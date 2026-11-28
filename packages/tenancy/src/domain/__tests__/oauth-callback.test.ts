import { readFileSync } from "node:fs";
import { types } from "node:util";

import { describe, expect, it } from "vitest";

import type { IsProxy } from "@fleet/shared";

import {
  OAUTH_PENDING_STATE_MAX_TTL_MS,
  OAUTH_STATE_DIGEST_LENGTH,
  decideOAuthCallback,
  parseOAuthPendingState,
} from "../oauth-callback.js";

const SOURCE = readFileSync(new URL("../oauth-callback.ts", import.meta.url), "utf8");

const ISSUED = "2026-11-26T12:00:00.000Z";
const EXPIRES = "2026-11-26T12:10:00.000Z";
const NOW = "2026-11-26T12:01:00.000Z";

const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);

const isProxy: IsProxy = (value) => types.isProxy(value);

type PendingRecord = {
  readonly stateDigest: string;
  readonly organizationId: string;
  readonly issuedAtIso: string;
  readonly expiresAtIso: string;
  readonly consumed: boolean;
};

const pendingRecord = (overrides: Partial<PendingRecord> = {}): PendingRecord => ({
  stateDigest: DIGEST,
  organizationId: "org-1",
  issuedAtIso: ISSUED,
  expiresAtIso: EXPIRES,
  consumed: false,
  ...overrides,
});

type CallbackInput = {
  readonly pending: PendingRecord;
  readonly callbackStateDigest: string;
  readonly providerError: null | boolean | string;
  readonly hasCode: boolean;
  readonly nowIso: string;
};

const callbackInput = (overrides: Partial<CallbackInput> = {}): CallbackInput => ({
  pending: pendingRecord(),
  callbackStateDigest: DIGEST,
  providerError: null,
  hasCode: true,
  nowIso: NOW,
  ...overrides,
});

/** A Proxy whose every reflection trap throws: the reader must never invoke it. */
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

/** An honest Proxy over a plain object: valid-looking data behind traps. */
function honestProxy(target: Record<string, unknown>): object {
  return new Proxy(target, {});
}

/** A plain object whose every listed field is a getter that throws when run. */
function getterObject(base: Record<string, unknown>, keys: readonly string[]): object {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (keys.includes(key)) {
      Object.defineProperty(result, key, {
        get() {
          throw new Error("getter must never run");
        },
        enumerable: true,
      });
    } else {
      result[key] = value;
    }
  }
  return result;
}

describe("oauth-callback module purity", () => {
  it("contains no clock, randomness, crypto or process access anywhere in the source", () => {
    expect(SOURCE).not.toMatch(/Date\.now/);
    expect(SOURCE).not.toMatch(/new Date\(\s*\)/);
    expect(SOURCE).not.toMatch(/Math\.random/);
    expect(SOURCE).not.toMatch(/\bcrypto\b/);
    expect(SOURCE).not.toMatch(/\bprocess\b/);
  });
});

describe("parseOAuthPendingState", () => {
  it("accepts a valid pending-state record and returns its fields", () => {
    const result = parseOAuthPendingState(pendingRecord(), isProxy);
    expect(result).toEqual({
      ok: true,
      value: pendingRecord(),
    });
  });

  it("refuses a missing detector: without one a Proxy is indistinguishable from plain data", () => {
    // No injected detector at all.
    expect(parseOAuthPendingState(pendingRecord())).toEqual({ ok: false, reason: "invalid-pending" });
    // An honest Proxy is refused even though its target is valid data,
    // because without an accurate detector its traps must never run.
    const proxyTarget = pendingRecord() as unknown as Record<string, unknown>;
    expect(parseOAuthPendingState(honestProxy(proxyTarget))).toEqual({
      ok: false,
      reason: "invalid-pending",
    });
  });

  it("refuses a non-function detector", () => {
    expect(parseOAuthPendingState(pendingRecord(), 42 as never)).toEqual({
      ok: false,
      reason: "invalid-pending",
    });
    expect(parseOAuthPendingState(pendingRecord(), null as never)).toEqual({
      ok: false,
      reason: "invalid-pending",
    });
  });

  it("refuses a Proxy with types.isProxy and a throwing-trap Proxy without throwing", () => {
    expect(parseOAuthPendingState(honestProxy(pendingRecord() as unknown as Record<string, unknown>), isProxy)).toEqual({
      ok: false,
      reason: "invalid-pending",
    });
    expect(parseOAuthPendingState(throwingProxy(), isProxy)).toEqual({
      ok: false,
      reason: "invalid-pending",
    });
  });

  it("refuses null, undefined, primitives, arrays, array holes, array-likes and enormous values", () => {
    const arrayLike = { length: 5 };
    const sparse: unknown[] = [pendingRecord()];
    delete sparse[0];
    expect(parseOAuthPendingState(null, isProxy)).toEqual({ ok: false, reason: "invalid-pending" });
    expect(parseOAuthPendingState(undefined, isProxy)).toEqual({ ok: false, reason: "invalid-pending" });
    expect(parseOAuthPendingState(42, isProxy)).toEqual({ ok: false, reason: "invalid-pending" });
    expect(parseOAuthPendingState("record", isProxy)).toEqual({ ok: false, reason: "invalid-pending" });
    expect(parseOAuthPendingState([pendingRecord()], isProxy)).toEqual({
      ok: false,
      reason: "invalid-pending",
    });
    expect(parseOAuthPendingState(sparse, isProxy)).toEqual({ ok: false, reason: "invalid-pending" });
    expect(parseOAuthPendingState(arrayLike, isProxy)).toEqual({ ok: false, reason: "invalid-pending" });
    expect(parseOAuthPendingState("x".repeat(10_000), isProxy)).toEqual({
      ok: false,
      reason: "invalid-pending",
    });
  });

  it("refuses a getter field without ever running the getter", () => {
    const hostile = getterObject(pendingRecord() as unknown as Record<string, unknown>, [
      "stateDigest",
      "organizationId",
      "issuedAtIso",
      "expiresAtIso",
      "consumed",
    ]);
    expect(parseOAuthPendingState(hostile, isProxy)).toEqual({ ok: false, reason: "invalid-pending" });
  });

  it("refuses missing, extra, symbol and prototype-polluting own keys", () => {
    const missing = {
      stateDigest: DIGEST,
      organizationId: "org-1",
      issuedAtIso: ISSUED,
      expiresAtIso: EXPIRES,
    };
    expect(parseOAuthPendingState(missing, isProxy)).toEqual({ ok: false, reason: "invalid-pending" });
    expect(parseOAuthPendingState({ ...pendingRecord(), extra: 1 }, isProxy)).toEqual({
      ok: false,
      reason: "invalid-pending",
    });
    for (const polluting of ["__proto__", "constructor", "prototype"]) {
      const record = { ...pendingRecord(), [polluting]: "x" };
      expect(parseOAuthPendingState(record, isProxy)).toEqual({
        ok: false,
        reason: "invalid-pending",
      });
    }
    const symbolKey = Symbol("key");
    expect(
      parseOAuthPendingState({ ...pendingRecord(), [symbolKey]: 1 } as never, isProxy),
    ).toEqual({ ok: false, reason: "invalid-pending" });
  });

  it("refuses an invalid stateDigest, organizationId, timestamps, lifetime or consumed flag", () => {
    expect(parseOAuthPendingState(pendingRecord({ stateDigest: "a".repeat(63) }), isProxy)).toEqual({
      ok: false,
      reason: "invalid-pending",
    });
    expect(parseOAuthPendingState(pendingRecord({ stateDigest: "A".repeat(64) }), isProxy)).toEqual({
      ok: false,
      reason: "invalid-pending",
    });
    expect(parseOAuthPendingState(pendingRecord({ organizationId: "ORG" }), isProxy)).toEqual({
      ok: false,
      reason: "invalid-pending",
    });
    expect(parseOAuthPendingState(pendingRecord({ organizationId: "o".repeat(64) }), isProxy)).toEqual({
      ok: false,
      reason: "invalid-pending",
    });
    expect(parseOAuthPendingState(pendingRecord({ issuedAtIso: "not-a-date" }), isProxy)).toEqual({
      ok: false,
      reason: "invalid-pending",
    });
    expect(parseOAuthPendingState(pendingRecord({ expiresAtIso: "2026-13-40T12:00:00Z" }), isProxy)).toEqual({
      ok: false,
      reason: "invalid-pending",
    });
    // Lifetime zero or negative: expiry at or before issuance.
    expect(
      parseOAuthPendingState(pendingRecord({ expiresAtIso: ISSUED }), isProxy),
    ).toEqual({ ok: false, reason: "invalid-pending" });
    // Lifetime above the 10-minute bound.
    expect(
      parseOAuthPendingState(
        pendingRecord({ expiresAtIso: "2026-11-26T12:10:00.001Z" }),
        isProxy,
      ),
    ).toEqual({ ok: false, reason: "invalid-pending" });
    expect(parseOAuthPendingState(pendingRecord({ consumed: "no" } as never), isProxy)).toEqual({
      ok: false,
      reason: "invalid-pending",
    });
  });

  it("accepts a record whose lifetime is exactly the 10-minute bound at millisecond precision", () => {
    expect(parseOAuthPendingState(pendingRecord(), isProxy).ok).toBe(true);
    expect(OAUTH_PENDING_STATE_MAX_TTL_MS).toBe(10 * 60 * 1000);
    expect(OAUTH_STATE_DIGEST_LENGTH).toBe(64);
  });

  it("refuses a lifetime that only exceeds the bound through sub-millisecond precision", () => {
    // Truncated to milliseconds the lifetime is exactly the bound, but the
    // true lifetime is one microsecond longer.
    const record = pendingRecord({
      issuedAtIso: "2026-11-26T12:00:00.000000Z",
      expiresAtIso: "2026-11-26T12:10:00.000001Z",
    });
    expect(parseOAuthPendingState(record, isProxy)).toEqual({ ok: false, reason: "invalid-pending" });
  });

  it("is a constant-refusal implementation under an identity detector mismatch: bad input still refuses", () => {
    // A detector that calls everything a Proxy must not turn bad data valid.
    const neverProxy: IsProxy = () => false;
    expect(parseOAuthPendingState(null, neverProxy)).toEqual({ ok: false, reason: "invalid-pending" });
  });
});

describe("decideOAuthCallback", () => {
  it("accepts a valid callback at the issued instant and inside the window", () => {
    expect(decideOAuthCallback(callbackInput({ nowIso: ISSUED }), isProxy)).toEqual({
      outcome: "accepted",
      organizationId: "org-1",
    });
    expect(decideOAuthCallback(callbackInput(), isProxy)).toEqual({
      outcome: "accepted",
      organizationId: "org-1",
    });
  });

  it("refuses a callback a sub-millisecond before issuance as expired", () => {
    // Date.parse truncates both instants to the same millisecond; the
    // decision must still refuse because now < issued at full precision.
    const input = callbackInput({
      nowIso: "2026-11-26T12:00:00.0000001Z",
      pending: pendingRecord({ issuedAtIso: "2026-11-26T12:00:00.0000009Z" }),
    });
    expect(decideOAuthCallback(input, isProxy)).toEqual({ outcome: "refused", reason: "expired" });
  });

  it("accepts a callback a sub-millisecond after issuance inside the same millisecond", () => {
    const input = callbackInput({
      nowIso: "2026-11-26T12:00:00.0000009Z",
      pending: pendingRecord({
        issuedAtIso: "2026-11-26T12:00:00.0000001Z",
        expiresAtIso: "2026-11-26T12:10:00.0000001Z",
      }),
    });
    expect(decideOAuthCallback(input, isProxy)).toEqual({
      outcome: "accepted",
      organizationId: "org-1",
    });
  });

  it("refuses at the expiry boundary instant and after as expired", () => {
    expect(decideOAuthCallback(callbackInput({ nowIso: EXPIRES }), isProxy)).toEqual({
      outcome: "refused",
      reason: "expired",
    });
    expect(decideOAuthCallback(callbackInput({ nowIso: "2026-11-26T12:10:00.000001Z" }), isProxy)).toEqual({
      outcome: "refused",
      reason: "expired",
    });
    expect(decideOAuthCallback(callbackInput({ nowIso: "2020-01-01T00:00:00Z" }), isProxy)).toEqual({
      outcome: "refused",
      reason: "expired",
    });
  });

  it("refuses each input-field fault as invalid-input", () => {
    const refusals: Array<Record<string, unknown>> = [
      callbackInput({ nowIso: "not-a-date" }),
      callbackInput({ nowIso: "2026-13-40T12:00:00Z" }),
      callbackInput({ callbackStateDigest: "a".repeat(63) }),
      callbackInput({ callbackStateDigest: "A".repeat(64) }),
      callbackInput({ callbackStateDigest: 42 } as never),
      callbackInput({ providerError: 42 } as never),
      callbackInput({ providerError: undefined as never }),
      callbackInput({ providerError: {} as never }),
      callbackInput({ providerError: "x".repeat(4097) }),
      callbackInput({ hasCode: "yes" as never }),
    ];
    for (const input of refusals) {
      expect(decideOAuthCallback(input as never, isProxy)).toEqual({
        outcome: "refused",
        reason: "invalid-input",
      });
    }
  });

  it("refuses a missing detector: without one a Proxy is indistinguishable from plain data", () => {
    expect(decideOAuthCallback(callbackInput())).toEqual({
      outcome: "refused",
      reason: "invalid-input",
    });
    const target = callbackInput() as unknown as Record<string, unknown>;
    expect(decideOAuthCallback(honestProxy(target))).toEqual({
      outcome: "refused",
      reason: "invalid-input",
    });
    expect(decideOAuthCallback(callbackInput(), 42 as never)).toEqual({
      outcome: "refused",
      reason: "invalid-input",
    });
  });

  it("refuses hostile outer shapes as invalid-input without throwing", () => {
    const sparse: unknown[] = [callbackInput()];
    delete sparse[0];
    const inputs: unknown[] = [
      null,
      undefined,
      42,
      "input",
      [callbackInput()],
      sparse,
      { length: 5 },
      throwingProxy(),
      honestProxy({ pending: pendingRecord(), callbackStateDigest: DIGEST }),
      getterObject(callbackInput() as unknown as Record<string, unknown>, ["pending", "hasCode"]),
      { ...callbackInput(), extra: true },
      { ...callbackInput(), __proto__: { evil: true } },
      { ...callbackInput(), constructor: "x" },
      { ...callbackInput(), prototype: "x" },
      { ...callbackInput(), pending: undefined },
      { ...callbackInput(), nowIso: undefined },
    ];
    for (const input of inputs) {
      const decision = decideOAuthCallback(input as never, isProxy);
      expect(decision.outcome).toBe("refused");
      if (input !== null && input !== undefined) {
        // Only a missing/invalid pending may be invalid-pending; every other
        // hostile outer shape is invalid-input. The two proxy/getter cases
        // with an intact pending field are invalid-input as well.
        const reason = decision.outcome === "refused" ? decision.reason : "accepted";
        expect(["invalid-input", "invalid-pending"]).toContain(reason);
      }
    }
  });

  it("refuses hostile pending shapes as invalid-pending", () => {
    const pendings: unknown[] = [
      null,
      undefined,
      42,
      "pending",
      [pendingRecord()],
      { length: 5 },
      throwingProxy(),
      honestProxy(pendingRecord() as unknown as Record<string, unknown>),
      getterObject(pendingRecord() as unknown as Record<string, unknown>, ["stateDigest"]),
      { ...pendingRecord(), extra: 1 },
      { stateDigest: DIGEST, organizationId: "org-1", issuedAtIso: ISSUED, expiresAtIso: EXPIRES },
      { ...pendingRecord(), __proto__: { evil: true } },
      { ...pendingRecord(), consumed: "yes" } as unknown as PendingRecord,
      { ...pendingRecord(), issuedAtIso: "nope" },
    ];
    for (const pending of pendings) {
      expect(decideOAuthCallback(callbackInput({ pending: pending as never }), isProxy)).toEqual({
        outcome: "refused",
        reason: "invalid-pending",
      });
    }
    // A missing pending key is invalid-pending, not invalid-input.
    const withoutPending = {
      callbackStateDigest: DIGEST,
      providerError: null,
      hasCode: true,
      nowIso: NOW,
    };
    expect(decideOAuthCallback(withoutPending, isProxy)).toEqual({
      outcome: "refused",
      reason: "invalid-pending",
    });
  });

  it("refuses a consumed pending state as already-consumed before expiry or digest checks", () => {
    const replay = callbackInput({ pending: pendingRecord({ consumed: true }) });
    expect(decideOAuthCallback(replay, isProxy)).toEqual({
      outcome: "refused",
      reason: "already-consumed",
    });
    // A consumed state with a wrong digest and an expired window still
    // refuses as already-consumed: it never reveals whether the digest matched.
    const leaked = callbackInput({
      pending: pendingRecord({ consumed: true }),
      callbackStateDigest: OTHER_DIGEST,
      nowIso: "2030-01-01T00:00:00Z",
    });
    expect(decideOAuthCallback(leaked, isProxy)).toEqual({
      outcome: "refused",
      reason: "already-consumed",
    });
  });

  it("refuses a digest mismatch as state-mismatch with neither digest echoed", () => {
    const decision = decideOAuthCallback(callbackInput({ callbackStateDigest: OTHER_DIGEST }), isProxy);
    expect(decision).toEqual({ outcome: "refused", reason: "state-mismatch" });
    expect(JSON.stringify(decision)).not.toContain(OTHER_DIGEST);
    expect(JSON.stringify(decision)).not.toContain(DIGEST);
  });

  it("refuses a provider error as provider-denied and never echoes its text", () => {
    for (const providerError of [true, "provider exploded", "S"]) {
      const decision = decideOAuthCallback(callbackInput({ providerError }), isProxy);
      expect(decision).toEqual({ outcome: "refused", reason: "provider-denied" });
      if (typeof providerError === "string") {
        expect(JSON.stringify(decision)).not.toContain(providerError);
      }
    }
  });

  it("accepts null, false and an empty string providerError with hasCode true", () => {
    for (const providerError of [null, false, ""]) {
      expect(decideOAuthCallback(callbackInput({ providerError }), isProxy)).toEqual({
        outcome: "accepted",
        organizationId: "org-1",
      });
    }
  });

  it("refuses hasCode false as missing-code", () => {
    expect(decideOAuthCallback(callbackInput({ hasCode: false }), isProxy)).toEqual({
      outcome: "refused",
      reason: "missing-code",
    });
  });

  it("enforces the fixed refusal ordering with two simultaneous faults", () => {
    const consumedPending = pendingRecord({ consumed: true });
    const badPending = { ...pendingRecord(), consumed: "no" };
    const cases: Array<[Record<string, unknown>, string]> = [
      // invalid-pending beats already-consumed and expired.
      [
        callbackInput({ pending: badPending as never, nowIso: "2030-01-01T00:00:00Z" }),
        "invalid-pending",
      ],
      // already-consumed beats expired and state-mismatch.
      [
        callbackInput({
          pending: consumedPending,
          callbackStateDigest: OTHER_DIGEST,
          nowIso: "2030-01-01T00:00:00Z",
        }),
        "already-consumed",
      ],
      // expired beats state-mismatch.
      [
        callbackInput({ callbackStateDigest: OTHER_DIGEST, nowIso: "2030-01-01T00:00:00Z" }),
        "expired",
      ],
      // state-mismatch beats provider-denied.
      [
        callbackInput({ callbackStateDigest: OTHER_DIGEST, providerError: "boom" }),
        "state-mismatch",
      ],
      // provider-denied beats missing-code.
      [callbackInput({ providerError: "boom", hasCode: false }), "provider-denied"],
    ];
    for (const [input, reason] of cases) {
      expect(decideOAuthCallback(input as never, isProxy)).toEqual({
        outcome: "refused",
        reason,
      });
    }
  });

  it("never echoes the state digest, callback digest or provider error text in any refusal", () => {
    const samples: Array<Record<string, unknown>> = [
      callbackInput({ callbackStateDigest: OTHER_DIGEST }),
      callbackInput({ providerError: "the-provider-said-no" }),
      callbackInput({ pending: pendingRecord({ consumed: true }) }),
      callbackInput({ nowIso: "2030-01-01T00:00:00Z" }),
      callbackInput({ hasCode: false }),
      callbackInput({ pending: { ...pendingRecord(), stateDigest: 1 } as unknown as PendingRecord }),
    ];
    for (const sample of samples) {
      const decision = decideOAuthCallback(sample as never, isProxy);
      expect(decision.outcome).toBe("refused");
      const text = JSON.stringify(decision);
      expect(text).not.toContain(DIGEST);
      expect(text).not.toContain(OTHER_DIGEST);
      expect(text).not.toContain("the-provider-said-no");
    }
  });
});
