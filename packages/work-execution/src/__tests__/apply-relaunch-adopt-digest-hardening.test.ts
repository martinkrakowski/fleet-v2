// AR3c1 — ApplyRelaunchUseCase adopt-digest preflight hardening: a participant
// whose `adopt` step is `completed` must have a journaled
// `relaunch/<planDigest>/<laneId>/adopt/work-order` completed result whose
// `digest` is a non-empty string the resent adopt input reproduces. A missing,
// null, empty, getter-carrying or mismatching digest refuses
// `stale-plan-state` in preflight — before `authorizeRelaunchApply` is ever
// called — instead of failing open.
//
// Cost bounds: each lookup is one pass over the already-validated snapshot
// (bounded by MAX_RELAUNCH_APPLY_ENTRIES entries); the entry reader consults
// only own data descriptors, so a getter or Proxy trap never executes. Every
// case would fail against the previous fail-open behaviour, which counted a
// digest-less completed adopt as an idle lane.

import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { canonicalSaveInputJson } from '../domain/relaunch-apply.js';
import {
  canonicalRelaunchPlanBodyJson,
  type RelaunchPlanRecord,
} from '../application/ports/out/RelaunchPlanRepositoryPort.out-port.js';
import type { FindRelaunchPlanResult } from '../application/ports/out/RelaunchPlanRepositoryPort.out-port.js';
import type {
  CutoverJournalAppendResult,
  CutoverJournalEntry,
  CutoverJournalListResult,
} from '../application/ports/out/CutoverJournalPort.out-port.js';
import type { AuthorizeRelaunchApplyResult } from '../application/ports/out/ActionAuthorizationPort.out-port.js';
import type { LaneRunRecord } from '../domain/lane-run-records.js';
import type { LaneRunJournalEntryRecord } from '../domain/lane-run-journal.js';
import { ApplyRelaunchUseCase, type ApplyRelaunchDependencies } from '../application/use-cases/ApplyRelaunchUseCase.use-case.js';

const CLOCK_NOW = '2026-11-23T09:59:00Z';
const BEFORE_DEADLINE = '2026-11-23T09:00:00Z';

const computeDigest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

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

const heldLane = (digest: string, laneId = 'lane-2'): FixtureLane => ({
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
  admissionWave: 1,
  dispatchEndpointKey: 'opencode:host-b:4321',
  staggerOffsetMs: 0,
  steps: [step(digest, laneId, 'save'), step(digest, laneId, 'adopt'), step(digest, laneId, 'redispatch')],
});

/** A stored plan digested over its own canonical body (keys re-keyed to the digest). */
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
  return {
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
  } as unknown as RelaunchPlanRecord;
};

const intent = (key: string, digest: string | null = null) => ({
  key,
  kind: 'intent',
  entryId: 'entry-1',
  recordedAtIso: BEFORE_DEADLINE,
  outcome: undefined,
  digest,
});

const result = (key: string, outcome: string, digest: string | null = null) => ({
  key,
  kind: 'result',
  entryId: 'entry-2',
  recordedAtIso: CLOCK_NOW,
  outcome,
  digest,
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

const saveInputDigest = (planDigest: string, input: Record<string, unknown>): string => {
  const canonical = canonicalSaveInputJson(planDigest, input);
  if (canonical === null) throw new Error('fixture save input must canonicalize');
  return computeDigest(canonical);
};

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
      briefText: 'do the thing',
      expectedBriefDigest: hex('do the thing'),
      prosePath: 'brief/prose.md',
      manifestPath: 'brief/manifest.json',
      reviewerModel: 'reviewer-1',
      acceptanceSpec: { commitRequired: true, diffCheck: true, commands: [{ argv: ['yarn', 'test'] }] },
    },
    attempt: { attemptId: 'attempt-1', endedAtIso: CLOCK_NOW, sessionId: null },
    run: {
      runId: `run-7${'A'.repeat(25)}`,
      tier: 2,
      seatPlanRef: 'e'.repeat(64),
      runPolicyRevision: 'policy-1',
      branchName: `fleet/run-7${'A'.repeat(25)}`,
    },
    source: { kind: 'save-ref', saveRef: 'refs/fleet/saved/lane-2', commitOid: 'c'.repeat(64), treeDigest: 'd'.repeat(64) },
    ...over,
  };
  const laneId = typeof base['laneId'] === 'string' ? base['laneId'] : 'lane-2';
  const projectId = typeof base['projectId'] === 'string' ? base['projectId'] : 'proj-1';
  return { ...base, planRef: { projectId, planId: 'plan-1', laneId } };
};

/** The digest `adoptInputIdentity` computes for a resent adopt input. */
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

const RUN_A = `run-7${'A'.repeat(25)}`;

const runRecord = (runId: string, workOrderId: string, attemptIds: string[]): Record<string, unknown> => ({
  version: 1,
  runId,
  workOrderId,
  tier: 2,
  seatPlanRef: 'b'.repeat(64),
  cursors: { 'first-pass': null, fix: null, review: null },
  round: 0,
  attemptIds,
  prNumber: null,
  parked: null,
  parkCount: 0,
  lease: null,
  revision: 1,
  runPolicyRevision: 'policy-1',
});

const conductEntry = (runId: string, state: string): Record<string, unknown> => ({
  version: 1,
  entryId: `7${'A'.repeat(25)}`,
  kind: 'conduct',
  key: null,
  runId,
  recordedAtIso: BEFORE_DEADLINE,
  mode: null,
  expectedRevision: null,
  mintedId: null,
  outcome: null,
  reasonCode: null,
  detail: null,
  grantId: null,
  state,
});

type HardeningDeps = ApplyRelaunchDependencies;

/** How the fixture journals the `adopt/work-order` completed result. */
type WorkOrderDigest =
  | /** A completed result entry that journals no `digest` member at all. */ undefined
  | /** A result entry with this digest (null = explicit null). */ string
  | null
  | /** A result entry whose digest is an own accessor (a counting getter). */ { getter: true };

interface Fixture {
  plan: RelaunchPlanRecord;
  workOrder: WorkOrderDigest;
  entries?: unknown[];
  journalAnswer?: unknown;
}

const makeDeps = (fixture: Fixture): { deps: HardeningDeps; getterReads: { count: number } } => {
  const plan = fixture.plan;
  const workOrderKey = `relaunch/${plan.planDigest}/lane-2/adopt/work-order`;
  const getterReads = { count: 0 };
  let adoptEntries: unknown[];
  if (fixture.workOrder === undefined) {
    // The adopt itself completed — every sub-step has its completed result —
    // but the work-order result journaled no digest member at all. This is the
    // AR3c1 fail-closed case: a completed adopt with no usable recorded digest.
    adoptEntries = [
      intent(workOrderKey),
      {
        key: workOrderKey,
        kind: 'result',
        entryId: 'entry-2',
        recordedAtIso: CLOCK_NOW,
        outcome: 'completed',
      },
      ...(['brief', 'attempt', 'run'] as const).flatMap((sub) => [
        intent(`relaunch/${plan.planDigest}/lane-2/adopt/${sub}`),
        result(`relaunch/${plan.planDigest}/lane-2/adopt/${sub}`, 'completed'),
      ]),
    ];
  } else if (typeof fixture.workOrder === 'object' && fixture.workOrder !== null && 'getter' in fixture.workOrder) {
    const entry: Record<string, unknown> = {
      key: workOrderKey,
      kind: 'result',
      entryId: 'entry-2',
      recordedAtIso: CLOCK_NOW,
      outcome: 'completed',
    };
    Object.defineProperty(entry, 'digest', {
      enumerable: true,
      configurable: true,
      get() {
        getterReads.count += 1;
        return 'f'.repeat(64);
      },
    });
    adoptEntries = [intent(workOrderKey), entry];
  } else {
    adoptEntries = [
      intent(workOrderKey),
      result(workOrderKey, 'completed', fixture.workOrder),
      ...(['brief', 'attempt', 'run'] as const).flatMap((sub) => [
        intent(`relaunch/${plan.planDigest}/lane-2/adopt/${sub}`),
        result(`relaunch/${plan.planDigest}/lane-2/adopt/${sub}`, 'completed'),
      ]),
    ];
  }
  const store = (fixture.entries ?? [
    intent(`relaunch/${plan.planDigest}/lane-2/save`, saveInputDigest(plan.planDigest, saveInput())),
    result(`relaunch/${plan.planDigest}/lane-2/save`, 'completed'),
    ...adoptEntries,
    intent(`relaunch/${plan.planDigest}/lane-2/redispatch`),
  ]) as Record<string, unknown>[];
  const depsObject: Record<string, unknown> = {
    planRepo: {
      findByDigest: vi.fn(async () => ({ outcome: 'found', plan }) as unknown as FindRelaunchPlanResult),
    },
    cutoverJournal: {
      append: vi.fn(async (entry: CutoverJournalEntry) => {
        const record = entry as unknown as Record<string, unknown>;
        store.push({ ...record, entryId: 'appended-1' });
        return { outcome: 'appended', entry: record } as unknown as CutoverJournalAppendResult;
      }),
      listByKeyPrefix: vi.fn(async () => {
        if (fixture.journalAnswer !== undefined) return fixture.journalAnswer as CutoverJournalListResult;
        return { outcome: 'listed', entries: store } as unknown as CutoverJournalListResult;
      }),
    },
    computeDigest,
    authorization: {
      authorizeRelaunchApply: vi.fn(
        async () => ({ outcome: 'blocked', reason: 'grant-missing' }) as AuthorizeRelaunchApplyResult,
      ),
    },
    clock: () => CLOCK_NOW,
    runRepo: {
      get: vi.fn(async () => ({ runId: 'run-1', state: 'running' }) as unknown as LaneRunRecord),
      list: vi.fn(async () => [runRecord(RUN_A, 'wo-9', ['attempt-1'])] as unknown as readonly LaneRunRecord[]),
    },
    runJournal: {
      listForRun: vi.fn(
        async (runId: string) =>
          (runId === RUN_A ? [conductEntry(RUN_A, 'merged')] : []) as unknown as readonly LaneRunJournalEntryRecord[],
      ),
    },
    runner: {
      inspectWorktreeRun: vi.fn(async () => ({ state: 'idle' })),
      abortWorktreeRun: vi.fn(async () => ({ outcome: 'aborted', endedAtIso: CLOCK_NOW })),
    },
    processTreeTermination: {
      terminateWorktreeProcesses: vi.fn(async () => ({ outcome: 'terminated', killed: 2 })),
    },
    saveLaneEdits: vi.fn(async () => ({ outcome: 'saved' })),
    adoptLane: vi.fn(async () => ({ outcome: 'refused', reason: 'invalid-request' })),
    mintEntryId: vi.fn(() => 'minted-1'),
  };
  return { deps: depsObject as unknown as HardeningDeps, getterReads };
};

const applyRequest = (planDigest: string, over: Record<string, unknown> = {}): unknown => ({
  planDigest,
  nowIso: CLOCK_NOW,
  apply: true,
  grantId: 'grant-1',
  saveInputs: [saveInput()],
  adoptInputs: [adoptInput()],
  ...over,
});

describe('ApplyRelaunchUseCase adopt-digest preflight hardening (AR3c1)', () => {
  const plan = buildPlan([conductedLaneWithRun(), heldLane(hex('hardening plan'))]);

  it('refuses stale-plan-state for a completed adopt whose work-order result journals no digest, before the grant', async () => {
    // AR3c1: the adopt step derives `completed` (every sub-step has a
    // completed result), but the work-order result carries no digest member,
    // so there is nothing the resent input can be checked against. The lane
    // fails closed in preflight — with or without a resent adopt input —
    // instead of counting as an idle lane.
    for (const adoptInputs of [[adoptInput()], []]) {
      const { deps } = makeDeps({ plan, workOrder: undefined });
      expect(
        await new ApplyRelaunchUseCase(deps).applyRelaunch(applyRequest(plan.planDigest, { adoptInputs })),
      ).toEqual({ outcome: 'refused', reason: 'stale-plan-state', laneId: 'lane-2' });
      expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    }
  });

  it('refuses out-of-order before the grant for a lane whose adopt step has no journal entries at all', async () => {
    // With no adopt entries the adopt step derives `absent` while the
    // redispatch intent has already begun; the lane progress derivation
    // refuses that ordering before the grant is spent.
    const { deps } = makeDeps({
      plan,
      workOrder: null,
      entries: [
        intent(`relaunch/${plan.planDigest}/lane-2/save`, saveInputDigest(plan.planDigest, saveInput())),
        result(`relaunch/${plan.planDigest}/lane-2/save`, 'completed'),
        intent(`relaunch/${plan.planDigest}/lane-2/redispatch`),
      ],
    });
    const out = await new ApplyRelaunchUseCase(deps).applyRelaunch(applyRequest(plan.planDigest));
    expect(out).toEqual({ outcome: 'refused', reason: 'out-of-order', laneId: 'lane-2' });
    expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
  });

  it('refuses stale-plan-state when the adopt/work-order result carries a null or empty digest and no input is resent, before the grant', async () => {
    // No adopt input is resent: the old fail-open behaviour counted the lane
    // as idle and went on to the grant; only the digest validation itself
    // refuses here.
    for (const digest of [null, ''] as const) {
      const { deps } = makeDeps({ plan, workOrder: digest });
      expect(
        await new ApplyRelaunchUseCase(deps).applyRelaunch(applyRequest(plan.planDigest, { adoptInputs: [] })),
      ).toEqual({ outcome: 'refused', reason: 'stale-plan-state', laneId: 'lane-2' });
      expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    }
  });

  it('refuses a getter-carrying work-order result as journal-unreadable without running its getter (cost: descriptor reads only)', async () => {
    const { deps, getterReads } = makeDeps({ plan, workOrder: { getter: true } });
    // The snapshot reader refuses the accessor entry whole, before the
    // preflight: journal-unreadable, and the getter never executed.
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(applyRequest(plan.planDigest)),
    ).toEqual({ outcome: 'refused', reason: 'journal-unreadable' });
    expect(getterReads.count).toBe(0);
    expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
  });

  it('refuses stale-plan-state when the resent adopt input does not reproduce the journaled digest, before the grant', async () => {
    const trueInput = adoptInput();
    const { deps } = makeDeps({
      plan,
      // The entry holds the TRUE digest, but the request resends a forged one.
      workOrder: adoptIdentityDigest('lane-2', trueInput),
      entries: [
        intent(`relaunch/${plan.planDigest}/lane-2/save`, saveInputDigest(plan.planDigest, saveInput())),
        result(`relaunch/${plan.planDigest}/lane-2/save`, 'completed'),
        intent(`relaunch/${plan.planDigest}/lane-2/adopt/work-order`),
        result(`relaunch/${plan.planDigest}/lane-2/adopt/work-order`, 'completed', adoptIdentityDigest('lane-2', trueInput)),
        ...(['brief', 'attempt', 'run'] as const).flatMap((sub) => [
          intent(`relaunch/${plan.planDigest}/lane-2/adopt/${sub}`),
          result(`relaunch/${plan.planDigest}/lane-2/adopt/${sub}`, 'completed'),
        ]),
        intent(`relaunch/${plan.planDigest}/lane-2/redispatch`),
      ],
    });
    const forged = adoptInput({ workOrder: { ...(trueInput['workOrder'] as object), workOrderId: 'wo-other' } });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(applyRequest(plan.planDigest, { adoptInputs: [forged] })),
    ).toEqual({ outcome: 'refused', reason: 'stale-plan-state', laneId: 'lane-2' });
    expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
  });

  it('passes the adopt-digest check and reaches authorization when the journaled digest matches the resent input', async () => {
    const { deps } = makeDeps({ plan, workOrder: adoptIdentityDigest('lane-2', adoptInput()) });
    // The authorization adapter answers grant-missing: the point proven here is
    // that preflight PASSED (the grant was consulted) instead of refusing
    // stale-plan-state.
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(applyRequest(plan.planDigest)),
    ).toEqual({ outcome: 'refused', reason: 'grant-missing' });
    expect(deps.authorization!.authorizeRelaunchApply).toHaveBeenCalledTimes(1);
  });

  it('refuses a malformed journal answer instead of treating it as an empty snapshot', async () => {
    const { deps } = makeDeps({
      plan,
      workOrder: adoptIdentityDigest('lane-2', adoptInput()),
      journalAnswer: { outcome: 'listed', entries: null },
    });
    const outcome = await new ApplyRelaunchUseCase(deps).applyRelaunch(applyRequest(plan.planDigest));
    expect(outcome).toMatchObject({ outcome: 'refused' });
    expect(['journal-unreadable', 'stale-plan-state']).toContain((outcome as { reason?: string }).reason);
    expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
  });
});
