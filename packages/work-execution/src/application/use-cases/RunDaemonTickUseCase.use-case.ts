// @generated use-case scaffold — refined for lane DT10a.
/**
 * RunDaemonTickUseCase implements RunDaemonTickPort: one bounded daemon tick
 * (daemon-tick plan §3.1, lane DT10a). It reads the pause and halt markers,
 * expands the configured repositories into one merge-pass job instance each,
 * orders the jobs deterministically, takes each job's lease by CAS, runs it
 * under the tick's deadline, releases the lease, writes `status.json`
 * atomically and appends the job outcomes to the events projection. The tick
 * never merges, never writes to the forge and never resolves a thread: it
 * leases, calls one job, records, and projects. Never throws, never logs, no
 * I/O of its own.
 */

import {
  DAEMON_CALL_MIN_REMAINING_MS,
  DAEMON_DEFAULT_BUDGET_SECONDS,
  DAEMON_REPO_DIGEST_PATTERN,
  DAEMON_TICK_ID_PATTERN,
  computeCallBudget,
  computeTickDeadlineIso,
  decideDaemonJobLease,
  mergePassJobId,
  nextConsecutiveBudgetExhausted,
  parseDaemonJobId,
  planDaemonTick,
  resolveRepoLastServedAtIso,
  tickExitCodeForJobs,
  type DaemonJobOutcome,
  type DaemonJobStatusRecord,
  type DaemonLeaseRecord,
  type DaemonRepositoryStatusRecord,
  type DaemonStatusRecord,
  type ParsedDaemonJobId,
} from '../../domain/daemon-tick.js';
import { projectJobOutcomeToDaemonEvent, type DaemonEventRecord } from '../../domain/daemon-events.js';
import { LANE_RUN_LEASE_MAX_MS } from '../../domain/lane-run-lease.js';
import type { LaneRunLeaseRecord } from '../../domain/lane-run-records.js';
import {
  findMergeQueueHead,
  orderMergeQueue,
  type MergeQueueEntryRecord,
} from '../../domain/merge-queue-records.js';
import type { DaemonJobPort, DaemonJobPassRequest } from '../ports/out/DaemonJobPort.out-port.js';
import type { ConductorHaltPort } from '../ports/out/ConductorHaltPort.out-port.js';
import type { DaemonEventProjectionPort } from '../ports/out/DaemonEventProjectionPort.out-port.js';
import type { DaemonLeasePort } from '../ports/out/DaemonLeasePort.out-port.js';
import type { DaemonPausePort } from '../ports/out/DaemonPausePort.out-port.js';
import type { DaemonStatusPort } from '../ports/out/DaemonStatusPort.out-port.js';
import type { ForgeMergeReadPort } from '../ports/out/ForgeMergeReadPort.out-port.js';
import type { MergeQueueRepositoryPort } from '../ports/out/MergeQueueRepositoryPort.out-port.js';
import type {
  DaemonRepositoryRef,
  RunDaemonTickPort,
  RunDaemonTickRequest,
  RunDaemonTickResult,
} from '../ports/in/RunDaemonTickPort.in-port.js';
import type { RunMergePassPort, RunMergePassResult } from '../ports/in/RunMergePassPort.in-port.js';

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** The production sleep: a `setTimeout` promise. Tests inject a fake instead. */
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RunDaemonTickDependencies {
  readonly pause: Pick<DaemonPausePort, 'read'>;
  readonly halt: Pick<ConductorHaltPort, 'read'>;
  readonly status: Pick<DaemonStatusPort, 'read' | 'write'>;
  readonly lease: Pick<DaemonLeasePort, 'acquire' | 'release' | 'read'>;
  readonly events: Pick<DaemonEventProjectionPort, 'append'>;
  readonly queue: Pick<MergeQueueRepositoryPort, 'listMergeEntries'>;
  readonly forge: Pick<ForgeMergeReadPort, 'isConfigured'>;
  readonly mergePass: RunMergePassPort;
  /** The tick clock; production real time, tests a fake. Absent means the system clock. */
  readonly now?: () => string;
  /** The tick sleep, awaited for the wake settle delay. Absent means a `setTimeout` promise. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Mints the projection event ids (a ULID). */
  readonly newUlid: () => string;
}

export interface DaemonJobRegistryDependencies {
  readonly mergePass: RunMergePassPort;
}

/** The port lease record → the domain lease record: only the three domain fields. */
function toLaneRunLease(lease: DaemonLeaseRecord | null): LaneRunLeaseRecord | null {
  return lease === null
    ? null
    : { holderId: lease.holderId, fence: lease.fence, leaseUntilIso: lease.leaseUntilIso };
}

/** DT9a's pass result → the DaemonJobOutcome the tick records. */
function toDaemonJobOutcome(result: RunMergePassResult): DaemonJobOutcome {
  if (result.outcome === 'completed') {
    return { outcome: 'completed', progressed: result.entries.length > 0 };
  }
  if (result.outcome === 'budget-exhausted') {
    return { outcome: 'budget-exhausted', progressed: false };
  }
  return { outcome: 'refused', reasonCode: result.reasonCode ?? 'merge-pass-refused' };
}

/** The earliest notBeforeIso among a repository's live entries; null when there is none. */
function earliestNotBeforeIso(entries: readonly MergeQueueEntryRecord[], digest: string): string | null {
  let best: string | null = null;
  for (const entry of orderMergeQueue(entries, digest)) {
    const notBefore = entry.notBeforeIso;
    if (notBefore === null) continue;
    if (best === null || Date.parse(notBefore) < Date.parse(best)) best = notBefore;
  }
  return best;
}

/** The head12 of the most recently merged entry of a repository; null when there is none. */
function lastMergedHead12(entries: readonly MergeQueueEntryRecord[], digest: string): string | null {
  let best: MergeQueueEntryRecord | null = null;
  for (const entry of entries) {
    if (entry.repoDigest !== digest || entry.state !== 'merged' || entry.mergedAtIso === null) continue;
    if (best === null || Date.parse(entry.mergedAtIso) > Date.parse(best.mergedAtIso ?? '')) best = entry;
  }
  return best === null ? null : best.headOid.slice(0, 12);
}

/** One merge-pass job instance: wraps the merge pass for one repository. */
class MergePassJob implements DaemonJobPort {
  constructor(
    private readonly repository: DaemonRepositoryRef,
    private readonly mergePass: RunMergePassPort,
    readonly jobId: string,
    readonly leaseScope: string,
  ) {}

  async pass(request: DaemonJobPassRequest): Promise<DaemonJobOutcome> {
    const result = await this.mergePass.runMergePass({
      repository: { owner: this.repository.owner, repo: this.repository.repo },
      repoDigest: this.repository.repoDigest,
      projectId: this.repository.projectId,
      policy: this.repository.policy,
      deadlineIso: request.deadlineIso,
    });
    return toDaemonJobOutcome(result);
  }
}

/** The registry that expands the configured repositories into one merge-pass job instance each. */
export class DaemonJobRegistry {
  constructor(private readonly deps: DaemonJobRegistryDependencies) {}

  /** One merge-pass job instance per valid repository, in request order. */
  instances(repositories: readonly DaemonRepositoryRef[]): readonly DaemonJobPort[] {
    const instances: DaemonJobPort[] = [];
    for (const repository of repositories) {
      if (
        !REPOSITORY_SEGMENT_PATTERN.test(repository.owner) ||
        repository.owner === '.' ||
        repository.owner === '..' ||
        !REPOSITORY_SEGMENT_PATTERN.test(repository.repo) ||
        repository.repo === '.' ||
        repository.repo === '..' ||
        !DAEMON_REPO_DIGEST_PATTERN.test(repository.repoDigest)
      ) {
        continue;
      }
      const parsed = parseDaemonJobId(mergePassJobId(repository.repoDigest));
      if (parsed === null || parsed.kind !== 'merge-pass') {
        continue;
      }
      instances.push(new MergePassJob(repository, this.deps.mergePass, parsed.jobId, parsed.leaseScope));
    }
    return instances;
  }
}

/** One planned job run: the outcome plus the timing and lease facts the records need. */
interface JobRun {
  readonly jobId: string;
  readonly digest: string | null;
  readonly outcome: DaemonJobOutcome;
  readonly leaseFence: number | null;
  readonly startedAtIso: string;
  readonly finishedAtIso: string;
}

export class RunDaemonTickUseCase implements RunDaemonTickPort {
  constructor(private readonly deps: RunDaemonTickDependencies) {}

  /**
   * The never-throws contract: a rejected port call, a throwing clock or a
   * throwing ULID mint never escapes; the tick returns a refused result.
   */
  async runTick(request: RunDaemonTickRequest): Promise<RunDaemonTickResult> {
    try {
      return await this.runTickInner(request);
    } catch {
      return this.refused(request.tickId, 'tick-failed');
    }
  }

  private async runTickInner(request: RunDaemonTickRequest): Promise<RunDaemonTickResult> {
    if (!DAEMON_TICK_ID_PATTERN.test(request.tickId)) {
      return this.refused(request.tickId, 'invalid-tick-id');
    }
    const nowIso = this.nowIso();
    const deadlineIso = computeTickDeadlineIso(
      nowIso,
      request.budgetSeconds ?? DAEMON_DEFAULT_BUDGET_SECONDS,
    );
    if (deadlineIso === null) {
      return this.refused(request.tickId, 'invalid-clock');
    }

    const previous = await this.deps.status.read();
    if (previous.status === 'unreadable') {
      return this.refused(request.tickId, 'status-unreadable');
    }
    const previousStatus = previous.status === 'ok' ? previous.record : null;

    const pause = await this.deps.pause.read();
    const halt = await this.deps.halt.read();
    const forgeReachable = request.forgeReachable ?? this.deps.forge.isConfigured();

    const registry = new DaemonJobRegistry({ mergePass: this.deps.mergePass });
    const jobs = registry.instances(request.repositories);
    const candidateIds = jobs.map((job) => job.jobId);

    const plan = planDaemonTick({
      candidates: candidateIds,
      previousStatus,
      pause,
      halt,
      forgeReachable,
      nowIso,
      jobFilter: request.jobFilter,
    });

    if (plan.settleDelayMs > 0) {
      await (this.deps.sleep ?? defaultSleep)(plan.settleDelayMs);
    }

    if (plan.paused) {
      const written = await this.deps.status.write({
        tickId: request.tickId,
        startedAtIso: nowIso,
        finishedAtIso: this.nowIso(),
        paused: true,
        halted: plan.halted,
        forgeReachable: null,
        jobs: [],
        repositories: previousStatus?.repositories ?? [],
        notifierCursor: previousStatus?.notifierCursor ?? null,
      });
      if (!written.ok) {
        return this.refused(request.tickId, 'status-unreadable');
      }
      return { outcome: 'completed', exitCode: 0, tickId: request.tickId, status: written.record, jobs: [] };
    }

    const jobById = new Map<string, DaemonJobPort>(jobs.map((job) => [job.jobId, job]));
    const runs: JobRun[] = [];
    for (const entry of plan.entries) {
      if (entry.action === 'skip') {
        const at = this.nowIso();
        runs.push({
          jobId: entry.job.jobId,
          digest: entry.job.kind === 'merge-pass' ? entry.job.repoDigest : null,
          outcome: entry.outcome,
          leaseFence: null,
          startedAtIso: at,
          finishedAtIso: at,
        });
        continue;
      }
      const job = jobById.get(entry.job.jobId);
      if (job === undefined) {
        const at = this.nowIso();
        runs.push({
          jobId: entry.job.jobId,
          digest: entry.job.kind === 'merge-pass' ? entry.job.repoDigest : null,
          outcome: { outcome: 'refused', reasonCode: 'job-failed' },
          leaseFence: null,
          startedAtIso: at,
          finishedAtIso: at,
        });
        continue;
      }
      runs.push(await this.runOneJob(job, entry.job, request, deadlineIso));
    }

    let queueEntries: readonly MergeQueueEntryRecord[] = [];
    let queueReadable = true;
    try {
      queueEntries = await this.deps.queue.listMergeEntries({ deadlineIso });
    } catch {
      queueReadable = false;
    }

    const jobRecords = this.jobRecords(runs, queueEntries, queueReadable, previousStatus);
    const repositoryRecords = this.repositoryRecords(jobs, runs, queueEntries, queueReadable, previousStatus);

    const finishedAtIso = this.nowIso();
    const written = await this.deps.status.write({
      tickId: request.tickId,
      startedAtIso: nowIso,
      finishedAtIso,
      paused: plan.paused,
      halted: plan.halted,
      forgeReachable: plan.forgeReachable,
      jobs: jobRecords,
      repositories: repositoryRecords,
      notifierCursor: previousStatus?.notifierCursor ?? null,
    });
    if (!written.ok) {
      return this.refused(request.tickId, 'status-unreadable');
    }

    const projected: DaemonEventRecord[] = [];
    try {
      for (const run of runs) {
        const event = projectJobOutcomeToDaemonEvent({
          eventId: this.deps.newUlid(),
          tickId: request.tickId,
          jobId: run.jobId,
          jobOutcome: run.outcome,
          recordedAtIso: finishedAtIso,
        });
        if (event.ok) {
          projected.push(event.record);
        }
      }
      await this.deps.events.append(projected);
    } catch {
      // a projection failure never fails the tick
    }

    return {
      outcome: 'completed',
      exitCode: tickExitCodeForJobs(jobRecords),
      tickId: request.tickId,
      status: written.record,
      jobs: jobRecords,
    };
  }

  private refused(tickId: string, reasonCode: string): RunDaemonTickResult {
    return { outcome: 'refused', exitCode: 1, tickId, status: null, jobs: [], reasonCode };
  }

  /** The tick clock, read fresh before each step; production real time, tests a fake. */
  private nowIso(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  /** One job run: budget guard, lease CAS, the pass under the deadline, release. */
  private async runOneJob(
    job: DaemonJobPort,
    parsed: ParsedDaemonJobId,
    request: RunDaemonTickRequest,
    deadlineIso: string,
  ): Promise<JobRun> {
    const startedAtIso = this.nowIso();
    const digest = parsed.kind === 'merge-pass' ? parsed.repoDigest : null;
    const budget = computeCallBudget({
      nowIso: startedAtIso,
      deadlineIso,
      normalTimeoutMs: DAEMON_CALL_MIN_REMAINING_MS,
    });
    if (!budget.allowed) {
      return {
        jobId: parsed.jobId,
        digest,
        outcome: { outcome: 'budget-exhausted', progressed: false },
        leaseFence: null,
        startedAtIso,
        finishedAtIso: this.nowIso(),
      };
    }

    const scope = job.leaseScope;
    const current = await this.deps.lease.read(scope);
    const budgetSeconds = request.budgetSeconds ?? DAEMON_DEFAULT_BUDGET_SECONDS;
    const leaseUntilIso = new Date(
      Date.parse(startedAtIso) + Math.min(LANE_RUN_LEASE_MAX_MS, (budgetSeconds + 10) * 1000),
    ).toISOString();
    const acquireRequest = {
      holderId: request.tickId,
      observedFence: current?.fence ?? 0,
      leaseUntilIso,
      nowIso: startedAtIso,
    };
    const decision = decideDaemonJobLease(toLaneRunLease(current), acquireRequest, scope);
    if (decision.action === 'skip' || decision.action === 'refuse') {
      return {
        jobId: parsed.jobId,
        digest,
        outcome: decision.outcome,
        leaseFence: null,
        startedAtIso,
        finishedAtIso: this.nowIso(),
      };
    }

    const acquired = await this.deps.lease.acquire({ scope, ...acquireRequest });
    if (acquired.outcome !== 'ok') {
      const outcome: DaemonJobOutcome =
        acquired.reason === 'lease-held'
          ? { outcome: 'skipped', reasonCode: 'lease-held' }
          : acquired.reason === 'lease-moved'
            ? { outcome: 'skipped', reasonCode: 'lease-moved' }
            : { outcome: 'refused', reasonCode: 'invalid-lease-request' };
      return {
        jobId: parsed.jobId,
        digest,
        outcome,
        leaseFence: null,
        startedAtIso,
        finishedAtIso: this.nowIso(),
      };
    }

    const fence = acquired.lease.fence;
    let outcome: DaemonJobOutcome;
    try {
      outcome = await job.pass({ nowIso: startedAtIso, deadlineIso });
    } catch {
      outcome = { outcome: 'refused', reasonCode: 'job-failed' };
    } finally {
      try {
        await this.deps.lease.release({
          scope,
          holderId: request.tickId,
          fence,
          nowIso: this.nowIso(),
        });
      } catch {
        // a release failure is swallowed, never fatal
      }
    }
    return {
      jobId: parsed.jobId,
      digest,
      outcome,
      leaseFence: fence,
      startedAtIso,
      finishedAtIso: this.nowIso(),
    };
  }

  /** One DaemonJobStatusRecord per run, in the order the jobs ran. */
  private jobRecords(
    runs: readonly JobRun[],
    queueEntries: readonly MergeQueueEntryRecord[],
    queueReadable: boolean,
    previousStatus: DaemonStatusRecord | null,
  ): DaemonJobStatusRecord[] {
    return runs.map((run) => {
      const previousJob = previousStatus?.jobs.find((record) => record.jobId === run.jobId);
      const nextNotBeforeIso = queueReadable
        ? run.digest === null
          ? null
          : earliestNotBeforeIso(queueEntries, run.digest)
        : previousJob?.nextNotBeforeIso ?? null;
      return {
        jobId: run.jobId,
        outcome: run.outcome.outcome,
        reasonCode: 'reasonCode' in run.outcome ? run.outcome.reasonCode ?? null : null,
        leaseFence: run.leaseFence,
        durationMs: Math.max(0, Date.parse(run.finishedAtIso) - Date.parse(run.startedAtIso)),
        nextNotBeforeIso,
        consecutiveBudgetExhausted: nextConsecutiveBudgetExhausted(
          previousJob?.consecutiveBudgetExhausted ?? 0,
          run.outcome.outcome,
        ),
      };
    });
  }

  /** One DaemonRepositoryStatusRecord per planned job instance's repository, in the registry's order. */
  private repositoryRecords(
    jobs: readonly DaemonJobPort[],
    runs: readonly JobRun[],
    queueEntries: readonly MergeQueueEntryRecord[],
    queueReadable: boolean,
    previousStatus: DaemonStatusRecord | null,
  ): DaemonRepositoryStatusRecord[] {
    const records: DaemonRepositoryStatusRecord[] = [];
    for (const instance of jobs) {
      const parsed = parseDaemonJobId(instance.jobId);
      if (parsed === null || parsed.kind !== 'merge-pass') {
        continue;
      }
      const run = runs.find((candidate) => candidate.jobId === instance.jobId);
      if (run === undefined) {
        continue;
      }
      const digest = parsed.repoDigest;
      const previousRepository = previousStatus?.repositories.find((record) => record.repoDigest === digest);
      const live = queueReadable ? orderMergeQueue(queueEntries, digest) : [];
      records.push({
        repoDigest: digest,
        lastServedAtIso: resolveRepoLastServedAtIso(
          previousRepository?.lastServedAtIso ?? null,
          run.outcome.outcome === 'skipped' ? null : run.startedAtIso,
        ),
        queued: queueReadable ? live.length : previousRepository?.queued ?? 0,
        ready: queueReadable ? live.filter((entry) => entry.state === 'ready').length : previousRepository?.ready ?? 0,
        parked: queueReadable ? live.filter((entry) => entry.state === 'parked').length : previousRepository?.parked ?? 0,
        headEntryId: queueReadable
          ? findMergeQueueHead(queueEntries, digest)?.entryId ?? null
          : previousRepository?.headEntryId ?? null,
        lastMergedHead12: queueReadable
          ? lastMergedHead12(queueEntries, digest)
          : previousRepository?.lastMergedHead12 ?? null,
      });
    }
    return records;
  }
}
