import { describe, expect, it } from "vitest";
import {
  journalCountText,
  journalStatusNote,
  journalStatusTone,
} from "./journal-view";
import type { JournalEntryView } from "./map-journal";

function entry(overrides: Partial<JournalEntryView> = {}): JournalEntryView {
  return {
    id: "jr_1",
    action: "dispatch",
    status: "completed",
    recordedAtIso: "2026-10-24T10:00:05Z",
    sessionId: "ses_live_1",
    detail: null,
    stopReason: null,
    ...overrides,
  };
}

describe("journalStatusTone", () => {
  it("maps every status to a badge tone", () => {
    expect(journalStatusTone("intent-recorded")).toBe("queued");
    expect(journalStatusTone("completed")).toBe("ended");
    expect(journalStatusTone("ambiguous")).toBe("unknown");
    expect(journalStatusTone("refused")).toBe("blocked");
  });
});

describe("journalStatusNote", () => {
  it("notes intent-recorded", () => {
    expect(journalStatusNote(entry({ status: "intent-recorded" }))).toBe(
      "intent recorded before the action ran",
    );
  });

  it("notes completed", () => {
    expect(journalStatusNote(entry({ status: "completed" }))).toBe(
      "result recorded",
    );
  });

  it("notes ambiguous", () => {
    expect(journalStatusNote(entry({ status: "ambiguous" }))).toBe(
      "result not confirmed: unknown, not a pass",
    );
  });

  it("notes refused without a stop reason", () => {
    expect(journalStatusNote(entry({ status: "refused" }))).toBe("refused");
  });

  it("names the stop reason when recorded", () => {
    expect(
      journalStatusNote(
        entry({ status: "refused", stopReason: "budget exhausted" }),
      ),
    ).toBe("refused · stop reason budget exhausted");
  });

  it("appends the stop reason suffix for other statuses too", () => {
    expect(
      journalStatusNote(entry({ status: "ambiguous", stopReason: "timeout" })),
    ).toBe("result not confirmed: unknown, not a pass · stop reason timeout");
  });
});

describe("journalCountText", () => {
  it("says no entries for zero", () => {
    expect(journalCountText(0)).toBe("no entries recorded");
  });

  it("says one entry", () => {
    expect(journalCountText(1)).toBe("1 entry, recorded order");
  });

  it("counts entries", () => {
    expect(journalCountText(3)).toBe("3 entries, recorded order");
  });
});
