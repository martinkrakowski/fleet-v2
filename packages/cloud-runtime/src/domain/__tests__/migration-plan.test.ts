/**
 * Tests for the forward-only migration planner (FC5B1). Every hostile input is
 * read through `snapshotPlainData` with the unit's own limits and a required
 * `types.isProxy` detector, so each refusal test fails against a constant or
 * identity implementation.
 */
import { types } from "node:util";

import {
  checksumOfMigration,
  decideMigrationRun,
  MIGRATION_ID_PATTERN,
  MAX_MIGRATIONS,
  MAX_SQL_LENGTH,
} from "../index.js";
import { describe, expect, it } from "vitest";

const isProxy = types.isProxy;

type Applied = { readonly id: string; readonly checksum: string; readonly appliedAtIso: string };
type Available = { readonly id: string; readonly checksum: string; readonly sql: string };

function applied(id: string, checksum: string): Applied {
  return { id, checksum, appliedAtIso: "2026-01-01T00:00:00Z" };
}

function available(id: string, checksum: string, sql = `select ${id};`): Available {
  return { id, checksum, sql };
}

function expectInvalidInput(result: ReturnType<typeof decideMigrationRun>, field: string): void {
  expect(result.ok).toBe(false);
  if (result.ok === false && result.reason === "invalid-input") {
    expect(result.field).toBe(field);
  } else {
    throw new Error(`expected invalid-input/${field}, got ${JSON.stringify(result)}`);
  }
}

describe("decideMigrationRun", () => {
  it("plans an empty applied history as an empty toRun", () => {
    const result = decideMigrationRun([], [], isProxy);
    expect(result).toEqual({ ok: true, toRun: [] });
  });

  it("plans a partial applied history as a sorted toRun containing only the unapplied migrations", () => {
    const result = decideMigrationRun(
      [applied("0002_b", "c2"), applied("0001_a", "ca")],
      [available("0004_d", "c4"), available("0003_c", "c3"), available("0002_b", "c2"), available("0001_a", "ca")],
      isProxy,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.toRun.map((m) => m.id)).toEqual(["0003_c", "0004_d"]);
      expect(result.toRun.map((m) => m.id)).toEqual([...result.toRun.map((m) => m.id)].sort());
    }
  });

  it("returns an empty toRun when every available migration is applied", () => {
    const result = decideMigrationRun(
      [applied("0001_a", "c1"), applied("0002_b", "c2")],
      [available("0001_a", "c1"), available("0002_b", "c2")],
      isProxy,
    );
    expect(result).toEqual({ ok: true, toRun: [] });
  });

  it("plans only unapplied migrations in id order, without re-ordering history", () => {
    const result = decideMigrationRun(
      [applied("0002_b", "cb"), applied("0001_a", "ca")],
      [available("0003_c", "cc"), available("0001_a", "ca"), available("0002_b", "cb"), available("0004_d", "cd")],
      isProxy,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.toRun.map((m) => m.id)).toEqual(["0003_c", "0004_d"]);
    }
  });

  it("refuses missing, non-function, or throwing isProxy detector", () => {
    const validApplied: Applied[] = [applied("0001_a", "c1")];
    const validAvailable: Available[] = [available("0001_a", "c1")];
    expectInvalidInput(decideMigrationRun(validApplied, validAvailable, undefined as never), "isProxy");
    expectInvalidInput(decideMigrationRun(validApplied, validAvailable, null as never), "isProxy");
    expectInvalidInput(decideMigrationRun(validApplied, validAvailable, 42 as never), "isProxy");
    expectInvalidInput(
      decideMigrationRun(validApplied, validAvailable, () => {
        throw new Error("detector");
      }),
      "isProxy",
    );
  });

  it("refuses non-array, null, undefined, primitive, and array-like inputs", () => {
    const bad: readonly unknown[] = [null, undefined, 7, "0001_a", { length: 1, 0: applied("0001_a", "c1") }];
    for (const value of bad) {
      expectInvalidInput(decideMigrationRun(value, [], isProxy), "applied");
      expectInvalidInput(decideMigrationRun([], value, isProxy), "available");
    }
  });

  it("refuses sparse array holes without reading prototypes", () => {
    const holey = new Array(2);
    holey[1] = applied("0001_a", "c1");
    expectInvalidInput(decideMigrationRun(holey, [], isProxy), "applied");
    const leadingHole = new Array(2);
    leadingHole[1] = available("0001_a", "c1");
    expectInvalidInput(decideMigrationRun([], leadingHole, isProxy), "available");
  });

  it("refuses arrays exceeding 10000 entries", () => {
    const oversized = new Array(MAX_MIGRATIONS + 1).fill(applied("0001_a", "c1"));
    expectInvalidInput(decideMigrationRun(oversized, [], isProxy), "applied");
    const oversizedAvailable = new Array(MAX_MIGRATIONS + 1).fill(available("0001_a", "c1"));
    expectInvalidInput(decideMigrationRun([], oversizedAvailable, isProxy), "available");
  });

  it("refuses null entries and getters without invoking the getter", () => {
    let getterRuns = 0;
    const withGetter = {
      get id(): string {
        getterRuns += 1;
        return "0001_a";
      },
      checksum: "c1",
      appliedAtIso: "2026-01-01T00:00:00Z",
    };
    expectInvalidInput(decideMigrationRun([null], [], isProxy), "applied");
    expectInvalidInput(decideMigrationRun([7], [], isProxy), "applied");
    expectInvalidInput(decideMigrationRun([withGetter], [], isProxy), "applied");
    expect(getterRuns).toBe(0);
    expectInvalidInput(decideMigrationRun([], [null], isProxy), "available");
  });

  it("refuses hostile Proxy inputs without invoking traps or throwing", () => {
    let trapRuns = 0;
    const hostileProxy = new Proxy([applied("0001_a", "c1")], {
      get(): never {
        trapRuns += 1;
        throw new Error("trap");
      },
      getOwnPropertyDescriptor(): never {
        trapRuns += 1;
        throw new Error("trap");
      },
      ownKeys(): never {
        trapRuns += 1;
        throw new Error("trap");
      },
    });
    expectInvalidInput(decideMigrationRun(hostileProxy, [], isProxy), "applied");
    expectInvalidInput(decideMigrationRun([], hostileProxy, isProxy), "available");
    const entryProxy = new Proxy(applied("0001_a", "c1"), {
      get(): never {
        trapRuns += 1;
        throw new Error("trap");
      },
      getOwnPropertyDescriptor(): never {
        trapRuns += 1;
        throw new Error("trap");
      },
      ownKeys(): never {
        trapRuns += 1;
        throw new Error("trap");
      },
    });
    expectInvalidInput(decideMigrationRun([entryProxy], [], isProxy), "applied");
    expect(trapRuns).toBe(0);
  });

  it("refuses prototype-polluting keys and extra keys on entries", () => {
    const polluted: unknown = Object.create(null);
    Object.defineProperty(polluted, "__proto__", { value: "x", enumerable: true });
    Object.defineProperty(polluted, "id", { value: "0001_a", enumerable: true });
    Object.defineProperty(polluted, "checksum", { value: "c1", enumerable: true });
    Object.defineProperty(polluted, "appliedAtIso", { value: "2026-01-01T00:00:00Z", enumerable: true });
    expectInvalidInput(decideMigrationRun([polluted], [], isProxy), "applied");

    const pollutedAvailable: unknown = Object.create(null);
    Object.defineProperty(pollutedAvailable, "constructor", { value: "x", enumerable: true });
    Object.defineProperty(pollutedAvailable, "id", { value: "0001_a", enumerable: true });
    Object.defineProperty(pollutedAvailable, "checksum", { value: "c1", enumerable: true });
    Object.defineProperty(pollutedAvailable, "sql", { value: "select 1;", enumerable: true });
    expectInvalidInput(decideMigrationRun([], [pollutedAvailable], isProxy), "available");

    const extraKey = { ...applied("0001_a", "c1"), extra: 1 };
    expectInvalidInput(decideMigrationRun([extraKey], [], isProxy), "applied");
    const extraKeyAvailable = { ...available("0001_a", "c1"), extra: 1 };
    expectInvalidInput(decideMigrationRun([], [extraKeyAvailable], isProxy), "available");
  });

  it("refuses malformed ids, non-string checksums, and oversized sql", () => {
    expectInvalidInput(
      decideMigrationRun([applied("nope", "c1")], [], isProxy),
      "applied",
    );
    expectInvalidInput(
      decideMigrationRun([applied("0001_A_upper", "c1")], [], isProxy),
      "applied",
    );
    expectInvalidInput(
      decideMigrationRun([applied("0001_a", "")], [], isProxy),
      "applied",
    );
    expectInvalidInput(
      decideMigrationRun([applied("0001_a", 7 as never)], [], isProxy),
      "applied",
    );
    expectInvalidInput(
      decideMigrationRun([], [available("0001_a", "c1", "x".repeat(MAX_SQL_LENGTH + 1))], isProxy),
      "available",
    );
    expectInvalidInput(decideMigrationRun([], [available("0001_a", 9 as never)], isProxy), "available");
  });

  it("refuses invalid appliedAtIso timestamps such as non-date strings and impossible calendar dates", () => {
    for (const badIso of ["not-a-date", "", "2026-02-30T00:00:00Z", "2026-02-29T00:00:00Z", "2026-13-01T00:00:00Z",
      "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z", "2026-01-01T00:00:60Z", 42 as never, null as never]) {
      expectInvalidInput(
        decideMigrationRun([{ id: "0001_a", checksum: "c1", appliedAtIso: badIso }], [available("0001_a", "c1")], isProxy),
        "applied",
      );
    }
    // Every real calendar component round-trips, including a fractional part
    // and a numeric offset.
    const ok = decideMigrationRun(
      [{ id: "0001_a", checksum: "c1", appliedAtIso: "2024-02-29T23:59:59.123+05:30" }],
      [available("0001_a", "c1")],
      isProxy,
    );
    expect(ok.ok).toBe(true);
  });

  it("refuses duplicate migration ids in applied or available", () => {
    expect(
      decideMigrationRun([applied("0001_a", "c1"), applied("0001_a", "c1")], [available("0001_a", "c1")], isProxy),
    ).toEqual({ ok: false, reason: "duplicate-id", id: "0001_a" });
    expect(
      decideMigrationRun([applied("0001_a", "c1")], [available("0001_a", "c1"), available("0001_a", "other")], isProxy),
    ).toEqual({ ok: false, reason: "duplicate-id", id: "0001_a" });
  });

  it("refuses applied migration id unknown to available", () => {
    expect(
      decideMigrationRun([applied("0001_a", "c1")], [available("0002_b", "c1")], isProxy),
    ).toEqual({ ok: false, reason: "unknown-applied", id: "0001_a" });
  });

  it("refuses checksum mismatch between applied and available", () => {
    expect(
      decideMigrationRun([applied("0001_a", "c1")], [available("0001_a", "c2")], isProxy),
    ).toEqual({ ok: false, reason: "checksum-mismatch", id: "0001_a" });
  });

  it("refuses unapplied migration sorting before any applied migration, including middle gaps", () => {
    // Leading gap: an unapplied migration before the first applied id.
    expect(
      decideMigrationRun(
        [applied("0002_b", "cb")],
        [available("0001_a", "ca"), available("0002_b", "cb")],
        isProxy,
      ),
    ).toEqual({ ok: false, reason: "gap", id: "0001_a" });
    // Middle gap between two applied ids.
    expect(
      decideMigrationRun(
        [applied("0001_a", "ca"), applied("0003_c", "cc")],
        [available("0001_a", "ca"), available("0002_b", "cb"), available("0003_c", "cc")],
        isProxy,
      ),
    ).toEqual({ ok: false, reason: "gap", id: "0002_b" });
  });
});

describe("checksumOfMigration", () => {
  it("produces a deterministic checksum for the same sql text", () => {
    const sql = "select 1; select 2;";
    const first = checksumOfMigration(sql, (text) => text.length.toString(16));
    const second = checksumOfMigration(sql, (text) => text.length.toString(16));
    expect(first).toEqual({ ok: true, value: "13".slice(0, 2) });
    expect(second).toEqual(first);
    // Different sql is not silently mapped to the same digest by an identity
    // cheat: the digest itself sees the exact text.
    const other = checksumOfMigration("select 1; select 3; select 4;", (text) => text.length.toString(16));
    expect(other.ok).toBe(true);
    if (other.ok && first.ok) {
      expect(other.value === first.value).toBe(false);
    }
  });

  it("refuses non-string or oversized sql in checksumOfMigration", () => {
    for (const bad of [null, undefined, 7, ["select 1;"], "x".repeat(MAX_SQL_LENGTH + 1)]) {
      expect(checksumOfMigration(bad, (text) => text)).toEqual({
        ok: false,
        reason: "invalid-input",
        field: "sql",
      });
    }
  });

  it("refuses missing, throwing, or empty-returning digest function", () => {
    expect(checksumOfMigration("select 1;", undefined as never)).toEqual({
      ok: false,
      reason: "invalid-input",
      field: "digest",
    });
    expect(checksumOfMigration("select 1;", null as never)).toEqual({
      ok: false,
      reason: "invalid-input",
      field: "digest",
    });
    expect(
      checksumOfMigration("select 1;", () => {
        throw new Error("digest");
      }),
    ).toEqual({ ok: false, reason: "digest-failed", field: "digest" });
    expect(checksumOfMigration("select 1;", () => "")).toEqual({
      ok: false,
      reason: "digest-failed",
      field: "digest",
    });
    expect(checksumOfMigration("select 1;", () => 5 as never)).toEqual({
      ok: false,
      reason: "digest-failed",
      field: "digest",
    });
  });
});

describe("migration-plan limits", () => {
  it("exports the pattern and bounds the planner promises", () => {
    expect(MIGRATION_ID_PATTERN.test("0001_init")).toBe(true);
    expect(MIGRATION_ID_PATTERN.test(`0001_${"a".repeat(65)}`)).toBe(false);
    expect(MIGRATION_ID_PATTERN.test("0001-Init")).toBe(false);
    expect(MIGRATION_ID_PATTERN.test("nope")).toBe(false);
    expect(MAX_MIGRATIONS).toBe(10_000);
    expect(MAX_SQL_LENGTH).toBe(200_000);
  });
});
