import { describe, expect, it } from 'vitest';

import {
  applyCoverage,
  type CheckCoverage,
  type CoverageExpectation,
  isCheckCoverage,
} from '../check-coverage.js';
import { EVIDENCE_RESULTS } from '../value-objects/EvidenceResult.vo.js';

describe('isCheckCoverage', () => {
  it.each([
    { ran: true, unitKind: 'tests', units: 0 },
    { ran: true, unitKind: 'files', units: 42 },
    { ran: true, unitKind: 'checks', units: 7 },
    { ran: false, reason: 'no count in output' },
  ] as const)('accepts %#', (value) => {
    expect(isCheckCoverage(value)).toBe(true);
  });

  it.each([
    { ran: true, unitKind: 'tests', units: -1 },
    { ran: true, unitKind: 'tests', units: 1.5 },
    { ran: true, unitKind: 'lines', units: 3 },
    { ran: false, reason: '' },
    { ran: false, reason: 'x'.repeat(201) },
    { ran: true, unitKind: 'tests', units: 3, extra: true },
    { ran: false, reason: 'why', extra: true },
    null,
    'a string',
    { ran: true },
  ] as const)('rejects %#', (value) => {
    expect(isCheckCoverage(value)).toBe(false);
  });
});

describe('applyCoverage', () => {
  const downgradeCases: ReadonlyArray<{
    name: string;
    coverage: CheckCoverage | undefined;
    expectation: CoverageExpectation;
  }> = [
    {
      name: 'missing coverage',
      coverage: undefined,
      expectation: { unitKind: 'tests', minUnits: 1 },
    },
    {
      name: 'coverage did not run',
      coverage: { ran: false, reason: 'no count in output' },
      expectation: { unitKind: 'tests', minUnits: 1 },
    },
    {
      name: 'different unit kind',
      coverage: { ran: true, unitKind: 'files', units: 10 },
      expectation: { unitKind: 'tests', minUnits: 1 },
    },
    {
      name: 'below minimum units',
      coverage: { ran: true, unitKind: 'tests', units: 0 },
      expectation: { unitKind: 'tests', minUnits: 1 },
    },
  ];

  it.each(downgradeCases)('downgrades pass to unknown: $name', ({ coverage, expectation }) => {
    expect(applyCoverage('pass', coverage, expectation)).toBe('unknown');
  });

  it.each(EVIDENCE_RESULTS)('returns %s unchanged without an expectation', (result) => {
    expect(applyCoverage(result, { ran: true, unitKind: 'tests', units: 3 }, undefined)).toBe(result);
  });

  it('keeps fail unchanged when an expectation is present', () => {
    expect(
      applyCoverage('fail', { ran: true, unitKind: 'tests', units: 0 }, { unitKind: 'tests', minUnits: 1 }),
    ).toBe('fail');
  });

  it('keeps fail unchanged when coverage is missing', () => {
    expect(applyCoverage('fail', undefined, { unitKind: 'tests', minUnits: 1 })).toBe('fail');
  });

  it('passes when units equals minUnits', () => {
    expect(
      applyCoverage('pass', { ran: true, unitKind: 'tests', units: 1 }, { unitKind: 'tests', minUnits: 1 }),
    ).toBe('pass');
  });
});
