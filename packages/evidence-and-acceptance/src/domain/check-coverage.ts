/**
 * V1 (plan §3.1): a check that exits 0 but covered nothing is `unknown`,
 * never `pass`. Agreement or a zero exit is not evidence of coverage.
 */

import type { EvidenceResultValue } from './value-objects/EvidenceResult.vo.js';

export type CoverageUnitKind = 'tests' | 'files' | 'checks';

export type CheckCoverage =
  | { readonly ran: true; readonly unitKind: CoverageUnitKind; readonly units: number }
  | { readonly ran: false; readonly reason: string };

export interface CoverageExpectation {
  readonly unitKind: CoverageUnitKind;
  readonly minUnits: number;
}

export const COVERAGE_UNIT_KINDS: readonly CoverageUnitKind[] = ['tests', 'files', 'checks'];

export function isCheckCoverage(value: unknown): value is CheckCoverage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);

  if (record.ran === true) {
    if (keys.length !== 3) {
      return false;
    }
    if (!keys.includes('ran') || !keys.includes('unitKind') || !keys.includes('units')) {
      return false;
    }
    if (
      typeof record.unitKind !== 'string' ||
      !(COVERAGE_UNIT_KINDS as readonly string[]).includes(record.unitKind)
    ) {
      return false;
    }
    if (
      typeof record.units !== 'number' ||
      !Number.isSafeInteger(record.units) ||
      record.units < 0
    ) {
      return false;
    }
    return true;
  }

  if (record.ran === false) {
    if (keys.length !== 2) {
      return false;
    }
    if (!keys.includes('ran') || !keys.includes('reason')) {
      return false;
    }
    if (typeof record.reason !== 'string') {
      return false;
    }
    const trimmed = record.reason.trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
      return false;
    }
    return true;
  }

  return false;
}

export function applyCoverage(
  result: EvidenceResultValue,
  coverage: CheckCoverage | undefined,
  expectation: CoverageExpectation | undefined,
): EvidenceResultValue {
  if (expectation === undefined || result !== 'pass') {
    return result;
  }
  if (
    coverage === undefined ||
    !coverage.ran ||
    coverage.unitKind !== expectation.unitKind ||
    coverage.units < expectation.minUnits
  ) {
    return 'unknown';
  }
  return 'pass';
}
