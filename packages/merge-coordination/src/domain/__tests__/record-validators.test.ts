import { describe, expect, it } from 'vitest';

import { validateBatchMemberRecord, validateBatchRecord } from '../entities/BatchRecord.js';
import { validateCandidateRecord } from '../entities/CandidateRecord.js';
import { validateGateReceiptRecord } from '../entities/GateReceiptRecord.js';
import { validatePromotionReceiptRecord } from '../entities/PromotionReceiptRecord.js';
import { validateQueueEntryRecord } from '../entities/QueueEntryRecord.js';
import { validateTrainRecord } from '../entities/TrainRecord.js';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

const VALID_TRAIN = {
  id: 'train-1',
  schemaVersion: 1,
  repository: 'org/repo',
  baseBranch: 'main',
  generation: 3,
  currentBaseSha: SHA,
};

const VALID_QUEUE_ENTRY = {
  id: 'entry-1',
  schemaVersion: 1,
  prNumber: 12,
  headSha: SHA,
  eligibility: { kind: 'eligible' },
};

const VALID_BATCH = {
  id: 'batch-1',
  schemaVersion: 1,
  members: [
    { prNumber: 12, headSha: SHA },
    { prNumber: 13, headSha: OTHER_SHA },
  ],
};

const VALID_CANDIDATE = {
  id: 'candidate-1',
  schemaVersion: 1,
  baseSha: SHA,
  resultSha: OTHER_SHA,
  parentCandidateId: null,
};

const VALID_GATE_RECEIPT = {
  id: 'gate-1',
  schemaVersion: 1,
  testedSha: SHA,
  gateProfile: 'default',
  result: 'passed',
};

const VALID_PROMOTION_RECEIPT = {
  id: 'promotion-1',
  schemaVersion: 1,
  previousSha: SHA,
  promotedSha: OTHER_SHA,
  memberPrNumbers: [12, 13],
};

/** Every validator, so shared refusal cases can run against all of them. */
const VALIDATORS = [
  ['train', validateTrainRecord, VALID_TRAIN],
  ['queue entry', validateQueueEntryRecord, VALID_QUEUE_ENTRY],
  ['batch', validateBatchRecord, VALID_BATCH],
  ['candidate', validateCandidateRecord, VALID_CANDIDATE],
  ['gate receipt', validateGateReceiptRecord, VALID_GATE_RECEIPT],
  ['promotion receipt', validatePromotionReceiptRecord, VALID_PROMOTION_RECEIPT],
] as const;

describe('shared refusals across every record validator', () => {
  it.each(VALIDATORS)('%s validator accepts its valid record', (_name, validate, valid) => {
    const result = validate(valid);
    expect(result.ok).toBe(true);
  });

  it.each(VALIDATORS)('%s validator refuses a non-object', (_name, validate) => {
    for (const input of [undefined, null, 42, 'x', []]) {
      const result = validate(input);
      expect(result.ok).toBe(false);
    }
  });

  it.each(VALIDATORS)('%s validator refuses a wrong schemaVersion', (_name, validate, valid) => {
    for (const version of [0, 2, '1', null]) {
      const result = validate({ ...valid, schemaVersion: version });
      expect(result.ok).toBe(false);
    }
  });

  it.each(VALIDATORS)('%s validator refuses an empty id', (_name, validate, valid) => {
    for (const id of ['', 7, null, undefined]) {
      const result = validate({ ...valid, id });
      expect(result.ok).toBe(false);
    }
  });

  it.each(VALIDATORS)('%s validator refuses a short SHA in every sha field', (_name, validate, valid) => {
    const short = 'abc123';
    const shaKeys = Object.keys(valid).filter((key) => key.toLowerCase().endsWith('sha'));
    for (const key of shaKeys) {
      const result = validate({ ...valid, [key]: short });
      expect(result.ok).toBe(false);
    }
    // The batch's sha lives on its members, not on the record itself.
    if (valid === VALID_BATCH) {
      expect(
        validateBatchRecord({
          ...valid,
          members: [{ prNumber: 12, headSha: short }],
        }).ok,
      ).toBe(false);
    }
  });
});

describe('SHA fields refuse anything but 40 lower-case hex characters', () => {
  const badShas = ['', 'ABCDEF', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), `${'a'.repeat(39)}g`, 123, null];

  it('train record currentBaseSha', () => {
    for (const sha of badShas) {
      expect(validateTrainRecord({ ...VALID_TRAIN, currentBaseSha: sha }).ok).toBe(false);
    }
    expect(validateTrainRecord({ ...VALID_TRAIN, currentBaseSha: OTHER_SHA }).ok).toBe(true);
  });

  it('queue entry headSha', () => {
    for (const sha of badShas) {
      expect(validateQueueEntryRecord({ ...VALID_QUEUE_ENTRY, headSha: sha }).ok).toBe(false);
    }
  });

  it('candidate baseSha and resultSha', () => {
    for (const sha of badShas) {
      expect(validateCandidateRecord({ ...VALID_CANDIDATE, baseSha: sha }).ok).toBe(false);
      expect(validateCandidateRecord({ ...VALID_CANDIDATE, resultSha: sha }).ok).toBe(false);
    }
  });

  it('gate receipt testedSha', () => {
    for (const sha of badShas) {
      expect(validateGateReceiptRecord({ ...VALID_GATE_RECEIPT, testedSha: sha }).ok).toBe(false);
    }
  });

  it('promotion receipt previousSha and promotedSha', () => {
    for (const sha of badShas) {
      expect(validatePromotionReceiptRecord({ ...VALID_PROMOTION_RECEIPT, previousSha: sha }).ok).toBe(false);
      expect(validatePromotionReceiptRecord({ ...VALID_PROMOTION_RECEIPT, promotedSha: sha }).ok).toBe(false);
    }
  });
});

describe('PR numbers are positive integers', () => {
  const badNumbers = [0, -1, 1.5, Number.NaN, '12', null, undefined];

  it('queue entry prNumber', () => {
    for (const pr of badNumbers) {
      expect(validateQueueEntryRecord({ ...VALID_QUEUE_ENTRY, prNumber: pr }).ok).toBe(false);
    }
    expect(validateQueueEntryRecord({ ...VALID_QUEUE_ENTRY, prNumber: 1 }).ok).toBe(true);
  });

  it('batch member prNumber', () => {
    for (const pr of badNumbers) {
      expect(validateBatchMemberRecord({ prNumber: pr, headSha: SHA }).ok).toBe(false);
    }
  });

  it('promotion receipt memberPrNumbers', () => {
    for (const pr of badNumbers) {
      expect(validatePromotionReceiptRecord({ ...VALID_PROMOTION_RECEIPT, memberPrNumbers: [pr] }).ok).toBe(false);
    }
  });
});

describe('queue entry eligibility', () => {
  it('accepts eligible without a reason', () => {
    const result = validateQueueEntryRecord(VALID_QUEUE_ENTRY);
    expect(result.ok).toBe(true);
  });

  it('accepts blocked with a non-empty reason', () => {
    const result = validateQueueEntryRecord({
      ...VALID_QUEUE_ENTRY,
      eligibility: { kind: 'blocked', reason: 'gate profile unavailable' },
    });
    expect(result.ok).toBe(true);
  });

  it('refuses blocked without a reason and unknown kinds', () => {
    expect(validateQueueEntryRecord({ ...VALID_QUEUE_ENTRY, eligibility: { kind: 'blocked' } }).ok).toBe(false);
    expect(validateQueueEntryRecord({ ...VALID_QUEUE_ENTRY, eligibility: { kind: 'blocked', reason: '' } }).ok).toBe(false);
    expect(validateQueueEntryRecord({ ...VALID_QUEUE_ENTRY, eligibility: { kind: 'unknown' } }).ok).toBe(false);
    expect(validateQueueEntryRecord({ ...VALID_QUEUE_ENTRY, eligibility: 'eligible' }).ok).toBe(false);
  });
});

describe('batch membership', () => {
  it('refuses an empty batch', () => {
    const result = validateBatchRecord({ ...VALID_BATCH, members: [] });
    expect(result.ok).toBe(false);
  });

  it('refuses a duplicate PR number, including an identical duplicate', () => {
    const result = validateBatchRecord({
      ...VALID_BATCH,
      members: [
        { prNumber: 12, headSha: SHA },
        { prNumber: 12, headSha: SHA },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a non-array members field', () => {
    expect(validateBatchRecord({ ...VALID_BATCH, members: 'nope' }).ok).toBe(false);
  });

  it('keeps the given member order', () => {
    const result = validateBatchRecord(VALID_BATCH);
    expect(result.ok && result.value.members.map((m) => m.prNumber)).toEqual([12, 13]);
  });
});

describe('candidate parent lineage', () => {
  it('accepts a null parent and a non-empty parent id', () => {
    expect(validateCandidateRecord(VALID_CANDIDATE).ok).toBe(true);
    expect(validateCandidateRecord({ ...VALID_CANDIDATE, parentCandidateId: 'candidate-0' }).ok).toBe(true);
  });

  it('refuses an empty string or non-string parent', () => {
    expect(validateCandidateRecord({ ...VALID_CANDIDATE, parentCandidateId: '' }).ok).toBe(false);
    expect(validateCandidateRecord({ ...VALID_CANDIDATE, parentCandidateId: 7 }).ok).toBe(false);
  });
});

describe('gate receipt result', () => {
  it('accepts each of the three outcomes', () => {
    for (const result of ['passed', 'failed', 'infrastructure-failure']) {
      expect(validateGateReceiptRecord({ ...VALID_GATE_RECEIPT, result }).ok).toBe(true);
    }
  });

  it('refuses any other outcome', () => {
    expect(validateGateReceiptRecord({ ...VALID_GATE_RECEIPT, result: 'skipped' }).ok).toBe(false);
    expect(validateGateReceiptRecord({ ...VALID_GATE_RECEIPT, result: 'PASSED' }).ok).toBe(false);
  });

  it('refuses an empty gate profile', () => {
    expect(validateGateReceiptRecord({ ...VALID_GATE_RECEIPT, gateProfile: '' }).ok).toBe(false);
  });
});

describe('promotion receipt members', () => {
  it('refuses an empty member list', () => {
    expect(validatePromotionReceiptRecord({ ...VALID_PROMOTION_RECEIPT, memberPrNumbers: [] }).ok).toBe(false);
  });

  it('refuses a duplicate member PR number', () => {
    expect(validatePromotionReceiptRecord({ ...VALID_PROMOTION_RECEIPT, memberPrNumbers: [12, 12] }).ok).toBe(false);
  });

  it('refuses a non-array member list', () => {
    expect(validatePromotionReceiptRecord({ ...VALID_PROMOTION_RECEIPT, memberPrNumbers: 12 }).ok).toBe(false);
  });
});

describe('train record specific fields', () => {
  it('refuses an empty repository or base branch', () => {
    expect(validateTrainRecord({ ...VALID_TRAIN, repository: '' }).ok).toBe(false);
    expect(validateTrainRecord({ ...VALID_TRAIN, baseBranch: '' }).ok).toBe(false);
  });

  it('refuses a negative or fractional generation', () => {
    expect(validateTrainRecord({ ...VALID_TRAIN, generation: -1 }).ok).toBe(false);
    expect(validateTrainRecord({ ...VALID_TRAIN, generation: 1.5 }).ok).toBe(false);
  });
});
