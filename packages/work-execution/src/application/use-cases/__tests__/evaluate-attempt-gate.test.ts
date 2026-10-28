// EvaluateAttemptGatePort tests — the conductor's gate step (K4-2).
/**
 * Covers the standalone gate behind RequestAttemptAcceptanceUseCase's
 * EvaluateAttemptGatePort: a typed verdict (passed, failed, unknown) at the
 * exact collected head, the stored outcome on a second call, and acceptance
 * rejection texts unchanged.
 */

import { describe, expect, it } from 'vitest';

import { RequestAttemptAcceptanceUseCase } from '../RequestAttemptAcceptanceUseCase.use-case.js';
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

function gateRequest(overrides: { attemptId?: string; candidateHeadSha?: string } = {}) {
  return { attemptId: 'attempt-1', candidateHeadSha: HEAD_SHA, ...overrides };
}

describe('evaluateAttemptGate (EvaluateAttemptGatePort)', () => {
  it('returns passed when every predicate passes, and reads the stored outcome on a second call', async () => {
    const gate = new FakeGatePredicatePort(EVALUATED_ALL_PASS);
    const { deps } = makeDeps({ gate });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const first = await useCase.evaluateAttemptGate(gateRequest());
    expect(first).toEqual({ verdict: 'passed' });
    expect(gate.requests).toHaveLength(1);

    const second = await useCase.evaluateAttemptGate(gateRequest());
    expect(second).toEqual({ verdict: 'passed' });
    expect(gate.requests).toHaveLength(1);
  });

  it('returns failed on a command fail; a later skipped result does not change the verdict', async () => {
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
    const { deps } = makeDeps({ gate });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const result = await useCase.evaluateAttemptGate(gateRequest());

    expect(result).toEqual({
      verdict: 'failed',
      reason: 'Gate predicate command 1: corepack yarn build fail with exit code 2: exit 2',
    });
  });

  it('returns unknown when the first non-pass result is a skip with no earlier fail', async () => {
    const gate = new FakeGatePredicatePort({
      outcome: 'evaluated',
      results: [
        { name: 'commit', kind: 'commit', verdict: 'skipped', exitCode: null, durationMs: 0, detail: 'not run: an earlier predicate did not pass' },
        ...PASS_RESULTS.slice(1),
      ],
    });
    const { deps } = makeDeps({ gate });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const result = await useCase.evaluateAttemptGate(gateRequest());

    expect(result.verdict).toBe('unknown');
    expect(result.verdict === 'unknown' && result.reason).toBe(
      'Gate predicate commit skipped: not run: an earlier predicate did not pass',
    );
  });

  it('returns unknown on a predicate unknown verdict', async () => {
    const gate = new FakeGatePredicatePort({
      outcome: 'evaluated',
      results: [
        PASS_RESULTS[0],
        PASS_RESULTS[1],
        {
          name: 'command 1: corepack yarn build',
          kind: 'command',
          verdict: 'unknown',
          exitCode: null,
          durationMs: 1,
          detail: 'could not run',
        },
      ],
    });
    const { deps } = makeDeps({ gate });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const result = await useCase.evaluateAttemptGate(gateRequest());

    expect(result.verdict).toBe('unknown');
  });

  it('returns unknown with the unavailable text when the gate port is unavailable', async () => {
    const gate = new FakeGatePredicatePort({ outcome: 'unavailable', reason: 'no runner' });
    const { deps } = makeDeps({ gate });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const result = await useCase.evaluateAttemptGate(gateRequest());

    expect(result).toEqual({
      verdict: 'unknown',
      reason: 'Unknown: gate predicates unavailable: no runner',
    });
  });

  it('returns unknown with the mismatch text when result names do not match the spec', async () => {
    const gate = new FakeGatePredicatePort({
      outcome: 'evaluated',
      results: [PASS_RESULTS[0], PASS_RESULTS[1], { ...PASS_RESULTS[2], name: 'command 9: other' }],
    });
    const { deps } = makeDeps({ gate });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const result = await useCase.evaluateAttemptGate(gateRequest());

    expect(result).toEqual({
      verdict: 'unknown',
      reason: 'Gate predicate results do not match the frozen acceptance spec',
    });
  });

  it('returns unknown when the frozen brief digest changed, without calling the gate port', async () => {
    const gate = new FakeGatePredicatePort(EVALUATED_ALL_PASS);
    const artifact = new FakeArtifactPort();
    artifact.manifest = JSON.stringify(
      { baseCommit: BASE_COMMIT, allowedPathPrefixes: ['src'], acceptanceSpec: SPEC },
      null,
      2,
    ) + '\n';
    const { deps } = makeDeps({ gate, artifact });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const result = await useCase.evaluateAttemptGate(gateRequest());

    expect(result.verdict).toBe('unknown');
    expect(gate.requests).toHaveLength(0);
  });

  it('returns unknown without a gate port call for a wrong head, a missing attempt, a running attempt and no gatePredicates', async () => {
    const gate = new FakeGatePredicatePort(EVALUATED_ALL_PASS);
    const { deps } = makeDeps({ gate });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const wrongHead = await useCase.evaluateAttemptGate(
      gateRequest({ candidateHeadSha: 'ffffffffffffffffffffffffffffffffffffffff' }),
    );
    expect(wrongHead).toEqual({ verdict: 'unknown', reason: 'Candidate head is not the collected head' });

    const missing = await useCase.evaluateAttemptGate(gateRequest({ attemptId: 'attempt-other' }));
    expect(missing).toEqual({ verdict: 'unknown', reason: 'Attempt not found' });

    const running = new RequestAttemptAcceptanceUseCase(
      makeDeps({ gate, attempt: makeAttempt({ state: 'running', artifacts: null }) }).deps,
    );
    const runningResult = await running.evaluateAttemptGate(gateRequest());
    expect(runningResult).toEqual({ verdict: 'unknown', reason: 'Attempt is not ready for the gate' });

    const unwired = new RequestAttemptAcceptanceUseCase(makeDeps({}).deps);
    const unwiredResult = await unwired.evaluateAttemptGate(gateRequest());
    expect(unwiredResult).toEqual({ verdict: 'unknown', reason: 'Gate predicates are not wired' });

    expect(gate.requests).toHaveLength(0);
  });

  it('keeps every acceptance rejection text identical to the typed reason', async () => {
    const failGate = new FakeGatePredicatePort({
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
    const unavailableGate = new FakeGatePredicatePort({ outcome: 'unavailable', reason: 'no runner' });
    const changedArtifact = new FakeArtifactPort();
    changedArtifact.manifest = MANIFEST + ' ';
    const failDeps = makeDeps({ gate: failGate }).deps;
    const unavailableDeps = makeDeps({ gate: unavailableGate }).deps;
    const changedDeps = makeDeps({ gate: new FakeGatePredicatePort(EVALUATED_ALL_PASS), artifact: changedArtifact }).deps;
    const failUseCase = new RequestAttemptAcceptanceUseCase(failDeps);
    const unavailableUseCase = new RequestAttemptAcceptanceUseCase(unavailableDeps);
    const changedUseCase = new RequestAttemptAcceptanceUseCase(changedDeps);

    const failTyped = await failUseCase.evaluateAttemptGate(gateRequest());
    const failAccepted = await new RequestAttemptAcceptanceUseCase(makeDeps({ gate: failGate }).deps)
      .requestAttemptAcceptance(acceptanceRequest());
    const unavailableTyped = await unavailableUseCase.evaluateAttemptGate(gateRequest());
    const unavailableAccepted = await new RequestAttemptAcceptanceUseCase(
      makeDeps({ gate: unavailableGate }).deps,
    ).requestAttemptAcceptance(acceptanceRequest());
    const changedTyped = await changedUseCase.evaluateAttemptGate(gateRequest());
    const changedAccepted = await new RequestAttemptAcceptanceUseCase(
      makeDeps({ gate: new FakeGatePredicatePort(EVALUATED_ALL_PASS), artifact: changedArtifact }).deps,
    ).requestAttemptAcceptance(acceptanceRequest());

    expect(failAccepted.outcome).toBe('rejected');
    expect(failAccepted.outcome === 'rejected' && failAccepted.reason).toBe(
      failTyped.verdict === 'failed' ? failTyped.reason : '',
    );
    expect(unavailableAccepted.outcome).toBe('rejected');
    expect(unavailableAccepted.outcome === 'rejected' && unavailableAccepted.reason).toBe(
      unavailableTyped.verdict === 'unknown' ? unavailableTyped.reason : '',
    );
    expect(changedAccepted.outcome).toBe('rejected');
    expect(changedAccepted.outcome === 'rejected' && changedAccepted.reason).toBe(
      changedTyped.verdict === 'unknown' ? changedTyped.reason : '',
    );
  });

  it('lets acceptance reuse a stored passed outcome without calling the gate port again', async () => {
    const gate = new FakeGatePredicatePort(EVALUATED_ALL_PASS);
    const { deps, acceptancePort } = makeDeps({ gate });
    const useCase = new RequestAttemptAcceptanceUseCase(deps);

    const gateResult = await useCase.evaluateAttemptGate(gateRequest());
    expect(gateResult).toEqual({ verdict: 'passed' });
    expect(gate.requests).toHaveLength(1);

    const acceptance = await useCase.requestAttemptAcceptance(acceptanceRequest());
    expect(acceptance.outcome).toBe('accepted');
    expect(gate.requests).toHaveLength(1);
    expect(acceptancePort.requests).toHaveLength(1);
  });
});
