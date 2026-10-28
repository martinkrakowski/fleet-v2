import { hasUnknownKeys, isPlainRecord, readBoundedInteger, readOwnDataProperty } from './policy-read.js';
import type { ResolvedSeatsPolicy, SeatRotationRole, SeatsPolicy } from './types.js';

export const SEAT_ROTATION_ROLES: readonly SeatRotationRole[] = Object.freeze(['first-pass', 'fix', 'review', 'pre-merge']);
export const SEATS_POLICY_KEYS: readonly string[] = Object.freeze(['rotate', 'cooldownMinutes', 'observationCooldownMinutes']);
export const SEATS_POLICY_MINUTE_BOUNDS = Object.freeze({ min: 0, max: 1440 });
export const DEFAULT_SEAT_COOLDOWN_MINUTES = 60;
export const DEFAULT_SEAT_OBSERVATION_COOLDOWN_MINUTES = 0;

export type SeatsPolicyRead =
  | { readonly ok: true; readonly policy: SeatsPolicy }
  | { readonly ok: false; readonly errors: readonly string[] };

/** A rotation list: an array whose every entry is one of the roles and which holds no entry twice. */
function readRotate(value: unknown): readonly SeatRotationRole[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const roles: SeatRotationRole[] = [];
  for (const entry of value) {
    if (!SEAT_ROTATION_ROLES.includes(entry as SeatRotationRole)) {
      return undefined;
    }
    if (roles.includes(entry as SeatRotationRole)) {
      return undefined;
    }
    roles.push(entry as SeatRotationRole);
  }
  return Object.freeze(roles);
}

/**
 * The v2 `policy.seats` validator (MCP tooling plan §3.5.2, D4, D5, D7). Never throws. Its errors are fixed
 * strings naming a path and a rule, never a value.
 */
export function readSeatsPolicyBlock(value: unknown): SeatsPolicyRead {
  try {
    if (!isPlainRecord(value)) {
      return { ok: false, errors: ['policy.seats: must be an object'] };
    }
    const errors: string[] = [];
    if (hasUnknownKeys(value, SEATS_POLICY_KEYS)) {
      errors.push('policy.seats: unknown key');
    }
    const rotate = readOwnDataProperty(value, 'rotate');
    if (rotate !== undefined && readRotate(rotate) === undefined) {
      errors.push('policy.seats.rotate: must be a list of distinct roles from first-pass, fix, review, pre-merge');
    }
    const cooldownMinutes = readOwnDataProperty(value, 'cooldownMinutes');
    if (cooldownMinutes !== undefined && readBoundedInteger(cooldownMinutes, SEATS_POLICY_MINUTE_BOUNDS) === undefined) {
      errors.push('policy.seats.cooldownMinutes: must be an integer from 0 to 1440');
    }
    const observationCooldownMinutes = readOwnDataProperty(value, 'observationCooldownMinutes');
    if (observationCooldownMinutes !== undefined && readBoundedInteger(observationCooldownMinutes, SEATS_POLICY_MINUTE_BOUNDS) === undefined) {
      errors.push('policy.seats.observationCooldownMinutes: must be an integer from 0 to 1440');
    }
    if (errors.length > 0) {
      return { ok: false, errors };
    }
    const policy: { -readonly [K in keyof SeatsPolicy]: SeatsPolicy[K] } = {};
    if (rotate !== undefined) {
      policy.rotate = readRotate(rotate);
    }
    if (cooldownMinutes !== undefined) {
      policy.cooldownMinutes = readBoundedInteger(cooldownMinutes, SEATS_POLICY_MINUTE_BOUNDS);
    }
    if (observationCooldownMinutes !== undefined) {
      policy.observationCooldownMinutes = readBoundedInteger(observationCooldownMinutes, SEATS_POLICY_MINUTE_BOUNDS);
    }
    return { ok: true, policy };
  } catch {
    return { ok: false, errors: ['policy.seats: must be an object'] };
  }
}

/** A fresh, deeply frozen default: no rotation, 60-minute cooling, observations off. */
function freshDefaultSeatsPolicy(): ResolvedSeatsPolicy {
  return Object.freeze({
    rotate: Object.freeze([]),
    cooldownMinutes: DEFAULT_SEAT_COOLDOWN_MINUTES,
    observationCooldownMinutes: DEFAULT_SEAT_OBSERVATION_COOLDOWN_MINUTES,
  });
}

export const DEFAULT_SEATS_POLICY: ResolvedSeatsPolicy = freshDefaultSeatsPolicy();

/**
 * The effective seat policy (MCP tooling plan §3.5.2, D4, D5, D7). The file's values with absent fields
 * defaulted, or the whole default when the block is absent or malformed.
 */
export function resolveSeatsPolicy(policy: unknown): ResolvedSeatsPolicy {
  if (!isPlainRecord(policy)) {
    return freshDefaultSeatsPolicy();
  }
  const read = readSeatsPolicyBlock(readOwnDataProperty(policy, 'seats'));
  if (!read.ok) {
    return freshDefaultSeatsPolicy();
  }
  const block = read.policy;
  return Object.freeze({
    rotate: Object.freeze([...(block.rotate ?? [])]),
    cooldownMinutes: block.cooldownMinutes ?? DEFAULT_SEAT_COOLDOWN_MINUTES,
    observationCooldownMinutes: block.observationCooldownMinutes ?? DEFAULT_SEAT_OBSERVATION_COOLDOWN_MINUTES,
  });
}
