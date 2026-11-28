/**
 * FC12F: pure per-organisation authority event export filter. Given a request
 * (a log of authority events, the organisation to export, a cursor and a
 * page size) it returns one organisation's events as single-line JSON, in log
 * order, a page at a time, or a typed refusal. Another organisation's events
 * never appear, never move the cursor and are never named in a refusal.
 *
 * Domain-only: no port, no clock, no randomness, no I/O, no import of the
 * tenancy or operator-coordination contexts. Untrusted input is read once
 * through the shared `snapshotPlainData` (bounded by this unit's own limits),
 * so no getter and no Proxy trap runs here. Nothing rejected is ever echoed.
 */

import { snapshotPlainData, type IsProxy, type PlainDataLimits } from '@fleet/shared';

import { isZonedIsoDateTime } from './conductor-halt.js';

/** The organisation an event with no `organizationId` belongs to. */
export const DEFAULT_ORGANIZATION_ID = 'default';

/** Most events one request may carry (and one selector may return). */
export const MAX_AUTHORITY_ORG_EXPORT_EVENTS = 50_000;

/** Largest page a request may ask for. */
export const MAX_AUTHORITY_ORG_EXPORT_LIMIT = 1000;

/** Longest serialized line, in UTF-8 bytes. */
export const MAX_AUTHORITY_ORG_EXPORT_LINE_BYTES = 4096;

/** Longest id, actor, cursor, organisation or revision, in characters. */
export const MAX_AUTHORITY_ORG_EXPORT_FIELD_LENGTH = 128;

/** Longest `atIso`, in characters. */
export const MAX_AUTHORITY_ORG_EXPORT_AT_ISO_LENGTH = 64;

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

export type AuthorityOrgEventKind = (typeof AUTHORITY_ORG_EVENT_KINDS)[number];

export const AUTHORITY_ORG_ACTOR_PATTERN = /^[A-Za-z0-9._@-]{1,128}$/;

/** Bounds for the request snapshot: root, events array and each event. */
export const AUTHORITY_ORG_EXPORT_SNAPSHOT_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 6,
  maxKeys: 16,
  maxArrayLength: MAX_AUTHORITY_ORG_EXPORT_EVENTS,
  maxNodes: MAX_AUTHORITY_ORG_EXPORT_EVENTS * 9 + 16,
  maxStringLength: 1024,
});

/** Bounds for the snapshot of what an injected selector returns. */
export const AUTHORITY_ORG_EXPORT_SELECTOR_SNAPSHOT_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 4,
  maxKeys: 16,
  maxArrayLength: MAX_AUTHORITY_ORG_EXPORT_EVENTS,
  maxNodes: MAX_AUTHORITY_ORG_EXPORT_EVENTS * 9 + 16,
  maxStringLength: 1024,
});

/** One validated event; omitted optional fields are normalized to `null`. */
export interface AuthorityOrgEvent {
  readonly eventId: string;
  readonly kind: AuthorityOrgEventKind;
  readonly actor: string;
  readonly organizationId: string | null;
  readonly atIso: string;
  readonly beforeRevision: string | null;
  readonly afterRevision: string | null;
}

/**
 * The seam that picks one organisation's events from the validated log. The
 * built-in filter is used when none is given; a caller-supplied one exists to
 * prove the leak guard, and its answer is treated as untrusted.
 */
export type AuthorityOrgEventSelector = (
  events: readonly AuthorityOrgEvent[],
  organizationId: string,
) => unknown;

export type AuthorityOrgExportRefusalReason =
  | 'invalid-input'
  | 'unknown-cursor'
  | 'foreign-event-leak'
  | 'line-too-long';

export type ExportAuthorityEventsForOrgResult =
  | { readonly ok: true; readonly lines: readonly string[]; readonly nextCursor: string | null }
  | { readonly ok: false; readonly reason: AuthorityOrgExportRefusalReason };

const REQUEST_KEYS: readonly string[] = ['events', 'organizationId', 'afterCursor', 'limit'];
const REQUIRED_EVENT_KEYS: readonly string[] = ['eventId', 'kind', 'actor', 'atIso'];
const OPTIONAL_EVENT_KEYS: readonly string[] = ['organizationId', 'beforeRevision', 'afterRevision'];

const INVALID_INPUT = { ok: false, reason: 'invalid-input' } as const;
const UNKNOWN_CURSOR = { ok: false, reason: 'unknown-cursor' } as const;
const FOREIGN_LEAK = { ok: false, reason: 'foreign-event-leak' } as const;
const LINE_TOO_LONG = { ok: false, reason: 'line-too-long' } as const;

/** A non-empty string of at most 128 characters with no ASCII control character. */
function isBoundedText(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_AUTHORITY_ORG_EXPORT_FIELD_LENGTH
  ) {
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

/** A snapshotted value that is a plain-object copy (never an array, never null). */
function isRecordCopy(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `O(own keys)`: every own key of a snapshotted record is in `allowed` (an own
 * `__proto__`, `constructor` or `prototype` key is never allowed) and every
 * `required` key is present. The snapshot already refused symbol keys,
 * accessors and non-enumerable keys.
 */
function hasExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      return false;
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      return false;
    }
  }
  return true;
}

/** An optional text field: omitted or `null` reads as `null`; otherwise bounded text. */
function readOptionalText(record: Record<string, unknown>, key: string): string | null | undefined {
  if (!Object.hasOwn(record, key)) {
    return null;
  }
  const value = record[key];
  if (value === null) {
    return null;
  }
  return isBoundedText(value) ? value : undefined;
}

/** Validates one snapshotted event; null when any field is malformed. */
function readEvent(value: unknown): AuthorityOrgEvent | null {
  if (!isRecordCopy(value) || !hasExactKeys(value, REQUIRED_EVENT_KEYS, OPTIONAL_EVENT_KEYS)) {
    return null;
  }
  const { eventId, kind, actor, atIso } = value;
  if (
    !isBoundedText(eventId) ||
    typeof kind !== 'string' ||
    !(AUTHORITY_ORG_EVENT_KINDS as readonly string[]).includes(kind) ||
    typeof actor !== 'string' ||
    !AUTHORITY_ORG_ACTOR_PATTERN.test(actor) ||
    typeof atIso !== 'string' ||
    atIso.length > MAX_AUTHORITY_ORG_EXPORT_AT_ISO_LENGTH ||
    !isZonedIsoDateTime(atIso)
  ) {
    return null;
  }
  const organizationId = readOptionalText(value, 'organizationId');
  const beforeRevision = readOptionalText(value, 'beforeRevision');
  const afterRevision = readOptionalText(value, 'afterRevision');
  if (organizationId === undefined || beforeRevision === undefined || afterRevision === undefined) {
    return null;
  }
  return {
    eventId,
    kind: kind as AuthorityOrgEventKind,
    actor,
    organizationId,
    atIso,
    beforeRevision,
    afterRevision,
  };
}

/** The organisation an event belongs to; an absent or `null` id is the default one. */
function organizationOf(event: AuthorityOrgEvent): string {
  return event.organizationId ?? DEFAULT_ORGANIZATION_ID;
}

/** `O(n)`: validates every element of a snapshotted array; null if any is malformed. */
function readEvents(value: unknown): AuthorityOrgEvent[] | null {
  if (!Array.isArray(value) || value.length > MAX_AUTHORITY_ORG_EXPORT_EVENTS) {
    return null;
  }
  const events: AuthorityOrgEvent[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const event = readEvent(value[index]);
    if (event === null) {
      return null;
    }
    events.push(event);
  }
  return events;
}

interface ExportRequest {
  readonly events: AuthorityOrgEvent[];
  readonly organizationId: string;
  readonly afterCursor: string | null;
  readonly limit: number;
}

/** Validates the snapshotted request root; null when anything is malformed. */
function readRequest(value: unknown): ExportRequest | null {
  if (!isRecordCopy(value) || !hasExactKeys(value, REQUEST_KEYS, [])) {
    return null;
  }
  const { organizationId, afterCursor, limit } = value;
  if (!isBoundedText(organizationId)) {
    return null;
  }
  if (afterCursor !== null && !isBoundedText(afterCursor)) {
    return null;
  }
  if (
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    Object.is(limit, -0) ||
    limit < 1 ||
    limit > MAX_AUTHORITY_ORG_EXPORT_LIMIT
  ) {
    return null;
  }
  const events = readEvents(value.events);
  if (events === null) {
    return null;
  }
  return { events, organizationId, afterCursor, limit };
}

/** The built-in filter: an index loop over the validated log, in log order. */
function selectOwnEvents(
  events: readonly AuthorityOrgEvent[],
  organizationId: string,
): AuthorityOrgEvent[] {
  const selected: AuthorityOrgEvent[] = [];
  for (let index = 0; index < events.length; index += 1) {
    if (organizationOf(events[index]) === organizationId) {
      selected.push(events[index]);
    }
  }
  return selected;
}

/**
 * Reads an injected selector's answer as untrusted data: one bounded
 * snapshot (never `for...of`, so no `[Symbol.iterator]` runs), then every
 * element re-validated. Null means the whole export is refused as a leak.
 */
function readSelected(
  select: AuthorityOrgEventSelector,
  events: readonly AuthorityOrgEvent[],
  organizationId: string,
  isProxy: IsProxy,
): AuthorityOrgEvent[] | null {
  let raw: unknown;
  try {
    raw = select(events, organizationId);
  } catch {
    return null;
  }
  const snapshot = snapshotPlainData(raw, isProxy, AUTHORITY_ORG_EXPORT_SELECTOR_SNAPSHOT_LIMITS);
  if (!snapshot.ok) {
    return null;
  }
  return readEvents(snapshot.value);
}

/** One event as a single JSON line with a fixed key order and the line separators escaped. */
function serializeEvent(event: AuthorityOrgEvent): string {
  return JSON.stringify({
    eventId: event.eventId,
    kind: event.kind,
    actor: event.actor,
    organizationId: event.organizationId,
    atIso: event.atIso,
    beforeRevision: event.beforeRevision,
    afterRevision: event.afterRevision,
  })
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}

/**
 * The structural start of a line for an event of `organizationId`. A rejected
 * text can never forge it: JSON escapes the quote that would have to close a
 * string field first.
 */
function expectedLinePrefix(event: AuthorityOrgEvent, organizationId: string): string {
  // The default organisation's events carry `null`; any other carries the requested id.
  const organizationJson = event.organizationId === null ? 'null' : JSON.stringify(organizationId);
  return (
    `{"eventId":${JSON.stringify(event.eventId)},"kind":${JSON.stringify(event.kind)},` +
    `"actor":${JSON.stringify(event.actor)},"organizationId":${organizationJson},`
  );
}

/**
 * Exports one organisation's authority events, paged by cursor, in log order.
 *
 * Cost: the snapshot is `O(N)` bounded by `maxNodes` and `maxDepth`; validation,
 * the duplicate check, filtering, the cursor lookup, serialization and the leak
 * guard are `O(n)` time and space for `n <= MAX_AUTHORITY_ORG_EXPORT_EVENTS`.
 * `isProxy` is a required detector, never defaulted: a default "nothing is a
 * Proxy" detector would let a hostile Proxy run its traps during the snapshot.
 * Never throws; a refusal never carries any input value.
 */
export function exportAuthorityEventsForOrg(
  input: unknown,
  isProxy: IsProxy,
  selectForOrg?: AuthorityOrgEventSelector,
): ExportAuthorityEventsForOrgResult {
  try {
    if (typeof isProxy !== 'function') {
      return INVALID_INPUT;
    }
    const snapshot = snapshotPlainData(input, isProxy, AUTHORITY_ORG_EXPORT_SNAPSHOT_LIMITS);
    if (!snapshot.ok) {
      return INVALID_INPUT;
    }
    const request = readRequest(snapshot.value);
    if (request === null) {
      return INVALID_INPUT;
    }
    const selected =
      selectForOrg === undefined
        ? selectOwnEvents(request.events, request.organizationId)
        : readSelected(selectForOrg, request.events, request.organizationId, isProxy);
    if (selected === null) {
      return FOREIGN_LEAK;
    }
    for (let index = 0; index < selected.length; index += 1) {
      if (organizationOf(selected[index]) !== request.organizationId) {
        return FOREIGN_LEAK;
      }
    }
    const seen = new Set<string>();
    for (let index = 0; index < selected.length; index += 1) {
      if (seen.has(selected[index].eventId)) {
        return INVALID_INPUT;
      }
      seen.add(selected[index].eventId);
    }
    let start = 0;
    if (request.afterCursor !== null) {
      let found = -1;
      for (let index = 0; index < selected.length; index += 1) {
        if (selected[index].eventId === request.afterCursor) {
          found = index;
          break;
        }
      }
      if (found < 0) {
        return UNKNOWN_CURSOR;
      }
      start = found + 1;
    }
    const page = selected.slice(start, start + request.limit);
    const encoder = new TextEncoder();
    const lines: string[] = [];
    for (let index = 0; index < page.length; index += 1) {
      const line = serializeEvent(page[index]);
      if (encoder.encode(line).length > MAX_AUTHORITY_ORG_EXPORT_LINE_BYTES) {
        return LINE_TOO_LONG;
      }
      if (!line.startsWith(expectedLinePrefix(page[index], request.organizationId))) {
        return FOREIGN_LEAK;
      }
      lines.push(line);
    }
    return {
      ok: true,
      lines,
      nextCursor: page.length === 0 ? null : page[page.length - 1].eventId,
    };
  } catch {
    return INVALID_INPUT;
  }
}
