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
import type { AttemptRecord } from '../../../domain/execution-records.js';
import { LaneRun } from '../../../domain/entities/LaneRun.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import {
  laneRunIntentEntry,
  laneRunResultEntry,
} from '../../../domain/lane-run-step-facts.js';
import type { DispatchAttemptResult } from '../../ports/in/DispatchAttemptPort.in-port.js';
import type { ReconcileAttemptResult } from '../../ports/in/ReconcileAttemptPort.in-port.js';
import type { AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
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
}

/**
 * The in-memory scenario of the Q4a brief §4, with the fake ports consuming
 * `outcomes` in order: the dispatch port takes the first outcome, the
 * reconcile port the next, and so on. An exhausted sequence answers
 * `completed` — the benign outcome that keeps every later pass settled —
 * so a short sequence still drives all four passes.
 */
export async function makeLaneRunScenario(outcomes: readonly PortOutcome[]): Promise<LaneRunScenario> {
  const runRepo = new LaneRunRepositoryAdapter();
  const runJournal = new LaneRunJournalAdapter();
  const attemptRepo = new AttemptRepositoryAdapter();
  const executionJournal = new ExecutionJournalAdapter();
  const newUlid = makeUlidMinter();

  let cursor = 0;
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

  const deps: AdvanceLaneRunDependencies = {
    runRepo,
    runJournal,
    attemptRepo,
    executionJournal,
    artifactPort,
    reconcileAttempt,
    admission: {
      admit: async () => ({ outcome: 'admitted' }),
    },
    dispatchAttempt,
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
