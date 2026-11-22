// @generated inbound contract scaffold — refined for step 5.
/**
 * RequestScopedDecisionPort: record the exact proposal, expected revision and
 * action scope before asking its authorized decider. Recording precedes the
 * ask; an unrecorded proposal is never put to a decider.
 */

import type { CoordinationRequestRecord } from '../../../domain/coordination-records.js';
import type { CoordinationKindValue } from '../../../domain/value-objects/CoordinationKind.vo.js';
import type { ShadowImportGrantRecord } from '../../../domain/coordination-records.js';

export interface RequestScopedDecisionRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly kind: CoordinationKindValue;
  readonly actionScope: string;
  readonly expectedHeadSha: string | null;
  readonly proposalDigest: string;
  readonly policyRevision: string;
  /** The attempt the decision's grant is for (CO24e); recorded with the grant so consumption is bound to it. */
  readonly attemptId?: string;
  /**
   * The release root the decision's grant is bound to (CO14 follow-up); only a
   * release decision carries one. Recorded with the grant so a resolve or
   * consumption naming another root is refused.
   */
  readonly releaseRoot?: string;
  /** The release grant's per-request nonce (32 lowercase hex); required for a release scope. */
  readonly releaseNonce?: string;
  /**
   * The standing shadow import grant's coordinates (owner decision
   * 2026-11-18); only a `merge:import-shadow` request carries one, and it is
   * required there. Bound to the request id by a digest of its coordinates.
   */
  readonly shadowImportGrant?: ShadowImportGrantRecord;
  readonly nowIso?: string;
}

export type RequestScopedDecisionResult =
  | {
      readonly outcome: 'requested';
      readonly request: CoordinationRequestRecord;
    }
  | {
      readonly outcome: 'rejected';
      readonly reason: string;
    };

/** Every typed way revoking a standing owner grant can be refused. */
export type RevokeOwnerGrantRefusal =
  | 'grant-missing'
  | 'grant-wrong-scope'
  | 'grant-already-revoked'
  | 'grant-not-revocable'
  | 'shadow-import-clock-unavailable'
  | 'revision-conflict';

export interface RevokeOwnerGrantRequest {
  /** The non-secret grant handle the owner wants to revoke. */
  readonly grantId: string;
  readonly nowIso?: string;
}

export type RevokeOwnerGrantResult =
  | {
      readonly outcome: 'revoked';
      readonly grantId: string;
    }
  | {
      readonly outcome: 'refused';
      readonly reason: RevokeOwnerGrantRefusal;
    };

export interface RequestScopedDecisionPort {
  requestScopedDecision(request: RequestScopedDecisionRequest): Promise<RequestScopedDecisionResult>;
  /**
   * Revoke one standing owner grant by its id. Scoped strictly to the
   * standing `merge:import-shadow` grant: every other recorded grant is
   * refused, and a refusal never prints secret-shaped values.
   *
   * Re-request rule: a revoked or declined grant blocks identical
   * coordinates — the request id is the digest of the grant's exact
   * coordinates ({ scope, owner, repo, expiresAtIso }), so re-recording them
   * is refused as an already-recorded request. To issue a fresh grant the
   * owner records a request with a different coordinate, for example a
   * different `expiresAtIso`, which yields a different digest and a new
   * request id.
   */
  revokeOwnerGrant?(request: RevokeOwnerGrantRequest): Promise<RevokeOwnerGrantResult>;
}
