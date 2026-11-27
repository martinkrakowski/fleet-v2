import { types } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  findUnbackedAvailabilityClaims,
  type AvailabilityClaimGuardResult,
} from '../availability-claim-guard.js';

const isProxy = types.isProxy;

/** A detector that is not a function, as a hostile caller might supply. */
const NOT_A_FUNCTION = undefined as unknown as typeof types.isProxy;

/** A detector that throws on any value. */
function throwingDetector(): boolean {
  throw new Error('detector exploded');
}

function expectRefused(
  result: AvailabilityClaimGuardResult,
  reason: string,
  target: 'docs' | 'drillRecords',
): void {
  expect(result).toEqual({ status: 'refused', reason, target });
  // The refusal carries only status/reason/target: nothing echoes the input.
  expect(Object.keys(result).sort()).toEqual(['reason', 'status', 'target']);
}

describe('findUnbackedAvailabilityClaims', () => {
  describe('core guard behaviour', () => {
    it('flags percentage availability figure when no drill record matches', () => {
      const result = findUnbackedAvailabilityClaims(
        [{ id: 'doc-1', text: 'The service advertises 99.9% uptime.' }],
        [{ id: 'drill-7' }],
        isProxy,
      );
      expect(result).toEqual({
        status: 'flagged',
        findings: [{ docId: 'doc-1', figure: '99.9%' }],
      });
    });

    it('flags a percentage figure with more than 16 fractional digits when no drill record matches', () => {
      // Regression: the previous pattern capped fractional digits at 16, so a
      // 19-fraction-digit figure matched nothing and the guard returned pass.
      const result = findUnbackedAvailabilityClaims(
        [{ id: 'doc-1', text: 'Claimed 99.99999999999999999% uptime.' }],
        [{ id: 'drill-7' }],
        isProxy,
      );
      expect(result).toEqual({
        status: 'flagged',
        findings: [{ docId: 'doc-1', figure: '99.99999999999999999%' }],
      });
    });

    it('deduplicates repeated unbacked figures within the same document', () => {
      const result = findUnbackedAvailabilityClaims(
        [{ id: 'doc-1', text: '99.9% here and 99.9% again, plus 99.99% once.' }],
        [],
        isProxy,
      );
      expect(result).toEqual({
        status: 'flagged',
        findings: [
          { docId: 'doc-1', figure: '99.9%' },
          { docId: 'doc-1', figure: '99.99%' },
        ],
      });
    });

    it('flags percentage availability figure when drill record id only appears as a substring of another token', () => {
      const result = findUnbackedAvailabilityClaims(
        [{ id: 'doc-1', text: 'Verified by drill-10: 99.9% uptime.' }],
        [{ id: 'drill-1' }],
        isProxy,
      );
      expect(result).toEqual({
        status: 'flagged',
        findings: [{ docId: 'doc-1', figure: '99.9%' }],
      });
    });

    it('passes when percentage availability figure has a matching drill record id at a token boundary', () => {
      const result = findUnbackedAvailabilityClaims(
        [{ id: 'doc-1', text: 'Verified by drill-1: 99.9% uptime.' }],
        [{ id: 'drill-1' }],
        isProxy,
      );
      expect(result).toEqual({ status: 'pass' });
    });

    it('passes when text exceeds 16384 characters up to configured limit and has a matching drill record id', () => {
      const filler = 'x'.repeat(20_000);
      const result = findUnbackedAvailabilityClaims(
        [{ id: 'doc-1', text: `${filler} drill-1 99.9%` }],
        [{ id: 'drill-1' }],
        isProxy,
      );
      expect(result).toEqual({ status: 'pass' });
    });

    it('passes when text contains no percentage availability figure', () => {
      const result = findUnbackedAvailabilityClaims(
        [{ id: 'doc-1', text: 'No claims here, only drill-1 prose.' }],
        [],
        isProxy,
      );
      expect(result).toEqual({ status: 'pass' });
    });
  });

  describe('refusals', () => {
    it('refuses null docs and null drillRecords with not-array', () => {
      expectRefused(
        findUnbackedAvailabilityClaims(null, [], isProxy),
        'not-array',
        'docs',
      );
      expectRefused(
        findUnbackedAvailabilityClaims([], null, isProxy),
        'not-array',
        'drillRecords',
      );
    });

    it('refuses undefined docs and undefined drillRecords', () => {
      expectRefused(
        findUnbackedAvailabilityClaims(undefined, [], isProxy),
        'snapshot-refused',
        'docs',
      );
      expectRefused(
        findUnbackedAvailabilityClaims([], undefined, isProxy),
        'snapshot-refused',
        'drillRecords',
      );
    });

    it('refuses non-iterable and wrong-primitive inputs', () => {
      for (const bad of [123, true, 'text', {}]) {
        expectRefused(
          findUnbackedAvailabilityClaims(bad, [], isProxy),
          'not-array',
          'docs',
        );
        expectRefused(
          findUnbackedAvailabilityClaims([], bad, isProxy),
          'not-array',
          'drillRecords',
        );
      }
      for (const bad of [Symbol('s'), 1n, () => {}]) {
        expectRefused(
          findUnbackedAvailabilityClaims(bad, [], isProxy),
          'snapshot-refused',
          'docs',
        );
      }
    });

    it('refuses sparse array with array hole', () => {
      const sparse: unknown[] = new Array(2);
      delete sparse[0];
      delete sparse[1];
      expectRefused(
        findUnbackedAvailabilityClaims(sparse, [], isProxy),
        'snapshot-refused',
        'docs',
      );
      expectRefused(
        findUnbackedAvailabilityClaims([], sparse, isProxy),
        'snapshot-refused',
        'drillRecords',
      );
    });

    it('refuses getter and throwing getter without invoking them', () => {
      let invoked = false;
      const getterDoc: object = Object.defineProperty({}, 'text', {
        enumerable: true,
        get() {
          invoked = true;
          return '99.9%';
        },
      });
      const throwingDoc: object = Object.defineProperty({}, 'text', {
        enumerable: true,
        get() {
          throw new Error('never read');
        },
      });
      for (const doc of [getterDoc, throwingDoc]) {
        expectRefused(
          findUnbackedAvailabilityClaims([doc], [], isProxy),
          'snapshot-refused',
          'docs',
        );
      }
      expect(invoked).toBe(false);
    });

    it('refuses top-level and nested Proxy with zero traps invoked', () => {
      function trapCountingProxy<T extends object>(target: T): { proxy: T; count: () => number } {
        let count = 0;
        const handler = new Proxy({}, {
          get(_handlerTarget, property) {
            count += 1;
            return Reflect.get({}, property);
          },
        });
        return { proxy: new Proxy(target, handler), count: () => count };
      }
      const topLevel = trapCountingProxy([] as unknown[]);
      expectRefused(
        findUnbackedAvailabilityClaims(topLevel.proxy, [], isProxy),
        'snapshot-refused',
        'docs',
      );
      expect(topLevel.count()).toBe(0);

      const nestedElement = trapCountingProxy({ id: 'doc-1', text: '99.9%' });
      expectRefused(
        findUnbackedAvailabilityClaims([nestedElement.proxy], [], isProxy),
        'snapshot-refused',
        'docs',
      );
      expect(nestedElement.count()).toBe(0);

      const nestedDrill = trapCountingProxy({ id: 'drill-1' });
      expectRefused(
        findUnbackedAvailabilityClaims([], [nestedDrill.proxy], isProxy),
        'snapshot-refused',
        'drillRecords',
      );
      expect(nestedDrill.count()).toBe(0);
    });

    it('refuses array-like objects', () => {
      expectRefused(
        findUnbackedAvailabilityClaims(
          { length: 1, 0: { id: 'doc-1', text: '99.9%' } },
          [],
          isProxy,
        ),
        'not-array',
        'docs',
      );
      expectRefused(
        findUnbackedAvailabilityClaims([], { length: 1, 0: { id: 'drill-1' } }, isProxy),
        'not-array',
        'drillRecords',
      );
    });

    it('refuses enormous length array without enumerating keys', () => {
      const huge = new Array(1_000_000);
      expectRefused(
        findUnbackedAvailabilityClaims(huge, [], isProxy),
        'snapshot-refused',
        'docs',
      );
    });

    it('refuses prototype-polluting keys on docs and drill records', () => {
      for (const key of ['__proto__', 'constructor', 'prototype']) {
        const doc: Record<string, unknown> = { id: 'doc-1', text: '99.9%' };
        Object.defineProperty(doc, key, { value: 'x', enumerable: true, writable: true, configurable: true });
        expectRefused(
          findUnbackedAvailabilityClaims([doc], [], isProxy),
          'prototype-polluting-key',
          'docs',
        );
        const drill: Record<string, unknown> = { id: 'drill-1' };
        Object.defineProperty(drill, key, { value: 'x', enumerable: true, writable: true, configurable: true });
        expectRefused(
          findUnbackedAvailabilityClaims([], [drill], isProxy),
          'prototype-polluting-key',
          'drillRecords',
        );
      }
    });

    it('refuses extra unknown keys on docs and drill records', () => {
      expectRefused(
        findUnbackedAvailabilityClaims(
          [{ id: 'doc-1', text: '99.9%', extra: 1 }],
          [],
          isProxy,
        ),
        'unknown-key',
        'docs',
      );
      expectRefused(
        findUnbackedAvailabilityClaims([], [{ id: 'drill-1', why: 'x' }], isProxy),
        'unknown-key',
        'drillRecords',
      );
    });

    it('refuses malformed doc and drill records including short or missing ids', () => {
      const cases: unknown[][] = [
        [null],
        ['text'],
        [42],
        [[]],
        [{}],
        [{ text: '99.9%' }],
        [{ id: '' }],
        [{ id: 'doc-1', text: 99 }],
      ];
      for (const [element] of cases) {
        expectRefused(
          findUnbackedAvailabilityClaims([element], [], isProxy),
          'malformed-record',
          'docs',
        );
      }
      for (const element of [null, 42, {}, { id: 'a' }, { id: 'has space' }, { id: 'x'.repeat(65) }]) {
        expectRefused(
          findUnbackedAvailabilityClaims([], [element], isProxy),
          'malformed-record',
          'drillRecords',
        );
      }
    });

    it('refuses doc with id exceeding 256 characters as malformed-record', () => {
      for (const length of [257, 262_144]) {
        expectRefused(
          findUnbackedAvailabilityClaims(
            [{ id: 'x'.repeat(length), text: '99.9%' }],
            [],
            isProxy,
          ),
          'malformed-record',
          'docs',
        );
      }
    });

    it('refuses missing or throwing isProxy detector', () => {
      expectRefused(
        findUnbackedAvailabilityClaims([{ id: 'doc-1', text: '99.9%' }], [], NOT_A_FUNCTION),
        'snapshot-refused',
        'docs',
      );
      expectRefused(
        findUnbackedAvailabilityClaims([], [{ id: 'drill-1' }], throwingDetector),
        'snapshot-refused',
        'docs',
      );
    });

    it('refuses with too-many-findings when unbacked findings exceed 1024', () => {
      // 513 docs x 2 distinct unbacked figures each = 1026 findings > 1024.
      const docs = Array.from({ length: 513 }, (_, i) => ({
        id: `doc-${i}`,
        text: '99.9% and 99.99%',
      }));
      expectRefused(
        findUnbackedAvailabilityClaims(docs, [], isProxy),
        'too-many-findings',
        'docs',
      );
    });

    it('never echoes rejected input values in refusal results', () => {
      const hostile = { id: 'doc-1', text: 'SECRET-VALUE-99.9%', extra: 'classified' };
      const result = findUnbackedAvailabilityClaims([hostile], [], isProxy);
      expectRefused(result, 'unknown-key', 'docs');
      expect(JSON.stringify(result)).not.toContain('SECRET-VALUE-99.9%');
      expect(JSON.stringify(result)).not.toContain('classified');
    });
  });
});
