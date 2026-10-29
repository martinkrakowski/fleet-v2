// @generated adapter scaffold — refined for lane OT2a-2.
/**
 * RecordingRunTelemetryAdapter implements RunTelemetryPort
 * (in-process-recording) for tests and `--dry-run`: it keeps copies of the
 * span references it was given (never serialized text), answers with a
 * configurable outcome, and never touches the network, the filesystem or a
 * clock. The default outcome is `exported@collector`; a script applies one
 * entry per sendable span, in span order across successive calls, and runs out
 * to the default. It shares the invalid-span, deadline and nothing-final
 * helpers with the no-op.
 */

import {
  TELEMETRY_SPAN_ID_PATTERN,
  type SpanDisposition,
  type TelemetryErrorKind,
} from '../../domain/run-telemetry-ids.js';
import { TelemetrySpan } from '../../domain/run-telemetry.js';
import type {
  RunTelemetryPort,
  RunTelemetrySendDeadline,
  RunTelemetrySendResult,
  RunTelemetrySpanDisposition,
} from '../../application/ports/out/RunTelemetryPort.out-port.js';

/** The span id of a span that cannot even report its own. */
const UNATTRIBUTABLE_SPAN_ID = '0000000000000000';

/** True only for a span built by `TelemetrySpan.build`; a throw reads as invalid. */
export function isSendableSpan(value: unknown): value is TelemetrySpan {
  try {
    return TelemetrySpan.isTelemetrySpan(value);
  } catch {
    return false;
  }
}

/** The `rejected:invalid` mapping both send adapters share (plan §3.5). */
export function invalidSpanDisposition(value: unknown): RunTelemetrySpanDisposition {
  let spanId: string = UNATTRIBUTABLE_SPAN_ID;
  try {
    const candidate = value as { spanId?: unknown } | null;
    const raw = candidate?.spanId;
    if (typeof raw === 'string' && TELEMETRY_SPAN_ID_PATTERN.test(raw)) {
      spanId = raw;
    }
  } catch {
    spanId = UNATTRIBUTABLE_SPAN_ID;
  }
  return { spanId, disposition: { state: 'rejected', reason: 'invalid' } };
}

/** A deadline is `{ atMs }` with a finite number, or null; anything else is refused. */
export function isAcceptedDeadline(deadline: RunTelemetrySendDeadline): boolean {
  if (deadline === null) {
    return true;
  }
  if (typeof deadline !== 'object') {
    return false;
  }
  return typeof deadline.atMs === 'number' && Number.isFinite(deadline.atMs);
}

/** The entry for one sendable span: nothing final (plan §3.5) means `pending`. */
export function pendingDispositionFor(span: TelemetrySpan): RunTelemetrySpanDisposition {
  return { spanId: span.spanId, disposition: { state: 'pending' } };
}

/**
 * One entry per span given, for a call that sends nothing: a sendable span
 * stays `pending` (nothing was sent, so nothing is final), and a span that
 * fails `TelemetrySpan.isTelemetrySpan` is `rejected:invalid`.
 */
export function refusalsFor(spans: readonly unknown[]): RunTelemetrySpanDisposition[] {
  const dispositions: RunTelemetrySpanDisposition[] = [];
  for (const span of spans) {
    if (isSendableSpan(span)) {
      dispositions.push(pendingDispositionFor(span));
    } else {
      dispositions.push(invalidSpanDisposition(span));
    }
  }
  return dispositions;
}

export interface RecordingRunTelemetryCall {
  /** The spans exactly as given: the same references, in the same order. */
  readonly spans: readonly unknown[];
  readonly deadline: RunTelemetrySendDeadline;
}

export interface RecordingRunTelemetryAdapterOptions {
  /**
   * One outcome per sendable span, applied to successive spans across
   * successive calls; an exhausted script falls back to `exported@collector`.
   * `error-timeout` leaves that span `pending` and sets `errorKind: 'timeout'`.
   */
  readonly script?: readonly (SpanDisposition | 'error-timeout')[];
}

const DEFAULT_OUTCOME: SpanDisposition = { state: 'exported', route: 'collector' };

export class RecordingRunTelemetryAdapter implements RunTelemetryPort {
  readonly #calls: RecordingRunTelemetryCall[] = [];
  readonly #script: readonly (SpanDisposition | 'error-timeout')[];
  #nextScriptEntry = 0;

  constructor(options: RecordingRunTelemetryAdapterOptions = {}) {
    this.#script = Array.isArray(options.script) ? options.script : [];
  }

  /** The recorded calls, in send order. */
  calls(): readonly RecordingRunTelemetryCall[] {
    return this.#calls;
  }

  async send(spans: readonly unknown[], deadline: RunTelemetrySendDeadline): Promise<RunTelemetrySendResult> {
    try {
      if (!isAcceptedDeadline(deadline)) {
        // Refused without a send (plan §3.5): nothing is attributable, so the
        // sendable spans stay `pending` and the call is not recorded.
        return { dispositions: refusalsFor(spans), errorKind: null };
      }
      const dispositions: RunTelemetrySpanDisposition[] = [];
      let errorKind: TelemetryErrorKind | null = null;
      for (const span of spans) {
        if (!isSendableSpan(span)) {
          dispositions.push(invalidSpanDisposition(span));
          continue;
        }
        const outcome = this.#nextScriptEntry < this.#script.length ? this.#script[this.#nextScriptEntry] : null;
        this.#nextScriptEntry++;
        if (outcome === 'error-timeout') {
          dispositions.push(pendingDispositionFor(span));
          errorKind = 'timeout';
          continue;
        }
        dispositions.push({ spanId: span.spanId, disposition: outcome ?? DEFAULT_OUTCOME });
      }
      // The same references, copied: never serialized text (plan §3.3).
      this.#calls.push({ spans: Array.from(spans), deadline });
      return { dispositions, errorKind };
    } catch {
      // Never rejects and never throws (plan §3.5 "Never blocks the lane").
      return { dispositions: refusalsFor(spans), errorKind: null };
    }
  }
}
