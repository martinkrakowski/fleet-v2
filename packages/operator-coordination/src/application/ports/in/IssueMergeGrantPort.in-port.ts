// @generated inbound contract scaffold — refined for lane DT6b.
/**
 * IssueMergeGrantPort: record one approved attempt-less merge policy grant for
 * an exact repository pull request at an expected head, named by the setting
 * revision that authorises it and bound to (repository, pullRequestNumber,
 * expectedHeadSha); earlier unconsumed merge grants for the same pull request
 * are cancelled first; it never decides eligibility. The moment comes from the
 * injected clock and the ids from the injected source, never from the request.
 */

import type { MergeGrantForgeKind } from '../../../domain/policy-grants.js';
import type { PolicyGrantClock, PolicyGrantIdSource } from './IssuePolicyForgeGrantPort.in-port.js';

export type { PolicyGrantClock, PolicyGrantIdSource };

export interface IssueMergeGrantRequest {
  readonly projectId: string;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly pullRequestNumber: number;
  readonly expectedHeadSha: string;
  readonly forgeKind: MergeGrantForgeKind;
  /** The current merge setting revision (12 hex) that authorises the grant. */
  readonly settingRevision: string;
  /** The daemon budget deadline; the grant path performs no forge I/O. */
  readonly deadlineIso: string;
}

export type IssueMergeGrantResult =
  | {
      readonly outcome: 'issued';
      readonly requestId: string;
      readonly grantId: string;
      readonly decisionRevision: string;
      /** Earlier merge grants of this pull request cancelled by this issue, sorted. */
      readonly cancelledGrantIds: readonly string[];
    }
  | {
      readonly outcome: 'superseded';
      readonly requestId: string;
      readonly grantId: string;
      /** This issue's own grant id when its cancel was confirmed; empty when it was already not live. */
      readonly cancelledGrantIds: readonly string[];
      /**
       * This issue's own grant id when its cancel hit a second revision conflict and the grant may
       * still be live beside the newer one; the next issue or cancel for the pull request converges it.
       */
      readonly unresolvedGrantIds: readonly string[];
    }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface IssueMergeGrantPort {
  issueMergeGrant(request: IssueMergeGrantRequest): Promise<IssueMergeGrantResult>;
}
