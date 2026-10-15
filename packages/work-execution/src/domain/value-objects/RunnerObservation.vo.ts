// @generated value-object stub — refined for migration step 1.
/**
 * RunnerObservation is an immutable value object for one point-in-time
 * observation of a runner: reachability and the worker command phase are
 * reported separately and never collapse into one "running" flag.
 */

export interface RunnerObservationProps {
  readonly observedAtIso: string;
  readonly runnerReachable: 'reachable' | 'unreachable' | 'unknown';
  readonly workerCommand: 'not-started' | 'active' | 'ended';
  readonly sessionId: string | null;
}

const REACHABILITY_VALUES: readonly unknown[] = ['reachable', 'unreachable', 'unknown'];
const WORKER_COMMAND_VALUES: readonly unknown[] = ['not-started', 'active', 'ended'];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class RunnerObservation {
  private constructor(private readonly props: RunnerObservationProps) {
    // Value is immutable after construction.
  }

  static create(props: RunnerObservationProps): {
    success: boolean;
    value?: RunnerObservation;
    error?: Error;
  } {
    if (!isNonEmptyString(props.observedAtIso)) {
      return { success: false, error: new Error('RunnerObservation requires a non-empty observedAtIso') };
    }
    if (!REACHABILITY_VALUES.includes(props.runnerReachable)) {
      return { success: false, error: new Error(`Invalid runner reachability: ${String(props.runnerReachable)}`) };
    }
    if (!WORKER_COMMAND_VALUES.includes(props.workerCommand)) {
      return { success: false, error: new Error(`Invalid worker command phase: ${String(props.workerCommand)}`) };
    }
    if (props.sessionId !== null && !isNonEmptyString(props.sessionId)) {
      return { success: false, error: new Error('RunnerObservation sessionId must be non-empty or null') };
    }
    return { success: true, value: new RunnerObservation(props) };
  }

  getObservedAtIso(): string {
    return this.props.observedAtIso;
  }

  getRunnerReachable(): 'reachable' | 'unreachable' | 'unknown' {
    return this.props.runnerReachable;
  }

  getWorkerCommand(): 'not-started' | 'active' | 'ended' {
    return this.props.workerCommand;
  }

  getSessionId(): string | null {
    return this.props.sessionId;
  }

  getProps(): RunnerObservationProps {
    return this.props;
  }

  /**
   * Only an ended worker command on a reachable runner may be treated as the
   * command's end. An unreachable runner or an active command is never ended.
   */
  isCommandEnded(): boolean {
    return this.props.runnerReachable === 'reachable' && this.props.workerCommand === 'ended';
  }

  equals(other: RunnerObservation): boolean {
    return (
      this.props.observedAtIso === other.props.observedAtIso &&
      this.props.runnerReachable === other.props.runnerReachable &&
      this.props.workerCommand === other.props.workerCommand &&
      this.props.sessionId === other.props.sessionId
    );
  }
}
