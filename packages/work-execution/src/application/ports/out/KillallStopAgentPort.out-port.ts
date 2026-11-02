// @generated outbound contract scaffold — refined for lane KA2.
/**
 * KillallStopAgentPort asks the stop agent beside the lane servers (KA3,
 * another repository) to stop every running lane and return its raw stop-report
 * payload. Unavailable, timeout and transport errors are named results, never
 * guesses, and no supplied value is echoed.
 */

export type KillallStopAgentResult =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly reason: 'unavailable' | 'timeout' | 'transport-error' };

export interface KillallStopAgentPort {
  stop(request: { readonly haltedAtIso: string }): Promise<KillallStopAgentResult>;
}
