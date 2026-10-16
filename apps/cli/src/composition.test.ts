import { describe, expect, it } from 'vitest';
import {
  createFleetCliRuntime,
  forgeActionScope,
  consumptionId,
  observationEventKind,
  assessmentIdForAttempt,
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

      // Register acceptance assessment and receipt for head H so merge-pr preconditions pass
      await rt.evidence.evidenceAssessmentRepository.saveAssessment({
        id: assessmentIdForAttempt(attemptId),
        projectId: 'proj-cli-test',
        attemptId,
        candidateHeadSha: headH,
        policyRevision: 'pol-1',
        requiredChecks: [],
        state: 'accepted',
        verificationReceipts: [],
        reviewReceipts: [],
        findingDispositions: [],
        acceptanceReceiptId: 'receipt-e2e-1',
        blockers: [],
        revision: 1,
        updatedAtIso: '2026-10-15T10:00:00Z',
      });

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

  describe('M12: acceptance evidence verification before merge-pr in composition root', () => {
    it('stale assessment with a receipt in the map -> merge refused', async () => {
      const rt = createFleetCliRuntime();
      const headH = makeHeadH();
      const workOrderId = 'wo-m12-stale';
      const attemptId = 'att-m12-stale';
      const grantId = 'grant-m12-stale';

      await rt.execution.workOrderRepository.saveWorkOrder(makeWorkOrder(workOrderId, headH));
      await rt.execution.attemptRepository.saveAttempt(makeAttempt(attemptId, workOrderId, headH));

      const mergeGrant = makeApprovedGrant(grantId, forgeActionScope('merge-pr'), headH);
      await rt.coordination.coordinationRequestRepository.saveRequest(mergeGrant);

      // Save a stale assessment in evidence repository
      await rt.evidence.evidenceAssessmentRepository.saveAssessment({
        id: assessmentIdForAttempt(attemptId),
        projectId: 'proj-cli-test',
        attemptId,
        candidateHeadSha: headH,
        policyRevision: 'pol-1',
        requiredChecks: [],
        state: 'stale',
        verificationReceipts: [],
        reviewReceipts: [],
        findingDispositions: [],
        acceptanceReceiptId: 'receipt-stale-1',
        blockers: [],
        revision: 2,
        updatedAtIso: '2026-10-15T11:00:00Z',
      });

      // Receipt exists in the map
      const forgeDeps = (rt.execution.executeAuthorizedForgeAction as unknown as {
        deps?: { acceptedReceiptByHead?: Record<string, string> };
      }).deps;
      if (forgeDeps?.acceptedReceiptByHead) {
        forgeDeps.acceptedReceiptByHead[headH] = 'receipt-stale-1';
      }

      const mergeResult = await rt.execution.executeAuthorizedForgeAction.executeAuthorizedForgeAction({
        actionId: 'action-m12-1',
        attemptId,
        workOrderId,
        kind: 'merge-pr',
        expectedHeadSha: headH,
        authorizationGrantId: grantId,
      });

      expect(mergeResult.outcome).toBe('refused');
      if (mergeResult.outcome === 'refused') {
        expect(mergeResult.reason).toContain('stale');
      }
    });

    it('policy moved -> merge refused', async () => {
      const rt = createFleetCliRuntime();
      const headH = makeHeadH();
      const workOrderId = 'wo-m12-pol';
      const attemptId = 'att-m12-pol';
      const grantId = 'grant-m12-pol';

      // Work order has policyRevision: 'pol-moved'
      const wo = { ...makeWorkOrder(workOrderId, headH), policyRevision: 'pol-moved' };
      await rt.execution.workOrderRepository.saveWorkOrder(wo);
      await rt.execution.attemptRepository.saveAttempt(makeAttempt(attemptId, workOrderId, headH));

      const mergeGrant = makeApprovedGrant(grantId, forgeActionScope('merge-pr'), headH);
      await rt.coordination.coordinationRequestRepository.saveRequest(mergeGrant);

      // Assessment was accepted under old policy 'pol-1'
      await rt.evidence.evidenceAssessmentRepository.saveAssessment({
        id: assessmentIdForAttempt(attemptId),
        projectId: 'proj-cli-test',
        attemptId,
        candidateHeadSha: headH,
        policyRevision: 'pol-1',
        requiredChecks: [],
        state: 'accepted',
        verificationReceipts: [],
        reviewReceipts: [],
        findingDispositions: [],
        acceptanceReceiptId: 'receipt-pol-1',
        blockers: [],
        revision: 1,
        updatedAtIso: '2026-10-15T11:00:00Z',
      });

      const mergeResult = await rt.execution.executeAuthorizedForgeAction.executeAuthorizedForgeAction({
        actionId: 'action-m12-2',
        attemptId,
        workOrderId,
        kind: 'merge-pr',
        expectedHeadSha: headH,
        authorizationGrantId: grantId,
      });

      expect(mergeResult.outcome).toBe('refused');
      if (mergeResult.outcome === 'refused') {
        expect(mergeResult.reason).toContain('policy revision');
      }
    });
  });

  describe('M15: owner decision / one-way door integration in composition root', () => {
    it('undecided one-way door -> acceptance blocked', async () => {
      const rt = createFleetCliRuntime();
      const headH = makeHeadH();
      const attemptId = 'att-m15-door-undecided';
      const assessmentId = assessmentIdForAttempt(attemptId);
      const doorRef = 'req-door-open-1';

      // Save a coordination request awaiting decision
      await rt.coordination.coordinationRequestRepository.saveRequest({
        id: doorRef,
        projectId: 'proj-cli-test',
        kind: 'action-decision',
        state: 'awaiting-decision',
        actionScope: 'door:dangerous-op',
        expectedHeadSha: headH,
        proposalDigest: 'digest-door-1',
        policyRevision: 'pol-1',
        decisionRevision: null,
        grantId: null,
        consumptions: [],
        acknowledgements: [],
        deliveryStatus: 'delivered',
        deliveryGapReason: null,
        revision: 1,
        createdAtIso: '2026-10-15T10:00:00Z',
        updatedAtIso: '2026-10-15T10:00:00Z',
      });

      // Save an assessment with passing review
      await rt.evidence.evidenceAssessmentRepository.saveAssessment({
        id: assessmentId,
        projectId: 'proj-cli-test',
        attemptId,
        candidateHeadSha: headH,
        policyRevision: 'pol-1',
        requiredChecks: [],
        state: 'pending',
        verificationReceipts: [],
        reviewReceipts: [
          {
            id: 'rev-m15-1',
            assessmentId,
            projectId: 'proj-cli-test',
            attemptId,
            candidateHeadSha: headH,
            reviewerModel: 'reviewer-mod',
            implementerModel: 'implementer-mod',
            readOnlyVerified: true,
            result: 'pass',
            findings: [],
            evidenceRef: 'ev-1',
            policyRevision: 'pol-1',
            completedAtIso: '2026-10-15T10:00:00Z',
          },
        ],
        findingDispositions: [],
        acceptanceReceiptId: null,
        blockers: [],
        revision: 1,
        updatedAtIso: '2026-10-15T10:00:00Z',
      });

      const result = await rt.evidence.assessHeadAcceptance.assessHeadAcceptance({
        assessmentId,
        candidateHeadSha: headH,
        policyRevision: 'pol-1',
        ownerDecisionReferences: [doorRef],
      });

      expect(result.outcome).toBe('blocked');
      if (result.outcome === 'blocked') {
        expect(result.blockers.some((b) => b.includes("state 'awaiting-decision', not 'approved'"))).toBe(true);
      }
    });

    it('decided one-way door -> acceptance passes', async () => {
      const rt = createFleetCliRuntime();
      const headH = makeHeadH();
      const attemptId = 'att-m15-door-decided';
      const assessmentId = assessmentIdForAttempt(attemptId);
      const doorRef = 'req-door-approved-1';

      // Save an approved coordination request for headH
      await rt.coordination.coordinationRequestRepository.saveRequest({
        id: doorRef,
        projectId: 'proj-cli-test',
        kind: 'action-decision',
        state: 'approved',
        actionScope: 'door:dangerous-op',
        expectedHeadSha: headH,
        proposalDigest: 'digest-door-1',
        policyRevision: 'pol-1',
        decisionRevision: 'dec-approved-1',
        grantId: 'grant-door-1',
        consumptions: [],
        acknowledgements: [],
        deliveryStatus: 'delivered',
        deliveryGapReason: null,
        revision: 2,
        createdAtIso: '2026-10-15T10:00:00Z',
        updatedAtIso: '2026-10-15T10:30:00Z',
      });

      // Save an assessment with passing review
      await rt.evidence.evidenceAssessmentRepository.saveAssessment({
        id: assessmentId,
        projectId: 'proj-cli-test',
        attemptId,
        candidateHeadSha: headH,
        policyRevision: 'pol-1',
        requiredChecks: [],
        state: 'pending',
        verificationReceipts: [],
        reviewReceipts: [
          {
            id: 'rev-m15-2',
            assessmentId,
            projectId: 'proj-cli-test',
            attemptId,
            candidateHeadSha: headH,
            reviewerModel: 'reviewer-mod',
            implementerModel: 'implementer-mod',
            readOnlyVerified: true,
            result: 'pass',
            findings: [],
            evidenceRef: 'ev-2',
            policyRevision: 'pol-1',
            completedAtIso: '2026-10-15T10:00:00Z',
          },
        ],
        findingDispositions: [],
        acceptanceReceiptId: null,
        blockers: [],
        revision: 1,
        updatedAtIso: '2026-10-15T10:00:00Z',
      });

      const result = await rt.evidence.assessHeadAcceptance.assessHeadAcceptance({
        assessmentId,
        candidateHeadSha: headH,
        policyRevision: 'pol-1',
        ownerDecisionReferences: [doorRef],
      });

      expect(result.outcome).toBe('accepted');
      if (result.outcome === 'accepted') {
        expect(result.candidateHeadSha).toBe(headH);
        expect(result.receiptId).toContain('acc-');
      }
    });
  });
});
