// SH13a: pure extractor of shell merges, head moves and carry decisions from the events log.
import { describe, expect, it } from 'vitest';

import { extractShadowShellFacts, SHADOW_SHELL_FACTS_MAX_EVENTS } from '../shadow-day-shell-facts.js';
import type { ShellTrainEvent } from '../shell-train-events.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const OLD_HEAD = '89abcdef0123456789abcdef0123456789abcdef';
const AT = '2026-11-16T12:00:00Z';

/** A synthetic record shaped exactly like `readShellEvent` requires. */
function event(overrides: Partial<ShellTrainEvent> = {}): ShellTrainEvent {
  return {
    line: 1,
    atIso: AT,
    kind: 'result',
    outcome: 'merged',
    pullRequest: 42,
    headOid: HEAD,
    detailCode: 'none',
    fromHeadOid: null,
    ...overrides,
  };
}

function extractList(events: unknown[]) {
  return extractShadowShellFacts(events);
}

function expectOk(events: unknown[]) {
  const result = extractList(events);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected ok');
  return result.facts;
}

function expectInvalid(events: unknown) {
  const result = extractShadowShellFacts(events);
  expect(result).toEqual({ ok: false, reason: 'invalid-input' });
}

describe('extractShadowShellFacts: extraction', () => {
  it('reads one result/merged event as one merge', () => {
    const facts = expectOk([event()]);
    expect(facts.merges).toEqual([{ pullRequest: 42, headOid: HEAD, atIso: AT }]);
    expect(facts.headMoves).toEqual([]);
    expect(facts.headMovesIncompleteFor).toEqual([]);
    expect(facts.carryDecisions).toEqual([]);
    expect(facts.anomalies).toEqual([]);
  });

  it('keeps a merge with a batch-member detail a merge', () => {
    const facts = expectOk([event({ detailCode: 'batch-member' })]);
    expect(facts.merges).toHaveLength(1);
    expect(facts.anomalies).toEqual([]);
  });

  it('result/merged with pullRequest: null emits unresolved-merge', () => {
    const facts = expectOk([event({ pullRequest: null })]);
    expect(facts.merges).toEqual([]);
    expect(facts.anomalies).toEqual([{ atIso: AT, code: 'unresolved-merge' }]);
  });

  it('head-moved with head-moved-from emits one head move', () => {
    const facts = expectOk([
      event({ kind: 'head-moved', outcome: 'moved', pullRequest: 7, headOid: HEAD, fromHeadOid: OLD_HEAD, detailCode: 'head-moved-from' }),
    ]);
    expect(facts.headMoves).toEqual([
      { pullRequest: 7, fromHeadOid: OLD_HEAD, toHeadOid: HEAD, atIso: AT },
    ]);
    expect(facts.headMovesIncompleteFor).toEqual([]);
  });

  it('head-moved with other detailCode records pullRequest in headMovesIncompleteFor', () => {
    const facts = expectOk([
      event({ kind: 'head-moved', outcome: 'moved', pullRequest: 7, headOid: HEAD, fromHeadOid: OLD_HEAD, detailCode: 'other' }),
    ]);
    expect(facts.headMoves).toEqual([]);
    expect(facts.headMovesIncompleteFor).toEqual([7]);
  });

  it('head-moved missing fromHeadOid records pullRequest in headMovesIncompleteFor', () => {
    const facts = expectOk([
      event({ kind: 'head-moved', outcome: 'moved', pullRequest: 7, headOid: HEAD, fromHeadOid: null, detailCode: 'head-moved-from' }),
    ]);
    expect(facts.headMoves).toEqual([]);
    expect(facts.headMovesIncompleteFor).toEqual([7]);
  });

  it('intent then result premerge-carried emits one move and one carried decision', () => {
    const facts = expectOk([
      event({ line: 1, kind: 'intent', outcome: 'update-branch', pullRequest: 7, headOid: OLD_HEAD }),
      event({ line: 2, outcome: 'updated', pullRequest: 7, headOid: HEAD, detailCode: 'premerge-carried' }),
    ]);
    expect(facts.headMoves).toEqual([
      { pullRequest: 7, fromHeadOid: OLD_HEAD, toHeadOid: HEAD, atIso: AT },
    ]);
    expect(facts.carryDecisions).toEqual([
      { pullRequest: 7, oldHeadOid: OLD_HEAD, newHeadOid: HEAD, atIso: AT, shellCarry: 'carried' },
    ]);
    expect(facts.anomalies).toEqual([]);
  });

  it('intent then result premerge-not-carried emits not-carried', () => {
    const facts = expectOk([
      event({ line: 1, kind: 'intent', outcome: 'update-branch', pullRequest: 7, headOid: OLD_HEAD }),
      event({ line: 2, outcome: 'updated', pullRequest: 7, headOid: HEAD, detailCode: 'premerge-not-carried' }),
    ]);
    expect(facts.carryDecisions).toEqual([
      { pullRequest: 7, oldHeadOid: OLD_HEAD, newHeadOid: HEAD, atIso: AT, shellCarry: 'not-carried' },
    ]);
  });

  it('intent then result premerge-reposted emits a move and no decision', () => {
    const facts = expectOk([
      event({ line: 1, kind: 'intent', outcome: 'update-branch', pullRequest: 7, headOid: OLD_HEAD }),
      event({ line: 2, outcome: 'updated', pullRequest: 7, headOid: HEAD, detailCode: 'premerge-reposted' }),
    ]);
    expect(facts.headMoves).toHaveLength(1);
    expect(facts.carryDecisions).toEqual([]);
    expect(facts.anomalies).toEqual([]);
  });

  it('result/updated with other detailCode emits unclassified-update and still the move', () => {
    const facts = expectOk([
      event({ line: 1, kind: 'intent', outcome: 'update-branch', pullRequest: 7, headOid: OLD_HEAD }),
      event({ line: 2, outcome: 'updated', pullRequest: 7, headOid: HEAD, detailCode: 'none' }),
    ]);
    expect(facts.headMoves).toHaveLength(1);
    expect(facts.carryDecisions).toEqual([]);
    expect(facts.anomalies).toEqual([{ atIso: AT, code: 'unclassified-update' }]);
  });

  it('result/updated without pending intent emits unpaired-update and records headMovesIncompleteFor', () => {
    const facts = expectOk([event({ outcome: 'updated', pullRequest: 7, headOid: HEAD, detailCode: 'premerge-carried' })]);
    expect(facts.headMoves).toEqual([]);
    expect(facts.anomalies).toEqual([{ atIso: AT, code: 'unpaired-update' }]);
    expect(facts.headMovesIncompleteFor).toEqual([7]);
  });

  it('result/updated with null headOid emits unpaired-update and records headMovesIncompleteFor', () => {
    const facts = expectOk([
      event({ line: 1, kind: 'intent', outcome: 'update-branch', pullRequest: 7, headOid: OLD_HEAD }),
      event({ line: 2, outcome: 'updated', pullRequest: 7, headOid: null, detailCode: 'premerge-carried' }),
    ]);
    expect(facts.headMoves).toEqual([]);
    expect(facts.anomalies).toEqual([{ atIso: AT, code: 'unpaired-update' }]);
    expect(facts.headMovesIncompleteFor).toEqual([7]);
  });

  it('an intermediate result with another outcome clears the pending intent', () => {
    const facts = expectOk([
      event({ line: 1, kind: 'intent', outcome: 'update-branch', pullRequest: 7, headOid: OLD_HEAD }),
      event({ line: 2, kind: 'result', outcome: 'failed', pullRequest: 7, headOid: HEAD }),
      event({ line: 3, outcome: 'updated', pullRequest: 7, headOid: HEAD, detailCode: 'premerge-carried' }),
    ]);
    expect(facts.headMoves).toEqual([]);
    expect(facts.carryDecisions).toEqual([]);
    expect(facts.anomalies).toEqual([{ atIso: AT, code: 'unpaired-update' }]);
    expect(facts.headMovesIncompleteFor).toEqual([7]);
  });

  it('a result/merged clears the pending intent before anything else', () => {
    const facts = expectOk([
      event({ line: 1, kind: 'intent', outcome: 'update-branch', pullRequest: 7, headOid: OLD_HEAD }),
      event({ line: 2, outcome: 'merged', pullRequest: 7, headOid: HEAD }),
      event({ line: 3, outcome: 'updated', pullRequest: 7, headOid: HEAD, detailCode: 'premerge-carried' }),
    ]);
    expect(facts.merges).toHaveLength(1);
    expect(facts.headMoves).toEqual([]);
    expect(facts.carryDecisions).toEqual([]);
    expect(facts.anomalies).toEqual([{ atIso: AT, code: 'unpaired-update' }]);
    expect(facts.headMovesIncompleteFor).toEqual([7]);
  });

  it('two intents then one result pairs from the second intent', () => {
    const newerHead = 'fedcba9876543210fedcba9876543210fedcba98';
    const facts = expectOk([
      event({ line: 1, kind: 'intent', outcome: 'update-branch', pullRequest: 7, headOid: OLD_HEAD }),
      event({ line: 2, kind: 'intent', outcome: 'update-branch', pullRequest: 7, headOid: newerHead }),
      event({ line: 3, outcome: 'updated', pullRequest: 7, headOid: HEAD, detailCode: 'premerge-carried' }),
    ]);
    expect(facts.headMoves).toEqual([
      { pullRequest: 7, fromHeadOid: newerHead, toHeadOid: HEAD, atIso: AT },
    ]);
    expect(facts.carryDecisions).toEqual([
      { pullRequest: 7, oldHeadOid: newerHead, newHeadOid: HEAD, atIso: AT, shellCarry: 'carried' },
    ]);
  });

  it('interleaved pull requests pair independently', () => {
    const facts = expectOk([
      event({ line: 1, kind: 'intent', outcome: 'update-branch', pullRequest: 7, headOid: OLD_HEAD }),
      event({ line: 2, kind: 'intent', outcome: 'update-branch', pullRequest: 9, headOid: HEAD }),
      event({ line: 3, outcome: 'updated', pullRequest: 9, headOid: HEAD, detailCode: 'premerge-carried' }),
      event({ line: 4, outcome: 'updated', pullRequest: 7, headOid: HEAD, detailCode: 'premerge-not-carried' }),
    ]);
    expect(facts.carryDecisions).toEqual([
      { pullRequest: 9, oldHeadOid: HEAD, newHeadOid: HEAD, atIso: AT, shellCarry: 'carried' },
      { pullRequest: 7, oldHeadOid: OLD_HEAD, newHeadOid: HEAD, atIso: AT, shellCarry: 'not-carried' },
    ]);
    expect(facts.anomalies).toEqual([]);
  });

  it('an intent never followed by a result produces nothing', () => {
    const facts = expectOk([event({ kind: 'intent', outcome: 'update-branch', pullRequest: 7, headOid: OLD_HEAD })]);
    expect(facts).toEqual({
      merges: [],
      headMoves: [],
      headMovesIncompleteFor: [],
      carryDecisions: [],
      anomalies: [],
    });
  });

  it('line not ascending is refused as invalid-input', () => {
    expectInvalid([event({ line: 2 }), event({ line: 1 })]);
  });
});

describe('extractShadowShellFacts: hostile input', () => {
  it('refuses null', () => {
    expectInvalid(null);
  });

  it('refuses undefined', () => {
    expectInvalid(undefined);
  });

  it('refuses a wrong primitive (a number where a list is due)', () => {
    expectInvalid(17);
  });

  it('refuses a non-iterable object where a list is due', () => {
    expectInvalid({ length: 1, 0: event() });
  });

  it('refuses a Proxy whose getOwnPropertyDescriptor reports NaN for length', () => {
    const plain = [event()];
    const proxy = new Proxy(plain, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === 'length' && descriptor) {
          return { ...descriptor, value: Number.NaN };
        }
        return descriptor;
      },
    });
    expectInvalid(proxy);
  });

  it('refuses an array with an extra own enumerable key', () => {
    const list: unknown[] = [event()];
    (list as unknown as Record<string, unknown>).extra = 'hostile';
    expectInvalid(list);
  });

  it('refuses a string where the event list is due', () => {
    expectInvalid('not-a-list');
  });

  it('refuses a number where a string field is due', () => {
    expectInvalid([event({ atIso: 17 as unknown as string })]);
  });

  it('refuses a sparse array with a hole', () => {
    const holey: unknown[] = [event()];
    holey.length = 2;
    expectInvalid(holey);
  });

  it('refuses an enormous length before any traversal', () => {
    const huge: unknown[] = [];
    Object.defineProperty(huge, 'length', { value: 2 ** 32 - 1, writable: false });
    expectInvalid(huge);
  });

  it('refuses a list over the cap of SHADOW_SHELL_FACTS_MAX_EVENTS', () => {
    const overCap: unknown[] = Array.from({ length: SHADOW_SHELL_FACTS_MAX_EVENTS + 1 }, (_, index) =>
      event({ line: index + 1, kind: 'park', outcome: 'parked', pullRequest: null, headOid: null }),
    );
    expectInvalid(overCap);
  });

  it('never runs a getter on an element', () => {
    let calls = 0;
    const item: Record<string, unknown> = { ...event() };
    Object.defineProperty(item, 'line', { get() { calls += 1; return 1; }, enumerable: true });
    expectInvalid([item]);
    expect(calls).toBe(0);
  });

  it('never runs a getter on the list root', () => {
    let calls = 0;
    const root: unknown[] = [event()];
    Object.defineProperty(root, '0', { get() { calls += 1; return event(); }, enumerable: true });
    expectInvalid(root);
    expect(calls).toBe(0);
  });

  it('accepts a Proxy over a valid list with no get trap run, yielding the plain result', () => {
    const plain = [
      event({ line: 1, kind: 'intent', outcome: 'update-branch', pullRequest: 7, headOid: OLD_HEAD }),
      event({ line: 2, outcome: 'updated', pullRequest: 7, headOid: HEAD, detailCode: 'premerge-carried' }),
    ];
    let getTraps = 0;
    const proxy = new Proxy(plain, {
      get(target, property, receiver) {
        getTraps += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const result = extractShadowShellFacts(proxy);
    expect(result).toEqual(extractShadowShellFacts(plain));
    expect(getTraps).toBe(0);
  });

  it('refuses an element carrying a prototype-polluting own key', () => {
    const item = JSON.parse(JSON.stringify(event())) as Record<string, unknown>;
    Object.defineProperty(item, '__proto__', { value: null, enumerable: true, configurable: true });
    expectInvalid([item]);
  });

  it('refuses an element that is a Proxy with a throwing getPrototypeOf trap', () => {
    const hostile = new Proxy(event(), {
      getPrototypeOf() {
        throw new Error('hostile getPrototypeOf');
      },
    });
    expectInvalid([hostile]);
  });

  it('is not satisfied by a constant verdict', () => {
    // A constant empty-facts verdict would report anomalies where the input has none.
    const facts = expectOk([event({ pullRequest: null })]);
    expect(facts.anomalies).toHaveLength(1);
  });

  it('is not satisfied by an identity echo of the input', () => {
    // An identity echo would return the raw records rather than typed facts.
    const facts = expectOk([event()]);
    expect(facts.merges).not.toEqual([event()]);
    expect(facts.merges).toEqual([{ pullRequest: 42, headOid: HEAD, atIso: AT }]);
  });
});
