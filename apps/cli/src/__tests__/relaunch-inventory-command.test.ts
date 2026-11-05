/**
 * CLI-boundary tests for CO26: `relaunch inventory` (read-only). One test
 * runs the real composition with no state directory and no installation and
 * proves the wiring: zero profiles means zero clones, so no git command is
 * ever spawned. The other two use a recording fake runtime: the host filter
 * and the clone refs built from the active profile's clones are passed
 * through unchanged, and `relaunch` without a subcommand is a usage error.
 */

import { describe, expect, it } from 'vitest';

import type { ProjectProfileRecord } from '@fleet/operator-coordination';
import type { InventoryRelaunchRequest } from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';

const NOW = '2026-10-31T00:00:00.000Z';

const ACTIVE_PROFILE: ProjectProfileRecord = {
  projectId: 'proj-1',
  displayName: 'Project One',
  repository: 'example-owner/example-repo',
  designatedDispatcherHost: 'lane-host',
  policyRevision: 'pol-1',
  maxConcurrentLanes: 2,
  runnerCapabilities: {},
  revision: 1,
  updatedAtIso: NOW,
  status: 'active',
  defaultBranch: 'main',
  clones: {
    'lane-host': { path: '/clones/repo', worktreeRoot: '/clones/repo-worktrees' },
  },
  gateProcedures: [],
  defaultAllowedPathPrefixes: [],
  lastProbe: null,
};

function collectIo(): {
  out: string[];
  err: string[];
  io: { stdout: (t: string) => void; stderr: (t: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
  };
}

describe('relaunch inventory', () => {
  it('exits 0 against a real empty runtime and prints one empty inventoried document', async () => {
    const { io, out } = collectIo();
    const runtime = createFleetCliRuntime({});

    const code = await runCli(['relaunch', 'inventory'], io, runtime);

    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.outcome).toBe('inventoried');
    expect(parsed.hosts).toEqual([]);
    expect(parsed.conductor.driverLease).toBe('absent');
  });

  it('passes the host filter and clone refs built from active profiles, printing the result unchanged', async () => {
    const { io, out } = collectIo();
    let captured: InventoryRelaunchRequest | undefined;
    const result = {
      outcome: 'inventoried',
      nowIso: NOW,
      conductor: { halted: false, driverLease: 'absent', runCount: 0 },
      riskFlags: [],
      hosts: [],
    };
    const runtime = {
      coordination: {
        listProjectProfiles: {
          listProjectProfiles: async () => ({
            outcome: 'listed',
            profiles: [ACTIVE_PROFILE],
          }),
        },
      },
      execution: {
        inventoryRelaunch: {
          inventoryRelaunch: async (request: InventoryRelaunchRequest) => {
            captured = request;
            return result;
          },
        },
      },
    } as unknown as FleetCliRuntime;

    const code = await runCli(['relaunch', 'inventory', '--host', 'lane-host'], io, runtime);

    expect(code).toBe(0);
    expect(captured?.hostName).toBe('lane-host');
    expect(captured?.clones).toHaveLength(1);
    expect(captured?.clones[0]).toEqual({
      projectId: 'proj-1',
      hostName: 'lane-host',
      clonePath: '/clones/repo',
      worktreeRoot: '/clones/repo-worktrees',
      recordedHost: null,
    });
    expect(JSON.parse(out.join(''))).toEqual(result);
  });

  it('exits 2 when relaunch is run without a subcommand', async () => {
    const { io, err } = collectIo();
    const runtime = createFleetCliRuntime({});

    const code = await runCli(['relaunch'], io, runtime);

    expect(code).toBe(2);
    expect(err.join('')).toContain('Subcommands: inventory');
  });
});
