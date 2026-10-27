/**
 * Pure view helpers for the journal panel. No React, no imports from the
 * server loader except types.
 */

import type { JournalEntryView, JournalStatus } from "./map-journal";

export function journalStatusTone(
  status: JournalStatus,
): "queued" | "ended" | "unknown" | "blocked" {
  switch (status) {
    case "intent-recorded":
      return "queued";
    case "completed":
      return "ended";
    case "ambiguous":
      return "unknown";
    case "refused":
      return "blocked";
  }
}

export function journalStatusNote(entry: JournalEntryView): string {
  let base: string;
  switch (entry.status) {
    case "intent-recorded":
      base = "intent recorded before the action ran";
      break;
    case "completed":
      base = "result recorded";
      break;
    case "ambiguous":
      base = "result not confirmed: unknown, not a pass";
      break;
    case "refused":
      base = "refused";
      break;
  }
  return entry.stopReason !== null
    ? `${base} · stop reason ${entry.stopReason}`
    : base;
}

export function journalCountText(count: number): string {
  if (count === 0) {
    return "no entries recorded";
  }
  if (count === 1) {
    return "1 entry, recorded order";
  }
  return `${count} entries, recorded order`;
}
