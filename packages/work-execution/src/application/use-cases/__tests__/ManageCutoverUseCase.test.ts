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
import { MergeQueueRepositoryAdapter } from '../../../infrastructure/adapters/MergeQueueRepositoryAdapter.adapter.js';
import type { MergeQueueEntryRecord } from '../../../domain/merge-queue-records.js';
import type { MergePolicyRepository } from '../../../application/ports/out/MergePolicyPort.out-port.js';
import { WORK_EXECUTION_STATE_FILES } from '../../../infrastructure/adapters/state-files.js';
import { sha256HexDigest } from '../../../infrastructure/adapters/AttemptArtifactAdapter.adapter.js';
import {
  CUTOVER_RETIREMENT_SCRIPTS,
  CUTOVER_ROLLBACK_WINDOW_MS,
  CUTOVER_SHADOW_CRITERIA,
  CUTOVER_SHADOW_MIN_MERGES,
  buildShadowParkJournalPayload,
  canonicalCutoverSwitchPayload,
  readRetirementLedger,
  type CutoverRecord,
} from '../../../domain/cutover-records.js';
import { ManageCutoverUseCase, type ManageCutoverDependencies } from '../ManageCutoverUseCase.use-case.js';

const SWITCHED_AT = '2026-11-03T12:00:00.000Z';
const NOW = '2026-11-05T12:00:00.000Z';
const LATER = '2026-11-05T13:00:00.000Z';
const EARLIER_DEADLINE = '2026-11-05T11:00:00.000Z';
const FUTURE_DEADLINE = '2026-11-05T18:00:00.000Z';
const PLAN_DIGEST = 'b'.repeat(64);
const AT_WINDOW_NOW = new Date(Date.parse(SWITCHED_AT) + CUTOVER_ROLLBACK_WINDOW_MS).toISOString();
const INSIDE_WINDOW_NOW = new Date(Date.parse(SWITCHED_AT) + CUTOVER_ROLLBACK_WINDOW_MS - 1).toISOString();
/** Past the rollback window of a switch performed at `NOW`. */
const AFTER_SWITCH_WINDOW = new Date(Date.parse(NOW) + CUTOVER_ROLLBACK_WINDOW_MS + 86_400_000).toISOString();
const AFTER_WINDOW_NOW = new Date(Date.parse(SWITCHED_AT) + CUTOVER_ROLLBACK_WINDOW_MS + 3 * 86_400_000).toISOString();

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
  readonly mergeQueue: MergeQueueRepositoryAdapter;
  readonly shadowParkJournal: CutoverJournalAdapter;
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
    readonly shadowParkAppend: MockInstance<CutoverJournalAdapter['append']>;
    readonly shadowParkList: MockInstance<CutoverJournalAdapter['listByKeyPrefix']>;
    readonly listMergeEntries: MockInstance<MergeQueueRepositoryAdapter['listMergeEntries']>;
    readonly applyMergeTransition: MockInstance<MergeQueueRepositoryAdapter['applyMergeTransition']>;
  };
}

interface HarnessOptions {
  readonly stateDir?: string;
  readonly seed?: CutoverRecord | null;
  readonly daemonStatus?: ManageCutoverDependencies['daemonStatus'];
  /** Pauses the daemon before the spies are created, so `daemonPauseWrite` starts at zero calls. */
  readonly daemonPaused?: boolean;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const { stateDir } = options;
  const clock = { now: NOW };
  const repo = new CutoverRecordRepositoryAdapter({ stateDir, nowIso: () => clock.now });
  const journal = new CutoverJournalAdapter({ stateDir });
  const daemonPause = new DaemonPauseAdapter({ stateDir });
  const trainPause = new KillallTrainPauseAdapter({ stateDir });
  // SW2b2: the merge queue the switch releases shadow parks through, and the
  // separate shadow-park journal (`shadow-park-journal.json` on disk), never
  // the cutover journal.
  const mergeQueue = new MergeQueueRepositoryAdapter({ stateDir });
  const shadowParkJournal = new CutoverJournalAdapter({
    stateDir,
    ...(stateDir !== undefined ? { fileName: 'shadow-park-journal.json' } : {}),
    shadowPark: true,
  });
  const seed = options.seed === undefined ? switchedRecord(1) : options.seed;
  if (seed !== null) {
    await repo.compareAndSet({ expectedRevision: seed.revision - 1, next: seed });
    if (seed.trainPauseSetByCutover) {
      await trainPause.set({ paused: true, nowIso: SWITCHED_AT });
    }
  }
  if (options.daemonPaused === true) {
    await daemonPause.write(true, NOW);
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
    shadowParkJournal,
    computeDigest: sha256HexDigest,
    mintEntryId: () => ulid((sequence += 1)),
    nowIso: () => clock.now,
    readRetirementLedger: async () => ({ status: 'ok', ledger: validRetirementLedger() }),
  };
  const spies = {
    daemonPauseWrite: vi.spyOn(daemonPause, 'write'),
    trainPauseSet: vi.spyOn(trainPause, 'set'),
    compareAndSet: vi.spyOn(repo, 'compareAndSet'),
    journalAppend: vi.spyOn(journal, 'append'),
    repoRead: vi.spyOn(repo, 'read'),
    journalList: vi.spyOn(journal, 'listByKeyPrefix'),
    shadowParkAppend: vi.spyOn(shadowParkJournal, 'append'),
    shadowParkList: vi.spyOn(shadowParkJournal, 'listByKeyPrefix'),
    listMergeEntries: vi.spyOn(mergeQueue, 'listMergeEntries'),
    applyMergeTransition: vi.spyOn(mergeQueue, 'applyMergeTransition'),
  };
  return {
    repo,
    journal,
    daemonPause,
    trainPause,
    mergeQueue,
    shadowParkJournal,
    clock,
    deps,
    useCase: new ManageCutoverUseCase(deps),
    spies,
  };
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

function shadowRecord(revision = 1): CutoverRecord {
  return {
    schemaVersion: 1,
    revision,
    state: 'shadow',
    updatedAtIso: SWITCHED_AT,
    switchedAtIso: null,
    rolledBackAtIso: null,
    retiredAtIso: null,
    relaunchPlanDigest: null,
    trainPauseSetByCutover: false,
  };
}

function rolledBackRecord(revision = 1): CutoverRecord {
  return { ...switchedRecord(revision), state: 'rolled-back', rolledBackAtIso: NOW, trainPauseSetByCutover: false };
}

function switchRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    move: 'switch',
    expectedRevision: 0,
    operationId: 'op-1',
    relaunchPlanDigest: PLAN_DIGEST,
    nowIso: NOW,
    ...overrides,
  };
}

function retireRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { move: 'retire', expectedRevision: 1, operationId: 'op-1', nowIso: AT_WINDOW_NOW, ...overrides };
}

/** One all-pass day on the UTC date of `nowIso`. */
function shadowEvidence(nowIso: string, verdictOverrides: Record<string, string> = {}): Record<string, unknown> {
  const base = Date.parse(nowIso);
  const days = [0].map((back) => {
    const verdicts: Record<string, string> = {};
    for (const id of CUTOVER_SHADOW_CRITERIA) verdicts[id] = 'pass';
    return { day: new Date(base - back * 86_400_000).toISOString().slice(0, 10), verdicts };
  });
  for (const [id, verdict] of Object.entries(verdictOverrides)) {
    (days[0].verdicts as Record<string, string>)[id] = verdict;
  }
  return { merges: CUTOVER_SHADOW_MIN_MERGES, days };
}

function useCaseWithReaders(h: Harness, overrides: Parameters<typeof readers>[0] = {}): ManageCutoverUseCase {
  return new ManageCutoverUseCase({ ...h.deps, mergeQueue: h.mergeQueue, ...readers(overrides) });
}

/** A switch refused before any port write: no pause set, no record save, no journal entry. */
function expectNoSwitchWrites(h: Harness): void {
  expect(h.spies.trainPauseSet).not.toHaveBeenCalled();
  expect(h.spies.compareAndSet).not.toHaveBeenCalled();
  expect(h.spies.journalAppend).not.toHaveBeenCalled();
}

type ShadowEvidenceReader = NonNullable<ManageCutoverDependencies['readShadowEvidence']>;
type UnrecordedLanesCounter = NonNullable<ManageCutoverDependencies['countUnrecordedLanes']>;
type RetirementLedgerReader = NonNullable<ManageCutoverDependencies['readRetirementLedger']>;

interface LedgerRow {
  readonly script: string;
  readonly verified: boolean;
  readonly evidenceLink: string;
}

/** One verified row with an evidence link for every §1 cutover-plan script. */
function validRetirementLedger(
  rowOverrides: Record<number, Partial<LedgerRow>> = {},
): { readonly schemaVersion: number; readonly rows: LedgerRow[] } {
  const rows: LedgerRow[] = CUTOVER_RETIREMENT_SCRIPTS.map((script) => ({
    script,
    verified: true,
    evidenceLink: `docs/planning/2026-11-03_cutover-plan.md §1 ${script} adopted attempt`,
  }));
  for (const [index, override] of Object.entries(rowOverrides)) {
    rows[Number(index)] = { ...rows[Number(index)], ...override };
  }
  return { schemaVersion: 1, rows };
}

type MergePolicyReader = NonNullable<ManageCutoverDependencies['mergePolicy']>;

/** One merge-policy repository entry, shadow or not. */
function policyRepo(owner: string, repo: string, shadow: boolean): MergePolicyRepository {
  return {
    owner,
    repo,
    repositoryKey: `${owner}/${repo}`,
    projectId: 'project-1',
    shadow,
    unattended: true,
    requiredContexts: [],
    updateBranch: false,
    macosProcedure: null,
    maxAttempts: 3,
    checksGraceMinutes: 5,
    veto: { mode: 'shadow', holdConfidence: 0.8 },
  };
}

function readers(overrides: {
  readShadowEvidence?: ShadowEvidenceReader;
  countUnrecordedLanes?: UnrecordedLanesCounter;
  readRetirementLedger?: RetirementLedgerReader;
  mergePolicy?: MergePolicyReader;
} = {}): {
  readShadowEvidence: ShadowEvidenceReader;
  countUnrecordedLanes: UnrecordedLanesCounter;
  readRetirementLedger: RetirementLedgerReader;
  mergePolicy: MergePolicyReader;
} {
  return {
    readShadowEvidence: async () => ({ status: 'ok', evidence: shadowEvidence(NOW) }),
    countUnrecordedLanes: async () => ({ status: 'ok', unrecorded: 0, unknownListings: 0 }),
    readRetirementLedger: async () => ({ status: 'ok', ledger: validRetirementLedger() }),
    // SW2b2 default: a valid policy that marks no repository shadow, so the
    // existing switch tests keep passing with no park planned at all.
    mergePolicy: {
      readMergePolicy: async () => ({
        outcome: 'known',
        policyRevision: 'pol-1',
        repositories: [],
        daemon: { intervalSeconds: 60, budgetSeconds: 60, settleSeconds: 30, chainRefresh: 'shadow' },
      }),
    },
    ...overrides,
  };
}

async function journalEntries(h: Harness, key: string): Promise<readonly { kind: string; outcome?: string }[]> {
  const listed = await h.journal.listByKeyPrefix(key);
  return listed.outcome === 'listed' ? listed.entries.filter((entry) => entry.key === key) : [];
}

/** The `trainPauseSetByCutover` flag of the stored switched record. */
async function savedPauseOwnership(h: Harness): Promise<boolean | 'no-switched-record'> {
  const read = await h.repo.read();
  return read.status === 'ok' && read.record.state === 'switched' ? read.record.trainPauseSetByCutover : 'no-switched-record';
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

  it('refuses bare switch and retire requests that carry none of the required fields, with no port call', async () => {
    const h = await harness();
    resetSpies(h);
    for (const move of ['switch', 'retire']) {
      expect(await h.useCase.execute({ move })).toEqual({ outcome: 'refused', reason: 'invalid-request' });
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

describe('ManageCutoverUseCase switch', () => {
  it('switch rejects a throwing getter on the request with invalid-request and writes nothing', async () => {
    const h = await harness({ seed: null });
    const request: Record<string, unknown> = { move: 'switch', expectedRevision: 0, operationId: 'op-1', relaunchPlanDigest: PLAN_DIGEST, nowIso: NOW };
    Object.defineProperty(request, 'deadlineIso', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    resetSpies(h);
    const result = await h.useCase.execute(request);
    expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(JSON.stringify(result)).not.toContain('boom');
    expect(totalWriteCalls(h)).toBe(0);
    expect(h.spies.repoRead).not.toHaveBeenCalled();
  });

  it('switch returns secret-shaped for a secret-shaped operation id and writes nothing', async () => {
    const h = await harness({ seed: null });
    const result = await h.useCase.execute(switchRequest({ operationId: LEGACY_ONLY_SECRET }));
    expect(result).toEqual({ outcome: 'refused', reason: 'secret-shaped' });
    expect(JSON.stringify(result)).not.toContain(LEGACY_ONLY_SECRET);
    expect(totalWriteCalls(h)).toBe(0);
  });

  it('switch returns unknown for an unreadable cutover record and writes nothing', async () => {
    for (const status of ['unreadable', 'unknown-version'] as const) {
      const h = await harness({ seed: null });
      h.spies.repoRead.mockResolvedValue({ status });
      resetSpies(h);
      expect(await h.useCase.execute(switchRequest())).toEqual({
        outcome: 'unknown',
        reason: status === 'unreadable' ? 'cutover-record-unreadable' : 'cutover-record-unknown-version',
      });
      expect(totalWriteCalls(h)).toBe(0);
    }
  });

  it('refuses not-shadow for a stored state that is not shadow, and revision-conflict for a mismatched revision', async () => {
    const switched = await harness();
    resetSpies(switched);
    expect(await switched.useCase.execute(switchRequest({ expectedRevision: 1 }))).toEqual({
      outcome: 'refused',
      reason: 'not-shadow',
    });
    expect(totalWriteCalls(switched)).toBe(0);

    const missing = await harness({ seed: null });
    resetSpies(missing);
    expect(await missing.useCase.execute(switchRequest({ expectedRevision: 1 }))).toEqual({
      outcome: 'refused',
      reason: 'revision-conflict',
    });
    expect(totalWriteCalls(missing)).toBe(0);
  });

  it('refuses revision-conflict before not-shadow when a stored non-shadow record carries a mismatched revision', async () => {
    // The revision precondition governs every stored record, shadow or not:
    // a stored non-shadow state with a revision other than the expected one
    // is a `revision-conflict`, never a `not-shadow`. The seed walks the
    // repository to a `switched` record at revision 3.
    const h = await harness({ seed: null });
    await h.repo.compareAndSet({ expectedRevision: 0, next: switchedRecord(1) });
    await h.repo.compareAndSet({ expectedRevision: 1, next: switchedRecord(2) });
    await h.repo.compareAndSet({ expectedRevision: 2, next: switchedRecord(3) });
    resetSpies(h);
    expect(await h.useCase.execute(switchRequest({ expectedRevision: 2 }))).toEqual({
      outcome: 'refused',
      reason: 'revision-conflict',
    });
    expect(totalWriteCalls(h)).toBe(0);
  });

  it('a missing readShadowEvidence method refuses shadow-evidence-absent and names S1 through S12', async () => {
    const h = await harness({ seed: null });
    resetSpies(h);
    const result = await h.useCase.execute(switchRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'shadow-evidence-absent', failed: [...CUTOVER_SHADOW_CRITERIA] });
    expectNoSwitchWrites(h);
  });

  it('a reader that answers absent refuses shadow-evidence-absent, and unreadable or unknown-version answers are unknown', async () => {
    for (const [status, expected] of [
      ['absent', { outcome: 'refused', reason: 'shadow-evidence-absent', failed: [...CUTOVER_SHADOW_CRITERIA] }],
      ['unreadable', { outcome: 'unknown', reason: 'shadow-evidence-unreadable' }],
      ['unknown-version', { outcome: 'unknown', reason: 'shadow-evidence-unknown-version' }],
      ['threw', { outcome: 'unknown', reason: 'shadow-evidence-unreadable' }],
    ] as const) {
      const h = await harness({ seed: null });
      const reader: ShadowEvidenceReader =
        status === 'threw'
          ? async () => {
              throw new Error('boom');
            }
          : (async () => ({ status })) as ShadowEvidenceReader;
      const useCase = useCaseWithReaders(h, { readShadowEvidence: reader });
      resetSpies(h);
      expect(await useCase.execute(switchRequest())).toEqual(expected);
      expect(totalWriteCalls(h)).toBe(0);
    }
  });

  it('refuses a switch whose evidence carries fewer merges than the minimum', async () => {
    const h = await harness({ seed: null });
    const useCase = useCaseWithReaders(h, {
      readShadowEvidence: async () => ({
        status: 'ok',
        evidence: { ...shadowEvidence(NOW), merges: CUTOVER_SHADOW_MIN_MERGES - 1 },
      }),
    });
    resetSpies(h);
    const result = await useCase.execute(switchRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'shadow-criteria-failed', failed: [...CUTOVER_SHADOW_CRITERIA] });
    expectNoSwitchWrites(h);
  });

  it('switch does not credit a train pause that was already paused, and a later rollback lifts nothing', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    // The pause already exists before the switch, so `set` answers `unchanged`.
    await h.trainPause.set({ paused: true, nowIso: SWITCHED_AT });
    const useCase = useCaseWithReaders(h);
    resetSpies(h);
    expect(await useCase.execute(switchRequest())).toMatchObject({
      outcome: 'completed',
      state: 'switched',
      revision: 1,
    });
    expect(await h.spies.trainPauseSet.mock.results[0].value).toMatchObject({ outcome: 'unchanged' });
    expect(await h.repo.read()).toMatchObject({
      status: 'ok',
      record: { state: 'switched', trainPauseSetByCutover: false },
    });

    // A later rollback leaves the pre-existing pause alone.
    resetSpies(h);
    expect(await h.useCase.execute(rollbackRequest())).toMatchObject({
      outcome: 'completed',
      state: 'rolled-back',
      revision: 2,
    });
    expect(h.spies.trainPauseSet).not.toHaveBeenCalled();
    expect((await h.trainPause.read()).status).toBe('paused');
  });

  it('switch does not credit a train pause that was already paused, and a later retire lifts nothing', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    await h.trainPause.set({ paused: true, nowIso: SWITCHED_AT });
    expect(await useCaseWithReaders(h).execute(switchRequest())).toMatchObject({ outcome: 'completed', revision: 1 });
    expect(await savedPauseOwnership(h)).toBe(false);

    resetSpies(h);
    expect(await h.useCase.execute(retireRequest({ nowIso: AFTER_SWITCH_WINDOW }))).toMatchObject({
      outcome: 'completed',
      state: 'retired',
      revision: 2,
    });
    expect(h.spies.trainPauseSet).not.toHaveBeenCalled();
    expect((await h.trainPause.read()).status).toBe('paused');
  });

  it('switch names S4 when that verdict is unknown and the other criteria pass', async () => {
    const h = await harness({ seed: null });
    const useCase = useCaseWithReaders(h, {
      readShadowEvidence: async () => ({ status: 'ok', evidence: shadowEvidence(NOW, { S4: 'unknown' }) }),
    });
    resetSpies(h);
    const result = await useCase.execute(switchRequest());
    expect(result).toEqual({ outcome: 'refused', reason: 'shadow-criteria-failed', failed: ['S4'] });
    expectNoSwitchWrites(h);
  });

  it('answers unrecorded-lanes-unknown for a missing or unreadable count or unknown listings, and unrecorded-lanes for unrecorded work', async () => {
    for (const [label, counter, expected] of [
      ['missing', undefined, { outcome: 'unknown', reason: 'unrecorded-lanes-unknown' }],
      ['unreadable', async () => ({ status: 'unreadable' }) as unknown as ReturnType<UnrecordedLanesCounter>, { outcome: 'unknown', reason: 'unrecorded-lanes-unknown' }],
      ['unknown listings', async () => ({ status: 'ok', unrecorded: 0, unknownListings: 2 }), { outcome: 'unknown', reason: 'unrecorded-lanes-unknown' }],
      ['unrecorded', async () => ({ status: 'ok', unrecorded: 1, unknownListings: 0 }), { outcome: 'refused', reason: 'unrecorded-lanes' }],
      ['throws', async () => { throw new Error('boom'); }, { outcome: 'unknown', reason: 'unrecorded-lanes-unknown' }],
    ] as const) {
      const h = await harness({ seed: null });
      const useCase = useCaseWithReaders(h, { countUnrecordedLanes: counter as UnrecordedLanesCounter | undefined });
      resetSpies(h);
      expect({ label, result: await useCase.execute(switchRequest()) }).toEqual({ label, result: expected });
      expect(totalWriteCalls(h)).toBe(0);
    }
  });

  it('reports daemon-status-unreadable, train-pause-unreadable and deadline-exceeded for a switch, with no compare-and-set', async () => {
    const boom = (): never => {
      throw new Error('boom');
    };
    const cases: Array<[string, (h: Harness) => void | Promise<void>, Record<string, string>]> = [
      ['daemon status throws', (h) => void ((h.deps as { daemonStatus: unknown }).daemonStatus = { read: boom }), { outcome: 'unknown', reason: 'daemon-status-unreadable' }],
      ['daemon status unreadable', (h) => void ((h.deps as { daemonStatus: unknown }).daemonStatus = { read: async () => ({ status: 'unreadable' }) }), { outcome: 'unknown', reason: 'daemon-status-unreadable' }],
      ['train pause throws', (h) => void ((h.deps as { trainPauseRead: unknown }).trainPauseRead = { read: boom }), { outcome: 'unknown', reason: 'train-pause-unreadable' }],
      ['train pause unreadable', (h) => void ((h.deps as { trainPauseRead: unknown }).trainPauseRead = { read: async () => ({ status: 'unreadable' }) }), { outcome: 'unknown', reason: 'train-pause-unreadable' }],
      ['deadline passed', () => undefined, { outcome: 'unknown', reason: 'deadline-exceeded' }],
    ];
    for (const [label, arrange, expected] of cases) {
      const h = await harness({ seed: null, daemonPaused: true });
      await arrange(h);
      const useCase = useCaseWithReaders(h);
      resetSpies(h);
      const request = label === 'deadline passed' ? switchRequest({ deadlineIso: EARLIER_DEADLINE }) : switchRequest();
      expect({ label, result: await useCase.execute(request) }).toEqual({ label, result: expected });
      expect(h.spies.compareAndSet).not.toHaveBeenCalled();
      expect(h.spies.journalAppend).not.toHaveBeenCalled();
      if (label.startsWith('train pause')) {
        expect(h.spies.trainPauseSet).not.toHaveBeenCalled();
      }
    }
  });

  it('refuses daemon-not-paused when daemonPauseRead returns clear, with zero writes', async () => {
    // The daemon pause is left `clear` (the harness default): the switch gate
    // must refuse before any pause, record or journal write.
    const h = await harness({ seed: null });
    const useCase = useCaseWithReaders(h);
    resetSpies(h);
    expect(await useCase.execute(switchRequest())).toEqual({ outcome: 'refused', reason: 'daemon-not-paused' });
    expect(totalWriteCalls(h)).toBe(0);
  });

  it('returns unknown daemon-pause-unreadable when daemonPauseRead throws, returns unreadable, or returns a malformed value, with zero writes', async () => {
    const boom = (): never => {
      throw new Error('boom');
    };
    const cases: Array<[string, unknown]> = [
      ['throws', { read: boom }],
      ['unreadable', { read: async () => ({ state: 'unreadable' }) }],
      ['null', { read: async () => null }],
      ['bogus state', { read: async () => ({ state: 'bogus' }) }],
    ];
    for (const [label, reader] of cases) {
      const h = await harness({ seed: null });
      (h.deps as { daemonPauseRead: unknown }).daemonPauseRead = reader;
      const useCase = useCaseWithReaders(h);
      resetSpies(h);
      expect({ label, result: await useCase.execute(switchRequest()) }).toEqual({
        label,
        result: { outcome: 'unknown', reason: 'daemon-pause-unreadable' },
      });
      expect(h.spies.compareAndSet).not.toHaveBeenCalled();
      expect(h.spies.journalAppend).not.toHaveBeenCalled();
      expect(h.spies.trainPauseSet).not.toHaveBeenCalled();
    }
  });

  it('returns unknown deadline-exceeded when deadlineIso is reached during or before daemonPauseRead, with zero writes', async () => {
    // The clock advances past the deadline inside the daemon-status read, so
    // the guarded daemon-pause read must answer `deadline` without ever
    // calling `daemonPauseRead.read`.
    const h = await harness({ seed: null });
    (h.deps as { daemonStatus: unknown }).daemonStatus = {
      read: async () => {
        h.clock.now = new Date(Date.parse(NOW) + 60_000).toISOString();
        return { status: 'missing' };
      },
    };
    const pauseRead = vi.spyOn(h.daemonPause, 'read');
    const useCase = useCaseWithReaders(h);
    resetSpies(h);
    const deadlineIso = new Date(Date.parse(NOW) + 30_000).toISOString();
    expect(await useCase.execute(switchRequest({ deadlineIso }))).toEqual({
      outcome: 'unknown',
      reason: 'deadline-exceeded',
    });
    expect(pauseRead).not.toHaveBeenCalled();
    expect(totalWriteCalls(h)).toBe(0);
  });

  it('refuses daemon-not-paused with zero writes when the marker is cleared between the preflight read and the write phase', async () => {
    // The preflight read sees `paused`, the marker is cleared before the write
    // phase, and the recheck before the first write must refuse with zero
    // writes: no intent, no train-pause set, no record swap.
    const h = await harness({ seed: null, daemonPaused: true });
    const states = ['paused', 'clear'];
    (h.deps as { daemonPauseRead: unknown }).daemonPauseRead = {
      read: async () => ({ state: states.shift() ?? 'clear' }),
    };
    const useCase = useCaseWithReaders(h);
    resetSpies(h);
    expect(await useCase.execute(switchRequest())).toEqual({ outcome: 'refused', reason: 'daemon-not-paused' });
    expect(totalWriteCalls(h)).toBe(0);
  });

  it('switch sets the train pause and saves a switched record when evidence passes and no lane is unrecorded', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    const useCase = useCaseWithReaders(h);
    resetSpies(h);
    const result = await useCase.execute(switchRequest());
    expect(result).toMatchObject({
      outcome: 'completed',
      move: 'switch',
      key: 'cutover/switch@0',
      replayed: false,
      state: 'switched',
      revision: 1,
    });
    expect(h.spies.trainPauseSet).toHaveBeenCalledWith({ paused: true, nowIso: NOW });
    expect(h.spies.daemonPauseWrite).not.toHaveBeenCalled();
    expect(await h.repo.read()).toMatchObject({
      status: 'ok',
      record: {
        state: 'switched',
        revision: 1,
        switchedAtIso: NOW,
        relaunchPlanDigest: PLAN_DIGEST,
        trainPauseSetByCutover: true,
        rolledBackAtIso: null,
        retiredAtIso: null,
      },
    });
    expect(await journalEntries(h, 'cutover/switch@0')).toEqual([
      expect.objectContaining({ kind: 'intent' }),
      expect.objectContaining({ kind: 'result', outcome: 'completed' }),
    ]);

    // A second call with the same operation id replays without calling set again.
    resetSpies(h);
    const replay = await useCase.execute(switchRequest());
    expect(replay).toMatchObject({ outcome: 'completed', replayed: true, state: 'switched', revision: 1 });
    expect(h.spies.trainPauseSet).not.toHaveBeenCalled();
    expect(h.spies.compareAndSet).not.toHaveBeenCalled();
    expect(h.spies.journalAppend).not.toHaveBeenCalled();
  });

  it('switch still proceeds when the daemon is present with a failed last tick', async () => {
    const h = await harness({ seed: null, daemonPaused: true, daemonStatus: { read: async () => ({ status: 'ok', record: { exitCode: 1 } as never }) } });
    const useCase = useCaseWithReaders(h);
    resetSpies(h);
    expect(await useCase.execute(switchRequest())).toMatchObject({ outcome: 'completed', state: 'switched', revision: 1 });
    expect(h.spies.trainPauseSet).toHaveBeenCalledTimes(1);
  });

  it('finishes a switch cut short after the intent, and maps refused writes to unknown', async () => {
    // A compare-and-set that throws once leaves the intent recorded; the next pass finishes the move.
    const h = await harness({ seed: null, daemonPaused: true });
    const useCase = useCaseWithReaders(h);
    h.spies.compareAndSet.mockRejectedValueOnce(new Error('disk gone'));
    expect(await useCase.execute(switchRequest())).toEqual({ outcome: 'unknown', reason: 'cutover-record-write-failed' });
    expect(await journalEntries(h, 'cutover/switch@0')).toHaveLength(1);
    expect(await useCase.execute(switchRequest())).toMatchObject({ outcome: 'completed', replayed: false, revision: 1 });
    expect(await journalEntries(h, 'cutover/switch@0')).toHaveLength(2);
    // The first pass set the pause (`changed`); the replay saw it already set (`unchanged`). The saved
    // record must still own it, or a later rollback would leave the cutover's pause in place.
    expect(await h.repo.read()).toMatchObject({ status: 'ok', record: { state: 'switched', trainPauseSetByCutover: true } });

    // A refused train-pause set is unknown and the record stays unswitched.
    const refusedSet = await harness({ seed: null, daemonPaused: true });
    const refusedUseCase = useCaseWithReaders(refusedSet);
    refusedSet.spies.trainPauseSet.mockResolvedValueOnce({ outcome: 'refused', reason: 'pause-unreadable' });
    expect(await refusedUseCase.execute(switchRequest())).toEqual({ outcome: 'unknown', reason: 'train-pause-write-failed' });
    expect(await refusedSet.repo.read()).toEqual({ status: 'missing' });

    // A refused compare-and-set is unknown; a conflict is a refusal.
    const refusedCas = await harness({ seed: null, daemonPaused: true });
    const refusedCasUseCase = useCaseWithReaders(refusedCas);
    refusedCas.spies.compareAndSet.mockResolvedValueOnce({ outcome: 'refused', reason: 'unreadable' });
    expect(await refusedCasUseCase.execute(switchRequest())).toEqual({ outcome: 'unknown', reason: 'cutover-record-write-failed' });
    refusedCas.spies.compareAndSet.mockResolvedValueOnce({ outcome: 'conflict', currentRevision: 4 });
    expect(await refusedCasUseCase.execute(switchRequest())).toEqual({ outcome: 'refused', reason: 'revision-conflict' });

    // A failed intent append writes no journal entry.
    const failedAppend = await harness({ seed: null, daemonPaused: true });
    const failedAppendUseCase = useCaseWithReaders(failedAppend);
    failedAppend.spies.journalAppend.mockResolvedValueOnce({ outcome: 'refused', reason: 'store-unreadable' });
    expect(await failedAppendUseCase.execute(switchRequest())).toEqual({ outcome: 'unknown', reason: 'journal-append-failed' });
    expect(await journalEntries(failedAppend, 'cutover/switch@0')).toHaveLength(0);
  });

  it('refuses a switch whose intent digest differs and a replay whose recorded outcome was a refusal', async () => {
    const h = await harness({ seed: null });
    const digest = sha256HexDigest(`{"move":"switch","expectedRevision":0,"operationId":"op-1","relaunchPlanDigest":"${PLAN_DIGEST}"}`);
    await h.journal.append({ key: 'cutover/switch@0', kind: 'intent', entryId: ulid(910), recordedAtIso: NOW, digest });
    const useCase = useCaseWithReaders(h);
    expect(await useCase.execute(switchRequest({ operationId: 'op-2' }))).toEqual({
      outcome: 'refused',
      reason: 'intent-digest-mismatch',
    });
    await h.journal.append({
      key: 'cutover/switch@0',
      kind: 'result',
      entryId: ulid(911),
      recordedAtIso: NOW,
      outcome: 'refused',
      reasonCode: 'refused',
      digest,
    });
    expect(await useCase.execute(switchRequest())).toEqual({ outcome: 'refused', reason: 'journal-refused' });
  });

  it('refuses not-shadow on a retried switch whose intent exists but no final result does, and writes nothing', async () => {
    // An intent without a final journal result is not a replay: a stored
    // switched record must still be refused `not-shadow`, never accepted as
    // case B by the compare-and-set recovery path. The retry carries the
    // stored revision; a retry whose expected revision no longer matches the
    // stored one is refused `revision-conflict` before the state is read.
    const h = await harness({ seed: switchedRecord(1) });
    const digest = sha256HexDigest(`{"move":"switch","expectedRevision":1,"operationId":"op-1","relaunchPlanDigest":"${PLAN_DIGEST}"}`);
    await h.journal.append({ key: 'cutover/switch@1', kind: 'intent', entryId: ulid(912), recordedAtIso: NOW, digest });
    const useCase = useCaseWithReaders(h);
    resetSpies(h);
    expect(await useCase.execute(switchRequest({ expectedRevision: 1 }))).toEqual({ outcome: 'refused', reason: 'not-shadow' });
    expect(totalWriteCalls(h)).toBe(0);
    expect(await h.repo.read()).toMatchObject({ status: 'ok', record: { state: 'switched', revision: 1 } });
  });

  it('a replayed switch after a crash in the first pass lets a later rollback lift the pause the cutover set', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    const useCase = useCaseWithReaders(h);
    h.spies.compareAndSet.mockRejectedValueOnce(new Error('disk gone'));
    expect(await useCase.execute(switchRequest())).toEqual({ outcome: 'unknown', reason: 'cutover-record-write-failed' });
    expect(await useCase.execute(switchRequest())).toMatchObject({ outcome: 'completed', replayed: false });
    resetSpies(h);
    expect(await h.useCase.execute(rollbackRequest())).toMatchObject({ outcome: 'completed', state: 'rolled-back' });
    expect(h.spies.trainPauseSet).toHaveBeenCalledWith({ paused: false, nowIso: NOW });
    expect((await h.trainPause.read()).status).toBe('clear');
  });

  it('a replayed switch after a crash in the first pass lets a later retire lift the pause the cutover set', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    const useCase = useCaseWithReaders(h);
    h.spies.compareAndSet.mockRejectedValueOnce(new Error('disk gone'));
    await useCase.execute(switchRequest());
    await useCase.execute(switchRequest());
    resetSpies(h);
    const afterWindow = new Date(Date.parse(NOW) + CUTOVER_ROLLBACK_WINDOW_MS + 86_400_000).toISOString();
    expect(await h.useCase.execute(retireRequest({ nowIso: afterWindow }))).toMatchObject({ outcome: 'completed', state: 'retired' });
    expect(h.spies.trainPauseSet).toHaveBeenCalledWith({ paused: false, nowIso: afterWindow });
    expect((await h.trainPause.read()).status).toBe('clear');
  });

  it('a switch whose result append failed after the record save is refused revision-conflict on replay, not finished', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    const useCase = useCaseWithReaders(h);
    const realAppend = Object.getPrototypeOf(h.journal).append as CutoverJournalAdapter['append'];
    h.spies.journalAppend.mockImplementation(async (entry) =>
      entry.kind === 'result' ? { outcome: 'refused', reason: 'store-unreadable' } : realAppend.call(h.journal, entry),
    );
    expect(await useCase.execute(switchRequest())).toEqual({ outcome: 'unknown', reason: 'journal-append-failed' });
    expect(await h.repo.read()).toMatchObject({ status: 'ok', record: { state: 'switched', revision: 1 } });
    resetSpies(h);
    expect(await useCase.execute(switchRequest())).toEqual({ outcome: 'refused', reason: 'revision-conflict' });
    expect(totalWriteCalls(h)).toBe(0);
  });
});

describe('ManageCutoverUseCase switch shadow parks', () => {
  let entrySequence = 900;
  const HEAD_OID = 'a'.repeat(40);
  // The queue adapter validates deadlines against the real clock, so the test
  // deadline must lie ahead of it, not ahead of the harness clock.
  const QUEUE_DEADLINE = new Date(Date.now() + 600_000).toISOString();

  /** Enqueues one entry into the harness queue and parks it with reason `checks`. */
  async function parkedEntry(h: Harness, owner: string, repo: string, pr: number): Promise<MergeQueueEntryRecord> {
    entrySequence += 1;
    const created = await h.mergeQueue.enqueueMergeEntry({
      repository: { owner, repo },
      pullRequest: pr,
      headOid: HEAD_OID,
      tier: 1,
      enqueuedBy: 'cli',
      runId: null,
      entryId: ulid(entrySequence),
      successorEntryId: ulid(entrySequence),
      enqueuedAtIso: NOW,
      deadlineIso: QUEUE_DEADLINE,
    });
    if (created.outcome !== 'created') {
      throw new Error(`enqueue refused: ${created.outcome} ${'reason' in created ? created.reason : ''}`);
    }
    const transition = await h.mergeQueue.applyMergeTransition({
      entryId: created.record.entryId,
      expectedRevision: created.record.revision,
      next: { ...created.record, revision: created.record.revision + 1, state: 'parked', reason: 'checks' },
      successor: null,
      deadlineIso: QUEUE_DEADLINE,
    });
    if (transition.outcome !== 'applied') {
      throw new Error(`park refused: ${transition.outcome}`);
    }
    return transition.record;
  }

  /** A policy reader that marks exactly the given repositories shadow. */
  function shadowPolicy(...keys: readonly string[]): MergePolicyReader {
    return {
      readMergePolicy: async () => ({
        outcome: 'known',
        policyRevision: 'pol-1',
        repositories: keys.map((key) => policyRepo(key.split('/')[0], key.split('/')[1], true)),
        daemon: { intervalSeconds: 60, budgetSeconds: 60, settleSeconds: 30, chainRefresh: 'shadow' },
      }),
    };
  }

  /** The shadow-park journal intents recorded for `cutover/shadow-park-...` keys. */
  async function parkIntents(h: Harness): Promise<readonly { key: string; digest: string | null | undefined }[]> {
    const listed = await h.shadowParkJournal.listByKeyPrefix('cutover/shadow-park-');
    return listed.outcome === 'listed'
      ? listed.entries.filter((e) => e.kind === 'intent').map((e) => ({ key: e.key, digest: e.digest }))
      : [];
  }

  it('releases every ordinary shadow-repo parked entry to queued and journals its intent after the cutover intent', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    const first = await parkedEntry(h, 'octo', 'repo', 1);
    const second = await parkedEntry(h, 'octo', 'repo', 2);
    const useCase = useCaseWithReaders(h, { mergePolicy: shadowPolicy('octo/repo') });
    resetSpies(h);
    const result = await useCase.execute(switchRequest());
    expect(result).toMatchObject({ outcome: 'completed', state: 'switched', releasedParks: 2, vetoHoldParks: 0 });

    // Both entries are back in the queue, with their attempt history kept.
    const listed = await h.mergeQueue.listMergeEntries({ deadlineIso: QUEUE_DEADLINE });
    const states = new Map(listed.map((e) => [e.entryId, { state: e.state, reason: e.reason, notBeforeIso: e.notBeforeIso, attempt: e.attempt }]));
    expect(states.get(first.entryId)).toEqual({ state: 'queued', reason: null, notBeforeIso: null, attempt: first.attempt });
    expect(states.get(second.entryId)).toEqual({ state: 'queued', reason: null, notBeforeIso: null, attempt: second.attempt });

    // The shadow-park journal holds one intent per park, keyed by its entry digest.
    const expectedKeys = [first, second]
      .map((e) => `cutover/shadow-park-${sha256HexDigest(e.entryId).slice(0, 32)}@${e.revision}`)
      .sort();
    expect((await parkIntents(h)).map((e) => e.key).sort()).toEqual(expectedKeys);
    expect(await journalEntries(h, 'cutover/switch@0')).toEqual([
      expect.objectContaining({ kind: 'intent' }),
      expect.objectContaining({ kind: 'result', outcome: 'completed' }),
    ]);
    expect(h.spies.applyMergeTransition).toHaveBeenCalledTimes(2);
  });

  it('never touches non-shadow repositories and never releases a veto-hold, but reports its count', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    const shadow = await parkedEntry(h, 'octo', 'repo', 1);
    const live = await parkedEntry(h, 'live', 'repo', 2);
    // Park the shadow entry again as a veto-hold via a direct transition.
    const veto = await h.mergeQueue.applyMergeTransition({
      entryId: shadow.entryId,
      expectedRevision: 99,
      next: { ...shadow, state: 'parked', reason: 'veto-hold' },
      successor: null,
      deadlineIso: QUEUE_DEADLINE,
    });
    expect(veto.outcome).toBe('refused');
    const vetoed = await h.mergeQueue.applyMergeTransition({
      entryId: shadow.entryId,
      expectedRevision: shadow.revision,
      next: { ...shadow, revision: shadow.revision + 1, state: 'parked', reason: 'veto-hold' },
      successor: null,
      deadlineIso: QUEUE_DEADLINE,
    });
    if (vetoed.outcome !== 'applied') throw new Error('veto park failed');
    const useCase = useCaseWithReaders(h, { mergePolicy: shadowPolicy('octo/repo') });
    resetSpies(h);
    const result = await useCase.execute(switchRequest());
    expect(result).toMatchObject({ outcome: 'completed', state: 'switched', releasedParks: 0, vetoHoldParks: 1 });
    expect(await parkIntents(h)).toEqual([]);
    const listed = await h.mergeQueue.listMergeEntries({ deadlineIso: QUEUE_DEADLINE });
    const byId = new Map(listed.map((e) => [e.entryId, e]));
    expect(byId.get(shadow.entryId)).toMatchObject({ state: 'parked', reason: 'veto-hold' });
    expect(byId.get(live.entryId)).toMatchObject({ state: 'parked', reason: 'checks' });
    expect(h.spies.applyMergeTransition).not.toHaveBeenCalled();
  });

  it('refuses merge-queue-absent, merge-policy-absent and park-journal-append-failed when a dependency is missing', async () => {
    for (const [label, missing, expected] of [
      ['mergeQueueRead', 'mergeQueueRead', 'merge-queue-absent'],
      ['mergeQueue', 'mergeQueue', 'merge-queue-absent'],
      ['mergePolicy', 'mergePolicy', 'merge-policy-absent'],
      ['shadowParkJournal', 'shadowParkJournal', 'park-journal-append-failed'],
    ] as const) {
      const h = await harness({ seed: null, daemonPaused: true });
      await parkedEntry(h, 'octo', 'repo', 1);
      const deps: Record<string, unknown> = { ...h.deps, mergeQueue: h.mergeQueue, ...readers({ mergePolicy: shadowPolicy('octo/repo') }) };
      delete deps[missing === 'mergeQueueRead' ? 'mergeQueue' : missing];
      if (missing === 'mergeQueueRead') deps.mergeQueue = undefined;
      if (missing === 'mergeQueue') deps.mergeQueueRead = undefined;
      const useCase = new ManageCutoverUseCase(deps as unknown as ManageCutoverDependencies);
      resetSpies(h);
      expect({ label, result: await useCase.execute(switchRequest()) }).toEqual({ label, result: { outcome: 'refused', reason: expected } });
      expect(h.spies.journalAppend).not.toHaveBeenCalled();
      expect(h.spies.shadowParkAppend).not.toHaveBeenCalled();
      expect(h.spies.applyMergeTransition).not.toHaveBeenCalled();
      expect(h.spies.trainPauseSet).not.toHaveBeenCalled();
      expect(h.spies.compareAndSet).not.toHaveBeenCalled();
    }
  });

  it('returns merge-policy-unreadable when mergePolicy throws, answers unknown, or carries a non-boolean shadow', async () => {
    const boom = (): never => {
      throw new Error('boom');
    };
    const badRepo = { ...policyRepo('octo', 'repo', true), shadow: 'yes' };
    const cases: Array<[string, MergePolicyReader]> = [
      ['throws', { readMergePolicy: boom }],
      ['null answer', { readMergePolicy: async () => null as unknown as Awaited<ReturnType<MergePolicyReader['readMergePolicy']>> }],
      ['undefined answer', { readMergePolicy: async () => undefined as unknown as Awaited<ReturnType<MergePolicyReader['readMergePolicy']>> }],
      ['unknown', { readMergePolicy: async () => ({ outcome: 'unknown', reason: 'installation-unreadable' }) }],
      ['non-boolean shadow', { readMergePolicy: async () => ({ outcome: 'known', policyRevision: 'pol-1', repositories: [badRepo as unknown as MergePolicyRepository], daemon: { intervalSeconds: 60, budgetSeconds: 60, settleSeconds: 30, chainRefresh: 'shadow' } }) }],
    ];
    for (const [label, mergePolicy] of cases) {
      const h = await harness({ seed: null, daemonPaused: true });
      await parkedEntry(h, 'octo', 'repo', 1);
      const useCase = useCaseWithReaders(h, { mergePolicy });
      resetSpies(h);
      expect({ label, result: await useCase.execute(switchRequest()) }).toEqual({ label, result: { outcome: 'unknown', reason: 'merge-policy-unreadable' } });
      expect(h.spies.journalAppend).not.toHaveBeenCalled();
      expect(h.spies.shadowParkAppend).not.toHaveBeenCalled();
      expect(h.spies.applyMergeTransition).not.toHaveBeenCalled();
    }
  });

  it('returns merge-queue-unreadable when listMergeEntries throws or returns a malformed entry', async () => {
    const valid = await (async () => {
      const h = await harness({ seed: null, daemonPaused: true });
      return parkedEntry(h, 'octo', 'repo', 1);
    })();
    const boom = (): never => {
      throw new Error('boom');
    };
    const cases: Array<[string, Pick<MergeQueueRepositoryAdapter, 'listMergeEntries'>]> = [
      ['throws', { listMergeEntries: boom }],
      ['null', { listMergeEntries: async () => null as unknown as readonly MergeQueueEntryRecord[] }],
      ['array-like', { listMergeEntries: async () => ({ length: 1, 0: valid }) as unknown as readonly MergeQueueEntryRecord[] }],
      ['sparse hole', { listMergeEntries: async () => Object.assign([valid], { 1: undefined, length: 2 }) as unknown as readonly MergeQueueEntryRecord[] }],
      ['malformed element', { listMergeEntries: async () => [{ ...valid, revision: 0 }] as unknown as readonly MergeQueueEntryRecord[] }],
    ];
    for (const [label, mergeQueueRead] of cases) {
      const h = await harness({ seed: null, daemonPaused: true });
      await parkedEntry(h, 'octo', 'repo', 1);
      const useCase = new ManageCutoverUseCase({
        ...h.deps,
        mergeQueue: h.mergeQueue,
        mergeQueueRead,
        ...readers({ mergePolicy: shadowPolicy('octo/repo') }),
      });
      resetSpies(h);
      expect({ label, result: await useCase.execute(switchRequest()) }).toEqual({ label, result: { outcome: 'unknown', reason: 'merge-queue-unreadable' } });
      expect(h.spies.journalAppend).not.toHaveBeenCalled();
      expect(h.spies.shadowParkAppend).not.toHaveBeenCalled();
      expect(h.spies.applyMergeTransition).not.toHaveBeenCalled();
    }
  });

  it('refuses park-digest-mismatch before any append or release', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    const entry = await parkedEntry(h, 'octo', 'repo', 1);
    const useCase = useCaseWithReaders(h, { mergePolicy: shadowPolicy('octo/repo') });
    // Seed the shadow-park journal with a valid intent for this park's key
    // whose digest and record cannot match the planned park.
    const seeded = buildShadowParkJournalPayload(entry);
    if (!seeded.ok) throw new Error('seed payload refused');
    await h.shadowParkJournal.append({
      key: `cutover/shadow-park-${sha256HexDigest(entry.entryId).slice(0, 32)}@${entry.revision}`,
      kind: 'intent',
      entryId: ulid(950),
      recordedAtIso: NOW,
      digest: 'f'.repeat(64),
      shadowPark: { ...seeded.record, attempt: seeded.record.attempt + 1 },
    });
    resetSpies(h);
    expect(await useCase.execute(switchRequest())).toEqual({ outcome: 'refused', reason: 'park-digest-mismatch' });
    expect(h.spies.journalAppend).not.toHaveBeenCalled();
    expect(h.spies.applyMergeTransition).not.toHaveBeenCalled();
    // Pre-intent refusals leave the cutover journal untouched.
    expect(await journalEntries(h, 'cutover/switch@0')).toEqual([]);
  });

  it('resumes after a crash between the park release and the record save, skipping already-released entries', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    const first = await parkedEntry(h, 'octo', 'repo', 1);
    const second = await parkedEntry(h, 'octo', 'repo', 2);
    const useCase = useCaseWithReaders(h, { mergePolicy: shadowPolicy('octo/repo') });
    // The first release applies (crash right after it), the second throws:
    // both park intents are journaled, one park is back in the queue.
    const realTransition = Object.getPrototypeOf(h.mergeQueue).applyMergeTransition as MergeQueueRepositoryAdapter['applyMergeTransition'];
    h.spies.applyMergeTransition.mockImplementationOnce(async (command) => realTransition.call(h.mergeQueue, command));
    h.spies.applyMergeTransition.mockImplementationOnce(async () => {
      throw new Error('disk gone');
    });
    expect(await useCase.execute(switchRequest())).toEqual({ outcome: 'unknown', reason: 'merge-queue-write-failed' });
    expect(await parkIntents(h)).toHaveLength(2);
    const afterCrash = new Map(
      (await h.mergeQueue.listMergeEntries({ deadlineIso: QUEUE_DEADLINE })).map((e) => [e.entryId, e.state]),
    );
    expect(afterCrash.get(first.entryId)).toBe('queued');
    expect(afterCrash.get(second.entryId)).toBe('parked');

    // The retry replays the recorded intents, releases only the still-parked
    // entry, and counts exactly one release.
    const result = await useCase.execute(switchRequest());
    expect(result).toMatchObject({ outcome: 'completed', state: 'switched', releasedParks: 1, vetoHoldParks: 0 });
    const listed = await h.mergeQueue.listMergeEntries({ deadlineIso: QUEUE_DEADLINE });
    const byId = new Map(listed.map((e) => [e.entryId, e.state]));
    expect(byId.get(first.entryId)).toBe('queued');
    expect(byId.get(second.entryId)).toBe('queued');
    expect((await parkIntents(h)).map((e) => e.key)).toHaveLength(2);
  });

  it('answers deadline-exceeded for the policy, queue, journal and write steps, with no cutover journal entry', async () => {
    const deadlineIso = new Date(Date.parse(NOW) + 30_000).toISOString();
    const advance = (h: Harness): void => {
      h.clock.now = new Date(Date.parse(NOW) + 60_000).toISOString();
    };
    const cases: Array<[string, (h: Harness) => ManageCutoverUseCase]> = [
      // The clock passes the deadline inside the train-pause preflight read, so
      // the guarded merge-policy read answers `deadline` without calling it.
      ['policy read', (h) => {
        (h.deps as { trainPauseRead: unknown }).trainPauseRead = {
          read: async () => {
            advance(h);
            return { status: 'clear' };
          },
        };
        return useCaseWithReaders(h, { mergePolicy: shadowPolicy('octo/repo') });
      }],
      // The clock passes inside the policy read, so the queue list answers `deadline`.
      ['queue list', (h) => useCaseWithReaders(h, {
        mergePolicy: {
          readMergePolicy: async () => {
            advance(h);
            return {
              outcome: 'known',
              policyRevision: 'pol-1',
              repositories: [policyRepo('octo', 'repo', true)],
              daemon: { intervalSeconds: 60, budgetSeconds: 60, settleSeconds: 30, chainRefresh: 'shadow' },
            };
          },
        },
      })],
      // The clock passes inside the queue list, so the journal list answers `deadline`.
      ['journal list', (h) => {
        h.spies.listMergeEntries.mockImplementationOnce(async () => {
          advance(h);
          return [];
        });
        return useCaseWithReaders(h, { mergePolicy: shadowPolicy('octo/repo') });
      }],
      // The clock passes inside the journal list, so the shadow-park append answers `deadline`.
      ['park append', (h) => {
        h.spies.listMergeEntries.mockImplementationOnce(async () => {
          advance(h);
          return [];
        });
        h.spies.shadowParkList.mockImplementation(async () => {
          advance(h);
          return { outcome: 'listed', entries: [] };
        });
        return useCaseWithReaders(h, { mergePolicy: shadowPolicy('octo/repo') });
      }],
    ];
    for (const [label, build] of cases) {
      const h = await harness({ seed: null, daemonPaused: true });
      await parkedEntry(h, 'octo', 'repo', 1);
      const useCase = build(h);
      resetSpies(h);
      expect({ label, result: await useCase.execute(switchRequest({ deadlineIso })) }).toEqual({ label, result: { outcome: 'unknown', reason: 'deadline-exceeded' } });
      expect(await journalEntries(h, 'cutover/switch@0')).toEqual([]);
      expect(h.spies.applyMergeTransition).not.toHaveBeenCalled();
      expect(h.spies.compareAndSet).not.toHaveBeenCalled();
    }
  });

  it('returns journal-unreadable when shadowParkJournal list throws, answers null or unreadable, or carries a hostile entries array', async () => {
    // A listed entry whose own `key` is an enumerable getter: the snapshot
    // reader refuses accessors without running them, so the entry can never
    // reach the match loop.
    const getterEntry = Object.defineProperty({}, 'key', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const cases: Array<[string, unknown]> = [
      ['throws', () => Promise.reject(new Error('boom'))],
      ['null response', null],
      ['undefined response', undefined],
      ['unreadable', { outcome: 'unreadable' }],
      ['null entries', { outcome: 'listed', entries: null }],
      ['undefined entries', { outcome: 'listed', entries: undefined }],
      ['array-like entries', { outcome: 'listed', entries: { length: 1, 0: { key: 'k', kind: 'intent' } } }],
      ['getter entry', { outcome: 'listed', entries: [getterEntry] }],
    ];
    for (const [label, behaviour] of cases) {
      const h = await harness({ seed: null, daemonPaused: true });
      await parkedEntry(h, 'octo', 'repo', 1);
      h.spies.shadowParkList.mockImplementation(
        (typeof behaviour === 'function' ? behaviour : async () => behaviour) as unknown as CutoverJournalAdapter['listByKeyPrefix'],
      );
      const useCase = useCaseWithReaders(h, { mergePolicy: shadowPolicy('octo/repo') });
      resetSpies(h);
      expect({ label, result: await useCase.execute(switchRequest()) }).toEqual({ label, result: { outcome: 'unknown', reason: 'journal-unreadable' } });
      expect(h.spies.journalAppend).not.toHaveBeenCalled();
      expect(h.spies.shadowParkAppend).not.toHaveBeenCalled();
      expect(h.spies.applyMergeTransition).not.toHaveBeenCalled();
      expect(await journalEntries(h, 'cutover/switch@0')).toEqual([]);
    }
  });

  it('refuses too-many-shadow-parks when one switch plans more parks than the per-switch cap, with zero writes', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    const base = await parkedEntry(h, 'octo', 'repo', 1);
    // 501 valid parked records on the shadow repository: one more than
    // MAX_SHADOW_PARKS_PER_SWITCH, each with a distinct entry id so every
    // park plans a distinct journal key.
    const overflow = Array.from({ length: 501 }, (_, i) => ({ ...base, entryId: ulid(10_000 + i), pullRequest: 10_000 + i }));
    h.spies.listMergeEntries.mockImplementationOnce(async () => overflow as unknown as MergeQueueEntryRecord[]);
    const useCase = useCaseWithReaders(h, { mergePolicy: shadowPolicy('octo/repo') });
    resetSpies(h);
    expect(await useCase.execute(switchRequest())).toEqual({ outcome: 'refused', reason: 'too-many-shadow-parks' });
    expect(h.spies.journalAppend).not.toHaveBeenCalled();
    expect(h.spies.shadowParkAppend).not.toHaveBeenCalled();
    expect(h.spies.applyMergeTransition).not.toHaveBeenCalled();
    expect(h.spies.compareAndSet).not.toHaveBeenCalled();
    expect(await journalEntries(h, 'cutover/switch@0')).toEqual([]);
  });

  it('refuses journal-capacity-exceeded when the shadow-park journal is one entry short of its cap, with zero writes', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    await parkedEntry(h, 'octo', 'repo', 1);
    // 9996 pre-existing journal entries + 1 new park + the switch reserve of
    // 4 exceeds MAX_CUTOVER_JOURNAL_ENTRIES (10_000) by one, while the listing
    // itself stays inside the bounded-array cap.
    const full = Array.from({ length: 9996 }, (_, i) => ({ key: `cutover/other-${i}`, kind: 'result' }));
    h.spies.shadowParkList.mockImplementationOnce(async () => ({ outcome: 'listed', entries: full }) as unknown as Awaited<ReturnType<CutoverJournalAdapter['listByKeyPrefix']>>);
    const useCase = useCaseWithReaders(h, { mergePolicy: shadowPolicy('octo/repo') });
    resetSpies(h);
    expect(await useCase.execute(switchRequest())).toEqual({ outcome: 'refused', reason: 'journal-capacity-exceeded' });
    expect(h.spies.journalAppend).not.toHaveBeenCalled();
    expect(h.spies.shadowParkAppend).not.toHaveBeenCalled();
    expect(h.spies.applyMergeTransition).not.toHaveBeenCalled();
    expect(h.spies.compareAndSet).not.toHaveBeenCalled();
    expect(await journalEntries(h, 'cutover/switch@0')).toEqual([]);
  });

  it('answers deadline-exceeded when the deadline passes between the park append and the queue release, releasing nothing', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    await parkedEntry(h, 'octo', 'repo', 1);
    const deadlineIso = new Date(Date.parse(NOW) + 30_000).toISOString();
    // The park intent append succeeds but moves the harness clock past the
    // deadline, so the guarded `applyMergeTransition` call answers `deadline`
    // before the queue is ever written.
    const realAppend = Object.getPrototypeOf(h.shadowParkJournal).append as CutoverJournalAdapter['append'];
    h.spies.shadowParkAppend.mockImplementationOnce(async (...args: Parameters<CutoverJournalAdapter['append']>) => {
      h.clock.now = new Date(Date.parse(NOW) + 60_000).toISOString();
      return realAppend.apply(h.shadowParkJournal, args);
    });
    const useCase = useCaseWithReaders(h, { mergePolicy: shadowPolicy('octo/repo') });
    resetSpies(h);
    expect(await useCase.execute(switchRequest({ deadlineIso }))).toEqual({ outcome: 'unknown', reason: 'deadline-exceeded' });
    expect(h.spies.applyMergeTransition).not.toHaveBeenCalled();
    expect(h.spies.compareAndSet).not.toHaveBeenCalled();
    // The cutover intent was already recorded, but no result was.
    expect(await journalEntries(h, 'cutover/switch@0')).toEqual([expect.objectContaining({ kind: 'intent' })]);
  });

  it('refuses park-journal-append-failed when the shadow-park append refuses or throws, with no queue release', async () => {
    for (const [label, behaviour] of [
      ['refuses', async () => ({ outcome: 'refused' as const, reason: 'store-read-only' as const })],
      ['throws', async (): Promise<never> => {
        throw new Error('boom');
      }],
    ] as const) {
      const h = await harness({ seed: null, daemonPaused: true });
      await parkedEntry(h, 'octo', 'repo', 1);
      h.spies.shadowParkAppend.mockImplementation(behaviour as unknown as CutoverJournalAdapter['append']);
      const useCase = useCaseWithReaders(h, { mergePolicy: shadowPolicy('octo/repo') });
      resetSpies(h);
      expect({ label, result: await useCase.execute(switchRequest()) }).toEqual({ label, result: { outcome: 'refused', reason: 'park-journal-append-failed' } });
      expect(h.spies.applyMergeTransition).not.toHaveBeenCalled();
      expect(h.spies.compareAndSet).not.toHaveBeenCalled();
    }
  });

  it('refuses park-release-conflict on a revision conflict and answers merge-queue-write-failed otherwise', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    await parkedEntry(h, 'octo', 'repo', 1);
    h.spies.applyMergeTransition.mockResolvedValueOnce({ outcome: 'refused', reason: 'revision-conflict' });
    const useCase = useCaseWithReaders(h, { mergePolicy: shadowPolicy('octo/repo') });
    expect(await useCase.execute(switchRequest())).toEqual({ outcome: 'refused', reason: 'park-release-conflict' });
    expect(h.spies.compareAndSet).not.toHaveBeenCalled();

    const other = await harness({ seed: null, daemonPaused: true });
    await parkedEntry(other, 'octo', 'repo', 1);
    other.spies.applyMergeTransition.mockResolvedValueOnce({ outcome: 'refused', reason: 'unknown-entry' });
    const otherUseCase = useCaseWithReaders(other, { mergePolicy: shadowPolicy('octo/repo') });
    expect(await otherUseCase.execute(switchRequest())).toEqual({ outcome: 'unknown', reason: 'merge-queue-write-failed' });
    expect(other.spies.compareAndSet).not.toHaveBeenCalled();
  });

  it('refuses invalid-park-record when a queue entry passes the record reader but fails park planning, with zero writes', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    const entry = await parkedEntry(h, 'octo', 'repo', 1);
    // A revision beyond the park key's cap: the queue record reader accepts
    // any positive safe-integer revision, but `cutoverShadowParkKey` refuses
    // one past MAX_REVISION, so planning refuses before any write.
    const hostile = { ...entry, revision: 2_000_000_000 };
    const useCase = new ManageCutoverUseCase({
      ...h.deps,
      mergeQueue: h.mergeQueue,
      mergeQueueRead: { listMergeEntries: async () => [hostile] },
      ...readers({ mergePolicy: shadowPolicy('octo/repo') }),
    });
    resetSpies(h);
    expect(await useCase.execute(switchRequest())).toEqual({ outcome: 'refused', reason: 'invalid-park-record' });
    expect(h.spies.journalAppend).not.toHaveBeenCalled();
    expect(h.spies.shadowParkAppend).not.toHaveBeenCalled();
    expect(h.spies.applyMergeTransition).not.toHaveBeenCalled();
    expect(await journalEntries(h, 'cutover/switch@0')).toEqual([]);
  });
});

describe('ManageCutoverUseCase switch pause ownership', () => {
  /** The digest a switch intent carries for the default request and one recorded `trainPausedBefore`. */
  const intentDigest = (trainPausedBefore?: boolean, operationId = 'op-1'): string =>
    sha256HexDigest(
      canonicalCutoverSwitchPayload({ expectedRevision: 0, operationId, relaunchPlanDigest: PLAN_DIGEST, trainPausedBefore }),
    );

  /** A first pass that appends its intent, calls `set`, and then loses the record save. */
  async function crashAfterSet(h: Harness, useCase: ManageCutoverUseCase): Promise<void> {
    h.spies.compareAndSet.mockRejectedValueOnce(new Error('disk gone'));
    expect(await useCase.execute(switchRequest())).toEqual({ outcome: 'unknown', reason: 'cutover-record-write-failed' });
    expect(await h.repo.read()).toEqual({ status: 'missing' });
  }

  /** The outcome the latest `trainPause.set` call answered. */
  async function lastSetOutcome(h: Harness): Promise<string> {
    return (await h.spies.trainPauseSet.mock.results.at(-1)?.value)?.outcome ?? 'not-called';
  }

  it('a clean switch on a clear train records trainPausedBefore false in the intent digest and owns the pause, and rollback lifts it', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    expect(await useCaseWithReaders(h).execute(switchRequest())).toMatchObject({ outcome: 'completed', replayed: false });
    expect(await lastSetOutcome(h)).toBe('changed');
    expect(await journalEntries(h, 'cutover/switch@0')).toEqual([
      expect.objectContaining({ kind: 'intent', digest: intentDigest(false) }),
      expect.objectContaining({ kind: 'result', digest: intentDigest(false) }),
    ]);
    expect(await savedPauseOwnership(h)).toBe(true);

    resetSpies(h);
    expect(await h.useCase.execute(rollbackRequest())).toMatchObject({ outcome: 'completed', state: 'rolled-back' });
    expect(h.spies.trainPauseSet).toHaveBeenCalledWith({ paused: false, nowIso: NOW });
    expect((await h.trainPause.read()).status).toBe('clear');
  });

  it('a clean switch on a clear train owns the pause, and retire lifts it', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    expect(await useCaseWithReaders(h).execute(switchRequest())).toMatchObject({ outcome: 'completed', replayed: false });
    expect(await savedPauseOwnership(h)).toBe(true);

    resetSpies(h);
    expect(await h.useCase.execute(retireRequest({ nowIso: AFTER_SWITCH_WINDOW }))).toMatchObject({
      outcome: 'completed',
      state: 'retired',
    });
    expect(h.spies.trainPauseSet).toHaveBeenCalledWith({ paused: false, nowIso: AFTER_SWITCH_WINDOW });
    expect((await h.trainPause.read()).status).toBe('clear');
  });

  it('a switch on an already paused train records trainPausedBefore true in the intent digest', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    await h.trainPause.set({ paused: true, nowIso: SWITCHED_AT });
    expect(await useCaseWithReaders(h).execute(switchRequest())).toMatchObject({ outcome: 'completed', replayed: false });
    expect(await journalEntries(h, 'cutover/switch@0')).toEqual([
      expect.objectContaining({ kind: 'intent', digest: intentDigest(true) }),
      expect.objectContaining({ kind: 'result', digest: intentDigest(true) }),
    ]);
  });

  it('a replay after a crash between a changed set and the record save still owns the pause although it now reads paused and set answers unchanged, and rollback lifts it', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    const useCase = useCaseWithReaders(h);
    await crashAfterSet(h, useCase);
    expect(await lastSetOutcome(h)).toBe('changed');
    // What the replay's own preflight read will see: the pause its first pass set.
    expect((await h.trainPause.read()).status).toBe('paused');

    resetSpies(h);
    expect(await useCase.execute(switchRequest())).toMatchObject({ outcome: 'completed', replayed: false, revision: 1 });
    expect(await lastSetOutcome(h)).toBe('unchanged');
    expect(await savedPauseOwnership(h)).toBe(true);

    resetSpies(h);
    expect(await h.useCase.execute(rollbackRequest())).toMatchObject({ outcome: 'completed', state: 'rolled-back' });
    expect(h.spies.trainPauseSet).toHaveBeenCalledWith({ paused: false, nowIso: NOW });
    expect((await h.trainPause.read()).status).toBe('clear');
  });

  it('a replay whose set answers changed after the first set threw owns the pause', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    const useCase = useCaseWithReaders(h);
    h.spies.trainPauseSet.mockRejectedValueOnce(new Error('pause store gone'));
    expect(await useCase.execute(switchRequest())).toEqual({ outcome: 'unknown', reason: 'train-pause-write-failed' });
    expect(await journalEntries(h, 'cutover/switch@0')).toHaveLength(1);
    expect((await h.trainPause.read()).status).toBe('clear');

    resetSpies(h);
    expect(await useCase.execute(switchRequest())).toMatchObject({ outcome: 'completed', replayed: false });
    expect(await lastSetOutcome(h)).toBe('changed');
    expect(await savedPauseOwnership(h)).toBe(true);
  });

  it('a first pass that read clear but whose set answers unchanged does not own the pause, and rollback lifts nothing', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    // Someone pauses the train between this pass's read and its set: the read answers `clear`.
    await h.trainPause.set({ paused: true, nowIso: SWITCHED_AT });
    const read = vi.spyOn(h.trainPause, 'read').mockResolvedValueOnce({ status: 'clear' });
    resetSpies(h);
    expect(await useCaseWithReaders(h).execute(switchRequest())).toMatchObject({ outcome: 'completed', replayed: false });
    expect(read).toHaveBeenCalledTimes(1);
    expect(await lastSetOutcome(h)).toBe('unchanged');
    expect(await journalEntries(h, 'cutover/switch@0')).toContainEqual(
      expect.objectContaining({ kind: 'intent', digest: intentDigest(false) }),
    );
    expect(await savedPauseOwnership(h)).toBe(false);

    resetSpies(h);
    expect(await h.useCase.execute(rollbackRequest())).toMatchObject({ outcome: 'completed', state: 'rolled-back' });
    expect(h.spies.trainPauseSet).not.toHaveBeenCalled();
    expect((await h.trainPause.read()).status).toBe('paused');
  });

  it('a replay whose set answers changed owns the pause even though the train was paused before the first pass and lifted by hand since', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    await h.trainPause.set({ paused: true, nowIso: SWITCHED_AT });
    const useCase = useCaseWithReaders(h);
    await crashAfterSet(h, useCase);
    expect(await lastSetOutcome(h)).toBe('unchanged');
    await h.trainPause.set({ paused: false, nowIso: SWITCHED_AT });

    resetSpies(h);
    expect(await useCase.execute(switchRequest())).toMatchObject({ outcome: 'completed', replayed: false });
    expect(await lastSetOutcome(h)).toBe('changed');
    expect(await savedPauseOwnership(h)).toBe(true);
  });

  it('a replay whose set answers unchanged does not own a pause the operator set before the first pass, and rollback lifts nothing', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    await h.trainPause.set({ paused: true, nowIso: SWITCHED_AT });
    const useCase = useCaseWithReaders(h);
    await crashAfterSet(h, useCase);

    resetSpies(h);
    expect(await useCase.execute(switchRequest())).toMatchObject({ outcome: 'completed', replayed: false });
    expect(await lastSetOutcome(h)).toBe('unchanged');
    expect(await savedPauseOwnership(h)).toBe(false);

    resetSpies(h);
    expect(await h.useCase.execute(rollbackRequest())).toMatchObject({ outcome: 'completed', state: 'rolled-back' });
    expect(h.spies.trainPauseSet).not.toHaveBeenCalled();
    expect((await h.trainPause.read()).status).toBe('paused');
  });

  it('a replay over a legacy four-key-digest intent succeeds and does not own the pause when set answers unchanged', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    const legacy = intentDigest();
    expect(legacy).toBe(
      sha256HexDigest(`{"move":"switch","expectedRevision":0,"operationId":"op-1","relaunchPlanDigest":"${PLAN_DIGEST}"}`),
    );
    await h.journal.append({ key: 'cutover/switch@0', kind: 'intent', entryId: ulid(920), recordedAtIso: NOW, digest: legacy });
    await h.trainPause.set({ paused: true, nowIso: SWITCHED_AT });

    resetSpies(h);
    expect(await useCaseWithReaders(h).execute(switchRequest())).toMatchObject({
      outcome: 'completed',
      replayed: false,
      state: 'switched',
      revision: 1,
    });
    expect(await lastSetOutcome(h)).toBe('unchanged');
    expect(await savedPauseOwnership(h)).toBe(false);
    // The legacy intent is the only intent; the result carries its digest.
    expect(await journalEntries(h, 'cutover/switch@0')).toEqual([
      expect.objectContaining({ kind: 'intent', digest: legacy }),
      expect.objectContaining({ kind: 'result', digest: legacy }),
    ]);
  });

  it('a different operation id on a key whose intent records trainPausedBefore still answers intent-digest-mismatch and writes nothing', async () => {
    for (const pausedBefore of [false, true]) {
      const h = await harness({ seed: null, daemonPaused: true });
      if (pausedBefore) await h.trainPause.set({ paused: true, nowIso: SWITCHED_AT });
      const useCase = useCaseWithReaders(h);
      await crashAfterSet(h, useCase);
      expect(await journalEntries(h, 'cutover/switch@0')).toEqual([
        expect.objectContaining({ kind: 'intent', digest: intentDigest(pausedBefore) }),
      ]);

      resetSpies(h);
      expect(await useCase.execute(switchRequest({ operationId: 'op-2' }))).toEqual({
        outcome: 'refused',
        reason: 'intent-digest-mismatch',
      });
      expect(totalWriteCalls(h)).toBe(0);
      expect(await h.repo.read()).toEqual({ status: 'missing' });
    }
  });

  it('an unreadable train-pause read on a replay is train-pause-unreadable, with no set call and no second intent', async () => {
    const h = await harness({ seed: null, daemonPaused: true });
    const useCase = useCaseWithReaders(h);
    await crashAfterSet(h, useCase);
    vi.spyOn(h.trainPause, 'read').mockResolvedValueOnce({ status: 'unreadable' });

    resetSpies(h);
    expect(await useCase.execute(switchRequest())).toEqual({ outcome: 'unknown', reason: 'train-pause-unreadable' });
    expect(totalWriteCalls(h)).toBe(0);
    expect(await journalEntries(h, 'cutover/switch@0')).toHaveLength(1);
  });
});

describe('ManageCutoverUseCase retire', () => {
  it('retire refuses not-switched when no switch is recorded', async () => {
    const missing = await harness({ seed: null });
    resetSpies(missing);
    expect(await missing.useCase.execute(retireRequest())).toEqual({ outcome: 'refused', reason: 'not-switched' });
    expect(totalWriteCalls(missing)).toBe(0);

    const shadow = await harness({ seed: shadowRecord(1) });
    expect(await shadow.useCase.execute(retireRequest())).toEqual({ outcome: 'refused', reason: 'not-switched' });

    const rolledBack = await harness({ seed: rolledBackRecord(1) });
    resetSpies(rolledBack);
    expect(await rolledBack.useCase.execute(retireRequest())).toEqual({ outcome: 'refused', reason: 'not-switched' });
    expect(totalWriteCalls(rolledBack)).toBe(0);
  });

  it('retire at exactly 14 days lifts a cutover-owned train pause and saves retired', async () => {
    const h = await harness();
    resetSpies(h);
    const result = await h.useCase.execute(retireRequest({ nowIso: AT_WINDOW_NOW }));
    expect(result).toMatchObject({
      outcome: 'completed',
      move: 'retire',
      key: 'cutover/retire@1',
      replayed: false,
      state: 'retired',
      revision: 2,
    });
    expect(h.spies.trainPauseSet).toHaveBeenCalledWith({ paused: false, nowIso: AT_WINDOW_NOW });
    expect(h.spies.daemonPauseWrite).not.toHaveBeenCalled();
    expect(await h.repo.read()).toMatchObject({
      status: 'ok',
      record: {
        state: 'retired',
        revision: 2,
        switchedAtIso: SWITCHED_AT,
        retiredAtIso: AT_WINDOW_NOW,
        rolledBackAtIso: null,
        relaunchPlanDigest: PLAN_DIGEST,
        trainPauseSetByCutover: false,
      },
    });
    expect(await journalEntries(h, 'cutover/retire@1')).toEqual([
      expect.objectContaining({ kind: 'intent' }),
      expect.objectContaining({ kind: 'result', outcome: 'completed' }),
    ]);
  });

  it('retire leaves an existing train pause when the cutover did not set it', async () => {
    const h = await harness({ seed: switchedRecord(1, false) });
    await h.trainPause.set({ paused: true, nowIso: SWITCHED_AT });
    resetSpies(h);
    expect(await h.useCase.execute(retireRequest({ nowIso: AFTER_WINDOW_NOW }))).toMatchObject({
      outcome: 'completed',
      state: 'retired',
      revision: 2,
    });
    expect(h.spies.trainPauseSet).not.toHaveBeenCalled();
    expect((await h.trainPause.read()).status).toBe('paused');
  });

  it('retire one millisecond before 14 days refuses inside-rollback-window and does not lift the pause', async () => {
    const h = await harness();
    resetSpies(h);
    expect(await h.useCase.execute(retireRequest({ nowIso: INSIDE_WINDOW_NOW }))).toEqual({
      outcome: 'refused',
      reason: 'inside-rollback-window',
    });
    expect(h.spies.trainPauseSet).not.toHaveBeenCalled();
    expect(h.spies.compareAndSet).not.toHaveBeenCalled();
    expect(h.spies.journalAppend).not.toHaveBeenCalled();
    expect((await h.trainPause.read()).status).toBe('paused');
  });

  it('retire with nowIso before the switch refuses invalid-clock', async () => {
    const h = await harness();
    resetSpies(h);
    expect(await h.useCase.execute(retireRequest({ nowIso: '2026-11-01T00:00:00.000Z' }))).toEqual({
      outcome: 'refused',
      reason: 'invalid-clock',
    });
    expect(totalWriteCalls(h)).toBe(0);
  });

  it('maps a refused pause lift, a refused compare-and-set and a failed journal append to unknown for a retire', async () => {
    const lift = await harness();
    lift.spies.trainPauseSet.mockResolvedValueOnce({ outcome: 'refused', reason: 'pause-unreadable' });
    expect(await lift.useCase.execute(retireRequest({ nowIso: AFTER_WINDOW_NOW }))).toEqual({
      outcome: 'unknown',
      reason: 'train-pause-write-failed',
    });
    expect(await lift.repo.read()).toMatchObject({ status: 'ok', record: { state: 'switched', revision: 1 } });

    const cas = await harness();
    cas.spies.compareAndSet.mockResolvedValueOnce({ outcome: 'refused', reason: 'unreadable' });
    expect(await cas.useCase.execute(retireRequest({ nowIso: AFTER_WINDOW_NOW }))).toEqual({
      outcome: 'unknown',
      reason: 'cutover-record-write-failed',
    });
    cas.spies.compareAndSet.mockResolvedValueOnce({ outcome: 'conflict', currentRevision: 9 });
    expect(await cas.useCase.execute(retireRequest({ nowIso: AFTER_WINDOW_NOW }))).toEqual({
      outcome: 'refused',
      reason: 'revision-conflict',
    });

    const append = await harness();
    append.spies.journalAppend.mockResolvedValueOnce({ outcome: 'refused', reason: 'store-unreadable' });
    expect(await append.useCase.execute(retireRequest({ nowIso: AFTER_WINDOW_NOW }))).toEqual({
      outcome: 'unknown',
      reason: 'journal-append-failed',
    });
    expect(await journalEntries(append, 'cutover/retire@1')).toHaveLength(0);
  });

  it('replays a completed retire without lifting the pause again', async () => {
    const h = await harness();
    const request = retireRequest({ nowIso: AFTER_WINDOW_NOW });
    expect(await h.useCase.execute(request)).toMatchObject({ outcome: 'completed', replayed: false, state: 'retired' });
    resetSpies(h);
    expect(await h.useCase.execute(request)).toMatchObject({ outcome: 'completed', replayed: true, state: 'retired', revision: 2 });
    expect(h.spies.trainPauseSet).not.toHaveBeenCalled();
    expect(h.spies.compareAndSet).not.toHaveBeenCalled();
    expect(h.spies.journalAppend).not.toHaveBeenCalled();
  });

  it('answers deadline-exceeded for a retire before any write', async () => {
    const h = await harness();
    resetSpies(h);
    expect(await h.useCase.execute(retireRequest({ deadlineIso: EARLIER_DEADLINE }))).toEqual({
      outcome: 'unknown',
      reason: 'deadline-exceeded',
    });
    expect(totalWriteCalls(h)).toBe(0);
  });

  it('refuses a retire whose intent digest differs', async () => {
    const h = await harness();
    const digest = sha256HexDigest('{"move":"retire","expectedRevision":1,"operationId":"op-1"}');
    await h.journal.append({ key: 'cutover/retire@1', kind: 'intent', entryId: ulid(920), recordedAtIso: NOW, digest });
    expect(await h.useCase.execute(retireRequest({ operationId: 'op-2' }))).toEqual({
      outcome: 'refused',
      reason: 'intent-digest-mismatch',
    });
    expect(h.spies.compareAndSet).not.toHaveBeenCalled();
  });

  it('refuses inside-rollback-window on a retried retire whose intent exists but no final result does, and writes nothing', async () => {
    // `nowIso` is not part of the intent digest, so a retry re-decides the
    // rollback window against the request's own clock instead of trusting the
    // pass that appended the intent.
    const h = await harness();
    h.spies.trainPauseSet.mockResolvedValueOnce({ outcome: 'refused', reason: 'pause-unreadable' });
    expect(await h.useCase.execute(retireRequest({ nowIso: AFTER_WINDOW_NOW }))).toEqual({
      outcome: 'unknown',
      reason: 'train-pause-write-failed',
    });
    expect(await journalEntries(h, 'cutover/retire@1')).toEqual([expect.objectContaining({ kind: 'intent' })]);
    resetSpies(h);
    expect(await h.useCase.execute(retireRequest({ nowIso: INSIDE_WINDOW_NOW }))).toEqual({
      outcome: 'refused',
      reason: 'inside-rollback-window',
    });
    expect(totalWriteCalls(h)).toBe(0);
    expect(h.spies.journalAppend).not.toHaveBeenCalled();
    expect(await h.repo.read()).toMatchObject({ status: 'ok', record: { state: 'switched', revision: 1 } });
  });

  it('a retire whose result append failed after the record save is refused not-switched on replay, not finished', async () => {
    const h = await harness();
    const realAppend = Object.getPrototypeOf(h.journal).append as CutoverJournalAdapter['append'];
    h.spies.journalAppend.mockImplementation(async (entry) =>
      entry.kind === 'result' ? { outcome: 'refused', reason: 'store-unreadable' } : realAppend.call(h.journal, entry),
    );
    expect(await h.useCase.execute(retireRequest({ nowIso: AFTER_WINDOW_NOW }))).toEqual({
      outcome: 'unknown',
      reason: 'journal-append-failed',
    });
    expect(await h.repo.read()).toMatchObject({ status: 'ok', record: { state: 'retired', revision: 2 } });
    resetSpies(h);
    expect(await h.useCase.execute(retireRequest({ nowIso: AFTER_WINDOW_NOW }))).toEqual({
      outcome: 'refused',
      reason: 'not-switched',
    });
    expect(totalWriteCalls(h)).toBe(0);
  });

  it('retire with a stale expected revision refuses not-switched and writes nothing', async () => {
    const h = await harness(); // stored switched record is at revision 1
    resetSpies(h);
    expect(await h.useCase.execute(retireRequest({ expectedRevision: 2, nowIso: AFTER_WINDOW_NOW }))).toEqual({
      outcome: 'refused',
      reason: 'not-switched',
    });
    expect(totalWriteCalls(h)).toBe(0);
    expect(await h.repo.read()).toMatchObject({ status: 'ok', record: { state: 'switched', revision: 1 } });
  });

  it('retire refuses retirement-ledger-absent when readRetirementLedger is omitted', async () => {
    const h = await harness();
    const { readRetirementLedger: _omitted, ...rest } = h.deps;
    void _omitted;
    const useCase = new ManageCutoverUseCase(rest);
    resetSpies(h);
    expect(await useCase.execute(retireRequest({ nowIso: AFTER_WINDOW_NOW }))).toEqual({
      outcome: 'refused',
      reason: 'retirement-ledger-absent',
    });
    expect(totalWriteCalls(h)).toBe(0);
  });

  it('retire refuses retirement-ledger-absent when ledger is absent', async () => {
    const h = await harness();
    const useCase = useCaseWithReaders(h, {
      readRetirementLedger: async () => ({ status: 'absent' }),
    });
    expect(await useCase.execute(retireRequest({ nowIso: AFTER_WINDOW_NOW }))).toEqual({
      outcome: 'refused',
      reason: 'retirement-ledger-absent',
    });
    expect(totalWriteCalls(h)).toBe(0);
    expect(await journalEntries(h, 'cutover/retire@1')).toHaveLength(0);
  });

  it('retire refuses retirement-ledger-failed on empty or unverified ledger', async () => {
    for (const ledger of [
      { schemaVersion: 1, rows: [] },
      validRetirementLedger({ 0: { verified: false } }),
      validRetirementLedger({ 0: { evidenceLink: '' } }),
    ]) {
      const h = await harness();
      const useCase = useCaseWithReaders(h, { readRetirementLedger: async () => ({ status: 'ok', ledger }) });
      expect(await useCase.execute(retireRequest({ nowIso: AFTER_WINDOW_NOW }))).toEqual({
        outcome: 'refused',
        reason: 'retirement-ledger-failed',
      });
      expect(totalWriteCalls(h)).toBe(0);
      expect(await journalEntries(h, 'cutover/retire@1')).toHaveLength(0);
    }
  });

  it('retire returns unknown retirement-ledger-unreadable on malformed, incomplete, or secret-shaped ledger', async () => {
    for (const ledger of [
      { schemaVersion: 1, rows: ['nope'] },
      // Missing one §1 script row.
      { schemaVersion: 1, rows: validRetirementLedger().rows.slice(1) },
      // An extra script row that is not part of the inventory.
      {
        schemaVersion: 1,
        rows: [...validRetirementLedger().rows, { script: 'train/extra.sh', verified: true, evidenceLink: 'e' }],
      },
      // A duplicated row.
      {
        schemaVersion: 1,
        rows: [...validRetirementLedger().rows.slice(0, -1), validRetirementLedger().rows[0]],
      },
      // Over-long text.
      validRetirementLedger({ 0: { evidenceLink: 'e'.repeat(257) } }),
      // Secret-shaped text.
      validRetirementLedger({ 0: { evidenceLink: LANE_ONLY_SECRET } }),
    ]) {
      const h = await harness();
      const useCase = useCaseWithReaders(h, { readRetirementLedger: async () => ({ status: 'ok', ledger }) });
      expect(await useCase.execute(retireRequest({ nowIso: AFTER_WINDOW_NOW }))).toEqual({
        outcome: 'unknown',
        reason: 'retirement-ledger-unreadable',
      });
      expect(totalWriteCalls(h)).toBe(0);
      expect(await journalEntries(h, 'cutover/retire@1')).toHaveLength(0);
    }
  });

  it('retire returns unknown retirement-ledger-unreadable when reader reports unreadable or throws', async () => {
    const unreadable = await harness();
    expect(
      await useCaseWithReaders(unreadable, { readRetirementLedger: async () => ({ status: 'unreadable' }) }).execute(
        retireRequest({ nowIso: AFTER_WINDOW_NOW }),
      ),
    ).toEqual({ outcome: 'unknown', reason: 'retirement-ledger-unreadable' });
    const threw = await harness();
    expect(
      await useCaseWithReaders(threw, {
        readRetirementLedger: async () => {
          throw new Error('boom');
        },
      }).execute(retireRequest({ nowIso: AFTER_WINDOW_NOW })),
    ).toEqual({ outcome: 'unknown', reason: 'retirement-ledger-unreadable' });
    expect(totalWriteCalls(unreadable)).toBe(0);
    expect(totalWriteCalls(threw)).toBe(0);
  });

  it('retire returns unknown retirement-ledger-unknown-version on newer schemaVersion', async () => {
    const h = await harness();
    const useCase = useCaseWithReaders(h, {
      readRetirementLedger: async () => ({ status: 'unknown-version' }),
    });
    expect(await useCase.execute(retireRequest({ nowIso: AFTER_WINDOW_NOW }))).toEqual({
      outcome: 'unknown',
      reason: 'retirement-ledger-unknown-version',
    });
    const domain = useCaseWithReaders(h, {
      readRetirementLedger: async () => ({ status: 'ok', ledger: { schemaVersion: 2, rows: [] } }),
    });
    expect(await domain.execute(retireRequest({ nowIso: AFTER_WINDOW_NOW }))).toEqual({
      outcome: 'unknown',
      reason: 'retirement-ledger-unknown-version',
    });
    expect(totalWriteCalls(h)).toBe(0);
    expect(await journalEntries(h, 'cutover/retire@1')).toHaveLength(0);
  });

  it('retire returns unknown deadline-exceeded before reading retirement ledger when deadline is past', async () => {
    const h = await harness();
    let read = 0;
    const useCase = useCaseWithReaders(h, {
      readRetirementLedger: async () => {
        read += 1;
        return { status: 'ok', ledger: validRetirementLedger() };
      },
    });
    expect(await useCase.execute(retireRequest({ nowIso: AFTER_WINDOW_NOW, deadlineIso: EARLIER_DEADLINE }))).toEqual({
      outcome: 'unknown',
      reason: 'deadline-exceeded',
    });
    expect(read).toBe(0);
    expect(totalWriteCalls(h)).toBe(0);
  });

  it('retire returns unknown deadline-exceeded when the deadline is reached during the ledger read', async () => {
    const h = await harness();
    h.clock.now = SWITCHED_AT;
    let read = 0;
    const useCase = useCaseWithReaders(h, {
      readRetirementLedger: async () => {
        read += 1;
        h.clock.now = EARLIER_DEADLINE;
        return { status: 'ok', ledger: validRetirementLedger() };
      },
    });
    // The gate itself must fail the pass: the ledger read may not hand a
    // deadline reached during reading to the steps after it.
    const intentSpy = vi.spyOn(
      useCase as unknown as {
        appendIntentUnlessRecorded: (...args: unknown[]) => Promise<unknown>,
      },
      'appendIntentUnlessRecorded',
    );
    expect(await useCase.execute(retireRequest({ nowIso: AFTER_WINDOW_NOW, deadlineIso: EARLIER_DEADLINE }))).toEqual({
      outcome: 'unknown',
      reason: 'deadline-exceeded',
    });
    expect(read).toBe(1);
    expect(intentSpy).not.toHaveBeenCalled();
    expect(totalWriteCalls(h)).toBe(0);
    expect(await journalEntries(h, 'cutover/retire@1')).toHaveLength(0);
  });

  it('readRetirementLedger refuses every malformed ledger shape', () => {
    const valid = validRetirementLedger();
    expect(readRetirementLedger(valid)).toEqual({ ok: true, ledger: valid });
    expect(readRetirementLedger({ schemaVersion: 1, rows: [] })).toEqual({ ok: false, reason: 'empty-ledger' });
    expect(readRetirementLedger({ schemaVersion: 1, rows: valid.rows.slice(1) })).toEqual({ ok: false, reason: 'invalid-ledger' });
    expect(readRetirementLedger({ schemaVersion: 2, rows: [] })).toEqual({ ok: false, reason: 'unknown-version' });
    expect(readRetirementLedger({ schemaVersion: 1, rows: [] , extra: 1 })).toEqual({ ok: false, reason: 'invalid-ledger' });
    expect(readRetirementLedger('nope')).toEqual({ ok: false, reason: 'invalid-ledger' });
    expect(readRetirementLedger({ schemaVersion: 1, rows: valid.rows.map((row) => ({ ...row, verified: false })) })).toEqual({
      ok: false,
      reason: 'row-unverified',
    });
    expect(readRetirementLedger({ schemaVersion: 1, rows: valid.rows.map((row, i) => i === 0 ? { ...row, evidenceLink: LANE_ONLY_SECRET } : row) })).toEqual({
      ok: false,
      reason: 'secret-shaped',
    });
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
