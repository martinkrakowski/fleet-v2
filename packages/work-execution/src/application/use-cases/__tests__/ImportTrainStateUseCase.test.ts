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
    ...overrides,
  };
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
    });
    expect(await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() })).toHaveLength(2);
  });

  it('apply counts a store duplicate the snapshot missed as alreadyQueued', async () => {
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
      alreadyQueued: 1,
      parkedLines: 0,
      chainFiles: 0,
      batchLines: 0,
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
});
