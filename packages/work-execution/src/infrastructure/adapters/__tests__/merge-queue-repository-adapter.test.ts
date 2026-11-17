import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MergeQueueDeadlineError,
  MergeQueueRepositoryAdapter,
} from '../MergeQueueRepositoryAdapter.adapter.js';
import { StateFileUnreadableError } from '../file-store.js';

const HEAD_A = '0123456789abcdef0123456789abcdef01234567';
const HEAD_B = '0123456789abcdef0123456789abcdef01234568';

let entryIdCounter = 0;
function nextEntryId(): string {
  const ordinal = String(entryIdCounter).padStart(22, '0').slice(-22);
  entryIdCounter += 1;
  return '01JB' + ordinal;
}

function futureDeadline(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

function command(headOid: string) {
  return {
    repository: { owner: 'fleet', repo: 'v2' },
    pullRequest: 7,
    headOid,
    tier: 2,
    enqueuedBy: 'cli' as const,
    runId: null,
    entryId: nextEntryId(),
    successorEntryId: nextEntryId(),
    enqueuedAtIso: new Date().toISOString(),
    deadlineIso: futureDeadline(),
  };
}

const DEADLINE_MESSAGE = 'merge queue list refused an expired or malformed deadline';

/** The same 12-character digest `computeRepoDigest` stores. */
function digestOf(owner: string, repo: string): string {
  return createHash('sha256').update(`${owner}/${repo}`, 'utf8').digest('hex').slice(0, 12);
}

async function writeTruncated(dir: string): Promise<string> {
  const filePath = path.join(dir, 'merge-queue.json');
  await fs.writeFile(filePath, '{ truncated');
  return filePath;
}

async function expectDeadlineRefusal(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error('expected MergeQueueDeadlineError');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(MergeQueueDeadlineError);
  expect(error instanceof Error ? error.message : '').toBe(DEADLINE_MESSAGE);
}

async function enqueueFleetAndOther(
  adapter: MergeQueueRepositoryAdapter,
): Promise<{ fleetId: string; otherId: string }> {
  const fleet = await adapter.enqueueMergeEntry(command(HEAD_A));
  const other = await adapter.enqueueMergeEntry({
    ...command(HEAD_B),
    repository: { owner: 'other', repo: 'repo' },
    pullRequest: 11,
  });
  expect(fleet.outcome).toBe('created');
  expect(other.outcome).toBe('created');
  if (fleet.outcome !== 'created' || other.outcome !== 'created') {
    throw new Error('expected both merge entries to be created');
  }
  return { fleetId: fleet.record.entryId, otherId: other.record.entryId };
}

function queuedRecord(fields: {
  entryId: string;
  owner: string;
  repo: string;
  pullRequest: number;
  headOid: string;
  repoDigest: string;
}): Record<string, unknown> {
  return {
    version: 1,
    entryId: fields.entryId,
    repository: { owner: fields.owner, repo: fields.repo },
    repoDigest: fields.repoDigest,
    pullRequest: fields.pullRequest,
    headOid: fields.headOid,
    state: 'queued',
    reason: null,
    attempt: 0,
    notBeforeIso: null,
    enqueuedAtIso: '2026-11-01T10:00:00.000Z',
    enqueuedBy: 'cli',
    supersedes: null,
    runId: null,
    attemptId: null,
    workOrderId: null,
    tier: 2,
    verifiedHeadOid: null,
    verifiedBy: null,
    policyRevision: null,
    premergeReceiptHeadOid: null,
    veto: null,
    mergeCommitOid: null,
    mergedAtIso: null,
    revision: 1,
  };
}

function proxyThatThrows<T extends object>(target: T): T {
  return new Proxy(target, {
    get(): never {
      throw new Error('get trap');
    },
    getOwnPropertyDescriptor(): never {
      throw new Error('getOwnPropertyDescriptor trap');
    },
    ownKeys(): never {
      throw new Error('ownKeys trap');
    },
    getPrototypeOf(): never {
      throw new Error('getPrototypeOf trap');
    },
  });
}

describe('MergeQueueRepositoryAdapter', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-merge-queue-'));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses a non-40-hex head without creating the file or echoing the value', async () => {
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    const decision = await adapter.enqueueMergeEntry({
      ...command('not-a-real-head'),
    });
    expect(decision).toEqual({ outcome: 'refused', reason: 'invalid-head' });
    await expect(fs.stat(path.join(stateDir, 'merge-queue.json'))).rejects.toThrow();
    expect(JSON.stringify(decision)).not.toContain('not-a-real-head');
  });

  it('returns the first live entry on a duplicate and writes nothing', async () => {
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    const first = await adapter.enqueueMergeEntry(command(HEAD_A));
    expect(first.outcome).toBe('created');
    if (first.outcome !== 'created') {
      return;
    }
    const filePath = path.join(stateDir, 'merge-queue.json');
    const bytesBefore = await fs.readFile(filePath);
    const second = await adapter.enqueueMergeEntry(command(HEAD_A));
    expect(second.outcome).toBe('duplicate');
    if (second.outcome === 'duplicate') {
      expect(second.record.entryId).toBe(first.record.entryId);
    }
    const bytesAfter = await fs.readFile(filePath);
    expect(bytesAfter).toEqual(bytesBefore);
    const parsed = JSON.parse(bytesAfter.toString('utf8')) as unknown[];
    expect(parsed).toHaveLength(1);
  });

  it('supersedes an earlier head with a successor that inherits its position', async () => {
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    const first = await adapter.enqueueMergeEntry(command(HEAD_A));
    expect(first.outcome).toBe('created');
    if (first.outcome !== 'created') {
      return;
    }
    const second = await adapter.enqueueMergeEntry(command(HEAD_B));
    expect(second.outcome).toBe('supersedes');
    if (second.outcome !== 'supersedes') {
      return;
    }
    const filePath = path.join(stateDir, 'merge-queue.json');
    const parsed = JSON.parse((await fs.readFile(filePath)).toString('utf8')) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    const storedFirst = parsed.find((record) => record.entryId === first.record.entryId)!;
    const storedSecond = parsed.find((record) => record.entryId === second.record.entryId)!;
    expect(storedFirst.state).toBe('superseded');
    expect(storedSecond.state).toBe('queued');
    expect(storedSecond.supersedes).toBe(first.record.entryId);
    expect(storedSecond.enqueuedAtIso).toBe(first.record.enqueuedAtIso);
    expect(storedSecond.enqueuedBy).toBe('cli');
  });

  it('throws on an unreadable list instead of returning an empty list', async () => {
    const filePath = path.join(stateDir, 'merge-queue.json');
    await fs.writeFile(filePath, '{ truncated');
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    await expect(adapter.listMergeEntries({ deadlineIso: futureDeadline() })).rejects.toBeInstanceOf(
      StateFileUnreadableError,
    );
  });

  it('refuses an invalid or past deadline on every mutation', async () => {
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    const past = new Date(Date.now() - 1000).toISOString();
    const enqueue = await adapter.enqueueMergeEntry({ ...command(HEAD_A), deadlineIso: past });
    expect(enqueue).toEqual({ outcome: 'refused', reason: 'invalid-deadline' });
    const drop = await adapter.dropMergeEntry({ entryId: nextEntryId(), deadlineIso: 'nonsense' });
    expect(drop).toEqual({ outcome: 'refused', reason: 'invalid-deadline' });
    const retry = await adapter.retryMergeEntry({
      entryId: nextEntryId(),
      retryEntryId: nextEntryId(),
      enqueuedAtIso: new Date().toISOString(),
      deadlineIso: past,
    });
    expect(retry).toEqual({ outcome: 'refused', reason: 'invalid-deadline' });
  });

  it('throws a typed error on an invalid list deadline', async () => {
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    await expect(adapter.listMergeEntries({ deadlineIso: 'nonsense' })).rejects.toBeInstanceOf(
      MergeQueueDeadlineError,
    );
  });

  it('reads an empty list when the store file is absent', async () => {
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    await expect(adapter.listMergeEntries({ deadlineIso: futureDeadline() })).resolves.toEqual([]);
  });

  it('two repositories in memory: listMergeEntries returns only the queried repository', async () => {
    const adapter = new MergeQueueRepositoryAdapter();
    const { fleetId, otherId } = await enqueueFleetAndOther(adapter);
    const deadlineIso = futureDeadline();
    const fleetEntries = await adapter.listMergeEntries({
      repository: { owner: 'fleet', repo: 'v2' },
      deadlineIso,
    });
    const otherEntries = await adapter.listMergeEntries({
      repository: { owner: 'other', repo: 'repo' },
      deadlineIso,
    });
    expect(fleetEntries.map((entry) => entry.entryId)).toEqual([fleetId]);
    expect(otherEntries.map((entry) => entry.entryId)).toEqual([otherId]);
    expect(fleetEntries[0]?.repository).toEqual({ owner: 'fleet', repo: 'v2' });
    expect(otherEntries[0]?.repository).toEqual({ owner: 'other', repo: 'repo' });
    expect(fleetEntries[0]?.repoDigest).toBe(digestOf('fleet', 'v2'));
    expect(otherEntries[0]?.repoDigest).toBe(digestOf('other', 'repo'));
    await expect(
      adapter.listMergeEntries({ repository: { owner: 'missing', repo: 'repo' }, deadlineIso }),
    ).resolves.toEqual([]);

    const nullRepository = Object.assign(Object.create(null) as object, { owner: 'fleet', repo: 'v2' });
    const nullQuery = Object.assign(Object.create(null) as object, { deadlineIso, repository: nullRepository });
    const fromNullPrototype = await adapter.listMergeEntries(nullQuery as never);
    expect(fromNullPrototype.map((entry) => entry.entryId)).toEqual([fleetId]);
  });

  it('two repositories on disk: listMergeEntries returns only the queried repository from merge-queue.json', async () => {
    const writer = new MergeQueueRepositoryAdapter({ stateDir });
    const { fleetId, otherId } = await enqueueFleetAndOther(writer);
    const reader = new MergeQueueRepositoryAdapter({ stateDir });
    const deadlineIso = futureDeadline();
    const fleetEntries = await reader.listMergeEntries({
      repository: { owner: 'fleet', repo: 'v2' },
      deadlineIso,
    });
    const otherEntries = await reader.listMergeEntries({
      repository: { owner: 'other', repo: 'repo' },
      deadlineIso,
    });
    expect(fleetEntries.map((entry) => entry.entryId)).toEqual([fleetId]);
    expect(otherEntries.map((entry) => entry.entryId)).toEqual([otherId]);
    expect(fleetEntries[0]?.repository).toEqual({ owner: 'fleet', repo: 'v2' });
    expect(otherEntries[0]?.repository).toEqual({ owner: 'other', repo: 'repo' });
    expect(fleetEntries[0]?.repoDigest).toBe(digestOf('fleet', 'v2'));
    expect(otherEntries[0]?.repoDigest).toBe(digestOf('other', 'repo'));
  });

  it('on-disk entries are filtered by stored repoDigest, so a mismatched digest is excluded', async () => {
    const fleetId = nextEntryId();
    const otherId = nextEntryId();
    const fleetDigest = digestOf('fleet', 'v2');
    const otherDigest = digestOf('other', 'repo');
    await fs.writeFile(
      path.join(stateDir, 'merge-queue.json'),
      JSON.stringify([
        queuedRecord({
          entryId: fleetId,
          owner: 'fleet',
          repo: 'v2',
          pullRequest: 7,
          headOid: HEAD_A,
          repoDigest: otherDigest,
        }),
        queuedRecord({
          entryId: otherId,
          owner: 'other',
          repo: 'repo',
          pullRequest: 9,
          headOid: HEAD_B,
          repoDigest: fleetDigest,
        }),
      ]),
    );
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    const deadlineIso = futureDeadline();
    const all = await adapter.listMergeEntries({ deadlineIso });
    expect(all.map((entry) => entry.entryId)).toEqual([fleetId, otherId]);
    // The fleet row stores the other repository's digest, and the other row
    // stores the fleet digest. A list matches the digest, so each query
    // returns the row whose repository fields name the other side.
    const fleetEntries = await adapter.listMergeEntries({
      repository: { owner: 'fleet', repo: 'v2' },
      deadlineIso,
    });
    const otherEntries = await adapter.listMergeEntries({
      repository: { owner: 'other', repo: 'repo' },
      deadlineIso,
    });
    expect(fleetEntries.map((entry) => entry.entryId)).toEqual([otherId]);
    expect(fleetEntries[0]?.repoDigest).toBe(fleetDigest);
    expect(otherEntries.map((entry) => entry.entryId)).toEqual([fleetId]);
    expect(otherEntries[0]?.repoDigest).toBe(otherDigest);
  });

  it('omitting repository returns entries from both repositories', async () => {
    const memory = new MergeQueueRepositoryAdapter();
    const memoryIds = await enqueueFleetAndOther(memory);
    const memoryAll = await memory.listMergeEntries({ deadlineIso: futureDeadline() });
    expect(memoryAll.map((entry) => entry.entryId)).toEqual([memoryIds.fleetId, memoryIds.otherId]);

    const writer = new MergeQueueRepositoryAdapter({ stateDir });
    const diskIds = await enqueueFleetAndOther(writer);
    const reader = new MergeQueueRepositoryAdapter({ stateDir });
    const diskAll = await reader.listMergeEntries({ deadlineIso: futureDeadline() });
    expect(diskAll.map((entry) => entry.entryId)).toEqual([diskIds.fleetId, diskIds.otherId]);
  });

  it('a constant return of an empty list or of every entry fails repository filtering', async () => {
    const adapter = new MergeQueueRepositoryAdapter();
    const { fleetId, otherId } = await enqueueFleetAndOther(adapter);
    const deadlineIso = futureDeadline();
    const fleetEntries = await adapter.listMergeEntries({
      repository: { owner: 'fleet', repo: 'v2' },
      deadlineIso,
    });
    const otherEntries = await adapter.listMergeEntries({
      repository: { owner: 'other', repo: 'repo' },
      deadlineIso,
    });
    const allEntries = await adapter.listMergeEntries({ deadlineIso });
    expect(fleetEntries.map((entry) => entry.entryId)).toEqual([fleetId]);
    expect(otherEntries.map((entry) => entry.entryId)).toEqual([otherId]);
    expect(allEntries).toHaveLength(2);
    expect(fleetEntries).not.toEqual(allEntries);
    expect(otherEntries).not.toEqual(allEntries);
    expect(fleetEntries).not.toEqual(otherEntries);
  });

  it('an identity echo of the query fails', async () => {
    const adapter = new MergeQueueRepositoryAdapter();
    const { fleetId } = await enqueueFleetAndOther(adapter);
    const query = {
      repository: { owner: 'fleet', repo: 'v2' },
      deadlineIso: futureDeadline(),
    };
    const result = await adapter.listMergeEntries(query);
    expect(result).not.toBe(query);
    expect(result).not.toEqual(query);
    expect(result.map((entry) => entry.entryId)).toEqual([fleetId]);
    expect(Object.hasOwn(result, 'deadlineIso')).toBe(false);
    expect(Object.hasOwn(result, 'repository')).toBe(false);
  });

  it('query is null or undefined throws MergeQueueDeadlineError', async () => {
    const filePath = await writeTruncated(stateDir);
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    await expectDeadlineRefusal(adapter.listMergeEntries(null as never));
    await expectDeadlineRefusal(adapter.listMergeEntries(undefined as never));
    expect((await fs.readFile(filePath)).toString('utf8')).toBe('{ truncated');
  });

  it('query.repository is null throws MergeQueueDeadlineError', async () => {
    const filePath = await writeTruncated(stateDir);
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    await expectDeadlineRefusal(
      adapter.listMergeEntries({ repository: null, deadlineIso: futureDeadline() } as never),
    );
    expect((await fs.readFile(filePath)).toString('utf8')).toBe('{ truncated');
  });

  it('query.repository is undefined returns all entries', async () => {
    const adapter = new MergeQueueRepositoryAdapter();
    const { fleetId, otherId } = await enqueueFleetAndOther(adapter);
    const result = await adapter.listMergeEntries({
      repository: undefined,
      deadlineIso: futureDeadline(),
    });
    expect(result.map((entry) => entry.entryId)).toEqual([fleetId, otherId]);
  });

  it('query.repository is a wrong primitive throws MergeQueueDeadlineError', async () => {
    const filePath = await writeTruncated(stateDir);
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    const deadlineIso = futureDeadline();
    await expectDeadlineRefusal(adapter.listMergeEntries({ repository: 42, deadlineIso } as never));
    await expectDeadlineRefusal(adapter.listMergeEntries({ repository: 'fleet/v2', deadlineIso } as never));
    expect((await fs.readFile(filePath)).toString('utf8')).toBe('{ truncated');
  });

  it('query.repository is a non-plain object throws MergeQueueDeadlineError', async () => {
    const filePath = await writeTruncated(stateDir);
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    const deadlineIso = futureDeadline();
    class RepositoryInstance {
      readonly owner = 'fleet';
      readonly repo = 'v2';
    }
    const customPrototype = Object.create({ owner: 'fleet', repo: 'v2' }) as { owner: string; repo: string };
    await expectDeadlineRefusal(adapter.listMergeEntries({ repository: [], deadlineIso } as never));
    await expectDeadlineRefusal(adapter.listMergeEntries({ repository: new Date(), deadlineIso } as never));
    await expectDeadlineRefusal(
      adapter.listMergeEntries({ repository: new RepositoryInstance(), deadlineIso } as never),
    );
    await expectDeadlineRefusal(adapter.listMergeEntries({ repository: customPrototype, deadlineIso }));
    expect((await fs.readFile(filePath)).toString('utf8')).toBe('{ truncated');
  });

  it('a missing, non-string, or empty owner or repo on query.repository throws MergeQueueDeadlineError', async () => {
    const filePath = await writeTruncated(stateDir);
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    const deadlineIso = futureDeadline();
    const malformed = [
      { owner: 'fleet' },
      { repo: 'v2' },
      { owner: '', repo: 'v2' },
      { owner: 'fleet', repo: '' },
      { owner: 1, repo: 'v2' },
      { owner: 'fleet', repo: 1 },
    ];
    for (const repository of malformed) {
      await expectDeadlineRefusal(adapter.listMergeEntries({ repository, deadlineIso } as never));
    }
    const nonEnumerableOwner = { repo: 'v2' };
    Object.defineProperty(nonEnumerableOwner, 'owner', { value: 'fleet', enumerable: false });
    await expectDeadlineRefusal(
      adapter.listMergeEntries({ repository: nonEnumerableOwner, deadlineIso } as never),
    );
    expect((await fs.readFile(filePath)).toString('utf8')).toBe('{ truncated');
  });

  it('a getter on query or query.repository never runs and throws MergeQueueDeadlineError', async () => {
    const filePath = await writeTruncated(stateDir);
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    let repositoryGets = 0;
    const withRepositoryGetter = { deadlineIso: futureDeadline() };
    Object.defineProperty(withRepositoryGetter, 'repository', {
      enumerable: true,
      configurable: true,
      get() {
        repositoryGets += 1;
        throw new Error('repository getter');
      },
    });
    await expectDeadlineRefusal(adapter.listMergeEntries(withRepositoryGetter));
    expect(repositoryGets).toBe(0);

    let deadlineGets = 0;
    const withDeadlineGetter: { repository: { owner: string; repo: string } } = {
      repository: { owner: 'fleet', repo: 'v2' },
    };
    Object.defineProperty(withDeadlineGetter, 'deadlineIso', {
      enumerable: true,
      configurable: true,
      get() {
        deadlineGets += 1;
        throw new Error('deadline getter');
      },
    });
    await expectDeadlineRefusal(adapter.listMergeEntries(withDeadlineGetter as never));
    expect(deadlineGets).toBe(0);
    expect((await fs.readFile(filePath)).toString('utf8')).toBe('{ truncated');
  });

  it('a Proxy over a valid query or query.repository yields the plain result and runs no get trap', async () => {
    const adapter = new MergeQueueRepositoryAdapter();
    const { fleetId } = await enqueueFleetAndOther(adapter);
    const deadlineIso = futureDeadline();
    const plain = { repository: { owner: 'fleet', repo: 'v2' }, deadlineIso };
    const plainResult = await adapter.listMergeEntries(plain);

    let getCalls = 0;
    const queryProxy = new Proxy(plain, {
      get(target, property, receiver) {
        getCalls += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const queryProxyResult = await adapter.listMergeEntries(queryProxy);
    expect(getCalls).toBe(0);
    expect(queryProxyResult).toEqual(plainResult);

    const repositoryProxy = new Proxy(plain.repository, {
      get(target, property, receiver) {
        getCalls += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const nestedResult = await adapter.listMergeEntries({ repository: repositoryProxy, deadlineIso });
    expect(getCalls).toBe(0);
    expect(nestedResult).toEqual(plainResult);
    expect(plainResult.map((entry) => entry.entryId)).toEqual([fleetId]);
  });

  it('a Proxy that throws on trap access throws MergeQueueDeadlineError', async () => {
    const filePath = await writeTruncated(stateDir);
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    const deadlineIso = futureDeadline();
    const queryTarget = { deadlineIso, repository: { owner: 'fleet', repo: 'v2' } };
    await expectDeadlineRefusal(adapter.listMergeEntries(proxyThatThrows(queryTarget) as never));
    await expectDeadlineRefusal(
      adapter.listMergeEntries({
        deadlineIso,
        repository: proxyThatThrows({ owner: 'fleet', repo: 'v2' }),
      } as never),
    );
    expect((await fs.readFile(filePath)).toString('utf8')).toBe('{ truncated');
  });

  it('prototype-polluting own keys on query or query.repository throw MergeQueueDeadlineError and never pollute Object.prototype', async () => {
    const filePath = await writeTruncated(stateDir);
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    const deadlineIso = futureDeadline();
    const marker = 'qf1Polluted';
    const constructorBefore = Object.prototype.constructor;
    try {
      for (const key of ['__proto__', 'constructor', 'prototype']) {
        const pollutedQuery: unknown = JSON.parse(
          `{"deadlineIso":${JSON.stringify(deadlineIso)},${JSON.stringify(key)}:{"${marker}":true}}`,
        );
        await expectDeadlineRefusal(adapter.listMergeEntries(pollutedQuery as never));
        const pollutedRepository: unknown = JSON.parse(
          `{"owner":"fleet","repo":"v2",${JSON.stringify(key)}:{"${marker}":true}}`,
        );
        await expectDeadlineRefusal(
          adapter.listMergeEntries({ deadlineIso, repository: pollutedRepository } as never),
        );
      }
      expect(Object.prototype.constructor).toBe(constructorBefore);
      expect(Object.getOwnPropertyDescriptor(Object.prototype, marker)).toBeUndefined();
    } finally {
      delete (Object.prototype as Record<string, unknown>)[marker];
    }
    expect((await fs.readFile(filePath)).toString('utf8')).toBe('{ truncated');
  });

  it('a query with 10000 extra own keys is refused with MergeQueueDeadlineError before any descriptor is read', async () => {
    const filePath = await writeTruncated(stateDir);
    const adapter = new MergeQueueRepositoryAdapter({ stateDir });
    const bloated: Record<string, unknown> = {
      deadlineIso: futureDeadline(),
      repository: { owner: 'fleet', repo: 'v2' },
    };
    for (let index = 0; index < 10_000; index += 1) {
      bloated[`extra${index}`] = index;
    }
    let descriptorReads = 0;
    const query = new Proxy(bloated, {
      getOwnPropertyDescriptor(target, property) {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    await expectDeadlineRefusal(adapter.listMergeEntries(query as never));
    expect(descriptorReads).toBe(0);
    expect((await fs.readFile(filePath)).toString('utf8')).toBe('{ truncated');
  });
});
