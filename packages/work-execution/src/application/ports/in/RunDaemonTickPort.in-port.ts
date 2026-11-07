// @generated inbound contract scaffold — refined for lane DT10a.
/**
 * RunDaemonTickPort: one bounded daemon tick (daemon-tick plan §3.1). The tick
 * reads the pause and halt markers, builds the deterministic job list, takes
 * each job's lease by CAS, runs it with `nowIso` and `deadlineIso`, releases
 * the lease, writes `status.json` atomically and appends the tick's
 * projection lines to `events.jsonl`.
 */
import type { MergeRepoPolicy } from '../../../domain/merge-queue-decider.js';
import type { DaemonJobStatusRecord, DaemonStatusRecord } from '../../../domain/daemon-tick.js';

/** One repository the daemon serves: one merge-pass job instance. */
export interface DaemonRepositoryRef {
  readonly owner: string;
  readonly repo: string;
  /** 12 lowercase hex of `owner/repo`; it names the job id and the lease scope. */
  readonly repoDigest: string;
  /** The evidence project id the merge pass uses for procedure receipts (DT9a). */
  readonly projectId: string;
  /** The repository's merge policy, exactly the decider's input (DT9a). */
  readonly policy: MergeRepoPolicy;
}

export interface RunDaemonTickRequest {
  /** `tick-<ulid>`, minted by the caller; it is the holder id on every lease. */
  readonly tickId: string;
  /** The repositories to serve, one job instance each. The tick orders the jobs itself; a malformed or repeated repository (same digest or same owner/repo) refuses the whole tick. */
  readonly repositories: readonly DaemonRepositoryRef[];
  /** The tick's budget in seconds (default 45). */
  readonly budgetSeconds?: number;
  /**
   * The tick's deadline (a zoned ISO date-time), when the caller already fixed
   * it before the tick started (the CLI computes one deadline at command start
   * and shares it with the forge probe). Absent: the tick computes it from its
   * own clock and `budgetSeconds`. A malformed value refuses the tick
   * (`invalid-deadline`).
   */
  readonly deadlineIso?: string;
  /** The tick interval in seconds, `1..3600` (default 60); it governs when a status counts as stale and a wake settles. */
  readonly intervalSeconds?: number;
  /** The wake settle delay in seconds, `0..600` (default 20). */
  readonly settleSeconds?: number;
  /** Only these job ids run (`--job`); absent runs every job. */
  readonly jobFilter?: readonly string[];
  /**
   * The caller's forge probe verdict (plan §3.1: `gh api rate_limit`, 10 s),
   * required: no declared port carries the probe, so the composition root runs
   * it. Forge-touching jobs run only when this is true **and** the forge
   * transport is configured; otherwise each is `skipped: forge-unreachable`.
   * A missing or non-boolean value refuses the tick (`forge-probe-missing`).
   */
  readonly forgeReachable: boolean;
}

export interface RunDaemonTickResult {
  /** `refused` when the tick could not run at all: a malformed request, a bad clock, an unreadable status store or a refused status write. Nothing is written before a refusal, except that a refused or unconfirmed status write may follow jobs that ran. */
  readonly outcome: 'completed' | 'refused';
  /** 0 completed (including every skipped job and `budget-exhausted`); 1 a refused job or an unreadable status store. */
  readonly exitCode: 0 | 1;
  readonly tickId: string;
  /**
   * The status record the tick wrote and the store confirmed, or null when it
   * refused before writing or the store gave no valid confirmation (a store
   * that throws after persisting cannot be told apart, so null is "no
   * confirmed write").
   */
  readonly status: DaemonStatusRecord | null;
  /** One record per job instance, in the order the jobs ran. */
  readonly jobs: readonly DaemonJobStatusRecord[];
  /**
   * The refusal reason when `outcome` is `refused`: `invalid-request`,
   * `invalid-tick-id`, `invalid-budget`, `invalid-repositories`,
   * `invalid-repository`, `duplicate-repository`, `invalid-job-filter`,
   * `invalid-interval`, `invalid-settle`, `invalid-deadline`, `forge-probe-missing`, `invalid-clock`, `status-unreadable`,
   * `status-write-failed`, or `tick-failed` (the last-resort guard).
   */
  readonly reasonCode?: string;
}

export interface RunDaemonTickPort {
  runTick(request: RunDaemonTickRequest): Promise<RunDaemonTickResult>;
}
