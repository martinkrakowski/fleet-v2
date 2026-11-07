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

/**
 * One project's generator state, read from files only. `state` is fleet-v2's
 * own vocabulary; a version the project does not state is null. Never a
 * credential, a path or a URL.
 */
export type ProjectGeneratorStateValue =
  | 'provisioned'
  | 'provisioned-legacy'
  | 'adopting'
  | 'none';

export interface ProjectGeneratorStateRecord {
  readonly state: ProjectGeneratorStateValue;
  readonly generatorVersion: string | null;
  readonly pinnedVersion: string | null;
}

/** Durable receipt proving a project was probed at a point in time. */
export interface ProjectProbeReceiptRecord {
  readonly probedAtIso: string;
  readonly probedFrom: string;
  readonly checks: readonly ProjectProbeCheckRecord[];
  /** The project's generator state; absent when the probe did not read it. */
  readonly generatorState?: ProjectGeneratorStateRecord;
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

/** The repository coordinates of an attempt-less merge grant (DT6b). */
export interface MergeGrantRepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

/**
 * The coordinates of an attempt-less merge grant (DT6b): the repository and pull
 * request it serves. Present only on a merge grant issued from the merge setting;
 * a policy grant (A3) and every other request never carries it.
 */
export interface MergeGrantRecord {
  readonly repository: MergeGrantRepositoryRef;
  readonly pullRequestNumber: number;
}

/**
 * The stored grant record version that records the attempt a grant is bound to (CO24e).
 * A record without `grantRecordVersion` is a legacy grant: it carries no attempt and
 * is bound by scope and exact head only, until it expires.
 */
export const GRANT_RECORD_VERSION = 2 as const;

/**
 * The scope prefix of a release grant (cutover row CO14): `release:install`,
 * `release:swap` or `release:rollback`. A release grant is attempt-less by
 * design (CO24g): it is anchored by its scope and exact head and consumed once
 * by its deterministic action id, so it never binds a work attempt.
 */
export const RELEASE_SCOPE_PREFIX = 'release:';

/** True only for a `release:<action>` scope; such a grant never binds an attempt. */
export function isReleaseActionScope(actionScope: string): boolean {
  return actionScope.startsWith(RELEASE_SCOPE_PREFIX);
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
  /** Present only on an attempt-less merge grant (DT6b); absent everywhere else. */
  readonly mergeGrant?: MergeGrantRecord;
  /** `2` once the record can name the attempt its grant is bound to; absent on a legacy grant. */
  readonly grantRecordVersion?: typeof GRANT_RECORD_VERSION;
  /**
   * The attempt the grant is bound to (CO24e). Written with `grantRecordVersion: 2`: at issue
   * for a policy grant, at request time or first resolve for an owner grant. A version-2 record
   * without it authorizes nothing at consumption.
   */
  readonly grantAttemptId?: string;
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
