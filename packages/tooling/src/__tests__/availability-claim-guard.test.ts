import { types } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  findUnbackedAvailabilityClaims,
  type AvailabilityDrillRecord,
} from '../availability-claim-guard.js';

const isProxy = types.isProxy;

const DOC = { id: 'doc-1', text: 'The service reports 99.9% uptime (drill-1).' };
const DRILL: AvailabilityDrillRecord = { id: 'drill-1', backedFigures: ['99.9%'] };

describe('findUnbackedAvailabilityClaims', () => {
  it('passes when percentage availability figure has a matching substantiating drill record id in the same clause at a token boundary', () => {
    const result = findUnbackedAvailabilityClaims(
      [DOC],
      [DRILL],
      isProxy,
    );
    expect(result).toEqual({ status: 'pass' });
  });

  it('flags percentage availability figure when no drill record matches', () => {
    const result = findUnbackedAvailabilityClaims(
      [{ id: 'doc-1', text: '99.9% uptime reported.' }],
      [],
      isProxy,
    );
    expect(result).toEqual({
      status: 'flagged',
      findings: [{ docId: 'doc-1', figure: '99.9%' }],
    });
  });

  it('flags percentage availability figure when drill record appears only in a different clause', () => {
    const result = findUnbackedAvailabilityClaims(
      [{ id: 'doc-1', text: '99.9% uptime; see drill-1 for the deployment notes' }],
      [DRILL],
      isProxy,
    );
    expect(result).toEqual({
      status: 'flagged',
      findings: [{ docId: 'doc-1', figure: '99.9%' }],
    });
  });

  it('flags percentage availability figure when same-clause drill record does not substantiate that figure', () => {
    for (const backedFigures of [[], ['99.0%']]) {
      const result = findUnbackedAvailabilityClaims(
        [{ id: 'doc-1', text: '99.9% uptime (drill-1)' }],
        [{ id: 'drill-1', backedFigures }],
        isProxy,
      );
      expect(result).toEqual({
        status: 'flagged',
        findings: [{ docId: 'doc-1', figure: '99.9%' }],
      });
    }
  });

  it('flags unbacked percentage in a second clause even when first clause backs a percentage', () => {
    const result = findUnbackedAvailabilityClaims(
      [{ id: 'doc-1', text: '99.9% uptime (drill-1); 99.99% durability' }],
      [DRILL],
      isProxy,
    );
    expect(result).toEqual({
      status: 'flagged',
      findings: [{ docId: 'doc-1', figure: '99.99%' }],
    });

    const repeated = findUnbackedAvailabilityClaims(
      [{ id: 'doc-1', text: '99.9% uptime (drill-1); 99.9% durability' }],
      [DRILL],
      isProxy,
    );
    expect(repeated).toEqual({
      status: 'flagged',
      findings: [{ docId: 'doc-1', figure: '99.9%' }],
    });
  });

  it('deduplicates repeated unbacked figures within the same document', () => {
    const result = findUnbackedAvailabilityClaims(
      [{ id: 'doc-1', text: '99.9% uptime; 99.9% durability; 99.9% failover' }],
      [],
      isProxy,
    );
    expect(result).toEqual({
      status: 'flagged',
      findings: [{ docId: 'doc-1', figure: '99.9%' }],
    });
  });

  it('flags percentage availability figure when drill record id only appears as a substring of another token', () => {
    const result = findUnbackedAvailabilityClaims(
      [{ id: 'doc-1', text: '99.9% uptime (drill-10)' }],
      [DRILL],
      isProxy,
    );
    expect(result).toEqual({
      status: 'flagged',
      findings: [{ docId: 'doc-1', figure: '99.9%' }],
    });
  });

  it('passes when text exceeds 16384 characters up to configured limit and has a matching substantiating drill record id in the same clause', () => {
    const filler = 'Deployment notes and reliability observations. '.repeat(400);
    expect(filler.length).toBeGreaterThan(16_384);
    const result = findUnbackedAvailabilityClaims(
      [{ id: 'doc-1', text: `${filler} 99.9% uptime (drill-1).` }],
      [DRILL],
      isProxy,
    );
    expect(result).toEqual({ status: 'pass' });
  });

  it('passes when text contains no percentage availability figure', () => {
    const result = findUnbackedAvailabilityClaims(
      [{ id: 'doc-1', text: 'The service was available all quarter (drill-1).' }],
      [DRILL],
      isProxy,
    );
    expect(result).toEqual({ status: 'pass' });
  });

  it('refuses null docs and null drillRecords with not-array', () => {
    expect(findUnbackedAvailabilityClaims(null, [DRILL], isProxy)).toEqual({
      status: 'refused',
      reason: 'not-array',
      target: 'docs',
    });
    expect(findUnbackedAvailabilityClaims([DOC], null, isProxy)).toEqual({
      status: 'refused',
      reason: 'not-array',
      target: 'drillRecords',
    });
  });

  it('refuses undefined docs and undefined drillRecords', () => {
    expect(findUnbackedAvailabilityClaims(undefined, [DRILL], isProxy)).toEqual({
      status: 'refused',
      reason: 'snapshot-refused',
      target: 'docs',
    });
    expect(findUnbackedAvailabilityClaims([DOC], undefined, isProxy)).toEqual({
      status: 'refused',
      reason: 'snapshot-refused',
      target: 'drillRecords',
    });
  });

  it('refuses non-iterable and wrong-primitive inputs', () => {
    for (const bad of [123, true, 'text', {}]) {
      expect(findUnbackedAvailabilityClaims(bad, [DRILL], isProxy)).toEqual({
        status: 'refused',
        reason: 'not-array',
        target: 'docs',
      });
      expect(findUnbackedAvailabilityClaims([DOC], bad, isProxy)).toEqual({
        status: 'refused',
        reason: 'not-array',
        target: 'drillRecords',
      });
    }
    for (const hostile of [Symbol('x'), 1n, () => {}]) {
      expect(findUnbackedAvailabilityClaims(hostile, [DRILL], isProxy)).toEqual({
        status: 'refused',
        reason: 'snapshot-refused',
        target: 'docs',
      });
      expect(findUnbackedAvailabilityClaims([DOC], hostile, isProxy)).toEqual({
        status: 'refused',
        reason: 'snapshot-refused',
        target: 'drillRecords',
      });
    }
  });

  it('refuses sparse array with array hole', () => {
    const sparse: unknown[] = new Array(2);
    sparse[1] = DOC;
    expect(findUnbackedAvailabilityClaims(sparse, [DRILL], isProxy)).toEqual({
      status: 'refused',
      reason: 'snapshot-refused',
      target: 'docs',
    });
  });

  it('refuses getter and throwing getter without invoking them', () => {
    let invoked = false;
    const withGetter = Object.defineProperties({}, {
      id: { get() { invoked = true; return 'doc-1'; }, enumerable: true },
      text: { value: '99.9% uptime', enumerable: true },
    });
    expect(findUnbackedAvailabilityClaims([withGetter], [DRILL], isProxy)).toEqual({
      status: 'refused',
      reason: 'snapshot-refused',
      target: 'docs',
    });
    expect(invoked).toBe(false);

    const throwing = Object.defineProperties({}, {
      id: {
        get() { throw new Error('never observed'); },
        enumerable: true,
      },
      text: { value: '99.9% uptime', enumerable: true },
    });
    expect(findUnbackedAvailabilityClaims([throwing], [DRILL], isProxy)).toEqual({
      status: 'refused',
      reason: 'snapshot-refused',
      target: 'docs',
    });
  });

  it('refuses top-level and nested Proxy with zero traps invoked', () => {
    let traps = 0;
    const proxy = new Proxy({ id: 'doc-1', text: '99.9%' }, {
      get() { traps += 1; return undefined; },
    });
    expect(findUnbackedAvailabilityClaims(proxy, [DRILL], isProxy)).toEqual({
      status: 'refused',
      reason: 'snapshot-refused',
      target: 'docs',
    });
    expect(findUnbackedAvailabilityClaims([proxy], [DRILL], isProxy)).toEqual({
      status: 'refused',
      reason: 'snapshot-refused',
      target: 'docs',
    });
    expect(traps).toBe(0);
  });

  it('refuses array-like objects', () => {
    const arrayLike = { length: 1, 0: { id: 'doc-1', text: '99.9%' } };
    expect(findUnbackedAvailabilityClaims(arrayLike, [DRILL], isProxy)).toEqual({
      status: 'refused',
      reason: 'not-array',
      target: 'docs',
    });
  });

  it('refuses enormous length array without enumerating keys', () => {
    const enormous = new Array(1_000_000);
    expect(findUnbackedAvailabilityClaims(enormous, [DRILL], isProxy)).toEqual({
      status: 'refused',
      reason: 'snapshot-refused',
      target: 'docs',
    });
  });

  it('refuses prototype-polluting keys on docs and drill records', () => {
    const badDoc = Object.defineProperty({ id: 'doc-1', text: '99.9%' }, '__proto__', {
      value: { injected: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const badDrill = Object.defineProperty({ id: 'drill-1', backedFigures: ['99.9%'] }, 'constructor', {
      value: null,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(findUnbackedAvailabilityClaims([badDoc], [DRILL], isProxy)).toEqual({
      status: 'refused',
      reason: 'prototype-polluting-key',
      target: 'docs',
    });
    expect(findUnbackedAvailabilityClaims([DOC], [badDrill], isProxy)).toEqual({
      status: 'refused',
      reason: 'prototype-polluting-key',
      target: 'drillRecords',
    });
  });

  it('refuses extra unknown keys on docs and drill records', () => {
    const extraDoc = { id: 'doc-1', text: '99.9% uptime', note: 'extra' };
    const extraDrill = { id: 'drill-1', backedFigures: ['99.9%'], note: 'extra' };
    expect(findUnbackedAvailabilityClaims([extraDoc], [DRILL], isProxy)).toEqual({
      status: 'refused',
      reason: 'unknown-key',
      target: 'docs',
    });
    expect(findUnbackedAvailabilityClaims([DOC], [extraDrill], isProxy)).toEqual({
      status: 'refused',
      reason: 'unknown-key',
      target: 'drillRecords',
    });
  });

  it('refuses malformed doc and drill records including invalid backedFigures', () => {
    const cases: ReadonlyArray<readonly [unknown, 'docs' | 'drillRecords']> = [
      [[null], 'docs'],
      [[42], 'docs'],
      [[{ id: 'doc-1' }], 'docs'],
      [[{ text: '99.9%' }], 'docs'],
      [[{ id: '', text: '99.9%' }], 'docs'],
      [[{ id: 'doc-1', text: 42 }], 'docs'],
      [[{ id: 42, text: '99.9%' }], 'docs'],
      [[42], 'drillRecords'],
      [[{ id: 'drill-1' }], 'drillRecords'],
      [[{ backedFigures: ['99.9%'] }], 'drillRecords'],
      [[{ id: 'a', backedFigures: ['99.9%'] }], 'drillRecords'],
      [[{ id: 'drill-1', backedFigures: '99.9%' }], 'drillRecords'],
      [[{ id: 'drill-1', backedFigures: ['uptime'] }], 'drillRecords'],
    ];
    for (const [bad, target] of cases) {
      const result = findUnbackedAvailabilityClaims(
        target === 'docs' ? bad : [DOC],
        target === 'docs' ? [DRILL] : bad,
        isProxy,
      );
      expect(result).toEqual({ status: 'refused', reason: 'malformed-record', target });
    }
  });

  it('refuses doc with id exceeding 256 characters as malformed-record', () => {
    const longId = 'd'.repeat(257);
    expect(
      findUnbackedAvailabilityClaims([{ id: longId, text: '99.9%' }], [DRILL], isProxy),
    ).toEqual({ status: 'refused', reason: 'malformed-record', target: 'docs' });
  });

  it('refuses missing or throwing isProxy detector', () => {
    const missing = undefined as unknown as typeof isProxy;
    expect(findUnbackedAvailabilityClaims([DOC], [DRILL], missing)).toEqual({
      status: 'refused',
      reason: 'snapshot-refused',
      target: 'docs',
    });
    const throwing = (() => { throw new Error('detector failed'); }) as typeof isProxy;
    expect(findUnbackedAvailabilityClaims([DOC], [DRILL], throwing)).toEqual({
      status: 'refused',
      reason: 'snapshot-refused',
      target: 'docs',
    });
  });

  it('refuses with too-many-findings when unbacked findings exceed 1024', () => {
    const docs = Array.from({ length: 3 }, (_, i) => ({
      id: `doc-${i}`,
      text: Array.from({ length: 500 }, (_, j) => `${j + 1}% note`).join('; '),
    }));
    expect(findUnbackedAvailabilityClaims(docs, [], isProxy)).toEqual({
      status: 'refused',
      reason: 'too-many-findings',
      target: 'docs',
    });
  });

  it('never echoes rejected input values in refusal results', () => {
    const secret = 'classified-uptime-secret';
    for (const result of [
      findUnbackedAvailabilityClaims(secret, [DRILL], isProxy),
      findUnbackedAvailabilityClaims([DOC], secret, isProxy),
      findUnbackedAvailabilityClaims([{ id: '', text: secret }], [DRILL], isProxy),
    ]) {
      if (result.status === 'refused') {
        expect(Object.keys(result).sort()).toEqual(['reason', 'status', 'target']);
        expect(JSON.stringify(result)).not.toContain(secret);
      } else {
        expect.unreachable('expected a refusal');
      }
    }
  });

  it('merges backed figures of drill records sharing one id and still requires the exact figure in the clause', () => {
    const drills: AvailabilityDrillRecord[] = [
      { id: 'drill-1', backedFigures: ['99.9%'] },
      { id: 'drill-1', backedFigures: ['99.5%'] },
    ];
    const backed = findUnbackedAvailabilityClaims(
      [{ id: 'doc-1', text: '99.9% and 99.5% uptime (drill-1).' }],
      drills,
      isProxy,
    );
    expect(backed).toEqual({ status: 'pass' });
    const partly = findUnbackedAvailabilityClaims(
      [{ id: 'doc-1', text: '99.9% and 99.99% uptime (drill-1).' }],
      drills,
      isProxy,
    );
    expect(partly).toEqual({ status: 'flagged', findings: [{ docId: 'doc-1', figure: '99.99%' }] });
  });

  it('flags a figure when only a different drill token in the clause backs another figure', () => {
    const result = findUnbackedAvailabilityClaims(
      [{ id: 'doc-1', text: '99.9% uptime (drill-2).' }],
      [DRILL, { id: 'drill-2', backedFigures: ['99.0%'] }],
      isProxy,
    );
    expect(result).toEqual({ status: 'flagged', findings: [{ docId: 'doc-1', figure: '99.9%' }] });
  });

  it('keeps work linear in document length when many clauses repeat a drill id shared by large figure sets', () => {
    const figures = Array.from({ length: 1000 }, (_, i) => `${String(i % 100)}.${String(Math.floor(i / 100))}%`);
    const drills: AvailabilityDrillRecord[] = [
      { id: 'abc', backedFigures: figures },
      { id: 'abc', backedFigures: figures.map((figure) => `1${figure}`).filter((figure) => figure.length <= 8) },
    ];
    const text = 'abc 1.1%;'.repeat(Math.floor(262_144 / 9));
    expect(text.length).toBeLessThanOrEqual(262_144);
    // Count Set insertions: the work is bounded by a small multiple of the
    // text length, not by clauses x backed figures (tens of millions).
    const originalAdd = Set.prototype.add;
    let adds = 0;
    Set.prototype.add = function countedAdd<T>(this: Set<T>, value: T): Set<T> {
      adds += 1;
      return originalAdd.call(this, value) as Set<T>;
    };
    try {
      const result = findUnbackedAvailabilityClaims([{ id: 'doc-1', text }], drills, isProxy);
      expect(result).toEqual({ status: 'pass' });
    } finally {
      Set.prototype.add = originalAdd;
    }
    expect(adds).toBeLessThan(10 * text.length);
  });
});
