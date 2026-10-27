import { describe, expect, it } from 'vitest';

import { EvidenceAssessment } from '../entities/EvidenceAssessment.js';
import type { EvidenceAssessmentProps } from '../entities/EvidenceAssessment.js';
import type {
  VerificationReceiptRecord,
  ReviewReceiptRecord,
  FindingDispositionRecord,
} from '../evidence-records.js';

const HEAD = '1111111111111111111111111111111111111111';
const OTHER_HEAD = '2222222222222222222222222222222222222222';

function sampleProps(overrides: Partial<EvidenceAssessmentProps> = {}): EvidenceAssessmentProps {
  return {
    id: 'asm-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: HEAD,
    policyRevision: 'pol-1',
    implementerModel: 'provider-b/model-implementer',
    requiredChecks: ['lint', 'test'],
    state: 'pending',
    verificationReceipts: [],
    reviewReceipts: [],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 0,
    updatedAtIso: '2026-10-15T12:00:00.000Z',
    ...overrides,
  };
}

describe('EvidenceAssessment entity', () => {
  describe('accept() terminal-state guard', () => {
    it('accepts successfully when assessment is pending or blocked', () => {
      const pendingAssessment = EvidenceAssessment.create(sampleProps({ state: 'pending' })).value!;
      pendingAssessment.accept('acc-1', '2026-10-15T12:01:00.000Z');
      expect(pendingAssessment.getState()).toBe('accepted');
      expect(pendingAssessment.getAcceptanceReceiptId()).toBe('acc-1');

      const blockedAssessment = EvidenceAssessment.create(sampleProps({ state: 'blocked' })).value!;
      blockedAssessment.accept('acc-2', '2026-10-15T12:02:00.000Z');
      expect(blockedAssessment.getState()).toBe('accepted');
      expect(blockedAssessment.getAcceptanceReceiptId()).toBe('acc-2');
    });

    it('refuses when assessment is stale and never accepts it again', () => {
      const assessment = EvidenceAssessment.create(sampleProps({ state: 'stale' })).value!;
      expect(assessment.isTerminal()).toBe(true);
      expect(() => assessment.accept('acc-stale', '2026-10-15T12:01:00.000Z')).toThrow(
        "Cannot accept an assessment in terminal state 'stale'",
      );
      expect(assessment.getState()).toBe('stale');
    });

    it('refuses when assessment is already accepted', () => {
      const assessment = EvidenceAssessment.create(
        sampleProps({ state: 'accepted', acceptanceReceiptId: 'acc-prior' }),
      ).value!;
      expect(assessment.isTerminal()).toBe(true);
      expect(() => assessment.accept('acc-new', '2026-10-15T12:01:00.000Z')).toThrow(
        "Cannot accept an assessment in terminal state 'accepted'",
      );
    });

    it('refuses when assessment is rejected', () => {
      const assessment = EvidenceAssessment.create(sampleProps({ state: 'rejected' })).value!;
      expect(assessment.isTerminal()).toBe(true);
      expect(() => assessment.accept('acc-rejected', '2026-10-15T12:01:00.000Z')).toThrow(
        "Cannot accept an assessment in terminal state 'rejected'",
      );
    });

    it('removes acceptance receipt when transitioning to stale, blocked or rejected', () => {
      const staleAssessment = EvidenceAssessment.create(
        sampleProps({ state: 'pending', acceptanceReceiptId: 'acc-1' }),
      ).value!;
      staleAssessment.markStale('2026-10-15T12:01:00.000Z');
      expect(staleAssessment.getAcceptanceReceiptId()).toBeNull();
      expect(staleAssessment.getState()).toBe('stale');

      const blockedAssessment = EvidenceAssessment.create(
        sampleProps({ state: 'pending', acceptanceReceiptId: 'acc-2' }),
      ).value!;
      blockedAssessment.block(['some blocker'], '2026-10-15T12:02:00.000Z');
      expect(blockedAssessment.getAcceptanceReceiptId()).toBeNull();
      expect(blockedAssessment.getState()).toBe('blocked');

      const rejectedAssessment = EvidenceAssessment.create(
        sampleProps({ state: 'pending', acceptanceReceiptId: 'acc-3' }),
      ).value!;
      rejectedAssessment.reject('2026-10-15T12:03:00.000Z');
      expect(rejectedAssessment.getAcceptanceReceiptId()).toBeNull();
      expect(rejectedAssessment.getState()).toBe('rejected');
    });
  });

  describe('pendingRequiredChecks() head filtering', () => {
    it('filters receipts by assessment candidate head; receipts for a different head do not satisfy checks', () => {
      const receiptForOtherHead: VerificationReceiptRecord = {
        id: 'vr-1',
        assessmentId: 'asm-1',
        projectId: 'proj-1',
        attemptId: 'att-1',
        candidateHeadSha: OTHER_HEAD,
        hostId: 'host-1',
        procedureName: 'lint',
        result: 'pass',
        exitCode: 0,
        evidenceRef: 'ref-1',
        policyRevision: 'pol-1',
        completedAtIso: '2026-10-15T12:00:00.000Z',
      };
      const receiptForThisHead: VerificationReceiptRecord = {
        id: 'vr-2',
        assessmentId: 'asm-1',
        projectId: 'proj-1',
        attemptId: 'att-1',
        candidateHeadSha: HEAD,
        hostId: 'host-1',
        procedureName: 'test',
        result: 'pass',
        exitCode: 0,
        evidenceRef: 'ref-2',
        policyRevision: 'pol-1',
        completedAtIso: '2026-10-15T12:00:00.000Z',
      };

      const assessment = EvidenceAssessment.create(
        sampleProps({
          requiredChecks: ['lint', 'test'],
          verificationReceipts: [receiptForOtherHead, receiptForThisHead],
        }),
      ).value!;

      // 'lint' only has a receipt for OTHER_HEAD, so it must still be pending for HEAD!
      // 'test' has a receipt for HEAD, so it is satisfied.
      expect(assessment.pendingRequiredChecks()).toEqual(['lint']);
    });
  });

  describe('stored placeholder evidence (D1)', () => {
    it('still loads receipts and dispositions whose placeholder text predates A2', () => {
      const receipt: ReviewReceiptRecord = {
        id: 'rr-1',
        assessmentId: 'asm-1',
        projectId: 'proj-1',
        attemptId: 'att-1',
        candidateHeadSha: HEAD,
        reviewerModel: 'provider-a/other-reviewer',
        implementerModel: 'provider-b/model-implementer',
        readOnlyVerified: true,
        result: 'fail',
        evidenceRef: 'n/a',
        policyRevision: 'pol-1',
        completedAtIso: '2026-10-15T12:00:00.000Z',
        findings: [
          {
            findingId: 'f-1',
            severity: 'major',
            summary: 'n/a',
            filePath: null,
            line: null,
            state: 'fixed',
            dispositionReason: 'tbd',
            dispositionEvidenceRef: 'n/a',
          },
        ],
      };
      const disposition: FindingDispositionRecord = {
        id: 'fd-1',
        assessmentId: 'asm-1',
        findingId: 'f-1',
        candidateHeadSha: HEAD,
        state: 'fixed',
        reason: 'tbd',
        evidenceRef: 'n/a',
        recordedBy: 'checker-1',
        recordedAtIso: '2026-10-15T12:00:00.000Z',
      };
      const props = sampleProps({
        requiredChecks: [],
        reviewReceipts: [receipt],
        findingDispositions: [disposition],
      });
      expect(() => EvidenceAssessment.fromRecord(props)).not.toThrow();
      expect(EvidenceAssessment.create(props).success).toBe(true);
    });
  });
});
