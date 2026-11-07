// @generated entity stub — refined for the merge train station.
/**
 * PromotionReceiptRecord is the durable proof that the train moved one base
 * forward: the sha before, the sha after and the pull requests the promoted
 * batch carried. The receipt never authorizes anything by itself.
 */

import { accepted, isNonEmptyString, isPositiveInteger, isSha40, refused, type ValidationResult } from './validation.js';

export interface PromotionReceiptRecord {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly previousSha: string;
  readonly promotedSha: string;
  readonly memberPrNumbers: readonly number[];
}

/** Validate unknown input as a PromotionReceiptRecord; a refused value never throws. */
export function validatePromotionReceiptRecord(value: unknown): ValidationResult<PromotionReceiptRecord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refused('promotion receipt record must be a plain object');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    return refused('promotion receipt record schemaVersion must be 1');
  }
  if (!isNonEmptyString(record.id)) {
    return refused('promotion receipt record id must be a non-empty string');
  }
  if (!isSha40(record.previousSha)) {
    return refused('promotion receipt record previousSha must be 40 lower-case hex characters');
  }
  if (!isSha40(record.promotedSha)) {
    return refused('promotion receipt record promotedSha must be 40 lower-case hex characters');
  }
  if (!Array.isArray(record.memberPrNumbers)) {
    return refused('promotion receipt record memberPrNumbers must be an array');
  }
  if (record.memberPrNumbers.length < 1) {
    return refused('a promotion receipt must name at least one member pull request');
  }
  const memberPrNumbers: number[] = [];
  const seen = new Set<number>();
  for (const raw of record.memberPrNumbers) {
    if (!isPositiveInteger(raw)) {
      return refused('promotion receipt member PR numbers must be positive integers');
    }
    if (seen.has(raw)) {
      return refused(`promotion receipt lists pull request ${raw} more than once`);
    }
    seen.add(raw);
    memberPrNumbers.push(raw);
  }
  return accepted({
    id: record.id,
    schemaVersion: 1,
    previousSha: record.previousSha,
    promotedSha: record.promotedSha,
    memberPrNumbers,
  });
}
