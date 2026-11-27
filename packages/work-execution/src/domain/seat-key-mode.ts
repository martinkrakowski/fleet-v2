/**
 * A pure compatibility guard for seat availability under a declared key mode.
 *
 * Some key modes only cover seats on an installation's own keyed allowance;
 * any other seat is refused with a typed reason rather than admitted by
 * default (fail closed). No input value is ever echoed into a refusal.
 */

import { snapshotPlainData, type IsProxy, type PlainDataLimits } from '@fleet/shared';

import { SEAT_CATALOG_SEAT_BOUND } from './seat-selection.js';

/**
 * Domain-sized snapshot bounds: 1 root object + 2 string fields + 1 allow-list
 * array of at most 256 entries = 260 nodes <= 264. The snapshot visits the
 * root at depth 0, the allow-list array at depth 1, and its entries at depth
 * 2, so `maxDepth` must be 3 for the whole shape to pass the depth bound
 * (`depth + 1 > maxDepth` never fires for it); anything deeper inside the
 * array is still refused as malformed by the field validation below.
 */
export const SEAT_KEY_MODE_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 3,
  maxKeys: 3,
  maxArrayLength: SEAT_CATALOG_SEAT_BOUND,
  maxNodes: 264,
  maxStringLength: 128,
});

/** The declared key modes a seat plan can be evaluated against. */
export const KEY_MODES = ['byok', 'managed', 'self-host'] as const;
// Frozen so runtime consumers cannot append undeclared modes that the guard
// would then accept as known.
Object.freeze(KEY_MODES);

export type KeyMode = (typeof KEY_MODES)[number];

export type SeatKeyModeRefusalReason = 'personal-plan-seat' | 'unknown-key-mode' | 'malformed-input';

export type SeatKeyModeResult = { readonly ok: true } | { readonly ok: false; readonly reason: SeatKeyModeRefusalReason };

export interface SeatKeyModeInput {
  readonly seatId: string;
  readonly keyMode: KeyMode;
  readonly keyedSeats: readonly string[];
}

const REQUIRED_KEYS: readonly string[] = ['seatId', 'keyMode', 'keyedSeats'];

const POLLUTING_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

// Fresh refusal per failure path: a shared mutable instance could be reassigned
// by a caller (e.g. Object.assign(result, { ok: true })) and poison later
// refusals.
function malformed(): SeatKeyModeResult {
  return Object.freeze({ ok: false as const, reason: 'malformed-input' as const });
}

function isPollutingKey(key: string): boolean {
  return POLLUTING_KEYS.includes(key);
}

/** True when the string is non-empty and has no leading or trailing whitespace. */
function isTrimmed(s: string): boolean {
  return s.length > 0 && s.trim() === s;
}

function isAcceptableId(s: unknown): s is string {
  return typeof s === 'string' && isTrimmed(s) && !isPollutingKey(s);
}

/**
 * Whether a seat may run under the declared key mode. `isProxy` is a required,
 * trusted detector (production: `types.isProxy`); every failure path returns a
 * typed refusal and never throws or echoes input values.
 */
export function assertSeatAllowedForKeyMode(input: unknown, isProxy: IsProxy): SeatKeyModeResult {
  // Snapshot once, bounded by SEAT_KEY_MODE_LIMITS: the detector runs first,
  // accessors are read by descriptor only, and every hostile shape is a typed
  // refusal here, mapped to 'malformed-input' regardless of path.
  const snap = snapshotPlainData(input, isProxy, SEAT_KEY_MODE_LIMITS);
  if (!snap.ok) {
    return malformed();
  }
  const value = snap.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return malformed();
  }
  // One enumeration: exactly the 3 required keys, no extras, no polluting key.
  const keys = Reflect.ownKeys(value);
  if (keys.length !== REQUIRED_KEYS.length) {
    return malformed();
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !REQUIRED_KEYS.includes(key)) {
      return malformed();
    }
    if (isPollutingKey(key)) {
      return malformed();
    }
  }
  const record = value as Record<string, unknown>;
  if (!isAcceptableId(record['seatId'])) {
    return malformed();
  }
  const rawKeyMode = record['keyMode'];
  if (typeof rawKeyMode !== 'string') {
    return malformed();
  }
  if (!KEY_MODES.includes(rawKeyMode as KeyMode)) {
    return { ok: false, reason: 'unknown-key-mode' };
  }
  const rawKeyedSeats = record['keyedSeats'];
  if (!Array.isArray(rawKeyedSeats)) {
    return malformed();
  }
  const keyedSet = new Set<string>();
  for (const entry of rawKeyedSeats) {
    if (!isAcceptableId(entry)) {
      return malformed();
    }
    keyedSet.add(entry);
  }
  // Fail closed: only the self-host mode admits every seat; every other mode
  // admits only an explicitly listed seat.
  if (rawKeyMode === 'self-host') {
    return { ok: true };
  }
  if (!keyedSet.has(record['seatId'])) {
    return { ok: false, reason: 'personal-plan-seat' };
  }
  return { ok: true };
}
