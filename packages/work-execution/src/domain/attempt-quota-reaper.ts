/**
 * FC8G: pure per-attempt quota reaper decider for sandbox runner attempts.
 *
 * Given a frozen snapshot of an attempt record, its quota limits and a
 * `nowIso` clock reading, decide whether the attempt must be reaped (with a
 * fixed-precedence reason), kept, or the input is invalid (fail closed: an
 * unreadable or invalid input is never `keep`). Domain-only: no port, no
 * adapter, no persistence, no clock read, no randomness, no I/O.
 *
 * The untrusted input is read exactly once through `snapshotPlainData`, so
 * no getter and no Proxy `get` trap ever runs; afterwards every check reads
 * only the frozen, plain copy. No input value is ever echoed into a
 * decision.
 */

import { snapshotPlainData, type IsProxy, type PlainDataLimits } from '@fleet/shared';

import { isCalendarDateTime } from './plain-record-reads.js';

/** Hard upper bound for `maxWallSeconds` (30 days). */
export const MAX_WALL_SECONDS_LIMIT = 2_592_000;

/** Hard upper bound for `maxCpuSeconds` (30 days). */
export const MAX_CPU_SECONDS_LIMIT = 2_592_000;

/** Hard upper bound for `maxEgressBytes` (100 GiB). */
export const MAX_EGRESS_BYTES_LIMIT = 107_374_182_400;

/**
 * The attempt lifecycle phases the reaper evaluates. `'destroyed'` aligns
 * with `AttemptEnvironmentStatus`; `'running'` and `'sealing'` are the
 * active pre-destroy phases.
 */
export type AttemptQuotaState = 'running' | 'sealing' | 'destroyed';

/** One attempt record the reaper evaluates. */
export interface AttemptQuotaRecord {
  readonly attemptId: string;
  readonly startedAtIso: string;
  readonly leaseExpiresAtIso: string;
  readonly cpuSeconds: number;
  readonly egressBytes: number;
  readonly state: AttemptQuotaState;
}

/** The quota limits applied to an attempt. */
export interface AttemptQuotaLimits {
  readonly maxWallSeconds: number;
  readonly maxCpuSeconds: number;
  readonly maxEgressBytes: number;
}

/** The reaper's input: an attempt record, its limits, and the clock reading. */
export interface AttemptQuotaReapInput {
  readonly attempt: AttemptQuotaRecord;
  readonly limits: AttemptQuotaLimits;
  readonly nowIso: string;
}

/** Why an attempt is reaped. `'invalid-input'` is the fail-closed reap. */
export type AttemptReapReason = 'lease-expired' | 'wall-time' | 'cpu-quota' | 'egress-quota';

/** The typed decision: keep the attempt, reap it, or refuse malformed input. */
export type AttemptReapDecision =
  | { readonly action: 'keep' }
  | { readonly action: 'reap'; readonly reason: AttemptReapReason | 'invalid-input' }
  | { readonly action: 'refused'; readonly reason: 'invalid-input' };

/**
 * Domain-sized snapshot bounds: 1 root object + 1 attempt object + 1 limits
 * object + 6 attempt fields + 3 limit fields + 1 `nowIso` string = 13 nodes
 * (<= 32). The deepest value sits at depth 2 (root at 0, `attempt`/`limits`
 * at 1, their fields at 2), so `maxDepth` is 4; the widest object has 6 own
 * keys (<= 16); arrays are disallowed (`maxArrayLength: 0`); strings are at
 * most 128 chars (<= 256).
 */
export const ATTEMPT_QUOTA_REAP_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 4,
  maxKeys: 16,
  maxArrayLength: 0,
  maxNodes: 32,
  maxStringLength: 256,
});

const ROOT_KEYS: readonly string[] = ['attempt', 'limits', 'nowIso'];
const ATTEMPT_KEYS: readonly string[] = [
  'attemptId',
  'startedAtIso',
  'leaseExpiresAtIso',
  'cpuSeconds',
  'egressBytes',
  'state',
];
const LIMIT_KEYS: readonly string[] = ['maxWallSeconds', 'maxCpuSeconds', 'maxEgressBytes'];

const STATES: readonly AttemptQuotaState[] = ['running', 'sealing', 'destroyed'];

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function keep(): AttemptReapDecision {
  return Object.freeze({ action: 'keep' as const });
}

function reap(reason: AttemptReapReason | 'invalid-input'): AttemptReapDecision {
  return Object.freeze({ action: 'reap' as const, reason });
}

function refused(): AttemptReapDecision {
  return Object.freeze({ action: 'refused' as const, reason: 'invalid-input' as const });
}

/** Whether the frozen snapshot value is a non-array plain object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether the frozen snapshot record carries exactly the required own keys:
 * every key must be a required one and their count must match, so missing,
 * extra, and own `__proto__`/polluting keys are all refused in one O(own
 * keys) enumeration. The snapshot copy holds only own enumerable data
 * properties, so `Object.keys` never reflects on untrusted values.
 */
function hasExactKeys(record: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(record);
  if (keys.length !== required.length) {
    return false;
  }
  for (const key of keys) {
    if (!required.includes(key)) {
      return false;
    }
  }
  return true;
}

function isAttemptId(value: unknown): value is string {
  return typeof value === 'string' && ATTEMPT_ID_PATTERN.test(value) && value.trim() === value;
}

/** A strict ISO-8601 UTC timestamp naming a real calendar instant. */
function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_UTC_PATTERN.test(value) &&
    isCalendarDateTime(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isNonNegativeCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveLimit(value: unknown, upperBound: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= upperBound;
}

/**
 * Decides whether a sandbox attempt must be reaped. Reads `input` once
 * through `snapshotPlainData` (bounded by `ATTEMPT_QUOTA_REAP_LIMITS`), then
 * validates exact keys and field shapes on the frozen copy, then applies the
 * fixed reap precedence: lease-expired > wall-time > cpu-quota >
 * egress-quota. `isProxy` is required, never defaulted: a missing detector
 * must not silently let a Proxy through, so infrastructure callers pass
 * `types.isProxy`. A `'destroyed'` attempt is kept idempotently. Every failure
 * is fail-closed: an unreadable or invalid input is never `keep`, and no
 * input value is ever echoed into a decision.
 */
export function decideAttemptReap(input: unknown, isProxy: IsProxy): AttemptReapDecision {
  // Single bounded read: the detector runs before any reflection, accessors
  // and Proxies are refused without running, and every hostile shape is a
  // typed refusal here regardless of path.
  const snap = snapshotPlainData(input, isProxy, ATTEMPT_QUOTA_REAP_LIMITS);
  if (!snap.ok) {
    return refused();
  }
  const root = snap.value;
  if (!isPlainRecord(root)) {
    return refused();
  }
  const attempt = root['attempt'];
  if (!isPlainRecord(attempt)) {
    return refused();
  }

  // Fail-closed classification: while the attempt is an active pre-destroy
  // record with a valid readable `attemptId`, any later validation failure
  // reaps with 'invalid-input'; otherwise every failure is refused.
  const attemptIdValid = isAttemptId(attempt['attemptId']);
  const state = attempt['state'];
  const stateActive = state === 'running' || state === 'sealing';
  const invalid = (): AttemptReapDecision =>
    stateActive && attemptIdValid ? reap('invalid-input') : refused();

  if (!hasExactKeys(root, ROOT_KEYS) || !hasExactKeys(attempt, ATTEMPT_KEYS)) {
    return invalid();
  }

  const limits = root['limits'];
  if (!isPlainRecord(limits) || !hasExactKeys(limits, LIMIT_KEYS)) {
    return invalid();
  }

  if (!attemptIdValid || typeof state !== 'string' || !STATES.includes(state as AttemptQuotaState)) {
    return invalid();
  }

  const startedAtIso = attempt['startedAtIso'];
  const leaseExpiresAtIso = attempt['leaseExpiresAtIso'];
  const nowIso = root['nowIso'];
  if (!isTimestamp(startedAtIso) || !isTimestamp(leaseExpiresAtIso) || !isTimestamp(nowIso)) {
    return invalid();
  }

  const cpuSeconds = attempt['cpuSeconds'];
  const egressBytes = attempt['egressBytes'];
  if (!isNonNegativeCounter(cpuSeconds) || !isNonNegativeCounter(egressBytes)) {
    return invalid();
  }

  const maxWallSeconds = limits['maxWallSeconds'];
  const maxCpuSeconds = limits['maxCpuSeconds'];
  const maxEgressBytes = limits['maxEgressBytes'];
  if (
    !isPositiveLimit(maxWallSeconds, MAX_WALL_SECONDS_LIMIT) ||
    !isPositiveLimit(maxCpuSeconds, MAX_CPU_SECONDS_LIMIT) ||
    !isPositiveLimit(maxEgressBytes, MAX_EGRESS_BYTES_LIMIT)
  ) {
    return invalid();
  }

  const nowMs = Date.parse(nowIso);
  if (nowMs < Date.parse(startedAtIso)) {
    return invalid();
  }

  // Idempotent: an already-destroyed attempt is never reaped again, even
  // with an expired lease or exceeded quotas.
  if (state === 'destroyed') {
    return keep();
  }

  // Fixed precedence: lease, then wall time, then cpu, then egress. The
  // lease instant itself reaps; the quota comparisons reap only above the
  // limit (equal is keep).
  if (nowMs >= Date.parse(leaseExpiresAtIso)) {
    return reap('lease-expired');
  }
  if (nowMs - Date.parse(startedAtIso) > maxWallSeconds * 1000) {
    return reap('wall-time');
  }
  if (cpuSeconds > maxCpuSeconds) {
    return reap('cpu-quota');
  }
  if (egressBytes > maxEgressBytes) {
    return reap('egress-quota');
  }
  return keep();
}
