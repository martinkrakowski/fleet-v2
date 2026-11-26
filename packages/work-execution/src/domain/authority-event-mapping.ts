/**
 * Pure consumer-side mapping of a recorded stop into the supplier context's
 * authority event shape (FC12B). The event type is LOCAL to `work-execution`
 * and its field names mirror FC12A's `AuthorityEvent`
 * (`packages/operator-coordination/src/domain/authority-event.ts`); the two
 * contexts are never imported across this seam (docs/architecture.md
 * "Dependency direction": consumer-side outbound contracts only, adapters
 * delegate).
 *
 * Stop-only: this module maps nothing but stop events. Dispatch, merge and
 * grant emission live elsewhere.
 *
 * Cost bounds: `authorityEventForStop` is O(1) — the key set is fixed and
 * checked by count before any read, every string field is bounded
 * (`eventId`/`actor`/`organizationId` <= 128 characters, `atIso` <= 64), and
 * the actor pattern and ISO shape are constant-cost regular expressions on
 * bounded strings.
 *
 * Hostile-input rule: nothing here throws and no getter ever runs — the key
 * enumeration is the one unavoidable reflective step (`Reflect.ownKeys`), its
 * count is refused before any value is read, every value is read through its
 * own property descriptor, accessors are refused (the `get`/`set` is never
 * invoked), a trap that throws is a typed refusal, and no supplied value is
 * ever echoed into a refusal reason. A `Proxy` whose traps lie consistently
 * cannot be distinguished from an ordinary object (JavaScript offers no way to
 * enumerate keys without running an `ownKeys` trap), so such a proxy is an
 * accepted residual; a proxy whose traps throw is refused.
 */

import { isPlainRecordObject } from './record-schema-version.js';
import { isZonedIsoDateTime } from './conductor-halt.js';

/**
 * The consumer-side stop authority event. Exactly FC12A's seven keys, with
 * `kind` narrowed to the stop-only value this context emits and both
 * revisions `null` (a stop revises nothing).
 */
export interface StopAuthorityEvent {
  readonly eventId: string;
  readonly kind: 'stop';
  readonly actor: string;
  /** `null` means the default organisation (FC12A's rule). */
  readonly organizationId: string | null;
  readonly atIso: string;
  readonly beforeRevision: null;
  readonly afterRevision: null;
}

/** The most characters `eventId`, `actor` and a non-null `organizationId` may occupy. */
export const MAX_STOP_AUTHORITY_FIELD_LENGTH = 128;

/** The most characters `atIso` may occupy. */
export const MAX_STOP_AUTHORITY_AT_ISO_LENGTH = 64;

/**
 * The exact actor shape. Mirrors FC12A's `AUTHORITY_ACTOR_PATTERN` character
 * for character; the supplier module is never imported across the seam, so
 * the pattern is duplicated here on purpose (the same discipline the forge
 * adapters follow for supplier rules).
 */
export const AUTHORITY_ACTOR_PATTERN = /^[A-Za-z0-9._@-]{1,128}$/;

/** Own keys whose presence marks the input as prototype-polluted. */
const PROTOTYPE_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/** The exactly-four own keys a valid mapper input has. */
const INPUT_KEYS: readonly string[] = ['eventId', 'actor', 'organizationId', 'atIso'];

/** Refusal codes `authorityEventForStop` returns; none echo any supplied value. */
export type AuthorityEventMappingRefusal =
  | 'invalid-input'
  | 'invalid-event-id'
  | 'invalid-actor'
  | 'invalid-organization-id'
  | 'invalid-at-iso';

/** The outcome of one `authorityEventForStop` call. */
export type AuthorityEventMappingResult =
  | { readonly ok: true; readonly event: StopAuthorityEvent }
  | { readonly ok: false; readonly reason: AuthorityEventMappingRefusal };

/** The strict key-read outcome of the mapper's own-key check. */
type MapperInputRead =
  | { readonly ok: true; readonly values: ReadonlyMap<string, unknown> }
  | { readonly ok: false };

/**
 * Reads a plain object's own enumerable string keys through their property
 * descriptors, refusing every hostile shape. Returns a typed refusal, never a
 * throw and never a run getter.
 */
function readMapperInputStrict(value: unknown): MapperInputRead {
  // Refuses null, undefined, every wrong primitive, arrays (including sparse
  // ones — a hole is an array shape, refused before any element is read) and
  // every non-plain prototype.
  if (!isPlainRecordObject(value)) {
    return { ok: false };
  }
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return { ok: false };
  }
  // The count refusal bounds hostile many-key objects at O(1) and refuses
  // every extra and every missing key in one step. An array-like's `length`
  // and index keys are extra keys here, so array-likes refuse too.
  if (ownKeys.length !== INPUT_KEYS.length) {
    return { ok: false };
  }
  const values = new Map<string, unknown>();
  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      return { ok: false };
    }
    if (PROTOTYPE_KEYS.includes(key)) {
      return { ok: false };
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return { ok: false };
    }
    if (descriptor === undefined || !descriptor.enumerable) {
      return { ok: false };
    }
    // An own accessor is refused outright: the getter would run a hostile
    // closure, so `get`/`set` is never invoked.
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return { ok: false };
    }
    values.set(key, descriptor.value);
  }
  for (const key of INPUT_KEYS) {
    if (!values.has(key)) {
      return { ok: false };
    }
  }
  return { ok: true, values };
}

/** A required bounded text check: non-empty, at most `max` characters, no ASCII control character. */
function isBoundedRequiredText(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * Maps one untrusted stop input into a frozen `StopAuthorityEvent`. Never
 * throws, never reads a clock (the `atIso` is whatever the caller passes),
 * never runs a getter and never echoes a supplied value into a reason.
 */
export function authorityEventForStop(input: unknown): AuthorityEventMappingResult {
  try {
    const read = readMapperInputStrict(input);
    if (!read.ok) {
      return { ok: false, reason: 'invalid-input' };
    }
    const eventId = read.values.get('eventId');
    if (typeof eventId !== 'string') {
      return { ok: false, reason: 'invalid-input' };
    }
    if (!isBoundedRequiredText(eventId, MAX_STOP_AUTHORITY_FIELD_LENGTH)) {
      return { ok: false, reason: 'invalid-event-id' };
    }
    const actor = read.values.get('actor');
    if (typeof actor !== 'string') {
      return { ok: false, reason: 'invalid-input' };
    }
    if (!AUTHORITY_ACTOR_PATTERN.test(actor)) {
      return { ok: false, reason: 'invalid-actor' };
    }
    const organizationId = read.values.get('organizationId');
    if (organizationId !== null) {
      if (typeof organizationId !== 'string') {
        return { ok: false, reason: 'invalid-input' };
      }
      if (!isBoundedRequiredText(organizationId, MAX_STOP_AUTHORITY_FIELD_LENGTH)) {
        return { ok: false, reason: 'invalid-organization-id' };
      }
    }
    const atIso = read.values.get('atIso');
    if (typeof atIso !== 'string') {
      return { ok: false, reason: 'invalid-input' };
    }
    if (atIso.length > MAX_STOP_AUTHORITY_AT_ISO_LENGTH || !isZonedIsoDateTime(atIso)) {
      return { ok: false, reason: 'invalid-at-iso' };
    }
    return {
      ok: true,
      event: Object.freeze({
        eventId: eventId,
        kind: 'stop' as const,
        actor: actor,
        organizationId: organizationId as string | null,
        atIso: atIso,
        beforeRevision: null,
        afterRevision: null,
      }),
    };
  } catch {
    // A revoked Proxy throws on every trap, including the prototype read
    // inside `isPlainRecordObject`; the refusal is typed, never a throw.
    return { ok: false, reason: 'invalid-input' };
  }
}
