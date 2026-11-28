/**
 * Tests for the pure fixed-window rate-limit decider. No network, no clock,
 * no randomness: every instant is a literal ISO-8601 string.
 */

import { readFileSync } from "node:fs";

import { isProxy } from "node:util/types";

import { describe, expect, it } from "vitest";

import {
  MAX_RATE_LIMIT,
  RATE_LIMIT_BUCKETS,
  decideRateLimit,
  type RateLimitDecision,
  type RateLimitRefusalReason,
} from "../rate-limit.js";

const SOURCE = readFileSync(new URL("../rate-limit.ts", import.meta.url), "utf8");

/**
 * The trusted runtime detector the infrastructure caller injects; every
 * decision call in these tests supplies it explicitly, because the decider
 * refuses an omitted detector rather than defaulting to a detector that
 * detects nothing.
 */
const decide = (input: unknown, detector?: unknown): RateLimitDecision =>
  decideRateLimit(input, (detector ?? isProxy) as never);

const ORG = "org-alpha";
const START = "2026-11-26T12:00:00.000Z";
const LENGTH_MS = 60_000;
const IN_WINDOW = "2026-11-26T12:00:30.000Z";
const NEXT_WINDOW = "2026-11-26T12:01:00.000Z";
const FAR_LATER = "2026-11-26T13:00:00.000Z";

const baseInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  organizationId: ORG,
  bucket: "api",
  window: { startIso: START, lengthMs: LENGTH_MS },
  limit: 5,
  count: 0,
  nowIso: IN_WINDOW,
  ...overrides,
});

function refusedReason(result: RateLimitDecision): RateLimitRefusalReason {
  if (result.outcome !== "refused") {
    throw new Error("expected refused");
  }
  return result.reason;
}

/** A Proxy whose every trap throws: the decider must never invoke it. */
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

/** A plain object whose `limit` field is a getter that throws when run. */
function getterInput(base: Record<string, unknown>): object {
  return Object.defineProperty({ ...base }, "limit", {
    get() {
      throw new Error("getter must never run");
    },
    enumerable: true,
  });
}

describe("rate-limit module purity", () => {
  it("contains no clock, randomness, crypto, or process access in rate-limit.ts", () => {
    expect(SOURCE).not.toMatch(/Date\.now/);
    expect(SOURCE).not.toMatch(/new Date\(\s*\)/);
    expect(SOURCE).not.toMatch(/Math\.random/);
    expect(SOURCE).not.toMatch(/\bcrypto\b/);
    expect(SOURCE).not.toMatch(/\bprocess\b/);
  });
});

describe("decideRateLimit allowed path", () => {
  it("allows requests under the limit and increments count", () => {
    const result = decide(baseInput({ count: 2, limit: 5 }));
    expect(result).toEqual({
      outcome: "allowed",
      count: 3,
      window: { startIso: START, lengthMs: LENGTH_MS },
    });
  });

  it("allows the limit-th request when count equals limit - 1", () => {
    const result = decide(baseInput({ count: 4, limit: 5 }));
    expect(result).toEqual({
      outcome: "allowed",
      count: 5,
      window: { startIso: START, lengthMs: LENGTH_MS },
    });
  });

  it("rolls over to count 1 in an aligned window when nowIso is exactly at start + length", () => {
    const result = decide(baseInput({ count: 5, limit: 5, nowIso: NEXT_WINDOW }));
    expect(result).toEqual({
      outcome: "allowed",
      count: 1,
      window: { startIso: NEXT_WINDOW, lengthMs: LENGTH_MS },
    });
  });

  it("rolls over across a long idle gap to the floor-aligned window boundary", () => {
    // START + 3600s = 60 windows of 60s each: the aligned window starts
    // exactly at 13:00:00.000Z even though nowIso lands mid-window.
    const result = decide(
      baseInput({ count: 5, limit: 5, nowIso: "2026-11-26T13:00:10.000Z" }),
    );
    expect(result).toEqual({
      outcome: "allowed",
      count: 1,
      window: { startIso: FAR_LATER, lengthMs: LENGTH_MS },
    });
  });

  it("keeps decisions for different organizations independent", () => {
    const a = decide(baseInput({ organizationId: "org-one", count: 5, limit: 5 }));
    const b = decide(baseInput({ organizationId: "org-two", count: 5, limit: 5 }));
    expect(refusedReason(a)).toBe("rate-limited");
    expect(refusedReason(b)).toBe("rate-limited");
    if (
      a.outcome !== "refused" ||
      a.reason !== "rate-limited" ||
      b.outcome !== "refused" ||
      b.reason !== "rate-limited"
    ) {
      throw new Error("unreachable");
    }
    expect(a.auditRow.organizationId).toBe("org-one");
    expect(b.auditRow.organizationId).toBe("org-two");
    expect(a.auditRow).not.toEqual(b.auditRow);
    const fresh = decide(baseInput({ organizationId: "org-one", count: 0, limit: 5 }));
    expect(fresh.outcome).toBe("allowed");
  });

  it("supports both api and webhook buckets", () => {
    for (const bucket of RATE_LIMIT_BUCKETS) {
      const result = decide(baseInput({ bucket, count: 0, limit: 1 }));
      expect(result).toEqual({
        outcome: "allowed",
        count: 1,
        window: { startIso: START, lengthMs: LENGTH_MS },
      });
      const blocked = decide(baseInput({ bucket, count: 1, limit: 1 }));
      expect(refusedReason(blocked)).toBe("rate-limited");
    }
  });
});

describe("decideRateLimit refusals", () => {
  it("refuses over-limit requests with rate-limited, exact retryAfterMs, and auditRow", () => {
    const result = decide(baseInput({ count: 5, limit: 5, nowIso: IN_WINDOW }));
    expect(result).toEqual({
      outcome: "refused",
      reason: "rate-limited",
      retryAfterMs: 30_000,
      auditRow: { organizationId: ORG, bucket: "api", atIso: IN_WINDOW, limit: 5 },
    });
  });

  it("computes retryAfterMs as remaining milliseconds until the active window end", () => {
    const now = "2026-11-26T12:00:59.250Z";
    const result = decide(baseInput({ count: 9, limit: 5, nowIso: now }));
    if (result.outcome !== "refused" || result.reason !== "rate-limited") {
      throw new Error("expected rate-limited");
    }
    expect(result.retryAfterMs).toBe(750);
  });

  it("refuses when limit is 0 with rate-limited and auditRow", () => {
    const result = decide(baseInput({ count: 0, limit: 0 }));
    expect(result).toEqual({
      outcome: "refused",
      reason: "rate-limited",
      retryAfterMs: 30_000,
      auditRow: { organizationId: ORG, bucket: "api", atIso: IN_WINDOW, limit: 0 },
    });
  });

  it("refuses in-window count above limit with rate-limited and retryAfterMs, and resets on rollover", () => {
    // A limit reduction leaves count above the new limit mid-window.
    const reduced = decide(baseInput({ count: 9, limit: 5, nowIso: IN_WINDOW }));
    expect(refusedReason(reduced)).toBe("rate-limited");
    if (reduced.outcome !== "refused" || reduced.reason !== "rate-limited") {
      throw new Error("unreachable");
    }
    expect(reduced.retryAfterMs).toBe(30_000);
    expect(reduced.auditRow.limit).toBe(5);
    // At rollover the carried count resets, so the request is allowed again
    // (limit > 0 here).
    const rolled = decide(baseInput({ count: 9, limit: 5, nowIso: NEXT_WINDOW }));
    expect(rolled).toEqual({
      outcome: "allowed",
      count: 1,
      window: { startIso: NEXT_WINDOW, lengthMs: LENGTH_MS },
    });
  });

  it("refuses a non-function isProxy detector with invalid-input", () => {
    const result = decide(baseInput(), 42 as never);
    expect(result).toEqual({ outcome: "refused", reason: "invalid-input" });
  });

  it("refuses an omitted isProxy detector with invalid-input", () => {
    // No always-false fallback: without a trusted detector a transparent
    // Proxy could pass the snapshot, so omission is refused outright.
    expect(decideRateLimit(baseInput())).toEqual({
      outcome: "refused",
      reason: "invalid-input",
    });
  });

  it("refuses a transparent Proxy as valid-looking input through the injected detector", () => {
    // With the real runtime detector a transparent Proxy over valid data
    // must still be refused by snapshotPlainData, never snapshotted.
    const transparent = new Proxy(baseInput(), {});
    expect(decide(transparent)).toEqual({ outcome: "refused", reason: "invalid-input" });
  });

  it("refuses hostile outer input shapes (null, undefined, primitives, arrays, holes, array-like, getter, Proxy, prototype-polluting keys) without invoking getters", () => {
    const sparse = new Array(3);
    sparse[1] = baseInput();
    const inputs: unknown[] = [
      null,
      undefined,
      42,
      "text",
      true,
      [],
      sparse,
      { length: 10000 },
      throwingProxy(),
      getterInput(baseInput()),
      Object.defineProperty({}, "__proto__", { value: null, enumerable: true }),
    ];
    const withExtraKey = baseInput();
    withExtraKey.extra = 1;
    inputs.push(withExtraKey);
    const withConstructorKey = baseInput();
    (withConstructorKey.constructor as unknown) = "polluted";
    inputs.push(withConstructorKey);
    const withPrototypeKey = baseInput();
    withPrototypeKey.prototype = "polluted";
    inputs.push(withPrototypeKey);
    for (const input of inputs) {
      const result = decide(input);
      expect(result).toEqual({ outcome: "refused", reason: "invalid-input" });
    }
  });

  it("refuses invalid organizationId, bucket, or nowIso with invalid-input", () => {
    const invalidOrgIds = [null, 42, "", "ORG", "org_", "a".repeat(64), "-leading", "__proto__"];
    for (const organizationId of invalidOrgIds) {
      expect(refusedReason(decide(baseInput({ organizationId })))).toBe("invalid-input");
    }
    const invalidBuckets = [null, 42, "", "jobs", "API", "__proto__"];
    for (const bucket of invalidBuckets) {
      expect(refusedReason(decide(baseInput({ bucket })))).toBe("invalid-input");
    }
    const invalidNowIsos = [
      null,
      42,
      "",
      "2026-11-26 12:00:00Z",
      "2026-11-26T12:00:00",
      "2026-13-01T00:00:00.000Z",
      "2026-02-31T00:00:00.000Z",
    ];
    for (const nowIso of invalidNowIsos) {
      expect(refusedReason(decide(baseInput({ nowIso })))).toBe("invalid-input");
    }
  });

  it("refuses NaN, Infinity, negative, fractional, unsafe, and over-max limit or count values with invalid-input", () => {
    const invalidNumbers = [
      NaN,
      Infinity,
      -Infinity,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      "5",
      null,
    ];
    for (const limit of invalidNumbers) {
      expect(refusedReason(decide(baseInput({ limit })))).toBe("invalid-input");
    }
    for (const count of invalidNumbers) {
      expect(refusedReason(decide(baseInput({ count })))).toBe("invalid-input");
    }
    expect(
      refusedReason(decide(baseInput({ limit: MAX_RATE_LIMIT + 1 }))),
    ).toBe("invalid-input");
    expect(
      decide(baseInput({ limit: MAX_RATE_LIMIT, count: 0 })).outcome,
    ).toBe("allowed");
  });

  it("refuses malformed window objects, nested hostile values, invalid startIso, and non-positive or non-integer lengthMs with invalid-window", () => {
    const invalidWindows: unknown[] = [
      null,
      undefined,
      42,
      "window",
      [],
      throwingProxy(),
      { length: 100 },
      {},
      { startIso: START },
      { lengthMs: LENGTH_MS },
      { startIso: START, lengthMs: LENGTH_MS, extra: 1 },
      { startIso: "not-a-timestamp", lengthMs: LENGTH_MS },
      { startIso: "2026-02-31T00:00:00.000Z", lengthMs: LENGTH_MS },
      { startIso: START, lengthMs: 0 },
      { startIso: START, lengthMs: -60_000 },
      { startIso: START, lengthMs: 60_000.5 },
      { startIso: START, lengthMs: NaN },
      { startIso: START, lengthMs: Infinity },
      { startIso: START, lengthMs: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const window of invalidWindows) {
      expect(refusedReason(decide(baseInput({ window })))).toBe("invalid-window");
    }
    // A getter inside window must never run, and the refusal stays inside
    // the window path.
    const hostileWindow = Object.defineProperty(
      { startIso: START, lengthMs: LENGTH_MS },
      "startIso",
      { get() { throw new Error("getter must never run"); }, enumerable: true },
    );
    expect(
      refusedReason(decide(baseInput({ window: hostileWindow }))),
    ).toBe("invalid-window");
    // A missing `window` key on the root input is an invalid-window.
    const missingWindow = baseInput();
    delete missingWindow.window;
    expect(refusedReason(decide(missingWindow))).toBe("invalid-window");
    // A window with a prototype-polluting key is an invalid-window.
    const pollutingWindow = baseInput({ window: { startIso: START, lengthMs: LENGTH_MS } });
    Object.defineProperty(pollutingWindow.window as object, "constructor", {
      value: "polluted",
      enumerable: true,
    });
    expect(
      refusedReason(decide(pollutingWindow)),
    ).toBe("invalid-window");
  });

  it("refuses nowIso strictly before window.startIso with clock-before-window", () => {
    const result = decide(baseInput({ nowIso: "2026-11-26T11:59:59.999Z" }));
    expect(result).toEqual({ outcome: "refused", reason: "clock-before-window" });
  });

  it("never echoes rejected input values in any refusal result", () => {
    const secret = "super-secret-rejected-value";
    const results: RateLimitDecision[] = [
      decide(null),
      decide(baseInput({ organizationId: "BAD-ORG!" })),
      decide(baseInput({ bucket: secret })),
      decide(baseInput({ nowIso: secret })),
      decide(baseInput({ window: { startIso: secret, lengthMs: LENGTH_MS } })),
      decide(throwingProxy()),
    ];
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i]!;
      expect(result.outcome, `case ${i}`).toBe("refused");
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
});
