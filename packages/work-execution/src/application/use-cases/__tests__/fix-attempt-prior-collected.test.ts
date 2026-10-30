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

function makeJournal(reservations: readonly Record<string, unknown>[] = []) {
  let listActiveCalls = 0;
  const thrower = () => Promise.reject(new Error('journal must not be called'));
  return {
    listActiveCalls: () => listActiveCalls,
    async listActiveReservations() {
      listActiveCalls += 1;
      return reservations;
    },
    appendJournalEntry: thrower,
    listJournalEntriesForAttempt: thrower,
    saveCapacityReservation: thrower,
    releaseCapacityReservation: thrower,
    reserveCapacityAtomically: thrower,
  };
}

function makeWorkspace() {
  const inspectionRequests: Record<string, unknown>[] = [];
  let inspectionAnswer: (request: Record<string, unknown>) => Record<string, unknown> = () => {
    throw new Error('inspection must not be called');
  };
  return {
    inspectionRequests,
    setInspectionAnswer(answer: (request: Record<string, unknown>) => Record<string, unknown>): void {
      inspectionAnswer = answer;
    },
    async inspectWorktree(request: Record<string, unknown>) {
      inspectionRequests.push(request);
      return inspectionAnswer(request);
    },
    async readWorktreeFile() {
      throw new Error('must not be called');
    },
  };
}

/** Full isolation capabilities a dispatch requires, for tests that pass the capability gate. */
const CAPABLE_RUNNER_CAPABILITIES = {
  filesystemScope: 'scoped-worktree' as const,
  networkEgressRestricted: true,
  cpuAndMemoryLimited: true,
  processTreeTermination: true,
  authoritativeCompletion: true,
  artifactPersistence: true,
};

function makeRunner(capable = false) {
  return {
    describeCapabilities() {
      if (capable) {
        return CAPABLE_RUNNER_CAPABILITIES;
      }
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

/** A held capacity reservation naming `attemptId`, as the journal fake returns. */
function heldReservation(attemptId: string): Record<string, unknown> {
  return {
    id: 'reservation-1',
    attemptId,
    hostId: 'host-example-1',
    slotIndex: 0,
    held: true,
    seatTool: null,
    reservedAtIso: '2026-10-27T09:00:00.000Z',
    releasedAtIso: null,
  };
}

/** Collected artifacts sealed at `headCommit`, as the collect step writes them. */
function collectedArtifacts(headCommit: string): AttemptRecord['artifacts'] {
  return { headCommit, commitsSinceBase: [headCommit], collectedArtifactPaths: [], notes: 'present' };
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

describe('Q2a-1 a fix attempt inherits its prior attempt\u2019s host block', () => {
  const fixRequest = {
    fixAttemptId: 'attempt-fix-q2a',
    workOrderId: 'wo-1',
    priorAttemptId: 'attempt-1',
    numberedFixes: ['1. example fix'],
    nowIso: '2026-10-29T10:00:00.000Z',
  };

  function prepareFromPrior(priorRunner: AttemptRecord['runner']) {
    const attemptRepo = makeAttemptRepo();
    attemptRepo.attempts.set('attempt-1', attempt({ state: 'collected', runner: priorRunner }));
    const useCase = new PrepareFixAttemptUseCase({
      attemptRepo: attemptRepo as unknown as AttemptRepositoryPort,
    });
    return { attemptRepo, useCase };
  }

  it('an ssh prior runner block is carried onto the fix record with null session fields', async () => {
    const { attemptRepo, useCase } = prepareFromPrior({
      kind: 'opencode',
      remotePort: 4001,
      host: 'alias-example',
      hostName: 'host-example',
      agent: 'agent-old',
      model: 'model-old',
      variant: 'variant-old',
    });
    const result = await useCase.prepareFixAttempt(
      fixRequest as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
    );
    expect(result.outcome).toBe('prepared');
    const fix = attemptRepo.attempts.get('attempt-fix-q2a');
    expect(fix?.runner).toEqual({
      kind: 'opencode',
      remotePort: 4001,
      host: 'alias-example',
      hostName: 'host-example',
      agent: null,
      model: null,
      variant: null,
    });
  });

  it('an agy prior runner block carries the null port', async () => {
    const { attemptRepo, useCase } = prepareFromPrior({
      kind: 'agy',
      remotePort: null,
      host: 'alias-example',
      hostName: 'host-example',
      agent: null,
      model: null,
      variant: null,
    });
    const result = await useCase.prepareFixAttempt(
      fixRequest as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
    );
    expect(result.outcome).toBe('prepared');
    expect(attemptRepo.attempts.get('attempt-fix-q2a')?.runner).toEqual({
      kind: 'agy',
      remotePort: null,
      host: 'alias-example',
      hostName: 'host-example',
      agent: null,
      model: null,
      variant: null,
    });
  });

  it('a prior without a host name or runner writes no runner on the fix record', async () => {
    for (const priorRunner of [
      null,
      { kind: 'opencode' as const, remotePort: 4001, host: 'alias-example', agent: null, model: null, variant: null },
    ]) {
      const { attemptRepo, useCase } = prepareFromPrior(priorRunner);
      const result = await useCase.prepareFixAttempt(
        fixRequest as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
      );
      expect(result.outcome).toBe('prepared');
      expect(attemptRepo.attempts.get('attempt-fix-q2a')?.runner).toBeUndefined();
    }
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
    options: {
      priorState?: AttemptRecord['state'];
      seedFix?: boolean;
      sibling?: AttemptRecord;
      priorArtifacts?: AttemptRecord['artifacts'];
      reservation?: boolean;
      capableRunner?: boolean;
    } = {},
  ) {
    const { priorState, seedFix = true, sibling, priorArtifacts, reservation = false, capableRunner = false } = options;
    const attemptRepo = makeAttemptRepo();
    const workOrderRepo = makeWorkOrderRepo();
    const journal = makeJournal(reservation ? [heldReservation('attempt-fix-1')] : []);
    const workspace = makeWorkspace();
    const runner = makeRunner(capableRunner);
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
      attemptRepo.attempts.set('attempt-1', attempt({ state: priorState, artifacts: priorArtifacts ?? null }));
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
    return { attemptRepo, journal, workspace, useCase };
  }

  /** A matching inspection answer: the worktree holds exactly `checkedOut`. */
  function matchingInspection(checkedOut: string): (request: Record<string, unknown>) => Record<string, unknown> {
    return (request) => ({
      matchesBaseCommit: request.baseCommit === checkedOut,
      checkedOutCommit: checkedOut,
      uncommittedPaths: [],
      untrackedPaths: [],
      residueFromEarlierAttempts: [],
    });
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
    const { journal, useCase } = makeDispatchSetup({
      priorState: 'collected',
      priorArtifacts: collectedArtifacts('b'.repeat(40)),
    });
    const result = await useCase.dispatchAttempt(
      validDispatch as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'No active capacity reservation for attempt' });
    expect(journal.listActiveCalls()).toBe(1);
  });

  it('inspects at the collected prior\u2019s sealed head and proceeds past the inspection', async () => {
    const { workspace, useCase } = makeDispatchSetup({
      priorState: 'collected',
      priorArtifacts: collectedArtifacts('b'.repeat(40)),
      reservation: true,
      capableRunner: true,
    });
    workspace.setInspectionAnswer(matchingInspection('b'.repeat(40)));
    const result = await useCase.dispatchAttempt(
      validDispatch as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    // Past the inspection: the next gate is the runner port description.
    expect(result).toEqual({ outcome: 'refused', reason: 'No runner port can be described for dispatch' });
    expect(workspace.inspectionRequests).toHaveLength(1);
    expect(workspace.inspectionRequests[0]).toMatchObject({ baseCommit: 'b'.repeat(40) });
  });

  it('refuses a collected prior with no sealed head before any reservation read or inspection', async () => {
    const { journal, workspace, useCase } = makeDispatchSetup({
      priorState: 'collected',
      priorArtifacts: null,
      reservation: true,
    });
    const result = await useCase.dispatchAttempt(
      validDispatch as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Prior attempt attempt-1 is collected but has no sealed head commit',
    });
    expect(journal.listActiveCalls()).toBe(0);
    expect(workspace.inspectionRequests).toHaveLength(0);
  });

  it('inspects a cancelled prior with no head at the request\u2019s base', async () => {
    const { workspace, useCase } = makeDispatchSetup({
      priorState: 'cancelled',
      priorArtifacts: null,
      reservation: true,
      capableRunner: true,
    });
    workspace.setInspectionAnswer(matchingInspection('abc123'));
    const result = await useCase.dispatchAttempt(
      validDispatch as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'No runner port can be described for dispatch' });
    expect(workspace.inspectionRequests).toHaveLength(1);
    expect(workspace.inspectionRequests[0]).toMatchObject({ baseCommit: 'abc123' });
  });

  it('inspects a cancelled prior that has a head at that head', async () => {
    const { workspace, useCase } = makeDispatchSetup({
      priorState: 'cancelled',
      priorArtifacts: collectedArtifacts('c'.repeat(40)),
      reservation: true,
      capableRunner: true,
    });
    workspace.setInspectionAnswer(matchingInspection('c'.repeat(40)));
    await useCase.dispatchAttempt(validDispatch as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0]);
    expect(workspace.inspectionRequests).toHaveLength(1);
    expect(workspace.inspectionRequests[0]).toMatchObject({ baseCommit: 'c'.repeat(40) });
  });

  it('refuses a collected prior whose head is blank or not a string, before any inspection', async () => {
    for (const headCommit of ['   ', 42 as unknown as string]) {
      const { workspace, useCase } = makeDispatchSetup({
        priorState: 'collected',
        priorArtifacts: { ...collectedArtifacts('b'.repeat(40)), headCommit } as AttemptRecord['artifacts'],
        reservation: true,
        capableRunner: true,
      });
      const result = await useCase.dispatchAttempt(
        validDispatch as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
      );
      expect(result).toEqual({
        outcome: 'refused',
        reason: 'Prior attempt attempt-1 is collected but has no sealed head commit',
      });
      expect(workspace.inspectionRequests).toHaveLength(0);
    }
  });

  it('inspects a first attempt at the request\u2019s base (unchanged)', async () => {
    const { workspace, useCase } = makeDispatchSetup({ seedFix: false, reservation: true, capableRunner: true });
    workspace.setInspectionAnswer(matchingInspection('abc123'));
    const result = await useCase.dispatchAttempt(
      validDispatch as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'No runner port can be described for dispatch' });
    expect(workspace.inspectionRequests).toHaveLength(1);
    expect(workspace.inspectionRequests[0]).toMatchObject({ baseCommit: 'abc123' });
  });

  it('rewords the mismatch refusal for a fix attempt dispatched on the prior\u2019s head', async () => {
    const { workspace, useCase } = makeDispatchSetup({
      priorState: 'collected',
      priorArtifacts: collectedArtifacts('b'.repeat(40)),
      reservation: true,
      capableRunner: true,
    });
    workspace.setInspectionAnswer(matchingInspection('c'.repeat(40)));
    const result = await useCase.dispatchAttempt(
      validDispatch as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: `Worktree /lanes/example does not match the prior attempt's head (checked out ${'c'.repeat(40)})`,
    });
  });

  it('keeps the base-commit mismatch refusal for a first attempt', async () => {
    const { workspace, useCase } = makeDispatchSetup({ seedFix: false, reservation: true, capableRunner: true });
    workspace.setInspectionAnswer(matchingInspection('d'.repeat(40)));
    const result = await useCase.dispatchAttempt(
      validDispatch as Parameters<DispatchAttemptUseCase['dispatchAttempt']>[0],
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: `Worktree /lanes/example does not match the base commit (checked out ${'d'.repeat(40)})`,
    });
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

describe('PrepareFixAttemptUseCase brief package fields (KF-6)', () => {
  const briefFixRequest = {
    fixAttemptId: 'attempt-fix-1',
    workOrderId: 'wo-1',
    priorAttemptId: 'attempt-1',
    numberedFixes: ['1. example fix'],
    nowIso: '2026-10-27T10:00:00.000Z',
  };

  function makeBriefPrepareSetup() {
    const attemptRepo = makeAttemptRepo();
    attemptRepo.attempts.set('attempt-1', attempt({ state: 'collected' }));
    const useCase = new PrepareFixAttemptUseCase({
      attemptRepo: attemptRepo as unknown as AttemptRepositoryPort,
    });
    return { attemptRepo, useCase };
  }

  it('stores briefDigest and briefPackagePath when both are given', async () => {
    const { attemptRepo, useCase } = makeBriefPrepareSetup();
    const result = await useCase.prepareFixAttempt({
      ...briefFixRequest,
      briefDigest: 'digest-9',
      briefPackagePath: '.lane/brief.md',
    } as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0]);

    expect(result.outcome).toBe('prepared');
    const saved = attemptRepo.attempts.get('attempt-fix-1');
    expect(saved?.briefDigest).toBe('digest-9');
    expect(saved?.briefPackagePath).toBe('.lane/brief.md');
  });

  it('keeps briefDigest and briefPackagePath null when neither is given', async () => {
    const { attemptRepo, useCase } = makeBriefPrepareSetup();
    const result = await useCase.prepareFixAttempt(
      briefFixRequest as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0],
    );

    expect(result.outcome).toBe('prepared');
    const saved = attemptRepo.attempts.get('attempt-fix-1');
    expect(saved?.briefDigest).toBeNull();
    expect(saved?.briefPackagePath).toBeNull();
  });

  it('refuses one without the other', async () => {
    const { attemptRepo, useCase } = makeBriefPrepareSetup();

    const onlyDigest = await useCase.prepareFixAttempt({
      ...briefFixRequest,
      briefDigest: 'digest-9',
    } as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0]);
    expect(onlyDigest).toEqual({
      outcome: 'refused',
      reason: 'briefDigest and briefPackagePath must be given together',
    });

    const onlyPath = await useCase.prepareFixAttempt({
      ...briefFixRequest,
      briefPackagePath: '.lane/brief.md',
    } as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0]);
    expect(onlyPath).toEqual({
      outcome: 'refused',
      reason: 'briefDigest and briefPackagePath must be given together',
    });
    expect(attemptRepo.attempts.has('attempt-fix-1')).toBe(false);
  });

  it('refuses empty brief package fields', async () => {
    const { attemptRepo, useCase } = makeBriefPrepareSetup();
    const result = await useCase.prepareFixAttempt({
      ...briefFixRequest,
      briefDigest: ' ',
      briefPackagePath: '.lane/brief.md',
    } as Parameters<PrepareFixAttemptUseCase['prepareFixAttempt']>[0]);

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'briefDigest and briefPackagePath must be non-empty strings',
    });
    expect(attemptRepo.attempts.has('attempt-fix-1')).toBe(false);
  });
});
