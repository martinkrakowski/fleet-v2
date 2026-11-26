/**
 * FC17E: pure driver standby lease takeover decider. Given a `unknown`
 * takeover request (the candidate id, the current lease or `null`, the time,
 * optional competing candidate ids and an optional duration), either acquire
 * or renew the driver lease, or refuse malformed, hostile or losing input
 * with a typed reason that never echoes a value.
 *
 * Domain-only: no filesystem, no subprocess, no network, no clock read, no
 * randomness. Time arrives as `nowIso`; hostility is read through the shared
 * descriptor-based snapshot, so no getter and no Proxy trap ever runs.
 */

import { isCalendarDateTime } from './plain-record-reads.js';
import { LANE_RUN_LEASE_MAX_MS } from './lane-run-lease.js';
import type { LaneRunLeaseRecord } from './lane-run-records.js';
import { containsSecretShape, snapshotPlainData } from '@fleet/shared';
import type { IsProxy, PlainDataLimits, PlainDataRefusalReason } from '@fleet/shared';

/** Hard cap on how many competing candidates a single takeover may name. */
export const MAX_COMPETING_CANDIDATES = 64;

/** The default takeover lease duration; capped at the run-lease maximum. */
export const DEFAULT_DRIVER_LEASE_TTL_MS = Math.min(60_000, LANE_RUN_LEASE_MAX_MS);

export type DriverLeaseRefusalReason =
  | 'invalid-input'
  | 'invalid-lease'
  | 'invalid-candidate-id'
  | 'invalid-now-iso'
  | 'invalid-competing-candidates'
  | 'too-many-competing-candidates'
  | 'invalid-lease-duration'
  | 'lease-held'
  | 'lost-tiebreak';

export type DriverLeaseDecision =
  | { readonly outcome: 'acquired'; readonly lease: LaneRunLeaseRecord }
  | { readonly outcome: 'renewed'; readonly lease: LaneRunLeaseRecord }
  | { readonly outcome: 'refused'; readonly reason: DriverLeaseRefusalReason };

const ID_MAX_BYTES = 256;
const LEASE_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const INPUT_KEYS: readonly string[] = [
  'lease',
  'candidateId',
  'nowIso',
  'competingCandidateIds',
  'leaseDurationMs',
];
const LEASE_KEYS: readonly string[] = ['holderId', 'fence', 'leaseUntilIso', 'version'];

/** The exact limits a takeover request is read through (see the plan sizing). */
const DRIVER_LEASE_LIMITS: Partial<PlainDataLimits> = {
  maxDepth: 2,
  maxKeys: 5,
  maxArrayLength: MAX_COMPETING_CANDIDATES,
  maxNodes: 128,
  maxStringLength: 512,
};

/** Code-unit string comparison; deterministic across engines. */
function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The K1-1 lease field rules for an id. Never throws, never echoes. */
function idError(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    new TextEncoder().encode(value).byteLength > ID_MAX_BYTES
  ) {
    return 'driver lease id must be a non-empty trimmed id of at most 256 bytes';
  }
  if (containsSecretShape(value)) {
    return 'driver lease id contains a secret-shaped value and was refused';
  }
  return null;
}

function isValidCandidateId(value: unknown): boolean {
  return typeof value === 'string' && idError(value) === null;
}

/** A zoned ISO-8601 time naming a real calendar instant. */
function isZonedIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    LEASE_ISO_PATTERN.test(value) &&
    isCalendarDateTime(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/**
 * Map a snapshot refusal to the takeover refusal: the path names the field at
 * fault (any reason on that field reads the same), `null` means the root was
 * not even readable as the request record.
 */
function mapSnapshotRefusal(
  reason: PlainDataRefusalReason,
  path: string | null,
): DriverLeaseRefusalReason {
  if (path === null) {
    return 'invalid-input';
  }
  if (path === 'candidateId') {
    return 'invalid-candidate-id';
  }
  if (path === 'nowIso') {
    return 'invalid-now-iso';
  }
  if (path === 'lease' || path.startsWith('lease.') || path.startsWith('lease[')) {
    return 'invalid-lease';
  }
  if (
    path === 'competingCandidateIds' ||
    path.startsWith('competingCandidateIds[') ||
    path.startsWith('competingCandidateIds.')
  ) {
    return reason === 'too-many-items'
      ? 'too-many-competing-candidates'
      : 'invalid-competing-candidates';
  }
  if (path === 'leaseDurationMs') {
    return 'invalid-lease-duration';
  }
  return 'invalid-input';
}

function refused(reason: DriverLeaseRefusalReason): DriverLeaseDecision {
  return { outcome: 'refused', reason };
}

/** True when the frozen lease snapshot's own keys are exactly a subset of `LEASE_KEYS`. */
function hasOnlyAllowedKeys(lease: object): boolean {
  return Reflect.ownKeys(lease).every(
    (key) => typeof key === 'string' && LEASE_KEYS.includes(key),
  );
}

/** Validate the frozen lease snapshot's fields (keys already checked). */
function isValidLeaseFields(lease: Record<string, unknown>): boolean {
  if (
    !isValidCandidateId(lease.holderId) ||
    !isZonedIso(lease.leaseUntilIso) ||
    !(Number.isSafeInteger(lease.fence) && (lease.fence as number) >= 1)
  ) {
    return false;
  }
  if (Object.hasOwn(lease, 'version') && lease.version !== 1) {
    return false;
  }
  return true;
}

/**
 * The pure takeover decider. The injected `isProxy` is a separate positional
 * parameter (never an options field): infrastructure passes
 * `types.isProxy` so this module never imports a runtime specifier.
 */
export function decideDriverLease(
  input: unknown,
  isProxy: IsProxy = () => false,
): DriverLeaseDecision {
  // One hostile-input read; the snapshot runs the detector before any
  // reflection, reads descriptors without invoking getters, refuses
  // non-plain data and checks array length in O(1) before ownKeys.
  const snapshot = snapshotPlainData(input, isProxy, DRIVER_LEASE_LIMITS);
  if (!snapshot.ok) {
    return refused(mapSnapshotRefusal(snapshot.reason, snapshot.path));
  }
  const value = snapshot.value;
  // The snapshot accepts null, primitives and arrays at the root.
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return refused('invalid-input');
  }

  // An own `__proto__` key is copied as data, so the allowed key set is
  // checked explicitly on the frozen plain object.
  const root = value as Record<string, unknown>;
  if (!Reflect.ownKeys(root).every((key) => typeof key === 'string' && INPUT_KEYS.includes(key))) {
    return refused('invalid-input');
  }

  // Required keys; optional fields are omitted when absent, never `undefined`.
  if (!Object.hasOwn(root, 'candidateId')) {
    return refused('invalid-candidate-id');
  }
  if (!Object.hasOwn(root, 'nowIso')) {
    return refused('invalid-now-iso');
  }
  if (!Object.hasOwn(root, 'lease')) {
    return refused('invalid-lease');
  }

  if (!isValidCandidateId(root.candidateId)) {
    return refused('invalid-candidate-id');
  }
  const candidateId = root.candidateId as string;
  if (!isZonedIso(root.nowIso)) {
    return refused('invalid-now-iso');
  }
  const nowIso = root.nowIso as string;

  const rawLease = root.lease;
  if (
    rawLease !== null &&
    (typeof rawLease !== 'object' || Array.isArray(rawLease) || !hasOnlyAllowedKeys(rawLease))
  ) {
    return refused('invalid-lease');
  }
  const leaseRecord =
    rawLease === null ? null : (rawLease as unknown as Record<string, unknown>);
  if (leaseRecord !== null) {
    if (
      !Object.hasOwn(leaseRecord, 'holderId') ||
      !Object.hasOwn(leaseRecord, 'fence') ||
      !Object.hasOwn(leaseRecord, 'leaseUntilIso') ||
      !isValidLeaseFields(leaseRecord)
    ) {
      return refused('invalid-lease');
    }
  }

  if (Object.hasOwn(root, 'competingCandidateIds')) {
    const competitors = root.competingCandidateIds;
    if (!Array.isArray(competitors)) {
      return refused('invalid-competing-candidates');
    }
    if (!competitors.every((id) => isValidCandidateId(id))) {
      return refused('invalid-competing-candidates');
    }
  }
  const competingCandidateIds = Object.hasOwn(root, 'competingCandidateIds')
    ? (root.competingCandidateIds as readonly string[])
    : [];

  if (Object.hasOwn(root, 'leaseDurationMs')) {
    const duration = root.leaseDurationMs;
    if (
      typeof duration !== 'number' ||
      !Number.isSafeInteger(duration) ||
      duration <= 0 ||
      duration > LANE_RUN_LEASE_MAX_MS
    ) {
      return refused('invalid-lease-duration');
    }
  }
  const ttlMs = Object.hasOwn(root, 'leaseDurationMs')
    ? (root.leaseDurationMs as number)
    : DEFAULT_DRIVER_LEASE_TTL_MS;

  const nowMs = Date.parse(nowIso);
  const nextLeaseUntilIso = new Date(nowMs + ttlMs).toISOString();

  // Live lease: the exact expiry instant counts as expired.
  const leaseLive =
    leaseRecord !== null && Date.parse(leaseRecord.leaseUntilIso as string) > nowMs;
  if (leaseLive) {
    if (candidateId === (leaseRecord?.holderId as string)) {
      return {
        outcome: 'renewed',
        lease: Object.freeze({
          holderId: leaseRecord?.holderId as string,
          fence: leaseRecord?.fence as number,
          leaseUntilIso: nextLeaseUntilIso,
        }),
      };
    }
    return refused('lease-held');
  }

  // Null or expired lease: the deterministic code-unit tie-break decides.
  if (competingCandidateIds.some((otherId) => compareCodeUnit(otherId, candidateId) < 0)) {
    return refused('lost-tiebreak');
  }
  const currentFence = leaseRecord === null ? 0 : (leaseRecord.fence as number);
  const nextFence = currentFence + 1;
  if (!Number.isSafeInteger(nextFence)) {
    return refused('invalid-lease');
  }
  return {
    outcome: 'acquired',
    lease: Object.freeze({
      holderId: candidateId,
      fence: nextFence,
      leaseUntilIso: nextLeaseUntilIso,
    }),
  };
}
