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

const withGateSlot = (gateSlot: unknown) => ({
  ...validV2,
  hosts: {
    ...validV2.hosts,
    'lane-host': {
      ...validV2.hosts['lane-host'],
      runner: { ...validV2.hosts['lane-host'].runner, gateSlot },
    },
  },
});

describe('parseInstallation runner.gateSlot parse edges (CL-11)', () => {
  it('refuses a gateSlot that is null, an array or not an object', () => {
    for (const gateSlot of [null, [], 'x']) {
      expect(parseInstallation(withGateSlot(gateSlot))).toEqual({
        ok: false,
        errors: ['hosts.lane-host.runner.gateSlot: must be an object'],
      });
    }
  });

  it('refuses slot counts that are not integers 1 or greater', () => {
    for (const slots of [1.5, '8', -1]) {
      expect(parseInstallation(withGateSlot({ path: '/usr/local/bin/gate-slot', slots }))).toEqual({
        ok: false,
        errors: ['hosts.lane-host.runner.gateSlot.slots: must be an integer 1 or greater'],
      });
    }
  });

  it('refuses a missing, non-string or empty path', () => {
    expect(parseInstallation(withGateSlot({ slots: 8 }))).toEqual({
      ok: false,
      errors: ['hosts.lane-host.runner.gateSlot.path: required'],
    });
    for (const path of [5, '']) {
      expect(parseInstallation(withGateSlot({ path, slots: 8 }))).toEqual({
        ok: false,
        errors: ['hosts.lane-host.runner.gateSlot.path: must be an absolute path'],
      });
    }
  });

  it('accepts the 1 and 4096 slot bounds', () => {
    for (const slots of [1, 4096]) {
      expect(
        parseInstallation(withGateSlot({ path: '/usr/local/bin/gate-slot', slots })).ok,
      ).toBe(true);
    }
  });

  it('trims a path padded with spaces', () => {
    const result = parseInstallation(
      withGateSlot({ path: '  /usr/local/bin/gate-slot  ', slots: 8 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.installation.hosts?.['lane-host']?.runner?.gateSlot).toEqual({
      path: '/usr/local/bin/gate-slot',
      slots: 8,
    });
  });
});
