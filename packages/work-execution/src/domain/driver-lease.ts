/**
 * FC17E: pure driver standby lease takeover decider (plan FC-17.5). Given a
 * standby candidate, the driver lease record it read (`null` when free), the
 * current time and the contenders it knows of, either acquire, renew or
 * refuse with a typed reason. Domain-only: no port, no adapter, no
 * persistence, no clock read, no randomness, no I/O.
 *
 * Hostile-input rule: `input` is read exactly once through
 * `snapshotPlainData`, which runs the injected `isProxy` detector before any
 * reflection, reads descriptors without invoking getters, and refuses
 * non-plain data with a typed reason. No rejected value is ever echoed.
 */

import { containsSecretShape, snapshotPlainData } from '@fleet/shared';
import type { IsProxy } from '@fleet/shared';
import type { LaneRunLeaseRecord } from './lane-run-records.js';
import { LANE_RUN_LEASE_MAX_MS } from './lane-run-lease.js';
import { isCalendarDateTime } from './plain-record-reads.js';

/** Hard cap on how many competing candidate ids a takeover request may carry. */
export const MAX_COMPETING_CANDIDATES = 64;

/** The default driver lease duration; at most `LANE_RUN_LEASE_MAX_MS`. */
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

/** Code-unit string comparison; deterministic across engines. */
function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A non-empty trimmed string of at most 256 UTF-8 bytes without a secret shape. */
function isValidCandidateId(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }
  if (new TextEncoder().encode(value).byteLength > ID_MAX_BYTES) {
    return false;
  }
  return !containsSecretShape(value);
}

/** Zoned ISO-8601 naming a real calendar instant that `Date.parse` accepts. */
function isZonedIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    LEASE_ISO_PATTERN.test(value) &&
    isCalendarDateTime(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/** Map a snapshot refusal to a field-naming driver-lease refusal; never echoes a value. */
function mapSnapshotFailure(path: string | null, reason: string): DriverLeaseRefusalReason {
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
    return reason === 'too-many-items' ? 'too-many-competing-candidates' : 'invalid-competing-candidates';
  }
  if (path === 'leaseDurationMs') {
    return 'invalid-lease-duration';
  }
  return 'invalid-input';
}

/** Every own key of the frozen snapshot copy is in the allowed set (O(K)). */
function hasOnlyAllowedKeys(snapshot: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(snapshot).every((key) => allowed.includes(key));
}

/** The lease fields required on a non-null lease record are present. */
function hasRequiredLeaseKeys(lease: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(lease, 'holderId') &&
    Object.hasOwn(lease, 'fence') &&
    Object.hasOwn(lease, 'leaseUntilIso')
  );
}

function refused(reason: DriverLeaseRefusalReason): DriverLeaseDecision {
  return { outcome: 'refused', reason };
}

/**
 * The takeover decision. `input` is read once through `snapshotPlainData`
 * (O(maxNodes) traversal, O(1) length pre-gate on arrays, O(K) engine bound
 * on `Reflect.ownKeys` per object, O(1) per-id byte check); the decision
 * itself is O(cap) over the competing ids. Neither the input nor any read
 * value is mutated; a getter and a reflection trap never run; no rejected
 * value is echoed. Never throws.
 */
export function decideDriverLease(input: unknown, isProxy: IsProxy = () => false): DriverLeaseDecision {
  const snapshot = snapshotPlainData(input, isProxy, {
    maxDepth: 2,
    maxKeys: 5,
    maxArrayLength: MAX_COMPETING_CANDIDATES,
    maxNodes: 128,
    maxStringLength: 512,
  });
  if (!snapshot.ok) {
    return refused(mapSnapshotFailure(snapshot.path, snapshot.reason));
  }
  const value = snapshot.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return refused('invalid-input');
  }
  const root = value as Record<string, unknown>;
  if (!hasOnlyAllowedKeys(root, INPUT_KEYS)) {
    return refused('invalid-input');
  }
  if (!Object.hasOwn(root, 'candidateId') || !Object.hasOwn(root, 'nowIso') || !Object.hasOwn(root, 'lease')) {
    return refused(
      Object.hasOwn(root, 'candidateId')
        ? Object.hasOwn(root, 'nowIso')
          ? 'invalid-lease'
          : 'invalid-now-iso'
        : 'invalid-candidate-id',
    );
  }
  const { candidateId, nowIso } = root;
  if (!isValidCandidateId(candidateId)) {
    return refused('invalid-candidate-id');
  }
  if (!isZonedIso(nowIso)) {
    return refused('invalid-now-iso');
  }

  // Lease record: null or a plain record with only the four allowed keys.
  let lease: LaneRunLeaseRecord | null = null;
  if (root.lease !== null) {
    if (
      typeof root.lease !== 'object' ||
      Array.isArray(root.lease) ||
      !hasOnlyAllowedKeys(root.lease as Record<string, unknown>, LEASE_KEYS) ||
      !hasRequiredLeaseKeys(root.lease as Record<string, unknown>)
    ) {
      return refused('invalid-lease');
    }
    const record = root.lease as Record<string, unknown>;
    if (Object.hasOwn(record, 'version') && record.version !== 1) {
      return refused('invalid-lease');
    }
    if (!isValidCandidateId(record.holderId)) {
      return refused('invalid-lease');
    }
    if (!Number.isSafeInteger(record.fence) || (record.fence as number) < 1) {
      return refused('invalid-lease');
    }
    if (!isZonedIso(record.leaseUntilIso)) {
      return refused('invalid-lease');
    }
    lease = {
      holderId: record.holderId as string,
      fence: record.fence as number,
      leaseUntilIso: record.leaseUntilIso as string,
    };
  }

  // Competing candidate ids, when present: a dense array of valid ids.
  if (Object.hasOwn(root, 'competingCandidateIds')) {
    const ids = root.competingCandidateIds;
    if (!Array.isArray(ids) || !(ids as readonly unknown[]).every((id) => isValidCandidateId(id))) {
      return refused('invalid-competing-candidates');
    }
  }

  // Optional lease duration in milliseconds.
  let ttlMs = DEFAULT_DRIVER_LEASE_TTL_MS;
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
    ttlMs = duration;
  }

  const now = Date.parse(nowIso);
  const nextLeaseUntilIso = new Date(now + ttlMs).toISOString();
  const live = lease !== null && Date.parse(lease.leaseUntilIso) > now;

  if (live) {
    if (candidateId === (lease as LaneRunLeaseRecord).holderId) {
      return {
        outcome: 'renewed',
        lease: Object.freeze({
          holderId: (lease as LaneRunLeaseRecord).holderId,
          fence: (lease as LaneRunLeaseRecord).fence,
          leaseUntilIso: nextLeaseUntilIso,
        }),
      };
    }
    return refused('lease-held');
  }

  // Lease is null or expired: the deterministic code-unit tie-break decides.
  if (Object.hasOwn(root, 'competingCandidateIds')) {
    for (const otherId of root.competingCandidateIds as readonly unknown[]) {
      if (compareCodeUnit(otherId as string, candidateId as string) < 0) {
        return refused('lost-tiebreak');
      }
    }
  }
  const nextFence = (lease?.fence ?? 0) + 1;
  if (!Number.isSafeInteger(nextFence)) {
    return refused('invalid-lease');
  }
  return {
    outcome: 'acquired',
    lease: Object.freeze({
      holderId: candidateId as string,
      fence: nextFence,
      leaseUntilIso: nextLeaseUntilIso,
    }),
  };
}
