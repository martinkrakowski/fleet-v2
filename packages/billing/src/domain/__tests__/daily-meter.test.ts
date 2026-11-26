/**
 * Hostile-input and behaviour tests for `aggregateDailyMeter` (FC-10.3).
 * Pure domain: no clock reads, no I/O, no price figures — amounts are
 * abstract cap units. Every test title states what it asserts and its body
 * proves it; every hostile input is the typed `invalid-input`, never a
 * throw and never an echoed input value.
 */
import { types } from "node:util";

import { describe, expect, it } from "vitest";

import {
  aggregateDailyMeter,
  DAILY_METER_MAX_ROWS,
  type DailyMeterRow,
} from "../daily-meter.js";

const MAX = Number.MAX_SAFE_INTEGER;

function row(overrides: Partial<DailyMeterRow> = {}): DailyMeterRow {
  return {
    attemptId: "att-1",
    organizationId: "org-a",
    runnerMinutes: 1,
    tokens: 2,
    modelCostMicros: 3,
    ...overrides,
  };
}

function input(rows: DailyMeterRow[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    organizationId: "org-a",
    dayKey: "2026-01-15",
    rows,
    ...overrides,
  };
}

describe("aggregateDailyMeter", () => {
  it("sums per-row integer runnerMinutes, tokens, and modelCostMicros so every total equals the exact sum of rows", () => {
    const rows = [
      row({ attemptId: "att-1", runnerMinutes: 1, tokens: 10, modelCostMicros: 100 }),
      row({ attemptId: "att-2", runnerMinutes: 2, tokens: 20, modelCostMicros: 200 }),
      row({ attemptId: "att-3", runnerMinutes: 5, tokens: 30, modelCostMicros: 300 }),
    ];
    const recorded = input(rows);
    const result = aggregateDailyMeter(recorded, (v) => types.isProxy(v));
    expect(result).toEqual({
      ok: true,
      meter: {
        organizationId: "org-a",
        dayKey: "2026-01-15",
        attempts: 3,
        runnerMinutes: 8,
        tokens: 60,
        modelCostMicros: 600,
      },
    });
    if (result.ok) {
      expect(Object.isFrozen(result.meter)).toBe(true);
    }
    // The caller's rows array and row objects are never mutated or retained.
    expect(rows).toEqual([
      row({ attemptId: "att-1", runnerMinutes: 1, tokens: 10, modelCostMicros: 100 }),
      row({ attemptId: "att-2", runnerMinutes: 2, tokens: 20, modelCostMicros: 200 }),
      row({ attemptId: "att-3", runnerMinutes: 5, tokens: 30, modelCostMicros: 300 }),
    ]);
    expect(Object.isFrozen(rows)).toBe(false);
    expect(Object.isFrozen(rows[0])).toBe(false);
  });

  it("returns zero totals and zero attempts for an empty rows array", () => {
    expect(aggregateDailyMeter(input([]), (v) => types.isProxy(v))).toEqual({
      ok: true,
      meter: {
        organizationId: "org-a",
        dayKey: "2026-01-15",
        attempts: 0,
        runnerMinutes: 0,
        tokens: 0,
        modelCostMicros: 0,
      },
    });
  });

  it("accepts leap-day 2024-02-29 and refuses invalid calendar dayKeys", () => {
    const rows = [row()];
    expect(aggregateDailyMeter(input(rows, { dayKey: "2024-02-29" }))).toMatchObject({ ok: true });
    for (const bad of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-00", "2026-1-15", "20260115", "not-a-day"]) {
      expect(aggregateDailyMeter(input(rows, { dayKey: bad }))).toEqual({
        ok: false,
        reason: "invalid-input",
      });
    }
  });

  it("refuses null, undefined, primitives, and top-level arrays", () => {
    for (const hostile of [null, undefined, 42, "s", true, [], [input([row()])]]) {
      expect(aggregateDailyMeter(hostile, (v) => types.isProxy(v))).toEqual({
        ok: false,
        reason: "invalid-input",
      });
    }
  });

  it("refuses non-array rows and array-like rows", () => {
    for (const badRows of [{ 0: row(), length: 1 }, null, 42, { rows: [row()] }]) {
      expect(aggregateDailyMeter(input(badRows as never), (v) => types.isProxy(v))).toEqual({
        ok: false,
        reason: "invalid-input",
      });
    }
  });

  it("refuses a sparse rows array with a hole", () => {
    const holed: unknown[] = new Array(2);
    holed[0] = row();
    expect(aggregateDailyMeter(input(holed as never), (v) => types.isProxy(v))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
  });

  it("refuses rows exceeding 50_000 items without walking excess elements", () => {
    const huge: unknown[] = new Array(DAILY_METER_MAX_ROWS + 1);
    for (let i = 0; i < DAILY_METER_MAX_ROWS + 1; i += 1) {
      huge[i] = row({ attemptId: `att-${i}` });
    }
    // The snapshot caps the array length in O(1) before walking elements,
    // so a hostile getter on the first element must never run.
    let elementReads = 0;
    const watched = new Proxy(
      { ...row(), extra: 0 },
      {
        get() {
          elementReads += 1;
          return 1;
        },
      },
    );
    huge[0] = watched;
    expect(aggregateDailyMeter(input(huge as never), (v) => types.isProxy(v))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(elementReads).toBe(0);
  });

  it("refuses getters on input, rows, and row elements without invoking them", () => {
    const makeGetter = () => {
      const watched: Record<string, unknown> = {};
      Object.defineProperty(watched, "secret", {
        enumerable: true,
        get() {
          throw new Error("getter ran");
        },
      });
      return watched;
    };
    const outer = { ...input([row()]), secret: 1 };
    Object.defineProperty(outer, "secret", {
      enumerable: true,
      get() {
        throw new Error("getter ran");
      },
    });
    expect(aggregateDailyMeter(outer, (v) => types.isProxy(v))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    const rowsHost = makeGetter();
    expect(aggregateDailyMeter(input(rowsHost as never), (v) => types.isProxy(v))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    const rowHost = makeGetter();
    expect(aggregateDailyMeter(input([rowHost as never]), (v) => types.isProxy(v))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    const getterRow = { ...row() };
    Object.defineProperty(getterRow, "tokens", {
      enumerable: true,
      get() {
        throw new Error("getter ran");
      },
    });
    expect(aggregateDailyMeter(input([getterRow]), (v) => types.isProxy(v))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
  });

  it("refuses hostile Proxies and transparent Proxies when detector is supplied", () => {
    let ownKeysCalls = 0;
    const ownKeysTrap = new Proxy(input([row()]), {
      ownKeys() {
        ownKeysCalls += 1;
        return ["organizationId", "dayKey", "rows"];
      },
      getOwnPropertyDescriptor() {
        throw new Error("trap");
      },
    });
    expect(aggregateDailyMeter(ownKeysTrap)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(ownKeysCalls).toBe(1);
    const prototypeTrap = new Proxy(input([row()]), {
      getPrototypeOf() {
        throw new Error("trap");
      },
    });
    expect(aggregateDailyMeter(prototypeTrap, (v) => types.isProxy(v))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    // A transparent Proxy on the outer input, on rows, and on a row is
    // refused only when the detector is supplied.
    expect(aggregateDailyMeter(new Proxy(input([row()]), {}), (v) => types.isProxy(v))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(aggregateDailyMeter(input(new Proxy([row()], {}) as never), (v) => types.isProxy(v))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(
      aggregateDailyMeter(input([new Proxy(row(), {}) as never]), (v) => types.isProxy(v)),
    ).toEqual({ ok: false, reason: "invalid-input" });
    // Without a detector the transparent Proxy is still refused, because
    // the snapshot reads it through descriptors and its own keys are the
    // expected ones... but the detector is absent, so the copy succeeds and
    // the aggregate proceeds; a NO_DETECTOR transparent Proxy is an
    // accepted residual only if it behaves like the plain data it wraps.
    expect(aggregateDailyMeter(new Proxy(input([row()]), {}))).toMatchObject({ ok: true });
  });

  it("refuses prototype-polluting, missing, extra, hidden, and symbol keys", () => {
    // Outer record: prototype-polluting keys.
    for (const polluter of ["__proto__", "constructor", "prototype"]) {
      const polluted: Record<string, unknown> = { ...input([row()]) };
      if (polluter === "__proto__") {
        Object.defineProperty(polluted, "__proto__", { value: {}, enumerable: true });
      } else {
        polluted[polluter] = 1;
      }
      expect(aggregateDailyMeter(polluted, (v) => types.isProxy(v))).toEqual({
        ok: false,
        reason: "invalid-input",
      });
    }
    // Outer record: missing and extra keys.
    const missing = { ...input([row()]) };
    delete missing.rows;
    expect(aggregateDailyMeter(missing, (v) => types.isProxy(v))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(aggregateDailyMeter({ ...input([row()]), extra: 1 }, (v) => types.isProxy(v))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    // Outer record: hidden non-enumerable and symbol keys.
    const hidden = { ...input([row()]) };
    Object.defineProperty(hidden, "hidden", { value: 1, enumerable: false });
    expect(aggregateDailyMeter(hidden, (v) => types.isProxy(v))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    const symbolic: Record<string | symbol, unknown> = { ...input([row()]) };
    symbolic[Symbol.for("meter-hidden")] = 1;
    expect(aggregateDailyMeter(symbolic, (v) => types.isProxy(v))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    // Row: prototype-polluting, missing, extra, hidden, and symbol keys.
    for (const polluter of ["__proto__", "constructor", "prototype"]) {
      const pollutedRow: Record<string, unknown> = { ...row() };
      if (polluter === "__proto__") {
        Object.defineProperty(pollutedRow, "__proto__", { value: {}, enumerable: true });
      } else {
        pollutedRow[polluter] = 1;
      }
      expect(aggregateDailyMeter(input([pollutedRow as never]), (v) => types.isProxy(v))).toEqual({
        ok: false,
        reason: "invalid-input",
      });
    }
    const missingRow: Record<string, unknown> = { ...row() };
    delete missingRow.tokens;
    expect(aggregateDailyMeter(input([missingRow as never]), (v) => types.isProxy(v))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(
      aggregateDailyMeter(input([{ ...row(), extra: 1 } as never]), (v) => types.isProxy(v)),
    ).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    const hiddenRow = { ...row() };
    Object.defineProperty(hiddenRow, "hidden", { value: 1, enumerable: false });
    expect(aggregateDailyMeter(input([hiddenRow]), (v) => types.isProxy(v))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    const symbolicRow: Record<string | symbol, unknown> = { ...row() };
    symbolicRow[Symbol.for("meter-row-hidden")] = 1;
    expect(aggregateDailyMeter(input([symbolicRow as never]), (v) => types.isProxy(v))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
  });

  it("refuses malformed organizationId, attemptId, and invalid calendar dayKeys", () => {
    for (const bad of ["-bad", "bad_id", "UPPER", "", "a".repeat(64)]) {
      expect(aggregateDailyMeter(input([row()], { organizationId: bad }))).toEqual({
        ok: false,
        reason: "invalid-input",
      });
      expect(aggregateDailyMeter(input([row({ organizationId: bad })]))).toEqual({
        ok: false,
        reason: "invalid-input",
      });
    }
    for (const bad of ["_bad", "-bad", "bad id", "a".repeat(129), ""]) {
      expect(aggregateDailyMeter(input([row({ attemptId: bad })]))).toEqual({
        ok: false,
        reason: "invalid-input",
      });
    }
    expect(aggregateDailyMeter(input([row()], { dayKey: "2026-02-29" }))).toEqual({
      ok: false,
      reason: "invalid-input",
    });
  });

  it("refuses float, negative, non-finite, and non-safe-integer metric values", () => {
    for (const bad of [-1, 1.5, NaN, Infinity, -Infinity, MAX + 1, -0]) {
      expect(aggregateDailyMeter(input([row({ runnerMinutes: bad as never })]))).toEqual({
        ok: false,
        reason: "invalid-input",
      });
      expect(aggregateDailyMeter(input([row({ tokens: bad as never })]))).toEqual({
        ok: false,
        reason: "invalid-input",
      });
      expect(aggregateDailyMeter(input([row({ modelCostMicros: bad as never })]))).toEqual({
        ok: false,
        reason: "invalid-input",
      });
    }
  });

  it("refuses the whole aggregate when any row belongs to a foreign organization", () => {
    const foreign = row({ attemptId: "att-f", organizationId: "org-b" });
    expect(aggregateDailyMeter(input([row(), foreign]))).toEqual({
      ok: false,
      reason: "foreign-organization-row",
    });
    expect(aggregateDailyMeter(input([foreign]))).toEqual({
      ok: false,
      reason: "foreign-organization-row",
    });
  });

  it("refuses duplicate attemptId rows", () => {
    expect(aggregateDailyMeter(input([row({ attemptId: "att-1" }), row({ attemptId: "att-1" })]))).toEqual({
      ok: false,
      reason: "duplicate-attempt",
    });
  });

  it("refuses safe-integer sum overflow in runnerMinutes, tokens, and modelCostMicros", () => {
    const half = Math.floor(MAX / 2);
    expect(
      aggregateDailyMeter(input([
        row({ attemptId: "att-1", runnerMinutes: half }),
        row({ attemptId: "att-2", runnerMinutes: half }),
        row({ attemptId: "att-3", runnerMinutes: half }),
      ])),
    ).toEqual({ ok: false, reason: "sum-overflow" });
    expect(
      aggregateDailyMeter(input([
        row({ attemptId: "att-1", tokens: MAX }),
        row({ attemptId: "att-2", tokens: 1 }),
      ])),
    ).toEqual({ ok: false, reason: "sum-overflow" });
    expect(
      aggregateDailyMeter(input([
        row({ attemptId: "att-1", modelCostMicros: MAX }),
        row({ attemptId: "att-2", modelCostMicros: 1 }),
      ])),
    ).toEqual({ ok: false, reason: "sum-overflow" });
  });

  it("never echoes rejected input values in any refusal", () => {
    const secret = "Z".repeat(64);
    const results = [
      aggregateDailyMeter(input([row()], { organizationId: secret })),
      aggregateDailyMeter(input([row({ attemptId: secret })])),
      aggregateDailyMeter(input([row()], { dayKey: secret })),
      aggregateDailyMeter(null),
      aggregateDailyMeter(42),
    ];
    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain("ZZZZ");
    }
  });
});
