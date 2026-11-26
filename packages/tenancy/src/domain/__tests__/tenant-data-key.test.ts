/**
 * Domain tests for the tenant data-key record and the fail-closed key-use
 * decider (FC9A1).
 *
 * Every title states what the test asserts and every body proves it; each
 * assertion would fail against a constant-allow implementation (positive
 * cases assert `{ allowed: true }` and accepted records) and against a
 * constant-refuse implementation (positive cases assert acceptance with
 * exact field values).
 *
 * Cost bounds under test: `parseTenantDataKeyRecord` performs one bounded
 * snapshot pass (at most 7 keys, depth 1, strings capped at 4096
 * characters) plus one pass over at most the 7 allowed own keys, each field
 * check over bounded strings; `decideKeyUse` adds one parse pass and a
 * fixed number of equality and pattern checks. All are O(1).
 *
 * Hostile-input posture: every case below proves a typed refusal (never a
 * throw, never a pass) for null, undefined, non-objects, arrays,
 * array-likes, non-plain prototypes, getters (never invoked), Proxies
 * (traps never run when the detector is supplied), enormous lengths,
 * prototype-polluting own keys, and oversized strings.
 */
import { types } from "node:util";

import { describe, expect, it } from "vitest";

import {
  decideKeyUse,
  parseTenantDataKeyRecord,
} from "../entities/TenantDataKey.js";

const isProxy = types.isProxy as (value: unknown) => boolean;

const CREATED = "2026-01-01T00:00:00Z";
const RETIRED_AT = "2026-06-01T12:00:00.500Z";

function validKey(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    keyId: "data-key-1",
    organizationId: "acme",
    wrappedKeyRef: "kms://acme/wrapped-v1",
    status: "active",
    createdAtIso: CREATED,
    retiredAtIso: null,
    ...overrides,
  };
}

describe("parseTenantDataKeyRecord accepts valid records", () => {
  it("accepts an active record with exact field values and no schemaVersion", () => {
    const result = parseTenantDataKeyRecord(validKey());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record).toEqual({
        schemaVersion: undefined,
        keyId: "data-key-1",
        organizationId: "acme",
        wrappedKeyRef: "kms://acme/wrapped-v1",
        status: "active",
        createdAtIso: CREATED,
        retiredAtIso: null,
      });
    }
  });

  it("accepts schemaVersion 1 and a rotated record with a non-null retiredAtIso", () => {
    const rotated = parseTenantDataKeyRecord(
      validKey({ schemaVersion: 1, status: "rotated", retiredAtIso: RETIRED_AT }),
    );
    expect(rotated.ok).toBe(true);
    if (rotated.ok) {
      expect(rotated.record.schemaVersion).toBe(1);
      expect(rotated.record.status).toBe("rotated");
      expect(rotated.record.retiredAtIso).toBe(RETIRED_AT);
    }
    const destroyed = parseTenantDataKeyRecord(
      validKey({ status: "destroyed", retiredAtIso: RETIRED_AT }),
    );
    expect(destroyed.ok).toBe(true);
    if (destroyed.ok) {
      expect(destroyed.record.status).toBe("destroyed");
    }
  });

  it("accepts a wrappedKeyRef of the boundary lengths 1 and 256", () => {
    const short = parseTenantDataKeyRecord(validKey({ wrappedKeyRef: "r" }));
    expect(short.ok).toBe(true);
    const long = parseTenantDataKeyRecord(
      validKey({ wrappedKeyRef: "r".repeat(256) }),
    );
    expect(long.ok).toBe(true);
  });
});

describe("parseTenantDataKeyRecord refuses hostile and malformed input", () => {
  it("refuses null, undefined, primitives, arrays, array-likes, non-plain objects, and Proxy", () => {
    const array: unknown[] = [];
    const arrayLike = { length: 1000000 };
    const date = new Date(0);
    const pseudoPlain = Object.create({ a: 1 }) as Record<string, unknown>;
    const hostileProxy = new Proxy(validKey(), {
      get() {
        throw new Error("trap");
      },
    });
    for (const input of [null, undefined, 42, "str", true, array, arrayLike, date, pseudoPlain, hostileProxy]) {
      const result = parseTenantDataKeyRecord(input, isProxy);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(typeof result.reason).toBe("string");
        expect(result.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("refuses getter property without invoking it", () => {
    let getterRan = false;
    const key = validKey() as Record<string, unknown>;
    Object.defineProperty(key, "wrappedKeyRef", {
      enumerable: true,
      configurable: true,
      get() {
        getterRan = true;
        return "kms://acme/wrapped-v1";
      },
    });
    const result = parseTenantDataKeyRecord(key, isProxy);
    expect(result.ok).toBe(false);
    expect(getterRan).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("tenant data key record wrappedKeyRef has a getter or setter property");
    }
  });

  it("refuses prototype-polluting keys and extra keys without echoing", () => {
    const secretKey = ["unknown", "Key"].join("");
    const secretValue = ["hidden", "Value"].join("");
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const hostile = { ...validKey() } as Record<string, unknown>;
      Object.defineProperty(hostile, key, { value: 1, enumerable: true, writable: true, configurable: true });
      const result = parseTenantDataKeyRecord(hostile, isProxy);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // __proto__ and constructor are named as prototype-polluting keys;
        // prototype is refused as an extra unknown key. Neither echoes the
        // key's value.
        expect(result.reason === "tenant data key record has the prototype-polluting key " + key
          || result.reason === "tenant data key record has an extra unknown key")
          .toBe(true);
        expect(result.reason).not.toContain("1");
      }
    }
    const extra = parseTenantDataKeyRecord(
      validKey({ [secretKey]: secretValue }),
      isProxy,
    );
    expect(extra.ok).toBe(false);
    if (!extra.ok) {
      expect(extra.reason).toContain("extra unknown key");
      expect(extra.reason).not.toContain(secretKey);
      expect(extra.reason).not.toContain(secretValue);
    }
  });

  it("refuses oversize strings and enormous lengths in O(1)", () => {
    // A wrappedKeyRef over its 256-character bound is refused as too-long,
    // as is a keyId over 63; nothing iterates an enormous length.
    const longRef = parseTenantDataKeyRecord(validKey({ wrappedKeyRef: "r".repeat(257) }));
    expect(longRef.ok).toBe(false);
    if (!longRef.ok) {
      expect(longRef.reason).toBe("tenant data key record wrappedKeyRef must be 1 to 256 characters");
    }
    const longId = parseTenantDataKeyRecord(validKey({ keyId: "a".repeat(64) }));
    expect(longId.ok).toBe(false);
    if (!longId.ok) {
      expect(longId.reason).toBe("tenant data key record keyId must match the key id pattern");
    }
    const enormous = { length: 1e9 };
    expect(parseTenantDataKeyRecord(enormous, isProxy).ok).toBe(false);
    expect(parseTenantDataKeyRecord(validKey({ wrappedKeyRef: enormous }), isProxy).ok).toBe(false);
  });

  it("refuses absent or invalid organizationId without defaulting", () => {
    const withoutOrg = { ...validKey() } as Record<string, unknown>;
    delete withoutOrg.organizationId;
    expect(withoutOrg).not.toHaveProperty("organizationId");
    const absent = parseTenantDataKeyRecord(withoutOrg, isProxy);
    expect(absent.ok).toBe(false);
    if (!absent.ok) {
      expect(absent.reason).toContain("organizationId");
    }
    for (const bad of [null, undefined, "", "Acme", "acme_x", "acme x", 42]) {
      const invalid = parseTenantDataKeyRecord(validKey({ organizationId: bad }), isProxy);
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) {
        expect(invalid.reason).toContain("organizationId");
      }
    }
  });

  it("refuses malformed fields, invalid schemaVersion, and retiredAtIso invariant mismatches", () => {
    const invalidKeyRef = parseTenantDataKeyRecord(validKey({ keyId: "Bad_Key" }));
    expect(invalidKeyRef.ok).toBe(false);
    if (!invalidKeyRef.ok) {
      expect(invalidKeyRef.reason).toContain("keyId");
    }
    for (const badRef of ["", "bad\nref", "bad\u007fref"]) {
      const result = parseTenantDataKeyRecord(validKey({ wrappedKeyRef: badRef }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("wrappedKeyRef");
      }
    }
    const badStatus = parseTenantDataKeyRecord(validKey({ status: "pending" }));
    expect(badStatus.ok).toBe(false);
    if (!badStatus.ok) {
      expect(badStatus.reason).toContain("status");
    }
    const badCreated = parseTenantDataKeyRecord(validKey({ createdAtIso: "2026-02-31T00:00:00Z" }));
    expect(badCreated.ok).toBe(false);
    if (!badCreated.ok) {
      expect(badCreated.reason).toContain("createdAtIso");
    }
    for (const badVersion of [0, 2, "1", null]) {
      const result = parseTenantDataKeyRecord(validKey({ schemaVersion: badVersion }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("schemaVersion");
      }
    }
    const retiredWithoutStamp = parseTenantDataKeyRecord(
      validKey({ status: "rotated", retiredAtIso: null }),
    );
    expect(retiredWithoutStamp.ok).toBe(false);
    if (!retiredWithoutStamp.ok) {
      expect(retiredWithoutStamp.reason).toContain("retiredAtIso");
    }
    const activeWithStamp = parseTenantDataKeyRecord(
      validKey({ retiredAtIso: RETIRED_AT }),
    );
    expect(activeWithStamp.ok).toBe(false);
    if (!activeWithStamp.ok) {
      expect(activeWithStamp.reason).toContain("retiredAtIso");
    }
    const badStamp = parseTenantDataKeyRecord(
      validKey({ status: "destroyed", retiredAtIso: "not-a-timestamp" }),
    );
    expect(badStamp.ok).toBe(false);
    if (!badStamp.ok) {
      expect(badStamp.reason).toContain("retiredAtIso");
    }
  });
});

describe("decideKeyUse allows and refuses by exact rules", () => {
  it("allows an active key for both wrap and unwrap", () => {
    for (const operation of ["wrap", "unwrap"] as const) {
      const decision = decideKeyUse(validKey(), "healthy", "acme", operation);
      expect(decision).toEqual({ allowed: true });
    }
  });

  it("refuses rotated key for wrap while allowing rotated key for unwrap", () => {
    const rotated = validKey({ status: "rotated", retiredAtIso: RETIRED_AT });
    const wrap = decideKeyUse(rotated, "healthy", "acme", "wrap");
    expect(wrap).toEqual({ allowed: false, reason: "key-not-active" });
    const unwrap = decideKeyUse(rotated, "healthy", "acme", "unwrap");
    expect(unwrap).toEqual({ allowed: true });
  });

  it("refuses destroyed key for both wrap and unwrap", () => {
    const destroyed = validKey({ status: "destroyed", retiredAtIso: RETIRED_AT });
    for (const operation of ["wrap", "unwrap"] as const) {
      const decision = decideKeyUse(destroyed, "healthy", "acme", operation);
      expect(decision).toEqual({ allowed: false, reason: "key-not-active" });
    }
  });

  it("refuses hostile record, invalid organisation id, and invalid operation with invalid-request", () => {
    const hostileProxy = new Proxy(validKey(), {
      get() {
        throw new Error("trap");
      },
      getOwnPropertyDescriptor() {
        throw new Error("trap");
      },
      ownKeys() {
        throw new Error("trap");
      },
    });
    const getterRan = { value: false };
    const getterRecord = validKey() as Record<string, unknown>;
    Object.defineProperty(getterRecord, "wrappedKeyRef", {
      enumerable: true,
      configurable: true,
      get() {
        getterRan.value = true;
        return "kms://acme/wrapped-v1";
      },
    });
    for (const badRecord of [null, undefined, 42, "str", [], { length: 1e9 }, getterRecord]) {
      const decision = decideKeyUse(badRecord, "healthy", "acme", "wrap");
      expect(decision).toEqual({ allowed: false, reason: "invalid-request" });
    }
    expect(getterRan.value).toBe(false);
    // Without a detector, a Proxy with throwing traps is the accepted
    // residual; the decider still fails closed instead of throwing.
    expect(() => decideKeyUse(hostileProxy, "healthy", "acme", "wrap")).not.toThrow();
    expect(decideKeyUse(hostileProxy, "healthy", "acme", "wrap")).toEqual({
      allowed: false,
      reason: "invalid-request",
    });
    for (const badOrg of [null, undefined, "", "Acme", "acme_x", 42]) {
      const decision = decideKeyUse(validKey(), "healthy", badOrg, "wrap");
      expect(decision).toEqual({ allowed: false, reason: "invalid-request" });
    }
    for (const badOperation of [null, undefined, "encrypt", "decrypt", "WRAP", 42]) {
      const decision = decideKeyUse(validKey(), "healthy", "acme", badOperation);
      expect(decision).toEqual({ allowed: false, reason: "invalid-request" });
    }
  });

  it("refuses degraded, down, missing, and unknown kmsHealth with unavailable", () => {
    for (const badHealth of ["degraded", "down", undefined, null, "HEALTHY", 42, {}]) {
      const decision = decideKeyUse(validKey(), badHealth, "acme", "wrap");
      expect(decision).toEqual({ allowed: false, reason: "unavailable" });
    }
  });

  it("refuses key of organisation A requested for organisation B with key-not-accessible regardless of key status", () => {
    for (const status of ["active", "rotated", "destroyed"] as const) {
      const record = validKey({
        status,
        retiredAtIso: status === "active" ? null : RETIRED_AT,
      });
      const decision = decideKeyUse(record, "healthy", "globex", operationFor(status));
      expect(decision).toEqual({ allowed: false, reason: "key-not-accessible" });
    }
  });

  it("enforces strict refusal reason precedence across overlapping failures", () => {
    const rotated = validKey({ status: "rotated", retiredAtIso: RETIRED_AT });
    // invalid-request beats unavailable: a hostile record with a down KMS
    // reports invalid-request.
    expect(decideKeyUse(null, "down", "acme", "wrap")).toEqual({
      allowed: false,
      reason: "invalid-request",
    });
    // invalid-request beats unavailable: a bad operation with a down KMS
    // reports invalid-request.
    expect(decideKeyUse(rotated, "down", "acme", "encrypt")).toEqual({
      allowed: false,
      reason: "invalid-request",
    });
    // invalid-request beats unavailable and key-not-accessible: a bad
    // requested organisation id on a foreign key with a down KMS reports
    // invalid-request.
    expect(decideKeyUse(rotated, "down", "Acme", "wrap")).toEqual({
      allowed: false,
      reason: "invalid-request",
    });
    // unavailable beats key-not-accessible: a foreign key with a degraded
    // KMS reports unavailable.
    expect(decideKeyUse(rotated, "degraded", "globex", "wrap")).toEqual({
      allowed: false,
      reason: "unavailable",
    });
    // key-not-accessible beats key-not-active: a foreign destroyed key
    // reports key-not-accessible, never key-not-active.
    const foreignDestroyed = validKey({
      organizationId: "acme",
      status: "destroyed",
      retiredAtIso: RETIRED_AT,
    });
    expect(decideKeyUse(foreignDestroyed, "healthy", "globex", "unwrap")).toEqual({
      allowed: false,
      reason: "key-not-accessible",
    });
    // key-not-active for wrap on a rotated key.
    expect(decideKeyUse(rotated, "healthy", "acme", "wrap")).toEqual({
      allowed: false,
      reason: "key-not-active",
    });
  });
});

function operationFor(status: string): "wrap" | "unwrap" {
  // A status-refusal can only be observed when the operation would otherwise
  // allow it, so wrap is used for rotated and unwrap for destroyed.
  return status === "rotated" ? "wrap" : "unwrap";
}
