/**
 * Unit tests for EX-2b / C2': the operator-opt-in worktree reap
 * (`ReapLaneWorktreesUseCase`). Fakes cover every rule: a terminal candidate
 * is removed through `inspectWorktreeForRemoval` + `removeWorktree` and
 * journalled with no branch command, each skip reason, a dry run that never
 * calls remove, refusals that are reported while the scan continues, the
 * sealed-manifest gate (`uncollected`, tampered, `--force-unsealed`), the
 * keyed idempotence and crash recovery, the budget guard, and the redaction.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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
import type {
  InspectWorktreeForRemovalRequest,
  InspectWorktreeForRemovalResult,
  RemoveWorktreeRequest,
  RemoveWorktreeResult,
  WorkspacePort,
} from '../../ports/out/WorkspacePort.out-port.js';
import type {
  AuthorizeUnsealedWorktreeRemovalRequest,
  AuthorizeUnsealedWorktreeRemovalResult,
} from '../../ports/out/ActionAuthorizationPort.out-port.js';
import type { ArtifactManifestRemovalCheckResult } from '../../ports/out/AttemptArtifactPort.out-port.js';
import type { RunnerForAttemptPort } from '../../ports/out/RunnerForAttemptPort.out-port.js';
import {
  ReapLaneWorktreesDependencies,
  ReapLaneWorktreesUseCase,
  unsealedRemovalRequestDigest,
} from '../ReapLaneWorktreesUseCase.use-case.js';
import type { ReapLaneWorktreesResult } from '../../ports/in/ReapLaneWorktreesPort.in-port.js';

const NOW = '2026-10-31T00:00:00.000Z';
/** Run ids must satisfy the run-id pattern or the journal reads them as `ready`. */
const RUN_1 = 'run-01JB000000000000000000000A';
const RUN_2 = 'run-01JB000000000000000000000B';
const COMMIT = 'a'.repeat(40);
const WORKTREE = '/tmp/worktree-example-1';
/** The sealed manifest coordinates a C1 collection recorded on the attempt. */
const MANIFEST_SHA = 'a'.repeat(64);
const MANIFEST_PATH = `.lane/artifacts-manifest-${'a'.repeat(16)}.json`;
const APPROVAL_REFERENCE = 'oq-1:cr-1:grant-1';

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

/** The attempt's sealed `CollectedAttemptArtifacts` (C1): a content-addressed manifest. */
function sealedArtifacts(): NonNullable<AttemptRecord['artifacts']> {
  return {
    headCommit: COMMIT,
    commitsSinceBase: [],
    collectedArtifactPaths: ['.lane/notes.md'],
    notes: 'present',
    manifestPath: MANIFEST_PATH,
    manifestSha256: MANIFEST_SHA,
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

type JournalFake = Pick<
  ReturnType<typeof makeExecutionJournal>,
  'entries' | 'appendJournalEntry' | 'listJournalEntriesForAttempt' | 'listActiveReservations'
>;

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

/** The clean, unlocked, idle facts `inspectWorktreeForRemoval` answers with. */
type RemovalFacts = Extract<InspectWorktreeForRemovalResult, { outcome: 'inspected' }>['facts'];

function cleanFacts(overrides: Partial<RemovalFacts> = {}): RemovalFacts {
  return {
    path: WORKTREE,
    head: COMMIT,
    branch: `fleet/${RUN_1}`,
    detached: false,
    headOnDefault: true,
    status: { tracked: 0, untracked: 0, unmerged: 0 },
    locked: false,
    inProgressOperations: [],
    lastActivity: { iso: NOW, unknown: false },
    sizeBytes: 1024,
    ...overrides,
  };
}

type InspectFake = (
  request: InspectWorktreeForRemovalRequest,
) => Promise<InspectWorktreeForRemovalResult> | InspectWorktreeForRemovalResult;

type RemoveFake = (
  request: RemoveWorktreeRequest,
) => Promise<RemoveWorktreeResult> | RemoveWorktreeResult;

type WorkspaceFake = Pick<WorkspacePort, 'inspectWorktreeForRemoval' | 'removeWorktree'> & {
  readonly inspectCalls: InspectWorktreeForRemovalRequest[];
  readonly removeCalls: RemoveWorktreeRequest[];
};

function makeWorkspace(
  inspect: InspectFake = () => ({ outcome: 'inspected', facts: cleanFacts() }),
  remove: RemoveFake = () => ({ outcome: 'removed', branchTip: COMMIT }),
): WorkspaceFake {
  const inspectCalls: InspectWorktreeForRemovalRequest[] = [];
  const removeCalls: RemoveWorktreeRequest[] = [];
  return {
    inspectCalls,
    removeCalls,
    async inspectWorktreeForRemoval(request) {
      inspectCalls.push(request);
      return inspect(request);
    },
    async removeWorktree(request) {
      removeCalls.push(request);
      return remove(request);
    },
  };
}

type AttemptArtifactFake =
  | { readonly outcome: 'sealed' | 'missing' | 'unknown' }
  | { readonly outcome: 'mismatch' };

function makeAttemptArtifact(result: AttemptArtifactFake = { outcome: 'sealed' }) {
  return {
    async checkArtifactManifestForRemoval(_request: unknown): Promise<ArtifactManifestRemovalCheckResult> {
      if (result.outcome === 'mismatch') {
        return { outcome: 'mismatch', mismatches: [{ path: MANIFEST_PATH, kind: 'sha256' }] };
      }
      if (result.outcome === 'unknown') {
        return { outcome: 'unknown', reason: 'artifact-probe-unreadable' };
      }
      return { outcome: result.outcome as 'sealed' | 'missing' } as ArtifactManifestRemovalCheckResult;
    },
  };
}

type AuthorizationFake = {
  readonly calls: AuthorizeUnsealedWorktreeRemovalRequest[];
  authorizeUnsealedWorktreeRemoval(
    request: AuthorizeUnsealedWorktreeRemovalRequest,
  ): Promise<AuthorizeUnsealedWorktreeRemovalResult>;
};

function makeActionAuthorization(
  result: AuthorizeUnsealedWorktreeRemovalResult = {
    outcome: 'approved',
    approvalReference: APPROVAL_REFERENCE,
  },
): AuthorizationFake {
  const calls: AuthorizeUnsealedWorktreeRemovalRequest[] = [];
  return {
    calls,
    async authorizeUnsealedWorktreeRemoval(request) {
      calls.push(request);
      return result;
    },
  };
}

interface Harness {
  readonly useCase: ReapLaneWorktreesUseCase;
  readonly workspace: WorkspaceFake | null;
  readonly journal: JournalFake;
  readonly authorization: AuthorizationFake | null;
  readonly removeCalls: () => RemoveWorktreeRequest[];
  readonly inspectCalls: () => InspectWorktreeForRemovalRequest[];
}

function harness(options: {
  workOrders?: WorkOrderRecord[];
  attempts?: AttemptRecord[];
  runs?: LaneRunRecord[];
  journalStates?: Map<string, string>;
  reservations?: CapacityReservationRecord[];
  profiles?: (ProjectProfileView | null)[];
  inspect?: InspectFake;
  remove?: RemoveFake;
  noWorkspace?: boolean;
  noProfileRead?: boolean;
  noAttemptArtifact?: boolean;
  noActionAuthorization?: boolean;
  attemptArtifact?: AttemptArtifactFake;
  authorization?: AuthorizeUnsealedWorktreeRemovalResult;
  runRepoList?: () => Promise<unknown>;  storeCallTimeoutMs?: number;
  appendJournalEntry?: JournalFake['appendJournalEntry'];
  listAttemptsThrows?: boolean;
  runnerForAttempt?: RunnerForAttemptPort;
  noRunnerForAttempt?: boolean;
} = {}): Harness {  const workOrders = new Map((options.workOrders ?? [makeWorkOrder('wo-a')]).map((r) => [r.id, r]));
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
      if (options.listAttemptsThrows === true) {
        throw new Error('attempt store unreadable');
      }
      return attempts.filter((attempt) => attempt.workOrderId === workOrderId);
    },
  };
  const runRepo: Pick<LaneRunRepositoryPort, 'list'> = {
    list: (options.runRepoList ?? (async () => runs)) as () => Promise<readonly LaneRunRecord[]>,
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
  if (options.appendJournalEntry !== undefined) {
    journal.appendJournalEntry = options.appendJournalEntry;
  }

  const profileRead: ProjectProfileReadPort | undefined =
    options.noProfileRead === true
      ? undefined
      : {
          async readProjectProfile(projectId) {
            return (profiles.find((profile) => profile?.projectId === projectId) ??
              null) as ProjectProfileView | null;
          },
        };
  const workspace =
    options.noWorkspace === true
      ? null
      : makeWorkspace(
          options.inspect ?? (() => ({ outcome: 'inspected', facts: cleanFacts() })),
          options.remove ?? (() => ({ outcome: 'removed', branchTip: COMMIT })),
        );

  const authorization =
    options.noActionAuthorization === true ? null : makeActionAuthorization(options.authorization);

  const runnerForAttempt: RunnerForAttemptPort | undefined =
    options.noRunnerForAttempt === true
      ? undefined
      : (options.runnerForAttempt ?? defaultRunnerForAttempt());

  const useCase = new ReapLaneWorktreesUseCase({
    workOrderRepo,
    attemptRepo,
    runRepo,
    runJournal,
    executionJournal: journal,
    ...(profileRead !== undefined ? { profileRead } : {}),
    ...(workspace !== null ? { workspace } : {}),
    ...(options.noAttemptArtifact === true
      ? {}
      : { attemptArtifact: makeAttemptArtifact(options.attemptArtifact) }),
    ...(authorization !== null ? { actionAuthorization: authorization } : {}),
    ...(runnerForAttempt === undefined
      ? {}
      : ({ runnerForAttempt } as { runnerForAttempt: RunnerForAttemptPort })),
    ...(options.storeCallTimeoutMs !== undefined
      ? { storeCallTimeoutMs: options.storeCallTimeoutMs }
      : {}),
  } as ReapLaneWorktreesDependencies);
  return {
    useCase,
    workspace,
    journal,
    authorization,
    removeCalls: () => workspace?.removeCalls ?? [],
    inspectCalls: () => workspace?.inspectCalls ?? [],
  };
}

function reap(
  h: Harness,
  request: { dryRun: boolean } & Record<string, unknown>,
): Promise<Extract<ReapLaneWorktreesResult, { outcome: 'reaped' }>> {
  return h.useCase.reapLaneWorktrees(request as never) as Promise<
    Extract<ReapLaneWorktreesResult, { outcome: 'reaped' }>
  >;
}

/** The default fake runner: answers idle so fixtures stay eligible without the option. */
function defaultRunnerForAttempt(): RunnerForAttemptPort {
  return {
    runnerForAttempt: () => ({
      ok: true,
      runner: {
        async inspectWorktreeRun() {
          return { state: 'idle' };
        },
      } as never,
    }),
  };
}

/** One terminal, eligible run: merged journal, merged work order, one collected attempt with a sealed manifest. */
function eligibleSeed(): {
  workOrders: WorkOrderRecord[];
  attempts: AttemptRecord[];
  runs: LaneRunRecord[];
  journalStates: Map<string, string>;
} {
  return {
    workOrders: [makeWorkOrder('wo-a')],
    attempts: [attemptFixture('wo-a', 'attempt-1', { artifacts: sealedArtifacts() })],
    runs: [runRecord(RUN_1, 'wo-a', { attemptIds: ['attempt-1'] })],
    journalStates: new Map([[RUN_1, 'merged']]),
  };
}

describe('ReapLaneWorktreesUseCase', () => {
  it('removes a terminal candidate through inspect + remove, journals its branchTip, and issues no branch command', async () => {
    const h = harness(eligibleSeed());
    const result = await reap(h, { dryRun: false });
    expect(result).toEqual({
      outcome: 'reaped',
      dryRun: false,
      removed: [{ runId: RUN_1, branchTip: COMMIT }],
      alreadyRemoved: [],
      refused: [],
      skipped: [],
      journalFailed: [],
    });
    // The removal is gated on the sealed manifest coordinates and re-checked
    // against the facts the inspection read.
    expect(h.removeCalls()).toHaveLength(1);
    expect(h.removeCalls()[0]).toEqual({
      repositoryRoot: '/srv/fleet/clone',
      worktreeRoot: '/srv/fleet/worktrees',
      worktreePath: WORKTREE,
      expectedHead: COMMIT,
      expectedBranch: `fleet/${RUN_1}`,
      expectedLastActivityIso: NOW,
      recordedHost: RECORDED_HOST,
      manifest: {
        kind: 'sealed',
        attemptId: 'attempt-1',
        manifestPath: MANIFEST_PATH,
        expectedManifestSha256: MANIFEST_SHA,
      },
    });
    expect(h.removeCalls()[0]!.recordedHost).toEqual(RECORDED_HOST);
    // The removal is journalled on the latest attempt: kept branch tip, no path.
    expect(h.journal.entries).toHaveLength(1);
    expect(h.journal.entries[0]).toMatchObject({
      attemptId: 'attempt-1',
      workOrderId: 'wo-a',
      action: 'collect',
      status: 'completed',
      sessionId: null,
      detail: expect.stringContaining(`fleet/${RUN_1} kept at ${COMMIT}`),
    });
    expect(h.journal.entries[0]!.id).toBe('attempt-1:collect:1');
    expect(h.journal.entries[0]!.detail).not.toContain(WORKTREE);
  });

  it('reports already-removed when the worktree is no longer a linked worktree', async () => {
    const h = harness({
      ...eligibleSeed(),
      inspect: () => ({ outcome: 'refused', reason: 'not-a-linked-worktree' }),
    });
    const result = await reap(h, { dryRun: false });
    expect(result).toEqual({
      outcome: 'reaped',
      dryRun: false,
      removed: [],
      alreadyRemoved: [{ runId: RUN_1 }],
      refused: [],
      skipped: [],
      journalFailed: [],
    });
    expect(h.journal.entries).toHaveLength(0);
  });

  it.each([['no dryRun', {}], ['a non-boolean dryRun', { dryRun: 'false' }], ['a null input', null]])(
    'an execute with %s is a dry run and removes nothing',
    async (_label, input) => {
      const h = harness(eligibleSeed());
      const result = await h.useCase.execute(input);
      expect(result).toMatchObject({ outcome: 'reaped', dryRun: true });
      expect(h.removeCalls()).toHaveLength(0);
      expect(h.journal.entries).toHaveLength(0);
    },
  );

  it('a dry run never calls inspect or remove and lists the candidate with a null tip', async () => {
    const h = harness(eligibleSeed());
    const result = await reap(h, { dryRun: true });
    expect(result).toEqual({
      outcome: 'reaped',
      dryRun: true,
      removed: [{ runId: RUN_1, branchTip: null }],
      alreadyRemoved: [],
      refused: [],
      skipped: [],
      journalFailed: [],
    });
    expect(h.removeCalls()).toHaveLength(0);
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
      journalFailed: [],
    });
    expect(h.removeCalls()).toHaveLength(0);
  });

  it('reports a dirty refusal and continues the scan', async () => {
    const h = harness({
      workOrders: [makeWorkOrder('wo-a')],
      attempts: [
        attemptFixture('wo-a', 'attempt-1', { worktreePath: '/tmp/wt-1', artifacts: sealedArtifacts() }),
        attemptFixture('wo-a', 'attempt-2', { worktreePath: '/tmp/wt-2', artifacts: sealedArtifacts() }),
      ],
      runs: [
        runRecord(RUN_1, 'wo-a', { attemptIds: ['attempt-1'] }),
        runRecord(RUN_2, 'wo-a', { attemptIds: ['attempt-2'] }),
      ],
      journalStates: new Map([[RUN_1, 'merged'], [RUN_2, 'merged']]),
      inspect: (request) => ({
        outcome: 'inspected',
        facts: cleanFacts({
          path: request.worktreePath,
          branch:
            request.worktreePath === '/tmp/wt-1' ? `fleet/${RUN_1}` : `fleet/${RUN_2}`,
        }),
      }),
      remove: () => ({ outcome: 'refused', reason: 'dirty' }),
    });
    const result = await reap(h, { dryRun: false });
    expect(result.refused).toEqual([
      { runId: RUN_1, reason: 'dirty' },
      { runId: RUN_2, reason: 'dirty' },
    ]);
    expect(result.removed).toEqual([]);
    expect(h.removeCalls()).toHaveLength(2);
  });

  it('reports an unknown removal as refused and exits the result with it', async () => {
    const h = harness({
      ...eligibleSeed(),
      remove: () => ({ outcome: 'unknown', reason: 'the remove did not report an exit code' }),
    });
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
    const attempts = [
      attemptFixture('wo-a', 'attempt-1', { worktreePath: '/tmp/wt-a', artifacts: sealedArtifacts() }),
      attemptFixture('wo-a', 'attempt-2', { worktreePath: '/tmp/wt-b', artifacts: sealedArtifacts() }),
      attemptFixture('wo-a', 'attempt-3', { worktreePath: '/tmp/wt-c', artifacts: sealedArtifacts() }),
      attemptFixture('wo-a', 'attempt-4', { worktreePath: '/tmp/wt-d', artifacts: sealedArtifacts() }),
    ];
    const h = harness({
      workOrders: [makeWorkOrder('wo-a')],
      attempts,
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
    h.workspace!.removeWorktree = async (request) => {
      if (request.worktreePath === '/tmp/wt-d') {
        return { outcome: 'refused', reason: 'dirty' };
      }
      return { outcome: 'removed', branchTip: COMMIT };
    };
    const branchByPath = new Map<string, string>([
      ['/tmp/wt-a', `fleet/${RUN_1}`],
      ['/tmp/wt-c', `fleet/${runC}`],
      ['/tmp/wt-d', `fleet/${runD}`],
    ]);
    h.workspace!.inspectWorktreeForRemoval = async (request) => {
      if (request.worktreePath === '/tmp/wt-b') {
        return { outcome: 'refused', reason: 'not-a-linked-worktree' };
      }
      return {
        outcome: 'inspected',
        facts: cleanFacts({ branch: branchByPath.get(request.worktreePath) ?? null }),
      };
    };
    const result = await reap(h, { dryRun: false });
    expect(result.removed.map((entry) => entry.runId)).toEqual([RUN_1, runC]);
    expect(result.alreadyRemoved.map((entry) => entry.runId)).toEqual([RUN_2]);
    expect(result.refused.map((entry) => entry.runId)).toEqual([runD]);
    expect(result.skipped).toEqual([]);
  });

  it('reports a failed post-removal journal append per removal and continues the scan', async () => {
    const h = harness({
      workOrders: [makeWorkOrder('wo-a')],
      attempts: [
        attemptFixture('wo-a', 'attempt-1', { worktreePath: '/tmp/wt-1', artifacts: sealedArtifacts() }),
        attemptFixture('wo-a', 'attempt-2', { worktreePath: '/tmp/wt-2', artifacts: sealedArtifacts() }),
      ],
      runs: [
        runRecord(RUN_1, 'wo-a', { attemptIds: ['attempt-1'] }),
        runRecord(RUN_2, 'wo-a', { attemptIds: ['attempt-2'] }),
      ],
      journalStates: new Map([
        [RUN_1, 'merged'],
        [RUN_2, 'merged'],
      ]),
      inspect: (request) => ({
        outcome: 'inspected',
        facts: cleanFacts({
          path: request.worktreePath,
          branch:
            request.worktreePath === '/tmp/wt-1' ? `fleet/${RUN_1}` : `fleet/${RUN_2}`,
        }),
      }),
    });
    // The primary completed append throws for every removal; RUN_2's fallback
    // ambiguous append throws too, yet the scan still finishes.
    const originalAppend = h.journal.appendJournalEntry;
    h.journal.appendJournalEntry = async (entry) => {
      if (entry.status === 'completed' || entry.attemptId === 'attempt-2') {
        throw new Error('journal write failed');
      }
      await originalAppend(entry);
    };
    const result = await reap(h, { dryRun: false });
    expect(result.removed).toEqual([
      { runId: RUN_1, branchTip: COMMIT },
      { runId: RUN_2, branchTip: COMMIT },
    ]);
    expect(result.journalFailed).toEqual([
      { runId: RUN_1, attemptId: 'attempt-1', branchTip: COMMIT, reason: 'journal write failed' },
      { runId: RUN_2, attemptId: 'attempt-2', branchTip: COMMIT, reason: 'journal write failed' },
    ]);
    // The best-effort ambiguous fallback records RUN_1's failure reason; RUN_2's
    // fallback also threw, so no ambiguous entry exists for it.
    const ambiguous = h.journal.entries.filter((entry) => entry.status === 'ambiguous');
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]).toMatchObject({
      attemptId: 'attempt-1',
      workOrderId: 'wo-a',
      action: 'collect',
      status: 'ambiguous',
      sessionId: null,
    });
    expect(ambiguous[0]!.detail).toContain('journal write failed');
  });

  // --- C2': the sealed-manifest gate and --force-unsealed -------------------

  it('refuses an uncollected candidate with artifacts not collected and keeps the worktree', async () => {
    const h = harness({
      ...eligibleSeed(),
      attempts: [attemptFixture('wo-a', 'attempt-1', { artifacts: null })],
      remove: () => ({ outcome: 'refused', reason: 'artifacts not collected' }),
    });
    const result = await reap(h, { dryRun: false });
    expect(result.refused).toEqual([{ runId: RUN_1, reason: 'artifacts not collected' }]);
    expect(result.removed).toEqual([]);
    expect(h.journal.entries).toHaveLength(0);
  });

  it('refuses a tampered candidate with artifacts changed since collection and keeps the worktree', async () => {
    const h = harness({
      ...eligibleSeed(),
      remove: () => ({ outcome: 'refused', reason: 'artifacts changed since collection' }),
    });
    const result = await reap(h, { dryRun: false });
    expect(result.refused).toEqual([{ runId: RUN_1, reason: 'artifacts changed since collection' }]);
    expect(result.removed).toEqual([]);
  });

  it('refuses forceUnsealed without an approval with unapproved-force-unsealed and removes nothing', async () => {
    const h = harness({
      ...eligibleSeed(),
      attempts: [attemptFixture('wo-a', 'attempt-1', { artifacts: null })],
      authorization: { outcome: 'blocked', reason: 'no-scoped-owner-approval' },
    });
    const result = await reap(h, { dryRun: false, forceUnsealed: true });
    expect(result.refused).toEqual([{ runId: RUN_1, reason: 'unapproved-force-unsealed' }]);
    expect(result.removed).toEqual([]);
    expect(h.removeCalls()).toHaveLength(0);
    expect(h.authorization!.calls).toHaveLength(1);
    // The intent entry was recorded before the ask, so a retry never re-asks
    // blindly; no completed entry exists.
    expect(h.journal.entries.map((entry) => entry.status)).toEqual(['intent-recorded']);
  });

  it('forceUnsealed with an approval removes a clean unlocked idle worktree and records approvalRef in the journal', async () => {
    const h = harness({
      ...eligibleSeed(),
      attempts: [attemptFixture('wo-a', 'attempt-1', { artifacts: null })],
    });
    const result = await reap(h, { dryRun: false, forceUnsealed: true });
    expect(result.removed).toEqual([{ runId: RUN_1, branchTip: COMMIT }]);
    expect(result.refused).toEqual([]);
    expect(h.removeCalls()).toHaveLength(1);
    expect(h.removeCalls()[0]!.manifest).toEqual({
      kind: 'force-unsealed',
      attemptId: 'attempt-1',
      approvalReference: APPROVAL_REFERENCE,
    });
    const completed = h.journal.entries.find((entry) => entry.status === 'completed');
    expect(completed!.detail).toContain(`approvalRef=${APPROVAL_REFERENCE}`);
    expect(completed!.detail).not.toContain(WORKTREE);
  });

  it.each([
    ['dirty', { status: { tracked: 1, untracked: 0, unmerged: 0 } } as Partial<RemovalFacts>, 'dirty'],
    ['locked', { locked: true } as Partial<RemovalFacts>, 'locked'],
    ['busy', { lastActivity: { iso: null, unknown: true } } as Partial<RemovalFacts>, 'busy'],
  ])('forceUnsealed on a %s worktree refuses without consuming the approval or removing', async (_label, facts, reason) => {
    const h = harness({
      ...eligibleSeed(),
      attempts: [attemptFixture('wo-a', 'attempt-1', { artifacts: null })],
      inspect: () => ({ outcome: 'inspected', facts: cleanFacts(facts) }),
    });
    const result = await reap(h, { dryRun: false, forceUnsealed: true });
    expect(result.refused).toEqual([{ runId: RUN_1, reason }]);
    expect(h.removeCalls()).toHaveLength(0);
    expect(h.authorization!.calls).toHaveLength(0);
    expect(h.journal.entries).toHaveLength(0);
  });

  it('forceUnsealed on a genuinely sealed worktree verifies the manifest first and removes without consuming an approval', async () => {
    const h = harness({
      ...eligibleSeed(),
      attemptArtifact: { outcome: 'sealed' },
    });
    const result = await reap(h, { dryRun: false, forceUnsealed: true });
    expect(result.removed).toEqual([{ runId: RUN_1, branchTip: COMMIT }]);
    expect(h.authorization!.calls).toHaveLength(0);
    expect(h.removeCalls()[0]!.manifest).toEqual({
      kind: 'sealed',
      attemptId: 'attempt-1',
      manifestPath: MANIFEST_PATH,
      expectedManifestSha256: MANIFEST_SHA,
    });
  });

  it('forceUnsealed on an unreadable sealed manifest refuses unknown and consumes nothing', async () => {
    const h = harness({
      ...eligibleSeed(),
      attemptArtifact: { outcome: 'unknown' },
    });
    const result = await reap(h, { dryRun: false, forceUnsealed: true });
    expect(result.refused).toEqual([{ runId: RUN_1, reason: 'unknown' }]);
    expect(h.removeCalls()).toHaveLength(0);
    expect(h.authorization!.calls).toHaveLength(0);
  });

  it('forceUnsealed on a tampered sealed manifest falls through to the unsealed authorization and removes', async () => {
    const h = harness({
      ...eligibleSeed(),
      attemptArtifact: { outcome: 'mismatch' },
    });
    const result = await reap(h, { dryRun: false, forceUnsealed: true });
    expect(result.removed).toEqual([{ runId: RUN_1, branchTip: COMMIT }]);
    expect(h.authorization!.calls).toHaveLength(1);
    expect(h.removeCalls()[0]!.manifest).toEqual({
      kind: 'force-unsealed',
      attemptId: 'attempt-1',
      approvalReference: APPROVAL_REFERENCE,
    });
  });

  it('forceUnsealed without the attempt-artifact dependency refuses unknown for a sealed coordinate', async () => {
    const h = harness({ ...eligibleSeed(), noAttemptArtifact: true });
    const result = await reap(h, { dryRun: false, forceUnsealed: true });
    expect(result.refused).toEqual([{ runId: RUN_1, reason: 'unknown' }]);
    expect(h.removeCalls()).toHaveLength(0);
  });

  it('forceUnsealed without the authorization dependency refuses not-configured', async () => {
    const h = harness({
      ...eligibleSeed(),
      attempts: [attemptFixture('wo-a', 'attempt-1', { artifacts: null })],
      noActionAuthorization: true,
    });
    const result = await reap(h, { dryRun: false, forceUnsealed: true });
    expect(result.refused).toEqual([{ runId: RUN_1, reason: 'not-configured' }]);
    expect(h.removeCalls()).toHaveLength(0);
  });

  // --- Runtime input guards -------------------------------------------------

  it('returns invalid-request without throwing on non-object requests, non-boolean forceUnsealed, invalid nowIso, sparse store arrays, and throwing getters', async () => {
    const h = harness(eligibleSeed());
    const throwingGetter = {
      get dryRun(): boolean {
        throw new Error('getter exploded');
      },
    };
    for (const bad of [
      { forceUnsealed: 'yes' },
      { forceUnsealed: 1 },
      { nowIso: 'not-a-date' },
      { nowIso: '2026-02-30T00:00:00.000Z' },
      throwingGetter,
    ]) {
      await expect(h.useCase.reapLaneWorktrees(bad as never)).resolves.toEqual({
        outcome: 'refused',
        reason: 'invalid-request',
      });
    }
    await expect(h.useCase.reapLaneWorktrees(null as never)).resolves.toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    await expect(h.useCase.reapLaneWorktrees(7 as never)).resolves.toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    await expect(h.useCase.execute(7 as never)).resolves.toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(h.removeCalls()).toHaveLength(0);
  });

  it('reports store-unreadable when the top-level run store throws, returns a non-array, or the journal read fails', async () => {
    const throwing = harness({
      ...eligibleSeed(),
      runRepoList: async () => {
        throw new Error('store unreadable');
      },
    });
    await expect(reap(throwing, { dryRun: false })).resolves.toEqual({
      outcome: 'unknown',
      reason: 'store-unreadable',
    });
    const nonArray = harness({
      ...eligibleSeed(),
      runRepoList: async () => ({ not: 'an array' }),
    });
    await expect(reap(nonArray, { dryRun: false })).resolves.toEqual({
      outcome: 'unknown',
      reason: 'store-unreadable',
    });
    const holey = harness({
      ...eligibleSeed(),
      runs: (() => {
        const sparse: LaneRunRecord[] = [runRecord(RUN_1, 'wo-a', { attemptIds: ['attempt-1'] })];
        sparse.length = 2;
        return sparse;
      })(),
    });
    const holeyResult = await reap(holey, { dryRun: false });
    expect(holeyResult.outcome).toBe('reaped');
    expect(holeyResult.removed.map((entry) => entry.runId)).toEqual([RUN_1]);
  });

  it('reports per-run unknown when repository or journal reads throw, never treating unreadable state as empty or skipped', async () => {
    const h = harness({ ...eligibleSeed(), listAttemptsThrows: true });
    const result = await reap(h, { dryRun: false });
    expect(result.refused).toEqual([{ runId: RUN_1, reason: 'unknown' }]);
    expect(result.skipped).toEqual([]);
    expect(h.removeCalls()).toHaveLength(0);
  });

  it('cuts short an exceeded outbound call via storeCallTimeoutMs, refuses unknown, and completes cleanly on the next pass', async () => {
    // First pass: the top-level run read hangs past the budget and the whole
    // scan refuses unknown without removing anything.
    let hang = true;
    const hung = harness({
      workOrders: [makeWorkOrder('wo-a')],
      attempts: [attemptFixture('wo-a', 'attempt-1', { artifacts: sealedArtifacts() })],
      runs: [runRecord(RUN_1, 'wo-a', { attemptIds: ['attempt-1'] })],
      journalStates: new Map([[RUN_1, 'merged']]),
      storeCallTimeoutMs: 25,
      runRepoList: async () => {
        if (hang) {
          await new Promise(() => {
            /* never settles */
          });
        }
        return [runRecord(RUN_1, 'wo-a', { attemptIds: ['attempt-1'] })];
      },
    });
    const first = await hung.useCase.reapLaneWorktrees({ dryRun: false } as never);
    expect(first).toEqual({ outcome: 'unknown', reason: 'store-unreadable' });
    expect(hung.removeCalls()).toHaveLength(0);
    // Next pass: the store answers and the reap completes cleanly.
    hang = false;
    const second = (await hung.useCase.reapLaneWorktrees({ dryRun: false } as never)) as Extract<
      ReapLaneWorktreesResult,
      { outcome: 'reaped' }
    >;
    expect(second.outcome).toBe('reaped');
    expect(second.removed).toEqual([{ runId: RUN_1, branchTip: COMMIT }]);
  });

  it('is idempotent on repeat reap and recovers from a crash between unsealed-removal intent and worktree removal', async () => {
    const seed = eligibleSeed();
    const h = harness({
      ...seed,
      attempts: [attemptFixture('wo-a', 'attempt-1', { artifacts: null })],
    });
    // First pass removes.
    const first = await reap(h, { dryRun: false, forceUnsealed: true });
    expect(first.removed).toEqual([{ runId: RUN_1, branchTip: COMMIT }]);
    // A repeat reap sees the completed removal journal entry and reports
    // alreadyRemoved without re-removing and without failing artifacts not
    // collected — even though the attempt has no sealed manifest at all.
    const second = await reap(h, { dryRun: false, forceUnsealed: true });
    expect(second.alreadyRemoved).toEqual([{ runId: RUN_1 }]);
    expect(second.removed).toEqual([]);
    expect(h.removeCalls()).toHaveLength(1);
    // Crash recovery: a crash between the intent entry and the removal leaves
    // the intent in the journal; the retry consumes the approval and removes
    // once, without a second intent entry.
    const crashed = harness({
      ...seed,
      attempts: [attemptFixture('wo-a', 'attempt-1', { artifacts: null })],
      journalStates: new Map([[RUN_1, 'merged']]),
    });
    const intentId = 'attempt-1:collect:reap-unsealed-intent:' + RUN_1;
    await crashed.journal.appendJournalEntry({
      id: intentId,
      attemptId: 'attempt-1',
      workOrderId: 'wo-a',
      action: 'collect',
      baseCommit: COMMIT,
      recordedAtIso: NOW,
      status: 'intent-recorded',
      sessionId: null,
      detail:
        `Authorizing unsealed worktree removal for attempt attempt-1 on branch fleet/${RUN_1}; ` +
        `requestDigest=${unsealedRemovalRequestDigest({
          attemptId: 'attempt-1',
          expectedHeadSha: COMMIT,
          projectId: 'project-a',
          repositoryRoot: '/srv/fleet/clone',
          runId: RUN_1,
          worktreePath: WORKTREE,
          worktreeRoot: '/srv/fleet/worktrees',
        })}`,
    });
    const recovered = await reap(crashed, { dryRun: false, forceUnsealed: true });
    expect(recovered.removed).toEqual([{ runId: RUN_1, branchTip: COMMIT }]);
    expect(crashed.journal.entries.filter((entry) => entry.id === intentId)).toHaveLength(1);
  });

  it('refuses invalid-request on missing or wrong-typed dryRun in reapLaneWorktrees while keeping execute defaults', async () => {
    let storeReads = 0;
    const h = harness({
      ...eligibleSeed(),
      runRepoList: async () => {
        storeReads += 1;
        return [];
      },
    });
    for (const bad of [{}, { dryRun: 'false' }, { dryRun: 0 }, { dryRun: undefined }, { dryRun: null }]) {
      await expect(h.useCase.reapLaneWorktrees(bad as never)).resolves.toEqual({
        outcome: 'refused',
        reason: 'invalid-request',
      });
    }
    expect(storeReads).toBe(0);
    expect(h.removeCalls()).toHaveLength(0);
    expect(h.journal.entries).toHaveLength(0);

    // `execute` keeps its pinned defaults: only an explicit `dryRun: false` removes.
    const defaults = harness(eligibleSeed());
    await expect(defaults.useCase.execute({ dryRun: 'false' })).resolves.toMatchObject({
      outcome: 'reaped',
      dryRun: true,
    });
    await expect(defaults.useCase.execute(undefined)).resolves.toMatchObject({ outcome: 'reaped', dryRun: true });
    const throwingGetter = {
      get dryRun(): boolean {
        throw new Error('getter exploded');
      },
    };
    for (const bad of [7, 'x', [], { forceUnsealed: 'yes' }, { nowIso: 'nope' }, throwingGetter]) {
      await expect(defaults.useCase.execute(bad)).resolves.toEqual({
        outcome: 'refused',
        reason: 'invalid-request',
      });
    }
    expect(defaults.removeCalls()).toHaveLength(0);
    await expect(defaults.useCase.execute({ dryRun: false })).resolves.toMatchObject({
      outcome: 'reaped',
      dryRun: false,
      removed: [{ runId: RUN_1, branchTip: COMMIT }],
    });
  });

  it('verifies the worktree runner is idle before consuming a force-unsealed approval or removing', async () => {
    const runnerCalls: unknown[] = [];
    const runnerFor = (
      answer: () => Promise<unknown>,
    ): RunnerForAttemptPort => ({
      runnerForAttempt: () => ({
        ok: true,
        runner: {
          async inspectWorktreeRun(this: unknown, ref: unknown) {
            runnerCalls.push(ref);
            return answer();
          },
        } as never,
      }),
    });
    const unsealedSeed = () => ({
      ...eligibleSeed(),
      attempts: [attemptFixture('wo-a', 'attempt-1', { artifacts: null })],
    });

    const running = harness({
      ...unsealedSeed(),
      runnerForAttempt: runnerFor(async () => ({ state: 'running', sessionId: 'ses_active1' })),
    });
    const busy = await reap(running, { dryRun: false, forceUnsealed: true });
    expect(busy.refused).toEqual([{ runId: RUN_1, reason: 'busy' }]);
    expect(busy.removed).toEqual([]);
    expect(running.authorization!.calls).toHaveLength(0);
    expect(running.removeCalls()).toHaveLength(0);
    expect(running.journal.entries).toHaveLength(0);
    expect(runnerCalls[0]).toEqual({ attemptId: 'attempt-1', worktreePath: WORKTREE, runner: RECORDED_HOST });

    const unprovable: [string, RunnerForAttemptPort][] = [
      ['state unknown', runnerFor(async () => ({ state: 'unknown', reason: 'runner unreachable' }))],
      ['an unexpected state', runnerFor(async () => ({ state: 'sleeping' }))],
      ['a non-object answer', runnerFor(async () => 'idle')],
      [
        'a rejected inspect',
        runnerFor(async () => {
          throw new Error('inspect failed');
        }),
      ],
      ['a host-missing selection', { runnerForAttempt: () => ({ ok: false, reason: 'host-missing' }) }],
      [
        'a throwing selection',
        {
          runnerForAttempt: () => {
            throw new Error('resolver exploded');
          },
        },
      ],
      ['a runner without inspectWorktreeRun', { runnerForAttempt: () => ({ ok: true, runner: {} as never }) }],
    ];
    for (const [label, runnerForAttempt] of unprovable) {
      const h = harness({ ...unsealedSeed(), runnerForAttempt });
      const result = await reap(h, { dryRun: false, forceUnsealed: true });
      expect(result.refused, label).toEqual([{ runId: RUN_1, reason: 'unknown' }]);
      expect(result.removed, label).toEqual([]);
      expect(h.authorization!.calls, label).toHaveLength(0);
      expect(h.removeCalls(), label).toHaveLength(0);
      expect(h.journal.entries, label).toHaveLength(0);
    }

    // A sealed removal without `forceUnsealed` is guarded too.
    const sealedBusy = harness({
      ...eligibleSeed(),
      runnerForAttempt: runnerFor(async () => ({ state: 'running', sessionId: 'ses_active1' })),
    });
    const sealedResult = await reap(sealedBusy, { dryRun: false });
    expect(sealedResult.refused).toEqual([{ runId: RUN_1, reason: 'busy' }]);
    expect(sealedBusy.removeCalls()).toHaveLength(0);

    // A runner that hangs past the budget is unknown, never idle.
    const hung = harness({
      ...unsealedSeed(),
      storeCallTimeoutMs: 25,
      runnerForAttempt: runnerFor(
        () =>
          new Promise(() => {
            /* never settles */
          }),
      ),
    });
    const hungResult = await reap(hung, { dryRun: false, forceUnsealed: true });
    expect(hungResult.refused).toEqual([{ runId: RUN_1, reason: 'unknown' }]);
    expect(hung.removeCalls()).toHaveLength(0);

    const idle = harness({
      ...unsealedSeed(),
      runnerForAttempt: runnerFor(async () => ({ state: 'idle' })),
    });
    const removed = await reap(idle, { dryRun: false, forceUnsealed: true });
    expect(removed.removed).toEqual([{ runId: RUN_1, branchTip: COMMIT }]);
    expect(removed.refused).toEqual([]);
    expect(idle.authorization!.calls).toHaveLength(1);
    expect(idle.removeCalls()).toHaveLength(1);
  });

  it('records the full request digest on a force-unsealed intent and refuses intent-digest-mismatch before any write when retried with a changed id or coordinate', async () => {
    const unsealedSeed = () => ({
      ...eligibleSeed(),
      attempts: [attemptFixture('wo-a', 'attempt-1', { artifacts: null })],
    });
    // First pass: the intent is written, then the authorization crashes.
    const first = harness(unsealedSeed());
    first.authorization!.authorizeUnsealedWorktreeRemoval = async () => {
      throw new Error('crashed after the intent was recorded');
    };
    const crashedResult = await reap(first, { dryRun: false, forceUnsealed: true });
    expect(crashedResult.refused).toEqual([{ runId: RUN_1, reason: 'unknown' }]);
    expect(first.journal.entries).toHaveLength(1);
    const intent = first.journal.entries[0]!;
    expect(intent).toMatchObject({ status: 'intent-recorded', action: 'collect' });
    const digest = /requestDigest=([0-9a-f]{64})$/.exec(intent.detail ?? '')?.[1];
    expect(digest).toBe(
      unsealedRemovalRequestDigest({
        attemptId: 'attempt-1',
        expectedHeadSha: COMMIT,
        projectId: 'project-a',
        repositoryRoot: '/srv/fleet/clone',
        runId: RUN_1,
        worktreePath: WORKTREE,
        worktreeRoot: '/srv/fleet/worktrees',
      }),
    );
    expect(intent.detail).not.toContain(WORKTREE);
    expect(intent.detail).not.toContain('/srv/fleet');

    const otherHead = 'b'.repeat(40);
    const otherPath = '/tmp/worktree-example-other';
    const variants: [string, string, Parameters<typeof harness>[0]][] = [
      [
        'runId',
        RUN_2,
        {
          runs: [runRecord(RUN_2, 'wo-a', { attemptIds: ['attempt-1'] })],
          journalStates: new Map([[RUN_2, 'merged']]),
          inspect: () => ({
            outcome: 'inspected',
            facts: cleanFacts({ branch: `fleet/${RUN_2}` }),
          }),
        },
      ],
      [
        'projectId',
        RUN_1,
        {
          workOrders: [makeWorkOrder('wo-a', { projectId: 'project-b' })],
          profiles: [{ ...makeProfile(), projectId: 'project-b' }],
        },
      ],
      [
        'expectedHeadSha',
        RUN_1,
        {
          inspect: () => ({ outcome: 'inspected', facts: cleanFacts({ head: otherHead }) }),
        },
      ],
      [
        'worktreePath',
        RUN_1,
        {
          attempts: [attemptFixture('wo-a', 'attempt-1', { artifacts: null, worktreePath: otherPath })],
          inspect: () => ({ outcome: 'inspected', facts: cleanFacts({ path: otherPath }) }),
        },
      ],
    ];
    for (const [label, runId, overrides] of variants) {
      const retry = harness({ ...unsealedSeed(), ...overrides });
      retry.journal.entries.push(...first.journal.entries);
      const result = await reap(retry, { dryRun: false, forceUnsealed: true });
      expect(result.refused, label).toEqual([{ runId, reason: 'intent-digest-mismatch' }]);
      expect(result.removed, label).toEqual([]);
      expect(retry.journal.entries, label).toHaveLength(1);
      expect(retry.authorization!.calls, label).toHaveLength(0);
      expect(retry.removeCalls(), label).toHaveLength(0);
    }

    // A prior intent that carries no digest at all, or a second intent entry, is a mismatch too.
    const legacy = harness(unsealedSeed());
    await legacy.journal.appendJournalEntry({
      ...intent,
      detail: `Authorizing unsealed worktree removal for attempt attempt-1 on branch fleet/${RUN_1}`,
    });
    const legacyResult = await reap(legacy, { dryRun: false, forceUnsealed: true });
    expect(legacyResult.refused).toEqual([{ runId: RUN_1, reason: 'intent-digest-mismatch' }]);
    expect(legacy.journal.entries).toHaveLength(1);
    expect(legacy.authorization!.calls).toHaveLength(0);

    const doubled = harness(unsealedSeed());
    await doubled.journal.appendJournalEntry(intent);
    await doubled.journal.appendJournalEntry({ ...intent, id: `attempt-1:collect:reap-unsealed-intent:${RUN_2}` });
    const doubledResult = await reap(doubled, { dryRun: false, forceUnsealed: true });
    expect(doubledResult.refused).toEqual([{ runId: RUN_1, reason: 'intent-digest-mismatch' }]);
    expect(doubled.journal.entries).toHaveLength(2);
    expect(doubled.removeCalls()).toHaveLength(0);

    // The same request retried unchanged still completes, keeping the one intent entry.
    const same = harness(unsealedSeed());
    same.journal.entries.push(intent);
    const completed = await reap(same, { dryRun: false, forceUnsealed: true });
    expect(completed.removed).toEqual([{ runId: RUN_1, branchTip: COMMIT }]);
    expect(same.journal.entries.map((entry) => entry.status)).toEqual(['intent-recorded', 'completed']);
    expect(same.journal.entries[1]!.id).toBe('attempt-1:collect:1');
  });

  it('redacts secret-shaped and path-containing errors and omits worktree paths from journal entries and results', async () => {
    // Synthetic secret shapes are split across template expressions so this
    // test file itself never carries a secret-shaped literal.
    const secret = `gh${'p_'}${'x'.repeat(30)}`;
    const withSecret = harness({
      ...eligibleSeed(),
      appendJournalEntry: async () => {
        throw new Error(`failed near ${secret}`);
      },
    });
    const secretResult = await reap(withSecret, { dryRun: false });
    expect(secretResult.journalFailed[0]!.reason).toBe('journal-append-failed (redacted)');

    const withPath = harness({
      ...eligibleSeed(),
      appendJournalEntry: async () => {
        throw new Error(`cannot write /srv/fleet/state/journal.json`);
      },
    });
    const pathResult = await reap(withPath, { dryRun: false });
    expect(pathResult.journalFailed[0]!.reason).toBe('journal-append-failed (redacted)');

    // A clean failure message still reads through.
    const clean = harness({
      ...eligibleSeed(),
      appendJournalEntry: async () => {
        throw new Error('journal write failed');
      },
    });
    const cleanResult = await reap(clean, { dryRun: false });
    expect(cleanResult.journalFailed[0]!.reason).toBe('journal write failed');
  });

  it('never references removeLaneWorktree: only ReapLaneWorktreesUseCase calls removeWorktree among implemented use cases', async () => {
    // Composition guard (C2'): no non-reaper use case in the work-execution
    // application layer may call `removeWorktree` or `removeLaneWorktree`.
    const useCaseDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
    );
    const offenders: string[] = [];
    const visit = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          visit(full);
          continue;
        }
        if (!name.endsWith('.use-case.ts')) {
          continue;
        }
        const text = fs.readFileSync(full, 'utf8');
        const referencesRemoval = text.includes('.removeWorktree') || text.includes('.removeLaneWorktree');
        if (referencesRemoval && !name.startsWith('ReapLaneWorktrees')) {
          offenders.push(name);
        }
        if (!referencesRemoval && name.startsWith('ReapLaneWorktrees')) {
          offenders.push(name);
        }
      }
    };
    visit(useCaseDir);
    expect(offenders).toEqual([]);
  });

  it('refuses not-configured when runnerForAttempt is absent at runtime (untyped caller), removing nothing', async () => {
    const h = harness({ ...eligibleSeed(), noRunnerForAttempt: true });
    const result = await reap(h, { dryRun: false });
    expect(result.refused).toEqual([{ runId: RUN_1, reason: 'not-configured' }]);
    expect(result.removed).toEqual([]);
    expect(h.removeCalls()).toHaveLength(0);
    expect(h.authorization?.calls).toEqual([]);
    expect(h.journal.entries).toHaveLength(0);
  });

  it('refuses not-configured when runnerForAttempt is a non-object without the method (untyped caller)', async () => {
    const bogus = {} as unknown as RunnerForAttemptPort;
    const h = harness({ ...eligibleSeed(), runnerForAttempt: bogus });
    const result = await reap(h, { dryRun: false });
    expect(result.refused).toEqual([{ runId: RUN_1, reason: 'not-configured' }]);
    expect(result.removed).toEqual([]);
    expect(h.removeCalls()).toHaveLength(0);
    expect(h.authorization?.calls).toEqual([]);
    expect(h.journal.entries).toHaveLength(0);
  });
});
