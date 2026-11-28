/**
 * FC12H: pure per-organisation erasure over chained authority events.
 *
 * Two operations over authority event chains that are linked per
 * `organizationId`:
 *
 * - `verifyEventChain` verifies every per-organisation hash chain across one
 *   event list.
 * - `pseudonymiseActors` replaces the `actor` of one organisation's events
 *   with a stable digest placeholder and recomputes that organisation's chain
 *   links and hashes in order, leaving every other organisation's events
 *   untouched byte-for-byte so their independent chains still verify.
 *
 * Canonical per-organisation hash-chain rule:
 *
 * 1. Canonical preimage of an event:
 *    `JSON.stringify({ eventId, kind, actor, organizationId, atIso,
 *    beforeRevision, afterRevision, previousHash })` in that exact key order.
 * 2. Per-organisation genesis rule: the first event for a given
 *    `organizationId` (including `null`) has `previousHash === null`.
 * 3. Per-organisation link rule: each subsequent event for the same
 *    `organizationId` has `previousHash === lastHashByOrg.get(organizationId)`.
 * 4. Digest rule: `hash === sha256Hex(preimage)` (64 lowercase hex chars).
 * 5. Pseudonymisation rule: for each event with
 *    `event.organizationId === organizationId`, `actor` is replaced with
 *    `'anon-' + sha256Hex(JSON.stringify([organizationId, salt,
 *    event.actor])).slice(0, 32)` (valid under `AUTHORITY_ACTOR_PATTERN`),
 *    `previousHash` is updated to the preceding pseudonymised output event's
 *    `hash` for `organizationId` (`null` for the first event of
 *    `organizationId`), and `hash` is recomputed over the pseudonymised record
 *    in order. Events with any other `organizationId` (including `null`) are
 *    emitted untouched byte-for-byte, preserving their independent
 *    per-organisation chains.
 *
 * Domain-only: no clock, no randomness, no I/O, no import of the tenancy or
 * billing contexts. The SHA-256 helper and the `isProxy` detector are injected
 * by the caller (infrastructure passes `types.isProxy` from `node:util`).
 * Untrusted input is read once through the shared `snapshotPlainData` (bounded
 * by this unit's own limits), so no getter and no Proxy trap runs here.
 * Nothing rejected is ever echoed.
 */

import {
  snapshotPlainData,
  type IsProxy,
  type PlainDataLimits,
  type PlainDataRefusalReason,
} from '@fleet/shared';

import { AUTHORITY_ACTOR_PATTERN } from './authority-event-mapping.js';
import { isZonedIsoDateTime } from './conductor-halt.js';
import { SHA256_HEX_PATTERN } from './lane-plan-records.js';

/** Most events one call may carry. */
export const MAX_ERASURE_EVENTS = 10_000;

/** Most characters `eventId`, `actor`, a revision and a non-null `organizationId` may occupy. */
export const MAX_ERASURE_FIELD_LENGTH = 128;

/** Most characters `atIso` may occupy. */
export const MAX_ERASURE_AT_ISO_LENGTH = 64;

/** Most characters the pseudonymisation salt may occupy. */
export const MAX_ERASURE_SALT_LENGTH = 256;

/** The event kinds a chained authority event may carry. */
export const CHAINED_EVENT_KINDS = [
  'dispatch',
  'stop',
  'grant',
  'merge',
  'policy-change',
  'key-change',
  'membership-change',
  'operator-access',
] as const;

/** The injected SHA-256 helper: 64 lowercase hex characters per call. */
export type Sha256HexFn = (text: string) => string;

/** One validated, hash-chained authority event; a frozen exact-nine-key record. */
export interface ChainedAuthorityEvent {
  readonly eventId: string;
  readonly kind: (typeof CHAINED_EVENT_KINDS)[number];
  readonly actor: string;
  /** `null` means the default organisation. Chains are linked per this key. */
  readonly organizationId: string | null;
  readonly atIso: string;
  readonly beforeRevision: string | null;
  readonly afterRevision: string | null;
  readonly previousHash: string | null;
  readonly hash: string;
}

/** Refusal codes both erasure operations return; none echo any supplied value. */
export type EventChainRefusalReason =
  | 'invalid-detector'
  | 'invalid-hasher'
  | 'invalid-events'
  | 'too-many-events'
  | 'hostile-input'
  | 'prototype-polluting-key'
  | 'invalid-event-record'
  | 'invalid-organization-id'
  | 'invalid-salt'
  | 'broken-chain'
  | 'hash-mismatch';

/** The outcome of one `verifyEventChain` call. */
export type VerifyEventChainResult =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly reason: EventChainRefusalReason; readonly index?: number };

/** The outcome of one `pseudonymiseActors` call. */
export type PseudonymiseActorsResult =
  | {
      readonly ok: true;
      readonly events: readonly ChainedAuthorityEvent[];
      readonly pseudonymisedCount: number;
    }
  | { readonly ok: false; readonly reason: EventChainRefusalReason; readonly index?: number };

/** The exact event payload `buildChainedEvent` accepts (the record without its hash fields). */
export interface ChainedEventInput {
  readonly eventId: string;
  readonly kind: (typeof CHAINED_EVENT_KINDS)[number];
  readonly actor: string;
  readonly organizationId: string | null;
  readonly atIso: string;
  readonly beforeRevision: string | null;
  readonly afterRevision: string | null;
}

/** The outcome of one `buildChainedEvent` call. */
export type BuildChainedEventResult =
  | { readonly ok: true; readonly event: ChainedAuthorityEvent }
  | { readonly ok: false; readonly reason: EventChainRefusalReason };

/** Bounds for the events snapshot: root array and each event record. */
export const ERASURE_SNAPSHOT_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 4,
  maxKeys: 10,
  maxArrayLength: MAX_ERASURE_EVENTS,
  maxNodes: MAX_ERASURE_EVENTS * 11 + 1,
  maxStringLength: MAX_ERASURE_SALT_LENGTH,
});

const CHAINED_EVENT_KEYS: readonly string[] = [
  'eventId',
  'kind',
  'actor',
  'organizationId',
  'atIso',
  'beforeRevision',
  'afterRevision',
  'previousHash',
  'hash',
];

const PROTOTYPE_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

const INVALID_DETECTOR = { ok: false, reason: 'invalid-detector' } as const;
const INVALID_HASHER = { ok: false, reason: 'invalid-hasher' } as const;
const INVALID_EVENTS = { ok: false, reason: 'invalid-events' } as const;

/**
 * A non-empty string of at most `max` characters with no ASCII control
 * character. `O(value.length)`, bounded by the call sites' constants.
 */
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
 * Runs the injected hasher once inside a guard: any throw, and any return
 * value that is not 64 lowercase hex characters, reads as `null` so the
 * caller refuses with `invalid-hasher`. Never lets a hostile hasher throw.
 */
function safeHash(sha256Hex: Sha256HexFn, text: string): string | null {
  try {
    const digest = sha256Hex(text);
    return typeof digest === 'string' && SHA256_HEX_PATTERN.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

/** The canonical preimage of one event, in the exact documented key order. */
function canonicalPreimage(event: ChainedEventInput, previousHash: string | null): string {
  return JSON.stringify({
    eventId: event.eventId,
    kind: event.kind,
    actor: event.actor,
    organizationId: event.organizationId,
    atIso: event.atIso,
    beforeRevision: event.beforeRevision,
    afterRevision: event.afterRevision,
    previousHash,
  });
}

/** The digest of one event over its canonical preimage; `null` on hasher failure. */
function hashEvent(event: ChainedEventInput, previousHash: string | null, sha256Hex: Sha256HexFn): string | null {
  return safeHash(sha256Hex, canonicalPreimage(event, previousHash));
}

/**
 * Maps one `snapshotPlainData` refusal to an `EventChainRefusalReason`
 * without echoing any input value or path text.
 */
function mapSnapshotRefusal(reason: PlainDataRefusalReason, path: string | null): EventChainRefusalReason {
  switch (reason) {
    case 'detector-threw':
      return 'invalid-detector';
    case 'too-many-items':
    case 'too-many-nodes':
      return 'too-many-events';
    case 'unsupported-type':
    case 'not-plain':
      return path === null ? 'invalid-events' : 'hostile-input';
    case 'invalid-limits':
      // The injected detector runs on the limits argument before the events
      // are read, so a detector that throws (or lies) surfaces here.
      return 'invalid-detector';
    default:
      // `proxy`, `accessor`, `not-enumerable`, `symbol-key`, `hostile`,
      // `cycle`, `sparse-array`, `non-finite-number`, `negative-zero`,
      // `too-deep`, `too-many-keys`, `too-long`, `invalid-limits`.
      return 'hostile-input';
  }
}

/** A snapshotted value that is a plain-object copy (never an array, never null). */
function isRecordCopy(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `O(own keys), one enumeration` per event: every own key must be one of the
 * exact nine, none may be prototype-polluting, and all nine must be present.
 * `snapshotPlainData` copies own `__proto__` keys as data, so the check reads
 * the copied record's own keys with one `Reflect.ownKeys` call.
 */
function readChainedRecordKeys(
  record: Record<string, unknown>,
): { readonly ok: true } | { readonly ok: false; readonly reason: EventChainRefusalReason } {
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(record);
  } catch {
    return { ok: false, reason: 'invalid-event-record' };
  }
  // A prototype-polluting own key is refused before any count or membership
  // check: the snapshot may carry it as an extra data key alongside the nine
  // valid ones.
  for (const key of ownKeys) {
    if ((PROTOTYPE_KEYS as readonly PropertyKey[]).includes(key)) {
      return { ok: false, reason: 'prototype-polluting-key' };
    }
  }
  if (ownKeys.length !== CHAINED_EVENT_KEYS.length) {
    return { ok: false, reason: 'invalid-event-record' };
  }
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !CHAINED_EVENT_KEYS.includes(key)) {
      return { ok: false, reason: 'invalid-event-record' };
    }
  }
  for (const key of CHAINED_EVENT_KEYS) {
    if (!Object.hasOwn(record, key)) {
      return { ok: false, reason: 'invalid-event-record' };
    }
  }
  return { ok: true };
}

/**
 * Validates one snapshotted event record's nine fields; the frozen record on
 * success, `null` on any malformed field. Field checks are each
 * `O(field length)`, bounded by the module constants.
 */
function readChainedEventFields(record: Record<string, unknown>): ChainedAuthorityEvent | null {
  const { eventId, kind, actor, organizationId, atIso, beforeRevision, afterRevision, previousHash, hash } = record;
  if (!isBoundedRequiredText(eventId, MAX_ERASURE_FIELD_LENGTH)) {
    return null;
  }
  if (typeof kind !== 'string' || !(CHAINED_EVENT_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  if (typeof actor !== 'string' || !AUTHORITY_ACTOR_PATTERN.test(actor)) {
    return null;
  }
  if (organizationId !== null && !isBoundedRequiredText(organizationId, MAX_ERASURE_FIELD_LENGTH)) {
    return null;
  }
  if (
    typeof atIso !== 'string' ||
    atIso.length > MAX_ERASURE_AT_ISO_LENGTH ||
    !isZonedIsoDateTime(atIso)
  ) {
    return null;
  }
  if (beforeRevision !== null && !isBoundedRequiredText(beforeRevision, MAX_ERASURE_FIELD_LENGTH)) {
    return null;
  }
  if (afterRevision !== null && !isBoundedRequiredText(afterRevision, MAX_ERASURE_FIELD_LENGTH)) {
    return null;
  }
  if (previousHash !== null && (typeof previousHash !== 'string' || !SHA256_HEX_PATTERN.test(previousHash))) {
    return null;
  }
  if (typeof hash !== 'string' || !SHA256_HEX_PATTERN.test(hash)) {
    return null;
  }
  return Object.freeze({
    eventId,
    kind: kind as ChainedAuthorityEvent['kind'],
    actor,
    organizationId: organizationId as string | null,
    atIso,
    beforeRevision: beforeRevision as string | null,
    afterRevision: afterRevision as string | null,
    previousHash: previousHash as string | null,
    hash,
  });
}

/**
 * `O(n)` over `n <= MAX_ERASURE_EVENTS` events: validates every element in order.
 */
function readChainedEvents(value: unknown): { readonly ok: true; readonly events: ChainedAuthorityEvent[] } | { readonly ok: false; readonly reason: EventChainRefusalReason; readonly index: number } {
  if (!Array.isArray(value)) {
    return { ok: false, reason: 'invalid-events', index: -1 };
  }
  const events: ChainedAuthorityEvent[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const element = value[index];
    if (!isRecordCopy(element)) {
      return { ok: false, reason: 'invalid-event-record', index };
    }
    const keys = readChainedRecordKeys(element);
    if (!keys.ok) {
      return { ok: false, reason: keys.reason, index };
    }
    const event = readChainedEventFields(element);
    if (event === null) {
      return { ok: false, reason: 'invalid-event-record', index };
    }
    events.push(event);
  }
  return { ok: true, events };
}

/**
 * Everything both operations share: detector and hasher checks (`O(1)`), one
 * bounded snapshot of the untrusted events, and full record validation
 * (`O(n)`). A refusal never carries any input value.
 */
function prepareEvents(
  events: unknown,
  sha256Hex: Sha256HexFn,
  isProxy: IsProxy,
): { readonly ok: true; readonly events: ChainedAuthorityEvent[] } | { readonly ok: false; readonly reason: EventChainRefusalReason; readonly index?: number } {
  if (typeof isProxy !== 'function') {
    return INVALID_DETECTOR;
  }
  if (typeof sha256Hex !== 'function') {
    return INVALID_HASHER;
  }
  // One canary call proves the injected hasher returns 64 lowercase hex
  // characters before any record is walked, so a malformed digest is refused
  // even for an empty event list. `O(1)`.
  if (safeHash(sha256Hex, '') === null) {
    return INVALID_HASHER;
  }
  const snapshot = snapshotPlainData(events, isProxy, ERASURE_SNAPSHOT_LIMITS);
  if (!snapshot.ok) {
    return { ok: false, reason: mapSnapshotRefusal(snapshot.reason, snapshot.path) };
  }
  if (!Array.isArray(snapshot.value)) {
    // Covers root `null`, root primitives that snapshot as values (e.g. a
    // string), and non-array plain objects and array-likes.
    return INVALID_EVENTS;
  }
  const read = readChainedEvents(snapshot.value);
  if (!read.ok) {
    return read.reason === 'invalid-events'
      ? INVALID_EVENTS
      : { ok: false, reason: read.reason, index: read.index };
  }
  return { ok: true, events: read.events };
}

/**
 * `O(n)`: walks the validated events once, checking each event's
 * `previousHash` against the last hash seen for its own `organizationId`
 * (`null` for the first event of that organisation) and its `hash` against
 * the canonical preimage digest. The first mismatch wins, with its index.
 */
function walkChain(
  events: readonly ChainedAuthorityEvent[],
  sha256Hex: Sha256HexFn,
): { readonly ok: true } | { readonly ok: false; readonly reason: EventChainRefusalReason; readonly index: number } {
  const lastHashByOrg = new Map<string | null, string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const expectedPreviousHash = lastHashByOrg.get(event.organizationId) ?? null;
    if (event.previousHash !== expectedPreviousHash) {
      return { ok: false, reason: 'broken-chain', index };
    }
    const expectedHash = hashEvent(event, event.previousHash, sha256Hex);
    if (expectedHash === null) {
      // A hasher that throws or returns a malformed digest is a hasher
      // failure, not evidence of tampering: refuse with `invalid-hasher`.
      return { ok: false, reason: 'invalid-hasher', index };
    }
    if (event.hash !== expectedHash) {
      return { ok: false, reason: 'hash-mismatch', index };
    }
    lastHashByOrg.set(event.organizationId, event.hash);
  }
  return { ok: true };
}

/**
 * Verifies every per-organisation hash chain across the event list.
 *
 * Cost: `O(1)` detector/hasher pre-checks, one bounded `O(N)` snapshot, and
 * `O(n)` validation and chain walking for `n <= MAX_ERASURE_EVENTS`. Never
 * throws; a refusal never carries any input value.
 */
export function verifyEventChain(
  events: unknown,
  sha256Hex: Sha256HexFn,
  isProxy: IsProxy,
): VerifyEventChainResult {
  try {
    const prepared = prepareEvents(events, sha256Hex, isProxy);
    if (!prepared.ok) {
      return prepared.reason === 'invalid-events'
        ? INVALID_EVENTS
        : { ok: false, reason: prepared.reason, index: prepared.index };
    }
    const walked = walkChain(prepared.events, sha256Hex);
    if (!walked.ok) {
      return { ok: false, reason: walked.reason, index: walked.index };
    }
    return { ok: true, count: prepared.events.length };
  } catch {
    return INVALID_EVENTS;
  }
}

/**
 * Builds one chained event from a validated payload and a `previousHash`,
 * computing `hash` over the canonical preimage with the injected hasher.
 * The payload is re-validated defensively; the result is a typed refusal,
 * never a throw.
 */
export function buildChainedEvent(
  input: ChainedEventInput,
  previousHash: string | null,
  sha256Hex: Sha256HexFn,
): BuildChainedEventResult {
  try {
    if (typeof sha256Hex !== 'function' || safeHash(sha256Hex, '') === null) {
      return INVALID_HASHER;
    }
    if (previousHash !== null && (typeof previousHash !== 'string' || !SHA256_HEX_PATTERN.test(previousHash))) {
      return { ok: false, reason: 'invalid-event-record' };
    }
    const record: Record<string, unknown> = {
      eventId: input.eventId,
      kind: input.kind,
      actor: input.actor,
      organizationId: input.organizationId,
      atIso: input.atIso,
      beforeRevision: input.beforeRevision,
      afterRevision: input.afterRevision,
      previousHash,
      hash: '',
    };
    const keys = readChainedRecordKeys(record);
    if (!keys.ok) {
      return { ok: false, reason: keys.reason };
    }
    const event = readChainedEventFields({ ...record, hash: '0'.repeat(64) });
    if (event === null) {
      return { ok: false, reason: 'invalid-event-record' };
    }
    const hash = hashEvent(input, previousHash, sha256Hex);
    if (hash === null) {
      return INVALID_HASHER;
    }
    return {
      ok: true,
      event: Object.freeze({ ...event, previousHash, hash }),
    };
  } catch {
    return { ok: false, reason: 'invalid-event-record' };
  }
}

/**
 * Erases one organisation's actors: every event belonging to
 * `organizationId` gets a stable digest placeholder actor and a recomputed
 * chain link and hash; every other event (including those with
 * `organizationId: null`) is emitted untouched byte-for-byte. The incoming
 * chains are verified first, so tampered input is refused before erasure.
 *
 * Cost: `O(1)` argument pre-checks, one bounded `O(N)` snapshot, `O(n)`
 * validation, verification and rebuild for `n <= MAX_ERASURE_EVENTS`. Never
 * throws; a refusal never carries any input value.
 */
export function pseudonymiseActors(
  events: unknown,
  organizationId: unknown,
  salt: unknown,
  sha256Hex: Sha256HexFn,
  isProxy: IsProxy,
): PseudonymiseActorsResult {
  try {
    if (!isBoundedRequiredText(organizationId, MAX_ERASURE_FIELD_LENGTH)) {
      return { ok: false, reason: 'invalid-organization-id' };
    }
    if (!isBoundedRequiredText(salt, MAX_ERASURE_SALT_LENGTH)) {
      return { ok: false, reason: 'invalid-salt' };
    }
    const prepared = prepareEvents(events, sha256Hex, isProxy);
    if (!prepared.ok) {
      return prepared.reason === 'invalid-events'
        ? INVALID_EVENTS
        : { ok: false, reason: prepared.reason, index: prepared.index };
    }
    const verified = walkChain(prepared.events, sha256Hex);
    if (!verified.ok) {
      return { ok: false, reason: verified.reason, index: verified.index };
    }
    const out: ChainedAuthorityEvent[] = [];
    let lastTargetHash: string | null = null;
    let pseudonymisedCount = 0;
    for (let index = 0; index < prepared.events.length; index += 1) {
      const event = prepared.events[index];
      if (event.organizationId === organizationId) {
        // `'anon-'` plus 32 lowercase hex characters is within
        // `AUTHORITY_ACTOR_PATTERN` and is stable for
        // `(organizationId, salt, actor)`.
        const digest = safeHash(sha256Hex, JSON.stringify([organizationId, salt, event.actor]));
        if (digest === null) {
          return INVALID_HASHER;
        }
        const placeholder = `anon-${digest.slice(0, 32)}`;
        const pseudonymised: ChainedEventInput = { ...event, actor: placeholder };
        const hash = hashEvent(pseudonymised, lastTargetHash, sha256Hex);
        if (hash === null) {
          return INVALID_HASHER;
        }
        out.push(
          Object.freeze({
            eventId: event.eventId,
            kind: event.kind,
            actor: placeholder,
            organizationId: event.organizationId,
            atIso: event.atIso,
            beforeRevision: event.beforeRevision,
            afterRevision: event.afterRevision,
            previousHash: lastTargetHash,
            hash,
          }),
        );
        lastTargetHash = hash;
        pseudonymisedCount += 1;
      } else {
        // An exact frozen copy of the original record: no field altered, so
        // the other organisations' chains still verify.
        out.push(event);
      }
    }
    return { ok: true, events: Object.freeze(out), pseudonymisedCount };
  } catch {
    return { ok: false, reason: 'invalid-events' };
  }
}
