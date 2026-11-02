// @generated entity stub — refined for the merge train station.
/**
 * GateReceiptRecord is the durable result of one gate run against one exact
 * commit under one named gate profile. An infrastructure failure is recorded
 * as its own result: it says nothing about the candidate and never counts as
 * a gate rejection.
 */

import { accepted, isNonEmptyString, isSha40, refused, type ValidationResult } from './validation.js';

/** The three outcomes a gate run may record. */
export type GateReceiptResult = 'passed' | 'failed' | 'infrastructure-failure';

const GATE_RECEIPT_RESULTS: readonly string[] = ['passed', 'failed', 'infrastructure-failure'];

export interface GateReceiptRecord {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly testedSha: string;
  readonly gateProfile: string;
  readonly result: GateReceiptResult;
}

/** Validate unknown input as a GateReceiptRecord; a refused value never throws. */
export function validateGateReceiptRecord(value: unknown): ValidationResult<GateReceiptRecord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refused('gate receipt record must be a plain object');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    return refused('gate receipt record schemaVersion must be 1');
  }
  if (!isNonEmptyString(record.id)) {
    return refused('gate receipt record id must be a non-empty string');
  }
  if (!isSha40(record.testedSha)) {
    return refused('gate receipt record testedSha must be 40 lower-case hex characters');
  }
  if (!isNonEmptyString(record.gateProfile)) {
    return refused('gate receipt record gateProfile must be a non-empty string');
  }
  if (typeof record.result !== 'string' || !GATE_RECEIPT_RESULTS.includes(record.result)) {
    return refused('gate receipt record result must be "passed", "failed" or "infrastructure-failure"');
  }
  return accepted({
    id: record.id,
    schemaVersion: 1,
    testedSha: record.testedSha,
    gateProfile: record.gateProfile,
    result: record.result as GateReceiptResult,
  });
}
