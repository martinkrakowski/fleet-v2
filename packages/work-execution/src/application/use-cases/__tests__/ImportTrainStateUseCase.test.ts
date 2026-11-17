// Lane CO5: import of the legacy shell merge-train state.
import { describe, expect, it } from 'vitest';

import { MergeQueueRepositoryAdapter } from '../../../infrastructure/adapters/MergeQueueRepositoryAdapter.adapter.js';
import type { LegacyTrainStateRead, LegacyTrainStateReadPort } from '../../ports/out/LegacyTrainStateReadPort.out-port.js';
import { ImportTrainStateUseCase } from '../ImportTrainStateUseCase.use-case.js';

const REPO = { owner: 'fleet', repo: 'v2' };
const HEAD_A = '0123456789abcdef0123456789abcdef01234567';
const HEAD_B = '0123456789abcdef0123456789abcdef01234568';
const MAIN_A = `42 ${HEAD_A} main`;
const MAIN_B = `7 ${HEAD_B} main`;
const CHAIN_LINE = `9 ${'c'.repeat(40)} chain/example-1`;

/** Successive ULID literals matching /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/. */
function createMintUlid(): () => string {
  let sequence = 0;
  return () => {
    const suffix = String(sequence).padStart(2, '0');
    sequence += 1;
    return `01ARZ3NDEKTSV4RRFFAT69F9${suffix}`;
  };
}

const mintUlid = createMintUlid();
const nowIso = (): string => new Date().toISOString();
const futureDeadline = (): string => new Date(Date.now() + 60_000).toISOString();

class FakeLegacyTrainStateReadPort implements LegacyTrainStateReadPort {
  calls = 0;

  constructor(private readonly state: LegacyTrainStateRead) {}

  async readLegacyTrainState(): Promise<LegacyTrainStateRead> {
    this.calls += 1;
    return this.state;
  }
}

function readState(queueLines: string[], overrides: Partial<LegacyTrainStateRead> = {}): LegacyTrainStateRead {
  return {
    queue: { status: 'read', lines: queueLines },
    parked: { status: 'read', lines: [] },
    chains: { status: 'read', chains: [] },
    batch: { status: 'read', lines: [] },
    inprogress: { status: 'read', lines: [] },
    ...overrides,
  };
}

/** The report shape every non-refused result now carries; `keys` varies by fixture. */
function emptyReportExtras(keys: readonly unknown[] = []): Record<string, unknown> {
  return {
    inprogressLines: 0,
    unknownBySource: { queue: [], parked: [], inprogress: [] },
    keys,
    keysTruncated: false,
  };
}

function keyFor(
  pullRequest: number,
  headOid: string,
  base: string,
  disposition: 'would-import' | 'already-queued' | 'not-importable-base' | 'legacy-in-progress',
  source: 'queue' | 'parked' | 'inprogress' = 'queue',
): Record<string, unknown> {
  return { pullRequest, headOid, base, source, disposition };
}

function makeUseCase(reader: LegacyTrainStateReadPort, queue: MergeQueueRepositoryAdapter): ImportTrainStateUseCase {
  return new ImportTrainStateUseCase({
    legacyState: reader,
    queue,
    mintUlid,
    nowIso,
  });
}

describe('ImportTrainStateUseCase', () => {
  it('dry-run writes nothing', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A, MAIN_B]));
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: false,
      authority: null,
    });

    expect(result).toEqual({
      outcome: 'dry-run',
      wouldImport: 2,
      unknownLineNumbers: [],
      notImportableBase: 0,
      alreadyQueued: 0,
      parkedLines: 0,
      chainFiles: 0,
      batchLines: 0,
      ...emptyReportExtras([keyFor(42, HEAD_A, 'main', 'would-import'), keyFor(7, HEAD_B, 'main', 'would-import')]),
    });
    expect(await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() })).toEqual([]);
  });

  it('dry-run counts what is already queued', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    await queue.enqueueMergeEntry({
      repository: REPO,
      pullRequest: 42,
      headOid: HEAD_A,
      tier: 2,
      enqueuedBy: 'cli',
      runId: null,
      entryId: mintUlid(),
      successorEntryId: mintUlid(),
      enqueuedAtIso: nowIso(),
      deadlineIso: futureDeadline(),
    });
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A, MAIN_B]));
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: false,
      authority: null,
    });

    expect(result).toEqual({
      outcome: 'dry-run',
      wouldImport: 1,
      unknownLineNumbers: [],
      notImportableBase: 0,
      alreadyQueued: 1,
      parkedLines: 0,
      chainFiles: 0,
      batchLines: 0,
      ...emptyReportExtras([
        keyFor(42, HEAD_A, 'main', 'already-queued'),
        keyFor(7, HEAD_B, 'main', 'would-import'),
      ]),
    });
  });

  it('apply creates queued entries idempotently', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A, MAIN_B]));
    const useCase = makeUseCase(reader, queue);
    const request = { repository: REPO, stateDir: '/tmp/legacy', apply: true, authority: 'owner-grant-1' } as const;

    const first = await useCase.importTrainState(request);
    expect(first).toEqual({
      outcome: 'applied',
      imported: 2,
      refused: 0,
      unknownLineNumbers: [],
      notImportableBase: 0,
      alreadyQueued: 0,
      parkedLines: 0,
      chainFiles: 0,
      batchLines: 0,
      ...emptyReportExtras([keyFor(42, HEAD_A, 'main', 'would-import'), keyFor(7, HEAD_B, 'main', 'would-import')]),
    });

    const entries = await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() });
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.state).toBe('queued');
      expect(entry.enqueuedBy).toBe('cli');
      expect(entry.tier).toBe(2);
      expect(entry.reason).toBeNull();
    }

    const second = await useCase.importTrainState(request);
    expect(second).toEqual({
      outcome: 'applied',
      imported: 0,
      refused: 0,
      unknownLineNumbers: [],
      notImportableBase: 0,
      alreadyQueued: 2,
      parkedLines: 0,
      chainFiles: 0,
      batchLines: 0,
      ...emptyReportExtras([
        keyFor(42, HEAD_A, 'main', 'already-queued'),
        keyFor(7, HEAD_B, 'main', 'already-queued'),
      ]),
    });
    expect(await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() })).toHaveLength(2);
  });

  it('apply dedupes identical queue lines into one import', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A, MAIN_A]));
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      authority: 'owner-grant-1',
    });

    expect(result).toEqual({
      outcome: 'applied',
      imported: 1,
      refused: 0,
      unknownLineNumbers: [],
      notImportableBase: 0,
      alreadyQueued: 0,
      parkedLines: 0,
      chainFiles: 0,
      batchLines: 0,
      ...emptyReportExtras(),
      keys: [
        {
          pullRequest: 42,
          headOid: HEAD_A,
          base: 'main',
          source: 'queue',
          disposition: 'would-import',
        },
      ],
    });
    expect(await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() })).toHaveLength(1);
  });

  it('apply without authority is refused before anything is read or written', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      authority: null,
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'authority-required' });
    expect(reader.calls).toBe(0);
    expect(await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() })).toEqual([]);
  });

  it('unknown lines are reported by number only', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const garbage = 'NOT-A-QUEUE-LINE';
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A, garbage]));
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: false,
      authority: null,
    });

    expect(result).toMatchObject({ outcome: 'dry-run', wouldImport: 1, unknownLineNumbers: [2] });
    expect(JSON.stringify(result)).not.toContain(garbage);
  });

  it('secret-shaped queue file refuses wholesale', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const secret = `gh${'p_'}${'A'.repeat(30)}`;
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A, secret]));
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: false,
      authority: null,
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'secret-shaped' });
    expect(await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() })).toEqual([]);
  });

  it('chain-based lines are reported, never imported', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A, CHAIN_LINE]));
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      authority: 'owner-grant-1',
    });

    expect(result).toEqual({
      outcome: 'applied',
      imported: 1,
      refused: 0,
      unknownLineNumbers: [],
      notImportableBase: 1,
      alreadyQueued: 0,
      parkedLines: 0,
      chainFiles: 0,
      batchLines: 0,
      ...emptyReportExtras(),
      keys: [
        {
          pullRequest: 42,
          headOid: HEAD_A,
          base: 'main',
          source: 'queue',
          disposition: 'would-import',
        },
        {
          pullRequest: 9,
          headOid: 'c'.repeat(40),
          base: 'chain/example-1',
          source: 'queue',
          disposition: 'not-importable-base',
        },
      ],
    });
    const entries = await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.pullRequest).toBe(42);
    expect(entries[0]!.headOid).toBe(HEAD_A);
  });

  it('unreadable sources refuse the import wholesale', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(
      readState([], {
        queue: { status: 'unreadable' },
      }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      authority: 'owner-grant-1',
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'legacy-unreadable' });
    expect(await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() })).toEqual([]);
  });

  it('invalid requests refuse with codes', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([]));
    const useCase = makeUseCase(reader, queue);

    const badRepo = await useCase.importTrainState({
      repository: { owner: '.', repo: 'v2' },
      stateDir: '/tmp/legacy',
      apply: false,
      authority: null,
    });
    expect(badRepo).toEqual({ outcome: 'refused', reason: 'invalid-repository' });

    const badDir = await useCase.importTrainState({
      repository: REPO,
      stateDir: '',
      apply: false,
      authority: null,
    });
    expect(badDir).toEqual({ outcome: 'refused', reason: 'invalid-state-dir' });
  });

  it('a parked-only PR is listed as would-import with source parked', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(
      readState([], { parked: { status: 'read', lines: [`7 ${HEAD_B} main`] } }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: false,
      authority: null,
    });

    expect(result).toMatchObject({ outcome: 'dry-run', wouldImport: 1, parkedLines: 1 });
    expect(result.outcome === 'dry-run' && result.keys).toEqual([
      { pullRequest: 7, headOid: HEAD_B, base: 'main', source: 'parked', disposition: 'would-import' },
    ]);
  });

  it('an in-progress-only PR is an import candidate with source inprogress', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(
      readState([], { inprogress: { status: 'read', lines: [`7 ${HEAD_B} main`] } }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      authority: 'owner-grant-1',
    });

    expect(result).toMatchObject({ outcome: 'applied', imported: 1, inprogressLines: 1 });
    expect(result.outcome === 'applied' && result.keys).toEqual([
      { pullRequest: 7, headOid: HEAD_B, base: 'main', source: 'inprogress', disposition: 'would-import' },
    ]);
    const entries = await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.pullRequest).toBe(7);
    expect(entries[0]!.headOid).toBe(HEAD_B);
  });

  it('a pair in both queue and inprogress is legacy-in-progress, source queue wins, and apply never enqueues it', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(
      readState([MAIN_B], { inprogress: { status: 'read', lines: [MAIN_B] } }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      authority: 'owner-grant-1',
    });

    // The legacy shell train is actively merging this PR right now (it is
    // live in BOTH the queue and the in-progress file): it must never be
    // reported as an ordinary would-import candidate, and apply must never
    // enqueue it alongside whatever the legacy train is doing.
    expect(result).toMatchObject({ outcome: 'applied', imported: 0 });
    expect(result.outcome === 'applied' && result.keys).toEqual([
      { pullRequest: 7, headOid: HEAD_B, base: 'main', source: 'queue', disposition: 'legacy-in-progress' },
    ]);
    const entries = await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() });
    expect(entries).toHaveLength(0);
  });

  it('a pair in inprogress only (no queue) is unaffected: still would-import', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(
      readState([], { inprogress: { status: 'read', lines: [MAIN_B] } }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      authority: 'owner-grant-1',
    });

    expect(result).toMatchObject({ outcome: 'applied', imported: 1 });
    expect(result.outcome === 'applied' && result.keys).toEqual([
      { pullRequest: 7, headOid: HEAD_B, base: 'main', source: 'inprogress', disposition: 'would-import' },
    ]);
    const entries = await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() });
    expect(entries).toHaveLength(1);
  });

  it('a pair in queue only (no inprogress) is unaffected: still would-import', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_B]));
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      authority: 'owner-grant-1',
    });

    expect(result).toMatchObject({ outcome: 'applied', imported: 1 });
    expect(result.outcome === 'applied' && result.keys).toEqual([
      { pullRequest: 7, headOid: HEAD_B, base: 'main', source: 'queue', disposition: 'would-import' },
    ]);
    const entries = await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() });
    expect(entries).toHaveLength(1);
  });

  it('a pair in both queue and parked is one key whose source is queue', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(
      readState([MAIN_B], { parked: { status: 'read', lines: [MAIN_B] } }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: false,
      authority: null,
    });

    expect(result).toMatchObject({ outcome: 'dry-run', wouldImport: 1 });
    expect(result.outcome === 'dry-run' && result.keys).toEqual([
      { pullRequest: 7, headOid: HEAD_B, base: 'main', source: 'queue', disposition: 'would-import' },
    ]);
  });

  it('the same PR and head on two different bases across sources still dedupes to one key', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const chainLine = `7 ${HEAD_B} chain/foo`;
    const reader = new FakeLegacyTrainStateReadPort(
      readState([chainLine], { parked: { status: 'read', lines: [MAIN_B] } }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: false,
      authority: null,
    });

    // The queue entry (chain/foo) and the parked entry (main) share the same
    // (pullRequest, headOid) pair, so base must not split them into two
    // candidates: exactly one key results, and the earlier source (queue)
    // wins per the source-order rule, carrying its own base through.
    expect(result).toMatchObject({ outcome: 'dry-run', wouldImport: 0, notImportableBase: 1 });
    expect(result.outcome === 'dry-run' && result.keys).toEqual([
      { pullRequest: 7, headOid: HEAD_B, base: 'chain/foo', source: 'queue', disposition: 'not-importable-base' },
    ]);
  });

  it('a parked or in-progress entry on a chain base is not importable', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(
      readState([], {
        parked: { status: 'read', lines: [CHAIN_LINE] },
        inprogress: { status: 'read', lines: [`11 ${'d'.repeat(40)} chain/other`] },
      }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: false,
      authority: null,
    });

    expect(result).toMatchObject({ outcome: 'dry-run', wouldImport: 0, notImportableBase: 2 });
    expect(result.outcome === 'dry-run' && result.keys).toEqual([
      { pullRequest: 11, headOid: 'd'.repeat(40), base: 'chain/other', source: 'inprogress', disposition: 'not-importable-base' },
      { pullRequest: 9, headOid: 'c'.repeat(40), base: 'chain/example-1', source: 'parked', disposition: 'not-importable-base' },
    ]);
  });

  it('501 distinct keys are capped at 500 with keysTruncated', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const many = Array.from({ length: 501 }, (_, i) => `${100 + i} ${String(i).padStart(40, '0')} main`);
    const reader = new FakeLegacyTrainStateReadPort(readState(many));
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: false,
      authority: null,
    });

    expect(result).toMatchObject({ outcome: 'dry-run', wouldImport: 501, keysTruncated: true });
    if (result.outcome !== 'dry-run') {
      throw new Error('expected dry-run');
    }
    expect(result.keys).toHaveLength(500);
    expect(result.keys[0]).toEqual({
      pullRequest: 100,
      headOid: '0'.repeat(40),
      base: 'main',
      source: 'queue',
      disposition: 'would-import',
    });
    expect(result.keys[499]).toMatchObject({ pullRequest: 599 });
  });

  it('a missing inprogress state refuses legacy-unreadable', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const state = readState([MAIN_A]);
    delete (state as { inprogress?: unknown }).inprogress;
    const reader = new FakeLegacyTrainStateReadPort(state);
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: false,
      authority: null,
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'legacy-unreadable' });
    expect(await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() })).toEqual([]);
  });

  it('an unreadable inprogress state refuses legacy-unreadable', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(
      readState([MAIN_A], { inprogress: { status: 'unreadable' } }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      authority: 'owner-grant-1',
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'legacy-unreadable' });
    expect(await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() })).toEqual([]);
  });

  it('a secret-shaped line in parked or inprogress refuses wholesale', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const secret = `gh${'p_'}${'A'.repeat(30)}`;
    const useCase = makeUseCase(
      new FakeLegacyTrainStateReadPort(readState([MAIN_A], { parked: { status: 'read', lines: [secret] } })),
      queue,
    );
    const parkedRefusal = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: false,
      authority: null,
    });
    expect(parkedRefusal).toEqual({ outcome: 'refused', reason: 'secret-shaped' });

    const inprogressRefusal = await makeUseCase(
      new FakeLegacyTrainStateReadPort(readState([MAIN_A], { inprogress: { status: 'read', lines: [secret] } })),
      new MergeQueueRepositoryAdapter(),
    ).importTrainState({ repository: REPO, stateDir: '/tmp/legacy', apply: false, authority: null });
    expect(inprogressRefusal).toEqual({ outcome: 'refused', reason: 'secret-shaped' });
  });

  it('apply imports a parked entry once, then reports it already-queued', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(
      readState([MAIN_A], { parked: { status: 'read', lines: [`7 ${HEAD_B} main`] } }),
    );
    const useCase = makeUseCase(reader, queue);
    const request = { repository: REPO, stateDir: '/tmp/legacy', apply: true, authority: 'owner-grant-1' } as const;

    const first = await useCase.importTrainState(request);
    expect(first).toMatchObject({ outcome: 'applied', imported: 2 });
    const entries = await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() });
    expect(entries).toHaveLength(2);
    expect(entries.some((entry) => entry.pullRequest === 7 && entry.headOid === HEAD_B)).toBe(true);

    const second = await useCase.importTrainState(request);
    expect(second).toMatchObject({ outcome: 'applied', imported: 0, alreadyQueued: 2 });
    expect(second.outcome === 'applied' && second.keys).toEqual([
      { pullRequest: 42, headOid: HEAD_A, base: 'main', source: 'queue', disposition: 'already-queued' },
      { pullRequest: 7, headOid: HEAD_B, base: 'main', source: 'parked', disposition: 'already-queued' },
    ]);
    expect(await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() })).toHaveLength(2);
  });

  it('unknownBySource reports each source independently', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const garbage = 'NOT-A-QUEUE-LINE';
    const reader = new FakeLegacyTrainStateReadPort(
      readState([MAIN_A, garbage], {
        parked: { status: 'read', lines: [`7 ${HEAD_B} main`, garbage] },
        inprogress: { status: 'read', lines: [garbage] },
      }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: false,
      authority: null,
    });

    expect(result).toMatchObject({ outcome: 'dry-run', wouldImport: 2 });
    expect(result.outcome === 'dry-run' && result.unknownBySource).toEqual({
      queue: [2],
      parked: [2],
      inprogress: [1],
    });
    expect(result.outcome === 'dry-run' && result.unknownLineNumbers).toEqual([2]);
  });
});
