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

/**
 * Isolation capabilities a runner must declare before an attempt may be
 * dispatched to it. The attempt's requirements must fit this profile;
 * Kubernetes objects and other vendor types stay out of this contract.
 */
export interface RunnerIsolationCapabilities {
  readonly filesystemScope: 'scoped-worktree' | 'inherited-directory';
  readonly networkEgressRestricted: boolean;
  readonly cpuAndMemoryLimited: boolean;
  readonly processTreeTermination: boolean;
  readonly authoritativeCompletion: boolean;
  readonly artifactPersistence: boolean;
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
  | { readonly outcome: 'refused'; readonly reason: string }
  | { readonly outcome: 'unknown'; readonly reason: string };

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
}

/**
 * Stop sequence: signal the worker process group, wait a bounded grace,
 * escalate, confirm termination, then release capacity. Capacity is released
 * only on a confirmed `terminated` receipt.
 */
export type StopRunnerSessionResult =
  | { readonly outcome: 'terminated'; readonly receipt: CommandCompletionReceipt }
  | { readonly outcome: 'still-running'; readonly reason: string }
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
}
