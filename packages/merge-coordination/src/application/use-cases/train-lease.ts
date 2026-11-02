/**
 * Pure lease rules for one merge train's per-train lease: the decisions for
 * acquire, renew, release and check held over a current train lease
 * (`TrainLeaseRecord | null`) and a request read from `unknown`. Each
 * decision returns a typed result and never throws, never echoes a value,
 * and never reads a clock (time arrives as `nowIso`).
 *
 * Two design rules carried over from the work-execution lease:
 * 1. A lease change never moves the train's revision. The lease is guarded
 *    by its own fence under the store's lock instead.
 * 2. The fence never goes back. Acquiring a lease raises the fence by one;
 *    renewing keeps it; releasing keeps holder and fence and sets
 *    `leaseUntilIso` to the release time. A lease is never set back to
 *    `null` once taken, so a holder that lost its lease can never match a
 *    later lease by fence.
 */

import { containsSecretShape } from '@fleet/shared';

/** The longest lease a holder may take or renew to in one step. */
export const TRAIN_LEASE_MAX_MS = 10 * 60 * 1000;

export const TRAIN_LEASE_REFUSALS = [
  'invalid-request', 'lease-held', 'lease-moved', 'lease-not-held', 'lease-expired',
] as const;
export type TrainLeaseRefusal = (typeof TRAIN_LEASE_REFUSALS)[number];

/** The current holder of one train's lease; never a credential. */
export interface TrainLeaseRecord {
  readonly holderId: string;
  readonly fence: number;
  readonly leaseUntilIso: string;
}

export interface TrainLeaseAcquireRequest {
  readonly holderId: string;
  /** The fence the caller read (0 when the lease was null): the CAS value. */
  readonly observedFence: number;
  readonly leaseUntilIso: string;
  readonly nowIso: string;
}
export interface TrainLeaseHoldRequest {
  readonly holderId: string;
  readonly fence: number;
  readonly nowIso: string;
}
export interface TrainLeaseRenewRequest extends TrainLeaseHoldRequest {
  readonly leaseUntilIso: string;
}

export type TrainLeaseDecision =
  | { readonly ok: true; readonly lease: TrainLeaseRecord }
  | { readonly ok: false; readonly reason: TrainLeaseRefusal };

const ID_MAX_BYTES = 256;
const LEASE_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const ACQUIRE_KEYS: readonly string[] = ['holderId', 'observedFence', 'leaseUntilIso', 'nowIso'];
const RENEW_KEYS: readonly string[] = ['holderId', 'fence', 'leaseUntilIso', 'nowIso'];
const HOLD_KEYS: readonly string[] = ['holderId', 'fence', 'nowIso'];

/**
 * Read `value` as a non-null, non-array plain object whose own keys are
 * exactly `keys`; null otherwise. Reads inside try/catch, never throws.
 */
function readExactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const own = Object.keys(record);
    if (own.length !== keys.length || !keys.every((key) => Object.prototype.hasOwnProperty.call(record, key))) {
      return null;
    }
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      copy[key] = record[key];
    }
    return copy;
  } catch {
    return null;
  }
}

/** A zoned ISO-8601 time string that also parses as a calendar date. */
function isZonedIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    LEASE_ISO_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/** The train lease field rules for an id: non-empty, at most 256 UTF-8 bytes, never secret-shaped. */
function isValidHolderId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    new TextEncoder().encode(value).byteLength <= ID_MAX_BYTES &&
    !containsSecretShape(value)
  );
}

function isExpired(lease: TrainLeaseRecord, nowIso: string): boolean {
  return Date.parse(lease.leaseUntilIso) <= Date.parse(nowIso);
}

/** `leaseUntilIso` is after `nowIso` and at most `TRAIN_LEASE_MAX_MS` after it. */
function withinLeaseWindow(leaseUntilIso: string, nowIso: string): boolean {
  const until = Date.parse(leaseUntilIso);
  const now = Date.parse(nowIso);
  return until > now && until - now <= TRAIN_LEASE_MAX_MS;
}

/** A safe integer of at least `minimum`: the shared fence rule of every reader. */
function isFence(value: unknown, minimum: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
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
    const snapshot = readExactKeys(request, keys);
    if (snapshot === null) {
      return null;
    }
    if (!isValidHolderId(snapshot.holderId) || !isoFields.every((field) => isZonedIso(snapshot[field]))) {
      return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

/** True when the holder and fence name the current lease (null never matches). */
function holdsCurrentLease(
  current: TrainLeaseRecord | null,
  holderId: string,
  fence: number,
): current is TrainLeaseRecord {
  return current?.holderId === holderId && current?.fence === fence;
}

function readAcquireRequest(request: unknown): TrainLeaseAcquireRequest | null {
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

function readRenewRequest(request: unknown): TrainLeaseRenewRequest | null {
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

function readHoldRequest(request: unknown): TrainLeaseHoldRequest | null {
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

/** Acquire one train's lease by CAS on the fence over a null or lapsed lease. */
export function decideTrainLeaseAcquire(current: TrainLeaseRecord | null, request: unknown): TrainLeaseDecision {
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

/** Renew one train's lease: the current holder with its fence keeps the fence. */
export function decideTrainLeaseRenew(current: TrainLeaseRecord | null, request: unknown): TrainLeaseDecision {
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

/** Release one train's lease: holder and fence are kept, the lease ends now. */
export function decideTrainLeaseRelease(current: TrainLeaseRecord | null, request: unknown): TrainLeaseDecision {
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
export function checkTrainLeaseHeld(current: TrainLeaseRecord | null, request: unknown): TrainLeaseRefusal | null {
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

/** Read unknown input as a `TrainLeaseRecord`; null when it does not match. Never throws, never echoes. */
export function readTrainLeaseRecord(value: unknown): TrainLeaseRecord | null {
  try {
    const snapshot = readExactKeys(value, ['holderId', 'fence', 'leaseUntilIso']);
    if (
      snapshot === null ||
      !isValidHolderId(snapshot.holderId) ||
      !isFence(snapshot.fence, 1) ||
      !isZonedIso(snapshot.leaseUntilIso)
    ) {
      return null;
    }
    return Object.freeze({
      holderId: snapshot.holderId as string,
      fence: snapshot.fence as number,
      leaseUntilIso: new Date(snapshot.leaseUntilIso as string).toISOString(),
    });
  } catch {
    return null;
  }
}
