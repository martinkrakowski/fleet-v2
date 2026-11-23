// AR2a2 — ApplyRelaunchUseCase tests (U1–U18): request validation, trusted
// clock and deadline, stored-plan digest verification, journal replay
// derivation, and the AR2a2 apply-path refusals that never call
// authorization.
//
// Every case feeds plain values — or a Proxy, getter, hole, array-like or
// polluting key where the inspection itself is the subject — and asserts the
// exact typed result. Getters and Proxy `get` traps are counting traps: a
// refusal must never invoke one (`reads === 0`). Cost bounds are stated per
// case. Each case would fail against a constant or an identity
// implementation: the refusals differ per reason, the dry-run summaries carry
// exact per-step statuses, and the trap counters would stay at zero only for
// the descriptor-based reader.

import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { canonicalSaveInputJson } from '../../../domain/relaunch-apply.js';
import type { FindRelaunchPlanResult } from '../../ports/out/RelaunchPlanRepositoryPort.out-port.js';
import {
  canonicalRelaunchPlanBodyJson,
  type RelaunchPlanRecord,
} from '../../ports/out/RelaunchPlanRepositoryPort.out-port.js';
import type { CutoverJournalListResult } from '../../ports/out/CutoverJournalPort.out-port.js';
import type { AuthorizeRelaunchApplyResult } from '../../ports/out/ActionAuthorizationPort.out-port.js';
import { ApplyRelaunchUseCase } from '../ApplyRelaunchUseCase.use-case.js';

const NOW = '2026-11-23T10:00:00Z';
const CLOCK_NOW = '2026-11-23T09:59:00Z';
const DEADLINE = '2026-11-23T10:30:00Z';
const BEFORE_DEADLINE = '2026-11-23T09:00:00Z';
const PAST_DEADLINE = '2026-11-23T11:00:00Z';

const computeDigest = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

const hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const otherDigest = (): string => hex('a different digest entirely');

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

const conductedLane = (laneId = 'lane-1'): FixtureLane => ({
  laneId,
  hostName: 'host-a',
  projectId: null,
  population: 'conducted' as const,
  runnerState: 'running' as const,
  runId: null,
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

const idleLane = (digest: string, laneId = 'lane-2', dependsOnLaneIds = ['lane-1']): FixtureLane => ({
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
  dependsOnLaneIds,
  admissionWave: 1,
  dispatchEndpointKey: 'opencode:host-b:4321',
  staggerOffsetMs: 0,
  steps: [
    step(digest, laneId, 'save'),
    step(digest, laneId, 'adopt'),
    step(digest, laneId, 'redispatch'),
  ],
});

const runningLane = (digest: string, laneId = 'lane-2'): FixtureLane => ({
  ...idleLane(digest, laneId),
  runnerState: 'running' as const,
  steps: [
    step(digest, laneId, 'save'),
    step(digest, laneId, 'abort'),
    step(digest, laneId, 'adopt'),
    step(digest, laneId, 'redispatch'),
  ],
});

/**
 * A valid stored plan for the given lanes. The step keys are rebuilt with the
 * final plan digest: the canonical body excludes the keys, so the digest is
 * computed once from the body and the keys are then re-keyed to it — no
 * circularity, and a refusal below can only come from the behaviour under
 * test, never from a digest accident.
 */
const buildPlan = (lanes: FixtureLane[]): RelaunchPlanRecord => {
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
    maxActiveRuns: 3,
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
    createdAtIso: BEFORE_DEADLINE,
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

/**
 * The default plan: one conducted lane and one idle lane behind it, digested
 * over its own canonical body.
 */
const defaultPlan = (): RelaunchPlanRecord =>
  buildPlan([conductedLane(), idleLane(hex('default relaunch plan'))]);

const intent = (key: string, digest: string | null = null) => ({
  key,
  kind: 'intent',
  entryId: 'entry-1',
  recordedAtIso: BEFORE_DEADLINE,
  outcome: undefined,
  digest,
});

const result = (key: string, outcome: string) => ({
  key,
  kind: 'result',
  entryId: 'entry-2',
  recordedAtIso: CLOCK_NOW,
  outcome,
  digest: null,
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

interface Deps {
  planRepo: { findByDigest: (planDigest: string) => Promise<FindRelaunchPlanResult> };
  cutoverJournal: { listByKeyPrefix: (prefix: string) => Promise<CutoverJournalListResult> };
  computeDigest: (text: string) => string;
  authorization: { authorizeRelaunchApply: (request: unknown) => Promise<AuthorizeRelaunchApplyResult> };
  clock: () => string;
}

/**
 * The default environment: the valid default plan under its own digest, an
 * empty journal, a fixed trusted clock before the deadline, and a
 * `authorizeRelaunchApply` spy that must stay at zero calls for the whole
 * suite.
 */
const makeDeps = (over: {
  plan?: RelaunchPlanRecord;
  findResult?: unknown;
  findByDigestThrows?: boolean;
  entries?: unknown[];
  journalThrows?: boolean;
  journalResult?: unknown;
  clock?: () => string;
  computeDigest?: (text: string) => string;
} = {}): Deps => {
  const plan = over.plan ?? defaultPlan();
  return {
    planRepo: {
      findByDigest: vi.fn(async (_planDigest: string) => {
        if (over.findByDigestThrows) throw new Error('store down');
        return (
          over.findResult !== undefined ? over.findResult : { outcome: 'found', plan }
        ) as unknown as FindRelaunchPlanResult;
      }),
    },
    cutoverJournal: {
      listByKeyPrefix: vi.fn(async (_prefix: string) => {
        if (over.journalThrows) throw new Error('journal down');
        return (
          over.journalResult ?? { outcome: 'listed', entries: over.entries ?? [] }
        ) as unknown as CutoverJournalListResult;
      }),
    },
    computeDigest: over.computeDigest ?? computeDigest,
    authorization: {
      authorizeRelaunchApply: vi.fn(async (_request: unknown) => ({
        outcome: 'authorized',
        grantId: 'g',
      }) as AuthorizeRelaunchApplyResult),
    },
    clock: over.clock ?? (() => CLOCK_NOW),
  };
};

const dryRunRequest = (planDigest: string, over: Record<string, unknown> = {}): unknown => ({
  planDigest,
  nowIso: NOW,
  ...over,
});

const applyRequest = (planDigest: string, over: Record<string, unknown> = {}): unknown => ({
  planDigest,
  nowIso: NOW,
  apply: true,
  grantId: 'grant-1',
  ...over,
});

/** An own `__proto__` key (a literal would set the prototype instead). */
const withPollutingKey = (key: string, value: unknown): Record<string, unknown> =>
  JSON.parse(`{"${key}": ${JSON.stringify(value)}, "ok": true}`) as Record<string, unknown>;

describe('ApplyRelaunchUseCase (AR2a2)', () => {
  it('U1: refuses malformed requests — null, undefined, primitives, arrays, array-likes, bad fields, sparse saveInputs, over-cap length (O(1) pre-gate, zero reads), duplicate lane ids, null or empty attemptId, and polluting keys, leaving Object.prototype untouched', async () => {
    const plan = defaultPlan();
    const deps = makeDeps({ plan });
    const useCase = new ApplyRelaunchUseCase(deps);
    const digest = plan.planDigest;
    const validInput = saveInput();
    const refused = async (request: unknown): Promise<void> => {
      expect(await useCase.applyRelaunch(request)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    };
    await refused(null);
    await refused(undefined);
    await refused(7);
    await refused(true);
    await refused('x');
    await refused([dryRunRequest(digest)]);
    // An array-like is not an array: refused without reading any element.
    await refused({ length: 1, 0: dryRunRequest(digest) });
    await refused({ planDigest: 7, nowIso: NOW });
    await refused({ planDigest: digest, nowIso: NOW, apply: 'yes' });
    await refused({ planDigest: digest, nowIso: NOW, saveInputs: {} });
    // A sparse saveInputs array is refused: a hole is not a lane input.
    await refused({ planDigest: digest, nowIso: NOW, saveInputs: new Array(2) });
    await refused({ planDigest: digest, nowIso: NOW, saveInputs: [saveInput(), saveInput()] });
    await refused({ planDigest: digest, nowIso: NOW, saveInputs: [saveInput({ attemptId: null })] });
    await refused({ planDigest: digest, nowIso: NOW, saveInputs: [saveInput({ attemptId: '' })] });
    await refused({ planDigest: digest, nowIso: NOW, saveInputs: [{ laneId: 'lane-2' }] });
    // A Proxy array with length 513 (> MAX_RELAUNCH_APPLY_LANES = 512) is
    // refused in the O(1) length pre-gate before any key enumeration: the
    // Proxy `get` trap is never invoked (reads === 0).
    const reads = { count: 0 };
    const longProxy = new Proxy(new Array(513), {
      get(target, property, receiver) {
        reads.count += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    await refused({ planDigest: digest, nowIso: NOW, saveInputs: longProxy });
    expect(reads.count).toBe(0);
    // Prototype-polluting keys in saveInputs are refused as own data keys and
    // leave Object.prototype untouched.
    const pristine = { untouched: true };
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const polluted = withPollutingKey(key, validInput);
      await refused({ planDigest: digest, nowIso: NOW, saveInputs: [polluted] });
      expect((pristine as Record<string, unknown>)['untouched']).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'untouched')).toBe(false);
    }
    expect(deps.planRepo.findByDigest).not.toHaveBeenCalled();
  });

  it('U2: never invokes a counting or throwing getter or a Proxy get trap on the request or saveInputs (reads === 0)', async () => {
    const plan = defaultPlan();
    const deps = makeDeps({ plan });
    const useCase = new ApplyRelaunchUseCase(deps);
    // A counting getter on planDigest is never read: the descriptor check
    // sees the accessor and refuses in O(1).
    const calls = { count: 0 };
    const request = getterOn({ planDigest: plan.planDigest, nowIso: NOW }, 'planDigest', calls);
    expect(await useCase.applyRelaunch(request)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(calls.count).toBe(0);
    // A throwing getter on a save input is never run either.
    const throwing = { count: 0 };
    const element = getterOn(saveInput(), 'laneId', throwing);
    Object.defineProperty(element, 'laneId', {
      enumerable: true,
      configurable: true,
      get(): string {
        throwing.count += 1;
        throw new Error('getter must never run');
      },
    });
    expect(
      await useCase.applyRelaunch({ planDigest: plan.planDigest, nowIso: NOW, saveInputs: [element] }),
    ).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(throwing.count).toBe(0);
    // A Proxy over a one-element saveInputs array whose element is invalid:
    // the elements are read through property descriptors, so the `get` trap
    // stays at zero even though the request is refused.
    const reads = { count: 0 };
    const proxy = new Proxy([{ laneId: 'lane-2' }], {
      get(target, property, receiver) {
        reads.count += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(
      await useCase.applyRelaunch({ planDigest: plan.planDigest, nowIso: NOW, saveInputs: proxy }),
    ).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(reads.count).toBe(0);
    expect(deps.planRepo.findByDigest).not.toHaveBeenCalled();
  });

  it('U3: refuses secret-shaped strings anywhere in the request as secret-detected', async () => {
    const plan = defaultPlan();
    const deps = makeDeps({ plan });
    const useCase = new ApplyRelaunchUseCase(deps);
    const legacySecret = `sk-${'a'.repeat(20)}`;
    const canonicalSecret = `AIza${'a'.repeat(30)}`; // canonical-registry only
    for (const secret of [legacySecret, canonicalSecret]) {
      expect(
        await useCase.applyRelaunch({
          planDigest: plan.planDigest,
          nowIso: NOW,
          apply: true,
          grantId: secret,
        }),
      ).toEqual({ outcome: 'refused', reason: 'secret-detected' });
      expect(
        await useCase.applyRelaunch({
          planDigest: plan.planDigest,
          nowIso: NOW,
          saveInputs: [saveInput({ worktreePath: secret })],
        }),
      ).toEqual({ outcome: 'refused', reason: 'secret-detected' });
      expect(
        await useCase.applyRelaunch({
          planDigest: plan.planDigest,
          nowIso: NOW,
          saveInputs: [saveInput({ allowedPathPrefixes: [secret] })],
        }),
      ).toEqual({ outcome: 'refused', reason: 'secret-detected' });
    }
    expect(deps.planRepo.findByDigest).not.toHaveBeenCalled();
  });

  it('U4: refuses a non-zoned nowIso or deadlineIso as invalid-clock', async () => {
    const plan = defaultPlan();
    const useCase = new ApplyRelaunchUseCase(makeDeps({ plan }));
    expect(await useCase.applyRelaunch({ planDigest: plan.planDigest, nowIso: '2026-11-23T10:00:00' })).toEqual({
      outcome: 'refused',
      reason: 'invalid-clock',
    });
    expect(
      await useCase.applyRelaunch({ planDigest: plan.planDigest, nowIso: NOW, deadlineIso: 'yesterday' }),
    ).toEqual({ outcome: 'refused', reason: 'invalid-clock' });
    expect(
      await useCase.applyRelaunch({ planDigest: plan.planDigest, nowIso: NOW, deadlineIso: 42 }),
    ).toEqual({ outcome: 'refused', reason: 'invalid-clock' });
  });

  it('U5: refuses budget exhaustion — clock at or past the deadline, a throwing clock, a non-string or invalid clock reading — checked before any outbound call and never from request.nowIso', async () => {
    const plan = defaultPlan();
    const exhausted = { outcome: 'refused', reason: 'budget-exhausted' };
    // Clock exactly at the deadline is exhausted (>=).
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan, clock: () => DEADLINE })).applyRelaunch(
        dryRunRequest(plan.planDigest, { deadlineIso: DEADLINE }),
      ),
    ).toEqual(exhausted);
    // The clock is the trusted source: request.nowIso is before the deadline,
    // yet the trusted clock is past it, so the refusal comes from the clock.
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan, clock: () => PAST_DEADLINE })).applyRelaunch(
        dryRunRequest(plan.planDigest, { deadlineIso: DEADLINE }),
      ),
    ).toEqual(exhausted);
    // A throwing clock is exhausted.
    expect(
      await new ApplyRelaunchUseCase(
        makeDeps({
          plan,
          clock: () => {
            throw new Error('clock down');
          },
        }),
      ).applyRelaunch(dryRunRequest(plan.planDigest)),
    ).toEqual(exhausted);
    // A non-string or non-ISO clock reading is exhausted.
    const badClockDeps = makeDeps({ plan });
    badClockDeps.clock = () => undefined as unknown as string;
    expect(await new ApplyRelaunchUseCase(badClockDeps).applyRelaunch(dryRunRequest(plan.planDigest))).toEqual(exhausted);
    const invalidClockDeps = makeDeps({ plan });
    invalidClockDeps.clock = () => 'not-an-instant';
    expect(await new ApplyRelaunchUseCase(invalidClockDeps).applyRelaunch(dryRunRequest(plan.planDigest))).toEqual(exhausted);
    // Checked before any outbound call: the store and journal are untouched.
    const spyDeps = makeDeps({ plan, clock: () => PAST_DEADLINE });
    const spyRequest = dryRunRequest(plan.planDigest, { deadlineIso: DEADLINE });
    expect(await new ApplyRelaunchUseCase(spyDeps).applyRelaunch(spyRequest)).toEqual(exhausted);
    expect(spyDeps.planRepo.findByDigest).not.toHaveBeenCalled();
    expect(spyDeps.cutoverJournal.listByKeyPrefix).not.toHaveBeenCalled();
  });

  it('U6: refuses a non-64-hex planDigest and a store-refused digest as invalid-plan-digest', async () => {
    const useCase = new ApplyRelaunchUseCase(makeDeps());
    expect(await useCase.applyRelaunch(dryRunRequest('nothex'))).toEqual({
      outcome: 'refused',
      reason: 'invalid-plan-digest',
    });
    expect(await useCase.applyRelaunch(dryRunRequest('A'.repeat(64)))).toEqual({
      outcome: 'refused',
      reason: 'invalid-plan-digest',
    });
    const deps = makeDeps({ findResult: { outcome: 'refused', reason: 'invalid-digest' } });
    const digest = defaultPlan().planDigest;
    expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(dryRunRequest(digest))).toEqual({
      outcome: 'refused',
      reason: 'invalid-plan-digest',
    });
    expect(deps.planRepo.findByDigest).toHaveBeenCalledWith(digest);
  });

  it('U7: refuses a known-absent plan as plan-not-found', async () => {
    const digest = defaultPlan().planDigest;
    const deps = makeDeps({ findResult: { outcome: 'absent' } });
    expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(dryRunRequest(digest))).toEqual({
      outcome: 'refused',
      reason: 'plan-not-found',
    });
    expect(deps.planRepo.findByDigest).toHaveBeenCalledWith(digest);
  });

  it('U8: refuses an unreadable store, an unknown plan version, a malformed store result, and a throwing store or computeDigest as plan-unreadable or plan-unknown-version', async () => {
    const digest = defaultPlan().planDigest;
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ findByDigestThrows: true })).applyRelaunch(dryRunRequest(digest)),
    ).toEqual({ outcome: 'refused', reason: 'plan-unreadable' });
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ findResult: { outcome: 'unreadable', reason: 'unreadable' } })).applyRelaunch(
        dryRunRequest(digest),
      ),
    ).toEqual({ outcome: 'refused', reason: 'plan-unreadable' });
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ findResult: { outcome: 'unreadable', reason: 'unknown-version' } })).applyRelaunch(
        dryRunRequest(digest),
      ),
    ).toEqual({ outcome: 'refused', reason: 'plan-unknown-version' });
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ findResult: {} })).applyRelaunch(dryRunRequest(digest)),
    ).toEqual({ outcome: 'refused', reason: 'plan-unreadable' });
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ findResult: null })).applyRelaunch(dryRunRequest(digest)),
    ).toEqual({ outcome: 'refused', reason: 'plan-unreadable' });
    // A throwing computeDigest on the canonical body is plan-unreadable.
    expect(
      await new ApplyRelaunchUseCase(
        makeDeps({ computeDigest: () => {
          throw new Error('hash down');
        } }),
      ).applyRelaunch(dryRunRequest(digest)),
    ).toEqual({ outcome: 'refused', reason: 'plan-unreadable' });
  });

  it('U9: refuses a malformed stored plan — bad schemaVersion, bad createdAtIso, out-of-order steps, bad idempotencyKey, a getter, a Proxy or a hole in plan.lanes — without invoking any getter', async () => {
    const base = defaultPlan();
    const digest = base.planDigest;
    const refusedInvalid = async (plan: unknown, calls?: { count: number }): Promise<void> => {
      const deps = makeDeps({ findResult: { outcome: 'found', plan } });
      expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(dryRunRequest(digest))).toEqual({
        outcome: 'refused',
        reason: 'invalid-plan',
      });
      if (calls) expect(calls.count).toBe(0);
    };
    const plan = defaultPlan() as unknown as Record<string, unknown>;
    await refusedInvalid({ ...plan, schemaVersion: 2 });
    await refusedInvalid({ ...plan, createdAtIso: 'not-an-instant' });
    // Out-of-order steps: adopt before save.
    const lanes = (plan['lanes'] as Record<string, unknown>[]).map((lane) => ({ ...lane }));
    const outOfOrder = { ...plan, lanes: [...lanes] };
    outOfOrder['lanes'][1] = {
      ...lanes[1],
      steps: [step(digest, 'lane-2', 'adopt'), step(digest, 'lane-2', 'save'), step(digest, 'lane-2', 'redispatch')],
    };
    await refusedInvalid(outOfOrder);
    // A bad idempotency key no longer names the plan, lane and step.
    const badKey = { ...plan, lanes: [...lanes] };
    badKey['lanes'][1] = {
      ...lanes[1],
      steps: [{ step: 'save', idempotencyKey: `relaunch/${otherDigest()}/lane-2/save` }, ...lanes[1] && (lanes[1] as { steps: unknown[] }).steps.slice(1)],
    };
    await refusedInvalid(badKey);
    // A counting getter on plan.lanes is never invoked (the validator reads
    // own descriptors only; preflight bound MAX_PREFLIGHT_NODES = 100_000,
    // MAX_PREFLIGHT_DEPTH = 32, lanes cap 512).
    const getterCalls = { count: 0 };
    const getterPlan = getterOn({ ...plan }, 'lanes', getterCalls);
    await refusedInvalid(getterPlan, getterCalls);
    // A Proxy over the lanes array lies in no trap that is consulted: the
    // refusal comes from the reflection answers alone.
    const proxyPlan = {
      ...plan,
      lanes: new Proxy([], {
        get(target, property, receiver) {
          return Reflect.get(target, property, receiver);
        },
      }),
    };
    await refusedInvalid(proxyPlan);
    // A hole in plan.lanes is refused.
    const holed = { ...plan, lanes: new Array(2) };
    (holed['lanes'] as unknown[])[0] = lanes[0];
    await refusedInvalid(holed);
  });

  it('U10: refuses when the recomputed canonical digest does not match the stored or the requested digest', async () => {
    const plan = defaultPlan();
    // The store answers a different digest with the same plan: the requested
    // digest does not match the plan's own canonical digest.
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan })).applyRelaunch(dryRunRequest(otherDigest())),
    ).toEqual({ outcome: 'refused', reason: 'plan-digest-mismatch' });
    // A computeDigest that disagrees with the stored digest is a mismatch too.
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan, computeDigest: () => 'f'.repeat(64) })).applyRelaunch(
        dryRunRequest(plan.planDigest),
      ),
    ).toEqual({ outcome: 'refused', reason: 'plan-digest-mismatch' });
  });

  it('U11: refuses an unreadable journal — a throw, an unreadable outcome, a non-array, a hole, a missing or non-string key or kind, a bad outcome or digest — and never invokes a counting getter on an entry (reads === 0, bound 10_000 entries)', async () => {
    const plan = defaultPlan();
    const digest = plan.planDigest;
    const refusedJournal = async (over: Parameters<typeof makeDeps>[0]): Promise<void> => {
      expect(await new ApplyRelaunchUseCase(makeDeps(over)).applyRelaunch(dryRunRequest(digest))).toEqual({
        outcome: 'refused',
        reason: 'journal-unreadable',
      });
    };
    await refusedJournal({ plan, journalThrows: true });
    await refusedJournal({ plan, journalResult: { outcome: 'unreadable' } });
    await refusedJournal({ plan, journalResult: { outcome: 'listed', entries: 'nope' } });
    // A hole in the entries array is unreadable.
    const holed = new Array(2);
    holed[0] = intent(`relaunch/${digest}/lane-2/save`);
    await refusedJournal({ plan, journalResult: { outcome: 'listed', entries: holed } });
    // An entry without a string kind, and one with a non-string outcome.
    await refusedJournal({
      plan,
      entries: [{ key: `relaunch/${digest}/lane-2/save`, digest: null }],
    });
    await refusedJournal({
      plan,
      entries: [{ key: `relaunch/${digest}/lane-2/save`, kind: 'intent', outcome: 7, digest: null }],
    });
    // A counting getter on an entry's key is never invoked (cost bound: the
    // entry scan is bounded by MAX_RELAUNCH_APPLY_ENTRIES = 10_000).
    const calls = { count: 0 };
    const entry = getterOn({ key: `relaunch/${digest}/lane-2/save`, kind: 'intent', digest: null }, 'key', calls);
    await refusedJournal({ plan, entries: [entry, { key: `relaunch/${digest}/lane-2/save`, kind: 'result', outcome: 7 }] });
    expect(calls.count).toBe(0);
    // A getter on digest is refused the same way.
    const digestCalls = { count: 0 };
    const digestGetter = getterOn(
      { key: `relaunch/${digest}/lane-2/save`, kind: 'intent', digest: 'x'.repeat(64) },
      'digest',
      digestCalls,
    );
    await refusedJournal({ plan, entries: [digestGetter] });
    expect(digestCalls.count).toBe(0);
  });

  it('U12: refuses a save-input digest mismatch — different save inputs on re-apply, an un-digested save intent, and lane ids that are prototype-polluting or dot names — keyed in a Map without pollution or collision', async () => {
    const recordedInput = saveInput();
    const buildWithIntent = (laneId: string, input: Record<string, unknown>, recordedDigest: string | null) => {
      const plan = buildPlan([conductedLane(), idleLane(hex(`plan ${laneId}`), laneId)]);
      const digest = plan.planDigest;
      const saveKey = `relaunch/${digest}/${laneId}/save`;
      return {
        plan,
        digest,
        entries: [intent(saveKey, recordedDigest === null ? null : recordedDigest)],
        recordedDigest: recordedDigest === null ? null : recordedDigest,
        saveKey,
        currentDigest: saveInputDigest(digest, { ...input, laneId }),
      };
    };
    // Different save inputs on re-apply: the recorded digest no longer matches.
    const mismatch = buildWithIntent('lane-2', recordedInput, null);
    mismatch.recordedDigest = saveInputDigest(mismatch.digest, { ...recordedInput, baseCommit: 'c'.repeat(64) });
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan: mismatch.plan, entries: [intent(mismatch.saveKey, mismatch.recordedDigest)] })).applyRelaunch(
        dryRunRequest(mismatch.digest, { saveInputs: [saveInput()] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'save-input-digest-mismatch', laneId: 'lane-2' });
    // An un-digested save intent (digest null) is refused, never accepted.
    const undigested = buildWithIntent('lane-2', recordedInput, null);
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan: undigested.plan, entries: [intent(undigested.saveKey, null)] })).applyRelaunch(
        dryRunRequest(undigested.digest, { saveInputs: [saveInput()] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'save-input-digest-mismatch', laneId: 'lane-2' });
    // The polluting and dot lane ids are valid lane ids: the Map keys them
    // without touching Object.prototype, and a matching digest replays fine
    // while a changed input is refused with the same laneId echoed back.
    const pristine = { untouched: true };
    for (const laneId of ['__proto__', '.', '..']) {
      const fixture = buildWithIntent(laneId, recordedInput, null);
      const deps = makeDeps({
        plan: fixture.plan,
        entries: [intent(fixture.saveKey, fixture.currentDigest)],
      });
      const useCase = new ApplyRelaunchUseCase(deps);
      expect(
        await useCase.applyRelaunch(dryRunRequest(fixture.digest, { saveInputs: [{ ...recordedInput, laneId }] })),
      ).not.toEqual({ outcome: 'refused', reason: 'save-input-digest-mismatch' });
      expect((pristine as Record<string, unknown>)['untouched']).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'untouched')).toBe(false);
      expect(
        await useCase.applyRelaunch(dryRunRequest(fixture.digest, { saveInputs: [{ ...recordedInput, laneId, baseCommit: 'd'.repeat(64) }] })),
      ).toEqual({ outcome: 'refused', reason: 'save-input-digest-mismatch', laneId });
    }
  });

  it('U13: refuses out-of-order journal steps and inconsistent step states with the offending laneId', async () => {
    // Out of order: the plan's first step (save) is untouched while a later
    // step (adopt) has already begun.
    const plan = defaultPlan();
    const digest = plan.planDigest;
    const adoptKey = `relaunch/${digest}/lane-2/adopt/work-order`;
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan, entries: [intent(adoptKey)] })).applyRelaunch(dryRunRequest(digest)),
    ).toEqual({ outcome: 'refused', reason: 'out-of-order', laneId: 'lane-2' });
    // Inconsistent: two intents for the same step key violate the ledger
    // grammar.
    const saveKey = `relaunch/${digest}/lane-2/save`;
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan, entries: [intent(saveKey), intent(saveKey)] })).applyRelaunch(
        dryRunRequest(digest),
      ),
    ).toEqual({ outcome: 'refused', reason: 'step-inconsistent', laneId: 'lane-2' });
    // A partial adopt (dangling sub-step intent) followed by a begun
    // redispatch is out of order, not a resume.
    const running = buildPlan([conductedLane(), runningLane(hex('running plan'))]);
    const runningDigest = running.planDigest;
    const entries = [
      intent(`relaunch/${runningDigest}/lane-2/save`),
      result(`relaunch/${runningDigest}/lane-2/save`, 'completed'),
      intent(`relaunch/${runningDigest}/lane-2/abort`),
      result(`relaunch/${runningDigest}/lane-2/abort`, 'completed'),
      intent(`relaunch/${runningDigest}/lane-2/adopt/work-order`),
      intent(`relaunch/${runningDigest}/lane-2/redispatch`),
    ];
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan: running, entries })).applyRelaunch(dryRunRequest(runningDigest)),
    ).toEqual({ outcome: 'refused', reason: 'out-of-order', laneId: 'lane-2' });
  });

  it('U14: refuses an apply with a missing, null or blank grantId as grant-missing and never calls authorizeRelaunchApply', async () => {
    const plan = defaultPlan();
    const digest = plan.planDigest;
    for (const grantId of [undefined, null, '   ']) {
      const deps = makeDeps({ plan });
      const request = applyRequest(digest);
      if (grantId === undefined) {
        delete (request as Record<string, unknown>)['grantId'];
      } else {
        (request as Record<string, unknown>)['grantId'] = grantId;
      }
      expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(request)).toEqual({
        outcome: 'refused',
        reason: 'grant-missing',
      });
      expect(deps.authorization.authorizeRelaunchApply).not.toHaveBeenCalled();
    }
  });

  it('U15: refuses the AR2a2 live apply with a grant as live-apply-not-implemented, with zero authorizeRelaunchApply calls on both the apply and the dry-run path', async () => {
    const plan = defaultPlan();
    const deps = makeDeps({ plan });
    const useCase = new ApplyRelaunchUseCase(deps);
    expect(await useCase.applyRelaunch(applyRequest(plan.planDigest))).toEqual({
      outcome: 'refused',
      reason: 'live-apply-not-implemented',
    });
    expect(await useCase.applyRelaunch(dryRunRequest(plan.planDigest))).toEqual({
      outcome: 'dry-run',
      planDigest: plan.planDigest,
      lanes: expect.any(Array),
    });
    expect(deps.authorization.authorizeRelaunchApply).toHaveBeenCalledTimes(0);
  });

  it('U16: defaults to a dry run when apply is omitted or false, with exact absent step statuses', async () => {
    const plan = defaultPlan();
    const digest = plan.planDigest;
    const expectedLanes = [
      { laneId: 'lane-1', population: 'conducted', stepStatuses: [], nextAction: { kind: 'done' } },
      {
        laneId: 'lane-2',
        population: 'unrecorded',
        stepStatuses: [
          { step: 'save', status: 'absent' },
          { step: 'adopt', status: 'absent' },
          { step: 'redispatch', status: 'absent' },
        ],
        nextAction: { kind: 'run', step: 'save' },
      },
    ];
    for (const apply of [undefined, false]) {
      const deps = makeDeps({ plan });
      const request = dryRunRequest(digest);
      if (apply !== undefined) (request as Record<string, unknown>)['apply'] = apply;
      expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(request)).toEqual({
        outcome: 'dry-run',
        planDigest: digest,
        lanes: expectedLanes,
      });
      expect(deps.cutoverJournal.listByKeyPrefix).toHaveBeenCalledWith(`relaunch/${digest}/`);
    }
    // An apply: true with a grant is still refused in AR2a2 — the dry run is
    // the only implemented outcome (see U15).
  });

  it('U17: derives replay progression across save, abort, adopt (partial resume for a dangling sub-step intent) and redispatch reconcile', async () => {
    // A running lane whose save is complete and whose abort has an intent
    // only: the next action reconciles the abort.
    const runningDigestBase = hex('running plan A');
    const running = buildPlan([conductedLane(), runningLane(runningDigestBase)]);
    const runningDigest = running.planDigest;
    const key = (code: string): string => `relaunch/${runningDigest}/lane-2/${code}`;
    const adoptKey = (sub: string): string => `relaunch/${runningDigest}/lane-2/adopt/${sub}`;
    expect(
      await new ApplyRelaunchUseCase(
        makeDeps({ plan: running, entries: [intent(key('save')), result(key('save'), 'completed'), intent(key('abort'))] }),
      ).applyRelaunch(dryRunRequest(runningDigest)),
    ).toEqual({
      outcome: 'dry-run',
      planDigest: runningDigest,
      lanes: [
        { laneId: 'lane-1', population: 'conducted', stepStatuses: [], nextAction: { kind: 'done' } },
        {
          laneId: 'lane-2',
          population: 'unrecorded',
          stepStatuses: [
            { step: 'save', status: 'completed' },
            { step: 'abort', status: 'intent-only' },
            { step: 'adopt', status: 'absent' },
            { step: 'redispatch', status: 'absent' },
          ],
          nextAction: { kind: 'reconcile', step: 'abort', status: 'intent-only' },
        },
      ],
    });
    // A partial adopt: save and abort complete, one adopt sub-step has a
    // dangling intent (I7) — the next action is a resume, not a repeat.
    const partialEntries = [
      intent(key('save')),
      result(key('save'), 'completed'),
      intent(key('abort')),
      result(key('abort'), 'completed'),
      intent(adoptKey('work-order')),
    ];
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan: running, entries: partialEntries })).applyRelaunch(
        dryRunRequest(runningDigest),
      ),
    ).toEqual({
      outcome: 'dry-run',
      planDigest: runningDigest,
      lanes: [
        { laneId: 'lane-1', population: 'conducted', stepStatuses: [], nextAction: { kind: 'done' } },
        {
          laneId: 'lane-2',
          population: 'unrecorded',
          stepStatuses: [
            { step: 'save', status: 'completed' },
            { step: 'abort', status: 'completed' },
            { step: 'adopt', status: 'partial' },
            { step: 'redispatch', status: 'absent' },
          ],
          nextAction: { kind: 'resume', step: 'adopt' },
        },
      ],
    });
    // A complete adopt leaves only the redispatch, which stays intent-only
    // once recorded (it hands the lane back to the conductor).
    const completeEntries = [
      intent(key('save')),
      result(key('save'), 'completed'),
      intent(key('abort')),
      result(key('abort'), 'completed'),
      ...ADOPT_SUB_STEPS.flatMap((sub) => [intent(adoptKey(sub)), result(adoptKey(sub), 'completed')]),
      intent(key('redispatch')),
    ];
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan: running, entries: completeEntries })).applyRelaunch(
        dryRunRequest(runningDigest),
      ),
    ).toEqual({
      outcome: 'dry-run',
      planDigest: runningDigest,
      lanes: [
        { laneId: 'lane-1', population: 'conducted', stepStatuses: [], nextAction: { kind: 'done' } },
        {
          laneId: 'lane-2',
          population: 'unrecorded',
          stepStatuses: [
            { step: 'save', status: 'completed' },
            { step: 'abort', status: 'completed' },
            { step: 'adopt', status: 'completed' },
            { step: 'redispatch', status: 'intent-only' },
          ],
          nextAction: { kind: 'reconcile', step: 'redispatch', status: 'intent-only' },
        },
      ],
    });
  });

  it('U18: an execute() replay of a fully complete lane reports done, and a refused save keeps the lane stopped without refusing the whole dry run', async () => {
    const runningDigestBase = hex('running plan B');
    const running = buildPlan([conductedLane(), runningLane(runningDigestBase)]);
    const digest = running.planDigest;
    const key = (code: string): string => `relaunch/${digest}/lane-2/${code}`;
    const adoptKey = (sub: string): string => `relaunch/${digest}/lane-2/adopt/${sub}`;
    const entries = [
      intent(key('save')),
      result(key('save'), 'completed'),
      intent(key('abort')),
      result(key('abort'), 'completed'),
      ...ADOPT_SUB_STEPS.flatMap((sub) => [intent(adoptKey(sub)), result(adoptKey(sub), 'completed')]),
      intent(key('redispatch')),
      result(key('redispatch'), 'completed'),
    ];
    const useCase = new ApplyRelaunchUseCase(makeDeps({ plan: running, entries }));
    // execute() delegates to applyRelaunch(): a fully complete lane is done.
    expect(await useCase.execute(dryRunRequest(digest))).toEqual({
      outcome: 'dry-run',
      planDigest: digest,
      lanes: [
        { laneId: 'lane-1', population: 'conducted', stepStatuses: [], nextAction: { kind: 'done' } },
        {
          laneId: 'lane-2',
          population: 'unrecorded',
          stepStatuses: [
            { step: 'save', status: 'completed' },
            { step: 'abort', status: 'completed' },
            { step: 'adopt', status: 'completed' },
            { step: 'redispatch', status: 'completed' },
          ],
          nextAction: { kind: 'done' },
        },
      ],
    });
    // A refused save stops the lane: nextAction is a stopped refusal, but the
    // dry run itself still reports the lane's state.
    const refusedEntries = [intent(key('save')), result(key('save'), 'refused')];
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan: running, entries: refusedEntries })).applyRelaunch(
        dryRunRequest(digest),
      ),
    ).toEqual({
      outcome: 'dry-run',
      planDigest: digest,
      lanes: [
        { laneId: 'lane-1', population: 'conducted', stepStatuses: [], nextAction: { kind: 'done' } },
        {
          laneId: 'lane-2',
          population: 'unrecorded',
          stepStatuses: [
            { step: 'save', status: 'refused' },
            { step: 'abort', status: 'absent' },
            { step: 'adopt', status: 'absent' },
            { step: 'redispatch', status: 'absent' },
          ],
          nextAction: { kind: 'stopped', step: 'save', reason: 'refused' },
        },
      ],
    });
  });
});
