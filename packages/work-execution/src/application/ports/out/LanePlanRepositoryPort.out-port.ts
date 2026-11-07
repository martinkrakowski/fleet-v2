// @generated outbound contract scaffold — refined for lane WB4a.
/**
 * LanePlanRepositoryPort persists lane-plan records **and** the plan's pull
 * request links (one lane per pull request, §3.2 "PR links are unique").
 * A plan is keyed (projectId, planId) and each save is a compare-and-swap
 * on `revision` — a stored revision >= the incoming one is an error, never
 * a silent overwrite. A link is keyed (repository, number); a stored link
 * is never replaced and never deleted. Known absence is null; unreadable
 * state is an error.
 */
import type {
  LanePlanRecord,
  PlannedLaneRef,
  PullRequestLinkConflictRecord,
  PullRequestLinkRecord,
} from '../../../domain/lane-plan-records.js';

export type SaveLanePlanResult =
  | { readonly outcome: 'saved' }
  | { readonly outcome: 'cycle'; readonly cycle: readonly PlannedLaneRef[] };

export type SavePullRequestLinkResult =
  | { readonly outcome: 'saved'; readonly link: PullRequestLinkRecord }
  | { readonly outcome: 'unchanged'; readonly link: PullRequestLinkRecord }
  | {
      readonly outcome: 'refused';
      readonly code: 'pr-already-linked' | 'invalid';
      readonly linkedLaneId: string | null;
    };

export type SavePullRequestLinkConflictResult =
  | { readonly outcome: 'saved'; readonly conflict: PullRequestLinkConflictRecord }
  | { readonly outcome: 'unchanged'; readonly conflict: PullRequestLinkConflictRecord }
  | { readonly outcome: 'refused'; readonly code: 'invalid' | 'store'; readonly message: string };

export interface LanePlanRepositoryPort {
  /** Persist one plan revision; CAS on `revision`: a stored revision >= the incoming one is an error, never a silent overwrite. */
  saveLanePlan(record: LanePlanRecord): Promise<void>;
  /** Atomically verify the plan introduces no dependency cycle across stored plans and persist it under the store's lock. */
  saveLanePlanIfAcyclic(record: LanePlanRecord): Promise<SaveLanePlanResult>;
  /** Known absence is null; unreadable state is an error. */
  findLanePlan(projectId: string, planId: string): Promise<LanePlanRecord | null>;
  /** Every stored plan, optionally narrowed to one project. */
  listLanePlans(projectId?: string): Promise<readonly LanePlanRecord[]>;
  /** Persist one pull request's link, keyed (repository, number). Create-if-absent: a stored link is never replaced and never deleted. */
  savePullRequestLink(record: PullRequestLinkRecord): Promise<SavePullRequestLinkResult>;
  /** Known absence is null; unreadable state is an error. */
  findPullRequestLink(repository: string, number: number): Promise<PullRequestLinkRecord | null>;
  /** Every stored link, optionally narrowed to one project. */
  listPullRequestLinks(projectId?: string): Promise<readonly PullRequestLinkRecord[]>;
  /**
   * Persist one pull-request link conflict (WB5b), keyed on the repository,
   * the number and both lane tuples. Create-if-absent: the same conflict is
   * never recorded twice. Optional so test doubles without conflict storage
   * keep working; callers must tolerate its absence.
   */
  savePullRequestLinkConflict?(record: PullRequestLinkConflictRecord): Promise<SavePullRequestLinkConflictResult>;
  /** Every stored conflict, optionally narrowed to one project. Optional for the same reason. */
  listPullRequestLinkConflicts?(projectId?: string): Promise<readonly PullRequestLinkConflictRecord[]>;
}
