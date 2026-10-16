import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EvidenceAssessmentRecord } from '@fleet/evidence-and-acceptance';
import type { CoordinationRequestRecord } from '@fleet/operator-coordination';
import type { AttemptRecord } from '@fleet/work-execution';
import { assessmentIdForAttempt, createFleetCliRuntime } from './composition.js';

/**
 * A collected attempt whose frozen brief named no one-way doors, so acceptance
 * reads an empty door list instead of blocking on an unknown one.
 */
function collectedAttempt(attemptId: string, headSha: string): AttemptRecord {
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
    ownerDecisionReferences: [],
    createdAtIso: '2026-10-15T09:00:00.000Z',
    updatedAtIso: '2026-10-15T10:00:00.000Z',
  };
}

describe('Fleet CLI composition root cross-process safe persistence', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-cli-composition-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('preserves accepted receipts across multiple runtime instances on the same stateDir', async () => {
    const runtimeA = createFleetCliRuntime({ stateDir: tempDir });
    const runtimeB = createFleetCliRuntime({ stateDir: tempDir });

    const assessmentA: EvidenceAssessmentRecord = {
      id: assessmentIdForAttempt('attempt-a'),
      projectId: 'project-1',
      attemptId: 'attempt-a',
      candidateHeadSha: 'head-sha-a',
      policyRevision: 'policy-v1',
      implementerModel: 'openrouter/openai/gpt-4o',
      state: 'pending',
      revision: 1,
      requiredChecks: [],
      verificationReceipts: [],
      reviewReceipts: [
        {
          id: 'rev-a',
          assessmentId: assessmentIdForAttempt('attempt-a'),
          projectId: 'project-1',
          attemptId: 'attempt-a',
          candidateHeadSha: 'head-sha-a',
          reviewerModel: 'openrouter/anthropic/claude-3.5-sonnet',
          implementerModel: 'openrouter/openai/gpt-4o',
          readOnlyVerified: true,
          result: 'pass',
          findings: [],
          evidenceRef: 'evidence-ref-a',
          policyRevision: 'policy-v1',
          completedAtIso: '2026-10-15T10:00:00.000Z',
        },
      ],
      findingDispositions: [],
      acceptanceReceiptId: null,
      blockers: [],
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };

    const assessmentB: EvidenceAssessmentRecord = {
      id: assessmentIdForAttempt('attempt-b'),
      projectId: 'project-1',
      attemptId: 'attempt-b',
      candidateHeadSha: 'head-sha-b',
      policyRevision: 'policy-v1',
      implementerModel: 'openrouter/openai/gpt-4o',
      state: 'pending',
      revision: 1,
      requiredChecks: [],
      verificationReceipts: [],
      reviewReceipts: [
        {
          id: 'rev-b',
          assessmentId: assessmentIdForAttempt('attempt-b'),
          projectId: 'project-1',
          attemptId: 'attempt-b',
          candidateHeadSha: 'head-sha-b',
          reviewerModel: 'openrouter/anthropic/claude-3.5-sonnet',
          implementerModel: 'openrouter/openai/gpt-4o',
          readOnlyVerified: true,
          result: 'pass',
          findings: [],
          evidenceRef: 'evidence-ref-b',
          policyRevision: 'policy-v1',
          completedAtIso: '2026-10-15T10:00:00.000Z',
        },
      ],
      findingDispositions: [],
      acceptanceReceiptId: null,
      blockers: [],
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };

    await runtimeA.evidence.evidenceAssessmentRepository.saveAssessment(assessmentA);
    await runtimeB.evidence.evidenceAssessmentRepository.saveAssessment(assessmentB);
    await runtimeA.execution.attemptRepository.saveAttempt(
      collectedAttempt('attempt-a', 'head-sha-a'),
    );
    await runtimeB.execution.attemptRepository.saveAttempt(
      collectedAttempt('attempt-b', 'head-sha-b'),
    );

    // Concurrently assess both attempts across runtime instances
    const [resultA, resultB] = await Promise.all([
      runtimeA.execution.acceptanceAssessment.assessHeadAcceptance({
        attemptId: 'attempt-a',
        workOrderId: 'wo-a',
        candidateHeadSha: 'head-sha-a',
        policyRevision: 'policy-v1',
      }),
      runtimeB.execution.acceptanceAssessment.assessHeadAcceptance({
        attemptId: 'attempt-b',
        workOrderId: 'wo-b',
        candidateHeadSha: 'head-sha-b',
        policyRevision: 'policy-v1',
      }),
    ]);

    expect(resultA.outcome).toBe('accepted');
    expect(resultB.outcome).toBe('accepted');

    // Both receipts must be present on disk in accepted-receipts.json
    const receiptsPath = path.join(tempDir, 'accepted-receipts.json');
    const raw = await fs.readFile(receiptsPath, 'utf8');
    const receipts = JSON.parse(raw) as Record<string, string>;

    expect(receipts['head-sha-a']).toBeDefined();
    expect(receipts['head-sha-b']).toBeDefined();

    // A fresh third runtime sees both receipts on disk
    const runtimeC = createFleetCliRuntime({ stateDir: tempDir });
    const freshRaw = await fs.readFile(receiptsPath, 'utf8');
    const freshReceipts = JSON.parse(freshRaw) as Record<string, string>;
    expect(freshReceipts['head-sha-a']).toBe(receipts['head-sha-a']);
    expect(freshReceipts['head-sha-b']).toBe(receipts['head-sha-b']);
    expect(runtimeC).toBeDefined();
  });

  it('preserves authorization coordinates across multiple runtime instances on the same stateDir', async () => {
    const runtimeA = createFleetCliRuntime({ stateDir: tempDir });
    const runtimeB = createFleetCliRuntime({ stateDir: tempDir });

    const reqA: CoordinationRequestRecord = {
      id: 'req-a',
      projectId: 'project-1',
      kind: 'action-decision',
      actionScope: 'forge:push-and-open-pr',
      expectedHeadSha: 'commit-a',
      proposalDigest: 'prop-a',
      policyRevision: 'pol-1',
      decisionRevision: 'dec-1',
      grantId: 'grant-a',
      state: 'approved',
      deliveryStatus: 'pending',
      deliveryGapReason: null,
      revision: 1,
      consumptions: [],
      acknowledgements: [],
      createdAtIso: '2026-10-15T10:00:00.000Z',
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };

    const reqB: CoordinationRequestRecord = {
      id: 'req-b',
      projectId: 'project-1',
      kind: 'action-decision',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: 'commit-b',
      proposalDigest: 'prop-b',
      policyRevision: 'pol-1',
      decisionRevision: 'dec-2',
      grantId: 'grant-b',
      state: 'approved',
      deliveryStatus: 'pending',
      deliveryGapReason: null,
      revision: 1,
      consumptions: [],
      acknowledgements: [],
      createdAtIso: '2026-10-15T10:00:00.000Z',
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };

    await runtimeA.coordination.coordinationRequestRepository.saveRequest(reqA);
    await runtimeB.coordination.coordinationRequestRepository.saveRequest(reqB);

    // Concurrently resolve grants across two runtime instances
    const [grantA, grantB] = await Promise.all([
      runtimeA.execution.actionAuthorization.resolveActionAuthorization({
        actionId: 'action-a',
        projectId: 'project-1',
        workOrderId: 'wo-a',
        attemptId: 'attempt-a',
        actionKind: 'push-and-open-pr',
        expectedHeadSha: 'commit-a',
        policyRevision: 'pol-1',
      }),
      runtimeB.execution.actionAuthorization.resolveActionAuthorization({
        actionId: 'action-b',
        projectId: 'project-1',
        workOrderId: 'wo-b',
        attemptId: 'attempt-b',
        actionKind: 'merge-pr',
        expectedHeadSha: 'commit-b',
        policyRevision: 'pol-1',
      }),
    ]);

    expect(grantA.outcome).toBe('granted');
    expect(grantB.outcome).toBe('granted');

    // Both coordinates must survive on disk in authorization-coordinates.json
    const coordPath = path.join(tempDir, 'authorization-coordinates.json');
    const raw = await fs.readFile(coordPath, 'utf8');
    const coordinates = JSON.parse(raw) as Record<string, { attemptId: string; expectedHeadSha: string }>;

    expect(coordinates['grant-a']).toEqual({
      attemptId: 'attempt-a',
      expectedHeadSha: 'commit-a',
    });
    expect(coordinates['grant-b']).toEqual({
      attemptId: 'attempt-b',
      expectedHeadSha: 'commit-b',
    });
  });

  it('throws and leaves corrupt accepted-receipts.json unchanged on write attempt', async () => {
    const runtime = createFleetCliRuntime({ stateDir: tempDir });
    const receiptsPath = path.join(tempDir, 'accepted-receipts.json');
    const corruptContent = 'CORRUPT_NOT_JSON_{{';
    await fs.writeFile(receiptsPath, corruptContent, 'utf8');

    const assessment: EvidenceAssessmentRecord = {
      id: assessmentIdForAttempt('attempt-corrupt'),
      projectId: 'project-1',
      attemptId: 'attempt-corrupt',
      candidateHeadSha: 'head-sha-corrupt',
      policyRevision: 'policy-v1',
      implementerModel: 'openrouter/openai/gpt-4o',
      state: 'pending',
      revision: 1,
      requiredChecks: [],
      verificationReceipts: [],
      reviewReceipts: [
        {
          id: 'rev-corrupt',
          assessmentId: assessmentIdForAttempt('attempt-corrupt'),
          projectId: 'project-1',
          attemptId: 'attempt-corrupt',
          candidateHeadSha: 'head-sha-corrupt',
          reviewerModel: 'openrouter/anthropic/claude-3.5-sonnet',
          implementerModel: 'openrouter/openai/gpt-4o',
          readOnlyVerified: true,
          result: 'pass',
          findings: [],
          evidenceRef: 'evidence-ref-corrupt',
          policyRevision: 'policy-v1',
          completedAtIso: '2026-10-15T10:00:00.000Z',
        },
      ],
      findingDispositions: [],
      acceptanceReceiptId: null,
      blockers: [],
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };

    await runtime.evidence.evidenceAssessmentRepository.saveAssessment(assessment);
    await runtime.execution.attemptRepository.saveAttempt(
      collectedAttempt('attempt-corrupt', 'head-sha-corrupt'),
    );

    await expect(
      runtime.execution.acceptanceAssessment.assessHeadAcceptance({
        attemptId: 'attempt-corrupt',
        workOrderId: 'wo-corrupt',
        candidateHeadSha: 'head-sha-corrupt',
        policyRevision: 'policy-v1',
      }),
    ).rejects.toThrow();

    const contentAfter = await fs.readFile(receiptsPath, 'utf8');
    expect(contentAfter).toBe(corruptContent);
  });
});
