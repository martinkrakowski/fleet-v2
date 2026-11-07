// @generated entity stub — refined for the merge train station.
/**
 * CandidateRecord is one built candidate commit on the train: the base it was
 * cut from, the result it produced and the candidate it descends from (or
 * null for the first candidate of a generation). The lineage lets the
 * splitter walk back one candidate at a time without any store access.
 */

import { accepted, isNonEmptyString, isSha40, refused, type ValidationResult } from './validation.js';

export interface CandidateRecord {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly baseSha: string;
  readonly resultSha: string;
  readonly parentCandidateId: string | null;
}

/** Validate unknown input as a CandidateRecord; a refused value never throws. */
export function validateCandidateRecord(value: unknown): ValidationResult<CandidateRecord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refused('candidate record must be a plain object');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    return refused('candidate record schemaVersion must be 1');
  }
  if (!isNonEmptyString(record.id)) {
    return refused('candidate record id must be a non-empty string');
  }
  if (!isSha40(record.baseSha)) {
    return refused('candidate record baseSha must be 40 lower-case hex characters');
  }
  if (!isSha40(record.resultSha)) {
    return refused('candidate record resultSha must be 40 lower-case hex characters');
  }
  if (record.parentCandidateId !== null && !isNonEmptyString(record.parentCandidateId)) {
    return refused('candidate record parentCandidateId must be a non-empty string or null');
  }
  return accepted({
    id: record.id,
    schemaVersion: 1,
    baseSha: record.baseSha,
    resultSha: record.resultSha,
    parentCandidateId: record.parentCandidateId,
  });
}
