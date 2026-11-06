// The per-tool token bucket (MCP tooling plan §3.7, D13). One bucket per tool
// name in this MCP process: reads 60 a minute, mutating tools 6 a minute. A
// call over the limit answers isError with `rate-limited`.

import { toToolResult, type McpToolResult } from "./envelope.js";

/** Reads: 60 calls a minute per tool (D13). */
export const READ_RATE_PER_MINUTE = 60;

/** Mutating tools: 6 calls a minute per tool (D13). */
export const MUTATING_RATE_PER_MINUTE = 6;

/** The code a refused call carries. */
export const RATE_LIMITED_CODE = "rate-limited";

export type RateLimitedKind = "read" | "mutating";

export interface ToolRateLimiter {
  /** Take one token for `toolName`; false when the bucket is empty. */
  allow(toolName: string, kind: RateLimitedKind): boolean;
}

interface Bucket {
  tokens: number;
  last: number;
}

/** Build a limiter. `now` is injectable for tests and defaults to `Date.now`. */
export function createToolRateLimiter(options?: { now?: () => number }): ToolRateLimiter {
  const nowFn = options?.now ?? Date.now;
  const buckets = new Map<string, Bucket>();

  const capacityFor = (kind: RateLimitedKind): number =>
    kind === "read" ? READ_RATE_PER_MINUTE : MUTATING_RATE_PER_MINUTE;

  return {
    allow(toolName: string, kind: RateLimitedKind): boolean {
      const capacity = capacityFor(kind);
      const current = nowFn();
      const bucket = buckets.get(toolName);
      if (bucket === undefined) {
        // A fresh bucket is full; the call takes one token immediately.
        buckets.set(toolName, { tokens: capacity - 1, last: current });
        return true;
      }
      const elapsed = Math.max(0, current - bucket.last);
      const refilled = Math.min(capacity, bucket.tokens + elapsed * (capacity / 60_000));
      if (refilled < 1) {
        // Leave the bucket unchanged: no token taken, `last` untouched.
        return false;
      }
      bucket.tokens = refilled - 1;
      // Never move `last` back: a clock that steps backwards must not re-credit elapsed time.
      bucket.last = Math.max(bucket.last, current);
      return true;
    },
  };
}

/** The isError result a refused call returns. */
export function rateLimitedResult(toolName: string): McpToolResult {
  return toToolResult({
    ok: false,
    code: RATE_LIMITED_CODE,
    message: `Tool ${toolName} is over its rate limit.`,
  });
}
