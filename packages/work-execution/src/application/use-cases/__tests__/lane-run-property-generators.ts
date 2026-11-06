/**
 * The shared `fast-check` generators and the in-memory lane-run scenario for
 * the Q4a/Q4b property tests over `AdvanceLaneRunUseCase` (plan §4.4). The
 * scenario is the fixture of `advance-lane-run-facts.test.ts` (§4 of the Q4a
 * brief): one lane run, one prepared attempt, in-memory stores, no runner,
 * no subprocess, no network, with the fake dispatch and reconcile ports
 * consuming a generated sequence of port outcomes in order.
 *
 * This file holds no `describe`/`it`: vitest only collects `*.test.ts`.
 */

import fc from 'fast-check';

import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { parseLaneRunKey } from '../../../domain/lane-run-keys.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { AttemptRecord, WorkOrderRecord } from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import {
  laneRunConductEntry,
  laneRunIntentEntry,
  laneRunResultEntry,
} from '../../../domain/lane-run-step-facts.js';
import type { DispatchAttemptResult } from '../../ports/in/DispatchAttemptPort.in-port.js';
import type { ReconcileAttemptResult } from '../../ports/in/ReconcileAttemptPort.in-port.js';
import type { ExecuteAuthorizedForgeActionResult } from '../../ports/in/ExecuteAuthorizedForgeActionPort.in-port.js';
import type { MergeEnqueueDecision } from '../../../domain/merge-queue-operations.js';
import type { AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import type { ConductorForgeGrantResult } from '../../ports/out/ConductorForgeGrantPort.out-port.js';
import type {
  AcceptanceAssessmentResult,
  AcceptanceReceiptsResult,
} from '../../ports/out/AcceptanceAssessmentPort.out-port.js';
import type { ReadPullRequestResult } from '../../ports/out/ForgeReadPort.out-port.js';
import {
  AdvanceLaneRunUseCase,
  type AdvanceLaneRunDependencies,
} from '../AdvanceLaneRunUseCase.use-case.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';

/** The port outcomes the property generates: the two ports' answers, or a throw. */
export const PORT_OUTCOMES = ['completed', 'refused', 'unknown', 'thrown'] as const;
export type PortOutcome = (typeof PORT_OUTCOMES)[number];

/** One port outcome. */
export const portOutcomeArb = fc.constantFrom(...PORT_OUTCOMES);

/** A sequence of port outcomes, 1..8 long. */
export const portOutcomeSequenceArb = fc.array(portOutcomeArb, { minLength: 1, maxLength: 8 });

export const RUN_ID = 'run-01JB0000000000000000000000';

/**
 * The error the fake dispatch and reconcile ports throw on a `thrown`
 * outcome. The Q4a property exempts exactly these throws from P1(a): a
 * port throw leaves the act's intent open, and the next pass settles it.
 * Any other exception from `advanceLaneRun` is an application-code defect
 * and must fail the test instead of being treated as a port throw.
 */
export class FakePortThrowError extends Error {}

const NOW = '2026-10-27T10:00:00.000Z';
const LATER = '2026-10-27T10:01:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const HOLDER = 'driver';
const COMMIT = 'a'.repeat(40);

const PROSE = '# brief\n';
// The frozen manifest must verify, otherwise the dispatch act parks
// `step-refused` and the dispatch port is never called.
const MANIFEST_JSON = JSON.stringify({
  stepLimit: 100,
  timeLimitSeconds: 3600,
  expectedArtifacts: ['notes.md'],
});
const DIGEST = simpleDeterministicHexDigest(PROSE + '\n' + MANIFEST_JSON);

/** The work order the `laterActs` fakes answer, matching `BASE_RECORD.workOrderId`. */
const LATER_ACT_WORK_ORDER: WorkOrderRecord = {
  id: 'wo-example-1',
  projectId: 'project-example',
  taskId: 'task-example-1',
  laneId: 'lane-example',
  repository: 'repo-example',
  baseCommit: COMMIT,
  ownedPaths: ['src/example.ts'],
  policyRevision: 'policy-example-1',
  prerequisiteWorkOrderIds: [],
  state: 'ready-to-merge',
  revision: 1,
  createdAtIso: NOW,
  updatedAtIso: NOW,
  risk: 'standard',
};

const SEAT_PLAN = {
  version: 1 as const,
  'first-pass': [
    { id: 'fp-1', model: 'model-example-1', tool: 'opencode' },
    { id: 'fp-2', model: 'model-example-2', tool: 'opencode' },
  ],
  fix: [{ id: 'fx-1', model: 'model-example-1', tool: 'opencode' }],
  review: [],
};

const SEAT_SELECTION = {
  role: 'first-pass' as const,
  seatIndex: 0,
  seatId: 'fp-1',
  model: 'model-example-1',
  tool: 'opencode',
  variant: null,
  agent: null,
};

/** The recorded host of a conducted attempt (KF-10/Q2a-2 invariant). */
const CONDUCTED_RUNNER = {
  kind: 'opencode' as const,
  remotePort: 4166,
  host: 'lane-alias-example',
  hostName: 'lane-host-example',
  agent: null,
  model: null,
  variant: null,
};

const BASE_RECORD = {
  version: 1,
  runId: RUN_ID,
  workOrderId: 'wo-example-1',
  tier: 2,
  seatPlanRef: 'a'.repeat(64),
  cursors: { 'first-pass': 0, fix: null, review: null },
  round: 0,
  attemptIds: ['attempt-example-1'],
  prNumber: null,
  parked: null,
  parkCount: 0,
  lease: null,
  revision: 1,
  runPolicyRevision: 'policy-example-1',
};

function attemptFixture(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-example-1',
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/tmp/opencode/wo-example-1/wt-example-1',
    baseCommit: COMMIT,
    state: 'intent-recorded',
    outcome: null,
    briefDigest: DIGEST,
    briefPackagePath: '.lane/brief-package',
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner: CONDUCTED_RUNNER,
    seatPlan: SEAT_PLAN,
    seatSelection: SEAT_SELECTION,
    stopReason: 'none',
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
  };
}

/** A run record via the domain entity, like the facts test's fixture. */
function runRecord(): LaneRunRecord {
  const result = LaneRun.create({ ...BASE_RECORD });
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

function makeUlidMinter(): () => string {
  let next = 0;
  return () => {
    const id = '01JB00000000000000000000' + String(next).padStart(2, '0');
    next += 1;
    return id;
  };
}

export interface LaneRunScenario {
  readonly deps: AdvanceLaneRunDependencies;
  /** One driver pass: `useCase.advanceLaneRun({ runId, lease, halted: false, nowIso: LATER })`. */
  advance(): Promise<AdvanceLaneRunResult>;
  /** The run's journal entries, in append order. */
  journal(): Promise<readonly LaneRunJournalEntryRecord[]>;
  /** The run record as stored. */
  record(): Promise<LaneRunRecord | null>;
  /** How many times the fake dispatch port has been called so far. */
  dispatchCalls(): number;
  /**
   * How many times the conductor has acted `prepare` so far: every attempt to
   * append a prepare intent through the run journal (landed or refused as a
   * duplicate) counts, so a duplicate prepare act without a new journal entry
   * is still observable.
   */
  prepareCalls(): number;
  /** How many times the fake reconcile port has been called so far. */
  reconcileCalls(): number;
  /** How many times the fake forge-action port has been called so far (the `open-pr`/`push` acting port). */
  forgeActionCalls(): number;
  /** How many times the fake merge-queue enqueue port has been called so far (the `merge-enqueue` acting port). */
  mergeCalls(): number;
}

export interface LaneRunScenarioOptions {
  /** When set, the fixture appends one terminal conduct entry at setup, so the run starts terminal. */
  readonly terminalState?: 'merged' | 'stopped';
  /**
   * When set, the fixture wires the open-pr/push/merge ports with benign
   * fakes: the conductor forge grant, the acceptance assessment, the work
   * order read, the pre-merge receipt read, the PR read (an open PR at the
   * lane head, merge state clean) and auto-merge enabled. These are only
   * read by the later acts and their facts, so the Q4a random scenario keeps
   * behaving exactly as before; the seeded one-way scenarios use them to put
   * the run into `opening-pr`, `pushing` or `merging`.
   */
  readonly laterActs?: boolean;
}

/**
 * The benign open-pr/push/merge fakes for `options.laterActs`. They are read
 * only by the later acts and their facts (`opening-pr` / `pushing` /
 * `merging` states), which the Q4a random scenario never reaches, so wiring
 * them changes no behaviour there. The PR fake answers an open PR at the lane
 * head with a clean merge state; a seeded pushing scenario overrides
 * `forgeRead` to a different head. `acceptanceAssessment` answers a receipts
 * pass and an acceptance at the exact head; `reviewRequest` answers a passed
 * pre-merge receipt (and nothing for the review kinds); `workOrderRepo`
 * answers the run's work order; `autoMergeEnabled` is true.
 */
function laterActDeps(): Partial<AdvanceLaneRunDependencies> {
  return {
    conductorForgeGrant: {
      issueConductorForgeGrant: async (): Promise<ConductorForgeGrantResult> => ({
        outcome: 'issued',
        grantId: 'grant-conductor-example-1',
        decisionRevision: 'policy:conductor@0123456789ab',
      }),
    },
    acceptanceAssessment: {
      assessHeadAcceptance: async (): Promise<AcceptanceAssessmentResult> => ({
        outcome: 'accepted',
        receiptId: 'rcp-example-1',
        assessedHeadSha: COMMIT,
      }),
      assessHeadReceipts: async (): Promise<AcceptanceReceiptsResult> => ({
        outcome: 'passed',
        receiptsId: 'rcp-example-1',
        assessedHeadSha: COMMIT,
      }),
    },
    workOrderRepo: {
      findWorkOrderById: async () => LATER_ACT_WORK_ORDER,
    },
    reviewRequest: {
      requestReview: async () => ({ outcome: 'no-receipt', reason: 'review-unavailable', detail: null }),
      findReviewReceipt: async () => ({ outcome: 'not-found' }),
      findLatestReceiptOfKind: async (request) =>
        request.kind === 'pre-merge'
          ? {
              outcome: 'found',
              receipt: {
                receiptId: 'rcp-example-1',
                requestId: null,
                kind: 'pre-merge',
                reviewerModel: 'model-example-1',
                candidateHeadSha: COMMIT,
                verdict: 'passed',
                findings: [],
              },
            }
          : { outcome: 'not-found' },
      recordOutOfScope: async () => ({ outcome: 'recorded' }),
    },
    forgeRead: {
      readPullRequest: async (): Promise<ReadPullRequestResult> => ({
        outcome: 'found',
        pullRequest: {
          number: 1,
          state: 'open',
          mergeState: 'clean',
          headSha: COMMIT,
          headRef: 'wt-example-1',
          baseRef: 'main',
          mergedAtIso: null,
          closedAtIso: null,
          mergeCommitSha: null,
        },
      }),
      isConfigured: () => true,
    },
    autoMergeEnabled: true,
  };
}

/**
 * The in-memory scenario of the Q4a brief §4, with the fake ports consuming
 * `outcomes` in order: the dispatch port takes the first outcome, the
 * reconcile port the next, and so on. An exhausted sequence answers
 * `completed` — the benign outcome that keeps every later pass settled —
 * so a short sequence still drives all four passes.
 */
export async function makeLaneRunScenario(
  outcomes: readonly PortOutcome[],
  options: LaneRunScenarioOptions = {},
): Promise<LaneRunScenario> {
  const runRepo = new LaneRunRepositoryAdapter();
  const runJournal = new LaneRunJournalAdapter();
  const attemptRepo = new AttemptRepositoryAdapter();
  const executionJournal = new ExecutionJournalAdapter();
  const newUlid = makeUlidMinter();

  let cursor = 0;
  let dispatchCallCount = 0;
  let reconcileCallCount = 0;
  let forgeActionCallCount = 0;
  let mergeCallCount = 0;
  let prepareCallCount = 0;

  // Count prepare acts through the journal: the conductor's `act prepare`
  // writes its intent through `runJournal.append`, so every attempt to append
  // a prepare intent — whether it lands or is refused as a duplicate — is one
  // observable prepare act. The setup's own prepare entry is appended through
  // the raw `runJournal` below, so the count starts at zero for the first pass.
  const instrumentedRunJournal: LaneRunJournalPort = {
    append: async (entry) => {
      const parsed =
        entry.kind === 'intent' && entry.key !== null ? parseLaneRunKey(entry.key) : null;
      if (parsed !== null && parsed.kind === 'step' && parsed.step === 'prepare') {
        prepareCallCount += 1;
      }
      return runJournal.append(entry);
    },
    listForRun: (runId) => runJournal.listForRun(runId),
    ...(runJournal.listForRuns !== undefined
      ? { listForRuns: (runIds) => runJournal.listForRuns!(runIds) }
      : {}),
    listForKey: (key) => runJournal.listForKey(key),
  };

  const nextOutcome = (): PortOutcome => {
    const outcome = outcomes[cursor];
    cursor += 1;
    return outcome ?? 'completed';
  };

  const artifactPort = {
    readBriefManifest: async () => MANIFEST_JSON,
    readBriefFile: async () => PROSE,
    verifyArtifactManifest: async () => ({ outcome: 'missing' } as const),
  };

  // Save the answer's attempt the way the real adapters do: one read, then a
  // save at revision + 1 (the facts test's fake pattern).
  const saveAnswered = async (attempt: AttemptRecord): Promise<void> => {
    const existing = await attemptRepo.findAttemptById(attempt.id);
    await attemptRepo.saveAttempt({ ...attempt, revision: (existing?.revision ?? 0) + 1 });
  };

  const attempt = attemptFixture();
  const endedAttempt = attemptFixture({ state: 'ended', sessionId: 'session-example-1' });
  const receipt = {
    attemptId: endedAttempt.id,
    sessionId: endedAttempt.sessionId ?? 'session-example-1',
    endedAtIso: LATER,
    authoritative: true,
    exitStatus: 0,
    stoppedByRequest: false,
  };

  const dispatchAttempt = {
    dispatchAttempt: async (): Promise<DispatchAttemptResult> => {
      dispatchCallCount += 1;
      const outcome = nextOutcome();
      if (outcome === 'thrown') {
        throw new FakePortThrowError('runner threw');
      }
      if (outcome === 'refused') {
        return { outcome: 'refused', reason: 'runner refused' };
      }
      if (outcome === 'unknown') {
        // The attempt stays `intent-recorded`: the next pass waits
        // `dispatch-pending` (the Q4a trace table).
        return { outcome: 'unknown', attempt, reason: 'runner unknown' };
      }
      // `completed`: the runner started — save the attempt `running` with its
      // session like the real adapter: one read, then a save at the stored
      // revision + 1 (`AttemptRepositoryAdapter` refuses a save that does not
      // increment the stored revision, so a hard-coded revision would throw
      // instead of simulating the started runner).
      await saveAnswered({ ...attempt, state: 'running', sessionId: 'session-example-1' });
      return { outcome: 'started', attempt, sessionId: 'session-example-1' };
    },
  };

  const reconcileAttempt = {
    reconcileAttempt: async (): Promise<ReconcileAttemptResult> => {
      reconcileCallCount += 1;
      const outcome = nextOutcome();
      if (outcome === 'thrown') {
        throw new FakePortThrowError('reconcile threw');
      }
      if (outcome === 'refused') {
        return { outcome: 'refused', reason: 'runner refused' };
      }
      if (outcome === 'unknown') {
        return { outcome: 'unknown', attempt, reason: 'runner unknown' };
      }
      // `completed`: the attempt ended — save the ended attempt.
      await saveAnswered(endedAttempt);
      return { outcome: 'ended', attempt: endedAttempt, receipt };
    },
  };

  // The `open-pr`/`push` acting port and the `merge` acting port. In this
  // fixture the run never reaches those one-way acts — the collect act is
  // unwired and parks the pipeline — so wiring them changes no behaviour;
  // the counters let the property tests refuse a duplicate call of either
  // acting port after its step key is settled (the one-way property's (b)
  // beyond dispatch), and the terminal property's no-port-call guard.
  const executeForgeAction = {
    executeAuthorizedForgeAction: async (): Promise<ExecuteAuthorizedForgeActionResult> => {
      forgeActionCallCount += 1;
      return { outcome: 'refused', reason: 'forge refused' };
    },
  };

  const enqueueMerge = {
    enqueue: async (): Promise<MergeEnqueueDecision> => {
      mergeCallCount += 1;
      return { outcome: 'refused', reason: 'invalid-head' };
    },
  };

  const deps: AdvanceLaneRunDependencies = {
    runRepo,
    runJournal: instrumentedRunJournal,
    attemptRepo,
    executionJournal,
    artifactPort,
    reconcileAttempt,
    admission: {
      admit: async () => ({ outcome: 'admitted' }),
    },
    dispatchAttempt,
    executeForgeAction,
    enqueueMerge,
    ...(options.laterActs === true ? laterActDeps() : {}),
    newUlid,
  };

  // The run record, leased for the whole scenario.
  const created = await runRepo.create(runRecord());
  if (created.outcome !== 'saved') {
    throw new Error('fixture must create the run record');
  }
  const leased = await runRepo.acquireLease(RUN_ID, {
    holderId: HOLDER,
    observedFence: 0,
    leaseUntilIso: LEASE_UNTIL,
    nowIso: NOW,
  });
  if (leased.outcome !== 'saved') {
    throw new Error('fixture must acquire the run lease');
  }
  await attemptRepo.saveAttempt(attempt);

  // A held capacity reservation, or the decider waits `admission` and the
  // dispatch act is never reached.
  await executionJournal.saveCapacityReservation({
    id: newUlid(),
    attemptId: attempt.id,
    hostId: 'host-example-1',
    slotIndex: 0,
    held: true,
    seatTool: 'opencode',
    reservedAtIso: NOW,
    releasedAtIso: null,
  });

  // One prepare intent and its result for the attempt, so its placement
  // (round 0, seat 0) is known and the dispatch key is still fresh.
  const prepareKey = buildLaneRunStepKey({
    runId: RUN_ID,
    round: 0,
    step: 'prepare',
    seatIndex: 0,
    attemptOrdinal: 1,
    head12: null,
    retry: null,
  });
  if (!prepareKey.ok) {
    throw new Error('fixture must build the prepare step key');
  }
  const appendedIntent = await runJournal.append(
    laneRunIntentEntry(newUlid(), RUN_ID, prepareKey.key, attempt.id, NOW),
  );
  if (appendedIntent.outcome !== 'appended') {
    throw new Error('fixture must append the prepare intent');
  }
  const appendedResult = await runJournal.append(
    laneRunResultEntry(newUlid(), RUN_ID, prepareKey.key, 'completed', 'prepared', NOW),
  );
  if (appendedResult.outcome !== 'appended') {
    throw new Error('fixture must append the prepare result');
  }

  if (options.terminalState !== undefined) {
    const appendedConduct = await runJournal.append(
      laneRunConductEntry(newUlid(), RUN_ID, options.terminalState, NOW),
    );
    if (appendedConduct.outcome !== 'appended') {
      throw new Error('fixture must append the terminal conduct entry');
    }
  }

  const useCase = new AdvanceLaneRunUseCase(deps);
  return {
    deps,
    advance: () =>
      useCase.advanceLaneRun({
        runId: RUN_ID,
        lease: { holderId: HOLDER, fence: 1 },
        halted: false,
        nowIso: LATER,
      }),
    journal: () => runJournal.listForRun(RUN_ID),
    record: () => runRepo.get(RUN_ID),
    dispatchCalls: () => dispatchCallCount,
    prepareCalls: () => prepareCallCount,
    reconcileCalls: () => reconcileCallCount,
    forgeActionCalls: () => forgeActionCallCount,
    mergeCalls: () => mergeCallCount,
  };
}

/**
 * The keys of the `intent` entries whose key parses as a step key and for
 * which no `result` entry with the same key exists: the property's subject.
 */
export function stepIntentKeysWithoutResult(
  entries: readonly LaneRunJournalEntryRecord[],
  runId: string,
): string[] {
  const settled = new Set(
    entries
      .filter((entry) => entry.kind === 'result' && entry.runId === runId)
      .map((entry) => entry.key),
  );
  const unsettled: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'intent' || entry.runId !== runId || entry.key === null) {
      continue;
    }
    if (parseLaneRunKey(entry.key)?.kind !== 'step') {
      continue;
    }
    if (!settled.has(entry.key)) {
      unsettled.push(entry.key);
    }
  }
  return unsettled;
}
