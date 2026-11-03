// @generated entity stub — refined for the merge train station.
/**
 * QueueEntryRecord is one pull request's place in the merge queue with its
 * current eligibility. Eligibility is decided elsewhere; this record only
 * carries it, and a blocked entry always names its reason.
 */

import { accepted, isNonEmptyString, isPositiveInteger, isSha40, refused, type ValidationResult } from './validation.js';

/** A queue entry is either eligible, or blocked with a stated reason. */
export type QueueEntryEligibility =
  | { readonly kind: 'eligible' }
  | { readonly kind: 'blocked'; readonly reason: string };

export interface QueueEntryRecord {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly prNumber: number;
  readonly headSha: string;
  readonly eligibility: QueueEntryEligibility;
}

/** Validate unknown input as a queue-entry eligibility; a refused value never throws. */
export function validateQueueEntryEligibility(value: unknown): ValidationResult<QueueEntryEligibility> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refused('queue entry eligibility must be a plain object');
  }
  const eligibility = value as Record<string, unknown>;
  if (eligibility.kind === 'eligible') {
    return accepted({ kind: 'eligible' });
  }
  if (eligibility.kind === 'blocked') {
    if (!isNonEmptyString(eligibility.reason)) {
      return refused('a blocked queue entry must carry a non-empty reason');
    }
    return accepted({ kind: 'blocked', reason: eligibility.reason });
  }
  return refused('queue entry eligibility kind must be "eligible" or "blocked"');
}

/** Validate unknown input as a QueueEntryRecord; a refused value never throws. */
export function validateQueueEntryRecord(value: unknown): ValidationResult<QueueEntryRecord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refused('queue entry record must be a plain object');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    return refused('queue entry record schemaVersion must be 1');
  }
  if (!isNonEmptyString(record.id)) {
    return refused('queue entry record id must be a non-empty string');
  }
  if (!isPositiveInteger(record.prNumber)) {
    return refused('queue entry record prNumber must be a positive integer');
  }
  if (!isSha40(record.headSha)) {
    return refused('queue entry record headSha must be 40 lower-case hex characters');
  }
  const eligibility = validateQueueEntryEligibility(record.eligibility);
  if (!eligibility.ok) {
    return eligibility;
  }
  return accepted({
    id: record.id,
    schemaVersion: 1,
    prNumber: record.prNumber,
    headSha: record.headSha,
    eligibility: eligibility.value,
  });
}
