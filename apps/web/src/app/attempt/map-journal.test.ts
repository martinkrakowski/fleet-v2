import { describe, expect, it } from "vitest";
import { parseJournalEnvelope } from "./map-journal";

const ENTRY_A = {
  id: "jr_1",
  attemptId: "att_live_1",
  workOrderId: "wo-live-1",
  action: "dispatch",
  baseCommit: "a".repeat(40),
  recordedAtIso: "2026-10-24T10:00:05Z",
  status: "completed",
  sessionId: "ses_live_1",
  detail: null,
  observedSessionIds: ["ses_live_1"],
};

const ENTRY_B = {
  id: "jr_2",
  attemptId: "att_live_1",
  workOrderId: "wo-live-1",
  action: "collect",
  baseCommit: "a".repeat(40),
  recordedAtIso: "2026-10-24T10:00:10Z",
  status: "ambiguous",
  sessionId: null,
  detail: "[detail withheld: secret-shaped (example)]",
};

function listedEnvelope(entries: unknown[]) {
  return {
    code: "OK",
    result: { outcome: "listed", attemptId: "att_live_1", entries },
  };
}

describe("parseJournalEnvelope", () => {
  it("keeps entries in the order the server returned them, even when times are out of order", () => {
    const parsed = parseJournalEnvelope(
      listedEnvelope([
        { ...ENTRY_B },
        { ...ENTRY_A },
        { ...ENTRY_A, id: "jr_3", recordedAtIso: "2026-10-24T09:00:00Z" },
      ]),
    );
    expect(parsed).not.toBeNull();
    if (parsed === null) {
      throw new Error("expected a listed envelope");
    }
    expect(parsed.map((entry) => entry.id)).toEqual([
      "jr_2",
      "jr_1",
      "jr_3",
    ]);
  });

  it("parses an empty entries array", () => {
    expect(parseJournalEnvelope(listedEnvelope([]))).toEqual([]);
  });

  it("keeps a forge action", () => {
    const parsed = parseJournalEnvelope(
      listedEnvelope([{ ...ENTRY_A, action: "forge" }]),
    );
    expect(parsed).not.toBeNull();
    if (parsed === null) {
      throw new Error("expected a listed envelope");
    }
    expect(parsed[0].action).toBe("forge");
  });

  it("returns null for an unknown status", () => {
    expect(
      parseJournalEnvelope(
        listedEnvelope([{ ...ENTRY_A, status: "passed" }]),
      ),
    ).toBeNull();
  });

  it("keeps detail byte-identical", () => {
    const img = '<img src=x onerror=alert(1)>';
    const withheld = "[detail withheld: secret-shaped (example)]";
    const parsed = parseJournalEnvelope(
      listedEnvelope([
        { ...ENTRY_A, detail: img },
        { ...ENTRY_B, detail: withheld },
      ]),
    );
    expect(parsed).not.toBeNull();
    if (parsed === null) {
      throw new Error("expected a listed envelope");
    }
    expect(parsed[0].detail).toBe(img);
    expect(parsed[1].detail).toBe(withheld);
  });

  it("returns null for a non-OK code", () => {
    expect(
      parseJournalEnvelope({
        code: "NOT_FOUND",
        result: { outcome: "listed", attemptId: "att_live_1", entries: [] },
      }),
    ).toBeNull();
  });

  it("drops baseCommit and observedSessionIds", () => {
    const parsed = parseJournalEnvelope(listedEnvelope([ENTRY_A]));
    const json = JSON.stringify(parsed);
    expect(json).not.toContain("baseCommit");
    expect(json).not.toContain("observedSessionIds");
    expect(json).not.toContain("workOrderId");
  });

  it("returns null when an entry is malformed", () => {
    expect(
      parseJournalEnvelope(
        listedEnvelope([{ ...ENTRY_A, sessionId: 42 }]),
      ),
    ).toBeNull();
  });
});
