import { describe, expect, it } from 'vitest';
import {
  createFleetCliRuntime,
  forgeActionScope,
  consumptionId,
  observationEventKind,
} from './composition.js';
import type { CoordinationRequestRecord } from '@fleet/operator-coordination';
import type { AttemptRecord, WorkOrderRecord } from '@fleet/work-execution';

function makeHeadH(): string {
  return '1111111111111111111111111111111111111111';
}

function makeWorkOrder(id: string, _head: string): WorkOrderRecord {
  return {
    id,
    projectId: 'proj-cli-test',
    taskId: 'task-cli-test',
    laneId: 'lane-cli-test',
    repository: 'github.com/org/repo',
    state: 'approved',
    revision: 1,
    baseCommit: '0000000000000000000000000000000000000000',
    ownedPaths: ['src/'],
    policyRevision: 'pol-1',
    prerequisiteWorkOrderIds: [],
    createdAtIso: '2026-10-15T10:00:00Z',
    updatedAtIso: '2026-10-15T10:00:00Z',
  };
}

function makeAttempt(id: string, workOrderId: string, head: string): AttemptRecord {
  return {
    id,
    workOrderId,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    state: 'collected',
    outcome: 'done',
    baseCommit: '0000000000000000000000000000000000000000',
    worktreePath: '/tmp/worktree',
    briefDigest: 'digest-1',
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: {
      headCommit: head,
      commitsSinceBase: [head],
      collectedArtifactPaths: ['/tmp/patch.diff'],
      notes: 'present',
    },
    createdAtIso: '2026-10-15T10:00:00Z',
    updatedAtIso: '2026-10-15T10:30:00Z',
  };
}

function makeApprovedGrant(
  grantId: string,
  scope: string,
  head: string,
): CoordinationRequestRecord {
  return {
    id: `req-${grantId}`,
    projectId: 'proj-cli-test',
    kind: 'action-decision',
    state: 'approved',
    actionScope: scope,
    expectedHeadSha: head,
    proposalDigest: 'digest-req',
    policyRevision: 'pol-1',
    decisionRevision: 'dec-1',
    grantId,
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'delivered',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: '2026-10-15T10:00:00Z',
    updatedAtIso: '2026-10-15T10:00:00Z',
  };
}

describe('apps/cli composition', () => {
  describe('M6: shared coordination key formats', () => {
    it('produces the standard forgeActionScope, consumptionId, and observationEventKind', () => {
      expect(forgeActionScope('push-and-open-pr')).toBe('forge:push-and-open-pr');
      expect(forgeActionScope('merge-pr')).toBe('forge:merge-pr');
      expect(consumptionId('act-99')).toBe('consumption-act-99');
      expect(observationEventKind('forge', 'completed')).toBe('execution:forge:completed');
    });
  });

  describe('H7: end-to-end grant action scope check at consumption', () => {
    it('a grant for push-and-open-pr at head H cannot be consumed for merge-pr at H', async () => {
      const rt = createFleetCliRuntime();
      const headH = makeHeadH();
      const workOrderId = 'wo-e2e-1';
      const attemptId = 'att-e2e-1';
      const grantId = 'grant-push-only';

      // Record work order and collected attempt at head H
      await rt.execution.workOrderRepository.saveWorkOrder(makeWorkOrder(workOrderId, headH));
      await rt.execution.attemptRepository.saveAttempt(makeAttempt(attemptId, workOrderId, headH));

      // Save an approved grant for push-and-open-pr at head H
      const pushGrant = makeApprovedGrant(grantId, forgeActionScope('push-and-open-pr'), headH);
      await rt.coordination.coordinationRequestRepository.saveRequest(pushGrant);

      // Register acceptance receipt for head H so merge-pr preconditions pass
      const forgeDeps = (rt.execution.executeAuthorizedForgeAction as unknown as {
        deps?: { acceptedReceiptByHead?: Record<string, string> };
      }).deps;
      if (forgeDeps?.acceptedReceiptByHead) {
        forgeDeps.acceptedReceiptByHead[headH] = 'receipt-e2e-1';
      }

      // Attempt to execute merge-pr at head H using the push grant
      const mergeResult = await rt.execution.executeAuthorizedForgeAction.executeAuthorizedForgeAction({
        actionId: 'action-merge-1',
        attemptId,
        workOrderId,
        kind: 'merge-pr',
        expectedHeadSha: headH,
        authorizationGrantId: grantId,
      });

      // Must be refused due to actionScope mismatch
      expect(mergeResult.outcome).toBe('refused');
      if (mergeResult.outcome === 'refused') {
        expect(mergeResult.reason).toContain('forge:push-and-open-pr, not forge:merge-pr');
      }

      // Verify grant was NOT consumed in the repository
      const grantAfter = await rt.coordination.coordinationRequestRepository.findRequestByGrantId(grantId);
      expect(grantAfter?.consumptions).toHaveLength(0);
      expect(grantAfter?.state).toBe('approved');
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
