// @generated outbound contract scaffold — refined for lane WB4a.
/**
 * LanePlanRepositoryPort persists lane-plan records (work-board plan §3.2):
 * a plan is keyed (projectId, planId) and each save is a compare-and-swap
 * on `revision` — a stored revision >= the incoming one is an error, never
 * a silent overwrite. Known absence is null; unreadable state is an error.
 */
import type { LanePlanRecord, PlannedLaneRef } from '../../../domain/lane-plan-records.js';

export type SaveLanePlanResult =
  | { readonly outcome: 'saved' }
  | { readonly outcome: 'cycle'; readonly cycle: readonly PlannedLaneRef[] };

export interface LanePlanRepositoryPort {
  /** Persist one plan revision; CAS on `revision`: a stored revision >= the incoming one is an error, never a silent overwrite. */
  saveLanePlan(record: LanePlanRecord): Promise<void>;
  /** Atomically verify the plan introduces no dependency cycle across stored plans and persist it under the store's lock. */
  saveLanePlanIfAcyclic(record: LanePlanRecord): Promise<SaveLanePlanResult>;
  /** Known absence is null; unreadable state is an error. */
  findLanePlan(projectId: string, planId: string): Promise<LanePlanRecord | null>;
  /** Every stored plan, optionally narrowed to one project. */
  listLanePlans(projectId?: string): Promise<readonly LanePlanRecord[]>;
}
