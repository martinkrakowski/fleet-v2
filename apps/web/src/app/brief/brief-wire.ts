/**
 * Local copy of the work-order brief wire shape, from `WorkOrderRecord` and
 * `AttemptRecord` (`packages/work-execution/src/domain/execution-records.ts`).
 * `apps/web` may not import `@fleet/work-execution`; this file is the only
 * place the shape lives in the web app. Every field is readonly. Host paths,
 * worktree paths and ports are never part of this shape.
 */

export interface WorkOrderBriefItem {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly laneId: string;
  readonly state: string;
  readonly revision: number;
  readonly baseCommit: string;
  readonly baseBranch?: string;
  readonly policyRevision: number;
  readonly risk?: "standard" | "high";
  readonly ownedPaths: readonly string[];
  readonly prerequisiteWorkOrderIds: readonly string[];
  readonly pullRequestTitle?: string;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export interface AttemptBriefSummary {
  readonly id: string;
  readonly workOrderId: string;
  readonly kind: "initial" | "fix";
  readonly fixNumber: number;
  readonly state: string;
  readonly outcome: string | null;
  readonly baseCommit: string;
  readonly briefDigest: string | null;
  readonly ownerDecisionReferences: readonly string[] | null;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export interface WorkOrderBriefEntry {
  readonly workOrder: WorkOrderBriefItem;
  readonly latestAttempt: AttemptBriefSummary | null;
  readonly briefMarkdown: string | null;
}

export interface WorkOrderBriefList {
  readonly entries: readonly WorkOrderBriefEntry[];
}
