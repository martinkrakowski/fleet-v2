/**
 * FC8G: pure per-attempt quota reaper decider for sandbox runner attempts.
 * Given a frozen snapshot of an attempt record, its quota limits and a clock
 * reading, either keep the attempt, reap it for a named quota reason, or
 * refuse malformed or hostile input (`refused`), never echoing any supplied
 * value. Domain-only: no port, no adapter, no persistence, no clock read, no
 * randomness, no I/O. The untrusted input is read exactly once through
 * `snapshotPlainData`, so no getter and no Proxy `get` trap ever runs.
 *
 * This is distinct from `reaper-findings.ts`, which classifies zombie
 * worktrees; this decider reaps single attempts against their per-attempt
 * lease and resource quotas.
 */

import {
  snapshotPlainData,
  type IsProxy,
} from '@fleet/shared';

import { isCalendarDateTime } from './plain-record-reads.js';

/** Hard upper bound for `maxWallSeconds` (30 days). */
export const MAX_WALL_SECONDS_LIMIT = 2_592_000;

/** Hard upper bound for `maxCpuSeconds` (30 days of CPU seconds). */
export const MAX_CPU_SECONDS_LIMIT = 2_592_000;

/** Hard upper bound for `maxEgressBytes` (100 GiB). */
export const MAX_EGRESS_BYTES_LIMIT = 107_374_182_400;

/**
 * The attempt lifecycle phases the reaper observes: the active pre-destroy
 * phases (`running`, `sealing`) and the terminal `destroyed` phase, aligned
 * with `AttemptEnvironmentStatus` in `attempt-environment.ts`.
 */
export type AttemptQuotaState = 'running' | 'sealing' | 'destroyed';

/** One attempt's quota-relevant record. */
export interface AttemptQuotaRecord {
  readonly attemptId: string;
  readonly startedAtIso: string;
  readonly leaseExpiresAtIso: string;
  readonly cpuSeconds: number;
  readonly egressBytes: number;
  readonly state: AttemptQuotaState;
}

/** The per-attempt quota limits the reaper enforces. */
export interface AttemptQuotaLimits {
  readonly maxWallSeconds: number;
  readonly maxCpuSeconds: number;
  readonly maxEgressBytes: number;
}

/** The reaper's input: the attempt record, its limits, and the clock reading. */
export interface AttemptQuotaReapInput {
  readonly attempt: AttemptQuotaRecord;
  readonly limits: AttemptQuotaLimits;
  readonly nowIso: string;
}

/** Why an attempt is reaped. */
export type AttemptReapReason = 'lease-expired' | 'wall-time' | 'cpu-quota' | 'egress-quota';

/** Typed outcome: keep the attempt, reap it for a named reason, or refuse. */
export type AttemptReapDecision =
  | { readonly action: 'keep' }
  | { readonly action: 'reap'; readonly reason: AttemptReapReason | 'invalid-input' }
  | { readonly action: 'refused'; readonly reason: 'invalid-input' };

/** The snapshot's sized limits: depth 2, at most 6 keys per object, no arrays, at most 13 nodes, strings at most 128 chars. */
const SNAPSHOT_LIMITS = {
  maxDepth: 4,
  maxKeys: 16,
  maxArrayLength: 0,
  maxNodes: 32,
  maxStringLength: 256,
} as const;

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const ATTEMPT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

const ROOT_KEYS: readonly string[] = ['attempt', 'limits', 'nowIso'];
const ATTEMPT_KEYS: readonly string[] = [
  'attemptId',
  'startedAtIso',
  'leaseExpiresAtIso',
  'cpuSeconds',
  'egressBytes',
  'state',
];
const LIMITS_KEYS: readonly string[] = ['maxWallSeconds', 'maxCpuSeconds', 'maxEgressBytes'];

const STATES: readonly AttemptQuotaState[] = ['running', 'sealing', 'destroyed'];

function defaultIsProxy(): boolean {
  return false;
}

/** The kept decision, as a fresh literal so no input value can leak in. */
const KEEP: AttemptReapDecision = Object.freeze({ action: 'keep' });

function refused(): AttemptReapDecision {
  return { action: 'refused', reason: 'invalid-input' };
}

function reaped(reason: AttemptReapReason | 'invalid-input'): AttemptReapDecision {
  return { action: 'reap', reason };
}

/**
 * A plain object: non-null, non-array, with `Object.prototype` or `null` as
 * its prototype. The snapshot already refused exotic prototypes, so this
 * guards against primitive and array roots on the frozen copy.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Whether the frozen object carries exactly the given own enumerable string
 * keys — no missing key, no extra key, and no own `__proto__` data key (the
 * snapshot copies such a key as data, so it surfaces as an extra key here).
 * O(own keys), one enumeration.
 */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  if (own.length !== keys.length) {
    return false;
  }
  return keys.every((key) => Object.hasOwn(value, key));
}

/** A strict ISO-8601 UTC timestamp naming a real calendar instant. */
function isIsoUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value)) {
    return false;
  }
  return isCalendarDateTime(value) && Number.isFinite(Date.parse(value));
}

/** A non-negative safe integer counter. */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A positive safe integer limit at or below its hard upper bound. */
function isBoundedPositiveSafeInteger(value: unknown, upperBound: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= upperBound
  );
}

/**
 * Decide whether a sandbox attempt should be reaped against its per-attempt
 * lease and quota limits. `input` is untrusted and read exactly once through
 * `snapshotPlainData` with the injected `isProxy` detector (production
 * callers pass `types.isProxy`); the detector runs before any reflection.
 *
 * Fail-closed: an unreadable input is refused; a readable `running`/`sealing`
 * attempt with a valid `attemptId` is reaped as `invalid-input` on any
 * post-snapshot validation failure; a `destroyed` attempt with any invalid
 * field is refused. No input value is ever echoed into a decision.
 */
export function decideAttemptReap(
  input: unknown,
  isProxy: IsProxy = defaultIsProxy,
): AttemptReapDecision {
  const snapshot = snapshotPlainData(input, isProxy, SNAPSHOT_LIMITS);
  if (!snapshot.ok) {
    return refused();
  }

  const root: unknown = snapshot.value;
  if (!isPlainObject(root)) {
    return refused();
  }

  const attempt: unknown = root['attempt'];
  if (!isPlainObject(attempt)) {
    return refused();
  }

  const attemptId: unknown = attempt['attemptId'];
  const attemptIdOk =
    typeof attemptId === 'string' &&
    attemptId.length > 0 &&
    attemptId.trim() === attemptId &&
    ATTEMPT_ID_RE.test(attemptId);

  const state: unknown = attempt['state'];
  const stateOk = STATES.includes(state as AttemptQuotaState);

  if (!attemptIdOk || !stateOk) {
    return refused();
  }

  // From here the attempt phase is known and its id is readable: every
  // post-snapshot validation failure reaps an active attempt and refuses a
  // destroyed one — never `keep` on invalid input.
  const active = state !== 'destroyed';
  const fail = (): AttemptReapDecision => (active ? reaped('invalid-input') : refused());

  if (!hasExactKeys(root, ROOT_KEYS)) {
    return fail();
  }
  if (!hasExactKeys(attempt, ATTEMPT_KEYS)) {
    return fail();
  }

  const limits: unknown = root['limits'];
  // A present-but-non-object `limits` is refused outright (the refusal list
  // covers non-object `attempt` and `limits`), while a missing or key-invalid
  // one fails through the active-attempt rule below.
  if (!isPlainObject(limits)) {
    return refused();
  }
  if (!hasExactKeys(limits, LIMITS_KEYS)) {
    return fail();
  }

  const startedAtIso: unknown = attempt['startedAtIso'];
  const leaseExpiresAtIso: unknown = attempt['leaseExpiresAtIso'];
  const cpuSeconds: unknown = attempt['cpuSeconds'];
  const egressBytes: unknown = attempt['egressBytes'];
  const nowIso: unknown = root['nowIso'];
  const maxWallSeconds: unknown = limits['maxWallSeconds'];
  const maxCpuSeconds: unknown = limits['maxCpuSeconds'];
  const maxEgressBytes: unknown = limits['maxEgressBytes'];

  if (
    !isIsoUtc(startedAtIso) ||
    !isIsoUtc(leaseExpiresAtIso) ||
    !isIsoUtc(nowIso) ||
    !isNonNegativeSafeInteger(cpuSeconds) ||
    !isNonNegativeSafeInteger(egressBytes) ||
    !isBoundedPositiveSafeInteger(maxWallSeconds, MAX_WALL_SECONDS_LIMIT) ||
    !isBoundedPositiveSafeInteger(maxCpuSeconds, MAX_CPU_SECONDS_LIMIT) ||
    !isBoundedPositiveSafeInteger(maxEgressBytes, MAX_EGRESS_BYTES_LIMIT)
  ) {
    return fail();
  }

  const nowMs = Date.parse(nowIso);
  const startedMs = Date.parse(startedAtIso);
  if (nowMs < startedMs) {
    return fail();
  }

  if (active) {
    // Fixed precedence: lease, wall time, CPU quota, egress quota. Equality
    // with a limit keeps; any excess reaps. The lease instant itself reaps.
    if (nowMs >= Date.parse(leaseExpiresAtIso)) {
      return reaped('lease-expired');
    }
    if (nowMs - startedMs > maxWallSeconds * 1000) {
      return reaped('wall-time');
    }
    if (cpuSeconds > maxCpuSeconds) {
      return reaped('cpu-quota');
    }
    if (egressBytes > maxEgressBytes) {
      return reaped('egress-quota');
    }
  }

  // A destroyed attempt is idempotently kept, even with an expired lease or
  // exceeded quotas; a valid active attempt within all quotas is kept too.
  return KEEP;
}
