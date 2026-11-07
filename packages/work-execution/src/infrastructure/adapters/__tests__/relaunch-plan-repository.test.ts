import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  canonicalRelaunchPlanBodyJson,
  relaunchStepCodesFor,
  relaunchStepKey,
  type RelaunchPlanRecord,
  type RelaunchPlannedLane,
} from '../../../application/ports/out/RelaunchPlanRepositoryPort.out-port.js';
import { RelaunchPlanRepositoryAdapter } from '../RelaunchPlanRepositoryAdapter.adapter.js';

const NOW = '2026-11-07T00:00:00.000Z';
const REQUEST_DIGEST = 'a'.repeat(64);

const tempDirs: string[] = [];

afterAll(async () => {
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'fleet-v2-relaunch-plans-'));
  tempDirs.push(dir);
  return dir;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface LaneSeed {
  readonly laneId: string;
  readonly population?: RelaunchPlannedLane['population'];
  readonly runnerState?: 'idle' | 'running';
  readonly hostName?: string;
  readonly dependsOnLaneIds?: readonly string[];
  readonly admissionWave?: number;
}

/** A well-formed plan whose digest and step keys are computed exactly as the use case computes them. */
function makePlan(
  seeds: readonly LaneSeed[] = [{ laneId: 'lane-a' }, { laneId: 'lane-b', runnerState: 'running' }],
  overrides: { readonly requestDigest?: string; readonly createdAtIso?: string; readonly hostFilter?: string | null } = {},
): RelaunchPlanRecord {
  const body = {
    schemaVersion: 1 as const,
    hostFilter: overrides.hostFilter ?? null,
    maxActiveRuns: 8,
    dispatchStaggerMs: 20_000,
    conductor: { halted: false, driverLease: 'absent' as const, runCount: 0 },
    lanes: seeds.map((seed, index) => {
      const population = seed.population ?? 'attempt-recorded';
      const runnerState = seed.runnerState ?? 'idle';
      const conducted = population === 'conducted';
      return {
        laneId: seed.laneId,
        hostName: seed.hostName ?? 'lane-host',
        projectId: 'proj-1',
        population,
        runnerState,
        runId: null,
        attemptId: `attempt-${seed.laneId}`,
        workOrderId: `wo-${seed.laneId}`,
        baseBranch: 'main' as const,
        chainHead: false,
        dependsOnLaneIds: seed.dependsOnLaneIds ?? [],
        admissionWave: conducted ? 0 : (seed.admissionWave ?? 1),
        dispatchEndpointKey: conducted ? null : 'opencode:lane-host:4001',
        staggerOffsetMs: conducted ? null : index * 20_000,
        stepCodes: relaunchStepCodesFor(population, runnerState),
      };
    }),
  };
  const planDigest = sha256(canonicalRelaunchPlanBodyJson(body));
  return {
    schemaVersion: 1,
    planDigest,
    requestDigest: overrides.requestDigest ?? REQUEST_DIGEST,
    createdAtIso: overrides.createdAtIso ?? NOW,
    hostFilter: body.hostFilter,
    maxActiveRuns: body.maxActiveRuns,
    dispatchStaggerMs: body.dispatchStaggerMs,
    conductor: body.conductor,
    lanes: body.lanes.map(({ stepCodes, ...lane }) => ({
      ...lane,
      steps: stepCodes.map((step) => ({ step, idempotencyKey: relaunchStepKey(planDigest, lane.laneId, step) })),
    })),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('RelaunchPlanRepositoryAdapter', () => {
  it('persists atomically once per planDigest and returns unchanged on identical replay', async () => {
    const dir = await tempDir();
    const adapter = new RelaunchPlanRepositoryAdapter({ stateDir: dir });
    const plan = makePlan();

    const first = await adapter.save(plan);
    expect(first).toMatchObject({ outcome: 'saved', planDigest: plan.planDigest });
    const file = path.join(dir, 'relaunch-plans.json');
    const bytesAfterFirst = await fs.readFile(file);
    const statAfterFirst = await fs.stat(file);

    // The same state planned at a later clock instant is the same plan: createdAtIso is metadata only.
    const later = makePlan(undefined, { createdAtIso: '2026-11-08T12:00:00.000Z' });
    expect(later.planDigest).toBe(plan.planDigest);
    const second = await new RelaunchPlanRepositoryAdapter({ stateDir: dir }).save(later);
    expect(second).toMatchObject({ outcome: 'unchanged', planDigest: plan.planDigest });
    if (second.outcome === 'unchanged') expect(second.plan.createdAtIso).toBe(NOW);

    expect((await fs.readFile(file)).equals(bytesAfterFirst)).toBe(true);
    expect((await fs.stat(file)).mtimeMs).toBe(statAfterFirst.mtimeMs);
    expect(JSON.parse(bytesAfterFirst.toString('utf8'))).toHaveLength(1);
    expect((await fs.readdir(dir)).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([]);

    const found = await new RelaunchPlanRepositoryAdapter({ stateDir: dir }).findByDigest(plan.planDigest);
    expect(found).toEqual({ outcome: 'found', plan });
    expect(await adapter.findByDigest('b'.repeat(64))).toEqual({ outcome: 'absent' });
  });

  it('keeps one record per digest when saves race', async () => {
    const dir = await tempDir();
    const adapter = new RelaunchPlanRepositoryAdapter({ stateDir: dir });
    const plan = makePlan();
    const results = await Promise.all([adapter.save(plan), adapter.save(plan), adapter.save(plan)]);
    expect(results.filter((result) => result.outcome === 'saved')).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'unchanged')).toHaveLength(2);
    const stored = JSON.parse(await fs.readFile(path.join(dir, 'relaunch-plans.json'), 'utf8')) as unknown[];
    expect(stored).toHaveLength(1);
  });

  it('holds plans in memory when no state directory is given', async () => {
    const adapter = new RelaunchPlanRepositoryAdapter();
    const plan = makePlan();
    expect((await adapter.save(plan)).outcome).toBe('saved');
    expect((await adapter.save(plan)).outcome).toBe('unchanged');
    expect(await adapter.findByDigest(plan.planDigest)).toEqual({ outcome: 'found', plan });
    expect(await new RelaunchPlanRepositoryAdapter().findByDigest(plan.planDigest)).toEqual({ outcome: 'absent' });
  });

  it('refuses malformed plans, sparse lane arrays, and throwing getters without throwing', async () => {
    const adapter = new RelaunchPlanRepositoryAdapter();
    const valid = makePlan();
    const refuse = async (input: unknown): Promise<unknown> => adapter.save(input as RelaunchPlanRecord);

    for (const input of [null, undefined, 7, 'plan', [], [valid], {}]) {
      expect(await refuse(input)).toEqual({ outcome: 'refused', reason: 'invalid-plan' });
    }

    const sparse = { ...valid, lanes: new Array(2) };
    expect(await refuse(sparse)).toEqual({ outcome: 'refused', reason: 'invalid-plan' });

    const throwingTop = { ...valid };
    Object.defineProperty(throwingTop, 'lanes', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(await refuse(throwingTop)).toEqual({ outcome: 'refused', reason: 'invalid-plan' });

    const throwingLane = clone(valid);
    Object.defineProperty(throwingLane.lanes[0], 'laneId', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(await refuse(throwingLane)).toEqual({ outcome: 'refused', reason: 'invalid-plan' });

    const throwingStep = clone(valid);
    Object.defineProperty(throwingStep.lanes[0].steps[0], 'step', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(await refuse(throwingStep)).toEqual({ outcome: 'refused', reason: 'invalid-plan' });

    const sparseSteps = clone(valid);
    (sparseSteps.lanes[0] as { steps: unknown }).steps = new Array(3);
    expect(await refuse(sparseSteps)).toEqual({ outcome: 'refused', reason: 'invalid-plan' });

    const withClassProto = Object.create({ inherited: true }) as Record<string, unknown>;
    Object.assign(withClassProto, valid);
    expect(await refuse(withClassProto)).toEqual({ outcome: 'refused', reason: 'invalid-plan' });

    const extraKey = { ...clone(valid), extra: 'x' };
    expect(await refuse(extraKey)).toEqual({ outcome: 'refused', reason: 'invalid-plan' });

    expect(await adapter.findByDigest(null as unknown as string)).toEqual({ outcome: 'refused', reason: 'invalid-digest' });
    expect(await adapter.findByDigest('XYZ')).toEqual({ outcome: 'refused', reason: 'invalid-digest' });
    expect(await adapter.findByDigest({} as unknown as string)).toEqual({ outcome: 'refused', reason: 'invalid-digest' });
  });

  it('refuses secret-shaped text, path-shaped ids, bad step keys and inconsistent lanes', async () => {
    const adapter = new RelaunchPlanRepositoryAdapter();
    const mutations: ((plan: RelaunchPlanRecord) => void)[] = [
      (plan) => ((plan.lanes[0] as { laneId: string }).laneId = 'lane/with/slash'),
      (plan) => ((plan.lanes[0] as { hostName: string }).hostName = '/srv/fleet/worktrees'),
      (plan) => ((plan.lanes[0] as { projectId: string | null }).projectId = 'a/b'),
      (plan) => ((plan.lanes[0] as { runId: string | null }).runId = 'run/1'),
      (plan) => ((plan.lanes[0] as { attemptId: string | null }).attemptId = `ghp_${'a'.repeat(30)}`),
      (plan) => ((plan.lanes[0] as { workOrderId: string | null }).workOrderId = `sk-${'a'.repeat(30)}`),
      (plan) => ((plan.lanes[0] as { baseBranch: string }).baseBranch = 'feature/x'),
      (plan) => ((plan.lanes[0].steps[0] as { idempotencyKey: string }).idempotencyKey = 'relaunch/x/lane-a/save'),
      (plan) => ((plan.lanes[0] as { steps: unknown }).steps = []),
      (plan) => ((plan.lanes[0] as { admissionWave: number }).admissionWave = 0),
      (plan) => ((plan.lanes[0] as { dispatchEndpointKey: string | null }).dispatchEndpointKey = null),
      (plan) => ((plan.lanes[0] as unknown as { dependsOnLaneIds: string[] }).dependsOnLaneIds = ['lane-a']),
      (plan) => ((plan.lanes[0] as unknown as { dependsOnLaneIds: string[] }).dependsOnLaneIds = ['lane-missing']),
      (plan) => ((plan as { planDigest: string }).planDigest = 'ABC'),
      (plan) => ((plan as { createdAtIso: string }).createdAtIso = '2026-11-07T00:00:00'),
      (plan) => ((plan as { maxActiveRuns: number }).maxActiveRuns = 0),
      (plan) => ((plan as { dispatchStaggerMs: number }).dispatchStaggerMs = -1),
      (plan) => ((plan as { schemaVersion: number }).schemaVersion = 2),
      (plan) => ((plan as { lanes: unknown }).lanes = [plan.lanes[0], plan.lanes[0]]),
    ];
    for (const mutate of mutations) {
      const plan = clone(makePlan());
      mutate(plan);
      expect(await adapter.save(plan)).toEqual({ outcome: 'refused', reason: 'invalid-plan' });
    }
  });

  it('refuses a plan whose digest is not its canonical digest, writing nothing', async () => {
    const dir = await tempDir();
    const adapter = new RelaunchPlanRepositoryAdapter({ stateDir: dir });
    const real = makePlan();
    const forged = { ...clone(real), planDigest: 'c'.repeat(64) };
    forged.lanes = forged.lanes.map((lane) => ({
      ...lane,
      steps: lane.steps.map((step) => ({ step: step.step, idempotencyKey: relaunchStepKey(forged.planDigest, lane.laneId, step.step) })),
    }));
    expect(await adapter.save(forged)).toEqual({ outcome: 'refused', reason: 'digest-mismatch' });
    await expect(fs.stat(path.join(dir, 'relaunch-plans.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses replay under a stored planDigest when requestDigest or any lane field differs before writing', async () => {
    const dir = await tempDir();
    const adapter = new RelaunchPlanRepositoryAdapter({ stateDir: dir });
    const plan = makePlan();
    expect((await adapter.save(plan)).outcome).toBe('saved');
    const file = path.join(dir, 'relaunch-plans.json');
    const before = await fs.readFile(file);

    const differentRequest = makePlan(undefined, { requestDigest: 'd'.repeat(64) });
    expect(differentRequest.planDigest).toBe(plan.planDigest);
    expect(await adapter.save(differentRequest)).toEqual({ outcome: 'refused', reason: 'digest-conflict' });

    const renamedLane = clone(plan) as { -readonly [K in keyof RelaunchPlanRecord]: RelaunchPlanRecord[K] };
    (renamedLane.lanes[0] as { laneId: string }).laneId = 'lane-renamed';
    renamedLane.lanes = renamedLane.lanes.map((lane) => ({
      ...lane,
      steps: lane.steps.map((step) => ({ step: step.step, idempotencyKey: relaunchStepKey(plan.planDigest, lane.laneId, step.step) })),
    }));
    expect(await adapter.save(renamedLane)).toEqual({ outcome: 'refused', reason: 'digest-conflict' });

    const changedWave = clone(plan);
    (changedWave.lanes[1] as { admissionWave: number }).admissionWave = 2;
    expect(await adapter.save(changedWave)).toEqual({ outcome: 'refused', reason: 'digest-conflict' });

    const changedHostFilter = { ...clone(plan), hostFilter: 'other-host' };
    expect(await adapter.save(changedHostFilter)).toEqual({ outcome: 'refused', reason: 'digest-conflict' });

    expect((await fs.readFile(file)).equals(before)).toBe(true);
  });

  it('reports unreadable and unknown-version store files instead of absent', async () => {
    const plan = makePlan();

    const corrupt = await tempDir();
    await fs.writeFile(path.join(corrupt, 'relaunch-plans.json'), '{not json', 'utf8');
    const corruptAdapter = new RelaunchPlanRepositoryAdapter({ stateDir: corrupt });
    expect(await corruptAdapter.findByDigest(plan.planDigest)).toEqual({ outcome: 'unreadable', reason: 'unreadable' });
    expect(await corruptAdapter.save(plan)).toEqual({ outcome: 'refused', reason: 'store-unreadable' });
    expect(await fs.readFile(path.join(corrupt, 'relaunch-plans.json'), 'utf8')).toBe('{not json');

    const notAList = await tempDir();
    await fs.writeFile(path.join(notAList, 'relaunch-plans.json'), '{}', 'utf8');
    expect(await new RelaunchPlanRepositoryAdapter({ stateDir: notAList }).findByDigest(plan.planDigest)).toEqual({
      outcome: 'unreadable',
      reason: 'unreadable',
    });

    const badRecord = await tempDir();
    await fs.writeFile(path.join(badRecord, 'relaunch-plans.json'), JSON.stringify([{ ...plan, lanes: 'x' }]), 'utf8');
    expect(await new RelaunchPlanRepositoryAdapter({ stateDir: badRecord }).findByDigest(plan.planDigest)).toEqual({
      outcome: 'unreadable',
      reason: 'unreadable',
    });

    const future = await tempDir();
    const futureBytes = JSON.stringify([{ ...plan, schemaVersion: 2 }]);
    await fs.writeFile(path.join(future, 'relaunch-plans.json'), futureBytes, 'utf8');
    const futureAdapter = new RelaunchPlanRepositoryAdapter({ stateDir: future });
    expect(await futureAdapter.findByDigest(plan.planDigest)).toEqual({ outcome: 'unreadable', reason: 'unknown-version' });
    expect(await futureAdapter.save(plan)).toEqual({ outcome: 'refused', reason: 'store-unknown-version' });
    expect(await fs.readFile(path.join(future, 'relaunch-plans.json'), 'utf8')).toBe(futureBytes);

    const duplicate = await tempDir();
    await fs.writeFile(path.join(duplicate, 'relaunch-plans.json'), JSON.stringify([plan, plan]), 'utf8');
    expect(await new RelaunchPlanRepositoryAdapter({ stateDir: duplicate }).save(plan)).toEqual({
      outcome: 'refused',
      reason: 'store-unreadable',
    });

    const dangling = await tempDir();
    await fs.symlink(path.join(dangling, 'nowhere.json'), path.join(dangling, 'relaunch-plans.json'));
    expect(await new RelaunchPlanRepositoryAdapter({ stateDir: dangling }).findByDigest(plan.planDigest)).toEqual({
      outcome: 'unreadable',
      reason: 'unreadable',
    });

    const missing = await tempDir();
    expect(await new RelaunchPlanRepositoryAdapter({ stateDir: missing }).findByDigest(plan.planDigest)).toEqual({ outcome: 'absent' });
  });

  it('reads a stored record that carries no schemaVersion as version 1', async () => {
    const dir = await tempDir();
    const plan = makePlan();
    const legacy: Record<string, unknown> = { ...plan };
    delete legacy.schemaVersion;
    await fs.writeFile(path.join(dir, 'relaunch-plans.json'), JSON.stringify([legacy]), 'utf8');
    const found = await new RelaunchPlanRepositoryAdapter({ stateDir: dir }).findByDigest(plan.planDigest);
    expect(found).toEqual({ outcome: 'found', plan });
  });

  it('refuses oversized store files before reading and refuses exceeding plan count bounds', async () => {
    const oversized = await tempDir();
    const file = path.join(oversized, 'relaunch-plans.json');
    await fs.writeFile(file, '');
    await fs.truncate(file, 8 * 1024 * 1024 + 1);
    const oversizedAdapter = new RelaunchPlanRepositoryAdapter({ stateDir: oversized });
    const plan = makePlan();
    expect(await oversizedAdapter.findByDigest(plan.planDigest)).toEqual({ outcome: 'unreadable', reason: 'unreadable' });
    expect(await oversizedAdapter.save(plan)).toEqual({ outcome: 'refused', reason: 'store-unreadable' });

    const full = new RelaunchPlanRepositoryAdapter();
    for (let index = 0; index < 256; index += 1) {
      expect((await full.save(makePlan([{ laneId: `lane-${index}` }]))).outcome).toBe('saved');
    }
    expect(await full.save(makePlan([{ laneId: 'lane-one-too-many' }]))).toEqual({
      outcome: 'refused',
      reason: 'store-limit-exceeded',
    });
    // A replay of a stored plan is still unchanged at the cap.
    expect((await full.save(makePlan([{ laneId: 'lane-0' }]))).outcome).toBe('unchanged');

    const tooManyLanes = makePlan(Array.from({ length: 513 }, (_, index) => ({ laneId: `lane-${index}` })));
    expect(await new RelaunchPlanRepositoryAdapter().save(tooManyLanes)).toEqual({ outcome: 'refused', reason: 'invalid-plan' });
    const maxLanes = makePlan(Array.from({ length: 512 }, (_, index) => ({ laneId: `lane-${index}` })));
    expect((await new RelaunchPlanRepositoryAdapter().save(maxLanes)).outcome).toBe('saved');
  });

  it('refuses a duplicate lane id on one host but allows the same id on another host', async () => {
    const adapter = new RelaunchPlanRepositoryAdapter();
    const duplicate = makePlan([{ laneId: 'lane-a' }, { laneId: 'lane-a' }]);
    expect(await adapter.save(duplicate)).toEqual({ outcome: 'refused', reason: 'invalid-plan' });
    const twoHosts = makePlan([{ laneId: 'lane-a' }, { laneId: 'lane-a', hostName: 'other-host' }]);
    expect((await adapter.save(twoHosts)).outcome).toBe('saved');
  });

  it('refuses every save when read-only, and refuses unsafe or colliding file names', async () => {
    const dir = await tempDir();
    const readOnly = new RelaunchPlanRepositoryAdapter({ stateDir: dir, readOnly: true });
    expect(await readOnly.save(makePlan())).toEqual({ outcome: 'refused', reason: 'store-read-only' });
    await expect(fs.readdir(dir)).resolves.toEqual([]);

    for (const fileName of ['work-orders.json', 'attempts.json', 'journal.json', 'reservations.json', 'lane-runs.json', 'run-journal.json', 'lane-plans.json', 'cutover-journal.json']) {
      expect(() => new RelaunchPlanRepositoryAdapter({ stateDir: dir, fileName })).toThrow();
    }
    for (const fileName of ['../plans.json', 'a/b.json', '', '..', '.', 'x'.repeat(129)]) {
      expect(() => new RelaunchPlanRepositoryAdapter({ stateDir: dir, fileName })).toThrow();
    }
    const custom = new RelaunchPlanRepositoryAdapter({ stateDir: dir, fileName: 'custom-plans.json' });
    expect((await custom.save(makePlan())).outcome).toBe('saved');
    expect(await fs.readdir(dir)).toEqual(['custom-plans.json']);
  });

  it('never reports a stored plan whose body no longer hashes to its digest as found', async () => {
    const dir = await tempDir();
    const plan = makePlan();
    const tampered = clone(plan);
    (tampered.lanes[1] as { admissionWave: number }).admissionWave = 2;
    await fs.writeFile(path.join(dir, 'relaunch-plans.json'), JSON.stringify([tampered]), 'utf8');
    expect(await new RelaunchPlanRepositoryAdapter({ stateDir: dir }).findByDigest(plan.planDigest)).toEqual({
      outcome: 'unreadable',
      reason: 'unreadable',
    });

    const memory = new RelaunchPlanRepositoryAdapter();
    expect((await memory.save(plan)).outcome).toBe('saved');
    const held = (
      memory as unknown as { inMemoryPlans: Map<string, RelaunchPlanRecord> }
    ).inMemoryPlans.get(plan.planDigest) as RelaunchPlanRecord;
    (held.lanes[1] as { admissionWave: number }).admissionWave = 2;
    expect(await memory.findByDigest(plan.planDigest)).toEqual({ outcome: 'absent' });
  });

  it('hands out copies, so mutating a returned plan never changes the stored one', async () => {
    const adapter = new RelaunchPlanRepositoryAdapter();
    const plan = makePlan();
    const saved = await adapter.save(plan);
    if (saved.outcome !== 'saved') throw new Error('expected saved');
    (saved.plan.lanes[0].steps[0] as { idempotencyKey: string }).idempotencyKey = 'mutated';
    const found = await adapter.findByDigest(plan.planDigest);
    if (found.outcome !== 'found') throw new Error('expected found');
    expect(found.plan.lanes[0].steps[0].idempotencyKey).toBe(relaunchStepKey(plan.planDigest, 'lane-a', 'save'));

    const replay = await adapter.save(plan);
    if (replay.outcome !== 'unchanged') throw new Error('expected unchanged');
    expect(replay.plan.lanes[0]).toEqual(found.plan.lanes[0]);
    (replay.plan.lanes[0].steps[0] as { idempotencyKey: string }).idempotencyKey = 'mutated-again';
    expect((await adapter.findByDigest(plan.planDigest)).outcome === 'found');
    const after = await adapter.findByDigest(plan.planDigest);
    if (after.outcome !== 'found') throw new Error('expected found');
    expect(after.plan.lanes[0].steps[0].idempotencyKey).toBe(relaunchStepKey(plan.planDigest, 'lane-a', 'save'));
  });

  it('writes ids, digests and codes only', async () => {
    const dir = await tempDir();
    await new RelaunchPlanRepositoryAdapter({ stateDir: dir }).save(makePlan());
    const text = await fs.readFile(path.join(dir, 'relaunch-plans.json'), 'utf8');
    expect(text).not.toContain(dir);
    expect(text).not.toMatch(/worktreePath|clonePath|worktreeRoot|stateDir/);
  });
});
