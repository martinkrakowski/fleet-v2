// @generated outbound contract scaffold — refined for lane OT2a-2.
/**
 * RunTelemetryPort sends closed telemetry spans and returns one disposition
 * per span given (plan §3.3 "Application", §3.5 "Dispositions from a result"):
 * `exported@<route>` only on an HTTP result, `rejected` with a reason class,
 * else `pending`, plus one error kind per call. It never rejects and never
 * throws to its caller (§3.5 "Never blocks the lane"), and never logs: its
 * counters reach the CLI boundary through the disposition store.
 */

import type { SpanDisposition, TelemetryErrorKind } from '../../../domain/run-telemetry-ids.js';
import type { TelemetrySpan } from '../../../domain/run-telemetry.js';

/** One result entry per span given, same length and order as the input. */
export interface RunTelemetrySpanDisposition {
  readonly spanId: string;
  readonly disposition: SpanDisposition;
}

export interface RunTelemetrySendResult {
  readonly dispositions: readonly RunTelemetrySpanDisposition[];
  readonly errorKind: TelemetryErrorKind | null;
}

/** `{ atMs }` or null: nothing waits past it; the send adapters validate it. */
export type RunTelemetrySendDeadline = { readonly atMs: number } | null;

export interface RunTelemetryPort {
  /**
   * Never rejects and never throws: every span given gets exactly one
   * disposition, in input order. A span that fails `TelemetrySpan.isTelemetrySpan`
   * is `rejected:invalid` without being sent (§3.5). A malformed deadline is
   * refused without a send: nothing is attributable, so valid spans stay
   * `pending` with a null error kind.
   */
  send(spans: readonly TelemetrySpan[], deadline: RunTelemetrySendDeadline): Promise<RunTelemetrySendResult>;
}
