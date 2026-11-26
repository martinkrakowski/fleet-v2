/**
 * Pure `AuthorityEvent` record, parser and JSONL exporter (FC12A).
 *
 * Stored-record rule (Q5a/Q5b): this module is DERIVED and NEVER STORED —
 * nothing here touches a port, an adapter or persistence. If a later unit
 * ever stores these events, it must write `schemaVersion: 1`, read an absent
 * `schemaVersion` as `1`, and refuse any unknown version on read.
 *
 * Cost bounds: `parseAuthorityEvent` is O(1) — every field is bounded
 * (`<= MAX_AUTHORITY_FIELD_LENGTH` characters) and the key set is fixed.
 * `exportAuthorityEventsJsonl` is O(n log n) time and O(n) space, bounded by
 * `n <= MAX_AUTHORITY_EXPORT_EVENTS` events and
 * `<= MAX_AUTHORITY_LINE_BYTES` UTF-8 bytes per line.
 *
 * Hostile-input rule: nothing here throws and no getter ever runs — every
 * value is read through its own property descriptor, accessors are refused
 * (the `get`/`set` is never invoked), and every reflective read is wrapped so
 * a trap that throws is a typed refusal.
 */

/** The exact event kinds an `AuthorityEvent` may carry. */
export const AUTHORITY_EVENT_KINDS = [
  'dispatch',
  'stop',
  'grant',
  'merge',
  'policy-change',
  'key-change',
  'membership-change',
  'operator-access',
] as const;

/** One of {@link AUTHORITY_EVENT_KINDS}. */
export type AuthorityEventKind = (typeof AUTHORITY_EVENT_KINDS)[number];

/** The most events `exportAuthorityEventsJsonl` will even consider. */
export const MAX_AUTHORITY_EXPORT_EVENTS = 50_000;

/** The most UTF-8 bytes one serialized JSONL line may occupy. */
export const MAX_AUTHORITY_LINE_BYTES = 4096;

/** The most characters any single string field may occupy. */
export const MAX_AUTHORITY_FIELD_LENGTH = 128;

/** The exact shape every `actor` value must have. */
export const AUTHORITY_ACTOR_PATTERN = /^[A-Za-z0-9._@-]{1,128}$/;

/** The ISO-8601 date-time shape `atIso` must match (a parse check alone is not enough). */
const AT_ISO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** One derived authority event. */
export interface AuthorityEvent {
  readonly eventId: string;
  readonly kind: AuthorityEventKind;
  readonly actor: string;
  readonly organizationId: string | null;
  readonly atIso: string;
  readonly beforeRevision: string | null;
  readonly afterRevision: string | null;
}

/** Which events `exportAuthorityEventsJsonl` selects (`null` selects only `null`-org events). */
export interface AuthorityEventFilter {
  readonly organizationId: string | null;
}

/** Refusal codes `parseAuthorityEvent` returns; none echo any supplied value. */
export type ParseAuthorityEventErrorCode =
  | 'not-a-plain-object'
  | 'hostile-input'
  | 'prototype-polluting-key'
  | 'invalid-keys'
  | 'invalid-event-id'
  | 'invalid-kind'
  | 'invalid-actor'
  | 'invalid-organization-id'
  | 'invalid-at-iso'
  | 'invalid-revision';

/** The outcome of one `parseAuthorityEvent` call. */
export type ParseAuthorityEventResult =
  | { readonly ok: true; readonly event: AuthorityEvent }
  | { readonly ok: false; readonly reason: ParseAuthorityEventErrorCode };

/** Refusal codes `exportAuthorityEventsJsonl` returns beyond the parse codes. */
export type ExportAuthorityEventsErrorCode =
  | ParseAuthorityEventErrorCode
  | 'not-an-array'
  | 'sparse-array'
  | 'too-large'
  | 'line-too-long'
  | 'invalid-filter';

/** The outcome of one `exportAuthorityEventsJsonl` call; a failure never carries partial text. */
export type ExportAuthorityEventsResult =
  | { readonly ok: true; readonly text: string; readonly count: number }
  | { readonly ok: false; readonly reason: ExportAuthorityEventsErrorCode };

/** Own keys whose presence marks the input as prototype-polluted. */
const PROTOTYPE_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/** The exactly-seven own keys a valid `AuthorityEvent` input has. */
const EVENT_KEYS: readonly string[] = [
  'eventId',
  'kind',
  'actor',
  'organizationId',
  'atIso',
  'beforeRevision',
  'afterRevision',
];

/** The exactly-one own key a valid filter has. */
const FILTER_KEYS: readonly string[] = ['organizationId'];

/** A required bounded text check: non-empty by definition. */
function isBoundedRequiredText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isBoundedTextWithin(value);
}

/** Shared tail of the bounded-text checks once non-emptiness is established. */
function isBoundedTextWithin(value: string): boolean {
  if (value.length > MAX_AUTHORITY_FIELD_LENGTH) {
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

/** An optional bounded text check: `null` or a non-empty bounded string. */
function isBoundedOptionalText(value: unknown): value is string | null {
  if (value === null) {
    return true;
  }
  return typeof value === 'string' && value.length > 0 && isBoundedTextWithin(value);
}

/**
 * Reads a plain object's own enumerable string keys through their property
 * descriptors, classifying any hostility. Returns a typed refusal, never a
 * throw and never a run getter.
 */
type PlainObjectRead =
  | { readonly ok: true; readonly values: ReadonlyMap<string, unknown> }
  | {
      readonly ok: false;
      readonly reason: 'not-a-plain-object' | 'hostile-input' | 'prototype-polluting-key' | 'invalid-keys';
    };

function readPlainObjectStrict(value: unknown, keys: readonly string[]): PlainObjectRead {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return { ok: false, reason: 'hostile-input' };
  }
  if (typeof value !== 'object' || value === null || isArray) {
    return { ok: false, reason: 'not-a-plain-object' };
  }
  let prototype: unknown;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return { ok: false, reason: 'hostile-input' };
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, reason: 'not-a-plain-object' };
  }
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return { ok: false, reason: 'hostile-input' };
  }
  // ACCEPTED RESIDUAL: a Proxy whose traps run consistently cannot be
  // distinguished from an ordinary object, because enumerating keys always
  // runs an `ownKeys` trap. JavaScript offers no way to enumerate without
  // that trap, so a consistently-lying Proxy is accepted here. What stays in
  // scope: a trap that THROWS returns this typed refusal, and no getter is
  // ever invoked — values are read only through
  // `Object.getOwnPropertyDescriptor`, and accessors are refused.
  const values = new Map<string, unknown>();
  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      return { ok: false, reason: 'hostile-input' };
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return { ok: false, reason: 'hostile-input' };
    }
    if (descriptor === undefined || !descriptor.enumerable) {
      return { ok: false, reason: 'hostile-input' };
    }
    // An own accessor is refused outright: the getter would run a hostile
    // closure, so `get`/`set` is never invoked.
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return { ok: false, reason: 'hostile-input' };
    }
    if (PROTOTYPE_KEYS.includes(key)) {
      return { ok: false, reason: 'prototype-polluting-key' };
    }
    if (!keys.includes(key)) {
      return { ok: false, reason: 'invalid-keys' };
    }
    values.set(key, descriptor.value);
  }
  for (const key of keys) {
    if (!values.has(key)) {
      return { ok: false, reason: 'invalid-keys' };
    }
  }
  return { ok: true, values };
}

/**
 * Parses one untrusted value into a frozen `AuthorityEvent`. Never throws,
 * never runs a getter, never echoes a supplied value into a reason.
 */
export function parseAuthorityEvent(raw: unknown): ParseAuthorityEventResult {
  const read = readPlainObjectStrict(raw, EVENT_KEYS);
  if (!read.ok) {
    return read;
  }
  const eventId = read.values.get('eventId');
  if (!isBoundedRequiredText(eventId)) {
    return { ok: false, reason: 'invalid-event-id' };
  }
  const kind = read.values.get('kind');
  if (typeof kind !== 'string' || !AUTHORITY_EVENT_KINDS.includes(kind as AuthorityEventKind)) {
    return { ok: false, reason: 'invalid-kind' };
  }
  const actor = read.values.get('actor');
  if (typeof actor !== 'string' || !AUTHORITY_ACTOR_PATTERN.test(actor)) {
    return { ok: false, reason: 'invalid-actor' };
  }
  const organizationId = read.values.get('organizationId');
  if (!isBoundedOptionalText(organizationId)) {
    return { ok: false, reason: 'invalid-organization-id' };
  }
  const atIso = read.values.get('atIso');
  if (!isBoundedRequiredText(atIso) || !AT_ISO_SHAPE.test(atIso) || !Number.isFinite(Date.parse(atIso))) {
    return { ok: false, reason: 'invalid-at-iso' };
  }
  const beforeRevision = read.values.get('beforeRevision');
  if (!isBoundedOptionalText(beforeRevision)) {
    return { ok: false, reason: 'invalid-revision' };
  }
  const afterRevision = read.values.get('afterRevision');
  if (!isBoundedOptionalText(afterRevision)) {
    return { ok: false, reason: 'invalid-revision' };
  }
  return {
    ok: true,
    event: Object.freeze({
      eventId: eventId,
      kind: kind as AuthorityEventKind,
      actor: actor,
      organizationId: organizationId,
      atIso: atIso,
      beforeRevision: beforeRevision,
      afterRevision: afterRevision,
    }),
  };
}

/**
 * Validates the filter argument of {@link exportAuthorityEventsJsonl}: a
 * plain object with exactly the `organizationId` key (`string | null` under
 * the same bounded-text rules).
 */
type FilterRead =
  | { readonly ok: true; readonly organizationId: string | null }
  | {
      readonly ok: false;
      readonly reason: 'not-a-plain-object' | 'hostile-input' | 'prototype-polluting-key' | 'invalid-keys' | 'invalid-organization-id';
    };

function readAuthorityEventFilter(filter: unknown): FilterRead {
  const read = readPlainObjectStrict(filter, FILTER_KEYS);
  if (!read.ok) {
    return read;
  }
  const organizationId = read.values.get('organizationId');
  if (!isBoundedOptionalText(organizationId)) {
    return { ok: false, reason: 'invalid-organization-id' };
  }
  return { ok: true, organizationId: organizationId as string | null };
}

/**
 * Serializes one frozen event with the fixed key order, escaping the JSON
 * line separators `U+2028`/`U+2029` so every line stays exactly one line.
 */
function serializeAuthorityEvent(event: AuthorityEvent): string {
  const line = JSON.stringify({
    eventId: event.eventId,
    kind: event.kind,
    actor: event.actor,
    organizationId: event.organizationId,
    atIso: event.atIso,
    beforeRevision: event.beforeRevision,
    afterRevision: event.afterRevision,
  });
  return line.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * Deterministically exports the filtered events as JSONL. Never throws and
 * never returns partial text: every input is validated (and every element
 * parsed) before a single line is serialized. The input array and its
 * elements are never mutated.
 */
export function exportAuthorityEventsJsonl(events: unknown, filter: unknown): ExportAuthorityEventsResult {
  let isArray: boolean;
  try {
    isArray = Array.isArray(events);
  } catch {
    return { ok: false, reason: 'hostile-input' };
  }
  if (!isArray) {
    return { ok: false, reason: 'not-an-array' };
  }
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(events, 'length');
  } catch {
    return { ok: false, reason: 'hostile-input' };
  }
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return { ok: false, reason: 'hostile-input' };
  }
  const length = lengthDescriptor.value;
  if (length > MAX_AUTHORITY_EXPORT_EVENTS) {
    return { ok: false, reason: 'too-large' };
  }
  const parsed: AuthorityEvent[] = [];
  for (let index = 0; index < length; index += 1) {
    let elementDescriptor: PropertyDescriptor | undefined;
    try {
      elementDescriptor = Object.getOwnPropertyDescriptor(events, index);
    } catch {
      return { ok: false, reason: 'hostile-input' };
    }
    // A missing descriptor is a hole (sparse array); an accessor or a
    // non-enumerable element is hostile — in every case the export refuses.
    if (elementDescriptor === undefined) {
      return { ok: false, reason: 'sparse-array' };
    }
    if (
      elementDescriptor.get !== undefined ||
      elementDescriptor.set !== undefined ||
      !elementDescriptor.enumerable
    ) {
      return { ok: false, reason: 'hostile-input' };
    }
    const parsedElement = parseAuthorityEvent(elementDescriptor.value);
    if (!parsedElement.ok) {
      return parsedElement;
    }
    parsed.push(parsedElement.event);
  }
  const filterRead = readAuthorityEventFilter(filter);
  if (!filterRead.ok) {
    return filterRead;
  }
  const selected = parsed.filter((event) => event.organizationId === filterRead.organizationId);
  // A fresh array, sorted in place: the caller's array and every element are
  // untouched, and the comparator is code-unit order on `atIso` then `eventId`.
  const sorted = [...selected].sort((left, right) => {
    if (left.atIso < right.atIso) {
      return -1;
    }
    if (left.atIso > right.atIso) {
      return 1;
    }
    if (left.eventId < right.eventId) {
      return -1;
    }
    if (left.eventId > right.eventId) {
      return 1;
    }
    return 0;
  });
  const encoder = new TextEncoder();
  const lines: string[] = [];
  for (const event of sorted) {
    const line = serializeAuthorityEvent(event);
    if (encoder.encode(line).length > MAX_AUTHORITY_LINE_BYTES) {
      return { ok: false, reason: 'line-too-long' };
    }
    lines.push(line);
  }
  const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  return { ok: true, text: text, count: lines.length };
}
