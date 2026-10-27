/**
 * Strict mapping from the `GET /v1/attempts/:id/journal` envelope to the typed
 * journal entry list. Only recorded fields are carried: baseCommit,
 * workOrderId and observedSessionIds are deliberately not parsed (rule 6).
 */

import { isRecord } from "../../lib/attempt-wire";

export type JournalStatus =
  | "intent-recorded"
  | "completed"
  | "ambiguous"
  | "refused";

export interface JournalEntryView {
  readonly id: string;
  /** Recorded action, verbatim ("dispatch", "reconcile", "stop", "collect", "forge", or a later one). */
  readonly action: string;
  readonly status: JournalStatus;
  readonly recordedAtIso: string;
  readonly sessionId: string | null;
  /** As the server returned it: already redacted and capped. Never re-parsed. */
  readonly detail: string | null;
  readonly stopReason: string | null;
}

const JOURNAL_STATUSES: readonly JournalStatus[] = [
  "intent-recorded",
  "completed",
  "ambiguous",
  "refused",
];

function parseJournalEntry(value: unknown): JournalEntryView | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    return null;
  }
  if (typeof value.action !== "string" || value.action.length === 0) {
    return null;
  }
  if (!JOURNAL_STATUSES.includes(value.status as JournalStatus)) {
    return null;
  }
  if (typeof value.recordedAtIso !== "string") {
    return null;
  }
  for (const field of ["sessionId", "detail"] as const) {
    const v = value[field];
    if (v !== null && typeof v !== "string") {
      return null;
    }
  }
  const stopReason = value.stopReason;
  if (
    stopReason !== undefined &&
    stopReason !== null &&
    typeof stopReason !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    action: value.action,
    status: value.status as JournalStatus,
    recordedAtIso: value.recordedAtIso,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
    detail: typeof value.detail === "string" ? value.detail : null,
    stopReason: typeof stopReason === "string" ? stopReason : null,
  };
}

export function parseJournalEnvelope(
  value: unknown,
): readonly JournalEntryView[] | null {
  if (!isRecord(value) || value.code !== "OK") {
    return null;
  }
  const result = value.result;
  if (!isRecord(result) || result.outcome !== "listed") {
    return null;
  }
  if (!Array.isArray(result.entries)) {
    return null;
  }
  const entries: JournalEntryView[] = [];
  for (const item of result.entries) {
    const entry = parseJournalEntry(item);
    if (entry === null) {
      return null;
    }
    entries.push(entry);
  }
  return entries;
}
