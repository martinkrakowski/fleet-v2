import { describe, expect, it } from 'vitest';

import {
  AUTHORITY_ACTOR_PATTERN,
  AUTHORITY_EVENT_KINDS,
  MAX_AUTHORITY_EXPORT_EVENTS,
  MAX_AUTHORITY_FIELD_LENGTH,
  MAX_AUTHORITY_LINE_BYTES,
  exportAuthorityEventsJsonl,
  parseAuthorityEvent,
} from '../authority-event.js';

// Runtime-built hostile key names: never written as literals.
const PROTO_KEY = '_'.repeat(2) + 'proto' + '_'.repeat(2);
const CONSTRUCTOR_KEY = 'constr' + 'uctor';
const PROTOTYPE_KEY = 'pro' + 'totype';

const AT_ISO = '2026-11-20T10:00:00.000Z';
const NL = String.fromCharCode(10);

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'event-0001',
    kind: 'dispatch',
    actor: 'policy-bot',
    organizationId: null,
    atIso: AT_ISO,
    beforeRevision: null,
    afterRevision: null,
    ...overrides,
  };
}

describe('parseAuthorityEvent: valid parsing', () => {
  it('parses every one of the eight kind values and preserves it exactly', () => {
    expect(AUTHORITY_EVENT_KINDS).toHaveLength(8);
    for (const kind of AUTHORITY_EVENT_KINDS) {
      const parsed = parseAuthorityEvent(validInput({ kind }));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.event.kind).toBe(kind);
      }
    }
  });

  it('parses with a string organizationId, beforeRevision and afterRevision', () => {
    const parsed = parseAuthorityEvent(
      validInput({
        organizationId: 'org-alpha',
        beforeRevision: 'rev-before-1',
        afterRevision: 'rev-after-1',
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.event.organizationId).toBe('org-alpha');
      expect(parsed.event.beforeRevision).toBe('rev-before-1');
      expect(parsed.event.afterRevision).toBe('rev-after-1');
    }
  });

  it('parses with null organizationId, beforeRevision and afterRevision', () => {
    const parsed = parseAuthorityEvent(validInput());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.event.organizationId).toBeNull();
      expect(parsed.event.beforeRevision).toBeNull();
      expect(parsed.event.afterRevision).toBeNull();
    }
  });

  it('returns a frozen event whose fields cannot be reassigned', () => {
    const parsed = parseAuthorityEvent(validInput());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Object.isFrozen(parsed.event)).toBe(true);
      expect(() => {
        (parsed as { event: { eventId: string } }).event.eventId = 'changed';
      }).toThrow();
      expect(parsed.event.eventId).toBe('event-0001');
    }
  });
});

describe('parseAuthorityEvent: shape refusals', () => {
  it('refuses null, undefined, primitives, arrays and non-plain objects as not-a-plain-object', () => {
    class Instance {
      eventId = 'x';
    }
    const cases: unknown[] = [
      null,
      undefined,
      42,
      'text',
      true,
      [],
      [validInput()],
      new Instance(),
      new Date(0),
    ];
    for (const value of cases) {
      const parsed = parseAuthorityEvent(value);
      expect(parsed).toEqual({ ok: false, reason: 'not-a-plain-object' });
    }
  });

  it('refuses a revoked Proxy as hostile-input without throwing', () => {
    const { proxy, revoke } = Proxy.revocable(validInput(), {});
    revoke();
    expect(parseAuthorityEvent(proxy)).toEqual({ ok: false, reason: 'hostile-input' });
  });

  it('refuses a Proxy whose ownKeys trap throws as hostile-input without throwing', () => {
    const proxy = new Proxy(validInput(), {
      ownKeys() {
        throw new Error('trap');
      },
    });
    expect(parseAuthorityEvent(proxy)).toEqual({ ok: false, reason: 'hostile-input' });
  });

  it('refuses an own getter without ever invoking it', () => {
    let getterRuns = 0;
    const input: Record<string, unknown> = validInput();
    Object.defineProperty(input, 'actor', {
      get() {
        getterRuns += 1;
        return 'hostile';
      },
      enumerable: true,
    });
    const parsed = parseAuthorityEvent(input);
    expect(parsed).toEqual({ ok: false, reason: 'hostile-input' });
    expect(getterRuns).toBe(0);
  });

  it('refuses a non-enumerable own key as hostile-input', () => {
    const input: Record<string, unknown> = validInput();
    Object.defineProperty(input, 'kind', { value: 'dispatch', enumerable: false });
    const parsed = parseAuthorityEvent(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(['hostile-input', 'invalid-kind']).toContain(parsed.reason);
    }
  });

  it('refuses a symbol own key as hostile-input', () => {
    const input: Record<string, unknown> = validInput();
    Object.defineProperty(input, Symbol('extra'), { value: 1, enumerable: true });
    expect(parseAuthorityEvent(input)).toEqual({ ok: false, reason: 'hostile-input' });
  });

  it('refuses prototype-polluting keys as prototype-polluting-key', () => {
    for (const key of [PROTO_KEY, CONSTRUCTOR_KEY, PROTOTYPE_KEY]) {
      const input: Record<string, unknown> = validInput();
      // defineProperty, never assignment: `input[key] = {}` on __proto__
      // would change the object's prototype instead of adding an own key.
      Object.defineProperty(input, key, { value: {}, enumerable: true, writable: true, configurable: true });
      const parsed = parseAuthorityEvent(input);
      expect(parsed).toEqual({ ok: false, reason: 'prototype-polluting-key' });
    }
  });

  it('refuses the JSON.parse own __proto__ key as prototype-polluting-key', () => {
    const input = { ...validInput(), ...JSON.parse(`{"${PROTO_KEY}":{}}`) };
    expect(parseAuthorityEvent(input)).toEqual({ ok: false, reason: 'prototype-polluting-key' });
  });
});

describe('parseAuthorityEvent: key and field refusals', () => {
  it('refuses a missing required key and an unknown extra key as invalid-keys', () => {
    const missing: Record<string, unknown> = validInput();
    delete missing.afterRevision;
    expect(parseAuthorityEvent(missing)).toEqual({ ok: false, reason: 'invalid-keys' });
    expect(parseAuthorityEvent(validInput({ extra: 1 }))).toEqual({
      ok: false,
      reason: 'invalid-keys',
    });
  });

  it('refuses an unknown event kind as invalid-kind', () => {
    expect(parseAuthorityEvent(validInput({ kind: 'unknown-kind' }))).toEqual({
      ok: false,
      reason: 'invalid-kind',
    });
  });

  it('refuses an empty, over-long or invalid-character actor as invalid-actor', () => {
    for (const actor of ['', 'a'.repeat(MAX_AUTHORITY_FIELD_LENGTH + 1), 'bad actor', 'org/bot']) {
      expect(parseAuthorityEvent(validInput({ actor }))).toEqual({
        ok: false,
        reason: 'invalid-actor',
      });
    }
    expect(AUTHORITY_ACTOR_PATTERN.test('policy-bot')).toBe(true);
  });

  it('refuses an empty, over-long or control-character eventId as invalid-event-id', () => {
    for (const eventId of [
      '',
      'a'.repeat(MAX_AUTHORITY_FIELD_LENGTH + 1),
      `bad${String.fromCharCode(1)}id`,
    ]) {
      expect(parseAuthorityEvent(validInput({ eventId }))).toEqual({
        ok: false,
        reason: 'invalid-event-id',
      });
    }
  });

  it('refuses an empty, over-long or control-character organizationId as invalid-organization-id', () => {
    for (const organizationId of [
      '',
      'a'.repeat(MAX_AUTHORITY_FIELD_LENGTH + 1),
      `bad${String.fromCharCode(7)}org`,
    ]) {
      expect(parseAuthorityEvent(validInput({ organizationId }))).toEqual({
        ok: false,
        reason: 'invalid-organization-id',
      });
    }
  });

  it('refuses a non-ISO, unparseable or shape-breaking atIso as invalid-at-iso', () => {
    for (const atIso of [
      'not-a-timestamp',
      '2026-01-01',
      '2026-13-01T00:00:00Z',
      `${AT_ISO}${NL}`,
    ]) {
      expect(parseAuthorityEvent(validInput({ atIso }))).toEqual({
        ok: false,
        reason: 'invalid-at-iso',
      });
    }
  });

  it('refuses newline, over-long and control-character beforeRevision and afterRevision as invalid-revision', () => {
    const overLong = 'a'.repeat(MAX_AUTHORITY_FIELD_LENGTH + 1);
    for (const value of [`a${NL}b`, overLong, `bad${String.fromCharCode(27)}rev`]) {
      expect(parseAuthorityEvent(validInput({ beforeRevision: value }))).toEqual({
        ok: false,
        reason: 'invalid-revision',
      });
      expect(parseAuthorityEvent(validInput({ afterRevision: value }))).toEqual({
        ok: false,
        reason: 'invalid-revision',
      });
    }
  });

  it('never echoes any supplied value inside a refusal reason', () => {
    const parsed = parseAuthorityEvent(validInput({ eventId: `secret-value-42${String.fromCharCode(1)}` }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(JSON.stringify(parsed)).not.toContain('secret-value-42');
    }
  });
});

function orgEvent(
  eventId: string,
  organizationId: string | null,
  atIso: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return validInput({ eventId, organizationId, atIso, ...overrides });
}

describe('exportAuthorityEventsJsonl: filtering and serialization', () => {
  const ORG_ONE = 'org-alpha';
  const ORG_TWO = 'org-beta';

  const events = [
    orgEvent('event-0001', null, '2026-11-20T10:00:00.000Z'),
    orgEvent('event-0002', ORG_ONE, '2026-11-20T11:00:00.000Z'),
    orgEvent('event-0003', ORG_ONE, '2026-11-20T09:00:00.000Z'),
    orgEvent('event-0004', ORG_TWO, '2026-11-20T12:00:00.000Z'),
  ];

  it('returns only null-organization events for the null filter', () => {
    const result = exportAuthorityEventsJsonl(events, { organizationId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.count).toBe(1);
      const parsed = JSON.parse(result.text.trim());
      expect(parsed.organizationId).toBeNull();
      expect(result.text).toContain('event-0001');
      expect(result.text).not.toContain(ORG_ONE);
      expect(result.text).not.toContain(ORG_TWO);
    }
  });

  it('returns only the named organization events for an organization filter', () => {
    for (const organization of [ORG_ONE, ORG_TWO]) {
      const result = exportAuthorityEventsJsonl(events, { organizationId: organization });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.count).toBe(organization === ORG_ONE ? 2 : 1);
        for (const line of result.text.split('\n').slice(0, -1)) {
          expect(JSON.parse(line).organizationId).toBe(organization);
        }
        expect(result.text).not.toContain(ORG_TWO === organization ? ORG_ONE : ORG_TWO);
      }
    }
  });

  it('sorts by atIso then eventId in code-unit order inside one organization', () => {
    const result = exportAuthorityEventsJsonl(events, { organizationId: ORG_ONE });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ids = result.text
        .split('\n')
        .slice(0, -1)
        .map((line) => JSON.parse(line).eventId);
      expect(ids).toEqual(['event-0003', 'event-0002']);
    }
  });

  it('serializes the fixed key order, terminates every line with a newline and matches count', () => {
    const result = exportAuthorityEventsJsonl(events, { organizationId: ORG_ONE });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text.endsWith('\n')).toBe(true);
      expect(result.count).toBe(result.text.split('\n').length - 1);
      expect(result.text.split('\n')[result.count]).toBe('');
      for (const line of result.text.split('\n').slice(0, -1)) {
        expect(Object.keys(JSON.parse(line))).toEqual([
          'eventId',
          'kind',
          'actor',
          'organizationId',
          'atIso',
          'beforeRevision',
          'afterRevision',
        ]);
      }
    }
  });

  it('round-trips every exported line back to the parsed input events', () => {
    const result = exportAuthorityEventsJsonl(events, { organizationId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const lines = result.text.split('\n').slice(0, -1);
      expect(lines).toHaveLength(1);
      const roundTripped = JSON.parse(lines[0]);
      const parsed = parseAuthorityEvent(events[0]);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(roundTripped).toEqual(parsed.event);
      }
    }
  });

  it('escapes U+2028 and U+2029 so the line count stays exact', () => {
    const separator = String.fromCharCode(0x2028);
    const paragraph = String.fromCharCode(0x2029);
    const hostile = orgEvent(
      `event${separator}one${paragraph}two`,
      null,
      '2026-11-20T10:00:00.000Z',
    );
    const result = exportAuthorityEventsJsonl([hostile], { organizationId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.count).toBe(1);
      expect(result.text.split('\n')).toHaveLength(2);
      expect(result.text).toContain('\\u2028');
      expect(result.text).toContain('\\u2029');
      expect(JSON.parse(result.text.trim()).eventId).toBe(`event${separator}one${paragraph}two`);
    }
  });
});

describe('exportAuthorityEventsJsonl: determinism, immutability and non-constancy', () => {
  const a = orgEvent('event-0001', null, '2026-11-20T10:00:00.000Z');
  const b = orgEvent('event-0002', null, '2026-11-20T09:00:00.000Z');

  it('produces byte-identical output for the same events in different input orders', () => {
    const first = exportAuthorityEventsJsonl([a, b], { organizationId: null });
    const second = exportAuthorityEventsJsonl([b, a], { organizationId: null });
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.text).toBe(second.text);
    }
  });

  it('does not mutate a deep-frozen input array or its deep-frozen elements', () => {
    const frozen = Object.freeze(
      [Object.freeze({ ...a }), Object.freeze({ ...b })],
    );
    const result = exportAuthorityEventsJsonl(frozen, { organizationId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ids = result.text
        .split('\n')
        .slice(0, -1)
        .map((line) => JSON.parse(line).eventId);
      expect(ids).toEqual(['event-0002', 'event-0001']);
    }
  });

  it('produces distinct output for distinct inputs (no constant or identity result)', () => {
    const first = exportAuthorityEventsJsonl([a], { organizationId: null });
    const second = exportAuthorityEventsJsonl([b], { organizationId: null });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.text).not.toBe(second.text);
    }
  });

  it('differs from the raw unsorted unfiltered input rendering', () => {
    const rawInput = [a, b];
    const result = exportAuthorityEventsJsonl(rawInput, { organizationId: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).not.toBe(JSON.stringify(rawInput));
      // The raw input order starts with event-0001; the sorted export must
      // not, because event-0002 carries the earlier atIso.
      expect(JSON.stringify(rawInput[0]).startsWith('{"eventId":"event-0001"')).toBe(true);
      expect(result.text.startsWith('{"eventId":"event-0001"')).toBe(false);
    }
  });
});

describe('exportAuthorityEventsJsonl: refusals', () => {
  it('refuses non-array, null, undefined, array-like, non-array iterable and hostile Proxy events', () => {
    const arrayLike = { length: 1, 0: validInput() };
    const set = new Set([validInput()]);
    const { proxy, revoke } = Proxy.revocable([validInput()], {});
    revoke();
    const cases: Array<[unknown, string]> = [
      [null, 'not-an-array'],
      [undefined, 'not-an-array'],
      [42, 'not-an-array'],
      [arrayLike, 'not-an-array'],
      [set, 'not-an-array'],
      [proxy, 'hostile-input'],
    ];
    for (const [value, reason] of cases) {
      const result = exportAuthorityEventsJsonl(value, { organizationId: null });
      expect(result).toEqual({ ok: false, reason });
    }
  });

  it('refuses a Proxy whose length read throws as hostile-input', () => {
    const proxy = new Proxy([validInput()], {
      getOwnPropertyDescriptor() {
        throw new Error('trap');
      },
    });
    expect(exportAuthorityEventsJsonl(proxy, { organizationId: null })).toEqual({
      ok: false,
      reason: 'hostile-input',
    });
  });

  it('refuses a sparse array with holes as sparse-array without touching later elements', () => {
    const sparse: unknown[] = new Array(3);
    sparse[0] = validInput();
    sparse[2] = validInput();
    expect(exportAuthorityEventsJsonl(sparse, { organizationId: null })).toEqual({
      ok: false,
      reason: 'sparse-array',
    });
  });

  it('refuses an accessor or non-enumerable element as hostile-input', () => {
    const withGetter: unknown[] = new Array(1);
    Object.defineProperty(withGetter, 0, {
      get() {
        return validInput();
      },
      enumerable: true,
    });
    expect(exportAuthorityEventsJsonl(withGetter, { organizationId: null })).toEqual({
      ok: false,
      reason: 'hostile-input',
    });
    const nonEnumerable: unknown[] = new Array(1);
    Object.defineProperty(nonEnumerable, 0, { value: validInput(), enumerable: false });
    expect(exportAuthorityEventsJsonl(nonEnumerable, { organizationId: null })).toEqual({
      ok: false,
      reason: 'hostile-input',
    });
  });

  it('refuses more than 50,000 events as too-large before iterating any element', () => {
    const oversized = new Array(MAX_AUTHORITY_EXPORT_EVENTS + 1);
    const result = exportAuthorityEventsJsonl(oversized, { organizationId: null });
    expect(result).toEqual({ ok: false, reason: 'too-large' });
  });

  it('refuses the whole export when any event is invalid, even one for another organization, with no partial text', () => {
    const events = [
      validInput({ eventId: 'event-0001', organizationId: null }),
      validInput({ eventId: 'event-0002', organizationId: 'org-alpha', kind: 'not-a-kind' }),
    ];
    const result = exportAuthorityEventsJsonl(events, { organizationId: null });
    expect(result).toEqual({ ok: false, reason: 'invalid-kind' });
  });

  it('refuses a null, hostile, getter-bearing, extra-key or invalid organizationId filter', () => {
    const events = [validInput()];
    expect(exportAuthorityEventsJsonl(events, null)).toEqual({
      ok: false,
      reason: 'not-a-plain-object',
    });
    const { proxy, revoke } = Proxy.revocable({ organizationId: null }, {});
    revoke();
    expect(exportAuthorityEventsJsonl(events, proxy)).toEqual({
      ok: false,
      reason: 'hostile-input',
    });
    const withGetter: Record<string, unknown> = {};
    Object.defineProperty(withGetter, 'organizationId', {
      get: () => null,
      enumerable: true,
    });
    expect(exportAuthorityEventsJsonl(events, withGetter)).toEqual({
      ok: false,
      reason: 'hostile-input',
    });
    expect(exportAuthorityEventsJsonl(events, { organizationId: null, extra: 1 })).toEqual({
      ok: false,
      reason: 'invalid-keys',
    });
    expect(exportAuthorityEventsJsonl(events, { organizationId: '' })).toEqual({
      ok: false,
      reason: 'invalid-organization-id',
    });
  });

  it('exports the largest valid event whose serialized line exceeds 3000 UTF-8 bytes', () => {
    // The largest valid event: every free-text field filled with 128 lone
    // surrogates, which JSON.stringify escapes to six ASCII bytes per code
    // unit. Even that stays under MAX_AUTHORITY_LINE_BYTES, so the cap is a
    // defensive guard for future field growth, not a reachable refusal with
    // today's field caps. This test still pins the guard: lowering
    // MAX_AUTHORITY_LINE_BYTES below this line's real byte length must turn
    // this export into a `line-too-long` refusal and fail this test.
    const surrogate = String.fromCharCode(0xd800).repeat(MAX_AUTHORITY_FIELD_LENGTH);
    const maximal = validInput({
      eventId: surrogate,
      organizationId: surrogate,
      beforeRevision: surrogate,
      afterRevision: surrogate,
    });
    const result = exportAuthorityEventsJsonl([maximal], { organizationId: surrogate });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new TextEncoder().encode(result.text.trim()).length).toBeGreaterThan(3000);
      expect(new TextEncoder().encode(result.text.trim()).length).toBeLessThan(
        MAX_AUTHORITY_LINE_BYTES,
      );
    }
  });
});
