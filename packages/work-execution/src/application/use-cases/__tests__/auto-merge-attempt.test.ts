// AutoMergeAttemptPort tests — AM4a-2, the use case up to the merge.
/**
 * Covers AutoMergeAttemptUseCase: off is today's behaviour with nothing
 * written; unreadable facts route to attention; eligibility (A4), the gate,
 * the exact-head acceptance evidence, the single ci-pending first look and
 * §4 routing. An eligible attempt merges through the grant and the forge
 * (AM4a-3). Fakes only.
 */

import { describe, expect, it } from 'vitest';

import { AutoMergeAttemptUseCase } from '../AutoMergeAttemptUseCase.use-case.js';
import type { AutoMergeAttemptDependencies } from '../AutoMergeAttemptUseCase.use-case.js';
import type { AutoMergeSettingsAnswer, AutoMergeSettingsPort } from '../../ports/out/AutoMergeSettingsPort.out-port.js';
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
import type { AutoMergeOwnerRoutingPort, AutoMergeNotice } from '../../ports/out/AutoMergeOwnerRoutingPort.out-port.js';
import type { PolicyMergeGrantPort, PolicyMergeGrantResult } from '../../ports/out/PolicyMergeGrantPort.out-port.js';
import type {
  ExecuteAuthorizedForgeActionPort,
  ExecuteAuthorizedForgeActionResult,
} from '../../ports/in/ExecuteAuthorizedForgeActionPort.in-port.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { WorkOrderRepositoryAdapter } from '../../../infrastructure/adapters/WorkOrderRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';
import { autoMergeFirstLookEntryId, autoMergeRoutingKey } from '../../../domain/auto-merge.js';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const FIXED_NOW = '2026-10-28T09:00:00.000Z';
const ATTEMPT_ID = 'attempt-example-1';
const WORK_ORDER_ID = 'wo-example-1';

function makeWorkOrder(overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id: WORK_ORDER_ID,
    projectId: 'project-example',
    taskId: 'task-example-1',
    laneId: 'lane-example',
    repository: 'repo-example',
    baseCommit: BASE,
    ownedPaths: ['src/example.ts'],
    policyRevision: 'policy-example-1',
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
    revision: '0123456789ab',
    forgeMode: 'github',
  };
  throws = false;

  async readAutoMergeSettings(): Promise<AutoMergeSettingsAnswer> {
    this.calls += 1;
    if (this.throws) {
      throw new Error('settings unavailable');
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
    receiptId: 'receipt-example-1',
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

  async assessHeadReceipts(): Promise<never> {
    throw new Error('assessHeadReceipts is not used by this test');
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
  answer: PolicyMergeGrantResult = {
    outcome: 'issued',
    grantId: 'grant-example-1',
    decisionRevision: 'policy:autoMerge@0123456789ab',
  };

  async issuePolicyMergeGrant(): Promise<PolicyMergeGrantResult> {
    this.calls += 1;
    return this.answer;
  }
}

class FakeForge implements ExecuteAuthorizedForgeActionPort {
  calls = 0;
  answer: ExecuteAuthorizedForgeActionResult = { outcome: 'executed', headSha: HEAD };

  async executeAuthorizedForgeAction(): Promise<ExecuteAuthorizedForgeActionResult> {
    this.calls += 1;
    return this.answer;
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

async function seed(built: Built): Promise<void> {
  await built.attemptRepo.saveAttempt(makeAttempt());
  await built.workOrderRepo.saveWorkOrder(makeWorkOrder());
}

describe('AutoMergeAttemptUseCase (AM4a-2)', () => {
  it('reads nothing and writes nothing when the setting is off', async () => {
    const attemptRepo = new AttemptRepositoryAdapter();
    let findCalls = 0;
    const spyAttemptRepo: AttemptRepositoryPort = {
      findAttemptById: async (attemptId: string) => {
        findCalls += 1;
        return attemptRepo.findAttemptById(attemptId);
      },
      saveAttempt: (record) => attemptRepo.saveAttempt(record),
      listAttemptsByWorkOrder: (workOrderId) => attemptRepo.listAttemptsByWorkOrder(workOrderId),
      listAllAttempts: () => attemptRepo.listAllAttempts(),
    };
    const built = build({ attemptRepo: spyAttemptRepo });
    built.settings.answer = {
      outcome: 'read',
      enabled: false,
      allowHighRisk: true,
      onBlocked: 'ask-owner',
      revision: '0123456789ab',
      forgeMode: 'github',
    };
    await seed(built);
    const result = await built.run();
    expect(result).toEqual({ outcome: 'off' });
    expect(findCalls).toBe(0);
    expect(built.doors.calls).toBe(0);
    expect(built.gate.calls).toBe(0);
    expect(built.acceptance.calls).toBe(0);
    expect(built.routing.calls).toHaveLength(0);
    expect(await built.journal.listJournalEntriesForAttempt(ATTEMPT_ID)).toHaveLength(0);
  });

  it('routes an unreadable setting to attention and never asks acceptance', async () => {
    const variants: Array<(built: Built) => void> = [
      (built) => {
        built.settings.answer = { outcome: 'unreadable', reason: 'malformed' };
      },
      (built) => {
        built.settings.throws = true;
      },
      (built) => {
        built.settings.answer = {
          outcome: 'read',
          enabled: true,
          allowHighRisk: true,
          onBlocked: 'later' as never,
          revision: '0123456789ab',
          forgeMode: 'github',
        };
      },
    ];
    for (const prepare of variants) {
      const built = build();
      prepare(built);
      await seed(built);
      const result = await built.run();
      expect(result.outcome).toBe('not-merged');
      if (result.outcome === 'not-merged') {
        expect(result.reason).toBe('settings-unreadable');
        expect(result.route).toBe('attention');
        expect(result.routeOutcome).toBe('recorded');
      }
      expect(built.routing.calls).toHaveLength(1);
      expect(built.routing.calls[0]?.method).toBe('recordAttention');
      expect(built.acceptance.calls).toBe(0);
    }
  });

  it('reports a missing attempt, a missing work order and a throwing repository without routing', async () => {
    const missingAttempt = build();
    const missingResult = await missingAttempt.run();
    expect(missingResult).toMatchObject({ outcome: 'not-merged', reason: 'attempt-missing', route: 'none' });
    expect(missingAttempt.routing.calls).toHaveLength(0);

    const missingWorkOrder = build();
    await missingWorkOrder.attemptRepo.saveAttempt(makeAttempt({ workOrderId: 'wo-example-9' }));
    const workOrderResult = await missingWorkOrder.run();
    expect(workOrderResult).toMatchObject({ outcome: 'not-merged', reason: 'work-order-missing', route: 'none' });
    expect(missingWorkOrder.routing.calls).toHaveLength(0);

    const throwing = build({
      attemptRepo: {
        findAttemptById: () => Promise.reject(new Error('store unavailable')),
      } as unknown as AttemptRepositoryPort,
    });
    // Records are unreadable before the work order is known, so no notice can address a project: route stays none despite the §4 attention rule.
    const throwingResult = await throwing.run();
    expect(throwingResult).toMatchObject({ outcome: 'not-merged', reason: 'records-unreadable', route: 'none' });
    expect(throwing.routing.calls).toHaveLength(0);
  });

  it('never merges a closed work order and never merges without a head', async () => {
    for (const state of ['merged', 'stopped'] as const) {
      const built = build();
      await seed(built);
      await built.workOrderRepo.saveWorkOrder(makeWorkOrder({ state, revision: 2 }));
      const result = await built.run();
      expect(result).toMatchObject({ outcome: 'not-merged', reason: 'work-order-closed', route: 'none' });
      expect(built.gate.calls).toBe(0);
    }
    for (const artifacts of [null, { headCommit: 'abc1234', commitsSinceBase: [], collectedArtifactPaths: [], notes: 'present' }]) {
      const built = build();
      await built.attemptRepo.saveAttempt(makeAttempt({ artifacts: artifacts as AttemptRecord['artifacts'] }));
      await built.workOrderRepo.saveWorkOrder(makeWorkOrder());
      const result = await built.run();
      expect(result).toMatchObject({ outcome: 'not-merged', reason: 'no-head', route: 'none' });
    }
  });

  it('suspends on an ambiguous forge entry of another attempt and never reaches the gate', async () => {
    const built = build();
    await seed(built);
    await built.attemptRepo.saveAttempt(makeAttempt({ id: 'attempt-example-2', sessionId: 'session-example-2' }));
    await built.journal.appendJournalEntry(
      forgeEntry({ id: 'forge:auto-merge:attempt-example-2:' + OTHER_HEAD + ':intent-recorded:1', attemptId: 'attempt-example-2', status: 'ambiguous' }),
    );
    const result = await built.run();
    expect(result).toMatchObject({ outcome: 'not-merged', reason: 'forge-suspended', route: 'attention' });
    expect(built.routing.calls).toHaveLength(1);
    expect(built.gate.calls).toBe(0);
    expect(built.acceptance.calls).toBe(0);
  });

  it('treats an own intent without a result as suspended and a tried head as already attempted', async () => {
    const suspended = build();
    await seed(suspended);
    await suspended.journal.appendJournalEntry(
      forgeEntry({ id: 'forge:auto-merge:' + ATTEMPT_ID + ':' + HEAD + ':intent-recorded:1', attemptId: ATTEMPT_ID }),
    );
    const suspendedResult = await suspended.run();
    expect(suspendedResult).toMatchObject({ outcome: 'not-merged', reason: 'forge-suspended', route: 'attention' });

    const attempted = build();
    await seed(attempted);
    await attempted.journal.appendJournalEntry(
      forgeEntry({ id: 'forge:auto-merge:' + ATTEMPT_ID + ':' + HEAD + ':intent-recorded:1', attemptId: ATTEMPT_ID }),
    );
    await attempted.journal.appendJournalEntry(
      forgeEntry({ id: 'forge:auto-merge:' + ATTEMPT_ID + ':' + HEAD + ':refused:2', attemptId: ATTEMPT_ID, status: 'refused' }),
    );
    const attemptedResult = await attempted.run();
    expect(attemptedResult).toMatchObject({ outcome: 'not-merged', reason: 'already-attempted', route: 'none' });
    expect(attempted.routing.calls).toHaveLength(0);
  });

  it('suspends when another forge action of the work order recorded an intent with no outcome', async () => {
    const built = build();
    await seed(built);
    await built.attemptRepo.saveAttempt(makeAttempt({ id: 'attempt-example-2', sessionId: 'session-example-2' }));
    await built.journal.appendJournalEntry(
      forgeEntry({ id: 'forge:auto-merge:attempt-example-2:' + OTHER_HEAD + ':intent-recorded:1', attemptId: 'attempt-example-2' }),
    );
    const result = await built.run();
    expect(result).toMatchObject({ outcome: 'not-merged', reason: 'forge-suspended', route: 'attention' });
    expect(built.gate.calls).toBe(0);
    expect(built.acceptance.calls).toBe(0);
  });

  it('suspends when another forge action completed a merge the work order did not record', async () => {
    const built = build();
    await seed(built);
    await built.attemptRepo.saveAttempt(makeAttempt({ id: 'attempt-example-2', sessionId: 'session-example-2' }));
    await built.journal.appendJournalEntry(
      forgeEntry({
        id: 'forge:auto-merge:attempt-example-2:' + OTHER_HEAD + ':completed:2',
        attemptId: 'attempt-example-2',
        status: 'completed',
      }),
    );
    const result = await built.run();
    expect(result).toMatchObject({ outcome: 'not-merged', reason: 'forge-suspended', route: 'attention' });
    expect(built.gate.calls).toBe(0);
    expect(built.acceptance.calls).toBe(0);
  });

  it('proceeds when a forge action recorded an intent and a refusal', async () => {
    const built = build();
    await seed(built);
    await built.attemptRepo.saveAttempt(makeAttempt({ id: 'attempt-example-2', sessionId: 'session-example-2' }));
    await built.journal.appendJournalEntry(
      forgeEntry({ id: 'forge:auto-merge:attempt-example-2:' + OTHER_HEAD + ':intent-recorded:1', attemptId: 'attempt-example-2' }),
    );
    await built.journal.appendJournalEntry(
      forgeEntry({ id: 'forge:auto-merge:attempt-example-2:' + OTHER_HEAD + ':refused:2', attemptId: 'attempt-example-2', status: 'refused' }),
    );
    const result = await built.run();
    expect(result).toEqual({
      outcome: 'merged',
      attemptId: ATTEMPT_ID,
      headSha: HEAD,
      decisionRevision: 'policy:autoMerge@0123456789ab',
    });
    expect(built.gate.calls).toBe(1);
    expect(built.acceptance.calls).toBe(1);
    expect(built.grant.calls).toBe(1);
    expect(built.forge.calls).toBe(1);
  });

  it('treats an unparseable forge entry id as unreadable forge history', async () => {
    const built = build();
    await seed(built);
    await built.attemptRepo.saveAttempt(makeAttempt({ id: 'attempt-example-2', sessionId: 'session-example-2' }));
    await built.journal.appendJournalEntry(
      forgeEntry({ id: 'forge:unparseable', attemptId: 'attempt-example-2' }),
    );
    const result = await built.run();
    expect(result).toMatchObject({ outcome: 'not-merged', reason: 'forge-history-unreadable', route: 'attention' });
    expect(built.gate.calls).toBe(0);
  });

  it('routes named and unreadable doors to attention and never asks acceptance', async () => {
    const named = build();
    named.doors.result = { outcome: 'recorded', ownerDecisionReferences: ['door-1'] };
    await seed(named);
    const namedResult = await named.run();
    expect(namedResult).toMatchObject({ outcome: 'not-merged', reason: 'door-named', route: 'attention' });
    expect(named.acceptance.calls).toBe(0);

    const unreadableVariants: Array<(built: Built) => void> = [
      (built) => {
        built.doors.result = { outcome: 'unknown', reason: 'not recorded' };
      },
      (built) => {
        built.doors.throws = true;
      },
    ];
    for (const prepare of unreadableVariants) {
      const built = build();
      prepare(built);
      await seed(built);
      const result = await built.run();
      expect(result).toMatchObject({ outcome: 'not-merged', reason: 'doors-unreadable', route: 'attention' });
      expect(built.routing.calls).toHaveLength(1);
      expect(built.acceptance.calls).toBe(0);
    }

    const noPort = build({ attemptOwnerDecisionPort: undefined });
    await seed(noPort);
    const noPortResult = await noPort.run();
    expect(noPortResult).toMatchObject({ outcome: 'not-merged', reason: 'doors-unreadable', route: 'attention' });
  });

  it('treats an absent or unlabelled risk as high-risk and honours the opt-in', async () => {
    const absent = build();
    await absent.attemptRepo.saveAttempt(makeAttempt());
    const withoutRisk = { ...makeWorkOrder(), risk: undefined } as WorkOrderRecord;
    await absent.workOrderRepo.saveWorkOrder(withoutRisk);
    const absentResult = await absent.run();
    expect(absentResult).toMatchObject({ outcome: 'not-merged', reason: 'high-risk', route: 'attention' });

    const highNoOptIn = build();
    await seed(highNoOptIn);
    await highNoOptIn.workOrderRepo.saveWorkOrder(makeWorkOrder({ risk: 'high', revision: 2 }));
    const highResult = await highNoOptIn.run();
    expect(highResult).toMatchObject({ outcome: 'not-merged', reason: 'high-risk', route: 'attention' });

    const highWithOptIn = build();
    highWithOptIn.settings.answer = {
      outcome: 'read',
      enabled: true,
      allowHighRisk: true,
      onBlocked: 'ask-owner',
      revision: '0123456789ab',
      forgeMode: 'github',
    };
    await seed(highWithOptIn);
    await highWithOptIn.workOrderRepo.saveWorkOrder(makeWorkOrder({ risk: 'high', revision: 2 }));
    const optInResult = await highWithOptIn.run();
    expect(optInResult).toEqual({
      outcome: 'merged',
      attemptId: ATTEMPT_ID,
      headSha: HEAD,
      decisionRevision: 'policy:autoMerge@0123456789ab',
    });
    expect(highWithOptIn.acceptance.calls).toBe(1);
  });

  it('refuses a forge mode other than github', async () => {
    for (const forgeMode of ['none', 'unknown'] as const) {
      const built = build();
      built.settings.answer = {
        outcome: 'read',
        enabled: true,
        allowHighRisk: false,
        onBlocked: 'ask-owner',
        revision: '0123456789ab',
        forgeMode,
      };
      await seed(built);
      const result = await built.run();
      expect(result).toMatchObject({ outcome: 'not-merged', reason: 'forge-mode', route: 'attention' });
      expect(built.gate.calls).toBe(0);
    }
  });

  it('routes every non-passing gate by onBlocked', async () => {
    const holdVariants: Array<(built: Built) => void> = [
      (built) => {
        built.gate.result = { verdict: 'failed', reason: 'a predicate failed' };
      },
      (built) => {
        built.gate.result = { verdict: 'unknown', reason: 'no predicates wired' };
      },
      (built) => {
        built.gate.throws = true;
      },
    ];
    for (const prepare of holdVariants) {
      const built = build();
      built.settings.answer = {
        outcome: 'read',
        enabled: true,
        allowHighRisk: false,
        onBlocked: 'hold',
        revision: '0123456789ab',
        forgeMode: 'github',
      };
      prepare(built);
      await seed(built);
      const result = await built.run();
      expect(result).toMatchObject({ outcome: 'not-merged', reason: 'gate-not-passed', route: 'attention' });
      expect(built.routing.calls).toHaveLength(1);
      expect(built.routing.calls[0]?.method).toBe('recordAttention');
      expect(built.routing.calls[0]?.notice.reason).toBe('gate-not-passed');
    }

    const noPort = build({ evaluateAttemptGate: undefined });
    await seed(noPort);
    const noPortResult = await noPort.run();
    expect(noPortResult).toMatchObject({
      outcome: 'not-merged',
      reason: 'gate-not-passed',
      detail: 'gate port not wired',
    });

    const askingGate = build();
    askingGate.gate.result = { verdict: 'failed', reason: 'a predicate failed' };
    await seed(askingGate);
    const askingResult = await askingGate.run();
    expect(askingResult).toMatchObject({ outcome: 'not-merged', reason: 'gate-not-passed', route: 'owner-question' });
    expect(askingGate.routing.calls).toHaveLength(1);
    expect(askingGate.routing.calls[0]?.method).toBe('askOwner');
  });

  it('never reads an empty blocker list as ci-pending', async () => {
    const rejectedEmpty = build();
    rejectedEmpty.acceptance.result = { outcome: 'rejected', reason: 'not accepted', blockerDetails: [] };
    await seed(rejectedEmpty);
    const rejectedResult = await rejectedEmpty.run();
    expect(rejectedResult).toMatchObject({ outcome: 'not-merged', reason: 'acceptance-blocked' });
    expect(await rejectedEmpty.journal.listJournalEntriesForAttempt(ATTEMPT_ID)).toHaveLength(0);

    const unknownNoDetails = build();
    unknownNoDetails.acceptance.result = { outcome: 'unknown', reason: 'evidence unavailable' };
    await seed(unknownNoDetails);
    const unknownResult = await unknownNoDetails.run();
    expect(unknownResult).toMatchObject({ outcome: 'not-merged', reason: 'acceptance-blocked' });
    expect(await unknownNoDetails.journal.listJournalEntriesForAttempt(ATTEMPT_ID)).toHaveLength(0);
  });

  it('records exactly one first look for a ci-pending-only block and waits', async () => {
    const built = build();
    built.acceptance.result = {
      outcome: 'rejected',
      reason: 'checks pending',
      blockerDetails: [{ kind: 'ci-pending', text: 'checks pending' }],
    };
    await seed(built);
    const result = await built.run();
    expect(result).toEqual({
      outcome: 'waiting',
      reason: 'ci-pending-first-look',
      headSha: HEAD,
      firstLookAtIso: FIXED_NOW,
    });
    const entries = await built.journal.listJournalEntriesForAttempt(ATTEMPT_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(autoMergeFirstLookEntryId(ATTEMPT_ID, HEAD));
    expect(entries[0]?.action).toBe('accept');
    expect(entries[0]?.status).toBe('refused');
    expect(built.routing.calls).toHaveLength(0);
  });

  it('falls to onBlocked on the second ci-pending look and keeps the journal unchanged', async () => {
    const buildWith = (onBlocked: 'ask-owner' | 'hold') => {
      const built = build();
      built.settings.answer = {
        outcome: 'read',
        enabled: true,
        allowHighRisk: false,
        onBlocked,
        revision: '0123456789ab',
        forgeMode: 'github',
      };
      built.acceptance.result = {
        outcome: 'rejected',
        reason: 'checks pending',
        blockerDetails: [{ kind: 'ci-pending', text: 'checks pending' }],
      };
      return built;
    };

    const holding = buildWith('hold');
    await seed(holding);
    await holding.run();
    const secondHold = await holding.run();
    expect(secondHold).toMatchObject({ outcome: 'not-merged', reason: 'ci-pending-second-look' });
    expect(secondHold).toMatchObject({ detail: 'first look at ' + FIXED_NOW });
    expect(holding.routing.calls).toHaveLength(1);
    expect(holding.routing.calls[0]?.method).toBe('recordAttention');
    expect(holding.routing.calls[0]?.notice.lines).toContain('checks pending');
    expect(await holding.journal.listJournalEntriesForAttempt(ATTEMPT_ID)).toHaveLength(1);

    const asking = buildWith('ask-owner');
    await seed(asking);
    await asking.run();
    const secondAsk = await asking.run();
    expect(secondAsk).toMatchObject({ outcome: 'not-merged', reason: 'ci-pending-second-look', route: 'owner-question' });
    expect(asking.routing.calls).toHaveLength(1);
    expect(asking.routing.calls[0]?.method).toBe('askOwner');
    expect(await asking.journal.listJournalEntriesForAttempt(ATTEMPT_ID)).toHaveLength(1);
  });

  it('blocks mixed blockers on the first run without a first look', async () => {
    const built = build();
    built.acceptance.result = {
      outcome: 'rejected',
      reason: 'not accepted',
      blockerDetails: [
        { kind: 'ci-pending', text: 'checks pending' },
        { kind: 'ci-failed', text: 'a check failed' },
      ],
    };
    await seed(built);
    const result = await built.run();
    expect(result).toMatchObject({ outcome: 'not-merged', reason: 'acceptance-blocked', route: 'owner-question' });
    expect(await built.journal.listJournalEntriesForAttempt(ATTEMPT_ID)).toHaveLength(0);
  });

  it('treats a receipt for another head as stale evidence', async () => {
    const built = build();
    built.acceptance.result = {
      outcome: 'accepted',
      receiptId: 'receipt-example-1',
      assessedHeadSha: OTHER_HEAD,
    };
    await seed(built);
    const result = await built.run();
    expect(result).toMatchObject({ outcome: 'not-merged', reason: 'acceptance-blocked' });
  });

  it('never accepts an empty or non-string receipt id', async () => {
    const empty = build();
    empty.acceptance.result = { outcome: 'accepted', receiptId: '', assessedHeadSha: HEAD };
    await seed(empty);
    const emptyResult = await empty.run();
    // Stale/blocked, never the not-wired reason: an empty receipt is not evidence.
    expect(emptyResult).toMatchObject({ outcome: 'not-merged', reason: 'acceptance-blocked' });

    const numeric = build();
    numeric.acceptance.result = { outcome: 'accepted', receiptId: 42 as unknown as string, assessedHeadSha: HEAD };
    await seed(numeric);
    const numericResult = await numeric.run();
    expect(numericResult).toMatchObject({ outcome: 'not-merged', reason: 'acceptance-blocked' });
  });

  it('routes an unreadable acceptance answer to attention', async () => {
    const built = build();
    built.acceptance.throws = true;
    await seed(built);
    const result = await built.run();
    expect(result).toMatchObject({ outcome: 'not-merged', reason: 'acceptance-unreadable', route: 'attention' });
    expect(built.routing.calls).toHaveLength(1);
    expect(built.routing.calls[0]?.method).toBe('recordAttention');
  });

  it('merges an eligible attempt through the grant and the forge', async () => {
    const built = build();
    await seed(built);
    const result = await built.run();
    expect(result).toEqual({
      outcome: 'merged',
      attemptId: ATTEMPT_ID,
      headSha: HEAD,
      decisionRevision: 'policy:autoMerge@0123456789ab',
    });
    expect(built.grant.calls).toBe(1);
    expect(built.forge.calls).toBe(1);
    expect(built.acceptance.requests[0]).toEqual({
      attemptId: ATTEMPT_ID,
      workOrderId: WORK_ORDER_ID,
      candidateHeadSha: HEAD,
      policyRevision: 'policy-example-1',
    });
  });

  it('stops with setting-changed before the forge when the re-read forge mode differs', async () => {
    const firstRead: AutoMergeSettingsAnswer = {
      outcome: 'read',
      enabled: true,
      allowHighRisk: false,
      onBlocked: 'ask-owner',
      revision: '0123456789ab',
      forgeMode: 'github',
    };
    const changedRead: AutoMergeSettingsAnswer = {
      outcome: 'read',
      enabled: true,
      allowHighRisk: false,
      onBlocked: 'ask-owner',
      revision: '0123456789ab',
      forgeMode: 'none',
    };
    let reads = 0;
    const settings: AutoMergeSettingsPort = {
      async readAutoMergeSettings() {
        reads += 1;
        return reads === 1 ? firstRead : changedRead;
      },
    };
    const rebuilt = build({ settings });
    await seed(rebuilt);
    const result = await rebuilt.run();
    expect(result).toMatchObject({ outcome: 'not-merged', reason: 'setting-changed' });
    expect(rebuilt.grant.calls).toBe(1);
    expect(rebuilt.forge.calls).toBe(0);
  });

  it('refuses a grant id that is not a non-empty string and never forges', async () => {
    for (const grantId of [undefined, null, '', 7] as unknown[]) {
      const built = build();
      built.grant.answer = {
        outcome: 'issued',
        grantId: grantId as string,
        decisionRevision: 'policy:autoMerge@0123456789ab',
      };
      await seed(built);
      const result = await built.run();
      expect(result).toMatchObject({ outcome: 'not-merged', reason: 'grant-revision-mismatch' });
      expect(built.forge.calls).toBe(0);
    }
  });

  it('refuses a grant id that is missing, inherited or an accessor, and never forges', async () => {
    const missing = { outcome: 'issued', decisionRevision: 'policy:autoMerge@0123456789ab' };
    const inherited = Object.assign(Object.create({ grantId: 'grant-example-1' }) as object, {
      outcome: 'issued',
      decisionRevision: 'policy:autoMerge@0123456789ab',
    });
    let accessorReads = 0;
    const accessor = {
      outcome: 'issued',
      decisionRevision: 'policy:autoMerge@0123456789ab',
      get grantId(): string {
        accessorReads += 1;
        return 'grant-example-1';
      },
    };
    for (const answer of [missing, inherited, accessor]) {
      const built = build();
      built.grant.answer = answer as typeof built.grant.answer;
      await seed(built);
      const result = await built.run();
      expect(result).toMatchObject({ outcome: 'not-merged', reason: 'grant-revision-mismatch' });
      expect(built.forge.calls).toBe(0);
    }
    expect(accessorReads).toBe(0);
  });

  it('keeps not-merged when routing is unwired or fails, and answers exists on a repeat key', async () => {
    const unwired = build({ routing: undefined });
    unwired.gate.result = { verdict: 'failed', reason: 'a predicate failed' };
    await seed(unwired);
    const unwiredResult = await unwired.run();
    expect(unwiredResult).toMatchObject({ outcome: 'not-merged', route: 'owner-question', routeOutcome: 'not-wired' });

    const failing = build();
    failing.gate.result = { verdict: 'failed', reason: 'a predicate failed' };
    failing.routing.throws = true;
    await seed(failing);
    const failingResult = await failing.run();
    expect(failingResult).toMatchObject({ outcome: 'not-merged', route: 'owner-question', routeOutcome: 'failed' });

    const existing = build();
    existing.acceptance.result = {
      outcome: 'rejected',
      reason: 'checks pending',
      blockerDetails: [{ kind: 'ci-pending', text: 'checks pending' }],
    };
    existing.routing.answer = { outcome: 'exists' };
    await seed(existing);
    await existing.run();
    await existing.run();
    const third = await existing.run();
    expect(third).toMatchObject({ outcome: 'not-merged', route: 'owner-question', routeOutcome: 'exists' });
    expect(existing.routing.calls).toHaveLength(2);
    expect(existing.routing.calls[0]?.notice.key).toBe(existing.routing.calls[1]?.notice.key);
    expect(existing.routing.calls[0]?.notice.key).toBe(
      autoMergeRoutingKey(ATTEMPT_ID, HEAD, 'ci-pending-second-look'),
    );
  });

  it('records a first look that never disturbs the stored gate outcome', async () => {
    const built = build();
    built.acceptance.result = {
      outcome: 'rejected',
      reason: 'checks pending',
      blockerDetails: [{ kind: 'ci-pending', text: 'checks pending' }],
    };
    await seed(built);
    await built.run();
    const entries = await built.journal.listJournalEntriesForAttempt(ATTEMPT_ID);
    const acceptEntries = entries.filter((entry) => entry.id.startsWith(ATTEMPT_ID + ':accept:'));
    expect(acceptEntries).toHaveLength(0);
  });
});
