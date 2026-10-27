// @generated inbound contract scaffold — refined for lane AM3a-2.
/**
 * IssuePolicyForgeGrantPort: record one approved policy grant for an exact
 * forge action at an accepted head, named by the setting revision that
 * authorises it and bound to its work order, attempt and acceptance receipt;
 * earlier unconsumed policy grants for the same work order are cancelled first;
 * it never decides eligibility. The moment comes from the injected clock and
 * the ids from the injected source, never from the request.
 */

import type { PolicyGrantForgeKind, PolicyGrantSource } from '../../../domain/policy-grants.js';

/** The only source of "now" for the policy-grant use cases; injected, never from a request. */
export interface PolicyGrantClock { readonly nowIso: () => string; }

/** Mints the new request and grant ids; injected by the composition root. */
export interface PolicyGrantIdSource {
  readonly newRequestId: () => string;
  readonly newGrantId: () => string;
}

export interface IssuePolicyForgeGrantRequest {
  readonly projectId: string;
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly forgeKind: PolicyGrantForgeKind;
  readonly expectedHeadSha: string;
  /** The work order's own policyRevision (A3), unrelated to the setting revision. */
  readonly policyRevision: string;
  readonly acceptanceReceiptId: string;
  readonly source: PolicyGrantSource;
  /** The current autoMergeRevision or conductorRevision (12 hex). */
  readonly settingRevision: string;
}

export type IssuePolicyForgeGrantResult =
  | {
      readonly outcome: 'issued';
      readonly requestId: string;
      readonly grantId: string;
      readonly actionScope: string;
      readonly decisionRevision: string;
      /** The coordinates the consumption side binds (A3). */
      readonly workOrderId: string;
      readonly attemptId: string;
      readonly expectedHeadSha: string;
      /** Earlier policy grants of this work order cancelled by this issue, sorted. */
      readonly cancelledGrantIds: readonly string[];
    }
  | {
      readonly outcome: 'superseded';
      readonly requestId: string;
      readonly grantId: string;
      /** This issue's own grant id, cancelled because a newer live grant exists. */
      readonly cancelledGrantIds: readonly string[];
    }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface IssuePolicyForgeGrantPort {
  issuePolicyForgeGrant(request: IssuePolicyForgeGrantRequest): Promise<IssuePolicyForgeGrantResult>;
}
