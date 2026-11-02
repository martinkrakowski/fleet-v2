// @generated entity stub — refined for the merge train station.
/**
 * TrainRecord is the pure, serializable identity of one merge train: which
 * repository and base branch it serves, which generation it is and the base
 * commit its current candidate was cut from. It carries no behaviour and
 * never a credential, token or client secret.
 */

import { accepted, isNonEmptyString, isSha40, refused, type ValidationResult } from './validation.js';

export interface TrainRecord {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly baseBranch: string;
  readonly generation: number;
  readonly currentBaseSha: string;
}

/** Validate unknown input as a TrainRecord; a refused value never throws. */
export function validateTrainRecord(value: unknown): ValidationResult<TrainRecord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refused('train record must be a plain object');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    return refused('train record schemaVersion must be 1');
  }
  if (!isNonEmptyString(record.id)) {
    return refused('train record id must be a non-empty string');
  }
  if (!isNonEmptyString(record.repository)) {
    return refused('train record repository must be a non-empty string');
  }
  if (!isNonEmptyString(record.baseBranch)) {
    return refused('train record baseBranch must be a non-empty string');
  }
  if (typeof record.generation !== 'number' || !Number.isInteger(record.generation) || record.generation < 0) {
    return refused('train record generation must be a non-negative integer');
  }
  if (!isSha40(record.currentBaseSha)) {
    return refused('train record currentBaseSha must be 40 lower-case hex characters');
  }
  return accepted({
    id: record.id,
    schemaVersion: 1,
    repository: record.repository,
    baseBranch: record.baseBranch,
    generation: record.generation,
    currentBaseSha: record.currentBaseSha,
  });
}
