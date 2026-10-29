// @generated outbound contract scaffold — refined for lane OT2a-2.
/**
 * RunTelemetryMarkPort marks one run or attempt for telemetry export (plan
 * §3.3 "Application", §3.5 "Never blocks the lane"): the only telemetry call
 * the driver makes, and the only thing on its critical path. Constant time
 * (adds an id to an in-memory set and wakes the background exporter), never
 * throws, never awaits and reads nothing. A lost mark only delays the next
 * `telemetry export`.
 */

/** The mark target: an id as given, stored and never validated further here. */
export type RunTelemetryMarkTarget =
  | { readonly kind: 'run'; readonly runId: string }
  | { readonly kind: 'attempt'; readonly attemptId: string };

export interface RunTelemetryMarkPort {
  /**
   * Never throws: a bad target is silently ignored, because a lost mark only
   * delays the next export (plan §3.3). Returns immediately; wakes nothing
   * synchronously beyond the adapter's own callback.
   */
  mark(target: RunTelemetryMarkTarget): void;
}
