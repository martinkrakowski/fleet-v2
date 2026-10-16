import { describe, expect, it } from 'vitest';
import {
  configureFleetApiRuntime,
} from './runtime.js';
import { workComposition } from './work/composition.js';
import { getOperatorComposition } from './operator/composition.js';
import {
  forgeActionScope,
  consumptionId,
  observationEventKind,
} from '@fleet/work-execution';
import type { CoordinationRequestRecord } from '@fleet/operator-coordination';
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
      if (workOrderRepo) {
        await workOrderRepo.saveWorkOrder(makeWorkOrder(workOrderId));
      }

      const attemptRepo = (work.executeAuthorizedForgeAction as unknown as {
        deps?: { attemptRepo: { saveAttempt: (a: AttemptRecord) => Promise<void> } };
      }).deps?.attemptRepo;
      if (attemptRepo) {
        await attemptRepo.saveAttempt(makeAttempt(attemptId, workOrderId, headH));
      }

      // Resolve authorization grant for push-and-open-pr at head H
      const grantRecord = makeApprovedGrant(
        grantId,
        forgeActionScope('push-and-open-pr'),
        headH,
      );
      // Save grant in operator context
      const reqRepo = (operator.recordAuthorizationConsumption as unknown as {
        deps?: { requestRepo: { saveRequest: (r: CoordinationRequestRecord) => Promise<void> } };
      }).deps?.requestRepo;
      if (reqRepo) {
        await reqRepo.saveRequest(grantRecord);
      }

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
      if (reqRepo) {
        const findRepo = reqRepo as unknown as {
          findRequestByGrantId: (id: string) => Promise<CoordinationRequestRecord | null>;
        };
        const grant = await findRepo.findRequestByGrantId(grantId);
        expect(grant?.consumptions).toHaveLength(0);
        expect(grant?.state).toBe('approved');
      }
    });
  });

  it("throws and leaves corrupt accepted-receipts.json unchanged on write attempt", async () => {
    const receiptsPath = path.join(tempDir, "accepted-receipts.json");
    const corruptContent = "CORRUPT_NOT_JSON_{{";
    await fs.writeFile(receiptsPath, corruptContent, "utf8");

    await expect(
      persistAcceptedReceiptsToState(tempDir, {
        "head-commit-new": "receipt-id-new",
      }),
    ).rejects.toThrow();

    const contentAfter = await fs.readFile(receiptsPath, "utf8");
    expect(contentAfter).toBe(corruptContent);
  });
});
