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
  /**
   * OD7a1: present only when `daemon.shadow` is set and valid. The values come
   * from `resolveMergePolicy`'s one shadow repository and the parsed
   * `daemon.shadow`; `grantId` is deliberately not part of the facts and is
   * never baked into a unit.
   */
  readonly shadow?: {
    readonly repository: string;
    readonly legacyStateDir: string;
    readonly projectId: string;
  };
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
  /**
   * OD7a1: present only when the shadow config carried in the facts was
   * refused by `readShadowSchedulerConfig`; no unit is rendered or touched.
   */
  readonly refusal?: 'invalid-shadow-config';
  /**
   * OD7a1 fix round 2: present only on an applied uninstall whose rendered
   * facts carried no shadow intake while the port still removed the intake
   * pair and one of its removals was `unreadable`. The two main lines stay
   * exactly as they are; the CLI reports the code and exits 1.
   */
  readonly intakeUnreadable?: boolean;
}

export interface ManageDaemonSchedulerPort {
  execute(
    request: ManageDaemonSchedulerRequest,
  ): Promise<ManageDaemonSchedulerResult>;
}
