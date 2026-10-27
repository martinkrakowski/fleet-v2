/**
 * Pure view helpers for the Questions page: filters, counts, ordering,
 * tones, CLI copy commands and the live-region summary. No React, no import
 * from a "use client" module.
 */

import type { QuestionBlock, QuestionState, QuestionView } from "./map-question";
import { shellQuote } from "../attempt/live-view";

export type StateFilter = "open" | "answered" | "rejected" | "expired" | "all";

export const STATE_FILTERS: readonly StateFilter[] = [
  "open",
  "answered",
  "rejected",
  "expired",
  "all",
];

export function parseStateFilter(value: string | null): StateFilter {
  switch (value) {
    case "open":
    case "answered":
    case "rejected":
    case "expired":
    case "all":
      return value;
    default:
      return "open";
  }
}

export function matchesState(q: QuestionView, filter: StateFilter): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "answered") {
    return q.state === "answered" || q.state === "acknowledged";
  }
  return q.state === filter;
}

export function filterQuestions(
  qs: readonly QuestionView[],
  f: { state: StateFilter; blockingOnly: boolean; oneWayOnly: boolean },
): readonly QuestionView[] {
  return qs.filter(
    (q) =>
      matchesState(q, f.state) &&
      (!f.blockingOnly || q.blocks.length > 0) &&
      (!f.oneWayOnly || q.doorKind === "one-way"),
  );
}

export function stateCounts(
  qs: readonly QuestionView[],
): Readonly<Record<StateFilter, number>> {
  let open = 0;
  let answered = 0;
  let rejected = 0;
  let expired = 0;
  for (const q of qs) {
    switch (q.state) {
      case "open":
        open += 1;
        break;
      case "answered":
      case "acknowledged":
        answered += 1;
        break;
      case "rejected":
        rejected += 1;
        break;
      case "expired":
        expired += 1;
        break;
    }
  }
  return { open, answered, rejected, expired, all: qs.length };
}

export function newestFirst(
  qs: readonly QuestionView[],
): readonly QuestionView[] {
  return [...qs].sort(
    (a, b) =>
      b.askedAt.localeCompare(a.askedAt) ||
      a.questionId.localeCompare(b.questionId),
  );
}

export function stateTone(
  state: QuestionState,
): "queued" | "accepted" | "failed" | "ended" {
  switch (state) {
    case "open":
      return "queued";
    case "answered":
    case "acknowledged":
      return "accepted";
    case "rejected":
      return "failed";
    case "expired":
      return "ended";
  }
}

export function blocksText(blocks: readonly QuestionBlock[]): string {
  if (blocks.length === 0) {
    return "blocks nothing recorded";
  }
  return blocks.map((b) => `${b.kind} ${b.ref}`).join(", ");
}

export function answerCommands(q: QuestionView): readonly string[] {
  if (q.state !== "open" || q.doorKind !== "two-way") {
    return [];
  }
  const id = shellQuote(q.questionId);
  const rev = String(q.revision);
  return [
    `fleet-v2 questions answer ${id} --revision ${rev} --accept`,
    `fleet-v2 questions answer ${id} --revision ${rev} --reject`,
    `fleet-v2 questions answer ${id} --revision ${rev} --option ${shellQuote(q.recommendation.optionId)}`,
  ];
}

export function isPastExpiry(q: QuestionView, observedAtIso: string): boolean {
  if (q.state !== "open" || q.expiresAt === null) {
    return false;
  }
  const expires = Date.parse(q.expiresAt);
  const observed = Date.parse(observedAtIso);
  if (!Number.isFinite(expires) || !Number.isFinite(observed)) {
    return false;
  }
  return expires < observed;
}

export function summaryText(qs: readonly QuestionView[]): string {
  let open = 0;
  let oneWay = 0;
  for (const q of qs) {
    if (q.state === "open") {
      open += 1;
      if (q.doorKind === "one-way") {
        oneWay += 1;
      }
    }
  }
  if (open === 0) {
    return "no open questions";
  }
  return `${open} open question${open === 1 ? "" : "s"} · ${oneWay} one-way`;
}
