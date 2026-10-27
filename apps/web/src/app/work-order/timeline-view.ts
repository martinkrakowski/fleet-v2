/**
 * Pure view helpers for the work-order timeline. No React, no imports from
 * server loaders except types.
 */

import type { RecordedAttemptWire } from "../../lib/attempt-wire";

export const MAX_TIMELINE_JOURNALS = 12;

export function workOrderHref(workOrderId: string): string {
  return `/work-order?id=${encodeURIComponent(workOrderId)}`;
}

export type ChainNote =
  | { readonly kind: "first-pass" }
  | { readonly kind: "fix-of"; readonly priorAttemptId: string }
  | { readonly kind: "prior-missing"; readonly priorAttemptId: string }
  | { readonly kind: "no-prior-recorded" };

export function chainNote(
  attempt: RecordedAttemptWire,
  recordedIds: ReadonlySet<string>,
): ChainNote {
  if (attempt.priorAttemptId === null) {
    return attempt.kind === "initial"
      ? { kind: "first-pass" }
      : { kind: "no-prior-recorded" };
  }
  return recordedIds.has(attempt.priorAttemptId)
    ? { kind: "fix-of", priorAttemptId: attempt.priorAttemptId }
    : { kind: "prior-missing", priorAttemptId: attempt.priorAttemptId };
}

export function chainNoteText(note: ChainNote): string {
  switch (note.kind) {
    case "first-pass":
      return "first pass";
    case "fix-of":
      return `fix of ${note.priorAttemptId}`;
    case "prior-missing":
      return `fix of ${note.priorAttemptId} · that attempt is not among this work order's recorded attempts`;
    case "no-prior-recorded":
      return "fix with no prior attempt recorded";
  }
}

export function journalReadIds(
  ordered: readonly RecordedAttemptWire[],
): ReadonlySet<string> {
  // The read window is the newest attempts by creation time; chain order only
  // controls display. The sort is stable, so equal times keep chain order.
  const byCreation = [...ordered].sort((left, right) =>
    compareIso(left.createdAtIso, right.createdAtIso),
  );
  const start = Math.max(0, byCreation.length - MAX_TIMELINE_JOURNALS);
  return new Set(byCreation.slice(start).map((attempt) => attempt.id));
}

function compareIso(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export function notReadText(notRead: number): string {
  if (notRead <= 0) {
    return "";
  }
  return `${notRead} older attempt(s): journal not read on this page (only the newest ${MAX_TIMELINE_JOURNALS} attempts are read)`;
}
