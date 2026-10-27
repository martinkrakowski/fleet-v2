import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

import { DispatchAttemptUseCase } from '../DispatchAttemptUseCase.use-case.js';
import { PrepareBriefPackageUseCase } from '../PrepareBriefPackageUseCase.use-case.js';
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  CapacityReservationRecord,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';
import type { CommandExecutorPort } from '../../ports/out/CommandExecutorPort.out-port.js';
import type {
  CommandRunOptions,
  CommandRunResult,
} from '../../ports/out/CommandExecutorPort.out-port.js';
import type { ExecutionRunnerPort } from '../../ports/out/ExecutionRunnerPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import { AttemptArtifactAdapter } from '../../../infrastructure/adapters/AttemptArtifactAdapter.adapter.js';
import { WorkspaceAdapter } from '../../../infrastructure/adapters/WorkspaceAdapter.adapter.js';
import { BriefAuthoringAdapter } from '../../../infrastructure/adapters/BriefAuthoringAdapter.adapter.js';
import { LocalExecutor } from '../../../infrastructure/adapters/LocalExecutor.adapter.js';

const execFileAsync = promisify(execFile);

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

function makeJournalWithReservation(worktreePath: string) {
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
  const entries: ActionJournalEntryRecord[] = [];
  const journal = {
    entries,
    heldFor(attemptId: string): boolean {
      return reservation.attemptId === attemptId && reservation.held;
    },
    async appendJournalEntry(entry: ActionJournalEntryRecord): Promise<void> {
      entries.push(entry);
    },
    async listJournalEntriesForAttempt(): Promise<ActionJournalEntryRecord[]> {
      return entries;
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
  return journal;
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

const attemptRepo = {
  async findAttemptById() {
    return null;
  },
} as unknown as AttemptRepositoryPort;

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

    const nonMd = await useCase.dispatchAttempt(dispatchRequest('/etc/passwd'));
    expect(nonMd).toEqual({
      outcome: 'refused',
      reason: 'briefPackagePath must name the frozen prose (.md), got /etc/passwd',
    });

    const result = await useCase.dispatchAttempt(dispatchRequest('/etc/passwd.md'));

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('Failed to read brief manifest');
    }
    expect(
      calls.filter((call) => call.argv.some((argument) => argument.includes('/etc/passwd'))),
    ).toHaveLength(0);
  });

  it('refuses a ../x brief package path and never cats it', async () => {
    const { executor, calls } = fakeExecutor();
    const useCase = makeDispatchUseCase(executor);

    const nonMd = await useCase.dispatchAttempt(dispatchRequest('../x'));
    expect(nonMd).toEqual({
      outcome: 'refused',
      reason: 'briefPackagePath must name the frozen prose (.md), got ../x',
    });

    const result = await useCase.dispatchAttempt(dispatchRequest('../x.md'));

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('Failed to read brief manifest');
    }
    expect(
      calls.filter((call) => call.argv.some((argument) => argument.includes('../x'))),
    ).toHaveLength(0);
  });

  it('readBriefFile refuses ../x and an absolute path and never cats them', async () => {
    const { executor, calls } = fakeExecutor();
    const adapter = new AttemptArtifactAdapter({ executor });

    await expect(adapter.readBriefFile('/wt', '../x')).rejects.toThrow(
      'Refused worktree-relative path ../x: worktree-relative path must not escape the worktree root',
    );
    await expect(adapter.readBriefFile('/wt', '/etc/passwd')).rejects.toThrow(
      'Refused worktree-relative path /etc/passwd: worktree-relative path must be relative',
    );
    expect(calls).toHaveLength(0);
  });
});

describe('dispatch through the real adapters recomputes the frozen brief digest (D3)', () => {
  const createdDirs = new Set<string>();

  afterAll(async () => {
    await Promise.all(
      [...createdDirs].map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  async function createTempGitWorktree(): Promise<{ repoPath: string; head: string }> {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-real-digest-'));
    createdDirs.add(repoPath);
    const git = (args: readonly string[]) =>
      execFileAsync(
        'git',
        ['-c', 'user.name=Fleet Test', '-c', 'user.email=fleet-test@example.invalid', ...args],
        { cwd: repoPath },
      );
    await git(['init']);
    await fs.writeFile(path.join(repoPath, '.gitignore'), '.lane/\n', 'utf8');
    await fs.writeFile(path.join(repoPath, 'README.md'), '# fleet test\n', 'utf8');
    await git(['add', '.']);
    await git(['commit', '-m', 'initial commit']);
    const { stdout } = await git(['rev-parse', 'HEAD']);
    return { repoPath, head: stdout.trim() };
  }

  function makeStartedRunner(): { runner: ExecutionRunnerPort; startCalls: unknown[] } {
    const startCalls: unknown[] = [];
    const runner: ExecutionRunnerPort = {
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
        model: 'implementer-model',
        variant: 'default',
      }),
      async startSession(request) {
        startCalls.push(request);
        return { outcome: 'started', sessionId: 'session-1' };
      },
      async inspectSession() {
        return {
          runnerReachable: 'reachable',
          workspacePreparation: 'prepared',
          workerCommand: 'active',
          completionReceipt: null,
          artifactsCollected: false,
        };
      },
      async stopSession() {
        return { outcome: 'still-running', reason: 'not used' };
      },
    };
    return { runner, startCalls };
  }

  function makeRealDispatchSetup(repoPath: string, runner: ExecutionRunnerPort) {
    const workOrderRepo = makeWorkOrderRepo();
    const attempts = new Map<string, AttemptRecord>();
    const attemptRepo: AttemptRepositoryPort & { attempts: Map<string, AttemptRecord> } = {
      attempts,
      async saveAttempt(record) {
        attempts.set(record.id, record);
      },
      async findAttemptById(attemptId) {
        return attempts.get(attemptId) ?? null;
      },
      async listAttemptsByWorkOrder() {
        return [...attempts.values()];
      },
      async listAllAttempts() {
        return [...attempts.values()];
      },
    };
    const journal = makeJournalWithReservation(repoPath);
    const useCase = new DispatchAttemptUseCase({
      workOrderRepo,
      attemptRepo,
      journal,
      workspace: new WorkspaceAdapter({ executor: new LocalExecutor() }),
      runner,
      artifactPort: new AttemptArtifactAdapter({ executor: new LocalExecutor() }),
    });
    return { attemptRepo, journal, runner, useCase };
  }

  async function prepareRealBrief(repoPath: string, head: string) {
    const briefFilePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-brief-file-')), 'brief.md');
    createdDirs.add(path.dirname(briefFilePath));
    await fs.writeFile(briefFilePath, '# Frozen prose\n', 'utf8');
    const prepare = new PrepareBriefPackageUseCase({
      briefAuthoring: new BriefAuthoringAdapter(),
      artifactPort: new AttemptArtifactAdapter({ executor: new LocalExecutor() }),
    });
    const result = await prepare.prepareBriefPackage({
      workOrderId: 'wo-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      laneId: 'lane-1',
      repository: 'git@example.org:acme/app.git',
      baseCommit: head,
      policyRevision: 'policy-7',
      modelAssignment: {
        model: 'implementer-model',
        variant: 'default',
        fallbackModel: 'fallback-model',
        seatTool: 'opencode',
      },
      independentReviewer: 'reviewer-model',
      ownedPaths: ['src/**'],
      permissions: ['filesystem:worktree'],
      acceptanceChecks: ['yarn test'],
      acceptanceSpec: { commitRequired: true, diffCheck: true, commands: [{ argv: ['corepack', 'yarn', 'build'] }] },
      allowedPathPrefixes: ['src'],
      stepLimit: 40,
      timeLimitSeconds: 3600,
      resourceBounds: { cpu: '2' },
      expectedArtifacts: [],
      ownerDecisionReferences: [],
      contextDecisions: [],
      attemptId: 'attempt-1',
      worktreePath: repoPath,
      handWrittenBriefPath: briefFilePath,
    });
    if (result.outcome !== 'prepared') {
      throw new Error(`prepare failed: ${result.reason}`);
    }
    return result.prepared;
  }

  function realDispatchRequest(repoPath: string, head: string, prepared: { prosePath: string; briefDigest: string }) {
    return {
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      worktreePath: repoPath,
      briefPackagePath: prepared.prosePath,
      briefDigest: prepared.briefDigest,
      baseCommit: head,
      stepLimit: 40,
      timeLimitSeconds: 3600,
      expectedArtifacts: [],
      nowIso: '2026-10-15T08:00:00.000Z',
    };
  }

  it('dispatches past the digest check when the brief still matches its prepared digest', { timeout: 30000 }, async () => {
    const { repoPath, head } = await createTempGitWorktree();
    const prepared = await prepareRealBrief(repoPath, head);
    const { runner, startCalls } = makeStartedRunner();
    const { useCase } = makeRealDispatchSetup(repoPath, runner);

    const result = await useCase.dispatchAttempt(realDispatchRequest(repoPath, head, prepared));

    expect(result.outcome).toBe('started');
    expect(startCalls).toHaveLength(1);
  });

  it('refuses when the frozen prose is edited after prepare, saving nothing and starting no runner', { timeout: 30000 }, async () => {
    const { repoPath, head } = await createTempGitWorktree();
    const prepared = await prepareRealBrief(repoPath, head);
    const { runner, startCalls } = makeStartedRunner();
    const { attemptRepo, journal, useCase } = makeRealDispatchSetup(repoPath, runner);

    await fs.appendFile(prepared.prosePath, '\nEDITED AFTER PREPARE\n', 'utf8');

    const result = await useCase.dispatchAttempt(realDispatchRequest(repoPath, head, prepared));

    expect(result).toEqual({
      outcome: 'refused',
      reason:
        'Frozen brief digest mismatch for attempt attempt-1: the brief or its manifest changed after it was prepared; run \'brief prepare\' again',
    });
    expect(startCalls).toHaveLength(0);
    expect(journal.entries).toHaveLength(0);
    expect(attemptRepo.attempts.size).toBe(0);
    expect(journal.heldFor('attempt-1')).toBe(true);
  });

  it('refuses when .lane/brief-manifest.json is edited after prepare, saving nothing and starting no runner', { timeout: 30000 }, async () => {
    const { repoPath, head } = await createTempGitWorktree();
    const prepared = await prepareRealBrief(repoPath, head);
    const { runner, startCalls } = makeStartedRunner();
    const { attemptRepo, journal, useCase } = makeRealDispatchSetup(repoPath, runner);

    const manifestPath = path.join(repoPath, '.lane', 'brief-manifest.json');
    const manifestRaw = await fs.readFile(manifestPath, 'utf8');
    await fs.writeFile(
      manifestPath,
      manifestRaw.replace('implementer-model', 'edited-model'),
      'utf8',
    );

    const result = await useCase.dispatchAttempt(realDispatchRequest(repoPath, head, prepared));

    expect(result).toEqual({
      outcome: 'refused',
      reason:
        'Frozen brief digest mismatch for attempt attempt-1: the brief or its manifest changed after it was prepared; run \'brief prepare\' again',
    });
    expect(startCalls).toHaveLength(0);
    expect(journal.entries).toHaveLength(0);
    expect(attemptRepo.attempts.size).toBe(0);
    expect(journal.heldFor('attempt-1')).toBe(true);
  });
});
