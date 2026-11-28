import { types } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  buildParksSnapshotPush,
  buildRunningSnapshotPush,
  buildTrainSnapshotPush,
  PublishSnapshotSectionUseCase,
  type LaneRunRecord,
  type LaneRunRepositoryPort,
  type LaneServerSessionListResult,
  type LaneServerSessionReadPort,
  type MergeQueueEntryRecord,
  type MergeQueueListQuery,
  type MergeQueueRepositoryPort,
  type PublishSnapshotSectionRequest,
  type PublishSnapshotSectionResult,
  type SectionSnapshotPush,
  type SnapshotPushOutcome,
  type SnapshotPushPort,
} from '@fleet/work-execution';
import type { IsProxy } from '@fleet/shared';

const AT = '2026-11-27T12:00:00.000Z';
const LATER = '2026-11-27T12:05:00.000Z';
const isProxy: IsProxy = types.isProxy;
const SECRET = 'ghp_' + 'i'.repeat(30);
const REPO = { owner: 'acme', repo: 'fleet' };

interface Harness {
  readonly useCase: PublishSnapshotSectionUseCase;
  readonly calls: {
    sessions: number;
    laneRunsList: number;
    queueQueries: MergeQueueListQuery[];
    pushes: SectionSnapshotPush[];
    writes: string[];
  };
}

interface Sources {
  sessions?: () => Promise<unknown>;
  runs?: () => Promise<unknown>;
  entries?: () => Promise<unknown>;
  push?: (snapshot: SectionSnapshotPush) => Promise<unknown>;
  isProxy?: unknown;
}

function run(runId: string, parkedReason: string | null): LaneRunRecord {
  return { runId, parked: parkedReason === null ? null : { reason: parkedReason } } as unknown as LaneRunRecord;
}

function entry(pullRequest: number, state: string, reason: string | null = null): MergeQueueEntryRecord {
  return { repository: { ...REPO }, pullRequest, state, reason } as unknown as MergeQueueEntryRecord;
}

function harness(sources: Sources = {}): Harness {
  const calls: Harness['calls'] = { sessions: 0, laneRunsList: 0, queueQueries: [], pushes: [], writes: [] };
  const writeTrap = (name: string) => (): Promise<never> => {
    calls.writes.push(name);
    return Promise.reject(new Error(`${name} must never be called`));
  };
  const sessions = {
    listRunningSessions: async () => {
      calls.sessions += 1;
      return (sources.sessions ?? (async () => ({ outcome: 'ok', sessions: [] })))();
    },
  } as unknown as LaneServerSessionReadPort;
  const laneRuns = {
    list: async () => {
      calls.laneRunsList += 1;
      return (sources.runs ?? (async () => []))();
    },
    create: writeTrap('laneRuns.create'),
    save: writeTrap('laneRuns.save'),
    acquireLease: writeTrap('laneRuns.acquireLease'),
    renewLease: writeTrap('laneRuns.renewLease'),
    releaseLease: writeTrap('laneRuns.releaseLease'),
    get: writeTrap('laneRuns.get'),
  } as unknown as LaneRunRepositoryPort;
  const mergeQueue = {
    listMergeEntries: async (query: MergeQueueListQuery) => {
      calls.queueQueries.push(query);
      return (sources.entries ?? (async () => []))();
    },
    enqueueMergeEntry: writeTrap('mergeQueue.enqueueMergeEntry'),
    dropMergeEntry: writeTrap('mergeQueue.dropMergeEntry'),
    retryMergeEntry: writeTrap('mergeQueue.retryMergeEntry'),
    applyMergeTransition: writeTrap('mergeQueue.applyMergeTransition'),
  } as unknown as MergeQueueRepositoryPort;
  const snapshotPush = {
    push: async (snapshot: SectionSnapshotPush) => {
      calls.pushes.push(snapshot);
      return (sources.push ?? (async () => ({ outcome: 'pushed' })))(snapshot);
    },
  } as unknown as SnapshotPushPort;
  const useCase = new PublishSnapshotSectionUseCase({
    sessions,
    laneRuns,
    mergeQueue,
    snapshotPush,
    isProxy: ('isProxy' in sources ? sources.isProxy : isProxy) as IsProxy,
  });
  return { useCase, calls };
}

function request(overrides: Partial<PublishSnapshotSectionRequest> = {}): PublishSnapshotSectionRequest {
  return { section: 'running', revision: 4, pushedAtIso: AT, ...overrides };
}

const OK_SESSIONS = async (): Promise<LaneServerSessionListResult> => ({
  outcome: 'ok',
  sessions: [{ sessionId: 's1', projectId: 'p1', seatRole: 'worker', seatModel: 'm1' }],
});

describe('PublishSnapshotSectionUseCase success paths', () => {
  it('publishes running tokens from the session list only and never reads lane runs or the merge queue', async () => {
    const { useCase, calls } = harness({
      sessions: OK_SESSIONS,
      // A lane-run record claiming a park must never leak into the running section.
      runs: async () => [run('01HX0000000000000000000001', 'halted')],
      entries: async () => [entry(12, 'queued')],
    });
    const result = await useCase.publish(request());
    expect(result).toEqual({ outcome: 'published', section: 'running', revision: 4, tokenCount: 3 });
    expect(calls.sessions).toBe(1);
    expect(calls.laneRunsList).toBe(0);
    expect(calls.queueQueries).toEqual([]);
    expect(calls.pushes).toEqual([
      {
        section: 'running',
        revision: 4,
        tokens: ['session:s1', 'project:p1', 'seat:worker:m1'],
        pushedAtIso: AT,
      },
    ]);
    expect(calls.pushes[0]).toEqual(
      (() => {
        const built = buildRunningSnapshotPush(
          {
            revision: 4,
            pushedAtIso: AT,
            sessions: [{ sessionId: 's1', projectId: 'p1', seatRole: 'worker', seatModel: 'm1' }],
          },
          isProxy,
        );
        return built.ok ? built.push : null;
      })(),
    );
    expect(calls.writes).toEqual([]);
  });

  it('publishes train tokens for live merge-queue entries with the deadline defaulting to pushedAtIso', async () => {
    const { useCase, calls } = harness({
      entries: async () => [entry(12, 'queued'), entry(13, 'merged'), entry(14, 'awaiting-checks'), entry(15, 'dropped')],
      runs: async () => [run('01HX0000000000000000000001', 'halted')],
    });
    const result = await useCase.publish(request({ section: 'train', revision: 9 }));
    expect(result).toEqual({ outcome: 'published', section: 'train', revision: 9, tokenCount: 2 });
    expect(calls.pushes).toEqual([
      {
        section: 'train',
        revision: 9,
        tokens: ['queue:acme.fleet:12:queued', 'queue:acme.fleet:14:awaiting-checks'],
        pushedAtIso: AT,
      },
    ]);
    expect(calls.queueQueries).toEqual([{ deadlineIso: AT }]);
    expect(calls.sessions).toBe(0);
    expect(calls.laneRunsList).toBe(0);
    expect(calls.writes).toEqual([]);
    const built = buildTrainSnapshotPush(
      {
        revision: 9,
        pushedAtIso: AT,
        entries: [
          { repository: { ...REPO }, pullRequest: 12, state: 'queued' },
          { repository: { ...REPO }, pullRequest: 14, state: 'awaiting-checks' },
        ],
      },
      isProxy,
    );
    expect(built.ok && built.push).toEqual(calls.pushes[0]);

    const explicit = harness({ entries: async () => [] });
    await explicit.useCase.publish(request({ section: 'train', deadlineIso: LATER }));
    expect(explicit.calls.queueQueries).toEqual([{ deadlineIso: LATER }]);
  });

  it('publishes parks tokens for parked lane runs and parked merge entries only', async () => {
    const { useCase, calls } = harness({
      runs: async () => [run('01HX0000000000000000000001', 'halted'), run('01HX0000000000000000000002', null)],
      entries: async () => [entry(13, 'parked', 'conflict'), entry(14, 'queued')],
      sessions: OK_SESSIONS,
    });
    const result = await useCase.publish(request({ section: 'parks', revision: 2, deadlineIso: LATER }));
    expect(result).toEqual({ outcome: 'published', section: 'parks', revision: 2, tokenCount: 2 });
    expect(calls.pushes).toEqual([
      {
        section: 'parks',
        revision: 2,
        tokens: ['park-run:01HX0000000000000000000001:halted', 'park-pr:acme.fleet:13:conflict'],
        pushedAtIso: AT,
      },
    ]);
    expect(calls.laneRunsList).toBe(1);
    expect(calls.queueQueries).toEqual([{ deadlineIso: LATER }]);
    expect(calls.sessions).toBe(0);
    expect(calls.writes).toEqual([]);
    const built = buildParksSnapshotPush(
      {
        revision: 2,
        pushedAtIso: AT,
        parkedRuns: [{ runId: '01HX0000000000000000000001', reason: 'halted' }],
        parkedEntries: [{ repository: { ...REPO }, pullRequest: 13, reason: 'conflict' }],
      },
      isProxy,
    );
    expect(built.ok && built.push).toEqual(calls.pushes[0]);
  });
});

describe('PublishSnapshotSectionUseCase refusal and unavailable paths', () => {
  it('returns unavailable when session-list port or repository is unavailable or throws', async () => {
    for (const reason of ['transport-error', 'timeout', 'not-configured', 'unreadable'] as const) {
      const { useCase, calls } = harness({ sessions: async () => ({ outcome: 'unavailable', reason }) });
      expect(await useCase.publish(request())).toEqual({ outcome: 'unavailable', reason });
      expect(calls.pushes).toEqual([]);
    }

    const throwing = harness({ sessions: () => Promise.reject(new Error('boom')) });
    expect(await throwing.useCase.publish(request())).toEqual({ outcome: 'unavailable', reason: 'source-unreadable' });
    expect(throwing.calls.pushes).toEqual([]);

    const getterResponse = Object.defineProperty({ outcome: 'ok' }, 'sessions', {
      enumerable: true,
      get() {
        throw new Error('getter ran');
      },
    });
    const malformedSessionAnswers: unknown[] = [
      null,
      undefined,
      'text',
      {},
      { outcome: 'ok' },
      { outcome: 'ok', sessions: 'text' },
      { outcome: 'ok', sessions: [{ sessionId: 's1' }] },
      { outcome: 'weird', sessions: [] },
      { outcome: 'unavailable', reason: 'bogus' },
      getterResponse,
      new Proxy({ outcome: 'ok', sessions: [] }, {}),
    ];
    for (const answer of malformedSessionAnswers) {
      const { useCase, calls } = harness({ sessions: async () => answer });
      expect(await useCase.publish(request())).toEqual({ outcome: 'unavailable', reason: 'unreadable' });
      expect(calls.pushes).toEqual([]);
    }

    const badSources: Array<() => Promise<unknown>> = [
      () => Promise.reject(new Error('boom')),
      async () => null,
      async () => 'text',
      async () => ({ length: 0 }),
      async () => new Array<unknown>(2 ** 32 - 1),
      async () => new Proxy([], {}),
    ];
    for (const source of badSources) {
      const train = harness({ entries: source });
      expect(await train.useCase.publish(request({ section: 'train' }))).toEqual({
        outcome: 'unavailable',
        reason: 'source-unreadable',
      });
      const parksRuns = harness({ runs: source });
      expect(await parksRuns.useCase.publish(request({ section: 'parks' }))).toEqual({
        outcome: 'unavailable',
        reason: 'source-unreadable',
      });
      const parksEntries = harness({ entries: source });
      expect(await parksEntries.useCase.publish(request({ section: 'parks' }))).toEqual({
        outcome: 'unavailable',
        reason: 'source-unreadable',
      });
      for (const h of [train, parksRuns, parksEntries]) {
        expect(h.calls.pushes).toEqual([]);
        expect(h.calls.writes).toEqual([]);
      }
    }

    const malformedRecords: Array<[string, Sources]> = [
      ['train', { entries: async () => [{}] }],
      ['train', { entries: async () => [{ repository: { ...REPO }, pullRequest: 12, state: 'bogus' }] }],
      ['parks', { runs: async () => [{ runId: '01HX0000000000000000000001' }] }],
      ['parks', { runs: async () => [run('01HX0000000000000000000001', 'bogus')] }],
      ['parks', { entries: async () => [entry(13, 'parked', null)] }],
      ['parks', { entries: async () => [{ repository: { ...REPO }, pullRequest: 13, reason: null }] }],
      ['parks', { entries: async () => [entry(13, 'not-a-state')] }],
      ['parks', { entries: async () => [entry(14, 'queued'), { ...entry(15, 'x'), state: 7 }] }],
    ];
    for (const [section, sources] of malformedRecords) {
      const { useCase, calls } = harness(sources);
      const result = await useCase.publish(request({ section: section as 'train' | 'parks' }));
      expect(result).toEqual({ outcome: 'unavailable', reason: 'source-unreadable' });
      expect(calls.pushes).toEqual([]);
    }
  });

  it('refuses bad requests and builder refusals without pushing or echoing a secret', async () => {
    const badRequests: unknown[] = [
      null,
      undefined,
      'running',
      { section: 'halt', revision: 1, pushedAtIso: AT },
      { section: 'bogus', revision: 1, pushedAtIso: AT },
      { section: 'running', revision: '1', pushedAtIso: AT },
      { section: 'running', revision: 1, pushedAtIso: 7 },
      { section: 'running', revision: 1, pushedAtIso: AT, deadlineIso: 7 },
    ];
    for (const bad of badRequests) {
      const { useCase, calls } = harness({ sessions: OK_SESSIONS });
      expect(await useCase.publish(bad as PublishSnapshotSectionRequest)).toEqual({
        outcome: 'refused',
        reason: 'invalid-input',
      });
      expect(calls.sessions).toBe(0);
      expect(calls.pushes).toEqual([]);
    }

    const noDetector = harness({ sessions: OK_SESSIONS, isProxy: undefined });
    expect(await noDetector.useCase.publish(request())).toEqual({ outcome: 'refused', reason: 'invalid-input' });
    expect(noDetector.calls.sessions).toBe(0);

    const { useCase, calls } = harness({ sessions: OK_SESSIONS });
    expect(await useCase.publish(request({ revision: 0 }))).toEqual({ outcome: 'refused', reason: 'invalid-revision' });
    expect(await useCase.publish(request({ pushedAtIso: 'not-a-date' }))).toEqual({
      outcome: 'refused',
      reason: 'invalid-pushed-at',
    });
    expect(calls.pushes).toEqual([]);

    const secret = harness({
      sessions: async () => ({ outcome: 'ok', sessions: [{ sessionId: SECRET, projectId: 'p1' }] }),
    });
    const secretResult = await secret.useCase.publish(request());
    expect(secretResult).toEqual({ outcome: 'refused', reason: 'secret-shaped' });
    expect(JSON.stringify(secretResult)).not.toContain(SECRET);
    expect(secret.calls.pushes).toEqual([]);

    const badToken = harness({
      sessions: async () => ({ outcome: 'ok', sessions: [{ sessionId: 'a/b', projectId: 'p1' }] }),
    });
    expect(await badToken.useCase.publish(request())).toEqual({ outcome: 'refused', reason: 'tokens-not-tokens' });

    const tooMany = harness({
      sessions: async () => ({
        outcome: 'ok',
        sessions: Array.from({ length: 501 }, (_, index) => ({ sessionId: `s${index}`, projectId: 'p1' })),
      }),
    });
    expect(await tooMany.useCase.publish(request())).toEqual({ outcome: 'refused', reason: 'budget-exhausted' });
    expect(tooMany.calls.pushes).toEqual([]);
  });

  it('refuses a pushed answer that carries a contradictory reason or an extra key, and publishes a bare pushed', async () => {
    for (const answer of [
      { outcome: 'pushed', reason: 'timeout' },
      { outcome: 'pushed', extra: 1 },
    ]) {
      const { useCase, calls } = harness({ sessions: OK_SESSIONS, push: async () => answer });
      expect(await useCase.publish(request())).toEqual({ outcome: 'refused', reason: 'invalid' });
      expect(calls.pushes).toHaveLength(1);
    }
    const bare = harness({ sessions: OK_SESSIONS, push: async () => ({ outcome: 'pushed' }) });
    expect(await bare.useCase.publish(request())).toMatchObject({ outcome: 'published' });
  });

  it('refuses a request with an own constructor, prototype or __proto__ key without pushing', async () => {
    const hostile: unknown[] = [
      { ...request(), constructor: 'x' },
      { ...request(), prototype: 'x' },
      JSON.parse(`{"section":"running","revision":1,"pushedAtIso":"${AT}","__proto__":{}}`),
    ];
    for (const bad of hostile) {
      const { useCase, calls } = harness({ sessions: OK_SESSIONS });
      expect(await useCase.publish(bad as PublishSnapshotSectionRequest)).toEqual({
        outcome: 'refused',
        reason: 'invalid-input',
      });
      expect(calls.sessions).toBe(0);
      expect(calls.pushes).toEqual([]);
    }
  });

  it('propagates push transport timeout and unavailable outcomes', async () => {
    for (const reason of ['timeout', 'transport-error', 'not-configured'] as const) {
      const { useCase, calls } = harness({
        sessions: OK_SESSIONS,
        push: async (): Promise<SnapshotPushOutcome> => ({ outcome: 'unavailable', reason }),
      });
      expect(await useCase.publish(request())).toEqual({ outcome: 'unavailable', reason });
      expect(calls.pushes).toHaveLength(1);
    }
    const throwing = harness({ sessions: OK_SESSIONS, push: () => Promise.reject(new Error('boom')) });
    expect(await throwing.useCase.publish(request())).toEqual({ outcome: 'unavailable', reason: 'transport-error' });
  });

  it('returns refused on non-increasing-revision or malformed push response', async () => {
    for (const reason of ['non-increasing-revision', 'unauthorized', 'invalid'] as const) {
      const { useCase } = harness({
        sessions: OK_SESSIONS,
        push: async (): Promise<SnapshotPushOutcome> => ({ outcome: 'refused', reason }),
      });
      expect(await useCase.publish(request())).toEqual({ outcome: 'refused', reason });
    }
    const getterAnswer = Object.defineProperty({}, 'outcome', {
      enumerable: true,
      get() {
        throw new Error('getter ran');
      },
    });
    const malformedAnswers: unknown[] = [
      undefined,
      null,
      'pushed',
      7,
      {},
      [],
      { outcome: 'ok' },
      { outcome: 'pushed-ish' },
      { outcome: 'refused' },
      { outcome: 'refused', reason: 'bogus' },
      { outcome: 'unavailable' },
      { outcome: 'unavailable', reason: 'bogus' },
      { outcome: 'unavailable', reason: 'non-increasing-revision' },
      { outcome: 'refused', reason: 'timeout' },
      getterAnswer,
      new Proxy({ outcome: 'pushed' }, {}),
    ];
    for (const answer of malformedAnswers) {
      const { useCase } = harness({ sessions: OK_SESSIONS, push: async () => answer });
      const result: PublishSnapshotSectionResult = await useCase.publish(request());
      expect(result).toEqual({ outcome: 'refused', reason: 'invalid' });
    }
    const pushed = harness({ sessions: OK_SESSIONS, push: async () => ({ outcome: 'pushed' }) });
    expect(await pushed.useCase.publish(request())).toEqual({
      outcome: 'published',
      section: 'running',
      revision: 4,
      tokenCount: 3,
    });
  });
});
