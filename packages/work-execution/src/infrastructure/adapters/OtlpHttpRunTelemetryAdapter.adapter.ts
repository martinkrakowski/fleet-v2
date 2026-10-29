// Lane OT3b-1: the OTLP send adapter's core — the queue bound, batching, byte
// splitting, result mapping, split resends, dispositions and error kinds. This
// part uses an injected fake transport only: no fetch, no http, no network, no
// filesystem, no clock reads, no timers. OT3b-2 supplies the real `OtlpPost`
// (retry, deadlines, token file, loopback rule) and fills the
// misconfiguration-breaker hook. Pure infrastructure: it never throws to its
// caller, never logs, and records nothing but its counters (plan §3.3
// "Infrastructure", §3.5).
/**
 * OtlpHttpRunTelemetryAdapter implements RunTelemetryPort over an injected
 * `OtlpPost` seam. One `send` call posts at most one request at a time per
 * adapter instance; sendable spans are batched in input order, dropped
 * oldest-first past the queue bound, and mapped to one disposition per span.
 * Every outcome that is not attributable to the spans leaves them `pending`
 * and stops the call with an error kind (§3.5 "Dispositions from a result").
 */

import type {
  TelemetryErrorKind,
  TelemetryRejectReason,
  TelemetryRoute,
} from '../../domain/run-telemetry-ids.js';
import type { TelemetryResourceInput } from '../../domain/run-telemetry-attributes.js';
import type { TelemetrySpan } from '../../domain/run-telemetry.js';
import type {
  RunTelemetryPort,
  RunTelemetrySendDeadline,
  RunTelemetrySendResult,
  RunTelemetrySpanDisposition,
} from '../../application/ports/out/RunTelemetryPort.out-port.js';
import {
  isAcceptedDeadline,
  isSendableSpan,
  invalidSpanDisposition,
  pendingDispositionFor,
  refusalsFor,
} from './RecordingRunTelemetryAdapter.adapter.js';
import { encodeOtlpTraces } from './OtlpJsonEncoder.helper.js';

/** The outcome of one OTLP/HTTP POST; OT3b-2 wraps retries and deadlines around it. */
export type OtlpPostOutcome =
  | { kind: 'http'; status: number; retryAfterSeconds: number | null; rejectedSpans: number | null }
  | { kind: 'timeout' }
  | { kind: 'network' };

/** The injected transport seam: one call, one final result (a throw reads as `network`). */
export type OtlpPost = (payload: Uint8Array) => Promise<OtlpPostOutcome>;

export interface OtlpHttpRunTelemetryAdapterOptions {
  readonly post: OtlpPost;
  readonly route: TelemetryRoute;
  readonly resource: TelemetryResourceInput;
  readonly maxQueueSpans?: number;
  readonly maxBatchSpans?: number;
  readonly maxBatchBytes?: number;
}

/** Per-call state threaded through the batch and split processing. */
interface OtlpCallState {
  readonly dispositions: (RunTelemetrySpanDisposition | null)[];
  readonly positions: readonly number[];
  errorKind: TelemetryErrorKind | null;
  stopped: boolean;
  sawPartialRejected: boolean;
}

const DEFAULT_MAX_QUEUE_SPANS = 2048;
const DEFAULT_MAX_BATCH_SPANS = 512;
const DEFAULT_MAX_BATCH_BYTES = 1_048_576;

export class OtlpHttpRunTelemetryAdapter implements RunTelemetryPort {
  readonly #post: OtlpPost;
  readonly #route: TelemetryRoute;
  readonly #resource: TelemetryResourceInput;
  readonly #maxQueueSpans: number;
  readonly #maxBatchSpans: number;
  readonly #maxBatchBytes: number;
  #queueDrops = 0;
  #errorKinds: Partial<Record<TelemetryErrorKind, number>> = {};
  #tail: Promise<void> = Promise.resolve();

  constructor(options: OtlpHttpRunTelemetryAdapterOptions) {
    this.#post = options.post;
    this.#route = options.route;
    this.#resource = options.resource;
    this.#maxQueueSpans = options.maxQueueSpans ?? DEFAULT_MAX_QUEUE_SPANS;
    this.#maxBatchSpans = options.maxBatchSpans ?? DEFAULT_MAX_BATCH_SPANS;
    this.#maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
  }

  /**
   * One request at a time per adapter instance: every `send` waits for the
   * previous one through an internal promise chain (plan §3.5 "Send"). A
   * failure in one call never breaks the chain.
   */
  async send(spans: readonly TelemetrySpan[], deadline: RunTelemetrySendDeadline): Promise<RunTelemetrySendResult> {
    const run = this.#tail.then(() => this.#runSend(spans, deadline));
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Returns and resets the counters accumulated since the last take (OT2c writes them). */
  takeCounters(): { queueDrops: number; errorKinds: Partial<Record<TelemetryErrorKind, number>> } {
    const counters = { queueDrops: this.#queueDrops, errorKinds: this.#errorKinds };
    this.#queueDrops = 0;
    this.#errorKinds = {};
    return counters;
  }

  async #runSend(spans: readonly TelemetrySpan[], deadline: RunTelemetrySendDeadline): Promise<RunTelemetrySendResult> {
    try {
      if (!isAcceptedDeadline(deadline)) {
        // Refused without a send (plan §3.5): nothing is attributable, so valid
        // spans stay `pending` with a null error kind.
        return { dispositions: refusalsFor(spans), errorKind: null };
      }

      const dispositions: (RunTelemetrySpanDisposition | null)[] = [];
      const positions: number[] = [];
      const sendable: TelemetrySpan[] = [];
      for (const span of spans) {
        if (isSendableSpan(span)) {
          positions.push(dispositions.length);
          sendable.push(span);
          dispositions.push(null);
        } else {
          dispositions.push(invalidSpanDisposition(span));
        }
      }

      // Queue bound (§3.5 "Queue"): past maxQueueSpans sendable spans, the
      // oldest (lowest index) are dropped — they stay `pending` and count in
      // queueDrops; the newest maxQueueSpans go on.
      const drop = Math.max(0, sendable.length - this.#maxQueueSpans);
      for (let i = 0; i < drop; i += 1) {
        dispositions[positions[i]] = pendingDispositionFor(sendable[i]);
        this.#queueDrops += 1;
      }

      const call: OtlpCallState = { dispositions, positions, errorKind: null, stopped: false, sawPartialRejected: false };

      // Batching (§3.5): groups of at most maxBatchSpans sendable spans, in
      // input order; a stopping outcome ends the call, the rest stay pending.
      for (let start = drop; start < sendable.length && !call.stopped; start += this.#maxBatchSpans) {
        await this.#processBatch(call, start, sendable.slice(start, start + this.#maxBatchSpans));
      }

      // Any span not reached by a batch (the call stopped) stays pending.
      for (let i = drop; i < sendable.length; i += 1) {
        if (dispositions[positions[i]] === null) {
          dispositions[positions[i]] = pendingDispositionFor(sendable[i]);
        }
      }

      const errorKind = call.errorKind ?? (call.sawPartialRejected ? 'partial' : null);
      if (errorKind !== null) {
        this.#errorKinds[errorKind] = (this.#errorKinds[errorKind] ?? 0) + 1;
      }
      return { dispositions: dispositions as RunTelemetrySpanDisposition[], errorKind };
    } catch {
      // Never throws (plan §3.5 "Never blocks the lane"): sendable spans stay
      // `pending`, invalid ones are `rejected:invalid`, error kind `network`.
      this.#errorKinds.network = (this.#errorKinds.network ?? 0) + 1;
      return { dispositions: refusalsFor(spans), errorKind: 'network' };
    }
  }

  async #processBatch(call: OtlpCallState, batchBase: number, batch: readonly TelemetrySpan[]): Promise<void> {
    const encoded = encodeOtlpTraces(batch, this.#resource);
    const encodedIndices = this.#applyEncode(call, batchBase, batch, encoded);
    if (encoded.payload === null || encodedIndices.length === 0) {
      return;
    }
    if (encoded.payload.byteLength > this.#maxBatchBytes) {
      // Split the batch in half and re-encode; a single span that still does
      // not fit is `rejected:too-large`.
      if (batch.length === 1) {
        this.#mark(call, batchBase, rejectedDispositionFor(batch[0], 'too-large'));
        return;
      }
      const mid = Math.floor(batch.length / 2);
      await this.#processBatch(call, batchBase, batch.slice(0, mid));
      if (!call.stopped) {
        await this.#processBatch(call, batchBase + mid, batch.slice(mid));
      }
      return;
    }
    const outcome = await this.#safePost(encoded.payload);
    await this.#mapOutcome(call, batchBase, batch, encodedIndices, outcome);
  }

  /** Marks encoder refusals `rejected:invalid` and returns the encoded spans' batch indices. */
  #applyEncode(
    call: OtlpCallState,
    batchBase: number,
    batch: readonly TelemetrySpan[],
    encoded: ReturnType<typeof encodeOtlpTraces>,
  ): number[] {
    const refused = new Set(encoded.refused.map((entry) => entry.index));
    for (const entry of encoded.refused) {
      this.#mark(call, batchBase + entry.index, {
        spanId: batch[entry.index].spanId,
        disposition: { state: 'rejected', reason: 'invalid' },
      });
    }
    const encodedIndices: number[] = [];
    for (let i = 0; i < batch.length; i += 1) {
      if (!refused.has(i)) {
        encodedIndices.push(i);
      }
    }
    return encodedIndices;
  }

  async #safePost(payload: Uint8Array): Promise<OtlpPostOutcome> {
    try {
      return await this.#post(payload);
    } catch {
      return { kind: 'network' };
    }
  }

  /** Result mapping for one batch (§3.5 "Dispositions from a result"). */
  async #mapOutcome(
    call: OtlpCallState,
    batchBase: number,
    batch: readonly TelemetrySpan[],
    encodedIndices: readonly number[],
    outcome: OtlpPostOutcome,
  ): Promise<void> {
    if (outcome.kind === 'timeout') {
      this.#pendingAll(call, batchBase, batch, encodedIndices);
      call.errorKind = 'timeout';
      call.stopped = true;
      return;
    }
    if (outcome.kind === 'network') {
      this.#pendingAll(call, batchBase, batch, encodedIndices);
      call.errorKind = 'network';
      call.stopped = true;
      return;
    }
    const { status, rejectedSpans } = outcome;
    if (status >= 200 && status < 300) {
      if (rejectedSpans === null || rejectedSpans === 0) {
        for (const idx of encodedIndices) {
          this.#mark(call, batchBase + idx, {
            spanId: batch[idx].spanId,
            disposition: { state: 'exported', route: this.#route },
          });
        }
        return;
      }
      // 2xx with a partial success: split a multi-span batch; a single span is
      // `rejected:partial-rejected`.
      if (encodedIndices.length > 1) {
        await this.#splitResend(call, batchBase, batch, encodedIndices);
        return;
      }
      const idx = encodedIndices[0];
      this.#mark(call, batchBase + idx, rejectedDispositionFor(batch[idx], 'partial-rejected'));
      call.sawPartialRejected = true;
      return;
    }
    if (status === 400 || status === 413) {
      if (encodedIndices.length > 1) {
        await this.#splitResend(call, batchBase, batch, encodedIndices);
        return;
      }
      const idx = encodedIndices[0];
      this.#mark(call, batchBase + idx, rejectedDispositionFor(batch[idx], status === 413 ? 'too-large' : 'http-4xx'));
      return;
    }
    // Stopping outcomes: nothing is attributable to the spans, so they stay
    // `pending`, the call stops, and nothing more is posted.
    if (status === 401 || status === 403) {
      this.#pendingAll(call, batchBase, batch, encodedIndices);
      call.errorKind = 'auth';
      call.stopped = true;
      return;
    }
    if (status >= 400 && status < 500) {
      this.#pendingAll(call, batchBase, batch, encodedIndices);
      call.errorKind = 'http-4xx';
      call.stopped = true;
      return;
    }
    if (status >= 500 && status < 600) {
      this.#pendingAll(call, batchBase, batch, encodedIndices);
      call.errorKind = 'http-5xx';
      call.stopped = true;
      return;
    }
    // Any other status: conservatively a non-attributable failure.
    this.#pendingAll(call, batchBase, batch, encodedIndices);
    call.errorKind = 'http-4xx';
    call.stopped = true;
  }

  /** Split resend: each encoded span is resent alone, in input order (§3.5). */
  async #splitResend(
    call: OtlpCallState,
    batchBase: number,
    batch: readonly TelemetrySpan[],
    encodedIndices: readonly number[],
  ): Promise<void> {
    for (let i = 0; i < encodedIndices.length && !call.stopped; i += 1) {
      const idx = encodedIndices[i];
      const single = [batch[idx]];
      const encoded = encodeOtlpTraces(single, this.#resource);
      const singleIndices = this.#applyEncode(call, batchBase + idx, single, encoded);
      if (encoded.payload === null || singleIndices.length === 0) {
        continue;
      }
      if (encoded.payload.byteLength > this.#maxBatchBytes) {
        this.#mark(call, batchBase + idx, rejectedDispositionFor(batch[idx], 'too-large'));
        continue;
      }
      const outcome = await this.#safePost(encoded.payload);
      if (this.#onSingleSpanResult(outcome) === 'stop') {
        // OT3b-2's misconfiguration breaker: stop; everything not yet sent
        // stays pending.
        for (let j = i; j < encodedIndices.length; j += 1) {
          this.#mark(call, batchBase + encodedIndices[j], pendingDispositionFor(batch[encodedIndices[j]]));
        }
        call.stopped = true;
        if (call.errorKind === null) {
          call.errorKind = 'http-4xx';
        }
        return;
      }
      await this.#mapOutcome(call, batchBase + idx, single, singleIndices, outcome);
    }
  }

  /**
   * Hook for OT3b-2's misconfiguration breaker (plan §3.5): called after each
   * single-span split resend result; currently always continues.
   */
  #onSingleSpanResult(_outcome: OtlpPostOutcome): 'continue' | 'stop' {
    return 'continue';
  }

  #pendingAll(call: OtlpCallState, batchBase: number, batch: readonly TelemetrySpan[], encodedIndices: readonly number[]): void {
    for (const idx of encodedIndices) {
      this.#mark(call, batchBase + idx, pendingDispositionFor(batch[idx]));
    }
  }

  #mark(call: OtlpCallState, sendableIndex: number, disposition: RunTelemetrySpanDisposition): void {
    call.dispositions[call.positions[sendableIndex]] = disposition;
  }
}

function rejectedDispositionFor(span: TelemetrySpan, reason: TelemetryRejectReason): RunTelemetrySpanDisposition {
  return { spanId: span.spanId, disposition: { state: 'rejected', reason } };
}
