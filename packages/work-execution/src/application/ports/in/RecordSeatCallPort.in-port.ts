// @generated inbound contract scaffold — refined for lane TEL-SEAT.
/**
 * RecordSeatCallPort: record one plan-billed seat call (`agy`, `grok` or
 * `claude`) as a single metadata-only `seat-call` telemetry span through the
 * run telemetry port. The span names the seat tool, the outcome, the wall
 * seconds and, optionally, a salted digest of an opaque seat label; it never
 * carries tokens, cost, a model, a provider, a prompt, an output, a path, a
 * branch or a session id. This port never throws: unknown input, a missing
 * dependency, a failed span build or a failed send is a typed result.
 */

import type { TelemetrySpan } from '../../../domain/run-telemetry.js';
import type { TelemetryErrorKind } from '../../../domain/run-telemetry-ids.js';
import type { RunTelemetrySendDeadline } from '../out/RunTelemetryPort.out-port.js';

/** The request. `label` is hashed before it reaches a span and never sent raw. */
export interface RecordSeatCallRequest {
  readonly tool: 'agy' | 'grok' | 'claude';
  readonly outcome: 'ok' | 'empty' | 'error' | 'timeout';
  readonly wallSeconds: number;
  readonly label: string | null;
  readonly mode: 'send' | 'dry-run';
  readonly deadline: RunTelemetrySendDeadline;
  readonly nowIso: string;
}

/**
 * `dry-run` returns the span exactly as it would be sent and sends nothing;
 * `exported` names the exported span; `send-failed` carries the send's error
 * kind or `unknown`; `refused` carries a fixed reason code and nothing sent.
 */
export type RecordSeatCallResult =
  | { readonly outcome: 'dry-run'; readonly span: TelemetrySpan }
  | { readonly outcome: 'exported'; readonly spanId: string }
  | { readonly outcome: 'send-failed'; readonly errorKind: TelemetryErrorKind | 'unknown' }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-request' | 'span-build-failed' | 'not-configured' };

export interface RecordSeatCallPort {
  /** Never throws or rejects: unknown input is a refused result, never an exception. */
  execute(request: unknown): Promise<RecordSeatCallResult>;
}
