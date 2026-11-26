import { types } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  findUnbackedAvailabilityClaims,
  type AvailabilityDoc,
  type AvailabilityDrillRecord,
} from '../availability-claim-guard.js';

const { isProxy } = types;

const DOC: AvailabilityDoc = { id: 'doc-1', text: 'Uptime is 99.9% this quarter.' };
const DRILL: AvailabilityDrillRecord = { id: 'drill-1' };

/** A doc whose text names the drill record, so its figure is backed. */
const BACKED_DOC: AvailabilityDoc = {
  id: 'doc-1',
  text: 'Uptime is 99.9% this quarter, per drill-1',
};

/** A getter that must never be invoked; reads go through descriptors only. */
function withGetter(value: unknown): unknown {
  return {
    get length() {
      throw new Error('getter invoked');
    },
    get 0() {
      throw new Error('getter invoked');
    },
    ...(typeof value === 'object' && value !== null ? value : {}),
  };
}

describe('findUnbackedAvailabilityClaims', () => {
  it('flags percentage availability figure when no drill record matches', () => {
    const result = findUnbackedAvailabilityClaims([DOC], [DRILL], isProxy);
    expect(result).toEqual({
      status: 'flagged',
      findings: [{ docId: 'doc-1', figure: '99.9%' }],
    });
  });

  it('flags percentage availability figure when drill record id only appears as a substring of another token', () => {
    const result = findUnbackedAvailabilityClaims(
      [{ id: 'doc-1', text: 'Uptime 99.9% per drill-10.' }],
      [{ id: 'drill-1' }],
      isProxy,
    );
    expect(result).toEqual({
      status: 'flagged',
      findings: [{ docId: 'doc-1', figure: '99.9%' }],
    });
  });

  it('passes when percentage availability figure has a matching drill record id at a token boundary', () => {
    const result = findUnbackedAvailabilityClaims([BACKED_DOC], [DRILL], isProxy);
    expect(result).toEqual({ status: 'pass' });
  });

  it('passes when text exceeds 16384 characters up to configured limit and has a matching drill record id', () => {
    const filler = 'x'.repeat(20_000);
    const result = findUnbackedAvailabilityClaims(
      [{ id: 'doc-1', text: `${filler} 99.9% per drill-1` }],
      [{ id: 'drill-1' }],
      isProxy,
    );
    expect(result).toEqual({ status: 'pass' });
  });

  it('passes when text contains no percentage availability figure', () => {
    const result = findUnbackedAvailabilityClaims(
      [{ id: 'doc-1', text: 'No figures here, see drill-1.' }],
      [DRILL],
      isProxy,
    );
    expect(result).toEqual({ status: 'pass' });
  });

  it('does not flag an integer percentage without availability context such as CPU load 80 percent', () => {
    const result = findUnbackedAvailabilityClaims(
      [{ id: 'doc-1', text: 'CPU load is 80% this hour.' }],
      [DRILL],
      isProxy,
    );
    expect(result).toEqual({ status: 'pass' });
  });

  it('flags an integer percentage that availability wording puts into an availability claim', () => {
    const result = findUnbackedAvailabilityClaims(
      [{ id: 'doc-1', text: 'Uptime was 99% last month.' }],
      [DRILL],
      isProxy,
    );
    expect(result).toEqual({
      status: 'flagged',
      findings: [{ docId: 'doc-1', figure: '99%' }],
    });
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
  });

  it('refuses sparse array with array hole', () => {
    const sparse: unknown[] = [];
    // eslint-disable-next-line no-sparse-arrays
    sparse[1] = { ...DRILL };
    expect(findUnbackedAvailabilityClaims(sparse, [DRILL], isProxy)).toEqual({
      status: 'refused',
      reason: 'snapshot-refused',
      target: 'docs',
    });
  });

  it('refuses getter and throwing getter without invoking them', () => {
    let invoked = 0;
    const getterDoc = {
      get text() {
        invoked += 1;
        return '99.9%';
      },
      id: 'doc-1',
    };
    expect(findUnbackedAvailabilityClaims([getterDoc], [DRILL], isProxy)).toEqual({
      status: 'refused',
      reason: 'snapshot-refused',
      target: 'docs',
    });
    expect(invoked).toBe(0);
    expect(() => findUnbackedAvailabilityClaims(withGetter([DOC]), [DRILL], isProxy)).not.toThrow();
    expect(findUnbackedAvailabilityClaims(withGetter([DOC]), [DRILL], isProxy)).toEqual({
      status: 'refused',
      reason: 'snapshot-refused',
      target: 'docs',
    });
    expect(invoked).toBe(0);
  });

  it('refuses top-level and nested Proxy with zero traps invoked', () => {
    let traps = 0;
    const counter = {
      get(target: unknown, key: string): unknown {
        traps += 1;
        return Reflect.get(target as object, key);
      },
    };
    const topLevel = new Proxy([DOC], counter);
    const nested = [{ id: 'doc-1', text: 'x', drill: new Proxy(DRILL, counter) }];
    expect(findUnbackedAvailabilityClaims(topLevel, [DRILL], isProxy)).toEqual({
      status: 'refused',
      reason: 'snapshot-refused',
      target: 'docs',
    });
    expect(findUnbackedAvailabilityClaims([DOC], nested, isProxy)).toEqual({
      status: 'refused',
      reason: 'snapshot-refused',
      target: 'drillRecords',
    });
    expect(traps).toBe(0);
  });

  it('refuses array-like objects', () => {
    expect(
      findUnbackedAvailabilityClaims({ length: 1, 0: DOC }, [DRILL], isProxy),
    ).toEqual({ status: 'refused', reason: 'not-array', target: 'docs' });
  });

  it('refuses enormous length array without enumerating keys', () => {
    const huge: unknown[] = new Array(1_000_000);
    expect(findUnbackedAvailabilityClaims(huge, [DRILL], isProxy)).toEqual({
      status: 'refused',
      reason: 'snapshot-refused',
      target: 'docs',
    });
  });

  it('refuses prototype-polluting keys on docs and drill records', () => {
    const badDoc: Record<string, unknown> = { id: 'doc-1', text: '99.9%' };
    Object.defineProperty(badDoc, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(findUnbackedAvailabilityClaims([badDoc], [DRILL], isProxy)).toEqual({
      status: 'refused',
      reason: 'prototype-polluting-key',
      target: 'docs',
    });
    const badDrill: Record<string, unknown> = { id: 'drill-1' };
    Object.defineProperty(badDrill, 'constructor', {
      value: { length: 1 },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(findUnbackedAvailabilityClaims([DOC], [badDrill], isProxy)).toEqual({
      status: 'refused',
      reason: 'prototype-polluting-key',
      target: 'drillRecords',
    });
  });

  it('refuses extra unknown keys on docs and drill records', () => {
    expect(
      findUnbackedAvailabilityClaims(
        [{ id: 'doc-1', text: '99.9%', note: 'extra' }],
        [DRILL],
        isProxy,
      ),
    ).toEqual({ status: 'refused', reason: 'unknown-key', target: 'docs' });
    expect(
      findUnbackedAvailabilityClaims([DOC], [{ id: 'drill-1', text: 'extra' }], isProxy),
    ).toEqual({ status: 'refused', reason: 'unknown-key', target: 'drillRecords' });
  });

  it('refuses malformed doc and drill records including short or missing ids', () => {
    expect(findUnbackedAvailabilityClaims([null], [DRILL], isProxy)).toEqual({
      status: 'refused',
      reason: 'malformed-record',
      target: 'docs',
    });
    expect(
      findUnbackedAvailabilityClaims([{ id: 'doc-1' }], [DRILL], isProxy),
    ).toEqual({ status: 'refused', reason: 'malformed-record', target: 'docs' });
    expect(
      findUnbackedAvailabilityClaims([{ text: '99.9%' }], [DRILL], isProxy),
    ).toEqual({ status: 'refused', reason: 'malformed-record', target: 'docs' });
    expect(
      findUnbackedAvailabilityClaims([{ id: '', text: '99.9%' }], [DRILL], isProxy),
    ).toEqual({ status: 'refused', reason: 'malformed-record', target: 'docs' });
    expect(
      findUnbackedAvailabilityClaims([{ id: 'doc-1', text: 5 }], [DRILL], isProxy),
    ).toEqual({ status: 'refused', reason: 'malformed-record', target: 'docs' });
    expect(findUnbackedAvailabilityClaims([DOC], [{ id: 'a' }], isProxy)).toEqual({
      status: 'refused',
      reason: 'malformed-record',
      target: 'drillRecords',
    });
    expect(findUnbackedAvailabilityClaims([DOC], [{}], isProxy)).toEqual({
      status: 'refused',
      reason: 'malformed-record',
      target: 'drillRecords',
    });
  });

  it('refuses missing or throwing isProxy detector', () => {
    expect(
      findUnbackedAvailabilityClaims([DOC], [DRILL], undefined as never),
    ).toEqual({ status: 'refused', reason: 'snapshot-refused', target: 'docs' });
    const throwing = () => {
      throw new Error('detector');
    };
    expect(findUnbackedAvailabilityClaims([DOC], [DRILL], throwing)).toEqual({
      status: 'refused',
      reason: 'snapshot-refused',
      target: 'docs',
    });
  });

  it('never echoes rejected input values in refusal results', () => {
    const secretNote = 'SECRET-VALUE-MUST-NOT-APPEAR';
    const bad: Record<string, unknown> = { id: 'doc-1', text: '99.9%', note: secretNote };
    const result = findUnbackedAvailabilityClaims([bad], [DRILL], isProxy);
    expect(JSON.stringify(result)).not.toContain(secretNote);
    expect(Object.keys(result).sort()).toEqual(['reason', 'status', 'target']);
  });
});
