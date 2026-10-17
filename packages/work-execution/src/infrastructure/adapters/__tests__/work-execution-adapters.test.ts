import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  AttemptRunnerRecord,
  CapacityReservationRecord,
  CommandCompletionReceipt,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';
import type {
  RunnerIsolationCapabilities,
  StartRunnerSessionRequest,
} from '../../../application/ports/out/ExecutionRunnerPort.out-port.js';
import type { SubprocessResult, SubprocessRunner } from '../ExecutionRunnerAdapter.adapter.js';
import {
  RUNNER_ENV_ALLOWLIST,
  buildRunnerEnv,
} from '../ExecutionRunnerAdapter.adapter.js';
import { AttemptArtifactAdapter } from '../AttemptArtifactAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../AttemptRepositoryAdapter.adapter.js';
import { BriefAuthoringAdapter } from '../BriefAuthoringAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../ExecutionJournalAdapter.adapter.js';
import { ExecutionRunnerAdapter } from '../ExecutionRunnerAdapter.adapter.js';
import { WorkOrderRepositoryAdapter } from '../WorkOrderRepositoryAdapter.adapter.js';
import { WorkspaceAdapter } from '../WorkspaceAdapter.adapter.js';
import { LocalExecutor } from '../LocalExecutor.adapter.js';

const execFileAsync = promisify(execFile);

const createdDirs = new Set<string>();

afterAll(async () => {
  await Promise.all(
    [...createdDirs].map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.add(directory);
  return directory;
}

async function git(repoPath: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'user.name=Fleet Test', '-c', 'user.email=fleet-test@example.invalid', ...args],
    { cwd: repoPath },
  );
  return stdout;
}

/** Real temporary Git repository with `.lane/` ignored by default. */
async function createGitRepo(ignoreLane = true): Promise<string> {
  const repoPath = await makeTempDir('fleet-repo-');
  await git(repoPath, ['init']);
  await fs.writeFile(path.join(repoPath, '.gitignore'), ignoreLane ? '.lane/\n' : '', 'utf8');
  await fs.writeFile(path.join(repoPath, 'README.md'), '# fleet test\n', 'utf8');
  await git(repoPath, ['add', '.']);
  await git(repoPath, ['commit', '-m', 'initial commit']);
  return repoPath;
}

function makeWorkOrder(overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id: 'wo-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'repo-1',
    baseCommit: 'abc123',
    ownedPaths: ['src/**'],
    policyRevision: 'policy-1',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 1,
    createdAtIso: '2026-10-15T10:00:00.000Z',
    updatedAtIso: '2026-10-15T10:00:00.000Z',
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'att-1',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/tmp/fleet-test-worktree',
    baseCommit: 'abc123',
    state: 'intent-recorded',
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    createdAtIso: '2026-10-15T10:00:00.000Z',
    updatedAtIso: '2026-10-15T10:00:00.000Z',
    ...overrides,
  };
}

function makeJournalEntry(overrides: Partial<ActionJournalEntryRecord> = {}): ActionJournalEntryRecord {
  return {
    id: 'je-1',
    attemptId: 'att-1',
    workOrderId: 'wo-1',
    action: 'dispatch',
    baseCommit: 'abc123',
    recordedAtIso: '2026-10-15T10:00:00.000Z',
    status: 'intent-recorded',
    sessionId: null,
    detail: null,
    ...overrides,
  };
}

function makeReservation(overrides: Partial<CapacityReservationRecord> = {}): CapacityReservationRecord {
  return {
    id: 'res-1',
    attemptId: 'att-1',
    hostId: 'host-a',
    slotIndex: 0,
    held: true,
    reservedAtIso: '2026-10-15T10:00:00.000Z',
    releasedAtIso: null,
    ...overrides,
  };
}

function makeReceipt(overrides: Partial<CommandCompletionReceipt> = {}): CommandCompletionReceipt {
  return {
    attemptId: 'att-1',
    sessionId: 'ses_1',
    endedAtIso: '2026-10-15T12:00:00.000Z',
    authoritative: true,
    exitStatus: 0,
    stoppedByRequest: false,
    ...overrides,
  };
}

const fullCapabilities: RunnerIsolationCapabilities = {
  // D4: the enforced default profile is the v1 / env-only behaviour, so its
  // report carries the loader-derived `legacy-asserted` source.
  source: 'legacy-asserted',
  filesystemScope: 'scoped-worktree',
  networkEgressRestricted: true,
  cpuAndMemoryLimited: true,
  processTreeTermination: true,
  authoritativeCompletion: true,
  artifactPersistence: true,
};

const runnerWorktreePath = '/tmp/fleet-test-worktree';
const runnerBriefPackagePath = '/tmp/fleet-test-worktree/.lane/brief.md';

function makeStartRequest(overrides: Partial<StartRunnerSessionRequest> = {}): StartRunnerSessionRequest {
  return {
    attemptId: 'att-1',
    worktreePath: runnerWorktreePath,
    briefPackagePath: runnerBriefPackagePath,
    baseCommit: 'abc123',
    stepLimit: 50,
    timeLimitSeconds: 3600,
    requiredCapabilities: fullCapabilities,
    ...overrides,
  };
}

interface RecordedSubprocessCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>> | undefined;
}

/** Injected subprocess runner that replays results (repeating the last) and records calls. */
function scriptedRunner(
  results: readonly (SubprocessResult | Error)[],
): { readonly runner: SubprocessRunner; readonly calls: RecordedSubprocessCall[] } {
  const calls: RecordedSubprocessCall[] = [];
  let cursor = 0;
  const runner: SubprocessRunner = async (command, args, env) => {
    calls.push({ command, args: [...args], env });
    const result = results[Math.min(cursor, results.length - 1)];
    cursor += 1;
    if (result instanceof Error) throw result;
    return result;
  };
  return { runner, calls };
}

describe('WorkOrderRepositoryAdapter', () => {
  it('saves and finds work orders in memory', async () => {
    const adapter = new WorkOrderRepositoryAdapter();
    const record = makeWorkOrder();
    await adapter.saveWorkOrder(record);
    await expect(adapter.findWorkOrderById('wo-1')).resolves.toEqual(record);
    await expect(adapter.findWorkOrderById('wo-missing')).resolves.toBeNull();
  });

  it('refuses stale revisions with optimistic concurrency', async () => {
    const adapter = new WorkOrderRepositoryAdapter();
    await adapter.saveWorkOrder(makeWorkOrder({ revision: 2 }));
    await expect(adapter.saveWorkOrder(makeWorkOrder({ revision: 2 }))).rejects.toThrow(
      'Stale work order revision for wo-1: expected > 2, got 2',
    );
    await expect(adapter.saveWorkOrder(makeWorkOrder({ revision: 1 }))).rejects.toThrow(
      'Stale work order revision for wo-1: expected > 2, got 1',
    );
  });

  it('accepts newer revisions', async () => {
    const adapter = new WorkOrderRepositoryAdapter();
    await adapter.saveWorkOrder(makeWorkOrder({ revision: 1 }));
    await adapter.saveWorkOrder(makeWorkOrder({ revision: 2, state: 'implementing' }));
    const found = await adapter.findWorkOrderById('wo-1');
    expect(found?.revision).toBe(2);
    expect(found?.state).toBe('implementing');
  });

  it('lists work orders, optionally narrowed by project', async () => {
    const adapter = new WorkOrderRepositoryAdapter();
    await adapter.saveWorkOrder(makeWorkOrder({ id: 'wo-a', projectId: 'proj-1' }));
    await adapter.saveWorkOrder(makeWorkOrder({ id: 'wo-b', projectId: 'proj-2' }));
    expect((await adapter.listWorkOrdersByProject()).map((record) => record.id)).toEqual([
      'wo-a',
      'wo-b',
    ]);
    expect((await adapter.listWorkOrdersByProject('proj-1')).map((record) => record.id)).toEqual([
      'wo-a',
    ]);
  });

  it('persists work orders to stateDir and reloads them for a new instance', async () => {
    const stateDir = await makeTempDir('fleet-state-');
    const writer = new WorkOrderRepositoryAdapter({ stateDir });
    await writer.saveWorkOrder(makeWorkOrder({ revision: 1 }));
    await writer.saveWorkOrder(makeWorkOrder({ revision: 2 }));
    const reader = new WorkOrderRepositoryAdapter({ stateDir });
    const found = await reader.findWorkOrderById('wo-1');
    expect(found?.revision).toBe(2);
    const persisted = JSON.parse(
      await fs.readFile(path.join(stateDir, 'work-orders.json'), 'utf8'),
    ) as unknown[];
    expect(persisted).toHaveLength(1);
  });
});

describe('AttemptRepositoryAdapter', () => {
  it('saves and finds attempts in memory', async () => {
    const adapter = new AttemptRepositoryAdapter();
    const record = makeAttempt();
    await adapter.saveAttempt(record);
    await expect(adapter.findAttemptById('att-1')).resolves.toEqual(record);
    await expect(adapter.findAttemptById('att-missing')).resolves.toBeNull();
  });

  it('refuses mutations of immutable attempt identity', async () => {
    const adapter = new AttemptRepositoryAdapter();
    await adapter.saveAttempt(makeAttempt());
    await expect(adapter.saveAttempt(makeAttempt({ workOrderId: 'wo-other' }))).rejects.toThrow(
      'Immutable attempt identity changed for att-1: workOrderId',
    );
    await expect(adapter.saveAttempt(makeAttempt({ worktreePath: '/tmp/other' }))).rejects.toThrow(
      'Immutable attempt identity changed for att-1: worktreePath',
    );
  });

  it('allows guarded lifecycle updates', async () => {
    const adapter = new AttemptRepositoryAdapter();
    await adapter.saveAttempt(makeAttempt({ state: 'dispatching' }));
    await adapter.saveAttempt(makeAttempt({ state: 'running', sessionId: 'ses_9' }));
    const found = await adapter.findAttemptById('att-1');
    expect(found?.state).toBe('running');
    expect(found?.sessionId).toBe('ses_9');
  });

  it('lists attempts by work order in creation order', async () => {
    const adapter = new AttemptRepositoryAdapter();
    await adapter.saveAttempt(
      makeAttempt({ id: 'att-3', createdAtIso: '2026-10-15T10:03:00.000Z' }),
    );
    await adapter.saveAttempt(
      makeAttempt({ id: 'att-1', createdAtIso: '2026-10-15T10:01:00.000Z' }),
    );
    await adapter.saveAttempt(
      makeAttempt({ id: 'att-2', createdAtIso: '2026-10-15T10:02:00.000Z' }),
    );
    expect((await adapter.listAttemptsByWorkOrder('wo-1')).map((record) => record.id)).toEqual([
      'att-1',
      'att-2',
      'att-3',
    ]);
  });

  it('lists all attempts newest update first', async () => {
    const adapter = new AttemptRepositoryAdapter();
    await adapter.saveAttempt(
      makeAttempt({ id: 'att-a', updatedAtIso: '2026-10-15T10:00:00.000Z' }),
    );
    await adapter.saveAttempt(
      makeAttempt({ id: 'att-b', updatedAtIso: '2026-10-15T11:00:00.000Z' }),
    );
    await adapter.saveAttempt(
      makeAttempt({ id: 'att-c', updatedAtIso: '2026-10-15T09:00:00.000Z' }),
    );
    expect((await adapter.listAllAttempts()).map((record) => record.id)).toEqual([
      'att-b',
      'att-a',
      'att-c',
    ]);
  });

  it('persists attempts to stateDir and reloads them for a new instance', async () => {
    const stateDir = await makeTempDir('fleet-state-');
    const writer = new AttemptRepositoryAdapter({ stateDir });
    await writer.saveAttempt(makeAttempt({ state: 'running' }));
    const reader = new AttemptRepositoryAdapter({ stateDir });
    const found = await reader.findAttemptById('att-1');
    expect(found?.state).toBe('running');
    expect((await reader.listAllAttempts()).map((record) => record.id)).toEqual(['att-1']);
  });
});

describe('ExecutionJournalAdapter', () => {
  it('appends journal entries and lists them per attempt in recorded order', async () => {
    const adapter = new ExecutionJournalAdapter();
    await adapter.appendJournalEntry(makeJournalEntry({ id: 'je-1' }));
    await adapter.appendJournalEntry(makeJournalEntry({ id: 'je-2', attemptId: 'att-2' }));
    await adapter.appendJournalEntry(makeJournalEntry({ id: 'je-3', action: 'collect' }));
    expect((await adapter.listJournalEntriesForAttempt('att-1')).map((entry) => entry.id)).toEqual([
      'je-1',
      'je-3',
    ]);
    expect((await adapter.listJournalEntriesForAttempt('att-2')).map((entry) => entry.id)).toEqual([
      'je-2',
    ]);
  });

  it('refuses duplicate journal entry ids', async () => {
    const adapter = new ExecutionJournalAdapter();
    await adapter.appendJournalEntry(makeJournalEntry());
    await expect(adapter.appendJournalEntry(makeJournalEntry())).rejects.toThrow(
      'Duplicate journal entry id: je-1',
    );
  });

  it('saves, lists and releases capacity reservations', async () => {
    const adapter = new ExecutionJournalAdapter();
    await adapter.saveCapacityReservation(makeReservation({ id: 'res-1', attemptId: 'att-1', hostId: 'host-a' }));
    await adapter.saveCapacityReservation(
      makeReservation({ id: 'res-2', attemptId: 'att-2', hostId: 'host-b' }),
    );
    expect((await adapter.listActiveReservations()).map((reservation) => reservation.id)).toEqual([
      'res-1',
      'res-2',
    ]);
    expect(
      (await adapter.listActiveReservations('host-a')).map((reservation) => reservation.id),
    ).toEqual(['res-1']);
    expect(await adapter.releaseCapacityReservation('att-1', '2026-10-15T12:00:00.000Z')).toBe(
      true,
    );
    expect((await adapter.listActiveReservations()).map((reservation) => reservation.id)).toEqual([
      'res-2',
    ]);
    expect(await adapter.releaseCapacityReservation('att-1', '2026-10-15T12:01:00.000Z')).toBe(
      false,
    );
    expect(await adapter.releaseCapacityReservation('att-missing', '2026-10-15T12:01:00.000Z')).toBe(
      false,
    );
  });

  it('refuses to supersede an earlier held reservation for the same attempt', async () => {
    const adapter = new ExecutionJournalAdapter();
    await adapter.saveCapacityReservation(makeReservation({ id: 'res-1', attemptId: 'att-1' }));
    await expect(
      adapter.saveCapacityReservation(makeReservation({ id: 'res-2', attemptId: 'att-1' })),
    ).rejects.toThrow(
      'ExecutionJournalAdapter refuses to supersede held reservation res-1 of attempt att-1',
    );
    // The earlier claim survives untouched.
    expect((await adapter.listActiveReservations()).map((reservation) => reservation.id)).toEqual([
      'res-1',
    ]);
    expect(await adapter.releaseCapacityReservation('att-1', '2026-10-15T12:00:00.000Z')).toBe(
      true,
    );
    // Once released, a fresh reservation for the same attempt is appendable history.
    await expect(
      adapter.saveCapacityReservation(makeReservation({ id: 'res-2', attemptId: 'att-1', slotIndex: 1 })),
    ).resolves.toBeUndefined();
    expect((await adapter.listActiveReservations()).map((reservation) => reservation.id)).toEqual([
      'res-2',
    ]);
  });

  it('persists journal entries and reservations to stateDir', async () => {
    const stateDir = await makeTempDir('fleet-state-');
    const writer = new ExecutionJournalAdapter({ stateDir });
    await writer.appendJournalEntry(makeJournalEntry({ id: 'je-1' }));
    await writer.saveCapacityReservation(makeReservation({ id: 'res-1', attemptId: 'att-1' }));
    await writer.releaseCapacityReservation('att-1', '2026-10-15T12:00:00.000Z');

    const reader = new ExecutionJournalAdapter({ stateDir });
    expect((await reader.listJournalEntriesForAttempt('att-1')).map((entry) => entry.id)).toEqual([
      'je-1',
    ]);
    expect(await reader.listActiveReservations()).toEqual([]);
    const persisted = JSON.parse(
      await fs.readFile(path.join(stateDir, 'reservations.json'), 'utf8'),
    ) as Array<Record<string, unknown>>;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.held).toBe(false);
    expect(persisted[0]?.releasedAtIso).toBe('2026-10-15T12:00:00.000Z');
  });
});

describe('WorkspaceAdapter', () => {
  it('inspects a clean worktree at its base commit', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
    const inspection = await new WorkspaceAdapter({ executor: new LocalExecutor() }).inspectWorktree({
      worktreePath: repoPath,
      baseCommit: head,
      expectedArtifactPaths: ['README.md'],
    });
    expect(inspection.checkedOutCommit).toBe(head);
    expect(inspection.matchesBaseCommit).toBe(true);
    expect(inspection.uncommittedPaths).toEqual([]);
    expect(inspection.untrackedPaths).toEqual([]);
    expect(inspection.residueFromEarlierAttempts).toEqual([]);
    expect(inspection.missingExpectedArtifacts).toEqual([]);
  });

  it('reports missing expected artifacts', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
    const inspection = await new WorkspaceAdapter({ executor: new LocalExecutor() }).inspectWorktree({
      worktreePath: repoPath,
      baseCommit: head,
      expectedArtifactPaths: ['README.md', 'docs/report.md'],
    });
    expect(inspection.missingExpectedArtifacts).toEqual(['docs/report.md']);
  });

  it('reports modified, untracked and residue paths without modifying the worktree', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
    await fs.writeFile(path.join(repoPath, 'README.md'), '# changed\n', 'utf8');
    await fs.writeFile(path.join(repoPath, 'scratch.txt'), 'scratch\n', 'utf8');
    await fs.mkdir(path.join(repoPath, '.lane'), { recursive: true });
    await fs.writeFile(path.join(repoPath, '.lane', 'brief.md'), 'brief\n', 'utf8');
    await fs.writeFile(path.join(repoPath, '.lane', 'notes.md'), 'notes\n', 'utf8');

    const inspection = await new WorkspaceAdapter({ executor: new LocalExecutor() }).inspectWorktree({
      worktreePath: repoPath,
      baseCommit: '0'.repeat(40),
      expectedArtifactPaths: ['.lane/brief.md'],
    });
    expect(inspection.checkedOutCommit).toBe(head);
    expect(inspection.matchesBaseCommit).toBe(false);
    expect(inspection.uncommittedPaths).toContain('README.md');
    expect(inspection.untrackedPaths).toContain('scratch.txt');
    expect(inspection.residueFromEarlierAttempts).toEqual(['.lane/brief.md', '.lane/notes.md']);
    expect(inspection.missingExpectedArtifacts).toEqual([]);
  });

  it('reads a worktree file when present and returns null when absent', async () => {
    const repoPath = await createGitRepo();
    await fs.writeFile(path.join(repoPath, 'config.json'), '{"hello":"world"}', 'utf8');
    const adapter = new WorkspaceAdapter({ executor: new LocalExecutor() });
    const content = await adapter.readWorktreeFile(repoPath, 'config.json');
    expect(content).toBe('{"hello":"world"}');

    const missing = await adapter.readWorktreeFile(repoPath, 'nonexistent.json');
    expect(missing).toBeNull();
  });
});

describe('BriefAuthoringAdapter', () => {
  it('authors a brief from a hand-written file', async () => {
    const directory = await makeTempDir('fleet-brief-');
    const briefPath = path.join(directory, 'brief.md');
    await fs.writeFile(briefPath, '# Hand-written brief\n', 'utf8');
    const result = await new BriefAuthoringAdapter().authorBrief({
      workOrderId: 'wo-1',
      laneId: 'lane-1',
      handWrittenBriefPath: briefPath,
    });
    expect(result).toEqual({
      outcome: 'authored',
      brief: { proseMarkdown: '# Hand-written brief\n', provenance: 'hand-written-file' },
    });
  });

  it('reports unavailable when the hand-written file is missing', async () => {
    const result = await new BriefAuthoringAdapter().authorBrief({
      workOrderId: 'wo-1',
      laneId: 'lane-1',
      handWrittenBriefPath: '/tmp/fleet-brief-does-not-exist.md',
    });
    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.reason).toContain('Hand-written brief file is missing or unreadable');
    }
  });

  it('reports unavailable when the hand-written file is empty', async () => {
    const directory = await makeTempDir('fleet-brief-');
    const briefPath = path.join(directory, 'brief.md');
    await fs.writeFile(briefPath, '   \n', 'utf8');
    const result = await new BriefAuthoringAdapter().authorBrief({
      workOrderId: 'wo-1',
      laneId: 'lane-1',
      handWrittenBriefPath: briefPath,
    });
    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.reason).toContain('Hand-written brief file is empty');
    }
  });

  it('authors reviewed orchestrator prose for a known work order', async () => {
    const adapter = new BriefAuthoringAdapter({
      defaultProseByWorkOrder: { 'wo-1': '# Orchestrator brief' },
    });
    const result = await adapter.authorBrief({
      workOrderId: 'wo-1',
      laneId: 'lane-1',
      handWrittenBriefPath: null,
    });
    expect(result).toEqual({
      outcome: 'authored',
      brief: { proseMarkdown: '# Orchestrator brief', provenance: 'orchestrator' },
    });
  });

  it('reports unavailable without any brief source', async () => {
    const adapter = new BriefAuthoringAdapter({
      defaultProseByWorkOrder: { 'wo-other': '# Different work order' },
    });
    const result = await adapter.authorBrief({
      workOrderId: 'wo-1',
      laneId: 'lane-1',
      handWrittenBriefPath: null,
    });
    expect(result).toEqual({
      outcome: 'unavailable',
      reason: 'No hand-written brief path or orchestrator brief provided',
    });
  });
});

describe('AttemptArtifactAdapter', () => {
  it('verifies which candidate paths are gitignored', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const adapter = new AttemptArtifactAdapter({ executor: new LocalExecutor() });
    const ignored = await adapter.verifyIgnoredPaths({
      worktreePath: repoPath,
      candidatePaths: ['.lane/brief.md', '.lane/brief-manifest.json'],
    });
    expect(ignored).toEqual({
      outcome: 'ignored',
      checkedPaths: ['.lane/brief.md', '.lane/brief-manifest.json'],
    });
    const notIgnored = await adapter.verifyIgnoredPaths({
      worktreePath: repoPath,
      candidatePaths: ['.lane/brief.md', 'README.md'],
    });
    expect(notIgnored).toEqual({ outcome: 'not-ignored', offendingPaths: ['README.md'] });
  });

  it('refuses to place a frozen brief when .lane is not gitignored', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo(false);
    const result = await new AttemptArtifactAdapter({ executor: new LocalExecutor() }).placeFrozenBrief({
      attemptId: 'att-1',
      worktreePath: repoPath,
      proseMarkdown: '# Brief',
      manifestJson: '{"attemptId":"att-1"}',
    });
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Brief target paths are not gitignored',
    });
    await expect(fs.stat(path.join(repoPath, '.lane'))).rejects.toThrow('ENOENT');
  });

  it('places the frozen brief package under ignored paths', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const result = await new AttemptArtifactAdapter({ executor: new LocalExecutor() }).placeFrozenBrief({
      attemptId: 'att-1',
      worktreePath: repoPath,
      proseMarkdown: '# Brief prose',
      manifestJson: '{"attemptId":"att-1"}',
    });
    expect(result).toEqual({
      outcome: 'placed',
      prosePath: path.join(repoPath, '.lane', 'brief.md'),
      manifestPath: path.join(repoPath, '.lane', 'brief-manifest.json'),
    });
    await expect(
      fs.readFile(path.join(repoPath, '.lane', 'brief.md'), 'utf8'),
    ).resolves.toBe('# Brief prose');
    await expect(
      fs.readFile(path.join(repoPath, '.lane', 'brief-manifest.json'), 'utf8'),
    ).resolves.toBe('{"attemptId":"att-1"}');
    const status = await git(repoPath, ['status', '--porcelain=v1', '-uall']);
    expect(status.trim()).toBe('');
  });

  it('refuses a completion receipt bound to another attempt', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
    const result = await new AttemptArtifactAdapter({ executor: new LocalExecutor() }).collectCompletedAttemptArtifacts({
      attemptId: 'att-1',
      worktreePath: repoPath,
      baseCommit: head,
      expectedArtifactPaths: [],
      completionReceipt: makeReceipt({ attemptId: 'att-other' }),
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'Completion receipt attemptId mismatch' });
  });

  it('collects artifacts with zero commits since base and missing notes', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
    const result = await new AttemptArtifactAdapter({ executor: new LocalExecutor() }).collectCompletedAttemptArtifacts({
      attemptId: 'att-1',
      worktreePath: repoPath,
      baseCommit: head,
      expectedArtifactPaths: ['README.md', 'docs/absent.md'],
      completionReceipt: makeReceipt(),
    });
    expect(result).toEqual({
      outcome: 'collected',
      artifacts: {
        headCommit: head,
        commitsSinceBase: [],
        collectedArtifactPaths: ['README.md'],
        notes: 'missing',
      },
    });
  });

  it('collects artifacts after one commit since base with present notes', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const base = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
    await fs.writeFile(path.join(repoPath, 'docs-summary.md'), 'summary\n', 'utf8');
    await git(repoPath, ['add', 'docs-summary.md']);
    await git(repoPath, ['commit', '-m', 'add summary']);
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
    await fs.mkdir(path.join(repoPath, '.lane'), { recursive: true });
    await fs.writeFile(path.join(repoPath, '.lane', 'notes.md'), 'notes\n', 'utf8');

    const result = await new AttemptArtifactAdapter({ executor: new LocalExecutor() }).collectCompletedAttemptArtifacts({
      attemptId: 'att-1',
      worktreePath: repoPath,
      baseCommit: base,
      expectedArtifactPaths: ['docs-summary.md'],
      completionReceipt: makeReceipt(),
    });
    expect(result.outcome).toBe('collected');
    if (result.outcome !== 'collected') return;
    expect(result.artifacts.headCommit).toBe(head);
    expect(result.artifacts.commitsSinceBase).toEqual([head]);
    expect(result.artifacts.notes).toBe('present');
    expect(result.artifacts.collectedArtifactPaths).toEqual(['docs-summary.md', '.lane/notes.md']);
  });

  it('deduplicates collected artifact paths', { timeout: 20000 }, async () => {
    const repoPath = await createGitRepo();
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
    await fs.mkdir(path.join(repoPath, '.lane'), { recursive: true });
    await fs.writeFile(path.join(repoPath, '.lane', 'notes.md'), 'notes\n', 'utf8');
    const result = await new AttemptArtifactAdapter({ executor: new LocalExecutor() }).collectCompletedAttemptArtifacts({
      attemptId: 'att-1',
      worktreePath: repoPath,
      baseCommit: head,
      expectedArtifactPaths: ['README.md', 'README.md', '.lane/notes.md'],
      completionReceipt: makeReceipt(),
    });
    expect(result.outcome).toBe('collected');
    if (result.outcome !== 'collected') return;
    expect(result.artifacts.collectedArtifactPaths).toEqual(['README.md', '.lane/notes.md']);
  });

  it('reads a brief manifest when present and returns null when absent', async () => {
    const repoPath = await createGitRepo();
    await fs.mkdir(path.join(repoPath, '.lane'), { recursive: true });
    await fs.writeFile(
      path.join(repoPath, '.lane', 'brief-manifest.json'),
      '{"modelAssignment":{"model":"glm-5"}}',
      'utf8',
    );
    const adapter = new AttemptArtifactAdapter({ executor: new LocalExecutor() });
    const content = await adapter.readBriefManifest(repoPath);
    expect(content).toBe('{"modelAssignment":{"model":"glm-5"}}');

    const missing = await adapter.readBriefManifest(repoPath, path.join(repoPath, '.lane', 'missing-manifest.json'));
    expect(missing).toBeNull();
  });
});

describe('ExecutionRunnerAdapter', () => {
  it('declares enforced default capabilities', () => {
    const adapter = new ExecutionRunnerAdapter();
    expect(adapter.describeCapabilities()).toEqual(fullCapabilities);
  });

  it('builds a runner environment that strips unapproved process.env keys', () => {
    const allowlisted: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      OCM_REMOTE_PORT: process.env.OCM_REMOTE_PORT,
    };
    const secretKeys = ['OPENROUTER_API_KEY', 'GITHUB_TOKEN', 'FLEET_TEST_SECRET'] as const;
    const secretSnapshot: Record<string, string | undefined> = Object.fromEntries(
      secretKeys.map((key) => [key, process.env[key]]),
    );
    try {
      process.env.PATH = '/usr/bin:/bin';
      process.env.OPENROUTER_API_KEY = 'sk-test-openrouter';
      process.env.GITHUB_TOKEN = 'gho-test-token';
      process.env.FLEET_TEST_SECRET = 'do-not-forward';

      const env = buildRunnerEnv({ OCM_REMOTE_PORT: '7777' });

      // Allow-listed keys survive; explicit overrides win.
      expect(env.PATH).toBe('/usr/bin:/bin');
      expect(env.OCM_REMOTE_PORT).toBe('7777');
      // Unapproved host variables — including credentials — are stripped.
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.FLEET_TEST_SECRET).toBeUndefined();
      for (const key of RUNNER_ENV_ALLOWLIST) {
        if (process.env[key] !== undefined) {
          expect(env[key]).toBe(process.env[key]);
        }
      }
    } finally {
      // Deleting instead of assigning undefined avoids Node coercing the
      // variable to the literal string "undefined" in later subprocess envs.
      if (allowlisted.PATH === undefined) delete process.env.PATH;
      else process.env.PATH = allowlisted.PATH;
      if (allowlisted.OCM_REMOTE_PORT === undefined) delete process.env.OCM_REMOTE_PORT;
      else process.env.OCM_REMOTE_PORT = allowlisted.OCM_REMOTE_PORT;
      for (const key of secretKeys) {
        const previous = secretSnapshot[key];
        if (previous === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous;
        }
      }
    }
  });

  it('applies capability overrides on top of the defaults', () => {
    const adapter = new ExecutionRunnerAdapter({
      capabilities: { networkEgressRestricted: false, filesystemScope: 'inherited-directory' },
    });
    const capabilities = adapter.describeCapabilities();
    expect(capabilities.networkEgressRestricted).toBe(false);
    expect(capabilities.filesystemScope).toBe('inherited-directory');
    expect(capabilities.cpuAndMemoryLimited).toBe(true);
    expect(capabilities.processTreeTermination).toBe(true);
  });

  it('refuses a session when required capabilities are not satisfied', async () => {
    const { runner } = scriptedRunner([
      { exitCode: 0, stdout: '{"sessionID":"ses_x"}', stderr: '' },
    ]);
    const adapter = new ExecutionRunnerAdapter({
      runSubprocess: runner,
      capabilities: { networkEgressRestricted: false },
    });
    const result = await adapter.startSession(makeStartRequest());
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Runner does not satisfy required isolation capabilities',
    });
  });

  it('refuses a session when the required filesystem scope differs', async () => {
    const { runner } = scriptedRunner([
      { exitCode: 0, stdout: '{"sessionID":"ses_x"}', stderr: '' },
    ]);
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner });
    const result = await adapter.startSession(
      makeStartRequest({
        requiredCapabilities: { ...fullCapabilities, filesystemScope: 'inherited-directory' },
      }),
    );
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Runner does not satisfy required isolation capabilities',
    });
  });

  it('starts a session and parses the sessionID from JSON stdout', async () => {
    const { runner, calls } = scriptedRunner([
      { exitCode: 0, stdout: '{"sessionID":"ses_abc"}', stderr: '' },
    ]);
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner });
    const result = await adapter.startSession(makeStartRequest({ modelAssignment: { model: 'glm-5' } }));
    expect(result).toEqual({ outcome: 'started', sessionId: 'ses_abc' });
    expect(calls[0]?.command).toMatch(/\/bin\/ocm-run$/);
    expect(calls[0]?.args).toEqual([
      '--detach',
      '--dir',
      runnerWorktreePath,
      '-m',
      'glm-5',
      '--format',
      'json',
      `Read and execute ${runnerBriefPackagePath}`,
    ]);
    expect(calls[0]?.env).toBeUndefined();
  });

  it('passes configured runner options, model flags and remote port env', async () => {
    const { runner, calls } = scriptedRunner([
      { exitCode: 0, stdout: '{"sessionId":"ses_lower"}', stderr: '' },
    ]);
    const adapter = new ExecutionRunnerAdapter({
      ocmRunBin: '/usr/local/bin/ocm-run',
      remotePort: 7777,
      runSubprocess: runner,
    });
    const result = await adapter.startSession(
      makeStartRequest({
        agent: 'opencode',
        model: 'glm-5',
        variant: 'fast',
      }),
    );
    expect(result).toEqual({
      outcome: 'started',
      sessionId: 'ses_lower',
      runner: {
        kind: 'opencode',
        remotePort: 7777,
        host: null,
        agent: 'opencode',
        model: 'glm-5',
        variant: 'fast',
      },
    });
    expect(calls[0]?.command).toBe('/usr/local/bin/ocm-run');
    expect(calls[0]?.args).toEqual([
      '--detach',
      '--dir',
      runnerWorktreePath,
      '--agent',
      'opencode',
      '-m',
      'glm-5',
      '--variant',
      'fast',
      '--format',
      'json',
      `Read and execute ${runnerBriefPackagePath}`,
    ]);
    expect(calls[0]?.env).toEqual({ OCM_REMOTE_PORT: '7777' });
  });

  it('parses a bare ses_ token when stdout is not JSON', async () => {
    const { runner } = scriptedRunner([
      { exitCode: 0, stdout: 'session started: ses_tok-42 (detached)', stderr: '' },
    ]);
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner });
    const result = await adapter.startSession(makeStartRequest({ modelAssignment: { model: 'glm-5' } }));
    expect(result).toEqual({ outcome: 'started', sessionId: 'ses_tok-42' });
  });

  it('refuses a start when the worktree already has an active session (exit 75)', async () => {
    const { runner } = scriptedRunner([
      { exitCode: 75, stdout: '', stderr: 'session already active' },
    ]);
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner });
    const result = await adapter.startSession(makeStartRequest({ modelAssignment: { model: 'glm-5' } }));
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'Worktree already has an active session (exit 75)',
    });
  });

  it('reports unknown when the runner exits 0 without a sessionId', async () => {
    const { runner } = scriptedRunner([{ exitCode: 0, stdout: '', stderr: '' }]);
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner });
    const result = await adapter.startSession(makeStartRequest({ modelAssignment: { model: 'glm-5' } }));
    expect(result).toEqual({
      outcome: 'unknown',
      reason: 'Runner exited 0 without returning a sessionId',
    });
  });

  it('reports unknown for non-zero exits and subprocess failures', async () => {
    const failing = new ExecutionRunnerAdapter({
      runSubprocess: scriptedRunner([{ exitCode: 1, stdout: '', stderr: 'runner unavailable' }])
        .runner,
    });
    const failed = await failing.startSession(makeStartRequest({ modelAssignment: { model: 'glm-5' } }));
    expect(failed).toEqual({ outcome: 'unknown', reason: 'runner unavailable' });

    const throwing = new ExecutionRunnerAdapter({
      runSubprocess: scriptedRunner([new Error('network timeout')]).runner,
    });
    const thrown = await throwing.startSession(makeStartRequest({ modelAssignment: { model: 'glm-5' } }));
    expect(thrown.outcome).toBe('unknown');
    if (thrown.outcome === 'unknown') {
      expect(thrown.reason).toContain('network timeout');
    }
  });

  it('reports an active session from status exit code 3', async () => {
    const { runner, calls } = scriptedRunner([
      { exitCode: 0, stdout: '{"sessionID":"ses_a"}', stderr: '' },
      { exitCode: 3, stdout: 'ocm-run: running in /tmp/fleet-test-worktree:\nses_a', stderr: '' },
    ]);
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner, remotePort: 4166 });
    const started = await adapter.startSession(makeStartRequest({ modelAssignment: { model: 'glm-5' } }));
    const status = await adapter.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_a',
      worktreePath: runnerWorktreePath,
      runner: started.outcome === 'started' ? started.runner : undefined,
    });
    expect(status).toEqual({
      runnerReachable: 'reachable',
      workspacePreparation: 'prepared',
      workerCommand: 'active',
      completionReceipt: null,
      artifactsCollected: false,
    });
    expect(calls[1]?.args).toEqual(['--status', '--dir', runnerWorktreePath]);
  });

  it('reports an ended session with an authoritative receipt', async () => {
    const { runner } = scriptedRunner([
      { exitCode: 0, stdout: '{"sessionID":"ses_a"}', stderr: '' },
      {
        exitCode: 0,
        stdout:
          '{"active":false,"exitStatus":0,"endedAtIso":"2026-10-15T12:34:56.000Z","artifactsCollected":true}',
        stderr: '',
      },
    ]);
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner, remotePort: 4166 });
    const started = await adapter.startSession(makeStartRequest({ modelAssignment: { model: 'glm-5' } }));
    const status = await adapter.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_a',
      worktreePath: runnerWorktreePath,
      runner: started.outcome === 'started' ? started.runner : undefined,
    });
    expect(status.runnerReachable).toBe('reachable');
    expect(status.workerCommand).toBe('ended');
    expect(status.artifactsCollected).toBe(true);
    expect(status.completionReceipt).toEqual({
      attemptId: 'att-1',
      sessionId: 'ses_a',
      endedAtIso: '2026-10-15T12:34:56.000Z',
      authoritative: true,
      exitStatus: 0,
      stoppedByRequest: false,
    });
  });

  it('treats idle and nothing-running status text as ended', async () => {
    const runnerRecord: AttemptRunnerRecord = {
      kind: 'opencode',
      remotePort: 4166,
      host: null,
      agent: null,
      model: 'glm-5',
      variant: null,
    };
    const idle = new ExecutionRunnerAdapter({
      runSubprocess: scriptedRunner([{ exitCode: 0, stdout: 'runner idle', stderr: '' }]).runner,
      remotePort: 4166,
    });
    const idleStatus = await idle.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_a',
      worktreePath: runnerWorktreePath,
      runner: runnerRecord,
    });
    expect(idleStatus.workerCommand).toBe('ended');
    expect(idleStatus.completionReceipt).not.toBeNull();
    expect(Number.isNaN(Date.parse(idleStatus.completionReceipt?.endedAtIso ?? ''))).toBe(false);

    const nothing = new ExecutionRunnerAdapter({
      runSubprocess: scriptedRunner([{ exitCode: 0, stdout: 'nothing running', stderr: '' }])
        .runner,
      remotePort: 4166,
    });
    const nothingStatus = await nothing.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_a',
      worktreePath: runnerWorktreePath,
      runner: runnerRecord,
    });
    expect(nothingStatus.workerCommand).toBe('ended');
  });

  it('refuses when no worktree is known and never falls back to the session id', async () => {
    const { runner, calls } = scriptedRunner([
      { exitCode: 0, stdout: '{"active":true}', stderr: '' },
    ]);
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner, remotePort: 4166 });
    const status = await adapter.inspectSession({
      attemptId: 'att-9',
      sessionId: 'ses_orphan',
      runner: { kind: 'opencode', remotePort: 4166, host: null, agent: null, model: 'glm-5', variant: null },
    });
    expect(status.runnerReachable).toBe('unknown');
    expect(calls).toHaveLength(0);
  });

  it('reports unknown when the status command fails or exits non-zero', async () => {
    const runnerRecord: AttemptRunnerRecord = {
      kind: 'opencode',
      remotePort: 4166,
      host: null,
      agent: null,
      model: 'glm-5',
      variant: null,
    };
    const exited = new ExecutionRunnerAdapter({
      runSubprocess: scriptedRunner([{ exitCode: 1, stdout: '', stderr: 'daemon not running' }])
        .runner,
      remotePort: 4166,
    });
    const exitedStatus = await exited.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_a',
      worktreePath: runnerWorktreePath,
      runner: runnerRecord,
    });
    expect(exitedStatus).toEqual({
      runnerReachable: 'unknown',
      workspacePreparation: 'unprepared',
      workerCommand: 'not-started',
      completionReceipt: null,
      artifactsCollected: false,
    });

    const throwing = new ExecutionRunnerAdapter({
      runSubprocess: scriptedRunner([new Error('connection refused')]).runner,
      remotePort: 4166,
    });
    const thrownStatus = await throwing.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_a',
      worktreePath: runnerWorktreePath,
      runner: runnerRecord,
    });
    expect(thrownStatus.runnerReachable).toBe('unknown');
    expect(thrownStatus.workerCommand).toBe('not-started');
  });

  it('terminates a session and returns an authoritative stop receipt', async () => {
    const { runner, calls } = scriptedRunner([{ exitCode: 0, stdout: 'aborted', stderr: '' }]);
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner, remotePort: 4166 });
    const result = await adapter.stopSession({
      attemptId: 'att-1',
      sessionId: 'ses_a',
      worktreePath: runnerWorktreePath,
      gracePeriodSeconds: 30,
      runner: { kind: 'opencode', remotePort: 4166, host: null, agent: null, model: 'glm-5', variant: null },
    });
    expect(result.outcome).toBe('terminated');
    if (result.outcome !== 'terminated') return;
    expect(result.receipt.attemptId).toBe('att-1');
    expect(result.receipt.sessionId).toBe('ses_a');
    expect(result.receipt.exitStatus).toBeNull();
    expect(result.receipt.stoppedByRequest).toBe(true);
    expect(result.receipt.authoritative).toBe(true);
    expect(Number.isNaN(Date.parse(result.receipt.endedAtIso))).toBe(false);
    expect(calls[0]?.args).toEqual(['--abort', '--dir', runnerWorktreePath]);
  });

  it('reports still-running when abort exits non-zero and unknown on failure', async () => {
    const stillRunning = new ExecutionRunnerAdapter({
      runSubprocess: scriptedRunner([{ exitCode: 1, stdout: '', stderr: 'still running' }])
        .runner,
      remotePort: 4166,
    });
    const still = await stillRunning.stopSession({
      attemptId: 'att-1',
      sessionId: 'ses_a',
      worktreePath: runnerWorktreePath,
      gracePeriodSeconds: 30,
      runner: { kind: 'opencode', remotePort: 4166, host: null, agent: null, model: 'glm-5', variant: null },
    });
    expect(still).toEqual({ outcome: 'still-running', reason: 'still running' });

    const throwing = new ExecutionRunnerAdapter({
      runSubprocess: scriptedRunner([new Error('abort failed')]).runner,
      remotePort: 4166,
    });
    const thrown = await throwing.stopSession({
      attemptId: 'att-1',
      sessionId: 'ses_a',
      worktreePath: runnerWorktreePath,
      gracePeriodSeconds: 30,
      runner: { kind: 'opencode', remotePort: 4166, host: null, agent: null, model: 'glm-5', variant: null },
    });
    expect(thrown.outcome).toBe('unknown');
    if (thrown.outcome === 'unknown') {
      expect(thrown.reason).toContain('abort failed');
    }
  });

  it('parses a sessionID out of a multi-line NDJSON runner stream', async () => {
    const { runner } = scriptedRunner([
      {
        exitCode: 0,
        stdout: [
          '{"type":"system","subtype":"init","sessionID":"ses_stream"}',
          '{"type":"message","part":{"type":"text","text":"working"}}',
          '{"type":"message","part":{"sessionId":"ses_stream","text":"working"}}',
        ].join('\n'),
        stderr: '',
      },
    ]);
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner });
    const result = await adapter.startSession(makeStartRequest({ modelAssignment: { model: 'glm-5' } }));
    expect(result).toEqual({ outcome: 'started', sessionId: 'ses_stream' });
  });

  it('parses a sessionID carried only by a streamed part object', async () => {
    const { runner } = scriptedRunner([
      {
        exitCode: 0,
        stdout: [
          '{"type":"step-start"}',
          '{"type":"message","part":{"sessionID":"ses_part_only","text":"hello"}}',
        ].join('\r\n'),
        stderr: '',
      },
    ]);
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner });
    const result = await adapter.startSession(makeStartRequest({ modelAssignment: { model: 'glm-5' } }));
    expect(result).toEqual({ outcome: 'started', sessionId: 'ses_part_only' });
  });

  it('reads exit code 3 as an active session from ocm-run --status', async () => {
    const { runner } = scriptedRunner([
      { exitCode: 3, stdout: 'ocm-run: running in /tmp/fleet-test-worktree:\nses_abc', stderr: '' },
    ]);
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner, remotePort: 4166 });
    const status = await adapter.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_abc',
      worktreePath: runnerWorktreePath,
      runner: { kind: 'opencode', remotePort: 4166, host: null, agent: null, model: 'glm-5', variant: null },
    });
    expect(status).toEqual({
      runnerReachable: 'reachable',
      workspacePreparation: 'prepared',
      workerCommand: 'active',
      completionReceipt: null,
      artifactsCollected: false,
    });
  });

  it('reads an exit-0 "nothing is running" status line as ended', async () => {
    const { runner } = scriptedRunner([
      {
        exitCode: 0,
        stdout: 'ocm-run: nothing is running in /path (server: remote port 4166)',
        stderr: '',
      },
    ]);
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner, remotePort: 4166 });
    const status = await adapter.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_a',
      worktreePath: '/path',
      runner: { kind: 'opencode', remotePort: 4166, host: null, agent: null, model: 'glm-5', variant: null },
    });
    expect(status.workerCommand).toBe('ended');
    expect(status.runnerReachable).toBe('reachable');
    expect(status.completionReceipt?.attemptId).toBe('att-1');
  });

  it('resolves the status and abort directory from the recorded attempt', async () => {
    // A fresh adapter stands in for a later CLI process: nothing is cached in
    // memory, so the locator must come from the persisted attempt record.
    const recordedWorktree = '/mnt/pool/cloud-services/worktrees/att-1';
    const { runner, calls } = scriptedRunner([
      { exitCode: 3, stdout: 'ocm-run: running in /mnt/pool:\nses_a', stderr: '' },
      { exitCode: 0, stdout: 'aborted', stderr: '' },
    ]);
    const adapter = new ExecutionRunnerAdapter({
      runSubprocess: runner,
      remotePort: 4166,
      resolveWorktreePath: (attemptId) =>
        attemptId === 'att-1' ? recordedWorktree : null,
      resolveAttempt: (attemptId) =>
        attemptId === 'att-1'
          ? ({
              ...makeAttempt({ id: 'att-1', worktreePath: recordedWorktree }),
              runner: {
                kind: 'opencode',
                remotePort: 4166,
                host: null,
                agent: null,
                model: 'glm-5',
                variant: null,
              },
            } as AttemptRecord)
          : null,
    });
    const status = await adapter.inspectSession({ attemptId: 'att-1', sessionId: 'ses_a' });
    expect(status.workerCommand).toBe('active');
    expect(calls[0]?.args).toEqual(['--status', '--dir', recordedWorktree]);
    expect(calls[0]?.env).toEqual({ OCM_REMOTE_PORT: '4166' });

    const stopped = await adapter.stopSession({
      attemptId: 'att-1',
      sessionId: 'ses_a',
      gracePeriodSeconds: 30,
    });
    expect(stopped.outcome).toBe('terminated');
    expect(calls[1]?.args).toEqual(['--abort', '--dir', recordedWorktree]);
    expect(calls[1]?.env).toEqual({ OCM_REMOTE_PORT: '4166' });
  });

  it('refuses to inspect when the attempt records no worktree', async () => {
    const { runner, calls } = scriptedRunner([
      { exitCode: 3, stdout: 'ocm-run: running in /path:\nses_abc', stderr: '' },
    ]);
    const adapter = new ExecutionRunnerAdapter({
      runSubprocess: runner,
      remotePort: 4166,
      resolveWorktreePath: async () => null,
    });
    const status = await adapter.inspectSession({
      attemptId: 'att-missing',
      sessionId: 'ses_orphan',
      runner: { kind: 'opencode', remotePort: 4166, host: null, agent: null, model: 'glm-5', variant: null },
    });
    expect(status.runnerReachable).toBe('unknown');
    expect(calls).toHaveLength(0);
  });

  it('forwards a configured remoteHost as OCM_HOST alongside the remote port', async () => {
    const { runner, calls } = scriptedRunner([
      { exitCode: 0, stdout: '{"sessionID":"ses_hosted"}', stderr: '' },
    ]);
    const adapter = new ExecutionRunnerAdapter({
      runSubprocess: runner,
      remotePort: 4166,
      remoteHost: 'midnight.lan',
    });
    const result = await adapter.startSession(makeStartRequest({ modelAssignment: { model: 'glm-5' } }));
    expect(result).toEqual({
      outcome: 'started',
      sessionId: 'ses_hosted',
      runner: {
        kind: 'opencode',
        remotePort: 4166,
        host: 'midnight.lan',
        agent: null,
        model: 'glm-5',
        variant: null,
      },
    });
    expect(calls[0]?.env).toEqual({ OCM_REMOTE_PORT: '4166', OCM_HOST: 'midnight.lan' });
  });

  const repoRootBin = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../../bin/ocm-run',
  );

  it('runs the bundled bin/ocm-run --help successfully', async () => {
    const { stdout } = await execFileAsync(repoRootBin, ['--help']);
    expect(stdout).toContain('Usage: ocm-run');
  });

  it('rejects --attach from the caller with exit 2', async () => {
    await expect(
      execFileAsync(repoRootBin, ['--attach=bad'], {
        env: { ...process.env, OCM_PORT: '' },
      }),
    ).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('do not pass --attach') });
  });

  it('refuses --check on an unused port without OCM_HOST with exit 2', async () => {
    await expect(
      execFileAsync(repoRootBin, ['--check'], {
        env: {
          ...process.env,
          OCM_REMOTE_PORT: '65431',
          OCM_PORT: '',
          OCM_HOST: '',
        },
      }),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('OCM_HOST is not set'),
    });
  });
});
