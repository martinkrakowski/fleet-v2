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

function makeAttempt(
  id: string,
  workOrderId: string,
  head: string,
  ownerDecisionReferences?: readonly string[],
): AttemptRecord {
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
    ...(ownerDecisionReferences === undefined ? {} : { ownerDecisionReferences }),
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

/** A recorded owner decision, addressed by its own `owner-decision:` scope. */
function makeOwnerDecisionRequest(
  requestId: string,
  head: string,
  overrides: Partial<CoordinationRequestRecord> = {},
): CoordinationRequestRecord {
  return {
    id: requestId,
    projectId: 'proj-cli-test',
    kind: 'action-decision',
    state: 'approved',
    actionScope: `owner-decision:${requestId}`,
    expectedHeadSha: head,
    proposalDigest: `digest-${requestId}`,
    policyRevision: 'pol-1',
    decisionRevision: `dec-${requestId}`,
    grantId: `grant-${requestId}`,
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'delivered',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: '2026-10-15T10:00:00Z',
    updatedAtIso: '2026-10-15T10:00:00Z',
    ...overrides,
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
      await rt.execution.attemptRepository.saveAttempt(
        makeAttempt(attemptId, workOrderId, headH, []),
      );

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
      await rt.execution.attemptRepository.saveAttempt(
        makeAttempt(attemptId, workOrderId, headH, []),
      );

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
      await rt.execution.attemptRepository.saveAttempt(
        makeAttempt(attemptId, workOrderId, headH, []),
      );

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
    const HEAD = makeHeadH();

    async function seedDoor(
      attemptId: string,
      options: {
        decision?: CoordinationRequestRecord;
        /** `null` records the attempt as it was before the field existed. */
        doors?: readonly string[] | null;
        state?: 'pending' | 'accepted';
      } = {},
    ) {
      const rt = createFleetCliRuntime();
      const assessmentId = assessmentIdForAttempt(attemptId);
      const workOrderId = `wo-${attemptId}`;
      await rt.execution.workOrderRepository.saveWorkOrder(makeWorkOrder(workOrderId, HEAD));
      await rt.execution.attemptRepository.saveAttempt(
        makeAttempt(attemptId, workOrderId, HEAD, options.doors === null ? undefined : (options.doors ?? [])),
      );
      if (options.decision !== undefined) {
        await rt.coordination.coordinationRequestRepository.saveRequest(options.decision);
      }
      await rt.evidence.evidenceAssessmentRepository.saveAssessment({
        id: assessmentId,
        projectId: 'proj-cli-test',
        attemptId,
        candidateHeadSha: HEAD,
        policyRevision: 'pol-1',
        requiredChecks: [],
        state: options.state ?? 'pending',
        verificationReceipts: [],
        reviewReceipts: [
          {
            id: `rev-${attemptId}`,
            assessmentId,
            projectId: 'proj-cli-test',
            attemptId,
            candidateHeadSha: HEAD,
            reviewerModel: 'reviewer-mod',
            implementerModel: 'implementer-mod',
            readOnlyVerified: true,
            result: 'pass',
            findings: [],
            evidenceRef: `ev-${attemptId}`,
            policyRevision: 'pol-1',
            completedAtIso: '2026-10-15T10:00:00Z',
          },
        ],
        findingDispositions: [],
        acceptanceReceiptId: options.state === 'accepted' ? `acc-${attemptId}` : null,
        blockers: [],
        revision: 1,
        updatedAtIso: '2026-10-15T10:00:00Z',
      });
      return { rt, assessmentId };
    }

    function assess(rt: ReturnType<typeof createFleetCliRuntime>, assessmentId: string) {
      return rt.evidence.assessHeadAcceptance.assessHeadAcceptance({
        assessmentId,
        candidateHeadSha: HEAD,
        policyRevision: 'pol-1',
      });
    }

    it('an approved one-way door for the candidate head -> acceptance passes', async () => {
      const doorRef = 'req-door-approved-1';
      const { rt, assessmentId } = await seedDoor('att-m15-door-decided', {
        doors: [doorRef],
        decision: makeOwnerDecisionRequest(doorRef, HEAD),
      });

      const result = await assess(rt, assessmentId);

      expect(result.outcome).toBe('accepted');
      if (result.outcome === 'accepted') {
        expect(result.candidateHeadSha).toBe(HEAD);
        expect(result.receiptId).toContain('acc-');
      }
    });

    it('an undecided one-way door -> acceptance blocked', async () => {
      const doorRef = 'req-door-open-1';
      const { rt, assessmentId } = await seedDoor('att-m15-door-undecided', {
        doors: [doorRef],
        decision: makeOwnerDecisionRequest(doorRef, HEAD, {
          state: 'awaiting-decision',
          decisionRevision: null,
          grantId: null,
        }),
      });

      const result = await assess(rt, assessmentId);

      expect(result.outcome).toBe('blocked');
      if (result.outcome === 'blocked') {
        expect(result.blockers.some((b) => b.includes("owner decision 'req-door-open-1' is not approved"))).toBe(
          true,
        );
        expect(result.blockers.some((b) => b.includes("'awaiting-decision'"))).toBe(true);
      }
    });

    it('a declined one-way door -> acceptance blocked', async () => {
      const doorRef = 'req-door-declined-1';
      const { rt, assessmentId } = await seedDoor('att-m15-door-declined', {
        doors: [doorRef],
        decision: makeOwnerDecisionRequest(doorRef, HEAD, {
          state: 'declined',
          decisionRevision: null,
          grantId: null,
        }),
      });

      const result = await assess(rt, assessmentId);

      expect(result.outcome).toBe('blocked');
      if (result.outcome === 'blocked') {
        expect(result.blockers.some((b) => b.includes("'declined'"))).toBe(true);
      }
    });

    it('an approval recorded for another scope on the same head -> acceptance blocked', async () => {
      const doorRef = 'req-door-other-scope';
      const { rt, assessmentId } = await seedDoor('att-m15-door-other-scope', {
        doors: [doorRef],
        decision: makeOwnerDecisionRequest(doorRef, HEAD, {
          actionScope: forgeActionScope('merge-pr'),
        }),
      });

      const result = await assess(rt, assessmentId);

      expect(result.outcome).toBe('blocked');
      if (result.outcome === 'blocked') {
        expect(
          result.blockers.some((b) => b.includes(`does not authorize owner-decision:${doorRef}`)),
        ).toBe(true);
      }
    });

    it('an unrecorded one-way door -> acceptance blocked as unknown', async () => {
      const { rt, assessmentId } = await seedDoor('att-m15-door-unrecorded', {
        doors: ['req-door-never-recorded'],
      });

      const result = await assess(rt, assessmentId);

      expect(result.outcome).toBe('blocked');
      if (result.outcome === 'blocked') {
        expect(result.blockers.some((b) => b.includes('is unknown'))).toBe(true);
      }
    });

    it('an attempt recorded before doors were frozen -> acceptance blocked', async () => {
      const { rt, assessmentId } = await seedDoor('att-m15-old-attempt', { doors: null });

      const result = await assess(rt, assessmentId);

      expect(result.outcome).toBe('blocked');
      if (result.outcome === 'blocked') {
        expect(
          result.blockers.some((b) =>
            b.includes('owner decision references for attempt'),
          ),
        ).toBe(true);
      }
    });

    it('an already accepted assessment with a newly undecided door -> blocked, not the stored acceptance', async () => {
      const doorRef = 'req-door-approved-then-open';
      const { rt, assessmentId } = await seedDoor('att-m15-door-regressed', {
        doors: [doorRef],
        state: 'accepted',
        decision: makeOwnerDecisionRequest(doorRef, HEAD),
      });

      const first = await assess(rt, assessmentId);
      expect(first.outcome).toBe('accepted');

      // The owner decision is withdrawn while the attempt keeps its door.
      await rt.coordination.coordinationRequestRepository.saveRequest(
        makeOwnerDecisionRequest(doorRef, HEAD, {
          state: 'awaiting-decision',
          decisionRevision: null,
          grantId: null,
          revision: 2,
        }),
      );

      const second = await assess(rt, assessmentId);
      expect(second.outcome).toBe('blocked');
      const stored = await rt.evidence.evidenceAssessmentRepository.findAssessmentById(assessmentId);
      expect(stored?.state).toBe('blocked');
      expect(stored?.acceptanceReceiptId).toBeNull();
    });

    it('withdrawn door: attempt accept is blocked and merge-pr refuses without consuming the grant', async () => {
    const HEAD = makeHeadH();
    const doorRef = 'req-door-e2e';
    const { rt } = await seedDoor('att-door-e2e', {
      doors: [doorRef],
      state: 'accepted',
      decision: makeOwnerDecisionRequest(doorRef, HEAD),
    });
    const grantId = 'grant-door-e2e';
    await rt.coordination.coordinationRequestRepository.saveRequest(
      makeApprovedGrant(grantId, forgeActionScope('merge-pr'), HEAD),
    );

    // The owner decision is withdrawn while the attempt keeps its door.
    await rt.coordination.coordinationRequestRepository.saveRequest(
      makeOwnerDecisionRequest(doorRef, HEAD, {
        state: 'awaiting-decision',
        decisionRevision: null,
        grantId: null,
        revision: 2,
      }),
    );

    // `attempt accept` must refuse even though a receipt-bearing accepted
    // assessment is still stored for this exact head.
    const accept = await rt.execution.requestAttemptAcceptance.requestAttemptAcceptance({
      attemptId: 'att-door-e2e',
      candidateHeadSha: HEAD,
      reviewerModel: 'openrouter/anthropic/claude-sonnet-4.5',
    });
    expect(accept.outcome).toBe('rejected');
    if (accept.outcome === 'rejected') {
      expect(accept.reason).toContain('Acceptance blocked');
    }

    // `forge execute --kind merge-pr` refuses before consuming the grant.
    const forge = await rt.execution.executeAuthorizedForgeAction.executeAuthorizedForgeAction({
      actionId: 'action-door-e2e',
      attemptId: 'att-door-e2e',
      workOrderId: 'wo-att-door-e2e',
      kind: 'merge-pr',
      expectedHeadSha: HEAD,
      authorizationGrantId: grantId,
    });
    expect(forge.outcome).toBe('refused');
    if (forge.outcome === 'refused') {
      expect(forge.reason).toContain(`'${doorRef}' is not approved`);
    }
    const grant =
      await rt.coordination.coordinationRequestRepository.findRequestByGrantId(grantId);
    expect(grant?.consumptions).toHaveLength(0);
    });
  });
});