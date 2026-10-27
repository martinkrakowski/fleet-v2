import { describe, expect, it } from 'vitest';

import {
  applyCoverage,
  type CheckCoverage,
  type CoverageExpectation,
  isCheckCoverage,
} from '../check-coverage.js';
import { VerificationReceipt } from '../entities/VerificationReceipt.js';
import type { VerificationReceiptRecord } from '../evidence-records.js';
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

describe('VerificationReceipt coverage', () => {
  const baseRecord: VerificationReceiptRecord = {
    id: 'vr-1',
    assessmentId: 'asm-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: '1111111111111111111111111111111111111111',
    hostId: 'host-1',
    procedureName: 'test',
    result: 'pass',
    exitCode: 0,
    evidenceRef: 'ref-1',
    policyRevision: 'pol-1',
    completedAtIso: '2026-10-15T12:00:00.000Z',
  };

  it('create succeeds with no coverage', () => {
    const created = VerificationReceipt.create(baseRecord);
    expect(created.success).toBe(true);
    expect(created.value?.getCoverage()).toBeUndefined();
  });

  it.each<CheckCoverage>([
    { ran: true, unitKind: 'tests', units: 12 },
    { ran: false, reason: 'no count in output' },
  ])('create succeeds with coverage %#', (coverage) => {
    const created = VerificationReceipt.create({ ...baseRecord, coverage });
    expect(created.success).toBe(true);
    expect(created.value?.getCoverage()).toEqual(coverage);
  });

  it.each([
    { ran: true, unitKind: 'lines', units: 3 },
    { ran: true, unitKind: 'tests', units: -1 },
    { ran: false, reason: '' },
    { ran: true, unitKind: 'tests', units: 1, extra: 1 },
  ] as const)('create fails with malformed coverage %#', (badCoverage) => {
    const created = VerificationReceipt.create({
      ...baseRecord,
      coverage: badCoverage as unknown as CheckCoverage,
    });
    expect(created.success).toBe(false);
    expect(created.error?.message).toBe('VerificationReceipt coverage is malformed');
  });

  it('round-trips a record with coverage through fromRecord and toRecord', () => {
    const record: VerificationReceiptRecord = {
      ...baseRecord,
      coverage: { ran: true, unitKind: 'tests', units: 12 },
    };
    expect(VerificationReceipt.fromRecord(record).toRecord()).toEqual(record);
  });

  it('omits coverage from toRecord when coverage is absent', () => {
    expect('coverage' in VerificationReceipt.fromRecord(baseRecord).toRecord()).toBe(false);
  });

  it('returns the coverage value from getCoverage()', () => {
    const coverage: CheckCoverage = { ran: true, unitKind: 'tests', units: 12 };
    const receipt = VerificationReceipt.fromRecord({ ...baseRecord, coverage });
    expect(receipt.getCoverage()).toEqual(coverage);
    expect(VerificationReceipt.fromRecord(baseRecord).getCoverage()).toBeUndefined();
  });
});
