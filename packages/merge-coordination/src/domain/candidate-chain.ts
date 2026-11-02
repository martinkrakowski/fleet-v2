/**
 * The pure candidate chain and invalidation logic. It is total: hostile input
 * yields a refused result (or `false` or `null`), never a throw.
 */

import { validateCandidateRecord } from './entities/CandidateRecord.js';
import type { CandidateRecord } from './entities/CandidateRecord.js';
import type { GateReceiptRecord } from './entities/GateReceiptRecord.js';
import { accepted, isSha40, refused, type ValidationResult } from './entities/validation.js';

/** A candidate chain: index 0 is the head, closest to the base. */
export type CandidateChain = readonly CandidateRecord[];

/**
 * Validate unknown input as a candidate chain. Refuses, with a reason and
 * without throwing, when the base sha is malformed, the value is not a
 * non-empty array, any entry is not a valid candidate record, any id is
 * duplicated, or the lineage links do not line up.
 */
export function validateCandidateChain(value: unknown, expectedBaseSha: string): ValidationResult<CandidateChain> {
  if (!isSha40(expectedBaseSha)) {
    return refused('expected base sha must be a 40-character lower-case hex string');
  }
  if (!Array.isArray(value) || value.length === 0) {
    return refused('candidate chain must be a non-empty array');
  }
  const records: CandidateRecord[] = [];
  for (const entry of value) {
    const result = validateCandidateRecord(entry);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    records.push(result.value);
  }
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) {
      return refused(`duplicate candidate id in chain: ${record.id}`);
    }
    seen.add(record.id);
  }
  const head = records[0];
  if (head === undefined) {
    return refused('candidate chain must be a non-empty array');
  }
  if (head.parentCandidateId !== null) {
    return refused(`head candidate ${head.id} must have a null parentCandidateId`);
  }
  if (head.baseSha !== expectedBaseSha) {
    return refused(`head candidate ${head.id} baseSha must equal the expected base sha`);
  }
  for (let i = 1; i < records.length; i++) {
    const previous = records[i - 1];
    const record = records[i];
    if (previous === undefined || record === undefined) {
      return refused('candidate chain must be a non-empty array');
    }
    if (record.parentCandidateId !== previous.id) {
      return refused(`candidate ${record.id} parentCandidateId must match the previous candidate id`);
    }
    if (record.baseSha !== previous.resultSha) {
      return refused(`candidate ${record.id} baseSha must equal the previous candidate resultSha`);
    }
  }
  return accepted(records);
}

/**
 * Append a candidate to the end of a chain and validate the result. The base
 * sha is taken from the chain head, or from the next candidate when the chain
 * is empty. Never mutates its inputs. Refuses, without throwing, when the
 * chain is not an array.
 */
export function appendCandidate(chain: CandidateChain, next: unknown): ValidationResult<CandidateChain> {
  if (!Array.isArray(chain)) {
    return refused('candidate chain must be an array');
  }
  const extended: unknown[] = [...chain, next];
  let expectedBaseSha = '';
  const head = chain[0];
  if (typeof head === 'object' && head !== null && 'baseSha' in head && typeof head.baseSha === 'string') {
    expectedBaseSha = head.baseSha;
  } else if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
    const baseSha = (next as Record<string, unknown>).baseSha;
    if (typeof baseSha === 'string') {
      expectedBaseSha = baseSha;
    }
  }
  return validateCandidateChain(extended, expectedBaseSha);
}

/** The split of a chain produced by invalidating from one candidate down. */
export interface ChainInvalidation {
  readonly kept: CandidateChain;
  readonly voided: CandidateChain;
}

/**
 * Void the named candidate and every descendant. The named candidate and all
 * that follow it are voided; everything before it is kept. Refuses, without
 * throwing, when the chain is not an array or the id is not found.
 */
export function invalidateFrom(chain: CandidateChain, candidateId: string): ValidationResult<ChainInvalidation> {
  if (!Array.isArray(chain)) {
    return refused('candidate chain must be an array');
  }
  let index = -1;
  for (let i = 0; i < chain.length; i++) {
    const record = chain[i];
    if (record !== undefined && record !== null && typeof record === 'object' && 'id' in record && record.id === candidateId) {
      index = i;
      break;
    }
  }
  if (index === -1) {
    return refused(`candidate id not found in chain: ${candidateId}`);
  }
  return accepted({ kept: chain.slice(0, index), voided: chain.slice(index) });
}

/** How a chain stands relative to an observed base commit. */
export type ChainBaseAssessment =
  | { readonly action: 'intact' }
  | { readonly action: 'advance'; readonly landed: CandidateRecord; readonly remaining: CandidateChain }
  | { readonly action: 'rebuild'; readonly voided: CandidateChain; readonly rebuildFromSha: string };

/**
 * Assess a chain against the observed base sha. Refuses when the chain is not
 * a non-empty array or the observed base sha is malformed. When the observed
 * base is the head's base the chain is intact; when it is the head's result
 * the head has landed and the rest of the chain still holds; otherwise the
 * whole chain must be rebuilt from the observed base.
 */
export function assessChainAgainstBase(chain: CandidateChain, observedBaseSha: string): ValidationResult<ChainBaseAssessment> {
  if (!Array.isArray(chain) || chain.length === 0) {
    return refused('candidate chain must be a non-empty array');
  }
  if (!isSha40(observedBaseSha)) {
    return refused('observed base sha must be a 40-character lower-case hex string');
  }
  const head = chain[0];
  if (head === undefined || head === null || typeof head !== 'object') {
    return refused('candidate chain must be a non-empty array');
  }
  if (observedBaseSha === head.baseSha) {
    return accepted({ action: 'intact' });
  }
  if (observedBaseSha === head.resultSha) {
    return accepted({ action: 'advance', landed: head, remaining: chain.slice(1) });
  }
  return accepted({ action: 'rebuild', voided: [...chain], rebuildFromSha: observedBaseSha });
}

/** Whether a gate receipt proves that a candidate passed its gate. */
export function receiptProvesCandidate(candidate: CandidateRecord, receipt: GateReceiptRecord, gateProfile: string): boolean {
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    receipt === null ||
    typeof receipt !== 'object'
  ) {
    return false;
  }
  return (
    receipt.result === 'passed' &&
    receipt.testedSha === candidate.resultSha &&
    receipt.gateProfile === gateProfile
  );
}

/**
 * The promotable candidate of a chain, if any. Only the head may be promoted,
 * and only when its base matches the observed base and a receipt proves it.
 * A green descendant is never promotable ahead of its parent.
 */
export function selectPromotable(
  chain: CandidateChain,
  receipts: readonly GateReceiptRecord[],
  observedBaseSha: string,
  gateProfile: string,
): CandidateRecord | null {
  if (!Array.isArray(chain) || chain.length === 0 || !Array.isArray(receipts)) {
    return null;
  }
  const head = chain[0];
  if (head === undefined || head === null || typeof head !== 'object' || head.baseSha !== observedBaseSha) {
    return null;
  }
  const proven = receipts.some((receipt) => receiptProvesCandidate(head, receipt, gateProfile));
  return proven ? head : null;
}

/** Whether promoting a sha preserves the candidate's identity. */
export function promotionPreservesIdentity(candidate: CandidateRecord, promotedSha: string): boolean {
  if (candidate === null || typeof candidate !== 'object') {
    return false;
  }
  return promotedSha === candidate.resultSha;
}
