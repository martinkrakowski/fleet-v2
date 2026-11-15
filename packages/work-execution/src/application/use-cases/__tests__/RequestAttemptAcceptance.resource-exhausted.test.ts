// Resource-exhausted gate tests — commands the OS killed under gate load.
/**
 * Covers the resource-exhausted branch end to end: a command predicate that
 * exited 137/143 is journaled as `unknown` with `cause: 'resource-exhausted'`
 * and the standalone gate reports `congested: true` (the retry path), while
 * other non-zero exits stay hard failures. Also covers the retrievable
 * `firstNonPassingGatePredicateOf` projection and the stored-cause guard.
 */

import { describe, expect, it } from 'vitest';

import {
  RequestAttemptAcceptanceUseCase,
  firstNonPassingGatePredicateOf,
  parseStoredPredicateResult,
} from '../RequestAttemptAcceptanceUseCase.use-case.js';
import type { RequestAttemptAcceptanceDependencies } from '../RequestAttemptAcceptanceUseCase.use-case.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';
import type {
  AcceptanceAssessmentPort,
  AcceptanceAssessmentResult,
} from '../../ports/out/AcceptanceAssessmentPort.out-port.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { GatePredicatePort } from '../../ports/out/GatePredicatePort.out-port.js';
import type {
  EvaluateGatePredicatesResult,
  GatePredicateResult,
} from '../../ports/out/GatePredicatePort.out-port.js';
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const BASE_COMMIT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const FIXED_NOW = '2026-11-15T08:00:00.000Z';

function makeAttempt(): AttemptRecord {
  return {
    id: 'attempt-1',
    ownerDecisionReferences: [],
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/tmp/opencode/lanes/attempt-1',
    baseCommit: BASE_COMMIT,
    state: 'collected',
    outcome: 'done',
    briefDigest: 'digest-1',
    briefPackagePath: '.lane/brief.md',
    sessionId: 'session-1',
    completionReceipt: null,
    artifacts: {
      headCommit: HEAD_SHA,
      commitsSinceBase: [HEAD_SHA],
      collectedArtifactPaths: [],
      notes: 'present',
    },
    runner: {
      kind: 'opencode',
      remotePort: 4166,
      host: null,
      agent: null,
      model: 'nvidia/z-ai/glm-5.3',
      variant: null,
    },
    createdAtIso: FIXED_NOW,
    updatedAtIso: FIXED_NOW,
  };
}

class InMemoryAttemptRepository implements AttemptRepositoryPort {
  constructor(private readonly records: readonly AttemptRecord[]) {}

  async saveAttempt(): Promise<void> {}

  async findAttemptById(attemptId: string): Promise<AttemptRecord | null> {
    return this.records.find((record) => record.id === attemptId) ?? null;
  }

  async listAttemptsByWorkOrder(): Promise<readonly AttemptRecord[]> {
    return this.records;
  }

  async listAllAttempts(): Promise<readonly AttemptRecord[]> {
    return this.records;
  }
}

class FakeAcceptanceAssessment implements AcceptanceAssessmentPort {
  async assessHeadAcceptance(): Promise<AcceptanceAssessmentResult> {
    return { outcome: 'accepted', receiptId: 'receipt-1', assessedHeadSha: HEAD_SHA };
  }

  async assessHeadReceipts(): Promise<never> {
    throw new Error('assessHeadReceipts is not used by this test');
  }
}

const PROSE = '# Brief\n';
const SPEC = { commitRequired: true, diffCheck: true, commands: [{ argv: ['corepack', 'yarn', 'build'] }] };
const MANIFEST = JSON.stringify(
  { baseCommit: BASE_COMMIT, allowedPathPrefixes: ['src'], acceptanceSpec: SPEC },
  null,
  2,
);

const ATTEMPT: AttemptRecord = {
  ...makeAttempt(),
  briefDigest: simpleDeterministicHexDigest(PROSE + '\n' + MANIFEST),
};

const WORK_ORDER: WorkOrderRecord = {
  id: 'wo-1',
  projectId: 'project-1',
  taskId: 'task-1',
  laneId: 'lane-1',
  repository: 'repo',
  baseCommit: BASE_COMMIT,
  ownedPaths: ['src'],
  policyRevision: 'policy-7',
  prerequisiteWorkOrderIds: [],
  state: 'approved',
  revision: 1,
  createdAtIso: FIXED_NOW,
  updatedAtIso: FIXED_NOW,
};

class InMemoryWorkOrderRepository implements WorkOrderRepositoryPort {
  async saveWorkOrder(): Promise<void> {}

  async findWorkOrderById(id: string): Promise<WorkOrderRecord | null> {
    return id === WORK_ORDER.id ? WORK_ORDER : null;
  }

  async listWorkOrdersByProject(): Promise<readonly WorkOrderRecord[]> {
    return [WORK_ORDER];
  }
}

class InMemoryJournal {
  readonly entries: ActionJournalEntryRecord[] = [];

  async appendJournalEntry(entry: ActionJournalEntryRecord): Promise<void> {
    if (this.entries.some((existing) => existing.id === entry.id)) {
      throw new Error(`Duplicate journal entry id: ${entry.id}`);
    }
    this.entries.push(entry);
  }

  async listJournalEntriesForAttempt(attemptId: string): Promise<readonly ActionJournalEntryRecord[]> {
    return this.entries.filter((entry) => entry.attemptId === attemptId);
  }
}

class FakeArtifactPort {
  prose: string | null = PROSE;
  manifest: string | null = MANIFEST;

  async readBriefFile(): Promise<string | null> {
    return this.prose;
  }

  async readBriefManifest(): Promise<string | null> {
    return this.manifest;
  }
}

class FakeGatePredicatePort implements GatePredicatePort {
  constructor(private readonly result: EvaluateGatePredicatesResult) {}

  async evaluateGatePredicates(): Promise<EvaluateGatePredicatesResult> {
    return this.result;
  }
}

const PASS_COMMIT: GatePredicateResult = {
  name: 'commit',
  kind: 'commit',
  verdict: 'pass',
  exitCode: null,
  durationMs: 1,
  detail: 'head ' + HEAD_SHA + ', 1 commit(s) since the base',
};

const PASS_DIFF: GatePredicateResult = {
  name: 'diff-check',
  kind: 'diff-check',
  verdict: 'pass',
  exitCode: null,
  durationMs: 1,
  detail: 'clean',
};

function commandResult(overrides: Partial<GatePredicateResult> = {}): GatePredicateResult {
  return {
    name: 'command 1: corepack yarn build',
    kind: 'command',
    verdict: 'fail',
    exitCode: 1,
    durationMs: 1,
    detail: 'exit 1',
    ...overrides,
  };
}

function makeDeps(options: { gate?: FakeGatePredicatePort; journal?: InMemoryJournal } = {}) {
  const journal = options.journal ?? new InMemoryJournal();
  const deps: RequestAttemptAcceptanceDependencies = {
    attemptRepo: new InMemoryAttemptRepository([ATTEMPT]),
    workOrderRepo: new InMemoryWorkOrderRepository(),
    acceptancePort: new FakeAcceptanceAssessment(),
    artifactPort: new FakeArtifactPort(),
    ...(options.gate !== undefined ? { gatePredicates: options.gate } : {}),
    journal,
  };
  return { deps, journal };
}

function gateRequest(overrides: { gateRun?: number } = {}) {
  return { attemptId: 'attempt-1', candidateHeadSha: HEAD_SHA, ...overrides };
}

function journalEntry(id: string, detail: unknown): ActionJournalEntryRecord {
  return {
    id,
    attemptId: 'attempt-1',
    workOrderId: 'wo-1',
    action: 'accept',
    baseCommit: BASE_COMMIT,
    recordedAtIso: FIXED_NOW,
    sessionId: 'session-1',
    status: 'ambiguous',
    detail: JSON.stringify(detail),
  };
}

describe('resource-exhausted gate classification', () => {
  it('evaluateAttemptGate returns unknown with congested true when a command exits 137 or 143', async () => {
    for (const exitCode of [137, 143]) {
      const gate = new FakeGatePredicatePort({
        outcome: 'evaluated',
        results: [
          PASS_COMMIT,
          PASS_DIFF,
          commandResult({
            verdict: 'unknown',
            exitCode,
            detail: `resource exhausted (exit ${exitCode}, ${exitCode === 137 ? 'SIGKILL' : 'SIGTERM'})`,
            cause: 'resource-exhausted',
          }),
        ],
      });
      const { deps } = makeDeps({ gate });
      const result = await new RequestAttemptAcceptanceUseCase(deps).evaluateAttemptGate(gateRequest());
      expect(result.verdict).toBe('unknown');
      expect(result.verdict === 'unknown' && result.congested).toBe(true);
    }
  });

  it('evaluateAttemptGate returns failed without congested when a command exits 1', async () => {
    const gate = new FakeGatePredicatePort({
      outcome: 'evaluated',
      results: [PASS_COMMIT, PASS_DIFF, commandResult({ exitCode: 1, detail: 'exit 1' })],
    });
    const { deps } = makeDeps({ gate });
    const result = await new RequestAttemptAcceptanceUseCase(deps).evaluateAttemptGate(gateRequest());
    expect(result.verdict).toBe('failed');
    expect(result.verdict === 'failed' && result.reason).toBe(
      'Gate predicate command 1: corepack yarn build fail with exit code 1: exit 1',
    );
    expect('congested' in result).toBe(false);
  });

  it('firstNonPassingGatePredicateOf retrieves name, verdict, exitCode, detail, and cause from the highest stored gate run', async () => {
    const journal = new InMemoryJournal();
    const congestedGate = new FakeGatePredicatePort({
      outcome: 'evaluated',
      results: [
        PASS_COMMIT,
        PASS_DIFF,
        commandResult({
          verdict: 'unknown',
          exitCode: 137,
          detail: 'resource exhausted (exit 137, SIGKILL)',
          cause: 'resource-exhausted',
        }),
      ],
    });
    const run0 = await new RequestAttemptAcceptanceUseCase(makeDeps({ gate: congestedGate, journal }).deps)
      .evaluateAttemptGate(gateRequest());
    expect(run0).toMatchObject({ verdict: 'unknown', congested: true });

    // Run 0 alone: the resource kill is retrievable with its cause.
    const exhausted = firstNonPassingGatePredicateOf(journal.entries, 'attempt-1', HEAD_SHA);
    expect(exhausted).toEqual({
      name: 'command 1: corepack yarn build',
      kind: 'command',
      verdict: 'unknown',
      exitCode: 137,
      detail: 'resource exhausted (exit 137, SIGKILL)',
      cause: 'resource-exhausted',
    });

    // A timeout unknown (no cause) and a real fail exit 1 read differently.
    const timeoutEntry = journalEntry(`attempt-1:accept:${HEAD_SHA}:2`, {
      predicate: 'command 1: corepack yarn build',
      kind: 'command',
      verdict: 'unknown',
      exitCode: null,
      durationMs: 5,
      detail: 'command did not complete',
    });
    const failEntry = journalEntry(`attempt-1:accept:${HEAD_SHA}:2`, {
      predicate: 'command 1: corepack yarn build',
      kind: 'command',
      verdict: 'fail',
      exitCode: 1,
      durationMs: 5,
      detail: 'exit 1',
    });
    const fromTimeout = firstNonPassingGatePredicateOf([timeoutEntry], 'attempt-1', HEAD_SHA);
    expect(fromTimeout).toMatchObject({ verdict: 'unknown', exitCode: null, detail: 'command did not complete' });
    expect(fromTimeout).not.toHaveProperty('cause');
    const fromFail = firstNonPassingGatePredicateOf([failEntry], 'attempt-1', HEAD_SHA);
    expect(fromFail).toMatchObject({ verdict: 'fail', exitCode: 1, detail: 'exit 1' });
    expect(fromFail).not.toHaveProperty('cause');

    // A later retry run replaces the earlier congested run.
    const failedGate = new FakeGatePredicatePort({
      outcome: 'evaluated',
      results: [PASS_COMMIT, commandResult({ kind: 'diff-check', name: 'diff-check', detail: 'bad diff' }), commandResult()],
    });
    const run1 = await new RequestAttemptAcceptanceUseCase(makeDeps({ gate: failedGate, journal }).deps)
      .evaluateAttemptGate(gateRequest({ gateRun: 1 }));
    expect(run1.verdict).toBe('failed');

    const afterRetry = firstNonPassingGatePredicateOf(journal.entries, 'attempt-1', HEAD_SHA);
    expect(afterRetry).toMatchObject({
      name: 'diff-check',
      verdict: 'fail',
      exitCode: 1,
      detail: 'bad diff',
    });
    expect(afterRetry).not.toHaveProperty('cause');
  });

  it('firstNonPassingGatePredicateOf withholds secret-shaped detail and truncates long detail to 300 characters', () => {
    const secretEntry = journalEntry(`attempt-1:accept:${HEAD_SHA}:2`, {
      predicate: 'command 1: corepack yarn build',
      kind: 'command',
      verdict: 'unknown',
      exitCode: 137,
      durationMs: 1,
      detail: 'killed while printing token sk-abcdef1234567890abcdef end',
      cause: 'resource-exhausted',
    });
    const secret = firstNonPassingGatePredicateOf([secretEntry], 'attempt-1', HEAD_SHA);
    expect(secret?.detail).toBe('detail withheld: secret-shaped text');
    expect(secret?.detail).not.toContain('sk-');

    const longEntry = journalEntry(`attempt-1:accept:${HEAD_SHA}:2`, {
      predicate: 'command 1: corepack yarn build',
      kind: 'command',
      verdict: 'fail',
      exitCode: 1,
      durationMs: 1,
      detail: 'x'.repeat(400),
    });
    const long = firstNonPassingGatePredicateOf([longEntry], 'attempt-1', HEAD_SHA);
    expect(long?.detail).toHaveLength(300);
    expect(long?.detail).toBe('x'.repeat(300));

    expect(firstNonPassingGatePredicateOf([], 'attempt-1', HEAD_SHA)).toBeNull();
  });

  it('parseStoredPredicateResult rejects an unrecognized cause value', () => {
    const entry = journalEntry(`attempt-1:accept:${HEAD_SHA}:2`, {
      predicate: 'command 1: corepack yarn build',
      kind: 'command',
      verdict: 'unknown',
      exitCode: 137,
      durationMs: 1,
      detail: 'resource exhausted',
      cause: 'alien-cause',
    });
    expect(parseStoredPredicateResult(entry)).toBeNull();
  });

  it('firstNonPassingGatePredicateOf returns null when no gate run is stored for the head', () => {
    expect(firstNonPassingGatePredicateOf([], 'attempt-1', HEAD_SHA)).toBeNull();
    const otherAttempt = journalEntry(`attempt-2:accept:${HEAD_SHA}:2`, {
      predicate: 'command 1: corepack yarn build',
      kind: 'command',
      verdict: 'fail',
      exitCode: 1,
      durationMs: 1,
      detail: 'exit 1',
    });
    expect(firstNonPassingGatePredicateOf([otherAttempt], 'attempt-1', HEAD_SHA)).toBeNull();
  });
});
