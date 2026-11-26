import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MAX_RATE_LIMIT,
  RATE_LIMIT_BUCKETS,
  decideRateLimit,
} from "../rate-limit.js";

const SOURCE = readFileSync(new URL("../rate-limit.ts", import.meta.url), "utf8");

const START = "2026-11-26T12:00:00.000Z";
const NOW = "2026-11-26T12:00:30.000Z";


const input = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  organizationId: "org-1",
  bucket: "api",
  window: { startIso: START, lengthMs: 60_000 },
  limit: 5,
  count: 0,
  nowIso: NOW,
  ...overrides,
});

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

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

const START_MS = Date.parse(START);

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
    const result = decideRateLimit(input({ count: 2, limit: 5 }));
    expect(result).toEqual({
      outcome: "allowed",
      count: 3,
      window: { startIso: START, lengthMs: 60_000 },
    });
  });

  it("allows the limit-th request when count equals limit - 1", () => {
    const result = decideRateLimit(input({ count: 4, limit: 5 }));
    expect(result).toEqual({
      outcome: "allowed",
      count: 5,
      window: { startIso: START, lengthMs: 60_000 },
    });
    // One more request in the same window is refused: the boundary is exact.
    expect(decideRateLimit(input({ count: 5, limit: 5 }))).toMatchObject({
      outcome: "refused",
      reason: "rate-limited",
    });
  });
});

describe("decideRateLimit refusal paths", () => {
  it("refuses over-limit requests with rate-limited, exact retryAfterMs, and auditRow", () => {
    const result = decideRateLimit(input({ count: 6, limit: 5 }));
    expect(result).toEqual({
      outcome: "refused",
      reason: "rate-limited",
      retryAfterMs: 30_000, // 12:01:00 window end minus 12:00:30 now
      auditRow: { organizationId: "org-1", bucket: "api", atIso: NOW, limit: 5 },
    });
  });

  it("refuses when limit is 0 with rate-limited and auditRow", () => {
    const result = decideRateLimit(input({ count: 0, limit: 0 }));
    expect(result).toMatchObject({
      outcome: "refused",
      reason: "rate-limited",
      auditRow: { organizationId: "org-1", bucket: "api", atIso: NOW, limit: 0 },
    });
  });

  it("rolls over to count 1 in an aligned window when nowIso is exactly at start + length", () => {
    const now = iso(START_MS + 60_000);
    const result = decideRateLimit(input({ count: 9, limit: 5, nowIso: now }));
    expect(result).toEqual({
      outcome: "allowed",
      count: 1,
      window: { startIso: now, lengthMs: 60_000 },
    });
  });

  it("rolls over across a long idle gap to the floor-aligned window boundary", () => {
    // 2.5 windows after START: aligned to 2 full windows, count resets.
    const now = iso(START_MS + 150_000);
    const result = decideRateLimit(input({ count: 9, limit: 5, nowIso: now }));
    expect(result).toEqual({
      outcome: "allowed",
      count: 1,
      window: { startIso: iso(START_MS + 120_000), lengthMs: 60_000 },
    });
  });

  it("computes retryAfterMs as remaining milliseconds until the active window end", () => {
    const now = iso(START_MS + 59_001);
    const result = decideRateLimit(input({ count: 5, limit: 5, nowIso: now }));
    expect(result).toMatchObject({ outcome: "refused", reason: "rate-limited" });
    if (result.outcome === "refused" && result.reason === "rate-limited") {
      expect(result.retryAfterMs).toBe(999);
    }
  });

  it("keeps decisions for different organizations independent", () => {
    // The decision is derived only from the supplied input fields: two
    // otherwise identical calls for different organizationId values carry
    // their own count, limit and auditRow.
    const a = decideRateLimit(input({ organizationId: "org-a", count: 5, limit: 5 }));
    const b = decideRateLimit(input({ organizationId: "org-b", count: 5, limit: 5 }));
    expect(a).toMatchObject({
      outcome: "refused",
      reason: "rate-limited",
      auditRow: { organizationId: "org-a" },
    });
    expect(b).toMatchObject({
      outcome: "refused",
      reason: "rate-limited",
      auditRow: { organizationId: "org-b" },
    });
  });

  it("supports both api and webhook buckets", () => {
    for (const bucket of RATE_LIMIT_BUCKETS) {
      const allowed = decideRateLimit(input({ bucket, count: 0, limit: 1 }));
      expect(allowed).toEqual({
        outcome: "allowed",
        count: 1,
        window: { startIso: START, lengthMs: 60_000 },
      });
      const refused = decideRateLimit(input({ bucket, count: 1, limit: 1 }));
      expect(refused).toMatchObject({
        outcome: "refused",
        reason: "rate-limited",
        auditRow: { bucket, limit: 1 },
      });
    }
  });

  it("refuses a non-function isProxy detector with invalid-input", () => {
    for (const detector of [42, "x", null, true, {}]) {
      const result = decideRateLimit(input(), detector as never);
      expect(result).toEqual({ outcome: "refused", reason: "invalid-input" });
    }
    // Omitting the detector is fine (the default detects nothing).
    expect(decideRateLimit(input()).outcome).toBe("allowed");
  });

  it("refuses hostile outer input shapes (null, undefined, primitives, arrays, holes, array-like, getter, Proxy, prototype-polluting keys) without invoking getters", () => {
    const withGetter = Object.defineProperty(input(), "count", {
      get() {
        throw new Error("getter must never run");
      },
      enumerable: true,
    });
    const withHoles: unknown[] = [];
    withHoles[3] = input();
    const hostile: unknown[] = [
      null,
      undefined,
      42,
      "input",
      true,
      [input()],
      { ...input(), length: 7 },
      withGetter,
      throwingProxy(),
      withHoles,
      Object.defineProperty(input(), "__proto__", { value: null, enumerable: true }),
      Object.defineProperty(input(), "constructor", { value: 1, enumerable: true }),
      Object.defineProperty(input(), "prototype", { value: 1, enumerable: true }),
      { ...input(), extra: 1 },
      { ...input(), count: "5" },
    ];
    for (const hostileInput of hostile) {
      const result = decideRateLimit(hostileInput);
      expect(result).toEqual({ outcome: "refused", reason: "invalid-input" });
    }
    // The throwing getter above was never invoked.
    expect(withGetter).toBeDefined();
  });

  it("refuses invalid organizationId, bucket, or nowIso with invalid-input", () => {
    for (const organizationId of [42, null, "", "Org-1", "-org", "a".repeat(64), "__proto__"]) {
      expect(decideRateLimit(input({ organizationId }))).toEqual({
        outcome: "refused",
        reason: "invalid-input",
      });
    }
    for (const bucket of [42, null, "", "dispatch", "API", "email"]) {
      expect(decideRateLimit(input({ bucket }))).toEqual({
        outcome: "refused",
        reason: "invalid-input",
      });
    }
    for (const nowIso of ["not-a-date", "2026-02-31T12:00:00.000Z", 42, null, NOW.slice(0, -1)]) {
      expect(decideRateLimit(input({ nowIso }))).toEqual({
        outcome: "refused",
        reason: "invalid-input",
      });
    }
  });

  it("refuses NaN, Infinity, negative, fractional, unsafe, and over-max limit or count values with invalid-input", () => {
    for (const bad of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "5", null]) {
      expect(decideRateLimit(input({ limit: bad }))).toEqual({
        outcome: "refused",
        reason: "invalid-input",
      });
      expect(decideRateLimit(input({ count: bad }))).toEqual({
        outcome: "refused",
        reason: "invalid-input",
      });
    }
    // limit over the max is refused; count itself has no upper bound (an
    // in-window count above a reduced limit is the rate-limited case).
    expect(decideRateLimit(input({ limit: MAX_RATE_LIMIT + 1 }))).toEqual({
      outcome: "refused",
      reason: "invalid-input",
    });
    // limit === MAX_RATE_LIMIT itself is accepted.
    expect(decideRateLimit(input({ limit: MAX_RATE_LIMIT, count: 0 })).outcome).toBe("allowed");
  });

  it("refuses malformed window objects, nested hostile values, invalid startIso, and non-positive or non-integer lengthMs with invalid-window", () => {
    const windowCases: unknown[] = [
      null,
      undefined,
      42,
      "window",
      [START, 60_000],
      { startIso: START },
      { lengthMs: 60_000 },
      { startIso: START, lengthMs: 60_000, extra: 1 },
      Object.defineProperty(
        { startIso: START, lengthMs: 60_000 },
        "constructor",
        { value: 1, enumerable: true },
      ),
      { startIso: "not-a-date", lengthMs: 60_000 },
      { startIso: "2026-02-31T12:00:00.000Z", lengthMs: 60_000 },
      { startIso: 42, lengthMs: 60_000 },
      { startIso: START, lengthMs: 0 },
      { startIso: START, lengthMs: -60_000 },
      { startIso: START, lengthMs: 1.5 },
      { startIso: START, lengthMs: NaN },
      { startIso: START, lengthMs: Infinity },
      { startIso: START, lengthMs: Number.MAX_SAFE_INTEGER + 1 },
      { startIso: START, lengthMs: "60000" },
      { startIso: START, lengthMs: null },
    ];
    for (const badWindow of windowCases) {
      expect(decideRateLimit(input({ window: badWindow }))).toEqual({
        outcome: "refused",
        reason: "invalid-window",
      });
    }
    // A getter inside window must never run.
    const getterWindow = Object.defineProperty(
      { startIso: START, lengthMs: 60_000 },
      "startIso",
      {
        get() {
          throw new Error("getter must never run");
        },
        enumerable: true,
      },
    );
    expect(decideRateLimit(input({ window: getterWindow }))).toEqual({
      outcome: "refused",
      reason: "invalid-window",
    });
    // A Proxy as the window (or as window.startIso) is refused as invalid-window.
    expect(decideRateLimit(input({ window: throwingProxy() }))).toEqual({
      outcome: "refused",
      reason: "invalid-window",
    });
    // Missing window key on the root is invalid-window, not invalid-input.
    const withoutWindow = input();
    delete withoutWindow.window;
    expect(decideRateLimit(withoutWindow)).toEqual({
      outcome: "refused",
      reason: "invalid-window",
    });
    // A -0 lengthMs inside window is a nested snapshot refusal mapped to invalid-window.
    expect(decideRateLimit(input({ window: { startIso: START, lengthMs: -0 } }))).toEqual({
      outcome: "refused",
      reason: "invalid-window",
    });
  });

  it("keeps the aligned window start inside the four-digit year range at the 9999 boundary", () => {
    // The aligned effective start never exceeds nowMs, so it always formats
    // through toISOString(); a window anchored at the last valid minute
    // formats exactly and a reached limit reports the exact retryAfterMs.
    const start = "9999-12-31T23:59:00.000Z";
    const now = "9999-12-31T23:59:59.000Z";
    const result = decideRateLimit(input({ window: { startIso: start, lengthMs: 60_000 }, nowIso: now, count: 5, limit: 5 }));
    expect(result).toEqual({
      outcome: "refused",
      reason: "rate-limited",
      retryAfterMs: 1000,
      auditRow: { organizationId: "org-1", bucket: "api", atIso: now, limit: 5 },
    });
    const allowed = decideRateLimit(input({ window: { startIso: start, lengthMs: 60_000 }, nowIso: now, count: 0, limit: 5 }));
    expect(allowed).toEqual({
      outcome: "allowed",
      count: 1,
      window: { startIso: start, lengthMs: 60_000 },
    });
  });

  it("refuses nowIso strictly before window.startIso with clock-before-window", () => {
    const before = iso(START_MS - 1);
    expect(decideRateLimit(input({ nowIso: before }))).toEqual({
      outcome: "refused",
      reason: "clock-before-window",
    });
    // Exactly at the start is inside the window, not before it.
    expect(decideRateLimit(input({ nowIso: START, count: 0, limit: 1 })).outcome).toBe("allowed");
  });

  it("refuses in-window count above limit with rate-limited and retryAfterMs, and resets on rollover", () => {
    // A limit reduction left the stored count above the new limit mid-window.
    const refused = decideRateLimit(input({ count: 10, limit: 3 }));
    expect(refused).toMatchObject({ outcome: "refused", reason: "rate-limited" });
    if (refused.outcome === "refused" && refused.reason === "rate-limited") {
      expect(refused.retryAfterMs).toBe(30_000);
      expect(refused.auditRow).toEqual({
        organizationId: "org-1",
        bucket: "api",
        atIso: NOW,
        limit: 3,
      });
    }
    // At rollover the count resets: nowIso reaches start + length.
    const rolled = decideRateLimit(input({ count: 10, limit: 3, nowIso: iso(START_MS + 60_000) }));
    expect(rolled).toEqual({
      outcome: "allowed",
      count: 1,
      window: { startIso: iso(START_MS + 60_000), lengthMs: 60_000 },
    });
  });

  it("never echoes rejected input values in any refusal result", () => {
    const secret = "very-secret-rejected-value";
    const cases: Array<[unknown, string]> = [
      [secret, "invalid-input"],
      [{ ...input(), organizationId: `!!${secret}` }, "invalid-input"],
      [{ ...input(), bucket: secret }, "invalid-input"],
      [{ ...input(), nowIso: secret }, "invalid-input"],
      [{ ...input(), count: secret }, "invalid-input"],
      [{ ...input(), window: secret }, "invalid-window"],
      [{ ...input(), window: { startIso: secret, lengthMs: 60_000 } }, "invalid-window"],
      [throwingProxy(), "invalid-input"],
    ];
    for (const [hostile, reason] of cases) {
      const result = decideRateLimit(hostile);
      expect(result.outcome).toBe("refused");
      expect((result as { reason: string }).reason).toBe(reason);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    // A hostile Proxy is never echoed either (its text form is not stable,
    // but no refusal may carry extra fields at all).
    const proxyResult = decideRateLimit(throwingProxy());
    expect(Object.keys(proxyResult).sort()).toEqual(["outcome", "reason"]);
  });
});
