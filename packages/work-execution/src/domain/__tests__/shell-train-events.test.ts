// SH3: pure parser for the legacy shell merge train's events log.
import { describe, expect, it } from 'vitest';

import {
  parseShellTrainEvents,
  SHELL_EVENTS_MAX_LINES,
  SHELL_EVENT_MAX_LINE_LENGTH,
  SHELL_DETAIL_CODES,
  SHELL_TRAIN_EVENT_KINDS,
} from '../shell-train-events.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const OTHER_HEAD = '89abcdef0123456789abcdef0123456789abcdef';
const AT = '2026-11-16T12:00:00Z';

/** Secret-shaped fakes are assembled from inert pieces (lane-run.test.ts precedent). */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

function eventJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    at: AT,
    kind: 'result',
    outcome: 'MERGED',
    pr: 42,
    headOid: HEAD,
    ...overrides,
  });
}

describe('parseShellTrainEvents', () => {
  it('parses well-formed event lines and lowercases the outcome', () => {
    const result = parseShellTrainEvents([
      eventJson(),
      eventJson({ kind: 'park', outcome: 'BLOCKED', pr: 7, headOid: '', detail: '' }),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([]);
    expect(result.secretShapedLines).toBe(0);
    expect(result.events).toEqual([
      {
        line: 0,
        atIso: AT,
        kind: 'result',
        outcome: 'merged',
        pullRequest: 42,
        headOid: HEAD,
        detailCode: 'none',
        fromHeadOid: null,
      },
      {
        line: 1,
        atIso: AT,
        kind: 'park',
        outcome: 'blocked',
        pullRequest: 7,
        headOid: null,
        detailCode: 'none',
        fromHeadOid: null,
      },
    ]);
  });

  it('parses one synthetic line per kind value, all eleven kinds', () => {
    const lines = SHELL_TRAIN_EVENT_KINDS.map((kind) => eventJson({ kind }));
    const result = parseShellTrainEvents(lines);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([]);
    expect(result.events.map((event) => event.kind)).toEqual([...SHELL_TRAIN_EVENT_KINDS]);
    expect(result.events.map((event) => event.line)).toEqual(SHELL_TRAIN_EVENT_KINDS.map((_, i) => i));
  });

  it('maps every detail shape to its exact code, including kind-gated head-moved-from', () => {
    const result = parseShellTrainEvents([
      eventJson({ detail: 'premerge carried (success) on chain/main' }),
      eventJson({ detail: 'premerge re-posted twice' }),
      eventJson({ detail: 'not carried: chain/main' }),
      eventJson({ kind: 'batch', detail: 'batch #1234' }),
      eventJson({ kind: 'head-moved', detail: `from ${OTHER_HEAD}` }),
      eventJson({ kind: 'park', detail: `from ${OTHER_HEAD}` }),
      eventJson({ kind: 'head-moved', detail: 'moved for an unrelated reason' }),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([]);
    expect(result.events.map((event) => event.detailCode)).toEqual([
      'premerge-carried',
      'premerge-reposted',
      'premerge-not-carried',
      'batch-member',
      'head-moved-from',
      'other',
      'other',
    ]);
    expect(result.events[4]?.fromHeadOid).toBe(OTHER_HEAD);
    expect(result.events[5]?.fromHeadOid).toBeNull();
    expect(result.events[6]?.fromHeadOid).toBeNull();
  });

  it('never echoes a detail holding what looks like a local filesystem path', () => {
    const path = '/var/fleet/secret/place.txt';
    const result = parseShellTrainEvents([eventJson({ detail: path })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events[0]?.detailCode).toBe('other');
    expect(JSON.stringify(result)).not.toContain(path);
  });

  // The following rules were previously bundled into one
  // "reports a bad line individually without refusing the file" test. Split
  // one rule per test (2026-11-16, SH3 fix round) so a regression in any one
  // rule identifies itself instead of being hidden behind the others' passes.
  // Each pairs a known-good line at index 0 with the one bad line at index 1,
  // confirming the file is parsed rather than refused outright.

  it('refuses a line that is not parsable JSON at all', () => {
    const result = parseShellTrainEvents([eventJson(), 'not json at all']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([1]);
    expect(result.events).toHaveLength(1);
  });

  it('refuses an unrecognized event kind', () => {
    const result = parseShellTrainEvents([eventJson(), eventJson({ kind: 'slurp' })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([1]);
    expect(result.events).toHaveLength(1);
  });

  it('refuses a calendar-invalid at with an out-of-range month', () => {
    const result = parseShellTrainEvents([eventJson(), eventJson({ at: '2026-13-05T10:00:00Z' })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([1]);
    expect(result.events).toHaveLength(1);
  });

  it('refuses a calendar-invalid at with a day past the month\'s length', () => {
    const result = parseShellTrainEvents([eventJson(), eventJson({ at: '2026-02-30T10:00:00Z' })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([1]);
    expect(result.events).toHaveLength(1);
  });

  it('refuses an uppercase headOid', () => {
    const result = parseShellTrainEvents([eventJson(), eventJson({ headOid: HEAD.toUpperCase() })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([1]);
    expect(result.events).toHaveLength(1);
  });

  it('refuses a line with one extra unrecognized key named extra', () => {
    const result = parseShellTrainEvents([eventJson(), eventJson({ extra: 'ignored' })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([1]);
    expect(result.events).toHaveLength(1);
  });

  it('refuses a non-numeric pr', () => {
    const result = parseShellTrainEvents([eventJson(), eventJson({ pr: 'x' })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([1]);
    expect(result.events).toHaveLength(1);
  });

  it('refuses a raw line that is a number, not a string', () => {
    const result = parseShellTrainEvents([eventJson(), 7]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([1]);
    expect(result.events).toHaveLength(1);
  });

  it('refuses a raw line that is null, not a string', () => {
    const result = parseShellTrainEvents([eventJson(), null]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([1]);
    expect(result.events).toHaveLength(1);
  });

  it('refuses an outcome with a leading dash', () => {
    const result = parseShellTrainEvents([eventJson(), eventJson({ outcome: '-leading-dash' })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([1]);
    expect(result.events).toHaveLength(1);
  });

  it('refuses a non-string detail', () => {
    const result = parseShellTrainEvents([eventJson(), eventJson({ detail: 3 })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([1]);
    expect(result.events).toHaveLength(1);
  });

  it('refuses a headOid one character longer than 40 hex', () => {
    const result = parseShellTrainEvents([eventJson(), eventJson({ headOid: `${HEAD}0` })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([1]);
    expect(result.events).toHaveLength(1);
  });

  it('counts a secret-shaped line exactly once and never echoes it', () => {
    const result = parseShellTrainEvents([eventJson(), fakeSecretShape()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([1]);
    expect(result.secretShapedLines).toBe(1);
    expect(JSON.stringify(result)).not.toContain('A'.repeat(20));
  });

  it('counts a secret-shaped line in secretShapedLines even when it is also over the length cap', () => {
    // A line can be refused as unknown for two independent reasons at once
    // (too long AND secret-shaped); secretShapedLines must still count it,
    // regardless of which other reason also makes it unknown (SH3 finding 2).
    const overLongSecret = `${fakeSecretShape()}${'x'.repeat(SHELL_EVENT_MAX_LINE_LENGTH)}`;
    expect(overLongSecret.length).toBeGreaterThan(SHELL_EVENT_MAX_LINE_LENGTH);
    const result = parseShellTrainEvents([eventJson(), overLongSecret]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([1]);
    expect(result.secretShapedLines).toBe(1);
    expect(JSON.stringify(result)).not.toContain('A'.repeat(20));
  });

  it('refuses a planted __proto__ own key from JSON.parse', () => {
    const result = parseShellTrainEvents([
      '{"__proto__":{"x":1},"at":"2026-11-16T12:00:00Z","kind":"result","outcome":"MERGED","pr":42}',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([0]);
  });

  it('refuses constructor or prototype own keys', () => {
    const result = parseShellTrainEvents([
      '{"constructor":1,"at":"2026-11-16T12:00:00Z","kind":"result","outcome":"MERGED","pr":42}',
      '{"prototype":1,"at":"2026-11-16T12:00:00Z","kind":"result","outcome":"MERGED","pr":42}',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([0, 1]);
  });

  it('refuses a line with one extra unrecognized key beyond the six allowed', () => {
    const result = parseShellTrainEvents([eventJson({ note: 'hello' })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([0]);
  });

  it('refuses a missing required key', () => {
    const result = parseShellTrainEvents(['{"at":"2026-11-16T12:00:00Z","kind":"result","outcome":"MERGED"}']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([0]);
  });

  it('refuses an oversized line', () => {
    const oversized = eventJson({ detail: 'x'.repeat(SHELL_EVENT_MAX_LINE_LENGTH) });
    expect(oversized.length).toBeGreaterThan(SHELL_EVENT_MAX_LINE_LENGTH);
    const result = parseShellTrainEvents([eventJson(), oversized]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([1]);
  });

  it('stores MERGED as merged', () => {
    const result = parseShellTrainEvents([eventJson({ outcome: 'MERGED' })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events[0]?.outcome).toBe('merged');
  });

  it('turns pr 0 into pullRequest null', () => {
    const result = parseShellTrainEvents([eventJson({ pr: 0 })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events[0]?.pullRequest).toBeNull();
  });

  it('refuses null as not-a-list', () => {
    expect(parseShellTrainEvents(null)).toEqual({ ok: false, reason: 'not-a-list' });
  });

  it('refuses undefined as not-a-list', () => {
    expect(parseShellTrainEvents(undefined)).toEqual({ ok: false, reason: 'not-a-list' });
  });

  it('refuses a wrong primitive as not-a-list', () => {
    expect(parseShellTrainEvents(7)).toEqual({ ok: false, reason: 'not-a-list' });
    expect(parseShellTrainEvents('a line')).toEqual({ ok: false, reason: 'not-a-list' });
    expect(parseShellTrainEvents([7])).toEqual({ ok: true, events: [], unknownLines: [0], secretShapedLines: 0 });
  });

  it('refuses a non-iterable object as not-a-list', () => {
    expect(parseShellTrainEvents({ length: 1, 0: eventJson() })).toEqual({ ok: false, reason: 'not-a-list' });
    expect(parseShellTrainEvents(new Map([[0, eventJson()]]))).toEqual({ ok: false, reason: 'not-a-list' });
  });

  it('reports a sparse-array hole as an unknown line and keeps parsing', () => {
    const sparse: string[] = [];
    sparse[0] = eventJson();
    sparse[2] = eventJson({ pr: 1 });
    const result = parseShellTrainEvents(sparse);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.map((event) => event.line)).toEqual([0, 2]);
    expect(result.unknownLines).toEqual([1]);
  });

  it('refuses an array-like object as not-a-list', () => {
    const arrayLike = { length: 1, 0: eventJson() };
    expect(parseShellTrainEvents(arrayLike)).toEqual({ ok: false, reason: 'not-a-list' });
  });

  it('refuses an enormous length before any traversal', () => {
    const sparse = new Array(2 ** 32 - 1);
    sparse[0] = eventJson();
    expect(parseShellTrainEvents(sparse)).toEqual({ ok: false, reason: 'too-many-lines' });
  });

  it('checks the length cap before reading any element', () => {
    let calls = 0;
    const array: unknown[] = [];
    Object.defineProperty(array, '0', {
      enumerable: true,
      get() {
        calls += 1;
        return eventJson();
      },
    });
    Object.defineProperty(array, 'length', { value: SHELL_EVENTS_MAX_LINES + 1 });
    expect(parseShellTrainEvents(array)).toEqual({ ok: false, reason: 'too-many-lines' });
    expect(calls).toBe(0);
  });

  it('never runs a getter planted on an item, and refuses accessor-backed fields', () => {
    // A JSON text cannot carry a getter, so an accessor can only ever appear on
    // an array item (planted directly on the list) or on the parsed record by
    // way of a hostile prototype — both are read through own data descriptors
    // only, so the accessor reads as absent and is refused, never run. This
    // test pins the item path with a call counter; the record path is pinned
    // by the __proto__/constructor/prototype key tests, which are the shapes
    // JSON.parse can actually produce.
    let calls = 0;
    const array: unknown[] = [];
    Object.defineProperty(array, '0', {
      enumerable: true,
      get() {
        calls += 1;
        return eventJson();
      },
    });
    Object.defineProperty(array, 'length', { value: 1 });
    const result = parseShellTrainEvents(array);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unknownLines).toEqual([0]);
    expect(calls).toBe(0);
  });

  it('yields the plain-data result for a Proxy over a valid input without a get trap', () => {
    let trapCalls = 0;
    const valid = [eventJson(), eventJson({ pr: 1 })];
    const proxy = new Proxy(valid, {
      get() {
        trapCalls += 1;
        return undefined;
      },
    });
    const result = parseShellTrainEvents(proxy);
    expect(result).toEqual(parseShellTrainEvents(valid));
    expect(trapCalls).toBe(0);
  });

  it('returns a typed refusal instead of throwing for a Proxy whose getPrototypeOf trap throws', () => {
    // SH3 finding 1: the boundary check at realArrayLength calls
    // Object.getPrototypeOf(value) directly, so a Proxy wrapping a genuine
    // array whose getPrototypeOf trap throws must not escape as an
    // exception. The parser's contract is to take `unknown` and never throw.
    const hostile = new Proxy([eventJson()], {
      getPrototypeOf() {
        throw new Error('trap');
      },
    });
    let result: ReturnType<typeof parseShellTrainEvents> | undefined;
    expect(() => {
      result = parseShellTrainEvents(hostile);
    }).not.toThrow();
    expect(result).toEqual({ ok: false, reason: 'not-a-list' });
  });

  it('is not satisfiable by a constant verdict or an identity echo', () => {
    const good = parseShellTrainEvents([eventJson()]);
    const bad = parseShellTrainEvents([eventJson({ kind: 'nope' })]);
    expect(good).not.toEqual(bad);

    const withDetail = parseShellTrainEvents([eventJson({ detail: 'not carried: chain/main' })]);
    if (!withDetail.ok) return;
    expect(JSON.stringify(withDetail)).not.toContain('not carried');
    expect(JSON.stringify(withDetail)).not.toContain('chain/main');
  });

  it('exposes the declared closed code sets and caps', () => {
    expect(SHELL_TRAIN_EVENT_KINDS).toEqual([
      'enqueue', 'intent', 'result', 'park', 'unpark', 'head-moved', 'retry', 'batch', 'skip', 'maint',
      'jev-shadow',
    ]);
    expect(SHELL_DETAIL_CODES).toEqual([
      'none', 'premerge-carried', 'premerge-reposted', 'premerge-not-carried', 'batch-member',
      'head-moved-from', 'other',
    ]);
    expect(SHELL_EVENTS_MAX_LINES).toBe(200_000);
    expect(SHELL_EVENT_MAX_LINE_LENGTH).toBe(4_096);
  });
});
