/**
 * A pure compatibility guard for seat availability under a declared key mode.
 *
 * Some key modes only cover seats on an installation's own keyed allowance;
 * any other seat is refused with a typed reason rather than admitted by
 * default (fail closed). No input value is ever echoed into a refusal.
 */

import { snapshotPlainData, type IsProxy, type PlainDataLimits } from '@fleet/shared';

import { SEAT_CATALOG_SEAT_BOUND } from './seat-selection.js';

/** Domain-sized snapshot bounds: 1 root object + 2 string fields + 1 allow-list array of at most 256 entries = 260 nodes <= 264, at depth <= 2. */
export const SEAT_KEY_MODE_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 2,
  maxKeys: 3,
  maxArrayLength: SEAT_CATALOG_SEAT_BOUND,
  maxNodes: 264,
  maxStringLength: 128,
});

/** The declared key modes a seat plan can be evaluated against. */
export const KEY_MODES = ['byok', 'managed', 'self-host'] as const;

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

const MALFORMED: SeatKeyModeResult = { ok: false, reason: 'malformed-input' };

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
    return MALFORMED;
  }
  const value = snap.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return MALFORMED;
  }
  // One enumeration: exactly the 3 required keys, no extras, no polluting key.
  const keys = Reflect.ownKeys(value);
  if (keys.length !== REQUIRED_KEYS.length) {
    return MALFORMED;
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !REQUIRED_KEYS.includes(key)) {
      return MALFORMED;
    }
    if (isPollutingKey(key)) {
      return MALFORMED;
    }
  }
  const record = value as Record<string, unknown>;
  if (!isAcceptableId(record['seatId'])) {
    return MALFORMED;
  }
  const rawKeyMode = record['keyMode'];
  if (typeof rawKeyMode !== 'string') {
    return MALFORMED;
  }
  if (!KEY_MODES.includes(rawKeyMode as KeyMode)) {
    return { ok: false, reason: 'unknown-key-mode' };
  }
  const rawKeyedSeats = record['keyedSeats'];
  if (!Array.isArray(rawKeyedSeats)) {
    return MALFORMED;
  }
  const keyedSet = new Set<string>();
  for (const entry of rawKeyedSeats) {
    if (!isAcceptableId(entry)) {
      return MALFORMED;
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
