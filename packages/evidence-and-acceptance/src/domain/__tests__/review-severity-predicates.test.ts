import { describe, expect, it, vi } from 'vitest';
import { isBlockingFindingSeverity, isMinorOrNitSeverity } from '../review-selection.js';

/**
 * Cost bound: both predicates are O(1) strict-equality (`===` / `!==`)
 * comparisons on a single `unknown` value — no loops, recursion or property
 * reads — so each call in these tests is constant-time and no further budget
 * bound applies.
 */

const KNOWN_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;

const HOSTILE_VALUES: readonly unknown[] = [
  'critical',
  '',
  'Minor',
  'nit ',
  undefined,
  null,
  0,
  {},
  ['minor'],
  { 0: 'minor', length: 1 },
  '__proto__',
  'constructor',
  'toString',
  new Proxy({}, {}),
  { get toString(): string {
    throw new Error('boom');
  } },
];

const ALL_SAMPLE_VALUES: readonly unknown[] = [...KNOWN_SEVERITIES, ...HOSTILE_VALUES];

describe('isBlockingFindingSeverity', () => {
  it('isBlockingFindingSeverity returns false only for minor and nit and true for blocker and major', () => {
    expect(isBlockingFindingSeverity('minor')).toBe(false);
    expect(isBlockingFindingSeverity('nit')).toBe(false);
    expect(isBlockingFindingSeverity('blocker')).toBe(true);
    expect(isBlockingFindingSeverity('major')).toBe(true);
  });

  it('isBlockingFindingSeverity fails closed to true for unrecognized strings, wrong types, and hostile inputs', () => {
    for (const value of HOSTILE_VALUES) {
      expect(isBlockingFindingSeverity(value), `value ${String(typeof value === 'object' && value !== null ? Object.prototype.toString.call(value) : value)} must read as blocking`).toBe(true);
    }
  });

  it('boxed String and objects with toString are treated as blocking without calling toString', () => {
    const toStringSpy = vi.fn(() => 'minor');
    expect(isBlockingFindingSeverity(new String('minor'))).toBe(true);
    expect(isBlockingFindingSeverity({ toString: toStringSpy })).toBe(true);
    expect(toStringSpy).not.toHaveBeenCalled();
  });
});

describe('isMinorOrNitSeverity', () => {
  it('isMinorOrNitSeverity returns true only for minor and nit and false for all other values', () => {
    expect(isMinorOrNitSeverity('minor')).toBe(true);
    expect(isMinorOrNitSeverity('nit')).toBe(true);
    expect(isMinorOrNitSeverity('blocker')).toBe(false);
    expect(isMinorOrNitSeverity('major')).toBe(false);
    for (const value of HOSTILE_VALUES) {
      expect(isMinorOrNitSeverity(value), `value must not read as minor/nit`).toBe(false);
    }
  });

  it('isMinorOrNitSeverity is a type guard that narrows to minor or nit without coercion', () => {
    const toStringSpy = vi.fn(() => 'minor');
    expect(isMinorOrNitSeverity(new String('minor'))).toBe(false);
    expect(isMinorOrNitSeverity({ toString: toStringSpy })).toBe(false);
    expect(toStringSpy).not.toHaveBeenCalled();
  });
});

describe('severity predicate complement invariant', () => {
  it('isBlockingFindingSeverity and isMinorOrNitSeverity are exact complements across all sample values', () => {
    for (const value of ALL_SAMPLE_VALUES) {
      expect(isBlockingFindingSeverity(value)).toBe(!isMinorOrNitSeverity(value));
    }
  });
});
