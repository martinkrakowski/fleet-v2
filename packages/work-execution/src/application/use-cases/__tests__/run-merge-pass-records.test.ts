// DT9c: entry records, successors, audit fields and keyed notifications of the shadow merge pass.
import { describe, expect, it } from 'vitest';

import { RunMergePassUseCase } from '../RunMergePassUseCase.use-case.js';
import type { RunMergePassRequest } from '../../ports/in/RunMergePassPort.in-port.js';
import type { ForgeMergeReadPort, ReadForgeMergeResult } from '../../ports/out/ForgeMergeReadPort.out-port.js';
import type { MergeVerificationPort } from '../../ports/out/MergeVerificationPort.out-port.js';
import type {
  MergeNotificationOutcome,
  MergeNotificationPort,
  MergeNotificationRequest,
} from '../../ports/out/MergeNotificationPort.out-port.js';
import type {
  MergeQueueRepositoryPort,
  MergeQueueTransitionCommand,
} from '../../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import type { ConductorHaltPort } from '../../ports/out/ConductorHaltPort.out-port.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { MergeQueueRepositoryAdapter } from '../../../infrastructure/adapters/MergeQueueRepositoryAdapter.adapter.js';
import { sha256HexDigest } from '../../../infrastructure/adapters/AttemptArtifactAdapter.adapter.js';
import type { MergeRepoPolicy } from '../../../domain/merge-queue-decider.js';
import type { MergeTransitionDecision } from '../../../domain/merge-pass-transitions.js';

const OWNER = 'fleet';
const REPO = 'v2';
const DIGEST = sha256HexDigest(`${OWNER}/${REPO}`).slice(0, 12);
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const HEAD_MOVED = '0123456789abcdef0123456789abcdef01234599';
const POSTER = 'premerge-bot';
const START = Date.now();

function ulid(n: number): string {
  return '01JC' + String(n).padStart(22, '0');
}

function greenContexts() {
  return [
    { name: 'gate', state: 'SUCCESS', isGreen: true, creatorLogin: null },
    { name: 'premerge', state: 'SUCCESS', isGreen: true, creatorLogin: POSTER },
  ];
}

const greenForge: ReadForgeMergeResult = {
  outcome: 'ok', prState: 'open', liveHeadSha: HEAD, mergeState: 'clean',
  contexts: greenContexts(), unresolvedThreads: 0,
};
const failedGate: ReadForgeMergeResult = {
  ...greenForge,
  contexts: [{ name: 'gate', state: 'FAILURE', isGreen: false, creatorLogin: null }, greenContexts()[1]],
} as ReadForgeMergeResult;
const closedForge = { ...greenForge, prState: 'closed' } as ReadForgeMergeResult;

class FakeNotifier implements MergeNotificationPort {
  readonly requests: MergeNotificationRequest[] = [];
  readonly delivered = new Set<string>();
  mode: 'ok' | 'refuse' | 'unavailable' | 'suppress' | 'throw' | 'garbage' = 'ok';
  async notifyMergeEvent(request: MergeNotificationRequest): Promise<MergeNotificationOutcome> {
    this.requests.push(request);
    if (this.mode === 'throw') throw new Error('sk-live-0123456789abcdef0123456789 /etc/passwd');
    if (this.mode === 'refuse') return { outcome: 'refused', reason: 'sk-live-0123456789abcdef0123456789' };
    if (this.mode === 'unavailable') return { outcome: 'unavailable', reason: 'sk-live-0123456789abcdef0123456789' };
    if (this.mode === 'suppress') return { outcome: 'suppressed', reason: 'notifications-disabled' };
    if (this.mode === 'garbage') return undefined as unknown as MergeNotificationOutcome;
    if (this.delivered.has(request.key)) return { outcome: 'duplicate' };
    this.delivered.add(request.key);
    return { outcome: 'notified' };
  }
}

interface Harness {
  readonly useCase: RunMergePassUseCase;
  readonly queue: MergeQueueRepositoryAdapter;
  readonly notifier: FakeNotifier;
  readonly journal: LaneRunJournalAdapter;
  readonly clock: { now: number };
  readonly verificationCalls: { count: number };
  readonly forge: { result: ReadForgeMergeResult };
  request(overrides?: Record<string, unknown>): RunMergePassRequest;
  list(): Promise<readonly import('../../../domain/merge-queue-records.js').MergeQueueEntryRecord[]>;
}

async function harness(options: {
  forge: ReadForgeMergeResult;
  policy?: Record<string, unknown>;
  writer?: Pick<MergeQueueRepositoryPort, 'applyMergeTransition'> | 'none';
  notifier?: FakeNotifier | 'none';
  journalHook?: (clock: { now: number }) => void;
  seed?: number;
}): Promise<Harness> {
  const queue = new MergeQueueRepositoryAdapter();
  const clock = { now: START };
  const iso = () => new Date(clock.now).toISOString();
  const seed = options.seed ?? 1;
  for (let index = 0; index < seed; index += 1) {
    await queue.enqueueMergeEntry({
      repository: { owner: OWNER, repo: REPO }, pullRequest: index + 1, headOid: HEAD, tier: 2,
      enqueuedBy: 'cli', runId: null, entryId: ulid(index * 2 + 1), successorEntryId: ulid(index * 2 + 2),
      enqueuedAtIso: new Date(START - 3_600_000 + index).toISOString(),
      deadlineIso: new Date(START + 3_600_000).toISOString(),
    });
  }
  const forge = { result: options.forge };
  const forgeRead: ForgeMergeReadPort = {
    async readForgeMerge() { return forge.result; },
    isConfigured() { return true; },
  };
  const verificationCalls = { count: 0 };
  const verification: MergeVerificationPort = {
    async readVerification() { verificationCalls.count += 1; return { outcome: 'unknown', reasonCode: 'no-receipt' }; },
    async runVerification() { throw new Error('never'); },
  } as unknown as MergeVerificationPort;
  const journal = new LaneRunJournalAdapter();
  const hooked: Pick<LaneRunJournalPort, 'append' | 'listForKey'> = {
    append: (entry) => journal.append(entry),
    async listForKey(key) {
      options.journalHook?.(clock);
      return journal.listForKey(key);
    },
  };
  const halt: ConductorHaltPort = {
    async read() { return { state: 'clear', record: null }; },
    async set(): Promise<never> { throw new Error('not used'); },
  } as ConductorHaltPort;
  const notifier = options.notifier === 'none' ? undefined : (options.notifier ?? new FakeNotifier());
  let counter = 1000;
  const useCase = new RunMergePassUseCase({
    queue,
    queueWriter: options.writer === 'none' ? undefined : (options.writer ?? queue),
    notifier,
    forgeRead,
    verification,
    journal: hooked,
    halt,
    newUlid: () => ulid(++counter),
    nowIso: iso,
  });
  return {
    useCase, queue, notifier: notifier ?? new FakeNotifier(), journal, clock, verificationCalls, forge,
    request: (overrides = {}) => ({
      repository: { owner: OWNER, repo: REPO }, repoDigest: DIGEST, projectId: 'proj-1',
      policy: {
        policyRevision: 'rev-1', shadow: true, unattended: true, updateBranch: false,
        premergePosterLogin: POSTER, macosProcedure: null, veto: { mode: 'off' },
        ...(options.policy ?? {}),
      } as MergeRepoPolicy,
      deadlineIso: new Date(clock.now + 600_000).toISOString(),
      ...overrides,
    }),
    list: () => queue.listMergeEntries({ deadlineIso: new Date(START + 3_600_000).toISOString() }),
  };
}

describe('RunMergePassUseCase (DT9c): audit fields', () => {
  it('records the verification audit on the entry, still journals only a dry-run, and writes once', async () => {
    const h = await harness({ forge: greenForge });

    const first = await h.useCase.runMergePass(h.request());

    expect(first.outcome).toBe('completed');
    expect(first.entries[0].decision).toBe('journalled');
    expect(first.entries[0].reasonCode).toBe('would-merge');
    const [entry] = await h.list();
    expect(entry).toMatchObject({
      state: 'ready', policyRevision: 'rev-1', verifiedHeadOid: HEAD, verifiedBy: 'contexts',
      premergeReceiptHeadOid: HEAD, veto: null, mergeCommitOid: null, mergedAtIso: null, revision: 2,
    });

    await h.useCase.runMergePass(h.request());
    expect((await h.list())[0].revision).toBe(2); // nothing rewritten
    expect(h.notifier.requests).toHaveLength(0);
    expect(h.verificationCalls.count).toBe(0);
  });

  it('keeps the premerge receipt head unknown when the policy does not require premerge', async () => {
    const h = await harness({ forge: greenForge, policy: { requiredContexts: ['gate'] } });
    await h.useCase.runMergePass(h.request());
    expect((await h.list())[0].premergeReceiptHeadOid).toBeNull();
  });

  it('records nothing on the queue when no writer is wired (the DT9a observer)', async () => {
    const h = await harness({ forge: greenForge, writer: 'none' });
    const result = await h.useCase.runMergePass(h.request());
    expect(result.entries[0].decision).toBe('journalled');
    expect((await h.list())[0]).toMatchObject({ state: 'queued', policyRevision: null, revision: 1 });
  });
});

describe('RunMergePassUseCase (DT9c): successor entries', () => {
  it('a moved head supersedes the entry and writes the successor in one step', async () => {
    const h = await harness({ forge: { ...greenForge, liveHeadSha: HEAD_MOVED } as ReadForgeMergeResult });

    const result = await h.useCase.runMergePass(h.request());

    expect(result.entries[0]).toMatchObject({ decision: 'recorded', reasonCode: 'superseded' });
    const all = await h.list();
    expect(all).toHaveLength(2);
    const predecessor = all.find((e) => e.entryId === ulid(1))!;
    const successor = all.find((e) => e.entryId !== ulid(1))!;
    expect(predecessor.state).toBe('superseded');
    expect(successor).toMatchObject({
      supersedes: ulid(1), headOid: HEAD_MOVED, enqueuedBy: 'update', enqueuedAtIso: predecessor.enqueuedAtIso,
    });

    // The next pass works on the successor and never writes a second one.
    await h.useCase.runMergePass(h.request());
    expect((await h.list()).filter((e) => e.supersedes === ulid(1))).toHaveLength(1);
    expect(h.notifier.requests).toHaveLength(0);
  });

  it('a write that fails leaves the queue untouched and the next pass recovers it', async () => {
    const delegate: { target?: MergeQueueRepositoryAdapter } = {};
    let failNext = true;
    const flaky: Pick<MergeQueueRepositoryPort, 'applyMergeTransition'> = {
      async applyMergeTransition(command: MergeQueueTransitionCommand): Promise<MergeTransitionDecision> {
        if (failNext) {
          failNext = false;
          throw new Error('disk full /var/secret');
        }
        return delegate.target!.applyMergeTransition(command);
      },
    };
    const h = await harness({ forge: { ...greenForge, liveHeadSha: HEAD_MOVED } as ReadForgeMergeResult, writer: flaky });
    delegate.target = h.queue;

    const first = await h.useCase.runMergePass(h.request());
    expect(first.entries[0]).toMatchObject({ decision: 'no-action', reasonCode: 'persist-failed' });
    expect(JSON.stringify(first)).not.toContain('secret');
    expect(await h.list()).toHaveLength(1);

    const second = await h.useCase.runMergePass(h.request());
    expect(second.entries[0].decision).toBe('recorded');
    expect(await h.list()).toHaveLength(2);
  });

  it('a revision conflict is reported, not retried inside the pass', async () => {
    const writer = { async applyMergeTransition(): Promise<MergeTransitionDecision> { return { outcome: 'refused', reason: 'revision-conflict' }; } };
    const h = await harness({ forge: greenForge, writer });
    const result = await h.useCase.runMergePass(h.request());
    expect(result.entries[0]).toMatchObject({ decision: 'no-action', reasonCode: 'persist-conflict' });
  });
});

describe('RunMergePassUseCase (DT9c): park, drop and notifications', () => {
  it('stores a park and notifies once; a later park of the same entry does not notify again', async () => {
    const h = await harness({ forge: failedGate });

    const first = await h.useCase.runMergePass(h.request());
    expect(first.entries[0]).toMatchObject({ decision: 'recorded', reasonCode: 'checks' });
    const [parked] = await h.list();
    expect(parked).toMatchObject({ state: 'parked', reason: 'checks', attempt: 1 });
    expect(parked.notBeforeIso).not.toBeNull();
    expect(h.notifier.requests).toHaveLength(1);
    expect(h.notifier.requests[0]).toEqual({
      event: 'parked', id: ulid(1), key: `parked:${ulid(1)}`, deadlineIso: expect.any(String),
    });

    // Inside the backoff the entry waits.
    const waiting = await h.useCase.runMergePass(h.request());
    expect(waiting.entries[0].reasonCode).toBe('backoff');

    // Past the backoff it parks again with the next attempt, silently.
    h.clock.now += 3_600_000;
    const again = await h.useCase.runMergePass(h.request());
    expect(again.entries[0].decision).toBe('recorded');
    expect((await h.list())[0].attempt).toBe(2);
    expect(h.notifier.requests).toHaveLength(1);
  });

  it('a drop notifies before it writes, once, and the dropped entry leaves the live queue', async () => {
    const h = await harness({ forge: closedForge });

    const first = await h.useCase.runMergePass(h.request());

    expect(first.entries[0]).toMatchObject({ decision: 'recorded', reasonCode: 'closed' });
    expect((await h.list())[0]).toMatchObject({ state: 'dropped', reason: 'closed' });
    expect(h.notifier.requests.map((r) => r.event)).toEqual(['dropped']);
    const second = await h.useCase.runMergePass(h.request());
    expect(second.entries).toHaveLength(0);
    expect(h.notifier.requests).toHaveLength(1);
  });

  it('a notification carries an event, an id and a key only: no path, no title', async () => {
    const h = await harness({ forge: closedForge });
    await h.useCase.runMergePass(h.request());
    const request = h.notifier.requests[0];
    expect(Object.keys(request).sort()).toEqual(['deadlineIso', 'event', 'id', 'key']);
    expect(`${request.event}${request.id}${request.key}`).not.toMatch(/[\\/\s]/);
  });

  it('a notification that fails leaves the entry untouched; the retry delivers it exactly once', async () => {
    for (const mode of ['refuse', 'unavailable', 'throw', 'garbage'] as const) {
      const notifier = new FakeNotifier();
      notifier.mode = mode;
      const h = await harness({ forge: closedForge, notifier });

      const failed = await h.useCase.runMergePass(h.request());
      expect(failed.entries[0]).toMatchObject({ decision: 'no-action', reasonCode: 'notify-failed' });
      expect(JSON.stringify(failed)).not.toMatch(/sk-live|passwd/);
      expect((await h.list())[0].state).toBe('queued');

      notifier.mode = 'ok';
      const retried = await h.useCase.runMergePass(h.request());
      expect(retried.entries[0].decision).toBe('recorded');
      expect(notifier.delivered.size).toBe(1);
    }
  });

  it('a deliberate suppression (notifications switched off) lets the transition through', async () => {
    const notifier = new FakeNotifier();
    notifier.mode = 'suppress';
    const h = await harness({ forge: closedForge, notifier });
    const result = await h.useCase.runMergePass(h.request());
    expect(result.entries[0].decision).toBe('recorded');
    expect((await h.list())[0].state).toBe('dropped');
  });

  it('a crash between the notification and the write replays under the same key', async () => {
    const notifier = new FakeNotifier();
    const failingWriter = { async applyMergeTransition(): Promise<MergeTransitionDecision> { throw new Error('crash'); } };
    const h = await harness({ forge: closedForge, notifier, writer: failingWriter });
    await h.useCase.runMergePass(h.request());
    expect(notifier.delivered.size).toBe(1);
    expect((await h.list())[0].state).toBe('queued');

    const healed = new RunMergePassUseCase({
      queue: h.queue, queueWriter: h.queue, notifier,
      forgeRead: { async readForgeMerge() { return closedForge; }, isConfigured: () => true },
      verification: { async readVerification() { return { outcome: 'unknown', reasonCode: 'x' }; }, async runVerification() { throw new Error('never'); } } as unknown as MergeVerificationPort,
      journal: h.journal,
      halt: { async read() { return { state: 'clear', record: null }; }, async set(): Promise<never> { throw new Error('x'); } } as ConductorHaltPort,
      newUlid: () => ulid(2000), nowIso: () => new Date(h.clock.now).toISOString(),
    });
    await healed.runMergePass(h.request());
    expect(notifier.requests).toHaveLength(2);
    expect(notifier.requests[0].key).toBe(notifier.requests[1].key);
    expect(notifier.delivered.size).toBe(1);
    expect((await h.list())[0].state).toBe('dropped');
  });

  it('without a notifier a transition that needs one is not written', async () => {
    const h = await harness({ forge: closedForge, notifier: 'none' });
    const result = await h.useCase.runMergePass(h.request());
    expect(result.entries[0]).toMatchObject({ decision: 'no-action', reasonCode: 'notifier-unavailable' });
    expect((await h.list())[0].state).toBe('queued');
  });

  it('a notification is not started once the budget is spent (D-DT9)', async () => {
    const h = await harness({
      forge: closedForge,
      journalHook: (clock) => { clock.now += 700_000; }, // past the 600 s deadline after the first journal read
    });
    const result = await h.useCase.runMergePass(h.request());
    expect(result.outcome).toBe('budget-exhausted');
    expect(h.notifier.requests).toHaveLength(0);
    h.clock.now = START;
    expect((await h.list())[0].state).toBe('queued');
  });
});

describe('RunMergePassUseCase (DT9c): hostile input and bounds', () => {
  it('never throws: a throwing getter or a wrong-typed request is a typed refusal', async () => {
    const h = await harness({ forge: greenForge });
    const base = h.request();
    const hostile = [
      Object.defineProperty({ ...base }, 'policy', { get() { throw new Error('boom'); }, enumerable: true }),
      { ...base, policy: null },
      { ...base, projectId: 7 },
      { ...base, projectId: 'p'.repeat(1000) },
      { ...base, repository: [] },
      undefined,
    ];
    for (const request of hostile) {
      const result = await h.useCase.runMergePass(request as unknown as RunMergePassRequest);
      expect(result.outcome).toBe('refused');
      expect(result.entries).toEqual([]);
    }
  });

  it('a queue that answers a non-list, a huge list or a sparse list is handled', async () => {
    const h = await harness({ forge: greenForge });
    const usecase = (answer: unknown) =>
      new RunMergePassUseCase({
        queue: { async listMergeEntries() { return answer as never; } },
        forgeRead: { async readForgeMerge() { return greenForge; }, isConfigured: () => true },
        verification: { async readVerification() { return { outcome: 'unknown', reasonCode: 'x' }; }, async runVerification() { throw new Error('never'); } } as unknown as MergeVerificationPort,
        journal: h.journal,
        halt: { async read() { return { state: 'clear', record: null }; }, async set(): Promise<never> { throw new Error('x'); } } as ConductorHaltPort,
        newUlid: () => ulid(3000), nowIso: () => new Date(START).toISOString(),
      });
    expect((await usecase({ not: 'a list' }).runMergePass(h.request())).reasonCode).toBe('queue-unreadable');
    expect((await usecase(new Array(6000).fill(null)).runMergePass(h.request())).reasonCode).toBe('queue-unreadable');
    // eslint-disable-next-line no-sparse-arrays
    const sparse = await usecase([, null, undefined] as unknown).runMergePass(h.request());
    expect(sparse).toEqual({ outcome: 'completed', reasonCode: null, entries: [] });
  });

  it('one pass looks at no more than 100 live entries', async () => {
    const pending: ReadForgeMergeResult = {
      ...greenForge,
      contexts: [{ name: 'gate', state: 'PENDING', isGreen: false, creatorLogin: null }, greenContexts()[1]],
    } as ReadForgeMergeResult;
    const h = await harness({ forge: pending, seed: 120 });
    const result = await h.useCase.runMergePass(h.request());
    expect(result.entries).toHaveLength(100);
  });

  it('reports only fixed lowercase reason tokens', async () => {
    const writer = { async applyMergeTransition(): Promise<MergeTransitionDecision> { return { outcome: 'refused', reason: 'sk-live-0123456789abcdef0123456789' as never }; } };
    const h = await harness({ forge: closedForge, writer });
    const result = await h.useCase.runMergePass(h.request());
    expect(result.entries[0].reasonCode).toBe('persist-refused');
    expect(JSON.stringify(result)).not.toContain('sk-live');
  });
});
