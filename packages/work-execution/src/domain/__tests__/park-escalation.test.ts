import { describe, expect, it } from 'vitest';

import {
  PARK_ESCALATION_HISTORY_MAX,
  PARK_ESCALATION_MODES,
  PARK_ESCALATION_STAY_REASONS,
  decideParkEscalation,
} from '../park-escalation.js';
import { PARK_FINDINGS_MAX_COUNT } from '../park-findings-view.js';

const PARKED_FIX = {
  reason: 'fix-no-progress',
  qualifier: null,
  parkedFrom: 'collecting',
  questionId: null,
};

const DIRTY = { trackedFilesChanged: 3 };

const STAY_PARKED_MALFORMED_PARKED = { kind: 'stay-parked', reason: 'malformed-parked-record' } as const;

function historyEntry(): Record<string, unknown> {
  return { entryId: 'e1', kind: 'result', reasonCode: 'gate-failed' };
}

describe('decideParkEscalation', () => {
  it('escalates with commit-pending for a fix-no-progress park, clean history, and a dirty worktree', () => {
    expect(decideParkEscalation(PARKED_FIX, [historyEntry(), { mode: 'other' }], DIRTY)).toEqual({
      kind: 'escalate',
      mode: 'commit-pending',
    });
    expect(decideParkEscalation(PARKED_FIX, [], DIRTY)).toEqual({ kind: 'escalate', mode: 'commit-pending' });
    expect(decideParkEscalation(PARKED_FIX, [], { trackedFilesChanged: 1 })).toEqual({
      kind: 'escalate',
      mode: 'commit-pending',
    });
  });

  it('exposes the closed mode and stay-reason sets and the history cap', () => {
    expect(PARK_ESCALATION_MODES).toEqual(['commit-pending']);
    expect(PARK_ESCALATION_STAY_REASONS).toEqual([
      'malformed-parked-record',
      'malformed-history',
      'history-too-long',
      'missing-dirty-worktree-fact',
      'malformed-dirty-worktree-fact',
      'worktree-clean',
      'head-advanced',
      'park-reason-not-escalatable',
      'already-escalated',
    ]);
    expect(PARK_ESCALATION_HISTORY_MAX).toBe(256);
  });

  it('returns malformed-parked-record for null, primitives, non-plain objects, throwing getters, and invalid findings', () => {
    const malformed = { kind: 'stay-parked', reason: 'malformed-parked-record' };
    for (const hostile of [
      null,
      undefined,
      7,
      'parked',
      true,
      [],
      [PARKED_FIX],
      new Date(),
      Object.create(null),
      {},
      // missing required keys
      { reason: 'fix-no-progress', qualifier: null, parkedFrom: 'collecting' },
      // extra keys
      { ...PARKED_FIX, extra: 1 },
      // invalid reason
      { ...PARKED_FIX, reason: 'XYZZY' },
      { ...PARKED_FIX, reason: 7 },
    ]) {
      expect(decideParkEscalation(hostile, [], DIRTY)).toEqual(malformed);
    }

    // A throwing enumerable getter is never invoked: the copied value is undefined,
    // which then fails the key/value validation as a typed refusal.
    const throwing: Record<string, unknown> = {};
    Object.defineProperty(throwing, 'reason', { enumerable: true, get() { throw new Error('boom'); } });
    expect(decideParkEscalation(throwing, [], DIRTY)).toEqual(malformed);

    // malformed findings: not an array, too long, array-like, sparse with holes, non-plain elements
    const finding = { findingId: 'f1', severity: 'minor', summary: 's', filePath: null, line: null };
    const sparseFindings: unknown[] = [finding, finding];
    delete sparseFindings[1];
    for (const findings of [
      7,
      'findings',
      { length: 1, 0: finding },
      new Array(PARK_FINDINGS_MAX_COUNT + 1).fill(finding),
      sparseFindings,
      [null],
      [7],
    ]) {
      expect(decideParkEscalation({ ...PARKED_FIX, findings }, [], DIRTY)).toEqual(malformed);
    }
    // absent, null, and a full valid list are accepted shapes
    expect(decideParkEscalation({ ...PARKED_FIX, findings: undefined }, [], DIRTY)).toEqual({ kind: 'escalate', mode: 'commit-pending' });
    expect(decideParkEscalation({ ...PARKED_FIX, findings: null }, [], DIRTY)).toEqual({ kind: 'escalate', mode: 'commit-pending' });
    expect(
      decideParkEscalation({ ...PARKED_FIX, findings: [finding, finding, finding, finding, finding] }, [], DIRTY),
    ).toEqual({ kind: 'escalate', mode: 'commit-pending' });
  });

  it('refuses a findings array whose element is a counter getter without ever running it', () => {
    let reads = 0;
    const findings: unknown[] = [
      { findingId: 'f1', severity: 'minor', summary: 's', filePath: null, line: null },
    ];
    Object.defineProperty(findings, 0, {
      enumerable: true,
      get() {
        reads += 1;
        return { findingId: `f${reads}`, severity: 'minor', summary: 's', filePath: null, line: null };
      },
    });
    expect(decideParkEscalation({ ...PARKED_FIX, findings }, [], DIRTY)).toEqual(STAY_PARKED_MALFORMED_PARKED);
    expect(reads).toBe(0);
  });

  it('refuses a history array whose element is a counter getter without ever running it', () => {
    let reads = 0;
    const history: unknown[] = [];
    Object.defineProperty(history, 0, {
      enumerable: true,
      get() {
        reads += 1;
        return { entryId: `e${reads}`, kind: 'result', reasonCode: 'gate-failed' };
      },
    });
    expect(decideParkEscalation(PARKED_FIX, history, DIRTY)).toEqual({ kind: 'stay-parked', reason: 'malformed-history' });
    expect(reads).toBe(0);
  });

  it('returns park-reason-not-escalatable for non-fix-no-progress park reasons', () => {
    for (const reason of [
      'one-way-door', 'seat-plan-exhausted', 'blocker-after-round-2', 'ambiguous', 'artifacts-unsealed',
      'cost-ceiling', 'ci-failed-no-rounds', 'branch-behind', 'review-seat-unavailable', 'halted',
      'stop-unconfirmed', 'stop-refused', 'acceptance-rejected', 'step-refused', 'owner-merge',
    ] as const) {
      const parked = { ...PARKED_FIX, reason };
      expect(decideParkEscalation(parked, [], DIRTY)).toEqual({ kind: 'stay-parked', reason: 'park-reason-not-escalatable' });
    }
  });

  it('returns malformed-history for non-arrays, array-likes, array holes, and hostile elements', () => {
    const malformed = { kind: 'stay-parked', reason: 'malformed-history' };
    const sparseHistory: unknown[] = [historyEntry(), historyEntry()];
    delete sparseHistory[1];
    for (const history of [
      null,
      undefined,
      7,
      'history',
      true,
      {},
      // array-like, not an array
      { length: 1, 0: historyEntry() },
      // sparse arrays with holes
      new Array(2),
      sparseHistory,
      // hostile elements
      [null],
      [7],
      ['entry'],
      [[]],
    ]) {
      expect(decideParkEscalation(PARKED_FIX, history, DIRTY)).toEqual(malformed);
    }

    // An own enumerable `__proto__` key on an element is refused and Object.prototype stays unpolluted.
    const protoKeyEntry: Record<string, unknown> = { reasonCode: 'gate-failed' };
    Object.defineProperty(protoKeyEntry, '__proto__', { enumerable: true, value: { polluted: true } });
    expect(decideParkEscalation(PARKED_FIX, [protoKeyEntry], DIRTY)).toEqual(malformed);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // A throwing getter on a history entry's own key is refused, never thrown.
    const throwingEntry: Record<string, unknown> = {};
    Object.defineProperty(throwingEntry, 'reasonCode', { enumerable: true, get() { throw new Error('boom'); } });
    expect(decideParkEscalation(PARKED_FIX, [throwingEntry], DIRTY)).toEqual(malformed);

    // A Proxy with a non-plain prototype on an element is refused by the domain reader via the one
    // unavoidable getPrototypeOf trap; a later slice claims the trap-free check (PX1).
    const traps: string[] = [];
    const hostileElement = new Proxy(historyEntry(), {
      getPrototypeOf() { traps.push('getPrototypeOf'); return Array.prototype; },
      get(t, k) { traps.push('get'); return Reflect.get(t, k); },
    });
    expect(decideParkEscalation(PARKED_FIX, [hostileElement], DIRTY)).toEqual(malformed);
    expect(traps).toEqual(['getPrototypeOf']);
  });

  it('returns malformed-parked-record when a throwing history Proxy is caught by the outer guard', () => {
    // A Proxy whose trap throws inside the history scan is caught: a typed
    // refusal on the outer catch, never a throw. The length read is what
    // throws; the decision does not escape as an exception.
    const throwingProxy = new Proxy([historyEntry()], {
      get() { throw new Error('boom'); },
    });
    expect(decideParkEscalation(PARKED_FIX, throwingProxy, DIRTY)).toEqual(STAY_PARKED_MALFORMED_PARKED);
  });

  it('returns malformed-parked-record for an unknown park class', () => {
    // A present class that is not in LANE_RUN_PARK_CLASSES is malformed, whether
    // it is an unknown string, a wrong primitive, or null. Absent class stays
    // the pre-PT1a shape and is covered by the escalate test.
    for (const parkClass of ['XYZZY', 7, null]) {
      expect(decideParkEscalation({ ...PARKED_FIX, class: parkClass }, [], DIRTY)).toEqual(STAY_PARKED_MALFORMED_PARKED);
    }
    // A declared class is not a refusal: the same park still escalates. This
    // fails a constant `malformed-parked-record` implementation.
    expect(decideParkEscalation({ ...PARKED_FIX, class: 'other' }, [], DIRTY)).toEqual({
      kind: 'escalate',
      mode: 'commit-pending',
    });
  });

  it('returns malformed-history for a subclassed array, a symbol key, a non-enumerable index, an extra named key and an own __proto__ key', () => {
    const malformed = { kind: 'stay-parked', reason: 'malformed-history' };

    // A subclass is an array whose prototype is not Array.prototype. The old
    // index loop accepted it; `readBoundedDenseArray` refuses it.
    class HostileHistory extends Array {}
    const subclassed = new HostileHistory(1);
    subclassed[0] = historyEntry();

    const symbolKeyed = [historyEntry()];
    Object.defineProperty(symbolKeyed, Symbol('extra'), { value: 1, enumerable: false });

    const hiddenIndex = [historyEntry()];
    Object.defineProperty(hiddenIndex, 0, {
      value: historyEntry(),
      enumerable: false,
      writable: true,
      configurable: true,
    });

    const paddedIndex = [historyEntry()];
    Object.defineProperty(paddedIndex, '01', {
      value: historyEntry(),
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const protoKey = [historyEntry()];
    Object.defineProperty(protoKey, '__proto__', { enumerable: true, value: { polluted: true } });

    for (const history of [subclassed, symbolKeyed, hiddenIndex, paddedIndex, protoKey]) {
      expect(decideParkEscalation(PARKED_FIX, history, DIRTY)).toEqual(malformed);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('returns history-too-long without scanning past the cap when history exceeds PARK_ESCALATION_HISTORY_MAX', () => {
    let reads = 0;
    const counting = new Proxy(
      Array.from({ length: PARK_ESCALATION_HISTORY_MAX + 1 }, historyEntry),
      {
        get(t, k) {
          reads += 1;
          return Reflect.get(t, k);
        },
      },
    );
    expect(decideParkEscalation(PARKED_FIX, counting, DIRTY)).toEqual({ kind: 'stay-parked', reason: 'history-too-long' });
    // Only the length read happened; no element was scanned.
    expect(reads).toBe(1);

    // The enormous non-array shape is refused for its shape, also without a scan.
    expect(decideParkEscalation(PARKED_FIX, { length: 1_000_000 }, DIRTY)).toEqual({ kind: 'stay-parked', reason: 'malformed-history' });
    expect(decideParkEscalation(PARKED_FIX, Array.from({ length: 1_000_000 }, historyEntry), DIRTY)).toEqual({
      kind: 'stay-parked',
      reason: 'history-too-long',
    });
  });

  it('returns already-escalated when commit-pending has already run once', () => {
    const byResult = { entryId: 'e1', kind: 'result', reasonCode: 'park-escalated', detail: 'commit-pending' };
    const byMode = { entryId: 'e2', kind: 'result', mode: 'commit-pending' };
    for (const history of [[byResult], [historyEntry(), byMode], [byMode], [historyEntry(), byResult]]) {
      expect(decideParkEscalation(PARKED_FIX, history, DIRTY)).toEqual({ kind: 'stay-parked', reason: 'already-escalated' });
    }
    // A malformed entry AFTER the escalation marker is validated first:
    // malformed-history wins, the scan never returns already-escalated on a
    // marker while skipping later entries.
    expect(decideParkEscalation(PARKED_FIX, [{ mode: 'commit-pending' }, Object.create(null)], DIRTY)).toEqual({
      kind: 'stay-parked',
      reason: 'malformed-history',
    });

    // A result naming another reason code and detail does not count as the escalation.
    expect(decideParkEscalation(PARKED_FIX, [{ reasonCode: 'park-escalated', detail: 'other' }], DIRTY)).toEqual({
      kind: 'escalate',
      mode: 'commit-pending',
    });
  });

  it('returns missing-dirty-worktree-fact when dirtyWorktree is absent or null', () => {
    const expected = { kind: 'stay-parked', reason: 'missing-dirty-worktree-fact' };
    expect(decideParkEscalation(PARKED_FIX, [])).toEqual(expected);
    expect(decideParkEscalation(PARKED_FIX, [], undefined)).toEqual(expected);
    expect(decideParkEscalation(PARKED_FIX, [], null)).toEqual(expected);
  });

  it('returns malformed-dirty-worktree-fact for wrong primitive types, negative/non-integer counts, and hostile objects', () => {
    const malformed = { kind: 'stay-parked', reason: 'malformed-dirty-worktree-fact' };
    for (const trackedFilesChanged of ['1', 'true', true, null, NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(decideParkEscalation(PARKED_FIX, [], { trackedFilesChanged })).toEqual(malformed);
    }
    // wrong keys: missing, extra, non-plain, array
    for (const fact of [{}, { trackedFilesChanged: 1, extra: 2 }, { other: 1 }, 7, 'fact', [], [1]]) {
      expect(decideParkEscalation(PARKED_FIX, [], fact)).toEqual(malformed);
    }
    // The optional `headAdvanced` key must be a boolean when present. An own
    // `headAdvanced: undefined` (explicit or copied from a getter) is a present
    // key, never "absent": it must be refused as malformed.
    for (const headAdvanced of ['true', 1, null, 0, undefined]) {
      expect(decideParkEscalation(PARKED_FIX, [], { trackedFilesChanged: 1, headAdvanced })).toEqual(malformed);
    }

    // An enumerable getter on `headAdvanced` is never invoked: the shared
    // reader copies its value as `undefined`, and the own-key presence test
    // (`Object.hasOwn`) then refuses the copied `undefined` as malformed.
    const getterHead: Record<string, unknown> = { trackedFilesChanged: 1 };
    let getterRan = false;
    Object.defineProperty(getterHead, 'headAdvanced', { enumerable: true, get() { getterRan = true; return true; } });
    expect(decideParkEscalation(PARKED_FIX, [], getterHead)).toEqual(malformed);
    expect(getterRan).toBe(false);

    // Even on a clean worktree an own `undefined` headAdvanced is malformed,
    // never read as absent (which would report worktree-clean).
    expect(decideParkEscalation(PARKED_FIX, [], { trackedFilesChanged: 0, headAdvanced: undefined })).toEqual(malformed);

    // A throwing enumerable getter is never invoked: the copied value is undefined, refused as malformed.
    const throwing: Record<string, unknown> = {};
    Object.defineProperty(throwing, 'trackedFilesChanged', { enumerable: true, get() { throw new Error('boom'); } });
    expect(decideParkEscalation(PARKED_FIX, [], throwing)).toEqual(malformed);

    // A prototype-polluting own `__proto__` key is refused and Object.prototype stays unpolluted.
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "trackedFilesChanged": 1}') as Record<string, unknown>;
    expect(decideParkEscalation(PARKED_FIX, [], parsed)).toEqual(malformed);
    const defined: Record<string, unknown> = {};
    Object.defineProperty(defined, '__proto__', { enumerable: true, value: { polluted: true } });
    Object.defineProperty(defined, 'trackedFilesChanged', { enumerable: true, value: 1 });
    expect(decideParkEscalation(PARKED_FIX, [], defined)).toEqual(malformed);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // A Proxy with a non-plain prototype is refused via the shared reader.
    const traps: string[] = [];
    expect(
      decideParkEscalation(PARKED_FIX, [], new Proxy({ trackedFilesChanged: 1 }, {
        getPrototypeOf() { traps.push('getPrototypeOf'); return Array.prototype; },
        get(t, k) { traps.push('get'); return Reflect.get(t, k); },
      })),
    ).toEqual(malformed);
    expect(traps).toEqual(['getPrototypeOf']);
  });

  it('returns worktree-clean when trackedFilesChanged is zero', () => {
    expect(decideParkEscalation(PARKED_FIX, [], { trackedFilesChanged: 0 })).toEqual({ kind: 'stay-parked', reason: 'worktree-clean' });
    // Absent headAdvanced stays unknown: the clean worktree is still worktree-clean.
    expect(decideParkEscalation(PARKED_FIX, [], { trackedFilesChanged: 0, headAdvanced: false })).toEqual({
      kind: 'stay-parked',
      reason: 'worktree-clean',
    });
  });

  it('returns head-advanced when the worktree is clean but the HEAD advanced past the recorded head commit', () => {
    expect(decideParkEscalation(PARKED_FIX, [], { trackedFilesChanged: 0, headAdvanced: true })).toEqual({
      kind: 'stay-parked',
      reason: 'head-advanced',
    });
    // A dirty worktree is still an escalation regardless of the head fact.
    expect(decideParkEscalation(PARKED_FIX, [], { trackedFilesChanged: 3, headAdvanced: true })).toEqual({
      kind: 'escalate',
      mode: 'commit-pending',
    });
    expect(decideParkEscalation(PARKED_FIX, [], { trackedFilesChanged: 3, headAdvanced: false })).toEqual({
      kind: 'escalate',
      mode: 'commit-pending',
    });
  });

  it('refuses a hostile parked Proxy with a non-plain prototype via the one getPrototypeOf trap, without throwing', () => {
    const traps: string[] = [];
    const handler: ProxyHandler<Record<string, unknown>> = {
      getPrototypeOf() { traps.push('getPrototypeOf'); return Array.prototype; },
      ownKeys(t) { traps.push('ownKeys'); return Reflect.ownKeys(t); },
      getOwnPropertyDescriptor(t, k) { traps.push('gopd'); return Reflect.getOwnPropertyDescriptor(t, k); },
      get(t, k) { traps.push('get'); return Reflect.get(t, k); },
    };
    expect(decideParkEscalation(new Proxy({ ...PARKED_FIX } as Record<string, unknown>, handler), [], DIRTY)).toEqual({
      kind: 'stay-parked',
      reason: 'malformed-parked-record',
    });
    expect(traps).toEqual(['getPrototypeOf']);

    // A Proxy whose trap throws is caught: a typed refusal, never a throw.
    expect(
      decideParkEscalation(new Proxy({ ...PARKED_FIX } as Record<string, unknown>, {
        getPrototypeOf() { throw new Error('boom'); },
      }), [], DIRTY),
    ).toEqual({ kind: 'stay-parked', reason: 'malformed-parked-record' });
  });
});
