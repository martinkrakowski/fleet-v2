/**
 * Unit tests for lane AG-4: the edit-only commit step
 * (`CommitEditOnlyAttemptUseCase`). Fixtures are copied from
 * `seat-plan-dispatch.test.ts` (fakes only: no git, no network, no runner).
 */

import { describe, expect, it } from 'vitest';

import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  AttemptRunnerRecord,
} from '../../../domain/execution-records.js';
import type { AttemptArtifactPort } from '../../ports/out/AttemptArtifactPort.out-port.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../../ports/out/ExecutionJournalPort.out-port.js';
import type {
  CommitLaneOutputRequest,
  CommitLaneOutputResult,
  WorkspacePort,
} from '../../ports/out/WorkspacePort.out-port.js';
import type { CommandExecutorPort } from '../../ports/out/CommandExecutorPort.out-port.js';
import { WorkspaceAdapter } from '../../../infrastructure/adapters/WorkspaceAdapter.adapter.js';
import type {
  LaneDiffCheckPort,
  LaneDiffCheckRequest,
  LaneDiffCheckResult,
} from '../../ports/out/LaneDiffCheckPort.out-port.js';
import type { LaneDiffFinding } from '../../../domain/lane-diff-check.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';
import { CommitEditOnlyAttemptUseCase } from '../CommitEditOnlyAttemptUseCase.use-case.js';
import { readBoundedDenseArray } from '../../../domain/plain-record-reads.js';

// ---------------------------------------------------------------------------
// Fakes (copied from seat-plan-dispatch.test.ts)
// ---------------------------------------------------------------------------

function makeAttemptRepo(): AttemptRepositoryPort & { attempts: Map<string, AttemptRecord> } {
  const attempts = new Map<string, AttemptRecord>();
  return {
    attempts,
    async saveAttempt(record) {
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
  return {
    entries,
    async appendJournalEntry(entry: ActionJournalEntryRecord) {
      entries.push(entry);
    },
    async listJournalEntriesForAttempt(attemptId: string) {
      return entries.filter((entry) => entry.attemptId === attemptId);
    },
  } as unknown as ExecutionJournalPort & { entries: ActionJournalEntryRecord[] };
}

type CommitCall = CommitLaneOutputRequest & { outcomeToReturn?: CommitLaneOutputResult };

type InspectWorktreeRequest = Parameters<WorkspacePort['inspectWorktree']>[0];

function makeWorkspace(
  outcome: CommitLaneOutputResult = { outcome: 'committed', headCommit: HEAD, branchRef: 'refs/heads/lane' },
  inspectWorktree?: ((request: InspectWorktreeRequest) => unknown) | 'missing',
) {
  const calls: CommitCall[] = [];
  const inspectionRequests: InspectWorktreeRequest[] = [];
  const workspace = {
    async inspectWorktree(request: InspectWorktreeRequest): Promise<unknown> {
      inspectionRequests.push(request);
      if (typeof inspectWorktree === 'function') {
        return inspectWorktree(request);
      }
      throw new Error('not used');
    },
    async commitLaneOutput(request: CommitLaneOutputRequest): Promise<CommitLaneOutputResult> {
      calls.push(request);
      return outcome;
    },
  };
  const narrowed: Pick<WorkspacePort, 'commitLaneOutput'> &
    Partial<Pick<WorkspacePort, 'inspectWorktree'>> =
    inspectWorktree === 'missing'
      ? { commitLaneOutput: workspace.commitLaneOutput }
      : {
          commitLaneOutput: workspace.commitLaneOutput,
          inspectWorktree: workspace.inspectWorktree as unknown as WorkspacePort['inspectWorktree'],
        };
  return { workspace: narrowed, calls, inspectionRequests };
}

const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const PRIOR_HEAD = '0f9e8d7c6b5a4938273615f4e3d2c1b0a9988776';

function briefFiles(manifest: Record<string, unknown>) {
  const prose = '# Frozen brief prose';
  const manifestRaw = JSON.stringify(manifest);
  return { prose, manifestRaw, digest: simpleDeterministicHexDigest(prose + '\n' + manifestRaw) };
}

function frozenManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    allowedPathPrefixes: ['packages/example/'],
    ...overrides,
  };
}

function runnerRecord(overrides: Partial<AttemptRunnerRecord> = {}): AttemptRunnerRecord {
  return {
    kind: 'agy',
    remotePort: null,
    host: null,
    hostName: 'lane-host',
    agent: 'agy-agent',
    model: 'gemini-example-high',
    variant: null,
    ...overrides,
  };
}

function endedAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-1',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/lanes/attempt-1',
    baseCommit: HEAD,
    state: 'ended',
    outcome: null,
    briefDigest: null,
    briefPackagePath: '.lane/brief.md',
    sessionId: 'session-1',
    completionReceipt: {
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      endedAtIso: '2026-10-15T09:00:00.000Z',
      authoritative: true,
      exitStatus: 0,
      stoppedByRequest: false,
    },
    artifacts: null,
    runner: runnerRecord(),
    createdAtIso: '2026-10-15T08:00:00.000Z',
    updatedAtIso: '2026-10-15T08:00:00.000Z',
    ...overrides,
  };
}

interface LaneSetup {
  useCase: CommitEditOnlyAttemptUseCase;
  repo: ReturnType<typeof makeAttemptRepo>;
  journal: ReturnType<typeof makeJournal>;
  commits: CommitCall[];
  inspectionRequests: InspectWorktreeRequest[];
  diffRequests: LaneDiffCheckRequest[];
  setDiffOutcome: (outcome: LaneDiffCheckResult) => void;
}

function makeLane(options: {
  attempt?: AttemptRecord;
  brief?: { prose: string; manifestRaw: string; digest: string };
  briefMissing?: 'prose' | 'manifest';
  editOnlyMode?: 'edit-only' | 'not-edit-only' | 'unknown';
  diffCheckAvailable?: boolean;
  initialDiffOutcome?: LaneDiffCheckResult;
  workspaceOutcome?: CommitLaneOutputResult;
  inspectWorktree?: ((request: InspectWorktreeRequest) => unknown) | 'missing';
} = {}): LaneSetup {
  const repo = makeAttemptRepo();
  const journal = makeJournal();
  const { workspace, calls, inspectionRequests } = makeWorkspace(options.workspaceOutcome, options.inspectWorktree);
  const diffRequests: LaneDiffCheckRequest[] = [];
  let diffOutcome: LaneDiffCheckResult =
    options.initialDiffOutcome ?? { outcome: 'clean' };
  const diffPort: LaneDiffCheckPort = {
    async checkLaneDiff(request) {
      diffRequests.push(request);
      return diffOutcome;
    },
  };
  const brief = options.brief ?? briefFiles(frozenManifest());
  const artifactPort: Pick<AttemptArtifactPort, 'readBriefManifest' | 'readBriefFile'> = {
    async readBriefManifest(_worktreePath, manifestPath) {
      if (manifestPath === undefined || !manifestPath.endsWith('-manifest.json')) return null;
      return options.briefMissing === 'manifest' ? null : brief.manifestRaw;
    },
    async readBriefFile(_worktreePath, relativePath) {
      if (relativePath !== '.lane/brief.md') return null;
      return options.briefMissing === 'prose' ? null : brief.prose;
    },
  };
  const attempt =
    options.attempt ??
    endedAttempt({ briefDigest: brief.digest });
  repo.attempts.set(attempt.id, attempt);
  if (attempt.priorAttemptId) {
    repo.attempts.set(attempt.priorAttemptId, {
      ...endedAttempt({
        id: attempt.priorAttemptId,
        artifacts: {
          headCommit: PRIOR_HEAD,
          commitsSinceBase: [],
          collectedArtifactPaths: [],
          notes: 'present',
        },
      }),
      state: 'collected',
      completionReceipt: null,
    });
  }
  const useCase = new CommitEditOnlyAttemptUseCase({
    attemptRepo: repo,
    journal,
    workspace,
    artifactPort,
    laneDiffCheckFor: options.diffCheckAvailable === false
      ? () => null
      : () => diffPort,
    editOnlyModeOf: () => options.editOnlyMode ?? 'edit-only',
  });
  return {
    useCase,
    repo,
    journal,
    commits: calls,
    inspectionRequests,
    diffRequests,
    setDiffOutcome: (outcome) => {
      diffOutcome = outcome;
    },
  };
}

const FINDINGS: readonly LaneDiffFinding[] = [
  { path: 'packages/example/secret.txt', line: 3, rule: 'secret-shape' },
];

// --- SN1 hostile-input helpers -------------------------------------------------

/** A plain-data inspection snapshot as the workspace adapter would report it. */
const inspectionRaw: Record<string, unknown> = {
  worktreePath: '/lanes/attempt-1',
  checkedOutCommit: HEAD,
  matchesBaseCommit: true,
  uncommittedPaths: [],
  untrackedPaths: [],
  residueFromEarlierAttempts: [],
  missingExpectedArtifacts: [],
};

function inspection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...inspectionRaw, ...overrides };
}

/** A genuine array with a hole (ownKeys != length + 1), never iterated by the reader. */
function sparsePathArray(): unknown[] {
  const array: unknown[] = new Array(2);
  array[0] = 'packages/example/a.ts';
  return array;
}

/** A genuine array whose length claims more than the cap allows. */
function enormousPathArray(): unknown[] {
  const array: unknown[] = ['packages/example/a.ts'];
  Object.defineProperty(array, 'length', { value: 2 ** 32 - 2 });
  return array;
}

/** A plain object carrying an own enumerable `__proto__` data key. */
function recordWithProtoKey(): Record<string, unknown> {
  const record = inspection({ uncommittedPaths: ['packages/example/a.ts'] });
  Object.defineProperty(record, '__proto__', { value: { inject: true }, enumerable: true });
  return record;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CommitEditOnlyAttemptUseCase', () => {
  it('commits an ended edit-only attempt: committed, expectedHead is the base commit, one collect/completed entry', async () => {
    const lane = makeLane();
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result).toEqual({
      outcome: 'committed',
      headCommit: HEAD,
      alreadyCommitted: false,
    });
    expect(lane.commits).toHaveLength(1);
    expect(lane.commits[0]!.expectedHead).toBe(HEAD);
    expect(lane.commits[0]!.attemptId).toBe('attempt-1');
    expect(lane.commits[0]!.implementerModel).toBe('gemini-example-high');
    const entries = lane.journal.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe('collect');
    expect(entries[0]!.status).toBe('completed');
  });

  it('a fix attempt commits with the prior attempt head as expectedHead', async () => {
    const attempt = endedAttempt({
      id: 'attempt-2',
      kind: 'fix',
      fixNumber: 1,
      priorAttemptId: 'attempt-1',
      briefDigest: briefFiles(frozenManifest()).digest,
    });
    const lane = makeLane({ attempt });
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-2' });
    expect(result.outcome).toBe('committed');
    expect(lane.commits[0]!.expectedHead).toBe(PRIOR_HEAD);
  });

  it('edit-only commits without ever inspecting the worktree', async () => {
    const lane = makeLane();
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result.outcome).toBe('committed');
    expect(lane.inspectionRequests).toHaveLength(0);
  });

  it('not-edit-only with a clean worktree at the dispatch head is not-applicable: inspected once, no commit, no diff, no journal', async () => {
    const lane = makeLane({
      editOnlyMode: 'not-edit-only',
      inspectWorktree: () => inspection(),
    });
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result).toEqual({ outcome: 'not-applicable' });
    expect(lane.inspectionRequests).toHaveLength(1);
    expect(lane.inspectionRequests[0]!.worktreePath).toBe('/lanes/attempt-1');
    expect(lane.inspectionRequests[0]!.baseCommit).toBe(HEAD);
    expect(lane.inspectionRequests[0]!.expectedArtifactPaths).toEqual([]);
    expect(lane.inspectionRequests[0]!.recordedHost).toEqual(runnerRecord());
    expect(lane.commits).toHaveLength(0);
    expect(lane.journal.entries).toHaveLength(0);
    expect(lane.diffRequests).toHaveLength(0);
  });

  it('not-edit-only with a moved head is not-applicable', async () => {
    const lane = makeLane({
      editOnlyMode: 'not-edit-only',
      inspectWorktree: () => inspection({ checkedOutCommit: PRIOR_HEAD }),
    });
    expect(await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' })).toEqual({ outcome: 'not-applicable' });
    expect(lane.commits).toHaveLength(0);
  });

  it('not-edit-only dirty at the dispatch head commits through the same steps', async () => {
    const lane = makeLane({
      editOnlyMode: 'not-edit-only',
      inspectWorktree: () => inspection({ uncommittedPaths: ['packages/example/a.ts'] }),
    });
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result).toEqual({ outcome: 'committed', headCommit: HEAD, alreadyCommitted: false });
    expect(lane.commits).toHaveLength(1);
    expect(lane.commits[0]!.expectedHead).toBe(HEAD);
    expect(lane.journal.entries).toHaveLength(1);
    expect(lane.journal.entries[0]!.status).toBe('completed');
  });

  it('an adopted head is the expected head: output left dirty after adoption is committed through the same scan path (SN2)', async () => {
    const ADOPTED = '9'.repeat(40);
    const lane = makeLane({
      editOnlyMode: 'not-edit-only',
      attempt: endedAttempt({
        briefDigest: briefFiles(frozenManifest()).digest,
        adoptedHeadCommit: ADOPTED,
      }),
      inspectWorktree: () => inspection({ checkedOutCommit: ADOPTED, uncommittedPaths: ['packages/example/a.ts'] }),
    });
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result).toEqual({ outcome: 'committed', headCommit: HEAD, alreadyCommitted: false });
    expect(lane.inspectionRequests[0]!.baseCommit).toBe(ADOPTED);
    expect(lane.commits).toHaveLength(1);
    expect(lane.commits[0]!.expectedHead).toBe(ADOPTED);
    // The diff check ran before the commit, with the same frozen prefixes.
    expect(lane.diffRequests.length).toBeGreaterThan(0);
    expect(lane.diffRequests[0]!.allowedPathPrefixes).toEqual(['packages/example/']);
  });

  it('an adopted head with a secret-shaped dirty file is refused diff-findings and nothing is committed or removed (SN2)', async () => {
    const ADOPTED = '9'.repeat(40);
    const lane = makeLane({
      editOnlyMode: 'not-edit-only',
      attempt: endedAttempt({
        briefDigest: briefFiles(frozenManifest()).digest,
        adoptedHeadCommit: ADOPTED,
      }),
      initialDiffOutcome: { outcome: 'findings', findings: FINDINGS },
      inspectWorktree: () => inspection({ checkedOutCommit: ADOPTED, untrackedPaths: ['packages/example/secret.txt'] }),
    });
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'diff-findings' });
    expect(lane.commits).toHaveLength(0);
    expect(lane.journal.entries.map((entry) => entry.status)).toEqual(['refused']);
  });

  it('without a recorded adoption a head that is not the dispatch head stays not-applicable (SN2 contrast)', async () => {
    const lane = makeLane({
      editOnlyMode: 'not-edit-only',
      inspectWorktree: () => inspection({ checkedOutCommit: '9'.repeat(40), uncommittedPaths: ['packages/example/a.ts'] }),
    });
    expect(await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' })).toEqual({ outcome: 'not-applicable' });
    expect(lane.commits).toHaveLength(0);
  });

  it('not-edit-only with only untracked files commits too', async () => {
    const lane = makeLane({
      editOnlyMode: 'not-edit-only',
      inspectWorktree: () => inspection({ untrackedPaths: ['packages/example/new.txt'] }),
    });
    expect(await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' })).toMatchObject({ outcome: 'committed' });
    expect(lane.commits).toHaveLength(1);
  });

  it('not-edit-only without a workspace inspectWorktree is unknown and nothing else runs', async () => {
    const lane = makeLane({ editOnlyMode: 'not-edit-only', inspectWorktree: 'missing' });
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result).toEqual({ outcome: 'unknown', reason: 'the workspace cannot inspect the worktree' });
    expect(lane.commits).toHaveLength(0);
    expect(lane.journal.entries).toHaveLength(0);
    expect(lane.diffRequests).toHaveLength(0);
  });

  it('not-edit-only with a throwing inspectWorktree is unknown', async () => {
    const lane = makeLane({
      editOnlyMode: 'not-edit-only',
      inspectWorktree: () => {
        throw new Error('boom');
      },
    });
    expect(await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' })).toEqual({
      outcome: 'unknown',
      reason: 'inspecting the worktree failed',
    });
    expect(lane.commits).toHaveLength(0);
  });

  // Hostile inspection inputs: every malformed shape is `unknown`, never a
  // pass, and no getter ever runs (the snapshot reads property descriptors).
  it.each([
    ['null', null],
    ['a number', 42],
    ['a getter for checkedOutCommit', { ...inspectionRaw, get checkedOutCommit() { return HEAD; } }],
    ['a missing checkedOutCommit', { worktreePath: '/lanes/attempt-1', uncommittedPaths: [], untrackedPaths: [] }],
    ['a sparse uncommittedPaths', sparsePathArray()],
    ['an array-like uncommittedPaths', { length: 1, 0: 'a' }],
    ['an enormous uncommittedPaths length', enormousPathArray()],
    ['a wrong-primitive element', inspection({ uncommittedPaths: [42] })],
    ['an empty-string element', inspection({ untrackedPaths: [''] })],
    ['an own __proto__ key', recordWithProtoKey()],
  ])('not-edit-only refuses a hostile inspection (%s) as malformed unknown', async (_label, value) => {
    const lane = makeLane({ editOnlyMode: 'not-edit-only', inspectWorktree: () => value });
    expect(await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' })).toEqual({
      outcome: 'unknown',
      reason: 'worktree inspection was malformed',
    });
    expect(lane.commits).toHaveLength(0);
    expect(lane.journal.entries).toHaveLength(0);
  });

  it('an unknown mode is unknown and nothing was called', async () => {
    const lane = makeLane({ editOnlyMode: 'unknown' });
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result.outcome).toBe('unknown');
    expect(lane.commits).toHaveLength(0);
    expect(lane.journal.entries).toHaveLength(0);
    expect(lane.diffRequests).toHaveLength(0);
  });

  it('a running attempt and a non-authoritative receipt are refused not-ended', async () => {
    const running = makeLane({
      attempt: endedAttempt({ briefDigest: briefFiles(frozenManifest()).digest, state: 'running' }),
    });
    expect((await running.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' })).outcome).toBe(
      'refused',
    );
    const unauth = makeLane({
      attempt: endedAttempt({
        briefDigest: briefFiles(frozenManifest()).digest,
        completionReceipt: {
          attemptId: 'attempt-1',
          sessionId: 'session-1',
          endedAtIso: '2026-10-15T09:00:00.000Z',
          authoritative: false,
          exitStatus: 1,
          stoppedByRequest: false,
        },
      }),
    });
    const result = await unauth.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'not-ended' });
  });

  it('a missing frozen brief prose file is unknown, never a refusal or a pass', async () => {
    const lane = makeLane({ briefMissing: 'prose' });
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result.outcome).toBe('unknown');
    expect(lane.commits).toHaveLength(0);
    expect(lane.journal.entries).toHaveLength(0);
  });

  it('a missing frozen brief manifest is unknown, never a refusal or a pass', async () => {
    const lane = makeLane({ briefMissing: 'manifest' });
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result.outcome).toBe('unknown');
    expect(lane.commits).toHaveLength(0);
  });

  it('a changed prose is refused brief-changed and nothing was committed', async () => {
    const good = briefFiles(frozenManifest());
    const lane = makeLane({
      attempt: endedAttempt({ briefDigest: good.digest }),
      brief: { prose: '# Changed prose', manifestRaw: good.manifestRaw, digest: good.digest },
    });
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'brief-changed' });
    expect(lane.commits).toHaveLength(0);
  });

  it('a manifest without allowedPathPrefixes is refused no-allowed-prefixes', async () => {
    const bad = briefFiles(frozenManifest({ allowedPathPrefixes: [] }));
    const lane = makeLane({
      attempt: endedAttempt({ briefDigest: bad.digest }),
      brief: bad,
    });
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'no-allowed-prefixes' });
  });

  it('a manifest whose allowedPathPrefixes contains a hole is refused, not skipped', async () => {
    // A sparse array's hole is skipped by `.every()`, so the old check passed
    // a manifest with a missing prefix. JSON has no holes (a hole serializes
    // to `null`, covered by the null-element assertion below), so the hole
    // itself is proved directly on the bounded dense reader the use case now
    // uses: it refuses a genuine sparse array in O(cap), cap 4096, never
    // invoking a getter.
    const sparse: string[] = ['packages/example/', 'packages/other/'];
    delete sparse[1];
    expect(readBoundedDenseArray(sparse, 4096)).toBeNull();
    // The JSON shape of that same hole — a `null` element — is refused by the
    // use case as `no-allowed-prefixes` and the workspace is never called.
    const withNull = briefFiles({ allowedPathPrefixes: ['packages/example/', null] });
    const lane = makeLane({
      attempt: endedAttempt({ briefDigest: withNull.digest }),
      brief: withNull,
    });
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'no-allowed-prefixes' });
    expect(lane.commits).toHaveLength(0);
  });

  it('a manifest whose allowedPathPrefixes exceeds the cap is refused no-allowed-prefixes, not traversed unbounded', async () => {
    // 4097 dense prefixes is one past PREFIX_CAP (4096): the bounded dense
    // read refuses the length in O(1) before any element is touched, while an
    // uncapped `.every()` would have walked all 4097.
    const manyPrefixes = Array.from(
      { length: 4097 },
      (_, index) => 'packages/example-' + index + '/',
    );
    const capped = briefFiles({ allowedPathPrefixes: manyPrefixes });
    const lane = makeLane({
      attempt: endedAttempt({ briefDigest: capped.digest }),
      brief: capped,
    });
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'no-allowed-prefixes' });
    expect(lane.commits).toHaveLength(0);
    expect(manyPrefixes).toHaveLength(4097);
  });

  it('findings are refused diff-findings, the workspace is never called and the journal names only the count', async () => {
    const lane = makeLane({ initialDiffOutcome: { outcome: 'findings', findings: FINDINGS } });
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result).toMatchObject({
      outcome: 'refused',
      reason: 'diff-findings',
      findings: FINDINGS,
    });
    expect(lane.commits).toHaveLength(0);
    const entry = lane.journal.entries[0]!;
    expect(entry.status).toBe('refused');
    expect(entry.detail).toBe('edit-only commit refused: 1 diff-check finding(s)');
    expect(entry.detail).not.toContain('secret.txt');
  });

  it('a diff error and an unreachable diff check are unknown', async () => {
    const errored = makeLane({
      initialDiffOutcome: { outcome: 'error', reason: 'git not available' },
    });
    const result = await errored.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result).toEqual({ outcome: 'unknown', reason: 'the lane diff check could not run' });

    const unreachable = makeLane({ diffCheckAvailable: false });
    const other = await unreachable.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(other.outcome).toBe('unknown');
  });

  it('already-committed maps to committed with alreadyCommitted true', async () => {
    const lane = makeLane({
      workspaceOutcome: { outcome: 'already-committed', headCommit: HEAD, branchRef: 'refs/heads/lane' },
    });
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result).toEqual({
      outcome: 'committed',
      headCommit: HEAD,
      alreadyCommitted: true,
    });
  });

  it('nothing-to-commit is passed through and head-moved / detached-head / ref-moved / outside-allowed-paths are refused with that reason', async () => {
    const nothing = makeLane({ workspaceOutcome: { outcome: 'nothing-to-commit' } });
    expect(await nothing.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' })).toEqual({
      outcome: 'nothing-to-commit',
    });

    for (const reason of [
      'head-moved',
      'detached-head',
      'ref-moved',
      'outside-allowed-paths',
      'merge-state-present',
      'staged-content-findings',
    ] as const) {
      const lane = makeLane({ workspaceOutcome: { outcome: 'refused', reason } });
      const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
      expect(result).toMatchObject({ outcome: 'refused', reason, findings: [] });
    }

    const failed = makeLane({
      workspaceOutcome: { outcome: 'error', reason: 'git died' },
    });
    expect(await failed.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' })).toEqual({
      outcome: 'unknown',
      reason: 'the edit-only commit could not complete',
    });
  });

  it('the workspace fake received the frozen manifest allowedPathPrefixes', async () => {
    const lane = makeLane();
    await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(lane.commits[0]!.allowedPathPrefixes).toEqual(['packages/example/']);
  });

  it('hands the commit a staged-content re-scan that runs the same diff check again and maps its verdict', async () => {
    const lane = makeLane();
    await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    const verify = lane.commits[0]!.verifyStagedContent;
    expect(verify).toBeDefined();
    const before = lane.diffRequests.length;
    expect(await verify!()).toBe('clean');
    expect(lane.diffRequests.length).toBe(before + 1);
    expect(lane.diffRequests[before]).toMatchObject({
      worktreePath: '/lanes/attempt-1',
      allowedPathPrefixes: ['packages/example/'],
    });
    lane.setDiffOutcome({ outcome: 'findings', findings: [{ path: 'packages/example/a.ts', line: 1, rule: 'secret' }] } as never);
    expect(await verify!()).toBe('findings');
    lane.setDiffOutcome({ outcome: 'error', reason: 'x' } as never);
    expect(await verify!()).toBe('error');
  });

  it('a missing attempt is refused attempt-missing', async () => {
    const lane = makeLane();
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'no-such-attempt' });
    expect(result).toEqual({ outcome: 'refused', reason: 'attempt-missing', findings: [] });
  });
});

describe('WorkspaceAdapter.removeUntrackedFiles (SN1)', () => {
  interface RecordedRun {
    readonly argv: readonly string[];
    readonly timeoutMs: number;
  }

  function fakeExecutor(result: { exitCode: number | null; error?: unknown }): {
    readonly runs: RecordedRun[];
    readonly port: CommandExecutorPort;
  } {
    const runs: RecordedRun[] = [];
    const port: CommandExecutorPort = {
      async run(argv: readonly string[], options: { timeoutMs: number }) {
        runs.push({ argv, timeoutMs: options.timeoutMs });
        return { exitCode: result.exitCode, stdout: '', stderr: '', error: result.error };
      },
    } as unknown as CommandExecutorPort;
    return { runs, port };
  }

  const HOST = runnerRecord();

  it('removes with git clean -fd on the recorded host executor, inside the 60 s budget', async () => {
    const { runs, port } = fakeExecutor({ exitCode: 0 });
    const adapter = new WorkspaceAdapter({ executor: port, executorForRecordedHost: () => ({ ok: true, executor: port }) });
    const result = await adapter.removeUntrackedFiles({ worktreePath: '/lanes/attempt-1', recordedHost: HOST });
    expect(result).toEqual({ outcome: 'removed' });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.timeoutMs).toBe(60_000);
    expect(runs[0]!.argv[0]).toBe('git');
    expect(runs[0]!.argv).toContain('-C');
    expect(runs[0]!.argv).toContain('/lanes/attempt-1');
    expect(runs[0]!.argv).toContain('clean');
    expect(runs[0]!.argv).toContain('-fd');
  });

  it('a non-zero git exit is a git-refused, not an error', async () => {
    const { runs, port } = fakeExecutor({ exitCode: 128 });
    const adapter = new WorkspaceAdapter({ executor: port });
    const result = await adapter.removeUntrackedFiles({ worktreePath: '/lanes/attempt-1' });
    expect(result).toEqual({ outcome: 'refused', reason: 'git-refused' });
    expect(runs).toHaveLength(1);
  });

  it('a run without an exit code (a timeout) is an error, never a refusal or a pass', async () => {
    const { port } = fakeExecutor({ exitCode: null });
    const adapter = new WorkspaceAdapter({ executor: port });
    expect(await adapter.removeUntrackedFiles({ worktreePath: '/lanes/attempt-1' })).toMatchObject({ outcome: 'error' });
  });

  it('a run reporting an error is an error', async () => {
    const { port } = fakeExecutor({ exitCode: 0, error: new Error('killed') });
    const adapter = new WorkspaceAdapter({ executor: port });
    expect(await adapter.removeUntrackedFiles({ worktreePath: '/lanes/attempt-1' })).toMatchObject({ outcome: 'error' });
  });

  it.each([
    ['null', null],
    ['a number', 7],
    ['a relative worktree path', { worktreePath: 'relative/path' }],
    ['a getter for worktreePath', { get worktreePath() { return '/lanes/attempt-1'; } }],
    ['a wrong-primitive worktreePath', { worktreePath: 42 }],
  ])('refuses a hostile request (%s) as invalid-request before any command', async (_label, request) => {
    const { runs, port } = fakeExecutor({ exitCode: 0 });
    const adapter = new WorkspaceAdapter({ executor: port });
    const result = await adapter.removeUntrackedFiles(request as never);
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(runs).toHaveLength(0);
  });
});
