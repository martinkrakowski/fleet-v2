import { describe, expect, it, vi } from 'vitest';

import type { DaemonStatusPort } from '../../../application/ports/out/DaemonStatusPort.out-port.js';
import type {
  ForgeMergeReadPort,
  ReadForgeMergeRequest,
} from '../../../application/ports/out/ForgeMergeReadPort.out-port.js';
import type {
  MergeQueueListQuery,
  MergeQueueRepositoryPort,
} from '../../../application/ports/out/MergeQueueRepositoryPort.out-port.js';
import type {
  TrainHealthStateReadRequest,
  TrainHealthStateReadResult,
} from '../../../application/ports/out/TrainHealthStateReadPort.out-port.js';
import { buildDaemonStatusRecord } from '../../../domain/daemon-tick.js';
import {
  MERGE_QUEUE_ORDER_CAP,
  type MergeQueueEntryRecord,
} from '../../../domain/merge-queue-records.js';
import type { TrainHealthSnapshot } from '../../../domain/train-health-rules.js';
import { sha256HexDigest } from '../AttemptArtifactAdapter.adapter.js';
import { MergeQueueRepositoryAdapter } from '../MergeQueueRepositoryAdapter.adapter.js';
import { TrainHealthStateReadAdapter } from '../TrainHealthStateReadAdapter.adapter.js';

const REPOSITORY = { owner: 'fleet', repo: 'v2' };
const OTHER_REPOSITORY = { owner: 'other', repo: 'repo' };
const REPO_DIGEST = sha256HexDigest(`${REPOSITORY.owner}/${REPOSITORY.repo}`).slice(0, 12);
const CLOCK = '2026-11-01T12:00:00.000Z';
const REQUEST_NOW = '2026-11-01T08:00:00.000Z';
const ENQUEUED = '2026-11-01T11:00:00.000Z';
/** The adapter's forge window: read start plus this, and never past the request deadline. */
const FORGE_READ_WINDOW_MS = 20_000;
const FINISHED = '2026-11-01T12:00:00.000Z';
const TICK = `tick-0${'1'.repeat(25)}`;

let entryOrdinal = 0;

function nextEntryId(): string {
  entryOrdinal += 1;
  return `01JB${String(entryOrdinal).padStart(22, '0')}`;
}

function headFor(pullRequest: number): string {
  return pullRequest.toString(16).padStart(40, '0');
}

function futureDeadline(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function effectiveForgeDeadline(readStartIso: string, requestDeadlineIso: string): string {
  const effectiveMs = Math.min(
    Date.parse(requestDeadlineIso),
    Date.parse(readStartIso) + FORGE_READ_WINDOW_MS,
  );
  return new Date(effectiveMs).toISOString();
}

function withOwn(record: MergeQueueEntryRecord, key: string, value: unknown): unknown {
  return { ...record, [key]: value };
}

async function queuedRecord(): Promise<MergeQueueEntryRecord> {
  const { records } = await seed([{ pullRequest: 7 }]);
  const template = records[0];
  if (template === undefined) {
    throw new Error('expected a real queue record');
  }
  return template;
}

function healthRequest(
  overrides: Partial<TrainHealthStateReadRequest> = {},
): TrainHealthStateReadRequest {
  return {
    repository: { ...REPOSITORY },
    repoDigest: REPO_DIGEST,
    nowIso: REQUEST_NOW,
    deadlineIso: futureDeadline(),
    ...overrides,
  };
}

function builtStatus() {
  const built = buildDaemonStatusRecord({
    tickId: TICK,
    startedAtIso: FINISHED,
    finishedAtIso: FINISHED,
    paused: false,
    halted: false,
    forgeReachable: true,
    jobs: [
      {
        jobId: 'merge-pass:00000000000a',
        outcome: 'completed',
        reasonCode: null,
        leaseFence: 1,
        durationMs: 10,
        nextNotBeforeIso: null,
        consecutiveBudgetExhausted: 0,
      },
    ],
    repositories: [],
    notifierCursor: null,
  });
  if (!built.ok) {
    throw new Error('fixture status must build');
  }
  return built.record;
}

async function enqueue(
  queue: MergeQueueRepositoryAdapter,
  spec: {
    readonly pullRequest: number;
    readonly enqueuedAtIso?: string;
    readonly repository?: { readonly owner: string; readonly repo: string };
  },
): Promise<MergeQueueEntryRecord> {
  const decision = await queue.enqueueMergeEntry({
    repository: spec.repository ?? { ...REPOSITORY },
    pullRequest: spec.pullRequest,
    headOid: headFor(spec.pullRequest),
    tier: 2,
    enqueuedBy: 'cli',
    runId: null,
    entryId: nextEntryId(),
    successorEntryId: nextEntryId(),
    enqueuedAtIso: spec.enqueuedAtIso ?? ENQUEUED,
    deadlineIso: futureDeadline(),
  });
  if (decision.outcome === 'refused') {
    throw new Error(`enqueue refused: ${decision.reason}`);
  }
  return decision.record;
}

async function seed(
  specs: readonly {
    readonly pullRequest: number;
    readonly enqueuedAtIso?: string;
    readonly repository?: { readonly owner: string; readonly repo: string };
  }[],
): Promise<{ queue: MergeQueueRepositoryAdapter; records: MergeQueueEntryRecord[] }> {
  const queue = new MergeQueueRepositoryAdapter();
  const records: MergeQueueEntryRecord[] = [];
  for (const spec of specs) {
    records.push(await enqueue(queue, spec));
  }
  return { queue, records };
}

function asStatus(read: () => Promise<unknown>): Pick<DaemonStatusPort, 'read'> {
  return { read: read as DaemonStatusPort['read'] };
}

function asQueue(
  listMergeEntries: (query: MergeQueueListQuery) => Promise<unknown>,
): Pick<MergeQueueRepositoryPort, 'listMergeEntries'> {
  return { listMergeEntries: listMergeEntries as MergeQueueRepositoryPort['listMergeEntries'] };
}

function asForge(
  readForgeMerge: (request: ReadForgeMergeRequest) => Promise<unknown>,
): Pick<ForgeMergeReadPort, 'readForgeMerge'> {
  return { readForgeMerge: readForgeMerge as ForgeMergeReadPort['readForgeMerge'] };
}

function openForge() {
  return vi.fn(async (_request: ReadForgeMergeRequest) => ({
    outcome: 'ok',
    prState: 'open',
  }));
}

function missingStatus() {
  return { read: async () => ({ status: 'missing' as const }) };
}

function adapterFor(parts: {
  readonly status: Pick<DaemonStatusPort, 'read'>;
  readonly queue: Pick<MergeQueueRepositoryPort, 'listMergeEntries'>;
  readonly forge: Pick<ForgeMergeReadPort, 'readForgeMerge'>;
  readonly now?: () => string;
  readonly maxForgeReads?: number;
}): TrainHealthStateReadAdapter {
  return new TrainHealthStateReadAdapter({
    status: parts.status,
    queue: parts.queue,
    forge: parts.forge,
    now: parts.now ?? (() => CLOCK),
    ...(parts.maxForgeReads === undefined ? {} : { maxForgeReads: parts.maxForgeReads }),
  });
}

function ports() {
  const statusRead = vi.fn(async () => ({ status: 'missing' as const }));
  const listMergeEntries = vi.fn(async (_query: MergeQueueListQuery) => [] as readonly unknown[]);
  const readForgeMerge = openForge();
  const adapter = adapterFor({
    status: asStatus(statusRead),
    queue: asQueue(listMergeEntries),
    forge: asForge(readForgeMerge),
  });
  return { adapter, statusRead, listMergeEntries, readForgeMerge };
}

function expectNoPortCalls(spies: {
  statusRead: { mock: { calls: readonly unknown[] } };
  listMergeEntries: { mock: { calls: readonly unknown[] } };
  readForgeMerge: { mock: { calls: readonly unknown[] } };
}): void {
  expect(spies.statusRead).not.toHaveBeenCalled();
  expect(spies.listMergeEntries).not.toHaveBeenCalled();
  expect(spies.readForgeMerge).not.toHaveBeenCalled();
}

function assertOk(
  result: TrainHealthStateReadResult,
): asserts result is { outcome: 'ok'; snapshot: TrainHealthSnapshot } {
  if (result.outcome !== 'ok') {
    expect(result).toEqual({ outcome: 'ok' });
    throw new Error('expected ok');
  }
}

function isOldestFirst(
  entries: readonly { readonly enqueuedAtIso: string; readonly pullRequest: number }[],
): boolean {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (previous === undefined || current === undefined) {
      return false;
    }
    const previousMs = Date.parse(previous.enqueuedAtIso);
    const currentMs = Date.parse(current.enqueuedAtIso);
    if (currentMs < previousMs) {
      return false;
    }
    if (currentMs === previousMs && current.pullRequest < previous.pullRequest) {
      return false;
    }
  }
  return true;
}

describe('TrainHealthStateReadAdapter', () => {
  it('returns a snapshot for a fresh status and one queued entry with forge open', async () => {
    const status = builtStatus();
    const { queue, records } = await seed([{ pullRequest: 7 }]);
    const readForgeMerge = openForge();
    const request = healthRequest();
    const result = await adapterFor({
      status: { read: async () => ({ status: 'ok', record: status }) },
      queue,
      forge: asForge(readForgeMerge),
    }).readTrainHealthState(request);

    expect(result).toEqual({
      outcome: 'ok',
      snapshot: {
        queue: [
          {
            pullRequest: 7,
            state: 'queued',
            forgeState: 'open',
            enqueuedAtIso: ENQUEUED,
            attempt: 0,
          },
        ],
        lastTickFinishedAtIso: status.finishedAtIso,
      },
    });
    assertOk(result);
    expect(Object.hasOwn(result.snapshot, 'lastMergedAtIso')).toBe(false);
    expect(readForgeMerge).toHaveBeenCalledTimes(1);
    expect(readForgeMerge.mock.calls[0]?.[0]).toMatchObject({
      repository: REPOSITORY,
      pullRequestNumber: 7,
      headSha: records[0]?.headOid,
      requiredContexts: [],
      deadlineIso: effectiveForgeDeadline(CLOCK, request.deadlineIso),
      nowIso: CLOCK,
    });
    expect(readForgeMerge.mock.calls[0]?.[0].nowIso).not.toBe(request.nowIso);
  });

  it('omits lastTickFinishedAtIso when status is missing', async () => {
    const { queue } = await seed([{ pullRequest: 7 }]);
    const result = await adapterFor({
      status: missingStatus(),
      queue,
      forge: asForge(openForge()),
    }).readTrainHealthState(healthRequest());

    assertOk(result);
    expect(result.snapshot.queue).toEqual([
      {
        pullRequest: 7,
        state: 'queued',
        forgeState: 'open',
        enqueuedAtIso: ENQUEUED,
        attempt: 0,
      },
    ]);
    expect(Object.hasOwn(result.snapshot, 'lastTickFinishedAtIso')).toBe(false);
  });

  it('skips a record of another repoDigest', async () => {
    const { queue } = await seed([
      { pullRequest: 7 },
      { pullRequest: 9, repository: OTHER_REPOSITORY },
    ]);
    const result = await adapterFor({
      status: missingStatus(),
      queue,
      forge: asForge(openForge()),
    }).readTrainHealthState(healthRequest());

    assertOk(result);
    expect(result.snapshot.queue.map((entry) => entry.pullRequest)).toEqual([7]);
  });

  it('carries forge closed and merged states', async () => {
    const { queue } = await seed([
      { pullRequest: 7, enqueuedAtIso: '2026-11-01T11:00:00.000Z' },
      { pullRequest: 8, enqueuedAtIso: '2026-11-01T11:05:00.000Z' },
    ]);
    const prStates = ['closed', 'merged'] as const;
    let index = 0;
    const readForgeMerge = vi.fn(async (_request: ReadForgeMergeRequest) => {
      const prState = prStates[index];
      index += 1;
      return { outcome: 'ok', prState };
    });
    const result = await adapterFor({
      status: missingStatus(),
      queue,
      forge: asForge(readForgeMerge),
    }).readTrainHealthState(healthRequest());

    assertOk(result);
    expect(result.snapshot.queue.map((entry) => entry.forgeState)).toEqual(['closed', 'merged']);
    expect(result.snapshot.queue.map((entry) => entry.state)).toEqual(['queued', 'queued']);
  });

  it('ignores nowIso and reads its own clock', async () => {
    const { queue, records } = await seed([{ pullRequest: 7 }]);
    const readForgeMerge = openForge();
    const request = healthRequest({ nowIso: 'tomorrow' });
    const result = await adapterFor({
      status: missingStatus(),
      queue,
      forge: asForge(readForgeMerge),
    }).readTrainHealthState(request);

    assertOk(result);
    expect(result.snapshot.queue).toHaveLength(1);
    expect(readForgeMerge.mock.calls[0]?.[0]).toMatchObject({
      nowIso: CLOCK,
      headSha: records[0]?.headOid,
      deadlineIso: effectiveForgeDeadline(CLOCK, request.deadlineIso),
    });
    expect(readForgeMerge.mock.calls[0]?.[0].nowIso).not.toBe('tomorrow');
  });

  it('uses the latest mergedAtIso of two merged entries as lastMergedAtIso', async () => {
    const { records } = await seed([{ pullRequest: 7 }]);
    const template = records[0];
    if (template === undefined) {
      throw new Error('expected a real queue record');
    }
    const later = '2026-11-03T00:00:00.000Z';
    const earlier = '2026-11-02T00:00:00.000Z';
    const listMergeEntries = vi.fn(async (_query: MergeQueueListQuery) => [
      { ...template, pullRequest: 7, state: 'merged', mergedAtIso: later },
      { ...template, pullRequest: 8, state: 'merged', mergedAtIso: earlier },
    ]);
    const result = await adapterFor({
      status: missingStatus(),
      queue: asQueue(listMergeEntries),
      forge: asForge(openForge()),
    }).readTrainHealthState(healthRequest());

    assertOk(result);
    expect(result.snapshot.queue).toEqual([]);
    expect(result.snapshot.lastMergedAtIso).toBe(later);
    expect(Object.hasOwn(result.snapshot, 'lastTickFinishedAtIso')).toBe(false);
  });

  it('returns invalid-request for a null request without calling ports', async () => {
    const spies = ports();
    const result = await spies.adapter.readTrainHealthState(
      null as unknown as TrainHealthStateReadRequest,
    );

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'invalid-request' });
    expectNoPortCalls(spies);
  });

  it('returns invalid-request when repository is a throwing getter', async () => {
    const spies = ports();
    const request = healthRequest();
    let invoked = false;
    Object.defineProperty(request, 'repository', {
      configurable: true,
      enumerable: true,
      get() {
        invoked = true;
        throw new Error('repository');
      },
    });
    const result = await spies.adapter.readTrainHealthState(request);

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'invalid-request' });
    expect(invoked).toBe(false);
    expectNoPortCalls(spies);
  });

  it('returns invalid-request when owner is ..', async () => {
    const spies = ports();
    const result = await spies.adapter.readTrainHealthState(
      healthRequest({ repository: { owner: '..', repo: 'v2' } }),
    );

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'invalid-request' });
    expectNoPortCalls(spies);
  });

  it('returns invalid-request when repoDigest is not 12 lowercase hex', async () => {
    const spies = ports();
    const result = await spies.adapter.readTrainHealthState(
      healthRequest({ repoDigest: 'ABCDEF012345' }),
    );

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'invalid-request' });
    expectNoPortCalls(spies);
  });

  it('returns invalid-clock when deadlineIso is malformed', async () => {
    const spies = ports();
    const result = await spies.adapter.readTrainHealthState(
      healthRequest({ deadlineIso: 'tomorrow' }),
    );

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'invalid-clock' });
    expectNoPortCalls(spies);
  });

  it('returns invalid-clock when now() throws', async () => {
    const statusRead = vi.fn(async () => ({ status: 'missing' as const }));
    const listMergeEntries = vi.fn(async () => [] as readonly unknown[]);
    const readForgeMerge = openForge();
    const adapter = adapterFor({
      status: asStatus(statusRead),
      queue: asQueue(listMergeEntries),
      forge: asForge(readForgeMerge),
      now: () => {
        throw new Error('clock');
      },
    });
    const result = await adapter.readTrainHealthState(healthRequest());

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'invalid-clock' });
    expectNoPortCalls({ statusRead, listMergeEntries, readForgeMerge });
  });

  it('returns invalid-clock when now() is not a zoned ISO time', async () => {
    const statusRead = vi.fn(async () => ({ status: 'missing' as const }));
    const listMergeEntries = vi.fn(async () => [] as readonly unknown[]);
    const readForgeMerge = openForge();
    const adapter = adapterFor({
      status: asStatus(statusRead),
      queue: asQueue(listMergeEntries),
      forge: asForge(readForgeMerge),
      now: () => 'tomorrow',
    });
    const result = await adapter.readTrainHealthState(healthRequest());

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'invalid-clock' });
    expectNoPortCalls({ statusRead, listMergeEntries, readForgeMerge });
  });

  it('returns budget-exhausted with zero port calls when deadline is 1s away', async () => {
    const statusRead = vi.fn(async () => ({ status: 'missing' as const }));
    const listMergeEntries = vi.fn(async () => [] as readonly unknown[]);
    const readForgeMerge = openForge();
    const adapter = adapterFor({
      status: asStatus(statusRead),
      queue: asQueue(listMergeEntries),
      forge: asForge(readForgeMerge),
      now: () => new Date().toISOString(),
    });
    const result = await adapter.readTrainHealthState(
      healthRequest({ deadlineIso: futureDeadline(1_000) }),
    );

    expect(result).toEqual({ outcome: 'budget-exhausted' });
    expectNoPortCalls({ statusRead, listMergeEntries, readForgeMerge });
  });

  it('returns budget-exhausted when the deadline passes between the status read and the queue read', async () => {
    const deadlineIso = '2026-11-01T12:01:00.000Z';
    const early = '2026-11-01T12:00:30.000Z';
    const late = '2026-11-01T12:00:59.000Z';
    // now() runs for the read start, the status budget, then the queue budget.
    let reads = 0;
    const now = () => {
      reads += 1;
      return reads < 3 ? early : late;
    };
    const statusRead = vi.fn(async () => ({ status: 'missing' as const }));
    const listMergeEntries = vi.fn(async () => [] as readonly unknown[]);
    const readForgeMerge = openForge();
    const result = await adapterFor({
      status: asStatus(statusRead),
      queue: asQueue(listMergeEntries),
      forge: asForge(readForgeMerge),
      now,
    }).readTrainHealthState(healthRequest({ deadlineIso }));

    expect(result).toEqual({ outcome: 'budget-exhausted' });
    expect(statusRead).toHaveBeenCalledTimes(1);
    expect(listMergeEntries).not.toHaveBeenCalled();
    expect(readForgeMerge).not.toHaveBeenCalled();
  });

  it('returns status-unreadable when status is unreadable and skips queue', async () => {
    const listMergeEntries = vi.fn(async () => [] as readonly unknown[]);
    const result = await adapterFor({
      status: { read: async () => ({ status: 'unreadable' }) },
      queue: asQueue(listMergeEntries),
      forge: asForge(openForge()),
    }).readTrainHealthState(healthRequest());

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'status-unreadable' });
    expect(listMergeEntries).not.toHaveBeenCalled();
  });

  it('returns status-unreadable when status.read throws', async () => {
    const listMergeEntries = vi.fn(async () => [] as readonly unknown[]);
    const result = await adapterFor({
      status: asStatus(async () => {
        throw new Error('status down');
      }),
      queue: asQueue(listMergeEntries),
      forge: asForge(openForge()),
    }).readTrainHealthState(healthRequest());

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'status-unreadable' });
    expect(listMergeEntries).not.toHaveBeenCalled();
  });

  it('returns status-unreadable when status record fails readDaemonStatusRecord', async () => {
    const listMergeEntries = vi.fn(async () => [] as readonly unknown[]);
    const result = await adapterFor({
      status: asStatus(async () => ({ status: 'ok', record: { version: 1 } })),
      queue: asQueue(listMergeEntries),
      forge: asForge(openForge()),
    }).readTrainHealthState(healthRequest());

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'status-unreadable' });
    expect(listMergeEntries).not.toHaveBeenCalled();
  });

  it('returns queue-unreadable when listMergeEntries throws', async () => {
    const result = await adapterFor({
      status: missingStatus(),
      queue: asQueue(async () => {
        throw new Error('list failed');
      }),
      forge: asForge(openForge()),
    }).readTrainHealthState(healthRequest());

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'queue-unreadable' });
  });

  it('returns queue-unreadable when listMergeEntries returns a non-array', async () => {
    const result = await adapterFor({
      status: missingStatus(),
      queue: asQueue(async () => ({ length: 1 })),
      forge: asForge(openForge()),
    }).readTrainHealthState(healthRequest());

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'queue-unreadable' });
  });

  it('returns queue-unreadable when listMergeEntries returns more than MERGE_QUEUE_ORDER_CAP records', async () => {
    const { records } = await seed([{ pullRequest: 7, repository: OTHER_REPOSITORY }]);
    const template = records[0];
    if (template === undefined) {
      throw new Error('expected a real queue record');
    }
    const listed = Array.from({ length: MERGE_QUEUE_ORDER_CAP + 1 }, (_, index) => ({
      ...template,
      pullRequest: index + 1,
      headOid: headFor(index + 1),
    }));
    const result = await adapterFor({
      status: missingStatus(),
      queue: asQueue(async () => listed),
      forge: asForge(openForge()),
    }).readTrainHealthState(healthRequest());

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'queue-unreadable' });
    expect(template.repoDigest).toBe(
      sha256HexDigest(`${OTHER_REPOSITORY.owner}/${OTHER_REPOSITORY.repo}`).slice(0, 12),
    );
    expect(listed).toHaveLength(MERGE_QUEUE_ORDER_CAP + 1);
    expect(listed[0]).toMatchObject({
      repoDigest: template.repoDigest,
      state: 'queued',
      attempt: 0,
      headOid: headFor(1),
    });
  });

  it('returns queue-unreadable when a matching record has pullRequest 0', async () => {
    const { records } = await seed([{ pullRequest: 7 }]);
    const template = records[0];
    if (template === undefined) {
      throw new Error('expected a real queue record');
    }
    const result = await adapterFor({
      status: missingStatus(),
      queue: asQueue(async () => [{ ...template, pullRequest: 0 }]),
      forge: asForge(openForge()),
    }).readTrainHealthState(healthRequest());

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'queue-unreadable' });
  });

  it('returns queue-unreadable when a matching record has a malformed state', async () => {
    const template = await queuedRecord();
    const result = await adapterFor({
      status: missingStatus(),
      queue: asQueue(async () => [withOwn(template, 'state', 'not-a-state')]),
      forge: asForge(openForge()),
    }).readTrainHealthState(healthRequest());

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'queue-unreadable' });
  });

  it('returns queue-unreadable when a matching record has a malformed attempt', async () => {
    const template = await queuedRecord();
    const result = await adapterFor({
      status: missingStatus(),
      queue: asQueue(async () => [withOwn(template, 'attempt', -1)]),
      forge: asForge(openForge()),
    }).readTrainHealthState(healthRequest());

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'queue-unreadable' });
  });

  it('returns queue-unreadable when a matching record has a malformed enqueuedAtIso', async () => {
    const template = await queuedRecord();
    const result = await adapterFor({
      status: missingStatus(),
      queue: asQueue(async () => [withOwn(template, 'enqueuedAtIso', 'tomorrow')]),
      forge: asForge(openForge()),
    }).readTrainHealthState(healthRequest());

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'queue-unreadable' });
  });

  it('returns queue-unreadable when a matching record has a malformed headOid', async () => {
    const template = await queuedRecord();
    const result = await adapterFor({
      status: missingStatus(),
      queue: asQueue(async () => [withOwn(template, 'headOid', 'abcd')]),
      forge: asForge(openForge()),
    }).readTrainHealthState(healthRequest());

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'queue-unreadable' });
  });

  it('returns queue-unreadable when a record has a non-string repoDigest', async () => {
    const template = await queuedRecord();
    const result = await adapterFor({
      status: missingStatus(),
      queue: asQueue(async () => [withOwn(template, 'repoDigest', 12)]),
      forge: asForge(openForge()),
    }).readTrainHealthState(healthRequest());

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'queue-unreadable' });
  });

  it('returns all 501 live entries oldest first instead of refusing', async () => {
    const { records } = await seed([{ pullRequest: 1 }]);
    const template = records[0];
    if (template === undefined) {
      throw new Error('expected a real queue record');
    }
    const base = Date.parse('2026-11-01T00:00:00.000Z');
    const copies = Array.from({ length: 501 }, (_, index) => {
      const pullRequest = index === 0 ? 10 : index === 1 ? 3 : index + 1;
      const offset = index < 2 ? 0 : index * 1_000;
      return {
        ...template,
        pullRequest,
        enqueuedAtIso: new Date(base + offset).toISOString(),
      };
    });
    const readForgeMerge = openForge();
    const result = await adapterFor({
      status: missingStatus(),
      queue: asQueue(async () => [...copies].reverse()),
      forge: asForge(readForgeMerge),
    }).readTrainHealthState(healthRequest());

    assertOk(result);
    expect(result.snapshot.queue).toHaveLength(501);
    expect(result.snapshot.queue[0]).toMatchObject({
      pullRequest: 3,
      enqueuedAtIso: new Date(base).toISOString(),
      forgeState: 'open',
    });
    expect(result.snapshot.queue[1]).toMatchObject({
      pullRequest: 10,
      enqueuedAtIso: new Date(base).toISOString(),
    });
    expect(isOldestFirst(result.snapshot.queue)).toBe(true);
    expect(result.snapshot.queue[10]?.forgeState).toBe('unknown');
    expect(readForgeMerge).toHaveBeenCalledTimes(10);
    expect(readForgeMerge.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('caps forge reads at maxForgeReads and marks remaining entries unknown', async () => {
    const { queue, records } = await seed([
      { pullRequest: 7, enqueuedAtIso: '2026-11-01T11:00:00.000Z' },
      { pullRequest: 8, enqueuedAtIso: '2026-11-01T11:05:00.000Z' },
    ]);
    const readForgeMerge = openForge();
    const request = healthRequest();
    const result = await adapterFor({
      status: missingStatus(),
      queue,
      forge: asForge(readForgeMerge),
      maxForgeReads: 1,
    }).readTrainHealthState(request);

    assertOk(result);
    expect(result.snapshot.queue.map((entry) => entry.forgeState)).toEqual(['open', 'unknown']);
    expect(readForgeMerge).toHaveBeenCalledTimes(1);
    expect(readForgeMerge.mock.calls[0]?.[0]).toMatchObject({
      pullRequestNumber: 7,
      headSha: records[0]?.headOid,
      requiredContexts: [],
      deadlineIso: effectiveForgeDeadline(CLOCK, request.deadlineIso),
    });
  });

  it('falls back to 10 forge reads when maxForgeReads is outside 0..50', async () => {
    const specs = Array.from({ length: 11 }, (_, index) => ({
      pullRequest: index + 1,
      enqueuedAtIso: new Date(Date.parse(ENQUEUED) + index * 1_000).toISOString(),
    }));
    const { queue } = await seed(specs);
    const readForgeMerge = openForge();
    const result = await adapterFor({
      status: missingStatus(),
      queue,
      forge: asForge(readForgeMerge),
      maxForgeReads: 51,
    }).readTrainHealthState(healthRequest());

    assertOk(result);
    expect(result.snapshot.queue).toHaveLength(11);
    expect(readForgeMerge).toHaveBeenCalledTimes(10);
    expect(result.snapshot.queue[9]?.forgeState).toBe('open');
    expect(result.snapshot.queue[10]?.forgeState).toBe('unknown');
  });

  it('marks later entries unknown without calling forge when budget exhausts mid-loop', async () => {
    const deadlineMs = Date.now() + 60_000;
    const deadlineIso = new Date(deadlineMs).toISOString();
    const early = new Date(deadlineMs - 30_000).toISOString();
    const late = new Date(deadlineMs + 1_000).toISOString();
    // now() runs for the read start, the status read, the queue read, then before each forge read.
    let reads = 0;
    const now = () => {
      reads += 1;
      return reads < 5 ? early : late;
    };
    const { queue } = await seed([
      { pullRequest: 7, enqueuedAtIso: '2026-11-01T11:00:00.000Z' },
      { pullRequest: 8, enqueuedAtIso: '2026-11-01T11:05:00.000Z' },
    ]);
    const readForgeMerge = openForge();
    const result = await adapterFor({
      status: missingStatus(),
      queue,
      forge: asForge(readForgeMerge),
      now,
    }).readTrainHealthState(healthRequest({ deadlineIso }));

    assertOk(result);
    expect(result.snapshot.queue.map((entry) => entry.forgeState)).toEqual(['open', 'unknown']);
    expect(readForgeMerge).toHaveBeenCalledTimes(1);
    expect(readForgeMerge.mock.calls[0]?.[0]).toMatchObject({
      nowIso: early,
      deadlineIso: effectiveForgeDeadline(early, deadlineIso),
      pullRequestNumber: 7,
    });
  });

  it('yields unknown and an ok snapshot when a forge call does not answer within the effective window', async () => {
    const { queue } = await seed([{ pullRequest: 7 }]);
    const requestDeadline = new Date(Date.parse(CLOCK) + 60_000).toISOString();
    const windowDeadline = effectiveForgeDeadline(CLOCK, requestDeadline);
    const readForgeMerge = vi.fn((request: ReadForgeMergeRequest) => {
      const waitMs = Date.parse(request.deadlineIso) - Date.parse(CLOCK);
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({ outcome: 'unavailable', code: 'forge-error', reason: 'timed out' });
        }, waitMs);
      });
    });
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = adapterFor({
        status: missingStatus(),
        queue,
        forge: asForge(readForgeMerge),
      })
        .readTrainHealthState(healthRequest({ deadlineIso: requestDeadline }))
        .then((result) => {
          settled = true;
          return result;
        });
      for (let step = 0; step < 10; step += 1) {
        await Promise.resolve();
      }
      expect(readForgeMerge).toHaveBeenCalledTimes(1);
      expect(readForgeMerge.mock.calls[0]?.[0].deadlineIso).toBe(windowDeadline);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(FORGE_READ_WINDOW_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(settled).toBe(true);
      assertOk(result);
      expect(result.snapshot.queue).toEqual([
        {
          pullRequest: 7,
          state: 'queued',
          forgeState: 'unknown',
          enqueuedAtIso: ENQUEUED,
          attempt: 0,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps forge not-found, unavailable, null, and thrown errors to forgeState unknown', async () => {
    const { queue } = await seed([
      { pullRequest: 1, enqueuedAtIso: '2026-11-01T11:00:00.000Z' },
      { pullRequest: 2, enqueuedAtIso: '2026-11-01T11:01:00.000Z' },
      { pullRequest: 3, enqueuedAtIso: '2026-11-01T11:02:00.000Z' },
      { pullRequest: 4, enqueuedAtIso: '2026-11-01T11:03:00.000Z' },
    ]);
    const script: Array<() => unknown> = [
      () => ({ outcome: 'not-found' }),
      () => ({ outcome: 'unavailable', code: 'unreadable', reason: 'down' }),
      () => null,
      () => {
        throw new Error('forge down');
      },
    ];
    let index = 0;
    const readForgeMerge = vi.fn(async (_request: ReadForgeMergeRequest) => {
      const produce = script[index];
      index += 1;
      if (produce === undefined) {
        throw new Error('unexpected forge call');
      }
      return produce();
    });
    const result = await adapterFor({
      status: missingStatus(),
      queue,
      forge: asForge(readForgeMerge),
    }).readTrainHealthState(healthRequest());

    assertOk(result);
    expect(result.snapshot.queue.map((entry) => entry.forgeState)).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
    expect(readForgeMerge).toHaveBeenCalledTimes(4);
  });

  it('maps a forge ok answer with an unknown prState to forgeState unknown', async () => {
    const { queue } = await seed([{ pullRequest: 7 }]);
    const readForgeMerge = vi.fn(async () => ({ outcome: 'ok', prState: 'draft' }));
    const result = await adapterFor({
      status: missingStatus(),
      queue,
      forge: asForge(readForgeMerge),
    }).readTrainHealthState(healthRequest());

    assertOk(result);
    expect(result.snapshot.queue.map((entry) => entry.forgeState)).toEqual(['unknown']);
    expect(result.snapshot.queue.map((entry) => entry.state)).toEqual(['queued']);
    expect(readForgeMerge).toHaveBeenCalledTimes(1);
  });

  it('maps a forge answer whose property read throws to forgeState unknown', async () => {
    const { queue } = await seed([
      { pullRequest: 7, enqueuedAtIso: '2026-11-01T11:00:00.000Z' },
      { pullRequest: 8, enqueuedAtIso: '2026-11-01T11:05:00.000Z' },
    ]);
    const trap: unknown = new Proxy(
      {},
      {
        getOwnPropertyDescriptor(): PropertyDescriptor {
          throw new Error('forge descriptor');
        },
      },
    );
    const answers = [trap, { outcome: 'ok', prState: 'open' }];
    let index = 0;
    const readForgeMerge = vi.fn(async () => {
      const answer = answers[index];
      index += 1;
      return answer;
    });
    const result = await adapterFor({
      status: missingStatus(),
      queue,
      forge: asForge(readForgeMerge),
    }).readTrainHealthState(healthRequest());

    assertOk(result);
    expect(result.snapshot.queue.map((entry) => entry.forgeState)).toEqual(['unknown', 'open']);
    expect(readForgeMerge).toHaveBeenCalledTimes(2);
  });

  it('returns read-failed when an unexpected exception escapes the read', async () => {
    const trap = new Proxy(
      {},
      {
        getOwnPropertyDescriptor(): PropertyDescriptor {
          throw new Error('trap');
        },
      },
    );
    const result = await adapterFor({
      status: missingStatus(),
      queue: asQueue(async () => [trap]),
      forge: asForge(openForge()),
    }).readTrainHealthState(healthRequest());

    expect(result).toEqual({ outcome: 'unavailable', reasonCode: 'read-failed' });
  });
});
