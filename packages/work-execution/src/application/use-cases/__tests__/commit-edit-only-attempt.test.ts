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
import type {
  LaneDiffCheckPort,
  LaneDiffCheckRequest,
  LaneDiffCheckResult,
} from '../../ports/out/LaneDiffCheckPort.out-port.js';
import type { LaneDiffFinding } from '../../../domain/lane-diff-check.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';
import { CommitEditOnlyAttemptUseCase } from '../CommitEditOnlyAttemptUseCase.use-case.js';

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

function makeWorkspace(outcome: CommitLaneOutputResult = { outcome: 'committed', headCommit: HEAD, branchRef: 'refs/heads/lane' }) {
  const calls: CommitCall[] = [];
  const workspace: WorkspacePort = {
    async inspectWorktree() {
      throw new Error('not used');
    },
    async commitLaneOutput(request: CommitLaneOutputRequest): Promise<CommitLaneOutputResult> {
      calls.push(request);
      return outcome;
    },
  };
  return { workspace: workspace as Pick<WorkspacePort, 'commitLaneOutput'>, calls };
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
  diffRequests: LaneDiffCheckRequest[];
  setDiffOutcome: (outcome: LaneDiffCheckResult) => void;
}

function makeLane(options: {
  attempt?: AttemptRecord;
  brief?: { prose: string; manifestRaw: string; digest: string };
  editOnlyMode?: 'edit-only' | 'not-edit-only' | 'unknown';
  diffCheckAvailable?: boolean;
  initialDiffOutcome?: LaneDiffCheckResult;
  workspaceOutcome?: CommitLaneOutputResult;
} = {}): LaneSetup {
  const repo = makeAttemptRepo();
  const journal = makeJournal();
  const { workspace, calls } = makeWorkspace(options.workspaceOutcome);
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
      return brief.manifestRaw;
    },
    async readBriefFile(_worktreePath, relativePath) {
      if (relativePath !== '.lane/brief.md') return null;
      return brief.prose;
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
    diffRequests,
    setDiffOutcome: (outcome) => {
      diffOutcome = outcome;
    },
  };
}

const FINDINGS: readonly LaneDiffFinding[] = [
  { path: 'packages/example/secret.txt', line: 3, rule: 'secret-shape' },
];

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

  it('not-edit-only is not-applicable and no port was called', async () => {
    const lane = makeLane({ editOnlyMode: 'not-edit-only' });
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'attempt-1' });
    expect(result).toEqual({ outcome: 'not-applicable' });
    expect(lane.commits).toHaveLength(0);
    expect(lane.journal.entries).toHaveLength(0);
    expect(lane.diffRequests).toHaveLength(0);
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

  it('a missing attempt is refused attempt-missing', async () => {
    const lane = makeLane();
    const result = await lane.useCase.commitEditOnlyAttempt({ attemptId: 'no-such-attempt' });
    expect(result).toEqual({ outcome: 'refused', reason: 'attempt-missing', findings: [] });
  });
});
