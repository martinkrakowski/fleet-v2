/**
 * Unit tests for EX-4: the operator-opt-in orphan-session reap
 * (`ReapOrphanSessionsUseCase`). Fakes cover every rule: a cancelled attempt
 * whose worktree reports `running` is an orphan and is aborted only without a
 * dry run, each skip reason, `unknown` reported and never aborted, a failed
 * abort going to `failed`, idle worktrees producing nothing, and sorted lists.
 */

import { describe, expect, it } from 'vitest';

import type {
  AttemptRecord,
  CapacityReservationRecord,
} from '../../../domain/execution-records.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../../ports/out/ExecutionJournalPort.out-port.js';
import type {
  AbortWorktreeRunRequest,
  AbortWorktreeRunResult,
  ExecutionRunnerPort,
  WorktreeRunState,
} from '../../ports/out/ExecutionRunnerPort.out-port.js';
import type { RunnerForAttemptPort } from '../../ports/out/RunnerForAttemptPort.out-port.js';
import type { ReapOrphanSessionsResult } from '../../ports/in/ReapOrphanSessionsPort.in-port.js';
import { ReapOrphanSessionsUseCase } from '../ReapOrphanSessionsUseCase.use-case.js';

const NOW = '2026-10-31T00:00:00.000Z';
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

function attemptFixture(id: string, overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id,
    workOrderId: 'wo-a',
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

function heldReservation(attemptId: string): CapacityReservationRecord {
  return {
    id: 'r1',
    attemptId,
    hostId: 'h',
    slotIndex: 0,
    held: true,
    seatTool: 'opencode' as const,
    reservedAtIso: NOW,
    releasedAtIso: null,
  };
}

/** A fake runner that answers one inspect state and one abort result, recording abort calls. */
function makeRunner(
  inspectState: WorktreeRunState,
  abortResult: AbortWorktreeRunResult = { outcome: 'aborted', endedAtIso: NOW },
): ExecutionRunnerPort & { readonly abortCalls: AbortWorktreeRunRequest[] } {
  const abortCalls: AbortWorktreeRunRequest[] = [];
  return {
    abortCalls,
    describeCapabilities: () => ({
      filesystemScope: 'scoped-worktree' as const,
      networkEgressRestricted: true,
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      authoritativeCompletion: true,
      artifactPersistence: true,
    }),
    async startSession() {
      throw new Error('unused fake runner method');
    },
    async inspectSession() {
      throw new Error('unused fake runner method');
    },
    async stopSession() {
      throw new Error('unused fake runner method');
    },
    async inspectWorktreeRun() {
      return inspectState;
    },
    async abortWorktreeRun(request) {
      abortCalls.push(request);
      return abortResult;
    },
  };
}

function makeRunnerForAttempt(options: {
  runnersByHost?: Map<string, ExecutionRunnerPort>;
  refuseHosts?: string[];
  noPort?: boolean;
}): RunnerForAttemptPort | undefined {
  if (options.noPort === true) {
    return undefined;
  }
  const runnersByHost = options.runnersByHost ?? new Map<string, ExecutionRunnerPort>();
  const refuseHosts = new Set(options.refuseHosts ?? []);
  return {
    runnerForAttempt(request) {
      const hostName = request.runner?.hostName ?? null;
      if (hostName === null || refuseHosts.has(hostName)) {
        return { ok: false, reason: `recorded host ${String(hostName)} unavailable` };
      }
      const runner = runnersByHost.get(hostName);
      if (runner === undefined) {
        return { ok: false, reason: `no runner for recorded host ${hostName}` };
      }
      return { ok: true, runner };
    },
  };
}

interface Harness {
  readonly useCase: ReapOrphanSessionsUseCase;
}

function harness(options: {
  attempts?: AttemptRecord[];
  reservations?: CapacityReservationRecord[];
  runnersByHost?: Map<string, ExecutionRunnerPort>;
  refuseHosts?: string[];
  noRunnerForAttempt?: boolean;
} = {}): Harness {
  const attempts = options.attempts ?? [];
  const reservations = options.reservations ?? [];
  const attemptRepo: Pick<AttemptRepositoryPort, 'listAllAttempts'> = {
    async listAllAttempts() {
      return attempts;
    },
  };
  const journal: Pick<ExecutionJournalPort, 'listActiveReservations'> = {
    async listActiveReservations() {
      return reservations;
    },
  };
  const runnerForAttempt =
    options.noRunnerForAttempt === true ? undefined : makeRunnerForAttempt(options);
  const useCase = new ReapOrphanSessionsUseCase({
    attemptRepo,
    executionJournal: journal,
    ...(runnerForAttempt !== undefined ? { runnerForAttempt } : {}),
  });
  return { useCase };
}

function reap(h: Harness, request: { dryRun: boolean }): Promise<ReapOrphanSessionsResult> {
  return h.useCase.reapOrphanSessions(request);
}

describe('ReapOrphanSessionsUseCase', () => {
  it('lists a cancelled attempt on a running worktree as an orphan, and aborts it only on a real run', async () => {
    const runner = makeRunner({ state: 'running', sessionId: 'ses_1' });
    const h = harness({
      attempts: [attemptFixture('attempt-1', { state: 'cancelled' })],
      runnersByHost: new Map([['lane-host', runner]]),
    });

    const dry = await reap(h, { dryRun: true });
    expect(dry).toEqual({
      outcome: 'reaped',
      dryRun: true,
      orphans: [{ worktreePath: WORKTREE, attemptId: 'attempt-1', sessionId: 'ses_1' }],
      aborted: [],
      failed: [],
      skipped: [],
      unknown: [],
    });
    expect(runner.abortCalls).toHaveLength(0);

    const real = await reap(h, { dryRun: false });
    expect(real.orphans).toEqual([
      { worktreePath: WORKTREE, attemptId: 'attempt-1', sessionId: 'ses_1' },
    ]);
    expect(real.aborted).toEqual([{ worktreePath: WORKTREE }]);
    expect(real.failed).toEqual([]);
    expect(runner.abortCalls).toHaveLength(1);
    expect(runner.abortCalls[0]).toEqual({
      attemptId: 'attempt-1',
      worktreePath: WORKTREE,
      runner: RECORDED_HOST,
      gracePeriodSeconds: 10,
    });
  });

  it('an execute with no or null input is a dry run and aborts nothing', async () => {
    const runner = makeRunner({ state: 'running', sessionId: 'ses_1' });
    const h = harness({
      attempts: [attemptFixture('attempt-1', { state: 'cancelled' })],
      runnersByHost: new Map([['lane-host', runner]]),
    });
    const result = await h.useCase.execute(null);
    expect(result).toMatchObject({ outcome: 'reaped', dryRun: true });
    expect(result.orphans).toEqual([
      { worktreePath: WORKTREE, attemptId: 'attempt-1', sessionId: 'ses_1' },
    ]);
    expect(runner.abortCalls).toHaveLength(0);
  });

  it.each([
    ['a live attempt on the worktree', { attempts: [attemptFixture('attempt-1', { state: 'cancelled' }), attemptFixture('attempt-2', { state: 'running' })] }, 'attempt-live'],
    ['an attempt holding a reservation', { reservations: [heldReservation('attempt-1')] }, 'slot-held'],
    ['an unresolved runner', { refuseHosts: ['lane-host'] }, 'no-runner'],
    ['a missing runner-for-attempt port', { noRunnerForAttempt: true }, 'no-runner'],
    ['no finished attempt with a recorded host', { attempts: [attemptFixture('attempt-1', { runner: { ...RECORDED_HOST, hostName: null } })] }, 'no-runner'],
  ])('skips a worktree with %s as %s', async (_label, seed, reason) => {
    const h = harness({
      attempts: [attemptFixture('attempt-1', { state: 'cancelled' })],
      runnersByHost: new Map([['lane-host', makeRunner({ state: 'running', sessionId: 'ses_1' })]]),
      ...seed,
    });
    const result = await reap(h, { dryRun: false });
    expect(result).toEqual({
      outcome: 'reaped',
      dryRun: false,
      orphans: [],
      aborted: [],
      failed: [],
      skipped: [{ worktreePath: WORKTREE, reason }],
      unknown: [],
    });
  });

  it('reports an unknown worktree and never aborts it', async () => {
    const runner = makeRunner({ state: 'unknown', reason: 'server unreachable' });
    const h = harness({
      attempts: [attemptFixture('attempt-1', { state: 'ended' })],
      runnersByHost: new Map([['lane-host', runner]]),
    });
    const result = await reap(h, { dryRun: false });
    expect(result.unknown).toEqual([{ worktreePath: WORKTREE, reason: 'server unreachable' }]);
    expect(result.orphans).toEqual([]);
    expect(result.aborted).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(runner.abortCalls).toHaveLength(0);
  });

  const abortCases: readonly [string, AbortWorktreeRunResult][] = [
    ['still-running', { outcome: 'still-running', reason: 'worker ignores TERM' }],
    ['refused', { outcome: 'refused', reason: 'dirty worktree' }],
    ['unknown', { outcome: 'unknown', reason: 'no answer' }],
  ];
  it.each(abortCases)('a %s abort goes to failed', async (_label, abortResult) => {
    const runner = makeRunner({ state: 'running', sessionId: 'ses_1' }, abortResult);
    const h = harness({
      attempts: [attemptFixture('attempt-1', { state: 'cancelled' })],
      runnersByHost: new Map([['lane-host', runner]]),
    });
    const result = await reap(h, { dryRun: false });
    expect(result.failed).toEqual([{ worktreePath: WORKTREE, outcome: abortResult.outcome }]);
    expect(result.aborted).toEqual([]);
    expect(result.orphans).toEqual([
      { worktreePath: WORKTREE, attemptId: 'attempt-1', sessionId: 'ses_1' },
    ]);
  });

  it('an idle worktree produces no entry and no abort', async () => {
    const runner = makeRunner({ state: 'idle' });
    const h = harness({
      attempts: [attemptFixture('attempt-1', { state: 'ended' })],
      runnersByHost: new Map([['lane-host', runner]]),
    });
    const result = await reap(h, { dryRun: false });
    expect(result).toEqual({
      outcome: 'reaped',
      dryRun: false,
      orphans: [],
      aborted: [],
      failed: [],
      skipped: [],
      unknown: [],
    });
    expect(runner.abortCalls).toHaveLength(0);
  });

  it('sorts every list by worktreePath in code-unit order', async () => {
    const runnerA = makeRunner({ state: 'running', sessionId: 'ses_a' });
    const runnerB = makeRunner({ state: 'running', sessionId: 'ses_b' });
    const runnerC = makeRunner({ state: 'unknown', reason: 'unreachable' });
    const h = harness({
      attempts: [
        attemptFixture('attempt-1', { worktreePath: '/tmp/wt-b', runner: { ...RECORDED_HOST, hostName: 'host-b' } }),
        attemptFixture('attempt-2', { worktreePath: '/tmp/wt-a', runner: { ...RECORDED_HOST, hostName: 'host-a' } }),
        attemptFixture('attempt-3', { worktreePath: '/tmp/wt-c', runner: { ...RECORDED_HOST, hostName: 'host-c' }, state: 'ended' }),
      ],
      runnersByHost: new Map([
        ['host-a', runnerA],
        ['host-b', runnerB],
        ['host-c', runnerC],
      ]),
    });
    const result = await reap(h, { dryRun: true });
    expect(result.orphans).toEqual([
      { worktreePath: '/tmp/wt-a', attemptId: 'attempt-2', sessionId: 'ses_a' },
      { worktreePath: '/tmp/wt-b', attemptId: 'attempt-1', sessionId: 'ses_b' },
    ]);
    expect(result.unknown).toEqual([{ worktreePath: '/tmp/wt-c', reason: 'unreachable' }]);
    expect(result.skipped).toEqual([]);
    expect(runnerA.abortCalls).toHaveLength(0);
    expect(runnerB.abortCalls).toHaveLength(0);
  });
});
