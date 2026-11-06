import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, WorkOrderRecord } from '../../../domain/execution-records.js';
import { prepareLaneRunJournalAppend } from '../../../domain/lane-run-journal.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { laneRunJournalState } from '../../../domain/lane-run-journal.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { AdoptLaneResult } from '../../ports/in/AdoptLanePort.in-port.js';
import type { CutoverJournalEntry, CutoverJournalPort } from '../../ports/out/CutoverJournalPort.out-port.js';
import { AdoptLaneUseCase } from '../AdoptLaneUseCase.use-case.js';
import type { AdoptLaneDependencies } from '../AdoptLaneUseCase.use-case.js';

const PLAN = 'a'.repeat(64);
const LANE = 'lane-co28';
const KEY = (step: string): string => `relaunch/${PLAN}/${LANE}/adopt/${step}`;
const SAVE_KEY = `relaunch/${PLAN}/${LANE}/save`;
const SAVE_REF = 'refs/fleet/saved/aaaaaaaaaaaa-lane-co28';
const COMMIT = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const RUN_ID = 'run-01JB0000000000000000000000';
const ATTEMPT_ID = 'attempt-adopted-1';
const BRIEF_TEXT = 'Implement the lane.\nNot done until the commit exists.';
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const BRIEF_DIGEST = sha(BRIEF_TEXT);

type Trace = string[];

interface World {
  readonly deps: AdoptLaneDependencies;
  readonly trace: Trace;
  readonly orders: Map<string, WorkOrderRecord>;
  readonly attempts: Map<string, AttemptRecord>;
  readonly runs: Map<string, LaneRunRecord>;
  readonly runEntries: LaneRunJournalEntryRecord[];
  readonly cutover: CutoverJournalEntry[];
  readonly fail: Set<string>;
  clock: { now: string };
}

let ulidCounter = 0;
const nextUlid = (): string => {
  ulidCounter += 1;
  return `01JB${String(ulidCounter).padStart(22, '0')}`.replace(/[ILOU]/g, '0');
};

function world(options: { crashAfterWrite?: string } = {}): World {
  const trace: Trace = [];
  const orders = new Map<string, WorkOrderRecord>();
  const attempts = new Map<string, AttemptRecord>();
  const runs = new Map<string, LaneRunRecord>();
  const runEntries: LaneRunJournalEntryRecord[] = [];
  const cutover: CutoverJournalEntry[] = [];
  const fail = new Set<string>();
  const clock = { now: '2026-11-06T10:00:00.000Z' };
  const check = (name: string): void => {
    if (fail.has(name)) throw new Error(`secret-looking /home/x/.ssh failure ${name}`);
  };
  const crash = (name: string): void => {
    if (options.crashAfterWrite === name) {
      options.crashAfterWrite = undefined;
      throw new Error('crash');
    }
  };
  const cutoverJournal: CutoverJournalPort = {
    async append(entry) {
      check('cutover.append');
      const own = cutover.filter((e) => e.key === entry.key);
      if (entry.kind === 'intent' && own.some((e) => e.kind === 'intent')) return { outcome: 'refused', reason: 'duplicate-intent' };
      if (entry.kind === 'result' && !own.some((e) => e.kind === 'intent')) return { outcome: 'refused', reason: 'result-without-intent' };
      cutover.push(entry);
      trace.push(`${entry.kind}:${entry.key.split('/').slice(3).join('/')}`);
      return { outcome: 'appended', entry };
    },
    async listByKeyPrefix(prefix) {
      check('cutover.list');
      if (fail.has('cutover.unreadable')) return { outcome: 'unreadable' };
      return { outcome: 'listed', entries: cutover.filter((e) => e.key.startsWith(prefix)) };
    },
  };
  const deps: AdoptLaneDependencies = {
    workOrderRepo: {
      async saveWorkOrder(record) {
        check('wo.save');
        orders.set(record.id, record);
        trace.push('write:work-order');
        crash('work-order');
      },
      async findWorkOrderById(id) {
        check('wo.find');
        return orders.get(id) ?? null;
      },
      async listWorkOrdersByProject() {
        check('wo.list');
        return [...orders.values()];
      },
    },
    attemptRepo: {
      async saveAttempt(record) {
        check('attempt.save');
        attempts.set(record.id, record);
        trace.push('write:attempt');
        crash('attempt');
      },
      async findAttemptById(id) {
        check('attempt.find');
        return attempts.get(id) ?? null;
      },
      async listAttemptsByWorkOrder(workOrderId) {
        check('attempt.list');
        return [...attempts.values()].filter((a) => a.workOrderId === workOrderId);
      },
      async listAllAttempts() {
        return [...attempts.values()];
      },
    },
    runRepo: {
      async create(record) {
        check('run.create');
        if (runs.has(record.runId)) return { outcome: 'refused', reason: 'run-exists' };
        runs.set(record.runId, record);
        trace.push('write:run');
        crash('run');
        return { outcome: 'saved', record };
      },
      async save() {
        throw new Error('never saved');
      },
      async get(runId) {
        check('run.get');
        return runs.get(runId) ?? null;
      },
      async list() {
        check('run.list');
        return [...runs.values()];
      },
      async acquireLease() {
        throw new Error('no lease');
      },
      async renewLease() {
        throw new Error('no lease');
      },
      async releaseLease() {
        throw new Error('no lease');
      },
    },
    runJournal: {
      async append(entry) {
        check('runjournal.append');
        const decision = prepareLaneRunJournalAppend(runEntries, entry);
        if (!decision.ok) return { outcome: 'refused', reason: decision.reason, detail: decision.detail };
        runEntries.push(decision.entry);
        trace.push(`write:conduct:${decision.entry.state}`);
        return { outcome: 'appended', entry: decision.entry };
      },
      async listForRun(runId) {
        check('runjournal.list');
        return runEntries.filter((e) => e.runId === runId);
      },
      async listForKey() {
        return [];
      },
    },
    cutoverJournal,
    computeDigest: sha,
    mintEntryId: nextUlid,
    now: () => clock.now,
  };
  return { deps, trace, orders, attempts, runs, runEntries, cutover, fail, clock };
}

function saveEntries(w: World, overrides: Partial<CutoverJournalEntry> = {}, withIntent = true): void {
  if (withIntent) w.cutover.push({ key: SAVE_KEY, kind: 'intent', entryId: nextUlid(), recordedAtIso: '2026-11-06T09:00:00.000Z' });
  w.cutover.push({
    key: SAVE_KEY, kind: 'result', entryId: nextUlid(), recordedAtIso: '2026-11-06T09:00:01.000Z',
    outcome: 'completed', reasonCode: 'saved', digest: TREE, commitId: COMMIT, saveRef: SAVE_REF, ...overrides,
  });
}

function request(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planDigest: PLAN,
    laneId: LANE,
    projectId: 'fleet-v2',
    planRef: { projectId: 'fleet-v2', planId: 'cutover-plan', laneId: LANE },
    baseBranch: 'main',
    workOrder: {
      workOrderId: 'wo-co28', taskId: 'co28', repository: 'fleet-v2', baseCommit: BASE,
      ownedPaths: ['packages/work-execution/src/application'], policyRevision: 'policy-1', risk: 'high',
    },
    brief: {
      briefId: 'brief-co28', briefText: BRIEF_TEXT, expectedBriefDigest: BRIEF_DIGEST,
      prosePath: '.lane/brief.md', manifestPath: '.lane/brief-manifest.json', reviewerModel: 'openai/gpt-6-luna',
      acceptanceSpec: { commitRequired: true, diffCheck: true, commands: [{ argv: ['yarn', 'typecheck'] }] },
    },
    attempt: { attemptId: ATTEMPT_ID, endedAtIso: '2026-11-06T09:30:00.000Z', sessionId: 'ses_1' },
    run: { runId: RUN_ID, tier: 2, seatPlanRef: 'e'.repeat(64), runPolicyRevision: 'policy-1' },
    source: { kind: 'save-ref', saveRef: SAVE_REF, commitOid: COMMIT, treeDigest: TREE },
    nowIso: '2026-11-06T10:00:00.000Z',
    ...extra,
  };
}

const clean = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'clean-commit', commitOid: COMMIT, branchName: 'fleet/run-x', commitOnBranch: true, dirtyCount: 0, ...extra,
});

async function adopt(w: World, req: unknown = request()): Promise<AdoptLaneResult> {
  return new AdoptLaneUseCase(w.deps).execute(req);
}

function savedWorld(): World {
  const w = world();
  saveEntries(w);
  return w;
}

describe('AdoptLaneUseCase happy paths', () => {
  it('adopts from a verified save ref: work order, frozen brief digest, ended partial attempt, collecting adopted run', async () => {
    const w = savedWorld();
    const result = await adopt(w);
    expect(result).toEqual({
      outcome: 'adopted', reused: false, workOrderId: 'wo-co28', briefDigest: BRIEF_DIGEST, attemptId: ATTEMPT_ID,
      runId: RUN_ID, commitOid: COMMIT, enteredState: 'collecting', provenance: 'adopted',
    });
    const order = w.orders.get('wo-co28');
    expect(order?.planRef).toEqual({ projectId: 'fleet-v2', planId: 'cutover-plan', laneId: LANE });
    expect(order?.baseBranch).toBe('main');
    expect(order?.state).toBe('implementing');
    const attempt = w.attempts.get(ATTEMPT_ID);
    expect(attempt).toMatchObject({ state: 'ended', outcome: 'partial', briefDigest: BRIEF_DIGEST, kind: 'initial', fixNumber: 0 });
    expect(attempt?.artifacts?.headCommit).toBe(COMMIT);
    expect(attempt?.artifacts?.manifestPath).toBeUndefined();
    const run = w.runs.get(RUN_ID);
    expect(run).toMatchObject({ provenance: 'adopted', round: 0, attemptIds: [ATTEMPT_ID], revision: 1, lease: null, parked: null, prNumber: null });
    expect(run?.branchName).toBe(`fleet/${RUN_ID}`);
    expect(laneRunJournalState(w.runEntries, RUN_ID)).toBe('collecting');
    // Intent before action, result after, for each step in order.
    expect(w.trace).toEqual([
      'intent:adopt/work-order', 'write:work-order', 'result:adopt/work-order',
      'intent:adopt/brief', 'result:adopt/brief',
      'intent:adopt/attempt', 'write:attempt', 'result:adopt/attempt',
      'intent:adopt/run', 'write:run', 'write:conduct:collecting', 'result:adopt/run',
    ]);
    // It dispatched nothing: one attempt, no fix round, no reservation.
    expect(w.attempts.size).toBe(1);
    const brief = w.cutover.find((e) => e.key === KEY('brief') && e.kind === 'result');
    expect(brief?.digest).toBe(BRIEF_DIGEST);
  });

  it('registers a chain base branch and keeps it on the work order and the run', async () => {
    const w = savedWorld();
    const result = await adopt(w, request({ baseBranch: 'chain/co-chain' }));
    expect(result.outcome).toBe('adopted');
    expect(w.orders.get('wo-co28')?.baseBranch).toBe('chain/co-chain');
    expect(w.runs.get(RUN_ID)?.baseBranch).toBe('chain/co-chain');
  });

  it('adopts a clean commit on the lane branch without a save', async () => {
    const w = world();
    const result = await adopt(w, request({ source: clean({ commitsSinceBase: [COMMIT] }) }));
    expect(result.outcome).toBe('adopted');
    expect(w.attempts.get(ATTEMPT_ID)?.artifacts?.commitsSinceBase).toEqual([COMMIT]);
  });

  it('does not rewrite the brief text: the digest it verified is the digest it records', async () => {
    const w = savedWorld();
    const seen: string[] = [];
    const deps = { ...w.deps, computeDigest: (text: string): string => { seen.push(text); return sha(text); } };
    const result = await new AdoptLaneUseCase(deps).execute(request());
    expect(result.outcome).toBe('adopted');
    expect(seen).toEqual([BRIEF_TEXT]);
  });
});

describe('AdoptLaneUseCase refusals', () => {
  it('save-missing when the journal holds no save for the lane', async () => {
    const w = world();
    expect(await adopt(w)).toEqual({ outcome: 'refused', reason: 'save-missing' });
    expect(w.trace).toEqual([]);
  });

  it.each([
    ['intent only', () => { const w = world(); saveEntries(w, {}, true); w.cutover.pop(); return w; }],
    ['failed save', () => { const w = world(); saveEntries(w, { outcome: 'refused', reasonCode: 'save-refused' }); return w; }],
    ['tree digest mismatch', () => { const w = world(); saveEntries(w, { digest: 'f'.repeat(40) }); return w; }],
    ['commit mismatch', () => { const w = world(); saveEntries(w, { commitId: 'f'.repeat(40) }); return w; }],
    ['save ref mismatch', () => { const w = world(); saveEntries(w, { saveRef: 'refs/fleet/saved/other' }); return w; }],
  ])('save-unverified on %s', async (_name, build) => {
    const w = build();
    expect(await adopt(w)).toEqual({ outcome: 'refused', reason: 'save-unverified' });
    expect(w.trace).toEqual([]);
  });

  it('save-unverified for a ref outside refs/fleet/saved/', async () => {
    const w = world();
    saveEntries(w, { saveRef: 'refs/heads/main' });
    const source = { kind: 'save-ref', saveRef: 'refs/heads/main', commitOid: COMMIT, treeDigest: TREE };
    expect(await adopt(w, request({ source }))).toEqual({ outcome: 'refused', reason: 'save-unverified' });
  });

  it.each([
    ['commit not on branch', clean({ commitOnBranch: false }), 'commit-not-on-branch'],
    ['commit is the base', clean({ commitOid: BASE }), 'commit-not-on-branch'],
    ['commit absent from commits since base', clean({ commitsSinceBase: ['9'.repeat(40)] }), 'commit-not-on-branch'],
    ['empty commits since base', clean({ commitsSinceBase: [] }), 'commit-not-on-branch'],
    ['dirty worktree', clean({ dirtyCount: 2 }), 'worktree-dirty'],
  ])('refuses a clean commit: %s', async (_name, source, reason) => {
    const w = world();
    expect(await adopt(w, request({ source }))).toEqual({ outcome: 'refused', reason });
    expect(w.trace).toEqual([]);
  });

  it('lane-already-has-run when a run exists for the work order, the run id or the same plan lane', async () => {
    const w = savedWorld();
    await adopt(w);
    const again = world();
    saveEntries(again);
    again.runs.set('run-01JB0000000000000000000009', { ...(w.runs.get(RUN_ID) as LaneRunRecord), runId: 'run-01JB0000000000000000000009', provenance: 'started' });
    expect(await adopt(again)).toEqual({ outcome: 'refused', reason: 'lane-already-has-run' });
    expect(again.trace).toEqual([]);
    const sameId = world();
    saveEntries(sameId);
    sameId.runs.set(RUN_ID, { ...(w.runs.get(RUN_ID) as LaneRunRecord), workOrderId: 'wo-other' });
    expect(await adopt(sameId)).toEqual({ outcome: 'refused', reason: 'lane-already-has-run' });
    const sameLane = world();
    saveEntries(sameLane);
    sameLane.orders.set('wo-old', { ...(w.orders.get('wo-co28') as WorkOrderRecord), id: 'wo-old', state: 'stopped', ownedPaths: ['x'] });
    sameLane.runs.set('run-01JB0000000000000000000008', { ...(w.runs.get(RUN_ID) as LaneRunRecord), runId: 'run-01JB0000000000000000000008', workOrderId: 'wo-old' });
    expect(await adopt(sameLane)).toEqual({ outcome: 'refused', reason: 'lane-already-has-run' });
  });

  it('owned-path-conflict with another active work order, before anything is recorded', async () => {
    const w = savedWorld();
    const other = (await (async () => { const x = savedWorld(); await adopt(x); return x.orders.get('wo-co28') as WorkOrderRecord; })());
    w.orders.set('wo-rival', { ...other, id: 'wo-rival', ownedPaths: ['packages/work-execution/src'], planRef: { projectId: 'fleet-v2', planId: 'p', laneId: 'rival' }, laneId: 'rival' });
    expect(await adopt(w)).toEqual({ outcome: 'refused', reason: 'owned-path-conflict' });
    expect(w.trace).toEqual([]);
  });

  it('work-order-conflict when the work order id exists with different immutable fields', async () => {
    const w = savedWorld();
    await adopt(w);
    const changed = world();
    saveEntries(changed);
    changed.orders.set('wo-co28', { ...(w.orders.get('wo-co28') as WorkOrderRecord), taskId: 'different' });
    expect(await adopt(changed)).toEqual({ outcome: 'refused', reason: 'work-order-conflict' });
  });

  it('attempt-conflict when another attempt exists for the work order', async () => {
    const w = savedWorld();
    await adopt(w);
    const other = world();
    saveEntries(other);
    other.attempts.set('attempt-foreign', { ...(w.attempts.get(ATTEMPT_ID) as AttemptRecord), id: 'attempt-foreign' });
    other.orders.set('wo-co28', w.orders.get('wo-co28') as WorkOrderRecord);
    expect(await adopt(other)).toEqual({ outcome: 'refused', reason: 'attempt-conflict' });
  });

  it('brief-digest-mismatch when the text does not hash to the expected digest, with nothing written', async () => {
    const w = savedWorld();
    const req = request();
    (req.brief as Record<string, unknown>).briefText = `${BRIEF_TEXT}\nedited`;
    expect(await adopt(w, req)).toEqual({ outcome: 'refused', reason: 'brief-digest-mismatch' });
    expect(w.trace).toEqual([]);
  });

  it('invalid-brief when the acceptance spec is not a valid gate', async () => {
    const w = savedWorld();
    const req = request();
    (req.brief as Record<string, unknown>).acceptanceSpec = { commitRequired: true, diffCheck: true, commands: [{ argv: ['bash', '-c', 'x'] }] };
    expect(await adopt(w, req)).toEqual({ outcome: 'refused', reason: 'invalid-brief' });
    expect(w.trace).toEqual([]);
  });

  it('idempotency-conflict when the recorded brief digest or commit is another adoption', async () => {
    const w = savedWorld();
    await adopt(w);
    const other = request({ source: { kind: 'save-ref', saveRef: SAVE_REF, commitOid: 'e'.repeat(40), treeDigest: TREE } });
    expect(await adopt(w, other)).toEqual({ outcome: 'refused', reason: 'idempotency-conflict' });
    const text = 'a different brief';
    const changed = request();
    changed.brief = { ...(changed.brief as Record<string, unknown>), briefText: text, expectedBriefDigest: sha(text) };
    expect(await adopt(w, changed)).toEqual({ outcome: 'refused', reason: 'idempotency-conflict' });
  });

  it('dispatches nothing and opens no fix round', async () => {
    const w = savedWorld();
    await adopt(w);
    expect(w.runs.get(RUN_ID)?.round).toBe(0);
    expect([...w.attempts.values()].every((a) => a.kind === 'initial' && a.fixNumber === 0)).toBe(true);
    expect(w.trace.some((line) => line.includes('dispatch'))).toBe(false);
  });
});

describe('AdoptLaneUseCase robustness', () => {
  it('returns invalid-request without throwing on null, non-object, missing or wrong-typed fields, sparse arrays, unknown enums, and throwing getters', async () => {
    const w = savedWorld();
    const sparse = ['packages/x'];
    sparse.length = 3;
    const throwing = request();
    Object.defineProperty(throwing, 'planDigest', { enumerable: true, get(): string { throw new Error('boom'); } });
    const bad = (path: string[], value: unknown): Record<string, unknown> => {
      const req = request();
      let target = req as Record<string, unknown>;
      for (const part of path.slice(0, -1)) target = target[part] as Record<string, unknown>;
      target[path[path.length - 1] as string] = value;
      return req;
    };
    const polluted = Object.create({ planDigest: PLAN, laneId: LANE }) as Record<string, unknown>;
    const inputs: unknown[] = [
      null, undefined, 7, 'x', true, [], () => 1, polluted, throwing,
      {}, { ...request(), planDigest: 'short' }, bad(['laneId'], 5), bad(['projectId'], ''),
      bad(['baseBranch'], 'develop'), bad(['baseBranch'], 'chain/Bad'), bad(['nowIso'], 'yesterday'), bad(['deadlineIso'], 'x'),
      bad(['planRef', 'projectId'], 'other'), bad(['planRef', 'laneId'], 'other'), bad(['planRef'], null),
      bad(['workOrder', 'ownedPaths'], sparse), bad(['workOrder', 'ownedPaths'], []), bad(['workOrder', 'ownedPaths'], 'x'),
      bad(['workOrder', 'prerequisiteWorkOrderIds'], sparse), bad(['workOrder', 'risk'], 'medium'), bad(['workOrder', 'baseCommit'], 'xyz'),
      bad(['run', 'tier'], 3), bad(['run', 'tier'], '1'), bad(['run', 'runId'], 'run-bad'), bad(['attempt', 'attemptId'], 'nope'),
      bad(['attempt', 'endedAtIso'], 'x'), bad(['brief'], null), bad(['brief', 'expectedBriefDigest'], 'abc'),
      bad(['source', 'kind'], 'worktree'), bad(['source'], null), bad(['source', 'commitOid'], 'abc'),
      bad(['source'], clean({ commitsSinceBase: sparse })), bad(['source'], clean({ dirtyCount: -1 })),
      bad(['source'], clean({ commitOnBranch: 'maybe' })),
    ];
    for (const input of inputs) {
      const result = await new AdoptLaneUseCase(w.deps).execute(input).catch(() => 'threw');
      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
    expect(w.trace).toEqual([]);
    const typed = await new AdoptLaneUseCase(w.deps).adoptLane(null as never);
    expect(typed).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('halts cleanly with budget-exhausted when the deadline expires mid-adoption and completes the remaining steps on the next pass', async () => {
    const w = savedWorld();
    const req = request({ deadlineIso: '2026-11-06T10:05:00.000Z' });
    // Time passes after the work-order and brief steps have run.
    let calls = 0;
    const base = w.deps.now as () => string;
    const deps: AdoptLaneDependencies = {
      ...w.deps,
      now: () => {
        calls += 1;
        // initial check, then one check per step: work-order (2), brief (3), attempt (4) expires.
        return calls >= 4 ? '2026-11-06T10:06:00.000Z' : base();
      },
    };
    const first = await new AdoptLaneUseCase(deps).execute(req);
    expect(first).toEqual({ outcome: 'budget-exhausted', completedSteps: ['work-order', 'brief'], nextStep: 'attempt' });
    expect(w.attempts.size).toBe(0);
    expect(w.runs.size).toBe(0);
    const second = await adopt(w, req);
    expect(second).toMatchObject({ outcome: 'adopted', reused: false });
    expect(w.trace.filter((line) => line === 'intent:adopt/work-order')).toHaveLength(1);
    expect(w.trace.filter((line) => line === 'write:work-order')).toHaveLength(1);
    // Exhausted before the first step.
    const none = savedWorld();
    expect(await adopt(none, request({ deadlineIso: '2026-11-06T09:59:00.000Z' }))).toEqual({
      outcome: 'budget-exhausted', completedSteps: [], nextStep: 'work-order',
    });
    expect(none.trace).toEqual([]);
  });

  it('is idempotent on repeat call under relaunch/<planDigest>/<lane>/adopt/<step> without duplicate writes or intents', async () => {
    const w = savedWorld();
    await adopt(w);
    const snapshot = [...w.trace];
    const entries = w.cutover.length;
    const runEntries = w.runEntries.length;
    const repeat = await adopt(w);
    expect(repeat).toMatchObject({ outcome: 'adopted', reused: true, enteredState: 'collecting', provenance: 'adopted' });
    expect(w.trace).toEqual(snapshot);
    expect(w.cutover).toHaveLength(entries);
    expect(w.runEntries).toHaveLength(runEntries);
    expect(w.cutover.filter((e) => e.kind === 'intent' && e.key.includes('/adopt/'))).toHaveLength(4);
  });

  it('re-ensures the collecting entry on a repeat when the run journal lost it', async () => {
    const w = savedWorld();
    await adopt(w);
    w.runEntries.length = 0;
    const repeat = await adopt(w);
    expect(repeat).toMatchObject({ outcome: 'adopted', reused: true });
    expect(laneRunJournalState(w.runEntries, RUN_ID)).toBe('collecting');
  });

  it('recovers from a crash between intent and result both before and after each repository write', async () => {
    for (const step of ['work-order', 'attempt', 'run']) {
      // Crash AFTER the repository write: the intent and the record exist, the result does not.
      const after = world({ crashAfterWrite: step });
      saveEntries(after);
      expect((await adopt(after)).outcome).toBe('unknown');
      const resumedAfter = await adopt(after);
      expect(resumedAfter).toMatchObject({ outcome: 'adopted', reused: false });
      expect(after.cutover.filter((e) => e.kind === 'intent' && e.key === KEY(step))).toHaveLength(1);
      expect(after.trace.filter((line) => line === `write:${step}`)).toHaveLength(1);
      expect(after.runs.size).toBe(1);
      expect(laneRunJournalState(after.runEntries, RUN_ID)).toBe('collecting');
    }
    // Crash BEFORE the repository write: the intent exists, the record does not.
    for (const failing of ['wo.save', 'attempt.save', 'run.create']) {
      const before = savedWorld();
      before.fail.add(failing);
      expect((await adopt(before)).outcome).toBe('unknown');
      before.fail.delete(failing);
      const resumed = await adopt(before);
      expect(resumed).toMatchObject({ outcome: 'adopted', reused: false });
      expect(before.cutover.filter((e) => e.kind === 'intent' && e.key.includes('/adopt/'))).toHaveLength(4);
    }
    // Crash between the run record and the collecting entry leaves no ready run behind after the next pass.
    const mid = savedWorld();
    mid.fail.add('runjournal.append');
    expect((await adopt(mid)).outcome).toBe('unknown');
    expect(mid.runs.get(RUN_ID)).toBeDefined();
    mid.fail.delete('runjournal.append');
    expect((await adopt(mid)).outcome).toBe('adopted');
    expect(laneRunJournalState(mid.runEntries, RUN_ID)).toBe('collecting');
  });

  it('reports unknown and writes nothing when any repository, journal read, or branch/dirty fact is unreadable or throws', async () => {
    const cases: [string, string][] = [
      ['cutover.list', 'cutover-journal-unreadable'],
      ['cutover.unreadable', 'cutover-journal-unreadable'],
      ['run.list', 'lane-run-store-unavailable'],
      ['wo.list', 'work-order-store-unavailable'],
    ];
    for (const [failing, reason] of cases) {
      const w = savedWorld();
      w.fail.add(failing);
      expect(await adopt(w)).toEqual({ outcome: 'unknown', reason });
      expect(w.trace).toEqual([]);
    }
    for (const [failing, reason] of [['wo.find', 'work-order-store-unavailable'], ['attempt.find', 'attempt-store-unavailable']] as const) {
      const w = savedWorld();
      w.fail.add(failing);
      const result = await adopt(w);
      expect(result).toEqual({ outcome: 'unknown', reason });
    }
    const journalDown = savedWorld();
    journalDown.fail.add('cutover.append');
    expect(await adopt(journalDown)).toEqual({ outcome: 'unknown', reason: 'journal-append-failed' });
    expect(journalDown.orders.size).toBe(0);
    const runJournalDown = savedWorld();
    await adopt(runJournalDown);
    runJournalDown.fail.add('runjournal.list');
    expect(await adopt(runJournalDown)).toEqual({ outcome: 'unknown', reason: 'run-journal-unavailable' });
    const dirty = world();
    expect(await adopt(dirty, request({ source: clean({ dirtyCount: 'unknown' }) }))).toEqual({ outcome: 'unknown', reason: 'dirty-state-unknown' });
    expect(await adopt(dirty, request({ source: clean({ commitOnBranch: 'unknown' }) }))).toEqual({ outcome: 'unknown', reason: 'branch-fact-unknown' });
    expect(dirty.trace).toEqual([]);
  });

  it('refuses secret-shaped input via SECRET_PATTERNS and echoes no secret or path in any outcome or journal entry', async () => {
    const secret = `token = "${'A'.repeat(24)}"`;
    const key = `ghp_${'a'.repeat(36)}`;
    const attempts: Record<string, unknown>[] = [];
    const withBrief = (briefText: string): Record<string, unknown> => {
      const req = request();
      req.brief = { ...(req.brief as Record<string, unknown>), briefText, expectedBriefDigest: sha(briefText) };
      return req;
    };
    attempts.push(withBrief(`do the work\n${secret}`));
    attempts.push(withBrief(`do the work ${key}`));
    const owned = request();
    (owned.workOrder as Record<string, unknown>).ownedPaths = [`packages/${key}`];
    attempts.push(owned);
    const task = request();
    (task.workOrder as Record<string, unknown>).repository = 'password: "hunter22hunter"';
    attempts.push(task);
    const runBranch = request();
    (runBranch.run as Record<string, unknown>).branchName = `fleet/${key}`;
    attempts.push(runBranch);
    const ref = request({ source: { kind: 'save-ref', saveRef: `refs/fleet/saved/${key}`, commitOid: COMMIT, treeDigest: TREE } });
    attempts.push(ref);
    for (const req of attempts) {
      const w = savedWorld();
      const result = await adopt(w, req);
      expect(result).toEqual({ outcome: 'refused', reason: 'secret-detected' });
      expect(JSON.stringify(result)).not.toContain(key);
      expect(w.trace).toEqual([]);
    }
    // A full adoption puts ids, digests and fixed codes in the journal and nothing else.
    const w = savedWorld();
    await adopt(w);
    const journalText = JSON.stringify(w.cutover.filter((e) => e.key.includes('/adopt/')));
    expect(journalText).not.toContain('Not done until');
    expect(journalText).not.toContain('.lane/brief');
    expect(journalText).not.toContain('packages/work-execution');
    // A thrown store error with path-shaped text is reported as a fixed token only.
    const thrown = savedWorld();
    thrown.fail.add('wo.save');
    const result = JSON.stringify(await adopt(thrown));
    expect(result).not.toContain('/home/');
    expect(result).not.toContain('boom');
  });

  it('performs adoption strictly through repositories and journals without git, network, or subprocess execution', async () => {
    const source = await import('node:fs').then((fs) =>
      ['AdoptLaneUseCase.use-case.ts']
        .map((name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'))
        .join('\n'));
    expect(source).not.toMatch(/child_process|node:net|node:http|node:https|fetch\(|spawn|execFile|\bexec\(/);
    expect(source).not.toMatch(/from '\.\.\/\.\.\/infrastructure/);
    // The dependency list is exactly the repositories, the journals, a digest, an id minter and a clock.
    const w = savedWorld();
    expect(Object.keys(w.deps).sort()).toEqual([
      'attemptRepo', 'computeDigest', 'cutoverJournal', 'mintEntryId', 'now', 'runJournal', 'runRepo', 'workOrderRepo',
    ]);
    expect((await adopt(w)).outcome).toBe('adopted');
  });

  it('refuses oversized brief text, identifier strings, and array fields exceeding size bounds', async () => {
    const w = savedWorld();
    const big = 'x'.repeat(262_145);
    const oversizedBrief = request();
    oversizedBrief.brief = { ...(oversizedBrief.brief as Record<string, unknown>), briefText: big, expectedBriefDigest: sha(big) };
    const longId = request({ laneId: 'l'.repeat(129) });
    const manyPaths = request();
    (manyPaths.workOrder as Record<string, unknown>).ownedPaths = Array.from({ length: 257 }, (_v, i) => `packages/p${i}`);
    const manyPrereqs = request();
    (manyPrereqs.workOrder as Record<string, unknown>).prerequisiteWorkOrderIds = Array.from({ length: 65 }, (_v, i) => `wo-${i}`);
    const longRef = request({ source: { kind: 'save-ref', saveRef: `refs/fleet/saved/${'r'.repeat(300)}`, commitOid: COMMIT, treeDigest: TREE } });
    const manyCommits = request({ source: clean({ commitsSinceBase: Array.from({ length: 513 }, () => COMMIT) }) });
    for (const req of [oversizedBrief, longId, manyPaths, manyPrereqs, longRef, manyCommits]) {
      expect(await adopt(w, req)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
    expect(w.trace).toEqual([]);
    const ok = await adopt(w);
    expect(ok.outcome).toBe('adopted');
    expect(Object.keys(ok).length).toBeLessThanOrEqual(9);
  });
});
