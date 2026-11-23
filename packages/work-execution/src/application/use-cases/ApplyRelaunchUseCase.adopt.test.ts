// AR2c — ApplyRelaunchUseCase adopt step tests: the `adopt` action inside the
// live apply. A held lane whose plan step is `adopt` adopts its existing
// worktree into a conducted run through `AdoptLanePort`, inside the same
// capacity rule as `redispatch`, idempotent on replay, and fail-closed on any
// missing port, missing input, stale plan state or exhausted budget.
//
// Every case feeds plain values — or a Proxy, getter, hole, array-like or
// polluting key where the inspection itself is the subject — and asserts the
// exact typed result. Getters and Proxy traps are counting traps: a refusal
// must never invoke one (`reads === 0`). Cost bounds are stated per case.
// Each case would fail against a constant or an identity implementation: the
// refusals differ per reason, the adopt input is forwarded field-by-field to
// the `adoptLane` spy, and the capacity counters are observed through which
// lanes hand off.

import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { canonicalSaveInputJson } from '../../domain/relaunch-apply.js';
import type { FindRelaunchPlanResult } from '../ports/out/RelaunchPlanRepositoryPort.out-port.js';
import {
  canonicalRelaunchPlanBodyJson,
  type RelaunchPlanRecord,
} from '../ports/out/RelaunchPlanRepositoryPort.out-port.js';
import type {
  CutoverJournalAppendResult,
  CutoverJournalEntry,
  CutoverJournalListResult,
} from '../ports/out/CutoverJournalPort.out-port.js';
import type { AuthorizeRelaunchApplyResult } from '../ports/out/ActionAuthorizationPort.out-port.js';
import type {
  AbortWorktreeRunRequest,
  AbortWorktreeRunResult,
  WorktreeRunRef,
  WorktreeRunState,
} from '../ports/out/ExecutionRunnerPort.out-port.js';
import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import type { LaneRunJournalEntryRecord } from '../../domain/lane-run-journal.js';
import type { AdoptLanePort } from '../ports/in/AdoptLanePort.in-port.js';
import type {
  SaveLaneEditsRequest,
  SaveLaneEditsResult,
} from '../ports/in/SaveLaneEditsPort.in-port.js';
import type {
  TerminateWorktreeProcessesRequest,
  TerminateWorktreeProcessesResult,
} from '../ports/out/ProcessTreeTerminationPort.out-port.js';
import { ApplyRelaunchUseCase } from './ApplyRelaunchUseCase.use-case.js';

const NOW = '2026-11-23T10:00:00Z';
const CLOCK_NOW = '2026-11-23T09:59:00Z';
const DEADLINE = '2026-11-23T10:30:00Z';
const PAST_DEADLINE = '2026-11-23T11:00:00Z';

const computeDigest = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The digest `adoptInputIdentity` computes for a resent adopt input: the
 * journaled `adopt/work-order` completed result must carry exactly this, or
 * the preflight refuses the lane (AR3c1).
 */
const adoptIdentityDigest = (laneId: string, input: Record<string, unknown>): string => {
  const part = (holder: unknown, field: string): unknown =>
    holder !== null && typeof holder === 'object' ? (holder as Record<string, unknown>)[field] : undefined;
  return computeDigest(
    JSON.stringify([
      'adopt-lane-ids/1',
      input['projectId'],
      part(input['planRef'], 'planId'),
      laneId,
      part(input['workOrder'], 'workOrderId'),
      part(input['brief'], 'briefId'),
      part(input['attempt'], 'attemptId'),
      part(input['run'], 'runId'),
    ]),
  );
};

const hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The fixture brief text and its REAL digest: the preflight verifies it before any side effect. */
const BRIEF_TEXT = 'do the thing';
const BRIEF_DIGEST = hex(BRIEF_TEXT);

type PlannedStep = { step: string; idempotencyKey: string };

interface FixtureLane {
  laneId: string;
  hostName: string;
  projectId: string | null;
  population: 'conducted' | 'unrecorded';
  runnerState: 'idle' | 'running';
  runId: string | null;
  attemptId: string | null;
  workOrderId: string | null;
  baseBranch: string;
  chainHead: boolean;
  dependsOnLaneIds: string[];
  admissionWave: number;
  dispatchEndpointKey: string | null;
  staggerOffsetMs: number | null;
  steps: PlannedStep[];
}

const step = (digest: string, laneId: string, code: string): PlannedStep => ({
  step: code,
  idempotencyKey: `relaunch/${digest}/${laneId}/${code}`,
});

const ADOPT_SUB_STEPS = ['work-order', 'brief', 'attempt', 'run'] as const;

const conductedLaneWithRun = (laneId = 'lane-1', runId = 'run-1'): FixtureLane => ({
  laneId,
  hostName: 'host-a',
  projectId: null,
  population: 'conducted' as const,
  runnerState: 'running' as const,
  runId,
  attemptId: null,
  workOrderId: null,
  baseBranch: 'main',
  chainHead: true,
  dependsOnLaneIds: [],
  admissionWave: 0,
  dispatchEndpointKey: null,
  staggerOffsetMs: null,
  steps: [],
});

const heldLane = (digest: string, laneId = 'lane-2', wave = 1): FixtureLane => ({
  laneId,
  hostName: 'host-b',
  projectId: 'proj-1',
  population: 'unrecorded' as const,
  runnerState: 'idle' as const,
  runId: null,
  attemptId: null,
  workOrderId: 'wo-9',
  baseBranch: 'chain/relaunch-2',
  chainHead: false,
  dependsOnLaneIds: ['lane-1'],
  admissionWave: wave,
  dispatchEndpointKey: 'opencode:host-b:4321',
  staggerOffsetMs: 0,
  steps: [
    step(digest, laneId, 'save'),
    step(digest, laneId, 'adopt'),
    step(digest, laneId, 'redispatch'),
  ],
});

/** A valid stored plan for the given lanes, digested over its canonical body. */
const buildPlan = (lanes: FixtureLane[], maxActiveRuns = 3): RelaunchPlanRecord => {
  const placeholder = '0'.repeat(64);
  const keyed = lanes.map((lane) => ({
    ...lane,
    steps: lane.steps.map((s) => ({
      step: s.step,
      idempotencyKey: `relaunch/${placeholder}/${lane.laneId}/${s.step}`,
    })),
  }));
  const body = {
    schemaVersion: 1 as const,
    hostFilter: null,
    maxActiveRuns,
    dispatchStaggerMs: 250,
    conductor: { halted: true, driverLease: 'lapsed' as const, runCount: 2 },
    lanes: keyed,
  };
  const planDigest = computeDigest(
    canonicalRelaunchPlanBodyJson(body as unknown as Parameters<typeof canonicalRelaunchPlanBodyJson>[0]),
  );
  const record = {
    ...body,
    planDigest,
    requestDigest: 'a'.repeat(64),
    createdAtIso: CLOCK_NOW,
    lanes: keyed.map((lane) => ({
      ...lane,
      steps: lane.steps.map((s) => ({
        step: s.step,
        idempotencyKey: `relaunch/${planDigest}/${lane.laneId}/${s.step}`,
      })),
    })),
  };
  return record as unknown as RelaunchPlanRecord;
};

const intent = (key: string, digest: string | null = null) => ({
  key,
  kind: 'intent',
  entryId: 'entry-1',
  recordedAtIso: CLOCK_NOW,
  outcome: undefined,
  digest,
});

const result = (key: string, outcome: string, over: Record<string, unknown> = {}) => ({
  key,
  kind: 'result',
  entryId: 'entry-2',
  recordedAtIso: CLOCK_NOW,
  outcome,
  digest: null,
  ...over,
});

const saveInput = (over: Record<string, unknown> = {}) => ({
  laneId: 'lane-2',
  attemptId: 'attempt-1',
  worktreePath: '/wt/lane-2',
  clonePath: '/clone/lane-2',
  recordedHost: null,
  baseCommit: 'b'.repeat(64),
  allowedPathPrefixes: ['src/'],
  ...over,
});

/** The digest a matching save intent would carry for `input`. */
const saveInputDigest = (planDigest: string, input: Record<string, unknown>): string => {
  const canonical = canonicalSaveInputJson(planDigest, input);
  if (canonical === null) throw new Error('fixture save input must canonicalize');
  return computeDigest(canonical);
};

const SAVE_REF = 'refs/fleet/saved/lane-2';
const COMMIT = 'c'.repeat(64);
const TREE = 'd'.repeat(64);

/** Fix-round item 2 hardening: run ids in the `LANE_RUN_ID_PATTERN` grammar. */
const RUN_9 = `run-7${'A'.repeat(25)}`;
const RUN_10 = `run-7${'B'.repeat(25)}`;
const RUN_11 = `run-7${'C'.repeat(25)}`;

/** A completed save result that carries the ref, commit id and tree digest. */
const savedResult = (key: string): Record<string, unknown> =>
  result(key, 'completed', { saveRef: SAVE_REF, commitId: COMMIT, digest: TREE });

/** A valid adopt input for the held lane; every cross-check matches the fixtures. */
const adoptInput = (over: Record<string, unknown> = {}): Record<string, unknown> => {
  const base = {
    laneId: 'lane-2',
    projectId: 'proj-1',
    baseBranch: 'chain/relaunch-2',
    workOrder: {
      workOrderId: 'wo-9',
      taskId: 'task-1',
      repository: 'repo-1',
      baseCommit: 'b'.repeat(64),
      ownedPaths: ['src/a.ts'],
      policyRevision: 'policy-1',
    },
    brief: {
      briefId: 'brief-1',
      briefText: BRIEF_TEXT,
      expectedBriefDigest: BRIEF_DIGEST,
      prosePath: 'brief/prose.md',
      manifestPath: 'brief/manifest.json',
      reviewerModel: 'reviewer-1',
      acceptanceSpec: { commitRequired: true, diffCheck: true, commands: [{ argv: ['yarn', 'test'] }] },
    },
    attempt: { attemptId: 'attempt-1', endedAtIso: CLOCK_NOW, sessionId: null },
    run: {
      runId: RUN_9,
      tier: 2,
      seatPlanRef: 'e'.repeat(64),
      runPolicyRevision: 'policy-1',
      branchName: `fleet/${RUN_9}`,
    },
    source: { kind: 'save-ref', saveRef: SAVE_REF, commitOid: COMMIT, treeDigest: TREE },
    ...over,
  };
  // The planRef mirrors the (possibly overridden) lane and project ids, as
  // the port's own grammar requires planRef.laneId and planRef.projectId to
  // match the request's.
  const laneId = typeof base['laneId'] === 'string' ? base['laneId'] : 'lane-2';
  const projectId = typeof base['projectId'] === 'string' ? base['projectId'] : 'proj-1';
  return { ...base, planRef: { projectId, planId: 'plan-1', laneId } };
};

const adopted = (): Record<string, unknown> => ({
  outcome: 'adopted',
  reused: false,
  workOrderId: 'wo-9',
  briefDigest: BRIEF_DIGEST,
  attemptId: 'attempt-1',
  runId: RUN_9,
  commitOid: COMMIT,
  enteredState: 'collecting',
  provenance: 'adopted',
});

/** An adopted result whose ids match whatever request the port received. */
const adoptedFor = (request: unknown): Record<string, unknown> => {
  const req = (request ?? {}) as {
    workOrder?: { workOrderId?: string };
    brief?: { expectedBriefDigest?: string };
    attempt?: { attemptId?: string };
    run?: { runId?: string };
    source?: { commitOid?: string };
  };
  return {
    outcome: 'adopted',
    reused: false,
    workOrderId: req.workOrder?.workOrderId ?? 'wo-9',
    briefDigest: req.brief?.expectedBriefDigest ?? BRIEF_DIGEST,
    attemptId: req.attempt?.attemptId ?? 'attempt-1',
    runId: req.run?.runId ?? RUN_9,
    commitOid: req.source?.commitOid ?? COMMIT,
    enteredState: 'collecting',
    provenance: 'adopted',
  };
};

interface Deps {
  planRepo: { findByDigest: (planDigest: string) => Promise<FindRelaunchPlanResult> };
  cutoverJournal: {
    listByKeyPrefix: (prefix: string) => Promise<CutoverJournalListResult>;
    append?: (entry: CutoverJournalEntry) => Promise<CutoverJournalAppendResult>;
  };
  computeDigest: (text: string) => string;
  authorization?: { authorizeRelaunchApply: (request: unknown) => Promise<AuthorizeRelaunchApplyResult> };
  clock: () => string;
  runRepo?: { get: (runId: string) => Promise<LaneRunRecord | null>; list: () => Promise<readonly LaneRunRecord[]> };
  runJournal?: {
    listForRun: (runId: string) => Promise<readonly LaneRunJournalEntryRecord[]>;
    listForRuns?: (runIds: readonly string[]) => Promise<ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>>;
  };
  runner?: {
    inspectWorktreeRun: (ref: WorktreeRunRef) => Promise<WorktreeRunState>;
    abortWorktreeRun: (request: AbortWorktreeRunRequest) => Promise<AbortWorktreeRunResult>;
  };
  processTreeTermination?: {
    terminateWorktreeProcesses: (
      request: TerminateWorktreeProcessesRequest,
    ) => Promise<TerminateWorktreeProcessesResult>;
  };
  saveLaneEdits?: (request: SaveLaneEditsRequest) => Promise<SaveLaneEditsResult>;
  adoptLane?: Pick<AdoptLanePort, 'adoptLane'>['adoptLane'];
  mintEntryId?: () => string;
  /** The entries appended through the journal spy, in append order. */
  appended?: Record<string, unknown>[];
}

interface LiveOver {
  noRunRepo?: boolean;
  noRunJournal?: boolean;
  noRunner?: boolean;
  noTerminate?: boolean;
  noSave?: boolean;
  noMint?: boolean;
  noAppend?: boolean;
  noAdoptLane?: boolean;
  noAuthorization?: boolean;
  run?: unknown;
  inspect?: unknown;
  inspectThrows?: boolean;
  abort?: unknown;
  save?: unknown;
  saveThrows?: boolean;
  adopt?: unknown;
  adoptThrows?: boolean;
  authorize?: unknown;
}

/** An `adoptLane` answer whose `outcome` is read through its own descriptor (never a getter). */
const plainOutcome = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'outcome');
    return descriptor !== undefined && descriptor.get === undefined ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};

/** The default environment: a valid plan, a stateful journal, healthy live ports. */
const makeDeps = (over: {
  plan?: RelaunchPlanRecord;
  entries?: unknown[];
  clock?: () => string;
  live?: LiveOver;
} = {}): Deps => {
  const plan = over.plan ?? buildPlan([conductedLaneWithRun(), heldLane(hex('adopt default plan'))]);
  const live = over.live ?? {};
  const store: Record<string, unknown>[] = [...((over.entries ?? []) as Record<string, unknown>[])];
  const appended: Record<string, unknown>[] = [];
  let entryCounter = 0;
  const append = vi.fn(async (entry: Record<string, unknown>) => {
    const record = { ...entry, entryId: `entry-${(entryCounter += 1)}` };
    appended.push(record);
    store.push(record);
    return { outcome: 'appended', entry: record };
  });
  const deps: Record<string, unknown> = {
    planRepo: {
      findByDigest: vi.fn(async () => ({ outcome: 'found', plan }) as unknown as FindRelaunchPlanResult),
    },
    cutoverJournal: {
      listByKeyPrefix: vi.fn(
        async () => ({ outcome: 'listed', entries: store }) as unknown as CutoverJournalListResult,
      ),
      append: live.noAppend ? undefined : append,
    },
    computeDigest,
    authorization: live.noAuthorization
      ? undefined
      : {
          authorizeRelaunchApply: vi.fn(async (request: unknown) => {
            if (live.authorize !== undefined) return live.authorize;
            const grantId = (request as { grantId?: string } | null)?.grantId;
            return { outcome: 'authorized', grantId } as AuthorizeRelaunchApplyResult;
          }),
        },
    clock: over.clock ?? (() => CLOCK_NOW),
    runRepo: live.noRunRepo
      ? undefined
      : {
          get: vi.fn(async () => (live.run !== undefined ? live.run : null)),
          list: vi.fn(async () => [] as readonly LaneRunRecord[]),
        },
    runJournal: live.noRunJournal
      ? undefined
      : {
          listForRun: vi.fn(async () => []),
          listForRuns: vi.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, []]))),
        },
    runner: live.noRunner
      ? undefined
      : {
          inspectWorktreeRun: vi.fn(async (_ref: unknown) => {
            if (live.inspectThrows) throw new Error('runner down');
            return live.inspect !== undefined ? live.inspect : { state: 'idle' };
          }),
          abortWorktreeRun: vi.fn(async () =>
            live.abort !== undefined ? live.abort : { outcome: 'aborted', endedAtIso: CLOCK_NOW },
          ),
        },
    processTreeTermination: live.noTerminate
      ? undefined
      : { terminateWorktreeProcesses: vi.fn(async () => ({ outcome: 'terminated', killed: 2 })) },
    saveLaneEdits: live.noSave
      ? undefined
      : vi.fn(async (request: unknown) => {
          if (live.saveThrows) throw new Error('save down');
          const answer = live.save !== undefined ? live.save : { outcome: 'saved' };
          // A real SaveLaneEdits journals the lane's save result; the fake
          // does the same so the wave's re-derivation sees the save completed.
          const outcome = plainOutcome(answer);
          const req = request as { planDigest?: unknown; laneId?: unknown };
          if (
            (outcome === 'saved' || outcome === 'already-saved') &&
            typeof req.planDigest === 'string' &&
            typeof req.laneId === 'string'
          ) {
            await append({
              key: `relaunch/${req.planDigest}/${req.laneId}/save`,
              kind: 'result',
              outcome: 'completed',
            });
          }
          return answer;
        }),
    // AR2c: the default adoptLane refuses (like any malformed port answer),
    // so a lane whose adopt runs stops with `adopt-failed`; the adopt tests
    // override `live.adopt`. An `adopted` outcome journals the four adopt
    // sub-steps, as the real AdoptLaneUseCase does, so the wave's
    // re-derivation sees the adopt completed.
    adoptLane: (live.noAdoptLane
      ? undefined
      : vi.fn(async (request: unknown) => {
          if (live.adoptThrows) throw new Error('adopt down');
          const answer =
            typeof live.adopt === 'function'
              ? await (live.adopt as (request: unknown) => unknown)(request)
              : live.adopt !== undefined
                ? live.adopt
                : { outcome: 'refused', reason: 'invalid-request' };
          if (
            plainOutcome(answer) === 'adopted' &&
            typeof (request as { planDigest?: string } | null)?.planDigest === 'string' &&
            typeof (request as { laneId?: string } | null)?.laneId === 'string'
          ) {
            const planDigest = (request as { planDigest: string }).planDigest;
            const laneId = (request as { laneId: string }).laneId;
            for (const sub of ADOPT_SUB_STEPS) {
              const subKey = `relaunch/${planDigest}/${laneId}/adopt/${sub}`;
              // A resumed adopt re-uses what the journal already holds: a real
              // AdoptLaneUseCase never journals a second intent or result for
              // a sub-step that has one.
              const has = (kind: string): boolean =>
                store.some((entry) => entry['key'] === subKey && entry['kind'] === kind);
              if (!has('intent')) await append({ key: subKey, kind: 'intent' });
              if (!has('result')) {
                // AR3c1: the completed work-order result carries the resent
                // input's identity digest, as the real AdoptLaneUseCase does.
                await append({
                  key: subKey,
                  kind: 'result',
                  outcome: 'completed',
                  ...(sub === 'work-order'
                    ? { digest: adoptIdentityDigest(laneId, request as Record<string, unknown>) }
                    : {}),
                });
              }
            }
          }
          return answer;
        })) as unknown as Deps['adoptLane'],
    mintEntryId: live.noMint ? undefined : vi.fn(() => `minted-${(entryCounter += 1)}`),
  };
  deps['appended'] = appended;
  return deps as unknown as Deps;
};

const applyRequest = (planDigest: string, over: Record<string, unknown> = {}): unknown => ({
  planDigest,
  nowIso: NOW,
  apply: true,
  grantId: 'grant-1',
  ...over,
});

/** An own accessor on `key` that counts its invocations and never fires. */
const getterOn = (target: object, key: string, calls: { count: number }): object => {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      calls.count += 1;
      return descriptor ? descriptor.value : undefined;
    },
  });
  return target;
};

/** An own `__proto__` key (a literal would set the prototype instead). */
const withPollutingKey = (key: string, value: unknown): Record<string, unknown> =>
  JSON.parse(`{"${key}": ${JSON.stringify(value)}, "ok": true}`) as Record<string, unknown>;

describe('ApplyRelaunchUseCase adopt (AR2c)', () => {
  const key = (digest: string, laneId: string, code: string): string =>
    `relaunch/${digest}/${laneId}/${code}`;
  const adoptKey = (digest: string, laneId: string, sub: string): string =>
    `relaunch/${digest}/${laneId}/adopt/${sub}`;

  /** Save intent + completed result for a lane, with the matching input digest. */
  const completedSave = (digest: string, laneId: string, input: Record<string, unknown>): unknown[] => [
    intent(key(digest, laneId, 'save'), saveInputDigest(digest, input)),
    result(key(digest, laneId, 'save'), 'completed'),
  ];

  /**
   * All four adopt sub-steps completed for a lane. AR3c1: when the wave
   * resents an adopt input, the completed work-order result journals the
   * matching identity digest, as the real AdoptLaneUseCase does.
   */
  const completedAdopt = (digest: string, laneId: string, input?: Record<string, unknown>): unknown[] =>
    ADOPT_SUB_STEPS.flatMap((sub) => [
      intent(adoptKey(digest, laneId, sub)),
      result(
        adoptKey(digest, laneId, sub),
        'completed',
        sub === 'work-order' && input !== undefined ? { digest: adoptIdentityDigest(laneId, input) } : {},
      ),
    ]);

  it('refuses stale-plan-state before authorization when adoptLane port is missing', async () => {
    const plan = buildPlan([conductedLaneWithRun(), heldLane(hex('no-port plan'))]);
    const deps = makeDeps({ plan, live: { noAdoptLane: true } });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(plan.planDigest, { saveInputs: [saveInput()], adoptInputs: [adoptInput()] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'stale-plan-state' });
    // The preflight refused: the grant was never spent and nothing was written.
    expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    expect(deps.saveLaneEdits).not.toHaveBeenCalled();
    expect(deps.appended).toEqual([]);
  });

  it('refuses stale-plan-state when adoptInput is missing for an uncompleted adopt lane', async () => {
    const plan = buildPlan([conductedLaneWithRun(), heldLane(hex('no-input plan'))]);
    const deps = makeDeps({ plan, live: { adopt: adopted() } });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(plan.planDigest, { saveInputs: [saveInput()] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'stale-plan-state', laneId: 'lane-2' });
    expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    expect(deps.appended).toEqual([]);
  });

  it('refuses invalid-plan for a held lane whose plan has no adopt step (the grammar pins it before preflight)', async () => {
    // Fix-round item 2 (documented residual): the adopt-input requirement and
    // its cross-checks are gated on the lane having an `adopt` step, matching
    // the AR2c brief exactly. The stored-plan grammar (`validateLaneStepOrder`)
    // itself refuses a non-conducted lane without an adopt step as
    // `invalid-plan` before preflight, so the gating is defensive and this
    // test pins that the grammar refusal still holds — the public entry never
    // reaches a no-adopt-step preflight lane.
    const lane = {
      ...heldLane(hex('no-adopt-step plan')),
      steps: [
        step(hex('no-adopt-step plan'), 'lane-2', 'save'),
        step(hex('no-adopt-step plan'), 'lane-2', 'redispatch'),
      ],
    };
    const plan = buildPlan([conductedLaneWithRun(), lane]);
    const deps = makeDeps({ plan, live: { adopt: adopted() } });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(plan.planDigest, { saveInputs: [saveInput()] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'invalid-plan' });
    expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    expect(deps.appended).toEqual([]);
  });

  it('refuses adopt-failed when a lying Proxy adoptLane result throws in its reflection traps', async () => {
    // Fix-round item 3: `own` reads the result through `getPrototypeOf` and
    // `getOwnPropertyDescriptor`; a Proxy that throws in those traps must
    // fail closed as `adopt-failed`, never propagate the exception out of
    // `applyRelaunch`.
    const plan = buildPlan([conductedLaneWithRun(), heldLane(hex('proxy-result plan'))]);
    const digest = plan.planDigest;
    const hostile = new Proxy(adopted(), {
      getPrototypeOf(): never {
        throw new Error('trap must not escape');
      },
      getOwnPropertyDescriptor(): never {
        throw new Error('trap must not escape');
      },
    });
    const deps = makeDeps({ plan, live: { adopt: hostile } });
    await expect(
      new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(digest, { saveInputs: [saveInput()], adoptInputs: [adoptInput()] }),
      ),
    ).resolves.toEqual({ outcome: 'refused', reason: 'adopt-failed', laneId: 'lane-2' });
    expect(
      deps.appended!.every((entry) => entry.key !== key(digest, 'lane-2', 'redispatch')),
    ).toBe(true);
  });

  it('refuses invalid-request for hostile adoptInputs shapes without invoking getters', async () => {
    const plan = buildPlan([conductedLaneWithRun(), heldLane(hex('hostile plan'))]);
    const valid = adoptInput();
    const refused = async (adoptInputs: unknown, reads?: { count: number }): Promise<void> => {
      const deps = makeDeps({ plan });
      expect(
        await new ApplyRelaunchUseCase(deps).applyRelaunch(
          applyRequest(plan.planDigest, { saveInputs: [saveInput()], adoptInputs }),
        ),
      ).toEqual({ outcome: 'refused', reason: 'invalid-request' });
      // Parsing refused: no plan read, no grant spent, no writes.
      expect(deps.planRepo.findByDigest).not.toHaveBeenCalled();
      expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
      expect(deps.appended).toEqual([]);
      if (reads) expect(reads.count).toBe(0);
    };
    await refused(null);
    await refused(undefined);
    await refused(7);
    await refused('x');
    await refused(true);
    // An array-like is not an array: refused without reading any element.
    await refused({ length: 1, 0: valid });
    // A hole is not a lane input.
    await refused(new Array(1));
    await refused([valid, valid]); // duplicate laneId
    await refused([7]); // a wrong primitive element
    // An over-long Proxy array (513 > MAX_RELAUNCH_APPLY_LANES = 512) is
    // refused in the O(1) length pre-gate before any key enumeration: the
    // Proxy get trap is never invoked.
    const reads = { count: 0 };
    const longProxy = new Proxy(new Array(513), {
      get(target, property, receiver) {
        reads.count += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    await refused(longProxy, reads);
    // A counting getter on an element's laneId is never run: the descriptor
    // scan refuses the accessor before any field check (cost: one bounded
    // descriptor read per element).
    const getterCalls = { count: 0 };
    const getterElement = getterOn(valid, 'laneId', getterCalls);
    await refused([getterElement], getterCalls);
    // A Proxy whose ownKeys trap throws is caught by the guarded parse.
    await refused([new Proxy(valid, { ownKeys() { throw new Error('trap must not escape'); } })]);
    // Prototype-polluting keys are refused and leave Object.prototype untouched.
    const pristine = { untouched: true };
    for (const polluting of ['__proto__', 'constructor', 'prototype']) {
      await refused([withPollutingKey(polluting, valid)]);
      expect((pristine as Record<string, unknown>)['untouched']).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'untouched')).toBe(false);
    }
    // Fix-round item 1: a NESTED own `constructor` or `prototype` key
    // survives both the snapshot helper and `structuredClone`, so the parse
    // must refuse it explicitly (the top-level reader alone does not see it).
    // Every input below is otherwise VALID (the nested readers ignore an
    // extra key), so only `containsPollutingKey` can refuse it: removing the
    // guard turns each case into a request that reaches the plan read.
    const validWorkOrder = valid['workOrder'] as object;
    const validBrief = valid['brief'] as object;
    for (const nested of ['constructor', 'prototype']) {
      await refused([adoptInput({ workOrder: { ...validWorkOrder, [nested]: 'hostile' } })]);
      await refused([adoptInput({ brief: { ...validBrief, [nested]: ['hostile'] } })]);
      expect((pristine as Record<string, unknown>)['untouched']).toBe(true);
    }
    // Positive control: the same extra key under an innocuous name passes the parse.
    const passes = async (adoptInputs: unknown): Promise<void> => {
      const deps = makeDeps({ plan });
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(plan.planDigest, { saveInputs: [saveInput()], adoptInputs }),
      );
      expect(deps.planRepo.findByDigest).toHaveBeenCalled();
    };
    await passes([adoptInput({ workOrder: { ...validWorkOrder, note: 'fine' } })]);
    // Over-deep: a container nested past MAX_ADOPT_SCAN_DEPTH = 8 is unreadable;
    // 4 levels of the same shape pass (so only the depth bound refuses).
    const nest = (levels: number): unknown => {
      let node: unknown = ['x'];
      for (let index = 0; index < levels; index += 1) node = [node];
      return node;
    };
    await passes([adoptInput({ workOrder: { ...validWorkOrder, junk: nest(3) } })]);
    await refused([adoptInput({ workOrder: { ...validWorkOrder, junk: nest(12) } })]);
    // Over-wide: more nodes than MAX_ADOPT_SCAN_NODES = 2048 is unreadable;
    // 100 nodes of the same shape pass.
    await passes([adoptInput({ workOrder: { ...validWorkOrder, junk: new Array(100).fill('x') } })]);
    await refused([adoptInput({ workOrder: { ...validWorkOrder, junk: new Array(2049).fill('x') } })]);
    // Aggregate text: one brief-sized string is fine, but four of them
    // (briefText plus three extras) exceed MAX_ADOPT_SCAN_CHARS although each
    // is within the per-string bound.
    const bulk = 'y'.repeat(262_144);
    await passes([adoptInput({ workOrder: { ...validWorkOrder, a: bulk }, brief: { ...validBrief, briefText: bulk, expectedBriefDigest: hex(bulk) } })]);
    await refused([
      adoptInput({
        workOrder: { ...validWorkOrder, a: bulk, b: bulk, c: bulk },
        brief: { ...validBrief, briefText: bulk, expectedBriefDigest: hex(bulk) },
      }),
    ]);
    // An element missing a required key, and one with an extra key, refuse.
    const missing = { ...valid };
    delete (missing as Record<string, unknown>)['run'];
    await refused([missing]);
    await refused([{ ...valid, extra: 'x' }]);
    // An empty briefText and one over MAX_BRIEF_TEXT_LENGTH = 262_144 refuse.
    await refused([adoptInput({ brief: { ...(valid['brief'] as object), briefText: '' } })]);
    await refused([
      adoptInput({ brief: { ...(valid['brief'] as object), briefText: 'x'.repeat(262_145) } }),
    ]);
  });

  it('refuses secret-detected when adoptInput acceptanceSpec argv contains a secret shape', async () => {
    const plan = buildPlan([conductedLaneWithRun(), heldLane(hex('secret plan'))]);
    const deps = makeDeps({ plan });
    const secret = `sk-${'a'.repeat(20)}`;
    const brief = (acceptanceSpec: unknown): Record<string, unknown> =>
      adoptInput({ brief: { ...(adoptInput()['brief'] as object), acceptanceSpec } });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(plan.planDigest, {
          saveInputs: [saveInput()],
          adoptInputs: [brief({ commands: [{ argv: ['run', '--token', secret] }] })],
        }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'secret-detected' });
    expect(deps.planRepo.findByDigest).not.toHaveBeenCalled();
    expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
  });

  it('refuses stale-plan-state for each adoptInput cross-check mismatch before authorization', async () => {
    const plan = buildPlan([conductedLaneWithRun(), heldLane(hex('cross-check plan'))]);
    const mismatch = (over: Record<string, unknown>): Record<string, unknown> => {
      if ('workOrderId' in over || 'baseCommit' in over || 'ownedPaths' in over || 'policyRevision' in over) {
        return adoptInput({ workOrder: { ...(adoptInput()['workOrder'] as object), ...over } });
      }
      if ('attemptId' in over) {
        return adoptInput({ attempt: { ...(adoptInput()['attempt'] as object), ...over } });
      }
      return adoptInput(over);
    };
    for (const bad of [
      mismatch({ baseBranch: 'chain/other' }),
      mismatch({ projectId: 'proj-2' }),
      mismatch({ workOrderId: 'wo-8' }),
      mismatch({ attemptId: 'attempt-2' }),
      mismatch({ baseCommit: 'c'.repeat(64) }),
      mismatch({ ownedPaths: ['docs/x.ts'] }), // not under any allowedPathPrefixes entry
    ]) {
      const deps = makeDeps({ plan });
      expect(
        await new ApplyRelaunchUseCase(deps).applyRelaunch(
          applyRequest(plan.planDigest, { saveInputs: [saveInput()], adoptInputs: [bad] }),
        ),
      ).toEqual({ outcome: 'refused', reason: 'stale-plan-state', laneId: 'lane-2' });
      expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
      expect(deps.appended).toEqual([]);
    }
    // A matching input passes the cross-checks and adopts; `policyRevision`
    // passes through untouched (AdoptLane's identity digest covers it).
    const deps = makeDeps({
      plan,
      live: { adopt: adopted() },
    });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(plan.planDigest, {
          saveInputs: [saveInput()],
          adoptInputs: [mismatch({ policyRevision: 'policy-9' })],
        }),
      ),
    ).toMatchObject({ outcome: 'applied', planDigest: plan.planDigest, wave: 1 });
    expect(deps.adoptLane).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: 'lane-2',
        workOrder: expect.objectContaining({ policyRevision: 'policy-9' }),
      }),
    );
  });

  it('counts partial or completed adopt with absent redispatch against maxActiveRuns and refuses next absent adopt lane', async () => {
    // lane-2 (wave 1) was already adopted but its redispatch is still
    // intent-only: it occupies a run, and so does any lane whose adopt has
    // begun or completed while its redispatch is absent. With maxActiveRuns
    // 2 the second wave-2 lane's own absent adopt crosses the cap before its
    // adopt runs; with 3 both wave-2 lanes fit.
    const lane2 = { ...heldLane(hex('cap plan'), 'lane-2'), dependsOnLaneIds: [] };
    const lane3 = { ...heldLane(hex('cap plan'), 'lane-3'), hostName: 'host-c', dependsOnLaneIds: ['lane-2'], admissionWave: 2 };
    const lane4 = { ...heldLane(hex('cap plan'), 'lane-4'), hostName: 'host-d', dependsOnLaneIds: ['lane-2'], admissionWave: 2 };
    const inputs = [
      saveInput(),
      saveInput({ laneId: 'lane-3', attemptId: 'attempt-3' }),
      saveInput({ laneId: 'lane-4', attemptId: 'attempt-4' }),
    ];
    const lane3Input = adoptInput({
      laneId: 'lane-3',
      attempt: { ...(adoptInput()['attempt'] as object), attemptId: 'attempt-3' },
      run: { ...(adoptInput()['run'] as object), runId: RUN_10 },
    });
    const lane4Input = adoptInput({
      laneId: 'lane-4',
      attempt: { ...(adoptInput()['attempt'] as object), attemptId: 'attempt-4' },
      run: { ...(adoptInput()['run'] as object), runId: RUN_11 },
    });
    const setup = (maxActiveRuns: number): { plan: RelaunchPlanRecord; entries: unknown[] } => {
      const plan = buildPlan([lane2, lane3, lane4], maxActiveRuns);
      const entries = [
        ...completedSave(plan.planDigest, 'lane-2', inputs[0]!),
        ...completedAdopt(plan.planDigest, 'lane-2', adoptInput()),
        intent(key(plan.planDigest, 'lane-2', 'redispatch')),
        // lane-3 was adopted in an earlier pass but its redispatch is still
        // absent: only the preflight's adopt counting sees it occupy a run.
        ...completedSave(plan.planDigest, 'lane-3', inputs[1]!),
        ...completedAdopt(plan.planDigest, 'lane-3', lane3Input),
        ...completedSave(plan.planDigest, 'lane-4', inputs[2]!),
      ];
      return { plan, entries };
    };
    // Cap 2: lane-2's completed adopt is counted by the preflight (1) and
    // lane-3's own adopt fills the cap (2), so lane-4's absent adopt refuses
    // before anything is written for it.
    const capped = setup(2);
    const deps = makeDeps({ plan: capped.plan, entries: capped.entries, live: { adopt: adopted() } });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(capped.plan.planDigest, {
          saveInputs: inputs,
          adoptInputs: [lane3Input, lane4Input],
        }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'active-run-cap-reached', laneId: 'lane-4' });
    expect(deps.adoptLane).not.toHaveBeenCalled();
    expect(
      deps.appended!.filter((entry) => entry.kind === 'intent').map((entry) => entry.key),
    ).toEqual([key(capped.plan.planDigest, 'lane-3', 'redispatch')]);
    // Cap 3: lane-4's adopt fits and both wave-2 lanes hand off.
    const roomier = setup(3);
    // Fix-round item 2 hardening: the port's answer must carry the ids of
    // the request it adopted, so the mock derives them per request.
    const roomierDeps = makeDeps({
      plan: roomier.plan,
      entries: roomier.entries,
      live: { adopt: (request: unknown) => adoptedFor(request) },
    });
    expect(
      await new ApplyRelaunchUseCase(roomierDeps).applyRelaunch(
        applyRequest(roomier.plan.planDigest, {
          saveInputs: inputs,
          adoptInputs: [lane3Input, lane4Input],
        }),
      ),
    ).toMatchObject({ outcome: 'applied', planDigest: roomier.plan.planDigest, wave: 2 });
    expect(roomierDeps.adoptLane).toHaveBeenCalledTimes(1);
    expect(
      roomierDeps.appended!.filter((entry) => entry.kind === 'intent').map((entry) => entry.key),
    ).toEqual([
      key(roomier.plan.planDigest, 'lane-3', 'redispatch'),
      adoptKey(roomier.plan.planDigest, 'lane-4', 'work-order'),
      adoptKey(roomier.plan.planDigest, 'lane-4', 'brief'),
      adoptKey(roomier.plan.planDigest, 'lane-4', 'attempt'),
      adoptKey(roomier.plan.planDigest, 'lane-4', 'run'),
      key(roomier.plan.planDigest, 'lane-4', 'redispatch'),
    ]);
  });

  it('allows own redispatch without re-checking or incrementing capacity after adopt', async () => {
    // maxActiveRuns = 1: the lane's own adopt fills the cap, and its own
    // redispatch must still append the intent — an implementation that
    // re-checked the counter here would refuse active-run-cap-reached.
    const lane = { ...heldLane(hex('own-redispatch plan')), dependsOnLaneIds: [] };
    const plan = buildPlan([lane], 1);
    const deps = makeDeps({ plan, live: { adopt: adopted() } });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(plan.planDigest, { saveInputs: [saveInput()], adoptInputs: [adoptInput()] }),
      ),
    ).toMatchObject({ outcome: 'applied', planDigest: plan.planDigest, wave: 1 });
    expect(deps.adoptLane).toHaveBeenCalledTimes(1);
    expect(
      deps.appended!.filter((entry) => entry.kind === 'intent').map((entry) => entry.key),
    ).toEqual([
      key(plan.planDigest, 'lane-2', 'save'),
      adoptKey(plan.planDigest, 'lane-2', 'work-order'),
      adoptKey(plan.planDigest, 'lane-2', 'brief'),
      adoptKey(plan.planDigest, 'lane-2', 'attempt'),
      adoptKey(plan.planDigest, 'lane-2', 'run'),
      key(plan.planDigest, 'lane-2', 'redispatch'),
    ]);
  });

  it('refuses adopt-failed when adoptLane returns refused, unknown, throws, or returns malformed result', async () => {
    const plan = buildPlan([conductedLaneWithRun(), heldLane(hex('adopt-fail plan'))]);
    for (const live of [
      { adopt: { outcome: 'refused', reason: 'lane-already-has-run' } },
      { adopt: { outcome: 'unknown', reason: 'adoption-unknown' } },
      { adoptThrows: true },
      { adopt: {} }, // malformed: no outcome
      { adopt: null },
      { adopt: { outcome: 7 } }, // a non-string outcome is malformed
    ]) {
      const deps = makeDeps({ plan, live: live as LiveOver });
      expect(
        await new ApplyRelaunchUseCase(deps).applyRelaunch(
          applyRequest(plan.planDigest, { saveInputs: [saveInput()], adoptInputs: [adoptInput()] }),
        ),
      ).toEqual({ outcome: 'refused', reason: 'adopt-failed', laneId: 'lane-2' });
      expect(deps.appended!.every((entry) => entry.key !== key(plan.planDigest, 'lane-2', 'redispatch'))).toBe(
        true,
      );
    }
    // A result whose outcome is a getter is malformed too: the descriptor
    // read refuses it and no getter runs.
    const getterCalls = { count: 0 };
    const getterResult = getterOn(adopted(), 'outcome', getterCalls);
    const deps = makeDeps({ plan, live: { adopt: getterResult } });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(plan.planDigest, { saveInputs: [saveInput()], adoptInputs: [adoptInput()] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'adopt-failed', laneId: 'lane-2' });
    expect(getterCalls.count).toBe(0);
  });

  it('refuses invalid-request before authorization when a nested adoptInput field is malformed', async () => {
    // Fix-round item 1: the nested fields are validated at parse, so a
    // `run.tier` outside {1, 2}, a run id outside the lane-run grammar or an
    // acceptance spec the domain value object refuses can no longer pass
    // preflight, consume the grant and save/abort the lane before
    // `AdoptLane` rejects it.
    const plan = buildPlan([conductedLaneWithRun(), heldLane(hex('nested plan'))]);
    for (const bad of [
      adoptInput({ run: { ...(adoptInput()['run'] as object), tier: 999 } }),
      adoptInput({ run: { ...(adoptInput()['run'] as object), runId: 'run-9' } }),
      adoptInput({
        brief: {
          ...(adoptInput()['brief'] as object),
          acceptanceSpec: { commands: [{ argv: ['yarn', 'test'] }] },
        },
      }),
      // A planRef whose laneId does not match the input's own lane id.
      { ...adoptInput(), planRef: { projectId: 'proj-1', planId: 'plan-1', laneId: 'lane-9' } },
    ]) {
      const deps = makeDeps({ plan });
      expect(
        await new ApplyRelaunchUseCase(deps).applyRelaunch(
          applyRequest(plan.planDigest, { saveInputs: [saveInput()], adoptInputs: [bad] }),
        ),
      ).toEqual({ outcome: 'refused', reason: 'invalid-request' });
      expect(deps.planRepo.findByDigest).not.toHaveBeenCalled();
      expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
      expect(deps.appended).toEqual([]);
    }
  });

  it('validates clean-commit commitsSinceBase ids and rejects an empty list at parse time', async () => {
    const plan = buildPlan([conductedLaneWithRun(), heldLane(hex('since plan'))]);
    const clean = (commitsSinceBase: unknown): Record<string, unknown> =>
      adoptInput({
        source: { kind: 'clean-commit', commitOid: COMMIT, branchName: 'fleet/x', commitOnBranch: true, dirtyCount: 0, commitsSinceBase },
      });
    for (const bad of [[], ['not-a-commit'], ['a'.repeat(40), 'XYZ']]) {
      const deps = makeDeps({ plan });
      expect(
        await new ApplyRelaunchUseCase(deps).applyRelaunch(
          applyRequest(plan.planDigest, { saveInputs: [saveInput()], adoptInputs: [clean(bad)] }),
        ),
      ).toEqual({ outcome: 'refused', reason: 'invalid-request' });
      expect(deps.planRepo.findByDigest).not.toHaveBeenCalled();
      expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
      expect(deps.appended).toEqual([]);
    }
    const deps = makeDeps({ plan });
    const out = (await new ApplyRelaunchUseCase(deps).applyRelaunch(
      applyRequest(plan.planDigest, { saveInputs: [saveInput()], adoptInputs: [clean(['a'.repeat(40), 'b'.repeat(40)])] }),
    )) as { reason?: string };
    expect(out.reason).not.toBe('invalid-request');
    expect(deps.planRepo.findByDigest).toHaveBeenCalled();
  });

  it('refuses adopt-failed when an adopted result is missing fields or carries mismatched ids', async () => {
    // Fix-round item 2: an `own` outcome of 'adopted' is only trusted when
    // every required result field is present and each id matches the input;
    // otherwise the wave must not journal the redispatch intent.
    const plan = buildPlan([conductedLaneWithRun(), heldLane(hex('adopted-shape plan'))]);
    for (const answer of [
      { outcome: 'adopted', reused: false, workOrderId: 'wo-9', briefDigest: BRIEF_DIGEST, attemptId: 'attempt-1', commitOid: COMMIT, enteredState: 'collecting', provenance: 'adopted' }, // no runId
      { ...adopted(), attemptId: 'attempt-2' }, // a mismatched attempt id
      { ...adopted(), commitOid: 'a'.repeat(64) }, // a commit the source does not carry
      { ...adopted(), enteredState: 'running' },
      { ...adopted(), reused: 'no' },
    ]) {
      const deps = makeDeps({ plan, live: { adopt: answer } });
      expect(
        await new ApplyRelaunchUseCase(deps).applyRelaunch(
          applyRequest(plan.planDigest, { saveInputs: [saveInput()], adoptInputs: [adoptInput()] }),
        ),
      ).toEqual({ outcome: 'refused', reason: 'adopt-failed', laneId: 'lane-2' });
      expect(deps.appended!.every((entry) => entry.key !== key(plan.planDigest, 'lane-2', 'redispatch'))).toBe(true);
    }
  });

  it('refuses adopt-failed without calling adoptLane when adopt status is refused', async () => {
    const plan = buildPlan([conductedLaneWithRun(), heldLane(hex('prior-refused plan'))]);
    const digest = plan.planDigest;
    const entries = [
      ...completedSave(digest, 'lane-2', saveInput()),
      intent(adoptKey(digest, 'lane-2', 'work-order')),
      result(adoptKey(digest, 'lane-2', 'work-order'), 'refused'),
    ];
    const deps = makeDeps({ plan, entries, live: { adopt: adopted() } });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(digest, { saveInputs: [saveInput()], adoptInputs: [adoptInput()] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'adopt-failed', laneId: 'lane-2' });
    expect(deps.adoptLane).not.toHaveBeenCalled();
  });

  it('refuses budget-exhausted when deadline expires before adopt, during adoptLane, or before redispatch', async () => {
    const plan = buildPlan([conductedLaneWithRun(), heldLane(hex('budget plan'))]);
    const digest = plan.planDigest;
    // Before adopt: the save (resumed from an intent-only state) runs past
    // the deadline, so the adopt's own budget check refuses first.
    let now = CLOCK_NOW;
    const before = makeDeps({
      plan,
      entries: [intent(key(digest, 'lane-2', 'save'), saveInputDigest(digest, saveInput()))],
      clock: () => now,
      live: {
        adopt: adopted(),
        save: { outcome: 'saved', saveRef: SAVE_REF, commitId: COMMIT, treeDigest: TREE },
      },
    });
    (before.saveLaneEdits as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      now = PAST_DEADLINE;
      return { outcome: 'saved', saveRef: SAVE_REF, commitId: COMMIT, treeDigest: TREE };
    });
    expect(
      await new ApplyRelaunchUseCase(before).applyRelaunch(
        applyRequest(digest, {
          deadlineIso: DEADLINE,
          saveInputs: [saveInput()],
          adoptInputs: [adoptInput()],
        }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'budget-exhausted' });
    expect(before.adoptLane).not.toHaveBeenCalled();
    // During adoptLane: the port itself reports an exhausted budget.
    const during = makeDeps({
      plan,
      entries: [...completedSave(digest, 'lane-2', saveInput())],
      live: { adopt: { outcome: 'budget-exhausted', completedSteps: [], nextStep: 'work-order' } },
    });
    expect(
      await new ApplyRelaunchUseCase(during).applyRelaunch(
        applyRequest(digest, {
          deadlineIso: DEADLINE,
          saveInputs: [saveInput()],
          adoptInputs: [adoptInput()],
        }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'budget-exhausted' });
    // Before redispatch: the adoptLane mock expires the deadline after the
    // adopt was adopted; the redispatch budget check refuses.
    let late = CLOCK_NOW;
    const after = makeDeps({
      plan,
      entries: [...completedSave(digest, 'lane-2', saveInput())],
      clock: () => late,
      live: { adopt: adopted() },
    });
    (after.adoptLane as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      late = PAST_DEADLINE;
      return adopted();
    });
    expect(
      await new ApplyRelaunchUseCase(after).applyRelaunch(
        applyRequest(digest, {
          deadlineIso: DEADLINE,
          saveInputs: [saveInput()],
          adoptInputs: [adoptInput()],
        }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'budget-exhausted' });
    expect(
      after.appended!.every((entry) => entry.key !== key(digest, 'lane-2', 'redispatch')),
    ).toBe(true);
  });

  it('applies adopt with real acceptanceSpec.commands[].argv and large briefText, and replays idempotently when adopt is completed', async () => {
    const plan = buildPlan([conductedLaneWithRun(), heldLane(hex('apply plan'))]);
    const digest = plan.planDigest;
    // The brief carries a real acceptance spec whose argv nests to depth 6
    // (past the save-input scan depth of 4) and a briefText at the
    // MAX_BRIEF_TEXT_LENGTH bound of 262,144; both must pass the adopt scan.
    const brief = {
      ...(adoptInput()['brief'] as object),
      briefText: 'x'.repeat(262_144),
      expectedBriefDigest: hex('x'.repeat(262_144)),
      acceptanceSpec: {
        commitRequired: true,
        diffCheck: true,
        commands: [{ argv: ['yarn', 'turbo', 'run', 'test', '--', '--filter=...'] }],
      },
    };
    const input = adoptInput({ brief });
    const deps = makeDeps({
      plan,
      entries: [
        // The save was completed in an earlier pass and journaled its ref,
        // commit id and tree digest; the adopt input carries no `source`, so
        // the apply derives the save-ref source from the journal.
        intent(key(digest, 'lane-2', 'save'), saveInputDigest(digest, saveInput())),
        savedResult(key(digest, 'lane-2', 'save')),
      ],
      live: { adopt: (request: unknown) => adoptedFor(request) },
    });
    const request = (): unknown =>
      applyRequest(digest, {
        deadlineIso: DEADLINE,
        saveInputs: [saveInput()],
        adoptInputs: [{ ...input, source: undefined }],
      });
    expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(request())).toMatchObject({
      outcome: 'applied',
      planDigest: digest,
      wave: 1,
    });
    expect(deps.saveLaneEdits).not.toHaveBeenCalled();
    expect(deps.adoptLane).toHaveBeenCalledWith({
      planDigest: digest,
      laneId: 'lane-2',
      projectId: 'proj-1',
      planRef: { projectId: 'proj-1', planId: 'plan-1', laneId: 'lane-2' },
      baseBranch: 'chain/relaunch-2',
      workOrder: expect.objectContaining({ workOrderId: 'wo-9', baseCommit: 'b'.repeat(64) }),
      brief: expect.objectContaining({ briefText: 'x'.repeat(262_144) }),
      attempt: expect.objectContaining({ attemptId: 'attempt-1' }),
      run: expect.objectContaining({ runId: RUN_9 }),
      source: { kind: 'save-ref', saveRef: SAVE_REF, commitOid: COMMIT, treeDigest: TREE },
      nowIso: CLOCK_NOW,
      deadlineIso: DEADLINE,
    });
    expect(
      deps.appended!.filter((entry) => entry.kind === 'intent').map((entry) => entry.key),
    ).toEqual([
      adoptKey(digest, 'lane-2', 'work-order'),
      adoptKey(digest, 'lane-2', 'brief'),
      adoptKey(digest, 'lane-2', 'attempt'),
      adoptKey(digest, 'lane-2', 'run'),
      key(digest, 'lane-2', 'redispatch'),
    ]);
    // Replay idempotency: with the adopt already completed (and no adopt
    // input supplied), the replay never calls adoptLane again.
    const replayDeps = makeDeps({
      plan,
      entries: [
        ...completedSave(digest, 'lane-2', saveInput()),
        ...completedAdopt(digest, 'lane-2', adoptInput()),
      ],
      live: { adopt: (request: unknown) => adoptedFor(request) },
    });
    expect(
      await new ApplyRelaunchUseCase(replayDeps).applyRelaunch(
        applyRequest(digest, { saveInputs: [saveInput()] }),
      ),
    ).toMatchObject({ outcome: 'applied', planDigest: digest, wave: 1 });
    expect(replayDeps.adoptLane).not.toHaveBeenCalled();
    expect(
      replayDeps.appended!.filter((entry) => entry.kind === 'intent').map((entry) => entry.key),
    ).toEqual([key(digest, 'lane-2', 'redispatch')]);
    // A save completed in the CURRENT wave also feeds the derived source: the
    // saveLaneEdits result carries the ref, commit id and tree digest.
    const waveDeps = makeDeps({
      plan,
      live: {
        adopt: (request: unknown) => adoptedFor(request),
        save: { outcome: 'saved', saveRef: SAVE_REF, commitId: COMMIT, treeDigest: TREE },
      },
    });
    expect(
      await new ApplyRelaunchUseCase(waveDeps).applyRelaunch(
        applyRequest(digest, {
          saveInputs: [saveInput()],
          adoptInputs: [{ ...input, source: undefined }],
        }),
      ),
    ).toMatchObject({ outcome: 'applied', planDigest: digest, wave: 1 });
    expect(waveDeps.saveLaneEdits).toHaveBeenCalledTimes(1);
    expect(waveDeps.adoptLane).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: 'save-ref', saveRef: SAVE_REF, commitOid: COMMIT, treeDigest: TREE },
      }),
    );
  });

  it('refuses pure adopt-input faults in preflight with zero side effects, before the grant', async () => {
    // AdoptLaneUseCase refuses these after the grant, the save and the abort;
    // the relaunch preflight runs the SAME pure validation first.
    const plan = buildPlan([conductedLaneWithRun(), heldLane(hex('pure-fault plan'))]);
    const brief = adoptInput()['brief'] as object;
    const branch = `fleet/${RUN_9}`;
    const clean = (over: Record<string, unknown>): Record<string, unknown> =>
      adoptInput({
        source: { kind: 'clean-commit', commitOid: COMMIT, branchName: branch, commitOnBranch: true, dirtyCount: 0, ...over },
      });
    const cases: Record<string, Record<string, unknown>> = {
      'digest mismatch': adoptInput({ brief: { ...brief, expectedBriefDigest: 'a'.repeat(64) } }),
      'NUL in a path': adoptInput({ brief: { ...brief, prosePath: 'brief/pro\u0000se.md' } }),
      'commitOid equals baseCommit': clean({ commitOid: 'b'.repeat(64) }),
      'commit on another branch': clean({ branchName: 'fleet/other' }),
      'dirty worktree': clean({ dirtyCount: 3 }),
      'unknown dirty state': clean({ dirtyCount: 'unknown' }),
    };
    for (const [name, bad] of Object.entries(cases)) {
      const deps = makeDeps({ plan, live: { adopt: (request: unknown) => adoptedFor(request) } });
      expect(
        await new ApplyRelaunchUseCase(deps).applyRelaunch(
          applyRequest(plan.planDigest, { saveInputs: [saveInput()], adoptInputs: [bad] }),
        ),
        name,
      ).toEqual({ outcome: 'refused', reason: 'adopt-failed', laneId: 'lane-2' });
      expect(deps.authorization!.authorizeRelaunchApply, name).not.toHaveBeenCalled();
      expect(deps.saveLaneEdits, name).not.toHaveBeenCalled();
      expect(deps.runner!.abortWorktreeRun, name).not.toHaveBeenCalled();
      expect(deps.processTreeTermination!.terminateWorktreeProcesses, name).not.toHaveBeenCalled();
      expect(deps.adoptLane, name).not.toHaveBeenCalled();
      expect(deps.appended, name).toEqual([]);
    }
    // Control: a clean commit that is on the lane branch and is not the base adopts.
    const deps = makeDeps({ plan, live: { adopt: (request: unknown) => adoptedFor(request) } });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(plan.planDigest, { saveInputs: [saveInput()], adoptInputs: [clean({})] }),
      ),
    ).toMatchObject({ outcome: 'applied' });
  });

  it('refuses a lane id AdoptLane would refuse (a leading dot) at parse, with no side effect', async () => {
    // `.lane` passes the save-input grammar but not AdoptLane's id pattern.
    const plan = buildPlan([conductedLaneWithRun(), heldLane(hex('dot-lane plan'), '.lane')]);
    const deps = makeDeps({ plan, live: { adopt: (request: unknown) => adoptedFor(request) } });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(plan.planDigest, {
          saveInputs: [saveInput({ laneId: '.lane' })],
          adoptInputs: [adoptInput({ laneId: '.lane' })],
        }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(deps.planRepo.findByDigest).not.toHaveBeenCalled();
    expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    expect(deps.saveLaneEdits).not.toHaveBeenCalled();
    expect(deps.appended).toEqual([]);
  });

  describe('a partially begun adopt', () => {
    // Wave 1: lane-2 is fully adopted and handed off (redispatch intent-only),
    // so it occupies one run. Wave 2: lane-3 has its work-order adopt step
    // completed and the brief step begun (status `partial`, redispatch
    // absent), and lane-4 has a save and nothing else (adopt `absent`).
    const adoptKey = (digest: string, laneId: string, sub: string): string =>
      `relaunch/${digest}/${laneId}/adopt/${sub}`;
    const setup = (maxActiveRuns: number, lane3Entries: (digest: string) => unknown[]) => {
      const seed = hex('partial plan');
      const lane2 = { ...heldLane(seed, 'lane-2'), dependsOnLaneIds: [] };
      const lane3 = { ...heldLane(seed, 'lane-3'), hostName: 'host-c', dependsOnLaneIds: ['lane-2'], admissionWave: 2 };
      const lane4 = { ...heldLane(seed, 'lane-4'), hostName: 'host-d', dependsOnLaneIds: ['lane-2'], admissionWave: 2 };
      const plan = buildPlan([lane2, lane3, lane4], maxActiveRuns);
      const saves = [
        saveInput(),
        saveInput({ laneId: 'lane-3', attemptId: 'attempt-3' }),
        saveInput({ laneId: 'lane-4', attemptId: 'attempt-4' }),
      ];
      const entries = [
        ...completedSave(plan.planDigest, 'lane-2', saves[0]!),
        ...completedAdopt(plan.planDigest, 'lane-2', adoptInput()),
        intent(key(plan.planDigest, 'lane-2', 'redispatch')),
        ...completedSave(plan.planDigest, 'lane-3', saves[1]!),
        ...lane3Entries(plan.planDigest),
        ...completedSave(plan.planDigest, 'lane-4', saves[2]!),
      ];
      const laneInput = (laneId: string, attemptId: string, runId: string): Record<string, unknown> =>
        adoptInput({
          laneId,
          attempt: { ...(adoptInput()['attempt'] as object), attemptId },
          run: { ...(adoptInput()['run'] as object), runId },
        });
      const deps = makeDeps({ plan, entries, live: { adopt: (request: unknown) => adoptedFor(request) } });
      const apply = (): Promise<unknown> =>
        new ApplyRelaunchUseCase(deps).applyRelaunch(
          applyRequest(plan.planDigest, {
            saveInputs: saves,
            adoptInputs: [laneInput('lane-3', 'attempt-3', RUN_10), laneInput('lane-4', 'attempt-4', RUN_11)],
          }),
        );
      const adoptedLanes = (): unknown[] =>
        (deps.adoptLane as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
          (call) => (call[0] as { laneId: string }).laneId,
        );
      return { plan, deps, apply, adoptedLanes };
    };
    const partial = (digest: string): unknown[] => [
      intent(adoptKey(digest, 'lane-3', 'work-order')),
      result(adoptKey(digest, 'lane-3', 'work-order'), 'completed'),
      intent(adoptKey(digest, 'lane-3', 'brief')),
    ];

    it('counts a partial adopt against the cap, resumes it without a cap check, and refuses the next absent adopt', async () => {
      // maxActiveRuns 2: lane-2's hand-off and lane-3's partial adopt fill the
      // cap in the preflight. lane-3 still resumes (a partial adopt is never
      // re-checked against the cap) and lane-4's absent adopt is refused.
      // Deleting `adoptStatus === 'partial'` from the preflight count lets
      // lane-4 adopt; checking the cap for a partial adopt refuses lane-3.
      const { deps, apply, adoptedLanes, plan } = setup(2, partial);
      expect(await apply()).toEqual({ outcome: 'refused', reason: 'active-run-cap-reached', laneId: 'lane-4' });
      expect(adoptedLanes()).toEqual(['lane-3']);
      expect(
        deps.appended!.some((entry) => entry.key === `relaunch/${plan.planDigest}/lane-3/redispatch`),
      ).toBe(true);
      expect(deps.appended!.some((entry) => String(entry.key).includes('/lane-4/'))).toBe(false);
    });

    it('does not count a resumed partial adopt a second time', async () => {
      // maxActiveRuns 3: lane-2 and lane-3 are counted once each (by the
      // preflight), so lane-4 still fits. Counting lane-3's resume again
      // would fill the cap and refuse lane-4.
      const { apply, adoptedLanes } = setup(3, partial);
      expect(await apply()).toMatchObject({ outcome: 'applied', wave: 2 });
      expect(adoptedLanes()).toEqual(['lane-3', 'lane-4']);
    });

    it('resumes a crash-window adopt (intent journaled, no result) once, counts it once, and a re-run never adopts again', async () => {
      const { deps, apply, adoptedLanes } = setup(3, (digest) => [intent(adoptKey(digest, 'lane-3', 'work-order'))]);
      expect(await apply()).toMatchObject({ outcome: 'applied', wave: 2 });
      // lane-3 was adopted once and counted once (lane-4 fit under the cap of 3).
      expect(adoptedLanes()).toEqual(['lane-3', 'lane-4']);
      // The process runs again over the same journal: both adopts completed,
      // so neither is adopted twice.
      await apply();
      expect(adoptedLanes()).toEqual(['lane-3', 'lane-4']);
      expect(deps.adoptLane).toHaveBeenCalledTimes(2);
    });
  });
});
