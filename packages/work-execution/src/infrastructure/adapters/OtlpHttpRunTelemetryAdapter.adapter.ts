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
import {
  checkOtlpEndpoint,
  createFetchOtlpPost,
  readOtlpTokenFile,
  withOtlpRetry,
} from './OtlpHttpTransport.helper.js';

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
  /**
   * OT3b-2: called with each `send`'s deadline when the call actually runs, so
   * a deadline-aware transport wrapper (the retry/deadline layer) can enforce
   * it. Sends are serialised, so the value observed is always the running
   * call's.
   */
  readonly onDeadline?: (deadline: RunTelemetrySendDeadline) => void;
}

/** Per-call state threaded through the batch and split processing. */
interface OtlpCallState {
  readonly dispositions: (RunTelemetrySpanDisposition | null)[];
  readonly positions: readonly number[];
  errorKind: TelemetryErrorKind | null;
  stopped: boolean;
  sawPartialRejected: boolean;
  /** Consecutive single-span 400/413 results in this call (the breaker's count). */
  breakerCount: number;
  /** Absolute sendable indices of the counted single-span 400/413 results. */
  breakerPending: number[];
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
  readonly #onDeadline: ((deadline: RunTelemetrySendDeadline) => void) | null;
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
    this.#onDeadline = options.onDeadline ?? null;
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
      this.#onDeadline?.(deadline);
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

      const call: OtlpCallState = {
      dispositions,
      positions,
      errorKind: null,
      stopped: false,
      sawPartialRejected: false,
      breakerCount: 0,
      breakerPending: [],
    };

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
    const tripped = await this.#mapOutcome(call, batchBase, batch, encodedIndices, outcome);
    if (tripped) {
      // The breaker tripped on a single-span batch (plan §3.5): its spans go
      // back to `pending` and the call stops with `http-4xx`.
      this.#revertBreakerPending(call);
      call.stopped = true;
      call.errorKind = 'http-4xx';
    }
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

  /**
   * Result mapping for one batch (§3.5 "Dispositions from a result"). Returns
   * whether the misconfiguration breaker tripped on this outcome (a single-span
   * 400/413), so the caller can stop the call.
   */
  async #mapOutcome(
    call: OtlpCallState,
    batchBase: number,
    batch: readonly TelemetrySpan[],
    encodedIndices: readonly number[],
    outcome: OtlpPostOutcome,
  ): Promise<boolean> {
    if (outcome.kind === 'timeout') {
      this.#stopCall(call, 'timeout', batchBase, batch, encodedIndices);
      return false;
    }
    if (outcome.kind === 'network') {
      this.#stopCall(call, 'network', batchBase, batch, encodedIndices);
      return false;
    }
    const { status, rejectedSpans } = outcome;
    if (status >= 200 && status < 300) {
      if (rejectedSpans === null || rejectedSpans === 0) {
        // An accepted 2xx resets the breaker, batch or single (plan §3.5); a
        // 2xx with `rejectedSpans > 0` never resets it.
        call.breakerCount = 0;
        call.breakerPending.length = 0;
        for (const idx of encodedIndices) {
          this.#mark(call, batchBase + idx, {
            spanId: batch[idx].spanId,
            disposition: { state: 'exported', route: this.#route },
          });
        }
        return false;
      }
      // 2xx with a partial success: split a multi-span batch; a single span is
      // `rejected:partial-rejected`.
      if (encodedIndices.length > 1) {
        await this.#splitResend(call, batchBase, batch, encodedIndices);
        return false;
      }
      const idx = encodedIndices[0];
      this.#mark(call, batchBase + idx, rejectedDispositionFor(batch[idx], 'partial-rejected'));
      call.sawPartialRejected = true;
      return false;
    }
    if (status === 400 || status === 413) {
      if (encodedIndices.length > 1) {
        await this.#splitResend(call, batchBase, batch, encodedIndices);
        return false;
      }
      const idx = encodedIndices[0];
      this.#mark(call, batchBase + idx, rejectedDispositionFor(batch[idx], status === 413 ? 'too-large' : 'http-4xx'));
      return this.#updateBreaker(call, batchBase + idx, outcome);
    }
    // Stopping outcomes: nothing is attributable to the spans, so they stay
    // `pending`, the call stops, and nothing more is posted.
    if (status === 401 || status === 403) {
      this.#stopCall(call, 'auth', batchBase, batch, encodedIndices);
      return false;
    }
    if (status >= 400 && status < 500) {
      this.#stopCall(call, 'http-4xx', batchBase, batch, encodedIndices);
      return false;
    }
    if (status >= 500 && status < 600) {
      this.#stopCall(call, 'http-5xx', batchBase, batch, encodedIndices);
      return false;
    }
    // Any other status (e.g. 302, or a non-HTTP number): conservatively a
    // non-attributable failure — the `network` kind, spans left `pending`.
    this.#stopCall(call, 'network', batchBase, batch, encodedIndices);
    return false;
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
      const tripped = await this.#mapOutcome(call, batchBase + idx, single, singleIndices, outcome);
      if (tripped || call.stopped) {
        // The call stops here — by the misconfiguration breaker or by a
        // stopping outcome: every single-span 4xx result of this call (across
        // batches) goes back to `pending` (plan §3.5), everything not yet
        // sent stays `pending`, and the error kind is the stopping request's
        // real kind (`#mapOutcome` set it; a breaker trip on 4xxs falls back
        // to `http-4xx`).
        this.#revertBreakerPending(call);
        for (let j = i + 1; j < encodedIndices.length; j += 1) {
          const unsentIdx = encodedIndices[j];
          this.#mark(call, batchBase + unsentIdx, pendingDispositionFor(batch[unsentIdx]));
        }
        call.stopped = true;
        if (call.errorKind === null) {
          call.errorKind = 'http-4xx';
        }
        return;
      }
    }
  }

  /**
   * Records a single-span result in the misconfiguration breaker state (plan
   * §3.5 "Send"): a 400/413 increments the consecutive count and joins the
   * pending set. Returns true when the breaker trips (three consecutive
   * 400/413s with no accepted 2xx between them). Accepted 2xx resets happen
   * in `#mapOutcome`, which sees batch and single results alike.
   */
  #updateBreaker(call: OtlpCallState, absIndex: number, outcome: OtlpPostOutcome): boolean {
    if (isSingleSpan4xx(outcome)) {
      call.breakerCount += 1;
      call.breakerPending.push(absIndex);
      return call.breakerCount >= 3;
    }
    return false;
  }

  /** Reverts the breaker's single-span 4xx results to `pending` (plan §3.5). */
  #revertBreakerPending(call: OtlpCallState): void {
    for (const sendableIndex of call.breakerPending) {
      const current = call.dispositions[call.positions[sendableIndex]];
      if (current !== null) {
        this.#mark(call, sendableIndex, { spanId: current.spanId, disposition: { state: 'pending' } });
      }
    }
    call.breakerPending.length = 0;
  }

  /** A stopping outcome: the breaker's 4xxs and this batch go back to pending and the call stops. */
  #stopCall(
    call: OtlpCallState,
    kind: TelemetryErrorKind,
    batchBase: number,
    batch: readonly TelemetrySpan[],
    encodedIndices: readonly number[],
  ): void {
    this.#revertBreakerPending(call);
    this.#pendingAll(call, batchBase, batch, encodedIndices);
    call.errorKind = kind;
    call.stopped = true;
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

/** A single-span 400 or 413 outcome — the breaker's counted result. */
function isSingleSpan4xx(outcome: OtlpPostOutcome): boolean {
  return outcome.kind === 'http' && (outcome.status === 400 || outcome.status === 413);
}

/** Fixed refusal reasons of the OTLP HTTP factory; they never echo the input (plan §3.9). */
export type OtlpHttpRunTelemetryAdapterFactoryResult =
  | { ok: true; adapter: OtlpHttpRunTelemetryAdapter }
  | { ok: false; reason: 'endpoint-invalid' | 'endpoint-needs-https' | 'token-file-unreadable' | 'token-empty' };

export interface CreateOtlpHttpRunTelemetryAdapterOptions {
  /** The operator-supplied endpoint string; validated by the loopback rule. */
  readonly endpoint: unknown;
  /** The operator-supplied token file path; read per send, never logged. */
  readonly tokenFile: unknown;
  readonly route: TelemetryRoute;
  readonly resource: TelemetryResourceInput;
  /** Queue bound override; 2048 by default. */
  readonly maxQueueSpans?: number;
  /** Batch span bound override; 512 by default. */
  readonly maxBatchSpans?: number;
  /** Batch byte bound override; 1 MiB by default. */
  readonly maxBatchBytes?: number;
  /** Injected fetch for tests; the global `fetch` by default. */
  readonly fetchImpl?: typeof fetch;
  /** An optional stop signal handed to every request. */
  readonly stopSignal?: AbortSignal;
  /** The per-request timeout in milliseconds; 5000 by default. */
  readonly timeoutMs?: number;
  /** Injected clock for `Retry-After` dates and deadline checks. */
  readonly nowMs?: () => number;
  /** Injected retry wait for tests; the unref'd `otlpRetrySleep` by default. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Builds a real `OtlpHttpRunTelemetryAdapter` over the fetch transport
 * (plan §3.5 "Send", §3.9): the endpoint passes the loopback rule, the token
 * file is validated once at build time and re-read inside every send, and the
 * post is wrapped with the retry and deadline layer fed from each `send`'s
 * deadline. Refusals are fixed reason strings that never echo the endpoint or
 * the token.
 */
export function createOtlpHttpRunTelemetryAdapter(
  options: CreateOtlpHttpRunTelemetryAdapterOptions,
): OtlpHttpRunTelemetryAdapterFactoryResult {
  const endpoint = checkOtlpEndpoint(options.endpoint);
  if (!endpoint.ok) {
    return endpoint;
  }
  // A build-time validation only: the file is re-read inside every send and
  // the token is kept only in that call's local scope (§3.9).
  const token = readOtlpTokenFile(options.tokenFile);
  if (!token.ok) {
    return token;
  }
  let currentDeadline: RunTelemetrySendDeadline = null;
  const post = withOtlpRetry(
    createFetchOtlpPost({
      url: endpoint.url,
      tokenReader: () => readOtlpTokenFile(options.tokenFile),
      fetchImpl: options.fetchImpl,
      stopSignal: options.stopSignal,
      timeoutMs: options.timeoutMs,
      deadlineMs: () => currentDeadline?.atMs ?? null,
      nowMs: options.nowMs,
    }),
    {
      deadline: () => currentDeadline,
      nowMs: options.nowMs,
      sleep: options.sleep,
      stopSignal: options.stopSignal,
    },
  );
  const adapter = new OtlpHttpRunTelemetryAdapter({
    post,
    route: options.route,
    resource: options.resource,
    maxQueueSpans: options.maxQueueSpans,
    maxBatchSpans: options.maxBatchSpans,
    maxBatchBytes: options.maxBatchBytes,
    onDeadline: (deadline) => {
      currentDeadline = deadline;
    },
  });
  return { ok: true, adapter };
}
