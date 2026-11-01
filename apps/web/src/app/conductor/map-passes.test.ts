import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConductorPassesEnvelope } from "./map-passes";

const WIRE_FIXTURE_PATH = join(
  import.meta.dirname,
  "../../../../api/test/fixtures/v1-runs-passes.json",
);
const WIRE_FIXTURE: unknown = JSON.parse(
  readFileSync(WIRE_FIXTURE_PATH, "utf8"),
);

describe("parseConductorPassesEnvelope", () => {
  it("refuses a non-OK envelope", () => {
    expect(parseConductorPassesEnvelope({ code: "NOT_FOUND" })).toBeNull();
  });

  it("refuses an unreadable result shape", () => {
    expect(parseConductorPassesEnvelope({ code: "OK", result: {} })).toBeNull();
  });

  it("refuses an unknown store state", () => {
    expect(
      parseConductorPassesEnvelope({
        code: "OK",
        result: {
          outcome: "listed",
          store: "mystery",
          passes: [],
          total: 0,
          truncated: false,
        },
      }),
    ).toBeNull();
  });

  it("parses an empty readable store", () => {
    expect(
      parseConductorPassesEnvelope({
        code: "OK",
        result: {
          outcome: "listed",
          store: "readable",
          passes: [],
          total: 0,
          truncated: false,
        },
      }),
    ).toEqual({
      store: "readable",
      passes: [],
      total: 0,
      truncated: false,
    });
  });

  it("parses an unreadable store with empty passes", () => {
    expect(
      parseConductorPassesEnvelope({
        code: "OK",
        result: {
          outcome: "listed",
          store: "unreadable",
          passes: [],
          total: 0,
          truncated: false,
        },
      }),
    ).toEqual({
      store: "unreadable",
      passes: [],
      total: 0,
      truncated: false,
    });
  });

  it("refuses a pass with an unknown schemaVersion", () => {
    const envelope = {
      code: "OK",
      result: {
        outcome: "listed",
        store: "readable",
        total: 1,
        truncated: false,
        passes: [
          {
            schemaVersion: 2,
            passId: "pass-0001",
            nowIso: "2026-10-31T13:41:08.000Z",
            halted: false,
            progressed: true,
            maxActiveRuns: 4,
            passConcurrency: 2,
            dispatchStaggerMs: 250,
            runs: [],
            attention: [],
          },
        ],
      },
    };
    expect(parseConductorPassesEnvelope(envelope)).toBeNull();
  });

  it("refuses an advanced report with more than 8 steps", () => {
    const steps = Array.from({ length: 9 }, (_, index) => ({
      outcome: `step-${index}`,
    }));
    const envelope = {
      code: "OK",
      result: {
        outcome: "listed",
        store: "readable",
        total: 1,
        truncated: false,
        passes: [
          {
            passId: "pass-0001",
            nowIso: "2026-10-31T13:41:08.000Z",
            halted: false,
            progressed: true,
            maxActiveRuns: 4,
            passConcurrency: 2,
            dispatchStaggerMs: 250,
            runs: [{ runId: "run-1", report: { outcome: "advanced", steps } }],
            attention: [],
          },
        ],
      },
    };
    expect(parseConductorPassesEnvelope(envelope)).toBeNull();
  });

  it("refuses a malformed run report", () => {
    const envelope = {
      code: "OK",
      result: {
        outcome: "listed",
        store: "readable",
        total: 1,
        truncated: false,
        passes: [
          {
            passId: "pass-0001",
            nowIso: "2026-10-31T13:41:08.000Z",
            halted: false,
            progressed: true,
            maxActiveRuns: 4,
            passConcurrency: 2,
            dispatchStaggerMs: 250,
            runs: [
              {
                runId: "run-1",
                report: { outcome: "advanced", steps: "not-an-array" },
              },
            ],
            attention: [],
          },
        ],
      },
    };
    expect(parseConductorPassesEnvelope(envelope)).toBeNull();
  });

  it("matches the VZ6 wire fixture newest first without holderId (parity)", () => {
    const parsed = parseConductorPassesEnvelope(WIRE_FIXTURE);
    expect(parsed).not.toBeNull();
    if (parsed === null) {
      return;
    }
    expect(parsed.store).toBe("readable");
    expect(parsed.total).toBe(2);
    expect(parsed.truncated).toBe(false);
    expect(parsed.passes.map((pass) => pass.passId)).toEqual([
      "pass-0002",
      "pass-0001",
    ]);

    const newest = parsed.passes[0];
    expect(newest.nowIso).toBe("2026-10-31T13:52:04.000Z");
    expect(newest.halted).toBe(true);
    expect(newest.progressed).toBe(false);
    expect(newest.maxActiveRuns).toBe(4);
    expect(newest.passConcurrency).toBe(2);
    expect(newest.dispatchStaggerMs).toBe(250);
    // Worker-take order is preserved, never sorted.
    expect(newest.runs.map((run) => run.runId)).toEqual([
      "run-0A1B2C3D4E5F6G7H8J9K0M1N2P",
      "run-1V2T3Z4J5K6M7N8P9A0B1C2D3E",
    ]);
    expect(newest.runs[0].report).toEqual({
      outcome: "resume-refused",
      reason: "halted",
    });
    expect(newest.attention.map((item) => item.kind)).toEqual([
      "resume-refused",
      "skipped",
    ]);

    const older = parsed.passes[1];
    expect(older.runs[0].report.outcome).toBe("advanced");
    if (older.runs[0].report.outcome === "advanced") {
      expect(older.runs[0].report.steps.map((step) => step.outcome)).toEqual([
        "dispatched",
        "prepared",
      ]);
    }

    // The five D-VZ3 wire fields never cross the port.
    const wired = JSON.stringify(WIRE_FIXTURE);
    expect(wired).not.toContain("holderId");
    const mapped = JSON.stringify(parsed);
    expect(mapped).not.toContain("holderId");
    expect(mapped).not.toContain("sshAlias");
    expect(mapped).not.toContain("worktreePath");
  });
});
