// @generated entity stub — refined for the merge train station.
/**
 * BatchRecord is one ordered set of pull requests the train will land
 * together. Order is the record's meaning, so members are a readonly list
 * kept exactly as given; a batch always has at least one member and never
 * repeats a pull request.
 */

import { accepted, isNonEmptyString, isPositiveInteger, isSha40, refused, type ValidationResult } from './validation.js';

/** One member of a batch: the pull request and the exact head it was batched at. */
export interface BatchMemberRecord {
  readonly prNumber: number;
  readonly headSha: string;
}

export interface BatchRecord {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly members: readonly BatchMemberRecord[];
}

/** Validate unknown input as one batch member; a refused value never throws. */
export function validateBatchMemberRecord(value: unknown): ValidationResult<BatchMemberRecord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refused('batch member must be a plain object');
  }
  const member = value as Record<string, unknown>;
  if (!isPositiveInteger(member.prNumber)) {
    return refused('batch member prNumber must be a positive integer');
  }
  if (!isSha40(member.headSha)) {
    return refused('batch member headSha must be 40 lower-case hex characters');
  }
  return accepted({ prNumber: member.prNumber, headSha: member.headSha });
}

/** Validate unknown input as a BatchRecord; a refused value never throws. */
export function validateBatchRecord(value: unknown): ValidationResult<BatchRecord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refused('batch record must be a plain object');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    return refused('batch record schemaVersion must be 1');
  }
  if (!isNonEmptyString(record.id)) {
    return refused('batch record id must be a non-empty string');
  }
  if (!Array.isArray(record.members)) {
    return refused('batch record members must be an array');
  }
  if (record.members.length < 1) {
    return refused('a batch must have at least one member');
  }
  const members: BatchMemberRecord[] = [];
  const seenPrNumbers = new Set<number>();
  for (const raw of record.members) {
    const member = validateBatchMemberRecord(raw);
    if (!member.ok) {
      return member;
    }
    if (seenPrNumbers.has(member.value.prNumber)) {
      return refused(`batch record lists pull request ${member.value.prNumber} more than once`);
    }
    seenPrNumbers.add(member.value.prNumber);
    members.push(member.value);
  }
  return accepted({ id: record.id, schemaVersion: 1, members });
}
