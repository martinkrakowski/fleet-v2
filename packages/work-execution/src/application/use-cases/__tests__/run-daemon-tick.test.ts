// DT10a: the daemon tick — the registry, the merge-pass job adapter and the tick itself.
import { describe, expect, it } from 'vitest';

import { DaemonJobRegistry, RunDaemonTickUseCase } from '../RunDaemonTickUseCase.use-case.js';
import type { RunDaemonTickDependencies } from '../RunDaemonTickUseCase.use-case.js';
import type { DaemonRepositoryRef, RunDaemonTickRequest, RunDaemonTickResult } from '../../ports/in/RunDaemonTickPort.in-port.js';
import type { RunMergePassPort, RunMergePassRequest, RunMergePassResult } from '../../ports/in/RunMergePassPort.in-port.js';
import type { DaemonLeasePort, DaemonLeaseResult } from '../../ports/out/DaemonLeasePort.out-port.js';
import type { DaemonStatusPort, DaemonStatusFileRead } from '../../ports/out/DaemonStatusPort.out-port.js';
import type { DaemonPausePort } from '../../ports/out/DaemonPausePort.out-port.js';
import type { DaemonEventProjectionPort } from '../../ports/out/DaemonEventProjectionPort.out-port.js';
import type { ConductorHaltPort } from '../../ports/out/ConductorHaltPort.out-port.js';
import type { MergeQueueRepositoryPort } from '../../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { ForgeMergeReadPort } from '../../ports/out/ForgeMergeReadPort.out-port.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import {
  DAEMON_RECORD_VERSION,
  buildDaemonStatusRecord,
  evaluateDaemonStatusHealth,
  type BuildDaemonStatusInput,
  type DaemonLeaseRecord,
  type DaemonPauseState,
  type DaemonStatusRecord,
} from '../../../domain/daemon-tick.js';
import type { ConductorHaltState } from '../../../domain/conductor-halt.js';
import type { DaemonEventRecord } from '../../../domain/daemon-events.js';
import type { MergeQueueEntryRecord } from '../../../domain/merge-queue-records.js';
import type { MergeRepoPolicy } from '../../../domain/merge-queue-decider.js';
import type { LeaseAcquireRequest, LeaseHoldRequest } from '../../../domain/lane-run-lease.js';

const TICK_A = `tick-0${'1'.repeat(25)}`;
const DIGEST_A = '00000000000a';
const DIGEST_B = '00000000000b';
const NOW = '2026-11-01T12:00:00.000Z';
const DEADLINE = '2026-11-01T12:00:45.000Z';

function mergePolicy(): MergeRepoPolicy {
  return {
    policyRevision: 'rev-1',
    shadow: true,
    unattended: true,
    updateBranch: false,
    veto: { mode: 'off' },
  };
}

function repoRef(digest: string, overrides: Partial<DaemonRepositoryRef> = {}): DaemonRepositoryRef {
  return {
    owner: 'fleet',
    repo: `v2-${digest.slice(-1)}`,
    repoDigest: digest,
    projectId: 'proj-1',
    policy: mergePolicy(),
    ...overrides,
  };
}

class FakeStatus implements Pick<DaemonStatusPort, 'read' | 'write'> {
  readValue: DaemonStatusFileRead = { status: 'missing' };
  throwOnRead = false;
  throwOnWrite = false;
  readonly writes: BuildDaemonStatusInput[] = [];
  async read(): Promise<DaemonStatusFileRead> {
    if (this.throwOnRead) {
      throw new Error('status store exploded');
    }
    return this.readValue;
  }
  async write(input: BuildDaemonStatusInput) {
    this.writes.push(input);
    if (this.throwOnWrite) {
      throw new Error('status write exploded');
    }
    return buildDaemonStatusRecord(input);
  }
}

class FakeLease implements Pick<DaemonLeasePort, 'acquire' | 'release' | 'read'> {
  readonly records = new Map<string, DaemonLeaseRecord>();
  readonly acquires: (LeaseAcquireRequest & { scope: string })[] = [];
  readonly releases: (LeaseHoldRequest & { scope: string })[] = [];
  refusalReason: string | null = null;
  releaseRefusal: string | null = null;
  throwOnReadScope: string | null = null;
  async read(scope: string): Promise<DaemonLeaseRecord | null> {
    if (scope === this.throwOnReadScope) {
      throw new Error('lease store exploded');
    }
    return this.records.get(scope) ?? null;
  }
  async acquire(request: LeaseAcquireRequest & { scope: string }): Promise<DaemonLeaseResult> {
    this.acquires.push(request);
    if (this.refusalReason !== null) {
      return { outcome: 'refused', reason: this.refusalReason };
    }
    const current = this.records.get(request.scope) ?? null;
    const fence = (current?.fence ?? 0) + 1;
    const lease: DaemonLeaseRecord = {
      version: DAEMON_RECORD_VERSION,
      scope: request.scope,
      holderId: request.holderId,
      fence,
      leaseUntilIso: request.leaseUntilIso,
    };
    this.records.set(request.scope, lease);
    return { outcome: 'ok', lease };
  }
  async release(request: LeaseHoldRequest & { scope: string }): Promise<DaemonLeaseResult> {
    this.releases.push(request);
    if (this.releaseRefusal !== null) {
      return { outcome: 'refused', reason: this.releaseRefusal };
    }
    const existing = this.records.get(request.scope);
    return {
      outcome: 'ok',
      lease: existing ?? {
        version: DAEMON_RECORD_VERSION,
        scope: request.scope,
        holderId: request.holderId,
        fence: request.fence,
        leaseUntilIso: request.nowIso,
      },
    };
  }
}

class FakePause implements Pick<DaemonPausePort, 'read'> {
  state: DaemonPauseState = { state: 'clear', record: null };
  throwOnRead = false;
  async read(): Promise<DaemonPauseState> {
    if (this.throwOnRead) {
      throw new Error('pause marker exploded');
    }
    return this.state;
  }
}

class FakeHalt implements Pick<ConductorHaltPort, 'read'> {
  state: ConductorHaltState = { state: 'clear', record: null };
  async read(): Promise<ConductorHaltState> {
    return this.state;
  }
}

class FakeEvents implements Pick<DaemonEventProjectionPort, 'append'> {
  readonly events: DaemonEventRecord[] = [];
  async append(events: readonly DaemonEventRecord[]): Promise<{ appended: number }> {
    this.events.push(...events);
    return { appended: events.length };
  }
}

class FakeQueue implements Pick<MergeQueueRepositoryPort, 'listMergeEntries'> {
  entries: readonly MergeQueueEntryRecord[] = [];
  throwOnRead = false;
  calls = 0;
  async listMergeEntries(): Promise<readonly MergeQueueEntryRecord[]> {
    this.calls += 1;
    if (this.throwOnRead) {
      throw new Error('queue unreadable');
    }
    return this.entries;
  }
}

class FakeForge implements Pick<ForgeMergeReadPort, 'isConfigured'> {
  configured = true;
  isConfigured(): boolean {
    return this.configured;
  }
}

class FakeJournal implements Pick<LaneRunJournalPort, 'listForKey'> {
  readonly byKey = new Map<string, readonly LaneRunJournalEntryRecord[]>();
  readonly reads: string[] = [];
  async listForKey(key: string): Promise<readonly LaneRunJournalEntryRecord[]> {
    this.reads.push(key);
    return this.byKey.get(key) ?? [];
  }
}

class FakeMergePass implements RunMergePassPort {
  readonly requests: RunMergePassRequest[] = [];
  result: RunMergePassResult = { outcome: 'completed', reasonCode: null, entries: [] };
  throwOnCall = false;
  async runMergePass(request: RunMergePassRequest): Promise<RunMergePassResult> {
    this.requests.push(request);
    if (this.throwOnCall) {
      throw new Error('merge pass failed');
    }
    return this.result;
  }
}

interface Harness {
  readonly useCase: RunDaemonTickUseCase;
  readonly status: FakeStatus;
  readonly lease: FakeLease;
  readonly pause: FakePause;
  readonly halt: FakeHalt;
  readonly events: FakeEvents;
  readonly queue: FakeQueue;
  readonly forge: FakeForge;
  readonly journal: FakeJournal;
  readonly mergePass: FakeMergePass;
  readonly now: () => string;
  readonly sleeps: number[];
  readonly run: (overrides?: Partial<RunDaemonTickRequest>) => Promise<RunDaemonTickResult>;
}

function makeHarness(overrides: {
  readonly previousStatus?: DaemonStatusRecord | null;
  readonly now?: string;
  readonly nowFn?: () => string;
  readonly mergePassResult?: RunMergePassResult;
  readonly queueEntries?: readonly MergeQueueEntryRecord[];
  readonly newUlid?: () => string;
} = {}): Harness {
  const status = new FakeStatus();
  if (overrides.previousStatus !== undefined) {
    status.readValue =
      overrides.previousStatus === null
        ? { status: 'missing' }
        : { status: 'ok', record: overrides.previousStatus };
  }
  const lease = new FakeLease();
  const pause = new FakePause();
  const halt = new FakeHalt();
  const events = new FakeEvents();
  const queue = new FakeQueue();
  queue.entries = overrides.queueEntries ?? [];
  const forge = new FakeForge();
  const journal = new FakeJournal();
  const mergePass = new FakeMergePass();
  if (overrides.mergePassResult !== undefined) {
    mergePass.result = overrides.mergePassResult;
  }
  const now =
    overrides.nowFn ?? (() => overrides.now ?? NOW);
  const sleeps: number[] = [];
  let ulidSequence = 0;
  const deps: RunDaemonTickDependencies = {
    pause,
    halt,
    status,
    lease,
    events,
    queue,
    forge,
    journal,
    mergePass,
    now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    newUlid:
      overrides.newUlid ??
      (() => {
        ulidSequence += 1;
        return '0' + String(ulidSequence).padStart(25, '0');
      }),
  };
  const useCase = new RunDaemonTickUseCase(deps);
  const run = (requestOverrides: Partial<RunDaemonTickRequest> = {}) =>
    useCase.runTick({
      tickId: TICK_A,
      repositories: [repoRef(DIGEST_A), repoRef(DIGEST_B)],
      forgeReachable: true,
      ...requestOverrides,
    });
  return { useCase, status, lease, pause, halt, events, queue, forge, journal, mergePass, now, sleeps, run };
}

describe('RunDaemonTickUseCase (DT10a)', () => {
  it('two repositories become two job instances, two leases and two status records', async () => {
    const h = makeHarness();

    const result = await h.run();

    expect(result.outcome).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.status?.jobs).toHaveLength(2);
    expect(result.status?.repositories).toHaveLength(2);
    expect(result.status?.jobs.map((job) => job.jobId)).toEqual([
      `merge-pass:${DIGEST_A}`,
      `merge-pass:${DIGEST_B}`,
    ]);
    expect(result.status?.repositories.map((repository) => repository.repoDigest)).toEqual([
      DIGEST_A,
      DIGEST_B,
    ]);
    expect(h.lease.acquires.map((acquire) => acquire.scope)).toEqual([
      `merge/${DIGEST_A}`,
      `merge/${DIGEST_B}`,
    ]);
    expect(h.lease.releases.map((release) => release.scope)).toEqual([
      `merge/${DIGEST_A}`,
      `merge/${DIGEST_B}`,
    ]);
  });

  it('the merge pass is called with the repository, the digest, nowIso and deadlineIso', async () => {
    const h = makeHarness();

    await h.run({ repositories: [repoRef(DIGEST_A)] });

    expect(h.mergePass.requests).toHaveLength(1);
    const request = h.mergePass.requests[0];
    expect(request.repository).toEqual({ owner: 'fleet', repo: 'v2-a' });
    expect(request.repoDigest).toBe(DIGEST_A);
    expect(request.projectId).toBe('proj-1');
    expect(request.policy.policyRevision).toBe('rev-1');
    expect(request.deadlineIso).toBe(DEADLINE);
  });

  it('a job whose lease a live holder holds is skipped with lease-held', async () => {
    const h = makeHarness();
    h.lease.refusalReason = 'lease-held';

    const result = await h.run({ repositories: [repoRef(DIGEST_A)] });

    expect(result.exitCode).toBe(0);
    expect(result.status?.jobs[0]).toMatchObject({ outcome: 'skipped', reasonCode: 'lease-held' });
    expect(h.lease.acquires).toHaveLength(1);
    expect(h.mergePass.requests).toHaveLength(0);
  });

  it('the job filter keeps only the named job', async () => {
    const h = makeHarness();

    const result = await h.run({ jobFilter: [`merge-pass:${DIGEST_B}`] });

    expect(result.status?.jobs.map((job) => job.jobId)).toEqual([`merge-pass:${DIGEST_B}`]);
    expect(result.status?.repositories.map((repository) => repository.repoDigest)).toEqual([DIGEST_A, DIGEST_B]);
    expect(h.lease.acquires.map((acquire) => acquire.scope)).toEqual([`merge/${DIGEST_B}`]);
    expect(h.mergePass.requests).toHaveLength(1);
    expect(h.mergePass.requests[0].repoDigest).toBe(DIGEST_B);
  });

  it('a paused tick runs no job, writes a paused status and exits 0', async () => {
    const h = makeHarness();
    h.pause.state = {
      state: 'paused',
      record: { version: DAEMON_RECORD_VERSION, paused: true, changedAtIso: NOW },
    };

    const result = await h.run();

    expect(result.outcome).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.status?.paused).toBe(true);
    expect(result.status?.jobs).toHaveLength(0);
    expect(h.status.writes).toHaveLength(1);
    expect(h.status.writes[0].paused).toBe(true);
    expect(h.lease.acquires).toHaveLength(0);
    expect(h.mergePass.requests).toHaveLength(0);
  });

  it('an unreadable status store refuses the tick with exit 1 and writes no status', async () => {
    const h = makeHarness();
    h.status.readValue = { status: 'unreadable' };

    const result = await h.run();

    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('status-unreadable');
    expect(result.exitCode).toBe(1);
    expect(result.status).toBeNull();
    expect(result.jobs).toHaveLength(0);
    expect(h.status.writes).toHaveLength(0);
    expect(h.mergePass.requests).toHaveLength(0);
  });

  it('an unreachable forge skips every merge-pass job and exits 0', async () => {
    const h = makeHarness();

    const result = await h.run({ forgeReachable: false });

    expect(result.exitCode).toBe(0);
    expect(result.status?.jobs.every((job) => job.outcome === 'skipped' && job.reasonCode === 'forge-unreachable')).toBe(true);
    expect(result.status?.repositories.every((repository) => repository.lastServedAtIso === null)).toBe(true);
    expect(h.lease.acquires).toHaveLength(0);
    expect(h.mergePass.requests).toHaveLength(0);
  });

  it('a budget-exhausted job exits 0 and is starved on the tenth consecutive tick', async () => {
    const previousRead = buildDaemonStatusRecord({
      tickId: TICK_A,
      startedAtIso: '2026-11-01T10:00:00.000Z',
      finishedAtIso: '2026-11-01T10:01:00.000Z',
      paused: false,
      halted: false,
      forgeReachable: true,
      jobs: [
        {
          jobId: `merge-pass:${DIGEST_A}`,
          outcome: 'budget-exhausted',
          reasonCode: null,
          leaseFence: null,
          durationMs: 0,
          nextNotBeforeIso: null,
          consecutiveBudgetExhausted: 9,
        },
      ],
      repositories: [],
      notifierCursor: null,
    });
    expect(previousRead.ok).toBe(true);
    if (!previousRead.ok) {
      throw new Error('fixture');
    }
    let nowCalls = 0;
    const h = makeHarness({
      previousStatus: previousRead.record,
      nowFn: () => {
        nowCalls += 1;
        return nowCalls === 1 ? NOW : '2026-11-01T12:00:46.000Z';
      },
    });

    const result = await h.run({ repositories: [repoRef(DIGEST_A)] });

    expect(result.exitCode).toBe(0);
    expect(result.status?.jobs[0].consecutiveBudgetExhausted).toBe(10);
    expect(result.status?.jobs[0].outcome).toBe('budget-exhausted');
    const status = result.status;
    if (status === null) {
      throw new Error('expected a status record');
    }
    const health = evaluateDaemonStatusHealth(status, NOW);
    expect(health.starvedJobIds).toContain(`merge-pass:${DIGEST_A}`);
  });

  it('the lease is released and the job is refused when the merge pass throws', async () => {
    const h = makeHarness();
    h.mergePass.throwOnCall = true;

    const result = await h.run({ repositories: [repoRef(DIGEST_A)] });

    expect(result.exitCode).toBe(1);
    expect(result.status?.jobs[0]).toMatchObject({ outcome: 'refused', reasonCode: 'job-failed' });
    expect(h.lease.releases).toHaveLength(1);
    expect(h.lease.releases[0].scope).toBe(`merge/${DIGEST_A}`);
    expect(h.lease.releases[0].holderId).toBe(TICK_A);
    expect(h.lease.releases[0].fence).toBe(1);
  });

  it('the tick writes the status through the status port and appends one job event per job', async () => {
    const h = makeHarness();

    await h.run();

    expect(h.status.writes).toHaveLength(1);
    expect(h.status.writes[0].jobs).toHaveLength(2);
    expect(h.events.events).toHaveLength(2);
    expect(h.events.events.every((event) => event.kind === 'job' && event.tickId === TICK_A)).toBe(true);
    expect(h.events.events.map((event) => event.jobId)).toEqual([
      `merge-pass:${DIGEST_A}`,
      `merge-pass:${DIGEST_B}`,
    ]);
  });

  it('a throwing ULID mint never fails the tick after the status was written', async () => {
    const h = makeHarness({
      newUlid: () => {
        throw new Error('ulid mint exploded');
      },
    });

    const result = await h.run();

    expect(result.outcome).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.status).not.toBeNull();
    expect(h.status.writes).toHaveLength(1);
    expect(h.events.events).toHaveLength(0);
  });

  it('a rejected status read refuses the tick as status-unreadable instead of throwing', async () => {
    const h = makeHarness();
    h.status.throwOnRead = true;

    const result = await h.run();

    expect(result.outcome).toBe('refused');
    expect(result.reasonCode).toBe('status-unreadable');
    expect(result.exitCode).toBe(1);
    expect(result.status).toBeNull();
    expect(result.jobs).toHaveLength(0);
    expect(h.status.writes).toHaveLength(0);
    expect(h.mergePass.requests).toHaveLength(0);
  });


  it('a repository with an invalid digest gets no job instance and refuses the tick', async () => {
    const h = makeHarness();
    const registry = new DaemonJobRegistry({ mergePass: h.mergePass });

    expect(registry.instances([repoRef(DIGEST_A), repoRef('not-a-digest')]).map((job) => job.jobId)).toEqual([
      `merge-pass:${DIGEST_A}`,
    ]);

    const result = await h.run({ repositories: [repoRef(DIGEST_A), repoRef('not-a-digest')] });

    expect(result).toMatchObject({ outcome: 'refused', exitCode: 1, reasonCode: 'invalid-repository', status: null });
    expect(h.status.writes).toHaveLength(0);
    expect(h.lease.acquires).toHaveLength(0);
    expect(h.mergePass.requests).toHaveLength(0);
  });

  it('a repeated repository refuses the tick, so one job runs per repository', async () => {
    const h = makeHarness();

    const sameDigest = await h.run({ repositories: [repoRef(DIGEST_A), repoRef(DIGEST_A, { repo: 'other' })] });
    const sameName = await h.run({ repositories: [repoRef(DIGEST_A), repoRef(DIGEST_B, { repo: 'V2-A' })] });

    expect(sameDigest).toMatchObject({ outcome: 'refused', exitCode: 1, reasonCode: 'duplicate-repository' });
    expect(sameName).toMatchObject({ outcome: 'refused', exitCode: 1, reasonCode: 'duplicate-repository' });
    expect(h.status.writes).toHaveLength(0);
    expect(h.mergePass.requests).toHaveLength(0);
  });

  it('malformed runtime requests become typed refusals and never throw', async () => {
    const h = makeHarness();
    const cases: readonly [unknown, string][] = [
      [null, 'invalid-request'],
      [{ tickId: 'tick-bad', repositories: [], forgeReachable: true }, 'invalid-tick-id'],
      [{ tickId: TICK_A, repositories: [], forgeReachable: true, budgetSeconds: 0 }, 'invalid-budget'],
      [{ tickId: TICK_A, repositories: [], forgeReachable: true, budgetSeconds: 4.5 }, 'invalid-budget'],
      [{ tickId: TICK_A, repositories: 'fleet/v2', forgeReachable: true }, 'invalid-repositories'],
      [{ tickId: TICK_A, repositories: [null], forgeReachable: true }, 'invalid-repository'],
      [{ tickId: TICK_A, repositories: [repoRef(DIGEST_A, { owner: '..' })], forgeReachable: true }, 'invalid-repository'],
      [{ tickId: TICK_A, repositories: [repoRef(DIGEST_A, { projectId: '' })], forgeReachable: true }, 'invalid-repository'],
      [
        {
          tickId: TICK_A,
          repositories: [repoRef(DIGEST_A, { policy: { policyRevision: 'rev-1' } as unknown as MergeRepoPolicy })],
          forgeReachable: true,
        },
        'invalid-repository',
      ],
      [
        {
          tickId: TICK_A,
          repositories: [repoRef(DIGEST_A, { policy: { ...mergePolicy(), veto: { mode: 'typo' } } as unknown as MergeRepoPolicy })],
          forgeReachable: true,
        },
        'invalid-repository',
      ],
      [{ tickId: TICK_A, repositories: [], forgeReachable: true, jobFilter: [1] }, 'invalid-job-filter'],
      [{ tickId: TICK_A, repositories: [] }, 'forge-probe-missing'],
      [{ tickId: TICK_A, repositories: [], forgeReachable: 'yes' }, 'forge-probe-missing'],
    ];

    const hostile = {
      get tickId(): string {
        throw new Error('getter exploded');
      },
    };
    await expect(h.useCase.runTick(hostile as unknown as RunDaemonTickRequest)).resolves.toMatchObject({
      outcome: 'refused',
      tickId: '',
      reasonCode: 'tick-failed',
    });

    for (const [request, reasonCode] of cases) {
      const result = await h.useCase.runTick(request as RunDaemonTickRequest);
      expect(result).toMatchObject({ outcome: 'refused', exitCode: 1, status: null, reasonCode });
    }
    expect(h.status.writes).toHaveLength(0);
    expect(h.mergePass.requests).toHaveLength(0);
  });

  it('a configured transport is not a passing probe: forge-touching jobs need both', async () => {
    const h = makeHarness();
    h.forge.configured = false;

    const unconfigured = await h.run({ forgeReachable: true });

    expect(unconfigured.exitCode).toBe(0);
    expect(unconfigured.status?.forgeReachable).toBe(false);
    expect(unconfigured.status?.jobs.every((job) => job.reasonCode === 'forge-unreachable')).toBe(true);

    h.forge.configured = true;
    const probeFailed = await h.run({ forgeReachable: false });

    expect(probeFailed.status?.jobs.every((job) => job.reasonCode === 'forge-unreachable')).toBe(true);
    expect(h.mergePass.requests).toHaveLength(0);
    expect(h.lease.acquires).toHaveLength(0);
  });

  it('the projection carries the journal entries the merge pass appended during the tick, then the job line', async () => {
    const key = `merge/${DIGEST_A}/42/0123456789ab/merge-pr`;
    const h = makeHarness({
      mergePassResult: {
        outcome: 'completed',
        reasonCode: null,
        entries: [
          { entryId: 'entry-1', head12: '0123456789ab', decision: 'journalled', reasonCode: 'would-merge', journalKey: key },
          { entryId: 'entry-2', head12: '0123456789ab', decision: 'no-action', reasonCode: 'checks-pending', journalKey: null },
        ],
      },
    });
    const journalEntry = (kind: 'intent' | 'result', recordedAtIso: string, entryId: string) =>
      ({
        version: 1,
        entryId,
        kind,
        key,
        runId: null,
        recordedAtIso,
        mode: null,
        expectedRevision: null,
        mintedId: null,
        outcome: kind === 'result' ? 'dry-run' : null,
        reasonCode: kind === 'result' ? 'would-merge' : null,
        detail: null,
        grantId: null,
        state: null,
      }) as LaneRunJournalEntryRecord;
    const during = '2026-11-01T12:00:01.000Z';
    h.journal.byKey.set(key, [
      journalEntry('intent', '2026-11-01T11:00:00.000Z', `0${'6'.repeat(25)}`),
      // stamped in the same millisecond as the job's start: written before this pass, never projected
      journalEntry('result', NOW, `0${'7'.repeat(25)}`),
      journalEntry('intent', during, `0${'8'.repeat(25)}`),
      journalEntry('result', during, `0${'9'.repeat(25)}`),
    ]);

    await h.run({ repositories: [repoRef(DIGEST_A)] });

    expect(h.journal.reads).toEqual([key]);
    expect(h.events.events.map((event) => [event.kind, event.key, event.entryId, event.outcome])).toEqual([
      ['intent', key, 'entry-1', null],
      ['result', key, null, 'dry-run'],
      ['job', null, null, 'completed'],
    ]);
    expect(h.events.events.every((event) => event.jobId === `merge-pass:${DIGEST_A}`)).toBe(true);
  });

  it('a refused lease release refuses the job so the held lease is visible', async () => {
    const h = makeHarness();
    h.lease.releaseRefusal = 'lease-moved';

    const result = await h.run({ repositories: [repoRef(DIGEST_A)] });

    expect(result.outcome).toBe('completed');
    expect(result.exitCode).toBe(1);
    expect(result.status?.jobs[0]).toMatchObject({ outcome: 'refused', reasonCode: 'lease-release-failed', leaseFence: 1 });
    expect(h.mergePass.requests).toHaveLength(1);
  });

  it('a filtered-out repository keeps its status record and its previous lastServedAtIso', async () => {
    const served = '2026-11-01T11:59:00.000Z';
    const previousRead = buildDaemonStatusRecord({
      tickId: TICK_A,
      startedAtIso: '2026-11-01T11:59:00.000Z',
      finishedAtIso: '2026-11-01T11:59:30.000Z',
      paused: false,
      halted: false,
      forgeReachable: true,
      jobs: [],
      repositories: [
        { repoDigest: DIGEST_A, lastServedAtIso: served, queued: 3, ready: 1, parked: 1, headEntryId: null, lastMergedHead12: null },
      ],
      notifierCursor: null,
    });
    if (!previousRead.ok) {
      throw new Error('fixture');
    }
    const h = makeHarness({ previousStatus: previousRead.record });
    h.queue.throwOnRead = true;

    const result = await h.run({ jobFilter: [`merge-pass:${DIGEST_B}`] });

    const repoA = result.status?.repositories.find((repository) => repository.repoDigest === DIGEST_A);
    expect(repoA).toMatchObject({ lastServedAtIso: served, queued: 3, ready: 1, parked: 1 });
    expect(result.status?.repositories.find((repository) => repository.repoDigest === DIGEST_B)?.lastServedAtIso).toBe(NOW);
  });

  it('a failing pause read pauses the tick (fail closed); a halted tick still runs and records the halt', async () => {
    const paused = makeHarness();
    paused.pause.throwOnRead = true;

    const pausedResult = await paused.run();

    expect(pausedResult).toMatchObject({ outcome: 'completed', exitCode: 0 });
    expect(pausedResult.status?.paused).toBe(true);
    expect(paused.mergePass.requests).toHaveLength(0);

    const halted = makeHarness();
    halted.halt.state = { state: 'unreadable' };

    const haltedResult = await halted.run({ repositories: [repoRef(DIGEST_A)] });

    expect(haltedResult.status?.halted).toBe(true);
    expect(halted.mergePass.requests).toHaveLength(1);
  });

  it('a failing lease read refuses that job only; the tick still writes its status', async () => {
    const h = makeHarness();
    h.lease.throwOnReadScope = `merge/${DIGEST_A}`;

    const result = await h.run();

    expect(result.outcome).toBe('completed');
    expect(result.exitCode).toBe(1);
    expect(result.status?.jobs).toEqual([
      expect.objectContaining({ jobId: `merge-pass:${DIGEST_A}`, outcome: 'refused', reasonCode: 'lease-unreadable' }),
      expect.objectContaining({ jobId: `merge-pass:${DIGEST_B}`, outcome: 'completed' }),
    ]);
    expect(h.mergePass.requests.map((request) => request.repoDigest)).toEqual([DIGEST_B]);
  });

  it('a malformed or failing lease acquire refuses the job and releases the expected fence', async () => {
    const malformed = makeHarness();
    malformed.lease.acquire = async (request) => {
      malformed.lease.acquires.push(request);
      return { outcome: 'ok' } as unknown as DaemonLeaseResult;
    };

    const result = await malformed.run({ repositories: [repoRef(DIGEST_A)] });

    expect(result.outcome).toBe('completed');
    expect(result.status?.jobs[0]).toMatchObject({ outcome: 'refused', reasonCode: 'lease-unreadable', leaseFence: null });
    expect(malformed.mergePass.requests).toHaveLength(0);
    expect(malformed.lease.releases).toEqual([
      expect.objectContaining({ scope: `merge/${DIGEST_A}`, holderId: TICK_A, fence: 1 }),
    ]);

    const foreign = makeHarness();
    foreign.lease.acquire = async (request) => ({
      outcome: 'ok',
      lease: {
        version: DAEMON_RECORD_VERSION,
        scope: request.scope,
        holderId: `tick-0${'2'.repeat(25)}`,
        fence: 7,
        leaseUntilIso: request.leaseUntilIso,
      },
    });
    const garbage = makeHarness();
    garbage.lease.acquire = async () => 'ok' as unknown as DaemonLeaseResult;

    const foreignResult = await foreign.run({ repositories: [repoRef(DIGEST_A)] });
    const garbageResult = await garbage.run({ repositories: [repoRef(DIGEST_A)] });

    for (const [harness, outcome] of [
      [foreign, foreignResult],
      [garbage, garbageResult],
    ] as const) {
      expect(outcome.status?.jobs[0]).toMatchObject({ outcome: 'refused', reasonCode: 'lease-unreadable' });
      expect(harness.mergePass.requests).toHaveLength(0);
      expect(harness.lease.releases).toEqual([expect.objectContaining({ fence: 1, holderId: TICK_A })]);
    }

    const failing = makeHarness();
    failing.lease.acquire = async () => {
      throw new Error('lease write exploded');
    };

    const failed = await failing.run({ repositories: [repoRef(DIGEST_A)] });

    expect(failed.status?.jobs[0]).toMatchObject({ outcome: 'refused', reasonCode: 'lease-unreadable' });
    expect(failing.lease.releases).toHaveLength(1);
    expect(failing.mergePass.requests).toHaveLength(0);
  });

  it('a failing status write refuses the tick as status-write-failed', async () => {
    const h = makeHarness();
    h.status.throwOnWrite = true;

    const result = await h.run({ repositories: [repoRef(DIGEST_A)] });

    expect(result).toMatchObject({ outcome: 'refused', exitCode: 1, reasonCode: 'status-write-failed', status: null });
    expect(h.lease.releases).toHaveLength(1);
  });

  it('past the deadline no job, queue read or journal read starts (D-DT9)', async () => {
    let nowCalls = 0;
    const h = makeHarness({
      nowFn: () => {
        nowCalls += 1;
        return nowCalls === 1 ? NOW : '2026-11-01T12:00:44.000Z';
      },
    });

    const result = await h.run();

    expect(result.exitCode).toBe(0);
    expect(result.status?.jobs.every((job) => job.outcome === 'budget-exhausted')).toBe(true);
    expect(h.lease.acquires).toHaveLength(0);
    expect(h.mergePass.requests).toHaveLength(0);
    expect(h.queue.calls).toBe(0);
  });

  it('a clock that throws or goes malformed after the start keeps every stamp valid', async () => {
    let nowCalls = 0;
    const h = makeHarness({
      nowFn: () => {
        nowCalls += 1;
        if (nowCalls === 1) {
          return NOW;
        }
        if (nowCalls % 2 === 0) {
          throw new Error('clock exploded');
        }
        return 'not-a-time';
      },
    });

    const result = await h.run();

    expect(result.outcome).toBe('completed');
    expect(result.status?.finishedAtIso).toBe(NOW);
    expect(result.status?.jobs.every((job) => job.durationMs === 0)).toBe(true);
  });

  it('a malformed or secret-shaped merge pass answer is recorded as a typed refusal', async () => {
    const h = makeHarness({
      mergePassResult: { outcome: 'refused', reasonCode: 'ghp_' + 'a'.repeat(36), entries: [] },
    });

    const result = await h.run({ repositories: [repoRef(DIGEST_A)] });

    expect(result.outcome).toBe('completed');
    expect(result.status?.jobs[0]).toMatchObject({ outcome: 'refused', reasonCode: 'merge-pass-refused' });

    const fresh = makeHarness({ mergePassResult: null as unknown as RunMergePassResult });
    const malformed = await fresh.run({ repositories: [repoRef(DIGEST_A)] });

    expect(malformed.status?.jobs[0]).toMatchObject({ outcome: 'refused', reasonCode: 'merge-pass-malformed' });
  });
});
