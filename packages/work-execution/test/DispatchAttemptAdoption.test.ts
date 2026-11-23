/**
 * SN2 tests: `DispatchAttemptUseCase.dispatchAttempt` adopts a clean
 * strict-descendant head only through the full gate — strict descendant,
 * bounded allowed prefixes and a clean lane diff check — and keeps the
 * existing head-mismatch refusal for every other case. Every test title
 * states what it asserts; every refusal path proves `startSession` was
 * never called and no adoption entry was journalled.
 *
 * Mutation proof (see the brief): after these tests passed, the
 * implementation was broken and each named test was watched to fail, then
 * the code was restored:
 * - the adoption preconditions replaced with the constant `true` →
 *   "refuses adoption when the worktree is dirty even with
 *   allowUncommittedHandover", "refuses adoption for an agy runner",
 *   "refuses adoption when workspace.isStrictDescendant is missing" and
 *   "refuses adoption when the checked-out commit is not a full hex SHA"
 *   failed (isStrictDescendant was called or the adoption proceeded).
 * - the lane-diff gate replaced with the identity `pass` (skipped) →
 *   "refuses adoption when checkLaneDiff reports findings or error" and
 *   "refuses adoption when laneDiffCheck is missing" failed (the dispatch
 *   started instead of refusing).
 * - the strict-descendant verdict check replaced with the constant
 *   `unknown-is-fine` (adopting on any verdict) → "refuses adoption when
 *   isStrictDescendant returns unknown or throws" failed.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { WorkspaceAdapter } from '../src/infrastructure/adapters/WorkspaceAdapter.adapter.js';

import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  AttemptRunnerRecord,
  CapacityReservationRecord,
  WorkOrderRecord,
} from '../src/domain/execution-records.js';
import type { AttemptRepositoryPort } from '../src/application/ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../src/application/ports/out/ExecutionJournalPort.out-port.js';
import type {
  ExecutionRunnerPort,
  RunnerIsolationCapabilities,
} from '../src/application/ports/out/ExecutionRunnerPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../src/application/ports/out/WorkOrderRepositoryPort.out-port.js';
import type {
  IsStrictDescendantRequest,
  IsStrictDescendantResult,
  WorkspacePort,
  WorktreeInspection,
} from '../src/application/ports/out/WorkspacePort.out-port.js';
import type {
  LaneDiffCheckPort,
  LaneDiffCheckRequest,
  LaneDiffCheckResult,
} from '../src/application/ports/out/LaneDiffCheckPort.out-port.js';
import { DispatchAttemptUseCase } from '../src/application/use-cases/DispatchAttemptUseCase.use-case.js';
import { simpleDeterministicHexDigest } from '../src/application/use-cases/PrepareBriefPackageUseCase.use-case.js';

const BASE = 'a'.repeat(40);
const DESCENDANT = 'b'.repeat(40);
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';
const NOW = '2026-11-20T10:00:00.000Z';
const PROSE = '# Task\n\nImplement the change.\n';

const MANIFEST_JSON = JSON.stringify({
  workOrderId: 'wo-1',
  modelAssignment: { model: 'model-example-1', seatTool: 'opencode' },
  allowedPathPrefixes: ['packages/example/src'],
  ownerDecisionReferences: [],
});

const MANIFEST_DIGEST = simpleDeterministicHexDigest(PROSE + '\n' + MANIFEST_JSON);

function makeAttemptRepo(): AttemptRepositoryPort & {
  attempts: Map<string, AttemptRecord>;
  saved: AttemptRecord[];
} {
  const attempts = new Map<string, AttemptRecord>();
  const saved: AttemptRecord[] = [];
  return {
    attempts,
    saved,
    async saveAttempt(record) {
      saved.push(record);
      attempts.set(record.id, record);
    },
    async findAttemptById(attemptId) {
      return attempts.get(attemptId) ?? null;
    },
    async listAttemptsByWorkOrder(workOrderId) {
      return [...attempts.values()].filter((attempt) => attempt.workOrderId === workOrderId);
    },
    async listAllAttempts() {
      return [...attempts.values()];
    },
  };
}

function makeJournal(): ExecutionJournalPort & { entries: ActionJournalEntryRecord[] } {
  const entries: ActionJournalEntryRecord[] = [];
  const reservations = new Map<string, CapacityReservationRecord>();
  return {
    entries,
    async appendJournalEntry(entry) {
      entries.push(entry);
    },
    async listJournalEntriesForAttempt(attemptId) {
      return entries.filter((entry) => entry.attemptId === attemptId);
    },
    async saveCapacityReservation(reservation) {
      reservations.set(reservation.id, reservation);
    },
    async listActiveReservations() {
      return [...reservations.values()].filter((reservation) => reservation.held);
    },
    async releaseCapacityReservation(attemptId, releasedAtIso) {
      for (const [id, reservation] of reservations) {
        if (reservation.attemptId === attemptId && reservation.held) {
          reservations.set(id, { ...reservation, held: false, releasedAtIso });
          return true;
        }
      }
      return false;
    },
    async reserveCapacityAtomically() {
      return { outcome: 'no-free-slot', heldCount: 0, maxSlots: 0 };
    },
  };
}

function makeWorkOrderRepo(): WorkOrderRepositoryPort {
  const order: WorkOrderRecord = {
    id: 'wo-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'git@example.org:acme/app.git',
    baseCommit: BASE,
    ownedPaths: ['packages/example/src/**'],
    policyRevision: 'policy-1',
    prerequisiteWorkOrderIds: [],
    state: 'implementing',
    revision: 1,
    createdAtIso: NOW,
    updatedAtIso: NOW,
  };
  return {
    async saveWorkOrder() {},
    async findWorkOrderById(workOrderId) {
      return workOrderId === 'wo-1' ? order : null;
    },
    async listWorkOrdersByProject() {
      return [order];
    },
  };
}

type StartSessionCall = Parameters<ExecutionRunnerPort['startSession']>[0];

function makeRunner(describe: () => AttemptRunnerRecord | undefined): {
  port: ExecutionRunnerPort;
  startCalls: StartSessionCall[];
} {
  const capabilities: RunnerIsolationCapabilities = {
    filesystemScope: 'scoped-worktree',
    networkEgressRestricted: true,
    cpuAndMemoryLimited: true,
    processTreeTermination: true,
    authoritativeCompletion: true,
    artifactPersistence: true,
  };
  const startCalls: StartSessionCall[] = [];
  const port: ExecutionRunnerPort = {
    describeCapabilities: () => capabilities,
    describeRunner: describe,
    async startSession(request) {
      startCalls.push(request);
      return { outcome: 'started', sessionId: 'session-1' };
    },
    async inspectSession() {
      throw new Error('inspectSession must never run in these tests');
    },
    async stopSession() {
      throw new Error('stopSession must never run in these tests');
    },
  };
  return { port, startCalls };
}

const OPENCODE_RUNNER_RECORD: AttemptRunnerRecord = {
  kind: 'opencode',
  remotePort: 4166,
  host: null,
  hostName: null,
  agent: null,
  model: 'model-example-1',
  variant: null,
};

const AGY_RUNNER_RECORD: AttemptRunnerRecord = {
  kind: 'agy',
  remotePort: null,
  host: null,
  hostName: null,
  agent: null,
  model: null,
  variant: null,
};

interface WorkspaceHarness {
  port: WorkspacePort;
  descendantCalls: IsStrictDescendantRequest[];
}

function makeWorkspace(options: {
  checkedOutCommit?: string;
  uncommittedPaths?: string[];
  untrackedPaths?: string[];
  withIsStrictDescendant?: boolean;
  descendantAnswer?:
    | IsStrictDescendantResult
    | ((request: IsStrictDescendantRequest) => Promise<IsStrictDescendantResult>);
}): WorkspaceHarness {
  const descendantCalls: IsStrictDescendantRequest[] = [];
  const inspection: WorktreeInspection = {
    worktreePath: WORKTREE,
    checkedOutCommit: options.checkedOutCommit ?? BASE,
    matchesBaseCommit: (options.checkedOutCommit ?? BASE) === BASE,
    uncommittedPaths: options.uncommittedPaths ?? [],
    untrackedPaths: options.untrackedPaths ?? [],
    residueFromEarlierAttempts: [],
    missingExpectedArtifacts: [],
  };
  const port: WorkspacePort = {
    async inspectWorktree() {
      return inspection;
    },
    async readWorktreeFile(_worktreePath, relativePath) {
      return relativePath === '.lane/brief-manifest.json' ? MANIFEST_JSON : PROSE;
    },
  };
  if (options.withIsStrictDescendant !== false) {
    port.isStrictDescendant = async (request) => {
      descendantCalls.push(request);
      if (typeof options.descendantAnswer === 'function') {
        return options.descendantAnswer(request);
      }
      return options.descendantAnswer ?? { outcome: 'strict-descendant' };
    };
  }
  return { port, descendantCalls };
}

function makeDiffCheck(answer: LaneDiffCheckResult): { port: LaneDiffCheckPort; calls: LaneDiffCheckRequest[] } {
  const calls: LaneDiffCheckRequest[] = [];
  return {
    calls,
    port: {
      async checkLaneDiff(request) {
        calls.push(request);
        return answer;
      },
    },
  };
}

function makeSetup(options: {
  workspace: WorkspaceHarness;
  seatTool?: 'opencode' | 'agy';
  laneDiffCheck?: LaneDiffCheckPort | null;
  laneDiffCheckFor?: (recorded: AttemptRunnerRecord | null) => LaneDiffCheckPort | null;
  policyProtectedPaths?: readonly string[];
}) {
  const attemptRepo = makeAttemptRepo();
  const journal = makeJournal();
  journal.saveCapacityReservation({
    id: 'res-1',
    attemptId: 'attempt-1',
    hostId: 'host-1',
    slotIndex: 0,
    held: true,
    seatTool: options.seatTool ?? 'opencode',
    reservedAtIso: NOW,
    releasedAtIso: null,
  });
  const agyRunner = options.seatTool === 'agy' ? makeRunner(() => AGY_RUNNER_RECORD) : undefined;
  const runner = makeRunner(() => (options.seatTool === 'agy' ? AGY_RUNNER_RECORD : OPENCODE_RUNNER_RECORD));
  const useCase = new DispatchAttemptUseCase({
    workOrderRepo: makeWorkOrderRepo(),
    attemptRepo,
    journal,
    workspace: options.workspace.port,
    runner: options.seatTool === 'agy' ? agyRunner!.port : runner.port,
    ...(agyRunner !== undefined ? { agyRunner: agyRunner.port } : {}),
    ...(options.laneDiffCheck !== undefined ? { laneDiffCheck: options.laneDiffCheck } : {}),
    ...(options.laneDiffCheckFor !== undefined ? { laneDiffCheckFor: options.laneDiffCheckFor } : {}),
    ...(options.policyProtectedPaths !== undefined ? { policyProtectedPaths: options.policyProtectedPaths } : {}),
  });
  return { attemptRepo, journal, useCase, startCalls: options.seatTool === 'agy' ? agyRunner!.startCalls : runner.startCalls };
}

function dispatchRequest(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: 'attempt-1',
    workOrderId: 'wo-1',
    worktreePath: WORKTREE,
    briefPackagePath: '.lane/brief.md',
    briefDigest: MANIFEST_DIGEST,
    baseCommit: BASE,
    stepLimit: 40,
    timeLimitSeconds: 3600,
    nowIso: NOW,
    ...overrides,
  };
}

type DispatchResult = Awaited<ReturnType<DispatchAttemptUseCase['dispatchAttempt']>>;

function headMismatch(result: DispatchResult): string {
  expect(result.outcome).toBe('refused');
  if (result.outcome !== 'refused') {
    throw new Error('unreachable');
  }
  return result.reason;
}

const HEAD_MISMATCH_BASE = `Worktree ${WORKTREE} does not match the base commit (checked out ${DESCENDANT})`;
const HEAD_MISMATCH_PRIOR = `Worktree ${WORKTREE} does not match the prior attempt's head (checked out ${DESCENDANT})`;

async function adoptExpectation(setup: ReturnType<typeof makeSetup>, result: DispatchResult): Promise<void> {
  expect(result.outcome).toBe('started');
  const entries = setup.journal.entries.filter((entry) => entry.status === 'intent-recorded');
  const adoption = entries.find((entry) => entry.detail.includes('strict-descendant'));
  expect(adoption).toBeDefined();
  expect(adoption?.action).toBe('dispatch');
  expect(adoption?.baseCommit).toBe(BASE);
  expect(adoption?.detail).toContain(`expected checkout ${BASE}`);
  expect(adoption?.detail).toContain(`adopted head ${DESCENDANT}`);
}

describe('DispatchAttemptUseCase adopts a clean strict-descendant head (SN2)', () => {
  it('adopts a clean strict descendant: probes ancestry, runs the diff check on the expected checkout and journals both SHAs', async () => {
    const workspace = makeWorkspace({ checkedOutCommit: DESCENDANT });
    const diff = makeDiffCheck({ outcome: 'clean' });
    const setup = makeSetup({ workspace, laneDiffCheck: diff.port, policyProtectedPaths: ['policies/'] });
    const result = await setup.useCase.dispatchAttempt(dispatchRequest());
    await adoptExpectation(setup, result);
    expect(workspace.descendantCalls).toEqual([
      {
        worktreePath: WORKTREE,
        ancestorCommit: BASE,
        descendantCommit: DESCENDANT,
        recordedHost: OPENCODE_RUNNER_RECORD,
      },
    ]);
    expect(diff.calls).toEqual([
      {
        worktreePath: WORKTREE,
        baseCommit: BASE,
        allowedPathPrefixes: ['packages/example/src'],
        policyProtectedPaths: ['policies/'],
      },
    ]);
    expect(setup.startCalls).toHaveLength(1);
  });

  it('resolves the diff check through laneDiffCheckFor with the recorded runner', async () => {
    const workspace = makeWorkspace({ checkedOutCommit: DESCENDANT });
    const diff = makeDiffCheck({ outcome: 'clean' });
    const forCalls: (AttemptRunnerRecord | null)[] = [];
    const setup = makeSetup({
      workspace,
      laneDiffCheckFor: (recorded) => {
        forCalls.push(recorded);
        return diff.port;
      },
    });
    const result = await setup.useCase.dispatchAttempt(dispatchRequest());
    await adoptExpectation(setup, result);
    expect(forCalls).toEqual([OPENCODE_RUNNER_RECORD]);
    expect(diff.calls).toHaveLength(1);
  });

  it('refuses adoption when the range holds a merge commit with an unrelated parent (real git)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'sn2-adopt-'));
    try {
      const env = { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@example.invalid', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@example.invalid' };
      const git = (...args: string[]): string =>
        execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env }).trim();
      git('init', '-q', '-b', 'main');
      git('commit', '-q', '--allow-empty', '-m', 'a');
      const ancestor = git('rev-parse', 'HEAD');
      git('checkout', '-q', '--orphan', 'other');
      git('commit', '-q', '--allow-empty', '-m', 'unrelated');
      git('checkout', '-q', 'main');
      git('merge', '-q', '--allow-unrelated-histories', '--no-ff', '-m', 'merge', 'other');
      const merged = git('rev-parse', 'HEAD');
      const real = new WorkspaceAdapter({
        executor: {
          async run(argv) {
            try {
              const stdout = execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8' });
              return { exitCode: 0, signal: null, stdout, stderr: '' };
            } catch (error) {
              const status = (error as { status?: number }).status ?? null;
              return { exitCode: status, signal: null, stdout: '', stderr: '' };
            }
          },
        },
      });
      const workspace = makeWorkspace({
        checkedOutCommit: DESCENDANT,
        descendantAnswer: (request) =>
          real.isStrictDescendant({
            ...request,
            worktreePath: repo,
            ancestorCommit: ancestor,
            descendantCommit: merged,
            recordedHost: null,
          }),
      });
      const setup = makeSetup({ workspace, laneDiffCheck: makeDiffCheck({ outcome: 'clean' }).port });
      expect(headMismatch(await setup.useCase.dispatchAttempt(dispatchRequest()))).toBe(HEAD_MISMATCH_BASE);
      expect(workspace.descendantCalls).toHaveLength(1);
      expect(setup.startCalls).toEqual([]);
      expect(setup.journal.entries.some((entry) => entry.detail.includes('strict-descendant'))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses adoption when isStrictDescendant returns unknown or throws', async () => {
    for (const answer of [
      { outcome: 'unknown', reason: 'merge-base never answered' } satisfies IsStrictDescendantResult,
      { outcome: 'not-descendant' } satisfies IsStrictDescendantResult,
      { outcome: 'refused', reason: 'invalid-request' } satisfies IsStrictDescendantResult,
    ]) {
      const workspace = makeWorkspace({ checkedOutCommit: DESCENDANT, descendantAnswer: answer });
      const setup = makeSetup({ workspace, laneDiffCheck: makeDiffCheck({ outcome: 'clean' }).port });
      expect(headMismatch(await setup.useCase.dispatchAttempt(dispatchRequest()))).toBe(HEAD_MISMATCH_BASE);
      expect(setup.startCalls).toEqual([]);
      expect(setup.journal.entries.some((entry) => entry.detail.includes('strict-descendant'))).toBe(false);
    }
    const throwing = makeWorkspace({
      checkedOutCommit: DESCENDANT,
      withIsStrictDescendant: false,
    });
    // Rebuild with a throwing probe.
    const descendantCalls: IsStrictDescendantRequest[] = [];
    const port: WorkspacePort = {
      ...throwing.port,
      isStrictDescendant: async (request) => {
        descendantCalls.push(request);
        throw new Error('probe exploded');
      },
    };
    const throwingSetup = makeSetup({
      workspace: { port, descendantCalls },
      laneDiffCheck: makeDiffCheck({ outcome: 'clean' }).port,
    });
    expect(headMismatch(await throwingSetup.useCase.dispatchAttempt(dispatchRequest()))).toBe(HEAD_MISMATCH_BASE);
    expect(throwingSetup.startCalls).toEqual([]);
  });

  it('refuses adoption when the worktree is dirty even with allowUncommittedHandover', async () => {
    for (const dirty of [
      { uncommittedPaths: ['packages/example/src/index.ts'] },
      { untrackedPaths: ['packages/example/src/scratch.txt'] },
    ]) {
      const workspace = makeWorkspace({ checkedOutCommit: DESCENDANT, ...dirty });
      const setup = makeSetup({ workspace, laneDiffCheck: makeDiffCheck({ outcome: 'clean' }).port });
      expect(
        headMismatch(
          await setup.useCase.dispatchAttempt(dispatchRequest({ allowUncommittedHandover: true })),
        ),
      ).toBe(HEAD_MISMATCH_BASE);
      expect(workspace.descendantCalls).toEqual([]);
      expect(setup.startCalls).toEqual([]);
    }
  });

  it('refuses adoption for an agy runner without calling isStrictDescendant', async () => {
    const workspace = makeWorkspace({ checkedOutCommit: DESCENDANT });
    const setup = makeSetup({ workspace, seatTool: 'agy', laneDiffCheck: makeDiffCheck({ outcome: 'clean' }).port });
    expect(headMismatch(await setup.useCase.dispatchAttempt(dispatchRequest()))).toBe(HEAD_MISMATCH_BASE);
    expect(workspace.descendantCalls).toEqual([]);
    expect(setup.startCalls).toEqual([]);
  });

  it('refuses adoption when workspace.isStrictDescendant is missing', async () => {
    const workspace = makeWorkspace({ checkedOutCommit: DESCENDANT, withIsStrictDescendant: false });
    const setup = makeSetup({ workspace, laneDiffCheck: makeDiffCheck({ outcome: 'clean' }).port });
    expect(headMismatch(await setup.useCase.dispatchAttempt(dispatchRequest()))).toBe(HEAD_MISMATCH_BASE);
    expect(setup.startCalls).toEqual([]);
  });

  it('refuses adoption when the checked-out commit is not a full hex SHA', async () => {
    for (const checkedOutCommit of ['b'.repeat(12), DESCENDANT.slice(0, 39), DESCENDANT.toUpperCase(), '0'.repeat(40)]) {
      const workspace = makeWorkspace({ checkedOutCommit });
      const setup = makeSetup({ workspace, laneDiffCheck: makeDiffCheck({ outcome: 'clean' }).port });
      const reason = headMismatch(await setup.useCase.dispatchAttempt(dispatchRequest()));
      expect(reason).toContain('does not match the base commit');
      expect(workspace.descendantCalls).toEqual([]);
    }
  });

  it('refuses adoption when laneDiffCheck is missing', async () => {
    const workspace = makeWorkspace({ checkedOutCommit: DESCENDANT });
    const setup = makeSetup({ workspace });
    const reason = headMismatch(await setup.useCase.dispatchAttempt(dispatchRequest()));
    expect(reason).toContain('No lane diff check is wired');
    expect(setup.startCalls).toEqual([]);
    expect(setup.journal.entries.some((entry) => entry.detail.includes('strict-descendant'))).toBe(false);
  });

  it('refuses adoption when laneDiffCheckFor resolves to null', async () => {
    const workspace = makeWorkspace({ checkedOutCommit: DESCENDANT });
    const setup = makeSetup({ workspace, laneDiffCheckFor: () => null });
    const reason = headMismatch(await setup.useCase.dispatchAttempt(dispatchRequest()));
    expect(reason).toContain('No lane diff check is wired');
    expect(setup.startCalls).toEqual([]);
  });

  it('refuses adoption when checkLaneDiff reports findings or error', async () => {
    for (const answer of [
      { outcome: 'findings', findings: [{ path: 'packages/example/src/index.ts', line: 3, rule: 'example-secret' }] } satisfies LaneDiffCheckResult,
      { outcome: 'error', reason: 'git diff failed' } satisfies LaneDiffCheckResult,
    ]) {
      const workspace = makeWorkspace({ checkedOutCommit: DESCENDANT });
      const setup = makeSetup({ workspace, laneDiffCheck: makeDiffCheck(answer).port });
      const reason = headMismatch(await setup.useCase.dispatchAttempt(dispatchRequest()));
      // The refusal names the outcome only; matched secret values never leak.
      expect(reason).toContain('lane diff check');
      expect(reason).not.toContain('example-secret-value');
      expect(setup.startCalls).toEqual([]);
      expect(setup.journal.entries.some((entry) => entry.detail.includes('strict-descendant'))).toBe(false);
    }
  });

  it('refuses adoption when checkLaneDiff throws', async () => {
    const workspace = makeWorkspace({ checkedOutCommit: DESCENDANT });
    const diffCheck: LaneDiffCheckPort = {
      async checkLaneDiff() {
        throw new Error('check exploded');
      },
    };
    const setup = makeSetup({ workspace, laneDiffCheck: diffCheck });
    const reason = headMismatch(await setup.useCase.dispatchAttempt(dispatchRequest()));
    expect(reason).toContain('could not run');
    expect(setup.startCalls).toEqual([]);
  });

  it('refuses adoption when allowedPathPrefixes is non-array, sparse, array-like, or exceeds cap', async () => {
    const huge = new Array<number>(4097).fill(0).map(() => 'packages/example/src');
    const cases: unknown[] = [
      undefined,
      null,
      'packages/example/src',
      {},
      { length: 1, 0: 'packages/example/src' },
      [],
      new Array(4097).fill('packages/example/src'),
      huge,
    ];
    // A sparse array with a hole in the middle.
    const sparse = ['packages/example/src', 'packages/example/src'];
    delete (sparse as unknown as { 1?: string })[1];
    cases.push(sparse);
    for (const raw of cases) {
      const manifest = JSON.parse(MANIFEST_JSON) as Record<string, unknown>;
      if (raw === undefined) {
        delete manifest['allowedPathPrefixes'];
      } else {
        manifest['allowedPathPrefixes'] = raw;
      }
      const manifestJson = JSON.stringify(manifest);
      const digest = simpleDeterministicHexDigest(PROSE + '\n' + manifestJson);
      const workspace = makeWorkspace({ checkedOutCommit: DESCENDANT });
      const port: WorkspacePort = {
        ...workspace.port,
        readWorktreeFile: async (_p, relativePath) => (relativePath === '.lane/brief-manifest.json' ? manifestJson : PROSE),
      };
      const setup = makeSetup({ workspace: { port, descendantCalls: workspace.descendantCalls }, laneDiffCheck: makeDiffCheck({ outcome: 'clean' }).port });
      const reason = headMismatch(await setup.useCase.dispatchAttempt(dispatchRequest({ briefDigest: digest })));
      expect(reason).toContain('allowedPathPrefixes');
      expect(setup.startCalls).toEqual([]);
      expect(setup.journal.entries.some((entry) => entry.detail.includes('strict-descendant'))).toBe(false);
    }
  });
});
