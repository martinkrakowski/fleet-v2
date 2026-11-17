/**
 * CO14 follow-up: `--root` is bound to the state directory of the driver that
 * serves that root. The release reads the lease of the state directory the
 * installation records for the root (`daemon.stateDir`), never the
 * process-wide one, so a release under another state directory cannot miss a
 * live lease. When the root's driver state directory cannot be determined the
 * release refuses with `release-root-state-dir-unknown`, writes nothing under
 * the root and starts no build.
 */

import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it(
    'CO14b fix round 4: a plan-only call on a fresh unbound root never binds the driver, ' +
      'and creates nothing under the root',
    async () => {
      const base = await tempDir('co14b-plan-only-base-');
      // A root that does not exist yet: a bind here would be the first thing to create it.
      const root = join(base, 'release-root');
      const stateDir = await tempDir('co14b-plan-only-state-');
      const rt: FleetCliRuntime = createFleetCliRuntime({
        stateDir,
        installation: installationWithDaemonStateDir(stateDir) as never,
      });
      const bindSpy = vi.spyOn(ReleaseStoreAdapter.prototype, 'bindDriver');
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(
        ['release', 'install', '--root', root, '--sha', SHA, '--source', root],
        { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
        rt,
      );
      expect(err.join('')).toBe('');
      expect(code).toBe(0);
      expect(JSON.parse(out.join('')).outcome).toBe('planned');
      // The early race-protection bind is for an apply only; a plan-only call never reaches it.
      expect(bindSpy).not.toHaveBeenCalled();
      // No bind means no `fs.mkdir(root, { recursive: true })` and no `.release-driver`
      // marker: the root itself was never created on disk.
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
      bindSpy.mockRestore();
    },
  );

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

  it('refuses a root bound to another installation\'s driver state directory, and writes nothing', async () => {
    const root = await tempDir('co14-release-root-');
    const boundDir = await tempDir('co14-state-bound-');
    const ownDir = await tempDir('co14-state-own-');
    expect(await new ReleaseStoreAdapter().bindDriver({ root, stateDir: boundDir })).toEqual({
      outcome: 'bound',
      stateDir: boundDir,
    });
    const before = await readdir(root);
    const rt: FleetCliRuntime = createFleetCliRuntime({
      stateDir: ownDir,
      installation: installationWithDaemonStateDir(ownDir) as never,
    });
    const out: string[] = [];
    const code = await runCli(
      ['release', 'swap', '--root', root, '--sha', SHA, '--project', 'p', '--apply'],
      { stdout: (text) => out.push(text), stderr: () => undefined },
      rt,
    );
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'refused', reason: 'release-root-state-dir-unknown' });
    expect(await readdir(root)).toEqual(before);
    // The same root under the driver it is bound to is served: the plan is printed.
    const servedRt: FleetCliRuntime = createFleetCliRuntime({
      stateDir: ownDir,
      installation: installationWithDaemonStateDir(boundDir) as never,
    });
    const planOut: string[] = [];
    await runCli(
      ['release', 'install', '--root', root, '--sha', SHA, '--source', root],
      { stdout: (text) => planOut.push(text), stderr: () => undefined },
      servedRt,
    );
    expect(JSON.parse(planOut.join('')).outcome).toBe('planned');
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

  it(
    'CO14b fix round 3: a hostile `daemon` getter on the configuration itself is never invoked, ' +
      'not merely one that throws',
    () => {
      // Unlike the throwing getter above (which a bare try/catch happens to mask whether or not
      // it is actually read), this getter succeeds and returns a value as `stateDir` so that a
      // plain `configuration?.daemon` property access — which invokes any getter it finds —
      // would NOT be caught by the surrounding try/catch and would resolve a state directory.
      // Only a descriptor check on `configuration`'s own `daemon` key, like the existing
      // descriptor check on `stateDir`, can keep this getter from running at all.
      let daemonGetterCalls = 0;
      const configuration = {
        get daemon(): { stateDir: string } {
          daemonGetterCalls += 1;
          return { stateDir: '/srv/state-from-hostile-getter' };
        },
      };
      expect(resolveRootStateDir('/srv/releases', configuration)).toBeNull();
      expect(daemonGetterCalls).toBe(0);
    },
  );
});
