// @generated outbound contract scaffold — refined for lane CO29b.
/**
 * RelaunchPlanRepositoryPort: store relaunch plans by digest, immutable once
 * written (cutover plan CO29, manifest contract). The same content under the
 * same digest is a no-op and other content under a stored digest is refused
 * by the store; a read by digest returns the plan or known absence, and an
 * unreadable or unknown-version plan is reported, never treated as absent.
 * Plans carry ids, codes, digests and step tokens only — never a path or a
 * secret-shaped string.
 */

import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';
import type { SaveLaneEditsRequest } from '../in/SaveLaneEditsPort.in-port.js';
import type { AdoptLaneRequest } from '../in/AdoptLanePort.in-port.js';

/** The plan record's schema version (§4.5: an explicit, required version). */
export const RELAUNCH_PLAN_SCHEMA_VERSION = 1 as const;

/** The five keyed steps of a relaunch plan, in dependency order. */
export const RELAUNCH_PLAN_STEPS = ['driver-swap', 'save', 'abort', 'adopt', 'redispatch'] as const;
export type RelaunchPlanStepKind = (typeof RELAUNCH_PLAN_STEPS)[number];

/** A conducted lane: a LaneRun exists; the driver is swapped, the run never stops. */
export interface RelaunchConductedLanePlan {
  readonly laneId: string;
  readonly population: 'conducted';
  readonly runId: string;
  readonly targetReleaseTag: string;
  readonly steps: readonly ['driver-swap'];
}

/** The abort step's runner arguments, carried by the plan. */
export interface RelaunchAbortSpec {
  readonly worktreePath: string;
  readonly recordedHost: AttemptRunnerRecord | null;
  readonly gracePeriodSeconds?: number;
}

/** The save step's arguments (CO27) without the per-apply identity fields. */
export type RelaunchSaveSpec = Omit<SaveLaneEditsRequest, 'planDigest' | 'laneId' | 'nowIso'>;

/** The adopt step's arguments (CO28) without the per-apply identity fields. */
export type RelaunchAdoptSpec = Omit<AdoptLaneRequest, 'planDigest' | 'laneId' | 'nowIso' | 'deadlineIso'>;

/** An attempt-recorded or unrecorded lane: saved, aborted, adopted, redispatched. */
export interface RelaunchAdoptableLanePlan {
  readonly laneId: string;
  readonly population: 'attempt-recorded' | 'unrecorded';
  readonly attemptId: string | null;
  readonly steps: readonly ('save' | 'abort' | 'adopt' | 'redispatch')[];
  readonly save?: RelaunchSaveSpec;
  readonly abort?: RelaunchAbortSpec;
  readonly adopt?: RelaunchAdoptSpec;
  readonly targetReleaseTag?: string;
}

/** One lane entry of a relaunch plan. */
export type RelaunchPlanLaneEntry = RelaunchConductedLanePlan | RelaunchAdoptableLanePlan;

/** The stored relaunch plan record (schema version 1). */
export interface RelaunchPlanRecord {
  readonly schemaVersion: typeof RELAUNCH_PLAN_SCHEMA_VERSION;
  /** 7–64 lowercase hex chars; the store's key and the owner grant's head. */
  readonly planDigest: string;
  /** ISO 8601 with an explicit zone. */
  readonly createdAtIso: string;
  readonly lanes: readonly RelaunchPlanLaneEntry[];
}

/** A read by digest: the plan, known absence, an unknown version, or an unreadable store. */
export type RelaunchPlanReadResult =
  | { readonly status: 'ok'; readonly plan: unknown }
  | { readonly status: 'missing' }
  | { readonly status: 'unknown-version'; readonly foundVersion?: number }
  | { readonly status: 'unreadable'; readonly reasonCode?: string };

export interface RelaunchPlanRepositoryPort {
  /** Read one stored plan by its digest; known absence is `missing`, never empty content. */
  readByDigest(planDigest: string): Promise<RelaunchPlanReadResult>;
}
