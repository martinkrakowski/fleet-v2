/**
 * ManageDaemonSchedulerUseCase: render the daemon tick's user-scope scheduler
 * units (systemd service and timer) and, per action, read, write or remove the
 * pair through the scheduler port (CO6). The port only ever returns codes; the
 * use case maps them to the CLI's codes and supplies the install-only operator
 * enable/linger hint lines. It renders no command, starts no process and never
 * enables a unit.
 */

import {
  DAEMON_SERVICE_UNIT_KEY,
  DAEMON_TIMER_UNIT_KEY,
} from '../ports/out/DaemonSchedulerPort.out-port.js';
import type { DaemonSchedulerPort } from '../ports/out/DaemonSchedulerPort.out-port.js';
import type {
  ManageDaemonSchedulerPort,
  ManageDaemonSchedulerRequest,
  ManageDaemonSchedulerResult,
} from '../ports/in/ManageDaemonSchedulerPort.in-port.js';

export const DAEMON_SERVICE_TEMPLATE = `[Unit]
Description=Fleet v2 daemon tick

[Service]
Type=oneshot
ExecStart={{nodePath}} {{cliPath}} --state-dir {{stateDir}} daemon tick
Environment=FLEET_STATE_DIR={{stateDir}}
Environment=FLEET_INSTALLATION_FILE={{installationFile}}
Nice=5
`;

export const DAEMON_TIMER_TEMPLATE = `[Unit]
Description=Fleet v2 daemon tick timer

[Timer]
Unit=fleet-v2-daemon.service
OnBootSec=60s
OnUnitActiveSec=60s
AccuracySec=1s
Persistent=true

[Install]
WantedBy=timers.target
`;

export interface RenderedDaemonUnits {
  readonly service: string;
  readonly timer: string;
}

/** Substitute the five placeholders of the validated `daemon` section. */
export function renderDaemonUnits(
  facts: ManageDaemonSchedulerRequest['daemon'],
): RenderedDaemonUnits {
  // Function replacements keep the facts literal: string replacements would
  // run `GetSubstitution`, turning `$$` into `$` and `$&` into the matched
  // placeholder text.
  const service = DAEMON_SERVICE_TEMPLATE
    .replaceAll('{{nodePath}}', () => facts.nodePath)
    .replaceAll('{{cliPath}}', () => facts.cliPath)
    .replaceAll('{{stateDir}}', () => facts.stateDir)
    .replaceAll('{{installationFile}}', () => facts.installationFile);
  return { service, timer: DAEMON_TIMER_TEMPLATE };
}

const INSTALL_OPERATOR_LINES: readonly string[] = [
  'enable: systemctl --user enable fleet-v2-daemon.timer',
  'linger: loginctl enable-linger',
];

/** Install without `--apply`: only unchanged stays unchanged. */
function installDryRunCode(code: string): string {
  if (code === 'unchanged' || code === 'unreadable') {
    return code;
  }
  return 'would-write';
}

/** Uninstall without `--apply`: only absent stays absent. */
function uninstallDryRunCode(code: string): string {
  if (code === 'absent' || code === 'unreadable') {
    return code;
  }
  return 'would-remove';
}

export class ManageDaemonSchedulerUseCase implements ManageDaemonSchedulerPort {
  constructor(
    private readonly deps: { readonly scheduler: DaemonSchedulerPort },
  ) {}

  async execute(
    request: ManageDaemonSchedulerRequest,
  ): Promise<ManageDaemonSchedulerResult> {
    const rendered = renderDaemonUnits(request.daemon);

    if (request.action === 'install') {
      const operatorLines = INSTALL_OPERATOR_LINES;
      if (request.apply) {
        const result = await this.deps.scheduler.write(rendered);
        return {
          units: [
            { key: DAEMON_SERVICE_UNIT_KEY, code: result.service },
            { key: DAEMON_TIMER_UNIT_KEY, code: result.timer },
          ],
          operatorLines,
        };
      }
      const result = await this.deps.scheduler.read(rendered);
      return {
        units: [
          { key: DAEMON_SERVICE_UNIT_KEY, code: installDryRunCode(result.service) },
          { key: DAEMON_TIMER_UNIT_KEY, code: installDryRunCode(result.timer) },
        ],
        operatorLines,
      };
    }

    if (request.action === 'show') {
      const result = await this.deps.scheduler.read(rendered);
      return {
        units: [
          { key: DAEMON_SERVICE_UNIT_KEY, code: result.service },
          { key: DAEMON_TIMER_UNIT_KEY, code: result.timer },
        ],
        operatorLines: null,
      };
    }

    if (request.apply) {
      const result = await this.deps.scheduler.remove();
      return {
        units: [
          { key: DAEMON_SERVICE_UNIT_KEY, code: result.service },
          { key: DAEMON_TIMER_UNIT_KEY, code: result.timer },
        ],
        operatorLines: null,
      };
    }

    const result = await this.deps.scheduler.read(rendered);
    return {
      units: [
        { key: DAEMON_SERVICE_UNIT_KEY, code: uninstallDryRunCode(result.service) },
        { key: DAEMON_TIMER_UNIT_KEY, code: uninstallDryRunCode(result.timer) },
      ],
      operatorLines: null,
    };
  }
}
