import { types } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  AUTHORITY_ORG_EVENT_KINDS,
  MAX_AUTHORITY_ORG_EXPORT_EVENTS,
  MAX_AUTHORITY_ORG_EXPORT_LINE_BYTES,
  exportAuthorityEventsForOrg,
  type AuthorityOrgEventSelector,
} from '../authority-event-org-export.js';

const isProxy = types.isProxy;

function ev(eventId: string, organizationId: string | null | undefined, extra: Record<string, unknown> = {}) {
  return {
    eventId,
    kind: 'grant',
    actor: 'operator@example',
    atIso: '2026-11-01T10:00:00Z',
    ...(organizationId === undefined ? {} : { organizationId }),
    ...extra,
  };
}

function req(events: unknown, overrides: Record<string, unknown> = {}) {
  return { events, organizationId: 'org-a', afterCursor: null, limit: 1000, ...overrides };
}

/** A copy of `record` without `key` (an absent key, not an own undefined). */
function omit(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

function run(input: unknown, selector?: AuthorityOrgEventSelector) {
  return exportAuthorityEventsForOrg(input, isProxy, selector);
}

/** Asserts a refusal with exactly this reason and no value of the input anywhere in it. */
function expectRefusal(result: unknown, reason: string, secrets: readonly string[] = []) {
  expect(result).toEqual({ ok: false, reason });
  const text = JSON.stringify(result);
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
}

function eventIdsOf(lines: readonly string[]): string[] {
  return lines.map((line) => (JSON.parse(line) as { eventId: string }).eventId);
}

describe('exportAuthorityEventsForOrg organisation filtering', () => {
  it('never includes org B events when exporting org A from an interleaved log', () => {
    const events = [ev('a1', 'org-a'), ev('b1', 'org-b'), ev('a2', 'org-a'), ev('b2', 'org-b'), ev('d1', null)];
    const result = run(req(events));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(eventIdsOf(result.lines)).toEqual(['a1', 'a2']);
      expect(result.lines.join('\n')).not.toContain('org-b');
      expect(result.nextCursor).toBe('a2');
    }
  });

  it('treats events with an omitted organizationId key or a null organizationId as belonging to default', () => {
    const events = [ev('x1', undefined), ev('x2', null), ev('o1', 'org-a'), ev('x3', 'default')];
    const result = run(req(events, { organizationId: 'default' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(eventIdsOf(result.lines)).toEqual(['x1', 'x2', 'x3']);
      const parsed = result.lines.map((line) => JSON.parse(line) as { organizationId: string | null });
      expect(parsed.map((entry) => entry.organizationId)).toEqual([null, null, 'default']);
    }
  });

  it('reconstructs the full org stream via cursor paging with no duplicate and no gap', () => {
    const events: unknown[] = [];
    for (let index = 0; index < 11; index += 1) {
      events.push(ev(`a${index}`, 'org-a'), ev(`b${index}`, 'org-b'));
    }
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = run(req(events, { afterCursor: cursor, limit: 4 }));
      expect(page.ok).toBe(true);
      if (!page.ok || page.lines.length === 0) {
        break;
      }
      collected.push(...eventIdsOf(page.lines));
      cursor = page.nextCursor;
    }
    expect(collected).toEqual(Array.from({ length: 11 }, (_, index) => `a${index}`));
  });

  it('returns zero lines and null nextCursor for an empty log or exhausted cursor', () => {
    expect(run(req([]))).toEqual({ ok: true, lines: [], nextCursor: null });
    const exhausted = run(req([ev('a1', 'org-a')], { afterCursor: 'a1' }));
    expect(exhausted).toEqual({ ok: true, lines: [], nextCursor: null });
  });

  it('accepts limit boundaries 1 and 1000 and refuses 0 and 1001', () => {
    const events = [ev('a1', 'org-a'), ev('a2', 'org-a')];
    const one = run(req(events, { limit: 1 }));
    expect(one.ok && one.lines.length).toBe(1);
    expect(run(req(events, { limit: 1000 })).ok).toBe(true);
    expectRefusal(run(req(events, { limit: 0 })), 'invalid-input');
    expectRefusal(run(req(events, { limit: 1001 })), 'invalid-input');
  });

  it('escapes U+2028 and U+2029 in serialized lines so no line contains a raw line separator', () => {
    const result = run(req([ev('a\u2028b', 'org-a'), ev('c\u2029d', 'org-a', { beforeRevision: 'r\u2028' })]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lines).toHaveLength(2);
      for (const line of result.lines) {
        expect(line).not.toMatch(/[\u2028\u2029\n\r]/);
      }
      expect(result.lines[0]).toContain('a\\u2028b');
      expect(result.lines[1]).toContain('c\\u2029d');
    }
  });

  it('serializes fixed key order with omitted optional fields as null', () => {
    const result = run(req([ev('a1', 'org-a')]));
    expect(result.ok && result.lines[0]).toBe(
      '{"eventId":"a1","kind":"grant","actor":"operator@example","organizationId":"org-a",' +
        '"atIso":"2026-11-01T10:00:00Z","beforeRevision":null,"afterRevision":null}',
    );
  });

  it('accepts every declared event kind and refuses one outside the list', () => {
    for (const kind of AUTHORITY_ORG_EVENT_KINDS) {
      expect(run(req([ev('a1', 'org-a', { kind })])).ok).toBe(true);
    }
    expectRefusal(run(req([ev('a1', 'org-a', { kind: 'other' })])), 'invalid-input', ['other']);
  });
});

describe('exportAuthorityEventsForOrg refusals', () => {
  it('refuses null, undefined, wrong primitives, non-iterables, array-likes, sparse holes, and enormous length as invalid-input', () => {
    for (const input of [null, undefined, 1, true, 'x', Symbol('s'), 10n, [], {}]) {
      expectRefusal(run(input), 'invalid-input');
    }
    expectRefusal(run(req('not-an-array')), 'invalid-input');
    expectRefusal(run(req({ length: 1, 0: ev('a1', 'org-a') })), 'invalid-input');
    // eslint-disable-next-line no-sparse-arrays
    expectRefusal(run(req([ev('a1', 'org-a'), , ev('a2', 'org-a')])), 'invalid-input');
    expectRefusal(run(req(new Array(MAX_AUTHORITY_ORG_EXPORT_EVENTS + 1))), 'invalid-input');
    expectRefusal(run(req([null])), 'invalid-input');
    expectRefusal(run(req([[]])), 'invalid-input');
  });

  it('refuses Proxy, getter without invoking it, and sparse hole inputs as invalid-input', () => {
    let getterRan = false;
    const withGetter = req([ev('a1', 'org-a')]);
    Object.defineProperty(withGetter, 'limit', {
      enumerable: true,
      get() {
        getterRan = true;
        return 5;
      },
    });
    expectRefusal(run(withGetter), 'invalid-input');
    expect(getterRan).toBe(false);

    let eventGetterRan = false;
    const getterEvent = ev('a1', 'org-a');
    Object.defineProperty(getterEvent, 'actor', {
      enumerable: true,
      get() {
        eventGetterRan = true;
        return 'x';
      },
    });
    expectRefusal(run(req([getterEvent])), 'invalid-input');
    expect(eventGetterRan).toBe(false);

    expectRefusal(run(new Proxy(req([ev('a1', 'org-a')]), {})), 'invalid-input');
    expectRefusal(run(req(new Proxy([ev('a1', 'org-a')], {}))), 'invalid-input');
    expectRefusal(run(req([new Proxy(ev('a1', 'org-a'), {})])), 'invalid-input');
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expectRefusal(run(req([revoked.proxy])), 'invalid-input');
  });

  it('refuses arrays carrying own symbol keys, non-enumerable own keys, or extra properties as invalid-input', () => {
    const withSymbol: unknown[] = [ev('a1', 'org-a')];
    Object.defineProperty(withSymbol, Symbol('s'), { value: 1, enumerable: true });
    expectRefusal(run(req(withSymbol)), 'invalid-input');

    const hidden: unknown[] = [ev('a1', 'org-a')];
    Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false });
    expectRefusal(run(req(hidden)), 'invalid-input');

    const nonEnumerableIndex: unknown[] = [];
    Object.defineProperty(nonEnumerableIndex, 0, { value: ev('a1', 'org-a'), enumerable: false });
    expectRefusal(run(req(nonEnumerableIndex)), 'invalid-input');

    const extra: unknown[] = [ev('a1', 'org-a')];
    (extra as unknown as Record<string, unknown>).note = 'x';
    expectRefusal(run(req(extra)), 'invalid-input');
  });

  it('refuses prototype-polluting keys including constructor, prototype, and own __proto__ on root and event objects as invalid-input', () => {
    for (const key of ['constructor', 'prototype']) {
      expectRefusal(run({ ...req([ev('a1', 'org-a')]), [key]: 1 }), 'invalid-input');
      expectRefusal(run(req([{ ...ev('a1', 'org-a'), [key]: 1 }])), 'invalid-input');
    }
    const rootProto = req([ev('a1', 'org-a')]);
    Object.defineProperty(rootProto, '__proto__', { value: 1, enumerable: true });
    expectRefusal(run(rootProto), 'invalid-input');
    const eventProto = ev('a1', 'org-a');
    Object.defineProperty(eventProto, '__proto__', { value: 1, enumerable: true });
    expectRefusal(run(req([eventProto])), 'invalid-input');
  });

  it('refuses missing or extra keys and an own undefined property as invalid-input', () => {
    const missingLimit = omit(req([ev('a1', 'org-a')]), 'limit');
    expectRefusal(run(missingLimit), 'invalid-input');
    expectRefusal(run({ ...req([ev('a1', 'org-a')]), extra: 1 }), 'invalid-input');
    const missingActor = omit(ev('a1', 'org-a'), 'actor');
    expectRefusal(run(req([missingActor])), 'invalid-input');
    expectRefusal(run(req([ev('a1', 'org-a', { extra: 1 })])), 'invalid-input');
    expectRefusal(run(req([ev('a1', 'org-a', { beforeRevision: undefined })])), 'invalid-input');
    expectRefusal(run(req([ev('a1', undefined, { organizationId: undefined })])), 'invalid-input');
  });

  it('refuses invalid request fields and malformed event kind, atIso, actor, and revision values without echoing input', () => {
    const secret = 'SECRET-VALUE';
    const bad = [
      req([ev('a1', 'org-a')], { organizationId: '' }),
      req([ev('a1', 'org-a')], { organizationId: null }),
      req([ev('a1', 'org-a')], { organizationId: 5 }),
      req([ev('a1', 'org-a')], { organizationId: 'x'.repeat(129) }),
      req([ev('a1', 'org-a')], { organizationId: 'a\u0007b' }),
      req([ev('a1', 'org-a')], { afterCursor: '' }),
      req([ev('a1', 'org-a')], { afterCursor: 5 }),
      req([ev('a1', 'org-a')], { afterCursor: 'x'.repeat(129) }),
      req([ev('a1', 'org-a')], { afterCursor: 'a\u007fb' }),
      req([ev('a1', 'org-a')], { limit: 1.5 }),
      req([ev('a1', 'org-a')], { limit: Number.NaN }),
      req([ev('a1', 'org-a')], { limit: Number.POSITIVE_INFINITY }),
      req([ev('a1', 'org-a')], { limit: -0 }),
      req([ev('a1', 'org-a')], { limit: '5' }),
      req([ev('', 'org-a')]),
      req([ev('x'.repeat(129), 'org-a')]),
      req([ev('a\nb', 'org-a')]),
      req([ev('a1', 'org-a', { actor: `bad actor ${secret}` })]),
      req([ev('a1', 'org-a', { actor: 'x'.repeat(129) })]),
      req([ev('a1', 'org-a', { atIso: '2026-11-01T10:00:00' })]),
      req([ev('a1', 'org-a', { atIso: '2026-02-31T10:00:00Z' })]),
      req([ev('a1', 'org-a', { atIso: `2026-11-01T10:00:00.${'1'.repeat(60)}Z` })]),
      req([ev('a1', 'org-a', { beforeRevision: '' })]),
      req([ev('a1', 'org-a', { beforeRevision: 5 })]),
      req([ev('a1', 'org-a', { afterRevision: 'x'.repeat(129) })]),
      req([ev('a1', 'org-a', { afterRevision: 'r\u0001' })]),
      // A malformed event of another organisation still refuses the request.
      req([ev('b1', 'org-b', { kind: `bogus-${secret}` }), ev('a1', 'org-a')]),
      req([ev('b1', '', {})]),
    ];
    for (const input of bad) {
      expectRefusal(run(input), 'invalid-input', [secret]);
    }
  });

  it('refuses duplicate eventId within the requested organisation stream as invalid-input', () => {
    expectRefusal(run(req([ev('a1', 'org-a'), ev('b1', 'org-b'), ev('a1', 'org-a')])), 'invalid-input', ['a1']);
    // The same id in two organisations is not a duplicate within either stream.
    expect(run(req([ev('s1', 'org-a'), ev('s1', 'org-b')])).ok).toBe(true);
  });

  it('refuses non-function or throwing isProxy detector as invalid-input', () => {
    const input = req([ev('a1', 'org-a')]);
    for (const detector of [undefined, null, 123, {}, 'x']) {
      expectRefusal(exportAuthorityEventsForOrg(input, detector as never), 'invalid-input');
    }
    expectRefusal(
      exportAuthorityEventsForOrg(input, () => {
        throw new Error('detector failed');
      }),
      'invalid-input',
      ['detector failed'],
    );
  });

  it('refuses an unknown cursor as unknown-cursor', () => {
    expectRefusal(run(req([ev('a1', 'org-a')], { afterCursor: 'nope' })), 'unknown-cursor', ['nope']);
  });

  it("refuses a cursor naming another organisation's event as unknown-cursor", () => {
    const result = run(req([ev('a1', 'org-a'), ev('b1', 'org-b')], { afterCursor: 'b1' }));
    expectRefusal(result, 'unknown-cursor', ['b1', 'org-b']);
  });
});

describe('exportAuthorityEventsForOrg leak guard', () => {
  it('uses a selector that returns exactly the right events like the built-in filter', () => {
    const selector: AuthorityOrgEventSelector = (events, organizationId) =>
      events.filter((event) => (event.organizationId ?? 'default') === organizationId);
    const events = [ev('a1', 'org-a'), ev('b1', 'org-b'), ev('a2', 'org-a')];
    expect(run(req(events), selector)).toEqual(run(req(events)));
  });

  it('refuses the whole export as foreign-event-leak when the injected selector leaks another organisation event', () => {
    const events = [ev('a1', 'org-a'), ev('b1', 'org-b'), ev('a2', 'org-a')];
    const leaky: AuthorityOrgEventSelector = (all) => all;
    const result = run(req(events), leaky);
    expectRefusal(result, 'foreign-event-leak', ['b1', 'org-b']);
    // A leak beyond the requested page is refused too: no partial lines.
    expectRefusal(run(req(events, { limit: 1 }), leaky), 'foreign-event-leak');
    // A selector that throws is refused as a leak, not propagated.
    expectRefusal(
      run(req(events), () => {
        throw new Error('selector failed');
      }),
      'foreign-event-leak',
      ['selector failed'],
    );
  });

  it('refuses a selector returning a hostile iterator, Proxy, forbidden own array keys, or length exceeding 50_000 as foreign-event-leak in bounded time', () => {
    const events = [ev('a1', 'org-a')];
    let iteratorRan = false;
    const hostileIterator: unknown[] = [ev('a1', 'org-a')];
    Object.defineProperty(hostileIterator, Symbol.iterator, {
      value: function* () {
        iteratorRan = true;
        for (;;) {
          yield ev('a1', 'org-a');
        }
      },
      enumerable: false,
    });
    const withSymbol: unknown[] = [ev('a1', 'org-a')];
    Object.defineProperty(withSymbol, Symbol('s'), { value: 1, enumerable: true });
    const withHidden: unknown[] = [ev('a1', 'org-a')];
    Object.defineProperty(withHidden, 'extra', { value: 1, enumerable: false });
    const withGetter: unknown[] = [];
    let getterRan = false;
    Object.defineProperty(withGetter, 0, {
      enumerable: true,
      get() {
        getterRan = true;
        return ev('a1', 'org-a');
      },
    });
    // eslint-disable-next-line no-sparse-arrays
    const sparse: unknown[] = [ev('a1', 'org-a'), , ev('a2', 'org-a')];
    const hostile: readonly unknown[] = [
      hostileIterator,
      new Proxy([ev('a1', 'org-a')], {}),
      withSymbol,
      withHidden,
      withGetter,
      sparse,
      { length: 1, 0: ev('a1', 'org-a') },
      new Array(MAX_AUTHORITY_ORG_EXPORT_EVENTS + 1),
      [{ ...ev('a1', 'org-a'), kind: 'bogus' }],
    ];
    const started = Date.now();
    for (const answer of hostile) {
      expectRefusal(
        run(req(events), () => answer),
        'foreign-event-leak',
      );
    }
    expect(iteratorRan).toBe(false);
    expect(getterRan).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('exportAuthorityEventsForOrg line length', () => {
  it('exports the largest valid event whose serialized line exceeds 3000 UTF-8 bytes and stays under 4096', () => {
    const lone = '\ud800'.repeat(128);
    const result = run(
      req([ev(lone, 'org-a', { beforeRevision: lone, afterRevision: lone })], { organizationId: 'org-a' }),
    );
    // The organisation id of the event is short here; widen it to the cap too.
    const widened = run(
      req([ev(lone, lone, { beforeRevision: lone, afterRevision: lone })], { organizationId: lone }),
    );
    expect(result.ok).toBe(true);
    expect(widened.ok).toBe(true);
    if (widened.ok) {
      const bytes = new TextEncoder().encode(widened.lines[0]).length;
      expect(bytes).toBeGreaterThan(3000);
      expect(bytes).toBeLessThan(MAX_AUTHORITY_ORG_EXPORT_LINE_BYTES);
    }
  });
});
