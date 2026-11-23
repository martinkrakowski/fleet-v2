// @generated inbound contract scaffold — refined for lane AR2a1x (CO29 §4 steps 4–7 & 9).
/**
 * ApplyRelaunchPort: apply one stored relaunch plan by digest, only under a
 * recorded owner grant naming that digest (cutover plan CO29, §4 steps 4–7 & 9,
 * invariants I1–I7). Dry-run is the default: `apply: false` reports what the
 * plan would do without touching anything. Each step is keyed
 * `relaunch/<planDigest>/<lane>/<step>` with intent before action; abort runs
 * only by directory through the runner after its save is verified, and
 * process-tree termination applies only when an abort has no confirmed
 * `'aborted'` result (I3). A refused save stops that lane before any abort; a
 * step with an intent but no result is reconciled read-only, never repeated,
 * so a re-run is safe (I7). It removes, resets or deletes no worktree or
 * branch (I1). Results carry ids, codes, digests and statuses only — never a
 * worktree path, a clone path or a secret value.
 */

import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';
import type { RelaunchApplyLaneProgress, RelaunchApplyStepStatus } from '../../../domain/relaunch-apply.js';
import type { RelaunchPlannedPopulation, RelaunchStepCode } from '../out/RelaunchPlanRepositoryPort.out-port.js';

/**
 * One lane's per-lane save inputs. `attemptId` is a non-empty string, never
 * `null`: a lane without an attempt is planned with no save input rather than
 * a null id.
 */
export interface ApplyRelaunchSaveInput {
  readonly laneId: string;
  readonly attemptId: string;
  readonly worktreePath: string;
  readonly clonePath: string;
  /** `null` when no runner block was recorded for the attempt. */
  readonly recordedHost: AttemptRunnerRecord | null;
  readonly baseCommit: string;
  readonly allowedPathPrefixes: readonly string[];
  readonly policyProtectedPaths?: readonly string[];
}

export interface ApplyRelaunchRequest {
  /** 64 lowercase hex: the digest of the stored plan to apply. */
  readonly planDigest: string;
  /**
   * Defaults to `false`: dry-run is the default, and only an explicit
   * `apply: true` mutates anything.
   */
  readonly apply?: boolean;
  /**
   * Required when `apply === true`: the owner grant id naming this plan
   * digest. Ignored for a dry run.
   */
  readonly grantId?: string | null;
  /**
   * Optional per-lane save inputs; each one's canonical digest is verified
   * against any recorded `save` intent for that lane before any abort, and a
   * mismatch refuses the lane (`save-input-digest-mismatch`).
   */
  readonly saveInputs?: readonly ApplyRelaunchSaveInput[];
  /** Zoned ISO-8601: the caller's clock reading. */
  readonly nowIso: string;
  /** Optional zoned ISO-8601: the apply's budget deadline. */
  readonly deadlineIso?: string | null;
}

/** Every reason the apply refuses, always as a fixed code. */
export type ApplyRelaunchRefusalReason =
  | 'invalid-request'
  | 'secret-detected'
  | 'invalid-clock'
  | 'budget-exhausted'
  | 'invalid-plan-digest'
  | 'plan-not-found'
  | 'plan-unreadable'
  | 'plan-unknown-version'
  | 'invalid-plan'
  | 'plan-digest-mismatch'
  | 'journal-unreadable'
  | 'save-input-digest-mismatch'
  | 'out-of-order'
  | 'step-inconsistent'
  | 'grant-missing'
  | 'grant-expired'
  | 'grant-revoked'
  | 'grant-wrong-scope'
  | 'grant-wrong-project'
  | 'grant-digest-mismatch'
  | 'grant-not-approved'
  | 'grant-id-mismatch'
  | 'authorization-unavailable'
  | 'unexpected-running-lane'
  | 'stale-plan-state'
  | 'journal-write-failed'
  | 'save-failed'
  | 'abort-failed'
  | 'active-run-cap-reached'
  | 'adopt-not-implemented'
  | 'live-apply-not-implemented';

/** One lane's apply summary: ids, step codes and statuses only. */
export interface ApplyRelaunchLaneSummary {
  readonly laneId: string;
  readonly population: RelaunchPlannedPopulation;
  readonly stepStatuses: readonly {
    readonly step: RelaunchStepCode;
    readonly status: RelaunchApplyStepStatus;
  }[];
  readonly nextAction: RelaunchApplyLaneProgress;
}

export type ApplyRelaunchResult =
  | {
      readonly outcome: 'dry-run';
      readonly planDigest: string;
      readonly lanes: readonly ApplyRelaunchLaneSummary[];
    }
  | {
      /** AR2b: one live wave applied (`wave: null` when nothing was left to do). */
      readonly outcome: 'applied';
      readonly planDigest: string;
      readonly wave: number | null;
      readonly lanes: readonly ApplyRelaunchLaneSummary[];
    }
  | {
      readonly outcome: 'refused';
      readonly reason: ApplyRelaunchRefusalReason;
      readonly laneId?: string;
    };

export interface ApplyRelaunchPort {
  applyRelaunch(request: ApplyRelaunchRequest): Promise<ApplyRelaunchResult>;
}
