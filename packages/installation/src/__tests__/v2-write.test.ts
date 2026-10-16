import { describe, expect, it } from 'vitest';

import type { FleetInstallationV2 } from '../types.js';
import { parseInstallation } from '../parse.js';
import { isFleetInstallationV2, writeInstallationV2 } from '../write.js';

/** A minimal valid v2 file: one host with both required roles and a runner. */
const validV2: FleetInstallationV2 = {
  schemaVersion: 2,
  hosts: {
    'lane-host': {
      transport: 'ssh',
      sshAlias: 'lane-host.example',
      worktreeRoot: '/srv/fleet/worktrees',
      roles: ['orchestrator', 'lane-runner'],
      runner: {
        kind: 'opencode',
        port: 46000,
        capabilities: {
          networkEgressRestricted: true,
          cpuAndMemoryLimited: true,
          processTreeTermination: true,
          filesystemScope: 'scoped-worktree',
        },
        maxLanes: 2,
      },
    },
  },
  tools: ['opencode'],
  seats: [
    {
      id: 'implementer',
      tool: 'opencode',
      model: 'example-provider/example-model',
      roles: ['implementer'],
      costClass: 'plan-quota',
    },
  ],
  chains: { implementer: [{ seatId: 'implementer' }] },
  policy: { forbiddenRoutes: [{ tool: 'example-tool', modelPattern: 'example-*' }] },
  shelf: { provider: 'local' },
  forge: { mode: 'github', owner: 'example-owner', repo: 'example-repo' },
  verification: { procedures: { gate: { command: 'yarn', args: ['test'] } } },
};

function parseV2Fixture(value: unknown): FleetInstallationV2 {
  const result = parseInstallation(value);
  if (!result.ok || !isFleetInstallationV2(result.installation)) {
    throw new Error('the fixture must parse as a v2 file');
  }
  return result.installation;
}

describe('writeInstallationV2', () => {
  it('round-trips a v2 file through the writer', () => {
    const installation = parseV2Fixture(validV2);
    const written = writeInstallationV2(installation);
    expect(written.endsWith('\n')).toBe(true);
    expect(parseInstallation(JSON.parse(written))).toEqual({
      ok: true,
      installation,
    });
  });

  it('writes a stable section and key order regardless of input order', () => {
    const installation = parseV2Fixture(validV2);
    const forward = writeInstallationV2(installation);
    const reordered: FleetInstallationV2 = {
      verification: installation.verification,
      forge: installation.forge,
      shelf: installation.shelf,
      policy: installation.policy,
      chains: installation.chains,
      seats: installation.seats,
      tools: installation.tools,
      hosts: {
        'lane-host': {
          runner: {
            maxLanes: 2,
            capabilities: {
              filesystemScope: 'scoped-worktree',
              processTreeTermination: true,
              cpuAndMemoryLimited: true,
              networkEgressRestricted: true,
            },
            port: 46000,
            kind: 'opencode',
          },
          roles: ['orchestrator', 'lane-runner'],
          worktreeRoot: '/srv/fleet/worktrees',
          sshAlias: 'lane-host.example',
          transport: 'ssh',
        },
      },
      schemaVersion: 2,
    };
    expect(writeInstallationV2(reordered)).toBe(forward);
  });

  it('never writes a runner capability source', () => {
    const installation = parseV2Fixture(validV2);
    const written = writeInstallationV2(installation);
    expect(written).not.toContain('"source"');
  });
});
