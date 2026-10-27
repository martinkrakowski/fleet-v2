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
 * One clone of a project's repository on an installation host. `path` is the
 * clone directory; `worktreeRoot` is the directory holding the clone's
 * worktrees, and must lie outside the clone itself.
 */
export interface ProjectCloneRecord {
  readonly path: string;
  readonly worktreeRoot: string;
}

/** Outcome of one probe check: verified, failed, or not exercised. */
export type ProjectProbeResult = 'pass' | 'fail' | 'unknown';

/**
 * One named check in a probe receipt. `host` is the host the check ran on, or
 * null when the check is not host-specific; `detail` carries human-readable
 * evidence and never a credential, token or secret value.
 */
export interface ProjectProbeCheckRecord {
  readonly name: string;
  readonly host: string | null;
  readonly result: ProjectProbeResult;
  readonly detail: string;
}

/** Durable receipt proving a project was probed at a point in time. */
export interface ProjectProbeReceiptRecord {
  readonly probedAtIso: string;
  readonly probedFrom: string;
  readonly checks: readonly ProjectProbeCheckRecord[];
}

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
  readonly status: 'active' | 'retired';
  readonly defaultBranch: string | null;
  readonly clones: Readonly<Record<string, ProjectCloneRecord>>;
  readonly gateProcedures: readonly string[];
  readonly defaultAllowedPathPrefixes: readonly string[];
  readonly lastProbe: ProjectProbeReceiptRecord | null;
}

/**
 * Input shape accepted by `ProjectProfile.fromRecord`. The six fields added in
 * profile v2 are optional here because records written before this lane lack
 * them; the entity fills defaults for a missing field.
 */
export type ProjectProfileInput = Omit<
  ProjectProfileRecord,
  | 'status'
  | 'defaultBranch'
  | 'clones'
  | 'gateProcedures'
  | 'defaultAllowedPathPrefixes'
  | 'lastProbe'
> &
  Partial<
    Pick<
      ProjectProfileRecord,
      | 'status'
      | 'defaultBranch'
      | 'clones'
      | 'gateProcedures'
      | 'defaultAllowedPathPrefixes'
      | 'lastProbe'
    >
  >;

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

/**
 * The coordinates of a policy grant (auto-merge plan A3): the work order it serves, the attempt whose
 * accepted head it authorises, and the acceptance receipt that made it eligible. Present only on a
 * grant issued from an installation setting; an owner grant never carries it.
 */
export interface PolicyGrantRecord {
  readonly workOrderId: string;
  readonly attemptId: string;
  readonly acceptanceReceiptId: string;
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
  /** Present only on a policy grant (A3); absent on every owner grant and every other request. */
  readonly policyGrant?: PolicyGrantRecord;
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
