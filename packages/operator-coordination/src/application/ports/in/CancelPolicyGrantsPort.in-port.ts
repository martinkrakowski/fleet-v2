// @generated inbound contract scaffold — refined for lane AM3a-2.
/**
 * CancelPolicyGrantsPort: cancel every unconsumed policy grant of one setting
 * issued under a revision other than the current one, across all projects
 * (the setting is installation-wide). Consumed grants, owner grants and the
 * other setting's grants are never written.
 */

import type { PolicyGrantSource } from '../../../domain/policy-grants.js';

export interface CancelPolicyGrantsRequest {
  readonly source: PolicyGrantSource;
  /** The setting's revision now; grants under any other revision of this source are cancelled. */
  readonly currentRevision: string;
}

export type CancelPolicyGrantsResult =
  | { readonly outcome: 'cancelled'; readonly cancelledGrantIds: readonly string[]; readonly consumedLeft: number }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface CancelPolicyGrantsPort {
  cancelPolicyGrants(request: CancelPolicyGrantsRequest): Promise<CancelPolicyGrantsResult>;
}
