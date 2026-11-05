// Routing facts for a conducted agy fix round after an opencode first pass.
// These tests record today's behaviour only; they are not a specification of a
// cross-host branch/worktree handoff (see
// docs/planning/2026-11-02_conducted-agy-fix-round-note.md).

import { describe, expect, it } from 'vitest';
import type { AttemptRecord } from '../src/domain/execution-records.js';
import { InMemoryAttemptRepository } from '../src/application/ports/out/__tests__/in-memory-attempt-repository.js';
import type { ExecutionRunnerPort } from '../src/application/ports/out/ExecutionRunnerPort.out-port.js';
import { PrepareFixAttemptUseCase } from '../src/application/use-cases/PrepareFixAttemptUseCase.use-case.js';
import { RunnerForAttemptAdapter } from '../src/infrastructure/adapters/RunnerForAttemptAdapter.adapter.js';
import { ExecutionRunnerAdapter } from '../src/infrastructure/adapters/ExecutionRunnerAdapter.adapter.js';
import { AgyRunnerAdapter } from '../src/infrastructure/adapters/AgyRunnerAdapter.adapter.js';

function createPriorAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'att-prior',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/worktrees/orig',
    baseCommit: 'commit-base-123',
    state: 'collected',
    outcome: 'done',
    briefDigest: 'sha256-brief',
    briefPackagePath: '/briefs/brief.md',
    sessionId: 'session-prior',
    completionReceipt: {
      attemptId: 'att-prior',
      sessionId: 'session-prior',
      endedAtIso: '2026-11-02T10:00:00.000Z',
      authoritative: true,
      exitStatus: 0,
      stoppedByRequest: false,
    },
    artifacts: null,
    runner: {
      kind: 'opencode',
      remotePort: null,
      host: null,
      hostName: 'host-opencode-alpha',
      agent: null,
      model: 'openrouter/inception/mercury-3',
      variant: 'default',
    },
    createdAtIso: '2026-11-02T09:00:00.000Z',
    updatedAtIso: '2026-11-02T10:00:00.000Z',
    ...overrides,
  };
}

function stubRunner(): ExecutionRunnerPort {
  return {
    describeCapabilities: () => ({
      filesystemScope: 'scoped-worktree' as const,
      networkEgressRestricted: true,
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      authoritativeCompletion: true,
      artifactPersistence: true,
      source: 'declared' as const,
    }),
    startSession: async () => ({ outcome: 'refused' as const, reason: 'stub runner' }),
    inspectSession: async () => ({
      runnerReachable: 'unknown' as const,
      workspacePreparation: 'unprepared' as const,
      workerCommand: 'not-started' as const,
      completionReceipt: null,
      artifactsCollected: false,
    }),
    stopSession: async () => ({ outcome: 'refused' as const, reason: 'stub runner' }),
  };
}

describe('PrepareFixAttemptUseCase routing after an opencode first pass', () => {
  it('inherits the prior opencode host block, worktreePath and baseCommit', async () => {
    const attemptRepo = new InMemoryAttemptRepository();
    const prior = createPriorAttempt();
    await attemptRepo.saveAttempt(prior);

    const useCase = new PrepareFixAttemptUseCase({ attemptRepo });
    const result = await useCase.prepareFixAttempt({
      fixAttemptId: 'att-fix-1',
      workOrderId: prior.workOrderId,
      priorAttemptId: prior.id,
      numberedFixes: ['Fix 1'],
    });

    expect(result.outcome).toBe('prepared');
    if (result.outcome === 'prepared') {
      expect(result.attempt.kind).toBe('fix');
      expect(result.attempt.fixNumber).toBe(1);
      expect(result.attempt.worktreePath).toBe(prior.worktreePath);
      expect(result.attempt.baseCommit).toBe(prior.baseCommit);
      expect(result.attempt.runner?.kind).toBe('opencode');
      expect(result.attempt.runner?.hostName).toBe('host-opencode-alpha');
      expect(result.attempt.runner?.remotePort).toBeNull();
      expect(result.attempt.runner?.agent).toBeNull();
      expect(result.attempt.runner?.model).toBeNull();
      expect(result.attempt.runner?.variant).toBeNull();
      expect(typeof result.attempt.createdAtIso).toBe('string');
    }
  });

  it('refuses with exactly "No fix seat available: " plus the selection reason and saves no record', async () => {
    const attemptRepo = new InMemoryAttemptRepository();
    const prior = createPriorAttempt({
      seatPlan: {
        version: 1,
        'first-pass': [{ id: 'fp-a', model: 'alpha-1', tool: 'opencode', agent: 'lane' }],
        fix: [{ id: 'fx-agy', model: 'beta-1', tool: 'agy', agent: 'lane-glm' }],
        review: [],
      },
    });
    await attemptRepo.saveAttempt(prior);

    const useCase = new PrepareFixAttemptUseCase({ attemptRepo });
    const result = await useCase.prepareFixAttempt({
      fixAttemptId: 'att-fix-1',
      workOrderId: prior.workOrderId,
      priorAttemptId: prior.id,
      numberedFixes: ['Fix 1'],
      unhealthySeatIds: ['fx-agy'],
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toBe('No fix seat available: Seat plan exhausted for role fix: fx-agy: unhealthy');
    }
    expect(await attemptRepo.findAttemptById('att-fix-1')).toBeNull();
  });
});

describe('RunnerForAttemptAdapter routing for a recorded opencode host', () => {
  it('resolves a recorded opencode host to the opencode adapter, never the agy runner', () => {
    const adapter = new RunnerForAttemptAdapter({
      hosts: {
        'host-opencode-alpha': {
          transport: 'local',
          roles: ['lane-runner'],
          runner: { kind: 'opencode', port: 4242 },
        },
      },
      legacyRunner: stubRunner(),
    });

    const result = adapter.runnerForAttempt({
      runner: {
        kind: 'opencode',
        remotePort: 4242,
        host: null,
        hostName: 'host-opencode-alpha',
        agent: null,
        model: null,
        variant: null,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runner).toBeInstanceOf(ExecutionRunnerAdapter);
      expect(result.runner).not.toBeInstanceOf(AgyRunnerAdapter);
    }
  });
});
