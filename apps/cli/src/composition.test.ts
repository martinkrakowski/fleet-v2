import { describe, expect, it } from 'vitest';
import {
  createFleetCliRuntime,
  forgeActionScope,
  consumptionId,
  observationEventKind,
  assessmentIdForAttempt,
  buildGhChildEnvironment,
} from './composition.js';
import { buildMergeGhChildEnv, composeExecutionHosts } from './composition/work-execution-hosts.js';
import { composeEvidence } from './composition/evidence.js';
import type { CoordinationRequestRecord } from '@fleet/operator-coordination';
import type { AttemptRecord, WorkOrderRecord } from '@fleet/work-execution';
import { ForgeActionAdapter, nextAttemptRevision } from '@fleet/work-execution';

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

  describe('WB5b: the merge path saves a merge record', () => {
    it('the composed forge use case is wired with the merge-record and lane-plan stores', () => {
      const rt = createFleetCliRuntime();
      const forgeDeps = (rt.execution.executeAuthorizedForgeAction as unknown as {
        deps?: { mergeRecordRepo?: unknown; lanePlanRepo?: unknown };
      }).deps;
      expect(forgeDeps?.mergeRecordRepo).toBeDefined();
      expect(forgeDeps?.lanePlanRepo).toBeDefined();
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
        implementerModel: 'implementer-mod',
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
        pullRequestNumber: 7,
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
        implementerModel: 'implementer-mod',
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
        pullRequestNumber: 7,
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
        implementerModel: 'implementer-mod',
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
        pullRequestNumber: 7,
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
        implementerModel: 'implementer-mod',
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
    // The attempt was dispatched on a recorded seat, so the acceptance use
    // case can bind the implementer and reach the door re-check.
    const storedAttempt = await rt.execution.attemptRepository.findAttemptById('att-door-e2e');
    await rt.execution.attemptRepository.saveAttempt({
      ...storedAttempt!,
      runner: { kind: 'opencode', remotePort: 0, host: null, agent: null, model: 'seat/implementer', variant: null },
      revision: nextAttemptRevision(storedAttempt!),
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

  describe('DT6a finding 1: child environment strips ambient gh credentials on merge path', () => {
    it('buildMergeGhChildEnv removes ambient tokens and sets GH_CONFIG_DIR', () => {
      const parentEnv: NodeJS.ProcessEnv = {
        PATH: '/usr/local/bin:/usr/bin',
        GH_CONFIG_DIR: '/inherited/config',
        GH_TOKEN: 'ambient-tok-a',
        GITHUB_TOKEN: 'ambient-tok-b',
        GH_ENTERPRISE_TOKEN: 'ambient-tok-c',
        GITHUB_ENTERPRISE_TOKEN: 'ambient-tok-d',
        CUSTOM_VAR: 'preserved-value',
      };
      const child = buildMergeGhChildEnv('/state/gh/merge', parentEnv);

      expect(child.GH_CONFIG_DIR).toBe('/state/gh/merge');
      expect(child.GH_CONFIG_DIR).not.toBe(parentEnv.GH_CONFIG_DIR);
      expect(child.GH_TOKEN).toBeUndefined();
      expect(child.GITHUB_TOKEN).toBeUndefined();
      expect(child.GH_ENTERPRISE_TOKEN).toBeUndefined();
      expect(child.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
      expect(child.PATH).toBe('/usr/local/bin:/usr/bin');
      expect(child.CUSTOM_VAR).toBe('preserved-value');
    });

    it('buildGhChildEnvironment strips ambient tokens when GH_CONFIG_DIR is present', () => {
      const parentEnv: NodeJS.ProcessEnv = {
        PATH: '/usr/bin',
        GH_CONFIG_DIR: '/inherited/config',
        GH_TOKEN: 'ambient-token-1',
        GITHUB_TOKEN: 'ambient-token-2',
        GH_ENTERPRISE_TOKEN: 'ambient-token-3',
        GITHUB_ENTERPRISE_TOKEN: 'ambient-token-4',
      };
      const child = buildGhChildEnvironment(parentEnv, { GH_CONFIG_DIR: '/state/gh/premerge' });

      expect(child).toBeDefined();
      expect(child?.GH_CONFIG_DIR).toBe('/state/gh/premerge');
      expect(child?.GH_CONFIG_DIR).not.toBe(parentEnv.GH_CONFIG_DIR);
      expect(child?.GH_TOKEN).toBeUndefined();
      expect(child?.GITHUB_TOKEN).toBeUndefined();
      expect(child?.GH_ENTERPRISE_TOKEN).toBeUndefined();
      expect(child?.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
      expect(child?.PATH).toBe('/usr/bin');
    });
  });

  describe('DT6a finding 4: timeoutMs is threaded through forgeGhRunner closure to runGhSubprocess', () => {
    it('passes timeoutMs from forgeRead to runGhSubprocess in composeEvidence', async () => {
      const calls: Array<{ args: readonly string[]; timeoutMs?: number }> = [];
      const dummyRunGhSubprocess = async (
        args: readonly string[],
        _candidates?: readonly string[],
        _env?: Record<string, string>,
        timeoutMs?: number,
      ) => {
        calls.push({ args, timeoutMs });
        return { exitCode: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: 'a'.repeat(40) }), stderr: '' };
      };

      const { forgeRead } = composeEvidence({
        roleExecutors: {
          worktree: {} as never,
          orchestrator: {} as never,
          verifier: {} as never,
        },
        forgeMode: 'github',
        installationModel: {
          forge: { mode: 'github', owner: 'fleet', repo: 'fleet-v2' },
        } as never,
        coordination: {} as never,
        runGhSubprocess: dummyRunGhSubprocess,
      });

      await forgeRead.readPullRequest({
        ref: { kind: 'number', number: 42 },
        timeoutMs: 7500,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].timeoutMs).toBe(7500);
    });
  });

  describe('DT6a fix round 3 finding 1: merge-path reads use per-kind identity through real runner closure', () => {
    it('sets GH_CONFIG_DIR and strips ambient tokens for merge-pr and post-status reads, leaving forgeRead unchanged', async () => {
      const calls: Array<{
        args: readonly string[];
        env?: Record<string, string>;
        timeoutMs?: number;
      }> = [];

      const dummyRunGhSubprocess = async (
        args: readonly string[],
        _candidates?: readonly string[],
        env?: Record<string, string>,
        timeoutMs?: number,
      ) => {
        calls.push({ args, env, timeoutMs });
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            number: 101,
            state: 'OPEN',
            headRefOid: makeHeadH(),
            headRefName: 'feature-branch',
            baseRefName: 'main',
            mergedAt: null,
            closedAt: null,
            mergeCommit: null,
            mergeStateStatus: 'CLEAN',
          }),
          stderr: '',
        };
      };

      const { forgeRead } = composeEvidence({
        roleExecutors: {
          worktree: {} as never,
          orchestrator: {} as never,
          verifier: {} as never,
        },
        forgeMode: 'github',
        installationModel: {
          forge: { mode: 'github', owner: 'fleet', repo: 'fleet-v2' },
        } as never,
        coordination: {} as never,
        runGhSubprocess: dummyRunGhSubprocess,
      });

      const { forgeAction } = composeExecutionHosts({
        options: {
          env: {
            FLEET_GH_CONFIG_MERGE: '/state/gh/merger-identity',
            FLEET_GH_CONFIG_PREMERGE: '/state/gh/premerge-identity',
            GH_TOKEN: 'ambient-token-secret',
            GITHUB_TOKEN: 'ambient-github-token',
            GH_ENTERPRISE_TOKEN: 'ambient-ent-token',
            GITHUB_ENTERPRISE_TOKEN: 'ambient-ent-gh-token',
          },
        },
        roleExecutors: {
          worktree: {} as never,
          orchestrator: {} as never,
          verifier: {} as never,
        },
        reviewLocatorRef: { locator: undefined },
        runnerProfile: undefined as never,
        executorForHostName: () => ({ ok: false, reason: 'none' }),
        runGhSubprocess: dummyRunGhSubprocess,
        ghBinaryCandidates: ['/usr/bin/gh'],
        forgeRead,
        forgeGithubSection: { mode: 'github', owner: 'fleet', repo: 'fleet-v2' },
        forgeActionOverrides: () => ({}),
        readGitHeadOverSsh: async () => makeHeadH(),
        readGitHeadLocally: async () => makeHeadH(),
        readGitHead: async () => makeHeadH(),
        headRouteForExecutor: () => ({ route: 'local' }),
        runGitCommand: async () => '',
      });

      // 1. merge-pr read path: runs gh pr view using merger identity
      const mergeResult = await forgeAction.performMergeForgeAction({
        kind: 'merge-pr',
        actionId: 'act-merge-read-test',
        repository: { owner: 'fleet', repo: 'fleet-v2' },
        pullRequestNumber: 101,
        branchName: 'feature-branch',
        expectedHeadSha: makeHeadH(),
        deadlineIso: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(mergeResult.outcome).toBe('executed');

      const mergePrViewCall = calls.find(
        (c) => c.args[0] === 'pr' && c.args[1] === 'view' && c.args[2] === '101',
      );
      expect(mergePrViewCall).toBeDefined();
      expect(mergePrViewCall?.env?.GH_CONFIG_DIR).toBe('/state/gh/merger-identity');
      expect(mergePrViewCall?.env?.GH_TOKEN).toBeUndefined();
      expect(mergePrViewCall?.env?.GITHUB_TOKEN).toBeUndefined();
      expect(mergePrViewCall?.env?.GH_ENTERPRISE_TOKEN).toBeUndefined();
      expect(mergePrViewCall?.env?.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();

      // 2. post-status read path: runs gh pr view using premerge identity
      calls.length = 0;
      const statusResult = await forgeAction.performMergeForgeAction({
        kind: 'post-status',
        actionId: 'act-status-read-test',
        repository: { owner: 'fleet', repo: 'fleet-v2' },
        pullRequestNumber: 101,
        branchName: 'feature-branch',
        expectedHeadSha: makeHeadH(),
        deadlineIso: new Date(Date.now() + 60_000).toISOString(),
        status: {
          context: 'premerge',
          state: 'success',
          description: 'pre-merge receipt recorded',
        },
      });
      expect(statusResult.outcome).toBe('executed');

      const statusPrViewCall = calls.find(
        (c) => c.args[0] === 'pr' && c.args[1] === 'view' && c.args[2] === '101',
      );
      expect(statusPrViewCall).toBeDefined();
      expect(statusPrViewCall?.env?.GH_CONFIG_DIR).toBe('/state/gh/premerge-identity');
      expect(statusPrViewCall?.env?.GH_TOKEN).toBeUndefined();
      expect(statusPrViewCall?.env?.GITHUB_TOKEN).toBeUndefined();

      // 3. Shared forgeRead: unchanged for other callers (no GH_CONFIG_DIR, env undefined)
      calls.length = 0;
      await forgeRead.readPullRequest({
        ref: { kind: 'number', number: 101 },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].env).toBeUndefined();
    });
  });

  describe('DT6a fix round 3 finding 2: refuse non-positive or non-integer pullRequestNumber before any call', () => {
    it.each([0, -1, 1.5, NaN])(
      'refuses merge action when pullRequestNumber is %s before any gh call',
      async (invalidPrNumber) => {
        let ghCalled = false;
        const dummyRunGh = async () => {
          ghCalled = true;
          return { exitCode: 0, stdout: '', stderr: '' };
        };

        const adapter = new ForgeActionAdapter(
          { runGh: dummyRunGh },
          undefined,
          {
            mergeGhConfigDir: '/state/gh/merge',
            premergeGhConfigDir: '/state/gh/premerge',
          },
        );

        const result = await adapter.performMergeForgeAction({
          kind: 'merge-pr',
          actionId: 'act-invalid-pr-number',
          repository: { owner: 'fleet', repo: 'fleet-v2' },
          pullRequestNumber: invalidPrNumber,
          branchName: 'feature/dt6a-fix',
          expectedHeadSha: makeHeadH(),
          deadlineIso: new Date(Date.now() + 60_000).toISOString(),
        });

        expect(result.outcome).toBe('refused');
        if (result.outcome === 'refused') {
          expect(result.reason).toContain(`Invalid pull request number: ${invalidPrNumber}`);
          expect(result.refusalKind).toBe('other');
        }
        expect(ghCalled).toBe(false);
      },
    );
  });
});
