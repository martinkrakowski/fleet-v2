// Lane CO5: import of the legacy shell merge-train state.
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { MergeQueueRepositoryAdapter } from '../../../infrastructure/adapters/MergeQueueRepositoryAdapter.adapter.js';
import { CutoverJournalAdapter } from '../../../infrastructure/adapters/CutoverJournalAdapter.adapter.js';
import type {
  ActionAuthorizationPort,
  AuthorizeShadowImportRequest,
  AuthorizeShadowImportResult,
} from '../../ports/out/ActionAuthorizationPort.out-port.js';
import type { CutoverJournalAppendResult, CutoverJournalEntry, CutoverJournalPort } from '../../ports/out/CutoverJournalPort.out-port.js';
import type { LegacyTrainStateRead, LegacyTrainStateReadPort } from '../../ports/out/LegacyTrainStateReadPort.out-port.js';
import type { MergeQueueEntryRecord } from '../../../domain/merge-queue-records.js';
import type { MergeQueueListQuery, MergeQueueRepositoryPort } from '../../ports/out/MergeQueueRepositoryPort.out-port.js';
import { ImportTrainStateUseCase, validateImportTrainStateRequest } from '../ImportTrainStateUseCase.use-case.js';

const REPO = { owner: 'fleet', repo: 'v2' };
const GRANT_ID = 'shadow-grant-0001';
const PROJECT_ID = 'project-1';
const GRANT_DIGEST = 'a'.repeat(64);
const HEAD_A = '0123456789abcdef0123456789abcdef01234567';
const HEAD_B = '0123456789abcdef0123456789abcdef01234568';
const MAIN_A = `42 ${HEAD_A} main`;
const MAIN_B = `7 ${HEAD_B} main`;
const CHAIN_LINE = `9 ${'c'.repeat(40)} chain/example-1`;
// Real shell parked records (SH4d): `pr head reason attempt notBefore base`.
// notBefore is the shell's epoch-seconds now(), never an ISO timestamp.
const PARKED_B = `7 ${HEAD_B} flaky-tests 2 1000 main`;
const PARKED_CHAIN = `9 ${'c'.repeat(40)} chain-conflict 2 1000 chain/example-1`;

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

  constructor(
    private readonly state: LegacyTrainStateRead,
    private readonly log?: string[],
  ) {}

  async readLegacyTrainState(): Promise<LegacyTrainStateRead> {
    this.calls += 1;
    this.log?.push('read-legacy');
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

function makeUseCase(
  reader: LegacyTrainStateReadPort,
  queue: MergeQueueRepositoryAdapter,
  overrides: {
    readonly authorization?: ActionAuthorizationPort;
    readonly journal?: CutoverJournalPort;
    readonly computeDigest?: (payload: string) => string;
    readonly nowIso?: () => string;
    readonly mintUlid?: () => string;
  } = {},
): ImportTrainStateUseCase {
  // An explicitly absent dependency (key present with `undefined`) means the
  // use case really gets none — that is how the `journal-unavailable` and
  // `authorization-unavailable` paths are tested.
  const has = <K extends keyof typeof overrides>(key: K): boolean => key in overrides;
  const defaultAuthorization: ActionAuthorizationPort = {
    authorizeShadowImport: async () => ({ outcome: 'authorized', grantId: GRANT_ID }),
  } as unknown as ActionAuthorizationPort;
  return new ImportTrainStateUseCase({
    legacyState: reader,
    queue,
    mintUlid,
    nowIso,
    authorization: has('authorization') ? overrides.authorization : defaultAuthorization,
    journal: has('journal') ? overrides.journal : new CutoverJournalAdapter(),
    computeDigest: has('computeDigest') ? overrides.computeDigest : (() => GRANT_DIGEST),
    ...(has('nowIso') ? { nowIso: overrides.nowIso } : {}),
    ...(has('mintUlid') ? { mintUlid: overrides.mintUlid } : {}),
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
    const request = { repository: REPO, stateDir: '/tmp/legacy', apply: true, grantId: GRANT_ID, projectId: PROJECT_ID } as const;

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
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
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

  it('apply without projectId refuses before anything is read or written', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      grantId: GRANT_ID,
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'project-required' });
    expect(reader.calls).toBe(0);
    expect(await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() })).toEqual([]);
  });

  it('apply without grantId refuses before anything is read or written', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      projectId: PROJECT_ID,
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'grant-missing' });
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
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
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
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
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
    });
    expect(badRepo).toEqual({ outcome: 'refused', reason: 'invalid-repository' });

    const badDir = await useCase.importTrainState({
      repository: REPO,
      stateDir: '',
      apply: false,
    });
    expect(badDir).toEqual({ outcome: 'refused', reason: 'invalid-state-dir' });
  });

  it('a parked-only PR is listed as would-import with source parked', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(
      readState([], { parked: { status: 'read', lines: [PARKED_B] } }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: false,
    });

    expect(result).toMatchObject({ outcome: 'dry-run', wouldImport: 1, parkedLines: 1 });
    expect(result.outcome === 'dry-run' && result.keys).toEqual([
      { pullRequest: 7, headOid: HEAD_B, base: 'main', source: 'parked', disposition: 'would-import' },
    ]);
  });

  it('an in-progress-only PR is legacy-in-progress, with source inprogress, and apply never enqueues it', async () => {
    // The real shell (tick.sh) MOVES a line from queue to inprogress when a pass starts, rather than
    // duplicating it into both: a PR the legacy train is actively merging normally appears in
    // inprogress ALONE. That must still be legacy-in-progress, never an ordinary would-import
    // candidate — queue+inprogress together is only a rare crash-leftover case, not the normal one.
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(
      readState([], { inprogress: { status: 'read', lines: [`7 ${HEAD_B} main`] } }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
    });

    expect(result).toMatchObject({ outcome: 'applied', imported: 0, inprogressLines: 1 });
    expect(result.outcome === 'applied' && result.keys).toEqual([
      { pullRequest: 7, headOid: HEAD_B, base: 'main', source: 'inprogress', disposition: 'legacy-in-progress' },
    ]);
    const entries = await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() });
    expect(entries).toHaveLength(0);
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
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
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

  it('a pair in inprogress only (no queue) is still legacy-in-progress: the normal case, not the rare one', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(
      readState([], { inprogress: { status: 'read', lines: [MAIN_B] } }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
    });

    expect(result).toMatchObject({ outcome: 'applied', imported: 0 });
    expect(result.outcome === 'applied' && result.keys).toEqual([
      { pullRequest: 7, headOid: HEAD_B, base: 'main', source: 'inprogress', disposition: 'legacy-in-progress' },
    ]);
    const entries = await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() });
    expect(entries).toHaveLength(0);
  });

  it('a PR with two different heads, one queued and one in progress, disposes BOTH keys legacy-in-progress', async () => {
    // enqueue.sh only refuses a second queue line for a PR NUMBER already in the queue file; it never
    // checks inprogress. So a PR can get a fresh queue line (a new push) while its older head is still
    // in progress: same PR, two distinct (pullRequest, headOid) pairs. The hazard must be checked by PR
    // number alone, or the new-head queue entry would slip through as would-import.
    const queue = new MergeQueueRepositoryAdapter();
    const queueLine = `7 ${HEAD_A} main`; // PR 7, a new head, freshly re-enqueued
    const inProgressLine = `7 ${HEAD_B} main`; // PR 7, the older head the legacy shell is still merging
    const reader = new FakeLegacyTrainStateReadPort(
      readState([queueLine], { inprogress: { status: 'read', lines: [inProgressLine] } }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
    });

    expect(result).toMatchObject({ outcome: 'applied', imported: 0 });
    expect(result.outcome === 'applied' && result.keys).toEqual([
      { pullRequest: 7, headOid: HEAD_A, base: 'main', source: 'queue', disposition: 'legacy-in-progress' },
      { pullRequest: 7, headOid: HEAD_B, base: 'main', source: 'inprogress', disposition: 'legacy-in-progress' },
    ]);
    const entries = await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() });
    expect(entries).toHaveLength(0);
  });

  it('a pair in queue only (no inprogress) is unaffected: still would-import', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_B]));
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
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
      readState([MAIN_B], { parked: { status: 'read', lines: [PARKED_B] } }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: false,
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
      readState([chainLine], { parked: { status: 'read', lines: [PARKED_B] } }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: false,
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
        parked: { status: 'read', lines: [PARKED_CHAIN] },
        inprogress: { status: 'read', lines: [`11 ${'d'.repeat(40)} chain/other`] },
      }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: false,
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
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
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
    });
    expect(parkedRefusal).toEqual({ outcome: 'refused', reason: 'secret-shaped' });

    const inprogressRefusal = await makeUseCase(
      new FakeLegacyTrainStateReadPort(readState([MAIN_A], { inprogress: { status: 'read', lines: [secret] } })),
      new MergeQueueRepositoryAdapter(),
    ).importTrainState({ repository: REPO, stateDir: '/tmp/legacy', apply: false });
    expect(inprogressRefusal).toEqual({ outcome: 'refused', reason: 'secret-shaped' });
  });

  it('apply imports a parked entry once, then reports it already-queued', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(
      readState([MAIN_A], { parked: { status: 'read', lines: [PARKED_B] } }),
    );
    const useCase = makeUseCase(reader, queue);
    const request = { repository: REPO, stateDir: '/tmp/legacy', apply: true, grantId: GRANT_ID, projectId: PROJECT_ID } as const;

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
        parked: { status: 'read', lines: [PARKED_B, garbage] },
        inprogress: { status: 'read', lines: [garbage] },
      }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: false,
    });

    expect(result).toMatchObject({ outcome: 'dry-run', wouldImport: 2 });
    expect(result.outcome === 'dry-run' && result.unknownBySource).toEqual({
      queue: [2],
      parked: [2],
      inprogress: [1],
    });
    expect(result.outcome === 'dry-run' && result.unknownLineNumbers).toEqual([2]);
  });

  it('a real 6-field parked line imports with its disposition and persisted entry', async () => {
    // The real shell parked file is `pr head reason attempt notBefore base`
    // (tick.sh). Before SH4f this use case parsed it with the 3-field queue
    // parser, so every real parked line was an unknown line and never an
    // import candidate. The extra reason/attempt/notBefore fields are parsed
    // and validated but the shared import logic needs only pr/head/base.
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(
      readState([], { parked: { status: 'read', lines: [PARKED_B] } }),
    );
    const useCase = makeUseCase(reader, queue);

    const dryRun = await useCase.importTrainState({ repository: REPO, stateDir: '/tmp/legacy', apply: false });
    expect(dryRun).toMatchObject({ outcome: 'dry-run', wouldImport: 1, unknownBySource: { parked: [] } });
    expect(dryRun.outcome === 'dry-run' && dryRun.keys).toEqual([
      { pullRequest: 7, headOid: HEAD_B, base: 'main', source: 'parked', disposition: 'would-import' },
    ]);

    const applied = await useCase.importTrainState({ repository: REPO, stateDir: '/tmp/legacy', apply: true, grantId: GRANT_ID, projectId: PROJECT_ID });
    expect(applied).toMatchObject({ outcome: 'applied', imported: 1 });
    const entries = await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ pullRequest: 7, headOid: HEAD_B });
  });

  it('a parked line with any one of its 6 fields wrong is an unknown parked line', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(
      readState([], {
        parked: {
          status: 'read',
          lines: [
            `0x7 ${HEAD_B} reason 1 1000 main`, // bad pr
            `7 nothex40 reason 1 1000 main`, // bad head
            `7 ${HEAD_B} ${'r'.repeat(129)} 1 1000 main`, // reason over 128 chars
            `7 ${HEAD_B} reason -1 1000 main`, // bad attempt
            `7 ${HEAD_B} reason 1 2026-11-17T00:00:00Z main`, // notBefore is epoch seconds, never ISO
            `7 ${HEAD_B} reason 1 1000 chain/Bad`, // bad base
            `7 ${HEAD_B} reason 1 1000`, // only 5 fields
            `7 ${HEAD_B} reason 1 1000 main extra`, // 7 fields
            `7 ${HEAD_B} main`, // the old 3-field queue shape is NOT a parked record
          ],
        },
      }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({ repository: REPO, stateDir: '/tmp/legacy', apply: false });
    expect(result).toMatchObject({ outcome: 'dry-run', wouldImport: 0 });
    expect(result.outcome === 'dry-run' && result.unknownBySource).toEqual({
      queue: [],
      inprogress: [],
      parked: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    });
    expect(result.outcome === 'dry-run' && result.keys).toEqual([]);
  });

  it('a parked entry sharing a pair with an inprogress entry dedupes with source inprogress', async () => {
    // Source-order rule from SH4c: queue > inprogress > parked wins.
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(
      readState([], {
        inprogress: { status: 'read', lines: [`7 ${HEAD_B} main`] },
        parked: { status: 'read', lines: [PARKED_B] },
      }),
    );
    const useCase = makeUseCase(reader, queue);

    const result = await useCase.importTrainState({ repository: REPO, stateDir: '/tmp/legacy', apply: true, grantId: GRANT_ID, projectId: PROJECT_ID });
    expect(result).toMatchObject({ outcome: 'applied', imported: 0 });
    expect(result.outcome === 'applied' && result.keys).toEqual([
      { pullRequest: 7, headOid: HEAD_B, base: 'main', source: 'inprogress', disposition: 'legacy-in-progress' },
    ]);
    const entries = await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() });
    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GR1b: grant verification, the separate shadow-intake journal, and the
// descriptor-safe request validation.
// ---------------------------------------------------------------------------

/** A counting authorization fake with an injectable answer or throw. */
class FakeAuthorization implements ActionAuthorizationPort {
  calls = 0;
  lastRequest: AuthorizeShadowImportRequest | null = null;

  constructor(
    private readonly answer:
      | { readonly kind: 'authorized' }
      | { readonly kind: 'blocked'; readonly reason: string }
      | { readonly kind: 'unknown'; readonly reason: string }
      | { readonly kind: 'throw' } = { kind: 'authorized' },
    private readonly log?: string[],
  ) {}

  async resolveActionAuthorization(): Promise<never> {
    throw new Error('not used in GR1b tests');
  }

  async consumeActionAuthorization(): Promise<never> {
    throw new Error('not used in GR1b tests');
  }

  async authorizeShadowImport(request: AuthorizeShadowImportRequest): Promise<AuthorizeShadowImportResult> {
    this.calls += 1;
    this.log?.push('authorize');
    this.lastRequest = request;
    if (this.answer.kind === 'throw') {
      throw new Error('delegate blew up');
    }
    if (this.answer.kind === 'authorized') {
      return { outcome: 'authorized', grantId: GRANT_ID };
    }
    return { outcome: this.answer.kind, reason: this.answer.reason };
  }
}

/** A journal fake with per-kind configured outcomes and an optional throw. */
class FakeJournal implements CutoverJournalPort {
  readonly entries: CutoverJournalEntry[] = [];

  constructor(
    private readonly intentOutcome: 'appended' | 'refused' = 'appended',
    private readonly resultBehaviour:
      | { readonly kind: 'append' }
      | { readonly kind: 'refuse' }
      | { readonly kind: 'throw' } = { kind: 'append' },
  ) {}

  async append(entry: CutoverJournalEntry): Promise<CutoverJournalAppendResult> {
    if (entry.kind === 'intent' && this.intentOutcome === 'refused') {
      return { outcome: 'refused', reason: 'duplicate-intent' };
    }
    if (entry.kind === 'result') {
      if (this.resultBehaviour.kind === 'refuse') {
        return { outcome: 'refused', reason: 'invalid-entry' };
      }
      if (this.resultBehaviour.kind === 'throw') {
        throw new Error('journal result blew up');
      }
    }
    this.entries.push(entry);
    return { outcome: 'appended', entry };
  }

  async listByKeyPrefix(): Promise<{ readonly outcome: 'listed'; readonly entries: readonly CutoverJournalEntry[] }> {
    return { outcome: 'listed', entries: [...this.entries] };
  }
}

/** A queue wrapper whose enqueue always throws; reads delegate to the real adapter. */
class ThrowingEnqueueQueue implements MergeQueueRepositoryPort {
  constructor(private readonly inner: MergeQueueRepositoryAdapter) {}

  async enqueueMergeEntry(): Promise<never> {
    throw new Error('apply blew up');
  }

  async dropMergeEntry(command: Parameters<MergeQueueRepositoryPort['dropMergeEntry']>[0]) {
    return this.inner.dropMergeEntry(command);
  }

  async retryMergeEntry(command: Parameters<MergeQueueRepositoryPort['retryMergeEntry']>[0]) {
    return this.inner.retryMergeEntry(command);
  }

  async listMergeEntries(query: MergeQueueListQuery): Promise<readonly MergeQueueEntryRecord[]> {
    return this.inner.listMergeEntries(query);
  }

  async applyMergeTransition(command: Parameters<MergeQueueRepositoryPort['applyMergeTransition']>[0]) {
    return this.inner.applyMergeTransition(command);
  }
}

/** A queue wrapper that records each list call on a shared call log. */
class LoggingListQueue extends MergeQueueRepositoryAdapter {
  constructor(private readonly log: string[]) {
    super();
  }

  override async listMergeEntries(query: MergeQueueListQuery): Promise<readonly MergeQueueEntryRecord[]> {
    this.log.push('list-queue');
    return super.listMergeEntries(query);
  }
}

describe('ImportTrainStateUseCase authorization and journaling (GR1b)', () => {
  it('applies verify the grant before any legacy read, queue read or queue write', async () => {
    // A shared call log pins the ORDER, not merely that each call happens:
    // authorize must come before the legacy read and before the queue read.
    const log: string[] = [];
    const queue = new LoggingListQueue(log);
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]), log);
    const authorization = new FakeAuthorization({ kind: 'authorized' }, log);
    const useCase = makeUseCase(reader, queue, { authorization });

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
    });

    expect(result).toMatchObject({ outcome: 'applied', imported: 1 });
    expect(log[0]).toBe('authorize');
    expect(log).toContain('read-legacy');
    expect(log).toContain('list-queue');
    expect(log.indexOf('authorize')).toBeLessThan(log.indexOf('read-legacy'));
    expect(log.indexOf('authorize')).toBeLessThan(log.indexOf('list-queue'));
    expect(authorization.calls).toBe(1);
    expect(authorization.lastRequest).toMatchObject({
      projectId: PROJECT_ID,
      grantId: GRANT_ID,
      repository: REPO,
    });
    expect(typeof authorization.lastRequest!.nowIso).toBe('string');
  });

  it('a dry run never calls the authorization, journal or digest', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
    const authorization = new FakeAuthorization();
    const useCase = makeUseCase(reader, queue, {
      authorization,
      journal: undefined,
      computeDigest: undefined,
    });

    const result = await useCase.importTrainState({ repository: REPO, stateDir: '/tmp/legacy', apply: false });

    expect(result).toMatchObject({ outcome: 'dry-run', wouldImport: 1 });
    expect(authorization.calls).toBe(0);
  });

  it('maps each grant refusal from authorizeShadowImport before any read or write', async () => {
    const reasons = [
      'grant-missing',
      'grant-expired',
      'grant-revoked',
      'grant-wrong-scope',
      'grant-wrong-repository',
      'grant-wrong-project',
      'grant-digest-mismatch',
      'grant-not-approved',
      'grant-id-mismatch',
    ];
    for (const reason of reasons) {
      const queue = new MergeQueueRepositoryAdapter();
      const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
      const useCase = makeUseCase(reader, queue, {
        authorization: new FakeAuthorization({ kind: 'blocked', reason }),
      });

      const result = await useCase.importTrainState({
        repository: REPO,
        stateDir: '/tmp/legacy',
        apply: true,
        grantId: GRANT_ID,
        projectId: PROJECT_ID,
      });

      expect(result).toEqual({ outcome: 'refused', reason });
      expect(reader.calls).toBe(0);
      expect(await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() })).toEqual([]);
    }
  });

  it('refused grant leaves corrupt merge-queue.json byte-identical without quarantine', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gr1b-corrupt-'));
    try {
      const queueFile = path.join(dir, 'merge-queue.json');
      const corrupt = '{"entries":[ this is not json';
      await writeFile(queueFile, corrupt, 'utf8');
      const queue = new MergeQueueRepositoryAdapter({ stateDir: dir });
      const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
      const useCase = makeUseCase(reader, queue, {
        authorization: new FakeAuthorization({ kind: 'blocked', reason: 'grant-expired' }),
      });

      const result = await useCase.importTrainState({
        repository: REPO,
        stateDir: '/tmp/legacy',
        apply: true,
        grantId: GRANT_ID,
        projectId: PROJECT_ID,
      });

      expect(result).toEqual({ outcome: 'refused', reason: 'grant-expired' });
      expect(await readFile(queueFile, 'utf8')).toBe(corrupt);
      expect(await readdir(dir)).toEqual(['merge-queue.json']);
      expect(reader.calls).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('authorization unavailable refuses', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
    // The dependency is present but its port carries no authorizeShadowImport.
    const useCase = makeUseCase(reader, queue, {
      authorization: {
        resolveActionAuthorization: async () => {
          throw new Error('unused');
        },
        consumeActionAuthorization: async () => {
          throw new Error('unused');
        },
      },
    });

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'authorization-unavailable' });
    expect(reader.calls).toBe(0);
  });

  it('a throwing delegate maps to authorization-unavailable', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
    const useCase = makeUseCase(reader, queue, { authorization: new FakeAuthorization({ kind: 'throw' }) });

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'authorization-unavailable' });
    expect(reader.calls).toBe(0);
  });

  it.each([
    ['project-id-required'],
    ['clock-unavailable'],
    ['invalid-now-iso'],
    ['digest-unavailable'],
    ['invalid-request'],
    ['authorization-unreadable'],
  ])('maps %s from authorizeShadowImport to authorization-unavailable', async (reason) => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
    const useCase = makeUseCase(reader, queue, {
      authorization: new FakeAuthorization({ kind: 'blocked', reason }),
    });

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'authorization-unavailable' });
    expect(reader.calls).toBe(0);
  });

  it('an unrecognized blocked reason maps to authorization-unavailable', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
    const useCase = makeUseCase(reader, queue, {
      authorization: new FakeAuthorization({ kind: 'blocked', reason: 'something-else' }),
    });

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'authorization-unavailable' });
  });

  it('missing journal refuses before queue write', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
    const useCase = makeUseCase(reader, queue, { journal: undefined });

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'journal-unavailable' });
    expect(await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() })).toEqual([]);
  });

  it('missing computeDigest refuses before queue write', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
    const useCase = makeUseCase(reader, queue, { computeDigest: undefined });

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'journal-unavailable' });
    expect(await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() })).toEqual([]);
  });

  it('refused journal intent refuses before queue write', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
    const useCase = makeUseCase(reader, queue, {
      journal: new FakeJournal('refused') as unknown as CutoverJournalPort,
    });

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'journal-refused' });
    expect(await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() })).toEqual([]);
  });

  it('a throwing computeDigest refuses journal-unavailable before queue write', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
    const useCase = makeUseCase(reader, queue, {
      computeDigest: () => {
        throw new Error('digest blew up');
      },
    });

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'journal-unavailable' });
    expect(await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() })).toEqual([]);
  });

  it('a throwing nowIso during journaling refuses journal-refused before queue write', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
    // Call 1 authorizes, call 2 mints the deadline, call 3 stamps the intent:
    // the clock blows up exactly at the journaling step.
    let clockCalls = 0;
    const useCase = makeUseCase(reader, queue, {
      nowIso: () => {
        clockCalls += 1;
        if (clockCalls >= 3) {
          throw new Error('clock blew up');
        }
        return new Date().toISOString();
      },
    });

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'journal-refused' });
    expect(await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() })).toEqual([]);
  });

  it('a throwing intent append refuses journal-refused before queue write', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
    const useCase = makeUseCase(reader, queue, {
      journal: {
        append: async () => {
          throw new Error('journal store blew up');
        },
        listByKeyPrefix: async () => ({ outcome: 'listed', entries: [] }),
      } as unknown as CutoverJournalPort,
    });

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'journal-refused' });
    expect(await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() })).toEqual([]);
  });

  it('a throwing mintUlid while creating the intent id refuses journal-refused before queue write', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
    const useCase = makeUseCase(reader, queue, {
      mintUlid: () => {
        throw new Error('id mint blew up');
      },
    });

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'journal-refused' });
    expect(await queue.listMergeEntries({ repository: REPO, deadlineIso: futureDeadline() })).toEqual([]);
  });

  it('zero candidates journal nothing', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const reader = new FakeLegacyTrainStateReadPort(readState([]));
    const journal = new FakeJournal();
    const useCase = makeUseCase(reader, queue, { journal: journal as unknown as CutoverJournalPort });

    const result = await useCase.importTrainState({
      repository: REPO,
      stateDir: '/tmp/legacy',
      apply: true,
      grantId: GRANT_ID,
      projectId: PROJECT_ID,
    });

    expect(result).toEqual({
      outcome: 'applied',
      imported: 0,
      refused: 0,
      unknownLineNumbers: [],
      notImportableBase: 0,
      alreadyQueued: 0,
      parkedLines: 0,
      chainFiles: 0,
      batchLines: 0,
      ...emptyReportExtras(),
    });
    expect(journal.entries).toEqual([]);
  });

  it('applies journal an intent and an applied result into shadow-intake-journal.json, never cutover-journal.json', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gr1b-journal-'));
    try {
      const queue = new MergeQueueRepositoryAdapter({ stateDir: dir });
      const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
      const useCase = new ImportTrainStateUseCase({
        legacyState: reader,
        queue,
        mintUlid,
        nowIso,
        authorization: new FakeAuthorization(),
        journal: new CutoverJournalAdapter({ stateDir: dir, fileName: 'shadow-intake-journal.json' }),
        computeDigest: () => GRANT_DIGEST,
      });

      const result = await useCase.importTrainState({
        repository: REPO,
        stateDir: '/tmp/legacy',
        apply: true,
        grantId: GRANT_ID,
        projectId: PROJECT_ID,
      });

      expect(result).toMatchObject({ outcome: 'applied', imported: 1 });
      const stored = JSON.parse(await readFile(path.join(dir, 'shadow-intake-journal.json'), 'utf8')) as {
        key: string;
        kind: string;
        digest?: string | null;
        outcome?: string | null;
        reasonCode?: string | null;
      }[];
      expect(stored).toHaveLength(2);
      expect(stored[0]).toMatchObject({ kind: 'intent', digest: GRANT_DIGEST });
      expect(stored[1]).toMatchObject({ kind: 'result', outcome: 'completed', reasonCode: 'applied', digest: GRANT_DIGEST });
      expect(stored[0]!.key).toMatch(/^shadow-import\/fleet\/v2\/[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
      await expect(readFile(path.join(dir, 'cutover-journal.json'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throw during apply records ambiguous result', async () => {
    const queue = new ThrowingEnqueueQueue(new MergeQueueRepositoryAdapter());
    const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
    const journal = new FakeJournal();
    const useCase = new ImportTrainStateUseCase({
      legacyState: reader,
      queue,
      mintUlid,
      nowIso,
      authorization: new FakeAuthorization(),
      journal: journal as unknown as CutoverJournalPort,
      computeDigest: () => GRANT_DIGEST,
    });

    await expect(
      useCase.importTrainState({
        repository: REPO,
        stateDir: '/tmp/legacy',
        apply: true,
        grantId: GRANT_ID,
        projectId: PROJECT_ID,
      }),
    ).rejects.toThrow('apply blew up');

    expect(journal.entries.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(journal.entries[1]).toMatchObject({ outcome: 'ambiguous', reasonCode: 'apply-threw' });
  });

  it('refused or throwing result append does not mask applied outcome', async () => {
    for (const behaviour of [{ kind: 'refuse' }, { kind: 'throw' }] as const) {
      const queue = new MergeQueueRepositoryAdapter();
      const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
      const journal = new FakeJournal('appended', { kind: behaviour.kind });
      const useCase = new ImportTrainStateUseCase({
        legacyState: reader,
        queue,
        mintUlid,
        nowIso,
        authorization: new FakeAuthorization(),
        journal: journal as unknown as CutoverJournalPort,
        computeDigest: () => GRANT_DIGEST,
      });

      const result = await useCase.importTrainState({
        repository: REPO,
        stateDir: '/tmp/legacy',
        apply: true,
        grantId: GRANT_ID,
        projectId: PROJECT_ID,
      });

      expect(result).toMatchObject({ outcome: 'applied', imported: 1 });
    }
  });

  it('refused or throwing result append does not mask apply error', async () => {
    for (const behaviour of [{ kind: 'refuse' }, { kind: 'throw' }] as const) {
      const queue = new ThrowingEnqueueQueue(new MergeQueueRepositoryAdapter());
      const reader = new FakeLegacyTrainStateReadPort(readState([MAIN_A]));
      const journal = new FakeJournal('appended', { kind: behaviour.kind });
      const useCase = new ImportTrainStateUseCase({
        legacyState: reader,
        queue,
        mintUlid,
        nowIso,
        authorization: new FakeAuthorization(),
        journal: journal as unknown as CutoverJournalPort,
        computeDigest: () => GRANT_DIGEST,
      });

      await expect(
        useCase.importTrainState({
          repository: REPO,
          stateDir: '/tmp/legacy',
          apply: true,
          grantId: GRANT_ID,
          projectId: PROJECT_ID,
        }),
      ).rejects.toThrow('apply blew up');
    }
  });
});

describe('validateImportTrainStateRequest (GR1b)', () => {
  const valid = (): Record<string, unknown> => ({
    repository: { owner: 'fleet', repo: 'v2' },
    stateDir: '/tmp/legacy',
    apply: true,
    grantId: GRANT_ID,
    projectId: PROJECT_ID,
  });

  it('accepts a plain valid request with its normalized fields (a constant verdict would fail)', () => {
    const result = validateImportTrainStateRequest(valid());
    expect(result).toEqual({
      ok: true,
      request: { repository: REPO, stateDir: '/tmp/legacy', apply: true, grantId: GRANT_ID, projectId: PROJECT_ID },
    });
  });

  it('refuses null and undefined', () => {
    expect(validateImportTrainStateRequest(null)).toEqual({ ok: false, reason: 'invalid-request' });
    expect(validateImportTrainStateRequest(undefined)).toEqual({ ok: false, reason: 'invalid-request' });
  });

  it('refuses a wrong primitive where an object is due', () => {
    expect(validateImportTrainStateRequest(42)).toEqual({ ok: false, reason: 'invalid-request' });
    expect(validateImportTrainStateRequest('apply')).toEqual({ ok: false, reason: 'invalid-request' });
  });

  it('refuses a wrong primitive where a string is due', () => {
    const request = { ...valid(), stateDir: 42 };
    expect(validateImportTrainStateRequest(request)).toEqual({ ok: false, reason: 'invalid-state-dir' });
  });

  it('refuses a non-iterable object where a list is due and arrays', () => {
    expect(validateImportTrainStateRequest([valid()])).toEqual({ ok: false, reason: 'invalid-request' });
  });

  it('refuses a sparse array before any traversal', () => {
    const sparse: unknown[] = [];
    sparse[10] = valid();
    expect(validateImportTrainStateRequest(sparse)).toEqual({ ok: false, reason: 'invalid-request' });
  });

  it('refuses an array-like object', () => {
    const arrayLike = { length: 1, 0: valid() };
    expect(validateImportTrainStateRequest(arrayLike)).toEqual({ ok: false, reason: 'invalid-repository' });
  });

  it('refuses an enormous sparse length before any traversal', () => {
    const enormous: unknown[] = [];
    Object.defineProperty(enormous, 'length', { value: 2 ** 32 - 1 });
    expect(validateImportTrainStateRequest(enormous)).toEqual({ ok: false, reason: 'invalid-request' });
  });

  it('refuses a getter on the root without ever running it', () => {
    let getterCalls = 0;
    const request: Record<string, unknown> = valid();
    Object.defineProperty(request, 'apply', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return true;
      },
    });
    expect(validateImportTrainStateRequest(request)).toEqual({ ok: false, reason: 'invalid-request' });
    expect(getterCalls).toBe(0);
  });

  it('refuses a getter on a nested field without ever running it', () => {
    let getterCalls = 0;
    const request: Record<string, unknown> = { ...valid() };
    Object.defineProperty(request, 'repository', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return { owner: 'fleet', repo: 'v2' };
      },
    });
    expect(validateImportTrainStateRequest(request)).toEqual({ ok: false, reason: 'invalid-request' });
    expect(getterCalls).toBe(0);
  });

  it('refuses a Proxy over a valid input with no get trap run, answering exactly as the plain data', () => {
    let getTraps = 0;
    const plain = validateImportTrainStateRequest(valid());
    const proxy = new Proxy(valid(), {
      get() {
        getTraps += 1;
        return undefined;
      },
    });
    const result = validateImportTrainStateRequest(proxy);
    // The Proxy's descriptors answer exactly as the plain data would.
    expect(result).toEqual(plain);
    expect(result).toEqual({
      ok: true,
      request: { repository: REPO, stateDir: '/tmp/legacy', apply: true, grantId: GRANT_ID, projectId: PROJECT_ID },
    });
    expect(getTraps).toBe(0);
  });

  it('refuses a prototype-polluting own key produced by JSON.parse', () => {
    const request = JSON.parse(JSON.stringify(valid())) as Record<string, unknown>;
    Object.defineProperty(request, '__proto__', { value: { apply: false }, enumerable: true, configurable: true });
    expect(validateImportTrainStateRequest(request)).toEqual({ ok: false, reason: 'invalid-request' });
  });

  it('an identity echo of the input would fail: the answer is a typed verdict, never the input', () => {
    const request = valid();
    const result = validateImportTrainStateRequest(request);
    expect(result).not.toBe(request);
    expect(result.ok).toBe(true);
  });

  it('refuses an apply without projectId and without grantId with their named reasons', () => {
    const noProject = { ...valid(), projectId: undefined };
    const noGrant = { ...valid(), grantId: null };
    const blankProject = { ...valid(), projectId: '  ' };
    expect(validateImportTrainStateRequest(noProject)).toEqual({ ok: false, reason: 'project-required' });
    expect(validateImportTrainStateRequest(blankProject)).toEqual({ ok: false, reason: 'project-required' });
    expect(validateImportTrainStateRequest(noGrant)).toEqual({ ok: false, reason: 'grant-missing' });
  });

  it('a dry run needs neither grantId nor projectId', () => {
    const dryRun = { repository: REPO, stateDir: '/tmp/legacy', apply: false };
    expect(validateImportTrainStateRequest(dryRun)).toEqual({
      ok: true,
      request: { repository: REPO, stateDir: '/tmp/legacy', apply: false, grantId: null, projectId: null },
    });
  });

  it('refuses a hostile repository shape', () => {
    expect(validateImportTrainStateRequest({ ...valid(), repository: 'fleet/v2' })).toEqual({
      ok: false,
      reason: 'invalid-repository',
    });
    expect(validateImportTrainStateRequest({ ...valid(), repository: { owner: '.', repo: 'v2' } })).toEqual({
      ok: false,
      reason: 'invalid-repository',
    });
    expect(validateImportTrainStateRequest({ ...valid(), stateDir: '' })).toEqual({
      ok: false,
      reason: 'invalid-state-dir',
    });
  });
});
