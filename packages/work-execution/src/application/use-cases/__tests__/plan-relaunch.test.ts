import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, AttemptRunnerRecord, WorkOrderRecord } from '../../../domain/execution-records.js';
import type { LanePlanRecord } from '../../../domain/lane-plan-records.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import { isCutoverJournalKey } from '../../../infrastructure/adapters/CutoverJournalAdapter.adapter.js';
import { RelaunchPlanRepositoryAdapter } from '../../../infrastructure/adapters/RelaunchPlanRepositoryAdapter.adapter.js';
import type {
  InventoryRelaunchResult,
  RelaunchCloneRef,
  RelaunchLaneRow,
  RelaunchRiskFlag,
} from '../../ports/in/InventoryRelaunchPort.in-port.js';
import type { PlanRelaunchResult } from '../../ports/in/PlanRelaunchPort.in-port.js';
import type { RelaunchPlanRecord, SaveRelaunchPlanResult } from '../../ports/out/RelaunchPlanRepositoryPort.out-port.js';
import { PlanRelaunchUseCase, type PlanRelaunchDependencies } from '../PlanRelaunchUseCase.use-case.js';

const NOW = '2026-11-07T00:00:00.000Z';
const WORKTREE_ROOT = '/srv/fleet/worktrees/p1';
const CLONE_PATH = '/srv/fleet/clones/p1';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const RUNNER: AttemptRunnerRecord = {
  kind: 'opencode',
  remotePort: 4001,
  host: null,
  hostName: 'h1',
  agent: null,
  model: null,
  variant: null,
};

const CLONE: RelaunchCloneRef = {
  projectId: 'p1',
  hostName: 'h1',
  clonePath: CLONE_PATH,
  worktreeRoot: WORKTREE_ROOT,
  recordedHost: RUNNER,
};

function workOrder(id: string, extra: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id,
    projectId: 'p1',
    taskId: `task-${id}`,
    laneId: `plan-lane-${id}`,
    repository: 'https://example.com/example.git',
    baseCommit: 'a'.repeat(40),
    ownedPaths: [`packages/${id}`],
    policyRevision: 'pol-1',
    prerequisiteWorkOrderIds: [],
    state: 'dispatched',
    revision: 1,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...extra,
  } as WorkOrderRecord;
}

function attempt(id: string, workOrderId: string, runner: AttemptRunnerRecord = RUNNER): AttemptRecord {
  return { id, workOrderId, kind: 'initial', fixNumber: 0, worktreePath: `${WORKTREE_ROOT}/${id}`, runner, createdAtIso: NOW } as unknown as AttemptRecord;
}

function run(runId: string, workOrderId: string, attemptIds: string[], extra: Partial<LaneRunRecord> = {}): LaneRunRecord {
  return { version: 1, runId, workOrderId, attemptIds, ...extra } as unknown as LaneRunRecord;
}

function row(laneId: string, extra: Partial<RelaunchLaneRow> = {}): RelaunchLaneRow {
  return {
    population: 'attempt-recorded',
    laneId,
    hostName: 'h1',
    worktreePath: `${WORKTREE_ROOT}/${laneId}`,
    runId: null,
    attemptId: laneId,
    runnerState: 'idle',
    ownership: 'proven',
    ...extra,
  };
}

interface World {
  rows: RelaunchLaneRow[];
  runs: LaneRunRecord[];
  attempts: AttemptRecord[];
  workOrders: WorkOrderRecord[];
  lanePlans: LanePlanRecord[];
  conductor: { halted: boolean; driverLease: 'absent' | 'lapsed' | 'live' | 'unknown'; runCount: number };
  topFlags: RelaunchRiskFlag[];
  hostFlags: RelaunchRiskFlag[];
}

function emptyWorld(): World {
  return {
    rows: [],
    runs: [],
    attempts: [],
    workOrders: [],
    lanePlans: [],
    conductor: { halted: false, driverLease: 'absent', runCount: 0 },
    topFlags: [],
    hostFlags: [],
  };
}

interface Rig {
  readonly useCase: PlanRelaunchUseCase;
  readonly plans: RelaunchPlanRepositoryAdapter;
  readonly calls: string[];
  readonly saves: SaveRelaunchPlanResult[];
  readonly world: World;
  readonly fail: Set<string>;
  inventoryOverride: (() => unknown) | null;
  setClock(clock: (() => string) | undefined): void;
}

function rig(world: World = emptyWorld(), clock?: () => string): Rig {
  const calls: string[] = [];
  const saves: SaveRelaunchPlanResult[] = [];
  const fail = new Set<string>();
  const plans = new RelaunchPlanRepositoryAdapter();
  let currentClock = clock;
  const state: Rig = {
    calls,
    saves,
    world,
    fail,
    plans,
    inventoryOverride: null,
    setClock: (next) => {
      currentClock = next;
    },
    useCase: undefined as unknown as PlanRelaunchUseCase,
  };
  const maybeFail = (name: string): void => {
    calls.push(name);
    if (fail.has(name)) throw new Error(`secret-looking /srv/fleet/${name} failure`);
  };
  const deps: PlanRelaunchDependencies = {
    inventory: {
      inventoryRelaunch: async (): Promise<InventoryRelaunchResult> => {
        maybeFail('inventory');
        if (state.inventoryOverride !== null) return state.inventoryOverride() as InventoryRelaunchResult;
        const hostNames = [...new Set(world.rows.map((lane) => lane.hostName))].sort();
        return {
          outcome: 'inventoried',
          nowIso: NOW,
          conductor: world.conductor,
          riskFlags: world.topFlags,
          hosts: hostNames.map((hostName) => ({
            hostName,
            cloneCount: 1,
            worktreeCount: world.rows.length,
            counts: { conducted: 0, attemptRecorded: 0, unrecorded: 0 },
            riskFlags: world.hostFlags,
            lanes: world.rows.filter((lane) => lane.hostName === hostName),
          })),
        };
      },
    },
    runRepo: { list: async () => (maybeFail('runs'), world.runs) },
    attemptRepo: { listAllAttempts: async () => (maybeFail('attempts'), world.attempts) },
    workOrderRepo: { listWorkOrdersByProject: async () => (maybeFail('workOrders'), world.workOrders) },
    lanePlanRepo: { listLanePlans: async () => (maybeFail('lanePlans'), world.lanePlans) },
    planRepo: {
      save: async (plan: RelaunchPlanRecord) => {
        maybeFail('save');
        const saved = await plans.save(plan);
        saves.push(saved);
        return saved;
      },
    },
    computeDigest: sha256,
    clock: () => (currentClock === undefined ? NOW : currentClock()),
  };
  return Object.assign(state, { useCase: new PlanRelaunchUseCase(deps) });
}

function request(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { nowIso: NOW, hostName: null, clones: [CLONE], ...extra };
}

function planned(result: PlanRelaunchResult): Extract<PlanRelaunchResult, { outcome: 'planned' }> {
  expect(result.outcome).toBe('planned');
  if (result.outcome !== 'planned') throw new Error(`expected planned, got ${JSON.stringify(result)}`);
  return result;
}

function laneOf(plan: RelaunchPlanRecord, laneId: string): RelaunchPlanRecord['lanes'][number] {
  const found = plan.lanes.find((lane) => lane.laneId === laneId);
  if (found === undefined) throw new Error(`lane ${laneId} is not in the plan`);
  return found;
}

/** The mixed world of the ordering tests: one conducted run and five relaunching lanes of one project. */
function mixedWorld(): World {
  const world = emptyWorld();
  const runner4002: AttemptRunnerRecord = { ...RUNNER, remotePort: 4002 };
  world.rows = [
    row('run-c1', { population: 'conducted', runId: 'run-c1', attemptId: 'att-c1', runnerState: 'running' }),
    row('att-a'),
    row('att-b'),
    row('att-c', { runnerState: 'running' }),
    row('att-d'),
    row('worktree-0123456789ab', { population: 'unrecorded', attemptId: null, ownership: 'none' }),
  ];
  world.workOrders = [
    workOrder('wo-c1', { ownedPaths: ['packages/conducted-pkg'] }),
    workOrder('wo-a', { ownedPaths: ['packages/pkg-a'], baseBranch: 'chain/feat' }),
    workOrder('wo-b', { ownedPaths: ['packages/pkg-b'], baseBranch: 'chain/feat', prerequisiteWorkOrderIds: ['wo-a'] }),
    workOrder('wo-c', { ownedPaths: ['packages/pkg-a/sub'] }),
    workOrder('wo-d', { ownedPaths: ['packages/pkg-d'] }),
  ];
  world.attempts = [
    attempt('att-c1', 'wo-c1'),
    attempt('att-a', 'wo-a'),
    attempt('att-b', 'wo-b'),
    attempt('att-c', 'wo-c'),
    attempt('att-d', 'wo-d', runner4002),
  ];
  world.runs = [run('run-c1', 'wo-c1', ['att-c1'])];
  world.conductor = { halted: false, driverLease: 'live', runCount: 1 };
  return world;
}

describe('PlanRelaunchUseCase', () => {
  it('orders conducted lanes first, then chain heads, with dependency waves, the admission cap, overlap and stagger offsets', async () => {
    const { useCase, world } = rig(mixedWorld());
    const result = planned(await useCase.planRelaunch(request({ maxActiveRuns: 3, dispatchStaggerMs: 1000 })));
    const plan = result.plan;

    expect(plan.lanes.map((lane) => lane.laneId)).toEqual([
      'run-c1',
      'att-a',
      'att-b',
      'att-c',
      'att-d',
      'worktree-0123456789ab',
    ]);
    expect(plan.lanes.map((lane) => lane.admissionWave)).toEqual([0, 1, 2, 2, 1, 3]);
    expect(plan.conductor).toEqual({ halted: false, driverLease: 'live', runCount: 1 });
    expect(plan.maxActiveRuns).toBe(3);
    expect(plan.dispatchStaggerMs).toBe(1000);

    // D-CO10: a conducted run keeps running; it has no step, no wave of its own and no endpoint.
    const conducted = laneOf(plan, 'run-c1');
    expect(conducted).toMatchObject({
      population: 'conducted',
      runnerState: 'running',
      steps: [],
      admissionWave: 0,
      dispatchEndpointKey: null,
      staggerOffsetMs: null,
      runId: 'run-c1',
      workOrderId: 'wo-c1',
    });

    const head = laneOf(plan, 'att-a');
    expect(head).toMatchObject({ chainHead: true, dependsOnLaneIds: [], baseBranch: 'chain/feat' });
    expect(laneOf(plan, 'att-b')).toMatchObject({ chainHead: false, dependsOnLaneIds: ['att-a'], baseBranch: 'chain/feat' });
    expect(laneOf(plan, 'att-d')).toMatchObject({ chainHead: false, dependsOnLaneIds: [], baseBranch: 'main' });

    expect(head.steps.map((step) => step.step)).toEqual(['save', 'adopt', 'redispatch']);
    expect(laneOf(plan, 'att-c').steps.map((step) => step.step)).toEqual(['save', 'abort', 'adopt', 'redispatch']);

    // att-c shares att-a's package, so it cannot share wave 1 with it; the unrecorded lane has no work order
    // and shares its project with every other lane, so it fails closed into a wave of its own.
    expect(laneOf(plan, 'att-c').admissionWave).toBe(2);
    const unrecorded = laneOf(plan, 'worktree-0123456789ab');
    expect(unrecorded).toMatchObject({ projectId: 'p1', workOrderId: null, population: 'unrecorded', baseBranch: 'main' });

    // Stagger: per runner endpoint, in plan order.
    expect(plan.lanes.map((lane) => lane.dispatchEndpointKey)).toEqual([
      null,
      'opencode:h1:4001',
      'opencode:h1:4001',
      'opencode:h1:4001',
      'opencode:h1:4002',
      'opencode:h1:4001',
    ]);
    expect(plan.lanes.map((lane) => lane.staggerOffsetMs)).toEqual([null, 0, 1000, 2000, 0, 3000]);

    // Every step key is the digest-scoped, journal-valid key.
    for (const lane of plan.lanes) {
      for (const step of lane.steps) {
        expect(step.idempotencyKey).toBe(`relaunch/${plan.planDigest}/${lane.laneId}/${step.step}`);
        expect(isCutoverJournalKey(step.idempotencyKey)).toBe(true);
      }
    }

    // No path of any kind in the stored plan.
    const text = JSON.stringify(result);
    for (const forbidden of [WORKTREE_ROOT, CLONE_PATH, 'worktreePath', 'clonePath', 'worktreeRoot']) {
      expect(text).not.toContain(forbidden);
    }

    // The planner wrote nothing but the one plan.
    expect(world.rows).toHaveLength(6);
  });

  it('leaves the first wave to conducted runs and starts at wave 2 when they fill the cap', async () => {
    const world = emptyWorld();
    world.rows = [
      row('run-1', { population: 'conducted', runId: 'run-1', attemptId: 'att-1', runnerState: 'running' }),
      row('run-2', { population: 'conducted', runId: 'run-2', attemptId: 'att-2', runnerState: 'running' }),
      row('att-x'),
    ];
    world.workOrders = [workOrder('wo-1'), workOrder('wo-2'), workOrder('wo-x')];
    world.attempts = [attempt('att-1', 'wo-1'), attempt('att-2', 'wo-2'), attempt('att-x', 'wo-x')];
    world.runs = [run('run-1', 'wo-1', ['att-1']), run('run-2', 'wo-2', ['att-2'])];
    const { useCase } = rig(world);

    const full = planned(await useCase.planRelaunch(request({ maxActiveRuns: 2 }))).plan;
    expect(laneOf(full, 'att-x').admissionWave).toBe(2);
    const roomy = planned(await useCase.planRelaunch(request({ maxActiveRuns: 3 }))).plan;
    expect(laneOf(roomy, 'att-x').admissionWave).toBe(1);
  });

  it('does not let a redispatching lane share a wave with a conducted lane over the same package', async () => {
    const world = emptyWorld();
    world.rows = [
      row('run-1', { population: 'conducted', runId: 'run-1', attemptId: 'att-1', runnerState: 'running' }),
      row('att-x'),
    ];
    world.workOrders = [workOrder('wo-1', { ownedPaths: ['packages/shared-pkg'] }), workOrder('wo-x', { ownedPaths: ['packages/shared-pkg/src'] })];
    world.attempts = [attempt('att-1', 'wo-1'), attempt('att-x', 'wo-x')];
    world.runs = [run('run-1', 'wo-1', ['att-1'])];
    const plan = planned(await rig(world).useCase.planRelaunch(request())).plan;
    expect(laneOf(plan, 'att-x').admissionWave).toBe(2);
  });

  it('derives dependencies from lane-plan after edges and exclusive orders', async () => {
    const world = emptyWorld();
    world.rows = [row('att-1'), row('att-2'), row('att-3')];
    world.workOrders = [
      workOrder('wo-1', { planRef: { projectId: 'p1', planId: 'plan-1', laneId: 'l1' } }),
      workOrder('wo-2', { planRef: { projectId: 'p1', planId: 'plan-1', laneId: 'l2' } }),
      // No planRef: the one plan of its project holding this work order's lane id maps it.
      workOrder('wo-3', { laneId: 'l3' }),
    ];
    world.attempts = [attempt('att-1', 'wo-1'), attempt('att-2', 'wo-2'), attempt('att-3', 'wo-3')];
    const plannedLane = (laneId: string, after: LanePlanRecord['lanes'][number]['after'] = []): LanePlanRecord['lanes'][number] =>
      ({ laneId, aliases: [], scope: 's', packages: [], sharedFiles: [], tier: 2, after, decisions: [], status: 'planned', brief: null, mergedPr: null }) as LanePlanRecord['lanes'][number];
    world.lanePlans = [
      {
        version: 1,
        projectId: 'p1',
        planId: 'plan-1',
        revision: 1,
        digest: 'd'.repeat(64),
        doc: 'docs/plan.md',
        lanes: [plannedLane('l1'), plannedLane('l2', [{ projectId: 'p1', planId: 'plan-1', laneId: 'l1' }]), plannedLane('l3')],
        decisions: [],
        exclusiveOrder: [{ file: 'yarn.lock', lanes: ['l3', 'l1'] }],
        importedAtIso: NOW,
      },
    ];
    const plan = planned(await rig(world).useCase.planRelaunch(request())).plan;
    expect(laneOf(plan, 'att-1').dependsOnLaneIds).toEqual(['att-3']);
    expect(laneOf(plan, 'att-2').dependsOnLaneIds).toEqual(['att-1']);
    expect(laneOf(plan, 'att-3').dependsOnLaneIds).toEqual([]);
    expect(plan.lanes.map((lane) => lane.laneId)).toEqual(['att-3', 'att-1', 'att-2']);
    expect(plan.lanes.map((lane) => lane.admissionWave)).toEqual([1, 2, 3]);
    expect(laneOf(plan, 'att-3').chainHead).toBe(true);
    expect(laneOf(plan, 'att-2').chainHead).toBe(false);
  });

  it('refuses a dependency cycle and stores nothing', async () => {
    const world = emptyWorld();
    world.rows = [row('att-x'), row('att-y')];
    world.workOrders = [
      workOrder('wo-x', { prerequisiteWorkOrderIds: ['wo-y'] }),
      workOrder('wo-y', { prerequisiteWorkOrderIds: ['wo-x'] }),
    ];
    world.attempts = [attempt('att-x', 'wo-x'), attempt('att-y', 'wo-y')];
    const { useCase, saves } = rig(world);
    expect(await useCase.planRelaunch(request())).toEqual({ outcome: 'refused', reason: 'dependency-cycle' });
    expect(saves).toEqual([]);
  });

  it('plans an empty relaunch', async () => {
    const { useCase } = rig();
    const result = planned(await useCase.planRelaunch(request({ clones: [] })));
    expect(result.plan.lanes).toEqual([]);
    expect(result.reused).toBe(false);
  });

  it('produces identical canonical planDigest and step keys across repeated runs and marks reused true', async () => {
    const { useCase, saves, plans } = rig(mixedWorld());
    const first = planned(await useCase.planRelaunch(request()));
    const second = planned(await useCase.planRelaunch(request({ nowIso: '2026-11-08T09:30:00.000Z' })));
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.planDigest).toBe(first.planDigest);
    expect(first.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.plan.lanes.map((lane) => lane.steps)).toEqual(first.plan.lanes.map((lane) => lane.steps));
    // The stored plan keeps the first run's metadata clock; the replay wrote nothing.
    expect(second.plan.createdAtIso).toBe(NOW);
    expect(saves.map((saved) => saved.outcome)).toEqual(['saved', 'unchanged']);
    expect(await plans.findByDigest(first.planDigest)).toMatchObject({ outcome: 'found' });
  });

  it('plans a different state under a different digest', async () => {
    const world = mixedWorld();
    const { useCase } = rig(world);
    const first = planned(await useCase.planRelaunch(request()));
    world.rows = world.rows.filter((lane) => lane.laneId !== 'att-d');
    const second = planned(await useCase.planRelaunch(request()));
    expect(second.planDigest).not.toBe(first.planDigest);
    expect(second.reused).toBe(false);
    // Another cap is another request and another plan body.
    const third = planned(await useCase.planRelaunch(request({ maxActiveRuns: 2 })));
    expect(third.planDigest).not.toBe(second.planDigest);
  });

  it('refuses null, non-object, wrong-typed fields, sparse arrays, unknown enums, and throwing getters without throwing', async () => {
    const { useCase, calls } = rig(mixedWorld());
    const invalid = { outcome: 'refused', reason: 'invalid-request' };
    const refuse = async (input: unknown): Promise<unknown> => useCase.planRelaunch(input);

    for (const input of [null, undefined, 3, 'request', true, [], [request()], {}]) {
      expect(await refuse(input)).toEqual(invalid);
    }
    const bad: Record<string, unknown>[] = [
      { nowIso: 'yesterday' },
      { nowIso: '2026-11-07T00:00:00' },
      { nowIso: 5 },
      { hostName: 7 },
      { hostName: '../escape' },
      { hostName: 'bad host' },
      { hostName: undefined },
      { clones: 'none' },
      { clones: undefined },
      { clones: new Array(2) },
      { clones: [null] },
      { clones: [CLONE, 'x'] },
      { clones: [{ ...CLONE, projectId: 7 }] },
      { clones: [{ ...CLONE, projectId: 'a/b' }] },
      { clones: [{ ...CLONE, hostName: '' }] },
      { clones: [{ ...CLONE, clonePath: '' }] },
      { clones: [{ ...CLONE, worktreeRoot: null }] },
      { clones: [{ ...CLONE, recordedHost: 'ssh' }] },
      { clones: [{ ...CLONE, recordedHost: { ...RUNNER, kind: 'ssh' } }] },
      { clones: [{ ...CLONE, recordedHost: { ...RUNNER, remotePort: 'x' } }] },
      { clones: [{ ...CLONE, recordedHost: { ...RUNNER, remotePort: 70_000 } }] },
      { maxActiveRuns: '8' },
      { maxActiveRuns: 0 },
      { maxActiveRuns: 65 },
      { maxActiveRuns: 1.5 },
      { maxActiveRuns: Number.NaN },
      { maxActiveRuns: true },
      { dispatchStaggerMs: -1 },
      { dispatchStaggerMs: 600_001 },
      { dispatchStaggerMs: 'soon' },
      { deadlineIso: 'tomorrow' },
      { deadlineIso: 12 },
      { deadlineIso: false },
    ];
    for (const extra of bad) {
      expect(await refuse(request(extra))).toEqual(invalid);
    }

    const getterOn = (target: Record<string, unknown>, key: string): Record<string, unknown> => {
      Object.defineProperty(target, key, {
        enumerable: true,
        get() {
          throw new Error('boom');
        },
      });
      return target;
    };
    for (const key of ['nowIso', 'hostName', 'clones', 'maxActiveRuns', 'dispatchStaggerMs', 'deadlineIso']) {
      expect(await refuse(getterOn(request(), key))).toEqual(invalid);
    }
    for (const key of ['projectId', 'hostName', 'clonePath', 'worktreeRoot', 'recordedHost']) {
      expect(await refuse(request({ clones: [getterOn({ ...CLONE }, key)] }))).toEqual(invalid);
    }
    expect(await refuse(request({ clones: [{ ...CLONE, recordedHost: getterOn({ ...RUNNER }, 'host') }] }))).toEqual(invalid);
    const throwingElement = [CLONE];
    Object.defineProperty(throwingElement, 0, {
      get() {
        throw new Error('boom');
      },
    });
    expect(await refuse(request({ clones: throwingElement }))).toEqual(invalid);

    expect(calls).toEqual([]);
  });

  it('refuses secret-shaped inputs and emits zero paths or secrets in planned, unknown, and refused results', async () => {
    const secret = `ghp_${'a'.repeat(30)}`;
    const { useCase, calls, world } = rig(mixedWorld());
    const refusals = [
      request({ clones: [{ ...CLONE, clonePath: `/srv/${secret}` }] }),
      request({ clones: [{ ...CLONE, worktreeRoot: `/srv/sk-${'b'.repeat(30)}` }] }),
      request({ clones: [{ ...CLONE, projectId: secret }] }),
      // Built at runtime so this source file holds no secret-shaped literal (the lane
      // diff gate scans file text, not just runtime values).
      request({
        clones: [
          {
            ...CLONE,
            recordedHost: { ...RUNNER, host: `${['OPENCODE', 'SERVER', 'PASSWORD'].join('_')}=${'x'.repeat(8)}` },
          },
        ],
      }),
      request({ clones: [{ ...CLONE, clonePath: ['', 'home', 'someone', '.ssh', 'id_ed25519'].join('/') }] }),
      request({ hostName: secret }),
    ];
    for (const input of refusals) {
      const result = await useCase.planRelaunch(input);
      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(calls).toEqual([]);

    // A secret-shaped id read back from the inventory or a record is refused, never planned.
    world.rows = [row(`ghp_${'c'.repeat(30)}`)];
    expect(await useCase.planRelaunch(request())).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    world.rows = [row('att-ok', { attemptId: 'att-ok' })];
    world.workOrders = [workOrder('wo-ok', { projectId: secret })];
    world.attempts = [attempt('att-ok', 'wo-ok')];
    expect(await useCase.planRelaunch(request())).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    world.rows = [row('att/ok')];
    expect(await useCase.planRelaunch(request())).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    world.rows = [row('a-lane'), { ...row('a-lane'), hostName: 'h2' }];
    world.workOrders = [];
    world.attempts = [];
    expect(await useCase.planRelaunch(request())).toEqual({ outcome: 'refused', reason: 'invalid-request' });

    // Planned, unknown and refused results never hold a path, an exception message or the secret.
    const results: unknown[] = [];
    const ok = rig(mixedWorld());
    results.push(await ok.useCase.planRelaunch(request()));
    const failing = rig(mixedWorld());
    failing.fail.add('attempts');
    results.push(await failing.useCase.planRelaunch(request()));
    const throwingInventory = rig(mixedWorld());
    throwingInventory.fail.add('inventory');
    results.push(await throwingInventory.useCase.planRelaunch(request()));
    const throwingSave = rig(mixedWorld());
    throwingSave.fail.add('save');
    results.push(await throwingSave.useCase.planRelaunch(request()));
    for (const result of results) {
      const text = JSON.stringify(result);
      for (const forbidden of [WORKTREE_ROOT, CLONE_PATH, '/srv/fleet', 'failure', 'secret-looking']) {
        expect(text).not.toContain(forbidden);
      }
    }
  });

  it('reports unknown and writes no plan when inventory, runner state, ownership, driver lease, or repositories are unknown', async () => {
    const unknown = async (mutate: (world: World, state: Rig) => void): Promise<{ result: PlanRelaunchResult; state: Rig }> => {
      const state = rig(mixedWorld());
      mutate(state.world, state);
      return { result: await state.useCase.planRelaunch(request()), state };
    };
    const cases: [string, (world: World, state: Rig) => void, unknown][] = [
      ['inventory throws', (_w, s) => s.fail.add('inventory'), ['inventory-records-unreadable']],
      ['inventory records unreadable', (_w, s) => (s.inventoryOverride = () => ({ outcome: 'refused', reason: 'records-unreadable' })), ['inventory-records-unreadable']],
      ['inventory malformed', (_w, s) => (s.inventoryOverride = () => ({ outcome: 'inventoried', hosts: 'x' })), ['inventory-records-unreadable']],
      ['inventory returns junk', (_w, s) => (s.inventoryOverride = () => null), ['inventory-records-unreadable']],
      ['driver lease unknown', (w) => (w.conductor.driverLease = 'unknown'), ['driver-lease-unknown']],
      ['runner state unknown', (w) => (w.rows[1] = row('att-a', { runnerState: 'unknown' })), ['unknown-runner-state']],
      ['ownership unknown', (w) => (w.rows[2] = row('att-b', { ownership: 'unknown' })), ['unproven-lane-records']],
      ['host flag unknown listing', (w) => w.hostFlags.push({ code: 'unknown-worktree-read', count: 1 }), ['unknown-worktree-read']],
      ['top flag unknown runner', (w) => w.topFlags.push({ code: 'unknown-runner-state', count: 2 }), ['unknown-runner-state']],
      ['several at once', (w) => {
        w.conductor.driverLease = 'unknown';
        w.hostFlags.push({ code: 'unknown-worktree-read', count: 1 });
        w.rows[1] = row('att-a', { runnerState: 'unknown', ownership: 'unknown' });
      }, ['driver-lease-unknown', 'unknown-runner-state', 'unknown-worktree-read', 'unproven-lane-records']],
      ['run store throws', (_w, s) => s.fail.add('runs'), ['store-read-failed']],
      ['attempt store throws', (_w, s) => s.fail.add('attempts'), ['store-read-failed']],
      ['work order store throws', (_w, s) => s.fail.add('workOrders'), ['store-read-failed']],
      ['lane plan store throws', (_w, s) => s.fail.add('lanePlans'), ['store-read-failed']],
    ];
    for (const [name, mutate, reasons] of cases) {
      const { result, state } = await unknown(mutate);
      expect({ name, result }).toEqual({ name, result: { outcome: 'unknown', reasons } });
      expect({ name, saved: state.saves.length, called: state.calls.includes('save') }).toEqual({ name, saved: 0, called: false });
      expect(await state.plans.findByDigest('0'.repeat(64))).toEqual({ outcome: 'absent' });
    }

    // A zero-count flag is not unknown, and an inventory refused as invalid stays a refusal.
    const calm = rig(mixedWorld());
    calm.world.hostFlags.push({ code: 'unknown-worktree-read', count: 0 });
    expect((await calm.useCase.planRelaunch(request())).outcome).toBe('planned');
    const invalidInventory = rig(mixedWorld());
    invalidInventory.inventoryOverride = () => ({ outcome: 'refused', reason: 'invalid-request' });
    expect(await invalidInventory.useCase.planRelaunch(request())).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('maps store refusals and a throwing store to fixed codes', async () => {
    const throwing = rig(mixedWorld());
    throwing.fail.add('save');
    expect(await throwing.useCase.planRelaunch(request())).toEqual({ outcome: 'refused', reason: 'store-unreadable' });

    const world = mixedWorld();
    const conflicting = rig(world);
    planned(await conflicting.useCase.planRelaunch(request()));
    // The same plan body under a different request digest is a replay conflict (F129): another clone list, same lanes.
    const otherClone = { ...CLONE, projectId: 'p2', clonePath: '/srv/fleet/clones/p2', worktreeRoot: '/srv/fleet/worktrees/p2' };
    const result = await conflicting.useCase.planRelaunch(request({ clones: [CLONE, otherClone] }));
    expect(result).toEqual({ outcome: 'refused', reason: 'digest-conflict' });
  });

  it('stops before the next outbound call when deadlineIso is exhausted and completes cleanly on the next pass', async () => {
    const outbound = ['inventory', 'runs', 'attempts', 'workOrders', 'lanePlans', 'save'];
    for (let allowed = 0; allowed <= outbound.length; allowed += 1) {
      const state = rig(mixedWorld());
      let checks = 0;
      state.setClock(() => {
        checks += 1;
        return checks <= allowed ? '2026-11-07T00:00:05.000Z' : '2026-11-07T00:00:10.000Z';
      });
      const result = await state.useCase.planRelaunch(request({ deadlineIso: '2026-11-07T00:00:10.000Z' }));
      if (allowed === outbound.length) {
        expect(result.outcome).toBe('planned');
        continue;
      }
      expect(result).toEqual({ outcome: 'refused', reason: 'budget-exhausted' });
      expect(state.calls).toEqual(outbound.slice(0, allowed));
      expect(state.saves).toEqual([]);
      expect(await state.plans.findByDigest('0'.repeat(64))).toEqual({ outcome: 'absent' });

      // The next pass, with time to spare, completes cleanly against the same store.
      state.setClock(() => '2026-11-07T00:00:01.000Z');
      const next = planned(await state.useCase.planRelaunch(request({ deadlineIso: '2026-11-07T00:00:10.000Z' })));
      expect(next.reused).toBe(false);
      expect(state.saves.map((saved) => saved.outcome)).toEqual(['saved']);
    }
  });

  it('falls back to nowIso for the deadline when no clock is wired, and treats a throwing clock as nowIso', async () => {
    const world = mixedWorld();
    const exhausted = rig(world);
    exhausted.setClock(undefined);
    expect(await exhausted.useCase.planRelaunch(request({ deadlineIso: NOW }))).toEqual({ outcome: 'refused', reason: 'budget-exhausted' });
    expect(exhausted.calls).toEqual([]);

    const throwingClock = rig(world);
    throwingClock.setClock(() => {
      throw new Error('clock failure');
    });
    expect(await throwingClock.useCase.planRelaunch(request({ deadlineIso: '2026-11-07T00:00:10.000Z' }))).toMatchObject({ outcome: 'planned' });
    expect(await throwingClock.useCase.planRelaunch(request({ deadlineIso: '2026-11-06T00:00:00.000Z' }))).toEqual({
      outcome: 'refused',
      reason: 'budget-exhausted',
    });
  });

  it('refuses clone lists and inventory lane counts exceeding size bounds', async () => {
    const { useCase, world, calls } = rig(emptyWorld());
    const clones = (count: number): RelaunchCloneRef[] => Array.from({ length: count }, (_, index) => ({ ...CLONE, projectId: `p-${index}` }));
    expect(await useCase.planRelaunch(request({ clones: clones(129) }))).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(calls).toEqual([]);
    expect((await useCase.planRelaunch(request({ clones: clones(128) }))).outcome).toBe('planned');

    const lanes = (count: number): RelaunchLaneRow[] => Array.from({ length: count }, (_, index) => row(`att-${index}`));
    world.rows = lanes(513);
    expect(await useCase.planRelaunch(request())).toEqual({ outcome: 'refused', reason: 'limit-exceeded' });
    world.rows = lanes(512);
    const result = planned(await useCase.planRelaunch(request({ maxActiveRuns: 64 })));
    expect(result.plan.lanes).toHaveLength(512);

    // More than 64 hosts is refused as well.
    const hostly = rig(emptyWorld());
    hostly.inventoryOverride = () => ({
      outcome: 'inventoried',
      nowIso: NOW,
      conductor: { halted: false, driverLease: 'absent', runCount: 0 },
      riskFlags: [],
      hosts: Array.from({ length: 65 }, (_, index) => ({ hostName: `h${index}`, riskFlags: [], lanes: [] })),
    });
    expect(await hostly.useCase.planRelaunch(request())).toEqual({ outcome: 'refused', reason: 'limit-exceeded' });
  });

  it('plans each lane host separately and filters by host', async () => {
    const world = emptyWorld();
    world.rows = [row('att-h1'), row('att-h2', { hostName: 'h2' })];
    world.workOrders = [workOrder('wo-h1'), workOrder('wo-h2')];
    world.attempts = [attempt('att-h1', 'wo-h1'), attempt('att-h2', 'wo-h2', { ...RUNNER, hostName: 'h2', host: 'ssh-alias', remotePort: 4100 })];
    const { useCase } = rig(world);
    const plan = planned(await useCase.planRelaunch(request({ clones: [CLONE, { ...CLONE, hostName: 'h2', recordedHost: { ...RUNNER, hostName: 'h2' } }] }))).plan;
    expect(plan.lanes.map((lane) => [lane.laneId, lane.hostName, lane.dispatchEndpointKey])).toEqual([
      ['att-h1', 'h1', 'opencode:h1:4001'],
      ['att-h2', 'h2', 'opencode:h2:4100'],
    ]);
    expect(plan.hostFilter).toBeNull();
    const filtered = planned(await useCase.planRelaunch(request({ hostName: 'h1' }))).plan;
    expect(filtered.hostFilter).toBe('h1');
  });

  it('execute delegates to planRelaunch and an unwired use case reports itself unimplemented', async () => {
    const { useCase } = rig(mixedWorld());
    expect((await useCase.execute(request())).outcome).toBe('planned');
    await expect(new PlanRelaunchUseCase().planRelaunch(request())).rejects.toThrow('Not implemented');
  });
});
