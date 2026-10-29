// @generated adapter scaffold — refined for lane OT2a-2.
/**
 * NoopRunTelemetryAdapter implements RunTelemetryPort (in-process-noop): the
 * default when no telemetry endpoint is configured (plan §3.3
 * "Infrastructure"). Nothing is sent, so nothing is final: every sendable span
 * stays `pending` with a null error kind, and a span that fails
 * `TelemetrySpan.isTelemetrySpan` is `rejected:invalid`. It shares the
 * invalid-span, deadline and nothing-final helpers with the recording adapter.
 */

import type {
  RunTelemetryPort,
  RunTelemetrySendDeadline,
  RunTelemetrySendResult,
  RunTelemetrySpanDisposition,
} from '../../application/ports/out/RunTelemetryPort.out-port.js';
import {
  invalidSpanDisposition,
  isAcceptedDeadline,
  isSendableSpan,
  pendingDispositionFor,
  refusalsFor,
} from './RecordingRunTelemetryAdapter.adapter.js';

export class NoopRunTelemetryAdapter implements RunTelemetryPort {
  async send(spans: readonly unknown[], deadline: RunTelemetrySendDeadline): Promise<RunTelemetrySendResult> {
    try {
      const dispositions: RunTelemetrySpanDisposition[] = [];
      if (!isAcceptedDeadline(deadline)) {
        // Refused without a send (plan §3.5). The no-op sends nothing either
        // way, so the outcome is the same: nothing final, never a send.
      }
      for (const span of spans) {
        if (!isSendableSpan(span)) {
          dispositions.push(invalidSpanDisposition(span));
          continue;
        }
        // Nothing was sent, so nothing is final (plan §3.5): pending.
        dispositions.push(pendingDispositionFor(span));
      }
      return { dispositions, errorKind: null };
    } catch {
      // Never rejects and never throws (plan §3.5 "Never blocks the lane").
      return { dispositions: refusalsFor(spans), errorKind: null };
    }
  }
}
