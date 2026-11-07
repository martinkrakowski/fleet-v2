// @generated outbound contract scaffold — refined for lane CO29a.
/**
 * RelaunchPlanRepositoryPort: the immutable store of relaunch plans (cutover
 * plan CO29a, §4 steps 2–7). A plan is keyed by its canonical `planDigest`
 * (sha256 of the canonical plan body); a stored plan is never replaced or
 * deleted. Saving the identical plan again changes nothing; a different plan
 * (or a different request digest) under a stored digest is refused before any
 * write. Records hold ids, counts, digests and fixed codes only: never a
 * worktree path, a clone path, a state directory or free text.
 */

import type { BaseBranchValue } from '../../../domain/base-branch.js';

export const RELAUNCH_PLAN_SCHEMA_VERSION = 1 as const;

/** The per-lane steps of a relaunch, in the order a lane runs them. */
export const RELAUNCH_STEP_CODES = ['save', 'abort', 'adopt', 'redispatch'] as const;
export type RelaunchStepCode = (typeof RELAUNCH_STEP_CODES)[number];

/** The three populations of the relaunch inventory (cutover plan §4 step 2). */
export type RelaunchPlannedPopulation = 'conducted' | 'attempt-recorded' | 'unrecorded';

export interface RelaunchPlannedStep {
  readonly step: RelaunchStepCode;
  /** Exactly `relaunch/${planDigest}/${laneId}/${step}`. */
  readonly idempotencyKey: string;
}

export interface RelaunchPlannedLane {
  /** `[A-Za-z0-9._-]{1,64}`. */
  readonly laneId: string;
  readonly hostName: string;
  readonly projectId: string | null;
  readonly population: RelaunchPlannedPopulation;
  /** Never `unknown`: an unknown runner state refuses planning. */
  readonly runnerState: 'idle' | 'running';
  readonly runId: string | null;
  readonly attemptId: string | null;
  readonly workOrderId: string | null;
  readonly baseBranch: BaseBranchValue;
  readonly chainHead: boolean;
  readonly dependsOnLaneIds: readonly string[];
  /** `0` for a conducted lane, an integer `>= 1` for a lane with a `redispatch` step. */
  readonly admissionWave: number;
  /** Null for a conducted lane, the runner endpoint key for a lane with a `redispatch` step. */
  readonly dispatchEndpointKey: string | null;
  /** Null for a conducted lane, an integer `>= 0` for a lane with a `redispatch` step. */
  readonly staggerOffsetMs: number | null;
  readonly steps: readonly RelaunchPlannedStep[];
}

export interface RelaunchPlanRecord {
  readonly schemaVersion: typeof RELAUNCH_PLAN_SCHEMA_VERSION;
  /** 64 lowercase hex: sha256 of `canonicalRelaunchPlanBodyJson`. */
  readonly planDigest: string;
  /** 64 lowercase hex: the full normalized request digest (F129). */
  readonly requestDigest: string;
  /** Zoned ISO-8601 instant; metadata only, excluded from `planDigest`. */
  readonly createdAtIso: string;
  readonly hostFilter: string | null;
  readonly maxActiveRuns: number;
  readonly dispatchStaggerMs: number;
  readonly conductor: {
    readonly halted: boolean;
    readonly driverLease: 'absent' | 'lapsed' | 'live';
    readonly runCount: number;
  };
  readonly lanes: readonly RelaunchPlannedLane[];
}

/** A lane as the canonical body sees it: step codes, or steps (whose keys are ignored). */
export type RelaunchPlanBodyLane = Omit<RelaunchPlannedLane, 'steps'> &
  (
    | { readonly stepCodes: readonly RelaunchStepCode[] }
    | { readonly steps: readonly { readonly step: RelaunchStepCode }[] }
  );

export type RelaunchPlanBody = Omit<
  RelaunchPlanRecord,
  'planDigest' | 'requestDigest' | 'createdAtIso' | 'lanes'
> & { readonly lanes: readonly RelaunchPlanBodyLane[] };

/**
 * The step codes of a lane (D-CO10): a conducted run keeps running and has no
 * step; any other lane is saved, aborted first when its runner is running,
 * then adopted and redispatched.
 */
export function relaunchStepCodesFor(
  population: RelaunchPlannedPopulation,
  runnerState: 'idle' | 'running',
): readonly RelaunchStepCode[] {
  if (population === 'conducted') return [];
  return runnerState === 'running' ? ['save', 'abort', 'adopt', 'redispatch'] : ['save', 'adopt', 'redispatch'];
}

/** The idempotency key of one step of one lane. */
export function relaunchStepKey(planDigest: string, laneId: string, step: RelaunchStepCode): string {
  return `relaunch/${planDigest}/${laneId}/${step}`;
}

/**
 * Pure, deterministic: the canonical text hashed into `planDigest`. Keys are
 * written in a fixed order; lane order is part of the plan. The request
 * digest, the creation time and the step keys (which embed the digest) are
 * not part of it.
 */
export function canonicalRelaunchPlanBodyJson(plan: RelaunchPlanBody): string {
  return JSON.stringify({
    schemaVersion: plan.schemaVersion,
    hostFilter: plan.hostFilter,
    maxActiveRuns: plan.maxActiveRuns,
    dispatchStaggerMs: plan.dispatchStaggerMs,
    conductor: {
      halted: plan.conductor.halted,
      driverLease: plan.conductor.driverLease,
      runCount: plan.conductor.runCount,
    },
    lanes: plan.lanes.map((lane) => ({
      laneId: lane.laneId,
      hostName: lane.hostName,
      projectId: lane.projectId,
      population: lane.population,
      runnerState: lane.runnerState,
      runId: lane.runId,
      attemptId: lane.attemptId,
      workOrderId: lane.workOrderId,
      baseBranch: lane.baseBranch,
      chainHead: lane.chainHead,
      dependsOnLaneIds: [...lane.dependsOnLaneIds],
      admissionWave: lane.admissionWave,
      dispatchEndpointKey: lane.dispatchEndpointKey,
      staggerOffsetMs: lane.staggerOffsetMs,
      stepCodes: 'stepCodes' in lane ? [...lane.stepCodes] : lane.steps.map((step) => step.step),
    })),
  });
}

export type RelaunchPlanSaveRefusalReason =
  | 'invalid-plan'
  | 'digest-mismatch'
  | 'digest-conflict'
  | 'store-unreadable'
  | 'store-unknown-version'
  | 'store-read-only'
  | 'store-limit-exceeded';

export type SaveRelaunchPlanResult =
  | { readonly outcome: 'saved'; readonly planDigest: string; readonly plan: RelaunchPlanRecord }
  | { readonly outcome: 'unchanged'; readonly planDigest: string; readonly plan: RelaunchPlanRecord }
  | { readonly outcome: 'refused'; readonly reason: RelaunchPlanSaveRefusalReason };

export type FindRelaunchPlanResult =
  | { readonly outcome: 'found'; readonly plan: RelaunchPlanRecord }
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-digest' }
  | { readonly outcome: 'unreadable'; readonly reason: 'unreadable' | 'unknown-version' };

export interface RelaunchPlanRepositoryPort {
  /** Create-if-absent by `planDigest`; an identical replay is `unchanged` and writes nothing. */
  save(plan: RelaunchPlanRecord): Promise<SaveRelaunchPlanResult>;
  /** Known absence is `absent`; an unreadable or future-version store is never reported as absent. */
  findByDigest(planDigest: string): Promise<FindRelaunchPlanResult>;
}
