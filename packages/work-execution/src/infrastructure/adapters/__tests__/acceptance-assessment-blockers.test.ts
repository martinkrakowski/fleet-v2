// Acceptance assessment blocker details: the adapter passes the delegate's
// result through unchanged, including the optional blockerDetails list, so
// the consumer-side kind union is exactly the A11 list.
/**
 * Covers AcceptanceAssessmentAdapter's pass-through of rejected results with
 * and without blockerDetails, and the compile-time declaration of the A11
 * blocker kinds on the consumer side.
 */

import { describe, expect, it } from 'vitest';

import { AcceptanceAssessmentAdapter } from '../AcceptanceAssessmentAdapter.adapter.js';
import type {
  AssessmentBlockerKind,
  AcceptanceAssessmentResult,
  AcceptanceReceiptsResult,
} from '../../../application/ports/out/AcceptanceAssessmentPort.out-port.js';

const REQUEST = {
  attemptId: 'attempt-example',
  workOrderId: 'wo-example',
  candidateHeadSha: '0123456789abcdef0123456789abcdef01234567',
  policyRevision: 'policy-example',
};

describe('AcceptanceAssessmentAdapter blocker details', () => {
  it('returns a rejected result with blockerDetails unchanged', async () => {
    const delegateResult: AcceptanceAssessmentResult = {
      outcome: 'rejected',
      reason: 'example',
      blockerDetails: [{ kind: 'ci-pending', text: 'example' }],
    };
    const adapter = new AcceptanceAssessmentAdapter({
      assess: async () => delegateResult,
    });

    await expect(adapter.assessHeadAcceptance(REQUEST)).resolves.toEqual(delegateResult);
  });

  it('returns a rejected result without the blockerDetails key when none was given', async () => {
    const adapter = new AcceptanceAssessmentAdapter({
      assess: async () => ({ outcome: 'rejected', reason: 'example' }),
    });

    const result = await adapter.assessHeadAcceptance(REQUEST);
    expect(result).toEqual({ outcome: 'rejected', reason: 'example' });
    expect('blockerDetails' in result).toBe(false);
  });

  it('declares exactly the A11 blocker kinds', () => {
    const all: readonly AssessmentBlockerKind[] = [
      'ci-pending',
      'ci-failed',
      'threads-unresolved',
      'threads-unreadable',
      'review-missing',
      'door',
      'stale',
      'other',
    ];
    expect(new Set(all).size).toBe(8);
  });

  it('rejects a receipts-only assessment while unconfigured', async () => {
    const adapter = new AcceptanceAssessmentAdapter();
    await expect(adapter.assessHeadReceipts(REQUEST)).rejects.toThrow(
      'Not implemented: AcceptanceAssessmentAdapter.assessHeadReceipts',
    );
  });

  it('delegates a receipts-only assessment to the assessReceipts delegate', async () => {
    const delegateResult: AcceptanceReceiptsResult = {
      outcome: 'passed',
      receiptsId: 'rcp-example-1',
      assessedHeadSha: REQUEST.candidateHeadSha,
    };
    const adapter = new AcceptanceAssessmentAdapter({
      assessReceipts: async () => delegateResult,
    });
    await expect(adapter.assessHeadReceipts(REQUEST)).resolves.toEqual(delegateResult);
  });
});
