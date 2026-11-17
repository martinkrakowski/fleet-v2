// SH13a: pure extractor of shell merges, head moves and carry decisions from the events log.
// SH13b: the S5' premerge carry-replay evaluator over those decisions.
import { describe, expect, it } from 'vitest';

import {
  evaluateShadowPremergeCarry,
  extractShadowShellFacts,
  SHADOW_CARRY_MAX_DECISIONS,
  SHADOW_SHELL_FACTS_MAX_EVENTS,
} from '../shadow-day-shell-facts.js';
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

  it('two events with the same line number are refused as invalid-input', () => {
    // `line` must be strictly ascending; equal lines fail the `<=` check.
    expectInvalid([event({ line: 1 }), event({ line: 1 })]);
  });

  it('collects incomplete head moves for PRs 9, 3 and 9 again as the sorted unique [3, 9]', () => {
    const facts = expectOk([
      event({ line: 1, kind: 'head-moved', outcome: 'moved', pullRequest: 9, headOid: HEAD, fromHeadOid: null, detailCode: 'head-moved-from' }),
      event({ line: 2, kind: 'head-moved', outcome: 'moved', pullRequest: 3, headOid: HEAD, fromHeadOid: null, detailCode: 'head-moved-from' }),
      event({ line: 3, kind: 'head-moved', outcome: 'moved', pullRequest: 9, headOid: HEAD, fromHeadOid: null, detailCode: 'head-moved-from' }),
    ]);
    expect(facts.headMoves).toEqual([]);
    // Out of order (9 before 3, 9 twice): sorted and deduplicated.
    expect(facts.headMovesIncompleteFor).toEqual([3, 9]);
  });

  it('a merged result with a null headOid emits unresolved-merge', () => {
    // `readShellEvent` does not refuse this input: it validates `headOid`
    // only when it is non-null, so the extractor handles the null itself.
    const facts = expectOk([event({ headOid: null })]);
    expect(facts.merges).toEqual([]);
    expect(facts.anomalies).toEqual([{ atIso: AT, code: 'unresolved-merge' }]);
  });

  it('an updated result with a null pullRequest emits unpaired-update only', () => {
    const facts = expectOk([event({ outcome: 'updated', pullRequest: null, headOid: HEAD, detailCode: 'premerge-carried' })]);
    expect(facts.headMoves).toEqual([]);
    expect(facts.carryDecisions).toEqual([]);
    expect(facts.anomalies).toEqual([{ atIso: AT, code: 'unpaired-update' }]);
    // With no pullRequest there is nothing to record as incomplete.
    expect(facts.headMovesIncompleteFor).toEqual([]);
  });

  it('an update intent with a null headOid deletes that pull request pending intent', () => {
    const facts = expectOk([
      event({ line: 1, kind: 'intent', outcome: 'update-branch', pullRequest: 7, headOid: OLD_HEAD }),
      event({ line: 2, kind: 'intent', outcome: 'update-branch', pullRequest: 7, headOid: null }),
      event({ line: 3, outcome: 'updated', pullRequest: 7, headOid: HEAD, detailCode: 'premerge-carried' }),
    ]);
    // The null-headOid intent removed the pending OLD_HEAD intent, so the
    // update that produced HEAD started from an unread head: no pairing.
    expect(facts.headMoves).toEqual([]);
    expect(facts.carryDecisions).toEqual([]);
    expect(facts.anomalies).toEqual([{ atIso: AT, code: 'unpaired-update' }]);
    expect(facts.headMovesIncompleteFor).toEqual([7]);
  });
});

describe('extractShadowShellFacts: hostile input', () => {
  it('refuses an Array subclass instance holding valid events', () => {
    class EventList extends Array<unknown> {}
    const list = new EventList();
    list.push(event(), event({ line: 2, pullRequest: null }));
    expectInvalid(list);
  });

  it('refuses null', () => {
    expectInvalid(null);
  });

  it('refuses undefined', () => {
    expectInvalid(undefined);
  });

  it('refuses a wrong primitive (a number where a list is due)', () => {
    expectInvalid(17);
  });

  it('refuses an array-like object where a list is due', () => {
    expectInvalid({ length: 1, 0: event() });
  });

  it('refuses a plain empty object where a list is due', () => {
    expectInvalid({});
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

  it('refuses an element whose Proxy trap throws inside readShellEvent, never throwing', () => {
    // `readShellEvent`'s own try/catch already refuses this (the trap throw
    // happens inside `readExactPlainRecord`, before any field check); the
    // extractor's catch around `readShellEvent` is the second line of
    // defence and is never reached for this input.
    const hostile = new Proxy(event(), {
      ownKeys() {
        throw new Error('hostile ownKeys');
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

const DAY = '2026-11-16';
const PREV_DAY = '2026-11-15';
const PR = 1234;

/** A synthetic carry decision shaped exactly like S5' reads one. */
function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pullRequest: PR,
    oldHeadOid: OLD_HEAD,
    newHeadOid: HEAD,
    atIso: AT,
    shellCarry: 'carried',
    fleetCarry: 'carry',
    ...overrides,
  };
}

/** A synthetic S5' input with nothing to compare. */
function carryInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { day: DAY, unknownLines: 0, decisions: [], anomalies: [], ...overrides };
}

function expectCarry(value: unknown, expected: Record<string, unknown>): void {
  expect(evaluateShadowPremergeCarry(value)).toEqual({
    status: 'unknown',
    reason: 'invalid-input',
    compared: 0,
    laxCarries: 0,
    stricterNoCarries: 0,
    ...expected,
  });
}

describe('evaluateShadowPremergeCarry: evaluation', () => {
  it('equal carried and not-carried decisions on D pass with compared 2', () => {
    const result = evaluateShadowPremergeCarry(
      carryInput({
        decisions: [
          decision({ shellCarry: 'carried', fleetCarry: 'carry' }),
          decision({ pullRequest: 9, newHeadOid: 'fedcba9876543210fedcba9876543210fedcba98', shellCarry: 'not-carried', fleetCarry: 'no-carry' }),
        ],
      }),
    );
    expect(result).toEqual({ status: 'pass', reason: 'carry-decisions-equal', compared: 2, laxCarries: 0, stricterNoCarries: 0 });
  });

  it('fleet carry where the shell did not fails with laxCarries 1', () => {
    const result = evaluateShadowPremergeCarry(
      carryInput({ decisions: [decision({ shellCarry: 'not-carried', fleetCarry: 'carry' })] }),
    );
    expect(result).toEqual({ status: 'fail', reason: 'carry-decision-differs', compared: 1, laxCarries: 1, stricterNoCarries: 0 });
  });

  it('fleet no-carry where the shell carried fails with stricterNoCarries 1', () => {
    const result = evaluateShadowPremergeCarry(
      carryInput({ decisions: [decision({ shellCarry: 'carried', fleetCarry: 'no-carry' })] }),
    );
    expect(result).toEqual({ status: 'fail', reason: 'carry-decision-differs', compared: 1, laxCarries: 0, stricterNoCarries: 1 });
  });

  it('51 differing decisions on D fail with the full count 51, no truncation at 50', () => {
    const decisions = Array.from({ length: 51 }, (_, index) =>
      decision({
        pullRequest: index + 1,
        newHeadOid: `fedcba9876543210fedcba9876543210fedcba${index.toString(16).padStart(2, '0')}`,
        shellCarry: 'not-carried',
        fleetCarry: 'carry',
      }),
    );
    const result = evaluateShadowPremergeCarry(carryInput({ decisions }));
    expect(result).toEqual({ status: 'fail', reason: 'carry-decision-differs', compared: 51, laxCarries: 51, stricterNoCarries: 0 });
  });

  it('a differing decision on D-1 is not counted and passes', () => {
    const result = evaluateShadowPremergeCarry(
      carryInput({ decisions: [decision({ atIso: `${PREV_DAY}T12:00:00Z`, shellCarry: 'not-carried', fleetCarry: 'carry' })] }),
    );
    expect(result).toEqual({ status: 'pass', reason: 'carry-decisions-equal', compared: 0, laxCarries: 0, stricterNoCarries: 0 });
  });

  it('a non-Z offset atIso near midnight is scoped by UTC instant, not written date', () => {
    // `2026-11-16T23:30:00-02:00` is 2026-11-17T01:30Z: outside D, never counted.
    const outside = evaluateShadowPremergeCarry(
      carryInput({ decisions: [decision({ atIso: '2026-11-16T23:30:00-02:00', shellCarry: 'not-carried', fleetCarry: 'carry' })] }),
    );
    expect(outside).toEqual({ status: 'pass', reason: 'carry-decisions-equal', compared: 0, laxCarries: 0, stricterNoCarries: 0 });
    // `2026-11-15T23:00:00-02:00` is 2026-11-16T01:00Z: inside D, counted.
    const inside = evaluateShadowPremergeCarry(
      carryInput({ decisions: [decision({ atIso: '2026-11-15T23:00:00-02:00', shellCarry: 'not-carried', fleetCarry: 'carry' })] }),
    );
    expect(inside).toEqual({ status: 'fail', reason: 'carry-decision-differs', compared: 1, laxCarries: 1, stricterNoCarries: 0 });
  });

  it('unknownLines greater than zero returns unknown/shell-incomplete', () => {
    expectCarry(carryInput({ unknownLines: 3 }), { status: 'unknown', reason: 'shell-incomplete' });
    expectCarry(carryInput({ unknownLines: 1, decisions: [decision()] }), { status: 'unknown', reason: 'shell-incomplete' });
  });

  it('unknownLines not a count returns unknown/invalid-input', () => {
    expectCarry(carryInput({ unknownLines: -1 }), { status: 'unknown', reason: 'invalid-input' });
    expectCarry(carryInput({ unknownLines: 1.5 }), { status: 'unknown', reason: 'invalid-input' });
    expectCarry(carryInput({ unknownLines: '0' }), { status: 'unknown', reason: 'invalid-input' });
  });

  it('fleetCarry unknown on D returns unknown/fleet-carry-unknown', () => {
    expectCarry(carryInput({ decisions: [decision({ fleetCarry: 'unknown' })] }), {
      status: 'unknown',
      reason: 'fleet-carry-unknown',
    });
  });

  it('unpaired-update anomaly on D returns unknown/carry-pairing-incomplete', () => {
    expectCarry(carryInput({ anomalies: [{ atIso: AT, code: 'unpaired-update' }] }), {
      status: 'unknown',
      reason: 'carry-pairing-incomplete',
    });
  });

  it('unpaired-update anomaly on D-1 is ignored', () => {
    const result = evaluateShadowPremergeCarry(
      carryInput({ anomalies: [{ atIso: `${PREV_DAY}T12:00:00Z`, code: 'unpaired-update' }], decisions: [decision()] }),
    );
    expect(result).toEqual({ status: 'pass', reason: 'carry-decisions-equal', compared: 1, laxCarries: 0, stricterNoCarries: 0 });
  });

  it('unclassified-update anomaly on D returns unknown/carry-pairing-incomplete', () => {
    expectCarry(carryInput({ anomalies: [{ atIso: AT, code: 'unclassified-update' }] }), {
      status: 'unknown',
      reason: 'carry-pairing-incomplete',
    });
  });

  it('unresolved-merge anomaly on D is ignored by S5', () => {
    const result = evaluateShadowPremergeCarry(
      carryInput({ anomalies: [{ atIso: AT, code: 'unresolved-merge' }], decisions: [decision()] }),
    );
    expect(result).toEqual({ status: 'pass', reason: 'carry-decisions-equal', compared: 1, laxCarries: 0, stricterNoCarries: 0 });
  });

  it('identical duplicate newHeadOid with equal shellCarry and fleetCarry counts as one decision', () => {
    const result = evaluateShadowPremergeCarry(
      carryInput({ decisions: [decision({ shellCarry: 'not-carried', fleetCarry: 'no-carry' }), decision({ shellCarry: 'not-carried', fleetCarry: 'no-carry' })] }),
    );
    expect(result).toEqual({ status: 'pass', reason: 'carry-decisions-equal', compared: 1, laxCarries: 0, stricterNoCarries: 0 });
  });

  it('duplicate newHeadOid with differing shellCarry or fleetCarry returns unknown/carry-facts-conflicting', () => {
    expectCarry(
      carryInput({ decisions: [decision({ shellCarry: 'carried', fleetCarry: 'carry' }), decision({ shellCarry: 'not-carried', fleetCarry: 'carry' })] }),
      { status: 'unknown', reason: 'carry-facts-conflicting' },
    );
    expectCarry(
      carryInput({ decisions: [decision({ shellCarry: 'carried', fleetCarry: 'carry' }), decision({ shellCarry: 'carried', fleetCarry: 'no-carry' })] }),
      { status: 'unknown', reason: 'carry-facts-conflicting' },
    );
  });

  it('no decisions on D with unknownLines 0 and no incomplete anomalies passes with compared 0', () => {
    const result = evaluateShadowPremergeCarry(carryInput());
    expect(result).toEqual({ status: 'pass', reason: 'carry-decisions-equal', compared: 0, laxCarries: 0, stricterNoCarries: 0 });
  });

  it('a decisions list over SHADOW_CARRY_MAX_DECISIONS is refused as invalid-input', () => {
    const overCap = Array.from({ length: SHADOW_CARRY_MAX_DECISIONS + 1 }, (_, index) => decision({ pullRequest: index + 1 }));
    expectCarry(carryInput({ decisions: overCap }), { status: 'unknown', reason: 'invalid-input' });
  });

  it('a decisions list over the cap is refused before any element is read', () => {
    let calls = 0;
    const element = decision();
    Object.defineProperty(element, 'atIso', { get() { calls += 1; return AT; }, enumerable: true });
    const overCap = Array.from({ length: SHADOW_CARRY_MAX_DECISIONS + 1 }, () => element);
    expectCarry(carryInput({ decisions: overCap }), { status: 'unknown', reason: 'invalid-input' });
    expect(calls).toBe(0);
  });

  it('JSON.stringify of an evaluation carries no head oid or pull request number from the input', () => {
    const result = evaluateShadowPremergeCarry(carryInput({ decisions: [decision({ shellCarry: 'not-carried', fleetCarry: 'carry' })] }));
    const text = JSON.stringify(result);
    expect(text).not.toContain(HEAD);
    expect(text).not.toContain(OLD_HEAD);
    expect(text).not.toContain('1234');
  });
});

describe('evaluateShadowPremergeCarry: hostile input', () => {
  it('refuses null', () => {
    expectCarry(null, { status: 'unknown', reason: 'invalid-input' });
  });

  it('refuses undefined', () => {
    expectCarry(undefined, { status: 'unknown', reason: 'invalid-input' });
  });

  it('refuses a wrong primitive (a number where a string is due)', () => {
    expectCarry(carryInput({ day: 17 }), { status: 'unknown', reason: 'invalid-input' });
  });

  it('refuses a string where a list is due', () => {
    expectCarry(carryInput({ decisions: 'not-a-list' }), { status: 'unknown', reason: 'invalid-input' });
  });

  it('refuses a non-iterable object where a list is due', () => {
    expectCarry(carryInput({ decisions: { length: 1, 0: decision() } }), { status: 'unknown', reason: 'invalid-input' });
  });

  it('refuses an array hole (a sparse array)', () => {
    const holey: unknown[] = [decision()];
    holey.length = 2;
    expectCarry(carryInput({ decisions: holey }), { status: 'unknown', reason: 'invalid-input' });
  });

  it('refuses an array-like object', () => {
    const arrayLike = { length: 1, 0: decision() };
    expectCarry(carryInput({ decisions: arrayLike }), { status: 'unknown', reason: 'invalid-input' });
  });

  it('refuses an enormous length (a sparse array of length 2**32 - 1) before any traversal', () => {
    const huge: unknown[] = [];
    Object.defineProperty(huge, 'length', { value: 2 ** 32 - 1, writable: false });
    expectCarry(carryInput({ decisions: huge }), { status: 'unknown', reason: 'invalid-input' });
  });

  it('never runs a getter on an item', () => {
    let calls = 0;
    const item: Record<string, unknown> = decision();
    Object.defineProperty(item, 'shellCarry', { get() { calls += 1; return 'carried'; }, enumerable: true });
    expectCarry(carryInput({ decisions: [item] }), { status: 'unknown', reason: 'invalid-input' });
    expect(calls).toBe(0);
  });

  it('never runs a getter on the root', () => {
    let calls = 0;
    const root: Record<string, unknown> = carryInput({ decisions: [decision()] });
    Object.defineProperty(root, 'day', { get() { calls += 1; return DAY; }, enumerable: true });
    expectCarry(root, { status: 'unknown', reason: 'invalid-input' });
    expect(calls).toBe(0);
  });

  it('accepts a Proxy over a valid input with no get trap run, yielding the plain result', () => {
    const plain = carryInput({ decisions: [decision({ shellCarry: 'not-carried', fleetCarry: 'no-carry' })] });
    let getTraps = 0;
    const proxy = new Proxy(plain, {
      get(target, property, receiver) {
        getTraps += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(evaluateShadowPremergeCarry(proxy)).toEqual(evaluateShadowPremergeCarry(plain));
    expect(getTraps).toBe(0);
  });

  it('refuses a prototype-polluting own key produced by JSON.parse', () => {
    const item = JSON.parse(JSON.stringify(decision())) as Record<string, unknown>;
    Object.defineProperty(item, '__proto__', { value: null, enumerable: true, configurable: true });
    expectCarry(carryInput({ decisions: [item] }), { status: 'unknown', reason: 'invalid-input' });
  });

  it('is not satisfied by a constant verdict', () => {
    // A constant pass verdict would pass where the fleet and shell disagree.
    const result = evaluateShadowPremergeCarry(
      carryInput({ decisions: [decision({ shellCarry: 'not-carried', fleetCarry: 'carry' })] }),
    );
    expect(result.status).toBe('fail');
  });

  it('is not satisfied by an identity echo of the input', () => {
    // An identity echo would return the raw input rather than an evaluation.
    const value = carryInput({ decisions: [decision()] });
    expect(evaluateShadowPremergeCarry(value)).not.toEqual(value);
    expect(evaluateShadowPremergeCarry(value)).toEqual({
      status: 'pass',
      reason: 'carry-decisions-equal',
      compared: 1,
      laxCarries: 0,
      stricterNoCarries: 0,
    });
  });
});
