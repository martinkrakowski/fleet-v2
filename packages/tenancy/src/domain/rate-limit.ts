/**
 * Pure fixed-window per-tenant rate-limit decider (FC-6.6). Pure domain
 * code: no Node, filesystem, subprocess, network or vendor imports; no clock
 * access and no randomness or cryptographic primitive — the caller supplies
 * `nowIso` and the current count.
 *
 * Hostile-input rule: every input is read through `snapshotPlainData`
 * (`@fleet/shared`) with a bounded snapshot (9 expected nodes, depth 2, at
 * most 8 own keys, strings capped at `MAX_STRING_LENGTH`) so no getter and
 * no Proxy `get` trap ever runs; a snapshot refusal is mapped to a typed
 * refusal path (`invalid-window` inside `window`, otherwise
 * `invalid-input`). A non-function `isProxy` detector is refused with
 * `invalid-input`. Extra unknown or prototype-polluting own keys are
 * refused through `checkSnapshotKeys`. Nothing is ever thrown and no
 * rejected value is ever echoed into a refusal.
 *
 * Cost bounds:
 * - One bounded snapshot pass: O(1) — at most 16 nodes, depth 2, 8 own
 *   keys, strings capped at 4096 characters.
 * - Key checks: O(1) — one pass over at most 9 own keys of each frozen
 *   snapshot copy.
 * - Timestamp parsing: two `Date.parse` calls over length-checked
 *   calendar-valid ISO-8601 strings: O(1).
 * - Window arithmetic: a fixed number of integer operations: O(1).
 */

import { snapshotPlainData, type IsProxy } from "@fleet/shared";

import { FORBIDDEN_KEY_SET } from "./value-objects/Role.vo.js";
import {
  MAX_STRING_LENGTH,
  ORGANIZATION_ID_PATTERN,
  checkSnapshotKeys,
  isZonedIsoDateTime,
} from "./entities/record-guards.js";

/** The only rate-limit buckets a request may target. */
export const RATE_LIMIT_BUCKETS = ["api", "webhook"] as const;

export type RateLimitBucket = (typeof RATE_LIMIT_BUCKETS)[number];

/** The highest limit a window may carry. */
export const MAX_RATE_LIMIT = 1_000_000;

/** The active fixed window: start instant and length. */
export type RateLimitWindow = {
  readonly startIso: string;
  readonly lengthMs: number;
};

/** A caller-journalable audit row for a `rate-limited` refusal (FC-R54). */
export type RateLimitAuditRow = {
  readonly organizationId: string;
  readonly bucket: RateLimitBucket;
  readonly atIso: string;
  readonly limit: number;
};

export type RateLimitRefusalReason =
  | "rate-limited"
  | "invalid-window"
  | "clock-before-window"
  | "invalid-input";

export type RateLimitDecision =
  | { readonly outcome: "allowed"; readonly count: number; readonly window: RateLimitWindow }
  | {
      readonly outcome: "refused";
      readonly reason: "rate-limited";
      readonly retryAfterMs: number;
      readonly auditRow: RateLimitAuditRow;
    }
  | { readonly outcome: "refused"; readonly reason: Exclude<RateLimitRefusalReason, "rate-limited"> };

const INPUT_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "organizationId",
  "bucket",
  "window",
  "limit",
  "count",
  "nowIso",
]);

const WINDOW_ALLOWED_KEYS: ReadonlySet<string> = new Set(["startIso", "lengthMs"]);

/**
 * The largest instant a four-digit-year ISO-8601 string can name:
 * `Date.UTC(9999, 11, 31, 23, 59, 59, 999)`. An aligned window start past
 * this bound would format as an extended year through `toISOString()`, so
 * it is refused as `invalid-window`.
 */
const MAX_ISO_INSTANT_MS = 253402300799999;

/** A detector that detects nothing, used when the caller supplies none. */
const NO_DETECTOR: IsProxy = () => false;

/**
 * The bounds for the one bounded snapshot of the input: one root object of
 * 6 keys plus one nested `window` object of 2 keys (9 expected nodes), with
 * headroom so a single extra key still reaches `checkSnapshotKeys`.
 */
const SNAPSHOT_LIMITS = Object.freeze({
  maxDepth: 2,
  maxKeys: 8,
  maxArrayLength: 8,
  maxNodes: 16,
  maxStringLength: MAX_STRING_LENGTH,
});

/** A safe non-negative integer: rejects negative, fractional, NaN, Infinity. */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Decide one per-tenant request against a fixed window aligned by the floor
 * of elapsed windows. Order of checks:
 *
 * 1. validate the injected `isProxy` detector (a non-function is
 *    `invalid-input`);
 * 2. snapshot the input once — any snapshot refusal inside `window` is
 *    `invalid-window`, any other is `invalid-input`;
 * 3. key checks and field validation (`invalid-window` for the window,
 *    `invalid-input` for everything else);
 * 4. `nowIso` strictly before `window.startIso` is `clock-before-window`;
 * 5. the effective window is the floor-aligned one; a rollover resets the
 *    carried count to 0;
 * 6. `effectiveCount >= limit` (including `limit === 0`) is `rate-limited`
 *    with `retryAfterMs` and a journalable `auditRow`; otherwise the
 *    request is allowed with the incremented count and the active window.
 *
 * No refusal ever echoes a rejected value.
 */
export function decideRateLimit(input: unknown, isProxy?: IsProxy): RateLimitDecision {
  const INVALID: RateLimitDecision = { outcome: "refused", reason: "invalid-input" };
  const detector = isProxy === undefined ? NO_DETECTOR : isProxy;
  if (typeof detector !== "function") {
    return INVALID;
  }
  const snapshot = snapshotPlainData(input, detector, SNAPSHOT_LIMITS);
  if (!snapshot.ok) {
    if (snapshot.path === "window" || (snapshot.path !== null && snapshot.path.startsWith("window."))) {
      return { outcome: "refused", reason: "invalid-window" };
    }
    return INVALID;
  }
  const inputSnap = snapshot.value;
  if (typeof inputSnap !== "object" || inputSnap === null || Array.isArray(inputSnap)) {
    return INVALID;
  }
  const rootKeysRefusal = checkSnapshotKeys(inputSnap as Record<string, unknown>, INPUT_ALLOWED_KEYS);
  if (rootKeysRefusal !== null) {
    return INVALID;
  }
  const root = inputSnap as Record<string, unknown>;
  if (!Object.hasOwn(root, "window")) {
    return { outcome: "refused", reason: "invalid-window" };
  }
  for (const key of ["organizationId", "bucket", "limit", "count", "nowIso"] as const) {
    if (!Object.hasOwn(root, key)) {
      return INVALID;
    }
  }
  // Window validation: a frozen snapshot copy, so these reads touch no
  // caller-controlled object.
  const windowValue: unknown = root.window;
  if (typeof windowValue !== "object" || windowValue === null || Array.isArray(windowValue)) {
    return { outcome: "refused", reason: "invalid-window" };
  }
  const windowSnap = windowValue as Record<string, unknown>;
  const windowKeysRefusal = checkSnapshotKeys(windowSnap, WINDOW_ALLOWED_KEYS);
  if (windowKeysRefusal !== null) {
    return { outcome: "refused", reason: "invalid-window" };
  }
  if (!Object.hasOwn(windowSnap, "startIso") || !Object.hasOwn(windowSnap, "lengthMs")) {
    return { outcome: "refused", reason: "invalid-window" };
  }
  const startIso: unknown = windowSnap.startIso;
  if (!isZonedIsoDateTime(startIso) || !Number.isFinite(Date.parse(startIso))) {
    return { outcome: "refused", reason: "invalid-window" };
  }
  const lengthMs: unknown = windowSnap.lengthMs;
  if (typeof lengthMs !== "number" || !Number.isSafeInteger(lengthMs) || lengthMs <= 0) {
    return { outcome: "refused", reason: "invalid-window" };
  }
  // Root field validation.
  const organizationId: unknown = root.organizationId;
  if (
    typeof organizationId !== "string" ||
    FORBIDDEN_KEY_SET.has(organizationId) ||
    !ORGANIZATION_ID_PATTERN.test(organizationId)
  ) {
    return INVALID;
  }
  const bucket: unknown = root.bucket;
  if (
    typeof bucket !== "string" ||
    FORBIDDEN_KEY_SET.has(bucket) ||
    !(RATE_LIMIT_BUCKETS as readonly string[]).includes(bucket)
  ) {
    return INVALID;
  }
  const bucketValue = bucket as RateLimitBucket;
  const limit: unknown = root.limit;
  if (!isNonNegativeSafeInteger(limit) || limit > MAX_RATE_LIMIT) {
    return INVALID;
  }
  const count: unknown = root.count;
  if (!isNonNegativeSafeInteger(count)) {
    return INVALID;
  }
  const nowIso: unknown = root.nowIso;
  if (!isZonedIsoDateTime(nowIso) || !Number.isFinite(Date.parse(nowIso))) {
    return INVALID;
  }
  const nowMs = Date.parse(nowIso);
  const startMs = Date.parse(startIso);
  if (nowMs < startMs) {
    return { outcome: "refused", reason: "clock-before-window" };
  }
  // Aligned fixed-window rollover: the active window starts at the floor
  // of elapsed windows, and a rollover resets the carried count to 0.
  const elapsedMs = nowMs - startMs;
  const elapsedWindows = Math.floor(elapsedMs / lengthMs);
  const effectiveStartMs = startMs + elapsedWindows * lengthMs;
  const effectiveCount = elapsedWindows > 0 ? 0 : count;
  if (!Number.isSafeInteger(effectiveStartMs) || effectiveStartMs > MAX_ISO_INSTANT_MS) {
    return { outcome: "refused", reason: "invalid-window" };
  }
  if (effectiveCount >= limit) {
    const effectiveEndMs = effectiveStartMs + lengthMs;
    const retryAfterMs = Math.max(0, effectiveEndMs - nowMs);
    return {
      outcome: "refused",
      reason: "rate-limited",
      retryAfterMs,
      auditRow: { organizationId, bucket: bucketValue, atIso: nowIso, limit },
    };
  }
  return {
    outcome: "allowed",
    count: effectiveCount + 1,
    window: { startIso: new Date(effectiveStartMs).toISOString(), lengthMs },
  };
}
