// @generated inbound contract scaffold — refined for step 5.
/**
 * RequestScopedDecisionPort: record the exact proposal, expected revision and
 * action scope before asking its authorized decider. Recording precedes the
 * ask; an unrecorded proposal is never put to a decider.
 */

import type { CoordinationRequestRecord } from '../../../domain/coordination-records.js';
import type { CoordinationKindValue } from '../../../domain/value-objects/CoordinationKind.vo.js';

export interface RequestScopedDecisionRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly kind: CoordinationKindValue;
  readonly actionScope: string;
  readonly expectedHeadSha: string | null;
  readonly proposalDigest: string;
  readonly policyRevision: string;
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

export interface RequestScopedDecisionPort {
  requestScopedDecision(request: RequestScopedDecisionRequest): Promise<RequestScopedDecisionResult>;
}
