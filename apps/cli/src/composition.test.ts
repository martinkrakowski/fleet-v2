import { describe, expect, it, afterAll, afterEach, beforeEach } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, promises as fs, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  createFleetCliRuntime,
  forgeActionScope,
  consumptionId,
  observationEventKind,
  assessmentIdForAttempt,
  buildGhChildEnvironment,
} from './composition.js';
import {
  buildMergeGhChildEnv,
  composeExecutionHosts,
  findAttemptForReview,
  MAX_BRIEF_ATTEMPT_ID_LENGTH,
  MAX_BRIEF_ATTEMPTS_READ,
} from './composition/work-execution-hosts.js';
import { composeEvidence } from './composition/evidence.js';
import type { CoordinationRequestRecord } from '@fleet/operator-coordination';
import {
  approvedAnswerFields,
  ephemeralOwnerKey,
  expectApprovedAnswerReadableThrough,
  writeSignedAnswer,
} from './__tests__/signed-decision-fixture.js';
import { coordinationCommands } from './commands/coordination.js';
import type {
  AttemptRecord,
  PreparePullRequestFeedbackFixRequest,
  PushPullRequestFeedbackFixRequest,
  WorkOrderRecord,
} from '@fleet/work-execution';
import {
  ForgeActionAdapter,
  LaneRun,
  buildArtifactManifest,
  computeBriefPackageDigest,
  laneRunConductEntry,
  nextAttemptRevision,
  serializeArtifactManifest,
  type LaneRunRecord,
  type SubprocessRunner,
} from '@fleet/work-execution';
import { assessmentIdForBrief, attemptIdForBrief } from '@fleet/evidence-and-acceptance';
import type { FleetInstallation } from '@fleet/installation';

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
  // KEY0c1b: every runtime in this file that seeds an approved owner grant
  // pins this ephemeral in-process key and reads its signed answers through
  // the runtime's own decision transport. The KEY0b section below pins its
  // own keys and is untouched.
  const ownerKey = ephemeralOwnerKey();
  const fixtureStateDir = mkdtempSync(path.join(tmpdir(), 'fleet-comp-fixtures-'));
  afterAll(() => {
    rmSync(fixtureStateDir, { recursive: true, force: true });
  });

  /** Pins the ephemeral owner key on a runtime under test. */
  function pinnedRuntime(
    options: Omit<Parameters<typeof createFleetCliRuntime>[0], 'ownerPublicKey'> = {},
  ): ReturnType<typeof createFleetCliRuntime> {
    return createFleetCliRuntime({ ...options, ownerPublicKey: ownerKey.ownerPublicKey });
  }

  /**
   * Saves one coordination request and, for an `approved` owner grant, writes
   * its correctly signed answer under the pinned ephemeral key, then reads it
   * back through the runtime's own decision transport.
   */
  async function seedRequest(
    rt: ReturnType<typeof createFleetCliRuntime>,
    record: CoordinationRequestRecord,
    stateDir: string = fixtureStateDir,
  ): Promise<void> {
    await rt.coordination.coordinationRequestRepository.saveRequest(record);
    if (record.state !== 'approved' || record.policyGrant || record.shadowImportGrant) {
      return;
    }
    const fields = approvedAnswerFields(record);
    writeSignedAnswer(stateDir, fields, ownerKey);
    await expectApprovedAnswerReadableThrough(rt.coordination.decisionTransport, fields);
  }

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
      const rt = pinnedRuntime({ stateDir: fixtureStateDir });
      const forgeDeps = (rt.execution.executeAuthorizedForgeAction as unknown as {
        deps?: { mergeRecordRepo?: unknown; lanePlanRepo?: unknown };
      }).deps;
      expect(forgeDeps?.mergeRecordRepo).toBeDefined();
      expect(forgeDeps?.lanePlanRepo).toBeDefined();
    });
  });

  describe('H7: end-to-end grant action scope check at consumption', () => {
    it('a grant for push-and-open-pr at head H cannot be consumed for merge-pr at H', async () => {
      const rt = pinnedRuntime({ stateDir: fixtureStateDir });
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
      await seedRequest(rt, pushGrant);

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

      // WB5b2: the typed completed entry confirms number 7, so the request reaches
      // the grant check this test is about.
      await rt.execution.executionJournal.appendJournalEntry({
        id: 'forge:action-open:completed:1',
        attemptId,
        workOrderId,
        action: 'forge',
        status: 'completed',
        baseCommit: headH,
        recordedAtIso: '2026-10-15T09:00:00Z',
        sessionId: null,
        detail: null,
        pullRequest: { repository: 'org/repo', number: 7 },
      });
      (rt.execution.executeAuthorizedForgeAction as unknown as {
        deps: { forgePort: { boundRepository?: unknown } };
      }).deps.forgePort.boundRepository = () => ({ owner: 'org', repo: 'repo' });
      (rt.execution.executeAuthorizedForgeAction as unknown as { deps: { forgeRead?: unknown } }).deps.forgeRead = {
        readPullRequest: async () => ({
          outcome: 'found',
          pullRequest: {
            number: 7,
            state: 'open',
            mergeState: 'clean',
            headSha: headH,
            headRef: 'feat/lane-cli-test',
            isCrossRepository: false,
            headRepositoryOwner: 'org',
baseRef: 'main',
            mergedAtIso: null,
            closedAtIso: null,
            mergeCommitSha: null,
          },
        }),
      };

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
      const rt = pinnedRuntime({ stateDir: fixtureStateDir });
      const headH = makeHeadH();
      const workOrderId = 'wo-m12-stale';
      const attemptId = 'att-m12-stale';
      const grantId = 'grant-m12-stale';

      await rt.execution.workOrderRepository.saveWorkOrder(makeWorkOrder(workOrderId, headH));
      await rt.execution.attemptRepository.saveAttempt(
        makeAttempt(attemptId, workOrderId, headH, []),
      );

      const mergeGrant = makeApprovedGrant(grantId, forgeActionScope('merge-pr'), headH);
      await seedRequest(rt, mergeGrant);

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
      const rt = pinnedRuntime({ stateDir: fixtureStateDir });
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
      await seedRequest(rt, mergeGrant);

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
      const rt = pinnedRuntime({ stateDir: fixtureStateDir });
      const assessmentId = assessmentIdForAttempt(attemptId);
      const workOrderId = `wo-${attemptId}`;
      await rt.execution.workOrderRepository.saveWorkOrder(makeWorkOrder(workOrderId, HEAD));
      await rt.execution.attemptRepository.saveAttempt(
        makeAttempt(attemptId, workOrderId, HEAD, options.doors === null ? undefined : (options.doors ?? [])),
      );
      if (options.decision !== undefined) {
        await seedRequest(rt, options.decision);
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
    await seedRequest(rt, makeApprovedGrant(grantId, forgeActionScope('merge-pr'), HEAD));

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
            isCrossRepository: false,
            headRepositoryOwner: { login: 'org' },
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

  describe('CO24comp: PreparePullRequestFeedbackFixUseCase in CLI composition', () => {
    const HEAD = '1111111111111111111111111111111111111111';
    const FIXED_HEAD = '2222222222222222222222222222222222222222';
    const KEY = 'pr-feedback/7@111111111111';
    const FIX_ATTEMPT_ID = 'pr-feedback-7-111111111111';
    const BRANCH = 'feat/lane-cli-test';
    const WORK_ORDER_ID = 'wo-co24-1';
    const PRIOR_ATTEMPT_ID = 'att-co24-init';
    const GRANT_ID = 'grant-co24-push';

    const co24Installation: FleetInstallation = {
      schemaVersion: 2,
      forge: { mode: 'github', owner: 'org', repo: 'repo' },
      hosts: {
        'host-1': {
          transport: 'local',
          worktreeRoot: '/tmp/worktrees',
          roles: ['orchestrator', 'lane-runner', 'verifier'],
        },
      },
    };

    /** The gh stub state: which calls were made, the PR's head on the forge, and the graphql answer mode. */
    interface Co24GhState {
      graphqlCalls: number;
      viewCalls: number;
      currentPrHead: string;
      graphqlMode: 'ok' | 'exit-fail' | 'garbage';
    }

    function co24GhStub(state: Co24GhState) {
      return async (args: readonly string[]) => {
        if (args[0] === 'api' && args[1] === 'graphql') {
          state.graphqlCalls += 1;
          if (state.graphqlMode === 'exit-fail') {
            return { exitCode: 1, stdout: '', stderr: 'gh api graphql failed' };
          }
          if (state.graphqlMode === 'garbage') {
            return { exitCode: 0, stdout: 'not json at all', stderr: '' };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    state: 'OPEN',
                    headRefOid: state.currentPrHead,
                    headRefName: BRANCH,
                    headRepository: { name: 'repo', owner: { login: 'org' } },
                    reviewThreads: {
                      totalCount: 2,
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [
                        {
                          id: 'PRRT_unresolved',
                          isResolved: false,
                          path: 'src/widget.ts',
                          line: 12,
                          comments: {
                            nodes: [{ body: 'Rename this.', author: { __typename: 'User' } }],
                          },
                        },
                        {
                          id: 'PRRT_resolved',
                          isResolved: true,
                          path: 'src/other.ts',
                          line: null,
                          comments: {
                            nodes: [{ body: 'Done.', author: { __typename: 'Bot' } }],
                          },
                        },
                      ],
                    },
                  },
                },
              },
            }),
            stderr: '',
          };
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          state.viewCalls += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              number: 7,
              state: 'OPEN',
              headRefOid: state.currentPrHead,
              headRefName: BRANCH,
              baseRefName: 'main',
              mergedAt: null,
              closedAt: null,
              mergeCommit: null,
              mergeStateStatus: 'CLEAN',
              isCrossRepository: false,
              headRepositoryOwner: { login: 'org' },
            }),
            stderr: '',
          };
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected gh invocation' };
      };
    }

    function prepareRequest(
      overrides: Partial<PreparePullRequestFeedbackFixRequest> = {},
    ): PreparePullRequestFeedbackFixRequest {
      return {
        repository: { owner: 'org', repo: 'repo' },
        pullRequestNumber: 7,
        headSha: HEAD,
        branchName: BRANCH,
        workOrderId: WORK_ORDER_ID,
        priorAttemptId: PRIOR_ATTEMPT_ID,
        ...overrides,
      };
    }

    function pushRequest(
      overrides: Partial<PushPullRequestFeedbackFixRequest> = {},
    ): PushPullRequestFeedbackFixRequest {
      return {
        repository: { owner: 'org', repo: 'repo' },
        pullRequestNumber: 7,
        branchName: BRANCH,
        expectedHeadSha: HEAD,
        fixedHeadSha: FIXED_HEAD,
        workOrderId: WORK_ORDER_ID,
        attemptId: FIX_ATTEMPT_ID,
        grantId: GRANT_ID,
        ...overrides,
      };
    }

    it('prepares a fix attempt in attemptRepository from gh api graphql findings and returns already-prepared on replay', async () => {
      const gh = { graphqlCalls: 0, viewCalls: 0, currentPrHead: HEAD, graphqlMode: 'ok' as const };
      const rt = createFleetCliRuntime({ installation: co24Installation, forgeGhRunner: co24GhStub(gh) });
      await rt.execution.workOrderRepository.saveWorkOrder(makeWorkOrder(WORK_ORDER_ID, HEAD));
      await rt.execution.attemptRepository.saveAttempt(makeAttempt(PRIOR_ATTEMPT_ID, WORK_ORDER_ID, HEAD));

      const first = await rt.execution.preparePullRequestFeedbackFix.preparePullRequestFeedbackFix(prepareRequest());
      expect(first).toEqual({ outcome: 'prepared', key: KEY, fixAttemptId: FIX_ATTEMPT_ID, findingCount: 1 });

      const stored = await rt.execution.attemptRepository.findAttemptById(FIX_ATTEMPT_ID);
      expect(stored).not.toBeNull();
      expect(stored?.kind).toBe('fix');
      expect(stored?.fixNumber).toBe(1);
      expect(stored?.priorAttemptId).toBe(PRIOR_ATTEMPT_ID);
      expect(stored?.state).toBe('intent-recorded');

      const replay = await rt.execution.preparePullRequestFeedbackFix.preparePullRequestFeedbackFix(prepareRequest());
      expect(replay).toEqual({ outcome: 'already-prepared', key: KEY, fixAttemptId: FIX_ATTEMPT_ID, findingCount: 1 });
      expect(gh.graphqlCalls).toBe(2);
      expect(gh.viewCalls).toBe(0);
    });

    it('pushes the fixed head through ExecuteAuthorizedForgeActionUseCase, consumes the push-to-pr grant, journals completion, and returns already-pushed on replay', async () => {
      const gh = { graphqlCalls: 0, viewCalls: 0, currentPrHead: HEAD, graphqlMode: 'ok' as const };
      const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-comp-co24-push-'));
      const rt = createFleetCliRuntime({
        stateDir,
        installation: co24Installation,
        ownerPublicKey: ownerKey.ownerPublicKey,
        forgeGhRunner: co24GhStub(gh),
        forgeActionDelegate: {
          verifyCurrentHeadSha: async () => {
            // The fix head lands on the forge when the push runs: the pr view
            // read after this verification shows the fixed head.
            gh.currentPrHead = FIXED_HEAD;
            return FIXED_HEAD;
          },
        },
      });
      await rt.execution.workOrderRepository.saveWorkOrder(makeWorkOrder(WORK_ORDER_ID, HEAD));
      await rt.execution.attemptRepository.saveAttempt(makeAttempt(PRIOR_ATTEMPT_ID, WORK_ORDER_ID, HEAD));
      await rt.execution.attemptRepository.saveAttempt({
        ...makeAttempt(FIX_ATTEMPT_ID, WORK_ORDER_ID, FIXED_HEAD, []),
        kind: 'fix',
        fixNumber: 1,
        priorAttemptId: PRIOR_ATTEMPT_ID,
      });
      await seedRequest(rt, {
        ...makeApprovedGrant(GRANT_ID, forgeActionScope('push-to-pr'), FIXED_HEAD),
        grantRecordVersion: 2,
        grantAttemptId: FIX_ATTEMPT_ID,
      }, stateDir);

      const first = await rt.execution.preparePullRequestFeedbackFix.pushPullRequestFeedbackFix(pushRequest());
      expect(first).toEqual({ outcome: 'pushed', key: KEY, headSha: FIXED_HEAD });

      const grant = await rt.coordination.coordinationRequestRepository.findRequestByGrantId(GRANT_ID);
      expect(grant?.consumptions).toHaveLength(1);
      expect(grant?.consumptions[0]?.actionId).toBe(KEY);

      const statuses = (await rt.execution.executionJournal.listJournalEntriesForAttempt(FIX_ATTEMPT_ID)).map(
        (entry) => entry.status,
      );
      expect(statuses).toEqual(['intent-recorded', 'completed']);

      const replay = await rt.execution.preparePullRequestFeedbackFix.pushPullRequestFeedbackFix(pushRequest());
      expect(replay).toEqual({ outcome: 'already-pushed', key: KEY, headSha: FIXED_HEAD });
    });

    it('refuses malformed requests with invalid-request before calling gh or touching stores', async () => {
      const gh = { graphqlCalls: 0, viewCalls: 0, currentPrHead: HEAD, graphqlMode: 'ok' as const };
      const rt = createFleetCliRuntime({ installation: co24Installation, forgeGhRunner: co24GhStub(gh) });
      await rt.execution.workOrderRepository.saveWorkOrder(makeWorkOrder(WORK_ORDER_ID, HEAD));
      await rt.execution.attemptRepository.saveAttempt(makeAttempt(PRIOR_ATTEMPT_ID, WORK_ORDER_ID, HEAD));

      const badNumber = await rt.execution.preparePullRequestFeedbackFix.preparePullRequestFeedbackFix(
        prepareRequest({ pullRequestNumber: 0 }),
      );
      expect(badNumber).toEqual({ outcome: 'refused', code: 'invalid-request' });

      const badHead = await rt.execution.preparePullRequestFeedbackFix.preparePullRequestFeedbackFix(
        prepareRequest({ headSha: 'not-a-head-sha' }),
      );
      expect(badHead).toEqual({ outcome: 'refused', code: 'invalid-request' });

      const badPush = await rt.execution.preparePullRequestFeedbackFix.pushPullRequestFeedbackFix(
        pushRequest({ attemptId: 'attempt-not-derived' }),
      );
      expect(badPush).toEqual({ outcome: 'refused', key: null, headSha: null, code: 'invalid-request' });

      expect(gh.graphqlCalls).toBe(0);
      expect(gh.viewCalls).toBe(0);
      expect(await rt.execution.attemptRepository.listAttemptsByWorkOrder(WORK_ORDER_ID)).toHaveLength(1);
    });

    it('refuses with repository-mismatch when the request names another repository or forge mode is not github', async () => {
      const gh = { graphqlCalls: 0, viewCalls: 0, currentPrHead: HEAD, graphqlMode: 'ok' as const };
      const rt = createFleetCliRuntime({ installation: co24Installation, forgeGhRunner: co24GhStub(gh) });

      const other = await rt.execution.preparePullRequestFeedbackFix.preparePullRequestFeedbackFix(
        prepareRequest({ repository: { owner: 'other', repo: 'repo' } }),
      );
      expect(other).toEqual({ outcome: 'refused', code: 'repository-mismatch' });
      const otherPush = await rt.execution.preparePullRequestFeedbackFix.pushPullRequestFeedbackFix(
        pushRequest({ repository: { owner: 'other', repo: 'repo' } }),
      );
      expect(otherPush).toEqual({ outcome: 'refused', key: KEY, headSha: FIXED_HEAD, code: 'repository-mismatch' });

      const unconfigured = createFleetCliRuntime();
      const none = await unconfigured.execution.preparePullRequestFeedbackFix.preparePullRequestFeedbackFix(prepareRequest());
      expect(none).toEqual({ outcome: 'refused', code: 'repository-mismatch' });

      expect(gh.graphqlCalls).toBe(0);
      expect(gh.viewCalls).toBe(0);
    });

    it('refuses push with grant-missing and makes no gh call when grantId is blank', async () => {
      const gh = { graphqlCalls: 0, viewCalls: 0, currentPrHead: HEAD, graphqlMode: 'ok' as const };
      const rt = createFleetCliRuntime({ installation: co24Installation, forgeGhRunner: co24GhStub(gh) });
      for (const grantId of [undefined, '', '   ']) {
        const request = { ...pushRequest() } as Record<string, unknown>;
        if (grantId === undefined) {
          delete request.grantId;
        } else {
          request.grantId = grantId;
        }
        const result = await rt.execution.preparePullRequestFeedbackFix.pushPullRequestFeedbackFix(
          request as unknown as PushPullRequestFeedbackFixRequest,
        );
        expect(result).toEqual({ outcome: 'refused', key: KEY, headSha: FIXED_HEAD, code: 'grant-missing' });
      }
      expect(gh.graphqlCalls).toBe(0);
      expect(gh.viewCalls).toBe(0);
    });

    it('refuses with forge-unreadable when gh api graphql fails or returns malformed JSON', async () => {
      for (const mode of ['exit-fail', 'garbage'] as const) {
        const gh = { graphqlCalls: 0, viewCalls: 0, currentPrHead: HEAD, graphqlMode: mode };
        const rt = createFleetCliRuntime({ installation: co24Installation, forgeGhRunner: co24GhStub(gh) });
        const prepared = await rt.execution.preparePullRequestFeedbackFix.preparePullRequestFeedbackFix(prepareRequest());
        expect(prepared).toEqual({ outcome: 'refused', code: 'forge-unreadable' });
        expect(gh.graphqlCalls).toBe(1);
      }
    });

    it('refuses with head-moved when the pull request head on the forge does not match expectedHeadSha', async () => {
      const gh = { graphqlCalls: 0, viewCalls: 0, currentPrHead: FIXED_HEAD, graphqlMode: 'ok' as const };
      const rt = createFleetCliRuntime({ installation: co24Installation, forgeGhRunner: co24GhStub(gh) });
      await rt.execution.workOrderRepository.saveWorkOrder(makeWorkOrder(WORK_ORDER_ID, HEAD));
      await rt.execution.attemptRepository.saveAttempt(makeAttempt(PRIOR_ATTEMPT_ID, WORK_ORDER_ID, HEAD));

      const prepared = await rt.execution.preparePullRequestFeedbackFix.preparePullRequestFeedbackFix(prepareRequest());
      expect(prepared).toEqual({ outcome: 'refused', code: 'head-moved' });
      expect(gh.graphqlCalls).toBe(1);
    });

    it('refuses with fix-attempt-refused when the prior attempt is not recorded in attemptRepository', async () => {
      const gh = { graphqlCalls: 0, viewCalls: 0, currentPrHead: HEAD, graphqlMode: 'ok' as const };
      const rt = createFleetCliRuntime({ installation: co24Installation, forgeGhRunner: co24GhStub(gh) });
      await rt.execution.workOrderRepository.saveWorkOrder(makeWorkOrder(WORK_ORDER_ID, HEAD));

      const result = await rt.execution.preparePullRequestFeedbackFix.preparePullRequestFeedbackFix(prepareRequest());
      expect(result).toEqual({ outcome: 'refused', code: 'fix-attempt-refused', detail: 'prior-not-found' });
      expect(gh.graphqlCalls).toBe(1);
      expect(await rt.execution.attemptRepository.findAttemptById(FIX_ATTEMPT_ID)).toBeNull();
    });

    it('refuses push with grant-refused and leaves the grant unconsumed when the grant scope or head does not match push-to-pr', async () => {
      const gh = { graphqlCalls: 0, viewCalls: 0, currentPrHead: HEAD, graphqlMode: 'ok' as const };
      const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-comp-co24-refuse-'));
      const rt = createFleetCliRuntime({
        stateDir,
        installation: co24Installation,
        ownerPublicKey: ownerKey.ownerPublicKey,
        forgeGhRunner: co24GhStub(gh),
        forgeActionDelegate: {
          verifyCurrentHeadSha: async () => {
            gh.currentPrHead = FIXED_HEAD;
            return FIXED_HEAD;
          },
        },
      });
      await rt.execution.workOrderRepository.saveWorkOrder(makeWorkOrder(WORK_ORDER_ID, HEAD));
      await rt.execution.attemptRepository.saveAttempt(makeAttempt(PRIOR_ATTEMPT_ID, WORK_ORDER_ID, HEAD));
      await rt.execution.attemptRepository.saveAttempt({
        ...makeAttempt(FIX_ATTEMPT_ID, WORK_ORDER_ID, FIXED_HEAD, []),
        kind: 'fix',
        fixNumber: 1,
        priorAttemptId: PRIOR_ATTEMPT_ID,
      });
      for (const variant of [
        // A grant for another action kind at the fixed head.
        { grantId: 'grant-co24-wrong-scope', actionScope: forgeActionScope('push-and-open-pr'), head: FIXED_HEAD },
        // A push-to-pr grant scoped to another head.
        { grantId: 'grant-co24-wrong-head', actionScope: forgeActionScope('push-to-pr'), head: HEAD },
      ]) {
        await seedRequest(rt, {
          ...makeApprovedGrant(variant.grantId, variant.actionScope, variant.head),
          grantRecordVersion: 2,
          grantAttemptId: FIX_ATTEMPT_ID,
        }, stateDir);
        const result = await rt.execution.preparePullRequestFeedbackFix.pushPullRequestFeedbackFix(
          pushRequest({ grantId: variant.grantId }),
        );
        expect(result).toEqual({ outcome: 'refused', key: KEY, headSha: FIXED_HEAD, code: 'grant-refused' });
        const stored = await rt.coordination.coordinationRequestRepository.findRequestByGrantId(variant.grantId);
        expect(stored?.consumptions).toHaveLength(0);
        expect(stored?.state).toBe('approved');
      }
    });
  });
});

/**
 * The fixture's pass reads run through the real `WorkspaceAdapter`, which
 * shells out to git and df. Under the parallel vitest load of the full CLI
 * suite a subprocess read intermittently fails to report an exit code, and the
 * reaper correctly treats that as an unknown (reads incomplete — findings stay
 * open, closures are skipped), exactly as the unit tests pin down. This helper
 * re-runs the pass when it reports one of those transient read failures, so
 * the end-to-end happy path is asserted without depending on the host's load.
 * The unknown-handling semantics themselves are covered by the unit tests; a
 * persistent failure still surfaces after the retries are exhausted.
 */
const TRANSIENT_REAP_READ_REASONS: ReadonlySet<string> = new Set([
  'worktree-list-unreadable',
  'worktree-unreadable',
  'disk-unreadable',
  'runs-unreadable',
  'journal-unreadable',
  'profiles-unreadable',
  'forge-unreadable',
  'halt-unreadable',
  'merge-records-unreadable',
  'attention-unreadable',
  // A pass whose outbound calls ran past the pass budget under host load:
  // the next attempt starts a fresh budget.
  'pass-budget',
]);

async function reapPassRobust<Req, Res extends { readonly unknown: readonly { readonly reason?: unknown }[] }>(
  pass: (request: Req) => Promise<Res>,
  request: Req,
): Promise<Res> {
  let last!: Res;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    last = await pass(request);
    const transient = last.unknown.some((entry) =>
      typeof entry.reason === 'string' ? TRANSIENT_REAP_READ_REASONS.has(entry.reason) : false,
    );
    // A retry whose pass already acted (a merged-worktree removal ran) must
    // not be replaced: a later attempt can no longer see the finding, so its
    // repairs would be empty even though the worktree is gone.
    const acted = (last as { repairs?: readonly { kind?: unknown }[] }).repairs?.some(
      (repair) => (repair as { kind?: unknown } | null)?.kind === 'merged-worktree',
    );
    if (!transient || acted) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return last;
}

describe("conductor reaper merged-worktree repair through production composition (KW4b')", () => {
  const RUN_ID = 'run-01JB000000000000000000000A';
  const OPT_IN_POLICY = { graceMinutes: 5, retentionHours: 0, repairs: { 'merged-worktree': true } };
  const tempStateDirs: string[] = [];
  const execGit = promisify(execFile);

  afterAll(() => {
    for (const dir of tempStateDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    'runs merged-worktree inspection and removal through production composition with read-only git flags and C2-prime sealed manifest',
    async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-reaper-comp-'));
    tempStateDirs.push(stateDir);
    const clonePath = path.join(stateDir, 'clone');
    const wtRoot = path.join(stateDir, 'worktrees');
    await fs.mkdir(clonePath, { recursive: true });
    await fs.mkdir(wtRoot, { recursive: true });

    const git = async (args: readonly string[], cwd = clonePath): Promise<string> => {
      const result = await execGit('git', args, { cwd });
      return String(result.stdout ?? '');
    };
    await git(['init', '-q']);
    await git(['config', 'user.email', 'lane@example.invalid']);
    await git(['config', 'user.name', 'Lane']);
    await fs.writeFile(path.join(clonePath, 'main.txt'), 'main\n');
    await git(['add', '.']);
    await git(['commit', '-q', '-m', 'initial']);
    await git(['branch', '-m', 'main']);
    const MAIN_COMMIT = (await git(['rev-parse', 'HEAD'])).trim();
    await git(['update-ref', 'refs/remotes/origin/main', MAIN_COMMIT]);

    const WT_PATH = path.join(wtRoot, 'wt1');
    await git(['worktree', 'add', '-b', `fleet/${RUN_ID}`, WT_PATH]);

    const attemptId = 'attempt-merged-1';
    const manifestText = serializeArtifactManifest(buildArtifactManifest(attemptId, []));
    const manifestSha = createHash('sha256').update(manifestText).digest('hex');
    const manifestRel = `.lane/artifacts-manifest-${manifestSha.slice(0, 16)}.json`;
    await fs.mkdir(path.join(WT_PATH, '.lane'), { recursive: true });
    await fs.writeFile(path.join(WT_PATH, manifestRel), manifestText);
    await git(['add', '.'], WT_PATH);
    await git(['commit', '-q', '-m', 'sealed manifest'], WT_PATH);
    const HEAD = (await git(['rev-parse', 'HEAD'], WT_PATH)).trim();

    // Simulate the merge: the default branch (and its remote-tracking ref) now
    // contains the worktree's HEAD, so the headOnDefault ancestor fact holds and
    // the worktree reads as merged.
    await git(['update-ref', 'refs/heads/main', HEAD]);
    await git(['update-ref', 'refs/remotes/origin/main', HEAD]);

    // Pass times run after the fixture, so the worktree's last activity is in
    // the past and the `quiet` fact holds with `retentionHours: 0`.
    const startMs = Date.now();
    const isoAt = (offsetMs: number): string => new Date(startMs + offsetMs).toISOString();
    const T0 = isoAt(60_000);
    const T1 = isoAt(7 * 60_000);
    const T2 = isoAt(13 * 60_000);
    const T3 = isoAt(19 * 60_000);

    const installation: FleetInstallation = {
      schemaVersion: 2,
      forge: { mode: 'none' },
      hosts: {
        'host-1': {
          transport: 'local',
          worktreeRoot: wtRoot,
          roles: ['orchestrator', 'lane-runner', 'verifier'],
        },
      },
    };
    // A stub for the runner subprocess: `ocm-run --status` answers idle, so
    // the real ExecutionRunnerAdapter reports the worktree idle.
    const runSubprocess: SubprocessRunner = async (_command, args) => {
      if (args.includes('--status')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected subprocess call' };
    };
    const runtime = createFleetCliRuntime({ stateDir, installation, runSubprocess });

    const registered = await runtime.coordination.registerProjectProfile.execute({
      projectId: 'reaper-project',
      displayName: 'Reaper Project',
      repository: 'https://example.com/reaper.git',
      designatedDispatcherHost: 'host-1',
      policyRevision: 'pol-1',
      maxConcurrentLanes: 2,
      runnerCapabilities: { networkEgressRestricted: true },
      clones: { 'host-1': { path: clonePath, worktreeRoot: wtRoot } },
    });
    expect(registered.outcome).toBe('registered');

    await runtime.execution.attemptRepository.saveAttempt({
      id: attemptId,
      workOrderId: 'wo-reaper-1',
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: WT_PATH,
      baseCommit: MAIN_COMMIT,
      state: 'collected',
      outcome: null,
      briefDigest: 'b'.repeat(64),
      briefPackagePath: '.lane/brief-package',
      sessionId: null,
      completionReceipt: null,
      artifacts: {
        headCommit: HEAD,
        commitsSinceBase: [HEAD],
        collectedArtifactPaths: [],
        notes: 'present',
        manifestPath: manifestRel,
        manifestSha256: manifestSha,
      },
      runner: {
        kind: 'opencode',
        remotePort: null,
        host: null,
        hostName: 'host-1',
        agent: null,
        model: null,
        variant: null,
      },
      createdAtIso: '2026-11-04T12:00:00.000Z',
      updatedAtIso: '2026-11-04T12:00:00.000Z',
    });

    const created = LaneRun.create({
      version: 1,
      runId: RUN_ID,
      workOrderId: 'wo-reaper-1',
      tier: 2,
      seatPlanRef: 'c'.repeat(64),
      cursors: { 'first-pass': 0, fix: null, review: null },
      round: 0,
      attemptIds: [attemptId],
      prNumber: null,
      parked: null,
      parkCount: 0,
      lease: null,
      revision: 1,
      runPolicyRevision: 'pol-1',
      branchName: `fleet/${RUN_ID}`,
    });
    expect(created.success).toBe(true);
    if (!created.success) {
      throw new Error('fixture must be a valid LaneRun record');
    }
    const record: LaneRunRecord = created.value.toRecord();
    expect(await runtime.conductor.laneRunRepository.create(record)).toMatchObject({ outcome: 'saved' });
    expect(
      await runtime.conductor.laneRunJournal.append(
        laneRunConductEntry('01JB0000000000000000000001', RUN_ID, 'merged', T0),
      ),
    ).toMatchObject({ outcome: 'appended' });

    // A merge record whose repository is the lane-run branch answers merged-pr.
    await runtime.execution.mergeRecordRepository.saveMergeRecord({
      schemaVersion: 1,
      repository: `fleet/${RUN_ID}`,
      number: 1,
      headSha: HEAD,
      mergedAtIso: T0,
      firstSeenAtIso: T0,
      source: 'forge-observation',
      merger: 'unknown',
    });

    // The runner for the recorded host answers idle (the stub subprocess would
    // too, but only after resolving a recorded runner port; a local host has
    // none, so the idle answer is stubbed at the runner boundary).
    const origRunnerForAttempt = runtime.execution.runnerForAttempt.runnerForAttempt.bind(runtime.execution.runnerForAttempt);
    runtime.execution.runnerForAttempt.runnerForAttempt = (request) => {
      const resolved = origRunnerForAttempt(request);
      if (!resolved.ok) {
        return resolved;
      }
      return {
        ...resolved,
        runner: {
          ...resolved.runner,
          inspectWorktreeRun: async () => ({ state: 'idle' as const }),
        },
      };
    };
    // The `df` read is load-sensitive under the parallel suite (a spawn under
    // heavy host load intermittently fails) and no assertion here reads the
    // disk-pressure observation, so the filesystem-space read is pinned to a
    // constant `read`; every git-side read stays on the real adapter.
    runtime.execution.workspace.readFilesystemSpace = async () => ({
      outcome: 'read' as const,
      freeBytes: 42_800_000_000,
      totalBytes: 53_700_000_000,
    });
    // The composed reaper's default 15 s per-outbound-call budget bounds one
    // workspace inspection, which fans out into a dozen git subprocesses; on
    // a saturated host (the parallel suite, other lanes building) one
    // inspection can legitimately exceed 15 s. The pass budget itself still
    // bounds the pass, so this test seam only widens the per-call cap.
    (runtime.conductor.reapZombies as unknown as { deps: { storeCallTimeoutMs: number } }).deps.storeCallTimeoutMs = 60_000;
    // Pass 1: the first sighting waits; no repair, the worktree stays.
    const pass1 = await reapPassRobust(
      (request) => runtime.conductor.reapZombies.reapZombies(request),
      { projectId: 'reaper-project', nowIso: T0, policy: OPT_IN_POLICY },
    );
    expect(pass1.outcome).toBe('completed');
    expect(pass1.findings.find((finding) => finding.kind === 'merged-worktree')?.action).toBe('wait');
    expect(pass1.repairs.filter((repair) => repair.kind === 'merged-worktree')).toEqual([]);
    expect(existsSync(WT_PATH)).toBe(true);

    // D-R6: a default policy leaves the worktree on disk (report only).
    const passDefault = await reapPassRobust(
      (request) => runtime.conductor.reapZombies.reapZombies(request),
      { projectId: 'reaper-project', nowIso: T1, policy: {} },
    );
    // The default policy keeps the repair off (D-R6): the worktree stays on
    // disk, and no merged-worktree repair runs. (The default 24 h retention
    // also means a fresh worktree is not `quiet`, so it is not even a report
    // candidate — the D-R6 report-only semantics are covered by the unit test.)
    expect(passDefault.repairs.filter((repair) => repair.kind === 'merged-worktree')).toEqual([]);
    expect(existsSync(WT_PATH)).toBe(true);

    // Pass 2: the opt-in repair removes the link worktree and keeps the branch.
    const pass2 = await reapPassRobust(
      (request) => runtime.conductor.reapZombies.reapZombies(request),
      { projectId: 'reaper-project', nowIso: T2, policy: OPT_IN_POLICY },
    );
    const repair2 = pass2.repairs.find((repair) => repair.kind === 'merged-worktree');
    expect(repair2?.outcome).toBe('completed');
    expect(repair2?.key).toMatch(/^reaper\/[0-9a-f]{12}\/merged-worktree@/);
    expect(pass2.attention.some((entry) => entry.kind === 'merged-worktree')).toBe(true);
    expect(existsSync(WT_PATH)).toBe(false);
    const branches = await git(['branch', '--list', `fleet/${RUN_ID}`]);
    expect(branches.trim()).toContain(`fleet/${RUN_ID}`);
    const held = await runtime.execution.executionJournal.listActiveReservations();
    expect(held.some((reservation) => reservation.attemptId.startsWith('reaper-'))).toBe(false);

    // Pass 3: the finding closes once the worktree is gone.
    const pass3 = await reapPassRobust(
      (request) => runtime.conductor.reapZombies.reapZombies(request),
      { projectId: 'reaper-project', nowIso: T3, policy: OPT_IN_POLICY },
    );
    expect(pass3.outcome).toBe('completed');
    const open = await runtime.conductor.reaperFindingRepository.listOpenFindings();
    expect(open.filter((entry) => entry.finding.kind === 'merged-worktree')).toHaveLength(0);
  },
  420_000,
);
});

const BRIEF_PROJECT_ID = 'proj-brief-co18a3b';
// The end-to-end brief-verify request below binds its `briefText` and its
// `briefManifestRaw` to the digest the subject carries: the frozen-brief
// package digest `computeBriefPackageDigest({ prose, manifestRaw })` computes
// with the SHA-256 function the composition roots inject (`prose + '\n' +
// manifestRaw`). The test package must digest to `BRIEF_DIGEST` or the
// request is refused as a mismatch.
const BRIEF_TEXT = 'Review the frozen brief package for this project.';
const BRIEF_MANIFEST = '{"schemaVersion":2,"attemptId":"attempt-brief-1"}';
const BRIEF_DIGEST = (() => {
  const computed = computeBriefPackageDigest(
    { prose: BRIEF_TEXT, manifestRaw: BRIEF_MANIFEST },
    (content) => createHash('sha256').update(content, 'utf8').digest('hex'),
  );
  if (!computed.ok) {
    throw new Error('the fixture brief package must digest');
  }
  return computed.briefDigest;
})();
const OTHER_DIGEST = 'cd'.repeat(32);
const IMPLEMENTER_MODEL = 'example-provider/glm-5.3';
const REVIEWER_MODEL = 'example-provider/grok-4.7';
const BRIEF_PASS_STREAM =
  '{"type":"step_start","part":{"type":"step-start"}}\n' +
  '{"type":"text","part":{"type":"text","text":"```json\\n{\\"verdict\\":\\"PASS\\",\\"findings\\":[]}\\n```\\n"}}\n' +
  '{"type":"step_finish"}';

/** Malformed `brief:` ids: none of these is `brief:<projectId>:<64 lowercase hex>`. */
const MALFORMED_BRIEF_IDS = [
  'brief:',
  'brief:not-a-digest',
  `brief:${BRIEF_PROJECT_ID}:${'ab'.repeat(31)}`,
  `brief:${BRIEF_PROJECT_ID}:${'AB'.repeat(32)}`,
  `brief:proj/name:${BRIEF_DIGEST}`,
  `brief: ${BRIEF_PROJECT_ID}:${BRIEF_DIGEST}`,
  `brief:${BRIEF_PROJECT_ID}\u0001x:${BRIEF_DIGEST}`,
];

function briefReviewInstallation(repoDir: string): FleetInstallation {
  const seats: NonNullable<FleetInstallation['seats']>[number][] = [
    {
      id: 'implementer',
      tool: 'opencode',
      model: IMPLEMENTER_MODEL,
      agent: 'example-agent',
      roles: ['implementer'],
      costClass: 'plan-quota',
    },
    {
      id: 'reviewer',
      tool: 'opencode',
      model: REVIEWER_MODEL,
      agent: 'example-agent',
      roles: ['reviewer'],
      costClass: 'paid',
    },
  ];
  return {
    schemaVersion: 2,
    hosts: {
      'this-machine': {
        transport: 'local',
        worktreeRoot: repoDir,
        tmpDir: path.join(repoDir, '.tmp'),
        roles: ['orchestrator', 'lane-runner', 'verifier'],
        runner: {
          kind: 'opencode',
          port: 46000,
          capabilities: {
            networkEgressRestricted: false,
            cpuAndMemoryLimited: false,
            processTreeTermination: false,
            filesystemScope: 'inherited-directory',
          },
        },
      },
    },
    tools: ['opencode'],
    seats,
    chains: {
      implementer: [{ seatId: 'implementer' }],
      reviewer: [{ seatId: 'reviewer' }],
    },
    forge: { mode: 'none' },
  };
}

function orderFor(id: string, projectId: string): WorkOrderRecord {
  return { ...makeWorkOrder(id, makeHeadH()), projectId };
}

function recordedAttempt(
  id: string,
  workOrderId: string,
  worktreePath: string,
  briefDigest: string,
  baseCommit: string,
): AttemptRecord {
  return {
    ...makeAttempt(id, workOrderId, baseCommit),
    worktreePath,
    baseCommit,
    briefDigest,
    runner: {
      kind: 'opencode',
      remotePort: 46000,
      host: null,
      hostName: 'this-machine',
      agent: 'example-agent',
      model: IMPLEMENTER_MODEL,
      variant: null,
    },
  };
}

function gitAt(cwd: string, args: readonly string[]): string {
  return String(execFileSync('git', [...args], { cwd, encoding: 'utf8' })).trim();
}

interface BriefLookupLog {
  findIds: string[];
  listed: number;
}

function briefLookup(options: {
  readonly attempts?: readonly AttemptRecord[];
  readonly orders?: ReadonlyMap<string, WorkOrderRecord>;
  readonly list?: () => Promise<readonly AttemptRecord[]>;
  readonly findThrows?: boolean;
}): {
  readonly log: BriefLookupLog;
  readonly attempts: {
    findAttemptById(attemptId: string): Promise<AttemptRecord | null>;
    listAllAttempts(): Promise<readonly AttemptRecord[]>;
  };
  readonly orders: {
    findWorkOrderById(workOrderId: string): Promise<WorkOrderRecord | null>;
  };
} {
  const log: BriefLookupLog = { findIds: [], listed: 0 };
  const orders = options.orders ?? new Map<string, WorkOrderRecord>();
  return {
    log,
    attempts: {
      async findAttemptById(attemptId: string): Promise<AttemptRecord | null> {
        log.findIds.push(attemptId);
        if (options.findThrows === true) {
          throw new Error('findAttemptById must not run');
        }
        return (options.attempts ?? []).find((attempt) => attempt.id === attemptId) ?? null;
      },
      async listAllAttempts(): Promise<readonly AttemptRecord[]> {
        log.listed += 1;
        if (options.list !== undefined) {
          return options.list();
        }
        return options.attempts ?? [];
      },
    },
    orders: {
      async findWorkOrderById(workOrderId: string): Promise<WorkOrderRecord | null> {
        return orders.get(workOrderId) ?? null;
      },
    },
  };
}

describe('CO18a3b brief-verify attempt resolution', () => {
  it(
    'requests, finds and replays a brief-verify review without a second reviewSpawn and leaves attempt acceptance unaffected',
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'fleet-cli-brief-verify-'));
      try {
        const repoDir = path.join(root, 'repo');
        const stateDir = path.join(root, 'state');
        await fs.mkdir(repoDir);
        await fs.mkdir(stateDir);
        gitAt(repoDir, ['init', '-q']);
        gitAt(repoDir, ['config', 'user.email', 'lane@example.invalid']);
        gitAt(repoDir, ['config', 'user.name', 'lane']);
        await fs.writeFile(path.join(repoDir, 'a.txt'), 'one\n');
        gitAt(repoDir, ['add', 'a.txt']);
        gitAt(repoDir, ['commit', '-q', '-m', 'base']);
        const head = gitAt(repoDir, ['rev-parse', 'HEAD']);

        const spawnCalls: Array<{ readonly args: readonly string[] }> = [];
        const runtime = createFleetCliRuntime({
          stateDir,
          installation: briefReviewInstallation(repoDir),
          reviewSpawn: async (_file: string, args: readonly string[]) => {
            spawnCalls.push({ args });
            return { exitCode: 0, stdout: BRIEF_PASS_STREAM, stderr: '' };
          },
        });

        const attemptId = 'attempt-brief-1';
        const briefAttemptId = attemptIdForBrief(BRIEF_PROJECT_ID, BRIEF_DIGEST);
        await runtime.execution.workOrderRepository.saveWorkOrder(orderFor('wo-brief-1', BRIEF_PROJECT_ID));
        await runtime.execution.attemptRepository.saveAttempt(
          recordedAttempt(attemptId, 'wo-brief-1', repoDir, BRIEF_DIGEST, head),
        );

        const acceptanceRequest = {
          assessmentId: assessmentIdForAttempt(attemptId),
          candidateHeadSha: head,
          policyRevision: 'pol-1',
        };
        const before = await runtime.evidence.assessHeadAcceptance.assessHeadAcceptance(acceptanceRequest);
        expect(before).toEqual({ outcome: 'rejected', reason: 'Assessment not found' });

        const review = {
          requestId: 'brief-verify-co18a3b',
          kind: 'brief-verify' as const,
          attemptId: briefAttemptId,
          projectId: BRIEF_PROJECT_ID,
          candidateHeadSha: head,
          subject: {
            kind: 'brief' as const,
            projectId: BRIEF_PROJECT_ID,
            briefPackageDigest: BRIEF_DIGEST,
            baseCommit: head,
          },
          policyRevision: 'pol-1',
          implementerModel: IMPLEMENTER_MODEL,
          reviewerModel: REVIEWER_MODEL,
          briefText: BRIEF_TEXT,
          briefManifestRaw: BRIEF_MANIFEST,
        };
        const requested = await runtime.conductor.reviewRequest.requestReview(review);
        expect(requested).toMatchObject({
          outcome: 'receipt',
          receipt: { kind: 'brief-verify', requestId: review.requestId, verdict: 'passed' },
        });
        expect(spawnCalls).toHaveLength(2);
        const waitSpawn = spawnCalls[0];
        const reviewSpawn = spawnCalls[1];
        if (waitSpawn === undefined || reviewSpawn === undefined) {
          throw new Error('expected the idle wait and the review spawn');
        }
        expect(waitSpawn.args.slice(0, 3)).toEqual(['--wait', '--dir', repoDir]);
        expect(reviewSpawn.args[reviewSpawn.args.indexOf('--dir') + 1]).toBe(repoDir);

        const found = await runtime.conductor.reviewRequest.findReviewReceipt({
          attemptId: briefAttemptId,
          requestId: review.requestId,
          candidateHeadSha: head,
          subject: review.subject,
        });
        expect(found).toMatchObject({
          outcome: 'found',
          receipt: { kind: 'brief-verify', requestId: review.requestId },
        });
        expect(spawnCalls).toHaveLength(2);

        const replayed = await runtime.conductor.reviewRequest.requestReview(review);
        expect(replayed).toMatchObject({
          outcome: 'receipt',
          receipt: { kind: 'brief-verify', requestId: review.requestId },
        });
        expect(spawnCalls).toHaveLength(2);

        const after = await runtime.evidence.assessHeadAcceptance.assessHeadAcceptance(acceptanceRequest);
        expect(after).toEqual(before);
        expect(
          await runtime.evidence.evidenceAssessmentRepository.findAssessmentById(
            assessmentIdForAttempt(attemptId),
          ),
        ).toBeNull();
        const briefAssessment = await runtime.evidence.evidenceAssessmentRepository.findAssessmentById(
          assessmentIdForBrief(BRIEF_PROJECT_ID, BRIEF_DIGEST),
        );
        expect(briefAssessment?.attemptId).toBe(briefAttemptId);
        expect(briefAssessment?.reviewReceipts).toHaveLength(1);
        expect(briefAssessment?.reviewReceipts[0]?.kind).toBe('brief-verify');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    'locate throws when no attempt matches a well-formed brief id and does not fall back to another attempt',
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'fleet-cli-brief-miss-'));
      try {
        const runtime = createFleetCliRuntime({
          installation: briefReviewInstallation(root),
        });
        const briefAttemptId = attemptIdForBrief(BRIEF_PROJECT_ID, BRIEF_DIGEST);
        const storedPath = path.join(root, 'stored');
        await fs.mkdir(storedPath);
        await runtime.execution.workOrderRepository.saveWorkOrder(orderFor('wo-stored', BRIEF_PROJECT_ID));
        // The attempt's own id is the brief id, but its digest is different.
        // findAttemptById of that string must not count as a match.
        await runtime.execution.attemptRepository.saveAttempt(
          recordedAttempt(briefAttemptId, 'wo-stored', storedPath, OTHER_DIGEST, makeHeadH()),
        );

        await expect(runtime.reviewLocator.locate(briefAttemptId)).rejects.toThrow(
          `No attempt is recorded for ${briefAttemptId}`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    'locate throws for a malformed brief id and does not accept an attempt stored under that string',
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'fleet-cli-brief-malformed-'));
      try {
        const runtime = createFleetCliRuntime({
          installation: briefReviewInstallation(root),
        });
        const storedId = MALFORMED_BRIEF_IDS[0] ?? 'brief:';
        const storedPath = path.join(root, 'stored');
        await fs.mkdir(storedPath);
        await runtime.execution.workOrderRepository.saveWorkOrder(orderFor('wo-stored', BRIEF_PROJECT_ID));
        await runtime.execution.attemptRepository.saveAttempt(
          recordedAttempt(storedId, 'wo-stored', storedPath, BRIEF_DIGEST, makeHeadH()),
        );

        for (const attemptId of MALFORMED_BRIEF_IDS) {
          await expect(runtime.reviewLocator.locate(attemptId)).rejects.toThrow(
            `No attempt is recorded for ${attemptId}`,
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    'locate throws when two attempts share the brief digest and project, and still locates an ordinary attempt id',
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'fleet-cli-brief-ambiguous-'));
      try {
        const runtime = createFleetCliRuntime({
          installation: briefReviewInstallation(root),
        });
        const pathA = path.join(root, 'a');
        const pathB = path.join(root, 'b');
        const pathOrdinary = path.join(root, 'ordinary');
        await fs.mkdir(pathA);
        await fs.mkdir(pathB);
        await fs.mkdir(pathOrdinary);
        await runtime.execution.workOrderRepository.saveWorkOrder(orderFor('wo-shared', BRIEF_PROJECT_ID));
        await runtime.execution.attemptRepository.saveAttempt(
          recordedAttempt('attempt-brief-a', 'wo-shared', pathA, BRIEF_DIGEST, makeHeadH()),
        );
        await runtime.execution.attemptRepository.saveAttempt(
          recordedAttempt('attempt-brief-b', 'wo-shared', pathB, BRIEF_DIGEST, makeHeadH()),
        );
        await runtime.execution.attemptRepository.saveAttempt(
          recordedAttempt('attempt-ordinary', 'wo-shared', pathOrdinary, OTHER_DIGEST, makeHeadH()),
        );

        const ordinary = await runtime.reviewLocator.locate('attempt-ordinary');
        expect(ordinary.worktreePath).toBe(pathOrdinary);
        await expect(runtime.reviewLocator.locate(attemptIdForBrief(BRIEF_PROJECT_ID, BRIEF_DIGEST))).rejects.toThrow(
          `No attempt is recorded for ${attemptIdForBrief(BRIEF_PROJECT_ID, BRIEF_DIGEST)}`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    'locate returns the recorded worktree for an ordinary attempt id',
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'fleet-cli-brief-ordinary-'));
      try {
        const runtime = createFleetCliRuntime({
          installation: briefReviewInstallation(root),
        });
        const worktreePath = path.join(root, 'worktree');
        await fs.mkdir(worktreePath);
        const baseCommit = makeHeadH();
        await runtime.execution.workOrderRepository.saveWorkOrder(orderFor('wo-ordinary', BRIEF_PROJECT_ID));
        await runtime.execution.attemptRepository.saveAttempt(
          recordedAttempt('attempt-ordinary', 'wo-ordinary', worktreePath, OTHER_DIGEST, baseCommit),
        );

        const location = await runtime.reviewLocator.locate('attempt-ordinary');
        expect(location.worktreePath).toBe(worktreePath);
        expect(location.baseCommit).toBe(baseCommit);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it('returns null for a null attempt id and does not read the repository', async () => {
    const lookup = briefLookup({ findThrows: true, list: async () => { throw new Error('listed'); } });
    await expect(findAttemptForReview(null, lookup.attempts, lookup.orders)).resolves.toBeNull();
    expect(lookup.log).toEqual({ findIds: [], listed: 0 });
  });

  it('returns null for an undefined attempt id and does not read the repository', async () => {
    const lookup = briefLookup({ findThrows: true, list: async () => { throw new Error('listed'); } });
    await expect(findAttemptForReview(undefined, lookup.attempts, lookup.orders)).resolves.toBeNull();
    expect(lookup.log).toEqual({ findIds: [], listed: 0 });
  });

  it('rejects when the attempt list is a non-iterable store shape instead of reading it as no attempt, and does not iterate it', async () => {
    const head = makeHeadH();
    const match = { ...makeAttempt('attempt-match', 'wo-match', head), briefDigest: BRIEF_DIGEST };
    let iterated = false;
    const list = {
      length: 1,
      0: match,
      [Symbol.iterator](): never {
        iterated = true;
        throw new Error('iterated');
      },
    };
    const lookup = briefLookup({
      findThrows: true,
      orders: new Map([['wo-match', orderFor('wo-match', BRIEF_PROJECT_ID)]]),
      list: async () => list as unknown as readonly AttemptRecord[],
    });

    await expect(
      findAttemptForReview(attemptIdForBrief(BRIEF_PROJECT_ID, BRIEF_DIGEST), lookup.attempts, lookup.orders),
    ).rejects.toThrow('cannot be read');
    expect(iterated).toBe(false);
    expect(lookup.log.listed).toBe(1);
    expect(lookup.log.findIds).toEqual([]);
  });

  it('rejects when listing attempts throws instead of reading the failure as no attempt', async () => {
    const lookup = briefLookup({ findThrows: true, list: async () => { throw new Error('store unavailable'); } });
    await expect(
      findAttemptForReview(attemptIdForBrief(BRIEF_PROJECT_ID, BRIEF_DIGEST), lookup.attempts, lookup.orders),
    ).rejects.toThrow('store unavailable');
    expect(lookup.log.listed).toBe(1);
    expect(lookup.log.findIds).toEqual([]);
  });

  it('rejects when reading the matching attempt work order throws instead of reading the failure as no attempt', async () => {
    const head = makeHeadH();
    const match = { ...makeAttempt('attempt-match', 'wo-match', head), briefDigest: BRIEF_DIGEST };
    const lookup = briefLookup({
      attempts: [match],
      findThrows: true,
      orders: new Map([['wo-match', orderFor('wo-match', BRIEF_PROJECT_ID)]]),
    });
    lookup.orders.findWorkOrderById = async () => {
      throw new Error('work order store unavailable');
    };
    await expect(
      findAttemptForReview(attemptIdForBrief(BRIEF_PROJECT_ID, BRIEF_DIGEST), lookup.attempts, lookup.orders),
    ).rejects.toThrow('work order store unavailable');
    expect(lookup.log.listed).toBe(1);
    expect(lookup.log.findIds).toEqual([]);
  });

  it('returns the one matching attempt when the attempt list has holes', async () => {
    const head = makeHeadH();
    const decoy = { ...makeAttempt('attempt-decoy', 'wo-decoy', head), briefDigest: BRIEF_DIGEST };
    const match = { ...makeAttempt('attempt-match', 'wo-match', head), briefDigest: BRIEF_DIGEST };
    const listed: AttemptRecord[] = [];
    listed[0] = decoy;
    listed[3] = match;
    const lookup = briefLookup({
      attempts: listed,
      findThrows: true,
      orders: new Map([
        ['wo-decoy', orderFor('wo-decoy', 'other-project')],
        ['wo-match', orderFor('wo-match', BRIEF_PROJECT_ID)],
      ]),
    });

    await expect(
      findAttemptForReview(attemptIdForBrief(BRIEF_PROJECT_ID, BRIEF_DIGEST), lookup.attempts, lookup.orders),
    ).resolves.toBe(match);
    expect(lookup.log.findIds).toEqual([]);
  });

  it('returns null for a non-string primitive attempt id and does not read the repository', async () => {
    const lookup = briefLookup({ findThrows: true, list: async () => { throw new Error('listed'); } });
    const values: unknown[] = [1, true, false, 1n, Symbol('attempt')];
    for (const value of values) {
      await expect(findAttemptForReview(value, lookup.attempts, lookup.orders)).resolves.toBeNull();
    }
    expect(lookup.log).toEqual({ findIds: [], listed: 0 });
  });

  it('returns null for an object with throwing getters and does not read the repository', async () => {
    const hostile: object = {};
    for (const key of ['toString', 'startsWith', 'length', 'slice', 'trim']) {
      Object.defineProperty(hostile, key, {
        get() {
          throw new Error(key);
        },
      });
    }
    const lookup = briefLookup({ findThrows: true, list: async () => { throw new Error('listed'); } });
    await expect(findAttemptForReview(hostile, lookup.attempts, lookup.orders)).resolves.toBeNull();
    expect(lookup.log).toEqual({ findIds: [], listed: 0 });
  });

  it('returns null for a Proxy whose traps throw and does not read the repository', async () => {
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error('get');
        },
        ownKeys() {
          throw new Error('ownKeys');
        },
      },
    );
    const lookup = briefLookup({ findThrows: true, list: async () => { throw new Error('listed'); } });
    await expect(findAttemptForReview(proxy, lookup.attempts, lookup.orders)).resolves.toBeNull();
    expect(lookup.log).toEqual({ findIds: [], listed: 0 });
  });

  it('returns null for an array-like with an enormous length and does not read it', async () => {
    let reads = 0;
    const arrayLike = new Proxy(
      { length: Number.MAX_SAFE_INTEGER },
      {
        get(target, prop) {
          reads += 1;
          if (prop === 'length') {
            return target.length;
          }
          throw new Error(`read ${String(prop)}`);
        },
      },
    );
    const lookup = briefLookup({ findThrows: true, list: async () => { throw new Error('listed'); } });
    await expect(findAttemptForReview(arrayLike, lookup.attempts, lookup.orders)).resolves.toBeNull();
    expect(reads).toBe(0);
    expect(lookup.log).toEqual({ findIds: [], listed: 0 });
  });

  it('returns null for prototype-polluting keys, looks the key strings up by attempt id, and does not pollute Object.prototype', async () => {
    const constructorBefore = Object.prototype.constructor;
    const hostile = {};
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      Object.defineProperty(hostile, key, {
        value: { polluted: true },
        enumerable: true,
        configurable: true,
      });
    }
    const lookup = briefLookup({});
    await expect(findAttemptForReview(hostile, lookup.attempts, lookup.orders)).resolves.toBeNull();
    expect(lookup.log).toEqual({ findIds: [], listed: 0 });

    for (const key of ['__proto__', 'constructor', 'prototype']) {
      await expect(findAttemptForReview(key, lookup.attempts, lookup.orders)).resolves.toBeNull();
    }
    expect(lookup.log.findIds).toEqual(['__proto__', 'constructor', 'prototype']);
    expect(lookup.log.listed).toBe(0);
    expect(Object.prototype.constructor).toBe(constructorBefore);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('returns null for a brief id longer than the length cap without listing attempts or calling findAttemptById', async () => {
    const huge = `brief:${'a'.repeat(2_000_000)}:${BRIEF_DIGEST}`;
    expect(huge.length).toBeGreaterThan(MAX_BRIEF_ATTEMPT_ID_LENGTH);
    const lookup = briefLookup({ findThrows: true, list: async () => { throw new Error('listed'); } });
    const started = Date.now();
    await expect(findAttemptForReview(huge, lookup.attempts, lookup.orders)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
    expect(lookup.log).toEqual({ findIds: [], listed: 0 });
  });

  it('returns null for a malformed brief id without calling findAttemptById', async () => {
    // findAttemptById is NOT a throwing stub here: if the locator fell back to
    // it for a malformed `brief:` id, it would return the attempt stored under
    // that very string, and `resolves.toBeNull()` below would fail.
    const lookup = briefLookup({
      attempts: [makeAttempt('brief:', 'wo-stored', makeHeadH())],
    });
    for (const attemptId of MALFORMED_BRIEF_IDS) {
      await expect(findAttemptForReview(attemptId, lookup.attempts, lookup.orders)).resolves.toBeNull();
    }
    expect(lookup.log).toEqual({ findIds: [], listed: 0 });
  });

  it('returns null for attempts stored under the exact ids "brief:" and "brief:" with a malformed digest, and never calls findAttemptById', async () => {
    const malformedDigestId = `brief:${BRIEF_PROJECT_ID}:${'zz'.repeat(32)}`;
    const lookup = briefLookup({
      attempts: [
        makeAttempt('brief:', 'wo-stored', makeHeadH()),
        makeAttempt(malformedDigestId, 'wo-stored', makeHeadH()),
      ],
    });
    await expect(findAttemptForReview('brief:', lookup.attempts, lookup.orders)).resolves.toBeNull();
    await expect(findAttemptForReview(malformedDigestId, lookup.attempts, lookup.orders)).resolves.toBeNull();
    // Spy call count 0: no fallback lookup of either string happened.
    expect(lookup.log.findIds.length).toBe(0);
    expect(lookup.log.findIds).toEqual([]);
    expect(lookup.log.listed).toBe(0);
  });

  it('returns the single attempt whose brief digest and project match', async () => {
    const head = makeHeadH();
    const decoy = { ...makeAttempt('attempt-decoy', 'wo-decoy', head), briefDigest: BRIEF_DIGEST };
    const match = { ...makeAttempt('attempt-match', 'wo-match', head), briefDigest: BRIEF_DIGEST };
    const lookup = briefLookup({
      attempts: [decoy, match],
      findThrows: true,
      orders: new Map([
        ['wo-decoy', orderFor('wo-decoy', 'other-project')],
        ['wo-match', orderFor('wo-match', BRIEF_PROJECT_ID)],
      ]),
    });

    // A constant null fails this test: the matching attempt is returned by identity.
    await expect(
      findAttemptForReview(attemptIdForBrief(BRIEF_PROJECT_ID, BRIEF_DIGEST), lookup.attempts, lookup.orders),
    ).resolves.toBe(match);
    expect(lookup.log.findIds).toEqual([]);
    expect(lookup.log.listed).toBe(1);
  });

  it('returns null when two work orders in one project share the brief digest', async () => {
    const head = makeHeadH();
    const first = { ...makeAttempt('attempt-a', 'wo-a', head), briefDigest: BRIEF_DIGEST };
    const second = { ...makeAttempt('attempt-b', 'wo-b', head), briefDigest: BRIEF_DIGEST };
    const lookup = briefLookup({
      attempts: [first, second],
      findThrows: true,
      orders: new Map([
        ['wo-a', orderFor('wo-a', BRIEF_PROJECT_ID)],
        ['wo-b', orderFor('wo-b', BRIEF_PROJECT_ID)],
      ]),
    });

    await expect(
      findAttemptForReview(attemptIdForBrief(BRIEF_PROJECT_ID, BRIEF_DIGEST), lookup.attempts, lookup.orders),
    ).resolves.toBeNull();
    expect(lookup.log.findIds).toEqual([]);
    expect(lookup.log.listed).toBe(1);
  });

  it('returns null, without throwing, for 4,097 attempts of which exactly one matches, and does not call findAttemptById', async () => {
    const head = makeHeadH();
    const match = { ...makeAttempt('attempt-match', 'wo-match', head), briefDigest: BRIEF_DIGEST };
    const filler = { ...makeAttempt('attempt-filler', 'wo-filler', head), briefDigest: OTHER_DIGEST };
    const listed = Array.from({ length: MAX_BRIEF_ATTEMPTS_READ + 1 }, () => filler);
    listed[0] = match;
    const lookup = briefLookup({
      attempts: listed,
      findThrows: true,
      orders: new Map([['wo-match', orderFor('wo-match', BRIEF_PROJECT_ID)]]),
    });

    // Over the cap the list cannot prove uniqueness, so the result is null,
    // the same as two matches: no throw, and no scan past the cap.
    await expect(
      findAttemptForReview(attemptIdForBrief(BRIEF_PROJECT_ID, BRIEF_DIGEST), lookup.attempts, lookup.orders),
    ).resolves.toBeNull();
    expect(lookup.log.listed).toBe(1);
    expect(lookup.log.findIds).toEqual([]);
  });

  it('returns the attempt findAttemptById records for an ordinary attempt id', async () => {
    const attempt = makeAttempt('attempt-ordinary', 'wo-ordinary', makeHeadH());
    const lookup = briefLookup({ attempts: [attempt] });
    await expect(findAttemptForReview(attempt.id, lookup.attempts, lookup.orders)).resolves.toBe(attempt);
    expect(lookup.log.findIds).toEqual([attempt.id]);
    expect(lookup.log.listed).toBe(0);
  });
});

/**
 * KEY0b: the CLI composition reads the owner public key only from the pinned
 * installation key (or the test-injected pinned fallback). FLEET_OWNER_PUBLIC_KEY
 * is never an authority: a mismatching value refuses, an equal value only warns.
 */
describe('KEY0b: pinned owner public key in the CLI composition root', () => {
  const HEAD = makeHeadH();

  function keyPair(): { publicKeyBase64: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] } {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return {
      publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64'),
      privateKey,
    };
  }

  const pinned = keyPair();
  const other = keyPair();
  // The ambient env key that must never become an authority on its own.
  const envOnly = keyPair();

  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'fleet-key0b-comp-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function awaitingRecord(
    grantId: string,
    scope: string,
    overrides: Partial<CoordinationRequestRecord> = {},
  ): CoordinationRequestRecord {
    return {
      ...makeApprovedGrant(grantId, scope, HEAD),
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
      ...overrides,
    };
  }

  async function writeDecision(
    fields: {
      requestId: string;
      projectId: string;
      actionScope: string;
      expectedHeadSha: string | null;
      decisionRevision: string | null;
      grantId: string | null;
      state: string;
    },
    privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  ): Promise<void> {
    const signature = sign(null, canonicalDecisionBytes(fields), privateKey).toString('base64');
    const decisionsDir = path.join(tempDir, 'decisions');
    if (!existsSync(decisionsDir)) {
      mkdirSync(decisionsDir);
    }
    writeFileSync(
      path.join(decisionsDir, `${fields.requestId}.json`),
      `${JSON.stringify({ ...fields, signature }, null, 2)}\n`,
    );
  }

  function canonicalDecisionBytes(fields: {
    requestId: string;
    projectId: string;
    actionScope: string;
    expectedHeadSha: string | null;
    decisionRevision: string | null;
    grantId: string | null;
    state: string;
  }): Buffer {
    return Buffer.from(
      JSON.stringify({
        requestId: fields.requestId,
        projectId: fields.projectId,
        actionScope: fields.actionScope,
        expectedHeadSha: fields.expectedHeadSha ?? null,
        decisionRevision: fields.decisionRevision ?? null,
        grantId: fields.grantId ?? null,
        state: fields.state,
      }),
      'utf8',
    );
  }

  /** Seeds an awaiting merge grant for org/repo PR 7 with its approved answer on disk. */
  async function seedMergeGrant(
    grantId: string,
    signingKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  ): Promise<CoordinationRequestRecord> {
    const record = awaitingRecord(grantId, 'forge:merge-pr', {
      mergeGrant: { repository: { owner: 'org', repo: 'repo' }, pullRequestNumber: 7 },
    });
    const runtime = createFleetCliRuntime({ stateDir: tempDir });
    await runtime.coordination.coordinationRequestRepository.saveRequest(record);
    await writeDecision(
      {
        requestId: record.id,
        projectId: record.projectId,
        actionScope: record.actionScope,
        expectedHeadSha: record.expectedHeadSha,
        decisionRevision: 'dec-1',
        grantId,
        state: 'approved',
      },
      signingKey,
    );
    return record;
  }

  it('(a) only FLEET_OWNER_PUBLIC_KEY set: a signed approval refuses as owner-key-unpinned', async () => {
    await seedMergeGrant('grant-env-only', envOnly.privateKey);
    const rt = createFleetCliRuntime({
      stateDir: tempDir,
      env: { FLEET_OWNER_PUBLIC_KEY: envOnly.publicKeyBase64 },
    });
    const resolved = await rt.coordination.resolveActionAuthorization.resolveActionAuthorization({
      projectId: 'proj-cli-test',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: HEAD,
      repository: 'org/repo',
      pullRequestNumber: 7,
    });
    expect(resolved).toEqual({ outcome: 'blocked', reason: 'owner-key-unpinned' });
  });

  it('(b) FLEET_OWNER_PUBLIC_KEY differs from the pinned key: refuses as owner-key-env-mismatch', async () => {
    await seedMergeGrant('grant-mismatch', other.privateKey);
    const rt = createFleetCliRuntime({
      stateDir: tempDir,
      ownerPublicKey: pinned.publicKeyBase64,
      env: { FLEET_OWNER_PUBLIC_KEY: other.publicKeyBase64 },
    });
    const resolved = await rt.coordination.resolveActionAuthorization.resolveActionAuthorization({
      projectId: 'proj-cli-test',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: HEAD,
      repository: 'org/repo',
      pullRequestNumber: 7,
    });
    expect(resolved).toEqual({ outcome: 'blocked', reason: 'owner-key-env-mismatch' });
  });

  it('(c) FLEET_OWNER_PUBLIC_KEY equals the pinned key: verifies and emits exactly one deprecation warning', async () => {
    await seedMergeGrant('grant-equal', pinned.privateKey);
    const warnings: string[] = [];
    const rt = createFleetCliRuntime({
      stateDir: tempDir,
      ownerPublicKey: pinned.publicKeyBase64,
      env: { FLEET_OWNER_PUBLIC_KEY: pinned.publicKeyBase64 },
      onOwnerKeyWarning: (message) => warnings.push(message),
    });
    const resolved = await rt.coordination.resolveActionAuthorization.resolveActionAuthorization({
      projectId: 'proj-cli-test',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: HEAD,
      repository: 'org/repo',
      pullRequestNumber: 7,
    });
    expect(resolved.outcome).toBe('authorized');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.split('\n')).toHaveLength(1);
    expect(warnings[0]).not.toContain(pinned.publicKeyBase64);
  });

  it('(d) the pinned key verifies a correctly signed decision with no env variable', async () => {
    await seedMergeGrant('grant-pinned', pinned.privateKey);
    const rt = createFleetCliRuntime({
      stateDir: tempDir,
      ownerPublicKey: pinned.publicKeyBase64,
      env: {},
    });
    const resolved = await rt.coordination.resolveActionAuthorization.resolveActionAuthorization({
      projectId: 'proj-cli-test',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: HEAD,
      repository: 'org/repo',
      pullRequestNumber: 7,
    });
    expect(resolved.outcome).toBe('authorized');
  });

  it('(e) no pinned key fails closed as owner-key-unpinned for a release grant', async () => {
    const record = awaitingRecord('grant-release', 'release:install');
    const runtime = createFleetCliRuntime({ stateDir: tempDir, env: {} });
    await runtime.coordination.coordinationRequestRepository.saveRequest(record);
    // An approving answer is recorded: the unpinned refusal must surface as
    // the resolve's block reason, not the ordinary awaiting state.
    await writeDecision(
      {
        requestId: record.id,
        projectId: record.projectId,
        actionScope: record.actionScope,
        expectedHeadSha: record.expectedHeadSha,
        decisionRevision: 'dec-1',
        grantId: 'grant-release',
        state: 'approved',
      },
      other.privateKey,
    );
    const resolved = await runtime.coordination.resolveActionAuthorization.resolveActionAuthorization({
      projectId: 'proj-cli-test',
      actionScope: 'release:install',
      expectedHeadSha: HEAD,
    });
    expect(resolved).toEqual({ outcome: 'blocked', reason: 'owner-key-unpinned' });
  });

  it('(e) no pinned key fails closed as owner-key-unpinned for a shadow-import grant', async () => {
    const record = awaitingRecord('grant-shadow', 'merge:import-shadow', {
      grantId: 'grant-shadow',
      shadowImportGrant: {
        repository: { owner: 'org', repo: 'repo' },
        expiresAtIso: '2036-11-18T00:00:00.000Z',
      },
      expectedHeadSha: null,
    });
    const runtime = createFleetCliRuntime({ stateDir: tempDir, env: {} });
    await runtime.coordination.coordinationRequestRepository.saveRequest(record);
    await writeDecision(
      {
        requestId: record.id,
        projectId: record.projectId,
        actionScope: record.actionScope,
        expectedHeadSha: record.expectedHeadSha,
        decisionRevision: 'dec-1',
        grantId: 'grant-shadow',
        state: 'approved',
      },
      other.privateKey,
    );
    const resolved = await runtime.coordination.resolveActionAuthorization.resolveActionAuthorization({
      projectId: 'proj-cli-test',
      actionScope: 'merge:import-shadow',
      expectedHeadSha: '',
      authorizationGrantId: 'grant-shadow',
      repository: 'org/repo',
    });
    expect(resolved).toEqual({ outcome: 'blocked', reason: 'owner-key-unpinned' });
  });

  it('(e) no pinned key fails closed as owner-key-unpinned for a scoped grant', async () => {
    await seedMergeGrant('grant-scoped', pinned.privateKey);
    const rt = createFleetCliRuntime({ stateDir: tempDir, env: {} });
    const resolved = await rt.coordination.resolveActionAuthorization.resolveActionAuthorization({
      projectId: 'proj-cli-test',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: HEAD,
      repository: 'org/repo',
      pullRequestNumber: 7,
    });
    expect(resolved).toEqual({ outcome: 'blocked', reason: 'owner-key-unpinned' });
  });
});

describe('KEY0c1b: a tampered signed answer on disk never authorizes', () => {
  it('a forged signature byte keeps the owner grant awaiting-decision; the valid answer authorizes', async () => {
    const HEAD = makeHeadH();
    const key = ephemeralOwnerKey();
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-comp-tamper-'));
    try {
      const rt = createFleetCliRuntime({ stateDir, ownerPublicKey: key.ownerPublicKey, env: {} });

      // Request an owner-gated forge grant through the real runtime.
      const requested = await coordinationCommands['request-decision'](
        {
          requestId: 'req-tamper',
          projectId: 'proj-cli-test',
          kind: 'action-decision',
          actionScope: forgeActionScope('push-and-open-pr'),
          expectedHeadSha: HEAD,
          proposalDigest: 'prop-tamper',
          policyRevision: 'pol-1',
          attemptId: 'att-tamper',
        },
        rt,
      );
      expect(requested).toMatchObject({ outcome: 'requested' });
      const record = await rt.coordination.coordinationRequestRepository.findRequestById('req-tamper');
      if (record === null) throw new Error('expected the requested decision to be recorded');
      expect(record).toMatchObject({ state: 'awaiting-decision', grantId: null, decisionRevision: null });

      // The owner's correctly signed answer, read back through the runtime's own transport.
      const fields = {
        requestId: record.id,
        projectId: record.projectId,
        actionScope: record.actionScope,
        expectedHeadSha: record.expectedHeadSha,
        decisionRevision: 'dec-tamper',
        grantId: 'grant-tamper',
        state: 'approved' as const,
      };
      writeSignedAnswer(stateDir, fields, key);
      await expectApprovedAnswerReadableThrough(rt.coordination.decisionTransport, fields);

      // Corrupt exactly one byte of the signature on disk.
      const answerPath = path.join(stateDir, 'decisions', `${fields.requestId}.json`);
      const answer = JSON.parse(await fs.readFile(answerPath, 'utf8')) as { signature: string };
      answer.signature = (answer.signature[0] === 'A' ? 'B' : 'A') + answer.signature.slice(1);
      await fs.writeFile(answerPath, `${JSON.stringify(answer, null, 2)}\n`);
      const tamperedRead = await rt.coordination.decisionTransport.readDecisionAnswer({
        requestId: fields.requestId,
        projectId: fields.projectId,
        actionScope: fields.actionScope,
        expectedHeadSha: fields.expectedHeadSha,
      });
      expect(tamperedRead.state).toBe('awaiting-decision');

      // Resolving while the tampered answer is present: a typed block, never authorized.
      const resolveRequest = {
        projectId: 'proj-cli-test',
        actionScope: forgeActionScope('push-and-open-pr'),
        expectedHeadSha: HEAD,
        attemptId: 'att-tamper',
      };
      const tampered = await rt.coordination.resolveActionAuthorization.resolveActionAuthorization(resolveRequest);
      expect(tampered).toEqual({
        outcome: 'blocked',
        reason: 'recorded request req-tamper is awaiting-decision, which does not authorize an action',
      });
      expect(await rt.coordination.coordinationRequestRepository.findRequestById('req-tamper')).toMatchObject({
        state: 'awaiting-decision',
        grantId: null,
      });

      // The untouched valid answer authorizes the same grant.
      writeSignedAnswer(stateDir, fields, key);
      const restored = await rt.coordination.resolveActionAuthorization.resolveActionAuthorization(resolveRequest);
      expect(restored).toMatchObject({ outcome: 'authorized', grantId: fields.grantId });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
