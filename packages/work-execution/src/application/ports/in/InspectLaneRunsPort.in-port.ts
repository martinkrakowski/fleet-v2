// @generated inbound contract scaffold — refined for lane K7-2.
/**
 * InspectLaneRunsPort: a read-only status view of one lane run or every run,
 * plus the state directory's halt marker and the driver lease (plan §3.7,
 * §3.8). It writes nothing.
 */

import type { LaneRunKeyStep, LaneRunTier } from '../../../domain/lane-run-records.js';
import type { LaneRunParkRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunParkFindingView } from '../../../domain/park-findings-view.js';
import type { RunStopMode } from '../../../domain/lane-run-transitions.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import type { BaseBranchValue } from '../../../domain/base-branch.js';

/**
 * The grace, in minutes, before a held reservation is reported as a crashed
 * start: the reaper's grace default (conductor plan §3.9.2, decision D13) —
 * a start that is still running is not a crashed start. It is a constant
 * here; the policy key `policy.conductor.reaper.graceMinutes` belongs to a
 * later unit (KWp), and is not read from the installation.
 */
export const CRASHED_START_GRACE_MINUTES = 5;

/**
 * One held reservation left by a crashed start: a capacity reservation whose
 * attempt id no run lists, held for at least `CRASHED_START_GRACE_MINUTES`
 * (the ListLaneRunsPort rule: no worktree path, ssh alias, port or transport
 * crosses the view).
 */
export interface CrashedStartView {
  readonly attemptId: string;
  readonly workOrderId: string | null;
  readonly hostName: string | null;
  readonly slotIndex: number;
  readonly reservedAtIso: string;
  /** Whole minutes held; null when the recorded time cannot be read. */
  readonly heldMinutes: number | null;
}

export interface LaneRunStatusView {
  readonly runId: string;
  readonly workOrderId: string;
  /** The base branch the run was started against (lane CB1). */
  readonly baseBranch: BaseBranchValue;
  readonly tier: LaneRunTier;
  /** The state of the run's last conduct entry (laneRunJournalState). */
  readonly state: LaneRunStateValue;
  readonly round: number;
  readonly revision: number;
  readonly parked: LaneRunParkRecord | null;
  /** Bounded findings of the failed code review at the parked head; null unless parked blocker-after-round-2. */
  readonly reviewFindings: readonly LaneRunParkFindingView[] | null;
  /**
   * The fixed refusal detail of a `step-refused` park (e.g. `worktree-uncommitted`); absent when none.
   */
  readonly parkDetail?: string;
  readonly parkCount: number;
  /** The strongest stop intent's mode (laneRunJournalStopFacts); null when none. */
  readonly stopMode: RunStopMode | null;
  readonly stopRequestedAtIso: string | null;
  readonly pendingIntent: {
    readonly key: string;
    readonly step: LaneRunKeyStep;
    readonly reconciliation: 'unread' | 'ambiguous';
  } | null;
  readonly latestAttemptId: string | null;
  readonly attemptCount: number;
  readonly prNumber: number | null;
  /** The run's own lease (the driver's), lapsed when its leaseUntilIso is at or before nowIso. */
  readonly lease: {
    readonly holderId: string;
    readonly fence: number;
    readonly leaseUntilIso: string;
    readonly lapsed: boolean;
  } | null;
}

export interface InspectLaneRunsRequest {
  readonly runId?: string;
  readonly nowIso: string;
}

export type InspectLaneRunsResult =
  | {
      readonly outcome: 'listed';
      /** 'unreadable' is reported as such; the driver treats it as halted. */
      readonly halt: 'clear' | 'halted' | 'unreadable';
      readonly driver: {
        readonly holderId: string;
        readonly fence: number;
        readonly leaseUntilIso: string;
        readonly lapsed: boolean;
      } | null;
      readonly runs: readonly LaneRunStatusView[];
      /** Held reservations left by crashed starts; an empty array when there are none. */
      readonly crashedStarts: readonly CrashedStartView[];
    }
  | { readonly outcome: 'not-found'; readonly runId: string };

export interface InspectLaneRunsPort {
  inspectLaneRuns(request: InspectLaneRunsRequest): Promise<InspectLaneRunsResult>;
}
