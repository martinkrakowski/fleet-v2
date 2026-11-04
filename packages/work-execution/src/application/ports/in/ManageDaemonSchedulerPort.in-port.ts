/**
 * ManageDaemonSchedulerPort: render, show, install and uninstall the
 * user-scope scheduler units that run one daemon tick at a fixed interval
 * (systemd service and timer, oneshot, no resident process). Writing the unit
 * files happens only on explicit apply; show and uninstall print keys only, and
 * enabling the timer and lingering are printed for the operator, never run
 * (CO6).
 */

export type DaemonSchedulerAction = 'install' | 'show' | 'uninstall';

/** The parsed `daemon` section facts used to render the units. */
export interface DaemonSchedulerFacts {
  readonly nodePath: string;
  readonly cliPath: string;
  readonly stateDir: string;
  readonly unitDir: string;
  readonly installationFile: string;
}

export interface ManageDaemonSchedulerRequest {
  readonly action: DaemonSchedulerAction;
  readonly apply: boolean;
  readonly daemon: DaemonSchedulerFacts;
}

/** One stdout line: the fixed unit key and its code. */
export interface ManageDaemonSchedulerUnitLine {
  readonly key: string;
  readonly code: string;
}

export interface ManageDaemonSchedulerResult {
  readonly units: readonly ManageDaemonSchedulerUnitLine[];
  /** Install-only operator hint lines; null for show and uninstall. */
  readonly operatorLines: readonly string[] | null;
}

export interface ManageDaemonSchedulerPort {
  execute(
    request: ManageDaemonSchedulerRequest,
  ): Promise<ManageDaemonSchedulerResult>;
}
