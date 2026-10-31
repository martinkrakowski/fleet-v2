// Tests for the receipt-scoped finding id edges of scopeFindingIdsToReceipt
// (RecordReviewReceiptUseCase.use-case.ts). Tier 1 lane CL-13: tests only.
import { describe, expect, it } from 'vitest';

import { scopeFindingIdsToReceipt } from '../RecordReviewReceiptUseCase.use-case.js';

// Same base finding shape as the blank-id test in
// RecordReviewReceiptUseCase.test.ts, copied (not imported) per the brief.
const base = {
  severity: 'major',
  summary: 's',
  filePath: null,
  line: null,
  state: 'unresolved',
  dispositionReason: null,
  dispositionEvidenceRef: null,
} as const;

describe('scopeFindingIdsToReceipt', () => {
  it('is idempotent: an already scoped id is never re-scoped with the same receipt id', () => {
    const scoped = scopeFindingIdsToReceipt('rr-1', [
      { ...base, findingId: 'rr-1:review-1' },
    ]);
    expect(scoped.map((f) => f.findingId)).toEqual(['rr-1:review-1']);
    expect(scoped.map((f) => f.findingId)).not.toEqual(['rr-1:rr-1:review-1']);
  });

  it('scopes on the exact `<receiptId>:` prefix, not a loose string prefix', () => {
    const scoped = scopeFindingIdsToReceipt('rr-1', [
      { ...base, findingId: 'rr-10:review-1' },
      { ...base, findingId: 'rr-1review' },
    ]);
    expect(scoped.map((f) => f.findingId)).toEqual(['rr-1:rr-10:review-1', 'rr-1:rr-1review']);
  });

  it('scopes an id held by another receipt again for the current receipt', () => {
    const scoped = scopeFindingIdsToReceipt('rr-2', [
      { ...base, findingId: 'rr-1:review-1' },
    ]);
    expect(scoped.map((f) => f.findingId)).toEqual(['rr-2:rr-1:review-1']);
  });

  it('makes transport ids from two receipts distinct', () => {
    const first = scopeFindingIdsToReceipt('rr-1', [
      { ...base, findingId: 'review-1' },
      { ...base, findingId: 'review-2' },
    ]);
    const second = scopeFindingIdsToReceipt('rr-2', [
      { ...base, findingId: 'review-1' },
      { ...base, findingId: 'review-2' },
    ]);
    const ids = [...first, ...second].map((f) => f.findingId);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toEqual(['rr-1:review-1', 'rr-1:review-2', 'rr-2:review-1', 'rr-2:review-2']);
  });

  it('does not mutate the input array or its findings and returns new objects', () => {
    const input = [
      { ...base, findingId: 'review-1' },
      { ...base, findingId: 'rr-1:review-1' },
    ];
    const snapshot = structuredClone(input);
    const scoped = scopeFindingIdsToReceipt('rr-1', input);
    expect(input).toEqual(snapshot);
    for (const [i, finding] of scoped.entries()) {
      expect(finding).not.toBe(input[i]);
      expect({ ...finding, findingId: input[i].findingId }).toEqual(input[i]);
    }
    expect(scoped.map((f) => f.findingId)).toEqual(['rr-1:review-1', 'rr-1:review-1']);
  });

  it('returns an empty list for an empty list', () => {
    expect(scopeFindingIdsToReceipt('rr-1', [])).toEqual([]);
  });
});
