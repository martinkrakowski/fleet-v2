// Lane CO5b: read-only rollback export of the merge queue as legacy documents.
import { describe, expect, it } from 'vitest';

import { parseLegacyTrainQueue } from '../../../domain/legacy-train-queue.js';
import type { MergeQueueEntryRecord } from '../../../domain/merge-queue-records.js';
import { isMergeQueueEntryLive } from '../../../domain/merge-queue-records.js';
import { MergeQueueRepositoryAdapter } from '../../../infrastructure/adapters/MergeQueueRepositoryAdapter.adapter.js';
import type {
  ExportLegacyTrainStateRequest,
  ExportLegacyTrainStateResult,
} from '../../ports/in/ExportLegacyTrainStatePort.in-port.js';
import type { ListMergeQueuePort, MergeQueueView } from '../../ports/in/ListMergeQueuePort.in-port.js';
import { ListMergeQueueUseCase } from '../ListMergeQueueUseCase.use-case.js';
import { ExportLegacyTrainStateUseCase } from '../ExportLegacyTrainStateUseCase.use-case.js';

const REPO = { owner: 'fleet', repo: 'v2' };
const HEAD_A = '0123456789abcdef0123456789abcdef01234567';
const HEAD_B = '0123456789abcdef0123456789abcdef01234568';
const FIXED_NOW = '2026-11-11T00:00:00.000Z';
const FIXED_DEADLINE = '2026-11-11T00:01:00.000Z';

/** Secret-shaped fakes are assembled from inert pieces (parser test precedent). */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

function ulid(n: number): string {
  return `01ARZ3NDEKTSV4RRFFAT69F9${String(n).padStart(2, '0')}`;
}

function entry(
  id: string,
  pullRequest: number,
  headOid: string,
  state: string,
  extra: Record<string, unknown> = {},
): MergeQueueEntryRecord {
  return {
    entryId: id,
    repository: { ...REPO },
    pullRequest,
    headOid,
    state,
    ...extra,
  } as unknown as MergeQueueEntryRecord;
}

class FakeListMergeQueue implements ListMergeQueuePort {
  calls: { repository?: { owner: string; repo: string }; deadlineIso: string }[] = [];

  constructor(private readonly result: MergeQueueView | Error) {}

  async list(query: { repository?: { owner: string; repo: string }; deadlineIso: string }): Promise<MergeQueueView> {
    this.calls.push({ repository: query.repository, deadlineIso: query.deadlineIso });
    if (this.result instanceof Error) {
      return Promise.reject(this.result);
    }
    return this.result;
  }
}

function makeUseCase(
  listPort: ListMergeQueuePort,
  nowIso: () => string = () => FIXED_NOW,
): ExportLegacyTrainStateUseCase {
  return new ExportLegacyTrainStateUseCase({ listMergeQueue: listPort, nowIso });
}

const repositoryRequest: ExportLegacyTrainStateRequest = { repository: REPO };

async function exportOf(entries: MergeQueueEntryRecord[]): Promise<ExportLegacyTrainStateResult> {
  return makeUseCase(new FakeListMergeQueue({ entries, heads: [] })).exportLegacyTrainState(
    repositoryRequest,
  );
}

/** Assert a refusal shape and that nothing secret or raw leaked into it. */
function expectRefusal(
  result: ExportLegacyTrainStateResult,
  expected: Record<string, unknown>,
  forbidden: string[] = [],
): void {
  expect(result.outcome).toBe('refused');
  expect(result).toEqual(expected);
  const serialized = JSON.stringify(result);
  for (const text of forbidden) {
    expect(serialized).not.toContain(text);
  }
}

describe('ExportLegacyTrainStateUseCase', () => {
  it('round-trips the queue and parked documents through parseLegacyTrainQueue', async () => {
    const listPort = new FakeListMergeQueue({
      entries: [
        entry(ulid(1), 42, HEAD_A, 'queued'),
        entry(ulid(2), 7, HEAD_B, 'parked'),
      ],
      heads: [],
    });
    const useCase = makeUseCase(listPort);

    const result = await useCase.exportLegacyTrainState(repositoryRequest);

    expect(result).toEqual({ outcome: 'exported', queueDocument: `42 ${HEAD_A} main`, parkedDocument: `7 ${HEAD_B} main` });
    expect(Object.keys(result)).toEqual(['outcome', 'queueDocument', 'parkedDocument']);
    expect(listPort.calls).toEqual([{ repository: REPO, deadlineIso: FIXED_DEADLINE }]);

    const queueParsed = parseLegacyTrainQueue(result.outcome === 'exported' ? result.queueDocument : '');
    expect(queueParsed.ok).toBe(true);
    if (queueParsed.ok) {
      expect(queueParsed.lines.map((line) => (line.ok ? line.entry : null))).toEqual([
        { line: 1, pullRequest: 42, headOid: HEAD_A, base: 'main' },
      ]);
    }
    const parkedParsed = parseLegacyTrainQueue(result.outcome === 'exported' ? result.parkedDocument : '');
    expect(parkedParsed.ok).toBe(true);
    if (parkedParsed.ok) {
      expect(parkedParsed.lines.map((line) => (line.ok ? line.entry : null))).toEqual([
        { line: 1, pullRequest: 7, headOid: HEAD_B, base: 'main' },
      ]);
    }
    if (result.outcome === 'exported') {
      expect(queueParsed.ok && queueParsed.lines.every((line) => line.ok && line.entry.pullRequest === 42)).toBe(true);
      expect(parkedParsed.ok && parkedParsed.lines.every((line) => line.ok && line.entry.pullRequest === 7)).toBe(true);
    }
  });

  it('keeps list order and renders a merging entry on the queue document', async () => {
    const result = await exportOf([
      entry(ulid(1), 9, HEAD_B, 'merging'),
      entry(ulid(2), 42, HEAD_A, 'queued'),
      entry(ulid(3), 3, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'parked'),
    ]);

    expect(result).toEqual({
      outcome: 'exported',
      queueDocument: `9 ${HEAD_B} main\n42 ${HEAD_A} main`,
      parkedDocument: `3 ${'a'.repeat(40)} main`,
    });
  });

  it('renders main when an entry has an extra base property', async () => {
    const result = await exportOf([entry(ulid(1), 42, HEAD_A, 'queued', { base: 'chain/example-1' })]);

    expect(result.outcome).toBe('exported');
    if (result.outcome === 'exported') {
      expect(result.queueDocument).toBe(`42 ${HEAD_A} main`);
      const parsed = parseLegacyTrainQueue(result.queueDocument);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.lines[0].ok).toBe(true);
        if (parsed.lines[0].ok) {
          expect(parsed.lines[0].entry.base).toBe('main');
        }
      }
    }
  });

  it('never inspects a secret-shaped base property', async () => {
    // The base is never read, not even to scan it for secret shapes: an
    // otherwise valid entry whose ignored `base` looks secret-shaped still
    // exports, because the rule is to never inspect that property at all.
    const result = await exportOf([entry(ulid(1), 42, HEAD_A, 'queued', { base: fakeSecretShape() })]);

    expect(result.outcome).toBe('exported');
    if (result.outcome === 'exported') {
      expect(result.queueDocument).toBe(`42 ${HEAD_A} main`);
      expect(JSON.stringify(result)).not.toContain(fakeSecretShape());
    }
  });

  it('renders an empty list as two empty documents', async () => {
    const result = await exportOf([]);

    expect(result).toEqual({ outcome: 'exported', queueDocument: '', parkedDocument: '' });
    expect(Object.keys(result)).toEqual(['outcome', 'queueDocument', 'parkedDocument']);
  });

  it('refuses an invalid repository before reading the queue', async () => {
    const listPort = new FakeListMergeQueue({ entries: [], heads: [] });
    const useCase = makeUseCase(listPort);

    const badSegments = await useCase.exportLegacyTrainState({
      repository: { owner: '..', repo: 'v2' },
    } as ExportLegacyTrainStateRequest);
    expectRefusal(badSegments, { outcome: 'refused', reason: 'invalid-repository' });

    const accessorRepository = {
      get owner(): string {
        throw new Error('getter ran');
      },
      repo: 'v2',
    };
    const accessor = await useCase.exportLegacyTrainState({
      repository: accessorRepository,
    } as unknown as ExportLegacyTrainStateRequest);
    expectRefusal(accessor, { outcome: 'refused', reason: 'invalid-repository' });

    const nonPlain = await useCase.exportLegacyTrainState({
      repository: Object.create({ owner: 'fleet', repo: 'v2' }),
    } as unknown as ExportLegacyTrainStateRequest);
    expectRefusal(nonPlain, { outcome: 'refused', reason: 'invalid-repository' });

    expect(listPort.calls).toEqual([]);
  });

  it('refuses a token-shaped repository owner before reading the queue', async () => {
    const listPort = new FakeListMergeQueue({ entries: [], heads: [] });
    const useCase = makeUseCase(listPort);
    const tokenOwner = fakeSecretShape();

    // A `ghp_<token>` owner satisfies the segment pattern, so only the secret
    // scan stops it: the export must refuse instead of answering with a
    // misleadingly successful empty document, and the token never echoes.
    const result = await useCase.exportLegacyTrainState({
      repository: { owner: tokenOwner, repo: 'v2' },
    } as ExportLegacyTrainStateRequest);

    expectRefusal(result, { outcome: 'refused', reason: 'invalid-repository' }, [tokenOwner]);
    expect(listPort.calls).toEqual([]);
  });

  it('refuses a clock that does not yield a deadline', async () => {
    const listPort = new FakeListMergeQueue({ entries: [], heads: [] });
    const throwing = makeUseCase(listPort, () => {
      throw new Error('clock is broken');
    });
    expectRefusal(await throwing.exportLegacyTrainState(repositoryRequest), {
      outcome: 'refused',
      reason: 'invalid-deadline',
    });

    const unparseable = makeUseCase(new FakeListMergeQueue({ entries: [], heads: [] }), () => 'not-a-timestamp');
    expectRefusal(await unparseable.exportLegacyTrainState(repositoryRequest), {
      outcome: 'refused',
      reason: 'invalid-deadline',
    });
    expect(listPort.calls).toEqual([]);
  });

  it('refuses a list deadline rejection', async () => {
    const error = new Error('an expired deadline is never echoed');
    error.name = 'MergeQueueDeadlineError';
    const listPort = new FakeListMergeQueue(error);
    const result = await makeUseCase(listPort).exportLegacyTrainState(repositoryRequest);
    expectRefusal(result, { outcome: 'refused', reason: 'invalid-deadline' }, [
      'an expired deadline is never echoed',
    ]);
  });

  it('refuses a thrown list error without echoing it', async () => {
    const error = new Error('merge-queue.json unreadable at /state/merge-queue.json');
    error.name = 'StateFileUnreadableError';
    const listPort = new FakeListMergeQueue(error);
    const result = await makeUseCase(listPort).exportLegacyTrainState(repositoryRequest);
    expectRefusal(result, { outcome: 'refused', reason: 'queue-unreadable' }, [
      'merge-queue.json',
      '/state/merge-queue.json',
    ]);
  });

  it('refuses a missing list and a non-array entries field', async () => {
    const missingList = makeUseCase({} as ListMergeQueuePort);
    expectRefusal(await missingList.exportLegacyTrainState(repositoryRequest), {
      outcome: 'refused',
      reason: 'queue-unreadable',
    });

    const nullView = new FakeListMergeQueue(null as unknown as MergeQueueView);
    expectRefusal(await makeUseCase(nullView).exportLegacyTrainState(repositoryRequest), {
      outcome: 'refused',
      reason: 'queue-unreadable',
    });

    const badEntries = new FakeListMergeQueue({ entries: 'nope', heads: [] } as unknown as MergeQueueView);
    expectRefusal(await makeUseCase(badEntries).exportLegacyTrainState(repositoryRequest), {
      outcome: 'refused',
      reason: 'queue-unreadable',
    });
  });

  it('refuses a list longer than the cap without reading an element', async () => {
    const entries: unknown[] = new Array(10001).fill(undefined);
    Object.defineProperty(entries, 0, {
      get(): unknown {
        throw new Error('element was read');
      },
      enumerable: true,
      configurable: true,
    });
    const listPort = new FakeListMergeQueue({ entries, heads: [] } as unknown as MergeQueueView);
    const result = await makeUseCase(listPort).exportLegacyTrainState(repositoryRequest);
    expectRefusal(result, { outcome: 'refused', reason: 'queue-too-large' });
  });

  it('refuses a hole and a getter without calling the getter', async () => {
    const withHole: unknown[] = [entry(ulid(1), 42, HEAD_A, 'queued')];
    delete (withHole as Record<number, unknown>)[0];
    withHole[1] = entry(ulid(2), 7, HEAD_B, 'queued');
    const holeResult = await exportOf(withHole as MergeQueueEntryRecord[]);
    expectRefusal(holeResult, { outcome: 'refused', reason: 'malformed-entry', entryId: null });

    let getterRan = false;
    const getterEntry = {
      get state(): string {
        getterRan = true;
        return 'queued';
      },
      entryId: ulid(1),
      pullRequest: 42,
      headOid: HEAD_A,
      repository: { ...REPO },
    };
    const getterResult = await exportOf([getterEntry as unknown as MergeQueueEntryRecord]);
    expect(getterRan).toBe(false);
    expectRefusal(getterResult, { outcome: 'refused', reason: 'malformed-entry', entryId: ulid(1) });

    const nullEntry = await exportOf([null as unknown as MergeQueueEntryRecord]);
    expectRefusal(nullEntry, { outcome: 'refused', reason: 'malformed-entry', entryId: null });
  });

  it('refuses an unrenderable entry and names its id', async () => {
    const stringPullRequest = await exportOf([entry(ulid(1), '42' as unknown as number, HEAD_A, 'queued')]);
    expectRefusal(stringPullRequest, { outcome: 'refused', reason: 'unrenderable', entryId: ulid(1) });

    const badHead = await exportOf([entry(ulid(1), 42, 'abc', 'queued')]);
    expectRefusal(badHead, { outcome: 'refused', reason: 'unrenderable', entryId: ulid(1) }, ['abc']);

    const terminal = await exportOf([entry(ulid(1), 42, HEAD_A, 'merged')]);
    expectRefusal(terminal, { outcome: 'refused', reason: 'unrenderable', entryId: ulid(1) });

    const mismatchedRepository = await exportOf([
      entry(ulid(1), 42, HEAD_A, 'queued', { repository: { owner: 'other', repo: 'v2' } }),
    ]);
    expectRefusal(mismatchedRepository, { outcome: 'refused', reason: 'unrenderable', entryId: ulid(1) });
  });

  it('refuses a duplicate live identity and names both ids', async () => {
    const duplicate = await exportOf([
      entry(ulid(1), 42, HEAD_A, 'queued'),
      entry(ulid(2), 42, HEAD_A, 'updating'),
    ]);
    expectRefusal(duplicate, {
      outcome: 'refused',
      reason: 'duplicate-identity',
      entryIds: [ulid(1), ulid(2)],
    });

    const duplicateMissingId = await exportOf([
      entry(ulid(1), 42, HEAD_A, 'queued'),
      entry('', 42, HEAD_A, 'queued'),
    ]);
    expectRefusal(duplicateMissingId, { outcome: 'refused', reason: 'malformed-entry', entryId: null });
  });

  it('refuses a secret-shaped entry id and does not echo it', async () => {
    const secret = fakeSecretShape();
    const result = await exportOf([entry(secret, 42, HEAD_A, 'queued')]);
    expectRefusal(result, { outcome: 'refused', reason: 'secret-shaped', entryId: null }, [secret]);
  });

  it('export leaves a real queue unchanged', async () => {
    const queue = new MergeQueueRepositoryAdapter();
    const listMergeQueue = new ListMergeQueueUseCase({ queue });
    await queue.enqueueMergeEntry({
      repository: REPO,
      pullRequest: 42,
      headOid: HEAD_A,
      tier: 2,
      enqueuedBy: 'cli',
      runId: null,
      entryId: ulid(1),
      successorEntryId: ulid(2),
      enqueuedAtIso: new Date().toISOString(),
      deadlineIso: new Date(Date.now() + 60_000).toISOString(),
    });
    const useCase = makeUseCase(listMergeQueue, () => new Date().toISOString());

    const result = await useCase.exportLegacyTrainState(repositoryRequest);

    expect(result.outcome).toBe('exported');
    if (result.outcome === 'exported') {
      expect(result.queueDocument).toBe(`42 ${HEAD_A} main`);
      expect(result.parkedDocument).toBe('');
    }
    const stored = await queue.listMergeEntries({ repository: REPO, deadlineIso: new Date(Date.now() + 60_000).toISOString() });
    expect(stored.length).toBe(1);
    expect(stored[0].entryId).toBe(ulid(1));
    expect(stored[0].state).toBe('queued');
    expect(isMergeQueueEntryLive(stored[0])).toBe(true);
  });
});
