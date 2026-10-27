/**
 * C1b: a fix attempt shares the lane's worktree with its prior attempt, so
 * preparing or dispatching one is refused until the prior attempt is
 * collected (artifact manifest sealed) or cancelled and no other attempt on
 * the work order can still touch the worktree. An ended-but-uncollected or
 * unknown prior state refuses; the refusal names only the attempt id and its
 * state. Dispatch refuses before any reservation read, journal entry or
 * runner call.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord } from '../../../domain/execution-records.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../../ports/out/ExecutionJournalPort.out-port.js';
import type { ExecutionRunnerPort } from '../../ports/out/ExecutionRunnerPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { WorkspacePort } from '../../ports/out/WorkspacePort.out-port.js';
import { DispatchAttemptUseCase } from '../DispatchAttemptUseCase.use-case.js';
import { PrepareFixAttemptUseCase } from '../PrepareFixAttemptUseCase.use-case.js';

function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-1',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/lanes/attempt-1',
    baseCommit: 'abc123',
    state: 'running',
    outcome: null,
    briefDigest: 'digest-1',
    briefPackagePath: '.lane/brief.md',
    sessionId: 'session-1',
    completionReceipt: null,
    artifacts: null,
    createdAtIso: '2026-10-15T08:00:00.000Z',
    updatedAtIso: '2026-10-15T08:00:00.000Z',
    ...overrides,
  };
}

function makeAttemptRepo() {
  const attempts = new Map<string, AttemptRecord>();
  let listCalls = 0;
  return {
    attempts,
    listCalls: () => listCalls,
    async saveAttempt(record: AttemptRecord): Promise<void> {
      attempts.set(record.id, record);
    },
    async findAttemptById(attemptId: string): Promise<AttemptRecord | null> {
      return attempts.get(attemptId) ?? null;
    },
    async listAttemptsByWorkOrder(workOrderId: string): Promise<readonly AttemptRecord[]> {
      listCalls += 1;
      return [...attempts.values()].filter((a) => a.workOrderId === workOrderId);
    },
    async listAllAttempts(): Promise<readonly AttemptRecord[]> {
      return [...attempts.values()];
    },
  };
}

function makeWorkOrderRepo() {
  return {
    async findWorkOrderById(workOrderId: string) {
      if (workOrderId !== 'wo-1') {
        return null;
      }
      return {
        id: 'wo-1',
        projectId: 'proj-1',
        taskId: 'task-1',
        laneId: 'lane-1',
        repository: 'git@example.org:acme/app.git',
        baseCommit: 'abc123',
        ownedPaths: ['packages/app-a/**'],
        policyRevision: 'policy-7',
        prerequisiteWorkOrderIds: [],
        state: 'implementing',
        revision: 1,
        createdAtIso: '2026-10-15T08:00:00.000Z',
        updatedAtIso: '2026-10-15T08:00:00.000Z',
      };
    },
    async saveWorkOrder() {},
    async listWorkOrdersByProject() {
      return [];
    },
  };
}

function makeJournal() {
  let listActiveCalls = 0;
  const thrower = () => Promise.reject(new Error('journal must not be called'));
  return {
    listActiveCalls: () => listActiveCalls,
    async listActiveReservations() {
      listActiveCalls += 1;
      return [];
    },
    appendJournalEntry: thrower,
    listJournalEntriesForAttempt: thrower,
    saveCapacityReservation: thrower,
    releaseCapacityReservation: thrower,
    reserveCapacityAtomically: thrower,
  };
}

function makeWorkspace() {
  return {
    async inspectWorktree() {
      throw new Error('must not be called');
    },
    async readWorktreeFile() {
      throw new Error('must not be called');
    },
  };
}

function makeRunner() {
  return {
    describeCapabilities() {
      throw new Error('must not be called');
    },
    async startSession() {
      throw new Error('must not be called');
    },
    async inspectSession() {
      throw new Error('must not be called');
    },
    async stopSession() {
      throw new Error('must not be called');
    },
  };
}

function expectCleanRefusalReason(reason: string): void {
  expect(reason).not.toContain('/lanes/');
  expect(reason).not.toContain('abc123');
  expect(reason).not.toContain('session');
}

describe('C1b fix attempt waits for the prior attempt to be collected', () => {
  const fixRequest = {
    fixAttemptId: 'attempt-fix-1',
    workOrderId: 'wo-1',
    priorAttemptId: 'attempt-1',
    numberedFixes: ['1. example fix'],
    nowIso: '2026-10-27T10:00:00.000Z',
  };

  function makePrepareSetup(priorState: AttemptRecord['state'], sibling?: AttemptRecord) {
    const attemptRepo = makeAttemptRepo();
    attemptRepo.attempts.set('attempt-1', attempt({ state: priorState }));
    if (sibling) {
      attemptRepo.attempts.set(sibling.id, sibling);
    }
    const useCase = new PrepareFixAttemptUseCase({
      attemptRepo: attemptRepo as unknown as AttemptRepositoryPort,
    });
    return { attemptRepo, useCase };
  }

  it.each(['intent-recorded', 'dispatching', 'running', 'reconciling', 'ended', 'blocked'] as const)(
    'refuses while the prior attempt is $state',
    async (state) => {
      const { attemptRepo, useCase } = makePrepareSetup(state);
      const result = await useCase.prepareFixAttempt(
        fixRequest as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
      );
      expect(result).toEqual({
        outcome: 'refused',
        reason: `Prior attempt attempt-1 is ${state}; a fix attempt starts only after it is collected or cancelled`,
      });
      expect(attemptRepo.attempts.has('attempt-fix-1')).toBe(false);
      if (result.outcome === 'refused') {
        expectCleanRefusalReason(result.reason);
      }
    },
  );

  it('prints unknown for an undeclared prior state and never echoes it', async () => {
    const { attemptRepo, useCase } = makePrepareSetup('paused-by-a-newer-binary' as AttemptRecord['state']);
    const result = await useCase.prepareFixAttempt(
      fixRequest as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Prior attempt attempt-1 is unknown; a fix attempt starts only after it is collected or cancelled',
    });
    expect(attemptRepo.attempts.has('attempt-fix-1')).toBe(false);
    if (result.outcome === 'refused') {
      expect(result.reason).not.toContain('paused');
      expectCleanRefusalReason(result.reason);
    }
  });

  it('prepares after a collected or cancelled prior', async () => {
    for (const state of ['collected', 'cancelled'] as const) {
      const { attemptRepo, useCase } = makePrepareSetup(state);
      const result = await useCase.prepareFixAttempt(
        fixRequest as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
      );
      expect(result.outcome).toBe('prepared');
      expect(attemptRepo.attempts.get('attempt-fix-1')?.state).toBe('intent-recorded');
    }
  });

  it('refuses while a sibling attempt can still touch the shared worktree', async () => {
    for (const siblingState of ['running', 'ended'] as const) {
      const { attemptRepo, useCase } = makePrepareSetup(
        'collected',
        attempt({ id: 'attempt-2', state: siblingState }),
      );
      const result = await useCase.prepareFixAttempt(
        fixRequest as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
      );
      expect(result).toEqual({
        outcome: 'refused',
        reason: `Attempt attempt-2 on the same work order is ${siblingState}; a fix attempt starts only after it is collected or cancelled`,
      });
      expect(attemptRepo.attempts.has('attempt-fix-1')).toBe(false);
      if (result.outcome === 'refused') {
        expectCleanRefusalReason(result.reason);
      }
    }
  });

  it('ignores non-blocking siblings and attempts on other work orders', async () => {
    for (const siblingState of ['intent-recorded', 'collected'] as const) {
      const { useCase } = makePrepareSetup('collected', attempt({ id: 'attempt-2', state: siblingState }));
      const result = await useCase.prepareFixAttempt(
        fixRequest as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
      );
      expect(result.outcome).toBe('prepared');
    }
    const { useCase } = makePrepareSetup(
      'collected',
      attempt({ id: 'attempt-9', workOrderId: 'wo-2', state: 'running' }),
    );
    const result = await useCase.prepareFixAttempt(
      fixRequest as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
    );
    expect(result.outcome).toBe('prepared');
  });
});

describe('C1b dispatch refuses until the prior attempt is collected', () => {
  const validDispatch = {
    attemptId: 'attempt-fix-1',
    workOrderId: 'wo-1',
    worktreePath: '/lanes/example',
    briefPackagePath: '.lane/brief.md',
    briefDigest: 'digest-example',
    baseCommit: 'abc123',
    stepLimit: 40,
    timeLimitSeconds: 3600,
    nowIso: '2026-10-27T10:00:00.000Z',
  };

  function makeDispatchSetup(
    options: { priorState?: AttemptRecord['state']; seedFix?: boolean; sibling?: AttemptRecord } = {},
  ) {
    const { priorState, seedFix = true, sibling } = options;
    const attemptRepo = makeAttemptRepo();
    const workOrderRepo = makeWorkOrderRepo();
    const journal = makeJournal();
    const workspace = makeWorkspace();
    const runner = makeRunner();
    if (seedFix) {
      attemptRepo.attempts.set(
        'attempt-fix-1',
        attempt({
          id: 'attempt-fix-1',
          kind: 'fix',
          fixNumber: 1,
          priorAttemptId: 'attempt-1',
          state: 'intent-recorded',
        }),
      );
    }
    if (priorState !== undefined) {
      attemptRepo.attempts.set('attempt-1', attempt({ state: priorState }));
    }
    if (sibling) {
      attemptRepo.attempts.set(sibling.id, sibling);
    }
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo: workOrderRepo as unknown as WorkOrderRepositoryPort,
      attemptRepo: attemptRepo as unknown as AttemptRepositoryPort,
      journal: journal as unknown as ExecutionJournalPort,
      workspace: workspace as unknown as WorkspacePort,
      runner: runner as unknown as ExecutionRunnerPort,
    });
    return { attemptRepo, journal, useCase };
  }

  it('refuses while the prior is running, before any reservation read', async () => {
    const { attemptRepo, journal, useCase } = makeDispatchSetup({ priorState: 'running' });
    const result = await useCase.dispatchAttempt(
      validDispatch as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Prior attempt attempt-1 is running; a fix attempt starts only after it is collected or cancelled',
    });
    expect(journal.listActiveCalls()).toBe(0);
    expect(attemptRepo.attempts.get('attempt-fix-1')?.state).toBe('intent-recorded');
  });

  it('refuses while the prior is ended but not yet collected', async () => {
    const { attemptRepo, journal, useCase } = makeDispatchSetup({ priorState: 'ended' });
    const result = await useCase.dispatchAttempt(
      validDispatch as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Prior attempt attempt-1 is ended; a fix attempt starts only after it is collected or cancelled',
    });
    expect(journal.listActiveCalls()).toBe(0);
    expect(attemptRepo.attempts.get('attempt-fix-1')?.state).toBe('intent-recorded');
  });

  it('refuses for an undeclared prior state, naming unknown', async () => {
    const { attemptRepo, journal, useCase } = makeDispatchSetup({
      priorState: 'paused-by-a-newer-binary' as AttemptRecord['state'],
    });
    const result = await useCase.dispatchAttempt(
      validDispatch as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Prior attempt attempt-1 is unknown; a fix attempt starts only after it is collected or cancelled',
    });
    expect(journal.listActiveCalls()).toBe(0);
    expect(attemptRepo.attempts.get('attempt-fix-1')?.state).toBe('intent-recorded');
  });

  it('refuses when the prior attempt is missing', async () => {
    const { journal, useCase } = makeDispatchSetup();
    const result = await useCase.dispatchAttempt(
      validDispatch as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'Prior attempt not found for work order' });
    expect(journal.listActiveCalls()).toBe(0);
  });

  it('lets dispatch proceed to the reservation step once the prior is collected', async () => {
    const { journal, useCase } = makeDispatchSetup({ priorState: 'collected' });
    const result = await useCase.dispatchAttempt(
      validDispatch as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'No active capacity reservation for attempt' });
    expect(journal.listActiveCalls()).toBe(1);
  });

  it('refuses while a sibling attempt can still touch the worktree', async () => {
    const { journal, useCase } = makeDispatchSetup({
      priorState: 'collected',
      sibling: attempt({ id: 'attempt-2', state: 'running' }),
    });
    const result = await useCase.dispatchAttempt(
      validDispatch as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Attempt attempt-2 on the same work order is running; a fix attempt starts only after it is collected or cancelled',
    });
    expect(journal.listActiveCalls()).toBe(0);
  });

  it('leaves first attempts with no recorded fix unaffected', async () => {
    const { attemptRepo, useCase } = makeDispatchSetup({ seedFix: false });
    const result = await useCase.dispatchAttempt(
      validDispatch as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'No active capacity reservation for attempt' });
    expect(attemptRepo.listCalls()).toBe(0);
  });
});
