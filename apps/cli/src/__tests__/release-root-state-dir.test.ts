/**
 * CO14b 4.2: the release is bound to the state directory of the driver that
 * serves its root. When that directory cannot be determined the release
 * refuses `release-root-state-dir-unknown` with exit 1 and writes nothing
 * under the root. A release under another state directory can never miss a
 * live lease: the lease is read from the root's own state directory, never
 * from the process-wide one.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConductorDriverLeaseAdapter, ReleaseStoreAdapter } from '@fleet/work-execution';
import type { FleetInstallation } from '@fleet/installation';

import { createFleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import { resolveReleaseRootStateDir } from '../release.js';

const SHA = 'a'.repeat(40);
const PROJECT = 'fleet-v2';
const NOW = '2026-11-06T10:00:00.000Z';

function installationWithDriverStateDir(stateDir: string, servedRoot: string): FleetInstallation {
  return {
    schemaVersion: 2,
    forge: { mode: 'none' },
    hosts: {
      here: {
        transport: 'local',
        worktreeRoot: '/tmp/wt',
        roles: ['orchestrator', 'lane-runner', 'verifier'],
        runner: { kind: 'opencode', port: 4166 },
      },
    },
    daemon: {
      stateDir,
      nodePath: '/x',
      cliPath: `${servedRoot}/current/apps/cli/dist/bin.js`,
      unitDir: '/x',
      installationFile: '/x',
    },
  };
}

describe('release root state directory binding', () => {
  let tempDir: string;
  let releaseRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-release-root-state-test-'));
    releaseRoot = path.join(tempDir, 'releases');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function runRelease(argv: readonly string[], rt: ReturnType<typeof createFleetCliRuntime>): Promise<{
    code: number;
    out: string[];
    err: string[];
  }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ['release', ...argv],
      { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      rt,
    );
    return { code, out, err };
  }

  it('release refuses when the root’s driver state directory cannot be determined', async () => {
    // No installation records a driver state directory, so the root's state
    // directory cannot be determined: refuse before any work.
    const rt = createFleetCliRuntime();
    const { code, out, err } = await runRelease(
      ['install', '--root', releaseRoot, '--sha', SHA, '--source', '/src', '--project', PROJECT, '--apply'],
      rt,
    );
    expect(err.join('')).toBe('');
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'refused', reason: 'release-root-state-dir-unknown' });
    // Nothing was created under the root.
    await expect(fs.lstat(releaseRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a release under another state directory cannot miss a live lease', async () => {
    const stateA = path.join(tempDir, 'state-a');
    const stateB = path.join(tempDir, 'state-b');
    // The release root holds a verified build for the swap target, so the
    // only thing that can refuse the swap at this point is the live lease.
    const store = new ReleaseStoreAdapter();
    const prepared = await store.prepare({ root: releaseRoot, sha: SHA });
    if (prepared.outcome !== 'prepared') {
      throw new Error('prepare refused');
    }
    const cliEntry = path.join(prepared.buildDir, 'apps', 'cli', 'dist');
    await fs.mkdir(cliEntry, { recursive: true });
    await fs.writeFile(path.join(cliEntry, 'bin.js'), '// cli\n');
    expect(await store.markVerified({ root: releaseRoot, sha: SHA, buildId: prepared.buildId, builtAtIso: NOW })).toEqual({
      outcome: 'ok',
    });
    // A live lease in A, the state directory of the driver that serves the
    // root. Held against the real clock, because the CLI reads the lease with
    // the real clock when it runs.
    const nowIso = new Date().toISOString();
    const leaseUntilIso = new Date(Date.parse(nowIso) + 5 * 60 * 1000).toISOString();
    const leaseA = new ConductorDriverLeaseAdapter({ stateDir: stateA });
    expect(await leaseA.acquire({ holderId: 'driver-x', observedFence: 0, leaseUntilIso, nowIso })).toMatchObject({
      outcome: 'ok',
    });

    const argv = ['swap', '--root', releaseRoot, '--sha', SHA, '--project', PROJECT, '--apply'];

    // The process's own state directory is B (no lease there), but the root is
    // served by A: the lease is read from A and the swap is refused.
    const withProcessStateB = createFleetCliRuntime({
      stateDir: stateB,
      installation: installationWithDriverStateDir(stateA, releaseRoot),
    });
    const fromA = await runRelease(argv, withProcessStateB);
    expect(fromA.code).toBe(1);
    expect(JSON.parse(fromA.out.join(''))).toEqual({ outcome: 'refused', reason: 'driver-lease-live' });

    // Running with the process state directory also set to A is refused the
    // same way: the live lease in A blocks both runs.
    const withProcessStateA = createFleetCliRuntime({
      stateDir: stateA,
      installation: installationWithDriverStateDir(stateA, releaseRoot),
    });
    const fromB = await runRelease(argv, withProcessStateA);
    expect(fromB.code).toBe(1);
    expect(JSON.parse(fromB.out.join(''))).toEqual({ outcome: 'refused', reason: 'driver-lease-live' });
  });

  it('resolveReleaseRootStateDir is root-aware: a non-absolute root binds no driver state directory', () => {
    const installation = installationWithDriverStateDir(path.join(tempDir, 'state'), releaseRoot);
    expect(resolveReleaseRootStateDir('relative/root', installation)).toBeNull();
    expect(resolveReleaseRootStateDir('', installation)).toBeNull();
    expect(resolveReleaseRootStateDir('/a/../b', installation)).toBeNull();
    expect(resolveReleaseRootStateDir(releaseRoot, installation)).toBe(path.join(tempDir, 'state'));
    expect(resolveReleaseRootStateDir(releaseRoot, undefined)).toBeNull();
  });

  it('an absolute root this installation does not serve is refused', async () => {
    const stateA = path.join(tempDir, 'state-a');
    const otherRoot = path.join(tempDir, 'someone-elses-releases');
    const installation = installationWithDriverStateDir(stateA, releaseRoot);
    expect(resolveReleaseRootStateDir(otherRoot, installation)).toBeNull();
    expect(resolveReleaseRootStateDir(`${releaseRoot}-sibling`, installation)).toBeNull();
    const rt = createFleetCliRuntime({ stateDir: stateA, installation });
    const { code, out } = await runRelease(
      ['install', '--root', otherRoot, '--sha', SHA, '--source', '/src', '--project', PROJECT, '--apply'],
      rt,
    );
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'refused', reason: 'release-root-state-dir-unknown' });
    await expect(fs.lstat(otherRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
