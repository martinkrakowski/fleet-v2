/**
 * Shared execution records used by more than one contract. They are pure
 * domain facts, not outbound port behaviour, so they live here rather than in
 * any single port module.
 */

/**
 * Completion receipt bound to the attempt and the runner session. A runner
 * `Running` task is not evidence a lane is working or succeeded; a watcher
 * exit or a model's final message never establishes authoritative completion.
 */
export interface CommandCompletionReceipt {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly endedAtIso: string;
  readonly authoritative: boolean;
  readonly exitStatus: number | null;
  readonly stoppedByRequest: boolean;
}

export interface CollectedAttemptArtifacts {
  readonly headCommit: string;
  readonly commitsSinceBase: readonly string[];
  readonly collectedArtifactPaths: readonly string[];
  /** Missing notes are recorded explicitly; absence is a fact, not an error. */
  readonly notes: 'present' | 'missing';
}
