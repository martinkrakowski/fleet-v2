/**
 * The typed facts the work board reads (work-board plan §3.7, §3.9):
 * one plain shape per store, mapped by WB6 from each store's records; ids,
 * enums, counts, times and text, never a credential or client content; a
 * fact grants nothing. Not every text field here has been validated by its
 * store: the board itself applies the plain-text rule to the texts it
 * displays (work-order lane ids and question titles) before rendering them.
 */

import type { WorkOrderStateValue } from './value-objects/WorkOrderState.vo.js';
import type { AttemptStateValue } from './value-objects/AttemptState.vo.js';
import type { StopReasonValue } from './value-objects/StopReason.vo.js';
import type { SeatPlanRole } from './value-objects/SeatPlan.vo.js';
import type { LaneRunStateValue } from './value-objects/LaneRunState.vo.js';
import type { LaneRunParkReason } from './lane-run-records.js';

export const WORK_BOARD_SCHEMA_VERSION = 1 as const;

/** Every store or read the board depends on (plan §3.7), in the one order used everywhere. */
export const BOARD_SOURCES = [
  'plans', 'work-orders', 'attempts', 'runs', 'declarations', 'pr-links', 'link-conflicts',
  'merge-records', 'forge-observation', 'owner-items', 'questions', 'attention', 'review-evidence',
  'reservations', 'project-profiles', 'brief-reads', 'installation',
] as const;
export type BoardSource = (typeof BOARD_SOURCES)[number];

/** Why a source was not read: an enum from the first commit, never an error message (waits-for plan §3.8, §5). */
export const SOURCE_READING_REASONS = [
  'quarantined', 'unavailable', 'not-configured', 'not-on-this-installation', 'permission',
] as const;
export type SourceReadingReason = (typeof SOURCE_READING_REASONS)[number];

export interface SourceReading {
  readonly source: BoardSource;
  /** The repository of a `forge-observation` reading (one per repository); null for every other source. */
  readonly repository: string | null;
  readonly readAtIso: string | null;
  readonly status: 'read' | 'not-read';
  readonly reason?: SourceReadingReason;
}

/** A lane anywhere (waits-for plan §3.1). A lane with no plan is its work order. */
export type LaneRef =
  | { readonly kind: 'plan'; readonly projectId: string; readonly planId: string; readonly laneId: string }
  | { readonly kind: 'work-order'; readonly projectId: string; readonly workOrderId: string };

export const PLANNED_LANE_STATUS_VALUES = ['planned', 'deferred', 'dropped'] as const;
export type BoardPlannedLaneStatus = (typeof PLANNED_LANE_STATUS_VALUES)[number];

/** One `after` entry, already resolved to a full reference (WB1a). */
export interface BoardPlannedLaneRef {
  readonly projectId: string;
  readonly planId: string;
  readonly laneId: string;
}

export interface BoardPlannedLaneFact {
  readonly laneId: string;
  /** Former ids, oldest first (WB1b). */
  readonly aliases: readonly string[];
  readonly status: BoardPlannedLaneStatus;
  readonly scope: string;
  readonly packages: readonly string[];
  readonly sharedFiles: readonly string[];
  readonly tier: 0 | 1 | 2;
  readonly after: readonly BoardPlannedLaneRef[];
  readonly decisions: readonly string[];
  readonly brief: string | null;
}

export interface BoardPlanFact {
  readonly projectId: string;
  readonly planId: string;
  readonly revision: number;
  /** In plan order. */
  readonly lanes: readonly BoardPlannedLaneFact[];
  readonly decisions: readonly { readonly id: string; readonly state: 'open' | 'decided' }[];
  readonly exclusiveOrder: readonly { readonly file: string; readonly lanes: readonly string[] }[];
}

export interface BoardWorkOrderFact {
  readonly id: string;
  readonly projectId: string;
  readonly laneId: string;
  readonly state: WorkOrderStateValue;
  readonly ownedPaths: readonly string[];
  /** WB1a's planRef; null for a work order with no plan. */
  readonly planRef: BoardPlannedLaneRef | null;
  readonly updatedAtIso: string;
}

export interface BoardAttemptFact {
  readonly id: string;
  readonly workOrderId: string;
  readonly kind: 'initial' | 'fix';
  readonly fixNumber: number;
  readonly state: AttemptStateValue;
  readonly seatRole: SeatPlanRole | null;
  readonly model: string | null;
  readonly stopReason: StopReasonValue | null;
  readonly headCommit: string | null;
  readonly briefDigest: string | null;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

/** A lane run as the board reads it (K3 projects `state`; WB11 maps). */
export interface BoardRunFact {
  readonly runId: string;
  readonly workOrderId: string;
  readonly state: LaneRunStateValue;
  readonly round: number;
  readonly seatRole: SeatPlanRole | null;
  readonly model: string | null;
  readonly parkReason: LaneRunParkReason | null;
  readonly prNumber: number | null;
  readonly updatedAtIso: string;
}

export const BOARD_DECLARATION_STEPS = [
  'first-pass', 'gate', 'brief-check', 'code-review', 'fix-round', 'pre-merge', 'ci', 'other',
] as const;
export type BoardDeclarationStep = (typeof BOARD_DECLARATION_STEPS)[number];

/** `plan declare` (D3): declared, not observed. */
export interface BoardDeclarationFact {
  readonly lane: LaneRef;
  readonly step: BoardDeclarationStep;
  readonly seatRole: string;
  readonly model: string;
  readonly declaredAtIso: string;
}

export interface BoardPullRequestLinkFact {
  readonly repository: string;
  readonly number: number;
  readonly lane: LaneRef;
  readonly linkedAtIso: string;
}

/** A refused second link (`pr-already-linked`, WB5b): the PR stays on `linkedLane`. */
export interface BoardLinkConflictFact {
  readonly repository: string;
  readonly number: number;
  readonly linkedLane: LaneRef;
  readonly refusedLane: LaneRef;
  readonly recordedAtIso: string;
}

/** WB5a's merge record: the first merge fact, never replaced. */
export interface BoardMergeFact {
  readonly repository: string;
  readonly number: number;
  readonly headSha: string;
  readonly mergedAtIso: string;
  readonly firstSeenAtIso: string;
  readonly merger: 'fleet' | 'unknown';
}

/** A later read that differed from the merge record (plan §3.4); shown as a badge until AM3b. */
export interface BoardMergeIntegrityFact {
  readonly repository: string;
  readonly number: number;
  readonly readAtIso: string;
}

export const BOARD_PR_STATES = ['open', 'merged', 'closed'] as const;
export const BOARD_CI_STATES = ['pending', 'passed', 'failed', 'unknown'] as const;
export type BoardCiState = (typeof BOARD_CI_STATES)[number];

export interface BoardForgePullRequestFact {
  readonly number: number;
  readonly state: (typeof BOARD_PR_STATES)[number];
  readonly headSha: string;
  /** Plain text, already capped and withheld when secret-shaped (plan §3.4). */
  readonly title: string | null;
  readonly mergedAtIso: string | null;
  readonly closedAtIso: string | null;
  readonly ciState: BoardCiState;
}

export interface BoardForgeObservationFact {
  readonly projectId: string;
  readonly repository: string;
  readonly readAtIso: string;
  readonly outcome: 'read' | 'unavailable';
  readonly pullRequests: readonly BoardForgePullRequestFact[];
}

export const BOARD_OWNER_ITEM_KINDS = ['merge', 'secret', 'decision', 'backup', 'other'] as const;
export type BoardOwnerItemKind = (typeof BOARD_OWNER_ITEM_KINDS)[number];
/** Plan §3.1, §3.3: these kinds gate a lane named in `blocks`. */
export const BOARD_GATING_OWNER_ITEM_KINDS = ['merge', 'decision', 'secret'] as const satisfies readonly BoardOwnerItemKind[];

/** The OwnerQuestion.blocks shape, shared by owner items and questions. */
export interface BoardBlockFact {
  readonly kind: 'plan' | 'pr' | 'lane' | 'work-order';
  readonly ref: string;
}

export type BoardOwnerItemRefFact =
  | { readonly kind: 'pr'; readonly repository: string; readonly number: number }
  | { readonly kind: 'lane'; readonly planId: string; readonly laneId: string }
  | { readonly kind: 'work-order'; readonly id: string }
  | { readonly kind: 'question'; readonly id: string }
  | { readonly kind: 'plan-decision'; readonly planId: string; readonly decisionId: string }
  | { readonly kind: 'run'; readonly id: string };

export interface BoardOwnerItemFact {
  readonly itemId: string;
  readonly projectId: string;
  readonly kind: BoardOwnerItemKind;
  readonly subject: string | null;
  readonly refs: readonly BoardOwnerItemRefFact[];
  readonly blocks: readonly BoardBlockFact[];
  readonly createdAtIso: string;
  readonly state: 'open' | 'closed' | 'withdrawn';
}

export interface BoardQuestionFact {
  readonly questionId: string;
  readonly title: string;
  readonly state: 'open' | 'answered' | 'rejected' | 'expired' | 'acknowledged';
  readonly askedAtIso: string;
  readonly blocks: readonly BoardBlockFact[];
  /** The recorded answer's shape and whether it carries an option or text; never the text itself. */
  readonly answer: { readonly shape: 'accept' | 'reject' | 'answer'; readonly hasOption: boolean; readonly hasText: boolean } | null;
}

/** Finding counts of the latest review receipt at a head (AcceptanceEvidencePort, WB6). */
export interface BoardReviewCountsFact {
  readonly headSha: string;
  readonly blocker: number;
  readonly major: number;
  readonly minor: number;
  readonly nit: number;
  readonly readAtIso: string;
}

export interface BoardProjectFact {
  readonly projectId: string;
  readonly repository: string;
  readonly maxConcurrentLanes: number;
  readonly status: 'active' | 'retired';
}

/** Read by WB2b only (capacity and brief guards). */
export interface BoardReservationFact {
  readonly attemptId: string;
  readonly held: boolean;
}
export interface BoardBriefReadFact {
  readonly lane: LaneRef;
  readonly path: string;
  readonly outcome: 'read' | 'failed';
  readonly sha256: string | null;
  readonly bytes: number | null;
  readonly readAtIso: string;
}

export interface BoardFacts {
  readonly sources: readonly SourceReading[];
  readonly projects: readonly BoardProjectFact[];
  readonly plans: readonly BoardPlanFact[];
  readonly workOrders: readonly BoardWorkOrderFact[];
  readonly attempts: readonly BoardAttemptFact[];
  readonly runs: readonly BoardRunFact[];
  readonly declarations: readonly BoardDeclarationFact[];
  readonly links: readonly BoardPullRequestLinkFact[];
  readonly linkConflicts: readonly BoardLinkConflictFact[];
  readonly merges: readonly BoardMergeFact[];
  readonly mergeIntegrity: readonly BoardMergeIntegrityFact[];
  readonly forgeObservations: readonly BoardForgeObservationFact[];
  readonly ownerItems: readonly BoardOwnerItemFact[];
  readonly questions: readonly BoardQuestionFact[];
  readonly reviewCounts: readonly BoardReviewCountsFact[];
  readonly reservations: readonly BoardReservationFact[];
  readonly briefReads: readonly BoardBriefReadFact[];
  /** The installation's slot budget (WB2b); null when the installation was not read. */
  readonly slotBudget: number | null;
}

/** `policy.board` (WB6p) as plain input; the defaults are the plan's (D3, D6, §3.4). */
export interface BoardPolicy {
  readonly forgeStaleMinutes: number;
  readonly declarationTtlMinutes: number;
  readonly doneWindowDays: number;
}
export const DEFAULT_BOARD_POLICY: BoardPolicy = Object.freeze({
  forgeStaleMinutes: 15,
  declarationTtlMinutes: 90,
  doneWindowDays: 14,
});

export interface BoardOptions {
  /** `--since`: show Done merges at or after this instant instead of the window. */
  readonly sinceIso?: string | null;
}

/** `<projectId>/<planId>/<laneId>` or `wo:<workOrderId>`: the only full forms (waits-for plan §3.7). */
export function formatLaneRef(ref: LaneRef): string {
  if (ref.kind === 'plan') {
    return ref.projectId + '/' + ref.planId + '/' + ref.laneId;
  }
  return 'wo:' + ref.workOrderId;
}

/** True when both name the same lane. */
export function sameLaneRef(left: LaneRef, right: LaneRef): boolean {
  if (left.kind === 'plan' && right.kind === 'plan') {
    return left.projectId === right.projectId && left.planId === right.planId && left.laneId === right.laneId;
  }
  if (left.kind === 'work-order' && right.kind === 'work-order') {
    return left.projectId === right.projectId && left.workOrderId === right.workOrderId;
  }
  return false;
}

/** Parse an ISO instant to epoch milliseconds; null when it does not parse. */
export function parseTimeMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
