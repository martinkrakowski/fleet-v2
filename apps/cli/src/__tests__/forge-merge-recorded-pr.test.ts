// The recorded pull request is the merged pull request (WB5b2), proved through
// the real CLI composition: the use case, the forge action adapter, the forge
// read, the journal and the stores are the production ones; only the two gh
// transports are stubs. A request number that the journal contradicts or the
// forge does not confirm refuses before the grant, and a confirmed number is
// the one `gh pr merge` receives.

import { describe, expect, it } from 'vitest';

import type { CoordinationRequestRecord } from '@fleet/operator-coordination';
import type { FleetInstallation } from '@fleet/installation';
import type { AttemptRecord, WorkOrderRecord } from '@fleet/work-execution';

import { assessmentIdForAttempt, createFleetCliRuntime, forgeActionScope } from '../composition.js';

const HEAD = '1111111111111111111111111111111111111111';
const BRANCH = 'feat/lane-cli-test';

function installation(): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {
      local: {
        transport: 'local',
        worktreeRoot: '/tmp/fleet-wb5b2-worktrees',
        roles: ['orchestrator', 'lane-runner'],
        runner: {
          kind: 'opencode',
          port: 46000,
          capabilities: {
            networkEgressRestricted: true,
            cpuAndMemoryLimited: true,
            processTreeTermination: true,
            filesystemScope: 'scoped-worktree',
          },
          maxLanes: 2,
        },
      },
    },
    forge: { mode: 'github', owner: 'martinkrakowski', repo: 'fleet-v2' },
  };
}

function prView(number: number, headRefName: string): string {
  return JSON.stringify({
    number,
    state: 'OPEN',
    headRefOid: HEAD,
    headRefName,
    baseRefName: 'main',
    mergedAt: null,
    closedAt: null,
    mergeCommit: null,
    mergeStateStatus: 'CLEAN',
    isCrossRepository: false,
    headRepositoryOwner: { login: 'martinkrakowski' },
  });
}

async function seed(options: { readNumberBranch: string }) {
  const reads: string[][] = [];
  const merges: string[][] = [];
  const rt = createFleetCliRuntime({
    installation: installation(),
    forgeGhRunner: async (args) => {
      reads.push([...args]);
      const number = Number(args[2]);
      return { exitCode: 0, stdout: prView(number, options.readNumberBranch), stderr: '' };
    },
    forgeActionDelegate: {
      runGh: async (args) => {
        merges.push([...args]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      verifyCurrentHeadSha: async () => HEAD,
    },
  });
  const workOrder: WorkOrderRecord = {
    id: 'wo-wb5b2',
    projectId: 'proj-cli-test',
    taskId: 'task-cli-test',
    laneId: 'lane-cli-test',
    // The exact shape of a live .fleet/state work-orders.json record (WB5b2).
    repository: 'https://github.com/martinkrakowski/fleet-v2.git',
    state: 'approved',
    revision: 1,
    baseCommit: '0'.repeat(40),
    ownedPaths: ['src/'],
    policyRevision: 'pol-1',
    prerequisiteWorkOrderIds: [],
    createdAtIso: '2026-10-15T10:00:00Z',
    updatedAtIso: '2026-10-15T10:00:00Z',
  };
  const attempt: AttemptRecord = {
    id: 'att-wb5b2',
    workOrderId: workOrder.id,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    state: 'collected',
    outcome: 'done',
    baseCommit: '0'.repeat(40),
    worktreePath: '/tmp/worktree',
    briefDigest: 'digest-1',
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: {
      headCommit: HEAD,
      commitsSinceBase: [HEAD],
      collectedArtifactPaths: ['/tmp/patch.diff'],
      notes: 'present',
    },
    ownerDecisionReferences: [],
    createdAtIso: '2026-10-15T10:00:00Z',
    updatedAtIso: '2026-10-15T10:30:00Z',
  };
  await rt.execution.workOrderRepository.saveWorkOrder(workOrder);
  await rt.execution.attemptRepository.saveAttempt(attempt);
  const grant: CoordinationRequestRecord = {
    id: 'req-grant-wb5b2',
    projectId: 'proj-cli-test',
    kind: 'action-decision',
    state: 'approved',
    actionScope: forgeActionScope('merge-pr'),
    expectedHeadSha: HEAD,
    proposalDigest: 'digest-req',
    policyRevision: 'pol-1',
    decisionRevision: 'dec-1',
    grantId: 'grant-wb5b2',
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'delivered',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: '2026-10-15T10:00:00Z',
    updatedAtIso: '2026-10-15T10:00:00Z',
  };
  await rt.coordination.coordinationRequestRepository.saveRequest(grant);
  await rt.evidence.evidenceAssessmentRepository.saveAssessment({
    id: assessmentIdForAttempt(attempt.id),
    projectId: 'proj-cli-test',
    attemptId: attempt.id,
    candidateHeadSha: HEAD,
    policyRevision: 'pol-1',
    implementerModel: 'implementer-mod',
    requiredChecks: [],
    state: 'accepted',
    verificationReceipts: [],
    reviewReceipts: [],
    findingDispositions: [],
    acceptanceReceiptId: 'receipt-wb5b2',
    blockers: [],
    revision: 1,
    updatedAtIso: '2026-10-15T11:00:00Z',
  });
  return { rt, reads, merges };
}

function mergeRequest(pullRequestNumber: number) {
  return {
    actionId: 'action-wb5b2',
    attemptId: 'att-wb5b2',
    workOrderId: 'wo-wb5b2',
    kind: 'merge-pr' as const,
    expectedHeadSha: HEAD,
    authorizationGrantId: 'grant-wb5b2',
    pullRequestNumber,
  };
}

describe('forge execute merge-pr through the CLI composition (WB5b2)', () => {
  it('refuses a request number the typed journal contradicts, before the grant and any gh call', async () => {
    const { rt, reads, merges } = await seed({ readNumberBranch: BRANCH });
    await rt.execution.executionJournal.appendJournalEntry({
      id: 'forge:action-open:completed:1',
      attemptId: 'att-wb5b2',
      workOrderId: 'wo-wb5b2',
      action: 'forge',
      status: 'completed',
      baseCommit: '0'.repeat(40),
      recordedAtIso: '2026-10-15T10:40:00Z',
      sessionId: null,
      detail: null,
      pullRequest: { repository: 'martinkrakowski/fleet-v2', number: 42 },
    });

    const result = await rt.execution.executeAuthorizedForgeAction.executeAuthorizedForgeAction(
      mergeRequest(999),
    );

    expect(result).toEqual({ outcome: 'refused', reason: 'pull-request-sources-disagree' });
    expect(merges).toHaveLength(0);
    expect(reads).toHaveLength(0);
    const grant = await rt.coordination.coordinationRequestRepository.findRequestByGrantId('grant-wb5b2');
    expect(grant?.consumptions).toHaveLength(0);
  });

  it('refuses a request-only number the forge reads as another branch, before the grant and the merge', async () => {
    const { rt, reads, merges } = await seed({ readNumberBranch: 'feat/another-lane' });

    const result = await rt.execution.executeAuthorizedForgeAction.executeAuthorizedForgeAction(
      mergeRequest(7),
    );

    expect(result).toEqual({ outcome: 'refused', reason: 'pull-request-unverified' });
    expect(reads).toHaveLength(1);
    expect(merges).toHaveLength(0);
    const grant = await rt.coordination.coordinationRequestRepository.findRequestByGrantId('grant-wb5b2');
    expect(grant?.consumptions).toHaveLength(0);
  });

  it('merges the verified number: gh receives it with the head pin, and the journal records the same number', async () => {
    const { rt, reads, merges } = await seed({ readNumberBranch: BRANCH });

    const result = await rt.execution.executeAuthorizedForgeAction.executeAuthorizedForgeAction(
      mergeRequest(7),
    );

    expect(result.outcome).toBe('executed');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toEqual(expect.arrayContaining(['pr', 'view', '7', '-R', 'martinkrakowski/fleet-v2']));
    expect(merges).toEqual([['pr', 'merge', '-R', 'martinkrakowski/fleet-v2', '7', '--match-head-commit', HEAD, '--merge']]);
    const entries = await rt.execution.executionJournal.listJournalEntriesForAttempt('att-wb5b2');
    expect(entries.find((entry) => entry.status === 'completed')?.pullRequest).toEqual({
      repository: 'martinkrakowski/fleet-v2',
      number: 7,
    });
    expect((await rt.execution.workOrderRepository.findWorkOrderById('wo-wb5b2'))?.state).toBe('merged');
    // WB5b3: the merge record itself is stored under the canonical
    // lower-case `owner/repo`, and a mixed-case lookup still finds it.
    const stored = await rt.execution.mergeRecordRepository.findMergeRecord(
      'martinkrakowski/fleet-v2',
      7,
    );
    expect(stored).toMatchObject({
      repository: 'martinkrakowski/fleet-v2',
      number: 7,
      headSha: HEAD,
      source: 'fleet-forge-action',
      merger: 'fleet',
    });
  });
});
