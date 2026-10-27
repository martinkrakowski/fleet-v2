/**
 * Pure lease rules both lease stores share (plan §3.6): the decisions for
 * acquire, renew, release and check held over a current run lease
 * (`LaneRunLeaseRecord | null`, K1-1's shape) and a request read from
 * `unknown`. Each decision returns a typed result and never throws, never
 * echoes a value, and never reads a clock (time arrives as `nowIso`). The
 * per-state-directory driver lease record version 1 and its reader live here
 * too.
 *
 * Two design rules all three K3 lanes share:
 * 1. A lease change never moves the run's `revision`. `revision` is the CAS
 *    revision of the run's content, and a web stop or resume carries it
 *    (§3.8); if every renewal bumped it, a heartbeat every poll would refuse
 *    every web request as stale. The lease is guarded by its own fence under
 *    the store's lock instead.
 * 2. The fence never goes back. Acquiring a lease raises the fence by one;
 *    renewing keeps it; releasing keeps holder and fence and sets
 *    `leaseUntilIso` to the release time. A lease is never set back to
 *    `null` once taken, so a holder that lost its lease can never match a
 *    later lease by fence.
 */

import { isCalendarDateTime, readExactPlainRecord } from './plain-record-reads.js';
import { containsSecretShape } from '@fleet/shared';
import type { LaneRunLeaseRecord } from './lane-run-records.js';

/** The longest lease a holder may take or renew to in one step. */
export const LANE_RUN_LEASE_MAX_MS = 10 * 60 * 1000;

export const LEASE_REFUSALS = [
  'invalid-request', 'lease-held', 'lease-moved', 'lease-not-held', 'lease-expired',
] as const;
export type LeaseRefusal = (typeof LEASE_REFUSALS)[number];

export interface LeaseAcquireRequest {
  readonly holderId: string;
  /** The fence the caller read (0 when the lease was null): the CAS value. */
  readonly observedFence: number;
  readonly leaseUntilIso: string;
  readonly nowIso: string;
}
export interface LeaseHoldRequest {
  readonly holderId: string;
  readonly fence: number;
  readonly nowIso: string;
}
export interface LeaseRenewRequest extends LeaseHoldRequest {
  readonly leaseUntilIso: string;
}

export type LeaseDecision =
  | { readonly ok: true; readonly lease: LaneRunLeaseRecord }
  | { readonly ok: false; readonly reason: LeaseRefusal };

const ID_MAX_BYTES = 256;
const LEASE_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const ACQUIRE_KEYS: readonly string[] = ['holderId', 'observedFence', 'leaseUntilIso', 'nowIso'];
const RENEW_KEYS: readonly string[] = ['holderId', 'fence', 'leaseUntilIso', 'nowIso'];
const HOLD_KEYS: readonly string[] = ['holderId', 'fence', 'nowIso'];

/** The K1-1 lease field rules for an id, with the fixed reader messages. */
function idError(field: string, value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    new TextEncoder().encode(value).byteLength > ID_MAX_BYTES
  ) {
    return 'ConductorDriverLease ' + field + ' must be a non-empty id of at most 256 bytes';
  }
  if (containsSecretShape(value)) {
    return 'ConductorDriverLease ' + field + ' contains a secret-shaped value and was refused';
  }
  return null;
}

function isValidHolderId(value: unknown): boolean {
  return idError('holderId', value) === null;
}

function isZonedIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    LEASE_ISO_PATTERN.test(value) &&
    isCalendarDateTime(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isExpired(lease: LaneRunLeaseRecord, nowIso: string): boolean {
  return Date.parse(lease.leaseUntilIso) <= Date.parse(nowIso);
}

/** `leaseUntilIso` is after `nowIso` and at most `LANE_RUN_LEASE_MAX_MS` after it. */
function withinLeaseWindow(leaseUntilIso: string, nowIso: string): boolean {
  const until = Date.parse(leaseUntilIso);
  const now = Date.parse(nowIso);
  return until > now && until - now <= LANE_RUN_LEASE_MAX_MS;
}

/** A safe integer of at least `minimum`: the shared fence rule of every reader. */
function isFence(value: unknown, minimum: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

/** The holder id is valid and every named field is a zoned ISO time. */
function hasValidHolderAndIsoTimes(
  snapshot: Record<string, unknown>,
  isoFields: readonly string[],
): boolean {
  return isValidHolderId(snapshot.holderId) && isoFields.every((field) => isZonedIso(snapshot[field]));
}

/**
 * The shared front half of every request reader: read the plain-object
 * snapshot, then validate the holder and the ISO time fields. Fence rules
 * differ per request and stay with each reader.
 */
function readRequestSnapshot(
  request: unknown,
  keys: readonly string[],
  isoFields: readonly string[],
): Record<string, unknown> | null {
  try {
    const snapshot = readExactPlainRecord(request, keys);
    if (snapshot === null || !hasValidHolderAndIsoTimes(snapshot, isoFields)) {
      return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

/** True when the holder and fence name the current lease (null never matches). */
function holdsCurrentLease(
  current: LaneRunLeaseRecord | null,
  holderId: string,
  fence: number,
): current is LaneRunLeaseRecord {
  return current?.holderId === holderId && current?.fence === fence;
}

function readAcquireRequest(request: unknown): LeaseAcquireRequest | null {
  const snapshot = readRequestSnapshot(request, ACQUIRE_KEYS, ['leaseUntilIso', 'nowIso']);
  if (snapshot === null || !isFence(snapshot.observedFence, 0)) {
    return null;
  }
  return {
    holderId: snapshot.holderId as string,
    observedFence: snapshot.observedFence as number,
    leaseUntilIso: snapshot.leaseUntilIso as string,
    nowIso: snapshot.nowIso as string,
  };
}

function readRenewRequest(request: unknown): LeaseRenewRequest | null {
  const snapshot = readRequestSnapshot(request, RENEW_KEYS, ['leaseUntilIso', 'nowIso']);
  if (snapshot === null || !isFence(snapshot.fence, 1)) {
    return null;
  }
  return {
    holderId: snapshot.holderId as string,
    fence: snapshot.fence as number,
    leaseUntilIso: snapshot.leaseUntilIso as string,
    nowIso: snapshot.nowIso as string,
  };
}

function readHoldRequest(request: unknown): LeaseHoldRequest | null {
  const snapshot = readRequestSnapshot(request, HOLD_KEYS, ['nowIso']);
  if (snapshot === null || !isFence(snapshot.fence, 1)) {
    return null;
  }
  return {
    holderId: snapshot.holderId as string,
    fence: snapshot.fence as number,
    nowIso: snapshot.nowIso as string,
  };
}

export function decideLeaseAcquire(current: LaneRunLeaseRecord | null, request: unknown): LeaseDecision {
  const parsed = readAcquireRequest(request);
  if (parsed === null) {
    return { ok: false, reason: 'invalid-request' };
  }
  if (!withinLeaseWindow(parsed.leaseUntilIso, parsed.nowIso)) {
    return { ok: false, reason: 'invalid-request' };
  }
  if (current !== null && !isExpired(current, parsed.nowIso)) {
    return { ok: false, reason: 'lease-held' };
  }
  const currentFence = current?.fence ?? 0;
  if (parsed.observedFence !== currentFence) {
    return { ok: false, reason: 'lease-moved' };
  }
  const nextFence = currentFence + 1;
  if (!Number.isSafeInteger(nextFence)) {
    return { ok: false, reason: 'invalid-request' };
  }
  return {
    ok: true,
    lease: Object.freeze({
      holderId: parsed.holderId,
      fence: nextFence,
      leaseUntilIso: new Date(parsed.leaseUntilIso).toISOString(),
    }),
  };
}

export function decideLeaseRenew(current: LaneRunLeaseRecord | null, request: unknown): LeaseDecision {
  const parsed = readRenewRequest(request);
  if (parsed === null) {
    return { ok: false, reason: 'invalid-request' };
  }
  if (!withinLeaseWindow(parsed.leaseUntilIso, parsed.nowIso)) {
    return { ok: false, reason: 'invalid-request' };
  }
  if (!holdsCurrentLease(current, parsed.holderId, parsed.fence)) {
    return { ok: false, reason: 'lease-not-held' };
  }
  if (isExpired(current, parsed.nowIso)) {
    return { ok: false, reason: 'lease-expired' };
  }
  return {
    ok: true,
    lease: Object.freeze({
      holderId: current.holderId,
      fence: current.fence,
      leaseUntilIso: new Date(parsed.leaseUntilIso).toISOString(),
    }),
  };
}

export function decideLeaseRelease(current: LaneRunLeaseRecord | null, request: unknown): LeaseDecision {
  const parsed = readHoldRequest(request);
  if (parsed === null) {
    return { ok: false, reason: 'invalid-request' };
  }
  if (!holdsCurrentLease(current, parsed.holderId, parsed.fence)) {
    return { ok: false, reason: 'lease-not-held' };
  }
  if (isExpired(current, parsed.nowIso)) {
    return {
      ok: true,
      lease: Object.freeze({
        holderId: current.holderId,
        fence: current.fence,
        leaseUntilIso: new Date(current.leaseUntilIso).toISOString(),
      }),
    };
  }
  return {
    ok: true,
    lease: Object.freeze({
      holderId: current.holderId,
      fence: current.fence,
      leaseUntilIso: new Date(parsed.nowIso).toISOString(),
    }),
  };
}

/** null when `request` names the current, unexpired lease; else why not. */
export function checkLeaseHeld(current: LaneRunLeaseRecord | null, request: unknown): LeaseRefusal | null {
  const parsed = readHoldRequest(request);
  if (parsed === null) {
    return 'invalid-request';
  }
  if (!holdsCurrentLease(current, parsed.holderId, parsed.fence)) {
    return 'lease-not-held';
  }
  if (isExpired(current, parsed.nowIso)) {
    return 'lease-expired';
  }
  return null;
}

/** True when the lease is null or its leaseUntilIso is at or before nowIso; false for a malformed nowIso. */
export function isLeaseLapsed(current: LaneRunLeaseRecord | null, nowIso: string): boolean {
  if (!isZonedIso(nowIso)) {
    return false;
  }
  if (current === null) {
    return true;
  }
  return Date.parse(current.leaseUntilIso) <= Date.parse(nowIso);
}

export const CONDUCTOR_DRIVER_LEASE_RECORD_VERSION = 1 as const;

/** The one driver lease of a state directory (plan §3.6). Same fields and rules as a run lease. */
export interface ConductorDriverLeaseRecord {
  readonly version: typeof CONDUCTOR_DRIVER_LEASE_RECORD_VERSION;
  readonly holderId: string;
  readonly fence: number;
  readonly leaseUntilIso: string;
}

export type ConductorDriverLeaseRead =
  | { readonly ok: true; readonly record: ConductorDriverLeaseRecord }
  | { readonly ok: false; readonly error: string };

const DRIVER_LEASE_KEYS: readonly string[] = ['version', 'holderId', 'fence', 'leaseUntilIso'];

/** Never throws, never echoes: exactly the four keys; version 1; the K1-1 lease field rules. */
export function readConductorDriverLease(input: unknown): ConductorDriverLeaseRead {
  try {
    const snapshot = readExactPlainRecord(input, DRIVER_LEASE_KEYS);
    if (snapshot === null) {
      return {
        ok: false,
        error: 'ConductorDriverLease must be a record with exactly version, holderId, fence and leaseUntilIso',
      };
    }
    if (snapshot.version !== CONDUCTOR_DRIVER_LEASE_RECORD_VERSION) {
      return { ok: false, error: 'ConductorDriverLease version must be 1' };
    }
    const holderIdMessage = idError('holderId', snapshot.holderId);
    if (holderIdMessage !== null) {
      return { ok: false, error: holderIdMessage };
    }
    if (!isFence(snapshot.fence, 1)) {
      return { ok: false, error: 'ConductorDriverLease fence must be a positive integer' };
    }
    if (!isZonedIso(snapshot.leaseUntilIso)) {
      return { ok: false, error: 'ConductorDriverLease leaseUntilIso must be an ISO-8601 time with a zone' };
    }
    return {
      ok: true,
      record: Object.freeze({
        version: CONDUCTOR_DRIVER_LEASE_RECORD_VERSION,
        holderId: snapshot.holderId as string,
        fence: snapshot.fence as number,
        leaseUntilIso: new Date(snapshot.leaseUntilIso as string).toISOString(),
      }),
    };
  } catch {
    return { ok: false, error: 'ConductorDriverLease input could not be read' };
  }
}
