/**
 * Local copy of the owner to-do wire shape, from
 * `docs/planning/2026-10-28_owner-todo-section-plan.md` section 3.2 (lines
 * 66–82). `apps/web` may not import `@fleet/work-execution`; this file is the
 * only place the shape lives in the web app. Every field is readonly.
 */

export type OwnerTodoKind =
  | "merge"
  | "secret"
  | "decision"
  | "backup"
  | "other";

export type OwnerTodoOrigin = "owner-item" | "question";

export type OwnerTodoClosedBy =
  | "owner"
  | "merge-observed"
  | "recorded-choice"
  | "answer";

export interface OwnerTodoEntry {
  readonly origin: OwnerTodoOrigin;
  readonly id: string;
  readonly projectId: string | null;
  readonly kind: OwnerTodoKind;
  readonly subject: string | null;
  readonly sinceIso: string;
  readonly ageDays: number;
  readonly gating: boolean;
  readonly gatesLanes: readonly string[];
  readonly namesLanes: readonly string[];
  readonly questionIds: readonly string[];
  readonly closedBy: OwnerTodoClosedBy;
  readonly commands: readonly string[];
}

export interface OwnerTodoCounts {
  readonly total: number;
  readonly gating: number;
  readonly yours: number;
  readonly clearsItself: number;
}

export interface OwnerTodoSourceReading {
  readonly source: string;
  readonly repository: string | null;
  readonly readAtIso: string | null;
  readonly status: "read" | "not-read";
  readonly reason: string | null;
}

export interface OwnerTodoList {
  readonly schemaVersion: 1;
  readonly readAtIso: string;
  readonly sources: readonly OwnerTodoSourceReading[];
  readonly complete: boolean;
  readonly counts: OwnerTodoCounts;
  readonly parksWithoutItem: number | null;
  readonly entries: readonly OwnerTodoEntry[];
}
