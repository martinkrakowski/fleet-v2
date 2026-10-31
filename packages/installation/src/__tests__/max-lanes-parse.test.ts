import { describe, expect, it } from 'vitest';

import { parseInstallation } from '../parse.js';

/** A minimal valid v2 file: one host with both required roles and a runner. */
const validV2 = {
  schemaVersion: 2,
  hosts: {
    'lane-host': {
      transport: 'local',
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

const withRunner = (runner: Record<string, unknown>) => ({
  ...validV2,
  hosts: {
    ...validV2.hosts,
    'lane-host': {
      ...validV2.hosts['lane-host'],
      runner,
    },
  },
});

const withMaxLanes = (maxLanes: unknown) =>
  withRunner({ ...validV2.hosts['lane-host'].runner, maxLanes });

describe('parseInstallation runner.maxLanes parse edges (CL-14)', () => {
  it('refuses maxLanes values that are not integers 1 or greater', () => {
    for (const maxLanes of [0, -1, 1.5, '2', null, true]) {
      expect(parseInstallation(withMaxLanes(maxLanes))).toEqual({
        ok: false,
        errors: ['hosts.lane-host.runner.maxLanes: must be an integer 1 or greater'],
      });
    }
  });

  it('accepts the 1 and 64 maxLanes bounds as numbers', () => {
    for (const maxLanes of [1, 64]) {
      const result = parseInstallation(withMaxLanes(maxLanes));
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.installation.hosts?.['lane-host']?.runner?.maxLanes).toBe(maxLanes);
    }
  });

  it('omits maxLanes on the runner when the key is absent', () => {
    const result = parseInstallation(validV2);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.installation.hosts?.['lane-host']?.runner).not.toHaveProperty('maxLanes');
  });

  it('reports the same error for an agy runner', () => {
    const agyRunner = { kind: 'agy', port: 46000, agyMode: 'edit-only' };
    expect(parseInstallation(withRunner({ ...agyRunner, maxLanes: 0 }))).toEqual({
      ok: false,
      errors: ['hosts.lane-host.runner.maxLanes: must be an integer 1 or greater'],
    });
  });
});
