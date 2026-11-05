// @generated use-case scaffold — refined for lane DT10a.
/**
 * RunDaemonTickUseCase implements RunDaemonTickPort: one bounded daemon tick
 * (daemon-tick plan §3.1, lane DT10a). It validates the request, reads the
 * pause and halt markers, expands the configured repositories into one
 * merge-pass job instance each, orders the jobs deterministically, takes each
 * job's lease by CAS, runs it under the tick's deadline, releases the lease,
 * writes `status.json` atomically and appends the tick's projection lines
 * (the journal entries the merge passes appended, then each job's outcome) to
 * `events.jsonl`. The tick never merges, never writes to the forge and never
 * resolves a thread: it leases, calls one job, records, and projects. Never
 * throws (every malformed input or port failure becomes a typed refusal),
 * never logs, no I/O of its own.
 */

import { containsSecretShape } from '@fleet/shared';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import type { ConductorHaltState } from '../../domain/conductor-halt.js';
import {
  DAEMON_CALL_MIN_REMAINING_MS,
  DAEMON_DEFAULT_BUDGET_SECONDS,
  DAEMON_MAX_BUDGET_SECONDS,
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
  type BuildDaemonStatusInput,
  type DaemonJobOutcome,
  type DaemonJobStatusRecord,
  type DaemonLeaseRecord,
  type DaemonPauseState,
  type DaemonPlannedJobEntry,
  type DaemonRepositoryStatusRecord,
  type DaemonStatusRead,
  type DaemonStatusRecord,
  type DaemonTickPlan,
  type ParsedDaemonJobId,
} from '../../domain/daemon-tick.js';
import {
  projectJobOutcomeToDaemonEvent,
  projectJournalEntryToDaemonEvent,
  type DaemonEventRecord,
} from '../../domain/daemon-events.js';
import { LANE_RUN_JOURNAL_REASON_CODE_PATTERN } from '../../domain/lane-run-journal.js';
import { LANE_RUN_LEASE_MAX_MS } from '../../domain/lane-run-lease.js';
import type { LaneRunLeaseRecord } from '../../domain/lane-run-records.js';
import {
  MERGE_VETO_MODES,
  findMergeQueueHead,
  orderMergeQueue,
  type MergeQueueEntryRecord,
} from '../../domain/merge-queue-records.js';
import type { DaemonJobPort, DaemonJobPassRequest } from '../ports/out/DaemonJobPort.out-port.js';
import type { ConductorHaltPort } from '../ports/out/ConductorHaltPort.out-port.js';
import type { DaemonEventProjectionPort } from '../ports/out/DaemonEventProjectionPort.out-port.js';
import type { DaemonLeasePort, DaemonLeaseResult } from '../ports/out/DaemonLeasePort.out-port.js';
import type { DaemonPausePort } from '../ports/out/DaemonPausePort.out-port.js';
import type { DaemonStatusFileRead, DaemonStatusPort } from '../ports/out/DaemonStatusPort.out-port.js';
import type { ForgeMergeReadPort } from '../ports/out/ForgeMergeReadPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
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
  /** Reads back the journal entries the merge passes appended, for the projection (plan §3.1). */
  readonly journal: Pick<LaneRunJournalPort, 'listForKey'>;
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

/** One journal key a merge pass reported as journalled, with the queue entry it acts on. */
interface JournalledKey {
  readonly key: string;
  readonly entryId: string;
}

/** True when the value is a plain non-null object (not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRepositorySegment(value: unknown): value is string {
  return typeof value === 'string' && REPOSITORY_SEGMENT_PATTERN.test(value) && value !== '.' && value !== '..';
}

/** A repository the registry may serve: valid owner, repo, digest, project id and the policy's required fields. */
function isUsableRepository(value: unknown): value is DaemonRepositoryRef {
  if (!isRecord(value)) {
    return false;
  }
  const policy = value.policy;
  return (
    isRepositorySegment(value.owner) &&
    isRepositorySegment(value.repo) &&
    typeof value.repoDigest === 'string' &&
    DAEMON_REPO_DIGEST_PATTERN.test(value.repoDigest) &&
    typeof value.projectId === 'string' &&
    value.projectId.length > 0 &&
    isRecord(policy) &&
    typeof policy.policyRevision === 'string' &&
    policy.policyRevision.length > 0 &&
    typeof policy.updateBranch === 'boolean' &&
    isRecord(policy.veto) &&
    (MERGE_VETO_MODES as readonly unknown[]).includes(policy.veto.mode)
  );
}

/** A job reason code the status record accepts: journal-shaped and free of secret shapes. */
function isSafeReasonCode(value: unknown): value is string {
  return typeof value === 'string' && LANE_RUN_JOURNAL_REASON_CODE_PATTERN.test(value) && !containsSecretShape(value);
}

/**
 * Any job's outcome → an outcome the status record and the projection accept.
 * A malformed outcome is `refused: job-failed`; a bad reason code is replaced.
 */
function normalizeJobOutcome(outcome: unknown): DaemonJobOutcome {
  if (!isRecord(outcome)) {
    return { outcome: 'refused', reasonCode: 'job-failed' };
  }
  const reasonCode = outcome.reasonCode;
  switch (outcome.outcome) {
    case 'completed':
      return isSafeReasonCode(reasonCode)
        ? { outcome: 'completed', progressed: outcome.progressed === true, reasonCode }
        : { outcome: 'completed', progressed: outcome.progressed === true };
    case 'budget-exhausted':
      return { outcome: 'budget-exhausted', progressed: outcome.progressed === true };
    case 'skipped':
      return { outcome: 'skipped', reasonCode: isSafeReasonCode(reasonCode) ? reasonCode : 'job-skipped' };
    case 'refused':
      return { outcome: 'refused', reasonCode: isSafeReasonCode(reasonCode) ? reasonCode : 'job-failed' };
    default:
      return { outcome: 'refused', reasonCode: 'job-failed' };
  }
}

/** The port lease record → the domain lease record: only the three domain fields. */
function toLaneRunLease(lease: DaemonLeaseRecord | null): LaneRunLeaseRecord | null {
  return lease === null
    ? null
    : { holderId: lease.holderId, fence: lease.fence, leaseUntilIso: lease.leaseUntilIso };
}

/** DT9a's pass result → the DaemonJobOutcome the tick records; a malformed result is refused. */
function toDaemonJobOutcome(result: RunMergePassResult): DaemonJobOutcome {
  if (!isRecord(result)) {
    return { outcome: 'refused', reasonCode: 'merge-pass-malformed' };
  }
  const entries = Array.isArray(result.entries) ? result.entries : [];
  if (result.outcome === 'completed') {
    return { outcome: 'completed', progressed: entries.length > 0 };
  }
  if (result.outcome === 'budget-exhausted') {
    return { outcome: 'budget-exhausted', progressed: false };
  }
  if (result.outcome === 'refused') {
    return {
      outcome: 'refused',
      reasonCode: isSafeReasonCode(result.reasonCode) ? result.reasonCode : 'merge-pass-refused',
    };
  }
  return { outcome: 'refused', reasonCode: 'merge-pass-malformed' };
}

/** The journal keys a pass result reports as journalled; malformed reports are ignored. */
function journalledKeys(result: RunMergePassResult): readonly JournalledKey[] {
  if (!isRecord(result) || !Array.isArray(result.entries)) {
    return [];
  }
  const keys: JournalledKey[] = [];
  for (const report of result.entries as readonly unknown[]) {
    if (
      isRecord(report) &&
      report.decision === 'journalled' &&
      typeof report.journalKey === 'string' &&
      typeof report.entryId === 'string'
    ) {
      keys.push({ key: report.journalKey, entryId: report.entryId });
    }
  }
  return keys;
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

/** A read pause marker, or `unreadable` (which pauses: fail closed) for a malformed answer. */
function normalizePause(value: unknown): DaemonPauseState {
  if (isRecord(value) && (value.state === 'clear' || value.state === 'paused')) {
    return value as unknown as DaemonPauseState;
  }
  return { state: 'unreadable' };
}

/** A read halt marker, or `unreadable` (which halts: fail closed) for a malformed answer. */
function normalizeHalt(value: unknown): ConductorHaltState {
  if (isRecord(value) && (value.state === 'clear' || value.state === 'halted')) {
    return value as unknown as ConductorHaltState;
  }
  return { state: 'unreadable' };
}

/**
 * True when a journal entry is an intent or a result recorded strictly after
 * `sinceIso`, the job's start read before its lease was taken. Strictly after,
 * so an entry stamped in the same millisecond as the start (necessarily
 * written before this pass began) is never attributed to this tick; the
 * worst case is one line of this pass left out, which the projection's
 * regeneration from the journal restores (plan §3.1).
 */
function appendedAfter(entry: unknown, sinceIso: string): boolean {
  return (
    isRecord(entry) &&
    (entry.kind === 'intent' || entry.kind === 'result') &&
    typeof entry.recordedAtIso === 'string' &&
    Date.parse(entry.recordedAtIso) > Date.parse(sinceIso)
  );
}

/** True when the port's acquired lease is exactly the one the domain decided: same scope, holder and fence. */
function isExpectedLease(actual: unknown, expected: DaemonLeaseRecord): boolean {
  return (
    isRecord(actual) &&
    actual.scope === expected.scope &&
    actual.holderId === expected.holderId &&
    actual.fence === expected.fence
  );
}

/** One merge-pass job instance: wraps the merge pass for one repository. */
class MergePassJob implements DaemonJobPort {
  private reported: readonly JournalledKey[] = [];

  constructor(
    private readonly repository: DaemonRepositoryRef,
    private readonly mergePass: RunMergePassPort,
    readonly jobId: string,
    readonly leaseScope: string,
  ) {}

  /** The journal keys the last pass reported as journalled; [] before a pass. */
  get journalled(): readonly JournalledKey[] {
    return this.reported;
  }

  async pass(request: DaemonJobPassRequest): Promise<DaemonJobOutcome> {
    this.reported = [];
    const result = await this.mergePass.runMergePass({
      repository: { owner: this.repository.owner, repo: this.repository.repo },
      repoDigest: this.repository.repoDigest,
      projectId: this.repository.projectId,
      policy: this.repository.policy,
      deadlineIso: request.deadlineIso,
    });
    this.reported = journalledKeys(result);
    return toDaemonJobOutcome(result);
  }
}

/** The registry that expands the configured repositories into one merge-pass job instance each. */
export class DaemonJobRegistry {
  constructor(private readonly deps: DaemonJobRegistryDependencies) {}

  /** One merge-pass job instance per valid repository, in request order; a repeated digest keeps the first. */
  instances(repositories: readonly DaemonRepositoryRef[]): readonly DaemonJobPort[] {
    const instances: DaemonJobPort[] = [];
    const seen = new Set<string>();
    for (const repository of repositories) {
      if (!isUsableRepository(repository) || seen.has(repository.repoDigest)) {
        continue;
      }
      const parsed = parseDaemonJobId(mergePassJobId(repository.repoDigest));
      if (parsed === null || parsed.kind !== 'merge-pass') {
        continue;
      }
      seen.add(repository.repoDigest);
      instances.push(new MergePassJob(repository, this.deps.mergePass, parsed.jobId, parsed.leaseScope));
    }
    return instances;
  }
}

/** The request after validation: every field the tick reads, in its checked form. */
interface ValidTickRequest {
  readonly tickId: string;
  readonly repositories: readonly DaemonRepositoryRef[];
  readonly budgetSeconds: number;
  readonly jobFilter: readonly string[] | undefined;
  readonly forgeReachable: boolean;
}

type TickRequestCheck =
  | { readonly ok: true; readonly request: ValidTickRequest }
  | { readonly ok: false; readonly tickId: string; readonly reasonCode: string };

function checkRepositories(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return 'invalid-repositories';
  }
  const digests = new Set<string>();
  const names = new Set<string>();
  for (const repository of value as readonly unknown[]) {
    if (!isUsableRepository(repository)) {
      return 'invalid-repository';
    }
    const name = `${repository.owner}/${repository.repo}`.toLowerCase();
    if (digests.has(repository.repoDigest) || names.has(name)) {
      return 'duplicate-repository';
    }
    digests.add(repository.repoDigest);
    names.add(name);
  }
  return null;
}

function isValidBudgetSeconds(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= DAEMON_MAX_BUDGET_SECONDS
  );
}

function isValidJobFilter(value: unknown): value is readonly string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

/** Validates the whole runtime request; the first failing field names the refusal. */
function checkTickRequest(raw: unknown): TickRequestCheck {
  if (!isRecord(raw)) {
    return { ok: false, tickId: '', reasonCode: 'invalid-request' };
  }
  const tickId = typeof raw.tickId === 'string' ? raw.tickId : '';
  const refuse = (reasonCode: string): TickRequestCheck => ({ ok: false, tickId, reasonCode });
  if (!DAEMON_TICK_ID_PATTERN.test(tickId)) {
    return refuse('invalid-tick-id');
  }
  const budgetSeconds = raw.budgetSeconds ?? DAEMON_DEFAULT_BUDGET_SECONDS;
  if (!isValidBudgetSeconds(budgetSeconds)) {
    return refuse('invalid-budget');
  }
  const repositoryProblem = checkRepositories(raw.repositories);
  if (repositoryProblem !== null) {
    return refuse(repositoryProblem);
  }
  if (!isValidJobFilter(raw.jobFilter)) {
    return refuse('invalid-job-filter');
  }
  if (typeof raw.forgeReachable !== 'boolean') {
    return refuse('forge-probe-missing');
  }
  return {
    ok: true,
    request: {
      tickId,
      repositories: raw.repositories as readonly DaemonRepositoryRef[],
      budgetSeconds,
      jobFilter: raw.jobFilter,
      forgeReachable: raw.forgeReachable,
    },
  };
}

/** One planned job run: the outcome plus the timing, lease and journal facts the records need. */
interface JobRun {
  readonly jobId: string;
  readonly digest: string | null;
  readonly outcome: DaemonJobOutcome;
  readonly leaseFence: number | null;
  readonly startedAtIso: string;
  readonly finishedAtIso: string;
  readonly journalled: readonly JournalledKey[];
}

/** The merge queue as read once after the jobs; `readable` false carries the previous numbers. */
interface QueueView {
  readonly readable: boolean;
  readonly entries: readonly MergeQueueEntryRecord[];
}

/** The per-tick state every step shares. */
interface TickContext {
  readonly request: ValidTickRequest;
  readonly nowIso: string;
  readonly deadlineIso: string;
  readonly previousStatus: DaemonStatusRecord | null;
  /** The tick clock after the start: a throwing or malformed reading falls back to the last good one. */
  readonly clock: () => string;
}

export class RunDaemonTickUseCase implements RunDaemonTickPort {
  constructor(private readonly deps: RunDaemonTickDependencies) {}

  /**
   * The never-throws contract: malformed input and failing ports become typed
   * refusals inside the steps; this guard is the last resort for anything else.
   */
  async runTick(request: RunDaemonTickRequest): Promise<RunDaemonTickResult> {
    try {
      return await this.runTickInner(request);
    } catch {
      return refused(safeTickId(request), 'tick-failed');
    }
  }

  private async runTickInner(raw: RunDaemonTickRequest): Promise<RunDaemonTickResult> {
    const checked = checkTickRequest(raw);
    if (!checked.ok) {
      return refused(checked.tickId, checked.reasonCode);
    }
    const request = checked.request;
    const nowIso = this.readClock();
    const deadlineIso = nowIso === null ? null : computeTickDeadlineIso(nowIso, request.budgetSeconds);
    if (nowIso === null || deadlineIso === null) {
      return refused(request.tickId, 'invalid-clock');
    }

    const previous = await this.readPreviousStatus();
    if (previous === 'unreadable') {
      return refused(request.tickId, 'status-unreadable');
    }
    const ctx: TickContext = {
      request,
      nowIso,
      deadlineIso,
      previousStatus: previous,
      clock: this.tickClock(nowIso),
    };

    const jobs = new DaemonJobRegistry({ mergePass: this.deps.mergePass }).instances(request.repositories);
    const plan = await this.plan(ctx, jobs);
    if (plan.settleDelayMs > 0) {
      await (this.deps.sleep ?? defaultSleep)(plan.settleDelayMs);
    }
    if (plan.paused) {
      return this.finishPaused(ctx, plan);
    }

    const runs = await this.runPlannedJobs(ctx, plan.entries, jobs);
    const queue = await this.readQueue(ctx);
    const jobRecords = this.jobRecords(runs, queue, ctx.previousStatus);
    const finishedAtIso = ctx.clock();
    const written = await this.writeStatus({
      tickId: request.tickId,
      startedAtIso: nowIso,
      finishedAtIso,
      paused: false,
      halted: plan.halted,
      forgeReachable: plan.forgeReachable,
      jobs: jobRecords,
      repositories: this.repositoryRecords(jobs, runs, queue, ctx.previousStatus),
      notifierCursor: ctx.previousStatus?.notifierCursor ?? null,
    });
    if (written === null) {
      return refused(request.tickId, 'status-write-failed');
    }

    await this.project(ctx, runs, finishedAtIso);
    return {
      outcome: 'completed',
      exitCode: tickExitCodeForJobs(jobRecords),
      tickId: request.tickId,
      status: written,
      jobs: jobRecords,
    };
  }

  /** The markers and the forge verdict → the domain plan. Forge-touching jobs run only on a passing probe and a configured transport. */
  private async plan(ctx: TickContext, jobs: readonly DaemonJobPort[]): Promise<DaemonTickPlan> {
    const pause = await this.readPause();
    const halt = await this.readHalt();
    const forgeReachable = ctx.request.forgeReachable && this.forgeConfigured();
    return planDaemonTick({
      candidates: jobs.map((job) => job.jobId),
      previousStatus: ctx.previousStatus,
      pause,
      halt,
      forgeReachable,
      nowIso: ctx.nowIso,
      jobFilter: ctx.request.jobFilter,
    });
  }

  /** A paused tick writes a paused status carrying the previous repositories and runs nothing. */
  private async finishPaused(ctx: TickContext, plan: DaemonTickPlan): Promise<RunDaemonTickResult> {
    const written = await this.writeStatus({
      tickId: ctx.request.tickId,
      startedAtIso: ctx.nowIso,
      finishedAtIso: ctx.clock(),
      paused: true,
      halted: plan.halted,
      forgeReachable: null,
      jobs: [],
      repositories: ctx.previousStatus?.repositories ?? [],
      notifierCursor: ctx.previousStatus?.notifierCursor ?? null,
    });
    if (written === null) {
      return refused(ctx.request.tickId, 'status-write-failed');
    }
    return { outcome: 'completed', exitCode: 0, tickId: ctx.request.tickId, status: written, jobs: [] };
  }

  /** The tick clock's first reading; null for a throwing or malformed clock. */
  private readClock(): string | null {
    try {
      const value = this.deps.now?.() ?? new Date().toISOString();
      return isZonedIsoDateTime(value) ? value : null;
    } catch {
      return null;
    }
  }

  /** Later readings: a throwing or malformed clock keeps the last good reading, so every stamp stays valid. */
  private tickClock(startIso: string): () => string {
    let last = startIso;
    return () => {
      const value = this.readClock();
      if (value !== null) {
        last = value;
      }
      return last;
    };
  }

  /** The previous status, null when known absent, `unreadable` for an unreadable, malformed or failing store. */
  private async readPreviousStatus(): Promise<DaemonStatusRecord | null | 'unreadable'> {
    let read: DaemonStatusFileRead;
    try {
      read = await this.deps.status.read();
    } catch {
      return 'unreadable';
    }
    if (isRecord(read) && read.status === 'missing') {
      return null;
    }
    if (isRecord(read) && read.status === 'ok' && isRecord(read.record)) {
      return read.record;
    }
    return 'unreadable';
  }

  private async readPause(): Promise<DaemonPauseState> {
    try {
      return normalizePause(await this.deps.pause.read());
    } catch {
      return { state: 'unreadable' };
    }
  }

  private async readHalt(): Promise<ConductorHaltState> {
    try {
      return normalizeHalt(await this.deps.halt.read());
    } catch {
      return { state: 'unreadable' };
    }
  }

  private forgeConfigured(): boolean {
    try {
      return this.deps.forge.isConfigured() === true;
    } catch {
      return false;
    }
  }

  /** The status write; null when the store refuses, answers malformed or fails. */
  private async writeStatus(input: BuildDaemonStatusInput): Promise<DaemonStatusRecord | null> {
    let written: DaemonStatusRead;
    try {
      written = await this.deps.status.write(input);
    } catch {
      return null;
    }
    return isRecord(written) && written.ok === true && isRecord(written.record) ? written.record : null;
  }

  /** Every planned entry in order: a forge skip is recorded without a lease; a run goes through runOneJob. */
  private async runPlannedJobs(
    ctx: TickContext,
    entries: readonly DaemonPlannedJobEntry[],
    jobs: readonly DaemonJobPort[],
  ): Promise<JobRun[]> {
    const jobById = new Map<string, DaemonJobPort>(jobs.map((job) => [job.jobId, job]));
    const runs: JobRun[] = [];
    for (const entry of entries) {
      const job = jobById.get(entry.job.jobId);
      if (entry.action === 'skip' || job === undefined) {
        const at = ctx.clock();
        const outcome: DaemonJobOutcome =
          entry.action === 'skip' ? entry.outcome : { outcome: 'refused', reasonCode: 'job-failed' };
        runs.push(this.run(entry.job, outcome, null, at, at));
        continue;
      }
      runs.push(await this.runOneJob(ctx, job, entry.job));
    }
    return runs;
  }

  private run(
    parsed: ParsedDaemonJobId,
    outcome: DaemonJobOutcome,
    leaseFence: number | null,
    startedAtIso: string,
    finishedAtIso: string,
    journalled: readonly JournalledKey[] = [],
  ): JobRun {
    return {
      jobId: parsed.jobId,
      digest: parsed.kind === 'merge-pass' ? parsed.repoDigest : null,
      outcome,
      leaseFence,
      startedAtIso,
      finishedAtIso,
      journalled,
    };
  }

  /** One job run: budget guard, lease CAS, the pass under the deadline, release. */
  private async runOneJob(ctx: TickContext, job: DaemonJobPort, parsed: ParsedDaemonJobId): Promise<JobRun> {
    const startedAtIso = ctx.clock();
    if (!this.hasBudget(ctx, startedAtIso)) {
      return this.run(parsed, { outcome: 'budget-exhausted', progressed: false }, null, startedAtIso, ctx.clock());
    }
    const taken = await this.takeLease(ctx, job.leaseScope, startedAtIso);
    if (!taken.ok) {
      return this.run(parsed, taken.outcome, null, startedAtIso, ctx.clock());
    }

    let outcome: DaemonJobOutcome;
    try {
      outcome = normalizeJobOutcome(await job.pass({ nowIso: startedAtIso, deadlineIso: ctx.deadlineIso }));
    } catch {
      outcome = { outcome: 'refused', reasonCode: 'job-failed' };
    }
    const released = await this.releaseLease(ctx, job.leaseScope, taken.fence);
    if (!released && outcome.outcome !== 'refused') {
      // The pass ran but its lease may still be held (or had lapsed): surface it.
      outcome = { outcome: 'refused', reasonCode: 'lease-release-failed' };
    }
    const journalled = job instanceof MergePassJob ? job.journalled : [];
    return this.run(parsed, outcome, taken.fence, startedAtIso, ctx.clock(), journalled);
  }

  /** D-DT9: a call whose remaining time is under 2 s is not started. */
  private hasBudget(ctx: TickContext, nowIso: string): boolean {
    return computeCallBudget({
      nowIso,
      deadlineIso: ctx.deadlineIso,
      normalTimeoutMs: DAEMON_CALL_MIN_REMAINING_MS,
    }).allowed;
  }

  /** The lease CAS: the domain decides, the port writes; a failing port refuses the job. */
  private async takeLease(
    ctx: TickContext,
    scope: string,
    startedAtIso: string,
  ): Promise<{ readonly ok: true; readonly fence: number } | { readonly ok: false; readonly outcome: DaemonJobOutcome }> {
    const leaseUntilIso = new Date(
      Date.parse(startedAtIso) + Math.min(LANE_RUN_LEASE_MAX_MS, (ctx.request.budgetSeconds + 10) * 1000),
    ).toISOString();
    const unreadable = { ok: false, outcome: { outcome: 'refused', reasonCode: 'lease-unreadable' } } as const;
    let current: DaemonLeaseRecord | null;
    try {
      current = await this.deps.lease.read(scope);
    } catch {
      return unreadable;
    }
    if (current !== null && !isRecord(current)) {
      return unreadable;
    }
    const acquireRequest = {
      holderId: ctx.request.tickId,
      observedFence: current?.fence ?? 0,
      leaseUntilIso,
      nowIso: startedAtIso,
    };
    const decision = decideDaemonJobLease(toLaneRunLease(current), acquireRequest, scope);
    if (decision.action !== 'acquired') {
      return { ok: false, outcome: decision.outcome };
    }
    let acquired: DaemonLeaseResult;
    try {
      acquired = await this.deps.lease.acquire({ scope, ...acquireRequest });
    } catch {
      // The write may have landed before the failure: release the fence the domain expected.
      await this.releaseLease(ctx, scope, decision.lease.fence);
      return unreadable;
    }
    if (isRecord(acquired) && acquired.outcome === 'ok') {
      if (isExpectedLease(acquired.lease, decision.lease)) {
        return { ok: true, fence: decision.lease.fence };
      }
      // A success that is not exactly the lease the domain decided: it may still be held, so release the expected fence.
      await this.releaseLease(ctx, scope, decision.lease.fence);
      return unreadable;
    }
    if (!isRecord(acquired) || acquired.outcome !== 'refused') {
      await this.releaseLease(ctx, scope, decision.lease.fence);
      return unreadable;
    }
    if (acquired.reason === 'lease-held' || acquired.reason === 'lease-moved') {
      return { ok: false, outcome: { outcome: 'skipped', reasonCode: acquired.reason } };
    }
    return { ok: false, outcome: { outcome: 'refused', reasonCode: 'invalid-lease-request' } };
  }

  /**
   * The release always runs, whatever the budget: it is the tick's own
   * bookkeeping and a lease left behind would block the next tick. False when
   * the port refuses or fails.
   */
  private async releaseLease(ctx: TickContext, scope: string, fence: number): Promise<boolean> {
    try {
      const released = await this.deps.lease.release({
        scope,
        holderId: ctx.request.tickId,
        fence,
        nowIso: ctx.clock(),
      });
      return isRecord(released) && released.outcome === 'ok';
    } catch {
      return false;
    }
  }

  /** The merge queue, read once under the budget; a failed or unbudgeted read carries the previous numbers. */
  private async readQueue(ctx: TickContext): Promise<QueueView> {
    if (!this.hasBudget(ctx, ctx.clock())) {
      return { readable: false, entries: [] };
    }
    try {
      const entries = await this.deps.queue.listMergeEntries({ deadlineIso: ctx.deadlineIso });
      return Array.isArray(entries) ? { readable: true, entries } : { readable: false, entries: [] };
    } catch {
      return { readable: false, entries: [] };
    }
  }

  /**
   * The projection: per run, the journal entries its pass appended during the
   * tick, then its job outcome. Never fails the tick; the projection is
   * regenerable from the journal (plan §3.1).
   */
  private async project(ctx: TickContext, runs: readonly JobRun[], finishedAtIso: string): Promise<void> {
    try {
      const records: DaemonEventRecord[] = [];
      for (const run of runs) {
        records.push(...(await this.journalEvents(ctx, run)));
        const event = projectJobOutcomeToDaemonEvent({
          eventId: this.deps.newUlid(),
          tickId: ctx.request.tickId,
          jobId: run.jobId,
          jobOutcome: run.outcome,
          recordedAtIso: finishedAtIso,
        });
        if (event.ok) {
          records.push(event.record);
        }
      }
      if (records.length > 0) {
        await this.deps.events.append(records);
      }
    } catch {
      // a projection failure never fails the tick
    }
  }

  /** One run's journal intent/result lines, each key read once under the budget. */
  private async journalEvents(ctx: TickContext, run: JobRun): Promise<DaemonEventRecord[]> {
    const records: DaemonEventRecord[] = [];
    const seen = new Set<string>();
    for (const journalled of run.journalled) {
      if (seen.has(journalled.key)) {
        continue;
      }
      seen.add(journalled.key);
      if (!this.hasBudget(ctx, ctx.clock())) {
        break;
      }
      let entries: readonly unknown[];
      try {
        entries = await this.deps.journal.listForKey(journalled.key);
      } catch {
        continue;
      }
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (!appendedAfter(entry, run.startedAtIso)) {
          continue;
        }
        const event = projectJournalEntryToDaemonEvent({
          eventId: this.deps.newUlid(),
          tickId: ctx.request.tickId,
          jobId: run.jobId,
          journalEntry: entry as Parameters<typeof projectJournalEntryToDaemonEvent>[0]['journalEntry'],
          queueEntryId: journalled.entryId,
        });
        if (event.ok) {
          records.push(event.record);
        }
      }
    }
    return records;
  }

  /** One DaemonJobStatusRecord per run, in the order the jobs ran. */
  private jobRecords(
    runs: readonly JobRun[],
    queue: QueueView,
    previousStatus: DaemonStatusRecord | null,
  ): DaemonJobStatusRecord[] {
    return runs.map((run) => {
      const previousJob = previousStatus?.jobs.find((record) => record.jobId === run.jobId);
      let nextNotBeforeIso: string | null;
      if (!queue.readable) {
        nextNotBeforeIso = previousJob?.nextNotBeforeIso ?? null;
      } else {
        nextNotBeforeIso = run.digest === null ? null : earliestNotBeforeIso(queue.entries, run.digest);
      }
      const durationMs = Date.parse(run.finishedAtIso) - Date.parse(run.startedAtIso);
      return {
        jobId: run.jobId,
        outcome: run.outcome.outcome,
        reasonCode: 'reasonCode' in run.outcome ? run.outcome.reasonCode ?? null : null,
        leaseFence: run.leaseFence,
        durationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0,
        nextNotBeforeIso,
        consecutiveBudgetExhausted: nextConsecutiveBudgetExhausted(
          previousJob?.consecutiveBudgetExhausted ?? 0,
          run.outcome.outcome,
        ),
      };
    });
  }

  /**
   * One DaemonRepositoryStatusRecord per registry instance, in the registry's
   * order, whether or not the job filter ran it: a job that did not run keeps
   * its previous `lastServedAtIso`.
   */
  private repositoryRecords(
    jobs: readonly DaemonJobPort[],
    runs: readonly JobRun[],
    queue: QueueView,
    previousStatus: DaemonStatusRecord | null,
  ): DaemonRepositoryStatusRecord[] {
    const records: DaemonRepositoryStatusRecord[] = [];
    for (const instance of jobs) {
      const parsed = parseDaemonJobId(instance.jobId);
      if (parsed === null || parsed.kind !== 'merge-pass') {
        continue;
      }
      const run = runs.find((candidate) => candidate.jobId === instance.jobId);
      const passRanAtIso = run === undefined || run.outcome.outcome === 'skipped' ? null : run.startedAtIso;
      const digest = parsed.repoDigest;
      const previousRepository = previousStatus?.repositories.find((record) => record.repoDigest === digest);
      records.push({
        repoDigest: digest,
        lastServedAtIso: resolveRepoLastServedAtIso(previousRepository?.lastServedAtIso ?? null, passRanAtIso),
        ...queueNumbers(queue, digest, previousRepository),
      });
    }
    return records;
  }
}

/** The queue numbers of one repository, or the previous record's when the queue was not read. */
function queueNumbers(
  queue: QueueView,
  digest: string,
  previous: DaemonRepositoryStatusRecord | undefined,
): Omit<DaemonRepositoryStatusRecord, 'repoDigest' | 'lastServedAtIso'> {
  if (!queue.readable) {
    return {
      queued: previous?.queued ?? 0,
      ready: previous?.ready ?? 0,
      parked: previous?.parked ?? 0,
      headEntryId: previous?.headEntryId ?? null,
      lastMergedHead12: previous?.lastMergedHead12 ?? null,
    };
  }
  const live = orderMergeQueue(queue.entries, digest);
  return {
    queued: live.length,
    ready: live.filter((entry) => entry.state === 'ready').length,
    parked: live.filter((entry) => entry.state === 'parked').length,
    headEntryId: findMergeQueueHead(queue.entries, digest)?.entryId ?? null,
    lastMergedHead12: lastMergedHead12(queue.entries, digest),
  };
}

/** The request's tick id for a last-resort refusal; '' when it is absent, not a string or its read throws. */
function safeTickId(request: unknown): string {
  try {
    return isRecord(request) && typeof request.tickId === 'string' ? request.tickId : '';
  } catch {
    return '';
  }
}

function refused(tickId: string, reasonCode: string): RunDaemonTickResult {
  return { outcome: 'refused', exitCode: 1, tickId, status: null, jobs: [], reasonCode };
}
