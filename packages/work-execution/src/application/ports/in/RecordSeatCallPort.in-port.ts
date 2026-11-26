/**
 * RecordSeatCallPort: one plan-billed seat call (`agy`, `grok` or `claude`)
 * recorded as a metadata-only OpenInference span through the run telemetry
 * send port (plan §3.2). The span always carries `fleet.seat.billing = 'plan'`
 * and never carries tokens, cost, model ids, prompts, outputs, paths, branch
 * names or session ids; an optional opaque seat/lane label is hashed before it
 * reaches a span. This port never throws: every invalid request, failing span
 * build or failing send is a typed refused or failed result (fail closed).
 */

import type { RunTelemetrySendDeadline } from '../out/RunTelemetryPort.out-port.js';
import type { TelemetrySpan } from '../../../domain/run-telemetry.js';
import type { TelemetryErrorKind } from '../../../domain/run-telemetry-ids.js';

/** The seat-call record request. Every field is validated here before use. */
export interface RecordSeatCallRequest {
  /** One of the plan-billed seat tools (`agy`, `grok`, `claude`). */
  readonly tool: string;
  /** One of the seat-call outcomes (`ok`, `empty`, `error`, `timeout`). */
  readonly outcome: string;
  /** The call's wall seconds; a finite number ≥ 0. */
  readonly wallSeconds: number;
  /** An opaque seat/lane label; hashed before it reaches a span, never sent raw. */
  readonly label: string | null;
  /** `dry-run` builds and returns the span without sending; `send` exports it. */
  readonly mode: 'send' | 'dry-run';
  /** The send deadline; `send` mode requires a valid one. */
  readonly deadline: RunTelemetrySendDeadline;
  /** The span's end instant; a zoned ISO time. */
  readonly nowIso: string;
}

/** The result. `dry-run` returns the span exactly as it would be sent. */
export type RecordSeatCallResult =
  | { readonly outcome: 'dry-run'; readonly span: TelemetrySpan }
  | { readonly outcome: 'exported'; readonly spanId: string }
  | { readonly outcome: 'send-failed'; readonly errorKind: TelemetryErrorKind | 'unknown' }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-request' | 'span-build-failed' };

export interface RecordSeatCallPort {
  /** Never throws: unknown input is a refused result, never an exception. */
  execute(request: unknown): Promise<RecordSeatCallResult>;
}
