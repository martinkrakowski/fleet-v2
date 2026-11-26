import { readFileSync } from "node:fs";
import { types } from "node:util";

import { describe, expect, it } from "vitest";

import { type IsProxy } from "@fleet/shared";

import {
  API_TOKEN_SCOPES,
  decideApiTokenRotation,
  decideApiTokenUse,
  parseApiTokenRecord,
  type ApiTokenRecord,
} from "../api-token.js";

const SOURCE = readFileSync(new URL("../api-token.ts", import.meta.url), "utf8");

const ISSUED = "2026-11-26T12:00:00Z";
const EXPIRES = "2026-11-27T12:00:00Z";
const NOW = "2026-11-26T13:00:00Z";
const DIGEST = "a".repeat(64);

/** A valid org-A record with a fresh token id per call. */
function validRecord(overrides: Record<string, unknown> = {}): ApiTokenRecord {
  return {
    tokenId: "token-0001",
    organizationId: "org-a",
    actor: "operator@example.com",
    scopes: ["read", "message"],
    secretDigest: DIGEST,
    issuedAtIso: ISSUED,
    expiresAtIso: EXPIRES,
    revokedAtIso: null,
    ...overrides,
  } as ApiTokenRecord;
}

const useInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  record: validRecord(),
  presentedDigest: DIGEST,
  organizationId: "org-a",
  requiredScope: "read",
  nowIso: NOW,
  ...overrides,
});

const rotationInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  record: validRecord(),
  organizationId: "org-a",
  nowIso: NOW,
  newTokenId: "token-0002",
  ...overrides,
});

/** A Proxy whose every trap throws: the reader must never invoke a trap. */
function throwingProxy(): object {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("trap");
      },
      getOwnPropertyDescriptor() {
        throw new Error("trap");
      },
      getPrototypeOf() {
        throw new Error("trap");
      },
      ownKeys() {
        throw new Error("trap");
      },
      has() {
        throw new Error("trap");
      },
    },
  );
}

/** A plain object whose `actor` field is a getter that throws when run. */
function getterRecord(base: ApiTokenRecord): object {
  return Object.defineProperty({ ...base }, "actor", {
    get() {
      throw new Error("getter must never run");
    },
    enumerable: true,
  });
}

/** Every public entry point, applied to one hostile input each. */
function applyAll(input: unknown, isProxy?: IsProxy): Array<{ outcome: string; reason?: string }> {
  return [
    parseApiTokenRecord(input, isProxy),
    decideApiTokenUse(input, isProxy),
    decideApiTokenRotation(input, isProxy),
  ];
}

describe("api-token module purity", () => {
  // Comments mention forbidden constructs only to document their absence,
  // so the source is scanned with comments stripped.
  const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("contains no clock, randomness, crypto or process access anywhere in the code", () => {
    expect(CODE).not.toMatch(/Date\.now/);
    expect(CODE).not.toMatch(/new Date\(\s*\)/);
    expect(CODE).not.toMatch(/Math\.random/);
    expect(CODE).not.toMatch(/\bcrypto\b/);
    expect(CODE).not.toMatch(/\bprocess\b/);
    expect(CODE).not.toMatch(/node:/);
  });

  it("compares timestamps only through compareZonedIsoInstants, never as strings", () => {
    expect(CODE).toMatch(/compareZonedIsoInstants\(/);
    // No lexicographic comparison between any two timestamp variables: the
    // only reads of the timestamp fields in operators are inside the
    // compareZonedIsoInstants argument lists.
    expect(CODE).not.toMatch(/(nowIso|issuedAtIso|expiresAtIso)\b[^(),;]*(?:[<>]|===|!==|==|>=|<=)/);
    // revokedAtIso is only ever compared to null or through the comparator.
    expect(CODE).not.toMatch(/revokedAtIso\b[^(),;{}]*(?:===|!==|==)(?!\s*null)/);
  });

  it("keeps the digest comparison at a fixed 64-iteration constant-time XOR shape", () => {
    expect(SOURCE).toMatch(/for \(let i = 0; i < SECRET_DIGEST_LENGTH; i \+= 1\)/);
    expect(SOURCE).toMatch(/charCodeAt\(i\) \^ /);
    expect(SOURCE).not.toMatch(/secretDigest ===/);
    expect(SOURCE).not.toMatch(/presentedDigest ===/);
    expect(SOURCE).not.toMatch(/secretDigest !==/);
    expect(SOURCE).not.toMatch(/presentedDigest !==/);
  });

  it("reads every untrusted object through snapshotPlainData with the injected detector", () => {
    expect(SOURCE).toMatch(/snapshotPlainData\(/);
    expect(SOURCE).toMatch(/maxNodes: 32/);
    expect(SOURCE).toMatch(/maxArrayLength: 7/);
  });
});

describe("API_TOKEN_SCOPES", () => {
  it("is the frozen seven-scope list including orchestrate", () => {
    expect([...API_TOKEN_SCOPES]).toEqual([
      "read",
      "message",
      "hook",
      "verdict",
      "operate",
      "orchestrate",
      "tail",
    ]);
  });
});

describe("parseApiTokenRecord", () => {
  it("parses a valid record with all required fields", () => {
    const result = parseApiTokenRecord(validRecord());
    expect(result.outcome).toBe("parsed");
    if (result.outcome !== "parsed") throw new Error("unreachable");
    expect(result.record.tokenId).toBe("token-0001");
    expect(result.record.organizationId).toBe("org-a");
    expect(result.record.scopes).toEqual(["read", "message"]);
    expect(result.record.revokedAtIso).toBeNull();
  });

  it("parses the optional registeredOrchestrator flag when present as a boolean", () => {
    const withFlag = parseApiTokenRecord(validRecord({ registeredOrchestrator: true }));
    expect(withFlag.outcome).toBe("parsed");
    if (withFlag.outcome !== "parsed") throw new Error("unreachable");
    expect(withFlag.record.registeredOrchestrator).toBe(true);
    const absent = parseApiTokenRecord(validRecord());
    expect(absent.outcome).toBe("parsed");
    if (absent.outcome !== "parsed") throw new Error("unreachable");
    expect("registeredOrchestrator" in absent.record).toBe(false);
  });

  it("refuses a non-boolean registeredOrchestrator as invalid-record", () => {
    for (const registeredOrchestrator of ["yes", 1, null]) {
      expect(parseApiTokenRecord(validRecord({ registeredOrchestrator }))).toEqual({
        outcome: "refused",
        reason: "invalid-record",
      });
    }
  });

  it("refuses malformed record fields, missing keys, extra keys, and duplicate or unknown scopes", () => {
    const cases: unknown[] = [
      validRecord({ tokenId: "bad actor" }),
      validRecord({ organizationId: "ORG-A" }),
      validRecord({ organizationId: "org_a" }),
      validRecord({ actor: "" }),
      validRecord({ secretDigest: "a".repeat(63) }),
      validRecord({ secretDigest: "A".repeat(64) }),
      validRecord({ secretDigest: "g".repeat(64) }),
      validRecord({ issuedAtIso: "2026-11-26 12:00:00" }),
      validRecord({ issuedAtIso: "not-a-date" }),
      validRecord({ issuedAtIso: "2026-02-31T12:00:00Z" }),
      validRecord({ expiresAtIso: ISSUED }),
      validRecord({ expiresAtIso: "2026-11-25T12:00:00Z" }),
      validRecord({ revokedAtIso: "2026-11-25T12:00:00Z" }),
      validRecord({ revokedAtIso: 0 }),
      validRecord({ revokedAtIso: "not-a-date" }),
      validRecord({ scopes: [] }),
      validRecord({ scopes: ["read", "read"] }),
      validRecord({ scopes: ["admin"] }),
      validRecord({ scopes: "read" }),
      validRecord({ scopes: null }),
      { ...validRecord(), extra: 1 },
      { tokenId: "token-0001" },
    ];
    for (const record of cases) {
      expect(parseApiTokenRecord(record)).toEqual({
        outcome: "refused",
        reason: "invalid-record",
      });
    }
  });
});

describe("decideApiTokenUse", () => {
  it("allows a use with the correct digest, org, window and granted scope", () => {
    const result = decideApiTokenUse(useInput());
    expect(result).toEqual({
      outcome: "allowed",
      tokenId: "token-0001",
      organizationId: "org-a",
      actor: "operator@example.com",
      scopes: ["read", "message"],
    });
  });

  it("never carries secretDigest in an allowed result", () => {
    const result = decideApiTokenUse(useInput());
    expect(JSON.stringify(result)).not.toContain(DIGEST);
  });

  it("refuses a digest differing in the last character without echoing digests", () => {
    const wrong = "a".repeat(63) + "b";
    const result = decideApiTokenUse(useInput({ presentedDigest: wrong }));
    expect(result).toEqual({ outcome: "refused", reason: "digest-mismatch" });
    expect(JSON.stringify(result)).not.toContain(wrong);
    expect(JSON.stringify(result)).not.toContain(DIGEST);
  });

  it("refuses a token bound to org A when used for org B", () => {
    expect(decideApiTokenUse(useInput({ organizationId: "org-b" }))).toEqual({
      outcome: "refused",
      reason: "wrong-organization",
    });
  });

  it("refuses a revoked token", () => {
    const revoked = validRecord({ revokedAtIso: "2026-11-26T12:30:00Z" });
    expect(decideApiTokenUse(useInput({ record: revoked }))).toEqual({
      outcome: "refused",
      reason: "revoked",
    });
  });

  it("refuses a token before issuedAtIso as not-yet-valid", () => {
    const result = decideApiTokenUse(useInput({ nowIso: "2026-11-26T11:59:59Z" }));
    expect(result).toEqual({ outcome: "refused", reason: "not-yet-valid" });
  });

  it("refuses a token at and after expiresAtIso as expired (boundary inclusive)", () => {
    for (const nowIso of [EXPIRES, "2026-11-27T12:00:00.001Z"]) {
      expect(decideApiTokenUse(useInput({ nowIso }))).toEqual({
        outcome: "refused",
        reason: "expired",
      });
    }
  });

  it("allows a use exactly at issuedAtIso (boundary inclusive at the start)", () => {
    expect(decideApiTokenUse(useInput({ nowIso: ISSUED })).outcome).toBe("allowed");
  });

  it("refuses a scope not granted on the token", () => {
    expect(decideApiTokenUse(useInput({ requiredScope: "operate" }))).toEqual({
      outcome: "refused",
      reason: "scope-not-granted",
    });
  });

  it("refuses orchestrate scope unless registeredOrchestrator is true", () => {
    const without = validRecord({ scopes: ["orchestrate"] });
    expect(decideApiTokenUse(useInput({ record: without, requiredScope: "orchestrate" }))).toEqual({
      outcome: "refused",
      reason: "orchestrate-not-registered",
    });
    const withFlag = validRecord({ scopes: ["orchestrate"], registeredOrchestrator: true });
    expect(decideApiTokenUse(useInput({ record: withFlag, requiredScope: "orchestrate" }))).toMatchObject({
      outcome: "allowed",
      tokenId: "token-0001",
    });
  });

  it("allows an instant across mixed UTC offsets even when the strings compare backwards", () => {
    // issued 10:00Z, expires 11:00Z, written with a +02:00 offset; the
    // lexicographic order says "10:30" < "12:00", so a string comparison
    // would wrongly refuse — the instant comparison must allow it.
    const record = validRecord({
      issuedAtIso: "2026-11-26T12:00:00+02:00",
      expiresAtIso: "2026-11-26T13:00:00+02:00",
    });
    expect(decideApiTokenUse(useInput({ record, nowIso: "2026-11-26T10:30:00Z" })).outcome).toBe(
      "allowed",
    );
    expect(
      decideApiTokenUse(useInput({ record, nowIso: "2026-11-26T09:59:59Z" })),
    ).toEqual({ outcome: "refused", reason: "not-yet-valid" });
    expect(decideApiTokenUse(useInput({ record, nowIso: "2026-11-26T11:00:00Z" }))).toEqual({
      outcome: "refused",
      reason: "expired",
    });
  });

  it("refuses malformed use inputs as invalid-input", () => {
    const cases: unknown[] = [
      useInput({ presentedDigest: "a".repeat(63) }),
      useInput({ presentedDigest: 42 }),
      useInput({ organizationId: "ORG-A" }),
      useInput({ requiredScope: "admin" }),
      useInput({ requiredScope: "__proto__" }),
      useInput({ nowIso: "not-a-date" }),
      useInput({ nowIso: "2026-11-26T13:00:00+01" }),
      useInput({ extra: true }),
      { record: validRecord(), presentedDigest: DIGEST, organizationId: "org-a", requiredScope: "read" },
    ];
    for (const input of cases) {
      expect(decideApiTokenUse(input)).toEqual({ outcome: "refused", reason: "invalid-input" });
    }
  });
});

describe("decideApiTokenRotation", () => {
  it("marks the old record revoked at nowIso with successorPending and the minting note", () => {
    const result = decideApiTokenRotation(rotationInput());
    expect(result.outcome).toBe("rotated");
    if (result.outcome !== "rotated") throw new Error("unreachable");
    expect(result.revokedRecord.revokedAtIso).toBe(NOW);
    expect(result.revokedRecord.tokenId).toBe("token-0001");
    expect(result.successorPending).toBe(true);
    expect(result.newTokenId).toBe("token-0002");
    expect(result.note).toBe("successor-must-be-minted-separately");
    // The stored digest is carried on the revoked record only, never in a refusal.
  });

  it("refuses a token bound to org A when rotated for org B", () => {
    expect(decideApiTokenRotation(rotationInput({ organizationId: "org-b" }))).toEqual({
      outcome: "refused",
      reason: "wrong-organization",
    });
  });

  it("refuses a colliding newTokenId as invalid-input", () => {
    expect(decideApiTokenRotation(rotationInput({ newTokenId: "token-0001" }))).toEqual({
      outcome: "refused",
      reason: "invalid-input",
    });
  });

  it("refuses an already-revoked token", () => {
    const revoked = validRecord({ revokedAtIso: "2026-11-26T12:30:00Z" });
    expect(decideApiTokenRotation(rotationInput({ record: revoked }))).toEqual({
      outcome: "refused",
      reason: "revoked",
    });
  });

  it("refuses a not-yet-valid token, including across mixed offsets", () => {
    const record = validRecord({ issuedAtIso: "2026-11-26T12:00:00+02:00" });
    expect(
      decideApiTokenRotation(rotationInput({ record, nowIso: "2026-11-26T09:59:59Z" })),
    ).toEqual({ outcome: "refused", reason: "not-yet-valid" });
    expect(decideApiTokenRotation(rotationInput({ nowIso: "2026-11-26T11:59:59Z" }))).toEqual({
      outcome: "refused",
      reason: "not-yet-valid",
    });
  });

  it("refuses a token at and after expiresAtIso as expired, across mixed offsets", () => {
    const record = validRecord({
      issuedAtIso: "2026-11-26T12:00:00+02:00",
      expiresAtIso: "2026-11-26T13:00:00+02:00",
    });
    expect(
      decideApiTokenRotation(rotationInput({ record, nowIso: "2026-11-26T11:00:00Z" })),
    ).toEqual({ outcome: "refused", reason: "expired" });
    expect(decideApiTokenRotation(rotationInput({ nowIso: EXPIRES }))).toEqual({
      outcome: "refused",
      reason: "expired",
    });
  });

  it("refuses malformed rotation inputs as invalid-input", () => {
    const cases: unknown[] = [
      rotationInput({ organizationId: "ORG-A" }),
      rotationInput({ newTokenId: "bad actor" }),
      rotationInput({ newTokenId: "" }),
      rotationInput({ nowIso: "not-a-date" }),
      rotationInput({ extra: true }),
      { record: validRecord(), organizationId: "org-a", nowIso: NOW },
    ];
    for (const input of cases) {
      expect(decideApiTokenRotation(input)).toEqual({ outcome: "refused", reason: "invalid-input" });
    }
  });
});

describe("hostile inputs", () => {
  it("refuses null, undefined, and wrong primitives without throwing", () => {
    for (const hostile of [null, undefined, 42, "record", true, NaN]) {
      for (const result of applyAll(hostile)) {
        expect(result.outcome).toBe("refused");
      }
      expect(parseApiTokenRecord(hostile)).toEqual({ outcome: "refused", reason: "invalid-record" });
      expect(decideApiTokenUse(hostile)).toEqual({ outcome: "refused", reason: "invalid-input" });
      expect(decideApiTokenRotation(hostile)).toEqual({ outcome: "refused", reason: "invalid-input" });
    }
  });

  it("refuses non-array, non-iterable, and array-like scopes", () => {
    for (const scopes of [{ length: 1, 0: "read" }, "read", 42, {}]) {
      const record = validRecord({ scopes });
      expect(parseApiTokenRecord(record)).toEqual({ outcome: "refused", reason: "invalid-record" });
      expect(decideApiTokenUse(useInput({ record }))).toEqual({
        outcome: "refused",
        reason: "invalid-record",
      });
      expect(decideApiTokenRotation(rotationInput({ record }))).toEqual({
        outcome: "refused",
        reason: "invalid-record",
      });
    }
  });

  it("refuses sparse array holes in scopes", () => {
    const sparse: unknown[] = new Array(2);
    sparse[1] = "read";
    const record = validRecord({ scopes: sparse });
    expect(parseApiTokenRecord(record)).toEqual({ outcome: "refused", reason: "invalid-record" });
    expect(decideApiTokenUse(useInput({ record }))).toEqual({
      outcome: "refused",
      reason: "invalid-record",
    });
    expect(decideApiTokenRotation(rotationInput({ record }))).toEqual({
      outcome: "refused",
      reason: "invalid-record",
    });
  });

  it("refuses accessor getters without invoking them", () => {
    const marker = getterRecord(validRecord());
    expect(parseApiTokenRecord(marker)).toEqual({ outcome: "refused", reason: "invalid-record" });
    expect(decideApiTokenUse(useInput({ record: marker }))).toEqual({
      outcome: "refused",
      reason: "invalid-record",
    });
    const hostileWrapper = Object.defineProperty({ ...useInput() }, "presentedDigest", {
      get() {
        throw new Error("getter must never run");
      },
      enumerable: true,
    });
    expect(decideApiTokenUse(hostileWrapper)).toEqual({
      outcome: "refused",
      reason: "invalid-input",
    });
  });

  it("refuses Proxy inputs via isProxy detector and throwing traps", () => {
    const proxy = throwingProxy();
    // With node:util's real detector the Proxy is refused without a trap running.
    for (const result of applyAll(proxy, types.isProxy)) {
      expect(result.outcome).toBe("refused");
    }
    expect(parseApiTokenRecord(proxy, types.isProxy)).toEqual({
      outcome: "refused",
      reason: "invalid-record",
    });
    // With no detector a throwing trap is caught and refused anyway.
    for (const result of applyAll(proxy)) {
      expect(result.outcome).toBe("refused");
    }
  });

  it("refuses oversized strings, oversized arrays, and enormous length properties", () => {
    const huge = { ...validRecord(), scopes: [...API_TOKEN_SCOPES, "read"] };
    expect(parseApiTokenRecord(huge)).toEqual({ outcome: "refused", reason: "invalid-record" });
    expect(decideApiTokenUse(useInput({ record: huge }))).toEqual({
      outcome: "refused",
      reason: "invalid-record",
    });
    expect(decideApiTokenRotation(rotationInput({ record: huge }))).toEqual({
      outcome: "refused",
      reason: "invalid-record",
    });
    const longDigest = { ...validRecord(), secretDigest: "a".repeat(10_000) };
    expect(parseApiTokenRecord(longDigest)).toEqual({
      outcome: "refused",
      reason: "invalid-record",
    });
    expect(decideApiTokenUse(useInput({ record: longDigest }))).toEqual({
      outcome: "refused",
      reason: "invalid-record",
    });
    const longNow = useInput({ nowIso: "x".repeat(10_000) });
    expect(decideApiTokenUse(longNow)).toEqual({ outcome: "refused", reason: "invalid-input" });
    expect(decideApiTokenRotation(longNow)).toEqual({ outcome: "refused", reason: "invalid-input" });
  });

  it("refuses prototype-polluting own keys", () => {
    for (const key of ["__proto__", "constructor", "prototype", "length"]) {
      const record = Object.defineProperty({ ...validRecord() }, key, {
        value: key === "__proto__" ? null : 1,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      expect(parseApiTokenRecord(record)).toEqual({ outcome: "refused", reason: "invalid-record" });
      expect(decideApiTokenUse(useInput({ record }))).toEqual({
        outcome: "refused",
        reason: "invalid-record",
      });
      expect(decideApiTokenRotation(rotationInput({ record }))).toEqual({
        outcome: "refused",
        reason: "invalid-record",
      });
      const hostileWrapper = Object.defineProperty({ ...useInput() }, key, {
        value: key === "__proto__" ? null : 1,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      expect(decideApiTokenUse(hostileWrapper)).toEqual({
        outcome: "refused",
        reason: "invalid-input",
      });
    }
  });

  it("refuses invalid or throwing isProxy detector", () => {
    const throwingDetector = (): boolean => {
      throw new Error("detector");
    };
    for (const isProxy of [42, "yes", throwingDetector] as unknown as IsProxy[]) {
      expect(parseApiTokenRecord(validRecord(), isProxy)).toEqual({
        outcome: "refused",
        reason: "invalid-record",
      });
      expect(decideApiTokenUse(useInput(), isProxy)).toEqual({
        outcome: "refused",
        reason: "invalid-input",
      });
      expect(decideApiTokenRotation(rotationInput(), isProxy)).toEqual({
        outcome: "refused",
        reason: "invalid-input",
      });
    }
  });
});

describe("digest non-echo", () => {
  it("no refusal result ever contains the stored or presented digest", () => {
    const stored = "b".repeat(64);
    const wrong = "c".repeat(64);
    const record = validRecord({ secretDigest: stored });
    const results = [
      decideApiTokenUse(useInput({ record, presentedDigest: wrong })),
      decideApiTokenUse(useInput({ record: validRecord({ secretDigest: stored, revokedAtIso: NOW }) })),
      decideApiTokenUse(null),
      decideApiTokenRotation(rotationInput({ record: validRecord({ secretDigest: stored, revokedAtIso: NOW }) })),
      decideApiTokenRotation(null),
    ];
    for (const result of results) {
      expect(result.outcome).toBe("refused");
      expect(JSON.stringify(result)).not.toContain(stored);
      expect(JSON.stringify(result)).not.toContain(wrong);
      expect(JSON.stringify(result)).not.toContain("secretDigest");
    }
  });
});
