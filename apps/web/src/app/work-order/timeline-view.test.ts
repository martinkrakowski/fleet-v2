import { describe, expect, it } from "vitest";
import type { RecordedAttemptWire } from "../../lib/attempt-wire";
import {
  chainNote,
  chainNoteText,
  journalReadIds,
  notReadText,
  workOrderHref,
} from "./timeline-view";

function attempt(
  id: string,
  overrides: Partial<RecordedAttemptWire> = {},
): RecordedAttemptWire {
  return {
    id,
    workOrderId: "wo-live-1",
    kind: "initial",
    fixNumber: 1,
    priorAttemptId: null,
    state: "ended",
    outcome: "ok",
    sessionId: "ses_live_1",
    createdAtIso: "2026-10-24T10:00:00Z",
    updatedAtIso: "2026-10-24T10:05:00Z",
    runner: null,
    usage: null,
    artifacts: null,
    ...overrides,
  };
}

describe("timeline-view pure helpers", () => {
  it("builds the work-order href with an encoded id", () => {
    expect(workOrderHref("wo 1/../x")).toBe(
      "/work-order?id=wo%201%2F..%2Fx",
    );
  });

  it("notes a first pass for an initial attempt with no prior", () => {
    const note = chainNote(
      attempt("att_live_1"),
      new Set(["att_live_1"]),
    );
    expect(note).toEqual({ kind: "first-pass" });
    expect(chainNoteText(note)).toBe("first pass");
  });

  it("notes a fix with no prior for a fix attempt with no prior", () => {
    const note = chainNote(
      attempt("att_live_2", { kind: "fix" }),
      new Set(["att_live_2"]),
    );
    expect(note).toEqual({ kind: "no-prior-recorded" });
    expect(chainNoteText(note)).toBe("fix with no prior attempt recorded");
  });

  it("notes a fix of a recorded prior attempt", () => {
    const note = chainNote(
      attempt("att_live_2", {
        kind: "fix",
        priorAttemptId: "att_live_1",
      }),
      new Set(["att_live_1", "att_live_2"]),
    );
    expect(note).toEqual({
      kind: "fix-of",
      priorAttemptId: "att_live_1",
    });
    expect(chainNoteText(note)).toBe("fix of att_live_1");
  });

  it("notes a prior attempt that is not recorded on the work order", () => {
    const note = chainNote(
      attempt("att_live_2", {
        kind: "fix",
        priorAttemptId: "att_live_999",
      }),
      new Set(["att_live_2"]),
    );
    expect(note).toEqual({
      kind: "prior-missing",
      priorAttemptId: "att_live_999",
    });
    expect(chainNoteText(note)).toBe(
      "fix of att_live_999 · that attempt is not among this work order's recorded attempts",
    );
  });

  it("keeps exactly the newest 12 journal-read ids", () => {
    const fourteen = Array.from({ length: 14 }, (_, index) =>
      attempt(`att_live_${index + 1}`, {
        kind: "fix",
        fixNumber: index + 1,
      }),
    );
    const readIds = journalReadIds(fourteen);
    expect(readIds.size).toBe(12);
    expect([...readIds]).toEqual(
      fourteen.slice(-12).map((entry) => entry.id),
    );
  });

  it("renders the not-read header text", () => {
    expect(notReadText(0)).toBe("");
    expect(notReadText(1)).toBe(
      "1 older attempt(s): journal not read on this page",
    );
    expect(notReadText(2)).toBe(
      "2 older attempt(s): journal not read on this page",
    );
  });
});
