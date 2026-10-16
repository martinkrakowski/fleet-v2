import { describe, expect, it } from 'vitest';
import {
  ExecutionRunnerAdapter,
  type SubprocessRunner,
} from './infrastructure/adapters/ExecutionRunnerAdapter.adapter.js';
import { DispatchAttemptUseCase } from './application/use-cases/DispatchAttemptUseCase.use-case.js';
import { ReconcileAttemptUseCase } from './application/use-cases/ReconcileAttemptUseCase.use-case.js';
import { StopAttemptUseCase } from './application/use-cases/StopAttemptUseCase.use-case.js';
import { underlyingModelFamily } from '@fleet/evidence-and-acceptance';
import {
  type ActionJournalEntryRecord,
  type AttemptRecord,
  type AttemptSeatOverrideRecord,
  type CapacityReservationRecord,
  type CommandCompletionReceipt,
  type WorkOrderRecord,
} from './domain/execution-records.js';
import type { WorkOrderRepositoryPort } from './application/ports/out/WorkOrderRepositoryPort.out-port.js';
import type { AttemptRepositoryPort } from './application/ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from './application/ports/out/ExecutionJournalPort.out-port.js';
import type { WorkspacePort } from './application/ports/out/WorkspacePort.out-port.js';
import type {
  ExecutionRunnerPort,
  StartRunnerSessionRequest,
} from './application/ports/out/ExecutionRunnerPort.out-port.js';
import type { DispatchAttemptRequest } from './application/ports/in/DispatchAttemptPort.in-port.js';

function createMockWorkOrder(overrides?: Partial<WorkOrderRecord>): WorkOrderRecord {
  return {
    id: 'wo-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'owner/repo',
    baseCommit: 'commit-base-123',
    ownedPaths: ['src/'],
    policyRevision: 'pol-1',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 1,
    createdAtIso: '2026-10-15T00:00:00.000Z',
    updatedAtIso: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

function createMockAttempt(overrides?: Partial<AttemptRecord>): AttemptRecord {
  return {
    id: 'att-1',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/worktrees/lane-1',
    baseCommit: 'commit-base-123',
    state: 'running',
    outcome: null,
    briefDigest: 'digest-1',
    briefPackagePath: '.lane/brief.md',
    sessionId: 'ses_test_123',
    completionReceipt: null,
    artifacts: null,
    runner: {
      remotePort: 4166,
      host: null,
      agent: null,
      model: 'nvidia/z-ai/glm-5.3',
      variant: null,
    },
    createdAtIso: '2026-10-15T00:00:00.000Z',
    updatedAtIso: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

function createInMemoryJournal(): ExecutionJournalPort & {
  readonly entries: ActionJournalEntryRecord[];
  readonly reservations: CapacityReservationRecord[];
} {
  const entries: ActionJournalEntryRecord[] = [];
  const reservations: CapacityReservationRecord[] = [
    {
      id: 'res-1',
      attemptId: 'att-1',
      hostId: 'host-1',
      slotIndex: 0,
      held: true,
      reservedAtIso: '2026-10-15T00:00:00.000Z',
      releasedAtIso: null,
    },
  ];

  return {
    entries,
    reservations,
    appendJournalEntry: async (entry) => {
      entries.push(entry);
    },
    listJournalEntriesForAttempt: async (attemptId) => {
      return entries.filter((e) => e.attemptId === attemptId);
    },
    saveCapacityReservation: async (reservation) => {
      const idx = reservations.findIndex((r) => r.id === reservation.id);
      if (idx >= 0) {
        reservations[idx] = reservation;
      } else {
        reservations.push(reservation);
      }
    },
    listActiveReservations: async () => {
      return reservations.filter((r) => r.held);
    },
    releaseCapacityReservation: async (attemptId, releasedAtIso) => {
      const reservation = reservations.find((r) => r.attemptId === attemptId && r.held);
      if (reservation) {
        (reservation as { held: boolean }).held = false;
        (reservation as { releasedAtIso: string | null }).releasedAtIso = releasedAtIso;
        return true;
      }
      return false;
    },
    // Mirrors the adapter's locked arbitration: duplicate, budget, then lowest free slot.
    reserveCapacityAtomically: async (request) => {
      const held = reservations.filter((r) => r.held);
      const duplicate = held.find((r) => r.attemptId === request.attemptId);
      if (duplicate !== undefined) {
        return {
          outcome: 'duplicate-attempt',
          attemptId: request.attemptId,
          existingReservationId: duplicate.id,
        };
      }
      const heldOnHost = held.filter((r) => r.hostId === request.record.hostId);
      if (heldOnHost.length >= request.maxSlots) {
        return { outcome: 'no-free-slot', heldCount: heldOnHost.length, maxSlots: request.maxSlots };
      }
      const usedSlots = new Set(heldOnHost.map((r) => r.slotIndex));
      let slotIndex = 0;
      while (usedSlots.has(slotIndex)) {
        slotIndex += 1;
      }
      const reservation: CapacityReservationRecord = { ...request.record, slotIndex };
      reservations.push(reservation);
      return { outcome: 'reserved', reservation };
    },
  };
}

describe('Runner Adapter Seat, Port and Status Fidelity', () => {
  describe('1. H5: Model Assignment, Seat Override, and -m Flag', () => {
    it('dispatches the frozen seat from request modelAssignment and always passes -m', async () => {
      const invocations: Array<{ command: string; args: readonly string[]; env?: Readonly<Record<string, string>> }> = [];
      const runner: SubprocessRunner = async (command, args, env) => {
        invocations.push({ command, args, env });
        return { exitCode: 0, stdout: JSON.stringify({ sessionID: 'ses_123' }), stderr: '' };
      };

      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
        remotePort: 4096,
      });

      const result = await adapter.startSession({
        attemptId: 'att-1',
        worktreePath: '/worktrees/lane-1',
        briefPackagePath: '.lane/brief.md',
        baseCommit: 'base-sha',
        stepLimit: 100,
        timeLimitSeconds: 3600,
        requiredCapabilities: adapter.describeCapabilities(),
        modelAssignment: {
          model: 'nvidia/z-ai/glm-5.3',
          variant: 'low',
          fallbackModel: 'openai/gpt-4o',
          agent: 'lane-glm',
        },
      });

      expect(result.outcome).toBe('started');
      expect(invocations).toHaveLength(1);
      const args = invocations[0].args;
      expect(args).toContain('-m');
      expect(args[args.indexOf('-m') + 1]).toBe('nvidia/z-ai/glm-5.3');
      expect(args).toContain('--variant');
      expect(args[args.indexOf('--variant') + 1]).toBe('low');
      expect(args).toContain('--agent');
      expect(args[args.indexOf('--agent') + 1]).toBe('lane-glm');
    });

    it('refuses to start when no model is known without spawning a subprocess', async () => {
      let spawned = false;
      const runner: SubprocessRunner = async () => {
        spawned = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      };

      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
      });

      const result = await adapter.startSession({
        attemptId: 'att-1',
        worktreePath: '/worktrees/lane-1',
        briefPackagePath: '.lane/brief.md',
        baseCommit: 'base-sha',
        stepLimit: 100,
        timeLimitSeconds: 3600,
        requiredCapabilities: adapter.describeCapabilities(),
      });

      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('No model specified');
      expect(spawned).toBe(false);
    });

    it('uses request.seatOverride during startSession', async () => {
      const invocations: Array<{ args: readonly string[] }> = [];
      const runner: SubprocessRunner = async (_cmd, args) => {
        invocations.push({ args });
        return { exitCode: 0, stdout: JSON.stringify({ sessionID: 'ses_override' }), stderr: '' };
      };

      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
      });

      const result = await adapter.startSession({
        attemptId: 'att-1',
        worktreePath: '/worktrees/lane-1',
        briefPackagePath: '.lane/brief.md',
        baseCommit: 'base-sha',
        stepLimit: 100,
        timeLimitSeconds: 3600,
        requiredCapabilities: adapter.describeCapabilities(),
        seatOverride: {
          model: 'anthropic/claude-3-5-sonnet',
          variant: 'high',
          agent: 'override-agent',
          reason: 'Test override',
          setBy: 'test',
          expiresAtIso: '2026-10-15T23:59:59.000Z',
        },
      });

      expect(result.outcome).toBe('started');
      const args = invocations[0].args;
      expect(args[args.indexOf('-m') + 1]).toBe('anthropic/claude-3-5-sonnet');
      expect(args[args.indexOf('--variant') + 1]).toBe('high');
      expect(args[args.indexOf('--agent') + 1]).toBe('override-agent');
    });

    it('adapter constructed without seat options plus a manifest without a variant produces no --variant flag', async () => {
      const invocations: Array<{ args: readonly string[] }> = [];
      const runner: SubprocessRunner = async (_cmd, args) => {
        invocations.push({ args });
        return { exitCode: 0, stdout: JSON.stringify({ sessionID: 'ses_123' }), stderr: '' };
      };

      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
        remotePort: 4096,
      });

      const result = await adapter.startSession({
        attemptId: 'att-1',
        worktreePath: '/worktrees/lane-1',
        briefPackagePath: '.lane/brief.md',
        baseCommit: 'base-sha',
        stepLimit: 100,
        timeLimitSeconds: 3600,
        requiredCapabilities: adapter.describeCapabilities(),
        model: 'nvidia/z-ai/glm-5.3',
        agent: 'lane-glm',
        // variant omitted
      });

      expect(result.outcome).toBe('started');
      const args = invocations[0].args;
      expect(args).toContain('-m');
      expect(args[args.indexOf('-m') + 1]).toBe('nvidia/z-ai/glm-5.3');
      expect(args).toContain('--agent');
      expect(args[args.indexOf('--agent') + 1]).toBe('lane-glm');
      expect(args).not.toContain('--variant');
    });
  });

  describe('2. H2: Record Runner Port & Host Fidelity in Reconcile', () => {
    it('records runner details on the attempt at dispatch', async () => {
      const workOrder = createMockWorkOrder();
      const attempt = createMockAttempt({ state: 'dispatching' });
      const attempts = new Map<string, AttemptRecord>([[attempt.id, attempt]]);
      const journal = createInMemoryJournal();

      const workOrderRepo: WorkOrderRepositoryPort = {
        findWorkOrderById: async (id) => (id === workOrder.id ? workOrder : null),
        saveWorkOrder: async () => {},
        listWorkOrdersByProject: async () => [workOrder],
      };

      const attemptRepo: AttemptRepositoryPort = {
        findAttemptById: async (id) => attempts.get(id) ?? null,
        saveAttempt: async (rec) => {
          attempts.set(rec.id, rec);
        },
        listAttemptsByWorkOrder: async () => [...attempts.values()],
        listAllAttempts: async () => [...attempts.values()],
      };

      const workspace: WorkspacePort = {
        inspectWorktree: async (req) => ({
          worktreePath: req.worktreePath,
          matchesBaseCommit: true,
          checkedOutCommit: 'commit-base-123',
          uncommittedPaths: [],
          untrackedPaths: [],
          residueFromEarlierAttempts: [],
          missingExpectedArtifacts: [],
        }),
        readWorktreeFile: async () =>
          JSON.stringify({
            modelAssignment: {
              model: 'nvidia/z-ai/glm-5.3',
              variant: 'low',
              agent: 'lane-agent',
            },
          }),
      };

      const runnerPort: ExecutionRunnerPort = {
        describeCapabilities: () => ({
          filesystemScope: 'scoped-worktree',
          networkEgressRestricted: true,
          cpuAndMemoryLimited: true,
          processTreeTermination: true,
          authoritativeCompletion: true,
          artifactPersistence: true,
        }),
        describeRunner: () => ({
          remotePort: 4166,
          host: 'runner-host.lan',
          agent: 'lane-agent',
          model: 'nvidia/z-ai/glm-5.3',
          variant: 'low',
        }),
        startSession: async () => ({
          outcome: 'started',
          sessionId: 'ses_started_4166',
          runner: {
            remotePort: 4166,
            host: 'runner-host.lan',
            agent: 'lane-agent',
            model: 'nvidia/z-ai/glm-5.3',
            variant: 'low',
          },
        }),
        inspectSession: async () => {
          throw new Error('Not used');
        },
        stopSession: async () => {
          throw new Error('Not used');
        },
      };

      const useCase = new DispatchAttemptUseCase({
        workOrderRepo,
        attemptRepo,
        journal,
        workspace,
        runner: runnerPort,
      });

      const result = await useCase.dispatchAttempt({
        attemptId: attempt.id,
        workOrderId: workOrder.id,
        worktreePath: attempt.worktreePath,
        briefPackagePath: attempt.briefPackagePath!,
        briefDigest: attempt.briefDigest!,
        baseCommit: attempt.baseCommit,
        stepLimit: 100,
        timeLimitSeconds: 3600,
      });

      expect(result.outcome).toBe('started');
      const saved = attempts.get(attempt.id)!;
      expect(saved.runner).toBeDefined();
      expect(saved.runner?.remotePort).toBe(4166);
      expect(saved.runner?.host).toBe('runner-host.lan');
      expect(saved.runner?.model).toBe('nvidia/z-ai/glm-5.3');
    });

    it('inspectSession refuses (unknown, non-authoritative) when attempt has no recorded port', async () => {
      const adapter = new ExecutionRunnerAdapter({
        remotePort: 4096,
      });

      // Old record with no runner details
      const status = await adapter.inspectSession({
        attemptId: 'att-old',
        sessionId: 'ses_old',
        worktreePath: '/worktrees/lane-1',
        runner: null,
      });

      expect(status.runnerReachable).toBe('unknown');
      expect(status.completionReceipt).toBeNull();
    });

    it('inspectSession refuses when configured remotePort differs from recorded port', async () => {
      const adapter = new ExecutionRunnerAdapter({
        remotePort: 4096, // Differing port!
      });

      const status = await adapter.inspectSession({
        attemptId: 'att-1',
        sessionId: 'ses_1',
        worktreePath: '/worktrees/lane-1',
        runner: {
          remotePort: 4166, // Recorded port was 4166
          host: null,
          agent: null,
          model: 'nvidia/z-ai/glm-5.3',
          variant: null,
        },
      });

      expect(status.runnerReachable).toBe('unknown');
      expect(status.completionReceipt).toBeNull();
    });

    it('inspectSession refuses when configured remoteHost differs from recorded host', async () => {
      const adapter = new ExecutionRunnerAdapter({
        remotePort: 4166,
        remoteHost: 'wrong-host.lan',
      });

      const status = await adapter.inspectSession({
        attemptId: 'att-1',
        sessionId: 'ses_1',
        worktreePath: '/worktrees/lane-1',
        runner: {
          remotePort: 4166,
          host: 'expected-host.lan',
          agent: null,
          model: 'nvidia/z-ai/glm-5.3',
          variant: null,
        },
      });

      expect(status.runnerReachable).toBe('unknown');
      expect(status.completionReceipt).toBeNull();
    });
  });

  describe('3. M1: Classify ocm-run --status by Exit Code Only (No Keyword Scanning)', () => {
    it('treats exit 3 as running even when stdout contains "idle"', async () => {
      const runner: SubprocessRunner = async () => ({
        exitCode: 3,
        // Text contains idle and path contains idle! Keyword scanning would have marked it ended!
        stdout: 'Session ses_idle_test is currently idle in /worktrees/idle-fix',
        stderr: '',
      });

      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
        remotePort: 4166,
      });

      const status = await adapter.inspectSession({
        attemptId: 'att-idle',
        sessionId: 'ses_idle_test',
        worktreePath: '/worktrees/idle-fix',
        runner: {
          remotePort: 4166,
          host: null,
          agent: null,
          model: 'model',
          variant: null,
        },
      });

      expect(status.runnerReachable).toBe('reachable');
      expect(status.workerCommand).toBe('active');
      expect(status.completionReceipt).toBeNull();
    });

    it('treats exit 0 as ended even when stdout contains "error"', async () => {
      const runner: SubprocessRunner = async () => ({
        exitCode: 0,
        // Text contains error! Keyword scanning would have marked it unreachable!
        stdout: 'Previous error recovered; nothing running in /worktrees/error-retry',
        stderr: '',
      });

      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
        remotePort: 4166,
      });

      const status = await adapter.inspectSession({
        attemptId: 'att-error',
        sessionId: 'ses_error_test',
        worktreePath: '/worktrees/error-retry',
        runner: {
          remotePort: 4166,
          host: null,
          agent: null,
          model: 'model',
          variant: null,
        },
      });

      expect(status.runnerReachable).toBe('reachable');
      expect(status.workerCommand).toBe('ended');
      expect(status.completionReceipt).not.toBeNull();
      expect(status.completionReceipt?.authoritative).toBe(true);
    });

    it('treats exit codes other than 0 and 3 as unknown', async () => {
      for (const exitCode of [1, 2, 4, 127]) {
        const runner: SubprocessRunner = async () => ({
          exitCode,
          stdout: 'Active session running',
          stderr: '',
        });

        const adapter = new ExecutionRunnerAdapter({
          runSubprocess: runner,
          remotePort: 4166,
        });

        const status = await adapter.inspectSession({
          attemptId: 'att-1',
          sessionId: 'ses_1',
          worktreePath: '/worktrees/lane-1',
          runner: {
            remotePort: 4166,
            host: null,
            agent: null,
            model: 'model',
            variant: null,
          },
        });

        expect(status.runnerReachable).toBe('unknown');
        expect(status.workerCommand).toBe('not-started');
        expect(status.completionReceipt).toBeNull();
      }
    });
  });

  describe('4. Authoritative Completion & Reconcile Capacity Release', () => {
    it('"nothing running" is authoritative only when sessionId is recorded', async () => {
      const runner: SubprocessRunner = async () => ({
        exitCode: 0,
        stdout: 'nothing is running',
        stderr: '',
      });

      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
        remotePort: 4166,
      });

      // No recorded sessionId
      const status = await adapter.inspectSession({
        attemptId: 'att-no-session',
        sessionId: '',
        worktreePath: '/worktrees/lane-1',
        runner: {
          remotePort: 4166,
          host: null,
          agent: null,
          model: 'model',
          variant: null,
        },
      });

      expect(status.runnerReachable).toBe('unknown');
      expect(status.completionReceipt).toBeNull();
    });

    it('ReconcileAttemptUseCase releases capacity only on authoritative receipt', async () => {
      const attempt = createMockAttempt({ state: 'running' });
      const attempts = new Map<string, AttemptRecord>([[attempt.id, attempt]]);
      const journal = createInMemoryJournal();

      const attemptRepo: AttemptRepositoryPort = {
        findAttemptById: async (id) => attempts.get(id) ?? null,
        saveAttempt: async (rec) => {
          attempts.set(rec.id, rec);
        },
        listAttemptsByWorkOrder: async () => [...attempts.values()],
        listAllAttempts: async () => [...attempts.values()],
      };

      const authoritativeReceipt: CommandCompletionReceipt = {
        attemptId: attempt.id,
        sessionId: attempt.sessionId!,
        endedAtIso: '2026-10-15T01:00:00.000Z',
        authoritative: true,
        exitStatus: null,
        stoppedByRequest: false,
      };

      const runnerPort: ExecutionRunnerPort = {
        describeCapabilities: () => ({
          filesystemScope: 'scoped-worktree',
          networkEgressRestricted: true,
          cpuAndMemoryLimited: true,
          processTreeTermination: true,
          authoritativeCompletion: true,
          artifactPersistence: true,
        }),
        startSession: async () => {
          throw new Error('Not used');
        },
        inspectSession: async () => ({
          runnerReachable: 'reachable',
          workspacePreparation: 'prepared',
          workerCommand: 'ended',
          completionReceipt: authoritativeReceipt,
          artifactsCollected: false,
        }),
        stopSession: async () => {
          throw new Error('Not used');
        },
      };

      const useCase = new ReconcileAttemptUseCase({
        attemptRepo,
        journal,
        runner: runnerPort,
      });

      const result = await useCase.reconcileAttempt({ attemptId: attempt.id });
      expect(result.outcome).toBe('ended');
      expect(attempts.get(attempt.id)!.state).toBe('ended');
      expect(journal.reservations[0].held).toBe(false); // Capacity released!
    });

    it('ReconcileAttemptUseCase does not release capacity when receipt is non-authoritative', async () => {
      const attempt = createMockAttempt({ state: 'running' });
      const attempts = new Map<string, AttemptRecord>([[attempt.id, attempt]]);
      const journal = createInMemoryJournal();

      const attemptRepo: AttemptRepositoryPort = {
        findAttemptById: async (id) => attempts.get(id) ?? null,
        saveAttempt: async (rec) => {
          attempts.set(rec.id, rec);
        },
        listAttemptsByWorkOrder: async () => [...attempts.values()],
        listAllAttempts: async () => [...attempts.values()],
      };

      const nonAuthoritativeReceipt: CommandCompletionReceipt = {
        attemptId: attempt.id,
        sessionId: attempt.sessionId!,
        endedAtIso: '2026-10-15T01:00:00.000Z',
        authoritative: false, // NON-AUTHORITATIVE!
        exitStatus: null,
        stoppedByRequest: false,
      };

      const runnerPort: ExecutionRunnerPort = {
        describeCapabilities: () => ({
          filesystemScope: 'scoped-worktree',
          networkEgressRestricted: true,
          cpuAndMemoryLimited: true,
          processTreeTermination: true,
          authoritativeCompletion: true,
          artifactPersistence: true,
        }),
        startSession: async () => {
          throw new Error('Not used');
        },
        inspectSession: async () => ({
          runnerReachable: 'reachable',
          workspacePreparation: 'prepared',
          workerCommand: 'ended',
          completionReceipt: nonAuthoritativeReceipt,
          artifactsCollected: false,
        }),
        stopSession: async () => {
          throw new Error('Not used');
        },
      };

      const useCase = new ReconcileAttemptUseCase({
        attemptRepo,
        journal,
        runner: runnerPort,
      });

      const result = await useCase.reconcileAttempt({ attemptId: attempt.id });
      expect(result.outcome).toBe('unknown');
      expect(attempts.get(attempt.id)!.state).toBe('reconciling');
      expect(journal.reservations[0].held).toBe(true); // Capacity NOT released!
    });
  });

  describe('5. L1: Never Fall Back to Session ID as Directory', () => {
    it('inspectSession refuses when worktree directory cannot be resolved', async () => {
      let executedArgs: readonly string[] = [];
      const runner: SubprocessRunner = async (_cmd, args) => {
        executedArgs = args;
        return { exitCode: 0, stdout: '', stderr: '' };
      };

      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
        remotePort: 4166,
      });

      const status = await adapter.inspectSession({
        attemptId: 'att-unknown-dir',
        sessionId: 'ses_fallback_test',
        runner: {
          remotePort: 4166,
          host: null,
          agent: null,
          model: 'model',
          variant: null,
        },
      });

      expect(status.runnerReachable).toBe('unknown');
      expect(executedArgs).toHaveLength(0); // Subprocess was not called with sessionId as dir!
    });

    it('stopSession refuses when worktree directory cannot be resolved', async () => {
      let executedArgs: readonly string[] = [];
      const runner: SubprocessRunner = async (_cmd, args) => {
        executedArgs = args;
        return { exitCode: 0, stdout: '', stderr: '' };
      };

      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
        remotePort: 4166,
      });

      const result = await adapter.stopSession({
        attemptId: 'att-unknown-dir',
        sessionId: 'ses_fallback_test',
        gracePeriodSeconds: 10,
        runner: {
          remotePort: 4166,
          host: null,
          agent: null,
          model: 'model',
          variant: null,
        },
      });

      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('Worktree directory not resolved');
      expect(executedArgs).toHaveLength(0);
    });
  });

  describe('6. L2: Abort Records exitStatus: null and stoppedByRequest: true', () => {
    it('successful abort records exitStatus: null and stoppedByRequest: true instead of 130', async () => {
      const runner: SubprocessRunner = async () => ({
        exitCode: 0,
        stdout: 'Session aborted',
        stderr: '',
      });

      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
        remotePort: 4166,
      });

      const result = await adapter.stopSession({
        attemptId: 'att-1',
        sessionId: 'ses_abort_test',
        worktreePath: '/worktrees/lane-1',
        gracePeriodSeconds: 10,
        runner: {
          remotePort: 4166,
          host: null,
          agent: null,
          model: 'model',
          variant: null,
        },
      });

      expect(result.outcome).toBe('terminated');
      const terminated = result as { outcome: 'terminated'; receipt: CommandCompletionReceipt };
      expect(terminated.receipt.exitStatus).toBeNull();
      expect(terminated.receipt.stoppedByRequest).toBe(true);
      expect(terminated.receipt.authoritative).toBe(true);
    });
  });

  describe('7. Appendix: StopAttemptUseCase Terminal States Guard', () => {
    const journal = createInMemoryJournal();

    function setupStopUseCase(attempt: AttemptRecord) {
      const attempts = new Map<string, AttemptRecord>([[attempt.id, attempt]]);
      const attemptRepo: AttemptRepositoryPort = {
        findAttemptById: async (id) => attempts.get(id) ?? null,
        saveAttempt: async (rec) => {
          attempts.set(rec.id, rec);
        },
        listAttemptsByWorkOrder: async () => [...attempts.values()],
        listAllAttempts: async () => [...attempts.values()],
      };

      let runnerStopCalled = false;
      const runnerPort: ExecutionRunnerPort = {
        describeCapabilities: () => ({
          filesystemScope: 'scoped-worktree',
          networkEgressRestricted: true,
          cpuAndMemoryLimited: true,
          processTreeTermination: true,
          authoritativeCompletion: true,
          artifactPersistence: true,
        }),
        startSession: async () => {
          throw new Error('Not used');
        },
        inspectSession: async () => {
          throw new Error('Not used');
        },
        stopSession: async () => {
          runnerStopCalled = true;
          return {
            outcome: 'terminated',
            receipt: {
              attemptId: attempt.id,
              sessionId: attempt.sessionId!,
              endedAtIso: '2026-10-15T01:00:00.000Z',
              authoritative: true,
              exitStatus: null,
              stoppedByRequest: true,
            },
          };
        },
      };

      const useCase = new StopAttemptUseCase({
        attemptRepo,
        journal,
        runner: runnerPort,
      });

      return { useCase, attempts, wasRunnerStopCalled: () => runnerStopCalled };
    }

    it('refuses stop on collected attempt instead of regressing it', async () => {
      const attempt = createMockAttempt({ state: 'collected' });
      const { useCase, attempts, wasRunnerStopCalled } = setupStopUseCase(attempt);

      const result = await useCase.stopAttempt({ attemptId: attempt.id });
      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain("terminal state 'collected'");
      expect(attempts.get(attempt.id)!.state).toBe('collected');
      expect(wasRunnerStopCalled()).toBe(false);
    });

    it('refuses stop on cancelled attempt', async () => {
      const attempt = createMockAttempt({ state: 'cancelled' });
      const { useCase, attempts, wasRunnerStopCalled } = setupStopUseCase(attempt);

      const result = await useCase.stopAttempt({ attemptId: attempt.id });
      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain("terminal state 'cancelled'");
      expect(attempts.get(attempt.id)!.state).toBe('cancelled');
      expect(wasRunnerStopCalled()).toBe(false);
    });

    it('refuses stop on ended attempt with authoritative receipt', async () => {
      const attempt = createMockAttempt({
        state: 'ended',
        completionReceipt: {
          attemptId: 'att-1',
          sessionId: 'ses_test_123',
          endedAtIso: '2026-10-15T01:00:00.000Z',
          authoritative: true,
          exitStatus: null,
          stoppedByRequest: false,
        },
      });
      const { useCase, attempts, wasRunnerStopCalled } = setupStopUseCase(attempt);

      const result = await useCase.stopAttempt({ attemptId: attempt.id });
      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain("terminal state 'ended'");
      expect(attempts.get(attempt.id)!.state).toBe('ended');
      expect(wasRunnerStopCalled()).toBe(false);
    });

    it('stops a running attempt', async () => {
      const attempt = createMockAttempt({ state: 'running' });
      const { useCase, attempts, wasRunnerStopCalled } = setupStopUseCase(attempt);

      const result = await useCase.stopAttempt({ attemptId: attempt.id });
      expect(result.outcome).toBe('terminated');
      expect(attempts.get(attempt.id)!.state).toBe('cancelled');
      expect(attempts.get(attempt.id)!.outcome).toBe('stopped');
      expect(wasRunnerStopCalled()).toBe(true);
    });
  });

  describe('8. ADDITION: Scoped Seat Override', () => {
    function setupDispatchWithOverride(existingAttempt?: AttemptRecord) {
      const workOrder = createMockWorkOrder();
      const attempts = new Map<string, AttemptRecord>();
      if (existingAttempt) {
        attempts.set(existingAttempt.id, existingAttempt);
      }
      const journal = createInMemoryJournal();

      const workOrderRepo: WorkOrderRepositoryPort = {
        findWorkOrderById: async (id) => (id === workOrder.id ? workOrder : null),
        saveWorkOrder: async () => {},
        listWorkOrdersByProject: async () => [workOrder],
      };

      const attemptRepo: AttemptRepositoryPort = {
        findAttemptById: async (id) => attempts.get(id) ?? null,
        saveAttempt: async (rec) => {
          attempts.set(rec.id, rec);
        },
        listAttemptsByWorkOrder: async () => [...attempts.values()],
        listAllAttempts: async () => [...attempts.values()],
      };

      const workspace: WorkspacePort = {
        inspectWorktree: async (req) => ({
          worktreePath: req.worktreePath,
          matchesBaseCommit: true,
          checkedOutCommit: 'commit-base-123',
          uncommittedPaths: [],
          untrackedPaths: [],
          residueFromEarlierAttempts: [],
          missingExpectedArtifacts: [],
        }),
        readWorktreeFile: async () =>
          JSON.stringify({
            modelAssignment: {
              model: 'nvidia/z-ai/glm-5.3',
              agent: 'lane-agent',
              variant: 'default',
              fallbackModel: 'openai/gpt-4o',
            },
            independentReviewer: 'reviewer-seat-1',
          }),
      };

      let startedModel: string | undefined;
      const runnerPort: ExecutionRunnerPort = {
        describeCapabilities: () => ({
          filesystemScope: 'scoped-worktree',
          networkEgressRestricted: true,
          cpuAndMemoryLimited: true,
          processTreeTermination: true,
          authoritativeCompletion: true,
          artifactPersistence: true,
        }),
        describeRunner: () => ({
          remotePort: 4096,
          host: null,
          agent: null,
          model: null,
          variant: null,
        }),
        startSession: async (req) => {
          startedModel = req.model;
          return {
            outcome: 'started',
            sessionId: 'ses_override_test',
            runner: {
              remotePort: 4096,
              host: null,
              agent: req.agent ?? null,
              model: req.model ?? null,
              variant: req.variant ?? null,
            },
          };
        },
        inspectSession: async () => {
          throw new Error('Not used');
        },
        stopSession: async () => {
          throw new Error('Not used');
        },
      };

      const useCase = new DispatchAttemptUseCase({
        workOrderRepo,
        attemptRepo,
        journal,
        workspace,
        runner: runnerPort,
      });

      return { useCase, attempts, journal, getStartedModel: () => startedModel };
    }

    it('refuses an override without a reason', async () => {
      const { useCase } = setupDispatchWithOverride();

      const result = await useCase.dispatchAttempt({
        attemptId: 'att-1',
        workOrderId: 'wo-1',
        worktreePath: '/worktrees/lane-1',
        briefPackagePath: '.lane/brief.md',
        briefDigest: 'digest-1',
        baseCommit: 'commit-base-123',
        stepLimit: 100,
        timeLimitSeconds: 3600,
        seatOverride: {
          model: 'anthropic/claude-3-5-sonnet',
          reason: '', // Empty reason!
          setBy: 'operator',
          expiresAtIso: '2026-10-15T23:59:59.000Z',
        },
      });

      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('explicit reason');
    });

    it('refuses an override without expiresAtIso (required field)', async () => {
      const { useCase } = setupDispatchWithOverride();

      const result = await useCase.dispatchAttempt({
        attemptId: 'att-1',
        workOrderId: 'wo-1',
        worktreePath: '/worktrees/lane-1',
        briefPackagePath: '.lane/brief.md',
        briefDigest: 'digest-1',
        baseCommit: 'commit-base-123',
        stepLimit: 100,
        timeLimitSeconds: 3600,
        seatOverride: {
          model: 'anthropic/claude-3-5-sonnet',
          reason: 'Valid reason',
          setBy: 'operator',
        } as unknown as AttemptSeatOverrideRecord,
      });

      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('expiresAtIso');
    });

    it('refuses an override with empty expiresAtIso', async () => {
      const { useCase } = setupDispatchWithOverride();

      const result = await useCase.dispatchAttempt({
        attemptId: 'att-1',
        workOrderId: 'wo-1',
        worktreePath: '/worktrees/lane-1',
        briefPackagePath: '.lane/brief.md',
        briefDigest: 'digest-1',
        baseCommit: 'commit-base-123',
        stepLimit: 100,
        timeLimitSeconds: 3600,
        seatOverride: {
          model: 'anthropic/claude-3-5-sonnet',
          reason: 'Valid reason',
          setBy: 'operator',
          expiresAtIso: '',
        },
      });

      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('expiresAtIso');
    });

    it('refuses an expired override', async () => {
      const { useCase } = setupDispatchWithOverride();

      const result = await useCase.dispatchAttempt({
        attemptId: 'att-1',
        workOrderId: 'wo-1',
        worktreePath: '/worktrees/lane-1',
        briefPackagePath: '.lane/brief.md',
        briefDigest: 'digest-1',
        baseCommit: 'commit-base-123',
        stepLimit: 100,
        timeLimitSeconds: 3600,
        nowIso: '2026-10-15T12:00:00.000Z',
        seatOverride: {
          model: 'anthropic/claude-3-5-sonnet',
          reason: 'Need higher reasoning',
          setBy: 'operator',
          expiresAtIso: '2026-10-15T11:59:59.000Z', // Expired!
        },
      });

      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('expired at');
    });

    it('refuses an override whose model shares underlying family with recorded reviewer seat', async () => {
      const existing = createMockAttempt({
        reviewerSeat: 'openrouter/z-ai/glm-5.3',
      });
      const { useCase } = setupDispatchWithOverride(existing);

      const result = await useCase.dispatchAttempt({
        attemptId: existing.id,
        workOrderId: 'wo-1',
        worktreePath: '/worktrees/lane-1',
        briefPackagePath: '.lane/brief.md',
        briefDigest: 'digest-1',
        baseCommit: 'commit-base-123',
        stepLimit: 100,
        timeLimitSeconds: 3600,
        nowIso: '2026-10-15T12:00:00.000Z',
        seatOverride: {
          model: 'nvidia/z-ai/glm-5.3#low', // Same underlying family as openrouter/z-ai/glm-5.3!
          reason: 'Trying glm',
          setBy: 'operator',
          expiresAtIso: '2026-10-15T23:59:59.000Z',
        },
      });

      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('shares underlying model family');
    });

    it('accepts valid override, starts session with override model, and records in journal and attempt', async () => {
      const existing = createMockAttempt({
        reviewerSeat: 'anthropic/claude-3-5-sonnet',
      });
      const { useCase, attempts, journal, getStartedModel } = setupDispatchWithOverride(existing);

      const result = await useCase.dispatchAttempt({
        attemptId: existing.id,
        workOrderId: 'wo-1',
        worktreePath: '/worktrees/lane-1',
        briefPackagePath: '.lane/brief.md',
        briefDigest: 'digest-1',
        baseCommit: 'commit-base-123',
        stepLimit: 100,
        timeLimitSeconds: 3600,
        nowIso: '2026-10-15T12:00:00.000Z',
        seatOverride: {
          model: 'openai/gpt-4o',
          variant: 'default',
          reason: 'Authorized benchmark test',
          setBy: 'martin',
          expiresAtIso: '2026-10-15T23:59:59.000Z',
        },
      });

      expect(result.outcome).toBe('started');
      expect(getStartedModel()).toBe('openai/gpt-4o');

      const saved = attempts.get(existing.id)!;
      expect(saved.seatOverride).toBeDefined();
      expect(saved.seatOverride?.model).toBe('openai/gpt-4o');
      expect(saved.seatOverride?.reason).toBe('Authorized benchmark test');
      expect(saved.seatOverride?.setBy).toBe('martin');

      // Journal entry was appended
      const overrideEntry = journal.entries.find((e) => e.detail?.includes('Seat override recorded'));
      expect(overrideEntry).toBeDefined();
      expect(overrideEntry?.detail).toContain('openai/gpt-4o');
      expect(overrideEntry?.detail).toContain('Authorized benchmark test');
      expect(overrideEntry?.detail).toContain('martin');
    });

    it('underlyingModelFamily (shared evidence rule) handles prefixes, variants and suffix stripping correctly', () => {
      expect(underlyingModelFamily('nvidia/z-ai/glm-5.3')).toBe('glm-5.3');
      expect(underlyingModelFamily('openrouter/z-ai/glm-5.3')).toBe('glm-5.3');
      expect(underlyingModelFamily('nvidia/z-ai/glm-5.3#low')).toBe('glm-5.3');
      expect(underlyingModelFamily('nvidia/z-ai/glm-5.3-flash')).toBe('glm-5.3');
      expect(underlyingModelFamily('openrouter/z-ai/glm-5.3-flash')).toBe('glm-5.3');
      expect(underlyingModelFamily('nvidia/z-ai/glm-5.3-flashx')).toBe('glm-5.3');
      expect(underlyingModelFamily('openrouter/anthropic/claude-3-5-sonnet:beta')).toBe('claude-3-5-sonnet');
      expect(underlyingModelFamily('anthropic/claude-3-5-sonnet:nitro')).toBe('claude-3-5-sonnet');
      expect(underlyingModelFamily('opencode/longcat-2.5-preview:free')).toBe('longcat-2.5');
      expect(underlyingModelFamily('anthropic/claude-3-5-sonnet@20250929')).toBe('claude-3-5-sonnet');
      expect(underlyingModelFamily('anthropic/claude-3-5-sonnet@20250929:beta')).toBe('claude-3-5-sonnet');
      expect(underlyingModelFamily('anthropic/claude-3-5-sonnet')).toBe('claude-3-5-sonnet');
      expect(underlyingModelFamily('openai/gpt-4o')).toBe('gpt-4o');
      expect(underlyingModelFamily('gpt-4o')).toBe('gpt-4o');
      // An empty family is invalid: flash and non-flash models of one family
      // compare equal under the strict rule.
      expect(underlyingModelFamily('z-ai/glm-5.3-flash')).toBe(underlyingModelFamily('z-ai/glm-5.3'));
      expect(underlyingModelFamily('')).toBe('');
      expect(underlyingModelFamily('/')).toBe('');
      expect(underlyingModelFamily('z-ai/')).toBe('');
      expect(underlyingModelFamily('#low')).toBe('');
    });
  });

  describe('9. OCM_HOST: Validate with isSafeSshHost (Refuse Unsafe Without Spawning)', () => {
    it('refuses startSession without spawning when remoteHost starts with a dash', async () => {
      let spawned = false;
      const runner: SubprocessRunner = async () => {
        spawned = true;
        return { exitCode: 0, stdout: JSON.stringify({ sessionID: 'ses_123' }), stderr: '' };
      };

      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
        remoteHost: '-oProxyCommand=evil',
        remotePort: 4166,
      });

      const result = await adapter.startSession({
        attemptId: 'att-1',
        worktreePath: '/worktrees/lane-1',
        briefPackagePath: '.lane/brief.md',
        baseCommit: 'base-sha',
        stepLimit: 100,
        timeLimitSeconds: 3600,
        requiredCapabilities: adapter.describeCapabilities(),
        modelAssignment: { model: 'glm-5' },
      });

      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('Unsafe OCM_HOST');
      expect(spawned).toBe(false);
    });

    it('refuses startSession without spawning when remoteHost contains whitespace', async () => {
      let spawned = false;
      const runner: SubprocessRunner = async () => {
        spawned = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      };

      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
        remoteHost: 'host name with space',
        remotePort: 4166,
      });

      const result = await adapter.startSession({
        attemptId: 'att-1',
        worktreePath: '/worktrees/lane-1',
        briefPackagePath: '.lane/brief.md',
        baseCommit: 'base-sha',
        stepLimit: 100,
        timeLimitSeconds: 3600,
        requiredCapabilities: adapter.describeCapabilities(),
        modelAssignment: { model: 'glm-5' },
      });

      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('Unsafe OCM_HOST');
      expect(spawned).toBe(false);
    });

    it('refuses inspectSession without spawning when configured remoteHost is unsafe', async () => {
      let spawned = false;
      const runner: SubprocessRunner = async () => {
        spawned = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      };

      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
        remoteHost: '-unsafe-host',
        remotePort: 4166,
      });

      const status = await adapter.inspectSession({
        attemptId: 'att-1',
        sessionId: 'ses_1',
        worktreePath: '/worktrees/lane-1',
        runner: {
          remotePort: 4166,
          host: '-unsafe-host',
          agent: null,
          model: 'glm-5',
          variant: null,
        },
      });

      expect(status.runnerReachable).toBe('unknown');
      expect(spawned).toBe(false);
    });

    it('refuses inspectSession without spawning when recorded runner host is unsafe', async () => {
      let spawned = false;
      const runner: SubprocessRunner = async () => {
        spawned = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      };

      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
        remotePort: 4166,
      });

      const status = await adapter.inspectSession({
        attemptId: 'att-1',
        sessionId: 'ses_1',
        worktreePath: '/worktrees/lane-1',
        runner: {
          remotePort: 4166,
          host: '-injected-host',
          agent: null,
          model: 'glm-5',
          variant: null,
        },
      });

      expect(status.runnerReachable).toBe('unknown');
      expect(spawned).toBe(false);
    });

    it('allows safe remoteHost and passes it to ocm-run subprocess as OCM_HOST', async () => {
      let capturedEnv: Readonly<Record<string, string>> | undefined;
      const runner: SubprocessRunner = async (_cmd, _args, env) => {
        capturedEnv = env;
        return { exitCode: 0, stdout: JSON.stringify({ sessionID: 'ses_safe' }), stderr: '' };
      };

      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
        remoteHost: 'runner-node-01.internal',
        remotePort: 4166,
      });

      const result = await adapter.startSession({
        attemptId: 'att-1',
        worktreePath: '/worktrees/lane-1',
        briefPackagePath: '.lane/brief.md',
        baseCommit: 'base-sha',
        stepLimit: 100,
        timeLimitSeconds: 3600,
        requiredCapabilities: adapter.describeCapabilities(),
        modelAssignment: { model: 'glm-5' },
      });

      expect(result.outcome).toBe('started');
      expect(capturedEnv?.OCM_HOST).toBe('runner-node-01.internal');
    });
  });

  describe('10. Recorded Runner Gate for stopSession and StopAttemptUseCase', () => {
    it('stopSession refuses without spawn when port does not match recorded port', async () => {
      let spawned = false;
      const runner: SubprocessRunner = async () => {
        spawned = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      };

      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
        remotePort: 4166,
      });

      const result = await adapter.stopSession({
        attemptId: 'att-1',
        sessionId: 'ses_1',
        gracePeriodSeconds: 0,
        worktreePath: '/worktrees/lane-1',
        runner: {
          remotePort: 4167,
          host: null,
          agent: null,
          model: 'model',
          variant: null,
        },
      });

      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('differs from recorded runner');
      expect(spawned).toBe(false);
    });

    it('StopAttemptUseCase holds capacity and does not cancel when stop is refused due to wrong port', async () => {
      let spawned = false;
      const runnerSubprocess: SubprocessRunner = async () => {
        spawned = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      };

      const runnerAdapter = new ExecutionRunnerAdapter({
        runSubprocess: runnerSubprocess,
        remotePort: 4166,
      });

      const attempt = createMockAttempt({
        id: 'att-wrong-port',
        state: 'running',
        runner: {
          remotePort: 4167,
          host: null,
          agent: null,
          model: 'model',
          variant: null,
        },
      });

      const attempts = new Map<string, AttemptRecord>([[attempt.id, attempt]]);
      const attemptRepo: AttemptRepositoryPort = {
        findAttemptById: async (id) => attempts.get(id) ?? null,
        saveAttempt: async (rec) => {
          attempts.set(rec.id, rec);
        },
        listAttemptsByWorkOrder: async () => [...attempts.values()],
        listAllAttempts: async () => [...attempts.values()],
      };
      const journal = createInMemoryJournal();

      const useCase = new StopAttemptUseCase({
        attemptRepo,
        journal,
        runner: runnerAdapter,
      });

      const result = await useCase.stopAttempt({ attemptId: attempt.id });
      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('differs from recorded runner');
      expect(spawned).toBe(false);

      const saved = attempts.get(attempt.id)!;
      expect(saved.state).toBe('running');
      expect(saved.outcome).toBeNull();
      expect(journal.reservations[0].held).toBe(true);
    });

    it('stopSession refuses without spawn when attempt has no runner record (legacy record)', async () => {
      let spawned = false;
      const runner: SubprocessRunner = async () => {
        spawned = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      };

      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
        remotePort: 4166,
      });

      const result = await adapter.stopSession({
        attemptId: 'att-legacy',
        sessionId: 'ses_1',
        gracePeriodSeconds: 0,
        worktreePath: '/worktrees/lane-1',
        runner: null,
      });

      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('no recorded runner port');
      expect(spawned).toBe(false);
    });

    it('stopSession refuses without spawn when recorded runner host is unsafe', async () => {
      let spawned = false;
      const runner: SubprocessRunner = async () => {
        spawned = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      };

      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
        remotePort: 4166,
      });

      const result = await adapter.stopSession({
        attemptId: 'att-unsafe',
        sessionId: 'ses_1',
        gracePeriodSeconds: 0,
        worktreePath: '/worktrees/lane-1',
        runner: {
          remotePort: 4166,
          host: '-unsafe-flag',
          agent: null,
          model: 'model',
          variant: null,
        },
      });

      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('Unsafe recorded runner host');
      expect(spawned).toBe(false);
    });

    it('stopSession spawns abort with recorded port when port matches', async () => {
      let capturedArgs: readonly string[] = [];
      let capturedEnv: Readonly<Record<string, string>> | undefined;
      const runner: SubprocessRunner = async (_cmd, args, env) => {
        capturedArgs = args;
        capturedEnv = env;
        return { exitCode: 0, stdout: '', stderr: '' };
      };

      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
        remotePort: 4166,
      });

      const result = await adapter.stopSession({
        attemptId: 'att-matching',
        sessionId: 'ses_1',
        gracePeriodSeconds: 0,
        worktreePath: '/worktrees/lane-1',
        runner: {
          remotePort: 4166,
          host: null,
          agent: null,
          model: 'model',
          variant: null,
        },
      });

      expect(result.outcome).toBe('terminated');
      expect(capturedArgs).toEqual(['--abort', '--dir', '/worktrees/lane-1']);
      expect(capturedEnv?.OCM_REMOTE_PORT).toBe('4166');
    });
  });

  describe('11. Frozen Seat Fidelity and Dispatch Validation', () => {
    function setupDispatchWithCustomWorkspace(
      workspace: WorkspacePort,
      runnerPortOverrides?: Partial<ExecutionRunnerPort>,
    ) {
      const workOrder = createMockWorkOrder();
      const attempts = new Map<string, AttemptRecord>();
      const journal = createInMemoryJournal();
      for (const id of ['att-remote-1', 'att-unreadable', 'att-no-port', 'att-tz-1', 'att-tz-2']) {
        journal.reservations.push({
          id: `res-${id}`,
          attemptId: id,
          hostId: 'host-1',
          slotIndex: 0,
          held: true,
          reservedAtIso: '2026-10-15T00:00:00.000Z',
          releasedAtIso: null,
        });
      }

      const workOrderRepo: WorkOrderRepositoryPort = {
        findWorkOrderById: async (id) => (id === workOrder.id ? workOrder : null),
        saveWorkOrder: async () => {},
        listWorkOrdersByProject: async () => [workOrder],
      };

      const attemptRepo: AttemptRepositoryPort = {
        findAttemptById: async (id) => attempts.get(id) ?? null,
        saveAttempt: async (rec) => {
          attempts.set(rec.id, rec);
        },
        listAttemptsByWorkOrder: async () => [...attempts.values()],
        listAllAttempts: async () => [...attempts.values()],
      };

      let startedSessionReq: StartRunnerSessionRequest | undefined;
      const defaultRunner: ExecutionRunnerPort = {
        describeCapabilities: () => ({
          filesystemScope: 'scoped-worktree',
          networkEgressRestricted: true,
          cpuAndMemoryLimited: true,
          processTreeTermination: true,
          authoritativeCompletion: true,
          artifactPersistence: true,
        }),
        describeRunner: () => ({
          remotePort: 4166,
          host: null,
          agent: null,
          model: null,
          variant: null,
        }),
        startSession: async (req) => {
          startedSessionReq = req;
          return {
            outcome: 'started',
            sessionId: 'ses_dispatch_test',
            runner: {
              remotePort: 4166,
              host: null,
              agent: req.agent ?? null,
              model: req.model ?? null,
              variant: req.variant ?? null,
            },
          };
        },
        inspectSession: async () => {
          throw new Error('Not used');
        },
        stopSession: async () => {
          throw new Error('Not used');
        },
      };

      const runnerPort = { ...defaultRunner, ...runnerPortOverrides };

      const useCase = new DispatchAttemptUseCase({
        workOrderRepo,
        attemptRepo,
        journal,
        workspace,
        runner: runnerPort,
      });

      return { useCase, attempts, journal, getStartedSessionReq: () => startedSessionReq };
    }

    it('refuses dispatch if request carries forbidden model field', async () => {
      const { useCase, getStartedSessionReq } = setupDispatchWithCustomWorkspace({
        inspectWorktree: async (req) => ({
          worktreePath: req.worktreePath,
          matchesBaseCommit: true,
          checkedOutCommit: 'commit-base-123',
          uncommittedPaths: [],
          untrackedPaths: [],
          residueFromEarlierAttempts: [],
          missingExpectedArtifacts: [],
        }),
        readWorktreeFile: async () => JSON.stringify({ modelAssignment: { model: 'seat-1' } }),
      });

      const result = await useCase.dispatchAttempt({
        attemptId: 'att-1',
        workOrderId: 'wo-1',
        worktreePath: '/worktrees/lane-1',
        briefPackagePath: '.lane/brief.md',
        briefDigest: 'digest-1',
        baseCommit: 'commit-base-123',
        stepLimit: 100,
        timeLimitSeconds: 3600,
        model: 'forbidden-model-override',
      } as unknown as DispatchAttemptRequest);

      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain("'model' must not be specified");
      expect(getStartedSessionReq()).toBeUndefined();
    });

    it('resolves seat from frozen brief manifest on remote worktree read through port', async () => {
      let readWorktreeArgs: { worktreePath: string; relativePath: string } | undefined;
      const { useCase, getStartedSessionReq, attempts } = setupDispatchWithCustomWorkspace({
        inspectWorktree: async (req) => ({
          worktreePath: req.worktreePath,
          matchesBaseCommit: true,
          checkedOutCommit: 'commit-base-123',
          uncommittedPaths: [],
          untrackedPaths: [],
          residueFromEarlierAttempts: [],
          missingExpectedArtifacts: [],
        }),
        readWorktreeFile: async (worktreePath, relativePath) => {
          readWorktreeArgs = { worktreePath, relativePath };
          return JSON.stringify({
            modelAssignment: {
              model: 'remote-manifest-seat-model',
              agent: 'remote-agent',
              variant: 'fast',
            },
          });
        },
      });

      const result = await useCase.dispatchAttempt({
        attemptId: 'att-remote-1',
        workOrderId: 'wo-1',
        worktreePath: '/ssh-remote-worktree/lane-1',
        briefPackagePath: '.lane/brief.md',
        briefDigest: 'digest-1',
        baseCommit: 'commit-base-123',
        stepLimit: 100,
        timeLimitSeconds: 3600,
      });

      expect(result.outcome).toBe('started');
      expect(readWorktreeArgs).toEqual({
        worktreePath: '/ssh-remote-worktree/lane-1',
        relativePath: '.lane/brief.md',
      });
      const started = getStartedSessionReq();
      expect(started).toBeDefined();
      if (!started) {
        throw new Error('started session request must be defined');
      }
      expect(started.model).toBe('remote-manifest-seat-model');
      expect(started.agent).toBe('remote-agent');
      expect(started.variant).toBe('fast');

      const saved = attempts.get('att-remote-1')!;
      expect(saved.runner?.model).toBe('remote-manifest-seat-model');
      expect(saved.runner?.remotePort).toBe(4166);
    });

    it('refuses dispatch and touches no runner when brief manifest cannot be read through port', async () => {
      let runnerStarted = false;
      const { useCase } = setupDispatchWithCustomWorkspace(
        {
          inspectWorktree: async (req) => ({
            worktreePath: req.worktreePath,
            matchesBaseCommit: true,
            checkedOutCommit: 'commit-base-123',
            uncommittedPaths: [],
            untrackedPaths: [],
            residueFromEarlierAttempts: [],
            missingExpectedArtifacts: [],
          }),
          readWorktreeFile: async () => null,
        },
        {
          startSession: async () => {
            runnerStarted = true;
            throw new Error('Should not be called');
          },
        },
      );

      const result = await useCase.dispatchAttempt({
        attemptId: 'att-unreadable',
        workOrderId: 'wo-1',
        worktreePath: '/worktrees/lane-1',
        briefPackagePath: '.lane/brief.md',
        briefDigest: 'digest-1',
        baseCommit: 'commit-base-123',
        stepLimit: 100,
        timeLimitSeconds: 3600,
      });

      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('Unable to read frozen brief manifest');
      expect(runnerStarted).toBe(false);
    });

    it('refuses dispatch and mutates no reservation when no runner port can be described', async () => {
      let runnerStarted = false;
      const { useCase, journal } = setupDispatchWithCustomWorkspace(
        {
          inspectWorktree: async (req) => ({
            worktreePath: req.worktreePath,
            matchesBaseCommit: true,
            checkedOutCommit: 'commit-base-123',
            uncommittedPaths: [],
            untrackedPaths: [],
            residueFromEarlierAttempts: [],
            missingExpectedArtifacts: [],
          }),
          readWorktreeFile: async () => JSON.stringify({ modelAssignment: { model: 'model-1' } }),
        },
        {
          describeRunner: () => undefined,
          startSession: async () => {
            runnerStarted = true;
            throw new Error('Should not be called');
          },
        },
      );

      const result = await useCase.dispatchAttempt({
        attemptId: 'att-no-port',
        workOrderId: 'wo-1',
        worktreePath: '/worktrees/lane-1',
        briefPackagePath: '.lane/brief.md',
        briefDigest: 'digest-1',
        baseCommit: 'commit-base-123',
        stepLimit: 100,
        timeLimitSeconds: 3600,
      });

      expect(result.outcome).toBe('refused');
      expect((result as { reason: string }).reason).toContain('No runner port can be described for dispatch');
      expect(runnerStarted).toBe(false);
      expect(journal.entries.filter((e) => e.attemptId === 'att-no-port')).toHaveLength(0);
    });

    it('compares seat override expiry with Date.parse correctly across timezones', async () => {
      const { useCase } = setupDispatchWithCustomWorkspace({
        inspectWorktree: async (req) => ({
          worktreePath: req.worktreePath,
          matchesBaseCommit: true,
          checkedOutCommit: 'commit-base-123',
          uncommittedPaths: [],
          untrackedPaths: [],
          residueFromEarlierAttempts: [],
          missingExpectedArtifacts: [],
        }),
        readWorktreeFile: async () => JSON.stringify({ modelAssignment: { model: 'seat-1' } }),
      });

      const resultExpired = await useCase.dispatchAttempt({
        attemptId: 'att-tz-1',
        workOrderId: 'wo-1',
        worktreePath: '/worktrees/lane-1',
        briefPackagePath: '.lane/brief.md',
        briefDigest: 'digest-1',
        baseCommit: 'commit-base-123',
        stepLimit: 100,
        timeLimitSeconds: 3600,
        nowIso: '2026-10-15T12:00:00.000Z',
        seatOverride: {
          model: 'anthropic/claude-3-5-sonnet',
          reason: 'Timezone test expired',
          setBy: 'operator',
          expiresAtIso: '2026-10-15T13:00:00+02:00',
        },
      });

      expect(resultExpired.outcome).toBe('refused');
      expect((resultExpired as { reason: string }).reason).toContain('expired at');

      const resultValid = await useCase.dispatchAttempt({
        attemptId: 'att-tz-2',
        workOrderId: 'wo-1',
        worktreePath: '/worktrees/lane-1',
        briefPackagePath: '.lane/brief.md',
        briefDigest: 'digest-1',
        baseCommit: 'commit-base-123',
        stepLimit: 100,
        timeLimitSeconds: 3600,
        nowIso: '2026-10-15T12:00:00.000Z',
        seatOverride: {
          model: 'anthropic/claude-3-5-sonnet',
          reason: 'Timezone test valid',
          setBy: 'operator',
          expiresAtIso: '2026-10-15T11:00:00-02:00',
        },
      });

      expect(resultValid.outcome).toBe('started');
    });
  });
});

