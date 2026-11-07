import type {
  OwnerTodoClosedBy,
  OwnerTodoEntry,
  OwnerTodoList,
} from "./todo-wire";

export const TODO_GROUPS = ["blocking", "yours", "clears"] as const;

export type TodoGroup = (typeof TODO_GROUPS)[number];

export const TODO_GROUP_TITLES: Record<TodoGroup, string> = {
  blocking: "Blocking lanes",
  yours: "Yours to do",
  clears: "Clears on its own",
};

export function groupForEntry(entry: OwnerTodoEntry): TodoGroup {
  if (entry.gating) return "blocking";
  if (
    entry.origin === "owner-item" &&
    (entry.kind === "secret" ||
      entry.kind === "backup" ||
      entry.kind === "other")
  ) {
    return "yours";
  }
  return "clears";
}

export function sortTodoEntries(
  entries: readonly OwnerTodoEntry[],
): OwnerTodoEntry[] {
  return [...entries].sort((a, b) => {
    if (a.gating !== b.gating) return a.gating ? -1 : 1;
    if (a.sinceIso !== b.sinceIso) {
      return a.sinceIso < b.sinceIso ? -1 : 1;
    }
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });
}

export function groupTodoEntries(
  entries: readonly OwnerTodoEntry[],
): Record<TodoGroup, OwnerTodoEntry[]> {
  const groups: Record<TodoGroup, OwnerTodoEntry[]> = {
    blocking: [],
    yours: [],
    clears: [],
  };
  for (const entry of sortTodoEntries(entries)) {
    groups[groupForEntry(entry)].push(entry);
  }
  return groups;
}

export function todoBadgeCount(list: OwnerTodoList): number {
  return list.counts.total;
}

const CLOSED_BY_TEXT: Record<OwnerTodoClosedBy, string> = {
  owner: "yours to mark done",
  "merge-observed": "clears when the merge is observed",
  "recorded-choice": "clears when the choice is recorded",
  answer: "clears when the question is answered",
};

export function todoClosedByText(closedBy: OwnerTodoClosedBy): string {
  return CLOSED_BY_TEXT[closedBy];
}

export function todoAgeText(ageDays: number): string {
  if (ageDays <= 0) return "today";
  if (ageDays === 1) return "1 day";
  return `${ageDays} days`;
}

export function todoRowLabel(entry: OwnerTodoEntry): string {
  if (entry.origin === "question") return "Question";
  return entry.kind.charAt(0).toUpperCase() + entry.kind.slice(1);
}

export function todoRowHref(entry: OwnerTodoEntry): string | null {
  if (entry.origin === "question") return "/questions";
  return null;
}

export function todoUnreadSources(list: OwnerTodoList): string[] {
  return list.sources
    .filter((source) => source.status === "not-read")
    .map((source) => source.source);
}
