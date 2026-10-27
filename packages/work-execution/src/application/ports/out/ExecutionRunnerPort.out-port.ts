// @generated outbound contract scaffold — refined for migration step 1.
/**
 * ExecutionRunnerPort: start, inspect and stop a matching attempt/session with
 * explicit capabilities and strict per-lane directory isolation. The first
 * adapter is OpenCode through `ocm-run` on the attempt's port; it is not
 * implemented in this step.
 */

import type {
  AttemptRunnerRecord,
  AttemptSeatOverrideRecord,
  CommandCompletionReceipt,
} from '../../../domain/execution-records.js';
import type { StopReasonValue } from '../../../domain/value-objects/StopReason.vo.js';

/**
 * Isolation capabilities a runner must declare before an attempt may be
 * dispatched to it. The attempt's requirements must fit this profile;
 * Kubernetes objects and other vendor types stay out of this contract.
 *
 * `filesystemScope: "unknown"` reports an undeclared runner (D4): dispatch
 * refuses it and no flag can waive the refusal. `source` reports how the
 * capability profile was established (D4): `declared` for a v2 declaration,
 * `legacy-asserted` for the v1 and env-only mapping, `undeclared` when the
 * runner carries no declaration. It is optional so records and tests that
 * predate D4 keep their meaning.
 */
export interface RunnerIsolationCapabilities {
  readonly filesystemScope: 'scoped-worktree' | 'inherited-directory' | 'unknown';
  readonly networkEgressRestricted: boolean;
  readonly cpuAndMemoryLimited: boolean;
  readonly processTreeTermination: boolean;
  readonly authoritativeCompletion: boolean;
  readonly artifactPersistence: boolean;
  readonly source?: 'declared' | 'undeclared' | 'legacy-asserted';
}

export type RunnerReachability = 'reachable' | 'unreachable' | 'unknown';

export type WorkspacePreparationState =
  | 'unprepared'
  | 'preparing'
  | 'prepared'
  | 'failed';

export type WorkerCommandPhase = 'not-started' | 'active' | 'ended';

/**
 * Runner states reported separately. They must not collapse into one
 * "running" flag.
 */
export interface RunnerSessionStatus {
  readonly runnerReachable: RunnerReachability;
  readonly workspacePreparation: WorkspacePreparationState;
  readonly workerCommand: WorkerCommandPhase;
  readonly completionReceipt: CommandCompletionReceipt | null;
  readonly artifactsCollected: boolean;
}

export interface StartRunnerSessionRequest {
  readonly attemptId: string;
  readonly worktreePath: string;
  readonly briefPackagePath: string;
  readonly baseCommit: string;
  readonly stepLimit: number;
  readonly timeLimitSeconds: number;
  readonly requiredCapabilities: RunnerIsolationCapabilities;
  readonly agent?: string;
  readonly model?: string;
  readonly variant?: string;
  readonly seatOverride?: AttemptSeatOverrideRecord;
  readonly modelAssignment?: {
    readonly model: string;
    readonly variant?: string;
    readonly fallbackModel?: string;
    readonly agent?: string;
  };
}

/**
 * Dispatch outcomes: a session id proves the start only when the runner
 * confirmed it. `unknown` retains the reservation and enters reconciliation;
 * it is never retried blindly and never releases capacity.
 */
export type StartRunnerSessionResult =
  | {
      readonly outcome: 'started';
      readonly sessionId: string;
      readonly runner?: AttemptRunnerRecord;
    }
  | {
      readonly outcome: 'refused';
      readonly reason: string;
      /** Optional typed class (S1); when absent the use case classifies `reason`. */
      readonly reasonClass?: StopReasonValue;
    }
  | { readonly outcome: 'unknown'; readonly reason: string }
  /**
   * The start created nothing, a session may be live in the worktree, so the
   * reservation is kept and the attempt is resolved by reconcile or stop.
   */
  | {
      readonly outcome: 'blocked';
      readonly reason: string;
      readonly runner?: AttemptRunnerRecord;
    };

export interface RunnerSessionRef {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly worktreePath?: string;
  readonly runner?: AttemptRunnerRecord | null;
}

export interface StopRunnerSessionRequest {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly gracePeriodSeconds: number;
  readonly worktreePath?: string;
  readonly runner?: AttemptRunnerRecord | null;
}

/**
 * Stop sequence: signal the worker process group, wait a bounded grace,
 * escalate, confirm termination, then release capacity. Capacity is released
 * only on a confirmed `terminated` receipt.
 */
export type StopRunnerSessionResult =
  | { readonly outcome: 'terminated'; readonly receipt: CommandCompletionReceipt }
  | { readonly outcome: 'still-running'; readonly reason: string }
  | { readonly outcome: 'refused'; readonly reason: string }
  | { readonly outcome: 'unknown'; readonly reason: string };

/**
 * A runner command addressed to a worktree directory rather than to a
 * recorded session id: used when an attempt carries no session id but the
 * worktree may still hold a live lane (a `blocked` start).
 */
export interface WorktreeRunRef {
  readonly attemptId: string;
  readonly worktreePath: string;
  readonly runner?: AttemptRunnerRecord | null;
}

/** What runs in a worktree directory, without a session id. */
export type WorktreeRunState =
  | { readonly state: 'idle' }
  | { readonly state: 'running'; readonly sessionId: string }
  | { readonly state: 'unknown'; readonly reason: string };

/** Abort whatever runs in a worktree directory, by directory. */
export interface AbortWorktreeRunRequest extends WorktreeRunRef {
  readonly gracePeriodSeconds: number;
}

export type AbortWorktreeRunResult =
  | { readonly outcome: 'aborted'; readonly endedAtIso: string }
  | { readonly outcome: 'still-running'; readonly reason: string }
  | { readonly outcome: 'refused'; readonly reason: string }
  | { readonly outcome: 'unknown'; readonly reason: string };

export interface ExecutionRunnerPort {
  /** Capabilities this runner can actually enforce, declared before dispatch. */
  describeCapabilities(): RunnerIsolationCapabilities;

  /** Optional runner configuration details for attempt recording and port fidelity. */
  describeRunner?(): AttemptRunnerRecord | undefined;

  /** Start one prepared attempt's worker command in its scoped worktree. */
  startSession(request: StartRunnerSessionRequest): Promise<StartRunnerSessionResult>;

  /** Report the separately tracked runner states for a session. */
  inspectSession(session: RunnerSessionRef): Promise<RunnerSessionStatus>;

  /** Request cancellation and establish the session's actual end. */
  stopSession(request: StopRunnerSessionRequest): Promise<StopRunnerSessionResult>;

  /**
   * Optional: report what runs in a worktree directory, without a session id.
   * A missing method means "cannot tell".
   */
  inspectWorktreeRun?(ref: WorktreeRunRef): Promise<WorktreeRunState>;

  /**
   * Optional: abort whatever runs in a worktree directory, by directory.
   * A missing method means "cannot tell".
   */
  abortWorktreeRun?(request: AbortWorktreeRunRequest): Promise<AbortWorktreeRunResult>;
}
