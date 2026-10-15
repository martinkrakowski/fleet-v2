/**
 * Coordination records are the pure domain facts shared by more than one
 * contract: the persisted profile, the aggregate's request snapshot and its
 * child receipts, and the bounded attention summary. They are plain
 * serializable data with no behaviour, so they live here rather than in any
 * single port module and never carry credentials, tokens or client content.
 */

import type { CoordinationKindValue } from './value-objects/CoordinationKind.vo.js';
import type { CoordinationStateValue } from './value-objects/CoordinationState.vo.js';

/**
 * Private installation references for one project. It names the designated
 * dispatcher host and the approved policy revision; it never stores a
 * credential, token or secret value.
 */
export interface ProjectProfileRecord {
  readonly projectId: string;
  readonly displayName: string;
  readonly repository: string;
  readonly designatedDispatcherHost: string;
  readonly policyRevision: string;
  readonly maxConcurrentLanes: number;
  readonly runnerCapabilities: Readonly<Record<string, boolean | string>>;
  readonly revision: number;
  readonly updatedAtIso: string;
}

/**
 * Durable receipt binding one grant to one action id and attempt. A second,
 * unrelated action never reuses a recorded consumption.
 */
export interface AuthorizationConsumptionRecord {
  readonly consumptionId: string;
  readonly grantId: string;
  readonly requestId: string;
  readonly actionId: string;
  readonly attemptId: string;
  readonly expectedHeadSha: string;
  readonly consumedAtIso: string;
}

/**
 * An actual recipient response with its provenance. Silence and transport
 * delivery are not acknowledgement; only a recorded response is.
 */
export interface RelayAcknowledgementRecord {
  readonly acknowledgementId: string;
  readonly requestId: string;
  readonly recipientId: string;
  readonly responseSummary: string;
  readonly provenance: string;
  readonly acknowledgedAtIso: string;
}

/** Serializable snapshot of the CoordinationRequest aggregate. */
export interface CoordinationRequestRecord {
  readonly id: string;
  readonly projectId: string;
  readonly kind: CoordinationKindValue;
  readonly state: CoordinationStateValue;
  readonly actionScope: string;
  readonly expectedHeadSha: string | null;
  readonly proposalDigest: string;
  readonly policyRevision: string;
  readonly decisionRevision: string | null;
  readonly grantId: string | null;
  readonly consumptions: readonly AuthorizationConsumptionRecord[];
  readonly acknowledgements: readonly RelayAcknowledgementRecord[];
  readonly deliveryStatus: 'delivered' | 'pending' | 'delivery-gap';
  readonly deliveryGapReason: string | null;
  readonly revision: number;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

/** Bounded attention and staleness summary; reading it rewrites nothing. */
export interface ProjectAttentionSummaryRecord {
  readonly projectId: string;
  readonly staleWorkOrderCount: number;
  readonly awaitingDecisionCount: number;
  readonly deliveryGapCount: number;
  readonly summaryText: string;
  readonly observedAtIso: string;
}
