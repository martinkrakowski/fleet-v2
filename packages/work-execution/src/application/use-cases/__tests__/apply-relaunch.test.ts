// Tests for lane CO29b: ApplyRelaunchUseCase and the relaunch plan contracts.
// Every pinned refusal name from the brief is a test title; every body asserts
// the typed result, never a throw.

import { describe, expect, it } from 'vitest';

import { containsSecretShape } from '@fleet/shared';

import { CutoverJournalAdapter } from '../../../infrastructure/adapters/CutoverJournalAdapter.adapter.js';
import { pureSha256Hex } from '../../../domain/held-work-order.js';
import type { ExecutionRunnerPort } from '../../ports/out/ExecutionRunnerPort.out-port.js';
import type {
  CutoverJournalAppendResult,
  CutoverJournalEntry,
  CutoverJournalListResult,
  CutoverJournalPort,
} from '../../ports/out/CutoverJournalPort.out-port.js';
import type {
  ApplyRelaunchRequest,
  ApplyRelaunchResult,
} from '../../ports/in/ApplyRelaunchPort.in-port.js';
import type { SaveLaneEditsPort, SaveLaneEditsResult } from '../../ports/in/SaveLaneEditsPort.in-port.js';
import type { AdoptLanePort, AdoptLaneResult } from '../../ports/in/AdoptLanePort.in-port.js';
import { ApplyRelaunchUseCase, type ApplyRelaunchDependencies } from '../ApplyRelaunchUseCase.use-case.js';

const PLAN = 'abcdef0123456789';
const NOW = '2026-11-06T10:00:00Z';
const LATER = '2026-11-06T10:05:00Z';
const EARLIER = '2026-11-06T09:00:00Z';
const TREE = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const SAVE_REF = 'refs/fleet/saved/abcdef012345-lane-a';
const ADOPTABLE_LANE = 'lane-a';
const CONDUCTED_LANE = 'lane-run-1';
const RUN_ID = CONDUCTED_LANE;
const ATTEMPT_ID = 'attempt-1';
// Built from fragments so no secret literal appears contiguously in this file.
const FAKE_SECRET = ['sk', '-', 'x9y8z7'.repeat(4)].join('');

const SAVE_KEY = `relaunch/${PLAN}/${ADOPTABLE_LANE}/save`;
const ABORT_KEY = `relaunch/${PLAN}/${ADOPTABLE_LANE}/abort`;
const ADOPT_KEY = `relaunch/${PLAN}/${ADOPTABLE_LANE}/adopt`;
const REDISPATCH_KEY = `relaunch/${PLAN}/${ADOPTABLE_LANE}/redispatch`;
const SWAP_KEY = `relaunch/${PLAN}/${CONDUCTED_LANE}/driver-swap`;

const stepKey = (laneId: string, step: string): string => `relaunch/${PLAN}/${laneId}/${step}`;

const recordedHost = {
  kind: 'opencode',
  remotePort: 46000,
  host: null,
  hostName: 'lanehost',
  agent: null,
  model: null,
  variant: null,
};

const saveSpec = {
  attemptId: ATTEMPT_ID,
  worktreePath: '/srv/lanes/worktrees/lane-a',
  clonePath: '/srv/lanes/clones/lane-a',
  recordedHost,
  baseCommit: BASE,
  allowedPathPrefixes: ['packages/'],
};

const abortSpec = {
  worktreePath: '/srv/lanes/worktrees/lane-a',
  recordedHost: null,
  gracePeriodSeconds: 30,
};

const adoptSpec = {
  projectId: 'proj-1',
  planRef: { projectId: 'proj-1', planId: 'plan-1', laneId: ADOPTABLE_LANE },
  baseBranch: 'main',
  workOrder: {
    workOrderId: 'wo-1',
    taskId: 'task-1',
    repository: 'fleet-v2',
    baseCommit: BASE,
    ownedPaths: ['packages/tooling'],
    policyRevision: 'pol-1',
  },
  brief: {
    briefId: 'brief-1',
    briefText: 'A frozen brief text.',
    expectedBriefDigest: 'd'.repeat(64),
    prosePath: 'docs/prose.md',
    manifestPath: 'docs/manifest.md',
    reviewerModel: 'reviewer-1',
    acceptanceSpec: { goals: [] },
  },
  attempt: { attemptId: ATTEMPT_ID, endedAtIso: NOW, sessionId: null, runner: null },
  run: { runId: 'run-new-1', tier: 'standard', seatPlanRef: 'e'.repeat(64), runPolicyRevision: 'pol-1' },
  source: { kind: 'save-ref', saveRef: SAVE_REF, commitOid: COMMIT, treeDigest: TREE },
};

const conductedLane = {
  laneId: CONDUCTED_LANE,
  population: 'conducted',
  runId: RUN_ID,
  targetReleaseTag: 'rel-1',
  steps: ['driver-swap'],
};

const adoptableLane = {
  laneId: ADOPTABLE_LANE,
  population: 'attempt-recorded',
  attemptId: ATTEMPT_ID,
  steps: ['save', 'abort', 'adopt', 'redispatch'],
  save: saveSpec,
  abort: abortSpec,
  adopt: adoptSpec,
};

const validPlan = (lanes: unknown[] = [conductedLane, adoptableLane]): Record<string, unknown> => ({
  schemaVersion: 1,
  planDigest: PLAN,
  createdAtIso: NOW,
  lanes,
});

const validRequest = (): ApplyRelaunchRequest => ({
  planDigest: PLAN,
  ownerGrantDecisionRef: 'owner-decision-1',
  nowIso: NOW,
});

const savedResult = (outcome: 'saved' | 'already-saved' = 'saved'): SaveLaneEditsResult => ({
  outcome,
  planDigest: PLAN,
  laneId: ADOPTABLE_LANE,
  journalKey: SAVE_KEY,
  saveRef: SAVE_REF,
  commitId: COMMIT,
  treeDigest: TREE,
});

const adoptedResult = (): AdoptLaneResult => ({
  outcome: 'adopted',
  reused: false,
  workOrderId: 'wo-1',
  briefDigest: 'd'.repeat(64),
  attemptId: ATTEMPT_ID,
  runId: 'run-new-1',
  commitOid: COMMIT,
  enteredState: 'collecting',
  provenance: 'adopted',
});

const runRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  runId: RUN_ID,
  workOrderId: 'wo-1',
  state: 'running',
  laneId: CONDUCTED_LANE,
  ...overrides,
});

interface State {
  owner: 'approved' | 'not-approved' | 'unknown' | 'throws';
  planRead:
    | { status: 'ok'; plan: unknown }
    | { status: 'missing' }
    | { status: 'unreadable' }
    | { status: 'unknown-version'; foundVersion?: number }
    | 'throws';
  run: Record<string, unknown> | null | 'throws';
  workOrder: Record<string, unknown> | null | 'absent' | 'throws';
  attempt: Record<string, unknown> | null | 'throws';
  save: SaveLaneEditsResult | 'throws';
  adopt: AdoptLaneResult | 'throws';
  runnerOk: boolean;
  runnerHasAbort: boolean;
  abort: 'aborted' | 'still-running' | 'refused' | 'unknown' | 'throws';
  journalRead: 'ok' | 'unreadable' | 'throws';
  journalAppend: 'ok' | 'refused' | 'throws';
}

interface HarnessOptions {
  readonly now?: () => string;
  readonly computeDigest?: (text: string) => string;
}

interface Harness {
  useCase: ApplyRelaunchUseCase;
  journal: CutoverJournalPort;
  events: string[];
  state: State;
  calls: { save: unknown[]; adopt: unknown[]; abort: unknown[] };
}

let entryCounter = 0;
const nextEntryId = (): string => {
  entryCounter += 1;
  return `01HZ${String(entryCounter).padStart(22, '0')}`;
};

function harness(overrides: Partial<State> = {}, options: HarnessOptions = {}): Harness {
  const events: string[] = [];
  const calls: Harness['calls'] = { save: [], adopt: [], abort: [] };
  const state: State = {
    owner: 'approved',
    planRead: { status: 'ok', plan: validPlan() },
    run: runRecord(),
    workOrder: { workOrderId: 'wo-1', laneId: CONDUCTED_LANE, state: 'running' },
    attempt: { attemptId: ATTEMPT_ID },
    save: savedResult(),
    adopt: adoptedResult(),
    runnerOk: true,
    runnerHasAbort: true,
    abort: 'aborted',
    journalRead: 'ok',
    journalAppend: 'ok',
    ...overrides,
  };
  const storage = new CutoverJournalAdapter();
  const journal: CutoverJournalPort = {
    listByKeyPrefix: async (prefix: string): Promise<CutoverJournalListResult> => {
      if (state.journalRead === 'unreadable') return { outcome: 'unreadable' };
      if (state.journalRead === 'throws') throw new Error('journal read failed');
      return storage.listByKeyPrefix(prefix);
    },
    append: async (entry: CutoverJournalEntry): Promise<CutoverJournalAppendResult> => {
      if (state.journalAppend === 'refused') return { outcome: 'refused', reason: 'store-read-only' };
      if (state.journalAppend === 'throws') throw new Error('journal append failed');
      return storage.append(entry);
    },
  };

  const deps: ApplyRelaunchDependencies = {
    relaunchPlanRepository: {
      readByDigest: async () => {
        if (state.planRead === 'throws') throw new Error('plan store failed');
        return state.planRead;
      },
    },
    cutoverJournal: journal,
    ownerDecisions: {
      resolveOwnerDecision: async () => {
        events.push('owner');
        if (state.owner === 'throws') throw new Error('owner store failed');
        if (state.owner === 'approved') return { outcome: 'approved', decisionId: 'od-1' };
        if (state.owner === 'not-approved') return { outcome: 'not-approved', reason: 'grant-expired' };
        return { outcome: 'unknown', reason: 'reference-unreadable' };
      },
    },
    laneRunRepository: {
      get: async () => {
        if (state.run === 'throws') throw new Error('run store failed');
        return state.run as never;
      },
      create: async () => ({ outcome: 'refused', reason: 'invalid-record' }),
      save: async () => ({ outcome: 'refused', reason: 'invalid-record' }),
      list: async () => [],
      acquireLease: async () => ({ outcome: 'refused', reason: 'invalid-record' }),
      renewLease: async () => ({ outcome: 'refused', reason: 'invalid-record' }),
      releaseLease: async () => ({ outcome: 'refused', reason: 'invalid-record' }),
    },
    attemptRepository: {
      findAttemptById: async () => {
        if (state.attempt === 'throws') throw new Error('attempt store failed');
        return state.attempt as never;
      },
      saveAttempt: async () => undefined,
      listAttemptsByWorkOrder: async () => [],
      listAllAttempts: async () => [],
    },
    saveLaneEdits: {
      saveLaneEdits: async (request) => {
        events.push('save');
        calls.save.push(request);
        const result = state.save;
        // Mirror CO27: the delegated use case journals its own intent and result.
        if (typeof result === 'object' && (result.outcome === 'saved' || result.outcome === 'already-saved')) {
          await journal.append({
            key: stepKey(ADOPTABLE_LANE, 'save'),
            kind: 'intent',
            entryId: nextEntryId(),
            recordedAtIso: NOW,
          });
          await journal.append({
            key: stepKey(ADOPTABLE_LANE, 'save'),
            kind: 'result',
            entryId: nextEntryId(),
            recordedAtIso: NOW,
            outcome: 'completed',
            reasonCode: result.outcome,
            digest: result.treeDigest,
            commitId: result.commitId,
            saveRef: result.saveRef,
          });
        }
        return result;
      },
    } as SaveLaneEditsPort,
    adoptLane: {
      adoptLane: async (request) => {
        events.push('adopt');
        calls.adopt.push(request);
        if (state.adopt === 'throws') throw new Error('adopt failed');
        return state.adopt;
      },
    } as AdoptLanePort,
    runnerForAttempt: {
      runnerForAttempt: (request) => {
        events.push('runner');
        calls.abort.push(request);
        if (!state.runnerOk) return { ok: false as const, reason: 'host-unreachable' };
        const runner = {
          describeCapabilities: () => ({}),
          startSession: async () => ({}),
          inspectSession: async () => ({}),
          stopSession: async () => ({}),
          ...(state.runnerHasAbort
            ? {
                abortWorktreeRun: async () => {
                  events.push('abort');
                  if (state.abort === 'throws') throw new Error('abort failed');
                  if (state.abort === 'aborted') return { outcome: 'aborted' as const, endedAtIso: NOW };
                  return { outcome: state.abort as 'still-running' | 'refused' | 'unknown', reason: 'x' };
                },
              }
            : {}),
        };
        return { ok: true as const, runner: runner as unknown as ExecutionRunnerPort };
      },
    },
    ...(state.workOrder === 'absent' ? {} : {
      workOrderRepository: {
        findWorkOrderById: async () => {
          if (state.workOrder === 'throws') throw new Error('work order store failed');
          return state.workOrder as never;
        },
        saveWorkOrder: async () => undefined,
        listWorkOrdersByProject: async () => [],
      },
    }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.computeDigest === undefined ? {} : { computeDigest: options.computeDigest }),
  };
  return { useCase: new ApplyRelaunchUseCase(deps), journal, events, state, calls };
}

/** Seed one intent and one completed result for a step key. */
async function seedCompleted(
  journal: CutoverJournalPort,
  key: string,
  fields: Partial<CutoverJournalEntry> = {},
): Promise<void> {
  await journal.append({ key, kind: 'intent', entryId: nextEntryId(), recordedAtIso: NOW });
  await journal.append({
    key,
    kind: 'result',
    entryId: nextEntryId(),
    recordedAtIso: NOW,
    outcome: 'completed',
    reasonCode: 'done',
    ...fields,
  });
}

const apply = async (useCase: ApplyRelaunchUseCase, request: unknown): Promise<ApplyRelaunchResult> =>
  useCase.applyRelaunch(request as ApplyRelaunchRequest);

describe('ApplyRelaunchUseCase — refusals', () => {
  it('test_request_invalid_null_refused: a null, non-object or array request is refused, never thrown', async () => {
    const { useCase } = harness();
    for (const value of [null, undefined, 'text', 5, true, [], [validRequest()]]) {
      expect(await apply(useCase, value)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
  });

  it('a Proxy whose reads throw is refused as invalid-request', async () => {
    const { useCase } = harness();
    const proxy = new Proxy(
      {},
      {
        get: () => { throw new Error('no reads'); },
        getOwnPropertyDescriptor: () => { throw new Error('no descriptors'); },
      },
    );
    expect(await apply(useCase, proxy)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('an own __proto__ key (prototype pollution) is refused as invalid-request', async () => {
    const { useCase } = harness();
    const polluted = JSON.parse(
      `{"planDigest":"${PLAN}","ownerGrantDecisionRef":"od-1","nowIso":"${NOW}","__proto__":{"x":1}}`,
    );
    expect(await apply(useCase, polluted)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('test_request_field_format_refused: a field that violates its format is refused', async () => {
    const { useCase } = harness();
    const bad: unknown[] = [
      { ...validRequest(), planDigest: 'ABCDEF0123456789' },
      { ...validRequest(), planDigest: 'abc' },
      { ...validRequest(), planDigest: 'a'.repeat(65) },
      { ...validRequest(), planDigest: 123 },
      { ...validRequest(), ownerGrantDecisionRef: '' },
      { ...validRequest(), ownerGrantDecisionRef: 'has space' },
      { ...validRequest(), ownerGrantDecisionRef: 'x'.repeat(129) },
      { ...validRequest(), nowIso: '2026-11-06T10:00:00' },
      { ...validRequest(), nowIso: 'not-a-date' },
      { ...validRequest(), deadlineIso: '2026-11-06 10:00' },
      { ...validRequest(), extraKey: 1 },
    ];
    for (const request of bad) {
      expect(await apply(useCase, request)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
  });

  it('an array-like request with an enormous length is refused as invalid-request', async () => {
    const { useCase } = harness();
    const arrayLike = { ...validRequest(), length: 1_000_000_000 };
    expect(await apply(useCase, arrayLike)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('test_secret_detected_refused: a secret-shaped request or plan string is refused', async () => {
    expect(containsSecretShape(FAKE_SECRET)).toBe(true);
    const { useCase } = harness();
    expect(
      await useCase.applyRelaunch({ ...validRequest(), ownerGrantDecisionRef: FAKE_SECRET }),
    ).toEqual({ outcome: 'refused', reason: 'secret-detected' });

    const secretPlan = validPlan();
    (secretPlan.lanes as unknown[])[0] = { ...conductedLane, targetReleaseTag: FAKE_SECRET };
    const secretPlanHarness = harness({ planRead: { status: 'ok', plan: secretPlan } });
    expect(await secretPlanHarness.useCase.applyRelaunch(validRequest())).toEqual({
      outcome: 'refused',
      reason: 'secret-detected',
    });
  });

  it('test_deadline_exceeded_at_start_unknown: a deadline already past is an unknown, before any step', async () => {
    const { useCase, events } = harness();
    const result = await useCase.applyRelaunch({ ...validRequest(), deadlineIso: EARLIER });
    expect(result).toEqual({ outcome: 'unknown', reason: 'deadline-exceeded' });
    expect(events).toEqual([]);
  });

  it('an unreadable apply clock with a deadline is an unknown', async () => {
    const { useCase } = harness({}, { now: () => 'garbage' });
    expect(await useCase.applyRelaunch({ ...validRequest(), deadlineIso: LATER })).toEqual({
      outcome: 'unknown',
      reason: 'deadline-exceeded',
    });
  });

  it('test_owner_grant_not_approved_refused: a not-approved grant is refused', async () => {
    const { useCase, events } = harness({ owner: 'not-approved' });
    expect(await useCase.applyRelaunch(validRequest())).toEqual({
      outcome: 'refused',
      reason: 'owner-grant-not-approved',
    });
    expect(events).toEqual(['owner']);
  });

  it('test_owner_grant_unknown: an unknown grant or a throwing resolver is an unknown', async () => {
    for (const owner of ['unknown', 'throws'] as const) {
      const { useCase } = harness({ owner });
      expect(await useCase.applyRelaunch(validRequest())).toEqual({
        outcome: 'unknown',
        reason: 'owner-grant-unknown',
      });
    }
  });

  it('test_plan_missing_refused: a missing plan is refused', async () => {
    const { useCase } = harness({ planRead: { status: 'missing' } });
    expect(await useCase.applyRelaunch(validRequest())).toEqual({ outcome: 'refused', reason: 'plan-missing' });
  });

  it('test_plan_store_unreadable_unknown: an unreadable plan store or a throw is an unknown', async () => {
    for (const planRead of [{ status: 'unreadable' }, 'throws'] as const) {
      const { useCase } = harness({ planRead: planRead as never });
      expect(await useCase.applyRelaunch(validRequest())).toEqual({
        outcome: 'unknown',
        reason: 'plan-store-unreadable',
      });
    }
  });

  it('test_plan_unknown_version_from_store: a store-reported unknown version is an unknown', async () => {
    const { useCase } = harness({ planRead: { status: 'unknown-version', foundVersion: 2 } });
    expect(await useCase.applyRelaunch(validRequest())).toEqual({
      outcome: 'unknown',
      reason: 'plan-unknown-version',
    });
  });

  it('test_plan_missing_schema_version_refused: an absent schemaVersion (explicit: false) is refused', async () => {
    const plan = validPlan();
    delete plan.schemaVersion;
    const { useCase } = harness({ planRead: { status: 'ok', plan } });
    expect(await useCase.applyRelaunch(validRequest())).toEqual({ outcome: 'refused', reason: 'plan-malformed' });
  });

  it('test_plan_unsupported_schema_version_unknown: a newer schemaVersion is an unknown', async () => {
    const plan = { ...validPlan(), schemaVersion: 2 };
    const { useCase } = harness({ planRead: { status: 'ok', plan } });
    expect(await useCase.applyRelaunch(validRequest())).toEqual({
      outcome: 'unknown',
      reason: 'plan-unknown-version',
    });
  });

  it('test_plan_malformed_schema_version_refused: a string, non-enumerable or getter schemaVersion is refused', async () => {
    const stringVersion = { ...validPlan(), schemaVersion: '1' };
    expect(await harness({ planRead: { status: 'ok', plan: stringVersion } }).useCase.applyRelaunch(validRequest()))
      .toEqual({ outcome: 'refused', reason: 'plan-malformed' });

    const hidden = validPlan();
    Object.defineProperty(hidden, 'schemaVersion', { value: 1, enumerable: false });
    expect(await harness({ planRead: { status: 'ok', plan: hidden } }).useCase.applyRelaunch(validRequest()))
      .toEqual({ outcome: 'refused', reason: 'plan-malformed' });

    const accessor = validPlan() as Record<string, unknown>;
    Object.defineProperty(accessor, 'schemaVersion', { get: () => 1, enumerable: true });
    expect(await harness({ planRead: { status: 'ok', plan: accessor } }).useCase.applyRelaunch(validRequest()))
      .toEqual({ outcome: 'refused', reason: 'plan-malformed' });
  });

  it('test_plan_digest_mismatch_refused: a plan stored under another digest is refused', async () => {
    const plan = { ...validPlan(), planDigest: '1111111' };
    const { useCase } = harness({ planRead: { status: 'ok', plan } });
    expect(await useCase.applyRelaunch(validRequest())).toEqual({
      outcome: 'refused',
      reason: 'plan-digest-mismatch',
    });
  });

  it('test_plan_lanes_invalid_refused: lanes that are not a dense 1..256 array are refused', async () => {
    for (const lanes of [undefined, 'lanes', {}, [], { length: 1_000_000_000 }]) {
      const plan = { ...validPlan(), lanes };
      const result = await harness({ planRead: { status: 'ok', plan } }).useCase.applyRelaunch(validRequest());
      expect(result).toEqual({ outcome: 'refused', reason: 'plan-malformed' });
    }
    const holey: unknown[] = new Array(3);
    holey[0] = conductedLane;
    holey[2] = adoptableLane;
    const plan = { ...validPlan(), lanes: holey };
    expect(await harness({ planRead: { status: 'ok', plan } }).useCase.applyRelaunch(validRequest())).toEqual({
      outcome: 'refused',
      reason: 'plan-malformed',
    });
    const tooMany = Array.from({ length: 257 }, () => conductedLane);
    const over = { ...validPlan(), lanes: tooMany };
    expect(await harness({ planRead: { status: 'ok', plan: over } }).useCase.applyRelaunch(validRequest())).toEqual({
      outcome: 'refused',
      reason: 'plan-malformed',
    });
  });

  it('test_plan_lane_accessor_and_extra_keys_refused: lane and nested spec accessors or extra keys are refused', async () => {
    // An extra key on a lane entry.
    const extraKeyPlan = validPlan([{ ...conductedLane, extra: 1 }]);
    expect(await harness({ planRead: { status: 'ok', plan: extraKeyPlan } }).useCase.applyRelaunch(validRequest()))
      .toEqual(expect.objectContaining({ outcome: 'refused', reason: 'plan-malformed' }));
    // A getter on a lane entry.
    const accessorLane: Record<string, unknown> = { ...conductedLane };
    Object.defineProperty(accessorLane, 'targetReleaseTag', { get: () => 'rel-1', enumerable: true });
    const accessorPlan = validPlan([accessorLane]);
    expect(await harness({ planRead: { status: 'ok', plan: accessorPlan } }).useCase.applyRelaunch(validRequest()))
      .toEqual({ outcome: 'refused', reason: 'plan-malformed' });
    // An extra key on a nested save spec.
    const extraSpecPlan = validPlan([{ ...adoptableLane, save: { ...saveSpec, extra: 1 } }]);
    expect(await harness({ planRead: { status: 'ok', plan: extraSpecPlan } }).useCase.applyRelaunch(validRequest()))
      .toEqual(expect.objectContaining({ outcome: 'refused', reason: 'plan-malformed' }));
    // A getter on a nested abort spec.
    const accessorSpec: Record<string, unknown> = { ...abortSpec };
    Object.defineProperty(accessorSpec, 'gracePeriodSeconds', { get: () => 30, enumerable: true });
    const accessorSpecPlan = validPlan([{ ...adoptableLane, abort: accessorSpec }]);
    expect(await harness({ planRead: { status: 'ok', plan: accessorSpecPlan } }).useCase.applyRelaunch(validRequest()))
      .toEqual(expect.objectContaining({ outcome: 'refused', reason: 'plan-malformed' }));
    // A nested spec that is not a plain object.
    const wrongSpecPlan = validPlan([{ ...adoptableLane, adopt: 'adopt' }]);
    expect(await harness({ planRead: { status: 'ok', plan: wrongSpecPlan } }).useCase.applyRelaunch(validRequest()))
      .toEqual(expect.objectContaining({ outcome: 'refused', reason: 'plan-malformed' }));
  });

  it('test_conducted_plan_malformed_refused: a conducted lane with laneId !== runId or wrong steps is refused', async () => {
    const mismatched = { ...conductedLane, runId: 'other-run' };
    const wrongSteps = { ...conductedLane, steps: ['save'] };
    for (const lane of [mismatched, wrongSteps]) {
      const result = await harness({ planRead: { status: 'ok', plan: validPlan([lane]) } }).useCase.applyRelaunch(validRequest());
      expect(result).toEqual({ outcome: 'refused', reason: 'plan-malformed', laneId: CONDUCTED_LANE });
    }
  });

  it('test_cutover_journal_unreadable_unknown: an unreadable or throwing journal is an unknown', async () => {
    for (const journalRead of ['unreadable', 'throws'] as const) {
      const { useCase, events } = harness({ journalRead });
      expect(await useCase.applyRelaunch(validRequest())).toEqual({
        outcome: 'unknown',
        reason: 'cutover-journal-unreadable',
      });
      expect(events).not.toContain('save');
    }
  });

  it('test_idempotency_conflict_refused: a refused result or a mismatched intent digest is refused', async () => {
    const refusedSeed = harness();
    await refusedSeed.journal.append({
      key: SWAP_KEY,
      kind: 'intent',
      entryId: nextEntryId(),
      recordedAtIso: NOW,
    });
    await refusedSeed.journal.append({
      key: SWAP_KEY,
      kind: 'result',
      entryId: nextEntryId(),
      recordedAtIso: NOW,
      outcome: 'refused',
      reasonCode: 'driver-busy',
    });
    expect(await refusedSeed.useCase.applyRelaunch(validRequest())).toEqual({
      outcome: 'refused',
      reason: 'idempotency-conflict',
      laneId: CONDUCTED_LANE,
    });

    const mismatchSeed = harness();
    await mismatchSeed.journal.append({
      key: SAVE_KEY,
      kind: 'intent',
      entryId: nextEntryId(),
      recordedAtIso: NOW,
      digest: pureSha256Hex('something-else'),
    });
    expect(await mismatchSeed.useCase.applyRelaunch(validRequest())).toEqual({
      outcome: 'refused',
      reason: 'idempotency-conflict',
      laneId: ADOPTABLE_LANE,
    });
  });

  it('test_save_replay_incomplete_fields_refused: a completed save without verifiable fields is refused', async () => {
    for (const fields of [
      { digest: TREE, commitId: COMMIT }, // saveRef missing
      { digest: TREE, saveRef: SAVE_REF }, // commitId missing
      { commitId: COMMIT, saveRef: SAVE_REF }, // digest missing
      { digest: TREE, commitId: COMMIT, saveRef: 'refs/fleet/saved/x..y' }, // unsafe saveRef
    ]) {
      const seeded = harness();
      await seedCompleted(seeded.journal, SAVE_KEY, fields);
      expect(await seeded.useCase.applyRelaunch(validRequest())).toEqual({
        outcome: 'refused',
        reason: 'idempotency-conflict',
        laneId: ADOPTABLE_LANE,
      });
    }
  });

  it('test_lane_run_store_unavailable_unknown: a throwing run or work-order store is an unknown', async () => {
    const runThrows = harness({ run: 'throws' });
    expect(await runThrows.useCase.applyRelaunch(validRequest())).toEqual({
      outcome: 'unknown',
      reason: 'lane-run-store-unavailable',
      laneId: CONDUCTED_LANE,
    });
    const workOrderThrows = harness({ workOrder: 'throws' });
    expect(await workOrderThrows.useCase.applyRelaunch(validRequest())).toEqual({
      outcome: 'unknown',
      reason: 'lane-run-store-unavailable',
      laneId: CONDUCTED_LANE,
    });
  });

  it('test_conducted_run_missing_or_mismatch_refused: a missing run or an identity mismatch is refused', async () => {
    for (const run of [
      null,
      runRecord({ runId: 'other-run' }),
      runRecord({ laneId: 'other-lane' }),
    ]) {
      const { useCase } = harness({ run: run as never });
      expect(await useCase.applyRelaunch(validRequest())).toEqual({
        outcome: 'refused',
        reason: 'conducted-run-missing',
        laneId: CONDUCTED_LANE,
      });
    }
    const { useCase } = harness({ workOrder: { workOrderId: 'wo-1', laneId: 'other-lane', state: 'running' } });
    expect(await useCase.applyRelaunch(validRequest())).toEqual({
      outcome: 'refused',
      reason: 'conducted-run-missing',
      laneId: CONDUCTED_LANE,
    });
  });

  it('test_conducted_run_terminal_refused: a terminal run or work order is refused without a completed swap', async () => {
    for (const run of [runRecord({ state: 'stopped' }), runRecord({ state: 'merged' })]) {
      const { useCase } = harness({ run });
      expect(await useCase.applyRelaunch(validRequest())).toEqual({
        outcome: 'refused',
        reason: 'conducted-run-terminal',
        laneId: CONDUCTED_LANE,
      });
    }
    const { useCase } = harness({ workOrder: { workOrderId: 'wo-1', laneId: CONDUCTED_LANE, state: 'stopped' } });
    expect(await useCase.applyRelaunch(validRequest())).toEqual({
      outcome: 'refused',
      reason: 'conducted-run-terminal',
      laneId: CONDUCTED_LANE,
    });
  });

  it('test_attempt_store_unavailable_unknown: a throwing attempt store is an unknown', async () => {
    const { useCase } = harness({ attempt: 'throws' });
    expect(await useCase.applyRelaunch(validRequest())).toEqual({
      outcome: 'unknown',
      reason: 'attempt-store-unavailable',
      laneId: ADOPTABLE_LANE,
    });
  });

  it('test_attempt_missing_refused: a recorded attempt id that resolves to null is refused', async () => {
    const { useCase } = harness({ attempt: null });
    expect(await useCase.applyRelaunch(validRequest())).toEqual({
      outcome: 'refused',
      reason: 'attempt-missing',
      laneId: ADOPTABLE_LANE,
    });
  });
  it('a later lane preflight refusal runs before any earlier lane writes or acts', async () => {
    const plan = validPlan([adoptableLane, conductedLane]);
    const { useCase, events, journal } = harness({
      planRead: { status: 'ok', plan },
      run: runRecord({ runId: 'other-run' }),
    });
    const result = await useCase.applyRelaunch(validRequest());
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'conducted-run-missing',
      laneId: CONDUCTED_LANE,
    });
    expect(events).toEqual(['owner']);
    const listed = await journal.listByKeyPrefix(`relaunch/${PLAN}/`);
    if (listed.outcome === 'listed') expect(listed.entries).toEqual([]);
  });
});

describe('ApplyRelaunchUseCase — partial outcomes', () => {
  it('test_deadline_exceeded_mid_execution_partial: the deadline stops the plan before the next step', async () => {
    // Calls: start check, swap pre-check, swap intent, swap result, save pre-check.
    const clock = [NOW, NOW, NOW, NOW, LATER];
    const { useCase } = harness({}, { now: () => clock.shift() ?? LATER });
    const result = await useCase.applyRelaunch({ ...validRequest(), deadlineIso: LATER });
    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'partial',
        reason: 'deadline-exceeded',
        stoppedLaneId: ADOPTABLE_LANE,
        stoppedStep: 'save',
      }),
    );
    if (result.outcome === 'partial') {
      expect(result.lanes.map((lane) => lane.status)).toEqual(['completed', 'halted']);
      expect(result.lanes[0].completedSteps).toEqual(['driver-swap']);
      expect(result.lanes[1].completedSteps).toEqual([]);
      expect(result.lanes[1].pendingSteps).toEqual(['abort', 'adopt', 'redispatch']);
    }
  });

  it('test_save_refused_partial: a refused save stops the lane before any abort', async () => {
    const { useCase, events } = harness({ save: { outcome: 'refused', reason: 'diff-check-findings', detail: null } });
    const result = await useCase.applyRelaunch(validRequest());
    expect(result).toEqual(
      expect.objectContaining({ outcome: 'partial', reason: 'save-refused', stoppedLaneId: ADOPTABLE_LANE, stoppedStep: 'save' }),
    );
    expect(events).not.toContain('abort');
  });

  it('test_save_unknown_partial: an unknown or throwing save is a save-unknown partial', async () => {
    const unknownHarness = harness({ save: { outcome: 'unknown', reason: 'save-unknown' } });
    expect(await unknownHarness.useCase.applyRelaunch(validRequest())).toEqual(
      expect.objectContaining({ outcome: 'partial', reason: 'save-unknown', stoppedLaneId: ADOPTABLE_LANE, stoppedStep: 'save' }),
    );
    const throwsHarness = harness({ save: 'throws' });
    expect(await throwsHarness.useCase.applyRelaunch(validRequest())).toEqual(
      expect.objectContaining({ outcome: 'partial', reason: 'save-unknown' }),
    );
  });

  it('test_abort_without_save_partial: an abort step without a verified save is refused to the lane', async () => {
    const plan = validPlan([{ ...adoptableLane, steps: ['abort'], save: undefined }]);
    const { useCase } = harness({ planRead: { status: 'ok', plan } });
    const result = await useCase.applyRelaunch(validRequest());
    expect(result).toEqual(expect.objectContaining({ outcome: 'partial', reason: 'abort-without-save' }));
  });

  it('test_abort_runner_unavailable_partial: a failed runner resolution or a missing abort is a partial', async () => {
    const noRunner = harness({ runnerOk: false });
    expect(await noRunner.useCase.applyRelaunch(validRequest())).toEqual(
      expect.objectContaining({ outcome: 'partial', reason: 'abort-runner-unavailable', stoppedStep: 'abort' }),
    );
    const noMethod = harness({ runnerHasAbort: false });
    expect(await noMethod.useCase.applyRelaunch(validRequest())).toEqual(
      expect.objectContaining({ outcome: 'partial', reason: 'abort-runner-unavailable' }),
    );
  });

  it('test_abort_failed_partial: a refused abort is a partial', async () => {
    const { useCase, events } = harness({ abort: 'refused' });
    const result = await useCase.applyRelaunch(validRequest());
    expect(result).toEqual(expect.objectContaining({ outcome: 'partial', reason: 'abort-failed', stoppedStep: 'abort' }));
    expect(events).not.toContain('adopt');
  });

  it('test_abort_not_idle_partial: a still-running, unknown or throwing abort is a partial', async () => {
    for (const abort of ['still-running', 'unknown', 'throws'] as const) {
      const { useCase } = harness({ abort });
      expect(await useCase.applyRelaunch(validRequest())).toEqual(
        expect.objectContaining({ outcome: 'partial', reason: 'abort-not-idle', stoppedStep: 'abort' }),
      );
    }
  });

  it('test_adopt_failures_partial: refused, budget-exhausted, unknown and throwing adopts are partials', async () => {
    const refused = harness({ adopt: { outcome: 'refused', reason: 'save-unverified' } });
    expect(await refused.useCase.applyRelaunch(validRequest())).toEqual(
      expect.objectContaining({ outcome: 'partial', reason: 'adopt-refused', stoppedStep: 'adopt' }),
    );
    const budget = harness({ adopt: { outcome: 'budget-exhausted', completedSteps: [], nextStep: 'work-order' } });
    expect(await budget.useCase.applyRelaunch(validRequest())).toEqual(
      expect.objectContaining({ outcome: 'partial', reason: 'adopt-budget-exhausted' }),
    );
    const unknownAdopt = harness({ adopt: { outcome: 'unknown', reason: 'lane-run-store-unavailable' } });
    expect(await unknownAdopt.useCase.applyRelaunch(validRequest())).toEqual(
      expect.objectContaining({ outcome: 'partial', reason: 'adopt-unknown' }),
    );
    const throws = harness({ adopt: 'throws' });
    expect(await throws.useCase.applyRelaunch(validRequest())).toEqual(
      expect.objectContaining({ outcome: 'partial', reason: 'adopt-unknown' }),
    );
  });

  it('test_journal_write_failed_partial: a refused or throwing append is a partial', async () => {
    const refusedAppend = harness({ journalAppend: 'refused' });
    expect(await refusedAppend.useCase.applyRelaunch(validRequest())).toEqual(
      expect.objectContaining({
        outcome: 'partial',
        reason: 'journal-write-failed',
        stoppedLaneId: CONDUCTED_LANE,
        stoppedStep: 'driver-swap',
      }),
    );
    const throwingAppend = harness({ journalAppend: 'throws' });
    expect(await throwingAppend.useCase.applyRelaunch(validRequest())).toEqual(
      expect.objectContaining({ outcome: 'partial', reason: 'journal-write-failed' }),
    );
  });

  it('a step with an intent but no result is reconciled read-only, never repeated', async () => {
    const seeded = harness();
    await seeded.journal.append({ key: SWAP_KEY, kind: 'intent', entryId: nextEntryId(), recordedAtIso: NOW });
    const result = await seeded.useCase.applyRelaunch(validRequest());
    expect(result).toEqual(
      expect.objectContaining({ outcome: 'partial', reason: 'step-failed', stoppedStep: 'driver-swap' }),
    );
  });
});

describe('ApplyRelaunchUseCase — applied', () => {
  it('a fresh apply runs every step in order and reports each lane', async () => {
    const { useCase, events } = harness();
    const result = await useCase.applyRelaunch(validRequest());
    expect(result.outcome).toBe('applied');
    if (result.outcome === 'applied') {
      expect(result.reused).toBe(false);
      expect(result.lanes).toHaveLength(2);
      const [conducted, adoptable] = result.lanes;
      expect(conducted).toEqual(
        expect.objectContaining({ laneId: CONDUCTED_LANE, status: 'completed', completedSteps: ['driver-swap'] }),
      );
      expect(adoptable).toEqual(
        expect.objectContaining({
          laneId: ADOPTABLE_LANE,
          status: 'completed',
          completedSteps: ['save', 'abort', 'adopt', 'redispatch'],
          saveRef: SAVE_REF,
          commitId: COMMIT,
        }),
      );
    }
    expect(events).toEqual(['owner', 'save', 'runner', 'abort', 'adopt']);
  });

  it('an abort journals its intent before the action and its verified result after', async () => {
    const h = harness();
    await h.useCase.applyRelaunch(validRequest());
    const listed = await h.journal.listByKeyPrefix(`relaunch/${PLAN}/`);
    expect(listed.outcome).toBe('listed');
    if (listed.outcome === 'listed') {
      const abortEntries = listed.entries.filter((entry) => entry.key === ABORT_KEY);
      expect(abortEntries).toHaveLength(2);
      expect(abortEntries[0].kind).toBe('intent');
      expect(abortEntries[0].digest).toBe(pureSha256Hex(JSON.stringify([PLAN, ADOPTABLE_LANE, 'abort', abortSpec])));
      expect(abortEntries[1]).toEqual(
        expect.objectContaining({ kind: 'result', outcome: 'completed', reasonCode: 'aborted' }),
      );
    }
  });

  it('a full replay reuses every recorded step and writes nothing', async () => {
    const h = harness();
    await seedCompleted(h.journal, SWAP_KEY);
    await seedCompleted(h.journal, SAVE_KEY, { digest: TREE, commitId: COMMIT, saveRef: SAVE_REF, reasonCode: 'saved' });
    await seedCompleted(h.journal, ABORT_KEY);
    await seedCompleted(h.journal, ADOPT_KEY);
    await seedCompleted(h.journal, REDISPATCH_KEY);
    const result = await h.useCase.applyRelaunch(validRequest());
    expect(result.outcome).toBe('applied');
    if (result.outcome === 'applied') {
      expect(result.reused).toBe(true);
      for (const lane of result.lanes) expect(lane.status).toBe('reused');
    }
    expect(h.events).toEqual(['owner']);
  });

  it('mixed conducted and adoptable lanes apply with per-lane population reports', async () => {
    const plan = validPlan([
      conductedLane,
      { laneId: 'lane-b', population: 'unrecorded', attemptId: null, steps: ['save', 'adopt'], save: saveSpec, adopt: adoptSpec },
    ]);
    const { useCase } = harness({ planRead: { status: 'ok', plan } });
    const result = await useCase.applyRelaunch(validRequest());
    expect(result.outcome).toBe('applied');
    if (result.outcome === 'applied') {
      expect(result.lanes.map((lane) => lane.population)).toEqual(['conducted', 'unrecorded']);
      expect(result.lanes[1].completedSteps).toEqual(['save', 'adopt']);
    }
  });

  it('a terminal conducted run applies when its driver-swap already completed', async () => {
    const h = harness({ run: runRecord({ state: 'stopped' }) });
    await seedCompleted(h.journal, SWAP_KEY);
    const result = await h.useCase.applyRelaunch(validRequest());
    expect(result.outcome).toBe('applied');
    if (result.outcome === 'applied') expect(result.lanes[0].status).toBe('reused');
  });

  it('the delegated adopt receives the plan digest, lane id and clocks', async () => {
    const { useCase, calls } = harness();
    await useCase.applyRelaunch({ ...validRequest(), deadlineIso: LATER });
    const request = calls.adopt.find(
      (entry) => typeof entry === 'object' && entry !== null && 'planDigest' in (entry as object),
    ) as Record<string, unknown> | undefined;
    expect(request).toBeDefined();
    expect(request?.planDigest).toBe(PLAN);
    expect(request?.laneId).toBe(ADOPTABLE_LANE);
    expect(typeof request?.nowIso).toBe('string');
    expect(request?.deadlineIso).toBe(LATER);
  });
});

describe('ApplyRelaunchUseCase — entry points', () => {
  it('execute accepts unknown input and returns the same typed result', async () => {
    const { useCase } = harness();
    expect(await useCase.execute(null)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await useCase.execute(validRequest())).toEqual(expect.objectContaining({ outcome: 'applied' }));
  });

  it('an unexpected throw anywhere becomes apply-unknown, never an escaping error', async () => {
    const { useCase } = harness(
      {},
      {
        computeDigest: () => {
          throw new Error('digest failed');
        },
      },
    );
    expect(await useCase.applyRelaunch(validRequest())).toEqual({ outcome: 'unknown', reason: 'apply-unknown' });
  });
});
