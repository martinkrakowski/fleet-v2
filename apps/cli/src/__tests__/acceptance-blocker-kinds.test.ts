// Acceptance blocker kinds reach the CLI's acceptance delegate: evidence's
// blocked/stale/rejected results carry their kinds as data (A11), so AM4a
// can read `ci-pending` without parsing the reason. Reason strings and the
// outcomes the CLI returns are unchanged.
/**
 * Covers the CLI composition root's acceptance delegate mapping evidence
 * blocker kinds into the work side's AssessmentBlocker union, and the
 * compile-time agreement between the two unions.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_BLOCKER_KINDS,
  type AcceptanceBlockerKind,
  type EvidenceAssessmentRecord,
} from '@fleet/evidence-and-acceptance';
import type { AssessmentBlockerKind, AttemptRecord } from '@fleet/work-execution';
import { assessmentIdForAttempt, createFleetCliRuntime } from '../composition.js';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// The consumer-side kind union is exactly evidence-and-acceptance's.
const unionsAgree: Same<AcceptanceBlockerKind, AssessmentBlockerKind> = true;

/**
 * A collected attempt whose frozen brief named the given one-way doors, so
 * acceptance resolves exactly those door references.
 */
function collectedAttempt(
  attemptId: string,
  headSha: string,
  ownerDecisionReferences: readonly string[] = [],
): AttemptRecord {
  return {
    id: attemptId,
    workOrderId: `wo-${attemptId}`,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    state: 'collected',
    outcome: 'done',
    baseCommit: 'base-sha',
    worktreePath: '/tmp/worktree',
    briefDigest: 'digest-1',
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: {
      headCommit: headSha,
      commitsSinceBase: [headSha],
      collectedArtifactPaths: [],
      notes: 'present',
    },
    ownerDecisionReferences: [...ownerDecisionReferences],
    createdAtIso: '2026-10-15T09:00:00.000Z',
    updatedAtIso: '2026-10-15T10:00:00.000Z',
  };
}

/**
 * A pending evidence assessment with the given head, a completed typecheck
 * verification receipt, and optionally a passing independent review.
 */
function pendingAssessment(
  attemptId: string,
  headSha: string,
  options: { withReview?: boolean } = {},
): EvidenceAssessmentRecord {
  const id = assessmentIdForAttempt(attemptId);
  const withReview = options.withReview !== false;
  return {
    id,
    projectId: 'project-1',
    attemptId,
    candidateHeadSha: headSha,
    policyRevision: 'policy-v1',
    implementerModel: 'openrouter/openai/gpt-4o',
    state: 'pending',
    revision: 1,
    requiredChecks: ['typecheck'],
    verificationReceipts: [
      {
        id: `vr-${attemptId}`,
        assessmentId: id,
        projectId: 'project-1',
        attemptId,
        candidateHeadSha: headSha,
        hostId: 'host-1',
        procedureName: 'typecheck',
        result: 'pass',
        exitCode: 0,
        evidenceRef: `seed@${headSha}`,
        policyRevision: 'policy-v1',
        completedAtIso: '2026-10-15T08:00:00.000Z',
      },
    ],
    reviewReceipts: withReview
      ? [
          {
            id: `rr-${attemptId}`,
            assessmentId: id,
            projectId: 'project-1',
            attemptId,
            candidateHeadSha: headSha,
            reviewerModel: 'openrouter/anthropic/claude-3.5-sonnet',
            implementerModel: 'openrouter/openai/gpt-4o',
            readOnlyVerified: true,
            result: 'pass',
            findings: [],
            evidenceRef: `review-seed@${headSha}`,
            policyRevision: 'policy-v1',
            completedAtIso: '2026-10-15T09:00:00.000Z',
          },
        ]
      : [],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    updatedAtIso: '2026-10-15T10:00:00.000Z',
  };
}

describe('Fleet CLI acceptance delegate blocker kinds', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fleet-cli-acceptance-blockers-'),
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('maps a missing review to a review-missing blocker', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempDir });
    await runtime.evidence.evidenceAssessmentRepository.saveAssessment(
      pendingAssessment('attempt-rv', 'head-sha-rv', { withReview: false }),
    );
    await runtime.execution.attemptRepository.saveAttempt(
      collectedAttempt('attempt-rv', 'head-sha-rv'),
    );

    const result = await runtime.execution.acceptanceAssessment.assessHeadAcceptance({
      attemptId: 'attempt-rv',
      workOrderId: 'wo-rv',
      candidateHeadSha: 'head-sha-rv',
      policyRevision: 'policy-v1',
    });

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Acceptance blocked: no independent review was recorded for this candidate head',
      blockerDetails: [
        {
          kind: 'review-missing',
          text: 'no independent review was recorded for this candidate head',
        },
      ],
    });
  });

  it('maps an unresolved owner decision to a door blocker', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempDir });
    await runtime.evidence.evidenceAssessmentRepository.saveAssessment(
      pendingAssessment('attempt-door', 'head-sha-door'),
    );
    await runtime.execution.attemptRepository.saveAttempt(
      collectedAttempt('attempt-door', 'head-sha-door', ['req-door-example']),
    );

    const result = await runtime.execution.acceptanceAssessment.assessHeadAcceptance({
      attemptId: 'attempt-door',
      workOrderId: 'wo-door',
      candidateHeadSha: 'head-sha-door',
      policyRevision: 'policy-v1',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      const details = result.blockerDetails ?? [];
      expect(details.length).toBeGreaterThan(0);
      expect(details.every((blocker) => blocker.kind === 'door')).toBe(true);
      expect(details.some((blocker) => blocker.text.includes('req-door-example'))).toBe(true);
    }
  });

  it('maps a moved candidate head to a stale blocker', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempDir });
    await runtime.evidence.evidenceAssessmentRepository.saveAssessment(
      pendingAssessment('attempt-stale', 'head-sha-stale'),
    );
    await runtime.execution.attemptRepository.saveAttempt(
      collectedAttempt('attempt-stale', 'head-sha-stale'),
    );

    const result = await runtime.execution.acceptanceAssessment.assessHeadAcceptance({
      attemptId: 'attempt-stale',
      workOrderId: 'wo-stale',
      candidateHeadSha: 'head-sha-other',
      policyRevision: 'policy-v1',
    });

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Candidate head or policy revision changed',
      blockerDetails: [
        { kind: 'stale', text: 'Candidate head or policy revision changed' },
      ],
    });
  });

  it('maps a missing assessment to an other blocker', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempDir });
    await runtime.execution.attemptRepository.saveAttempt(
      collectedAttempt('attempt-missing', 'head-sha-missing'),
    );

    const result = await runtime.execution.acceptanceAssessment.assessHeadAcceptance({
      attemptId: 'attempt-missing',
      workOrderId: 'wo-missing',
      candidateHeadSha: 'head-sha-missing',
      policyRevision: 'policy-v1',
    });

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Assessment not found',
      blockerDetails: [{ kind: 'other', text: 'Assessment not found' }],
    });
  });

  it('keeps the accepted result unchanged without a blockerDetails key', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempDir });
    await runtime.evidence.evidenceAssessmentRepository.saveAssessment(
      pendingAssessment('attempt-ok', 'head-sha-ok'),
    );
    await runtime.execution.attemptRepository.saveAttempt(
      collectedAttempt('attempt-ok', 'head-sha-ok'),
    );

    const result = await runtime.execution.acceptanceAssessment.assessHeadAcceptance({
      attemptId: 'attempt-ok',
      workOrderId: 'wo-ok',
      candidateHeadSha: 'head-sha-ok',
      policyRevision: 'policy-v1',
    });

    expect(result.outcome).toBe('accepted');
    if (result.outcome === 'accepted') {
      expect(result.receiptId).toBeTruthy();
      expect(result.assessedHeadSha).toBe('head-sha-ok');
      expect('blockerDetails' in result).toBe(false);
    }
  });

  it('declares the unions agreeing and the runtime kind list at length 8', () => {
    expect(unionsAgree).toBe(true);
    expect(ACCEPTANCE_BLOCKER_KINDS).toHaveLength(8);
  });
});
