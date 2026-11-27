/**
 * Domain tests for `classifyHostedRows` and `describeQuarantine` (FC5D,
 * Plan FC-5.8 / FC-R24).
 *
 * Every title states what the test asserts and every body proves it; each
 * refusal assertion would fail against a constant-allow implementation and
 * each positive assertion (exact quarantined reasons, preserved valid rows)
 * would fail against a constant-refuse implementation.
 *
 * `types.isProxy` from `node:util` proves real Proxy detection; getters
 * defined with `Object.defineProperty` throw if invoked, proving they never
 * run. Hostile-input posture: every refusal case proves a typed refusal or
 * quarantine entry — never a throw, never a pass, never leaked row content.
 */
import { readFileSync } from "node:fs";
import { types } from "node:util";

import { type IsProxy } from "@fleet/shared";

import { describe, expect, it } from "vitest";

import {
  classifyHostedRows,
  describeQuarantine,
  MAX_DESCRIBE_INDEXES,
  MAX_HOSTED_ROWS,
  MAX_QUARANTINE_REASON_LENGTH,
} from "../index.js";

const isProxy = types.isProxy as (value: unknown) => boolean;

interface ParsedRow {
  readonly id: string;
}

const parseOk: (row: unknown) => { ok: true; value: ParsedRow } | { ok: false; reason: string } = (row) => {
  const record = row as Record<string, unknown>;
  if (typeof record.id !== "string") {
    return { ok: false, reason: "missing id" };
  }
  return { ok: true, value: { id: record.id } };
};

/**
 * A getter/setter pair that fails loudly if ever invoked. Because it is
 * installed with `Object.defineProperty`, reading the key through its
 * descriptor never triggers it, but any ordinary property read does.
 */
function throwingGetter(): PropertyDescriptor {
  return {
    enumerable: true,
    configurable: true,
    get(): unknown {
      throw new Error("getter must never run");
    },
    set(): void {
      throw new Error("setter must never run");
    },
  };
}

function rowWithThrowingIndexGetter(array: unknown[], index: number): unknown[] {
  Object.defineProperty(array, index, throwingGetter());
  return array;
}

describe("module purity", () => {
  it("keeps hosted-row-quarantine.ts pure: no clock, randomness, process, node or console usage", () => {
    const source = readFileSync(new URL("../hosted-row-quarantine.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/Date\.now|new Date\(|Math\.random|\bprocess\b|\bconsole\./);
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/require\(/);
  });

  it("declares the documented bounds: 10,000 rows, 128 reason characters, 16 described indexes", () => {
    expect(MAX_HOSTED_ROWS).toBe(10_000);
    expect(MAX_QUARANTINE_REASON_LENGTH).toBe(128);
    expect(MAX_DESCRIBE_INDEXES).toBe(16);
  });
});

describe("classifyHostedRows accepts valid hosted rows", () => {
  it("parses every row and returns zero quarantined entries for a clean list", () => {
    const result = classifyHostedRows<ParsedRow>(
      [{ id: "a", schemaVersion: 1 }, { id: "b" }],
      parseOk,
      1,
      isProxy,
    );
    expect(result).toEqual({
      ok: true,
      rows: [{ id: "a" }, { id: "b" }],
      quarantined: [],
      quarantinedCount: 0,
    });
    expect(Object.isFrozen((result as { rows: readonly unknown[] }).rows)).toBe(true);
    expect(Object.isFrozen((result as { quarantined: readonly unknown[] }).quarantined)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("omitting isProxy uses the never-true fallback detector and still classifies clean rows", () => {
    const result = classifyHostedRows<ParsedRow>([{ id: "solo" }], parseOk, 1);
    expect(result).toEqual({ ok: true, rows: [{ id: "solo" }], quarantined: [], quarantinedCount: 0 });
  });

  it("accepts an empty rows list", () => {
    const result = classifyHostedRows<ParsedRow>([], parseOk, 1, isProxy);
    expect(result).toEqual({ ok: true, rows: [], quarantined: [], quarantinedCount: 0 });
  });

  it("accepts schemaVersion equal to supportedVersion", () => {
    const result = classifyHostedRows<ParsedRow>([{ id: "a", schemaVersion: 1 }], parseOk, 1, isProxy);
    expect(result).toMatchObject({ ok: true, rows: [{ id: "a" }] });
  });
});

describe("classifyHostedRows refuses malformed outer input", () => {
  it("refuses null, undefined, primitives, non-arrays, and array-likes as invalid-rows", () => {
    for (const rows of [null, undefined, 42, "rows", true, { length: 1, 0: { id: "a" } }]) {
      const result = classifyHostedRows<ParsedRow>(rows, parseOk, 1, isProxy);
      expect(result).toEqual({ ok: false, reason: "invalid-rows" });
    }
  });

  it("refuses sparse arrays and arrays with __proto__ or symbol keys", () => {
    const sparse: unknown[] = new Array(3);
    sparse[2] = { id: "a" };
    expect(classifyHostedRows<ParsedRow>(sparse, parseOk, 1, isProxy)).toEqual({
      ok: false,
      reason: "invalid-rows",
    });

    const protoKeyed: unknown[] = [{ id: "a" }];
    Object.defineProperty(protoKeyed, "__proto__", {
      value: {},
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(classifyHostedRows<ParsedRow>(protoKeyed, parseOk, 1, isProxy)).toEqual({
      ok: false,
      reason: "invalid-rows",
    });

    const symbol = Symbol("extra");
    const symbolKeyed: unknown[] = [{ id: "a" }];
    Object.defineProperty(symbolKeyed, symbol, { value: 1, enumerable: true, configurable: true });
    expect(classifyHostedRows<ParsedRow>(symbolKeyed, parseOk, 1, isProxy)).toEqual({
      ok: false,
      reason: "invalid-rows",
    });

    const extraKey: unknown[] = [{ id: "a" }];
    (extraKey as unknown as Record<string, unknown>).extra = true;
    expect(classifyHostedRows<ParsedRow>(extraKey, parseOk, 1, isProxy)).toEqual({
      ok: false,
      reason: "invalid-rows",
    });
  });

  it("refuses array with an index getter without invoking it", () => {
    const rows = rowWithThrowingIndexGetter([{ id: "a" }], 0);
    expect(() => rows[0]).toThrow("getter must never run");
    const result = classifyHostedRows<ParsedRow>(rows, parseOk, 1, isProxy);
    expect(result).toEqual({ ok: false, reason: "invalid-rows" });
  });

  it("refuses a Proxy reporting an accessor length without invoking a get trap", () => {
    // A real array's `length` cannot be redefined as an accessor, so the
    // hostile shape is reported by a Proxy's own-descriptor trap instead; the
    // implementation must refuse through the descriptor alone.
    const target: unknown[] = [];
    let getTrapRan = false;
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor(t, key) {
        if (key === "length") {
          return { enumerable: true, configurable: true, get(): unknown { throw new Error("length getter must never run"); } };
        }
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
      get(t, key, receiver) {
        getTrapRan = true;
        return Reflect.get(t, key, receiver);
      },
    });
    const result = classifyHostedRows<ParsedRow>(proxy, parseOk, 1, isProxy);
    expect(result).toEqual({ ok: false, reason: "invalid-rows" });
    expect(getTrapRan).toBe(false);
  });

  it("refuses a Proxy rows input without invoking traps", () => {
    const target: unknown[] = [{ id: "a" }];
    let trapRan = false;
    const proxy = new Proxy(target, {
      get(t, key, receiver) {
        trapRan = true;
        return Reflect.get(t, key, receiver);
      },
    });
    const result = classifyHostedRows<ParsedRow>(proxy, parseOk, 1, isProxy);
    expect(result).toEqual({ ok: false, reason: "invalid-rows" });
    expect(trapRan).toBe(false);
  });

  it("refuses 10,001 rows beyond the MAX_HOSTED_ROWS bound", () => {
    const rows: unknown[] = Array.from({ length: MAX_HOSTED_ROWS + 1 }, () => ({ id: "a" }));
    expect(classifyHostedRows<ParsedRow>(rows, parseOk, 1, isProxy)).toEqual({
      ok: false,
      reason: "too-many-rows",
    });
  });

  it("refuses non-function parser", () => {
    const result = classifyHostedRows<ParsedRow>([{ id: "a" }], undefined as unknown as typeof parseOk, 1, isProxy);
    expect(result).toEqual({ ok: false, reason: "invalid-parser" });
  });

  it("refuses invalid supportedVersion", () => {
    for (const version of [0, -1, 1.5, Number.NaN, "1", Number.MAX_SAFE_INTEGER + 1]) {
      const result = classifyHostedRows<ParsedRow>([{ id: "a" }], parseOk, version as number, isProxy);
      expect(result).toEqual({ ok: false, reason: "invalid-supported-version" });
    }
  });

  it("refuses non-function proxy detector", () => {
    const result = classifyHostedRows<ParsedRow>([{ id: "a" }], parseOk, 1, "nope" as unknown as IsProxy);
    expect(result).toEqual({ ok: false, reason: "invalid-proxy-detector" });
  });

  it("refuses when proxy detector throws", () => {
    const throwingDetector: IsProxy = () => {
      throw new Error("detector boom");
    };
    const result = classifyHostedRows<ParsedRow>([{ id: "a" }], parseOk, 1, throwingDetector);
    expect(result).toEqual({ ok: false, reason: "detector-threw" });
  });
});

describe("classifyHostedRows aborts on future schema versions", () => {
  it("aborts the entire read with unknown-version when any row has schemaVersion above supportedVersion", () => {
    let calls = 0;
    const countingParse: typeof parseOk = (row) => {
      calls += 1;
      return parseOk(row);
    };
    const result = classifyHostedRows<ParsedRow>(
      [{ id: "a", schemaVersion: 1 }, { id: "b", schemaVersion: 2 }],
      countingParse,
      1,
      isProxy,
    );
    expect(result).toEqual({ ok: false, reason: "unknown-version" });
    // Exactly one row was parsed (the first, version 1) before the abort: the
    // read is never partial and the parser never reaches the future row.
    expect(calls).toBe(1);
  });

  it("leaves a non-number schemaVersion to the parser instead of refusing the read", () => {
    const result = classifyHostedRows<ParsedRow>([{ id: "a", schemaVersion: "2" }], parseOk, 1, isProxy);
    expect(result).toEqual({
      ok: true,
      rows: [{ id: "a" }],
      quarantined: [],
      quarantinedCount: 0,
    });
  });
});

describe("classifyHostedRows quarantines corrupt rows", () => {
  it("quarantines null, primitive, and array rows as not-object", () => {
    const result = classifyHostedRows<ParsedRow>(
      [null, 7, ["nested"], { id: "good" }],
      parseOk,
      1,
      isProxy,
    );
    expect(result).toEqual({
      ok: true,
      rows: [{ id: "good" }],
      quarantined: [
        { index: 0, reason: "not-object" },
        { index: 1, reason: "not-object" },
        { index: 2, reason: "not-object" },
      ],
      quarantinedCount: 3,
    });
  });

  it("quarantines a row with an own __proto__ key as forbidden-key", () => {
    const row: Record<string, unknown> = { id: "a" };
    Object.defineProperty(row, "__proto__", {
      value: { evil: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const nested: Record<string, unknown> = { id: "b", child: { deep: {} } };
    Object.defineProperty(nested.child, "__proto__", {
      value: {},
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const result = classifyHostedRows<ParsedRow>([row, nested, { id: "c" }], parseOk, 1, isProxy);
    expect(result).toEqual({
      ok: true,
      rows: [{ id: "c" }],
      quarantined: [
        { index: 0, reason: "forbidden-key" },
        { index: 1, reason: "forbidden-key" },
      ],
      quarantinedCount: 2,
    });
  });

  it("quarantines a row with a getter or Proxy without invoking the getter", () => {
    const withGetter: Record<string, unknown> = {};
    Object.defineProperty(withGetter, "id", throwingGetter());
    const guarded: unknown[] = [withGetter, { id: "b" }];
    const result = classifyHostedRows<ParsedRow>(guarded, parseOk, 1, isProxy);
    expect(result).toEqual({
      ok: true,
      rows: [{ id: "b" }],
      quarantined: [{ index: 0, reason: "accessor" }],
      quarantinedCount: 1,
    });

    const proxyRow = new Proxy({ id: "p" }, {});
    const result2 = classifyHostedRows<ParsedRow>([proxyRow, { id: "b" }], parseOk, 1, isProxy);
    expect(result2).toEqual({
      ok: true,
      rows: [{ id: "b" }],
      quarantined: [{ index: 0, reason: "proxy" }],
      quarantinedCount: 1,
    });
  });

  it("quarantines a cyclic row with the snapshot cycle reason without hanging", () => {
    const cyclic: Record<string, unknown> = { id: "a" };
    cyclic.self = cyclic;
    const result = classifyHostedRows<ParsedRow>([cyclic], parseOk, 1, isProxy);
    expect(result).toEqual({
      ok: true,
      rows: [],
      quarantined: [{ index: 0, reason: "cycle" }],
      quarantinedCount: 1,
    });
  });

  it("quarantines corrupt rows in a mixed list and preserves valid rows", () => {
    const result = classifyHostedRows<ParsedRow>(
      [{ id: "a" }, { nope: true }, { id: "c" }],
      parseOk,
      1,
      isProxy,
    );
    expect(result).toEqual({
      ok: true,
      rows: [{ id: "a" }, { id: "c" }],
      quarantined: [{ index: 1, reason: "missing id" }],
      quarantinedCount: 1,
    });
  });

  it("quarantines every row when all rows fail parsing", () => {
    const result = classifyHostedRows<ParsedRow>([{ x: 1 }, { y: 2 }], parseOk, 1, isProxy);
    expect(result).toEqual({
      ok: true,
      rows: [],
      quarantined: [
        { index: 0, reason: "missing id" },
        { index: 1, reason: "missing id" },
      ],
      quarantinedCount: 2,
    });
  });

  it("quarantines only the row whose parser throws", () => {
    const parseThrower = (row: unknown): { ok: true; value: ParsedRow } | { ok: false; reason: string } => {
      if ((row as Record<string, unknown>).id === "boom") {
        throw new Error("parser exploded");
      }
      return parseOk(row);
    };
    const result = classifyHostedRows<ParsedRow>([{ id: "a" }, { id: "boom" }, { id: "c" }], parseThrower, 1, isProxy);
    expect(result).toEqual({
      ok: true,
      rows: [{ id: "a" }, { id: "c" }],
      quarantined: [{ index: 1, reason: "parser-threw" }],
      quarantinedCount: 1,
    });
  });

  it("sanitizes parser reasons: control characters stripped, capped at 128, non-string and empty become invalid-row", () => {
    const control = classifyHostedRows<ParsedRow>(
      [{ id: "x" }],
      () => ({ ok: false, reason: "bad\u0007id\n" }),
      1,
      isProxy,
    );
    expect((control as { quarantined: readonly { reason: string }[] }).quarantined[0]?.reason).toBe("badid");

    const long = "r".repeat(300);
    const capped = classifyHostedRows<ParsedRow>(
      [{ id: "x" }],
      () => ({ ok: false, reason: long }),
      1,
      isProxy,
    );
    expect((capped as { quarantined: readonly { reason: string }[] }).quarantined[0]?.reason).toBe(
      "r".repeat(MAX_QUARANTINE_REASON_LENGTH),
    );

    for (const bad of [undefined, null, 42, "", {}]) {
      const result = classifyHostedRows<ParsedRow>(
        [{ id: "x" }],
        () => ({ ok: false, reason: bad as string }),
        1,
        isProxy,
      );
      expect((result as { quarantined: readonly { reason: string }[] }).quarantined[0]?.reason).toBe("invalid-row");
    }
  });

  it("never includes row content in quarantined entries or describeQuarantine output", () => {
    const secret = "SECRET-ROW-CONTENT";
    // Both failing rows carry the secret somewhere in their content; neither
    // the quarantine entries nor the summary text may echo any of it.
    const result = classifyHostedRows<ParsedRow>(
      [{ nope: secret }, { password: secret }],
      parseOk,
      1,
      isProxy,
    );
    const rendered = JSON.stringify((result as { quarantined: readonly { reason: string }[] }).quarantined) + describeQuarantine(result, isProxy);
    expect(rendered).not.toContain(secret);
    expect((result as { quarantined: readonly { reason: string }[] }).quarantined.map((q) => q.reason)).toEqual([
      "missing id",
      "missing id",
    ]);
  });
});

describe("describeQuarantine", () => {
  it("summarizes a clean result without indexes", () => {
    const result = classifyHostedRows<ParsedRow>([{ id: "a" }, { id: "b" }, { id: "c" }], parseOk, 1, isProxy);
    expect(describeQuarantine(result, isProxy)).toBe("quarantine: 0 quarantined, 3 valid");
  });

  it("summarizes quarantined indexes in order", () => {
    const result = classifyHostedRows<ParsedRow>([{ nope: 1 }, { id: "b" }, { nope: 3 }, { id: "d" }], parseOk, 1, isProxy);
    expect(describeQuarantine(result, isProxy)).toBe("quarantine: 2 quarantined (indexes: 0, 2), 2 valid");
  });

  it("summarizes a whole-read refusal with its sanitized reason", () => {
    expect(describeQuarantine({ ok: false, reason: "unknown-version" }, isProxy)).toBe(
      "quarantine: refused (unknown-version)",
    );
  });

  it("returns fixed refusal text on hostile, Proxy, getter, or malformed input", () => {
    const invalid = "quarantine: invalid result";
    expect(describeQuarantine(null, isProxy)).toBe(invalid);
    expect(describeQuarantine(undefined, isProxy)).toBe(invalid);
    expect(describeQuarantine(42, isProxy)).toBe(invalid);
    expect(describeQuarantine("quarantine", isProxy)).toBe(invalid);
    expect(describeQuarantine([], isProxy)).toBe(invalid);
    expect(describeQuarantine(Object.create(null), isProxy)).toBe(invalid);
    expect(describeQuarantine(new Proxy({}, {}), isProxy)).toBe(invalid);
    expect(describeQuarantine({}, isProxy)).toBe(invalid);

    const okGetter = {};
    Object.defineProperty(okGetter, "ok", throwingGetter());
    expect(describeQuarantine(okGetter, isProxy)).toBe(invalid);

    const okProxyRows = { ok: true, rows: new Proxy([1], {}), quarantined: [] };
    expect(describeQuarantine(okProxyRows, isProxy)).toBe(invalid);

    const mismatchedCount = { ok: true, rows: [1], quarantined: [], quarantinedCount: 5 };
    expect(describeQuarantine(mismatchedCount, isProxy)).toBe(invalid);

    expect(describeQuarantine({ ok: true, rows: [1] }, isProxy)).toBe(invalid);
    expect(describeQuarantine({ ok: false }, isProxy)).toBe(invalid);
    expect(describeQuarantine({ ok: false, reason: 42 }, isProxy)).toBe(invalid);
    expect(describeQuarantine({ ok: true, rows: [1], quarantined: [{ index: "0" }] }, isProxy)).toBe(invalid);
  });

  it("bounds output to the first 16 quarantined indexes with a (+N more) suffix", () => {
    const rows: unknown[] = Array.from({ length: 20 }, () => ({ nope: true }));
    const result = classifyHostedRows<ParsedRow>(rows, parseOk, 1, isProxy);
    const summary = describeQuarantine(result, isProxy);
    expect(summary).toBe(
      `quarantine: 20 quarantined (indexes: ${[...Array(MAX_DESCRIBE_INDEXES).keys()].join(", ")} ... (+4 more)), 0 valid`,
    );
  });

  it("returns fixed refusal text when the detector throws or is not a function", () => {
    const throwingDetector: IsProxy = () => {
      throw new Error("boom");
    };
    expect(describeQuarantine({ ok: true, rows: [], quarantined: [] }, throwingDetector)).toBe(
      "quarantine: invalid result",
    );
    expect(describeQuarantine({ ok: true, rows: [], quarantined: [] }, "no" as unknown as IsProxy)).toBe(
      "quarantine: invalid result",
    );
  });

  it("omitting isProxy still summarizes a plain result", () => {
    expect(describeQuarantine({ ok: true, rows: [1], quarantined: [] })).toBe("quarantine: 0 quarantined, 1 valid");
  });
});
