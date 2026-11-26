/**
 * Domain tests for the forge installation record and its parser (FC7D1).
 *
 * Every title states what the test asserts and every body proves it; the
 * valid-path tests assert exact accepted values (so they fail against a
 * constant or identity implementation) and every refusal test asserts its
 * named typed reason (so it fails against an always-accept implementation).
 *
 * Hostile-input posture: every case proves a typed refusal (never a throw,
 * never a pass) for null, undefined, wrong primitives, arrays and
 * array-likes, non-plain prototypes, sparse arrays, getters (never
 * invoked), detectable Proxies (traps never run when the detector is
 * supplied), oversized strings/lists and prototype-polluting keys.
 */
import { types } from "node:util";

import { describe, expect, it } from "vitest";

import {
  FORGE_INSTALLATION_STATUSES,
  MAX_FORGE_INSTALLATION_REPOSITORIES,
  parseForgeInstallationRecord,
} from "../index.js";

const isProxy = types.isProxy as (value: unknown) => boolean;
const INSTALLED_AT = "2026-05-01T08:30:00Z";

/** Key names built at runtime so no polluting literal appears in this file. */
const PROTO_KEY = ["__proto", "__"].join("");
const CONSTRUCTOR_KEY = ["construct", "or"].join("");

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    installationId: "inst-01",
    organizationId: "acme",
    forge: "github",
    repositories: ["acme/widgets"],
    installedAtIso: INSTALLED_AT,
    status: "active",
    ...overrides,
  };
}

/** A Proxy whose get trap throws; reading it must be a refusal, not a crash. */
function hostileProxy(): unknown {
  return new Proxy(record(), {
    get() {
      throw new Error("trap ran");
    },
  });
}

describe("parseForgeInstallationRecord: accepted records", () => {
  it("accepts a complete valid record and returns its exact field values", () => {
    const result = parseForgeInstallationRecord(record(), isProxy);
    expect(result).toEqual({
      ok: true,
      record: {
        schemaVersion: undefined,
        installationId: "inst-01",
        organizationId: "acme",
        forge: "github",
        repositories: ["acme/widgets"],
        installedAtIso: INSTALLED_AT,
        status: "active",
      },
    });
    if (result.ok) {
      expect(result.record.schemaVersion).toBeUndefined();
    }
  });

  it("accepts a record with schemaVersion 1 and keeps schemaVersion as 1", () => {
    const result = parseForgeInstallationRecord(record({ schemaVersion: 1 }), isProxy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.schemaVersion).toBe(1);
    }
  });

  it("omits the schemaVersion own key entirely when the input carries none", () => {
    const result = parseForgeInstallationRecord(record(), isProxy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.hasOwn(result.record, "schemaVersion")).toBe(false);
      expect(Object.keys(result.record as unknown as Record<string, unknown>)).not.toContain(
        "schemaVersion",
      );
    }
  });

  it("accepts an empty repositories list as a valid, frozen empty array", () => {
    const result = parseForgeInstallationRecord(record({ repositories: [] }), isProxy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.repositories).toEqual([]);
      expect(Object.isFrozen(result.record.repositories)).toBe(true);
    }
  });

  it("accepts a repositories list at the 500-item bound with all entries preserved", () => {
    const many = Array.from(
      { length: MAX_FORGE_INSTALLATION_REPOSITORIES },
      (_, i) => `acme/repo-${i}`,
    );
    const result = parseForgeInstallationRecord(record({ repositories: many }), isProxy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.repositories.length).toBe(MAX_FORGE_INSTALLATION_REPOSITORIES);
      expect(result.record.repositories[MAX_FORGE_INSTALLATION_REPOSITORIES - 1]).toBe(
        "acme/repo-499",
      );
    }
  });

  it("freezes the returned record so it cannot be mutated after parsing", () => {
    const result = parseForgeInstallationRecord(record(), isProxy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result.record)).toBe(true);
      expect(Object.isFrozen(result.record.repositories)).toBe(true);
    }
  });

  it("refuses a call without a detector with proxy-detector-required and never reads the input", () => {
    const probe = hostileProxy();
    const result = parseForgeInstallationRecord(probe);
    expect(result).toEqual({ ok: false, reason: "proxy-detector-required" });
  });

  it("refuses an explicitly undefined detector with proxy-detector-required", () => {
    const result = parseForgeInstallationRecord(record(), undefined);
    expect(result).toEqual({ ok: false, reason: "proxy-detector-required" });
  });
});

describe("parseForgeInstallationRecord: proxy detector contract", () => {
  it("refuses a supplied non-function detector with proxy-detector-required before reading the input", () => {
    const probe = hostileProxy();
    const result = parseForgeInstallationRecord(probe, 42 as unknown as (v: unknown) => boolean);
    expect(result).toEqual({ ok: false, reason: "proxy-detector-required" });
  });

  it("refuses with detector-threw when the detector itself throws", () => {
    const result = parseForgeInstallationRecord(record(), () => {
      throw new Error("detector blew up");
    });
    expect(result).toEqual({ ok: false, reason: "detector-threw" });
  });

  it("refuses a Proxy at the root with reason proxy and never runs its get trap", () => {
    let trapRan = false;
    const proxy = new Proxy(record(), {
      get(target, key, receiver) {
        trapRan = true;
        return Reflect.get(target, key, receiver);
      },
    });
    const result = parseForgeInstallationRecord(proxy, isProxy);
    expect(result).toEqual({ ok: false, reason: "proxy" });
    expect(trapRan).toBe(false);
  });

  it("refuses a Proxy nested inside repositories with reason proxy and never runs its get trap", () => {
    let trapRan = false;
    const repoProxy = new Proxy(["acme/widgets"], {
      get(target, key, receiver) {
        trapRan = true;
        return Reflect.get(target, key, receiver);
      },
    });
    const result = parseForgeInstallationRecord(record({ repositories: repoProxy }), isProxy);
    expect(result).toEqual({ ok: false, reason: "proxy" });
    expect(trapRan).toBe(false);
  });
});

describe("parseForgeInstallationRecord: getters", () => {
  it("refuses a getter on the root with getter-not-allowed and never invokes the getter", () => {
    let getterRan = false;
    const input = record();
    Object.defineProperty(input, "status", {
      enumerable: true,
      get() {
        getterRan = true;
        return "active";
      },
    });
    const result = parseForgeInstallationRecord(input, isProxy);
    expect(result).toEqual({ ok: false, reason: "getter-not-allowed" });
    expect(getterRan).toBe(false);
  });

  it("refuses a getter on repositories with getter-not-allowed and never invokes the getter", () => {
    let getterRan = false;
    const input = record();
    Object.defineProperty(input, "repositories", {
      enumerable: true,
      get() {
        getterRan = true;
        return ["acme/widgets"];
      },
    });
    const result = parseForgeInstallationRecord(input, isProxy);
    expect(result).toEqual({ ok: false, reason: "getter-not-allowed" });
    expect(getterRan).toBe(false);
  });
});

describe("parseForgeInstallationRecord: root shape", () => {
  it.each([null, undefined, 42, "str", true])(
    "refuses the root value %p with invalid-record",
    (value) => {
      const result = parseForgeInstallationRecord(value, isProxy);
      expect(result).toEqual({ ok: false, reason: "invalid-record" });
    },
  );

  it("refuses a top-level array with invalid-record", () => {
    const result = parseForgeInstallationRecord([record()], isProxy);
    expect(result).toEqual({ ok: false, reason: "invalid-record" });
  });

  it("refuses an array-like root with unknown-key", () => {
    const result = parseForgeInstallationRecord({ length: 1, 0: "a" }, isProxy);
    expect(result).toEqual({ ok: false, reason: "unknown-key" });
  });

  it("refuses a non-plain prototype root with invalid-record", () => {
    const result = parseForgeInstallationRecord(new Map(), isProxy);
    expect(result).toEqual({ ok: false, reason: "invalid-record" });
  });

  it("refuses a root created with a custom prototype with invalid-record", () => {
    const result = parseForgeInstallationRecord(Object.create({ a: 1 }), isProxy);
    expect(result).toEqual({ ok: false, reason: "invalid-record" });
  });

  it("refuses a symbol own key on the root with invalid-record", () => {
    const input: Record<PropertyKey, unknown> = record();
    input[Symbol.for("tag")] = 1;
    const result = parseForgeInstallationRecord(input, isProxy);
    expect(result).toEqual({ ok: false, reason: "invalid-record" });
  });

  it("refuses an oversized root string with invalid-record", () => {
    const result = parseForgeInstallationRecord("x".repeat(4097), isProxy);
    expect(result).toEqual({ ok: false, reason: "invalid-record" });
  });
});

describe("parseForgeInstallationRecord: own keys", () => {
  it.each([() => PROTO_KEY, () => CONSTRUCTOR_KEY])(
    "refuses the prototype-polluting own key %p with forbidden-key",
    (key) => {
      const input = record();
      Object.defineProperty(input, key(), {
        enumerable: true,
        value: "polluted",
      });
      const result = parseForgeInstallationRecord(input, isProxy);
      expect(result).toEqual({ ok: false, reason: "forbidden-key" });
    },
  );

  it("refuses an extra unknown own key with unknown-key", () => {
    const result = parseForgeInstallationRecord(record({ extra: 1 }), isProxy);
    expect(result).toEqual({ ok: false, reason: "unknown-key" });
  });
});

describe("parseForgeInstallationRecord: field refusals", () => {
  it("refuses schemaVersion 2 with invalid-schema-version", () => {
    const result = parseForgeInstallationRecord(record({ schemaVersion: 2 }), isProxy);
    expect(result).toEqual({ ok: false, reason: "invalid-schema-version" });
  });

  it.each([
    ["missing", { installationId: undefined }],
    ["non-string", { installationId: 7 }],
    ["empty", { installationId: "" }],
    ["over 64 chars", { installationId: `a${"b".repeat(64)}` }],
    ["pattern-violating (leading dash)", { installationId: "-abc" }],
    ["pattern-violating (illegal character)", { installationId: "abc/def" }],
  ])("refuses an %s installationId with invalid-installation-id", (_label, override) => {
    const result = parseForgeInstallationRecord(record(override), isProxy);
    expect(result).toEqual({ ok: false, reason: "invalid-installation-id" });
  });

  it.each([
    ["missing", { organizationId: undefined }],
    ["non-string", { organizationId: 9 }],
    ["empty", { organizationId: "" }],
    ["uppercase", { organizationId: "Acme" }],
    ["leading dash", { organizationId: "-acme" }],
  ])("refuses an %s organizationId with invalid-organization-id", (_label, override) => {
    const result = parseForgeInstallationRecord(record(override), isProxy);
    expect(result).toEqual({ ok: false, reason: "invalid-organization-id" });
  });

  it.each([
    ["missing", { forge: undefined }],
    ["wrong forge", { forge: "gitlab" }],
    ["non-string", { forge: 1 }],
  ])("refuses an %s forge with invalid-forge", (_label, override) => {
    const result = parseForgeInstallationRecord(record(override), isProxy);
    expect(result).toEqual({ ok: false, reason: "invalid-forge" });
  });

  it.each([
    ["missing", { repositories: undefined }],
    ["non-array (string)", { repositories: "acme/widgets" }],
    ["non-array (object)", { repositories: { 0: "acme/widgets" } }],
    ["sparse array", (() => {
      const holey = new Array(2);
      holey[0] = "acme/widgets";
      return { repositories: holey };
    })()],
    ["over 500 items", { repositories: Array.from({ length: 501 }, () => "acme/r") }],
    ["non-string item", { repositories: [1] }],
    ["unsupported item (null)", { repositories: [null] }],
    ["missing slash", { repositories: ["acmewidgets"] }],
    ["too-short item", { repositories: ["a/"] }],
    ["over-200-char item", { repositories: [`a/${"b".repeat(200)}`] }],
    ["dot owner segment", { repositories: ["./widgets"] }],
    ["dot-parent owner segment", { repositories: ["../widgets"] }],
    ["dot name segment", { repositories: ["acme/."] }],
    ["dot-parent name segment", { repositories: ["acme/.."] }],
    ["item with control character", { repositories: ["acme/\u0007x"] }],
    ["duplicate items", { repositories: ["acme/widgets", "acme/widgets"] }],
  ])("refuses an %s repositories with invalid-repositories", (_label, override) => {
    const result = parseForgeInstallationRecord(record(override), isProxy);
    expect(result).toEqual({ ok: false, reason: "invalid-repositories" });
  });

  it.each([
    ["missing", { installedAtIso: undefined }],
    ["non-string", { installedAtIso: 1 }],
    ["over 64 chars", { installedAtIso: `2026-05-01T08:30:00Z${"0".repeat(64)}` }],
    ["unzoned", { installedAtIso: "2026-05-01T08:30:00" }],
    ["non-calendar date", { installedAtIso: "2026-02-31T08:30:00Z" }],
    ["garbage", { installedAtIso: "not-a-date" }],
  ])("refuses an %s installedAtIso with invalid-installed-at", (_label, override) => {
    const result = parseForgeInstallationRecord(record(override), isProxy);
    expect(result).toEqual({ ok: false, reason: "invalid-installed-at" });
  });

  it.each([
    ["missing", { status: undefined }],
    ["unknown status", { status: "archived" }],
    ["non-string", { status: 3 }],
    ["wrong case", { status: "Active" }],
  ])("refuses an %s status with invalid-status", (_label, override) => {
    const result = parseForgeInstallationRecord(record(override), isProxy);
    expect(result).toEqual({ ok: false, reason: "invalid-status" });
  });

  it("accepts exactly the three declared statuses and no others", () => {
    expect([...FORGE_INSTALLATION_STATUSES]).toEqual(["active", "suspended", "removed"]);
    for (const status of FORGE_INSTALLATION_STATUSES) {
      const result = parseForgeInstallationRecord(record({ status }), isProxy);
      expect(result.ok).toBe(true);
    }
  });
});
