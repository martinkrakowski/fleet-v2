import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DAEMON_SERVICE_TEMPLATE,
  DAEMON_TIMER_TEMPLATE,
  ManageDaemonSchedulerUseCase,
  SHADOW_INTAKE_SERVICE_TEMPLATE,
  SHADOW_INTAKE_TIMER_TEMPLATE,
  MAX_SHADOW_CONFIG_VALUE_LENGTH,
  readShadowSchedulerConfig,
  renderDaemonUnits,
  renderShadowIntakeUnits,
} from '../ManageDaemonSchedulerUseCase.use-case.js';
import {
  DAEMON_SERVICE_UNIT_KEY,
  DAEMON_TIMER_UNIT_KEY,
  SHADOW_INTAKE_SERVICE_UNIT_KEY,
  SHADOW_INTAKE_TIMER_UNIT_KEY,
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
        const base = results.read ?? { service: 'unchanged', timer: 'unchanged' };
        return input.shadowIntake === undefined
          ? base
          : {
              ...base,
              shadowIntake: { service: base.service, timer: base.timer },
            };
      },
      async write(input) {
        calls.push(`write:${input.service.length}:${input.timer.length}`);
        const base = results.write ?? { service: 'written', timer: 'written' };
        return input.shadowIntake === undefined
          ? base
          : {
              ...base,
              shadowIntake: { service: base.service, timer: base.timer },
            };
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

const SHADOW_CONFIG = {
  repository: 'owner/repo',
  legacyStateDir: '/srv/fleet/legacy-state',
  projectId: 'proj-1',
};

const SHADOW_FACTS = { ...FACTS, shadow: SHADOW_CONFIG };

describe('readShadowSchedulerConfig (OD7a1)', () => {
  it('accepts a valid config', () => {
    expect(readShadowSchedulerConfig(SHADOW_CONFIG)).toEqual({
      ok: true,
      config: SHADOW_CONFIG,
    });
  });

  it('refuses null', () => {
    expect(readShadowSchedulerConfig(null)).toEqual({
      ok: false,
      reason: 'invalid-shadow-config',
    });
  });

  it('refuses undefined', () => {
    expect(readShadowSchedulerConfig(undefined)).toEqual({
      ok: false,
      reason: 'invalid-shadow-config',
    });
  });

  it('refuses a wrong primitive where an object is due', () => {
    expect(readShadowSchedulerConfig(7)).toEqual({
      ok: false,
      reason: 'invalid-shadow-config',
    });
    expect(readShadowSchedulerConfig('owner/repo')).toEqual({
      ok: false,
      reason: 'invalid-shadow-config',
    });
  });

  it('refuses an array where an object is due', () => {
    expect(readShadowSchedulerConfig([])).toEqual({
      ok: false,
      reason: 'invalid-shadow-config',
    });
    const sparse = new Array(3);
    sparse[1] = 'x';
    expect(readShadowSchedulerConfig(sparse)).toEqual({
      ok: false,
      reason: 'invalid-shadow-config',
    });
  });

  it('refuses a non-iterable array-like object where an object is due', () => {
    expect(
      readShadowSchedulerConfig({ length: 1, 0: SHADOW_CONFIG }),
    ).toEqual({ ok: false, reason: 'invalid-shadow-config' });
  });

  it('refuses an enormous sparse array before any traversal', () => {
    const sparse = new Array(2 ** 32 - 1);
    expect(readShadowSchedulerConfig(sparse)).toEqual({
      ok: false,
      reason: 'invalid-shadow-config',
    });
  });

  it('never runs a getter on the root or on a value', () => {
    let getterCalls = 0;
    const input = {
      get repository(): string {
        getterCalls += 1;
        return SHADOW_CONFIG.repository;
      },
      legacyStateDir: SHADOW_CONFIG.legacyStateDir,
      projectId: SHADOW_CONFIG.projectId,
    };
    expect(readShadowSchedulerConfig(input)).toEqual({
      ok: false,
      reason: 'invalid-shadow-config',
    });
    expect(getterCalls).toBe(0);
  });

  it('refuses a Proxy over a valid input without running a get trap', () => {
    let getTrapCalls = 0;
    const proxy = new Proxy(SHADOW_CONFIG, {
      get(target, key, receiver) {
        getTrapCalls += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const result = readShadowSchedulerConfig(proxy);
    // Either refused or exactly the plain-data result; either way no get trap
    // may have run for the value reads.
    if (result.ok) {
      expect(result.config).toEqual(SHADOW_CONFIG);
    } else {
      expect(result.reason).toBe('invalid-shadow-config');
    }
    expect(getTrapCalls).toBe(0);
  });

  it('refuses a prototype-polluting own key', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const raw = `{"repository":"owner/repo","legacyStateDir":"/srv/fleet/l","projectId":"p","${key}":"x"}`;
      const parsed: unknown = JSON.parse(raw);
      expect(readShadowSchedulerConfig(parsed)).toEqual({
        ok: false,
        reason: 'invalid-shadow-config',
      });
    }
  });

  it('refuses each value with whitespace, %, $, quotes or backslash', () => {
    const bad = [
      'owner repo',
      'owner%repo',
      'owner$repo',
      "owner'repo",
      'owner"repo',
      'owner\\repo',
    ];
    for (const value of bad) {
      for (const key of ['repository', 'legacyStateDir', 'projectId'] as const) {
        expect(readShadowSchedulerConfig({ ...SHADOW_CONFIG, [key]: value })).toEqual({
          ok: false,
          reason: 'invalid-shadow-config',
        });
      }
    }
  });

  it('refuses a constant verdict that ignores the input', () => {
    // A constant `ok` verdict would accept these; a constant refusal would
    // reject the valid config.
    expect(readShadowSchedulerConfig(SHADOW_CONFIG).ok).toBe(true);
    expect(readShadowSchedulerConfig({ ...SHADOW_CONFIG, projectId: '' }).ok).toBe(
      false,
    );
  });

  it('refuses an identity echo of the input', () => {
    // An echo would return the input object itself, not a validated config
    // with exactly the three keys and string values.
    const result = readShadowSchedulerConfig({
      ...SHADOW_CONFIG,
      extra: 'key',
    });
    expect(result).toEqual({ ok: false, reason: 'invalid-shadow-config' });
  });

  it('refuses an overlong value', () => {
    expect(
      readShadowSchedulerConfig({
        ...SHADOW_CONFIG,
        projectId: 'p'.repeat(MAX_SHADOW_CONFIG_VALUE_LENGTH + 1),
      }).ok,
    ).toBe(false);
  });

  it('refuses a credential-shaped projectId that avoids the substitution characters', () => {
    // Built at runtime so no secret literal ever lands in this file.
    const token = ['sk', '-Ab1', 'xY2zW3'.repeat(4)].join('');
    expect(token).toMatch(/[A-Za-z0-9_-]{20,}/);
    expect(readShadowSchedulerConfig({ ...SHADOW_CONFIG, projectId: token })).toEqual({
      ok: false,
      reason: 'invalid-shadow-config',
    });
  });

  it('refuses a credential-shaped repository that avoids the substitution characters', () => {
    // Built at runtime so no secret literal ever lands in this file.
    const token = ['ghp', '_', 'A1b2C3'.repeat(4)].join('');
    expect(token).toMatch(/[A-Za-z0-9_-]{20,}/);
    expect(readShadowSchedulerConfig({ ...SHADOW_CONFIG, repository: token })).toEqual({
      ok: false,
      reason: 'invalid-shadow-config',
    });
  });
});

describe('ManageDaemonSchedulerUseCase shadow intake (OD7a1)', () => {
  it('shadow facts render the intake service with --project and --scheduled and no grant or Restart', async () => {
    const { scheduler, calls } = fakeScheduler({
      write: { service: 'written', timer: 'written' },
    });
    const useCase = new ManageDaemonSchedulerUseCase({ scheduler });
    const result = await useCase.execute({
      action: 'install',
      apply: true,
      daemon: SHADOW_FACTS,
    });
    expect(result.units).toEqual([
      { key: DAEMON_SERVICE_UNIT_KEY, code: 'written' },
      { key: DAEMON_TIMER_UNIT_KEY, code: 'written' },
      { key: SHADOW_INTAKE_SERVICE_UNIT_KEY, code: 'written' },
      { key: SHADOW_INTAKE_TIMER_UNIT_KEY, code: 'written' },
    ]);
    expect(result.operatorLines).toEqual([
      ...OPERATOR_LINES,
      'enable: systemctl --user enable fleet-v2-shadow-intake.timer',
    ]);
    expect(calls).toEqual([expect.stringMatching(/^write:/)]);
    // Assert the exact rendered intake ExecStart through the templates.
    expect(SHADOW_INTAKE_SERVICE_TEMPLATE).toContain(
      'ExecStart={{nodePath}} {{cliPath}} --state-dir {{stateDir}} merge import --repository {{repository}} --legacy-state-dir {{legacyStateDir}} --apply --project {{projectId}} --scheduled',
    );
    expect(SHADOW_INTAKE_SERVICE_TEMPLATE).not.toContain('--grant');
    expect(SHADOW_INTAKE_SERVICE_TEMPLATE).not.toContain('Restart=');
    expect(SHADOW_INTAKE_SERVICE_TEMPLATE).not.toContain('EnvironmentFile');
    expect(SHADOW_INTAKE_SERVICE_TEMPLATE).toContain('Type=oneshot');
    expect(SHADOW_INTAKE_SERVICE_TEMPLATE).toContain(
      'Environment=FLEET_STATE_DIR={{stateDir}}',
    );
    expect(SHADOW_INTAKE_SERVICE_TEMPLATE).toContain(
      'Environment=FLEET_INSTALLATION_FILE={{installationFile}}',
    );
    expect(SHADOW_INTAKE_TIMER_TEMPLATE).toContain('OnBootSec=120s');
    expect(SHADOW_INTAKE_TIMER_TEMPLATE).toContain('OnUnitActiveSec=180s');
    expect(SHADOW_INTAKE_TIMER_TEMPLATE).toContain('AccuracySec=5s');
    expect(SHADOW_INTAKE_TIMER_TEMPLATE).toContain('Persistent=true');
    expect(SHADOW_INTAKE_TIMER_TEMPLATE).toContain(
      'Unit=fleet-v2-shadow-intake.service',
    );
    expect(SHADOW_INTAKE_TIMER_TEMPLATE).toContain('WantedBy=timers.target');
    const rendered = renderShadowIntakeUnits(SHADOW_FACTS, SHADOW_CONFIG);
    expect(rendered.service).toContain('--project proj-1 --scheduled');
    expect(rendered.service).toContain('--repository owner/repo');
    expect(rendered.service).toContain('--legacy-state-dir /srv/fleet/legacy-state');
    expect(rendered.service).not.toContain('--grant');
    expect(rendered.service).not.toContain('{{');
  });

  it('no shadow facts render only the two main units', async () => {
    const { scheduler } = fakeScheduler({
      write: { service: 'written', timer: 'written' },
    });
    const useCase = new ManageDaemonSchedulerUseCase({ scheduler });
    const result = await useCase.execute({
      action: 'install',
      apply: true,
      daemon: FACTS,
    });
    expect(result.units.map((unit) => unit.key)).toEqual([
      DAEMON_SERVICE_UNIT_KEY,
      DAEMON_TIMER_UNIT_KEY,
    ]);
    expect(result.operatorLines).toEqual(OPERATOR_LINES);
  });

  it('an invalid shadow config is a typed refusal with no units touched', async () => {
    const { scheduler, calls } = fakeScheduler();
    const useCase = new ManageDaemonSchedulerUseCase({ scheduler });
    const result = await useCase.execute({
      action: 'install',
      apply: true,
      daemon: { ...FACTS, shadow: { ...SHADOW_CONFIG, repository: 'owner repo' } },
    });
    expect(result.refusal).toBe('invalid-shadow-config');
    expect(result.units).toEqual([]);
    expect(result.operatorLines).toBeNull();
    expect(calls).toEqual([]);
  });

  it('uninstall with shadow off prints exactly the 2 main lines on dry-run and --apply', async () => {
    const dryRun = new ManageDaemonSchedulerUseCase({
      scheduler: fakeScheduler({
        read: { service: 'unchanged', timer: 'absent' },
      }).scheduler,
    });
    const resultDry = await dryRun.execute({
      action: 'uninstall',
      apply: false,
      daemon: FACTS,
    });
    expect(resultDry.units).toEqual([
      { key: DAEMON_SERVICE_UNIT_KEY, code: 'would-remove' },
      { key: DAEMON_TIMER_UNIT_KEY, code: 'absent' },
    ]);
    const applied = new ManageDaemonSchedulerUseCase({
      scheduler: fakeScheduler({
        remove: {
          service: 'absent',
          timer: 'absent',
          shadowIntake: { service: 'absent', timer: 'absent' },
        },
      }).scheduler,
    });
    const resultApply = await applied.execute({
      action: 'uninstall',
      apply: true,
      daemon: FACTS,
    });
    // The port removed the intake units too, but the lines stay exactly 2.
    expect(resultApply.units).toEqual([
      { key: DAEMON_SERVICE_UNIT_KEY, code: 'absent' },
      { key: DAEMON_TIMER_UNIT_KEY, code: 'absent' },
    ]);
  });

  it('uninstall with shadow on prints all 4 unit lines', async () => {
    const useCase = new ManageDaemonSchedulerUseCase({
      scheduler: fakeScheduler({
        remove: {
          service: 'absent',
          timer: 'absent',
          shadowIntake: { service: 'absent', timer: 'absent' },
        },
      }).scheduler,
    });
    const result = await useCase.execute({
      action: 'uninstall',
      apply: true,
      daemon: SHADOW_FACTS,
    });
    expect(result.units.map((unit) => unit.key)).toEqual([
      DAEMON_SERVICE_UNIT_KEY,
      DAEMON_TIMER_UNIT_KEY,
      SHADOW_INTAKE_SERVICE_UNIT_KEY,
      SHADOW_INTAKE_TIMER_UNIT_KEY,
    ]);
  });

  it('treats port rejection as unreadable', async () => {
    const useCase = new ManageDaemonSchedulerUseCase({
      scheduler: {
        async read() {
          throw new Error('port rejected');
        },
        async write() {
          throw new Error('port rejected');
        },
        async remove() {
          throw new Error('port rejected');
        },
      },
    });
    const install = await useCase.execute({
      action: 'install',
      apply: true,
      daemon: FACTS,
    });
    expect(install.units.map((unit) => unit.code)).toEqual([
      'unreadable',
      'unreadable',
    ]);
    const show = await useCase.execute({
      action: 'show',
      apply: false,
      daemon: FACTS,
    });
    expect(show.units.map((unit) => unit.code)).toEqual([
      'unreadable',
      'unreadable',
    ]);
    const uninstall = await useCase.execute({
      action: 'uninstall',
      apply: true,
      daemon: FACTS,
    });
    expect(uninstall.units.map((unit) => unit.code)).toEqual([
      'unreadable',
      'unreadable',
    ]);
  });

  it('treats a missing port method as unreadable', async () => {
    const useCase = new ManageDaemonSchedulerUseCase({
      scheduler: {} as unknown as DaemonSchedulerPort,
    });
    const result = await useCase.execute({
      action: 'show',
      apply: false,
      daemon: FACTS,
    });
    expect(result.units.map((unit) => unit.code)).toEqual([
      'unreadable',
      'unreadable',
    ]);
  });
});
