/**
 * CO14 follow-up: `--root` is bound to the state directory of the driver that
 * serves that root. The release reads the lease of the state directory the
 * installation records for the root (`daemon.stateDir`), never the
 * process-wide one, so a release under another state directory cannot miss a
 * live lease. When the root's driver state directory cannot be determined the
 * release refuses with `release-root-state-dir-unknown`, writes nothing under
 * the root and starts no build.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConductorDriverLeaseAdapter, ReleaseStoreAdapter } from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import { resolveRootStateDir, type ReleaseDriverConfiguration } from '../release.js';

const SHA = 'a'.repeat(40);

let dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  const pending = dirs;
  dirs = [];
  await Promise.all(pending.map((dir) => rm(dir, { recursive: true, force: true })));
});

function installationWithDaemonStateDir(stateDir: string): ReleaseDriverConfiguration {
  return {
    daemon: { stateDir },
  } as ReleaseDriverConfiguration;
}

describe('release root state directory binding (CO14 follow-up)', () => {
  it('refuses when the root\'s driver state directory cannot be determined', async () => {
    const root = await tempDir('co14-release-root-');
    // A runtime with no installation at all: no state directory can be resolved.
    const rt = createFleetCliRuntime();
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ['release', 'swap', '--root', root, '--sha', SHA, '--project', 'p', '--apply'],
      { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      rt,
    );
    expect(code).toBe(1);
    expect(err.join('')).toBe('');
    expect(JSON.parse(out.join(''))).toEqual({
      outcome: 'refused',
      reason: 'release-root-state-dir-unknown',
    });
    // Nothing was created under the root.
    expect(await readdir(root)).toEqual([]);
  });

  it('a release under another state directory cannot miss a live lease', async () => {
    const root = await tempDir('co14-release-root-');
    const servingStateDir = await tempDir('co14-state-a-');
    const otherStateDir = await tempDir('co14-state-b-');
    // The installation records state directory A as the driver state directory
    // serving the root; the process's own state directory is B.
    const rt: FleetCliRuntime = createFleetCliRuntime({
      stateDir: otherStateDir,
      installation: installationWithDaemonStateDir(servingStateDir) as never,
    });
    // A live driver lease is held in the serving state directory A.
    const holder = new ConductorDriverLeaseAdapter({ stateDir: servingStateDir });
    const now = new Date();
    const acquired = await holder.acquire({
      holderId: 'driver-1',
      observedFence: 0,
      leaseUntilIso: new Date(now.getTime() + 60_000).toISOString(),
      nowIso: now.toISOString(),
    });
    expect(acquired.outcome).toBe('ok');
    // The swap target exists as a verified build in the root, so the release
    // reaches the lease fence and must be refused by the lease in A.
    const store = new ReleaseStoreAdapter();
    const staging = await store.prepare({ root, sha: SHA });
    if (staging.outcome !== 'prepared') throw new Error('prepare failed');
    const entry = join(staging.buildDir, 'apps', 'cli', 'dist');
    await mkdir(entry, { recursive: true });
    await writeFile(join(entry, 'bin.js'), '// built\n');
    expect(await store.markVerified({ root, sha: SHA, buildId: staging.buildId, builtAtIso: now.toISOString() })).toEqual({ outcome: 'ok' });
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ['release', 'swap', '--root', root, '--sha', SHA, '--project', 'p', '--apply'],
      { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      rt,
    );
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'refused', reason: 'driver-lease-live' });
    expect(err.join('')).toBe('');
  });

  it('the binding is a pure (root, configuration) mapping', () => {
    expect(resolveRootStateDir('/srv/releases', installationWithDaemonStateDir('/srv/state'))).toBe(
      '/srv/state',
    );
    expect(resolveRootStateDir('/srv/releases', { daemon: { stateDir: 'relative' } })).toBeNull();
    expect(resolveRootStateDir('/srv/releases', { daemon: {} })).toBeNull();
    expect(resolveRootStateDir('/srv/releases', undefined)).toBeNull();
    const getterConfiguration = {
      get daemon(): { stateDir: string } {
        throw new Error('getter ran');
      },
    };
    expect(resolveRootStateDir('/srv/releases', getterConfiguration)).toBeNull();
  });
});
