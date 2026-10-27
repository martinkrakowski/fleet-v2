import { describe, expect, it } from "vitest";
import {
  parseRecordedArtifacts,
  parseRecordedAttempt,
  parseRecordedRunner,
  parseRecordedUsage,
  usageCost,
} from "./attempt-wire";

describe("parseRecordedRunner", () => {
  it("parses a full runner", () => {
    expect(
      parseRecordedRunner({
        kind: "opencode",
        agent: "lane",
        model: "example/model-a",
        variant: null,
      }),
    ).toEqual({
      kind: "opencode",
      agent: "lane",
      model: "example/model-a",
      variant: null,
    });
  });

  it("reads absent agent, model and variant as null", () => {
    expect(parseRecordedRunner({ kind: "agy" })).toEqual({
      kind: "agy",
      agent: null,
      model: null,
      variant: null,
    });
  });

  it("returns null for null and undefined", () => {
    expect(parseRecordedRunner(null)).toBeNull();
    expect(parseRecordedRunner(undefined)).toBeNull();
  });

  it("returns undefined for a malformed runner", () => {
    expect(parseRecordedRunner({})).toBeUndefined();
    expect(parseRecordedRunner({ kind: "" })).toBeUndefined();
    expect(parseRecordedRunner({ kind: "opencode", agent: 7 })).toBeUndefined();
    expect(parseRecordedRunner("opencode")).toBeUndefined();
  });

  it("ignores recorded host facts", () => {
    expect(
      parseRecordedRunner({
        kind: "opencode",
        host: "h-1",
        hostName: "host",
        remotePort: 1,
        useFreeSeats: true,
        agent: "lane",
        model: "example/model-a",
        variant: null,
      }),
    ).toEqual({
      kind: "opencode",
      agent: "lane",
      model: "example/model-a",
      variant: null,
    });
  });
});

describe("parseRecordedUsage", () => {
  const full = {
    source: "opencode-db",
    readAtIso: "2026-10-24T10:05:00Z",
    steps: 40,
    wallSeconds: 1500,
    tokensInput: 1000,
    tokensOutput: 500,
    costUsd: 0.12,
    model: "example/model-a",
    reason: null,
  };

  it("parses a full usage record", () => {
    expect(parseRecordedUsage(full)).toEqual(full);
  });

  it("parses an unavailable usage record", () => {
    expect(
      parseRecordedUsage({
        source: "unavailable",
        readAtIso: "2026-10-24T10:05:00Z",
        steps: null,
        wallSeconds: null,
        tokensInput: null,
        tokensOutput: null,
        costUsd: null,
        model: null,
        reason: "the usage db cannot be read",
      }),
    ).toEqual({
      source: "unavailable",
      readAtIso: "2026-10-24T10:05:00Z",
      steps: null,
      wallSeconds: null,
      tokensInput: null,
      tokensOutput: null,
      costUsd: null,
      model: null,
      reason: "the usage db cannot be read",
    });
  });

  it("returns null for null and undefined", () => {
    expect(parseRecordedUsage(null)).toBeNull();
    expect(parseRecordedUsage(undefined)).toBeNull();
  });

  it("returns undefined for a malformed usage", () => {
    expect(parseRecordedUsage({ source: "guessed" })).toBeUndefined();
    expect(parseRecordedUsage({ source: "opencode-db" })).toBeUndefined();
    expect(parseRecordedUsage({ ...full, steps: "40" })).toBeUndefined();
    expect(parseRecordedUsage({ ...full, wallSeconds: NaN })).toBeUndefined();
    expect(parseRecordedUsage({ ...full, model: 7 })).toBeUndefined();
    expect(parseRecordedUsage("usage")).toBeUndefined();
  });

  it("reads absent numeric fields as null", () => {
    expect(
      parseRecordedUsage({
        source: "opencode-db",
        readAtIso: "2026-10-24T10:05:00Z",
      }),
    ).toEqual({
      source: "opencode-db",
      readAtIso: "2026-10-24T10:05:00Z",
      steps: null,
      wallSeconds: null,
      tokensInput: null,
      tokensOutput: null,
      costUsd: null,
      model: null,
      reason: null,
    });
  });
});

describe("parseRecordedArtifacts", () => {
  it("parses collected artifacts and derives commitCount", () => {
    expect(
      parseRecordedArtifacts({
        headCommit: "a".repeat(40),
        commitsSinceBase: ["b".repeat(40), "c".repeat(40)],
        collectedArtifactPaths: [".lane/notes.md"],
        notes: "present",
      }),
    ).toEqual({
      headCommit: "a".repeat(40),
      commitCount: 2,
      notes: "present",
    });
  });

  it("parses missing notes with zero commits", () => {
    expect(
      parseRecordedArtifacts({
        headCommit: "a".repeat(40),
        commitsSinceBase: [],
        notes: "missing",
      }),
    ).toEqual({ headCommit: "a".repeat(40), commitCount: 0, notes: "missing" });
  });

  it("returns null for null and undefined", () => {
    expect(parseRecordedArtifacts(null)).toBeNull();
    expect(parseRecordedArtifacts(undefined)).toBeNull();
  });

  it("returns undefined for malformed artifacts", () => {
    expect(parseRecordedArtifacts({})).toBeUndefined();
    expect(
      parseRecordedArtifacts({
        headCommit: "",
        commitsSinceBase: [],
        notes: "present",
      }),
    ).toBeUndefined();
    expect(
      parseRecordedArtifacts({
        headCommit: "a".repeat(40),
        commitsSinceBase: [7],
        notes: "present",
      }),
    ).toBeUndefined();
    expect(
      parseRecordedArtifacts({
        headCommit: "a".repeat(40),
        commitsSinceBase: [],
        notes: "kept",
      }),
    ).toBeUndefined();
    expect(parseRecordedArtifacts("artifacts")).toBeUndefined();
  });
});

describe("parseRecordedAttempt", () => {
  const baseAttempt = {
    id: "att_live_1",
    workOrderId: "wo-live-1",
    kind: "initial",
    fixNumber: 1,
    priorAttemptId: null,
    state: "running",
    outcome: null,
    sessionId: "ses_live_1",
    createdAtIso: "2026-10-24T10:00:00Z",
    updatedAtIso: "2026-10-24T10:05:00Z",
  };

  it("parses a record with no runner, usage or artifacts as null", () => {
    expect(parseRecordedAttempt(baseAttempt)).toEqual({
      ...baseAttempt,
      runner: null,
      usage: null,
      artifacts: null,
    });
  });

  it("parses the recorded sub-records", () => {
    expect(
      parseRecordedAttempt({
        ...baseAttempt,
        runner: {
          kind: "opencode",
          agent: "lane",
          model: "example/model-a",
          variant: null,
        },
        usage: {
          source: "opencode-db",
          readAtIso: "2026-10-24T10:05:00Z",
          steps: 40,
          wallSeconds: 1500,
          tokensInput: 1000,
          tokensOutput: 500,
          costUsd: 0.12,
          model: "example/model-a",
          reason: null,
        },
        artifacts: {
          headCommit: "a".repeat(40),
          commitsSinceBase: [],
          notes: "present",
        },
      }),
    ).toEqual({
      ...baseAttempt,
      runner: {
        kind: "opencode",
        agent: "lane",
        model: "example/model-a",
        variant: null,
      },
      usage: {
        source: "opencode-db",
        readAtIso: "2026-10-24T10:05:00Z",
        steps: 40,
        wallSeconds: 1500,
        tokensInput: 1000,
        tokensOutput: 500,
        costUsd: 0.12,
        model: "example/model-a",
        reason: null,
      },
      artifacts: {
        headCommit: "a".repeat(40),
        commitCount: 0,
        notes: "present",
      },
    });
  });

  it("returns null when a required base field is malformed", () => {
    expect(parseRecordedAttempt({ ...baseAttempt, id: 7 })).toBeNull();
    expect(parseRecordedAttempt({ ...baseAttempt, kind: "other" })).toBeNull();
    expect(parseRecordedAttempt({ ...baseAttempt, fixNumber: -1 })).toBeNull();
    expect(parseRecordedAttempt(null)).toBeNull();
  });

  it("returns null when a sub-record is malformed", () => {
    expect(
      parseRecordedAttempt({ ...baseAttempt, runner: { kind: 7 } }),
    ).toBeNull();
    expect(
      parseRecordedAttempt({ ...baseAttempt, usage: { source: "guessed" } }),
    ).toBeNull();
    expect(
      parseRecordedAttempt({ ...baseAttempt, artifacts: { notes: "kept" } }),
    ).toBeNull();
  });
});

describe("usageCost", () => {
  const usage = {
    source: "opencode-db",
    readAtIso: "2026-10-24T10:05:00Z",
    steps: 40,
    wallSeconds: 1500,
    tokensInput: 1000,
    tokensOutput: 500,
    costUsd: 0.12,
    model: "example/model-a",
    reason: null,
  } as const;

  it("is null when usage is null", () => {
    expect(usageCost(null)).toBeNull();
  });

  it("computes minutes by rounding wall seconds", () => {
    expect(usageCost(usage)).toEqual({ steps: 40, minutes: 25, usd: 0.12 });
  });

  it("counts a free seat's zero cost", () => {
    expect(usageCost({ ...usage, costUsd: 0 })).toEqual({
      steps: 40,
      minutes: 25,
      usd: 0,
    });
  });

  it("stays null when costUsd is null", () => {
    expect(usageCost({ ...usage, costUsd: null })).toBeNull();
  });

  it("stays null when the source is unavailable", () => {
    expect(
      usageCost({
        ...usage,
        source: "unavailable",
        steps: null,
        wallSeconds: null,
        costUsd: null,
      }),
    ).toBeNull();
  });

  it("stays null when a measurement is missing", () => {
    expect(usageCost({ ...usage, steps: null })).toBeNull();
    expect(usageCost({ ...usage, wallSeconds: null })).toBeNull();
  });
});
