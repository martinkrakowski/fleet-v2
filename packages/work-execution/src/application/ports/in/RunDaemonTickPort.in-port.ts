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
  /** The repositories to serve. The tick orders the jobs itself. */
  readonly repositories: readonly DaemonRepositoryRef[];
  /** The tick's budget in seconds (default 45). */
  readonly budgetSeconds?: number;
  /** Only these job ids run (`--job`); absent runs every job. */
  readonly jobFilter?: readonly string[];
  /** The forge probe's verdict; absent asks the forge port. */
  readonly forgeReachable?: boolean;
}

export interface RunDaemonTickResult {
  /** `refused` when the tick could not run at all: a bad tick id, a bad clock, an unreadable status store or a refused status write. */
  readonly outcome: 'completed' | 'refused';
  /** 0 completed (including every skipped job and `budget-exhausted`); 1 a refused job or an unreadable status store. */
  readonly exitCode: 0 | 1;
  readonly tickId: string;
  /** The status record the tick wrote, or null when it refused before writing. */
  readonly status: DaemonStatusRecord | null;
  /** One record per job instance, in the order the jobs ran. */
  readonly jobs: readonly DaemonJobStatusRecord[];
  /** The refusal reason when `outcome` is `refused`. */
  readonly reasonCode?: string;
}

export interface RunDaemonTickPort {
  runTick(request: RunDaemonTickRequest): Promise<RunDaemonTickResult>;
}
