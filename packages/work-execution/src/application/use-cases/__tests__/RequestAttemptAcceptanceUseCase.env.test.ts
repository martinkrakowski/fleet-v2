// CB1b: a second consecutive persistent install failure fails the gate and archives its tail.
/**
 * The first `environment-not-installed` stays congested `unknown`. The second
 * at the same head is promoted to `fail` only when its exit is a non-zero
 * integer other than 75, 137 or 143, so the tail is archived. A null exit, a
 * congestion exit, a different prior cause, or a malformed prior journal
 * entry is not promoted.
 */

import { describe, expect, it } from 'vitest';

import {
  RequestAttemptAcceptanceUseCase,
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
import type { EvidenceArchivePort } from '@fleet/evidence-and-acceptance';
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const BASE_COMMIT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const FIXED_NOW = '2026-11-15T08:00:00.000Z';
const MISMATCH = 'Gate predicate results do not match the frozen acceptance spec';
const TAIL = 'lockfile drift: yarn.lock would change';

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
  async readBriefFile(): Promise<string | null> {
    return PROSE;
  }
  async readBriefManifest(): Promise<string | null> {
    return MANIFEST;
  }
}

class FakeGatePredicatePort implements GatePredicatePort {
  calls = 0;
  constructor(private readonly steps: readonly EvaluateGatePredicatesResult[]) {}
  async evaluateGatePredicates(): Promise<EvaluateGatePredicatesResult> {
    const step = this.steps[Math.min(this.calls, this.steps.length - 1)];
    this.calls += 1;
    if (step === undefined) {
      throw new Error('no scripted gate result');
    }
    return step;
  }
}

class FakeArchive implements EvidenceArchivePort {
  readonly archived: { artifactId: string; content: string; candidateHeadSha: string }[] = [];
  constructor(private readonly behaviour: 'ok' | 'throw' = 'ok') {}
  async archiveEvidence(request: { artifactId: string; candidateHeadSha: string; content: string }) {
    this.archived.push({ ...request });
    if (this.behaviour === 'throw') {
      throw new Error('archive unavailable');
    }
    return { evidenceRef: `evidence://${request.artifactId}@${'a'.repeat(64)}`, digest: 'a'.repeat(64) };
  }
  async readArchivedEvidence(): Promise<string | null> {
    return null;
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

function envResult(exitCode: number | null, outputTail?: string): GatePredicateResult {
  return {
    name: 'command 1: corepack yarn build',
    kind: 'command',
    verdict: 'unknown',
    exitCode,
    durationMs: 4,
    detail: 'dependencies not installed in the worktree',
    cause: 'environment-not-installed',
    ...(outputTail === undefined ? {} : { outputTail }),
  };
}

function evaluated(command: GatePredicateResult): EvaluateGatePredicatesResult {
  return { outcome: 'evaluated', results: [PASS_COMMIT, PASS_DIFF, command] };
}

const SLOT_WAIT: GatePredicateResult = {
  name: 'command 1: corepack yarn build',
  kind: 'command',
  verdict: 'unknown',
  exitCode: 75,
  durationMs: 4,
  detail: 'gate slot wait limit reached',
  cause: 'gate-slot-wait-limit',
};

function makeDeps(options: {
  gate: FakeGatePredicatePort;
  journal?: InMemoryJournal;
  archive?: FakeArchive;
}) {
  const journal = options.journal ?? new InMemoryJournal();
  const deps: RequestAttemptAcceptanceDependencies = {
    attemptRepo: new InMemoryAttemptRepository([ATTEMPT]),
    workOrderRepo: new InMemoryWorkOrderRepository(),
    acceptancePort: new FakeAcceptanceAssessment(),
    artifactPort: new FakeArtifactPort(),
    gatePredicates: options.gate,
    journal,
    now: () => FIXED_NOW,
    ...(options.archive === undefined ? {} : { evidenceArchive: options.archive }),
  };
  return { deps, journal };
}

function gateRequest(gateRun?: number) {
  return {
    attemptId: 'attempt-1',
    candidateHeadSha: HEAD_SHA,
    ...(gateRun === undefined ? {} : { gateRun }),
  };
}

function commandEntry(journal: InMemoryJournal, run: number): ActionJournalEntryRecord | undefined {
  const suffix = run === 0 ? `:${HEAD_SHA}:3` : `:${HEAD_SHA}/g${run}:3`;
  return journal.entries.find((entry) => entry.id.endsWith(suffix));
}

describe('persistent environment-not-installed classification (CB1b)', () => {
  it('first environment-not-installed returns congested unknown', async () => {
    const archive = new FakeArchive();
    const gate = new FakeGatePredicatePort([evaluated(envResult(1, TAIL))]);
    const { deps, journal } = makeDeps({ gate, archive });
    const result = await new RequestAttemptAcceptanceUseCase(deps).evaluateAttemptGate(gateRequest());
    expect(result).toMatchObject({ verdict: 'unknown', congested: true });
    expect(result.verdict).not.toBe('failed');
    expect(archive.archived).toEqual([]);
    const stored = commandEntry(journal, 0);
    expect(stored?.status).toBe('ambiguous');
    expect(stored?.detail ?? '').not.toContain(TAIL);
    expect(stored?.detail ?? '').not.toContain('outputEvidenceRef');
    expect(parseStoredPredicateResult(stored as ActionJournalEntryRecord)).toMatchObject({
      verdict: 'unknown',
      cause: 'environment-not-installed',
      exitCode: 1,
    });
  });

  it('environment-not-installed after gate-slot-wait-limit stays congested unknown', async () => {
    const archive = new FakeArchive();
    const journal = new InMemoryJournal();
    const gate = new FakeGatePredicatePort([evaluated(SLOT_WAIT), evaluated(envResult(1, TAIL))]);
    const { deps } = makeDeps({ gate, journal, archive });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);
    const run0 = await useCase.evaluateAttemptGate(gateRequest());
    expect(run0).toMatchObject({ verdict: 'unknown', congested: true });
    const run1 = await useCase.evaluateAttemptGate(gateRequest(1));
    expect(run1).toMatchObject({ verdict: 'unknown', congested: true });
    expect(run1.verdict).not.toBe('failed');
    expect(archive.archived).toEqual([]);
    expect(commandEntry(journal, 1)?.detail ?? '').not.toContain('outputEvidenceRef');
  });

  it('null exit on second environment-not-installed stays congested unknown', async () => {
    for (const exitCode of [null, 0, 75, 137, 143]) {
      const journal = new InMemoryJournal();
      const archive = new FakeArchive();
      const gate = new FakeGatePredicatePort([
        evaluated(envResult(1, TAIL)),
        evaluated(envResult(exitCode, TAIL)),
      ]);
      const { deps } = makeDeps({ gate, journal, archive });
      const useCase = new RequestAttemptAcceptanceUseCase(deps);
      const run0 = await useCase.evaluateAttemptGate(gateRequest());
      expect(run0).toMatchObject({ verdict: 'unknown', congested: true });
      const run1 = await useCase.evaluateAttemptGate(gateRequest(1));
      expect(run1).toMatchObject({ verdict: 'unknown', congested: true });
      expect(run1.verdict).not.toBe('failed');
      expect(archive.archived).toEqual([]);
    }
  });

  it('second consecutive environment-not-installed at same head fails gate and archives tail', async () => {
    const archive = new FakeArchive();
    const journal = new InMemoryJournal();
    const gate = new FakeGatePredicatePort([
      evaluated(envResult(1, TAIL)),
      evaluated(envResult(2, TAIL)),
    ]);
    const { deps } = makeDeps({ gate, journal, archive });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);
    const run0 = await useCase.evaluateAttemptGate(gateRequest());
    expect(run0).toMatchObject({ verdict: 'unknown', congested: true });
    expect(archive.archived).toEqual([]);

    const run1 = await useCase.evaluateAttemptGate(gateRequest(1));
    expect(run1.verdict).toBe('failed');
    if (run1.verdict !== 'failed' || run1.results === undefined) {
      throw new Error('expected a failed gate with predicate results');
    }
    expect(run1.results[2]).toMatchObject({
      verdict: 'fail',
      cause: 'environment-not-installed',
      exitCode: 2,
      outputTail: TAIL,
      detail: 'dependencies not installed in the worktree',
    });
    expect(archive.archived).toEqual([
      {
        artifactId: `attempt-1:accept:${HEAD_SHA}/g1:3:output-tail`,
        candidateHeadSha: HEAD_SHA,
        content: TAIL,
      },
    ]);
    const stored = parseStoredPredicateResult(commandEntry(journal, 1) as ActionJournalEntryRecord);
    expect(stored).toMatchObject({
      verdict: 'fail',
      cause: 'environment-not-installed',
      exitCode: 2,
    });
    expect(stored?.outputEvidenceRef).toMatch(/^evidence:\/\//);
    expect(commandEntry(journal, 1)?.detail ?? '').not.toContain(TAIL);
  });

  it('missing or throwing evidenceArchive still fails gate on second env failure', async () => {
    for (const archive of [undefined, new FakeArchive('throw')]) {
      const journal = new InMemoryJournal();
      const gate = new FakeGatePredicatePort([
        evaluated(envResult(1, TAIL)),
        evaluated(envResult(1, TAIL)),
      ]);
      const { deps } = makeDeps({ gate, journal, ...(archive === undefined ? {} : { archive }) });
      const useCase = new RequestAttemptAcceptanceUseCase(deps);
      await useCase.evaluateAttemptGate(gateRequest());
      const run1 = await useCase.evaluateAttemptGate(gateRequest(1));
      expect(run1.verdict).toBe('failed');
      if (run1.verdict !== 'failed' || run1.results === undefined) {
        throw new Error('expected a failed gate with predicate results');
      }
      expect(run1.results[2]).toMatchObject({
        verdict: 'fail',
        cause: 'environment-not-installed',
        outputTail: TAIL,
      });
      expect(commandEntry(journal, 1)?.detail ?? '').not.toContain('outputEvidenceRef');
      expect(commandEntry(journal, 1)?.detail ?? '').not.toContain(TAIL);
    }
  });

  it('malformed prior journal entry does not promote to fail', async () => {
    expect(parseStoredPredicateResult(null as unknown as ActionJournalEntryRecord)).toBeNull();
    expect(parseStoredPredicateResult(undefined as unknown as ActionJournalEntryRecord)).toBeNull();
    expect(parseStoredPredicateResult('nope' as unknown as ActionJournalEntryRecord)).toBeNull();
    for (const detail of ['not json', 'null', '[]', '""']) {
      expect(
        parseStoredPredicateResult({
          id: 'x',
          attemptId: 'attempt-1',
          workOrderId: 'wo-1',
          action: 'accept',
          baseCommit: BASE_COMMIT,
          recordedAtIso: FIXED_NOW,
          sessionId: null,
          status: 'ambiguous',
          detail,
        }),
      ).toBeNull();
    }

    for (const results of [null, 'nope', [], { length: 3 }]) {
      const gate = new FakeGatePredicatePort([
        { outcome: 'evaluated', results } as unknown as EvaluateGatePredicatesResult,
      ]);
      const { deps } = makeDeps({ gate });
      const result = await new RequestAttemptAcceptanceUseCase(deps).evaluateAttemptGate(gateRequest());
      expect(result).toEqual({ verdict: 'unknown', reason: MISMATCH });
    }

    const journal = new InMemoryJournal();
    const gate = new FakeGatePredicatePort([
      evaluated(envResult(1, TAIL)),
      evaluated(envResult(1, TAIL)),
    ]);
    const { deps } = makeDeps({ gate, journal });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);
    await useCase.evaluateAttemptGate(gateRequest());
    const index = journal.entries.findIndex((entry) => entry.id.endsWith(`:${HEAD_SHA}:3`));
    const prior = journal.entries[index];
    if (prior === undefined) {
      throw new Error('expected the run 0 command entry');
    }
    journal.entries[index] = { ...prior, detail: '[]' };
    expect(parseStoredPredicateResult(journal.entries[index] as ActionJournalEntryRecord)).toBeNull();
    const run1 = await useCase.evaluateAttemptGate(gateRequest(1));
    expect(run1.verdict).not.toBe('failed');
    expect(run1.verdict).toBe('unknown');

    const slotJournal = new InMemoryJournal();
    const slotGate = new FakeGatePredicatePort([evaluated(SLOT_WAIT), evaluated(envResult(1, TAIL))]);
    const slot = makeDeps({ gate: slotGate, journal: slotJournal });
    const slotUseCase = new RequestAttemptAcceptanceUseCase(slot.deps);
    await slotUseCase.evaluateAttemptGate(gateRequest());
    slotJournal.entries.push({
      id: `attempt-1:accept:${HEAD_SHA}:bogus`,
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      action: 'accept',
      baseCommit: BASE_COMMIT,
      recordedAtIso: FIXED_NOW,
      sessionId: 'session-1',
      status: 'ambiguous',
      detail: '[]',
    });
    const afterBogus = await slotUseCase.evaluateAttemptGate(gateRequest(1));
    expect(afterBogus).toMatchObject({ verdict: 'unknown', congested: true });
    expect(afterBogus.verdict).not.toBe('failed');
  });

  it('throwing journal detail getter does not promote first env failure', async () => {
    const hostile = {
      id: `attempt-1:accept:${HEAD_SHA}:0`,
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      action: 'accept' as const,
      baseCommit: BASE_COMMIT,
      recordedAtIso: FIXED_NOW,
      sessionId: 'session-1',
      status: 'ambiguous' as const,
      detail: null as string | null,
    };
    Object.defineProperty(hostile, 'detail', {
      enumerable: true,
      configurable: true,
      get(): string {
        throw new Error('hostile detail getter');
      },
    });
    expect(parseStoredPredicateResult(hostile)).toBeNull();

    const journal = new InMemoryJournal();
    const gate = new FakeGatePredicatePort([evaluated(SLOT_WAIT), evaluated(envResult(1, TAIL))]);
    const { deps } = makeDeps({ gate, journal });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);
    await useCase.evaluateAttemptGate(gateRequest());
    journal.entries.push(hostile);
    const run1 = await useCase.evaluateAttemptGate(gateRequest(1));
    expect(run1).toMatchObject({ verdict: 'unknown', congested: true });
    expect(run1.verdict).not.toBe('failed');
  });

  it('a timed-out first install failure followed by a persistent second one promotes to fail (current behaviour: only the current run\'s exit is checked)', async () => {
    const archive = new FakeArchive();
    const journal = new InMemoryJournal();
    const gate = new FakeGatePredicatePort([
      evaluated(envResult(null, TAIL)),
      evaluated(envResult(2, TAIL)),
    ]);
    const { deps } = makeDeps({ gate, journal, archive });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);
    const run0 = await useCase.evaluateAttemptGate(gateRequest());
    expect(run0).toMatchObject({ verdict: 'unknown', congested: true });
    expect(run0.verdict).not.toBe('failed');
    expect(archive.archived).toEqual([]);

    const run1 = await useCase.evaluateAttemptGate(gateRequest(1));
    expect(run1.verdict).toBe('failed');
    if (run1.verdict !== 'failed' || run1.results === undefined) {
      throw new Error('expected a failed gate with predicate results');
    }
    expect(run1.results[2]).toMatchObject({
      verdict: 'fail',
      cause: 'environment-not-installed',
      exitCode: 2,
      outputTail: TAIL,
    });
    expect(archive.archived).toEqual([
      {
        artifactId: `attempt-1:accept:${HEAD_SHA}/g1:3:output-tail`,
        candidateHeadSha: HEAD_SHA,
        content: TAIL,
      },
    ]);
    const stored = parseStoredPredicateResult(commandEntry(journal, 1) as ActionJournalEntryRecord);
    expect(stored).toMatchObject({
      verdict: 'fail',
      cause: 'environment-not-installed',
      exitCode: 2,
    });
    expect(stored?.outputEvidenceRef).toMatch(/^evidence:\/\//);
  });

  it('a persistent first install failure followed by a timed-out second one stays congested unknown', async () => {
    const archive = new FakeArchive();
    const journal = new InMemoryJournal();
    const gate = new FakeGatePredicatePort([
      evaluated(envResult(2, TAIL)),
      evaluated(envResult(null, TAIL)),
    ]);
    const { deps } = makeDeps({ gate, journal, archive });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);
    const run0 = await useCase.evaluateAttemptGate(gateRequest());
    expect(run0).toMatchObject({ verdict: 'unknown', congested: true });
    expect(archive.archived).toEqual([]);

    const run1 = await useCase.evaluateAttemptGate(gateRequest(1));
    expect(run1).toMatchObject({ verdict: 'unknown', congested: true });
    expect(run1.verdict).not.toBe('failed');
    expect(archive.archived).toEqual([]);
    expect(commandEntry(journal, 1)?.detail ?? '').not.toContain('outputEvidenceRef');

    // Positive control: the same persistent exit twice does promote.
    const controlJournal = new InMemoryJournal();
    const controlArchive = new FakeArchive();
    const controlGate = new FakeGatePredicatePort([
      evaluated(envResult(2, TAIL)),
      evaluated(envResult(2, TAIL)),
    ]);
    const control = makeDeps({ gate: controlGate, journal: controlJournal, archive: controlArchive });
    const controlUseCase = new RequestAttemptAcceptanceUseCase(control.deps);
    await controlUseCase.evaluateAttemptGate(gateRequest());
    const controlRun1 = await controlUseCase.evaluateAttemptGate(gateRequest(1));
    expect(controlRun1.verdict).toBe('failed');
    expect(controlArchive.archived).toEqual([
      {
        artifactId: `attempt-1:accept:${HEAD_SHA}/g1:3:output-tail`,
        candidateHeadSha: HEAD_SHA,
        content: TAIL,
      },
    ]);
  });

  it('a congestion-exited first install failure followed by a persistent second one promotes to fail', async () => {
    // The prior run's exit code (137) is deliberately not consulted:
    // promoteConsecutiveEnvironmentFailure inspects only
    // priorCause === 'environment-not-installed'.
    const archive = new FakeArchive();
    const journal = new InMemoryJournal();
    const gate = new FakeGatePredicatePort([
      evaluated(envResult(137, TAIL)),
      evaluated(envResult(2, TAIL)),
    ]);
    const { deps } = makeDeps({ gate, journal, archive });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);
    const run0 = await useCase.evaluateAttemptGate(gateRequest());
    expect(run0).toMatchObject({ verdict: 'unknown', congested: true });
    expect(run0.verdict).not.toBe('failed');
    expect(archive.archived).toEqual([]);

    const run1 = await useCase.evaluateAttemptGate(gateRequest(1));
    expect(run1.verdict).toBe('failed');
    if (run1.verdict !== 'failed' || run1.results === undefined) {
      throw new Error('expected a failed gate with predicate results');
    }
    expect(run1.results[2]).toMatchObject({
      verdict: 'fail',
      cause: 'environment-not-installed',
      exitCode: 2,
    });
    expect(archive.archived).toHaveLength(1);
    expect(archive.archived[0]?.artifactId).toMatch(/\/g1:3:output-tail$/);
    const stored = parseStoredPredicateResult(commandEntry(journal, 1) as ActionJournalEntryRecord);
    expect(stored).toMatchObject({
      verdict: 'fail',
      cause: 'environment-not-installed',
      exitCode: 2,
    });
  });
});
