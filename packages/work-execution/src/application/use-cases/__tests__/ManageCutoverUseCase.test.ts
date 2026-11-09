// Lane CO30a: CutoverRecordRepositoryAdapter and ManageCutoverUseCase (`cutover status` and `cutover rollback`).
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { CutoverJournalAdapter } from '../../../infrastructure/adapters/CutoverJournalAdapter.adapter.js';
import {
  CUTOVER_RECORD_MAX_BYTES,
  CutoverRecordRepositoryAdapter,
} from '../../../infrastructure/adapters/CutoverRecordRepositoryAdapter.adapter.js';
import { DaemonPauseAdapter } from '../../../infrastructure/adapters/DaemonPauseAdapter.adapter.js';
import { KillallTrainPauseAdapter } from '../../../infrastructure/adapters/KillallTrainPauseAdapter.adapter.js';
import { WORK_EXECUTION_STATE_FILES } from '../../../infrastructure/adapters/state-files.js';
import { sha256HexDigest } from '../../../infrastructure/adapters/AttemptArtifactAdapter.adapter.js';
import type { CutoverRecord } from '../../../domain/cutover-records.js';
import { ManageCutoverUseCase, type ManageCutoverDependencies } from '../ManageCutoverUseCase.use-case.js';

const SWITCHED_AT = '2026-11-03T12:00:00.000Z';
const NOW = '2026-11-05T12:00:00.000Z';
const LATER = '2026-11-05T13:00:00.000Z';
const EARLIER_DEADLINE = '2026-11-05T11:00:00.000Z';
const FUTURE_DEADLINE = '2026-11-05T18:00:00.000Z';
const PLAN_DIGEST = 'b'.repeat(64);

// Built at runtime so no literal token shape appears in source.
const LEGACY_ONLY_SECRET = 'xox' + 's-' + '1234567890';
const LANE_ONLY_SECRET = 'github' + '_pat_' + 'y'.repeat(28);
const GITHUB_SECRET = 'gh' + 'p_' + 'x'.repeat(28);

function switchedRecord(revision = 1, trainPauseSetByCutover = true): CutoverRecord {
  return {
    schemaVersion: 1,
    revision,
    state: 'switched',
    updatedAtIso: SWITCHED_AT,
    switchedAtIso: SWITCHED_AT,
    rolledBackAtIso: null,
    retiredAtIso: null,
    relaunchPlanDigest: PLAN_DIGEST,
    trainPauseSetByCutover,
  };
}

function ulid(sequence: number): string {
  return `0${String(sequence).padStart(25, '0')}`;
}

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'fleet-cutover-test-'));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('CutoverRecordRepositoryAdapter', () => {
  it.each(['memory', 'disk'] as const)('reads missing and walks compare-and-set 0 -> 1 -> 2 (%s)', async (mode) => {
    const repo = new CutoverRecordRepositoryAdapter({ stateDir: mode === 'disk' ? tempDir : undefined });
    expect(await repo.read()).toEqual({ status: 'missing' });

    const first = switchedRecord(1);
    expect(await repo.compareAndSet({ expectedRevision: 0, next: first })).toEqual({ outcome: 'saved', record: first });
    expect(await repo.read()).toEqual({ status: 'ok', record: first });

    const second: CutoverRecord = {
      ...first,
      revision: 2,
      state: 'rolled-back',
      rolledBackAtIso: NOW,
      updatedAtIso: NOW,
      trainPauseSetByCutover: false,
    };
    expect(await repo.compareAndSet({ expectedRevision: 1, next: second })).toEqual({ outcome: 'saved', record: second });
    expect(await repo.read()).toEqual({ status: 'ok', record: second });
    if (mode === 'disk') {
      const stored = JSON.parse(readFileSync(join(tempDir, 'cutover.json'), 'utf8')) as Record<string, unknown>;
      expect(stored.schemaVersion).toBe(1);
      expect(stored.revision).toBe(2);
    }
  });

  it.each(['memory', 'disk'] as const)('answers a conflict with the current revision (%s)', async (mode) => {
    const repo = new CutoverRecordRepositoryAdapter({ stateDir: mode === 'disk' ? tempDir : undefined });
    expect(await repo.compareAndSet({ expectedRevision: 3, next: switchedRecord(4) })).toEqual({
      outcome: 'conflict',
      currentRevision: null,
    });
    await repo.compareAndSet({ expectedRevision: 0, next: switchedRecord(1) });
    expect(await repo.compareAndSet({ expectedRevision: 0, next: switchedRecord(1) })).toEqual({
      outcome: 'conflict',
      currentRevision: 1,
    });
    expect(await repo.compareAndSet({ expectedRevision: 5, next: switchedRecord(6) })).toEqual({
      outcome: 'conflict',
      currentRevision: 1,
    });
  });

  it('refuses a next record whose revision is not expectedRevision + 1 or that is invalid', async () => {
    const repo = new CutoverRecordRepositoryAdapter({ stateDir: tempDir });
    expect(await repo.compareAndSet({ expectedRevision: 0, next: switchedRecord(2) })).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(
      await repo.compareAndSet({ expectedRevision: 0, next: { ...switchedRecord(1), state: 'bogus' } as unknown as CutoverRecord }),
    ).toEqual({ outcome: 'refused', reason: 'invalid-record' });
    expect(existsSync(join(tempDir, 'cutover.json'))).toBe(false);
  });

  it('reports unknown-version and corrupt JSON and never overwrites or quarantines them', async () => {
    const target = join(tempDir, 'cutover.json');
    const repo = new CutoverRecordRepositoryAdapter({ stateDir: tempDir });

    const newer = JSON.stringify({ ...switchedRecord(1), schemaVersion: 99 });
    writeFileSync(target, newer);
    expect(await repo.read()).toEqual({ status: 'unknown-version' });
    expect(await repo.compareAndSet({ expectedRevision: 1, next: switchedRecord(2) })).toEqual({
      outcome: 'refused',
      reason: 'unknown-version',
    });
    expect(readFileSync(target, 'utf8')).toBe(newer);

    for (const bytes of ['{ not json', '[]', JSON.stringify({ ...switchedRecord(1), extra: true })]) {
      writeFileSync(target, bytes);
      expect(await repo.read()).toEqual({ status: 'unreadable' });
      expect(await repo.compareAndSet({ expectedRevision: 0, next: switchedRecord(1) })).toEqual({
        outcome: 'refused',
        reason: 'unreadable',
      });
      expect(readFileSync(target, 'utf8')).toBe(bytes);
    }
    expect(readdirSync(tempDir).filter((name) => name !== 'cutover.json' && !name.endsWith('.lock'))).toEqual([]);
  });

  it('refuses a symlinked cutover.json as unreadable, never as missing', async () => {
    const real = join(tempDir, 'elsewhere.json');
    writeFileSync(real, JSON.stringify(switchedRecord(1)));
    symlinkSync(real, join(tempDir, 'cutover.json'));
    const repo = new CutoverRecordRepositoryAdapter({ stateDir: tempDir });
    expect(await repo.read()).toEqual({ status: 'unreadable' });
    expect(await repo.compareAndSet({ expectedRevision: 1, next: switchedRecord(2) })).toEqual({
      outcome: 'refused',
      reason: 'unreadable',
    });
  });

  it('refuses every write when opened read-only and still reads', async () => {
    const writable = new CutoverRecordRepositoryAdapter({ stateDir: tempDir });
    await writable.compareAndSet({ expectedRevision: 0, next: switchedRecord(1) });
    const before = readFileSync(join(tempDir, 'cutover.json'), 'utf8');
    const readOnly = new CutoverRecordRepositoryAdapter({ stateDir: tempDir, readOnly: true });
    expect(await readOnly.read()).toEqual({ status: 'ok', record: switchedRecord(1) });
    expect(await readOnly.compareAndSet({ expectedRevision: 1, next: switchedRecord(2) })).toEqual({
      outcome: 'refused',
      reason: 'read-only',
    });
    expect(readFileSync(join(tempDir, 'cutover.json'), 'utf8')).toBe(before);
  });

  it('refuses a file name that is unsafe or collides with another store', () => {
    for (const fileName of ['killall-train-pause.json', 'cutover-journal.json', 'merge-queue.json', '../x.json', 'a/b.json', '']) {
      expect(() => new CutoverRecordRepositoryAdapter({ stateDir: tempDir, fileName })).toThrow();
    }
    expect(() => new CutoverRecordRepositoryAdapter({ stateDir: tempDir, fileName: 'cutover-alt.json' })).not.toThrow();
  });

  it('is described to `fleet-v2 state` as the single-record store cutover.json', async () => {
    const descriptor = WORK_EXECUTION_STATE_FILES.find((entry) => entry.basename === 'cutover.json');
    expect(descriptor).toBeDefined();
    expect(descriptor?.inspect(Buffer.from(JSON.stringify(switchedRecord(1))))).toEqual({ status: 'ok', recordCount: 1 });
    expect(descriptor?.inspect(Buffer.from(JSON.stringify({ ...switchedRecord(1), schemaVersion: 2 }))).status).toBe(
      'unknown-version',
    );
    expect(descriptor?.inspect(Buffer.from('{ nope')).status).toBe('unreadable');
    expect(descriptor?.inspect(Buffer.from('[]')).status).toBe('unreadable');
    const repo = new CutoverRecordRepositoryAdapter({ stateDir: tempDir });
    await repo.compareAndSet({ expectedRevision: 0, next: switchedRecord(1) });
    expect((await descriptor?.check(tempDir))?.result).toMatchObject({ status: 'ok', recordCount: 1 });
  });
});

interface Harness {
  readonly repo: CutoverRecordRepositoryAdapter;
  readonly journal: CutoverJournalAdapter;
  readonly daemonPause: DaemonPauseAdapter;
  readonly trainPause: KillallTrainPauseAdapter;
  readonly clock: { now: string };
  readonly deps: ManageCutoverDependencies;
  readonly useCase: ManageCutoverUseCase;
  readonly spies: {
    readonly daemonPauseWrite: MockInstance<DaemonPauseAdapter['write']>;
    readonly trainPauseSet: MockInstance<KillallTrainPauseAdapter['set']>;
    readonly compareAndSet: MockInstance<CutoverRecordRepositoryAdapter['compareAndSet']>;
    readonly journalAppend: MockInstance<CutoverJournalAdapter['append']>;
    readonly repoRead: MockInstance<CutoverRecordRepositoryAdapter['read']>;
    readonly journalList: MockInstance<CutoverJournalAdapter['listByKeyPrefix']>;
  };
}

interface HarnessOptions {
  readonly stateDir?: string;
  readonly seed?: CutoverRecord | null;
  readonly daemonStatus?: ManageCutoverDependencies['daemonStatus'];
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const { stateDir } = options;
  const clock = { now: NOW };
  const repo = new CutoverRecordRepositoryAdapter({ stateDir, nowIso: () => clock.now });
  const journal = new CutoverJournalAdapter({ stateDir });
  const daemonPause = new DaemonPauseAdapter({ stateDir });
  const trainPause = new KillallTrainPauseAdapter({ stateDir });
  const seed = options.seed === undefined ? switchedRecord(1) : options.seed;
  if (seed !== null) {
    await repo.compareAndSet({ expectedRevision: seed.revision - 1, next: seed });
    if (seed.trainPauseSetByCutover) {
      await trainPause.set({ paused: true, nowIso: SWITCHED_AT });
    }
  }
  let sequence = 0;
  const deps: ManageCutoverDependencies = {
    cutoverRepo: repo,
    cutoverJournal: journal,
    daemonStatus: options.daemonStatus ?? { read: async () => ({ status: 'missing' }) },
    daemonPauseRead: stateDir === undefined ? daemonPause : new DaemonPauseAdapter({ stateDir, readOnly: true }),
    daemonPause,
    trainPauseRead: stateDir === undefined ? trainPause : new KillallTrainPauseAdapter({ stateDir, readOnly: true }),
    trainPause,
    computeDigest: sha256HexDigest,
    mintEntryId: () => ulid((sequence += 1)),
    nowIso: () => clock.now,
  };
  const spies = {
    daemonPauseWrite: vi.spyOn(daemonPause, 'write'),
    trainPauseSet: vi.spyOn(trainPause, 'set'),
    compareAndSet: vi.spyOn(repo, 'compareAndSet'),
    journalAppend: vi.spyOn(journal, 'append'),
    repoRead: vi.spyOn(repo, 'read'),
    journalList: vi.spyOn(journal, 'listByKeyPrefix'),
  };
  return { repo, journal, daemonPause, trainPause, clock, deps, useCase: new ManageCutoverUseCase(deps), spies };
}

function resetSpies(h: Harness): void {
  for (const spy of Object.values(h.spies)) spy.mockClear();
}

function totalWriteCalls(h: Harness): number {
  const { daemonPauseWrite, trainPauseSet, compareAndSet, journalAppend } = h.spies;
  return daemonPauseWrite.mock.calls.length + trainPauseSet.mock.calls.length + compareAndSet.mock.calls.length + journalAppend.mock.calls.length;
}

function rollbackRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { move: 'rollback', expectedRevision: 1, operationId: 'op-1', nowIso: NOW, ...overrides };
}

async function journalEntries(h: Harness, key: string): Promise<readonly { kind: string; outcome?: string }[]> {
  const listed = await h.journal.listByKeyPrefix(key);
  return listed.outcome === 'listed' ? listed.entries.filter((entry) => entry.key === key) : [];
}

describe('ManageCutoverUseCase status', () => {
  it('reports shadow at revision 0 when no cutover record exists, and writes nothing', async () => {
    const h = await harness({ seed: null });
    expect(await h.useCase.execute({ move: 'status' })).toEqual({
      outcome: 'completed',
      move: 'status',
      state: 'shadow',
      revision: 0,
      record: null,
      daemonStatus: 'missing',
      daemonLastTickOutcome: null,
      daemonPause: 'clear',
      trainPause: 'clear',
      withinRollbackWindow: null,
    });
    expect(totalWriteCalls(h)).toBe(0);
  });

  it('reports the stored record, the pauses, the last tick and the rollback window', async () => {
    const h = await harness({
      daemonStatus: {
        read: async () => ({
          status: 'ok',
          record: { exitCode: 1 } as never,
        }),
      },
    });
    await h.daemonPause.write(true, NOW);
    const result = await h.useCase.execute({ move: 'status', nowIso: NOW });
    expect(result).toMatchObject({
      outcome: 'completed',
      state: 'switched',
      revision: 1,
      daemonStatus: 'present',
      daemonLastTickOutcome: 'failed',
      daemonPause: 'paused',
      trainPause: 'paused',
      withinRollbackWindow: true,
    });
    const outside = await h.useCase.execute({ move: 'status', nowIso: '2026-12-01T00:00:00.000Z' });
    expect(outside).toMatchObject({ withinRollbackWindow: false });
    const beforeSwitch = await h.useCase.execute({ move: 'status', nowIso: '2026-11-01T00:00:00.000Z' });
    expect(beforeSwitch).toMatchObject({ withinRollbackWindow: null });
  });
});

describe('ManageCutoverUseCase rollback', () => {
  it.each([true, false])('pauses the daemon, lifts the train pause only when the cutover set it (set=%s)', async (setByCutover) => {
    const h = await harness({ seed: switchedRecord(1, setByCutover) });
    if (!setByCutover) {
      await h.trainPause.set({ paused: true, nowIso: SWITCHED_AT });
    }
    resetSpies(h);
    const result = await h.useCase.execute(rollbackRequest());
    expect(result).toMatchObject({
      outcome: 'completed',
      move: 'rollback',
      key: 'cutover/rollback@1',
      replayed: false,
      state: 'rolled-back',
      revision: 2,
    });
    expect((await h.daemonPause.read()).state).toBe('paused');
    expect((await h.trainPause.read()).status).toBe(setByCutover ? 'clear' : 'paused');
    expect(h.spies.trainPauseSet).toHaveBeenCalledTimes(setByCutover ? 1 : 0);
    expect(await h.repo.read()).toMatchObject({
      status: 'ok',
      record: { state: 'rolled-back', revision: 2, trainPauseSetByCutover: false, rolledBackAtIso: NOW, switchedAtIso: SWITCHED_AT },
    });
    expect(await journalEntries(h, 'cutover/rollback@1')).toEqual([
      expect.objectContaining({ kind: 'intent' }),
      expect.objectContaining({ kind: 'result', outcome: 'completed' }),
    ]);
  });

  it('refuses before recording an intent when there is nothing to roll back', async () => {
    const missing = await harness({ seed: null });
    expect(await missing.useCase.execute(rollbackRequest())).toEqual({ outcome: 'refused', reason: 'not-switched' });
    expect(totalWriteCalls(missing)).toBe(0);

    const wrongRevision = await harness();
    expect(await wrongRevision.useCase.execute(rollbackRequest({ expectedRevision: 2 }))).toEqual({
      outcome: 'refused',
      reason: 'revision-conflict',
    });
    expect(totalWriteCalls(wrongRevision)).toBe(0);

    const shadow = await harness({
      seed: {
        ...switchedRecord(1),
        state: 'shadow',
        switchedAtIso: null,
        relaunchPlanDigest: null,
        trainPauseSetByCutover: false,
      },
    });
    expect(await shadow.useCase.execute(rollbackRequest())).toEqual({ outcome: 'refused', reason: 'not-switched' });

    const early = await harness();
    expect(await early.useCase.execute(rollbackRequest({ nowIso: '2026-11-01T00:00:00.000Z' }))).toEqual({
      outcome: 'refused',
      reason: 'invalid-clock',
    });
    expect(totalWriteCalls(early)).toBe(0);
  });

  it('refuses switch and retire as not implemented, with no port call', async () => {
    const h = await harness();
    resetSpies(h);
    for (const move of ['switch', 'retire']) {
      expect(await h.useCase.execute({ move })).toEqual({ outcome: 'refused', reason: 'move-not-implemented' });
    }
    expect(h.spies.repoRead).not.toHaveBeenCalled();
    expect(totalWriteCalls(h)).toBe(0);
  });

  it('refuses a replay whose recorded outcome was a refusal', async () => {
    const h = await harness();
    const digest = sha256HexDigest('{"move":"rollback","expectedRevision":1,"operationId":"op-1"}');
    await h.journal.append({ key: 'cutover/rollback@1', kind: 'intent', entryId: ulid(900), recordedAtIso: NOW, digest });
    await h.journal.append({
      key: 'cutover/rollback@1',
      kind: 'result',
      entryId: ulid(901),
      recordedAtIso: NOW,
      outcome: 'refused',
      reasonCode: 'refused',
      digest,
    });
    expect(await h.useCase.execute(rollbackRequest())).toEqual({ outcome: 'refused', reason: 'journal-refused' });
  });

  it('refuses a replay of a completed rollback once the record is no longer rolled back', async () => {
    const h = await harness();
    await h.useCase.execute(rollbackRequest());
    await h.repo.compareAndSet({
      expectedRevision: 2,
      next: { ...switchedRecord(3) },
    });
    expect(await h.useCase.execute(rollbackRequest())).toEqual({ outcome: 'refused', reason: 'revision-conflict' });
  });
});

describe('ManageCutoverUseCase robustness bar', () => {
  it('refuses null, primitives, arrays, sparse arrays, unknown moves, missing/wrong-typed fields, and throwing getters without throwing', async () => {
    const h = await harness();
    const throwing: Record<string, unknown> = { move: 'status' };
    Object.defineProperty(throwing, 'nowIso', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const throwingMove: Record<string, unknown> = {};
    Object.defineProperty(throwingMove, 'move', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const inputs: unknown[] = [
      null,
      undefined,
      'str',
      42,
      [],
      new Array(2),
      {},
      { move: 'unknown' },
      { move: 'switch' },
      { move: 'status', extra: 1 },
      { move: 'status', nowIso: 'tomorrow' },
      { move: 'status', nowIso: 5 },
      rollbackRequest({ operationId: undefined }),
      rollbackRequest({ operationId: '' }),
      rollbackRequest({ operationId: 'bad id!' }),
      rollbackRequest({ expectedRevision: -1 }),
      rollbackRequest({ expectedRevision: 0 }),
      rollbackRequest({ expectedRevision: 1.5 }),
      rollbackRequest({ expectedRevision: '1' }),
      rollbackRequest({ nowIso: undefined }),
      rollbackRequest({ extra: true }),
      throwing,
      throwingMove,
    ];
    resetSpies(h);
    for (const input of inputs) {
      const result = await h.useCase.execute(input);
      expect(result.outcome).toBe('refused');
    }
    expect(h.spies.repoRead).not.toHaveBeenCalled();
    expect(totalWriteCalls(h)).toBe(0);

    const adapter = new CutoverRecordRepositoryAdapter({ stateDir: tempDir });
    const casInputs: unknown[] = [
      null,
      undefined,
      'str',
      [],
      new Array(2),
      {},
      { move: 'unknown' },
      { expectedRevision: -1, next: switchedRecord(1) },
      { expectedRevision: 0.5, next: switchedRecord(1) },
      { expectedRevision: 0 },
      { expectedRevision: 0, next: switchedRecord(1), extra: true },
      { expectedRevision: 0, next: switchedRecord(1), deadlineIso: 'soon' },
      throwing,
      { expectedRevision: 0, next: throwing },
    ];
    const throwingExpected: Record<string, unknown> = { next: switchedRecord(1) };
    Object.defineProperty(throwingExpected, 'expectedRevision', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    casInputs.push(throwingExpected);
    for (const input of casInputs) {
      const result = await adapter.compareAndSet(input as never);
      expect(result.outcome).toBe('refused');
    }
    expect(existsSync(join(tempDir, 'cutover.json'))).toBe(false);
  });

  it('stops before outbound calls once deadlineIso is reached and leaves partial rollback recoverable on the next pass', async () => {
    // Before any read.
    const early = await harness();
    resetSpies(early);
    expect(await early.useCase.execute(rollbackRequest({ deadlineIso: EARLIER_DEADLINE }))).toEqual({
      outcome: 'unknown',
      reason: 'deadline-exceeded',
    });
    expect(await early.useCase.execute({ move: 'status', deadlineIso: EARLIER_DEADLINE })).toEqual({
      outcome: 'unknown',
      reason: 'deadline-exceeded',
    });
    expect(early.spies.repoRead).not.toHaveBeenCalled();
    expect(early.spies.journalList).not.toHaveBeenCalled();
    expect(totalWriteCalls(early)).toBe(0);

    // After the intent, before daemonPause.write.
    const afterIntent = await harness();
    const appendOriginal = afterIntent.journal.append.bind(afterIntent.journal);
    afterIntent.spies.journalAppend.mockImplementationOnce(async (entry) => {
      const appended = await appendOriginal(entry);
      afterIntent.clock.now = LATER;
      return appended;
    });
    afterIntent.spies.daemonPauseWrite.mockClear();
    const cut = await afterIntent.useCase.execute(rollbackRequest({ deadlineIso: '2026-11-05T12:30:00.000Z' }));
    expect(cut).toEqual({ outcome: 'unknown', reason: 'deadline-exceeded' });
    expect(afterIntent.spies.daemonPauseWrite).not.toHaveBeenCalled();
    expect(await journalEntries(afterIntent, 'cutover/rollback@1')).toHaveLength(1);
    afterIntent.clock.now = NOW;
    expect(await afterIntent.useCase.execute(rollbackRequest({ deadlineIso: FUTURE_DEADLINE }))).toMatchObject({
      outcome: 'completed',
      replayed: false,
      revision: 2,
    });
    expect(await journalEntries(afterIntent, 'cutover/rollback@1')).toHaveLength(2);

    // Between daemonPause.write and compareAndSet.
    const mid = await harness();
    const writeOriginal = mid.daemonPause.write.bind(mid.daemonPause);
    mid.spies.daemonPauseWrite.mockImplementationOnce(async (paused, changedAtIso) => {
      const written = await writeOriginal(paused, changedAtIso);
      mid.clock.now = LATER;
      return written;
    });
    const half = await mid.useCase.execute(rollbackRequest({ deadlineIso: '2026-11-05T12:30:00.000Z' }));
    expect(half).toEqual({ outcome: 'unknown', reason: 'deadline-exceeded' });
    expect((await mid.daemonPause.read()).state).toBe('paused');
    expect(mid.spies.compareAndSet).not.toHaveBeenCalled();
    expect(await mid.repo.read()).toMatchObject({ status: 'ok', record: { state: 'switched', revision: 1 } });
    mid.clock.now = NOW;
    expect(await mid.useCase.execute(rollbackRequest({ deadlineIso: FUTURE_DEADLINE }))).toMatchObject({
      outcome: 'completed',
      state: 'rolled-back',
      revision: 2,
    });
    expect((await mid.trainPause.read()).status).toBe('clear');
    expect(await journalEntries(mid, 'cutover/rollback@1')).toHaveLength(2);
  });

  it('records cutover/rollback@<revision> once, recovers a crash after intent or after CAS, and replays without repeating writes', async () => {
    // (a) crash after the intent, before the compare-and-set completes.
    const a = await harness();
    a.spies.daemonPauseWrite.mockRejectedValueOnce(new Error('disk gone'));
    expect(await a.useCase.execute(rollbackRequest())).toEqual({ outcome: 'unknown', reason: 'daemon-pause-write-failed' });
    expect(await journalEntries(a, 'cutover/rollback@1')).toHaveLength(1);
    expect(await a.useCase.execute(rollbackRequest())).toMatchObject({ outcome: 'completed', replayed: false, revision: 2 });
    expect(await journalEntries(a, 'cutover/rollback@1')).toHaveLength(2);

    // (b) crash after the compare-and-set, before the result is journaled.
    const b = await harness();
    const appendOriginal = (entry: Parameters<CutoverJournalAdapter['append']>[0]): ReturnType<CutoverJournalAdapter['append']> =>
      CutoverJournalAdapter.prototype.append.call(b.journal, entry);
    b.spies.journalAppend.mockImplementation(async (entry) =>
      entry.kind === 'result' ? { outcome: 'refused', reason: 'store-unreadable' } : appendOriginal(entry),
    );
    expect(await b.useCase.execute(rollbackRequest())).toEqual({ outcome: 'unknown', reason: 'journal-append-failed' });
    expect(await b.repo.read()).toMatchObject({ status: 'ok', record: { state: 'rolled-back', revision: 2 } });
    b.spies.journalAppend.mockImplementation(async (entry) => appendOriginal(entry));
    resetSpies(b);
    expect(await b.useCase.execute(rollbackRequest())).toMatchObject({ outcome: 'completed', replayed: false, revision: 2 });
    expect(b.spies.trainPauseSet).not.toHaveBeenCalled();
    expect(b.spies.compareAndSet).not.toHaveBeenCalled();
    expect(await journalEntries(b, 'cutover/rollback@1')).toEqual([
      expect.objectContaining({ kind: 'intent' }),
      expect.objectContaining({ kind: 'result', outcome: 'completed' }),
    ]);

    // (c) a completed rollback repeated: recorded outcome, zero writes.
    resetSpies(b);
    expect(await b.useCase.execute(rollbackRequest())).toMatchObject({ outcome: 'completed', replayed: true, revision: 2 });
    expect(b.spies.daemonPauseWrite).not.toHaveBeenCalled();
    expect(b.spies.trainPauseSet).not.toHaveBeenCalled();
    expect(b.spies.compareAndSet).not.toHaveBeenCalled();
    expect(b.spies.journalAppend).not.toHaveBeenCalled();

    // (d) cutover/rollback@10 never collides with cutover/rollback@1.
    const d = await harness();
    const otherDigest = sha256HexDigest('{"move":"rollback","expectedRevision":10,"operationId":"other"}');
    await d.journal.append({ key: 'cutover/rollback@10', kind: 'intent', entryId: ulid(800), recordedAtIso: NOW, digest: otherDigest });
    await d.journal.append({
      key: 'cutover/rollback@10',
      kind: 'result',
      entryId: ulid(801),
      recordedAtIso: NOW,
      outcome: 'completed',
      reasonCode: 'rolled-back',
      digest: otherDigest,
    });
    expect(await d.useCase.execute(rollbackRequest())).toMatchObject({ outcome: 'completed', replayed: false, revision: 2 });
    expect(await journalEntries(d, 'cutover/rollback@1')).toHaveLength(2);
    expect(await journalEntries(d, 'cutover/rollback@10')).toHaveLength(2);
  });

  it('reports unreadable or unknown-version cutover, daemon-status, daemon-pause, train-pause, and journal stores as unknown, never as shadow, clear, or completed', async () => {
    const boom = (): never => {
      throw new Error('boom');
    };
    const statusCases: Array<[string, (h: Harness) => void, string]> = [
      ['cutover unknown-version', (h) => h.spies.repoRead.mockResolvedValue({ status: 'unknown-version' }), 'cutover-record-unknown-version'],
      ['cutover unreadable', (h) => h.spies.repoRead.mockResolvedValue({ status: 'unreadable' }), 'cutover-record-unreadable'],
      ['cutover throws', (h) => h.spies.repoRead.mockImplementation(boom), 'cutover-record-unreadable'],
      ['daemon status unreadable', (h) => ((h.deps as { daemonStatus: unknown }).daemonStatus = { read: async () => ({ status: 'unreadable' }) }), 'daemon-status-unreadable'],
      ['daemon status throws', (h) => ((h.deps as { daemonStatus: unknown }).daemonStatus = { read: boom }), 'daemon-status-unreadable'],
      ['daemon pause unreadable', (h) => ((h.deps as { daemonPauseRead: unknown }).daemonPauseRead = { read: async () => ({ state: 'unreadable' }) }), 'daemon-pause-unreadable'],
      ['daemon pause throws', (h) => ((h.deps as { daemonPauseRead: unknown }).daemonPauseRead = { read: boom }), 'daemon-pause-unreadable'],
      ['train pause unreadable', (h) => ((h.deps as { trainPauseRead: unknown }).trainPauseRead = { read: async () => ({ status: 'unreadable' }) }), 'train-pause-unreadable'],
      ['train pause throws', (h) => ((h.deps as { trainPauseRead: unknown }).trainPauseRead = { read: boom }), 'train-pause-unreadable'],
    ];
    for (const [label, arrange, reason] of statusCases) {
      const h = await harness();
      arrange(h);
      const useCase = new ManageCutoverUseCase(h.deps);
      expect({ label, result: await useCase.execute({ move: 'status' }) }).toEqual({ label, result: { outcome: 'unknown', reason } });
    }
    for (const [label, arrange, reason] of statusCases.filter(([label]) => !label.startsWith('daemon status'))) {
      const h = await harness();
      arrange(h);
      resetSpies(h);
      const useCase = new ManageCutoverUseCase(h.deps);
      const result = await useCase.execute(rollbackRequest());
      expect({ label, result }).toEqual({ label, result: { outcome: 'unknown', reason } });
      expect(h.spies.daemonPauseWrite).not.toHaveBeenCalled();
      expect(h.spies.trainPauseSet).not.toHaveBeenCalled();
      expect(h.spies.compareAndSet).not.toHaveBeenCalled();
    }
    for (const arrange of [
      (h: Harness) => h.spies.journalList.mockResolvedValue({ outcome: 'unreadable' }),
      (h: Harness) => h.spies.journalList.mockImplementation(boom),
    ]) {
      const h = await harness();
      arrange(h);
      resetSpies(h);
      expect(await h.useCase.execute(rollbackRequest())).toEqual({ outcome: 'unknown', reason: 'journal-unreadable' });
      expect(totalWriteCalls(h)).toBe(0);
    }

    // On disk: corrupt bytes and schemaVersion 99 are reported, and a status never quarantines the pause files.
    const dir = join(tempDir, 'state');
    mkdirSync(join(dir, 'daemon'), { recursive: true });
    const pausePath = join(dir, 'daemon', 'paused.json');
    const trainPath = join(dir, 'killall-train-pause.json');
    const h = await harness({ stateDir: dir });
    writeFileSync(pausePath, '{ not json');
    expect(await h.useCase.execute({ move: 'status' })).toEqual({ outcome: 'unknown', reason: 'daemon-pause-unreadable' });
    expect(readFileSync(pausePath, 'utf8')).toBe('{ not json');
    rmSync(pausePath);
    writeFileSync(trainPath, '{"schemaVersion":99}');
    expect(await h.useCase.execute({ move: 'status' })).toEqual({ outcome: 'unknown', reason: 'train-pause-unreadable' });
    expect(readFileSync(trainPath, 'utf8')).toBe('{"schemaVersion":99}');
    expect(existsSync(join(dir, 'quarantine'))).toBe(false);
    expect(existsSync(join(dir, 'daemon', 'quarantine'))).toBe(false);
    writeFileSync(join(dir, 'cutover.json'), JSON.stringify({ ...switchedRecord(1), schemaVersion: 99 }));
    expect(await h.useCase.execute({ move: 'status' })).toEqual({ outcome: 'unknown', reason: 'cutover-record-unknown-version' });
  });

  it('refuses secret-shaped inputs from both secret registries and never echoes paths or raw input values in results', async () => {
    const dir = join(tempDir, 'state-secret');
    const h = await harness({ stateDir: dir });
    resetSpies(h);
    for (const secret of [LEGACY_ONLY_SECRET, LANE_ONLY_SECRET, GITHUB_SECRET]) {
      for (const input of [
        rollbackRequest({ operationId: secret }),
        rollbackRequest({ nowIso: secret }),
        { move: 'status', nowIso: secret },
        { move: 'status', deadlineIso: secret },
        { move: 'status', extra: secret },
        { move: secret },
      ]) {
        const result = await h.useCase.execute(input);
        expect(result).toEqual({ outcome: 'refused', reason: 'secret-shaped' });
        expect(JSON.stringify(result)).not.toContain(secret);
      }
    }
    expect(h.spies.repoRead).not.toHaveBeenCalled();
    expect(totalWriteCalls(h)).toBe(0);

    const sentinel = 'sentinel-operation-id';
    const outputs = [
      await h.useCase.execute({ move: 'status' }),
      await h.useCase.execute(rollbackRequest({ operationId: sentinel })),
      await h.useCase.execute(rollbackRequest({ operationId: sentinel })),
      await h.useCase.execute(rollbackRequest({ operationId: 'another-sentinel' })),
      await h.useCase.execute({ move: 'status' }),
    ];
    const text = JSON.stringify(outputs);
    expect(text).not.toContain(dir);
    expect(text).not.toContain(tempDir);
    expect(text).not.toContain(sentinel);
    expect(text).not.toContain('another-sentinel');
  });

  it('refuses oversized request fields and oversized cutover.json files without reading unbounded bytes', async () => {
    const h = await harness();
    resetSpies(h);
    for (const input of [
      rollbackRequest({ operationId: 'a'.repeat(129) }),
      rollbackRequest({ operationId: 'a'.repeat(5000) }),
      rollbackRequest({ nowIso: `2026-11-05T12:00:00.000Z${' '.repeat(65)}` }),
      rollbackRequest({ nowIso: '2026-11-05T12:00:00.000000000000000000000000000000000000000000000000000000000Z' }),
      { move: 'status', nowIso: 'x'.repeat(1000) },
      { move: 'status', deadlineIso: `${NOW}${'0'.repeat(70)}` },
    ]) {
      expect(await h.useCase.execute(input)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
    expect(h.spies.repoRead).not.toHaveBeenCalled();

    const dir = join(tempDir, 'state-big');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cutover.json'), `${JSON.stringify(switchedRecord(1))}${' '.repeat(CUTOVER_RECORD_MAX_BYTES)}`);
    const repo = new CutoverRecordRepositoryAdapter({ stateDir: dir });
    expect(await repo.read()).toEqual({ status: 'unreadable' });
    expect(await repo.compareAndSet({ expectedRevision: 1, next: switchedRecord(2) })).toEqual({
      outcome: 'refused',
      reason: 'unreadable',
    });
    const big = await harness({ stateDir: dir, seed: null });
    expect(await big.useCase.execute({ move: 'status' })).toEqual({ outcome: 'unknown', reason: 'cutover-record-unreadable' });
  });

  it('refuses a retried rollback after a failed post-intent step when operationId changes before any store write occurs', async () => {
    const h = await harness();
    h.spies.daemonPauseWrite.mockRejectedValueOnce(new Error('disk gone'));
    expect(await h.useCase.execute(rollbackRequest({ operationId: 'op-1' }))).toEqual({
      outcome: 'unknown',
      reason: 'daemon-pause-write-failed',
    });
    expect(await journalEntries(h, 'cutover/rollback@1')).toHaveLength(1);
    resetSpies(h);

    expect(await h.useCase.execute(rollbackRequest({ operationId: 'op-2' }))).toEqual({
      outcome: 'refused',
      reason: 'intent-digest-mismatch',
    });
    expect(h.spies.daemonPauseWrite).not.toHaveBeenCalled();
    expect(h.spies.trainPauseSet).not.toHaveBeenCalled();
    expect(h.spies.compareAndSet).not.toHaveBeenCalled();
    expect(h.spies.journalAppend).not.toHaveBeenCalled();

    // The original request still finishes the move.
    expect(await h.useCase.execute(rollbackRequest({ operationId: 'op-1' }))).toMatchObject({ outcome: 'completed', revision: 2 });
    // And a changed operationId is refused after completion too, before any cached outcome is returned.
    expect(await h.useCase.execute(rollbackRequest({ operationId: 'op-2' }))).toEqual({
      outcome: 'refused',
      reason: 'intent-digest-mismatch',
    });
  });

  it('maps failed writes after the intent to unknown, and a compare-and-set conflict to a refusal', async () => {
    const lift = await harness();
    lift.spies.trainPauseSet.mockResolvedValueOnce({ outcome: 'refused', reason: 'pause-unreadable' });
    expect(await lift.useCase.execute(rollbackRequest())).toEqual({ outcome: 'unknown', reason: 'train-pause-write-failed' });

    const cas = await harness();
    cas.spies.compareAndSet.mockResolvedValueOnce({ outcome: 'refused', reason: 'unreadable' });
    expect(await cas.useCase.execute(rollbackRequest())).toEqual({ outcome: 'unknown', reason: 'cutover-record-write-failed' });
    cas.spies.compareAndSet.mockResolvedValueOnce({ outcome: 'conflict', currentRevision: 7 });
    expect(await cas.useCase.execute(rollbackRequest())).toEqual({ outcome: 'refused', reason: 'revision-conflict' });

    const intent = await harness();
    intent.spies.journalAppend.mockResolvedValueOnce({ outcome: 'refused', reason: 'store-unreadable' });
    expect(await intent.useCase.execute(rollbackRequest())).toEqual({ outcome: 'unknown', reason: 'journal-append-failed' });
    expect(await journalEntries(intent, 'cutover/rollback@1')).toHaveLength(0);
  });
});
