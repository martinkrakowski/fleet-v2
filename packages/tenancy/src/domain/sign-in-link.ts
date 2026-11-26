/**
 * Pure sign-in link issue and redemption decider. Pure domain code: no Node,
 * filesystem, subprocess, network or vendor imports; no clock, no randomness,
 * no randomness or cryptographic primitive — the caller supplies `nowIso`
 * and the secret digest.
 *
 * Single-use semantics follow `apps/api/server/wiring/web-login.ts` (verify
 * then spend; a refusal never echoes the presented value) and the actor shape
 * follows `apps/api/server/wiring/session-exchange.ts:35`.
 *
 * Hostile-input rule (every public function): null, undefined, non-objects,
 * arrays, array-likes, non-plain prototypes, getters (never read — inspected
 * through `Object.getOwnPropertyDescriptor` inside try/catch), throwing
 * Proxy traps (caught and refused; a Proxy that lies consistently in every
 * trap is an accepted residual), oversized strings and prototype-polluting
 * own keys are each refused with `{ outcome: 'refused', reason: 'invalid-input' }`,
 * never a throw and never a pass.
 *
 * Cost bounds:
 * - Record and input snapshots inspect a fixed field set with
 *   `Object.getOwnPropertyDescriptor`: O(1).
 * - String length bounds are checked before regex/parsing: O(1).
 * - Digest comparison runs a fixed 64-iteration XOR loop: O(1) constant time.
 */

/** Copied verbatim from apps/api/server/wiring/session-exchange.ts:35. */
export const ACTOR_PATTERN = /^[A-Za-z0-9._@-]{1,128}$/;

/** Sign-in links live at most 15 minutes. */
export const SIGN_IN_LINK_MAX_TTL_MS = 15 * 60 * 1000;

/** A link refuses redemption once this many failed attempts are recorded. */
export const MAX_SIGN_IN_ATTEMPTS = 5;

/** A secret digest is exactly 64 lowercase hex characters. */
export const SECRET_DIGEST_LENGTH = 64;
export const SECRET_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** At most this many characters before any timestamp is regex-tested. */
const MAX_ISO_LENGTH = 64;

/** Strict UTC ISO-8601: `YYYY-MM-DDTHH:mm:ss(.sss)?Z`. */
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export type SignInLinkRecord = {
  readonly linkId: string;
  readonly actor: string;
  readonly secretDigest: string;
  readonly issuedAtIso: string;
  readonly expiresAtIso: string;
  readonly redeemedAtIso: string | null;
  readonly failedAttempts: number;
};

export type SignInLinkRefusalReason =
  | "expired"
  | "already-redeemed"
  | "mismatch"
  | "too-many-attempts"
  | "invalid-input";

export type SignInLinkIssueResult =
  | { readonly outcome: "issued"; readonly record: SignInLinkRecord }
  | { readonly outcome: "refused"; readonly reason: "invalid-input" };

export type SignInLinkRedemptionResult =
  | { readonly outcome: "redeemed"; readonly record: SignInLinkRecord }
  | {
      readonly outcome: "refused";
      readonly reason: SignInLinkRefusalReason;
      readonly record?: SignInLinkRecord;
    };

const ISSUE_INPUT_KEYS = ["linkId", "actor", "secretDigest", "nowIso", "ttlMs"] as const;
const OPTIONAL_INPUT_KEYS = new Set<string>(["ttlMs"]);
const RECORD_KEYS = [
  "linkId",
  "actor",
  "secretDigest",
  "issuedAtIso",
  "expiresAtIso",
  "redeemedAtIso",
  "failedAttempts",
] as const;
const POLLUTING_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Snapshot an unknown value as a plain record whose own data properties are
 * exactly `keys` (the keys in `optional` may be absent). No getter ever runs:
 * fields are read through property descriptors only. Returns null on any
 * hostile shape. Cost bound: O(1) — one bounded descriptor pass over a fixed
 * key set, a fixed prototype check and fixed key checks.
 */
function snapPlainObject(
  input: unknown,
  keys: readonly string[],
  optional: ReadonlySet<string>,
): Record<string, unknown> | null {
  let prototype: unknown;
  let descriptors: Record<string, PropertyDescriptor | undefined>;
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    prototype = Object.getPrototypeOf(input);
    descriptors = {};
    for (const key of keys) {
      descriptors[key] = Object.getOwnPropertyDescriptor(input, key);
    }
  } catch {
    // A throwing Proxy trap is hostile; a lying one is an accepted residual.
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const snap: Record<string, unknown> = {};
  for (const key of keys) {
    if (POLLUTING_KEYS.has(key)) {
      return null;
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined) {
      if (optional.has(key)) {
        continue;
      }
      return null;
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) {
      return null;
    }
    snap[key] = descriptor.value;
  }
  let ownNames: readonly string[];
  try {
    ownNames = Object.getOwnPropertyNames(input);
  } catch {
    return null;
  }
  for (const key of ownNames) {
    if (POLLUTING_KEYS.has(key)) {
      return null;
    }
    if (!keys.includes(key)) {
      return null;
    }
  }
  return snap;
}

/**
 * True when the date and time fields of an ISO-8601 string name a real
 * calendar instant. Date.parse rolls an impossible date such as 02-31 over
 * into the next month instead of refusing it, so the fields are checked here.
 * Cost bound: O(1) — a fixed number of field reads and one bounded Date.UTC
 * call.
 */
function isCalendarUtcDate(iso: string): boolean {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const hour = Number(iso.slice(11, 13));
  const minute = Number(iso.slice(14, 16));
  const second = Number(iso.slice(17, 19));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

/**
 * A strict UTC ISO-8601 timestamp. The length is checked before the regex so
 * an enormous string never reaches parsing. Cost bound: O(1) — fixed-length
 * checks, one regex over at most 64 characters, and one Date.parse.
 */
function isValidUtcIso(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ISO_LENGTH) {
    return false;
  }
  if (!UTC_ISO_PATTERN.test(value)) {
    return false;
  }
  if (!isCalendarUtcDate(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

/** A string matching ACTOR_PATTERN, length-checked before the regex. O(1). */
function isValidActor(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 128 && value.length >= 1 && ACTOR_PATTERN.test(value)
  );
}

/** Exactly 64 lowercase hex characters, length-checked before the regex. O(1). */
function isValidDigest(value: unknown): value is string {
  return typeof value === "string" && value.length === SECRET_DIGEST_LENGTH && SECRET_DIGEST_PATTERN.test(value);
}

/** A safe non-negative integer: rejects negative, fractional, NaN, Infinity. O(1). */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseInstantMs(iso: string): number {
  return Date.parse(iso);
}

/**
 * Decide whether a sign-in link may be issued. Takes a single object
 * argument, snapshotted safely; every field is validated before any record is
 * produced. The expiration is derived from `nowIso` and `ttlMs` (default
 * `SIGN_IN_LINK_MAX_TTL_MS`), formatted with `new Date(ms).toISOString()` —
 * never from a clock.
 */
export function decideSignInLinkIssue(input: {
  readonly linkId: unknown;
  readonly actor: unknown;
  readonly secretDigest: unknown;
  readonly nowIso: unknown;
  readonly ttlMs?: unknown;
}): SignInLinkIssueResult {
  const INVALID: SignInLinkIssueResult = { outcome: "refused", reason: "invalid-input" };
  const snap = snapPlainObject(input, ISSUE_INPUT_KEYS, OPTIONAL_INPUT_KEYS);
  if (snap === null) {
    return INVALID;
  }
  if (!isValidActor(snap.linkId) || !isValidActor(snap.actor)) {
    return INVALID;
  }
  if (!isValidDigest(snap.secretDigest)) {
    return INVALID;
  }
  if (!isValidUtcIso(snap.nowIso)) {
    return INVALID;
  }
  let ttlMs = SIGN_IN_LINK_MAX_TTL_MS;
  if (Object.hasOwn(snap, "ttlMs") && snap.ttlMs !== undefined) {
    const provided = snap.ttlMs;
    if (
      typeof provided !== "number" ||
      !Number.isSafeInteger(provided) ||
      provided <= 0 ||
      provided > SIGN_IN_LINK_MAX_TTL_MS
    ) {
      return INVALID;
    }
    ttlMs = provided;
  }
  const nowMs = parseInstantMs(snap.nowIso);
  if (Number.isNaN(nowMs)) {
    return INVALID;
  }
  const record: SignInLinkRecord = {
    linkId: snap.linkId,
    actor: snap.actor,
    secretDigest: snap.secretDigest,
    issuedAtIso: snap.nowIso,
    expiresAtIso: new Date(nowMs + ttlMs).toISOString(),
    redeemedAtIso: null,
    failedAttempts: 0,
  };
  return { outcome: "issued", record };
}

function isSignInLinkRecordFields(snap: Record<string, unknown>): boolean {
  if (!isValidActor(snap.linkId) || !isValidActor(snap.actor)) {
    return false;
  }
  if (!isValidDigest(snap.secretDigest)) {
    return false;
  }
  if (!isValidUtcIso(snap.issuedAtIso) || !isValidUtcIso(snap.expiresAtIso)) {
    return false;
  }
  if (snap.redeemedAtIso !== null && !isValidUtcIso(snap.redeemedAtIso)) {
    return false;
  }
  if (!isNonNegativeSafeInteger(snap.failedAttempts)) {
    return false;
  }
  const issuedMs = parseInstantMs(snap.issuedAtIso);
  const expiresMs = parseInstantMs(snap.expiresAtIso);
  const lifetime = expiresMs - issuedMs;
  return lifetime > 0 && lifetime <= SIGN_IN_LINK_MAX_TTL_MS;
}

function toRecord(snap: Record<string, unknown>): SignInLinkRecord {
  return {
    linkId: snap.linkId as string,
    actor: snap.actor as string,
    secretDigest: snap.secretDigest as string,
    issuedAtIso: snap.issuedAtIso as string,
    expiresAtIso: snap.expiresAtIso as string,
    redeemedAtIso: (snap.redeemedAtIso ?? null) as string | null,
    failedAttempts: snap.failedAttempts as number,
  };
}

/**
 * Decide one redemption attempt in a fixed order:
 *
 * 1. validate and snapshot every input (any failure is `invalid-input`
 *    before any digest comparison);
 * 2. an already redeemed link is `already-redeemed`;
 * 3. `failedAttempts >= MAX_SIGN_IN_ATTEMPTS` is `too-many-attempts`;
 * 4. outside `[issuedAtIso, expiresAtIso)` is `expired`;
 * 5. a constant-time digest comparison — a mismatch is `mismatch` with the
 *    failed-attempt count incremented;
 * 6. otherwise the link is redeemed at `nowIso`.
 *
 * Neither the presented digest nor the recorded one is ever echoed in a
 * refusal.
 */
export function decideSignInLinkRedemption(
  record: unknown,
  presentedDigest: unknown,
  nowIso: unknown,
): SignInLinkRedemptionResult {
  const snap = snapPlainObject(record, RECORD_KEYS, new Set());
  if (snap === null || !isSignInLinkRecordFields(snap)) {
    return { outcome: "refused", reason: "invalid-input" };
  }
  if (!isValidDigest(presentedDigest)) {
    return { outcome: "refused", reason: "invalid-input" };
  }
  if (!isValidUtcIso(nowIso)) {
    return { outcome: "refused", reason: "invalid-input" };
  }
  if (snap.redeemedAtIso !== null) {
    return { outcome: "refused", reason: "already-redeemed" };
  }
  if (((snap.failedAttempts as number) >= MAX_SIGN_IN_ATTEMPTS)) {
    return { outcome: "refused", reason: "too-many-attempts" };
  }
  const nowMs = parseInstantMs(nowIso);
  const issuedMs = parseInstantMs(snap.issuedAtIso as string);
  const expiresMs = parseInstantMs(snap.expiresAtIso as string);
  if (nowMs < issuedMs || nowMs >= expiresMs) {
    return { outcome: "refused", reason: "expired" };
  }
  const stored = snap.secretDigest as string;
  let diff = 0;
  for (let i = 0; i < SECRET_DIGEST_LENGTH; i += 1) {
    diff |= presentedDigest.charCodeAt(i) ^ stored.charCodeAt(i);
  }
  if (diff !== 0) {
    return {
      outcome: "refused",
      reason: "mismatch",
      record: { ...toRecord(snap), failedAttempts: (snap.failedAttempts as number) + 1 },
    };
  }
  return { outcome: "redeemed", record: { ...toRecord(snap), redeemedAtIso: nowIso } };
}
