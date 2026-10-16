// Step 6 — domain unit tests for evidence-and-acceptance.
// Covers the manifest invariants: terminal/pending states, passing evidence,
// blocking findings, exact-head binding and the underlying-model-family rule.

import { describe, expect, it } from 'vitest';
import type { ReviewFindingRecord } from '../evidence-records.js';
import { EvidenceAssessment } from '../entities/EvidenceAssessment.js';
import type { EvidenceAssessmentProps } from '../entities/EvidenceAssessment.js';
import { FindingDisposition } from '../entities/FindingDisposition.js';
import { ReviewReceipt, underlyingModelFamily } from '../entities/ReviewReceipt.js';
import type { ReviewReceiptProps } from '../entities/ReviewReceipt.js';
import { VerificationReceipt } from '../entities/VerificationReceipt.js';
import type { VerificationReceiptProps } from '../entities/VerificationReceipt.js';
import { AcceptanceReceipt } from '../value-objects/AcceptanceReceipt.vo.js';
import { AssessmentState } from '../value-objects/AssessmentState.vo.js';
import { EvidenceResult } from '../value-objects/EvidenceResult.vo.js';
import { EvidenceScope } from '../value-objects/EvidenceScope.vo.js';
import { FindingState } from '../value-objects/FindingState.vo.js';

function requireValue<T>(result: { success: boolean; value?: T; error?: Error }): T {
  if (!result.success || result.value === undefined) {
    throw new Error(result.error?.message ?? 'expected a successful create');
  }
  return result.value;
}

function requireFailure(result: { success: boolean; error?: Error }): Error {
  if (result.success || result.error === undefined) {
    throw new Error('expected a failed create');
  }
  return result.error;
}

function verificationReceiptProps(
  overrides: Partial<VerificationReceiptProps> = {},
): VerificationReceiptProps {
  return {
    id: 'vr-1',
    assessmentId: 'ea-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: 'sha-1',
    hostId: 'host-1',
    procedureName: 'unit-tests',
    result: 'pass',
    exitCode: 0,
    evidenceRef: 'evidence://vr-1',
    policyRevision: 'policy-7',
    completedAtIso: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

function finding(findingId: string, overrides: Partial<ReviewFindingRecord> = {}): ReviewFindingRecord {
  return {
    findingId,
    severity: 'major',
    summary: `summary for ${findingId}`,
    filePath: 'src/a.ts',
    line: 12,
    state: 'unresolved',
    dispositionReason: null,
    dispositionEvidenceRef: null,
    ...overrides,
  };
}

function reviewReceiptProps(overrides: Partial<ReviewReceiptProps> = {}): ReviewReceiptProps {
  return {
    id: 'rr-1',
    assessmentId: 'ea-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: 'sha-1',
    reviewerModel: 'openrouter/poolside/laguna-s-2.1',
    implementerModel: 'openrouter/z-ai/glm-5.3-flash',
    readOnlyVerified: true,
    result: 'fail',
    findings: [finding('f-1'), finding('f-2')],
    evidenceRef: 'evidence://rr-1',
    policyRevision: 'policy-7',
    completedAtIso: '2026-10-15T00:01:00.000Z',
    ...overrides,
  };
}

function assessmentProps(overrides: Partial<EvidenceAssessmentProps> = {}): EvidenceAssessmentProps {
  return {
    id: 'ea-1',
    projectId: 'proj-1',
    attemptId: 'att-1',
    candidateHeadSha: 'sha-1',
    policyRevision: 'policy-7',
    implementerModel: 'provider-b/model-implementer',
    requiredChecks: ['ci', 'unit-tests'],
    state: 'pending',
    verificationReceipts: [],
    reviewReceipts: [],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 0,
    updatedAtIso: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('AssessmentState', () => {
  it('accepts every manifest enum value', () => {
    for (const value of ['pending', 'blocked', 'accepted', 'rejected', 'stale'] as const) {
      expect(requireValue(AssessmentState.create(value)).getValue()).toBe(value);
    }
  });

  it('rejects unknown states', () => {
    expect(requireFailure(AssessmentState.create('running')).message).toContain('Invalid assessment state');
    expect(requireFailure(AssessmentState.create(42)).message).toContain('Invalid assessment state');
  });

  it('treats only accepted, rejected and stale as terminal', () => {
    expect(requireValue(AssessmentState.create('accepted')).isTerminal()).toBe(true);
    expect(requireValue(AssessmentState.create('rejected')).isTerminal()).toBe(true);
    expect(requireValue(AssessmentState.create('stale')).isTerminal()).toBe(true);
    expect(requireValue(AssessmentState.create('pending')).isTerminal()).toBe(false);
    expect(requireValue(AssessmentState.create('blocked')).isTerminal()).toBe(false);
  });

  it('compares by value', () => {
    const pending = requireValue(AssessmentState.create('pending'));
    expect(pending.equals(requireValue(AssessmentState.create('pending')))).toBe(true);
    expect(pending.equals(requireValue(AssessmentState.create('blocked')))).toBe(false);
  });
});

describe('EvidenceResult', () => {
  it('accepts every manifest enum value', () => {
    for (const value of ['pending', 'pass', 'fail', 'unknown', 'not-applicable'] as const) {
      expect(requireValue(EvidenceResult.create(value)).getValue()).toBe(value);
    }
  });

  it('rejects unknown results', () => {
    expect(requireFailure(EvidenceResult.create('success')).message).toContain('Invalid evidence result');
  });

  it('counts only pass and not-applicable as passing', () => {
    expect(requireValue(EvidenceResult.create('pass')).isPassing()).toBe(true);
    expect(requireValue(EvidenceResult.create('not-applicable')).isPassing()).toBe(true);
    expect(requireValue(EvidenceResult.create('pending')).isPassing()).toBe(false);
    expect(requireValue(EvidenceResult.create('fail')).isPassing()).toBe(false);
    expect(requireValue(EvidenceResult.create('unknown')).isPassing()).toBe(false);
  });
});

describe('FindingState', () => {
  it('accepts every manifest enum value', () => {
    for (const value of ['unresolved', 'fixed', 'refuted'] as const) {
      expect(requireValue(FindingState.create(value)).getValue()).toBe(value);
    }
  });

  it('rejects unknown states', () => {
    expect(requireFailure(FindingState.create('wontfix')).message).toContain('Invalid finding state');
  });

  it('treats only unresolved findings as blocking', () => {
    expect(requireValue(FindingState.create('unresolved')).isBlocking()).toBe(true);
    expect(requireValue(FindingState.create('fixed')).isBlocking()).toBe(false);
    expect(requireValue(FindingState.create('refuted')).isBlocking()).toBe(false);
  });
});

describe('EvidenceScope', () => {
  it('binds evidence to project, attempt, head and policy revision', () => {
    const scope = requireValue(
      EvidenceScope.create({
        projectId: 'proj-1',
        attemptId: 'att-1',
        candidateHeadSha: 'sha-1',
        policyRevision: 'policy-7',
      }),
    );
    expect(scope.getProjectId()).toBe('proj-1');
    expect(scope.getAttemptId()).toBe('att-1');
    expect(scope.getPolicyRevision()).toBe('policy-7');
  });

  it('rejects empty fields', () => {
    expect(
      requireFailure(
        EvidenceScope.create({
          projectId: 'proj-1',
          attemptId: '  ',
          candidateHeadSha: 'sha-1',
          policyRevision: 'policy-7',
        }),
      ).message,
    ).toContain('non-empty');
  });

  it('matches only the exact head it was produced for', () => {
    const scope = requireValue(
      EvidenceScope.create({
        projectId: 'proj-1',
        attemptId: 'att-1',
        candidateHeadSha: 'sha-1',
        policyRevision: 'policy-7',
      }),
    );
    expect(scope.matchesHead('sha-1')).toBe(true);
    expect(scope.matchesHead('sha-2')).toBe(false);
  });
});

describe('AcceptanceReceipt', () => {
  it('requires every scoped field', () => {
    const receipt = requireValue(
      AcceptanceReceipt.create({
        receiptId: 'receipt-1',
        assessmentId: 'ea-1',
        projectId: 'proj-1',
        attemptId: 'att-1',
        candidateHeadSha: 'sha-1',
        policyRevision: 'policy-7',
        issuedAtIso: '2026-10-15T00:02:00.000Z',
      }),
    );
    expect(receipt.getReceiptId()).toBe('receipt-1');
    expect(receipt.getCandidateHeadSha()).toBe('sha-1');
  });

  it('rejects an empty issuedAtIso', () => {
    expect(
      requireFailure(
        AcceptanceReceipt.create({
          receiptId: 'receipt-1',
          assessmentId: 'ea-1',
          projectId: 'proj-1',
          attemptId: 'att-1',
          candidateHeadSha: 'sha-1',
          policyRevision: 'policy-7',
          issuedAtIso: '',
        }),
      ).message,
    ).toContain('non-empty');
  });
});

describe('VerificationReceipt', () => {
  it('retains a completed check', () => {
    const receipt = requireValue(VerificationReceipt.create(verificationReceiptProps()));
    expect(receipt.getId()).toBe('vr-1');
    expect(receipt.getProcedureName()).toBe('unit-tests');
    expect(receipt.toRecord()).toEqual(verificationReceiptProps());
  });

  it('rejects a missing evidence reference', () => {
    expect(
      requireFailure(VerificationReceipt.create(verificationReceiptProps({ evidenceRef: '' }))).message,
    ).toContain('non-empty');
  });

  it('rejects a non-integer exit code', () => {
    expect(
      requireFailure(VerificationReceipt.create(verificationReceiptProps({ exitCode: 1.5 }))).message,
    ).toContain('exitCode');
  });

  it('binds to the exact head', () => {
    const receipt = requireValue(VerificationReceipt.create(verificationReceiptProps()));
    expect(receipt.matchesHead('sha-1')).toBe(true);
    expect(receipt.matchesHead('sha-2')).toBe(false);
  });
});

describe('ReviewReceipt', () => {
  it('retains an attributable read-only review', () => {
    const receipt = requireValue(ReviewReceipt.create(reviewReceiptProps()));
    expect(receipt.getResult()).toBe('fail');
    expect(receipt.getFindings()).toHaveLength(2);
    expect(receipt.toRecord().findings).toHaveLength(2);
  });

  it('strips prefixes, variants, cost and size suffixes when comparing model families', () => {
    const sameFamily: readonly [string, string][] = [
      ['nvidia/z-ai/glm-5.3-flash', 'openrouter/z-ai/glm-5.3'],
      ['openrouter/z-ai/glm-5.3', 'z-ai/glm-5.3#none'],
      ['opencode/longcat-2.5-preview-free', 'longcat-2.5'],
      ['openrouter/z-ai/glm-5.3-flash', 'NVIDIA/z-ai/glm-5.3'],
      ['bare-model', 'bare-model'],
    ];
    for (const [left, right] of sameFamily) {
      expect(underlyingModelFamily(left)).toBe(underlyingModelFamily(right));
    }
    const distinctFamilies: readonly [string, string][] = [
      ['claude-sonnet', 'claude-opus'],
      ['glm-5.3', 'glm-5.4'],
      ['gpt-6-luna', 'glm-5.3'],
    ];
    for (const [left, right] of distinctFamilies) {
      expect(underlyingModelFamily(left)).not.toBe(underlyingModelFamily(right));
    }
  });

  it('rejects openrouter/z-ai/glm-5.3 vs nvidia/z-ai/glm-5.3 as the same model', () => {
    const error = requireFailure(
      ReviewReceipt.create(
        reviewReceiptProps({
          reviewerModel: 'nvidia/z-ai/glm-5.3',
          implementerModel: 'openrouter/z-ai/glm-5.3',
        }),
      ),
    );
    expect(error.message).toContain('same underlying model');
  });

  it('accepts a reviewer on a genuinely different underlying model', () => {
    const receipt = requireValue(
      ReviewReceipt.create(
        reviewReceiptProps({
          reviewerModel: 'openrouter/poolside/laguna-s-2.1',
          implementerModel: 'nvidia/z-ai/glm-5.3-flash',
        }),
      ),
    );
    expect(receipt.getReviewerModel()).toBe('openrouter/poolside/laguna-s-2.1');
  });

  it('rejects an invalid finding', () => {
    expect(
      requireFailure(
        ReviewReceipt.create(reviewReceiptProps({ findings: [finding('f-1', { severity: 'catastrophic' as never })] })),
      ).message,
    ).toContain('invalid finding');
  });
});

describe('FindingDisposition', () => {
  it('records an evidence-backed refutation', () => {
    const disposition = requireValue(
      FindingDisposition.create({
        id: 'fd-1',
        assessmentId: 'ea-1',
        findingId: 'f-1',
        candidateHeadSha: 'sha-1',
        state: 'refuted',
        reason: 'claim does not hold against the diff',
        evidenceRef: 'evidence://fd-1',
        recordedBy: 'orchestrator',
        recordedAtIso: '2026-10-15T00:03:00.000Z',
      }),
    );
    expect(disposition.getFindingId()).toBe('f-1');
    expect(disposition.getState()).toBe('refuted');
  });

  it('rejects an unknown finding state', () => {
    expect(
      requireFailure(
        FindingDisposition.create({
          id: 'fd-1',
          assessmentId: 'ea-1',
          findingId: 'f-1',
          candidateHeadSha: 'sha-1',
          state: 'ignored' as never,
          reason: 'n/a',
          evidenceRef: 'evidence://fd-1',
          recordedBy: 'orchestrator',
          recordedAtIso: '2026-10-15T00:03:00.000Z',
        }),
      ).message,
    ).toContain('Invalid finding state');
  });

  it('rejects an empty reason', () => {
    expect(
      requireFailure(
        FindingDisposition.create({
          id: 'fd-1',
          assessmentId: 'ea-1',
          findingId: 'f-1',
          candidateHeadSha: 'sha-1',
          state: 'fixed',
          reason: '   ',
          evidenceRef: 'evidence://fd-1',
          recordedBy: 'orchestrator',
          recordedAtIso: '2026-10-15T00:03:00.000Z',
        }),
      ).message,
    ).toContain('non-empty');
  });
});

describe('EvidenceAssessment', () => {
  it('creates a pending assessment with no implicit pass', () => {
    const assessment = requireValue(EvidenceAssessment.create(assessmentProps()));
    expect(assessment.getState()).toBe('pending');
    expect(assessment.isTerminal()).toBe(false);
    expect(assessment.pendingRequiredChecks()).toEqual(['ci', 'unit-tests']);
    expect(assessment.collectBlockers()).toEqual([
      "required check 'ci' has no passing verification receipt",
      "required check 'unit-tests' has no passing verification receipt",
    ]);
  });

  it('never counts pending, fail or unknown receipts as passing', () => {
    for (const result of ['pending', 'fail', 'unknown'] as const) {
      const assessment = requireValue(
        EvidenceAssessment.create(
          assessmentProps({
            verificationReceipts: [verificationReceiptProps({ id: 'vr-x', procedureName: 'ci', result })],
          }),
        ),
      );
      expect(assessment.pendingRequiredChecks()).toEqual(['ci', 'unit-tests']);
    }
  });

  it('counts pass and not-applicable receipts as satisfying a required check', () => {
    for (const result of ['pass', 'not-applicable'] as const) {
      const assessment = requireValue(
        EvidenceAssessment.create(
          assessmentProps({
            verificationReceipts: [verificationReceiptProps({ id: 'vr-x', procedureName: 'ci', result })],
          }),
        ),
      );
      expect(assessment.pendingRequiredChecks()).toEqual(['unit-tests']);
    }
  });

  it('derives blockers from unresolved findings, preserving fixed and refuted ones', () => {
    const assessment = requireValue(
      EvidenceAssessment.create(
        assessmentProps({
          requiredChecks: [],
          reviewReceipts: [requireValue(ReviewReceipt.create(reviewReceiptProps())).toRecord()],
          findingDispositions: [
            {
              id: 'fd-1',
              assessmentId: 'ea-1',
              findingId: 'f-2',
              candidateHeadSha: 'sha-1',
              state: 'fixed',
              reason: 'patched',
              evidenceRef: 'evidence://fd-1',
              recordedBy: 'orchestrator',
              recordedAtIso: '2026-10-15T00:04:00.000Z',
            },
          ],
        }),
      ),
    );
    expect(assessment.unresolvedFindingIds()).toEqual(['f-1']);
    expect(assessment.collectBlockers()).toEqual(["finding 'f-1' is unresolved"]);
  });

  it('rejects a child receipt bound to a different head', () => {
    const assessment = requireValue(EvidenceAssessment.create(assessmentProps()));
    expect(() =>
      assessment.appendVerificationReceipt(
        verificationReceiptProps({ candidateHeadSha: 'sha-2' }),
        '2026-10-15T00:05:00.000Z',
      ),
    ).toThrow('different head');
  });

  it('rejects a child receipt bound to a different assessment', () => {
    const assessment = requireValue(EvidenceAssessment.create(assessmentProps()));
    expect(() =>
      assessment.appendVerificationReceipt(
        verificationReceiptProps({ assessmentId: 'ea-2' }),
        '2026-10-15T00:05:00.000Z',
      ),
    ).toThrow('different assessment');
  });

  it('appends a valid receipt and bumps the revision', () => {
    const assessment = requireValue(EvidenceAssessment.create(assessmentProps()));
    assessment.appendVerificationReceipt(verificationReceiptProps(), '2026-10-15T00:05:00.000Z');
    const record = assessment.toRecord();
    expect(record.verificationReceipts).toHaveLength(1);
    expect(record.revision).toBe(1);
    expect(record.updatedAtIso).toBe('2026-10-15T00:05:00.000Z');
  });

  it('issues a scoped acceptance receipt and closes the assessment', () => {
    const assessment = requireValue(EvidenceAssessment.create(assessmentProps()));
    assessment.accept('receipt-1', '2026-10-15T00:06:00.000Z');
    expect(assessment.getState()).toBe('accepted');
    expect(assessment.getAcceptanceReceiptId()).toBe('receipt-1');
    expect(assessment.isTerminal()).toBe(true);
    expect(assessment.getBlockers()).toEqual([]);
  });

  it('holds the assessment open with explicit blockers', () => {
    const assessment = requireValue(EvidenceAssessment.create(assessmentProps()));
    assessment.block(["finding 'f-1' is unresolved"], '2026-10-15T00:07:00.000Z');
    expect(assessment.getState()).toBe('blocked');
    expect(assessment.getBlockers()).toEqual(["finding 'f-1' is unresolved"]);
    expect(assessment.isTerminal()).toBe(false);
  });

  it('marks a changed head stale', () => {
    const assessment = requireValue(EvidenceAssessment.create(assessmentProps()));
    expect(assessment.isStaleForHead('sha-1')).toBe(false);
    expect(assessment.isStaleForHead('sha-2')).toBe(true);
    assessment.markStale('2026-10-15T00:08:00.000Z');
    expect(assessment.getState()).toBe('stale');
    expect(assessment.isTerminal()).toBe(true);
  });

  it('rejects an invalid state', () => {
    expect(
      requireFailure(EvidenceAssessment.create(assessmentProps({ state: 'running' as never }))).message,
    ).toContain('Invalid assessment state');
  });
});
