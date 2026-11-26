/**
 * SpendCap: the pure spend-cap value object and the pure `decideSpend`
 * admission decision for @fleet/billing (FC9B). Shadow only: nothing here
 * invoices, charges or contacts anything. Pure domain code: no Node,
 * filesystem, subprocess, network or vendor imports, no clock reads, no I/O,
 * no `console.*`, and nothing throws on hostile input.
 *
 * Amounts are abstract non-negative safe integers in "cap units". No price
 * figure, currency symbol or rate appears anywhere in this module.
 *
 * Hostile-input posture: `parseSpendCap`, `periodKeyOf` and `decideSpend`
 * treat their inputs as untrusted. Every object read goes through own-property
 * descriptors only (`Reflect.ownKeys` bounded against the exact expected key
 * count, then `Object.getOwnPropertyDescriptor`), so no getter or setter ever
 * runs, non-enumerable and symbol keys are refused, prototype-polluting keys
 * (`__proto__`, `constructor`, `prototype`) and extra or missing keys are
 * refused, and non-plain objects (including arrays and class instances) are
 * refused. A hostile Proxy trap surfaces as a typed refusal, never a throw;
 * a Proxy that lies consistently in every trap is an accepted residual.
 * Every refusal is the typed reason `invalid-input`; no input value is ever
 * echoed back. Every check is O(1): the key census is bounded (see
 * `readExactRecord`), string lengths are bounded (63 for identifiers, 7 for a
 * period key, 64 for an ISO timestamp) and the arithmetic rests on single
 * safe-integer comparisons.
 */

/** The scope a cap applies to. An organization cap carries no project. */
export type SpendCapScope = "organization" | "project";

/**
 * A spend cap: where it applies (scope plus identifiers), which calendar
 * month it counts (`periodKey`) and how many cap units it allows
 * (`limitUnits`, a non-negative safe integer).
 */
export interface SpendCap {
  readonly scope: SpendCapScope;
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly periodKey: string;
  readonly limitUnits: number;
}

/** The single refusal reason every hostile input maps to. */
export type SpendCapRefusalReason = "invalid-input";

/** The typed result of `parseSpendCap`. */
export type SpendCapParse =
  | { readonly ok: true; readonly cap: SpendCap }
  | { readonly ok: false; readonly reason: SpendCapRefusalReason };

/** The typed result of `periodKeyOf`. */
export type PeriodKeyParse =
  | { readonly ok: true; readonly periodKey: string }
  | { readonly ok: false; readonly reason: SpendCapRefusalReason };

/** Every outcome `decideSpend` can produce. Unknown state is never allow. */
export type SpendDecision =
  | { readonly outcome: "allow" }
  | { readonly outcome: "park"; readonly reason: "spend-cap"; readonly scope: SpendCapScope }
  | { readonly outcome: "park"; readonly reason: "no-cap-for-period" }
  | { readonly outcome: "refuse"; readonly reason: SpendCapRefusalReason };

/** Identifier shape shared by `organizationId` and a non-null `projectId`. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** An exact `YYYY-MM` calendar month, `01`-`12`, exactly seven ASCII characters. */
const PERIOD_KEY_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

/** Strict ISO-8601 timestamp with captured calendar and clock fields. */
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * Whether the captured calendar day exists in that month of that year,
 * including the Gregorian leap-year rule. Cost bound: O(1) — fixed-size
 * arithmetic on at most six two-digit fields.
 */
function isRealCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth;
}

/** Longest string this module will even look at as an ISO timestamp. */
const MAX_ISO_LENGTH = 64;

/** Prototype-polluting keys, refused wherever a key-shaped string is read. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

type ReadResult =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false };

/**
 * Snapshot an unknown value into a frozen plain record with exactly the
 * expected keys, reading every own property through its descriptor.
 *
 * Cost bound: O(1). The key census runs in two bounded phases and never
 * materializes an unbounded key list before refusing an excess:
 *
 * 1. A lazy `for...in` census of the enumerable own string keys (the
 *    prototype is already pinned to `Object.prototype` or `null`, so nothing
 *    is inherited) bails out the moment the count exceeds the expected one.
 *    An input with any excess of enumerable keys is therefore refused after
 *    at most `expectedKeys.length + 1` iterations, never after enumerating
 *    all of them.
 * 2. Only when that bounded count matches exactly does the full own-key
 *    census (`Reflect.ownKeys`) run, refusing hidden extras (non-enumerable
 *    or symbol keys). Residual, same class as a Proxy that lies in every
 *    trap: an input deliberately built with exactly the expected enumerable
 *    keys plus an enormous number of *hidden* keys cannot be distinguished
 *    from a clean record without that full enumeration, because the platform
 *    offers no lazy own-key enumeration for hidden properties; building such
 *    an input already costs the attacker one write per hidden key, and no
 *    property of it is ever read beyond the expected keys' descriptors.
 *
 * Refused, never thrown: non-objects, arrays, non-plain prototypes,
 * descriptor-read failures (hostile Proxy traps), excess enumerable keys
 * (bounded phase 1), key counts other than the exact expected one, unexpected
 * keys (including symbols, non-enumerable keys and prototype-polluting keys),
 * accessors and non-enumerable properties. A Proxy that lies consistently in
 * every trap is an accepted residual.
 */
function readExactRecord(
  input: unknown,
  expectedKeys: readonly string[],
): ReadResult {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { ok: false };
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return { ok: false };
    }
    // Phase 1: lazy census of the enumerable own string keys, bailing out as
    // soon as the count exceeds the expected one, so excess keys are refused
    // in O(expectedKeys.length + 1) without materializing them.
    const expected: ReadonlySet<string> = new Set(expectedKeys);
    let enumerableCount = 0;
    for (const key in input) {
      enumerableCount += 1;
      if (
        enumerableCount > expectedKeys.length ||
        typeof key !== "string" ||
        !expected.has(key) ||
        FORBIDDEN_KEYS.has(key)
      ) {
        return { ok: false };
      }
    }
    if (enumerableCount !== expectedKeys.length) {
      return { ok: false };
    }
    // Phase 2: full own-key census, reached only when the bounded phase-1
    // count already matched exactly; it refuses hidden extras (symbols and
    // non-enumerable keys) and any key outside the expected set.
    const keys = Reflect.ownKeys(input);
    if (keys.length !== expectedKeys.length) {
      return { ok: false };
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string" || !expected.has(key) || FORBIDDEN_KEYS.has(key)) {
        return { ok: false };
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      ) {
        return { ok: false };
      }
      snapshot[key] = descriptor.value;
    }
    Object.freeze(snapshot);
    return { ok: true, value: snapshot };
  } catch {
    // A hostile Proxy trap (ownKeys, getPrototypeOf, getOwnPropertyDescriptor)
    // surfaces here as a typed refusal. No property value is ever read through
    // a `get` trap, so a getter — the input's own or a trap's — never runs.
    return { ok: false };
  }
}

/**
 * Whether `value` is a non-negative safe integer (a cap-unit count).
 * Cost bound: O(1) — two number checks.
 */
function isUnitCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Whether `value` is a well-formed identifier. Cost bound: O(1) — one type
 * check, one length bound and one bounded regular-expression match over at
 * most 63 characters.
 */
function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length <= 63 && ID_PATTERN.test(value);
}

/**
 * Whether `value` is an exact `YYYY-MM` calendar month (`01`-`12`). Cost
 * bound: O(1) — one type check, one exact-length check and one bounded
 * regular-expression match over exactly 7 characters.
 */
function isPeriodKey(value: unknown): value is string {
  return typeof value === "string" && value.length === 7 && PERIOD_KEY_PATTERN.test(value);
}

/** The five own keys `parseSpendCap` accepts, no more and no fewer. */
const CAP_KEYS = ["scope", "organizationId", "projectId", "periodKey", "limitUnits"] as const;

/**
 * Parse an unknown value into a `SpendCap`. Every field is read through its
 * own data-property descriptor (see `readExactRecord`), so getters never run
 * and Proxies are refused or bounded; excess keys are refused by the bounded
 * census of `readExactRecord` before any descriptor is read.
 *
 * Cost bound: O(1) per the bounds documented on `readExactRecord`,
 * `isIdentifier`, `isPeriodKey` and `isUnitCount`. Never throws, never
 * echoes input values: every refusal is `invalid-input`.
 */
export function parseSpendCap(raw: unknown): SpendCapParse {
  const read = readExactRecord(raw, CAP_KEYS);
  if (!read.ok) {
    return { ok: false, reason: "invalid-input" };
  }
  const { scope, organizationId, projectId, periodKey, limitUnits } = read.value;
  if (scope !== "organization" && scope !== "project") {
    return { ok: false, reason: "invalid-input" };
  }
  if (!isIdentifier(organizationId)) {
    return { ok: false, reason: "invalid-input" };
  }
  if (scope === "organization") {
    if (projectId !== null) {
      return { ok: false, reason: "invalid-input" };
    }
  } else if (!isIdentifier(projectId)) {
    return { ok: false, reason: "invalid-input" };
  }
  if (!isPeriodKey(periodKey)) {
    return { ok: false, reason: "invalid-input" };
  }
  if (!isUnitCount(limitUnits)) {
    return { ok: false, reason: "invalid-input" };
  }
  const cap: SpendCap = {
    scope,
    organizationId,
    projectId: scope === "project" ? (projectId as string) : null,
    periodKey,
    limitUnits,
  };
  return { ok: true, cap: Object.freeze(cap) };
}

/**
 * Reduce an ISO-8601 timestamp to its UTC calendar month (`YYYY-MM`), purely
 * from the timestamp itself: the system clock is never read and parsing never
 * depends on the host `TZ`, because the string must carry `Z` or an explicit
 * numeric offset and the month is taken from the UTC accessors.
 *
 * Cost bound: O(1) — one type check, one length bound of 64 characters, one
 * bounded regular-expression match over at most 64 characters and one
 * `Date` parse of that bounded string. Non-strings, empty or oversized
 * strings, offset-less strings, non-4-digit-year strings and unparseable or
 * `NaN` dates are refused with `invalid-input`; never throws and never
 * echoes input values.
 */
export function periodKeyOf(iso: unknown): PeriodKeyParse {
  if (typeof iso !== "string" || iso.length === 0 || iso.length > MAX_ISO_LENGTH) {
    return { ok: false, reason: "invalid-input" };
  }
  if (!ISO_TIMESTAMP_PATTERN.test(iso)) {
    return { ok: false, reason: "invalid-input" };
  }
  // Validate the calendar and clock fields from the string itself, so a
  // rollover parse (`2026-02-30` reading as March) is refused rather than
  // silently shifted; the system clock is never read and host `TZ` never
  // matters because the offset is explicit.
  const fields = ISO_TIMESTAMP_PATTERN.exec(iso);
  if (fields === null) {
    return { ok: false, reason: "invalid-input" };
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offH, offM] = fields;
  if (
    !isRealCalendarDay(Number(yearText), Number(monthText), Number(dayText)) ||
    Number(hourText) > 23 ||
    Number(minuteText) > 59 ||
    Number(secondText) > 59 ||
    Number(offH ?? 0) > 23 ||
    Number(offM ?? 0) > 59
  ) {
    return { ok: false, reason: "invalid-input" };
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, reason: "invalid-input" };
  }
  const year = parsed.getUTCFullYear();
  const month = parsed.getUTCMonth() + 1;
  const periodKey = `${year}-${String(month).padStart(2, "0")}`;
  return { ok: true, periodKey };
}

/** The six own keys `decideSpend` accepts, no more and no fewer. */
const DECISION_KEYS = [
  "orgCap",
  "projectCap",
  "orgSpentUnits",
  "projectSpentUnits",
  "requestedUnits",
  "periodKey",
] as const;

/**
 * Decide whether a request may spend `requestedUnits` cap units under an
 * organisation cap and an optional project cap for `periodKey`.
 *
 * The input carries no request `organizationId` or `projectId`: verifying
 * that the caps passed in actually belong to the requesting organisation and
 * project is the caller's duty. This function only checks the caps' internal
 * consistency (same organisation, project cap no larger than the
 * organisation cap) and the arithmetic against the recorded spent units.
 *
 * Cost bound: O(1) — fixed key counts via `readExactRecord`, two nested cap
 * parses each bounded as `parseSpendCap` is, four safe-integer validations
 * and at most two `MAX_SAFE_INTEGER` overflow comparisons. Never throws and
 * never echoes input values: a hostile input is `refuse`/`invalid-input`,
 * a period mismatch parks with `no-cap-for-period`, and an exhausted or
 * overflowing cap parks with `spend-cap` and its scope. Unknown state is
 * never allow.
 */
export function decideSpend(input: unknown): SpendDecision {
  const read = readExactRecord(input, DECISION_KEYS);
  if (!read.ok) {
    return { outcome: "refuse", reason: "invalid-input" };
  }
  const { orgCap, projectCap, orgSpentUnits, projectSpentUnits, requestedUnits, periodKey } =
    read.value;
  const orgParsed = parseSpendCap(orgCap);
  if (!orgParsed.ok || orgParsed.cap.scope !== "organization") {
    return { outcome: "refuse", reason: "invalid-input" };
  }
  let project: SpendCap | null = null;
  if (projectCap !== null) {
    const projectParsed = parseSpendCap(projectCap);
    if (!projectParsed.ok || projectParsed.cap.scope !== "project") {
      return { outcome: "refuse", reason: "invalid-input" };
    }
    project = projectParsed.cap;
  }
  if (
    !isUnitCount(orgSpentUnits) ||
    !isUnitCount(projectSpentUnits) ||
    !isUnitCount(requestedUnits) ||
    !isPeriodKey(periodKey)
  ) {
    return { outcome: "refuse", reason: "invalid-input" };
  }
  if (project !== null && project.organizationId !== orgParsed.cap.organizationId) {
    return { outcome: "refuse", reason: "invalid-input" };
  }
  if (project !== null && project.limitUnits > orgParsed.cap.limitUnits) {
    return { outcome: "refuse", reason: "invalid-input" };
  }
  if (orgParsed.cap.periodKey !== periodKey || (project !== null && project.periodKey !== periodKey)) {
    return { outcome: "park", reason: "no-cap-for-period" };
  }
  if (project !== null) {
    if (
      projectSpentUnits > Number.MAX_SAFE_INTEGER - requestedUnits ||
      projectSpentUnits + requestedUnits > project.limitUnits
    ) {
      return { outcome: "park", reason: "spend-cap", scope: "project" };
    }
  }
  if (
    orgSpentUnits > Number.MAX_SAFE_INTEGER - requestedUnits ||
    orgSpentUnits + requestedUnits > orgParsed.cap.limitUnits
  ) {
    return { outcome: "park", reason: "spend-cap", scope: "organization" };
  }
  return { outcome: "allow" };
}
