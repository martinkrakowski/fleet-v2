// @generated inbound contract scaffold — refined for lane K7-2.
/**
 * InspectLaneRunsPort: a read-only status view of one lane run or every run,
 * plus the state directory's halt marker and the driver lease (plan §3.7,
 * §3.8). It writes nothing.
 */

import type { LaneRunKeyStep, LaneRunTier } from '../../../domain/lane-run-records.js';
import type { LaneRunParkRecord } from '../../../domain/lane-run-records.js';
import type { RunStopMode } from '../../../domain/lane-run-transitions.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import type { BaseBranchValue } from '../../../domain/base-branch.js';

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
    }
  | { readonly outcome: 'not-found'; readonly runId: string };

export interface InspectLaneRunsPort {
  inspectLaneRuns(request: InspectLaneRunsRequest): Promise<InspectLaneRunsResult>;
}
