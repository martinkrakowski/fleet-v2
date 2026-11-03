// @generated inbound contract scaffold — refined for lane WB4c.
/**
 * SyncPlanDecisionsPort: bring the owner items of one stored plan's decisions
 * in line with the record (work-board plan §3.2, §3.9). Each `open` decision
 * has one owner item keyed (projectId, planId, decisionId); a `decided`
 * decision resolves it `plan-decided`; an id the record no longer carries
 * resolves `decision-removed` — but only when the caller proved what the
 * previous revision held (`previousDecisionIds`), never on `null`.
 */

export interface SyncPlanDecisionsRequest {
  readonly projectId: string;
  readonly planId: string;
  /** The previous revision's decision ids, or null when unproved: no removals then. */
  readonly previousDecisionIds: readonly string[] | null;
}

export type SyncPlanDecisionsDecisionOutcome =
  | 'opened' | 'exists' | 'resolved' | 'unchanged' | 'not-found' | 'refused';

export type SyncPlanDecisionsDecisionResult =
  | { readonly decisionId: string; readonly outcome: Exclude<SyncPlanDecisionsDecisionOutcome, 'refused'> }
  | { readonly decisionId: string; readonly outcome: 'refused'; readonly code: string };

export type SyncPlanDecisionsRefusalCode = 'plan-unread' | 'all-refused';

export type SyncPlanDecisionsResult =
  | { readonly outcome: 'synced' | 'partial'; readonly decisions: readonly SyncPlanDecisionsDecisionResult[] }
  | {
      readonly outcome: 'refused';
      readonly code: SyncPlanDecisionsRefusalCode;
      readonly reason: string;
      readonly decisions: readonly SyncPlanDecisionsDecisionResult[];
    };

export interface SyncPlanDecisionsPort {
  /** Sync one plan's decision items. Never throws past the port boundary. */
  execute(request: SyncPlanDecisionsRequest): Promise<SyncPlanDecisionsResult>;
}
