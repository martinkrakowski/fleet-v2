// AutoMergeAttemptPort merge tests — AM4a-3, the grant, A7 and the forge.
/**
 * Covers AutoMergeAttemptUseCase's merge step: one policy grant at the
 * accepted head, the A7 re-read, the forge call with the grant id and the
 * decision revision, and §4 routing of forge outcomes. Tests 1 and 9 run the
 * real ExecuteAuthorizedForgeActionUseCase over the same in-memory stores;
 * everything else uses recording fakes. Fakes only, no network, no state dir.
 */

import { describe, expect, it } from 'vitest';

import { AutoMergeAttemptUseCase } from '../AutoMergeAttemptUseCase.use-case.js';
import type { AutoMergeAttemptDependencies } from '../AutoMergeAttemptUseCase.use-case.js';
import { ExecuteAuthorizedForgeActionUseCase } from '../ExecuteAuthorizedForgeActionUseCase.use-case.js';
import type {
  AutoMergeSettingsAnswer,
  AutoMergeSettingsPort,
} from '../../ports/out/AutoMergeSettingsPort.out-port.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../../ports/out/ExecutionJournalPort.out-port.js';
import type {
  AttemptOwnerDecisionPort,
  AttemptOwnerDecisionResult,
} from '../../ports/out/AttemptOwnerDecisionPort.out-port.js';
import type {
  EvaluateAttemptGatePort,
  EvaluateAttemptGateResult,
} from '../../ports/in/EvaluateAttemptGatePort.in-port.js';
import type {
  AcceptanceAssessmentPort,
  AcceptanceAssessmentRequest,
  AcceptanceAssessmentResult,
} from '../../ports/out/AcceptanceAssessmentPort.out-port.js';
import type {
  AutoMergeOwnerRoutingPort,
  AutoMergeNotice,
} from '../../ports/out/AutoMergeOwnerRoutingPort.out-port.js';
import type {
  PolicyMergeGrantPort,
  PolicyMergeGrantRequest,
  PolicyMergeGrantResult,
} from '../../ports/out/PolicyMergeGrantPort.out-port.js';
import type {
  ExecuteAuthorizedForgeActionPort,
  ExecuteAuthorizedForgeActionRequest,
  ExecuteAuthorizedForgeActionResult,
} from '../../ports/in/ExecuteAuthorizedForgeActionPort.in-port.js';
import type {
  ActionAuthorizationPort,
  ConsumeActionAuthorizationRequest,
  ResolveActionAuthorizationResult,
} from '../../ports/out/ActionAuthorizationPort.out-port.js';
import type { AcceptanceEvidencePort, ReadAcceptanceResult } from '../../ports/out/AcceptanceEvidencePort.out-port.js';
import type { ForgeActionPort, ForgeActionResult, ForgeActionRequest } from '../../ports/out/ForgeActionPort.out-port.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { WorkOrderRepositoryAdapter } from '../../../infrastructure/adapters/WorkOrderRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';
import type { AutoMergeReason } from '../../../domain/auto-merge.js';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const FIXED_NOW = '2026-10-28T09:00:00.000Z';
const ATTEMPT_ID = 'attempt-example-1';
const WORK_ORDER_ID = 'wo-example-1';
const REVISION = '0123456789ab';
const DECISION_REVISION = 'policy:autoMerge@0123456789ab';
const RECEIPT = 'receipt-example-1';
const POLICY_REVISION = 'policy-example-1';

function makeWorkOrder(overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id: WORK_ORDER_ID,
    projectId: 'project-example',
    taskId: 'task-example-1',
    laneId: 'lane-example',
    repository: 'repo-example',
    baseCommit: BASE,
    ownedPaths: ['src/example.ts'],
    policyRevision: POLICY_REVISION,
    prerequisiteWorkOrderIds: [],
    state: 'ready-to-merge',
    revision: 1,
    createdAtIso: FIXED_NOW,
    updatedAtIso: FIXED_NOW,
    risk: 'standard',
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: ATTEMPT_ID,
    workOrderId: WORK_ORDER_ID,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/tmp/opencode/lanes/attempt-example-1',
    baseCommit: BASE,
    state: 'collected',
    outcome: 'done',
    briefDigest: 'digest-example',
    briefPackagePath: null,
    sessionId: 'session-example-1',
    completionReceipt: null,
    artifacts: {
      headCommit: HEAD,
      commitsSinceBase: [HEAD],
      collectedArtifactPaths: [],
      notes: 'present',
    },
    runner: null,
    createdAtIso: FIXED_NOW,
    updatedAtIso: FIXED_NOW,
    ...overrides,
  };
}

function forgeEntry(
  overrides: Partial<ActionJournalEntryRecord> & { id: string; attemptId: string },
): ActionJournalEntryRecord {
  return {
    workOrderId: WORK_ORDER_ID,
    action: 'forge' as const,
    status: 'intent-recorded' as const,
    baseCommit: BASE,
    recordedAtIso: FIXED_NOW,
    sessionId: null,
    detail: null,
    ...overrides,
  };
}

class FakeSettings implements AutoMergeSettingsPort {
  calls = 0;
  answer: AutoMergeSettingsAnswer = {
    outcome: 'read',
    enabled: true,
    allowHighRisk: false,
    onBlocked: 'ask-owner',
    revision: REVISION,
    forgeMode: 'github',
  };
  answers: AutoMergeSettingsAnswer[] = [];
  throws = false;

  async readAutoMergeSettings(): Promise<AutoMergeSettingsAnswer> {
    this.calls += 1;
    if (this.throws) {
      throw new Error('settings unavailable');
    }
    if (this.answers.length > 0) {
      return this.answers[Math.min(this.calls - 1, this.answers.length - 1)] ?? this.answer;
    }
    return this.answer;
  }
}

class FakeDoors implements AttemptOwnerDecisionPort {
  calls = 0;
  result: AttemptOwnerDecisionResult = { outcome: 'recorded', ownerDecisionReferences: [] };
  throws = false;

  async readAttemptOwnerDecisionReferences(): Promise<AttemptOwnerDecisionResult> {
    this.calls += 1;
    if (this.throws) {
      throw new Error('doors unavailable');
    }
    return this.result;
  }
}

class FakeGate implements EvaluateAttemptGatePort {
  calls = 0;
  result: EvaluateAttemptGateResult = { verdict: 'passed' };
  throws = false;

  async evaluateAttemptGate(): Promise<EvaluateAttemptGateResult> {
    this.calls += 1;
    if (this.throws) {
      throw new Error('gate unavailable');
    }
    return this.result;
  }
}

class FakeAcceptance implements AcceptanceAssessmentPort {
  calls = 0;
  requests: AcceptanceAssessmentRequest[] = [];
  result: AcceptanceAssessmentResult = {
    outcome: 'accepted',
    receiptId: RECEIPT,
    assessedHeadSha: HEAD,
  };
  throws = false;

  async assessHeadAcceptance(request: AcceptanceAssessmentRequest): Promise<AcceptanceAssessmentResult> {
    this.calls += 1;
    this.requests.push(request);
    if (this.throws) {
      throw new Error('acceptance unavailable');
    }
    return this.result;
  }
}

interface RecordedNotice {
  readonly method: 'askOwner' | 'recordAttention';
  readonly notice: AutoMergeNotice;
}

class FakeRouting implements AutoMergeOwnerRoutingPort {
  calls: RecordedNotice[] = [];
  answer: { outcome: 'recorded' } | { outcome: 'exists' } = { outcome: 'recorded' };
  throws = false;

  async askOwner(notice: AutoMergeNotice) {
    return this.record('askOwner', notice);
  }

  async recordAttention(notice: AutoMergeNotice) {
    return this.record('recordAttention', notice);
  }

  private async record(method: RecordedNotice['method'], notice: AutoMergeNotice) {
    this.calls.push({ method, notice });
    if (this.throws) {
      throw new Error('routing unavailable');
    }
    return this.answer;
  }
}

class FakeGrant implements PolicyMergeGrantPort {
  calls = 0;
  requests: PolicyMergeGrantRequest[] = [];
  answer: PolicyMergeGrantResult = {
    outcome: 'issued',
    grantId: 'grant-example-1',
    decisionRevision: DECISION_REVISION,
  };
  throws = false;

  async issuePolicyMergeGrant(request: PolicyMergeGrantRequest): Promise<PolicyMergeGrantResult> {
    this.calls += 1;
    this.requests.push(request);
    if (this.throws) {
      throw new Error('grant unavailable');
    }
    return this.answer;
  }
}

class FakeForge implements ExecuteAuthorizedForgeActionPort {
  calls = 0;
  requests: ExecuteAuthorizedForgeActionRequest[] = [];
  answer: ExecuteAuthorizedForgeActionResult = { outcome: 'executed', headSha: HEAD };
  throws = false;
  onCall?: () => Promise<void>;

  async executeAuthorizedForgeAction(
    request: ExecuteAuthorizedForgeActionRequest,
  ): Promise<ExecuteAuthorizedForgeActionResult> {
    this.calls += 1;
    this.requests.push(request);
    if (this.onCall) {
      await this.onCall();
    }
    if (this.throws) {
      throw new Error('forge unavailable');
    }
    return this.answer;
  }
}

class FakeForgeActionPort implements ForgeActionPort {
  readonly requests: ForgeActionRequest[] = [];
  result: ForgeActionResult;

  constructor(result: ForgeActionResult = { outcome: 'executed', headSha: HEAD }) {
    this.result = result;
  }

  isConfigured(): boolean {
    return true;
  }

  async performForgeAction(request: ForgeActionRequest): Promise<ForgeActionResult> {
    this.requests.push(request);
    return this.result;
  }
}

class FakeActionAuthorizationPort implements ActionAuthorizationPort {
  readonly consumeRequests: ConsumeActionAuthorizationRequest[] = [];

  async resolveActionAuthorization(): Promise<ResolveActionAuthorizationResult> {
    return { outcome: 'granted', authorizationGrantId: 'grant-example-1' };
  }

  async consumeActionAuthorization(request: ConsumeActionAuthorizationRequest) {
    this.consumeRequests.push(request);
    return { outcome: 'consumed' as const, actionId: request.actionId };
  }
}

class FakeAcceptanceEvidence implements AcceptanceEvidencePort {
  async readAcceptance(): Promise<ReadAcceptanceResult> {
    return {
      outcome: 'found',
      assessment: {
        state: 'accepted',
        candidateHeadSha: HEAD,
        policyRevision: POLICY_REVISION,
        acceptanceReceiptId: RECEIPT,
      },
    };
  }
}

interface Built {
  settings: FakeSettings;
  doors: FakeDoors;
  gate: FakeGate;
  acceptance: FakeAcceptance;
  routing: FakeRouting;
  grant: FakeGrant;
  forge: FakeForge;
  forgeActionPort?: FakeForgeActionPort;
  attemptRepo: AttemptRepositoryPort;
  workOrderRepo: WorkOrderRepositoryPort;
  journal: ExecutionJournalPort;
  deps: AutoMergeAttemptDependencies;
  run(): ReturnType<AutoMergeAttemptUseCase['autoMergeAttempt']>;
}

function build(overrides: Partial<AutoMergeAttemptDependencies> = {}): Built {
  const settings = new FakeSettings();
  const doors = new FakeDoors();
  const gate = new FakeGate();
  const acceptance = new FakeAcceptance();
  const routing = new FakeRouting();
  const grant = new FakeGrant();
  const forge = new FakeForge();

  const attemptRepo = new AttemptRepositoryAdapter();
  const workOrderRepo = new WorkOrderRepositoryAdapter();
  const journal = new ExecutionJournalAdapter();

  const deps: AutoMergeAttemptDependencies = {
    settings,
    attemptRepo,
    workOrderRepo,
    journal,
    attemptOwnerDecisionPort: doors,
    evaluateAttemptGate: gate,
    acceptancePort: acceptance,
    routing,
    policyMergeGrant: grant,
    executeForgeAction: forge,
    nowIso: () => FIXED_NOW,
    ...overrides,
  };
  const useCase = new AutoMergeAttemptUseCase(deps);
  return {
    settings,
    doors,
    gate,
    acceptance,
    routing,
    grant,
    forge,
    attemptRepo,
    workOrderRepo,
    journal,
    deps,
    run: () => useCase.autoMergeAttempt({ attemptId: ATTEMPT_ID }),
  };
}

function buildWithRealForge(options: { forgeResult?: ForgeActionResult } = {}): Built {
  const settings = new FakeSettings();
  const doors = new FakeDoors();
  const gate = new FakeGate();
  const acceptance = new FakeAcceptance();
  const routing = new FakeRouting();
  const grant = new FakeGrant();

  const attemptRepo = new AttemptRepositoryAdapter();
  const workOrderRepo = new WorkOrderRepositoryAdapter();
  const journal = new ExecutionJournalAdapter();

  const forgeActionPort = new FakeForgeActionPort(options.forgeResult);
  const authorizationPort = new FakeActionAuthorizationPort();
  const acceptanceEvidencePort = new FakeAcceptanceEvidence();
  const forgeUseCase = new ExecuteAuthorizedForgeActionUseCase({
    attemptRepo,
    workOrderRepo,
    journal,
    authorizationPort,
    forgePort: forgeActionPort,
    acceptanceEvidencePort,
    attemptOwnerDecisionPort: {
      async readAttemptOwnerDecisionReferences() {
        return { outcome: 'recorded', ownerDecisionReferences: [] };
      },
    },
    forgeMode: 'github',
    now: () => FIXED_NOW,
  });

  const deps: AutoMergeAttemptDependencies = {
    settings,
    attemptRepo,
    workOrderRepo,
    journal,
    attemptOwnerDecisionPort: doors,
    evaluateAttemptGate: gate,
    acceptancePort: acceptance,
    routing,
    policyMergeGrant: grant,
    executeForgeAction: forgeUseCase,
    nowIso: () => FIXED_NOW,
  };
  const useCase = new AutoMergeAttemptUseCase(deps);
  return {
    settings,
    doors,
    gate,
    acceptance,
    routing,
    grant,
    forge: new FakeForge(),
    forgeActionPort,
    attemptRepo,
    workOrderRepo,
    journal,
    deps,
    run: () => useCase.autoMergeAttempt({ attemptId: ATTEMPT_ID }),
  };
}

async function seed(built: Built): Promise<void> {
  await built.attemptRepo.saveAttempt(makeAttempt());
  await built.workOrderRepo.saveWorkOrder(makeWorkOrder());
}

describe('AutoMergeAttemptUseCase (AM4a-3)', () => {
  it('merges a standard lane exactly once through the real forge use case', async () => {
    const built = buildWithRealForge();
    await seed(built);
    const result = await built.run();
    expect(result).toEqual({
      outcome: 'merged',
      attemptId: ATTEMPT_ID,
      headSha: HEAD,
      decisionRevision: DECISION_REVISION,
    });
    expect(built.grant.calls).toBe(1);
    expect(built.grant.requests[0]).toEqual({
      projectId: 'project-example',
      workOrderId: WORK_ORDER_ID,
      attemptId: ATTEMPT_ID,
      expectedHeadSha: HEAD,
      policyRevision: POLICY_REVISION,
      acceptanceReceiptId: RECEIPT,
      settingRevision: REVISION,
    });
    expect(built.forgeActionPort?.requests).toHaveLength(1);
    expect(built.forgeActionPort?.requests[0]?.kind).toBe('merge-pr');
    expect(built.forgeActionPort?.requests[0]?.branchName).toBe('feat/lane-example');
    const workOrder = await built.workOrderRepo.findWorkOrderById(WORK_ORDER_ID);
    expect(workOrder?.state).toBe('merged');
    const entries = await built.journal.listJournalEntriesForAttempt(ATTEMPT_ID);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.id.startsWith('forge:auto-merge:' + ATTEMPT_ID + ':')).toBe(true);
      expect(entry.authorizedBy).toBe(DECISION_REVISION);
    }
  });

  it('passes the issued grant id, head, attempt and policy revision to the forge', async () => {
    const built = build();
    built.grant.answer = { outcome: 'issued', grantId: 'grant-policy-distinct-7', decisionRevision: DECISION_REVISION };
    await seed(built);
    await built.run();
    expect(built.forge.calls).toBe(1);
    expect(built.forge.requests[0]).toMatchObject({
      attemptId: ATTEMPT_ID,
      workOrderId: WORK_ORDER_ID,
      kind: 'merge-pr',
      expectedHeadSha: HEAD,
      authorizationGrantId: 'grant-policy-distinct-7',
      authorizedBy: DECISION_REVISION,
    });
  });

  it('caps forge text in the result and the routed lines for ambiguous and refused outcomes', async () => {
    const long = 'x'.repeat(5000);
    for (const answer of [
      { outcome: 'refused', reason: long, forgeAmbiguous: true },
      { outcome: 'refused', reason: long, forgeRefusalKind: 'conflict' },
    ] as const) {
      const built = build();
      built.forge.answer = answer as typeof built.forge.answer;
      await seed(built);
      const result = await built.run();
      expect(result).toMatchObject({ outcome: 'not-merged' });
      expect(JSON.stringify(result)).not.toContain('x'.repeat(301));
      expect(JSON.stringify(built.routing)).not.toContain('x'.repeat(301));
    }
  });

  it('never merges a closed work order twice', async () => {
    const built = buildWithRealForge();
    await seed(built);
    const first = await built.run();
    expect(first.outcome).toBe('merged');
    const second = await built.run();
    expect(second).toMatchObject({ outcome: 'not-merged', reason: 'work-order-closed' });
    expect(built.grant.calls).toBe(1);
  });

  it('honours the high-risk opt-in and stops when the setting changes after the grant', async () => {
    const optIn = buildWithRealForge();
    optIn.settings.answer = {
      outcome: 'read',
      enabled: true,
      allowHighRisk: true,
      onBlocked: 'ask-owner',
      revision: REVISION,
      forgeMode: 'github',
    };
    await seed(optIn);
    await optIn.workOrderRepo.saveWorkOrder(makeWorkOrder({ risk: 'high', revision: 2 }));
    const merged = await optIn.run();
    expect(merged).toMatchObject({ outcome: 'merged', decisionRevision: DECISION_REVISION });

    const changed = build();
    changed.settings.answers = [
      {
        outcome: 'read',
        enabled: true,
        allowHighRisk: true,
        onBlocked: 'ask-owner',
        revision: REVISION,
        forgeMode: 'github',
      },
      {
        outcome: 'read',
        enabled: true,
        allowHighRisk: true,
        onBlocked: 'ask-owner',
        revision: 'ffffffffffff',
        forgeMode: 'github',
      },
    ];
    await seed(changed);
    await changed.workOrderRepo.saveWorkOrder(makeWorkOrder({ risk: 'high', revision: 2 }));
    const result = await changed.run();
    expect(result).toMatchObject({ outcome: 'not-merged', reason: 'setting-changed' });
    expect(changed.grant.calls).toBe(1);
    expect(changed.forge.calls).toBe(0);
  });

  it('routes every grant refusal and a revision mismatch without calling the forge', async () => {
    const cases: Array<{
      name: string;
      prepare: (grant: FakeGrant) => void;
      expectedReason: AutoMergeReason;
      route: 'attention' | 'none';
    }> = [
      {
        name: 'refused',
        prepare: (grant) => {
          grant.answer = { outcome: 'refused', reason: 'no active policy' };
        },
        expectedReason: 'grant-refused',
        route: 'attention',
      },
      {
        name: 'superseded',
        prepare: (grant) => {
          grant.answer = { outcome: 'superseded' };
        },
        expectedReason: 'grant-superseded',
        route: 'none',
      },
      {
        name: 'revision mismatch',
        prepare: (grant) => {
          grant.answer = { outcome: 'issued', grantId: 'grant-example-1', decisionRevision: 'policy:autoMerge@ffffffffffff' };
        },
        expectedReason: 'grant-revision-mismatch',
        route: 'attention',
      },
      {
        name: 'throw',
        prepare: (grant) => {
          grant.throws = true;
        },
        expectedReason: 'grant-refused',
        route: 'attention',
      },
    ];
    for (const testCase of cases) {
      const built = build();
      testCase.prepare(built.grant);
      await seed(built);
      const result = await built.run();
      expect(result).toMatchObject({ outcome: 'not-merged', reason: testCase.expectedReason, route: testCase.route });
      expect(built.forge.calls).toBe(0);
    }
  });

  it('asks the owner for every forge refusal kind and never issues a second grant for the head', async () => {
    const kinds = ['conflict', 'protection', 'permission', 'other'] as const;
    for (const kind of kinds) {
      for (const onBlocked of ['ask-owner', 'hold'] as const) {
        const built = build();
        built.settings.answer = {
          outcome: 'read',
          enabled: true,
          allowHighRisk: false,
          onBlocked,
          revision: REVISION,
          forgeMode: 'github',
        };
        built.forge.answer = {
          outcome: 'refused',
          reason: 'gh pr merge refused: ' + kind,
          forgeRefusalKind: kind,
        };
        await seed(built);
        const result = await built.run();
        expect(result).toMatchObject({
          outcome: 'not-merged',
          reason: 'forge-refused',
          route: 'owner-question',
        });
        expect(built.routing.calls).toHaveLength(1);
        expect(built.routing.calls[0]?.method).toBe('askOwner');
        expect(built.routing.calls[0]?.notice.lines).toEqual([
          'refusal kind: ' + kind,
          'gh pr merge refused: ' + kind,
        ]);
        expect(built.grant.calls).toBe(1);
        expect(built.forge.calls).toBe(1);
      }
    }

    const built = build();
    built.forge.answer = { outcome: 'refused', reason: 'blocked', forgeRefusalKind: 'conflict' };
    await seed(built);
    await built.run();
    await built.journal.appendJournalEntry(
      forgeEntry({ id: 'forge:auto-merge:' + ATTEMPT_ID + ':' + HEAD + ':intent-recorded:1', attemptId: ATTEMPT_ID }),
    );
    await built.journal.appendJournalEntry(
      forgeEntry({
        id: 'forge:auto-merge:' + ATTEMPT_ID + ':' + HEAD + ':refused:2',
        attemptId: ATTEMPT_ID,
        status: 'refused',
      }),
    );
    const second = await built.run();
    expect(second).toMatchObject({ outcome: 'not-merged', reason: 'already-attempted', route: 'none' });
    expect(built.grant.calls).toBe(1);
  });

  it('treats ambiguous and thrown forge outcomes as ambiguous and suspends the next run', async () => {
    const ambiguous = build();
    ambiguous.forge.answer = { outcome: 'refused', reason: 'merge request timed out', forgeAmbiguous: true };
    await seed(ambiguous);
    const first = await ambiguous.run();
    expect(first).toMatchObject({ outcome: 'not-merged', reason: 'forge-ambiguous', route: 'attention' });
    expect(ambiguous.routing.calls).toHaveLength(1);
    expect(ambiguous.routing.calls[0]?.method).toBe('recordAttention');

    const thrown = build();
    thrown.forge.throws = true;
    await seed(thrown);
    const thrownResult = await thrown.run();
    expect(thrownResult).toMatchObject({ outcome: 'not-merged', reason: 'forge-ambiguous', route: 'attention' });

    const suspended = build();
    await seed(suspended);
    await suspended.journal.appendJournalEntry(
      forgeEntry({
        id: 'forge:auto-merge:' + ATTEMPT_ID + ':' + HEAD + ':intent-recorded:1',
        attemptId: ATTEMPT_ID,
        status: 'ambiguous',
      }),
    );
    const suspendedResult = await suspended.run();
    expect(suspendedResult).toMatchObject({ outcome: 'not-merged', reason: 'forge-suspended', route: 'attention' });
    expect(suspended.grant.calls).toBe(0);
  });

  it('reads a moved stored head after a kindless refusal and records a pre-grant refusal otherwise', async () => {
    const moved = build();
    moved.forge.answer = { outcome: 'refused', reason: 'gh pr merge failed' };
    moved.forge.onCall = async () => {
      await moved.attemptRepo.saveAttempt(
        makeAttempt({
          revision: 1,
          artifacts: {
            headCommit: OTHER_HEAD,
            commitsSinceBase: [OTHER_HEAD],
            collectedArtifactPaths: [],
            notes: 'present',
          },
        }),
      );
    };
    await seed(moved);
    const movedResult = await moved.run();
    expect(movedResult).toMatchObject({ outcome: 'not-merged', reason: 'head-moved', route: 'none' });
    expect(moved.routing.calls).toHaveLength(0);

    const unchanged = build();
    unchanged.forge.answer = { outcome: 'refused', reason: 'gh pr merge failed' };
    await seed(unchanged);
    const unchangedResult = await unchanged.run();
    expect(unchangedResult).toMatchObject({
      outcome: 'not-merged',
      reason: 'forge-refused-before-grant',
      route: 'attention',
    });
    expect(unchanged.routing.calls).toHaveLength(1);
    expect(unchanged.routing.calls[0]?.method).toBe('recordAttention');
    expect(unchanged.routing.calls[0]?.notice.lines).toEqual(['gh pr merge failed']);
  });

  it('stops at an unreadable setting on the A7 re-read', async () => {
    const built = build();
    built.settings.answers = [
      {
        outcome: 'read',
        enabled: true,
        allowHighRisk: false,
        onBlocked: 'ask-owner',
        revision: REVISION,
        forgeMode: 'github',
      },
      { outcome: 'unreadable', reason: 'malformed' },
    ];
    await seed(built);
    const result = await built.run();
    expect(result).toMatchObject({ outcome: 'not-merged', reason: 'setting-changed' });
    expect(built.grant.calls).toBe(1);
    expect(built.forge.calls).toBe(0);
  });

  it('merges when the forge adapter reports executed after a refusal round-trip (A13)', async () => {
    const built = buildWithRealForge({ forgeResult: { outcome: 'executed', headSha: HEAD } });
    await seed(built);
    const result = await built.run();
    expect(result).toEqual({
      outcome: 'merged',
      attemptId: ATTEMPT_ID,
      headSha: HEAD,
      decisionRevision: DECISION_REVISION,
    });
  });

  it("forwards the run's recorded branch on the merge-pr action (KF-5b)", async () => {
    const built = build();
    await seed(built);
    const useCase = new AutoMergeAttemptUseCase(built.deps);
    const result = await useCase.autoMergeAttempt({
      attemptId: ATTEMPT_ID,
      branchName: 'fleet/run-01JB0000000000000000000000',
    });
    expect(result).toMatchObject({ outcome: 'merged' });
    expect(built.forge.calls).toBe(1);
    expect(built.forge.requests[0]?.branchName).toBe('fleet/run-01JB0000000000000000000000');
  });

  it('omits branchName on the merge-pr action when the request does not carry one (KF-5b)', async () => {
    const built = build();
    await seed(built);
    await built.run();
    expect(built.forge.calls).toBe(1);
    expect(built.forge.requests[0]).not.toHaveProperty('branchName');
  });
});
