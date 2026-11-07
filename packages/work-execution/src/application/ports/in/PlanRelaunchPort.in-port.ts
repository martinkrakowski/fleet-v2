// @generated inbound contract scaffold — refined for lane CO29a.
/**
 * PlanRelaunchPort: build and store the ordered relaunch plan (cutover plan
 * CO29a, §4 steps 2–7). Strictly read-only over the relaunch inventory and the
 * work-execution records: it reads, orders and stores one immutable plan keyed
 * by its canonical digest, and it stops, aborts, adopts and dispatches
 * nothing. A conducted run is never stopped (D-CO10). Results carry ids,
 * counts, digests and fixed codes only; never a path, an exception message or
 * a rejected input value.
 */

import type { RelaunchPlanRecord } from '../out/RelaunchPlanRepositoryPort.out-port.js';
import type { RelaunchCloneRef } from './InventoryRelaunchPort.in-port.js';

export const DEFAULT_RELAUNCH_MAX_ACTIVE_RUNS = 8 as const;

export interface PlanRelaunchRequest {
  /** The read's clock: an ISO 8601 instant with an explicit zone. */
  readonly nowIso: string;
  /** The lane host to plan; null plans every host. */
  readonly hostName: string | null;
  /** The registered clones to read (D18: registered clones only). */
  readonly clones: readonly RelaunchCloneRef[];
  /** The admission cap per wave; an integer 1..64, default 8. */
  readonly maxActiveRuns?: number;
  /** The minimum interval between starts per runner endpoint; an integer 0..600000, default 20000. */
  readonly dispatchStaggerMs?: number;
  /** When set, no outbound call starts once this instant has passed. */
  readonly deadlineIso?: string | null;
}

export type PlanRelaunchUnknownReason =
  | 'profile-records-unreadable'
  | 'inventory-records-unreadable'
  | 'unknown-worktree-read'
  | 'unproven-lane-records'
  | 'unknown-runner-state'
  | 'driver-lease-unknown'
  | 'store-read-failed';

export type PlanRelaunchRefusalReason =
  | 'invalid-request'
  | 'budget-exhausted'
  | 'limit-exceeded'
  | 'dependency-cycle'
  | 'digest-mismatch'
  | 'digest-conflict'
  | 'store-unreadable'
  | 'store-unknown-version'
  | 'store-read-only'
  | 'store-limit-exceeded';

export type PlanRelaunchResult =
  | {
      readonly outcome: 'planned';
      readonly planDigest: string;
      /** True when the identical plan was already stored; nothing was written. */
      readonly reused: boolean;
      readonly plan: RelaunchPlanRecord;
    }
  | { readonly outcome: 'unknown'; readonly reasons: readonly PlanRelaunchUnknownReason[] }
  | { readonly outcome: 'refused'; readonly reason: PlanRelaunchRefusalReason };

export interface PlanRelaunchPort {
  planRelaunch(request: PlanRelaunchRequest): Promise<PlanRelaunchResult>;
}
