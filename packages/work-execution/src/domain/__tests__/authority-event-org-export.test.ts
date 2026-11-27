import { types } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import {
  exportAuthorityEventsForOrg,
  MAX_AUTHORITY_ORG_EXPORT_EVENTS,
  MAX_AUTHORITY_ORG_EXPORT_LINE_BYTES,
  type AuthorityOrgEventSelector,
} from '../authority-event-org-export.js';

const isProxy = types.isProxy;

/** A zoned ISO time, built at runtime from parts. */
function atIso(day: number): string {
  return `2026-01-${`${day}`.padStart(2, '0')}T12:00:00Z`;
}

/** A valid event with all seven keys (or fewer via overrides). */
function validEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'ev-1',
    kind: 'stop',
    actor: 'op.lane',
    organizationId: null,
    atIso: atIso(2),
    beforeRevision: null,
    afterRevision: null,
    ...overrides,
  };
}

/** A valid request object with exactly the four own keys. */
function request(events: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    events,
    organizationId: 'org-a',
    afterCursor: null,
    limit: 1000,
    ...overrides,
  };
}

/** A request whose events are sparse (a hole at index 1). */
function sparseEvents(): unknown[] {
  const events = [validEvent(), validEvent({ eventId: 'ev-2' })];
  delete events[1];
  return events;
}

describe('exportAuthorityEventsForOrg', () => {
  it('exports one organisation stream as single-line JSONL with a cursor', () => {
    const events = [
      validEvent({ eventId: 'ev-a1', organizationId: 'org-a', atIso: atIso(1) }),
      validEvent({ eventId: 'ev-b1', organizationId: 'org-b', atIso: atIso(2) }),
      validEvent({ eventId: 'ev-a2', organizationId: 'org-a', atIso: atIso(3) }),
    ];
    const result = exportAuthorityEventsForOrg(request(events), isProxy);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.lines).toHaveLength(2);
    expect(result.nextCursor).toBe('ev-a2');
    const parsed = result.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed[0].eventId).toBe('ev-a1');
    expect(parsed[1].eventId).toBe('ev-a2');
    expect(parsed[1].organizationId).toBe('org-a');
    expect(result.lines[0].includes('\n')).toBe(false);
  });

  it('never includes org B events when exporting org A from an interleaved log', () => {
    const events = [
      validEvent({ eventId: 'ev-b1', organizationId: 'org-b' }),
      validEvent({ eventId: 'ev-a1', organizationId: 'org-a' }),
      validEvent({ eventId: 'ev-b2', organizationId: 'org-b' }),
      validEvent({ eventId: 'ev-a2', organizationId: 'org-a' }),
      validEvent({ eventId: 'ev-b3', organizationId: 'org-b' }),
    ];
    const result = exportAuthorityEventsForOrg(request(events), isProxy);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const ids = result.lines.map(
      (line) => (JSON.parse(line) as Record<string, unknown>).eventId,
    );
    expect(ids).toEqual(['ev-a1', 'ev-a2']);
    for (const line of result.lines) {
      expect((JSON.parse(line) as Record<string, unknown>).organizationId).toBe('org-a');
    }
  });

  it('reconstructs the full org stream via cursor paging with no duplicate and no gap', () => {
    const events = [
      validEvent({ eventId: 'ev-a1', organizationId: 'org-a', atIso: atIso(1) }),
      validEvent({ eventId: 'ev-b1', organizationId: 'org-b', atIso: atIso(2) }),
      validEvent({ eventId: 'ev-a2', organizationId: 'org-a', atIso: atIso(3) }),
      validEvent({ eventId: 'ev-b2', organizationId: 'org-b', atIso: atIso(4) }),
      validEvent({ eventId: 'ev-a3', organizationId: 'org-a', atIso: atIso(5) }),
    ];
    const paged: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result = exportAuthorityEventsForOrg(
        request(events, { afterCursor: cursor, limit: 2 }),
        isProxy,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      paged.push(...result.lines);
      if (result.nextCursor === null) {
        break;
      }
      cursor = result.nextCursor;
    }
    const ids = paged.map((line) => (JSON.parse(line) as Record<string, unknown>).eventId);
    expect(ids).toEqual(['ev-a1', 'ev-a2', 'ev-a3']);
    expect(new Set(ids).size).toBe(ids.length);
    // No org B event leaked into the paged stream.
    for (const line of paged) {
      expect((JSON.parse(line) as Record<string, unknown>).organizationId).toBe('org-a');
    }
  });

  it('accepts limit boundaries 1 and 1000 and refuses 0 and 1001', () => {
    const events = [
      validEvent({ eventId: 'ev-a1', organizationId: 'org-a' }),
      validEvent({ eventId: 'ev-a2', organizationId: 'org-a' }),
    ];
    expect(exportAuthorityEventsForOrg(request(events, { limit: 1 }), isProxy).ok).toBe(true);
    expect(exportAuthorityEventsForOrg(request(events, { limit: 1000 }), isProxy).ok).toBe(true);
    const zero = exportAuthorityEventsForOrg(request(events, { limit: 0 }), isProxy);
    expect(zero).toEqual({ ok: false, reason: 'invalid-input' });
    const over = exportAuthorityEventsForOrg(request(events, { limit: 1001 }), isProxy);
    expect(over).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('treats events with omitted organizationId key or null organizationId as belonging to default', () => {
    const omitted: Record<string, unknown> = {
      eventId: 'ev-omit',
      kind: 'stop',
      actor: 'op.lane',
      atIso: atIso(2),
    };
    const events = [
      omitted,
      validEvent({ eventId: 'ev-null', organizationId: null }),
      validEvent({ eventId: 'ev-a', organizationId: 'org-a' }),
    ];
    const defaultResult = exportAuthorityEventsForOrg(
      request(events, { organizationId: 'default' }),
      isProxy,
    );
    expect(defaultResult.ok).toBe(true);
    if (defaultResult.ok) {
      const ids = defaultResult.lines.map(
        (line) => (JSON.parse(line) as Record<string, unknown>).eventId,
      );
      expect(ids).toEqual(['ev-omit', 'ev-null']);
      for (const line of defaultResult.lines) {
        expect((JSON.parse(line) as Record<string, unknown>).organizationId).toBeNull();
      }
      expect(defaultResult.nextCursor).toBe('ev-null');
    }
    const orgAResult = exportAuthorityEventsForOrg(request(events), isProxy);
    expect(orgAResult.ok).toBe(true);
    if (orgAResult.ok) {
      expect(orgAResult.lines).toHaveLength(1);
      expect(orgAResult.nextCursor).toBe('ev-a');
    }
  });

  it('returns zero lines and null nextCursor for an empty log or exhausted cursor', () => {
    const empty = exportAuthorityEventsForOrg(request([]), isProxy);
    expect(empty).toEqual({ ok: true, lines: [], nextCursor: null });
    const events = [
      validEvent({ eventId: 'ev-a1', organizationId: 'org-a' }),
      validEvent({ eventId: 'ev-a2', organizationId: 'org-a' }),
    ];
    const exhausted = exportAuthorityEventsForOrg(
      request(events, { afterCursor: 'ev-a2' }),
      isProxy,
    );
    expect(exhausted).toEqual({ ok: true, lines: [], nextCursor: null });
  });

  it('escapes U+2028 and U+2029 in serialized JSONL lines so every output line contains no raw line separators', () => {
    const separator = `${String.fromCharCode(0x2028)}mid${String.fromCharCode(0x2029)}`;
    const events = [
      validEvent({ eventId: `ev${separator}1`, organizationId: 'org-a' }),
    ];
    const result = exportAuthorityEventsForOrg(request(events), isProxy);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.lines).toHaveLength(1);
    const line = result.lines[0];
    expect(line.includes(String.fromCharCode(0x2028))).toBe(false);
    expect(line.includes(String.fromCharCode(0x2029))).toBe(false);
    expect(line.includes('\\u2028')).toBe(true);
    expect(line.includes('\\u2029')).toBe(true);
    expect(line.includes('\n')).toBe(false);
    expect((JSON.parse(line) as Record<string, unknown>).eventId).toBe(
      `ev${separator}1`,
    );
  });

  it('refuses null, undefined, wrong primitives, non-iterables, array-likes, sparse holes, and enormous length as invalid-input', () => {
    expect(exportAuthorityEventsForOrg(null, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
    expect(exportAuthorityEventsForOrg(undefined, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
    expect(exportAuthorityEventsForOrg(0, isProxy).ok).toBe(false);
    expect(exportAuthorityEventsForOrg(1.5, isProxy).ok).toBe(false);
    expect(exportAuthorityEventsForOrg(false, isProxy).ok).toBe(false);
    expect(exportAuthorityEventsForOrg('events', isProxy).ok).toBe(false);
    expect(exportAuthorityEventsForOrg(Symbol('s'), isProxy).ok).toBe(false);
    expect(exportAuthorityEventsForOrg(BigInt(1), isProxy).ok).toBe(false);
    // A Map is not a plain object: a non-iterable, non-plain container.
    expect(exportAuthorityEventsForOrg(new Map(), isProxy).ok).toBe(false);
    // An array-like is not an array.
    expect(exportAuthorityEventsForOrg({ length: 1, 0: validEvent() }, isProxy).ok).toBe(false);
    // A sparse hole in `events`.
    const sparse = exportAuthorityEventsForOrg(request(sparseEvents()), isProxy);
    expect(sparse).toEqual({ ok: false, reason: 'invalid-input' });
    // An enormous array length is refused without walking its keys.
    const enormous: unknown[] = [validEvent({ organizationId: 'org-a' })];
    Object.defineProperty(enormous, 'length', { value: MAX_AUTHORITY_ORG_EXPORT_EVENTS + 1 });
    expect(exportAuthorityEventsForOrg(request(enormous), isProxy)).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
  });

  it('refuses Proxy, getter without invoking it, and sparse hole inputs as invalid-input', () => {
    const getterSpy = vi.fn(() => {
      throw new Error('getter must never run');
    });
    const hostileRoot = request([]);
    Object.defineProperty(hostileRoot, 'limit', { get: getterSpy, enumerable: true });
    const getterResult = exportAuthorityEventsForOrg(hostileRoot, isProxy);
    expect(getterResult).toEqual({ ok: false, reason: 'invalid-input' });
    expect(getterSpy).not.toHaveBeenCalled();
    const proxyResult = exportAuthorityEventsForOrg(new Proxy(request([]), {}), isProxy);
    expect(proxyResult).toEqual({ ok: false, reason: 'invalid-input' });
    const holeResult = exportAuthorityEventsForOrg(request(sparseEvents()), isProxy);
    expect(holeResult).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses arrays carrying own symbol keys, non-enumerable own keys, or extra properties as invalid-input', () => {
    const symbolKeyed = [validEvent({ organizationId: 'org-a' })];
    Object.defineProperty(symbolKeyed, Symbol('tag'), { value: 1 });
    expect(exportAuthorityEventsForOrg(request(symbolKeyed), isProxy)).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
    const nonEnumerable = [validEvent({ organizationId: 'org-a' })];
    Object.defineProperty(nonEnumerable, 'extra', { value: 1, enumerable: false });
    expect(exportAuthorityEventsForOrg(request(nonEnumerable), isProxy).ok).toBe(false);
    const extraKeyed = [validEvent({ organizationId: 'org-a' })];
    Object.defineProperty(extraKeyed, 'extra', { value: 1, enumerable: true });
    expect(exportAuthorityEventsForOrg(request(extraKeyed), isProxy).ok).toBe(false);
  });

  it('refuses prototype-polluting keys including constructor, prototype, and own __proto__ on root and event objects as invalid-input', () => {
    const rootProto = request([validEvent({ organizationId: 'org-a' })]);
    Object.defineProperty(rootProto, '__proto__', { value: {}, enumerable: true });
    expect(exportAuthorityEventsForOrg(rootProto, isProxy)).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
    const rootConstructor = request([]);
    Object.defineProperty(rootConstructor, 'constructor', { value: 'x', enumerable: true });
    expect(exportAuthorityEventsForOrg(rootConstructor, isProxy).ok).toBe(false);
    const rootPrototype = request([]);
    Object.defineProperty(rootPrototype, 'prototype', { value: 'x', enumerable: true });
    expect(exportAuthorityEventsForOrg(rootPrototype, isProxy).ok).toBe(false);
    const eventProto: Record<string, unknown> = validEvent({ organizationId: 'org-a' });
    Object.defineProperty(eventProto, '__proto__', { value: {}, enumerable: true });
    expect(exportAuthorityEventsForOrg(request([eventProto]), isProxy).ok).toBe(false);
    const eventConstructor: Record<string, unknown> = validEvent({ organizationId: 'org-a' });
    Object.defineProperty(eventConstructor, 'constructor', { value: 'x', enumerable: true });
    expect(exportAuthorityEventsForOrg(request([eventConstructor]), isProxy).ok).toBe(false);
    const eventPrototype: Record<string, unknown> = validEvent({ organizationId: 'org-a' });
    Object.defineProperty(eventPrototype, 'prototype', { value: 'x', enumerable: true });
    expect(exportAuthorityEventsForOrg(request([eventPrototype]), isProxy).ok).toBe(false);
  });

  it('refuses invalid request fields and malformed event kind, atIso, actor, and revision values without echoing input', () => {
    const events = [validEvent({ organizationId: 'org-a' })];
    const badRoots: Array<Record<string, unknown>> = [
      request(events, { organizationId: '' }),
      request(events, { organizationId: null }),
      request(events, { organizationId: 7 }),
      request(events, { organizationId: 'o'.repeat(129) }),
      request(events, { organizationId: 'org\na' }),
      request(events, { afterCursor: '' }),
      request(events, { afterCursor: 12 }),
      request(events, { afterCursor: 'a'.repeat(129) }),
      request(events, { afterCursor: 'cur\u0001sor' }),
      request(events, { limit: 0 }),
      request(events, { limit: 1001 }),
      request(events, { limit: 1.5 }),
      request(events, { limit: Number.NaN }),
      request(events, { limit: Number.POSITIVE_INFINITY }),
      request(events, { events: 'not-an-array' }),
    ];
    for (const badRoot of badRoots) {
      expect(exportAuthorityEventsForOrg(badRoot, isProxy)).toEqual({
        ok: false,
        reason: 'invalid-input',
      });
    }
    const badEvents: Array<Record<string, unknown>> = [
      validEvent({ eventId: '', organizationId: 'org-a' }),
      validEvent({ eventId: 'e'.repeat(129), organizationId: 'org-a' }),
      validEvent({ eventId: 'ev\u0001', organizationId: 'org-a' }),
      validEvent({ kind: 'bogus', organizationId: 'org-a' }),
      validEvent({ actor: 'op lane!', organizationId: 'org-a' }),
      validEvent({ atIso: '2026-01-02T12:00:00', organizationId: 'org-a' }),
      validEvent({ atIso: '2026-13-02T12:00:00Z', organizationId: 'org-a' }),
      validEvent({ atIso: `${'2'.repeat(65)}Z`, organizationId: 'org-a' }),
      validEvent({ organizationId: '' }),
      validEvent({ organizationId: 'org-a'.repeat(40) }),
      validEvent({ beforeRevision: 'r'.repeat(129), organizationId: 'org-a' }),
      validEvent({ beforeRevision: 'rev\u0001', organizationId: 'org-a' }),
      validEvent({ afterRevision: 12, organizationId: 'org-a' }),
      validEvent({ afterRevision: '', organizationId: 'org-a' }),
      // Missing and extra keys on an event object.
      { eventId: 'ev-1', kind: 'stop', organizationId: 'org-a', atIso: atIso(2) },
      { ...validEvent({ organizationId: 'org-a' }), extra: 1 },
      // An own undefined property is refused by the snapshot.
      { ...validEvent({ organizationId: 'org-a' }), beforeRevision: undefined },
      // Malformed fields refuse even on another organisation's event.
      validEvent({ kind: 'bogus', organizationId: 'org-b' }),
    ];
    for (const badEvent of badEvents) {
      expect(exportAuthorityEventsForOrg(request([badEvent]), isProxy)).toEqual({
        ok: false,
        reason: 'invalid-input',
      });
    }
    // No refusal ever echoes a value: every result has exactly two keys.
    const first = exportAuthorityEventsForOrg(request(events, { limit: 1001 }), isProxy);
    expect(Object.keys(first)).toEqual(['ok', 'reason']);
  });

  it('refuses duplicate eventId within the requested organisation stream as invalid-input', () => {
    const events = [
      validEvent({ eventId: 'ev-dup', organizationId: 'org-a', atIso: atIso(1) }),
      validEvent({ eventId: 'ev-dup', organizationId: 'org-a', atIso: atIso(2) }),
      validEvent({ eventId: 'ev-dup', organizationId: 'org-b' }),
    ];
    const result = exportAuthorityEventsForOrg(request(events), isProxy);
    expect(result).toEqual({ ok: false, reason: 'invalid-input' });
    // The same id in two different streams is not a duplicate.
    const otherOrg = exportAuthorityEventsForOrg(
      request(events, { organizationId: 'org-b' }),
      isProxy,
    );
    expect(otherOrg.ok).toBe(true);
  });

  it('refuses non-function or throwing isProxy detector as invalid-input', () => {
    const events = [validEvent({ organizationId: 'org-a' })];
    const nonFunction = exportAuthorityEventsForOrg(
      request(events),
      42 as unknown as typeof isProxy,
    );
    expect(nonFunction).toEqual({ ok: false, reason: 'invalid-input' });
    const throwing = exportAuthorityEventsForOrg(
      request(events),
      () => {
        throw new Error('detector blew up');
      },
    );
    expect(throwing).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses an unknown cursor as unknown-cursor', () => {
    const events = [validEvent({ eventId: 'ev-a1', organizationId: 'org-a' })];
    const result = exportAuthorityEventsForOrg(
      request(events, { afterCursor: 'ev-nope' }),
      isProxy,
    );
    expect(result).toEqual({ ok: false, reason: 'unknown-cursor' });
  });

  it('refuses a cursor naming another organisation event as unknown-cursor', () => {
    const events = [
      validEvent({ eventId: 'ev-a1', organizationId: 'org-a' }),
      validEvent({ eventId: 'ev-b1', organizationId: 'org-b' }),
    ];
    const result = exportAuthorityEventsForOrg(
      request(events, { afterCursor: 'ev-b1' }),
      isProxy,
    );
    expect(result).toEqual({ ok: false, reason: 'unknown-cursor' });
  });

  it('refuses the whole export as foreign-event-leak when the injected selector leaks another organisation event', () => {
    const events = [
      validEvent({ eventId: 'ev-a1', organizationId: 'org-a' }),
      validEvent({ eventId: 'ev-b1', organizationId: 'org-b' }),
    ];
    const leakySelector: AuthorityOrgEventSelector = () => events;
    const result = exportAuthorityEventsForOrg(request([events[0]]), isProxy, leakySelector);
    expect(result).toEqual({ ok: false, reason: 'foreign-event-leak' });
  });

  it('refuses a selector returning a hostile iterator, Proxy, forbidden own array keys, or length exceeding 50_000 as foreign-event-leak in bounded time', () => {
    const validA = validEvent({ eventId: 'ev-a1', organizationId: 'org-a' });
    // A hostile `[Symbol.iterator]` must never be invoked: the snapshot
    // refuses the own symbol key without enumerating through the iterator.
    const hostileIterator: unknown[] = [validA];
    Object.defineProperty(hostileIterator, Symbol.iterator, {
      value: () => {
        throw new Error('iterator must never run');
      },
    });
    const iteratorResult = exportAuthorityEventsForOrg(
      request([validA]),
      isProxy,
      () => hostileIterator,
    );
    expect(iteratorResult).toEqual({ ok: false, reason: 'foreign-event-leak' });
    // A Proxy among the selector output.
    const proxyResult = exportAuthorityEventsForOrg(
      request([validA]),
      isProxy,
      () => new Proxy([validA], {}),
    );
    expect(proxyResult).toEqual({ ok: false, reason: 'foreign-event-leak' });
    // A getter element is refused without being invoked.
    const getter = vi.fn(() => {
      throw new Error('getter must never run');
    });
    const getterArray: unknown[] = [];
    Object.defineProperty(getterArray, 0, { get: getter, enumerable: true });
    const getterResult = exportAuthorityEventsForOrg(
      request([validA]),
      isProxy,
      () => getterArray,
    );
    expect(getterResult).toEqual({ ok: false, reason: 'foreign-event-leak' });
    expect(getter).not.toHaveBeenCalled();
    // A non-array return value.
    const nonArray = exportAuthorityEventsForOrg(
      request([validA]),
      isProxy,
      () => 'not-an-array',
    );
    expect(nonArray).toEqual({ ok: false, reason: 'foreign-event-leak' });
    // Own symbol and extra keys on the returned array.
    const symbolKeyed: unknown[] = [validA];
    Object.defineProperty(symbolKeyed, Symbol('tag'), { value: 1 });
    expect(
      exportAuthorityEventsForOrg(request([validA]), isProxy, () => symbolKeyed),
    ).toEqual({ ok: false, reason: 'foreign-event-leak' });
    const extraKeyed: unknown[] = [validA];
    Object.defineProperty(extraKeyed, 'extra', { value: 1, enumerable: true });
    expect(
      exportAuthorityEventsForOrg(request([validA]), isProxy, () => extraKeyed),
    ).toEqual({ ok: false, reason: 'foreign-event-leak' });
    // A length past 50_000 is refused in O(1) before any key walk.
    const enormous: unknown[] = [];
    Object.defineProperty(enormous, 'length', { value: MAX_AUTHORITY_ORG_EXPORT_EVENTS + 1 });
    expect(
      exportAuthorityEventsForOrg(request([validA]), isProxy, () => enormous),
    ).toEqual({ ok: false, reason: 'foreign-event-leak' });
    // A sparse hole in the selector output.
    expect(
      exportAuthorityEventsForOrg(request([validA]), isProxy, () => sparseEvents()),
    ).toEqual({ ok: false, reason: 'foreign-event-leak' });
  });

  it('exports the largest valid event whose serialized line exceeds 3000 UTF-8 bytes and stays under 4096', () => {
    // The largest valid event: every free-text field filled with 128 lone
    // surrogates, which JSON.stringify escapes to six ASCII bytes per code
    // unit. Lowering MAX_AUTHORITY_ORG_EXPORT_LINE_BYTES below this line's
    // real byte length must turn this export into `line-too-long`.
    const surrogate = String.fromCharCode(0xd800).repeat(128);
    const events = [
      validEvent({
        eventId: surrogate,
        organizationId: surrogate,
        beforeRevision: surrogate,
        afterRevision: surrogate,
      }),
    ];
    const result = exportAuthorityEventsForOrg(
      request(events, { organizationId: surrogate }),
      isProxy,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const bytes = new TextEncoder().encode(result.lines[0]).length;
    expect(bytes).toBeGreaterThan(3000);
    expect(bytes).toBeLessThan(MAX_AUTHORITY_ORG_EXPORT_LINE_BYTES);
  });
});
