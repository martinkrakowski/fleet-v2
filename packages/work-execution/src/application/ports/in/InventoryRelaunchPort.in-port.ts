// @generated inbound contract scaffold — refined for lane CO26.
/**
 * InventoryRelaunchPort: the read-only relaunch inventory (cutover plan
 * CO26, §4 step 2). It reports what a relaunch would find on each lane
 * host: the registered clones' worktree listing, the runner's state per
 * worktree directory, the conductor's status, and each lane's population
 * (conducted, attempt-recorded, unrecorded). Risk flags are counts only;
 * worktree paths appear in the local CLI output only. It writes nothing,
 * journals nothing and mutates no worktree.
 */

import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';

/** One registered clone of an active project profile on one lane host (D18). */
export interface RelaunchCloneRef {
  readonly projectId: string;
  readonly hostName: string;
  /** The clone's absolute path on that host. */
  readonly clonePath: string;
  /** The directory holding that clone's worktrees; only worktrees under it count. */
  readonly worktreeRoot: string;
  /**
   * The host's recorded runner block; it routes the read to that host. Null
   * means the host is absent from the installation: the read cannot be
   * routed, so the inventory reports an unknown listing for that host rather
   * than falling back to a local executor.
   */
  readonly recordedHost: AttemptRunnerRecord | null;
}

export interface InventoryRelaunchRequest {
  /** The read's clock: an ISO 8601 instant with an explicit zone. */
  readonly nowIso: string;
  /** The lane host to report; null reports every host. */
  readonly hostName: string | null;
  /** The registered clones to read (D18: registered clones only, never a host-wide scan). */
  readonly clones: readonly RelaunchCloneRef[];
}

/** The three populations of the relaunch plan §4 step 2. */
export type RelaunchPopulation = 'conducted' | 'attempt-recorded' | 'unrecorded';

/** What the runner reports for one worktree directory. */
export type RelaunchRunnerState = 'idle' | 'running' | 'unknown';

/** One lane the inventory found. */
export interface RelaunchLaneRow {
  readonly population: RelaunchPopulation;
  /** The run id (conducted), the attempt id (attempt-recorded) or `worktree-<12 hex>` (unrecorded). */
  readonly laneId: string;
  /** The lane host; `unknown-host` when the record names no host. */
  readonly hostName: string;
  /** The worktree path. Local CLI output only; never in a web or API payload. */
  readonly worktreePath: string;
  /** The recorded run id, when one exists. */
  readonly runId: string | null;
  /** The recorded attempt id, when one exists. */
  readonly attemptId: string | null;
  /** The runner's state for that worktree directory. */
  readonly runnerState: RelaunchRunnerState;
}

/** The risk flag codes the inventory reports. */
export const RELAUNCH_RISK_FLAG_CODES = [
  'conductor-halted',
  'driver-lease-live',
  'unrecorded-worktrees',
  'running-worktrees',
  'unknown-worktree-read',
] as const;
export type RelaunchRiskFlagCode = (typeof RELAUNCH_RISK_FLAG_CODES)[number];

/** One risk flag: a code and how many times it holds. Never a path. */
export interface RelaunchRiskFlag {
  readonly code: RelaunchRiskFlagCode;
  readonly count: number;
}

/** One lane host's inventory. */
export interface RelaunchHostInventory {
  readonly hostName: string;
  /** The registered clones read on this host. */
  readonly cloneCount: number;
  /** The worktrees the clones listed. */
  readonly worktreeCount: number;
  readonly counts: {
    readonly conducted: number;
    readonly attemptRecorded: number;
    readonly unrecorded: number;
  };
  readonly riskFlags: readonly RelaunchRiskFlag[];
  readonly lanes: readonly RelaunchLaneRow[];
}

/** The conductor's status, as the inventory reads it. */
export interface RelaunchConductorStatus {
  /** The halt marker; an unreadable marker reads as halted. */
  readonly halted: boolean;
  /** The driver lease: absent, lapsed or live. */
  readonly driverLease: 'absent' | 'lapsed' | 'live';
  /** The recorded lane runs. */
  readonly runCount: number;
}

export type InventoryRelaunchResult =
  | {
      readonly outcome: 'inventoried';
      readonly nowIso: string;
      readonly conductor: RelaunchConductorStatus;
      readonly riskFlags: readonly RelaunchRiskFlag[];
      readonly hosts: readonly RelaunchHostInventory[];
    }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-request' };

export interface InventoryRelaunchPort {
  inventoryRelaunch(request: InventoryRelaunchRequest): Promise<InventoryRelaunchResult>;
}
