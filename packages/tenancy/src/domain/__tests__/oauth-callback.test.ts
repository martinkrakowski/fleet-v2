import { readFileSync } from "node:fs";
import { types } from "node:util";

import { describe, expect, it } from "vitest";

import {
  OAUTH_PENDING_STATE_MAX_TTL_MS,
  OAUTH_STATE_DIGEST_LENGTH,
  OAUTH_STATE_DIGEST_PATTERN,
  decideOAuthCallback,
  parseOAuthPendingState,
  type OAuthCallbackDecision,
  type OAuthPendingStateRecord,
} from "../oauth-callback.js";

const SOURCE = readFileSync(new URL("../oauth-callback.ts", import.meta.url), "utf8");

const ISSUED = "2026-11-26T12:00:00.000Z";
const EXPIRES = "2026-11-26T12:10:00.000Z";
const DIGEST = "a".repeat(64);
const ORG = "org-1";

const pendingRecord = (overrides: Partial<OAuthPendingStateRecord> = {}): OAuthPendingStateRecord => ({
  stateDigest: DIGEST,
  organizationId: ORG,
  issuedAtIso: ISSUED,
  expiresAtIso: EXPIRES,
  consumed: false,
  ...overrides,
});

const callbackInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  pending: pendingRecord(),
  callbackStateDigest: DIGEST,
  providerError: null,
  hasCode: true,
  nowIso: ISSUED,
  ...overrides,
});

/** A Proxy whose every trap throws: the reader must never invoke it. */
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
    },
  );
}

/** A plain object with one field replaced by a getter that throws when run. */
function getterObject(base: object, key: string): object {
  return Object.defineProperty({ ...base }, key, {
    get() {
      throw new Error("getter must never run");
    },
    enumerable: true,
  });
}

function expectAccepted(decision: OAuthCallbackDecision): string {
  expect(decision.outcome).toBe("accepted");
  if (decision.outcome !== "accepted") throw new Error("unreachable");
  return decision.organizationId;
}

describe("oauth-callback module purity", () => {
  it("contains no clock, randomness, crypto or process access anywhere in the source", () => {
    expect(SOURCE).not.toMatch(/Date\.now/);
    expect(SOURCE).not.toMatch(/new Date\(\s*\)/);
    expect(SOURCE).not.toMatch(/Math\.random/);
    expect(SOURCE).not.toMatch(/\bcrypto\b/);
    expect(SOURCE).not.toMatch(/\bprocess\b/);
  });

  it("exports the documented constants (10-minute TTL, 64-hex digest pattern)", () => {
    expect(OAUTH_PENDING_STATE_MAX_TTL_MS).toBe(10 * 60 * 1000);
    expect(OAUTH_STATE_DIGEST_LENGTH).toBe(64);
    expect(OAUTH_STATE_DIGEST_PATTERN.source).toBe("^[0-9a-f]{64}$");
  });
});

describe("parseOAuthPendingState", () => {
  it("parses a valid unconsumed record with all five fields preserved", () => {
    const result = parseOAuthPendingState(pendingRecord({ consumed: true }));
    expect(result).toEqual({ ok: true, value: pendingRecord({ consumed: true }) });
  });

  it("refuses missing and extra keys as invalid-pending", () => {
    const missing = { ...pendingRecord() } as Record<string, unknown>;
    delete missing.consumed;
    expect(parseOAuthPendingState(missing)).toEqual({ ok: false, reason: "invalid-pending" });
    expect(parseOAuthPendingState({ ...pendingRecord(), extra: 1 })).toEqual({
      ok: false,
      reason: "invalid-pending",
    });
    expect(parseOAuthPendingState({})).toEqual({ ok: false, reason: "invalid-pending" });
  });

  it("refuses prototype-polluting own keys (__proto__, constructor, prototype)", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const hostile: Record<string, unknown> = { ...pendingRecord(), [key]: 1 };
      if (key === "__proto__") {
        Object.defineProperty(hostile, key, { value: null, enumerable: true, configurable: true, writable: true });
      }
      expect(parseOAuthPendingState(hostile)).toEqual({ ok: false, reason: "invalid-pending" });
    }
  });

  it("refuses arrays, array holes and array-likes as invalid-pending", () => {
    const asArray = [...Object.values(pendingRecord())] as unknown;
    (asArray as unknown[]).length = 6; // sparse
    expect(parseOAuthPendingState([pendingRecord()])).toEqual({ ok: false, reason: "invalid-pending" });
    expect(parseOAuthPendingState(asArray)).toEqual({ ok: false, reason: "invalid-pending" });
    expect(parseOAuthPendingState({ length: 5 })).toEqual({ ok: false, reason: "invalid-pending" });
  });

  it("refuses enormous strings and an oversized record without echoing them", () => {
    const result = parseOAuthPendingState(pendingRecord({ stateDigest: "a".repeat(10_000) }));
    expect(result).toEqual({ ok: false, reason: "invalid-pending" });
    const noisy: Record<string, unknown> = { ...pendingRecord() };
    for (let i = 0; i < 100; i += 1) {
      noisy[`extra-${i}`] = "x".repeat(100);
    }
    expect(parseOAuthPendingState(noisy)).toEqual({ ok: false, reason: "invalid-pending" });
    expect(JSON.stringify(parseOAuthPendingState(noisy))).not.toContain("x".repeat(100));
  });

  it("refuses getters without ever running them", () => {
    const hostile = getterObject(pendingRecord(), "organizationId");
    expect(parseOAuthPendingState(hostile)).toEqual({ ok: false, reason: "invalid-pending" });
    expect(parseOAuthPendingState(getterObject(pendingRecord(), "stateDigest"))).toEqual({
      ok: false,
      reason: "invalid-pending",
    });
  });

  it("refuses Proxies (detected via types.isProxy and throwing traps) as invalid-pending", () => {
    expect(parseOAuthPendingState(throwingProxy(), types.isProxy)).toEqual({
      ok: false,
      reason: "invalid-pending",
    });
    const silentProxy = new Proxy(pendingRecord(), {});
    expect(parseOAuthPendingState(silentProxy, types.isProxy)).toEqual({
      ok: false,
      reason: "invalid-pending",
    });
  });

  it("refuses null, undefined, primitives and symbol-keyed records", () => {
    for (const raw of [null, undefined, 42, "record", true, Symbol("s")]) {
      expect(parseOAuthPendingState(raw)).toEqual({ ok: false, reason: "invalid-pending" });
    }
    const symbolKey: Record<string | symbol, unknown> = { ...pendingRecord() };
    symbolKey[Symbol("extra")] = 1;
    expect(parseOAuthPendingState(symbolKey)).toEqual({ ok: false, reason: "invalid-pending" });
  });

  it("refuses invalid stateDigest (wrong length, non-hex, non-string)", () => {
    for (const stateDigest of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "", 42, null]) {
      expect(parseOAuthPendingState(pendingRecord({ stateDigest: stateDigest as string }))).toEqual({
        ok: false,
        reason: "invalid-pending",
      });
    }
  });

  it("refuses invalid organizationId (bad shape, too long, non-string)", () => {
    for (const organizationId of ["", "a".repeat(64), "Org_1", "org/1", "-org", 42, null]) {
      expect(parseOAuthPendingState(pendingRecord({ organizationId: organizationId as string }))).toEqual({
        ok: false,
        reason: "invalid-pending",
      });
    }
  });

  it("refuses invalid or non-zoned timestamps", () => {
    for (const pair of [
      { issuedAtIso: "garbage" },
      { issuedAtIso: "2026-02-31T12:00:00.000Z" },
      { issuedAtIso: "2026-11-26T12:00:00" },
      { expiresAtIso: "not-a-date" },
      { expiresAtIso: 42 },
      { issuedAtIso: null },
    ]) {
      expect(parseOAuthPendingState(pendingRecord(pair as Partial<OAuthPendingStateRecord>))).toEqual({
        ok: false,
        reason: "invalid-pending",
      });
    }
  });

  it("refuses lifetimes <= 0 or over 10 minutes", () => {
    expect(
      parseOAuthPendingState(pendingRecord({ expiresAtIso: ISSUED })),
    ).toEqual({ ok: false, reason: "invalid-pending" });
    expect(
      parseOAuthPendingState(
        pendingRecord({
          expiresAtIso: new Date(Date.parse(ISSUED) + OAUTH_PENDING_STATE_MAX_TTL_MS + 1).toISOString(),
        }),
      ),
    ).toEqual({ ok: false, reason: "invalid-pending" });
    // Exactly 10 minutes is still accepted.
    expect(
      parseOAuthPendingState(pendingRecord({ expiresAtIso: EXPIRES })).ok,
    ).toBe(true);
  });

  it("refuses non-boolean consumed values", () => {
    for (const consumed of [0, 1, "true", null, undefined]) {
      expect(parseOAuthPendingState(pendingRecord({ consumed: consumed as unknown as boolean }))).toEqual({
        ok: false,
        reason: "invalid-pending",
      });
    }
  });

  it("refuses a non-function isProxy detector as invalid-pending", () => {
    for (const isProxy of [42, "no", true, null]) {
      expect(parseOAuthPendingState(pendingRecord(), isProxy as never)).toEqual({
        ok: false,
        reason: "invalid-pending",
      });
    }
  });
});

describe("decideOAuthCallback", () => {
  it("accepts at issuedAtIso and inside the window, returning the organizationId", () => {
    for (const nowIso of [ISSUED, "2026-11-26T12:05:00.000Z"]) {
      const organizationId = expectAccepted(decideOAuthCallback(callbackInput({ nowIso })));
      expect(organizationId).toBe(ORG);
    }
  });

  it("refuses the boundary instant expiresAtIso and any instant before issuedAtIso as expired", () => {
    for (const nowIso of ["2026-11-26T11:59:59.999Z", EXPIRES, "2026-11-26T13:00:00.000Z"]) {
      expect(decideOAuthCallback(callbackInput({ nowIso }))).toEqual({
        outcome: "refused",
        reason: "expired",
      });
    }
  });

  it("refuses each documented field fault with the right reason", () => {
    expect(decideOAuthCallback(callbackInput({ callbackStateDigest: "b".repeat(64) }))).toEqual({
      outcome: "refused",
      reason: "state-mismatch",
    });
    expect(decideOAuthCallback(callbackInput({ pending: pendingRecord({ consumed: true }) }))).toEqual({
      outcome: "refused",
      reason: "already-consumed",
    });
    expect(decideOAuthCallback(callbackInput({ providerError: "provider down" }))).toEqual({
      outcome: "refused",
      reason: "provider-denied",
    });
    expect(decideOAuthCallback(callbackInput({ providerError: true }))).toEqual({
      outcome: "refused",
      reason: "provider-denied",
    });
    expect(decideOAuthCallback(callbackInput({ hasCode: false }))).toEqual({
      outcome: "refused",
      reason: "missing-code",
    });
    expect(decideOAuthCallback(callbackInput({ hasCode: "yes" }))).toEqual({
      outcome: "refused",
      reason: "invalid-input",
    });
  });

  it("accepts null, false and empty-string providerError with hasCode true, and refuses undefined as invalid-input", () => {
    for (const providerError of [null, false, ""]) {
      expect(decideOAuthCallback(callbackInput({ providerError }))).toEqual({
        outcome: "accepted",
        organizationId: ORG,
      });
    }
    expect(decideOAuthCallback(callbackInput({ providerError: undefined }))).toEqual({
      outcome: "refused",
      reason: "invalid-input",
    });
    expect(decideOAuthCallback(callbackInput({ providerError: 42 }))).toEqual({
      outcome: "refused",
      reason: "invalid-input",
    });
    expect(decideOAuthCallback(callbackInput({ providerError: "e".repeat(5000) }))).toEqual({
      outcome: "refused",
      reason: "invalid-input",
    });
    // A provider error at the snapshot string cap is still a provider denial.
    expect(decideOAuthCallback(callbackInput({ providerError: "e".repeat(4096) }))).toEqual({
      outcome: "refused",
      reason: "provider-denied",
    });
  });

  it("refuses an invalid nowIso or callbackStateDigest as invalid-input", () => {
    for (const nowIso of ["garbage", "2026-02-31T12:00:00.000Z", 42, null, "a".repeat(10_000)]) {
      expect(decideOAuthCallback(callbackInput({ nowIso }))).toEqual({
        outcome: "refused",
        reason: "invalid-input",
      });
    }
    for (const callbackStateDigest of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "", 42, null]) {
      expect(decideOAuthCallback(callbackInput({ callbackStateDigest }))).toEqual({
        outcome: "refused",
        reason: "invalid-input",
      });
    }
  });

  it("refuses a replay of an accepted callback (consumed: true) as already-consumed", () => {
    const first = decideOAuthCallback(callbackInput());
    expect(first.outcome).toBe("accepted");
    const replay = decideOAuthCallback(
      callbackInput({ pending: pendingRecord({ consumed: true }) }),
    );
    expect(replay).toEqual({ outcome: "refused", reason: "already-consumed" });
  });

  it("refuses invalid pending shapes as invalid-pending, not invalid-input", () => {
    for (const pending of [
      null,
      undefined,
      42,
      "pending",
      [pendingRecord()],
      { length: 5 },
      {},
      { ...pendingRecord(), extra: 1 },
      pendingRecord({ stateDigest: "short" }),
      pendingRecord({ issuedAtIso: "garbage" }),
    ]) {
      expect(decideOAuthCallback(callbackInput({ pending }))).toEqual({
        outcome: "refused",
        reason: "invalid-pending",
      });
    }
  });

  it("refuses hostile outer input shapes as invalid-input", () => {
    for (const input of [
      null,
      undefined,
      42,
      "input",
      [callbackInput()],
      { length: 5 },
      getterObject(callbackInput(), "callbackStateDigest"),
      throwingProxy(),
      Object.defineProperty({ ...callbackInput() }, "__proto__", { value: null, enumerable: true }),
      Object.defineProperty({ ...callbackInput() }, "constructor", { value: 1, enumerable: true }),
      { ...callbackInput(), extra: 1 },
    ]) {
      expect(decideOAuthCallback(input, types.isProxy)).toEqual({
        outcome: "refused",
        reason: "invalid-input",
      });
    }
  });

  it("maps missing outer keys per the table: pending is invalid-pending, others invalid-input", () => {
    const without = (key: string): Record<string, unknown> => {
      const input = { ...callbackInput() } as Record<string, unknown>;
      delete input[key];
      return input;
    };
    expect(decideOAuthCallback(without("pending"))).toEqual({
      outcome: "refused",
      reason: "invalid-pending",
    });
    for (const key of ["callbackStateDigest", "providerError", "hasCode", "nowIso"]) {
      expect(decideOAuthCallback(without(key))).toEqual({
        outcome: "refused",
        reason: "invalid-input",
      });
    }
    // An entirely empty object misses `pending`, so it is invalid-pending.
    expect(decideOAuthCallback({})).toEqual({
      outcome: "refused",
      reason: "invalid-pending",
    });
  });

  it("refuses a non-function isProxy detector as invalid-input", () => {
    for (const isProxy of [42, "no", true, null]) {
      expect(decideOAuthCallback(callbackInput(), isProxy as never)).toEqual({
        outcome: "refused",
        reason: "invalid-input",
      });
    }
  });

  it("keeps the fixed refusal ordering when two faults are present simultaneously", () => {
    const consumed = callbackInput({ pending: pendingRecord({ consumed: true }) });
    // invalid-pending beats already-consumed.
    expect(
      decideOAuthCallback(callbackInput({ pending: pendingRecord({ consumed: true, stateDigest: "bad" }) })),
    ).toEqual({ outcome: "refused", reason: "invalid-pending" });
    // invalid-pending beats expired.
    expect(
      decideOAuthCallback(
        callbackInput({ pending: pendingRecord({ issuedAtIso: "garbage" }), nowIso: EXPIRES }),
      ),
    ).toEqual({ outcome: "refused", reason: "invalid-pending" });
    // already-consumed beats expired and state-mismatch.
    expect(decideOAuthCallback({ ...consumed, nowIso: EXPIRES })).toEqual({
      outcome: "refused",
      reason: "already-consumed",
    });
    expect(decideOAuthCallback({ ...consumed, callbackStateDigest: "c".repeat(64) })).toEqual({
      outcome: "refused",
      reason: "already-consumed",
    });
    // expired beats state-mismatch.
    expect(
      decideOAuthCallback(
        callbackInput({ nowIso: EXPIRES, callbackStateDigest: "c".repeat(64) }),
      ),
    ).toEqual({ outcome: "refused", reason: "expired" });
    // state-mismatch beats provider-denied.
    expect(
      decideOAuthCallback(
        callbackInput({ callbackStateDigest: "c".repeat(64), providerError: "boom" }),
      ),
    ).toEqual({ outcome: "refused", reason: "state-mismatch" });
    // provider-denied beats missing-code.
    expect(
      decideOAuthCallback(callbackInput({ providerError: "boom", hasCode: false })),
    ).toEqual({ outcome: "refused", reason: "provider-denied" });
  });

  it("never echoes the state digest, callback digest or provider error text in any refusal", () => {
    const wrong = "f".repeat(63) + "0";
    const providerText = "totally-secret-provider-error";
    const results = [
      decideOAuthCallback(callbackInput({ callbackStateDigest: wrong })),
      decideOAuthCallback(callbackInput({ providerError: providerText })),
      decideOAuthCallback(callbackInput({ pending: pendingRecord({ stateDigest: "short" }) })),
      decideOAuthCallback(null),
      decideOAuthCallback(throwingProxy(), types.isProxy),
    ];
    for (const result of results) {
      expect(result.outcome).toBe("refused");
      const text = JSON.stringify(result);
      expect(text).not.toContain(wrong);
      expect(text).not.toContain(DIGEST);
      expect(text).not.toContain(providerText);
    }
  });

  it("never invokes getters or Proxy traps while reading input or pending", () => {
    expect(
      decideOAuthCallback(getterObject(callbackInput(), "hasCode"), types.isProxy),
    ).toEqual({ outcome: "refused", reason: "invalid-input" });
    expect(
      decideOAuthCallback(
        callbackInput({ pending: getterObject(pendingRecord(), "consumed") }),
        types.isProxy,
      ),
    ).toEqual({ outcome: "refused", reason: "invalid-pending" });
    expect(decideOAuthCallback(throwingProxy(), types.isProxy)).toEqual({
      outcome: "refused",
      reason: "invalid-input",
    });
  });

  it("keeps the digest comparison at a fixed 64-iteration constant-time shape", () => {
    expect(SOURCE).toMatch(/for \(let i = 0; i < OAUTH_STATE_DIGEST_LENGTH; i \+= 1\)/);
    expect(SOURCE).not.toMatch(/callbackStateDigest ===/);
    expect(SOURCE).not.toMatch(/stateDigest ===/);
    expect(SOURCE).not.toMatch(/callbackStateDigest !==/);
    expect(SOURCE).not.toMatch(/stateDigest !==/);
  });

  it("reads the untrusted input exactly once through snapshotPlainData and never enumerates own properties ad hoc", () => {
    expect(SOURCE.match(/snapshotPlainData\(/g)?.length).toBe(2);
    expect(SOURCE).not.toMatch(/getOwnPropertyNames/);
    expect(SOURCE).not.toMatch(/Object\.keys/);
  });
});
