/**
 * Unit tests for EX-2b: the operator-opt-in worktree reap
 * (`ReapLaneWorktreesUseCase`). Fakes cover every rule: a terminal candidate
 * is removed and journalled with no branch command, each skip reason, a dry
 * run that never calls remove, and refusals that are reported while the scan
 * continues.
 */

import { describe, expect, it } from 'vitest';

import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  CapacityReservationRecord,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import { laneRunConductEntry } from '../../../domain/lane-run-step-facts.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunRepositoryPort } from '../../ports/out/LaneRunRepositoryPort.out-port.js';
import type { ProjectProfileReadPort, ProjectProfileView } from '../../ports/out/ProjectProfileReadPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { RemoveLaneWorktreeRequest, RemoveLaneWorktreeResult, WorkspacePort } from '../../ports/out/WorkspacePort.out-port.js';
import { ReapLaneWorktreesUseCase } from '../ReapLaneWorktreesUseCase.use-case.js';
import type { ReapLaneWorktreesResult } from '../../ports/in/ReapLaneWorktreesPort.in-port.js';

const NOW = '2026-10-31T00:00:00.000Z';
/** Run ids must satisfy the run-id pattern or the journal reads them as `ready`. */
const RUN_1 = 'run-01JB000000000000000000000A';
const RUN_2 = 'run-01JB000000000000000000000B';
const COMMIT = 'a'.repeat(40);
const WORKTREE = '/tmp/worktree-example-1';

const RECORDED_HOST = {
  kind: 'opencode' as const,
  remotePort: 4166,
  host: 'lane-host',
  hostName: 'lane-host',
  agent: null,
  model: null,
  variant: null,
};

function makeWorkOrder(id: string, overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id,
    projectId: 'project-a',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'repo-1',
    baseCommit: COMMIT,
    ownedPaths: ['src/example.ts'],
    policyRevision: 'policy-1',
    prerequisiteWorkOrderIds: [],
    state: 'merged',
    revision: 1,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    risk: 'standard',
    ...overrides,
  };
}

function attemptFixture(
  workOrderId: string,
  id: string,
  overrides: Partial<AttemptRecord> = {},
): AttemptRecord {
  return {
    id,
    workOrderId,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE,
    baseCommit: COMMIT,
    state: 'collected',
    outcome: null,
    briefDigest: 'b'.repeat(64),
    briefPackagePath: '.lane/brief-package',
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner: RECORDED_HOST,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
  };
}

function runRecord(
  runId: string,
  workOrderId: string,
  overrides: Partial<LaneRunRecord> = {},
): LaneRunRecord {
  return {
    version: 1,
    runId,
    workOrderId,
    tier: 2,
    seatPlanRef: 'c'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: [],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-1',
    ...overrides,
  } as LaneRunRecord;
}

function makeProfile(): ProjectProfileView {
  return {
    projectId: 'project-a',
    status: 'active',
    repository: 'https://example.com/example.git',
    clones: {
      'lane-host': { path: '/srv/fleet/clone', worktreeRoot: '/srv/fleet/worktrees' },
    },
    gateProcedures: [],
    revision: 1,
  };
}

type JournalFake = Pick<ReturnType<typeof makeExecutionJournal>, 'entries' | 'appendJournalEntry' | 'listJournalEntriesForAttempt' | 'listActiveReservations'>;

function makeExecutionJournal() {
  const entries: ActionJournalEntryRecord[] = [];
  let reservations: CapacityReservationRecord[] = [];
  return {
    entries,
    setReservations(next: CapacityReservationRecord[]) {
      reservations = next;
    },
    async listActiveReservations() {
      return reservations;
    },
    async listJournalEntriesForAttempt(attemptId: string) {
      return entries.filter((entry) => entry.attemptId === attemptId);
    },
    async appendJournalEntry(entry: ActionJournalEntryRecord) {
      entries.push(entry);
    },
  };
}

type WorkspaceFake = Pick<WorkspacePort, 'removeLaneWorktree'> & {
  calls: RemoveLaneWorktreeRequest[];
};

function makeWorkspace(result: RemoveLaneWorktreeResult): WorkspaceFake {
  const calls: RemoveLaneWorktreeRequest[] = [];
  return {
    calls,
    async removeLaneWorktree(request) {
      calls.push(request);
      return result;
    },
  };
}

interface Harness {
  readonly useCase: ReapLaneWorktreesUseCase;
  readonly workspace: WorkspaceFake | null;
  readonly journal: JournalFake;
  readonly calls: () => RemoveLaneWorktreeRequest[];
}

function harness(options: {
  workOrders?: WorkOrderRecord[];
  attempts?: AttemptRecord[];
  runs?: LaneRunRecord[];
  journalStates?: Map<string, string>;
  reservations?: CapacityReservationRecord[];
  profiles?: (ProjectProfileView | null)[];
  workspaceResult?: RemoveLaneWorktreeResult;
  noWorkspace?: boolean;
  noProfileRead?: boolean;
} = {}): Harness {
  const workOrders = new Map((options.workOrders ?? [makeWorkOrder('wo-a')]).map((r) => [r.id, r]));
  const attempts = options.attempts ?? [];
  const runs = options.runs ?? [];
  const journalStates = options.journalStates ?? new Map<string, string>();
  const profiles = options.profiles ?? [makeProfile()];

  const workOrderRepo: Pick<WorkOrderRepositoryPort, 'findWorkOrderById'> = {
    async findWorkOrderById(id) {
      return workOrders.get(id) ?? null;
    },
  };
  const attemptRepo: Pick<AttemptRepositoryPort, 'listAttemptsByWorkOrder'> = {
    async listAttemptsByWorkOrder(workOrderId) {
      return attempts.filter((attempt) => attempt.workOrderId === workOrderId);
    },
  };
  const runRepo: Pick<LaneRunRepositoryPort, 'list'> = {
    async list() {
      return runs;
    },
  };
  const runJournal: Pick<LaneRunJournalPort, 'listForRun'> = {
    async listForRun(runId) {
      const state = journalStates.get(runId);
      return state === undefined
        ? []
        : [laneRunConductEntry('01JB0000000000000000000001', runId, state as LaneRunStateValue, NOW)];
    },
  };
  const journal = makeExecutionJournal();
  journal.setReservations(options.reservations ?? []);

  const profileRead: ProjectProfileReadPort | undefined =
    options.noProfileRead === true
      ? undefined
      : {
          async readProjectProfile(projectId) {
            return (profiles.find((profile) => profile?.projectId === projectId) ?? null) as ProjectProfileView | null;
          },
        };
  const workspace = options.noWorkspace === true ? null : makeWorkspace(options.workspaceResult ?? { outcome: 'removed', branchTip: COMMIT });

  const useCase = new ReapLaneWorktreesUseCase({
    workOrderRepo,
    attemptRepo,
    runRepo,
    runJournal,
    executionJournal: journal,
    ...(profileRead !== undefined ? { profileRead } : {}),
    ...(workspace !== null ? { workspace } : {}),
  });
  return { useCase, workspace, journal, calls: () => workspace?.calls ?? [] };
}

function reap(h: Harness, request: { dryRun: boolean }): Promise<ReapLaneWorktreesResult> {
  return h.useCase.reapLaneWorktrees(request);
}

/** One terminal, eligible run: run merged, work order merged, one collected attempt on a recorded host. */
function eligibleSeed(): {
  workOrders: WorkOrderRecord[];
  attempts: AttemptRecord[];
  runs: LaneRunRecord[];
  journalStates: Map<string, string>;
} {
  return {
    workOrders: [makeWorkOrder('wo-a')],
    attempts: [attemptFixture('wo-a', 'attempt-1')],
    runs: [runRecord(RUN_1, 'wo-a', { attemptIds: ['attempt-1'] })],
    journalStates: new Map([[RUN_1, 'merged']]),
  };
}

describe('ReapLaneWorktreesUseCase', () => {
  it('removes a terminal candidate, journals its branchTip, and issues no branch command', async () => {
    const h = harness(eligibleSeed());
    const result = await reap(h, { dryRun: false });
    expect(result).toEqual({
      outcome: 'reaped',
      dryRun: false,
      removed: [{ runId: RUN_1, branchTip: COMMIT }],
      alreadyRemoved: [],
      refused: [],
      skipped: [],
    });
    // The only workspace call is the removal itself; no branch command exists.
    expect(h.calls()).toHaveLength(1);
    expect(h.calls()[0]).toEqual({
      clonePath: '/srv/fleet/clone',
      worktreeRoot: '/srv/fleet/worktrees',
      worktreePath: WORKTREE,
      branch: `fleet/${RUN_1}`,
      recordedHost: RECORDED_HOST,
    });
    // The removal is journalled on the latest attempt: worktree path, kept branch tip.
    expect(h.journal.entries).toHaveLength(1);
    expect(h.journal.entries[0]).toMatchObject({
      attemptId: 'attempt-1',
      workOrderId: 'wo-a',
      action: 'collect',
      status: 'completed',
      sessionId: null,
      detail: expect.stringContaining(`fleet/${RUN_1} kept at ${COMMIT}`),
    });
    expect(h.journal.entries[0].id).toBe('attempt-1:collect:1');
  });

  it('reports already-removed and skips nothing else', async () => {
    const h = harness({ ...eligibleSeed(), workspaceResult: { outcome: 'already-removed' } });
    const result = await reap(h, { dryRun: false });
    expect(result).toEqual({
      outcome: 'reaped',
      dryRun: false,
      removed: [],
      alreadyRemoved: [{ runId: RUN_1 }],
      refused: [],
      skipped: [],
    });
    expect(h.journal.entries).toHaveLength(0);
  });

  it.each([['no dryRun', {}], ['a non-boolean dryRun', { dryRun: 'false' }], ['a null input', null]])(
    'an execute with %s is a dry run and removes nothing',
    async (_label, input) => {
      const h = harness(eligibleSeed());
      const result = await h.useCase.execute(input);
      expect(result).toMatchObject({ outcome: 'reaped', dryRun: true });
      expect(h.calls()).toHaveLength(0);
      expect(h.journal.entries).toHaveLength(0);
    },
  );

  it('a dry run never calls remove and lists the candidate with a null tip', async () => {
    const h = harness(eligibleSeed());
    const result = await reap(h, { dryRun: true });
    expect(result).toEqual({
      outcome: 'reaped',
      dryRun: true,
      removed: [{ runId: RUN_1, branchTip: null }],
      alreadyRemoved: [],
      refused: [],
      skipped: [],
    });
    expect(h.calls()).toHaveLength(0);
    expect(h.journal.entries).toHaveLength(0);
  });

  it.each([
    ['non-terminal run', { journalStates: new Map([[RUN_1, 'running']]) }, 'run-not-terminal'],
    ['active work order', { workOrders: [makeWorkOrder('wo-a', { state: 'approved' })] }, 'work-order-active'],
    ['missing work order', { workOrders: [] }, 'work-order-active'],
    ['live attempt', { attempts: [attemptFixture('wo-a', 'attempt-1', { state: 'running' })] }, 'attempt-live'],
    ['missing attempt record', { attempts: [] }, 'attempt-live'],
    ['held slot', { reservations: [{ id: 'r1', attemptId: 'attempt-1', hostId: 'h', slotIndex: 0, held: true, seatTool: 'opencode' as const, reservedAtIso: NOW, releasedAtIso: null }] }, 'slot-held'],
    ['no recorded host', { attempts: [attemptFixture('wo-a', 'attempt-1', { runner: { ...RECORDED_HOST, hostName: null } })] }, 'no-recorded-host'],
    ['no clone for host', { profiles: [{ ...makeProfile(), clones: {} }] }, 'no-clone'],
    ['missing profile', { profiles: [null] }, 'no-clone'],
  ])('skips a %s with %s', async (_label, seed, reason) => {
    const h = harness({ ...eligibleSeed(), ...seed });
    const result = await reap(h, { dryRun: false });
    expect(result).toEqual({
      outcome: 'reaped',
      dryRun: false,
      removed: [],
      alreadyRemoved: [],
      refused: [],
      skipped: [{ runId: RUN_1, reason }],
    });
    expect(h.calls()).toHaveLength(0);
  });

  it('reports a dirty refusal and continues the scan', async () => {
    const h = harness({
      workOrders: [makeWorkOrder('wo-a')],
      attempts: [attemptFixture('wo-a', 'attempt-1'), attemptFixture('wo-a', 'attempt-2')],
      runs: [
        runRecord(RUN_1, 'wo-a', { attemptIds: ['attempt-1'] }),
        runRecord(RUN_2, 'wo-a', { attemptIds: ['attempt-2'] }),
      ],
      journalStates: new Map([[RUN_1, 'merged'], [RUN_2, 'merged']]),
      workspaceResult: { outcome: 'refused', reason: 'dirty' },
    });
    const result = await reap(h, { dryRun: false });
    expect(result.refused).toEqual([
      { runId: RUN_1, reason: 'dirty' },
      { runId: RUN_2, reason: 'dirty' },
    ]);
    expect(result.removed).toEqual([]);
    expect(h.calls()).toHaveLength(2);
  });

  it('reports an unknown removal as refused and exits the result with it', async () => {
    const h = harness({ ...eligibleSeed(), workspaceResult: { outcome: 'unknown' } });
    const result = await reap(h, { dryRun: false });
    expect(result.refused).toEqual([{ runId: RUN_1, reason: 'unknown' }]);
    expect(h.journal.entries).toHaveLength(0);
  });

  it('refuses not-configured when the workspace dependency is missing', async () => {
    const h = harness({ ...eligibleSeed(), noWorkspace: true });
    const result = await reap(h, { dryRun: false });
    expect(result.refused).toEqual([{ runId: RUN_1, reason: 'not-configured' }]);
    expect(result.skipped).toEqual([]);
  });

  it('refuses not-configured when the profile read dependency is missing', async () => {
    const h = harness({ ...eligibleSeed(), noProfileRead: true });
    const result = await reap(h, { dryRun: false });
    expect(result.refused).toEqual([{ runId: RUN_1, reason: 'not-configured' }]);
  });

  it('sorts every list by runId in code-unit order', async () => {
    const runC = 'run-01JB000000000000000000000C';
    const runD = 'run-01JB000000000000000000000D';
    const h = harness({
      workOrders: [makeWorkOrder('wo-a')],
      attempts: [
        attemptFixture('wo-a', 'attempt-1', { worktreePath: '/tmp/wt-a' }),
        attemptFixture('wo-a', 'attempt-2', { worktreePath: '/tmp/wt-b' }),
        attemptFixture('wo-a', 'attempt-3', { worktreePath: '/tmp/wt-c' }),
        attemptFixture('wo-a', 'attempt-4', { worktreePath: '/tmp/wt-d' }),
      ],
      runs: [
        runRecord(RUN_2, 'wo-a', { attemptIds: ['attempt-2'] }),
        runRecord(RUN_1, 'wo-a', { attemptIds: ['attempt-1'] }),
        runRecord(runC, 'wo-a', { attemptIds: ['attempt-3'] }),
        runRecord(runD, 'wo-a', { attemptIds: ['attempt-4'] }),
      ],
      journalStates: new Map([
        [RUN_1, 'merged'],
        [RUN_2, 'merged'],
        [runC, 'merged'],
        [runD, 'merged'],
      ]),
    });
    // Outcomes differ per worktree path, so every list has an entry: RUN_1
    // and C removed, RUN_2 already-removed, D refused dirty.
    h.workspace!.removeLaneWorktree = async (request) => {
      if (request.worktreePath === '/tmp/wt-b') {
        return { outcome: 'already-removed' };
      }
      if (request.worktreePath === '/tmp/wt-d') {
        return { outcome: 'refused', reason: 'dirty' };
      }
      return { outcome: 'removed', branchTip: COMMIT };
    };
    const result = await reap(h, { dryRun: false });
    expect(result.removed.map((entry) => entry.runId)).toEqual([RUN_1, runC]);
    expect(result.alreadyRemoved.map((entry) => entry.runId)).toEqual([RUN_2]);
    expect(result.refused.map((entry) => entry.runId)).toEqual([runD]);
    expect(result.skipped).toEqual([]);
  });
});
