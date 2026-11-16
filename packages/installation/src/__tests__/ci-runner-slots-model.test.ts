import { describe, expect, it } from 'vitest';

import { deriveInstallationModel } from '../model.js';
import { parseInstallation } from '../parse.js';
import type { FleetInstallation, HostModel } from '../types.js';

const SLOTS = [
  { name: 'slot-1', unit: 'fleet-ci@1.service' },
  { name: 'slot-2', unit: 'fleet-ci@2.service' },
];

/** A minimal valid v2 file whose ssh lane host carries `extra`. */
function v2With(extra: Record<string, unknown>): unknown {
  return {
    schemaVersion: 2,
    hosts: {
      'orchestrator-host': {
        transport: 'local',
        worktreeRoot: '/srv/fleet/orchestrator',
        roles: ['orchestrator'],
      },
      'lane-host': {
        transport: 'ssh',
        sshAlias: 'lane-host.example',
        worktreeRoot: '/srv/fleet/lane',
        roles: ['lane-runner'],
        runner: { kind: 'opencode', port: 46000 },
        ...extra,
      },
    },
    forge: { mode: 'github', owner: 'example-owner', repo: 'example-repo' },
  };
}

const v1File = {
  schemaVersion: 1,
  runner: { agent: 'runner-agent', model: 'runner-model', host: 'lane-host.example' },
  worktree: { sshHost: 'lane-host.example' },
  verification: {
    sshHost: 'verify-host.example',
    procedures: { gate: { command: 'yarn', args: ['test'] } },
  },
};

function parsed(value: unknown): FleetInstallation {
  const result = parseInstallation(value);
  if (!result.ok) {
    throw new Error(`the fixture must parse: ${result.errors.join('; ')}`);
  }
  return result.installation;
}

function hostsOf(installation: FleetInstallation): Readonly<Record<string, HostModel>> {
  const outcome = deriveInstallationModel(installation);
  expect(outcome.errors).toBeUndefined();
  return outcome.model.hosts;
}

describe('deriveInstallationModel hosts.<name>.ciRunnerSlots (OG-28b)', () => {
  it('derives ciRunnerSlots in order with name and unit for a v2 host', () => {
    const installation = parsed(v2With({ ciRunnerSlots: SLOTS }));
    const hosts = hostsOf(installation);
    expect(hosts['lane-host'].ciRunnerSlots).toEqual([
      { name: 'slot-1', unit: 'fleet-ci@1.service' },
      { name: 'slot-2', unit: 'fleet-ci@2.service' },
    ]);
    expect(hosts['lane-host'].ciRunnerSlots).not.toBe(
      installation.hosts?.['lane-host']?.ciRunnerSlots,
    );
    expect(Object.hasOwn(hosts['orchestrator-host'], 'ciRunnerSlots')).toBe(false);
  });

  it('omits the ciRunnerSlots key on a v2 host that declares none', () => {
    const hosts = hostsOf(parsed(v2With({})));
    expect(Object.keys(hosts)).toEqual(['orchestrator-host', 'lane-host']);
    for (const host of Object.values(hosts)) {
      expect(Object.hasOwn(host, 'ciRunnerSlots')).toBe(false);
    }
  });

  it('derives no ciRunnerSlots key on any host of a v1 installation', () => {
    const hosts = hostsOf(parsed(v1File));
    expect(Object.keys(hosts)).toEqual(['lane-host.example', 'verify-host.example']);
    for (const host of Object.values(hosts)) {
      expect(Object.hasOwn(host, 'ciRunnerSlots')).toBe(false);
    }
  });
});
