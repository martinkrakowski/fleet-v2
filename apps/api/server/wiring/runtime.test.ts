import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configureFleetApiRuntime,
} from './runtime.js';
import { workComposition } from './work/composition.js';
import { getOperatorComposition } from './operator/composition.js';
import { getEvidenceUseCases } from './evidence/composition.js';
import {
  forgeActionScope,
  consumptionId,
  observationEventKind,
} from '@fleet/work-execution';
import type { CoordinationRequestRecord } from '@fleet/operator-coordination';
import type { EvidenceAssessmentRecord } from '@fleet/evidence-and-acceptance';
import type { AttemptRecord, WorkOrderRecord } from '@fleet/work-execution';

function makeHeadH(): string {
  return '2222222222222222222222222222222222222222';
}

function makeWorkOrder(id: string): WorkOrderRecord {
  return {
    id,
    projectId: 'proj-api-test',
    taskId: 'task-api-test',
    laneId: 'lane-api-test',
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
  doors?: readonly string[],
): AttemptRecord {
  const record: AttemptRecord = {
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
  return doors === undefined ? record : { ...record, ownerDecisionReferences: doors };
}

function makeApprovedGrant(
  grantId: string,
  scope: string,
  head: string,
): CoordinationRequestRecord {
  return {
    id: `req-${grantId}`,
    projectId: 'proj-api-test',
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

describe('apps/api runtime wiring', () => {
  describe('M6: shared coordination keys', () => {
    it('produces identical coordination keys to CLI root for the same inputs', () => {
      // Both roots import the pure functions from @fleet/work-execution.
      // Verify the keys match the CLI root formats:
      // forge:<kind>, consumption-<actionId>, execution:<action>:<status>
      expect(forgeActionScope('push-and-open-pr')).toBe('forge:push-and-open-pr');
      expect(forgeActionScope('merge-pr')).toBe('forge:merge-pr');
      expect(consumptionId('forge-att-123')).toBe('consumption-forge-att-123');
      expect(observationEventKind('forge', 'completed')).toBe('execution:forge:completed');
    });
  });

  describe('M10: unconfigured forge delegate leaves grant unconsumed', () => {
    it('API-style composition with no forge delegate refuses with unavailable WITHOUT consuming the grant', async () => {
      configureFleetApiRuntime();

      const work = workComposition();
      const operator = getOperatorComposition();
      const headH = makeHeadH();
      const workOrderId = 'wo-api-1';
      const attemptId = 'att-api-1';
      const grantId = 'grant-api-push';

      // Seed work order and attempt
      const workOrderRepo = (work.registerWorkOrder as unknown as {
        deps?: { workOrderRepo: { saveWorkOrder: (w: WorkOrderRecord) => Promise<void> } };
      }).deps?.workOrderRepo;
      expect(workOrderRepo).toBeDefined();
      await workOrderRepo!.saveWorkOrder(makeWorkOrder(workOrderId));

      const attemptRepo = (work.executeAuthorizedForgeAction as unknown as {
        deps?: { attemptRepo: { saveAttempt: (a: AttemptRecord) => Promise<void> } };
      }).deps?.attemptRepo;
      expect(attemptRepo).toBeDefined();
      await attemptRepo!.saveAttempt(makeAttempt(attemptId, workOrderId, headH, []));

      // Resolve authorization grant for push-and-open-pr at head H
      const grantRecord = makeApprovedGrant(
        grantId,
        forgeActionScope('push-and-open-pr'),
        headH,
      );
      // Save grant in operator context
      const reqRepo = (operator.recordAuthorizationConsumption as unknown as {
        deps?: {
          requestRepo: {
            saveRequest: (r: CoordinationRequestRecord) => Promise<void>;
            findRequestByGrantId: (id: string) => Promise<CoordinationRequestRecord | null>;
          };
        };
      }).deps?.requestRepo;
      expect(reqRepo).toBeDefined();
      await reqRepo!.saveRequest(grantRecord);

      // Try to execute forge action through work composition
      const result = await work.executeAuthorizedForgeAction.executeAuthorizedForgeAction({
        actionId: 'action-api-1',
        attemptId,
        workOrderId,
        kind: 'push-and-open-pr',
        expectedHeadSha: headH,
        authorizationGrantId: grantId,
      });

      // Must be refused with unavailable because API binds no forge delegate
      expect(result).toEqual({ outcome: 'refused', reason: 'unavailable' });

      // Verify the grant is still UNCONSUMED
      const grant = await reqRepo!.findRequestByGrantId(grantId);
      expect(grant?.consumptions).toHaveLength(0);
      expect(grant?.state).toBe('approved');
    });
  });

  describe('restart-reload coverage', () => {
    it('reloads authorization-coordinates.json on a fresh API runtime and consumes through authorization delegate', async () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'fleet-api-restart-test-'));
      try {
        const grantId = 'grant-api-restart-1';
        const attemptId = 'att-api-restart-1';
        const headH = makeHeadH();
        const actionId = 'action-api-restart-1';

        // Write authorization-coordinates.json directly to stateDir
        const coordinatesPath = join(stateDir, 'authorization-coordinates.json');
        writeFileSync(
          coordinatesPath,
          JSON.stringify({
            [grantId]: {
              attemptId,
              expectedHeadSha: headH,
            },
          }),
          'utf8',
        );

        // Build a fresh API runtime on the same stateDir
        configureFleetApiRuntime({ stateDir });

        const operator = getOperatorComposition();
        const work = workComposition();

        // Seed the approved grant in operator context
        const grantRecord = makeApprovedGrant(
          grantId,
          forgeActionScope('push-and-open-pr'),
          headH,
        );
        const reqRepo = (operator.recordAuthorizationConsumption as unknown as {
          deps?: {
            requestRepo: {
              saveRequest: (r: CoordinationRequestRecord) => Promise<void>;
              findRequestByGrantId: (id: string) => Promise<CoordinationRequestRecord | null>;
            };
          };
        }).deps?.requestRepo;
        expect(reqRepo).toBeDefined();
        await reqRepo!.saveRequest(grantRecord);

        // Access authorization delegate/port from work composition
        const authPort = (work.executeAuthorizedForgeAction as unknown as {
          deps?: {
            authorizationPort: {
              consumeActionAuthorization: (req: {
                authorizationGrantId: string;
                actionId: string;
                actionKind: 'push-and-open-pr' | 'merge-pr';
                expectedHeadSha?: string;
                attemptId?: string;
              }) => Promise<{ outcome: string; actionId?: string; reason?: string }>;
            };
          };
        }).deps?.authorizationPort;
        expect(authPort).toBeDefined();

        // Consume through the authorization delegate carrying only the grant
        // and action identities. The attempt and head coordinates were never
        // in this request, so the only source that can scope the consumption
        // is the coordinates file reloaded from `stateDir` above.
        const result = await authPort!.consumeActionAuthorization({
          authorizationGrantId: grantId,
          actionId,
          actionKind: 'push-and-open-pr',
        });

        expect(result).toEqual({ outcome: 'consumed', actionId });

        // Verify the grant in operator repo is now consumed and state completed,
        // scoped by the reloaded coordinates rather than by the request.
        const grant = await reqRepo!.findRequestByGrantId(grantId);
        expect(grant?.state).toBe('completed');
        expect(grant?.consumptions).toHaveLength(1);
        expect(grant?.consumptions[0].actionId).toBe(actionId);
        expect(grant?.consumptions[0].attemptId).toBe(attemptId);
        expect(grant?.consumptions[0].expectedHeadSha).toBe(headH);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
        configureFleetApiRuntime(null);
      }
    });
  });

  describe('M15: one-way doors resolve through the coordination application layer', () => {
    const headH = makeHeadH();

    function ownerDecision(
      requestId: string,
      overrides: Partial<CoordinationRequestRecord>,
    ): CoordinationRequestRecord {
      return {
        id: requestId,
        projectId: 'proj-api-test',
        kind: 'action-decision',
        state: 'approved',
        actionScope: `owner-decision:${requestId}`,
        expectedHeadSha: headH,
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

    async function assessWithDoor(
      attemptId: string,
      doors: readonly string[] | null,
      decision?: CoordinationRequestRecord,
    ) {
      configureFleetApiRuntime();
      const work = workComposition();
      const operator = getOperatorComposition();
      const evidence = getEvidenceUseCases();
      const assessmentId = `assessment-${attemptId}`;

      const attemptRepo = (work.executeAuthorizedForgeAction as unknown as {
        deps?: { attemptRepo: { saveAttempt: (a: AttemptRecord) => Promise<void> } };
      }).deps?.attemptRepo;
      if (attemptRepo) {
        await attemptRepo.saveAttempt(
          doors === null
            ? makeAttempt(attemptId, `wo-${attemptId}`, headH)
            : { ...makeAttempt(attemptId, `wo-${attemptId}`, headH), ownerDecisionReferences: doors },
        );
      }
      const reqRepo = (operator.checkOwnerDecision as unknown as {
        deps?: { requestRepo: { saveRequest: (r: CoordinationRequestRecord) => Promise<void> } };
      }).deps?.requestRepo;
      if (decision && reqRepo) {
        await reqRepo.saveRequest(decision);
      }
      const assessmentRepo = (evidence.assessHeadAcceptance as unknown as {
        deps?: {
          repo: {
            saveAssessment: (a: EvidenceAssessmentRecord) => Promise<void>;
          };
        };
      }).deps?.repo;
      const assessment: EvidenceAssessmentRecord = {
          id: assessmentId,
          projectId: 'proj-api-test',
          attemptId,
          candidateHeadSha: headH,
          policyRevision: 'pol-1',
          implementerModel: 'seat/implementer',
          requiredChecks: [],
          state: 'pending',
          verificationReceipts: [],
          reviewReceipts: [
            {
              id: `review-${attemptId}`,
              assessmentId,
              projectId: 'proj-api-test',
              attemptId,
              candidateHeadSha: headH,
              reviewerModel: 'seat/reviewer',
              implementerModel: 'seat/implementer',
              readOnlyVerified: true,
              result: 'pass',
              findings: [],
              evidenceRef: `ev-${attemptId}`,
              policyRevision: 'pol-1',
              completedAtIso: '2026-10-15T10:00:00Z',
            },
          ],
          findingDispositions: [],
          acceptanceReceiptId: null,
          blockers: [],
          revision: 1,
          updatedAtIso: '2026-10-15T10:00:00Z',
        };
      if (assessmentRepo) {
        await assessmentRepo.saveAssessment(assessment);
      }

      return evidence.assessHeadAcceptance.assessHeadAcceptance({
        assessmentId,
        candidateHeadSha: headH,
        policyRevision: 'pol-1',
      });
    }

    it('an approved door for the candidate head accepts through the runtime wiring', async () => {
      const result = await assessWithDoor(
        'att-api-door-approved',
        ['req-door-approved'],
        ownerDecision('req-door-approved', {}),
      );

      // The only blockers left are the unbound forge transport's honest unknowns:
// the door itself cleared through the coordination application layer.
      expect(result.outcome).toBe('blocked');
      if (result.outcome === 'blocked') {
        expect(result.blockers.some((blocker) => blocker.includes('owner decision'))).toBe(false);
        expect(result.blockers).toEqual([
          'forge could not confirm the pull request head after reading CI state',
          "forge reports CI state 'unknown' for this candidate head",
          'forge could not read review threads for this candidate head',
        ]);
      }
    });

    it('a declined door blocks through the runtime wiring', async () => {
      const result = await assessWithDoor(
        'att-api-door-declined',
        ['req-door-declined'],
        ownerDecision('req-door-declined', { state: 'declined', decisionRevision: null, grantId: null }),
      );

      expect(result.outcome).toBe('blocked');
      if (result.outcome === 'blocked') {
        expect(
          result.blockers.some((blocker) =>
            blocker.includes("owner decision 'req-door-declined' is not approved"),
          ),
        ).toBe(true);
      }
    });

    it('an attempt recorded before doors were frozen blocks through the runtime wiring', async () => {
      const result = await assessWithDoor('att-api-door-legacy', null);

      expect(result.outcome).toBe('blocked');
      if (result.outcome === 'blocked') {
        expect(
          result.blockers.some((blocker) =>
            blocker.includes('owner decision references for attempt'),
          ),
        ).toBe(true);
      }
    });

    it('withdrawn door: attempt accept is blocked and merge-pr refuses without consuming the grant', async () => {
      configureFleetApiRuntime();
      const work = workComposition();
      const operator = getOperatorComposition();
      const evidence = getEvidenceUseCases();
      const attemptId = 'att-api-door-e2e';
      const workOrderId = 'wo-api-door-e2e';
      const doorRef = 'req-api-door-e2e';
      const grantId = 'grant-api-door-e2e';
      // The API acceptance delegate addresses the assessment by the shared
      // prefixed id (assessmentIdForAttempt).
      const assessmentId = `assessment-${attemptId}`;

      const workOrderRepo = (work.registerWorkOrder as unknown as {
        deps?: { workOrderRepo: { saveWorkOrder: (w: WorkOrderRecord) => Promise<void> } };
      }).deps?.workOrderRepo;
      if (workOrderRepo) {
        await workOrderRepo.saveWorkOrder(makeWorkOrder(workOrderId));
      }
      const attemptRepo = (work.executeAuthorizedForgeAction as unknown as {
        deps?: { attemptRepo: { saveAttempt: (a: AttemptRecord) => Promise<void> } };
      }).deps?.attemptRepo;
      if (attemptRepo) {
        await attemptRepo.saveAttempt({
          ...makeAttempt(attemptId, workOrderId, headH, [doorRef]),
          runner: { kind: 'opencode', remotePort: 0, host: null, model: 'seat/implementer', variant: null, agent: null },
        });
      }
      const reqRepo = (operator.checkOwnerDecision as unknown as {
        deps?: { requestRepo: { saveRequest: (r: CoordinationRequestRecord) => Promise<void> } };
      }).deps?.requestRepo;
      if (reqRepo) {
        await reqRepo.saveRequest(ownerDecision(doorRef, {}));
        await reqRepo.saveRequest(makeApprovedGrant(grantId, forgeActionScope('merge-pr'), headH));
      }
      const assessmentRepo = (evidence.assessHeadAcceptance as unknown as {
        deps?: { repo: { saveAssessment: (a: EvidenceAssessmentRecord) => Promise<void> } };
      }).deps?.repo;
      if (assessmentRepo) {
        await assessmentRepo.saveAssessment({
          id: assessmentId,
          projectId: 'proj-api-test',
          attemptId,
          candidateHeadSha: headH,
          policyRevision: 'pol-1',
          implementerModel: 'seat/implementer',
          requiredChecks: [],
          state: 'accepted',
          verificationReceipts: [],
          reviewReceipts: [],
          findingDispositions: [],
          acceptanceReceiptId: `acc-${attemptId}`,
          blockers: [],
          revision: 1,
          updatedAtIso: '2026-10-15T10:00:00Z',
        });
      }

      // The owner decision is withdrawn while the attempt keeps its door.
      if (reqRepo) {
        await reqRepo.saveRequest(
          ownerDecision(doorRef, {
            state: 'awaiting-decision',
            decisionRevision: null,
            grantId: null,
            revision: 2,
          }),
        );
      }

      // `attempt accept` must refuse even though a receipt-bearing accepted
      // assessment is still stored for this exact head.
      const accept = await work.requestAttemptAcceptance.requestAttemptAcceptance({
        attemptId,
        candidateHeadSha: headH,
        reviewerModel: 'openrouter/anthropic/claude-sonnet-4.5',
      });
      expect(accept.outcome).toBe('rejected');
      if (accept.outcome === 'rejected') {
        // The API delegate surfaces the acceptance blockers directly.
        expect(accept.reason).toContain(`'${doorRef}' is not approved`);
      }

      // `forge execute --kind merge-pr` refuses before consuming the grant.
      const forge = await work.executeAuthorizedForgeAction.executeAuthorizedForgeAction({
        actionId: 'action-api-door-e2e',
        attemptId,
        workOrderId,
        kind: 'merge-pr',
        expectedHeadSha: headH,
        authorizationGrantId: grantId,
      });
      expect(forge.outcome).toBe('refused');
      if (forge.outcome === 'refused') {
        expect(forge.reason).toContain(`'${doorRef}' is not approved`);
      }
      if (reqRepo) {
        const findRepo = reqRepo as unknown as {
          findRequestByGrantId: (id: string) => Promise<CoordinationRequestRecord | null>;
        };
        const grant = await findRepo.findRequestByGrantId(grantId);
        expect(grant?.consumptions ?? []).toHaveLength(0);
      }
    });
  });
});
