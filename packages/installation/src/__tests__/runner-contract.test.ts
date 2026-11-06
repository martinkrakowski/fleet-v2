import { describe, expect, it } from 'vitest';

import type { FleetInstallationModel, FleetInstallationV2, HostRunnerModel } from '../types.js';
import { deriveInstallationModel } from '../model.js';
import { parseInstallation } from '../parse.js';
import { isFleetInstallationV2, writeInstallationV2 } from '../write.js';
import {
  resolveRoleAlias,
  resolveRoleRunnerDefaults,
  resolveRunnerDefaults,
} from '../runner-defaults.js';

/** The declared capabilities a minimal runner block carries. */
const declaredCapabilities = {
  networkEgressRestricted: true,
  cpuAndMemoryLimited: true,
  processTreeTermination: true,
  filesystemScope: 'scoped-worktree',
};

/** A minimal valid v2 file that carries every host contract field. */
const contractV2 = {
  schemaVersion: 2,
  hosts: {
    'lane-host': {
      transport: 'local',
      worktreeRoot: '/srv/fleet/worktrees',
      roles: ['orchestrator', 'lane-runner'],
      container: 'fleet-runner',
      runner: {
        kind: 'opencode',
        port: 46000,
        tunnelOffset: 1,
        authFile: '/etc/fleet/opencode-auth.json',
        capabilities: declaredCapabilities,
        maxLanes: 2,
      },
    },
    'verifier-host': {
      transport: 'ssh',
      sshAlias: 'verifier.fleet.example',
      roleAliases: { verifier: 'verifier-alias' },
      worktreeRoot: '/srv/fleet/worktrees',
      roles: ['verifier'],
      runner: {
        kind: 'opencode',
        port: 46100,
        capabilities: declaredCapabilities,
      },
    },
  },
  forge: { mode: 'github', owner: 'example-owner', repo: 'example-repo' },
};

function parseContractFixture(value: unknown): FleetInstallationV2 {
  const result = parseInstallation(value);
  expect(result.ok).toBe(true);
  if (!result.ok || !isFleetInstallationV2(result.installation)) {
    throw new Error('the fixture must parse as a v2 file');
  }
  return result.installation;
}

function contractModel(value: unknown): FleetInstallationModel {
  const installation = parseContractFixture(value);
  const outcome = deriveInstallationModel(installation);
  return outcome.model;
}

describe('the host contract fields (P2)', () => {
  it('parses the host contract fields and derives them in the model', () => {
    const installation = parseContractFixture(contractV2);
    expect(installation.hosts['lane-host'].container).toBe('fleet-runner');
    expect(installation.hosts['lane-host'].runner?.tunnelOffset).toBe(1);
    expect(installation.hosts['verifier-host'].roleAliases).toEqual({
      verifier: 'verifier-alias',
    });

    const model = contractModel(contractV2);
    expect(model.hosts['lane-host'].container).toBe('fleet-runner');
    expect(model.hosts['lane-host'].runner?.tunnelOffset).toBe(1);
    expect(model.hosts['verifier-host'].roleAliases).toEqual({
      verifier: 'verifier-alias',
    });
  });

  it('refuses a container name that is not identifier-shaped', () => {
    const host = (container: unknown) =>
      parseInstallation({
        ...contractV2,
        hosts: {
          ...contractV2.hosts,
          'lane-host': { ...contractV2.hosts['lane-host'], container },
        },
      });

    expect(host(42)).toEqual({
      ok: false,
      errors: ['hosts.lane-host.container: must be a non-empty string'],
    });
    expect(host('   ')).toEqual({
      ok: false,
      errors: ['hosts.lane-host.container: must be a non-empty string'],
    });
    expect(host('a'.repeat(65))).toEqual({
      ok: false,
      errors: ['hosts.lane-host.container: must be at most 64 characters'],
    });
    expect(host('Fleet')).toEqual({
      ok: false,
      errors: [
        'hosts.lane-host.container: must be a lowercase container name matching ^[a-z0-9][a-z0-9-]*$',
      ],
    });
    // A value that is both secret-shaped and identifier-shaped reports the
    // credential refusal and never the shape refusal. The value is assembled
    // at runtime so this file never itself carries a secret-shaped literal.
    expect(host(`sk-${'a'.repeat(20)}`)).toEqual({
      ok: false,
      errors: ['hosts.lane-host.container: must not contain secret-shaped text'],
    });
  });

  it('refuses a role alias for a role the host does not hold', () => {
    const result = parseInstallation({
      ...contractV2,
      hosts: {
        ...contractV2.hosts,
        'verifier-host': {
          ...contractV2.hosts['verifier-host'],
          roleAliases: { orchestrator: 'orchestrator-alias' },
        },
      },
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        'hosts.verifier-host.roleAliases.orchestrator: the host does not hold that role',
      ],
    });
  });

  it('refuses an unknown role alias key', () => {
    const result = parseInstallation({
      ...contractV2,
      hosts: {
        ...contractV2.hosts,
        'verifier-host': {
          ...contractV2.hosts['verifier-host'],
          roleAliases: { manager: 'manager-alias' },
        },
      },
    });
    expect(result).toEqual({
      ok: false,
      errors: ['hosts.verifier-host.roleAliases.manager: must be a known host role'],
    });
  });

  it('refuses an unsafe role alias without echoing the value', () => {
    const result = parseInstallation({
      ...contractV2,
      hosts: {
        ...contractV2.hosts,
        'verifier-host': {
          ...contractV2.hosts['verifier-host'],
          roleAliases: { verifier: '-unsafe-alias' },
        },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('the unsafe alias must be refused');
    }
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].startsWith('hosts.verifier-host.roleAliases.verifier:')).toBe(true);
    expect(result.errors[0]).not.toContain('-unsafe-alias');
  });

  it('refuses role aliases on a local host', () => {
    const result = parseInstallation({
      ...contractV2,
      hosts: {
        ...contractV2.hosts,
        'lane-host': {
          ...contractV2.hosts['lane-host'],
          roleAliases: { 'lane-runner': 'lane-alias' },
        },
      },
    });
    expect(result).toEqual({
      ok: false,
      errors: ['hosts.lane-host.roleAliases: must be absent when transport is "local"'],
    });
  });

  it('refuses a tunnel offset the bundled runner program cannot dial', () => {
    const runnerWith = (tunnelOffset: unknown) =>
      parseInstallation({
        ...contractV2,
        hosts: {
          ...contractV2.hosts,
          'lane-host': {
            ...contractV2.hosts['lane-host'],
            runner: { ...contractV2.hosts['lane-host'].runner, tunnelOffset },
          },
        },
      });

    expect(runnerWith(2)).toEqual({
      ok: false,
      errors: [
        'hosts.lane-host.runner.tunnelOffset: must be 1 while the bundled runner program dials the server at port + 1',
      ],
    });
    expect(runnerWith(0)).toEqual(runnerWith(2));
    expect(runnerWith(-1)).toEqual({
      ok: false,
      errors: ['hosts.lane-host.runner.tunnelOffset: must be an integer from 0 to 1024'],
    });
    expect(runnerWith(1025)).toEqual({
      ok: false,
      errors: ['hosts.lane-host.runner.tunnelOffset: must be an integer from 0 to 1024'],
    });
    expect(runnerWith('one')).toEqual({
      ok: false,
      errors: ['hosts.lane-host.runner.tunnelOffset: must be an integer from 0 to 1024'],
    });
    // The bound itself is accepted, then refused by the dial-offset rule.
    expect(runnerWith(1024)).toEqual(runnerWith(2));
  });

  it('accepts the tunnel offset 1 and an absent offset', () => {
    const withOne = parseContractFixture(contractV2);
    expect(withOne.hosts['lane-host'].runner?.tunnelOffset).toBe(1);

    const withoutOffset = parseContractFixture({
      ...contractV2,
      hosts: {
        ...contractV2.hosts,
        'lane-host': {
          ...contractV2.hosts['lane-host'],
          runner: { ...contractV2.hosts['lane-host'].runner, tunnelOffset: undefined },
        },
      },
    });
    expect(withoutOffset.hosts['lane-host'].runner?.tunnelOffset).toBeUndefined();
  });

  it('keeps the contract fields through the v2 writer', () => {
    const installation = parseContractFixture(contractV2);
    const written = writeInstallationV2(installation);
    expect(written).toContain('"container": "fleet-runner"');
    expect(written).toContain('"tunnelOffset": 1');
    expect(written).toContain('"roleAliases"');
    expect(written).toContain('"verifier-alias"');
    const reparsed = parseContractFixture(JSON.parse(written));
    expect(reparsed).toEqual(installation);
  });

  it('resolves the runner defaults the file declares', () => {
    const model = contractModel(contractV2);

    // An ssh host dials port + 1 and uses its own alias when no role is given.
    expect(resolveRunnerDefaults(model, 'verifier-host')).toEqual({
      ok: true,
      defaults: {
        hostName: 'verifier-host',
        transport: 'ssh',
        port: 46100,
        tunnelOffset: 1,
        dialPort: 46101,
        sshAlias: 'verifier.fleet.example',
      },
    });

    // A local host dials its own port and carries no alias.
    expect(resolveRunnerDefaults(model, 'lane-host')).toEqual({
      ok: true,
      defaults: {
        hostName: 'lane-host',
        transport: 'local',
        port: 46000,
        tunnelOffset: 1,
        dialPort: 46000,
        authFile: '/etc/fleet/opencode-auth.json',
        container: 'fleet-runner',
      },
    });

    // The role alias overrides the host alias for that role.
    expect(resolveRoleRunnerDefaults(model, 'verifier')).toEqual({
      ok: true,
      defaults: {
        hostName: 'verifier-host',
        transport: 'ssh',
        port: 46100,
        tunnelOffset: 1,
        dialPort: 46101,
        sshAlias: 'verifier-alias',
      },
    });

    expect(resolveRoleAlias(model, 'verifier-host', 'verifier')).toBe('verifier-alias');
    expect(resolveRoleAlias(model, 'lane-host', 'orchestrator')).toBeUndefined();
  });

  it('reports an unknown host, a missing runner and an out-of-range dial port as typed refusals', () => {
    const emptyModel: FleetInstallationModel = { schemaVersion: 2, hosts: Object.create(null) };
    expect(resolveRunnerDefaults(emptyModel, 'missing-host')).toEqual({
      ok: false,
      reason: 'host-not-found',
    });
    expect(resolveRoleRunnerDefaults(emptyModel, 'lane-runner')).toEqual({
      ok: false,
      reason: 'host-not-found',
    });

    const undeclaredCapabilities = {
      source: 'undeclared' as const,
      filesystemScope: 'unknown' as const,
      networkEgressRestricted: null,
      cpuAndMemoryLimited: null,
      processTreeTermination: null,
    };
    const runnerWithNoPort: HostRunnerModel = {
      kind: 'opencode',
      capabilities: undeclaredCapabilities,
    };
    const noRunnerHost = {
      transport: 'local' as const,
      roles: ['verifier' as const],
    };
    const noPortHost = {
      transport: 'local' as const,
      roles: ['lane-runner' as const],
      runner: runnerWithNoPort,
    };
    const outOfRangeHost = {
      transport: 'ssh' as const,
      sshAlias: 'edge.fleet.example',
      roles: ['verifier' as const],
      runner: { kind: 'opencode' as const, port: 65535, capabilities: undeclaredCapabilities },
    };
    const model: FleetInstallationModel = {
      schemaVersion: 2,
      hosts: {
        'no-runner-host': noRunnerHost,
        'no-port-host': noPortHost,
        'edge-host': outOfRangeHost,
      },
    };

    expect(resolveRunnerDefaults(model, 'no-runner-host')).toEqual({
      ok: false,
      reason: 'no-runner',
    });
    expect(resolveRunnerDefaults(model, 'no-port-host')).toEqual({
      ok: false,
      reason: 'no-port',
    });
    expect(resolveRunnerDefaults(model, 'edge-host')).toEqual({
      ok: false,
      reason: 'dial-port-out-of-range',
    });
  });

  it('never throws on a hostile installation value', () => {
    const expectRefusal = (value: unknown) => {
      expect(() => parseInstallation(value)).not.toThrow();
      const result = parseInstallation(value);
      expect(result.ok).toBe(false);
    };

    expectRefusal(null);
    expectRefusal(42);
    expectRefusal('installation');
    // A missing field: no hosts at all.
    expectRefusal({ schemaVersion: 2 });
    // A wrong-typed field.
    expectRefusal({ ...contractV2, hosts: null });
    // hosts as an array.
    expectRefusal({ ...contractV2, hosts: [{ transport: 'local' }] });

    // A sparse roles array: the hole is refused, nothing throws.
    const sparseRoles = new Array(3);
    sparseRoles[0] = 'orchestrator';
    sparseRoles[2] = 'lane-runner';
    expectRefusal({
      ...contractV2,
      hosts: {
        ...contractV2.hosts,
        'lane-host': { ...contractV2.hosts['lane-host'], roles: sparseRoles },
      },
    });

    // An unknown role value.
    expectRefusal({
      ...contractV2,
      hosts: {
        ...contractV2.hosts,
        'lane-host': { ...contractV2.hosts['lane-host'], roles: ['boss'] },
      },
    });

    // A throwing getter on hosts.<name>.container never runs.
    const getterHost = {
      ...contractV2.hosts['lane-host'],
      get container(): string {
        throw new Error('the getter must never run');
      },
    };
    const getterResult = parseInstallation({
      ...contractV2,
      hosts: { ...contractV2.hosts, 'lane-host': getterHost },
    });
    expect(getterResult.ok).toBe(true);

    // A throwing getter on the root schemaVersion never runs.
    const getterRoot = {
      ...contractV2,
      get schemaVersion(): number {
        throw new Error('the getter must never run');
      },
    };
    const rootResult = parseInstallation(getterRoot);
    expect(rootResult.ok).toBe(false);
    if (!rootResult.ok) {
      expect(rootResult.errors).toContain('schemaVersion: must be 1 or 2');
    }
  });
});
