import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DAEMON_SERVICE_TEMPLATE,
  DAEMON_TIMER_TEMPLATE,
  ManageDaemonSchedulerUseCase,
  renderDaemonUnits,
} from '../ManageDaemonSchedulerUseCase.use-case.js';
import {
  DAEMON_SERVICE_UNIT_KEY,
  DAEMON_TIMER_UNIT_KEY,
  type DaemonSchedulerPort,
  type DaemonSchedulerReadResult,
  type DaemonSchedulerRemoveResult,
  type DaemonSchedulerWriteResult,
} from '../../ports/out/DaemonSchedulerPort.out-port.js';

const FACTS = {
  nodePath: '/srv/fleet/node/bin/node',
  cliPath: '/srv/fleet/cli/fleet-v2.mjs',
  stateDir: '/srv/fleet/state',
  unitDir: '/srv/fleet/units',
  installationFile: '/srv/fleet/fleet.json',
};

interface FakeSchedulerResults {
  readonly read?: DaemonSchedulerReadResult;
  readonly write?: DaemonSchedulerWriteResult;
  readonly remove?: DaemonSchedulerRemoveResult;
}

function fakeScheduler(results: FakeSchedulerResults = {}): {
  scheduler: DaemonSchedulerPort;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    scheduler: {
      async read(input) {
        calls.push(`read:${input.service.length}:${input.timer.length}`);
        return results.read ?? { service: 'unchanged', timer: 'unchanged' };
      },
      async write(input) {
        calls.push(`write:${input.service.length}:${input.timer.length}`);
        return results.write ?? { service: 'written', timer: 'written' };
      },
      async remove() {
        calls.push('remove');
        return results.remove ?? { service: 'absent', timer: 'absent' };
      },
    },
  };
}

const OPERATOR_LINES = [
  'enable: systemctl --user enable fleet-v2-daemon.timer',
  'linger: loginctl enable-linger',
];

describe('ManageDaemonSchedulerUseCase', () => {
  it('install without apply reads only and maps absent/different to would-write', async () => {
    const { scheduler, calls } = fakeScheduler({
      read: { service: 'absent', timer: 'differs' },
    });
    const useCase = new ManageDaemonSchedulerUseCase({ scheduler });
    const result = await useCase.execute({
      action: 'install',
      apply: false,
      daemon: FACTS,
    });
    expect(result.units).toEqual([
      { key: DAEMON_SERVICE_UNIT_KEY, code: 'would-write' },
      { key: DAEMON_TIMER_UNIT_KEY, code: 'would-write' },
    ]);
    expect(result.operatorLines).toEqual(OPERATOR_LINES);
    expect(calls).toEqual([expect.stringMatching(/^read:/)]);
  });

  it('install without apply keeps unchanged and unreadable codes', async () => {
    const { scheduler } = fakeScheduler({
      read: { service: 'unchanged', timer: 'unreadable' },
    });
    const useCase = new ManageDaemonSchedulerUseCase({ scheduler });
    const result = await useCase.execute({
      action: 'install',
      apply: false,
      daemon: FACTS,
    });
    expect(result.units.map((unit) => unit.code)).toEqual([
      'unchanged',
      'unreadable',
    ]);
  });

  it('install with apply writes only', async () => {
    const { scheduler, calls } = fakeScheduler({
      write: { service: 'written', timer: 'unchanged' },
    });
    const useCase = new ManageDaemonSchedulerUseCase({ scheduler });
    const result = await useCase.execute({
      action: 'install',
      apply: true,
      daemon: FACTS,
    });
    expect(result.units.map((unit) => unit.code)).toEqual([
      'written',
      'unchanged',
    ]);
    expect(result.operatorLines).toEqual(OPERATOR_LINES);
    expect(calls).toEqual([expect.stringMatching(/^write:/)]);
  });

  it('show reads only, maps differs and has null operator lines', async () => {
    const { scheduler, calls } = fakeScheduler({
      read: { service: 'differs', timer: 'unchanged' },
    });
    const useCase = new ManageDaemonSchedulerUseCase({ scheduler });
    const result = await useCase.execute({
      action: 'show',
      apply: false,
      daemon: FACTS,
    });
    expect(result.units.map((unit) => unit.code)).toEqual([
      'differs',
      'unchanged',
    ]);
    expect(result.operatorLines).toBeNull();
    expect(calls).toEqual([expect.stringMatching(/^read:/)]);
  });

  it('uninstall without apply keeps an unreadable code', async () => {
    const { scheduler, calls } = fakeScheduler({
      read: { service: 'unreadable', timer: 'unchanged' },
    });
    const useCase = new ManageDaemonSchedulerUseCase({ scheduler });
    const result = await useCase.execute({
      action: 'uninstall',
      apply: false,
      daemon: FACTS,
    });
    expect(result.units.map((unit) => unit.code)).toEqual([
      'unreadable',
      'would-remove',
    ]);
    expect(result.operatorLines).toBeNull();
    expect(calls).toEqual([expect.stringMatching(/^read:/)]);
  });

  it('uninstall without apply maps present to would-remove and never removes', async () => {
    const { scheduler, calls } = fakeScheduler({
      read: { service: 'unchanged', timer: 'absent' },
    });
    const useCase = new ManageDaemonSchedulerUseCase({ scheduler });
    const result = await useCase.execute({
      action: 'uninstall',
      apply: false,
      daemon: FACTS,
    });
    expect(result.units.map((unit) => unit.code)).toEqual([
      'would-remove',
      'absent',
    ]);
    expect(result.operatorLines).toBeNull();
    expect(calls).toEqual([expect.stringMatching(/^read:/)]);
  });

  it('uninstall with apply removes only and reports absent', async () => {
    const { scheduler, calls } = fakeScheduler({
      remove: { service: 'absent', timer: 'absent' },
    });
    const useCase = new ManageDaemonSchedulerUseCase({ scheduler });
    const result = await useCase.execute({
      action: 'uninstall',
      apply: true,
      daemon: FACTS,
    });
    expect(result.units.map((unit) => unit.code)).toEqual([
      'absent',
      'absent',
    ]);
    expect(result.operatorLines).toBeNull();
    expect(calls).toEqual(['remove']);
  });

  it('renders the service unit text', () => {
    const service = renderDaemonUnits(FACTS).service;
    expect(service).toContain('Type=oneshot');
    expect(service).toContain('daemon tick');
    expect(service).toContain(
      'Environment=FLEET_STATE_DIR=/srv/fleet/state',
    );
    expect(service).toContain(
      'Environment=FLEET_INSTALLATION_FILE=/srv/fleet/fleet.json',
    );
    expect(service).toContain('Nice=5');
    expect(service).not.toContain('RemainAfterExit');
    expect(service).not.toContain('Restart=');
    expect(service).not.toContain('WantedBy');
    expect(service).not.toContain('sh -c');
    expect(service).not.toContain('/bin/sh');
    expect(service).not.toContain('systemctl');
  });

  it('renders the timer unit text', () => {
    const timer = renderDaemonUnits(FACTS).timer;
    expect(timer).toContain('OnUnitActiveSec=60s');
    expect(timer).toContain('OnBootSec=60s');
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('Unit=fleet-v2-daemon.service');
    expect(timer).toContain('WantedBy=timers.target');
  });

  it('renders dollar sequences in the facts literally', () => {
    const rendered = renderDaemonUnits({
      ...FACTS,
      nodePath: '/srv/fleet/$$/node',
      stateDir: '/srv/$&/state',
    });
    expect(rendered.service).toContain('/srv/fleet/$$/node');
    expect(rendered.service).toContain('/srv/$&/state');
    expect(rendered.service).not.toContain('{{');
    expect(rendered.service).not.toContain('ExecStart=/srv/fleet/$/node');
  });

  it('rendered text equals the committed deploy templates with the same facts', () => {
    const serviceTemplate = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../../../deploy/systemd/fleet-v2-daemon.service.tmpl',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    const timerTemplate = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../../../deploy/systemd/fleet-v2-daemon.timer.tmpl',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    expect(DAEMON_SERVICE_TEMPLATE).toBe(serviceTemplate);
    expect(DAEMON_TIMER_TEMPLATE).toBe(timerTemplate);

    const rendered = renderDaemonUnits(FACTS);
    const substitutedService = serviceTemplate
      .replaceAll('{{nodePath}}', FACTS.nodePath)
      .replaceAll('{{cliPath}}', FACTS.cliPath)
      .replaceAll('{{stateDir}}', FACTS.stateDir)
      .replaceAll('{{installationFile}}', FACTS.installationFile);
    expect(rendered.service).toBe(substitutedService);
    expect(rendered.timer).toBe(timerTemplate);
  });

  it('substitution leaves no placeholder behind', () => {
    const rendered = renderDaemonUnits(FACTS);
    expect(rendered.service).not.toContain('{{');
    expect(rendered.timer).not.toContain('{{');
    expect(rendered.service).not.toContain('}}');
    expect(rendered.timer).not.toContain('}}');
  });
});
