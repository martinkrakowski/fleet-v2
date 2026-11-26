/**
 * Pure per-tenant fixed-window rate-limit decider. Pure domain code: no Node,
 * filesystem, subprocess, network or vendor imports; no clock and no
 * randomness or cryptographic primitive — the caller supplies `nowIso` and
 * the active window, and the decider only parses and compares them.
 *
 * Semantics: each `{ organizationId, bucket }` pair owns a fixed window
 * anchored at `window.startIso` with length `window.lengthMs`. The active
 * window is the floor-aligned window containing `nowIso`: windows roll over
 * in alignment with the supplied anchor, so a long idle gap lands the next
 * request in the correct aligned window with a reset count. When the count
 * inside the active window has reached `limit` the request is refused with
 * `rate-limited`, a `retryAfterMs` naming the remaining milliseconds until
 * the active window ends, and a journalable `auditRow` (FC-R54).
 *
 * Hostile-input posture: the outer input is snapshotted once through
 * `snapshotPlainData` (no Proxy trap and no getter ever runs), extra and
 * prototype-polluting own keys are refused via `checkSnapshotKeys`, and no
 * rejected value is ever echoed into a refusal result.
 *
 * Cost bounds:
 * - The bounded snapshot visits at most 16 nodes over depth 2 with strings
 *   capped at `MAX_STRING_LENGTH`: O(1).
 * - Key checks are one pass over at most 9 own keys per object: O(1).
 * - Timestamp validation is a regex over a bounded string plus one
 *   `Date.parse` each: O(1).
 * - All window arithmetic is a fixed number of integer operations: O(1).
 */

import { snapshotPlainData, type IsProxy } from "@fleet/shared";

import {
  MAX_STRING_LENGTH,
  ORGANIZATION_ID_PATTERN,
  checkSnapshotKeys,
  isZonedIsoDateTime,
} from "./entities/record-guards.js";
import { FORBIDDEN_KEY_SET } from "./value-objects/Role.vo.js";

/** The only rate-limit buckets a tenant may draw from. */
export const RATE_LIMIT_BUCKETS = ["api", "webhook"] as const;

export type RateLimitBucket = (typeof RATE_LIMIT_BUCKETS)[number];

/** A per-tenant request limit may not exceed this bound. */
export const MAX_RATE_LIMIT = 1_000_000;

/** The fixed window carried in the input: an anchored start and a length. */
export type RateLimitWindow = {
  readonly startIso: string;
  readonly lengthMs: number;
};

/** One journalable rate-limit refusal row (FC-R54). */
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
  | {
      readonly outcome: "allowed";
      readonly count: number;
      readonly window: RateLimitWindow;
    }
  | {
      readonly outcome: "refused";
      readonly reason: "rate-limited";
      readonly retryAfterMs: number;
      readonly auditRow: RateLimitAuditRow;
    }
  | {
      readonly outcome: "refused";
      readonly reason: Exclude<RateLimitRefusalReason, "rate-limited">;
    };

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
 * `Date.UTC(9999, 11, 31, 23, 59, 59, 999)`. Formatting a later instant
 * through `toISOString()` would emit an extended year (`+010000-…`), so the
 * rolled-over window start is refused past this bound.
 */
const MAX_ISO_INSTANT_MS = 253402300799999;

/** A detector that detects nothing, used when the caller supplies none. */
const NO_DETECTOR: IsProxy = () => false;

/**
 * Decide one rate-limited request against a per-tenant fixed window.
 * Takes a single unknown input snapshotted safely; every field is validated
 * before any decision. A non-function `isProxy` is refused; an omitted one
 * detects nothing. Cost bound: O(1) overall — a bounded snapshot, fixed key
 * checks, bounded timestamp parsing and constant arithmetic (see the module
 * docstring). No rejected value is ever echoed.
 */
export function decideRateLimit(input: unknown, isProxy?: IsProxy): RateLimitDecision {
  const INVALID_INPUT: RateLimitDecision = { outcome: "refused", reason: "invalid-input" };
  const INVALID_WINDOW: RateLimitDecision = { outcome: "refused", reason: "invalid-window" };
  const detector = isProxy === undefined ? NO_DETECTOR : isProxy;
  if (typeof detector !== "function") {
    return INVALID_INPUT;
  }
  const snapshot = snapshotPlainData(input, detector, {
    maxDepth: 2,
    maxKeys: 8,
    maxArrayLength: 8,
    maxNodes: 16,
    maxStringLength: MAX_STRING_LENGTH,
  });
  if (!snapshot.ok) {
    if (snapshot.path === "window" || (snapshot.path !== null && snapshot.path.startsWith("window."))) {
      return INVALID_WINDOW;
    }
    return INVALID_INPUT;
  }
  const inputSnap = snapshot.value;
  if (typeof inputSnap !== "object" || inputSnap === null || Array.isArray(inputSnap)) {
    return INVALID_INPUT;
  }
  const root = inputSnap as Record<string, unknown>;
  if (checkSnapshotKeys(root, INPUT_ALLOWED_KEYS) !== null) {
    return INVALID_INPUT;
  }
  if (!Object.hasOwn(root, "window")) {
    return INVALID_WINDOW;
  }
  for (const key of ["organizationId", "bucket", "limit", "count", "nowIso"] as const) {
    if (!Object.hasOwn(root, key)) {
      return INVALID_INPUT;
    }
  }
  const organizationId = root.organizationId;
  const bucket = root.bucket;
  const limit = root.limit;
  const count = root.count;
  const nowIso = root.nowIso;

  const windowValue = root.window;
  if (typeof windowValue !== "object" || windowValue === null || Array.isArray(windowValue)) {
    return INVALID_WINDOW;
  }
  const windowSnap = windowValue as Record<string, unknown>;
  if (checkSnapshotKeys(windowSnap, WINDOW_ALLOWED_KEYS) !== null) {
    return INVALID_WINDOW;
  }
  if (!Object.hasOwn(windowSnap, "startIso") || !Object.hasOwn(windowSnap, "lengthMs")) {
    return INVALID_WINDOW;
  }
  const startIso = windowSnap.startIso;
  const lengthMs = windowSnap.lengthMs;
  if (!isZonedIsoDateTime(startIso) || !Number.isFinite(Date.parse(startIso))) {
    return INVALID_WINDOW;
  }
  if (typeof lengthMs !== "number" || !Number.isSafeInteger(lengthMs) || lengthMs <= 0) {
    return INVALID_WINDOW;
  }

  if (typeof organizationId !== "string" || FORBIDDEN_KEY_SET.has(organizationId)) {
    return INVALID_INPUT;
  }
  if (!ORGANIZATION_ID_PATTERN.test(organizationId)) {
    return INVALID_INPUT;
  }
  if (typeof bucket !== "string" || !(RATE_LIMIT_BUCKETS as readonly string[]).includes(bucket)) {
    return INVALID_INPUT;
  }
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0 || limit > MAX_RATE_LIMIT) {
    return INVALID_INPUT;
  }
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    return INVALID_INPUT;
  }
  if (!isZonedIsoDateTime(nowIso) || !Number.isFinite(Date.parse(nowIso))) {
    return INVALID_INPUT;
  }

  const nowMs = Date.parse(nowIso);
  const startMs = Date.parse(startIso);
  if (nowMs < startMs) {
    return { outcome: "refused", reason: "clock-before-window" };
  }

  // Aligned fixed-window rollover: the active window is the floor-aligned
  // window containing `now`; a gap of whole window lengths resets the count.
  const elapsedMs = nowMs - startMs;
  const elapsedWindows = Math.floor(elapsedMs / lengthMs);
  const effectiveStartMs = startMs + elapsedWindows * lengthMs;
  const effectiveCount = elapsedWindows > 0 ? 0 : count;

  if (!Number.isSafeInteger(effectiveStartMs) || effectiveStartMs > MAX_ISO_INSTANT_MS) {
    return INVALID_WINDOW;
  }

  if (effectiveCount >= limit) {
    const effectiveEndMs = effectiveStartMs + lengthMs;
    const retryAfterMs = Math.max(0, effectiveEndMs - nowMs);
    return {
      outcome: "refused",
      reason: "rate-limited",
      retryAfterMs,
      auditRow: { organizationId, bucket: bucket as RateLimitBucket, atIso: nowIso, limit },
    };
  }
  return {
    outcome: "allowed",
    count: effectiveCount + 1,
    window: { startIso: new Date(effectiveStartMs).toISOString(), lengthMs },
  };
}
