/**
 * Domain tests for `readHostedRecordOrg` (FC3J, Plan FC-3.8).
 *
 * Every title states what the test asserts and every body proves it; each
 * assertion would fail against a constant-allow implementation (refusal
 * cases assert `{ ok: false }`) and against a constant-refuse
 * implementation (positive cases assert `{ ok: true }` with exact field
 * values, including `defaulted`).
 *
 * Every `readHostedRecordOrg` call passes `types.isProxy` from `node:util`
 * as the required second argument, except the negative tests that
 * explicitly exercise an omitted or throwing detector.
 *
 * Hostile-input posture: every refusal case below proves a typed refusal
 * (never a throw, never a pass), with no rejected value echoed back in the
 * result object.
 */
import { readFileSync } from "node:fs";
import { types } from "node:util";

import { type IsProxy } from "@fleet/shared";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_ORGANIZATION_ID,
  HOSTED_RECORD_SUPPORTED_SCHEMA_VERSION,
  readHostedRecordOrg,
} from "../index.js";

const isProxy = types.isProxy as (value: unknown) => boolean;

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

const LEGACY_WITHOUT_ORG = loadFixture("legacy-record-without-org.json");
const RECORD_WITH_ORG = loadFixture("record-with-org.json");
const FUTURE_VERSION_RECORD = loadFixture("future-version-record.json");

describe("module purity", () => {
  it("keeps default-org-read.ts pure: no clock, randomness, process or node imports", () => {
    const source = readFileSync(
      new URL("../default-org-read.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/Date\.now|new Date\(|Math\.random|\bprocess\b/);
    expect(source).not.toMatch(/from\s+["']node:/);
  });

  it("declares HOSTED_RECORD_SUPPORTED_SCHEMA_VERSION as 1", () => {
    expect(HOSTED_RECORD_SUPPORTED_SCHEMA_VERSION).toBe(1);
  });
});

describe("readHostedRecordOrg accepts valid hosted records", () => {
  it("defaults the legacy fixture without organizationId to the default organisation", () => {
    const result = readHostedRecordOrg(LEGACY_WITHOUT_ORG, isProxy);
    expect(result).toEqual({
      ok: true,
      organizationId: DEFAULT_ORGANIZATION_ID,
      defaulted: true,
    });
  });

  it("returns the explicit non-default organizationId of the org fixture", () => {
    const result = readHostedRecordOrg(RECORD_WITH_ORG, isProxy);
    expect(result).toEqual({ ok: true, organizationId: "acme-org", defaulted: false });
  });

  it("accepts an absent schemaVersion key as version 1", () => {
    const withoutSchemaVersion = { ...LEGACY_WITHOUT_ORG };
    delete withoutSchemaVersion.schemaVersion;
    const result = readHostedRecordOrg(withoutSchemaVersion, isProxy);
    expect(result).toEqual({ ok: true, organizationId: DEFAULT_ORGANIZATION_ID, defaulted: true });
  });

  it("accepts explicit schemaVersion 1 and organisation ids at the boundary lengths 1 and 63", () => {
    const one = { schemaVersion: 1, organizationId: "a" };
    expect(readHostedRecordOrg(one, isProxy)).toEqual({
      ok: true,
      organizationId: "a",
      defaulted: false,
    });
    const sixtyThree = {
      schemaVersion: 1,
      organizationId: "a".repeat(63),
    };
    expect(readHostedRecordOrg(sixtyThree, isProxy)).toEqual({
      ok: true,
      organizationId: "a".repeat(63),
      defaulted: false,
    });
  });

  it("accepts a large valid hosted record within DEFAULT_PLAIN_DATA_LIMITS", () => {
    const large: Record<string, unknown> = {
      schemaVersion: 1,
      id: "run-large",
      kind: "work-run",
      organizationId: "acme-org",
    };
    for (let i = 0; i < 100; i += 1) {
      large[`field-${i}`] = { index: i, nested: { deep: { value: [i, `${i}`] } } };
    }
    const result = readHostedRecordOrg(large, isProxy);
    expect(result).toEqual({ ok: true, organizationId: "acme-org", defaulted: false });
  });

  it("accepts an empty object as a defaulted default-organisation record", () => {
    expect(readHostedRecordOrg({}, isProxy)).toEqual({
      ok: true,
      organizationId: DEFAULT_ORGANIZATION_ID,
      defaulted: true,
    });
  });
});

describe("readHostedRecordOrg refuses hostile and malformed input", () => {
  it("refuses null, undefined, primitive raw inputs, and undefined property values as invalid-input", () => {
    for (const input of [null, undefined, 42, -0, Number.NaN, "record", true, Symbol("s"), () => {}]) {
      const result = readHostedRecordOrg(input, isProxy);
      expect(result).toEqual({ ok: false, reason: "invalid-input" });
    }
    expect(readHostedRecordOrg({ schemaVersion: undefined }, isProxy)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(readHostedRecordOrg({ organizationId: undefined }, isProxy)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
  });

  it("refuses arrays and sparse arrays with holes as invalid-input", () => {
    const sparse: unknown[] = new Array(4);
    for (const input of [[], ["a"], [{ organizationId: "acme" }], sparse]) {
      expect(readHostedRecordOrg(input, isProxy)).toEqual({
        ok: false,
        reason: "invalid-input",
      });
    }
  });

  it("refuses array-like objects carrying an own length property as invalid-input", () => {
    for (const input of [{ length: 0 }, { length: 2, 0: "a", 1: "b" }]) {
      expect(readHostedRecordOrg(input, isProxy)).toEqual({
        ok: false,
        reason: "invalid-input",
      });
    }
  });

  it("refuses non-plain prototype instances as invalid-input", () => {
    class HostedRecord {
      readonly organizationId = "acme-org";
    }
    for (const input of [new Date(0), new Map(), new Set(), new HostedRecord()]) {
      expect(readHostedRecordOrg(input, isProxy)).toEqual({
        ok: false,
        reason: "invalid-input",
      });
    }
  });

  it("refuses getter and setter properties without invoking them", () => {
    let accessorRan = false;
    const withGetter = {
      get organizationId(): string {
        accessorRan = true;
        return "acme-org";
      },
    };
    expect(readHostedRecordOrg(withGetter, isProxy)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(accessorRan).toBe(false);
    const withSetter: Record<string, unknown> = {};
    Object.defineProperty(withSetter, "schemaVersion", {
      set() {
        accessorRan = true;
      },
      enumerable: true,
    });
    expect(readHostedRecordOrg(withSetter, isProxy)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(accessorRan).toBe(false);
    const nested = { extra: { get value(): number { accessorRan = true; return 1; } } };
    expect(readHostedRecordOrg(nested, isProxy)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(accessorRan).toBe(false);
  });

  it("refuses Proxy inputs via types.isProxy without invoking traps, and refuses omitted or throwing isProxy detectors", () => {
    const trapCalls: string[] = [];
    const hostileProxy = new Proxy({}, {
      getPrototypeOf() {
        trapCalls.push("getPrototypeOf");
        return Object.prototype;
      },
      getOwnPropertyDescriptor() {
        trapCalls.push("getOwnPropertyDescriptor");
        return undefined;
      },
      ownKeys() {
        trapCalls.push("ownKeys");
        return [];
      },
      get() {
        trapCalls.push("get");
        return undefined;
      },
    });
    expect(readHostedRecordOrg(hostileProxy, isProxy)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    expect(trapCalls).toEqual([]);
    const omitted = readHostedRecordOrg(
      { organizationId: "acme-org" },
      undefined as unknown as IsProxy,
    );
    expect(omitted).toEqual({ ok: false, reason: "invalid-input" });
    const throwing = readHostedRecordOrg({ organizationId: "acme-org" }, () => {
      throw new Error("detector");
    });
    expect(throwing).toEqual({ ok: false, reason: "invalid-input" });
  });

  it("refuses non-enumerable own properties and symbol own keys as invalid-input", () => {
    const nonEnumerable: Record<string, unknown> = { organizationId: "acme-org" };
    Object.defineProperty(nonEnumerable, "schemaVersion", {
      value: 1,
      enumerable: false,
    });
    expect(readHostedRecordOrg(nonEnumerable, isProxy)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
    const symbolKeyed: Record<string, unknown> = { organizationId: "acme-org" };
    (symbolKeyed as Record<PropertyKey, unknown>)[Symbol("extra")] = 1;
    expect(readHostedRecordOrg(symbolKeyed, isProxy)).toEqual({
      ok: false,
      reason: "invalid-input",
    });
  });

  it("refuses prototype-polluting own keys as invalid-input", () => {
    const raw = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    for (const key of ["__proto__", "constructor", "prototype", "length"]) {
      const record: Record<string, unknown> = { organizationId: "acme-org", [key]: 1 };
      expect(readHostedRecordOrg(record, isProxy)).toEqual({
        ok: false,
        reason: "invalid-input",
      });
    }
    expect(readHostedRecordOrg(raw, isProxy)).toEqual({ ok: false, reason: "invalid-input" });
  });

  it(
    "refuses oversized strings, excessive key counts, oversized arrays, excessive node counts, " +
      "deep nesting, cycles, and non-finite numbers against DEFAULT_PLAIN_DATA_LIMITS",
    () => {
      const tooLong = {
        organizationId: "acme-org",
        note: "x".repeat(16_385),
      };
      expect(readHostedRecordOrg(tooLong, isProxy)).toEqual({
        ok: false,
        reason: "invalid-input",
      });
      const tooManyKeys: Record<string, unknown> = {};
      for (let i = 0; i < 129; i += 1) {
        tooManyKeys[`key-${i}`] = i;
      }
      expect(readHostedRecordOrg(tooManyKeys, isProxy)).toEqual({
        ok: false,
        reason: "invalid-input",
      });
      const oversizedArray = {
        organizationId: "acme-org",
        items: new Array(1_025).fill(0),
      };
      expect(readHostedRecordOrg(oversizedArray, isProxy)).toEqual({
        ok: false,
        reason: "invalid-input",
      });
      const tooManyNodes: Record<string, unknown> = { organizationId: "acme-org" };
      for (let i = 0; i < 130; i += 1) {
        tooManyNodes[`node-${i}`] = { a: { b: { c: { d: 1 } } } };
      }
      expect(readHostedRecordOrg(tooManyNodes, isProxy)).toEqual({
        ok: false,
        reason: "invalid-input",
      });
      let deep: unknown = 1;
      for (let i = 0; i < 17; i += 1) {
        deep = { nested: deep };
      }
      expect(readHostedRecordOrg(deep, isProxy)).toEqual({
        ok: false,
        reason: "invalid-input",
      });
      const cycle: Record<string, unknown> = { organizationId: "acme-org" };
      cycle.self = cycle;
      expect(readHostedRecordOrg(cycle, isProxy)).toEqual({
        ok: false,
        reason: "invalid-input",
      });
      for (const badNumber of [Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(readHostedRecordOrg({ schemaVersion: badNumber }, isProxy)).toEqual({
          ok: false,
          reason: "invalid-input",
        });
      }
    },
  );
});

describe("readHostedRecordOrg refuses wrong schema versions", () => {
  it("refuses future-version-record.json and any schemaVersion above 1 as unknown-schema-version", () => {
    const result = readHostedRecordOrg(FUTURE_VERSION_RECORD, isProxy);
    expect(result).toEqual({ ok: false, reason: "unknown-schema-version" });
    for (const version of [2, 3, 100]) {
      expect(readHostedRecordOrg({ schemaVersion: version }, isProxy)).toEqual({
        ok: false,
        reason: "unknown-schema-version",
      });
    }
    expect(readHostedRecordOrg({ schemaVersion: 2 }, isProxy)).not.toEqual({
      ok: true,
      organizationId: DEFAULT_ORGANIZATION_ID,
      defaulted: true,
    });
  });

  it("refuses non-integer, zero, negative, null, and non-numeric schemaVersion as invalid-schema-version", () => {
    for (const bad of ["1", null, true, {}, 0, -1, 1.5]) {
      expect(readHostedRecordOrg({ schemaVersion: bad }, isProxy)).toEqual({
        ok: false,
        reason: "invalid-schema-version",
      });
    }
  });
});

describe("readHostedRecordOrg refuses invalid organization ids", () => {
  it("refuses null and non-string organizationId as invalid-organization-id", () => {
    for (const bad of [null, 42, true, {}, ["acme"]]) {
      expect(readHostedRecordOrg({ organizationId: bad }, isProxy)).toEqual({
        ok: false,
        reason: "invalid-organization-id",
      });
    }
  });

  it("refuses empty, oversized, and non-matching organizationId strings as invalid-organization-id", () => {
    for (const bad of [
      "",
      "a".repeat(65),
      "a".repeat(64),
      "ACME",
      " acme",
      "-acme",
      "../etc/passwd",
      "acme_org",
      "acme org",
    ]) {
      expect(readHostedRecordOrg({ organizationId: bad }, isProxy)).toEqual({
        ok: false,
        reason: "invalid-organization-id",
      });
    }
  });

  it("never echoes a rejected value into the refusal result", () => {
    const secret = "a".repeat(65);
    const result = readHostedRecordOrg({ organizationId: secret }, isProxy);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
