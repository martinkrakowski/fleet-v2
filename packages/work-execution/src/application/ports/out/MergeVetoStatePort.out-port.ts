// OG-16a: the shadow merge pass reads the Jev veto state through this port.
/**
 * MergeVetoStatePort: read the veto state fields for one pull request at one
 * head, so the pass can ask `MergeVetoPort.adviseMergeVeto` with a complete
 * state. Read-only; known absence of configuration is reported as
 * `unavailable`, never guessed.
 */

import type { MergeVetoStateFields } from './MergeVetoPort.out-port.js';

export interface MergeVetoStateRequest {
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly pullRequestNumber: number;
  readonly headOid: string;
  readonly deadlineIso: string;
}

export type MergeVetoStateResult =
  | { readonly status: 'read'; readonly state: MergeVetoStateFields }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface MergeVetoStatePort {
  readMergeVetoState(request: MergeVetoStateRequest): Promise<MergeVetoStateResult>;
}
