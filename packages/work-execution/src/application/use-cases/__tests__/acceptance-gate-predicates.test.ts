// Acceptance gate predicate tests — plan S2b.
/**
 * Covers RequestAttemptAcceptanceUseCase with the gate wired: the frozen
 * acceptance spec is read from the attempt's brief package, verified against
 * the recorded digest, evaluated predicate by predicate through the gate
 * port, and journaled one entry per predicate before the evidence assessment.
 */

import { describe, expect, it } from 'vitest';

import { RequestAttemptAcceptanceUseCase, nonPassingGatePredicatesOf } from '../RequestAttemptAcceptanceUseCase.use-case.js';
import type { RequestAttemptAcceptanceDependencies } from '../RequestAttemptAcceptanceUseCase.use-case.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';
import type { RequestAttemptAcceptanceRequest } from '../../ports/in/RequestAttemptAcceptancePort.in-port.js';
import type {
  AcceptanceAssessmentPort,
  AcceptanceAssessmentRequest,
  AcceptanceAssessmentResult,
} from '../../ports/out/AcceptanceAssessmentPort.out-port.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { GatePredicatePort } from '../../ports/out/GatePredicatePort.out-port.js';
import type {
  EvaluateGatePredicatesRequest,
  EvaluateGatePredicatesResult,
  GatePredicateResult,
} from '../../ports/out/GatePredicatePort.out-port.js';
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  AttemptRunnerRecord,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const BASE_COMMIT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const FIXED_NOW = '2026-10-15T08:00:00.000Z';

function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
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
    briefPackagePath: null,
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
    ...overrides,
  };
}

class InMemoryAttemptRepository implements AttemptRepositoryPort {
  private readonly attempts = new Map<string, AttemptRecord>();

  constructor(records: readonly AttemptRecord[] = []) {
    for (const record of records) {
      this.attempts.set(record.id, record);
    }
  }

  async saveAttempt(record: AttemptRecord): Promise<void> {
    this.attempts.set(record.id, record);
  }

  async findAttemptById(attemptId: string): Promise<AttemptRecord | null> {
    return this.attempts.get(attemptId) ?? null;
  }

  async listAttemptsByWorkOrder(workOrderId: string): Promise<readonly AttemptRecord[]> {
    return [...this.attempts.values()].filter((a) => a.workOrderId === workOrderId);
  }

  async listAllAttempts(): Promise<readonly AttemptRecord[]> {
    return [...this.attempts.values()];
  }
}

class FakeAcceptanceAssessment implements AcceptanceAssessmentPort {
  readonly requests: AcceptanceAssessmentRequest[] = [];
  result: AcceptanceAssessmentResult = {
    outcome: 'accepted',
    receiptId: 'receipt-1',
    assessedHeadSha: HEAD_SHA,
  };

  async assessHeadAcceptance(request: AcceptanceAssessmentRequest): Promise<AcceptanceAssessmentResult> {
    this.requests.push(request);
    return this.result;
  }

  async assessHeadReceipts(): Promise<never> {
    throw new Error('assessHeadReceipts is not used by this test');
  }
}

function acceptanceRequest(overrides: Partial<RequestAttemptAcceptanceRequest> = {}): RequestAttemptAcceptanceRequest {
  return {
    attemptId: 'attempt-1',
    candidateHeadSha: HEAD_SHA,
    reviewerModel: 'openrouter/anthropic/claude-sonnet-4.5',
    ...overrides,
  };
}

const PROSE = '# Brief\n';
const SPEC = { commitRequired: true, diffCheck: true, commands: [{ argv: ['corepack', 'yarn', 'build'] }] };
const MANIFEST = JSON.stringify(
  { baseCommit: BASE_COMMIT, allowedPathPrefixes: ['src'], acceptanceSpec: SPEC },
  null,
  2,
);

const ATTEMPT = makeAttempt({
  briefPackagePath: '.lane/brief.md',
  briefDigest: simpleDeterministicHexDigest(PROSE + '\n' + MANIFEST),
});

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
  readBriefFileCalls = 0;
  prose: string | null = PROSE;
  manifest: string | null = MANIFEST;

  async readBriefFile(
    _worktreePath: string,
    _relativePath: string,
    _recordedHost?: AttemptRunnerRecord | null,
  ): Promise<string | null> {
    this.readBriefFileCalls += 1;
    return this.prose;
  }

  async readBriefManifest(
    _worktreePath: string,
    _manifestPath?: string,
    _recordedHost?: AttemptRunnerRecord | null,
  ): Promise<string | null> {
    return this.manifest;
  }
}

class FakeGatePredicatePort implements GatePredicatePort {
  readonly requests: EvaluateGatePredicatesRequest[] = [];

  constructor(private readonly result: EvaluateGatePredicatesResult) {}

  async evaluateGatePredicates(
    request: EvaluateGatePredicatesRequest,
  ): Promise<EvaluateGatePredicatesResult> {
    this.requests.push(request);
    return this.result;
  }
}

function makeDeps(options: {
  gate?: FakeGatePredicatePort;
  journal?: InMemoryJournal;
  artifact?: FakeArtifactPort;
  includeJournal?: boolean;
  attempt?: AttemptRecord;
} = {}) {
  const acceptancePort = new FakeAcceptanceAssessment();
  const artifact = options.artifact ?? new FakeArtifactPort();
  const journal = options.journal ?? new InMemoryJournal();
  const attempt = options.attempt ?? ATTEMPT;
  const deps: RequestAttemptAcceptanceDependencies = {
    attemptRepo: new InMemoryAttemptRepository([attempt]),
    workOrderRepo: new InMemoryWorkOrderRepository(),
    acceptancePort,
    artifactPort: artifact,
    ...(options.gate !== undefined ? { gatePredicates: options.gate } : {}),
    ...(options.includeJournal === false ? {} : { journal }),
  };
  return { deps, acceptancePort, artifact, journal, attempt };
}

const PASS_RESULTS: readonly GatePredicateResult[] = [
  {
    name: 'commit',
    kind: 'commit',
    verdict: 'pass',
    exitCode: null,
    durationMs: 1,
    detail: 'head ' + HEAD_SHA + ', 1 commit(s) since the base',
  },
  { name: 'diff-check', kind: 'diff-check', verdict: 'pass', exitCode: null, durationMs: 1, detail: 'clean' },
  {
    name: 'command 1: corepack yarn build',
    kind: 'command',
    verdict: 'pass',
    exitCode: 0,
    durationMs: 1,
    detail: 'exit 0',
  },
];

const EVALUATED_ALL_PASS: EvaluateGatePredicatesResult = { outcome: 'evaluated', results: PASS_RESULTS };

describe('RequestAttemptAcceptanceUseCase with the gate wired', () => {
  it('accepts when every predicate passes and journals one entry per predicate', async () => {
    const gate = new FakeGatePredicatePort(EVALUATED_ALL_PASS);
    const { deps, acceptancePort, journal, artifact } = makeDeps({ gate });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result.outcome).toBe('accepted');
    expect(gate.requests).toHaveLength(1);
    expect(gate.requests[0].spec).toEqual(SPEC);
    expect(gate.requests[0].allowedPathPrefixes).toEqual(['src']);
    expect(gate.requests[0].baseCommit).toBe(BASE_COMMIT);
    expect(gate.requests[0].candidateHeadSha).toBe(HEAD_SHA);

    const acceptEntries = journal.entries.filter((entry) => entry.action === 'accept');
    expect(acceptEntries.map((entry) => entry.status)).toEqual([
      'intent-recorded',
      'completed',
      'completed',
      'completed',
    ]);
    expect(acceptEntries.map((entry) => entry.id)).toEqual([
      `attempt-1:accept:${HEAD_SHA}:0`,
      `attempt-1:accept:${HEAD_SHA}:1`,
      `attempt-1:accept:${HEAD_SHA}:2`,
      `attempt-1:accept:${HEAD_SHA}:3`,
    ]);
    expect(acceptancePort.requests).toHaveLength(1);
    expect(artifact.readBriefFileCalls).toBe(1);
  });

  it('rejects on a failing command, journals refused, and skips the assessment', async () => {
    const gate = new FakeGatePredicatePort({
      outcome: 'evaluated',
      results: [
        PASS_RESULTS[0],
        PASS_RESULTS[1],
        {
          name: 'command 1: corepack yarn build',
          kind: 'command',
          verdict: 'fail',
          exitCode: 2,
          durationMs: 1,
          detail: 'exit 2',
        },
      ],
    });
    const { deps, acceptancePort, journal } = makeDeps({ gate });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Gate predicate command 1: corepack yarn build fail with exit code 2: exit 2',
    });
    const acceptEntries = journal.entries.filter((entry) => entry.action === 'accept');
    expect(acceptEntries).toHaveLength(4);
    expect(acceptEntries[3].status).toBe('refused');
    const parsed = JSON.parse(acceptEntries[3].detail as string) as Record<string, unknown>;
    expect(parsed.predicate).toBe('command 1: corepack yarn build');
    expect(parsed.kind).toBe('command');
    expect(parsed.verdict).toBe('fail');
    expect(parsed.exitCode).toBe(2);
    expect(acceptancePort.requests).toHaveLength(0);
  });

  it('rejects naming the commit predicate when it fails and the rest are skipped', async () => {
    const gate = new FakeGatePredicatePort({
      outcome: 'evaluated',
      results: [
        { name: 'commit', kind: 'commit', verdict: 'fail', exitCode: null, durationMs: 1, detail: 'no commit since the base' },
        { name: 'diff-check', kind: 'diff-check', verdict: 'skipped', exitCode: null, durationMs: 0, detail: 'not run: an earlier predicate did not pass' },
        { name: 'command 1: corepack yarn build', kind: 'command', verdict: 'skipped', exitCode: null, durationMs: 0, detail: 'not run: an earlier predicate did not pass' },
      ],
    });
    const { deps, journal } = makeDeps({ gate });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('Gate predicate commit fail');
      expect(result.reason).toContain('no commit since the base');
    }
    const acceptEntries = journal.entries.filter((entry) => entry.action === 'accept');
    expect(acceptEntries.map((entry) => entry.status)).toEqual([
      'intent-recorded',
      'refused',
      'refused',
      'refused',
    ]);
  });

  it('rejects on an unknown command and journals it ambiguous', async () => {
    const gate = new FakeGatePredicatePort({
      outcome: 'evaluated',
      results: [
        PASS_RESULTS[0],
        PASS_RESULTS[1],
        { name: 'command 1: corepack yarn build', kind: 'command', verdict: 'unknown', exitCode: null, durationMs: 1, detail: 'no exit code' },
      ],
    });
    const { deps, journal } = makeDeps({ gate });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('Gate predicate command 1: corepack yarn build unknown');
    }
    const acceptEntries = journal.entries.filter((entry) => entry.action === 'accept');
    expect(acceptEntries[3].status).toBe('ambiguous');
  });

  it('keeps run 0 id and rejects a congested verdict like any other unknown', async () => {
    const gate = new FakeGatePredicatePort({
      outcome: 'evaluated',
      results: [
        PASS_RESULTS[0],
        PASS_RESULTS[1],
        {
          name: 'command 1: corepack yarn build',
          kind: 'command',
          verdict: 'unknown',
          exitCode: 75,
          durationMs: 1,
          detail: 'gate slot wait limit reached',
          cause: 'gate-slot-wait-limit',
        },
      ],
    });
    const { deps, journal, acceptancePort } = makeDeps({ gate });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result).toEqual({
      outcome: 'rejected',
      reason:
        'Gate predicate command 1: corepack yarn build unknown with exit code 75: gate slot wait limit reached',
    });
    const acceptEntries = journal.entries.filter((entry) => entry.action === 'accept');
    expect(acceptEntries.map((entry) => entry.id)).toEqual([
      `attempt-1:accept:${HEAD_SHA}:0`,
      `attempt-1:accept:${HEAD_SHA}:1`,
      `attempt-1:accept:${HEAD_SHA}:2`,
      `attempt-1:accept:${HEAD_SHA}:3`,
    ]);
    expect(acceptEntries[3].status).toBe('ambiguous');
    expect(acceptancePort.requests).toHaveLength(0);
  });

  it('rejects when the frozen brief manifest changed after preparation', async () => {
    const gate = new FakeGatePredicatePort(EVALUATED_ALL_PASS);
    const artifact = new FakeArtifactPort();
    artifact.manifest = MANIFEST + ' ';
    const { deps, journal, attempt } = makeDeps({ gate, artifact });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Frozen brief digest mismatch for attempt attempt-1: the brief or its manifest changed after it was prepared',
    });
    expect(gate.requests).toHaveLength(0);
    expect(journal.entries).toHaveLength(0);
    expect(attempt.briefDigest).toBe(simpleDeterministicHexDigest(PROSE + '\n' + MANIFEST));
  });

  it('rejects a manifest without an acceptance spec', async () => {
    const noSpecManifest = JSON.stringify(
      { baseCommit: BASE_COMMIT, allowedPathPrefixes: ['src'] },
      null,
      2,
    );
    const attempt = makeAttempt({
      briefPackagePath: '.lane/brief.md',
      briefDigest: simpleDeterministicHexDigest(PROSE + '\n' + noSpecManifest),
    });
    const artifact = new FakeArtifactPort();
    artifact.manifest = noSpecManifest;
    const { deps } = makeDeps({ gate: new FakeGatePredicatePort(EVALUATED_ALL_PASS), artifact, attempt });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason.startsWith('Frozen brief has no valid acceptance spec: ')).toBe(true);
    }
  });

  it('rejects when the manifest base commit does not match the attempt', async () => {
    const badBaseManifest = JSON.stringify(
      { baseCommit: 'c'.repeat(40), allowedPathPrefixes: ['src'], acceptanceSpec: SPEC },
      null,
      2,
    );
    const attempt = makeAttempt({
      briefPackagePath: '.lane/brief.md',
      briefDigest: simpleDeterministicHexDigest(PROSE + '\n' + badBaseManifest),
    });
    const artifact = new FakeArtifactPort();
    artifact.manifest = badBaseManifest;
    const { deps } = makeDeps({ gate: new FakeGatePredicatePort(EVALUATED_ALL_PASS), artifact, attempt });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Frozen brief base commit does not match the attempt base commit',
    });
  });

  it('rejects an attempt without a recorded frozen brief', async () => {
    const attempt = makeAttempt({
      briefPackagePath: null,
      briefDigest: simpleDeterministicHexDigest(PROSE + '\n' + MANIFEST),
    });
    const { deps } = makeDeps({ gate: new FakeGatePredicatePort(EVALUATED_ALL_PASS), attempt });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Attempt attempt-1 records no frozen brief; the gate cannot be read',
    });
  });

  it('requires the execution journal when the gate is wired', async () => {
    const gate = new FakeGatePredicatePort(EVALUATED_ALL_PASS);
    const { deps } = makeDeps({ gate, includeJournal: false });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Gate predicates need the execution journal',
    });
    expect(gate.requests).toHaveLength(0);
  });

  it('rejects with one ambiguous entry when the gate is unavailable', async () => {
    const gate = new FakeGatePredicatePort({ outcome: 'unavailable', reason: 'host gone' });
    const { deps, journal } = makeDeps({ gate });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Unknown: gate predicates unavailable: host gone',
    });
    const acceptEntries = journal.entries.filter((entry) => entry.action === 'accept');
    expect(acceptEntries.map((entry) => entry.status)).toEqual(['intent-recorded', 'ambiguous']);
  });

  it('behaves exactly as before when no gate is wired', async () => {
    const artifact = new FakeArtifactPort();
    const { deps, acceptancePort, journal } = makeDeps({ artifact });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result.outcome).toBe('accepted');
    expect(journal.entries).toHaveLength(0);
    expect(artifact.readBriefFileCalls).toBe(0);
    expect(acceptancePort.requests).toHaveLength(1);
  });

  it('refuses an evaluated response with empty, missing, extra or out-of-order results', async () => {
    const emptyGate = new FakeGatePredicatePort({ outcome: 'evaluated', results: [] });
    const { deps: emptyDeps, acceptancePort: emptyAcceptance } = makeDeps({ gate: emptyGate });
    const emptyResult = await new RequestAttemptAcceptanceUseCase(emptyDeps).requestAttemptAcceptance(
      acceptanceRequest(),
    );
    expect(emptyResult).toEqual({
      outcome: 'rejected',
      reason: 'Gate predicate results do not match the frozen acceptance spec',
    });
    expect(emptyAcceptance.requests).toHaveLength(0);

    const missingCommandGate = new FakeGatePredicatePort({
      outcome: 'evaluated',
      results: [PASS_RESULTS[0], PASS_RESULTS[1]],
    });
    const { deps: missingDeps, acceptancePort: missingAcceptance } = makeDeps({
      gate: missingCommandGate,
    });
    const missingResult = await new RequestAttemptAcceptanceUseCase(
      missingDeps,
    ).requestAttemptAcceptance(acceptanceRequest());
    expect(missingResult).toEqual({
      outcome: 'rejected',
      reason: 'Gate predicate results do not match the frozen acceptance spec',
    });
    expect(missingAcceptance.requests).toHaveLength(0);

    const outOfOrderGate = new FakeGatePredicatePort({
      outcome: 'evaluated',
      results: [PASS_RESULTS[1], PASS_RESULTS[0], PASS_RESULTS[2]],
    });
    const { deps: outOfOrderDeps, acceptancePort: outOfOrderAcceptance } = makeDeps({
      gate: outOfOrderGate,
    });
    const outOfOrderResult = await new RequestAttemptAcceptanceUseCase(
      outOfOrderDeps,
    ).requestAttemptAcceptance(acceptanceRequest());
    expect(outOfOrderResult).toEqual({
      outcome: 'rejected',
      reason: 'Gate predicate results do not match the frozen acceptance spec',
    });
    expect(outOfOrderAcceptance.requests).toHaveLength(0);

    const extraResultGate = new FakeGatePredicatePort({
      outcome: 'evaluated',
      results: [...PASS_RESULTS, PASS_RESULTS[2]],
    });
    const { deps: extraDeps, acceptancePort: extraAcceptance } = makeDeps({
      gate: extraResultGate,
    });
    const extraResult = await new RequestAttemptAcceptanceUseCase(extraDeps).requestAttemptAcceptance(
      acceptanceRequest(),
    );
    expect(extraResult).toEqual({
      outcome: 'rejected',
      reason: 'Gate predicate results do not match the frozen acceptance spec',
    });
    expect(extraAcceptance.requests).toHaveLength(0);
  });

  it('returns the same result on a second call after a completed run without running the gate again', async () => {
    const gate = new FakeGatePredicatePort(EVALUATED_ALL_PASS);
    const { deps } = makeDeps({ gate });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const first = await useCase.requestAttemptAcceptance(acceptanceRequest());
    const second = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(first.outcome).toBe('accepted');
    expect(second).toEqual(first);
    expect(gate.requests).toHaveLength(1);

    const failingGate = new FakeGatePredicatePort({
      outcome: 'evaluated',
      results: [
        PASS_RESULTS[0],
        PASS_RESULTS[1],
        {
          name: 'command 1: corepack yarn build',
          kind: 'command',
          verdict: 'fail',
          exitCode: 2,
          durationMs: 1,
          detail: 'exit 2',
        },
      ],
    });
    const { deps: failingDeps } = makeDeps({ gate: failingGate });
    const failingUseCase = new RequestAttemptAcceptanceUseCase(failingDeps);

    const firstFailed = await failingUseCase.requestAttemptAcceptance(acceptanceRequest());
    const secondFailed = await failingUseCase.requestAttemptAcceptance(acceptanceRequest());

    expect(firstFailed.outcome).toBe('rejected');
    expect(secondFailed).toEqual(firstFailed);
    expect(failingGate.requests).toHaveLength(1);
  });

  it('refuses without running the gate when an unfinished acceptance intent already exists', async () => {
    const gate = new FakeGatePredicatePort(EVALUATED_ALL_PASS);
    const journal = new InMemoryJournal();
    await journal.appendJournalEntry({
      id: `attempt-1:accept:${HEAD_SHA}:0`,
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      action: 'accept',
      baseCommit: BASE_COMMIT,
      recordedAtIso: FIXED_NOW,
      sessionId: 'session-1',
      status: 'intent-recorded',
      detail: `gate: 3 predicates for head ${HEAD_SHA}`,
    });
    const { deps, acceptancePort } = makeDeps({ gate, journal });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const result = await useCase.requestAttemptAcceptance(acceptanceRequest());

    expect(result).toEqual({
      outcome: 'rejected',
      reason: `Unknown: gate evaluation for head ${HEAD_SHA} has an unfinished intent in the journal`,
    });
    expect(gate.requests).toHaveLength(0);
    expect(acceptancePort.requests).toHaveLength(0);
  });

  it('runs the gate at most once across two concurrent calls and returns the same result', async () => {
    const gate = new FakeGatePredicatePort(EVALUATED_ALL_PASS);
    const { deps } = makeDeps({ gate });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const [first, second] = await Promise.all([
      useCase.requestAttemptAcceptance(acceptanceRequest()),
      useCase.requestAttemptAcceptance(acceptanceRequest()),
    ]);

    expect(first.outcome).toBe('accepted');
    expect(second).toEqual(first);
    expect(gate.requests).toHaveLength(1);
  });
});

function gateJournalEntry(partial: Partial<ActionJournalEntryRecord> & { id: string }): ActionJournalEntryRecord {
  return {
    attemptId: 'attempt-1',
    workOrderId: 'wo-1',
    action: 'accept',
    baseCommit: BASE_COMMIT,
    recordedAtIso: FIXED_NOW,
    sessionId: 'session-1',
    status: 'completed',
    detail: '',
    ...partial,
  };
}

function predicateEntry(head: string, n: number, result: GatePredicateResult): ActionJournalEntryRecord {
  return gateJournalEntry({
    id: `attempt-1:accept:${head}:${n}`,
    status: result.verdict === 'pass' ? 'completed' : result.verdict === 'fail' ? 'refused' : 'ambiguous',
    detail: JSON.stringify({
      predicate: result.name,
      kind: result.kind,
      verdict: result.verdict,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      detail: result.detail,
    }),
  });
}

describe('nonPassingGatePredicatesOf', () => {
  const headA = HEAD_SHA;
  const headB = 'abcdef0123456789abcdef0123456789abcdef01';

  it('returns only failing or unknown predicates for the given head, in numeric order', () => {
    const entries: ActionJournalEntryRecord[] = [
      predicateEntry(headA, 1, { name: 'commit', kind: 'commit', verdict: 'pass', exitCode: null, durationMs: 1, detail: 'ok' }),
      predicateEntry(headA, 2, { name: 'diff-check', kind: 'diff-check', verdict: 'fail', exitCode: 1, durationMs: 1, detail: 'bad' }),
      predicateEntry(headA, 3, { name: 'command 1: x', kind: 'command', verdict: 'unknown', exitCode: null, durationMs: 1, detail: '?' }),
      predicateEntry(headB, 1, { name: 'commit', kind: 'commit', verdict: 'fail', exitCode: null, durationMs: 1, detail: 'bad head b' }),
    ];
    expect(nonPassingGatePredicatesOf(entries, 'attempt-1', headA)).toEqual([
      { name: 'diff-check', kind: 'diff-check', verdict: 'fail', exitCode: 1 },
      { name: 'command 1: x', kind: 'command', verdict: 'unknown', exitCode: null },
    ]);
  });

  it('skips malformed entries and returns the rest in numeric id order', () => {
    const entries: ActionJournalEntryRecord[] = [
      gateJournalEntry({ id: `attempt-1:accept:${headA}:10`, detail: 'not json' }),
      gateJournalEntry({ id: `attempt-1:accept:${headA}:abc`, detail: JSON.stringify({ predicate: 'commit', kind: 'commit', verdict: 'fail', exitCode: null, durationMs: 1, detail: 'x' }) }),
      predicateEntry(headA, 5, { name: 'commit', kind: 'commit', verdict: 'fail', exitCode: null, durationMs: 1, detail: 'bad' }),
      predicateEntry(headA, 2, { name: 'a', kind: 'commit', verdict: 'unknown', exitCode: null, durationMs: 1, detail: '?' }),
    ];
    expect(nonPassingGatePredicatesOf(entries, 'attempt-1', headA)).toEqual([
      { name: 'a', kind: 'commit', verdict: 'unknown', exitCode: null },
      { name: 'commit', kind: 'commit', verdict: 'fail', exitCode: null },
    ]);
  });
});
