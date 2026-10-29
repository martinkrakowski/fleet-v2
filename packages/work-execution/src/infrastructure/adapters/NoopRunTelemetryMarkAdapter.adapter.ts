// @generated adapter scaffold — refined for lane OT2a-2.
/**
 * NoopRunTelemetryMarkAdapter implements RunTelemetryMarkPort
 * (in-process-noop): the default when no telemetry exporter is configured.
 * `mark` does nothing, so the driver can always mark without a background
 * exporter wired (plan §3.3 "Infrastructure").
 */

import type { RunTelemetryMarkPort, RunTelemetryMarkTarget } from '../../application/ports/out/RunTelemetryMarkPort.out-port.js';

export class NoopRunTelemetryMarkAdapter implements RunTelemetryMarkPort {
  mark(_target: RunTelemetryMarkTarget): void {
    // no-op: nothing is queued and nothing is woken.
  }
}
