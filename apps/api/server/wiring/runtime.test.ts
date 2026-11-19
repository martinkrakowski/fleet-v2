import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterAll } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  configureFleetApiRuntime,
} from './runtime.js';
import { bootstrapFleetApiFromEnv } from '../plugins/runtime.js';
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

// KEY0c1b: every runtime in this file that seeds an approved owner grant
// pins this ephemeral in-process key and reads its signed answers through
// the runtime's own decision transport. The KEY0b section below pins its
// own keys and is untouched.
const ownerKey = ephemeralOwnerKey();
const fixtureStateDir = mkdtempSync(join(tmpdir(), 'fleet-api-fixtures-'));

/** The runtime configuration that pins the ephemeral owner key. */
function pinnedRuntimeConfig(stateDir: string = fixtureStateDir) {
  return {
    stateDir,
    installation: { owner: { publicKey: ownerKey.ownerPublicKey } } as never,
  };
}

/** The decision transport in the deps of the operator composition's resolve use case. */
function decisionTransportOf(operator: ReturnType<typeof getOperatorComposition>) {
  const transport = (
    operator.resolveActionAuthorization as unknown as {
      deps?: { decisionTransport?: { readDecisionAnswer(query: {
        requestId: string;
        projectId: string;
        actionScope: string;
        expectedHeadSha: string | null;
      }): Promise<{ state: string; grantId: string | null; decisionRevision: string | null }> } };
    }
  ).deps?.decisionTransport;
  if (!transport) {
    throw new Error('signed-decision-fixture self-check: the operator composition carries no decisionTransport');
  }
  return transport;
}

/** Saves one coordination request and, for an `approved` owner grant, writes its correctly signed answer. */
async function seedApproved(
  reqRepo: { saveRequest: (r: CoordinationRequestRecord) => Promise<void> },
  record: CoordinationRequestRecord,
  stateDir: string = fixtureStateDir,
): Promise<void> {
  await reqRepo.saveRequest(record);
  if (record.state !== 'approved') {
    return;
  }
  const fields = approvedAnswerFields(record);
  writeSignedAnswer(stateDir, fields, ownerKey);
  await expectApprovedAnswerReadableThrough(decisionTransportOf(getOperatorComposition()), fields);
}
import {
  approvedAnswerFields,
  ephemeralOwnerKey,
  expectApprovedAnswerReadableThrough,
  writeSignedAnswer,
} from './__tests__/signed-decision-fixture.js';

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
  afterAll(() => {
    rmSync(fixtureStateDir, { recursive: true, force: true });
    configureFleetApiRuntime(null);
  });

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
      configureFleetApiRuntime(pinnedRuntimeConfig());

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
      await seedApproved(reqRepo!, grantRecord);

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
        configureFleetApiRuntime(pinnedRuntimeConfig(stateDir));

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
        await seedApproved(reqRepo!, grantRecord, stateDir);

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
      configureFleetApiRuntime(pinnedRuntimeConfig());
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
        await seedApproved(reqRepo, decision);
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
      configureFleetApiRuntime(pinnedRuntimeConfig());
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
        await seedApproved(reqRepo, ownerDecision(doorRef, {}));
        await seedApproved(reqRepo, makeApprovedGrant(grantId, forgeActionScope('merge-pr'), headH));
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

describe('CO24d: the API composition binds a grant to its resolved attempt', () => {
  type ConsumeResult = { outcome: string; actionId?: string; reason?: string };
  type AuthPort = {
    consumeActionAuthorization: (req: {
      authorizationGrantId: string;
      actionId: string;
      actionKind: 'push-and-open-pr' | 'merge-pr';
      expectedHeadSha?: string;
      attemptId?: unknown;
    }) => Promise<ConsumeResult>;
  };

  async function setup(...grantIds: string[]) {
    const stateDir = mkdtempSync(join(tmpdir(), 'fleet-api-co24d-'));
    const headH = makeHeadH();
    writeFileSync(
      join(stateDir, 'authorization-coordinates.json'),
      JSON.stringify(
        Object.fromEntries(grantIds.map((id) => [id, { attemptId: 'att-A', expectedHeadSha: headH }])),
      ),
      'utf8',
    );
    configureFleetApiRuntime(pinnedRuntimeConfig(stateDir));
    const operator = getOperatorComposition();
    const work = workComposition();
    const reqRepo = (operator.recordAuthorizationConsumption as unknown as {
      deps: {
        requestRepo: {
          saveRequest: (r: CoordinationRequestRecord) => Promise<void>;
          findRequestByGrantId: (id: string) => Promise<CoordinationRequestRecord | null>;
        };
      };
    }).deps.requestRepo;
    for (const id of grantIds) {
      await seedApproved(reqRepo, makeApprovedGrant(id, forgeActionScope('push-and-open-pr'), headH), stateDir);
    }
    const authPort = (work.executeAuthorizedForgeAction as unknown as { deps: { authorizationPort: AuthPort } })
      .deps.authorizationPort;
    return { stateDir, headH, reqRepo, authPort };
  }

  it('refuses a request naming attempt B for a grant resolved for attempt A, and records nothing', async () => {
    const { stateDir, headH, reqRepo, authPort } = await setup('grant-co24d-1');
    try {
      const result = await authPort.consumeActionAuthorization({
        authorizationGrantId: 'grant-co24d-1',
        actionId: 'action-co24d-1',
        actionKind: 'push-and-open-pr',
        expectedHeadSha: headH,
        attemptId: 'att-B',
      });
      expect(result).toEqual({ outcome: 'refused', reason: 'grant-attempt-mismatch' });
      const grant = await reqRepo.findRequestByGrantId('grant-co24d-1');
      expect(grant?.consumptions).toHaveLength(0);
      expect(grant?.state).toBe('approved');
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      configureFleetApiRuntime(null);
    }
  });

  it('refuses a wrong-typed attempt id', async () => {
    const { stateDir, headH, reqRepo, authPort } = await setup('grant-co24d-2');
    try {
      const result = await authPort.consumeActionAuthorization({
        authorizationGrantId: 'grant-co24d-2',
        actionId: 'action-co24d-2',
        actionKind: 'push-and-open-pr',
        expectedHeadSha: headH,
        attemptId: 42,
      });
      // The reason pins the branch: the adapter's request validation refuses a wrong-typed id before any delegate runs.
      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
      expect((await reqRepo.findRequestByGrantId('grant-co24d-2'))?.consumptions).toHaveLength(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      configureFleetApiRuntime(null);
    }
  });

  it('consumes for the matching attempt and for an absent attempt (the resolved one is used)', async () => {
    const { stateDir, headH, reqRepo, authPort } = await setup('grant-co24d-ok-1', 'grant-co24d-ok-2');
    try {
      const matching = await authPort.consumeActionAuthorization({
        authorizationGrantId: 'grant-co24d-ok-1',
        actionId: 'action-co24d-ok-1',
        actionKind: 'push-and-open-pr',
        expectedHeadSha: headH,
        attemptId: 'att-A',
      });
      expect(matching).toEqual({ outcome: 'consumed', actionId: 'action-co24d-ok-1' });
      const absent = await authPort.consumeActionAuthorization({
        authorizationGrantId: 'grant-co24d-ok-2',
        actionId: 'action-co24d-ok-2',
        actionKind: 'push-and-open-pr',
        expectedHeadSha: headH,
      });
      expect(absent).toEqual({ outcome: 'consumed', actionId: 'action-co24d-ok-2' });
      for (const id of ['grant-co24d-ok-1', 'grant-co24d-ok-2']) {
        expect((await reqRepo.findRequestByGrantId(id))?.consumptions[0]?.attemptId).toBe('att-A');
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      configureFleetApiRuntime(null);
    }
  });
});

/**
 * KEY0b: the API composition reads the owner public key only from the pinned
 * installation.owner.publicKey. FLEET_OWNER_PUBLIC_KEY is never an authority:
 * a mismatching value refuses, an equal value only warns once.
 */
describe('KEY0b: pinned owner public key in the API composition root', () => {
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

  function awaitingRecord(
    grantId: string,
    scope: string,
    overrides: Partial<CoordinationRequestRecord> = {},
  ): CoordinationRequestRecord {
    return {
      ...makeApprovedGrant(grantId, scope, makeHeadH()),
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
      ...overrides,
    };
  }

  /** Seeds an awaiting merge grant for org/repo PR 7 with its approved answer on disk. */
  function seedMergeGrant(grantId: string): CoordinationRequestRecord {
    return awaitingRecord(grantId, forgeActionScope('merge-pr'), {
      mergeGrant: { repository: { owner: 'org', repo: 'repo' }, pullRequestNumber: 7 },
    });
  }

  async function writeDecision(
    stateDir: string,
    fields: Parameters<typeof canonicalDecisionBytes>[0],
    privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  ): Promise<void> {
    const signature = sign(null, canonicalDecisionBytes(fields), privateKey).toString('base64');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(stateDir, 'decisions'), { recursive: true });
    writeFileSync(
      join(stateDir, 'decisions', `${fields.requestId}.json`),
      `${JSON.stringify({ ...fields, signature }, null, 2)}\n`,
    );
  }

  function withStateDir(body: (stateDir: string) => Promise<void>): () => Promise<void> {
    return async () => {
      const { mkdtempSync, rmSync } = await import('node:fs');
      const stateDir = mkdtempSync(join(tmpdir(), 'fleet-api-key0b-'));
      try {
        await body(stateDir);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
        configureFleetApiRuntime(null);
      }
    };
  }

  const resolveRequest = {
    projectId: 'proj-api-test',
    actionScope: forgeActionScope('merge-pr'),
    expectedHeadSha: makeHeadH(),
    repository: 'org/repo',
    pullRequestNumber: 7,
  };

  it('(a) only FLEET_OWNER_PUBLIC_KEY set: a signed approval refuses as owner-key-unpinned', withStateDir(async (stateDir) => {
    const record = seedMergeGrant('grant-api-env-only');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    configureFleetApiRuntime({
      stateDir,
      env: { FLEET_OWNER_PUBLIC_KEY: envOnly.publicKeyBase64 },
    });
    const operator = getOperatorComposition();
    await operator.coordinationRequestRepository.saveRequest(record);
    mkdirSync(join(stateDir, 'decisions'), { recursive: true });
    writeFileSync(
      join(stateDir, 'decisions', `${record.id}.json`),
      `${JSON.stringify({ state: 'approved', decisionRevision: 'dec-1', grantId: record.id.replace('req-', 'grant-') })}\n`,
    );
    const resolved = await operator.resolveActionAuthorization.resolveActionAuthorization(resolveRequest);
    expect(resolved).toEqual({ outcome: 'blocked', reason: 'owner-key-unpinned' });
  }));

  it('(b) FLEET_OWNER_PUBLIC_KEY differs from the pinned key: refuses as owner-key-env-mismatch', withStateDir(async (stateDir) => {
    const record = seedMergeGrant('grant-api-mismatch');
    configureFleetApiRuntime({
      stateDir,
      installation: { owner: { publicKey: pinned.publicKeyBase64 } } as never,
      env: { FLEET_OWNER_PUBLIC_KEY: other.publicKeyBase64 },
    });
    const operator = getOperatorComposition();
    await operator.coordinationRequestRepository.saveRequest(record);
    await writeDecision(stateDir, {
      requestId: record.id,
      projectId: record.projectId,
      actionScope: record.actionScope,
      expectedHeadSha: record.expectedHeadSha,
      decisionRevision: 'dec-1',
      grantId: 'grant-api-mismatch',
      state: 'approved',
    }, other.privateKey);
    const resolved = await operator.resolveActionAuthorization.resolveActionAuthorization(resolveRequest);
    expect(resolved).toEqual({ outcome: 'blocked', reason: 'owner-key-env-mismatch' });
  }));

  it('(c) FLEET_OWNER_PUBLIC_KEY equals the pinned key: verifies and emits exactly one deprecation warning', withStateDir(async (stateDir) => {
    const record = seedMergeGrant('grant-api-equal');
    // The warning is written while the runtime composes, so the spy is in
    // place before `configureFleetApiRuntime`.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    configureFleetApiRuntime({
      stateDir,
      installation: { owner: { publicKey: pinned.publicKeyBase64 } } as never,
      env: { FLEET_OWNER_PUBLIC_KEY: pinned.publicKeyBase64 },
    });
    try {
      const operator = getOperatorComposition();
      await operator.coordinationRequestRepository.saveRequest(record);
      await writeDecision(stateDir, {
        requestId: record.id,
        projectId: record.projectId,
        actionScope: record.actionScope,
        expectedHeadSha: record.expectedHeadSha,
        decisionRevision: 'dec-1',
        grantId: 'grant-api-equal',
        state: 'approved',
      }, pinned.privateKey);
      const resolved = await operator.resolveActionAuthorization.resolveActionAuthorization(resolveRequest);
      expect(resolved.outcome).toBe('authorized');
      const warnings = stderrSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((text) => text.includes('FLEET_OWNER_PUBLIC_KEY is deprecated'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.split('\n')).toHaveLength(2);
      expect(warnings[0]).not.toContain(pinned.publicKeyBase64);
    } finally {
      stderrSpy.mockRestore();
    }
  }));

  it('(d) the pinned key verifies a correctly signed decision with no env variable', withStateDir(async (stateDir) => {
    const record = seedMergeGrant('grant-api-pinned');
    configureFleetApiRuntime({
      stateDir,
      installation: { owner: { publicKey: pinned.publicKeyBase64 } } as never,
      env: {},
    });
    const operator = getOperatorComposition();
    await operator.coordinationRequestRepository.saveRequest(record);
    await writeDecision(stateDir, {
      requestId: record.id,
      projectId: record.projectId,
      actionScope: record.actionScope,
      expectedHeadSha: record.expectedHeadSha,
      decisionRevision: 'dec-1',
      grantId: 'grant-api-pinned',
      state: 'approved',
    }, pinned.privateKey);
    const resolved = await operator.resolveActionAuthorization.resolveActionAuthorization(resolveRequest);
    expect(resolved.outcome).toBe('authorized');
  }));

  it('(e) no pinned key fails closed as owner-key-unpinned for a release grant', withStateDir(async (stateDir) => {
    const record = awaitingRecord('grant-api-release', 'release:install');
    configureFleetApiRuntime({ stateDir, env: {} });
    const operator = getOperatorComposition();
    await operator.coordinationRequestRepository.saveRequest(record);
    await writeDecision(stateDir, {
      requestId: record.id,
      projectId: record.projectId,
      actionScope: record.actionScope,
      expectedHeadSha: record.expectedHeadSha,
      decisionRevision: 'dec-1',
      grantId: 'grant-api-release',
      state: 'approved',
    }, other.privateKey);
    const resolved = await operator.resolveActionAuthorization.resolveActionAuthorization({
      projectId: 'proj-api-test',
      actionScope: 'release:install',
      expectedHeadSha: makeHeadH(),
    });
    expect(resolved).toEqual({ outcome: 'blocked', reason: 'owner-key-unpinned' });
  }));

  it('(e) no pinned key fails closed as owner-key-unpinned for a shadow-import grant', withStateDir(async (stateDir) => {
    const record = awaitingRecord('grant-api-shadow', 'merge:import-shadow', {
      grantId: 'grant-api-shadow',
      shadowImportGrant: {
        repository: { owner: 'org', repo: 'repo' },
        expiresAtIso: '2036-11-18T00:00:00.000Z',
      },
      expectedHeadSha: null,
    });
    configureFleetApiRuntime({ stateDir, env: {} });
    const operator = getOperatorComposition();
    await operator.coordinationRequestRepository.saveRequest(record);
    await writeDecision(stateDir, {
      requestId: record.id,
      projectId: record.projectId,
      actionScope: record.actionScope,
      expectedHeadSha: record.expectedHeadSha,
      decisionRevision: 'dec-1',
      grantId: 'grant-api-shadow',
      state: 'approved',
    }, other.privateKey);
    const resolved = await operator.resolveActionAuthorization.resolveActionAuthorization({
      projectId: 'proj-api-test',
      actionScope: 'merge:import-shadow',
      expectedHeadSha: '',
      authorizationGrantId: 'grant-api-shadow',
      repository: 'org/repo',
    });
    expect(resolved).toEqual({ outcome: 'blocked', reason: 'owner-key-unpinned' });
  }));

  it('(e) no pinned key fails closed as owner-key-unpinned for a scoped grant', withStateDir(async (stateDir) => {
    const record = seedMergeGrant('grant-api-scoped');
    configureFleetApiRuntime({ stateDir, env: {} });
    const operator = getOperatorComposition();
    await operator.coordinationRequestRepository.saveRequest(record);
    await writeDecision(stateDir, {
      requestId: record.id,
      projectId: record.projectId,
      actionScope: record.actionScope,
      expectedHeadSha: record.expectedHeadSha,
      decisionRevision: 'dec-1',
      grantId: 'grant-api-scoped',
      state: 'approved',
    }, pinned.privateKey);
    const resolved = await operator.resolveActionAuthorization.resolveActionAuthorization(resolveRequest);
    expect(resolved).toEqual({ outcome: 'blocked', reason: 'owner-key-unpinned' });
  }));

  // End-to-end through `bootstrapFleetApiFromEnv`: the pinned key comes from a
  // real (trusted) installation file on disk, never from the environment. An
  // approval signed by the ambient env key is refused as a mismatch; the same
  // approval signed by the pinned key authorizes.
  it('(f) bootstrapFleetApiFromEnv pins the key from the installation file: an approval signed by the env key refuses and one signed by the pinned key authorizes', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'fleet-api-key0b-e2e-'));
    try {
      const stateDir = join(rootDir, 'state');
      mkdirSync(stateDir, { recursive: true });
      const tokenFile = join(rootDir, 'api-token');
      writeFileSync(tokenFile, `e2etoken${'x'.repeat(40)}\n`, { mode: 0o600 });
      const installationFile = join(rootDir, 'fleet.json');
      writeFileSync(
        installationFile,
        `${JSON.stringify({ schemaVersion: 1, owner: { publicKey: pinned.publicKeyBase64 } }, null, 2)}\n`,
        { mode: 0o600 },
      );
      const baseEnv = {
        FLEET_STATE_DIR: stateDir,
        FLEET_API_TOKEN_FILE: tokenFile,
        FLEET_INSTALLATION_FILE: installationFile,
      };
      const record = seedMergeGrant('grant-api-e2e');
      const operator = (() => {
        const ok = bootstrapFleetApiFromEnv({ ...baseEnv, FLEET_OWNER_PUBLIC_KEY: other.publicKeyBase64 });
        expect(ok).toBe(true);
        return getOperatorComposition();
      })();
      await operator.coordinationRequestRepository.saveRequest(record);
      await writeDecision(stateDir, {
        requestId: record.id,
        projectId: record.projectId,
        actionScope: record.actionScope,
        expectedHeadSha: record.expectedHeadSha,
        decisionRevision: 'dec-1',
        grantId: 'grant-api-e2e',
        state: 'approved',
      }, other.privateKey);

      // The env key never verifies: the mismatch refusal leaves the grant
      // exactly where it was (nothing authorized).
      const refused = await operator.resolveActionAuthorization.resolveActionAuthorization(resolveRequest);
      expect(refused).toEqual({ outcome: 'blocked', reason: 'owner-key-env-mismatch' });
      const untouched = await operator.coordinationRequestRepository.findRequestById(record.id);
      expect(untouched).toMatchObject({
        state: 'awaiting-decision',
        decisionRevision: null,
        grantId: null,
      });

      // Mirror: with the environment variable gone, the pinned key from the
      // same installation file verifies the approval signed by key A.
      configureFleetApiRuntime(null);
      expect(bootstrapFleetApiFromEnv({ ...baseEnv })).toBe(true);
      const pinnedOperator = getOperatorComposition();
      await pinnedOperator.coordinationRequestRepository.saveRequest(record);
      await writeDecision(stateDir, {
        requestId: record.id,
        projectId: record.projectId,
        actionScope: record.actionScope,
        expectedHeadSha: record.expectedHeadSha,
        decisionRevision: 'dec-1',
        grantId: 'grant-api-e2e',
        state: 'approved',
      }, pinned.privateKey);
      const authorized = await pinnedOperator.resolveActionAuthorization.resolveActionAuthorization(resolveRequest);
      expect(authorized.outcome).toBe('authorized');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      configureFleetApiRuntime(null);
    }
  });
});
