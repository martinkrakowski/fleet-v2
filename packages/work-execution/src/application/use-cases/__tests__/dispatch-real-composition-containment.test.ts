import { describe, expect, it } from 'vitest';

import { DispatchAttemptUseCase } from '../DispatchAttemptUseCase.use-case.js';
import type {
  ActionJournalEntryRecord,
  CapacityReservationRecord,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';
import type { CommandExecutorPort } from '../../ports/out/CommandExecutorPort.out-port.js';
import type {
  CommandRunOptions,
  CommandRunResult,
} from '../../ports/out/CommandExecutorPort.out-port.js';
import type { ExecutionJournalPort } from '../../ports/out/ExecutionJournalPort.out-port.js';
import type { ExecutionRunnerPort } from '../../ports/out/ExecutionRunnerPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import { AttemptArtifactAdapter } from '../../../infrastructure/adapters/AttemptArtifactAdapter.adapter.js';
import { WorkspaceAdapter } from '../../../infrastructure/adapters/WorkspaceAdapter.adapter.js';

type RunCall = { argv: readonly string[]; options?: CommandRunOptions };

/**
 * One recording fake executor shared by the REAL WorkspaceAdapter and the
 * REAL AttemptArtifactAdapter: git reads answer plausibly, existence probes
 * report absence, and every call is recorded so the test can prove no `cat`
 * ever ran on a refused path.
 */
function fakeExecutor(): { executor: CommandExecutorPort; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const executor: CommandExecutorPort = {
    run: async (argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> => {
      calls.push({ argv, options });
      if (argv[0] === 'git') {
        const stdout = argv.includes('rev-parse') ? 'abc123\n' : '';
        return { exitCode: 0, signal: null, stdout, stderr: '' };
      }
      return { exitCode: 1, signal: null, stdout: '', stderr: '' };
    },
  };
  return { executor, calls };
}

function makeJournalWithReservation(worktreePath: string): ExecutionJournalPort {
  const reservation: CapacityReservationRecord = {
    id: 'res-1',
    attemptId: 'attempt-1',
    hostId: 'host-1',
    slotIndex: 0,
    held: true,
    seatTool: 'opencode',
    reservedAtIso: '2026-10-15T08:00:00.000Z',
    releasedAtIso: null,
    worktreePath,
  };
  return {
    async appendJournalEntry(_entry: ActionJournalEntryRecord): Promise<void> {},
    async listJournalEntriesForAttempt(): Promise<ActionJournalEntryRecord[]> {
      return [];
    },
    async saveCapacityReservation(): Promise<void> {},
    async listActiveReservations(): Promise<CapacityReservationRecord[]> {
      return [reservation];
    },
    async releaseCapacityReservation(): Promise<boolean> {
      return false;
    },
    async reserveCapacityAtomically(): Promise<never> {
      throw new Error('not used in this test');
    },
  };
}

function makeRunnerPort(): ExecutionRunnerPort {
  return {
    describeCapabilities: () => ({
      filesystemScope: 'scoped-worktree',
      networkEgressRestricted: true,
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      authoritativeCompletion: true,
      artifactPersistence: true,
    }),
    describeRunner: () => ({
      kind: 'opencode',
      remotePort: 4166,
      host: null,
      agent: null,
      model: 'nvidia/z-ai/glm-5.3',
      variant: 'default',
    }),
    async startSession(): Promise<never> {
      throw new Error('startSession must never run in this test');
    },
    async inspectSession(): Promise<never> {
      throw new Error('inspectSession must never run in this test');
    },
    async stopSession(): Promise<never> {
      throw new Error('stopSession must never run in this test');
    },
  };
}

function makeWorkOrderRepo(): WorkOrderRepositoryPort {
  const workOrder: WorkOrderRecord = {
    id: 'wo-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'git@example.org:acme/app.git',
    baseCommit: 'abc123',
    ownedPaths: ['src/**'],
    policyRevision: 'policy-1',
    prerequisiteWorkOrderIds: [],
    state: 'implementing',
    revision: 1,
    createdAtIso: '2026-10-15T08:00:00.000Z',
    updatedAtIso: '2026-10-15T08:00:00.000Z',
  };
  return {
    async saveWorkOrder(): Promise<void> {},
    async findWorkOrderById(workOrderId: string) {
      return workOrder.id === workOrderId ? workOrder : null;
    },
    async listWorkOrdersByProject() {
      return [workOrder];
    },
  };
}

const attemptRepo = {} as AttemptRepositoryPort;

function makeDispatchUseCase(executor: CommandExecutorPort): DispatchAttemptUseCase {
  return new DispatchAttemptUseCase({
    workOrderRepo: makeWorkOrderRepo(),
    attemptRepo,
    journal: makeJournalWithReservation('/wt'),
    // The real adapters over the one recording fake executor.
    workspace: new WorkspaceAdapter({ executor }),
    runner: makeRunnerPort(),
    artifactPort: new AttemptArtifactAdapter({ executor }),
  });
}

function dispatchRequest(briefPackagePath: string) {
  return {
    attemptId: 'attempt-1',
    workOrderId: 'wo-1',
    worktreePath: '/wt',
    briefPackagePath,
    briefDigest: 'digest-1',
    baseCommit: 'abc123',
    stepLimit: 40,
    timeLimitSeconds: 3600,
    expectedArtifacts: [],
    nowIso: '2026-10-15T08:00:00.000Z',
  };
}

describe('dispatch through the real adapters refuses uncontained brief paths', () => {
  it('refuses a /etc/passwd brief package path and never cats it', async () => {
    const { executor, calls } = fakeExecutor();
    const useCase = makeDispatchUseCase(executor);

    const result = await useCase.dispatchAttempt(dispatchRequest('/etc/passwd'));

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('Failed to read brief manifest');
    }
    expect(calls.filter((call) => call.argv.some((argument) => argument === '/etc/passwd'))).toHaveLength(0);
  });

  it('refuses a ../x brief package path and never cats it', async () => {
    const { executor, calls } = fakeExecutor();
    const useCase = makeDispatchUseCase(executor);

    const result = await useCase.dispatchAttempt(dispatchRequest('../x'));

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('Failed to read brief manifest');
    }
    expect(calls.filter((call) => call.argv.some((argument) => argument === '../x'))).toHaveLength(0);
  });
});
