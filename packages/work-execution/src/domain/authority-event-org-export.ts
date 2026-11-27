/**
 * Per-organisation audit export filter (FC12F). A pure domain function that
 * takes an untrusted, opaque request — an event log plus the organisation to
 * export — and returns that organisation's events as single-line JSONL with a
 * cursor for paging. The event shape mirrors FC12A's `AuthorityEvent` field
 * for field (`organizationId: null` denotes the default organisation); the
 * supplier module itself is never imported across the seam.
 *
 * Every untrusted read goes through `@fleet/shared`'s `snapshotPlainData`
 * bounded by this unit's own exported limits, so no Proxy trap, getter,
 * sparse hole, symbol key, cycle, or enormous length is ever followed. The
 * snapshot runs once over the request and once over the optional injected
 * selector's output; everything after that is O(n) over at most
 * `MAX_AUTHORITY_ORG_EXPORT_EVENTS` validated events.
 *
 * Hostile-input rule: nothing throws, no getter or iterator is ever invoked
 * (the selector's output is never walked with `for...of`), and no rejected
 * value is ever echoed into a refusal. Defence in depth: every serialized
 * line is re-parsed and its organisation re-checked against the request, so
 * even a faulty injected selector cannot leak another organisation's event.
 */

import {
  snapshotPlainData,
  type IsProxy,
  type PlainDataLimits,
} from '@fleet/shared';
import { isZonedIsoDateTime } from './conductor-halt.js';

/** The organisation id a missing or `null` `organizationId` denotes. */
export const DEFAULT_ORGANIZATION_ID = 'default';

/** The most events `exportAuthorityEventsForOrg` will even consider. */
export const MAX_AUTHORITY_ORG_EXPORT_EVENTS = 50_000;

/** The inclusive upper bound an explicit `limit` may carry. */
export const MAX_AUTHORITY_ORG_EXPORT_LIMIT = 1000;

/** The most UTF-8 bytes one serialized JSONL line may occupy. */
export const MAX_AUTHORITY_ORG_EXPORT_LINE_BYTES = 4096;

/** The most characters any single string field may occupy. */
export const MAX_AUTHORITY_ORG_EXPORT_FIELD_LENGTH = 128;

/** The most characters `atIso` may occupy. */
export const MAX_AUTHORITY_ORG_EXPORT_AT_ISO_LENGTH = 64;

/** The exact event kinds an exported event may carry. Mirrors FC12A. */
export const AUTHORITY_ORG_EVENT_KINDS = [
  'dispatch',
  'stop',
  'grant',
  'merge',
  'policy-change',
  'key-change',
  'membership-change',
  'operator-access',
] as const;

/** One of {@link AUTHORITY_ORG_EVENT_KINDS}. */
export type AuthorityOrgEventKind = (typeof AUTHORITY_ORG_EVENT_KINDS)[number];

/** The exact actor shape. Mirrors FC12A's pattern character for character. */
export const AUTHORITY_ORG_ACTOR_PATTERN = /^[A-Za-z0-9._@-]{1,128}$/;

/** The snapshot limits the request snapshot is bounded by. */
export const AUTHORITY_ORG_EXPORT_SNAPSHOT_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 6,
  maxKeys: 16,
  maxArrayLength: MAX_AUTHORITY_ORG_EXPORT_EVENTS,
  maxNodes: MAX_AUTHORITY_ORG_EXPORT_EVENTS * 9 + 16,
  maxStringLength: 1024,
});

/** The snapshot limits the injected selector's output snapshot is bounded by. */
export const AUTHORITY_ORG_EXPORT_SELECTOR_SNAPSHOT_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 4,
  maxKeys: 16,
  maxArrayLength: MAX_AUTHORITY_ORG_EXPORT_EVENTS,
  maxNodes: MAX_AUTHORITY_ORG_EXPORT_EVENTS * 9 + 16,
  maxStringLength: 1024,
});

/** One validated, normalized event: omitted organisations become `DEFAULT_ORGANIZATION_ID`. */
export interface AuthorityOrgExportEvent {
  readonly eventId: string;
  readonly kind: AuthorityOrgEventKind;
  readonly actor: string;
  /** Normalized: never empty, `null` requests become `'default'`. */
  readonly organizationId: string;
  /** As requested: `null` denotes the default organisation in the output line. */
  readonly rawOrganizationId: string | null;
  readonly atIso: string;
  readonly beforeRevision: string | null;
  readonly afterRevision: string | null;
}

/**
 * The internal selection seam. Omitted in production (the built-in filter
 * selects the events whose normalized organisation matches); injected only in
 * tests to prove the foreign-event-leak defence in depth.
 */
export type AuthorityOrgEventSelector = (
  events: readonly AuthorityOrgExportEvent[],
  organizationId: string,
) => unknown;

/** Refusal codes `exportAuthorityEventsForOrg` returns; none echo any value. */
export type AuthorityOrgExportRefusal =
  | 'invalid-input'
  | 'unknown-cursor'
  | 'foreign-event-leak'
  | 'line-too-long';

/** The outcome of one `exportAuthorityEventsForOrg` call. */
export type ExportAuthorityEventsForOrgResult =
  | {
      readonly ok: true;
      readonly lines: readonly string[];
      readonly nextCursor: string | null;
    }
  | { readonly ok: false; readonly reason: AuthorityOrgExportRefusal };

/** The exactly-four own keys a valid request object has. */
const REQUIRED_ROOT_KEYS: readonly string[] = ['events', 'organizationId', 'afterCursor', 'limit'];

/** Own keys whose presence marks an object as prototype-polluted. */
const PROTOTYPE_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/** The exactly-four required own keys of a valid event object. */
const REQUIRED_EVENT_KEYS: readonly string[] = ['eventId', 'kind', 'actor', 'atIso'];

/** The optional own keys of a valid event object. */
const OPTIONAL_EVENT_KEYS: readonly string[] = [
  'organizationId',
  'beforeRevision',
  'afterRevision',
];

const EVENT_KINDS: readonly string[] = AUTHORITY_ORG_EVENT_KINDS;

type EventRead =
  | { readonly ok: true; readonly event: AuthorityOrgExportEvent }
  | { readonly ok: false };

/** `Object.prototype.hasOwnProperty.call` without running any getter. */
function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
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

/** An optional bounded text check: absent, `null`, or a required bounded text. */
function isBoundedOptionalText(value: unknown, max: number): value is string | null {
  return value === null || isBoundedRequiredText(value, max);
}

/** Normalizes an omitted or `null` organisation id to the default organisation. */
function normalizeOrganizationId(raw: string | null): string {
  return raw === null ? DEFAULT_ORGANIZATION_ID : raw;
}

/**
 * Validates one snapshotted event object in full: exact key set (required
 * four, optional three, no prototype-polluting key) and every field bounded.
 * Cost: O(own keys) — one key enumeration, one bounded scan per string field.
 */
function validateEvent(raw: unknown): EventRead {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false };
  }
  for (const key of PROTOTYPE_KEYS) {
    if (hasOwn(raw, key)) {
      return { ok: false };
    }
  }
  const keys = Object.keys(raw);
  let optionalCount = 0;
  for (const key of OPTIONAL_EVENT_KEYS) {
    if (hasOwn(raw, key)) {
      optionalCount += 1;
    }
  }
  if (keys.length !== REQUIRED_EVENT_KEYS.length + optionalCount) {
    return { ok: false };
  }
  for (const key of REQUIRED_EVENT_KEYS) {
    if (!hasOwn(raw, key)) {
      return { ok: false };
    }
  }
  for (const key of keys) {
    if (!REQUIRED_EVENT_KEYS.includes(key) && !OPTIONAL_EVENT_KEYS.includes(key)) {
      return { ok: false };
    }
  }
  const record = raw as Record<string, unknown>;
  const eventId = record.eventId;
  if (!isBoundedRequiredText(eventId, MAX_AUTHORITY_ORG_EXPORT_FIELD_LENGTH)) {
    return { ok: false };
  }
  const kind = record.kind;
  if (typeof kind !== 'string' || !EVENT_KINDS.includes(kind)) {
    return { ok: false };
  }
  const actor = record.actor;
  if (typeof actor !== 'string' || !AUTHORITY_ORG_ACTOR_PATTERN.test(actor)) {
    return { ok: false };
  }
  const atIso = record.atIso;
  if (
    typeof atIso !== 'string' ||
    atIso.length > MAX_AUTHORITY_ORG_EXPORT_AT_ISO_LENGTH ||
    !isZonedIsoDateTime(atIso)
  ) {
    return { ok: false };
  }
  const organizationId = hasOwn(raw, 'organizationId') ? record.organizationId : null;
  if (!isBoundedOptionalText(organizationId, MAX_AUTHORITY_ORG_EXPORT_FIELD_LENGTH)) {
    return { ok: false };
  }
  const beforeRevision = hasOwn(raw, 'beforeRevision') ? record.beforeRevision : null;
  if (!isBoundedOptionalText(beforeRevision, MAX_AUTHORITY_ORG_EXPORT_FIELD_LENGTH)) {
    return { ok: false };
  }
  const afterRevision = hasOwn(raw, 'afterRevision') ? record.afterRevision : null;
  if (!isBoundedOptionalText(afterRevision, MAX_AUTHORITY_ORG_EXPORT_FIELD_LENGTH)) {
    return { ok: false };
  }
  return {
    ok: true,
    event: {
      eventId,
      kind: kind as AuthorityOrgEventKind,
      actor,
      organizationId: normalizeOrganizationId(organizationId),
      rawOrganizationId: organizationId,
      atIso,
      beforeRevision,
      afterRevision,
    },
  };
}

/** Serializes one normalized event as a single JSONL line in the fixed key order. */
function serializeEvent(event: AuthorityOrgExportEvent): string {
  const line = JSON.stringify({
    eventId: event.eventId,
    kind: event.kind,
    actor: event.actor,
    organizationId: event.rawOrganizationId,
    atIso: event.atIso,
    beforeRevision: event.beforeRevision,
    afterRevision: event.afterRevision,
  });
  // Keep every line exactly one line: escape the JSON line separators.
  return line.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** The defence-in-depth re-check: parse a line and compare its organisation. */
function lineBelongsToOrganization(line: string, organizationId: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const record = parsed as Record<string, unknown>;
  if (!hasOwn(record, 'organizationId')) {
    return false;
  }
  const raw = record.organizationId;
  const normalized = raw === null || raw === undefined ? DEFAULT_ORGANIZATION_ID : raw;
  return typeof normalized === 'string' && normalized === organizationId;
}

/**
 * Deterministically exports one organisation's stream as JSONL with a paging
 * cursor. Never throws and never returns partial lines: every input is
 * validated before a single line is serialized, and every line is re-parsed
 * and re-checked before the export is returned.
 */
export function exportAuthorityEventsForOrg(
  input: unknown,
  isProxy: IsProxy,
  selectForOrg?: AuthorityOrgEventSelector,
): ExportAuthorityEventsForOrgResult {
  // One bounded snapshot of the whole request. Every `snapshotPlainData`
  // refusal (hostile shape, wrong type, bound exceeded) is `invalid-input`;
  // a non-function or throwing detector surfaces as `detector-threw` here.
  const snapshot = snapshotPlainData(input, isProxy, AUTHORITY_ORG_EXPORT_SNAPSHOT_LIMITS);
  if (!snapshot.ok) {
    return { ok: false, reason: 'invalid-input' };
  }
  const root = snapshot.value;
  // Root shape and prototype-polluting keys are checked explicitly after the
  // snapshot (the snapshot copies an own `__proto__` key as data).
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    return { ok: false, reason: 'invalid-input' };
  }
  for (const key of PROTOTYPE_KEYS) {
    if (hasOwn(root, key)) {
      return { ok: false, reason: 'invalid-input' };
    }
  }
  const rootKeys = Object.keys(root);
  if (rootKeys.length !== REQUIRED_ROOT_KEYS.length) {
    return { ok: false, reason: 'invalid-input' };
  }
  for (const key of REQUIRED_ROOT_KEYS) {
    if (!hasOwn(root, key)) {
      return { ok: false, reason: 'invalid-input' };
    }
  }
  const request = root as Record<string, unknown>;
  const organizationId = request.organizationId;
  if (!isBoundedRequiredText(organizationId, MAX_AUTHORITY_ORG_EXPORT_FIELD_LENGTH)) {
    return { ok: false, reason: 'invalid-input' };
  }
  const afterCursor = request.afterCursor;
  if (
    afterCursor !== null &&
    !isBoundedRequiredText(afterCursor, MAX_AUTHORITY_ORG_EXPORT_FIELD_LENGTH)
  ) {
    return { ok: false, reason: 'invalid-input' };
  }
  const limit = request.limit;
  if (
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_AUTHORITY_ORG_EXPORT_LIMIT
  ) {
    return { ok: false, reason: 'invalid-input' };
  }
  const events = request.events;
  if (!Array.isArray(events)) {
    return { ok: false, reason: 'invalid-input' };
  }
  // Every event is validated before any filtering or paging: O(n).
  const validated: AuthorityOrgExportEvent[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const read = validateEvent(events[index]);
    if (!read.ok) {
      return { ok: false, reason: 'invalid-input' };
    }
    validated.push(read.event);
  }
  // Bounded selection. The built-in filter is an index loop; an injected
  // selector's return value is snapshotted and index-walked, never iterated
  // with `for...of`, so a hostile `[Symbol.iterator]` is never invoked.
  let selected: readonly AuthorityOrgExportEvent[];
  if (selectForOrg === undefined) {
    const filtered: AuthorityOrgExportEvent[] = [];
    for (let index = 0; index < validated.length; index += 1) {
      if (validated[index].organizationId === organizationId) {
        filtered.push(validated[index]);
      }
    }
    selected = filtered;
  } else {
    let selectedRaw: unknown;
    try {
      selectedRaw = selectForOrg(validated, organizationId);
    } catch {
      return { ok: false, reason: 'foreign-event-leak' };
    }
    const selectedSnapshot = snapshotPlainData(
      selectedRaw,
      isProxy,
      AUTHORITY_ORG_EXPORT_SELECTOR_SNAPSHOT_LIMITS,
    );
    if (!selectedSnapshot.ok || !Array.isArray(selectedSnapshot.value)) {
      return { ok: false, reason: 'foreign-event-leak' };
    }
    const selectedArray = selectedSnapshot.value;
    const parsed: AuthorityOrgExportEvent[] = [];
    for (let index = 0; index < selectedArray.length; index += 1) {
      const read = validateEvent(selectedArray[index]);
      if (!read.ok) {
        return { ok: false, reason: 'foreign-event-leak' };
      }
      parsed.push(read.event);
    }
    selected = parsed;
  }
  // Duplicate `eventId` inside the selected stream is malformed input.
  const seen: Set<string> = new Set();
  for (let index = 0; index < selected.length; index += 1) {
    const id = selected[index].eventId;
    if (seen.has(id)) {
      return { ok: false, reason: 'invalid-input' };
    }
    seen.add(id);
  }
  // Cursor lookup happens inside the selected stream only: a cursor naming
  // another organisation's event is simply absent here, and its id is never
  // revealed.
  let start = 0;
  if (afterCursor !== null) {
    let cursorIndex = -1;
    for (let index = 0; index < selected.length; index += 1) {
      if (selected[index].eventId === afterCursor) {
        cursorIndex = index;
        break;
      }
    }
    if (cursorIndex < 0) {
      return { ok: false, reason: 'unknown-cursor' };
    }
    start = cursorIndex + 1;
  }
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let lastEventId: string | null = null;
  for (let index = start; index < selected.length && lines.length < limit; index += 1) {
    const line = serializeEvent(selected[index]);
    if (encoder.encode(line).length > MAX_AUTHORITY_ORG_EXPORT_LINE_BYTES) {
      return { ok: false, reason: 'line-too-long' };
    }
    // Defence in depth: re-parse every line and re-check its organization.
    if (!lineBelongsToOrganization(line, organizationId)) {
      return { ok: false, reason: 'foreign-event-leak' };
    }
    lines.push(line);
    lastEventId = selected[index].eventId;
  }
  return { ok: true, lines, nextCursor: lines.length === 0 ? null : lastEventId };
}
