import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ACTOR_PATTERN,
  MAX_SIGN_IN_ATTEMPTS,
  SECRET_DIGEST_LENGTH,
  SIGN_IN_LINK_MAX_TTL_MS,
  decideSignInLinkIssue,
  decideSignInLinkRedemption,
  type SignInLinkRecord,
} from "../sign-in-link.js";

const SOURCE = readFileSync(new URL("../sign-in-link.ts", import.meta.url), "utf8");

const NOW = "2026-11-26T12:00:00.000Z";
const LATER = "2026-11-26T12:10:00.000Z";

type IssueInput = Parameters<typeof decideSignInLinkIssue>[0];

const issueInput = (overrides: Record<string, unknown> = {}): IssueInput =>
  ({
    linkId: "link-0001",
    actor: "operator@example.com",
    secretDigest: "a".repeat(64),
    nowIso: NOW,
    ...overrides,
  }) as IssueInput;

function issuedRecord(): SignInLinkRecord {
  const result = decideSignInLinkIssue(issueInput());
  if (result.outcome !== "issued") {
    throw new Error("expected issued");
  }
  return result.record;
}

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

/** A plain object whose `actor` field is a getter that throws when run. */
function getterRecord(base: SignInLinkRecord): object {
  return Object.defineProperty({ ...base }, "actor", {
    get() {
      throw new Error("getter must never run");
    },
    enumerable: true,
  });
}

describe("sign-in-link module purity", () => {
  it("contains no clock, randomness, crypto or process access anywhere in the source", () => {
    expect(SOURCE).not.toMatch(/Date\.now/);
    expect(SOURCE).not.toMatch(/new Date\(\s*\)/);
    expect(SOURCE).not.toMatch(/Math\.random/);
    expect(SOURCE).not.toMatch(/\bcrypto\b/);
    expect(SOURCE).not.toMatch(/\bprocess\b/);
  });

  it("never echoes either digest in any refusal result", () => {
    const stored = "b".repeat(64);
    const wrong = "a".repeat(63) + "c";
    const record = decideSignInLinkIssue(
      issueInput({ secretDigest: stored }),
    );
    if (record.outcome !== "issued") {
      throw new Error("expected issued");
    }
    const results = [
      decideSignInLinkRedemption(record.record, wrong, NOW),
      decideSignInLinkRedemption(record.record, wrong, "2026-11-26T20:00:00.000Z"),
      decideSignInLinkRedemption(record.record, { length: 10000 }, NOW),
      decideSignInLinkRedemption(null, wrong, NOW),
      decideSignInLinkIssue(issueInput({ secretDigest: 42 })),
      decideSignInLinkIssue(throwingProxy() as never),
    ];
    for (const result of results) {
      expect(result.outcome).toBe("refused");
      // Neither the presented (wrong) digest nor the stored one is ever
      // echoed anywhere in a refusal.
      expect(JSON.stringify(result)).not.toContain(wrong);
      expect(JSON.stringify(result)).not.toContain(stored);
    }
  });
});

describe("ACTOR_PATTERN", () => {
  it("matches the actor rule copied from session-exchange.ts: 1..128 chars of [A-Za-z0-9._@-]", () => {
    expect(ACTOR_PATTERN.source).toBe("^[A-Za-z0-9._@-]{1,128}$");
    expect(ACTOR_PATTERN.test("operator@example.com")).toBe(true);
    expect(ACTOR_PATTERN.test("")).toBe(false);
    expect(ACTOR_PATTERN.test("a".repeat(129))).toBe(false);
    expect(ACTOR_PATTERN.test("bad actor")).toBe(false);
  });
});

describe("decideSignInLinkIssue", () => {
  it("issues with the default 15-minute TTL when ttlMs is absent", () => {
    const result = decideSignInLinkIssue(issueInput());
    expect(result.outcome).toBe("issued");
    if (result.outcome !== "issued") throw new Error("unreachable");
    expect(result.record.issuedAtIso).toBe(NOW);
    const expected = new Date(Date.parse(NOW) + SIGN_IN_LINK_MAX_TTL_MS).toISOString();
    expect(result.record.expiresAtIso).toBe(expected);
    expect(result.record.redeemedAtIso).toBeNull();
    expect(result.record.failedAttempts).toBe(0);
  });

  it("issues with an explicit in-range ttlMs and computes expiresAtIso from it", () => {
    const result = decideSignInLinkIssue(issueInput({ ttlMs: 60_000 }));
    expect(result.outcome).toBe("issued");
    if (result.outcome !== "issued") throw new Error("unreachable");
    expect(result.record.expiresAtIso).toBe(new Date(Date.parse(NOW) + 60_000).toISOString());
  });

  it("refuses an issue whose expiry would roll past the four-digit year as invalid-input", () => {
    // 23:45 + 15 minutes lands in year 10000, where `toISOString()` emits an
    // extended year this module would itself reject.
    expect(
      decideSignInLinkIssue(issueInput({ nowIso: "9999-12-31T23:45:00.000Z" })),
    ).toEqual({ outcome: "refused", reason: "invalid-input" });
    // An issue whose expiry stays inside year 9999 is still fine.
    const ok = decideSignInLinkIssue(issueInput({ nowIso: "9999-12-31T23:00:00.000Z" }));
    expect(ok.outcome).toBe("issued");
    if (ok.outcome !== "issued") throw new Error("unreachable");
    expect(ok.record.expiresAtIso).toBe("9999-12-31T23:15:00.000Z");
  });

  it("refuses ttlMs out of range (0, negative, non-integer, over 15 minutes) as invalid-input", () => {
    for (const ttlMs of [0, -1, 1.5, SIGN_IN_LINK_MAX_TTL_MS + 1, "60000", NaN]) {
      const result = decideSignInLinkIssue(issueInput({ ttlMs }));
      expect(result).toEqual({ outcome: "refused", reason: "invalid-input" });
    }
  });

  it("refuses an invalid nowIso (non-ISO string, invalid calendar date, wrong tz) as invalid-input", () => {
    for (const nowIso of ["not-a-date", "2026-02-31T12:00:00.000Z", "2026-11-26T12:00:00+01:00", 42, null]) {
      const result = decideSignInLinkIssue(issueInput({ nowIso }));
      expect(result).toEqual({ outcome: "refused", reason: "invalid-input" });
    }
  });
});

describe("decideSignInLinkRedemption", () => {
  it("redeems at issuedAtIso, inside the window, and before expiresAtIso, stamping redeemedAtIso", () => {
    const record = issuedRecord();
    for (const nowIso of [record.issuedAtIso, LATER]) {
      const result = decideSignInLinkRedemption(record, "a".repeat(64), nowIso);
      expect(result.outcome).toBe("redeemed");
      if (result.outcome !== "redeemed") throw new Error("unreachable");
      expect(result.record.redeemedAtIso).toBe(nowIso);
      expect(result.record.failedAttempts).toBe(0);
    }
  });

  it("refuses redemption at and after expiresAtIso and before issuedAtIso as expired", () => {
    const record = issuedRecord();
    for (const nowIso of ["2026-11-26T11:59:59.999Z", record.expiresAtIso, "2026-11-26T13:00:00.000Z"]) {
      const result = decideSignInLinkRedemption(record, "a".repeat(64), nowIso);
      expect(result).toEqual({ outcome: "refused", reason: "expired" });
    }
  });

  it("refuses a mismatched digest with incremented failedAttempts without echoing digests", () => {
    const record = issuedRecord();
    const wrong = "0".repeat(63) + "1";
    const result = decideSignInLinkRedemption(record, wrong, NOW);
    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused" || result.reason !== "mismatch") throw new Error("unreachable");
    expect(result.record?.failedAttempts).toBe(1);
    expect("secretDigest" in (result.record as object)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(wrong);
    expect(JSON.stringify(result)).not.toContain(record.secretDigest);
  });

  it("refuses second redemption after success as already-redeemed even with matching digest", () => {
    const record = issuedRecord();
    const first = decideSignInLinkRedemption(record, "a".repeat(64), NOW);
    expect(first.outcome).toBe("redeemed");
    const result = decideSignInLinkRedemption(
      first.outcome === "redeemed" ? first.record : record,
      "a".repeat(64),
      LATER,
    );
    expect(result).toEqual({ outcome: "refused", reason: "already-redeemed" });
  });

  it("refuses an already-redeemed record whose redeemedAtIso is a plain ISO string, even with a matching digest", () => {
    const record = { ...issuedRecord(), redeemedAtIso: LATER };
    const result = decideSignInLinkRedemption(record, "a".repeat(64), NOW);
    expect(result).toEqual({ outcome: "refused", reason: "already-redeemed" });
  });

  it("refuses redemption after 5 failed attempts even with matching digest", () => {
    const record = { ...issuedRecord(), failedAttempts: MAX_SIGN_IN_ATTEMPTS };
    const result = decideSignInLinkRedemption(record, "a".repeat(64), NOW);
    expect(result).toEqual({ outcome: "refused", reason: "too-many-attempts" });
    const still = decideSignInLinkRedemption({ ...record, failedAttempts: 4 }, "b".repeat(64), NOW);
    expect(still).toMatchObject({ outcome: "refused", reason: "mismatch" });
  });

  it("refuses malformed or oversized digest as invalid-input before any comparison", () => {
    const record = issuedRecord();
    const before = { ...record, failedAttempts: 0, redeemedAtIso: null };
    for (const digest of [null, undefined, 42, "a".repeat(10000), "a".repeat(63), "A".repeat(64), "g".repeat(64)]) {
      const result = decideSignInLinkRedemption(before, digest, NOW);
      expect(result).toEqual({ outcome: "refused", reason: "invalid-input" });
    }
  });

  it("refuses invalid actor or linkId at issue and redemption", () => {
    for (const bad of ["", "a".repeat(129), "bad actor", "a/b", 42, null]) {
      expect(decideSignInLinkIssue(issueInput({ actor: bad }))).toEqual({
        outcome: "refused",
        reason: "invalid-input",
      });
      expect(decideSignInLinkIssue(issueInput({ linkId: bad }))).toEqual({
        outcome: "refused",
        reason: "invalid-input",
      });
      expect(
        decideSignInLinkRedemption({ ...issuedRecord(), actor: bad }, "a".repeat(64), NOW),
      ).toMatchObject({ outcome: "refused", reason: "invalid-input" });
      expect(
        decideSignInLinkRedemption({ ...issuedRecord(), linkId: bad }, "a".repeat(64), NOW),
      ).toMatchObject({ outcome: "refused", reason: "invalid-input" });
    }
  });

  it("refuses non-integer, negative, NaN, and infinite failedAttempts", () => {
    for (const failedAttempts of [-1, 1.5, NaN, Infinity, -Infinity, "2", null]) {
      const result = decideSignInLinkRedemption({ ...issuedRecord(), failedAttempts }, "a".repeat(64), NOW);
      expect(result).toEqual({ outcome: "refused", reason: "invalid-input" });
    }
  });

  it("refuses unparseable timestamps, invalid redeemedAtIso, and lifetimes outside 15 minutes", () => {
    for (const record of [
      { ...issuedRecord(), issuedAtIso: "garbage" },
      { ...issuedRecord(), expiresAtIso: "2026-02-31T12:00:00.000Z" },
      { ...issuedRecord(), redeemedAtIso: 0 },
      { ...issuedRecord(), redeemedAtIso: "" },
      { ...issuedRecord(), redeemedAtIso: "not-a-date" },
    ]) {
      expect(decideSignInLinkRedemption(record, "a".repeat(64), NOW)).toEqual({
        outcome: "refused",
        reason: "invalid-input",
      });
    }
    // A lifetime over the 15-minute maximum is refused even if parseable.
    const long = {
      linkId: "link-0001",
      actor: "actor-1",
      secretDigest: "a".repeat(64),
      issuedAtIso: NOW,
      expiresAtIso: new Date(Date.parse(NOW) + SIGN_IN_LINK_MAX_TTL_MS + 1).toISOString(),
      redeemedAtIso: null,
      failedAttempts: 0,
    };
    expect(decideSignInLinkRedemption(long, "a".repeat(64), LATER)).toEqual({
      outcome: "refused",
      reason: "invalid-input",
    });
    // A non-positive lifetime (expires before issuance) is refused too.
    const backwards = { ...long, expiresAtIso: NOW };
    expect(decideSignInLinkRedemption(backwards, "a".repeat(64), NOW)).toEqual({
      outcome: "refused",
      reason: "invalid-input",
    });
  });

  it("refuses hostile record and issue input shapes without invoking getters", () => {
    const base = issuedRecord();
    const hostileRecords: unknown[] = [
      null,
      undefined,
      42,
      "record",
      [base],
      { ...base, length: 7 },
      getterRecord(base),
      throwingProxy(),
      Object.defineProperty({ ...base }, "__proto__", { value: null, enumerable: true }),
      Object.defineProperty({ ...base }, "constructor", { value: 1, enumerable: true }),
      Object.defineProperty({ ...base }, "prototype", { value: 1, enumerable: true }),
      { ...base, secretDigest: undefined },
    ];
    for (const hostile of hostileRecords) {
      const result = decideSignInLinkRedemption(hostile, "a".repeat(64), NOW);
      expect(result).toEqual({ outcome: "refused", reason: "invalid-input" });
    }
    const hostileInputs: unknown[] = [
      null,
      "input",
      [issueInput()],
      Object.defineProperty({ ...issueInput() }, "actor", {
        get() {
          throw new Error("getter must never run");
        },
        enumerable: true,
      }),
      throwingProxy(),
      Object.defineProperty({ ...issueInput() }, "__proto__", { value: null, enumerable: true }),
    ];
    for (const hostile of hostileInputs) {
      const result = decideSignInLinkIssue(hostile as never);
      expect(result).toEqual({ outcome: "refused", reason: "invalid-input" });
    }
  });

  it("keeps the digest comparison at a fixed 64-iteration constant-time shape", () => {
    expect(SOURCE).toMatch(/for \(let i = 0; i < SECRET_DIGEST_LENGTH; i \+= 1\)/);
    expect(SOURCE).not.toMatch(/secretDigest ===/);
    expect(SOURCE).not.toMatch(/presentedDigest ===/);
    expect(SOURCE).not.toMatch(/secretDigest !==/);
    expect(SOURCE).not.toMatch(/presentedDigest !==/);
    expect(SECRET_DIGEST_LENGTH).toBe(64);
  });

  it("snapshots records without enumerating own properties, keeping the cost fixed", () => {
    // The snapshot must never enumerate the input's own properties: that
    // would make its cost grow with the property count instead of staying at
    // the required fixed-field O(1) bound.
    expect(SOURCE).not.toMatch(/getOwnPropertyNames/);
    expect(SOURCE).not.toMatch(/Reflect\.ownKeys/);
    expect(SOURCE).not.toMatch(/Object\.keys/);
    // Hostile names are screened directly, without enumeration.
    expect(SOURCE).toMatch(/for \(const key of FORBIDDEN_KEYS\)/);
    // An object carrying many extra benign own properties is still processed
    // by reading only the fixed field set.
    const noisy: Record<string, unknown> = { ...issuedRecord() };
    for (let i = 0; i < 5000; i += 1) {
      noisy[`extra-${i}`] = i;
    }
    const result = decideSignInLinkRedemption(noisy, "a".repeat(64), NOW);
    expect(result.outcome).toBe("redeemed");
  });
});
