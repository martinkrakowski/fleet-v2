// @generated outbound contract scaffold — refined for lane CO-WD7.
/**
 * HostAudibleAlertPort: speak one complete sentence on the operator host.
 * The sentence is chosen by the domain rule `decideTrainHealthAnnouncements`
 * (fixed text built from attention codes and a validated pull request number).
 * The summary sentence "N more merge train problems are not announced." and the
 * refusal fallback sentence cannot be expressed as a per-rule request, which is
 * why this port takes the sentence and not a rule code. The use case calls
 * `speak` only with sentences that came from that domain rule.
 *
 * OBLIGATION THIS MOVES TO CO-WD8 (the `spd-say` adapter, not built here): the
 * adapter must treat the sentence as untrusted input, validate it (at most
 * `TRAIN_HEALTH_SENTENCE_MAX_LENGTH` = 120 characters and a fixed character
 * set; anything else answers `{ outcome: 'refused', reasonCode: 'invalid-request' }`
 * without spawning), and pass it as ONE argv element through the injected
 * command executor, never through a shell or string interpolation.
 */

export interface HostAudibleAlertRequest {
  readonly sentence: string;
}

export type HostAudibleAlertResult =
  | { readonly outcome: 'spoken' }
  | { readonly outcome: 'unavailable'; readonly reasonCode: 'binary-missing' }
  | { readonly outcome: 'refused'; readonly reasonCode: 'invalid-request' }
  | { readonly outcome: 'failed'; readonly reasonCode: 'spawn-failed' | 'killed' | 'nonzero-exit' };

export interface HostAudibleAlertPort {
  speak(request: HostAudibleAlertRequest): Promise<HostAudibleAlertResult>;
}
