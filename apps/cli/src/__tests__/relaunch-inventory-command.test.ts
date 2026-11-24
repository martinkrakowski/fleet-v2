/**
 * CLI-boundary tests for CO26: `relaunch inventory` (read-only). One test
 * runs the real composition with no state directory and no installation and
 * proves the wiring: zero profiles means zero clones, so no git command is
 * ever spawned. The other two use a recording fake runtime: the host filter
 * and the clone refs built from the active profile's clones are passed
 * through unchanged, and `relaunch` without a subcommand is a usage error.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';

import type { ProjectProfileRecord } from '@fleet/operator-coordination';
import type { InventoryRelaunchRequest } from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';

/** Every file under dir (recursive): its name, size and sha256 — the whole on-disk state. */
async function stateDirSnapshot(dir: string): Promise<string> {
  const names = await fs.readdir(dir, { recursive: true });
  const entries = await Promise.all(
    [...names].sort((left, right) => left.localeCompare(right)).map(async (name) => {
      const full = path.join(dir, name);
      const stat = await fs.lstat(full);
      if (stat.isFile()) {
        const digest = createHash('sha256').update(await fs.readFile(full)).digest('hex');
        return `${name} ${stat.size} ${digest}`;
      }
      return `${name}/`;
    }),
  );
  return entries.join('\n');
}

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
        listProjectProfilesReadOnly: {
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
    expect(err.join('')).toContain('Subcommands: apply, inventory');
  });
  it('refuses with exit 1 when the profile records cannot be read, never reporting zero hosts', async () => {
    const { io, out } = collectIo();
    let called = false;
    const runtime = {
      coordination: {
        listProjectProfilesReadOnly: {
          listProjectProfiles: async () => ({ outcome: 'rejected', reason: 'store unreadable' }),
        },
      },
      execution: {
        inventoryRelaunch: {
          inventoryRelaunch: async () => {
            called = true;
            return { outcome: 'inventoried' };
          },
        },
      },
    } as unknown as FleetCliRuntime;

    const code = await runCli(['relaunch', 'inventory'], io, runtime);

    expect(code).toBe(1);
    expect(called).toBe(false);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'refused', reason: 'records-unreadable' });
  });
});

/**
 * CO29a-ro2 through the real composition (`createFleetCliRuntime`): a corrupt
 * store file answers unknown or a refusal, and the state dir keeps its exact
 * names, sizes and sha256 — a read-only command never quarantines and never
 * writes. All of these fail on the pre-CO29a-ro2 behaviour.
 */
describe('relaunch inventory reads that cannot write (CO29a-ro2)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-relaunch-readonly-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('a corrupt project-profiles.json is refused and never quarantined', async () => {
    await fs.writeFile(path.join(tempDir, 'project-profiles.json'), '{ not json CANARY-bytes', 'utf8');
    const before = await stateDirSnapshot(tempDir);

    const { io, out } = collectIo();
    const runtime = createFleetCliRuntime({ stateDir: tempDir });
    const code = await runCli(['relaunch', 'inventory'], io, runtime);

    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'refused', reason: 'records-unreadable' });
    expect(await stateDirSnapshot(tempDir)).toBe(before);
  });

  it('a corrupt conductor-halt.json answers unknown and never quarantines', async () => {
    await fs.writeFile(path.join(tempDir, 'conductor-halt.json'), '{ not json CANARY-bytes', 'utf8');
    const before = await stateDirSnapshot(tempDir);

    const { io, out } = collectIo();
    const runtime = createFleetCliRuntime({ stateDir: tempDir });
    const code = await runCli(['relaunch', 'inventory'], io, runtime);

    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'unknown', reason: 'halt-unreadable' });
    expect(await stateDirSnapshot(tempDir)).toBe(before);
  });

  it('a corrupt conductor-driver-lease.json answers unknown and never quarantines', async () => {
    await fs.writeFile(
      path.join(tempDir, 'conductor-driver-lease.json'),
      '{ not json CANARY-bytes',
      'utf8',
    );
    const before = await stateDirSnapshot(tempDir);

    const { io, out } = collectIo();
    const runtime = createFleetCliRuntime({ stateDir: tempDir });
    const code = await runCli(['relaunch', 'inventory'], io, runtime);

    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'unknown', reason: 'lease-unreadable' });
    expect(await stateDirSnapshot(tempDir)).toBe(before);
  });

  it('absent halt and lease files still inventory normally', async () => {
    const { io, out } = collectIo();
    const runtime = createFleetCliRuntime({ stateDir: tempDir });
    const code = await runCli(['relaunch', 'inventory'], io, runtime);

    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.outcome).toBe('inventoried');
    expect(parsed.conductor).toEqual({ halted: false, driverLease: 'absent', runCount: 0 });
  });
});
