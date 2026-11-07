/**
 * CO14b 4.3: a release grant is bound to the root it names. A grant resolved
 * for root R authorizes only an operation on root R; any other root is refused
 * with `release-grant-root-mismatch` before anything is built, repointed or
 * consumed, and a consumed grant never authorizes a second release.
 *
 * The grant path is the real `ActionAuthorizationAdapter` (the same
 * `ActionAuthorizationPort` implementation CO14 resolves `release:install`
 * through) over a real grant map, with the real `ReleaseStoreAdapter` and the
 * real `ConductorDriverLeaseAdapter`.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../ports/out/CommandExecutorPort.out-port.js';
import {
  ActionAuthorizationAdapter,
  type ActionAuthorizationGrantEntry,
} from '../../../infrastructure/adapters/ActionAuthorizationAdapter.adapter.js';
import { ConductorDriverLeaseAdapter } from '../../../infrastructure/adapters/ConductorDriverLeaseAdapter.adapter.js';
import { ReleaseStoreAdapter } from '../../../infrastructure/adapters/ReleaseStoreAdapter.adapter.js';
import { ManageReleaseUseCase } from '../ManageReleaseUseCase.use-case.js';

const A = 'a'.repeat(40);
const NOW = '2026-11-06T10:00:00.000Z';
const PROJECT = 'fleet-v2';

class RecordingExecutor implements CommandExecutorPort {
  readonly runs: string[][] = [];
  async run(argv: readonly string[], _options?: CommandRunOptions): Promise<CommandRunResult> {
    this.runs.push([...argv]);
    return { exitCode: 0, signal: null, stdout: '', stderr: '' };
  }
}

describe('release grant root binding', () => {
  let tempDir: string;
  let rootA: string;
  let rootB: string;
  let leaseStateDir: string;
  let store: ReleaseStoreAdapter;
  let grants: Map<string, ActionAuthorizationGrantEntry>;
  let executor: RecordingExecutor;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-release-grant-root-test-'));
    rootA = path.join(tempDir, 'root-a');
    rootB = path.join(tempDir, 'root-b');
    leaseStateDir = path.join(tempDir, 'lease-state');
    store = new ReleaseStoreAdapter();
    grants = new Map<string, ActionAuthorizationGrantEntry>();
    executor = new RecordingExecutor();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function verified(root: string, digit: string, _day: number): Promise<string> {
    const id = digit.repeat(40);
    const prepared = await store.prepare({ root, sha: id });
    if (prepared.outcome !== 'prepared') {
      throw new Error(`prepare refused for ${id}`);
    }
    const entry = path.join(prepared.buildDir, 'apps', 'cli', 'dist');
    await fs.mkdir(entry, { recursive: true });
    await fs.writeFile(path.join(entry, 'bin.js'), '// cli\n');
    expect(await store.markVerified({ root, sha: id, buildId: prepared.buildId, builtAtIso: NOW })).toEqual({
      outcome: 'ok',
    });
    return id;
  }

  function releaseGrant(root: string, kind: 'release-install' | 'release-swap', head: string): void {
    grants.set('grant-1', {
      expectedHeadSha: head,
      kind,
      root,
      consumedByActionId: null,
    });
  }

  function useCase() {
    return new ManageReleaseUseCase({
      store,
      lease: new ConductorDriverLeaseAdapter({ stateDir: leaseStateDir }),
      authorization: new ActionAuthorizationAdapter({ grants }),
      executor,
      nowIso: () => NOW,
      env: () => ({ PATH: '/usr/bin' }),
    });
  }

  it('a grant for one root cannot authorize another root', async () => {
    await verified(rootA, 'a', 1);
    releaseGrant(rootA, 'release-install', A);

    const result = await useCase().manageRelease({
      action: 'install',
      root: rootB,
      sha: A,
      source: '/src',
      keep: 3,
      apply: true,
      projectId: PROJECT,
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'release-grant-root-mismatch' });
    // Nothing was built under root B and the grant was not consumed.
    await expect(fs.lstat(path.join(rootB, A))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(grants.get('grant-1')?.consumedByActionId).toBeNull();
    expect(executor.runs).toEqual([]);
  });

  it('a grant for the root it names authorizes that root and is consumed once', async () => {
    await verified(rootA, 'a', 1);
    releaseGrant(rootA, 'release-install', A);

    const result = await useCase().manageRelease({
      action: 'install',
      root: rootA,
      sha: A,
      source: '/src',
      keep: 3,
      apply: true,
      projectId: PROJECT,
    });

    expect(result).toMatchObject({ outcome: 'applied', action: 'install', target: A, current: A });
    expect(await store.list({ root: rootA })).toMatchObject({ outcome: 'read', current: A });
    expect(grants.get('grant-1')?.consumedByActionId).not.toBeNull();
  });

  it('a consumed grant does not authorize a second release', async () => {
    await verified(rootA, 'a', 1);
    releaseGrant(rootA, 'release-install', A);
    const uc = useCase();
    const first = await uc.manageRelease({
      action: 'install',
      root: rootA,
      sha: A,
      source: '/src',
      keep: 3,
      apply: true,
      projectId: PROJECT,
    });
    expect(first.outcome).toBe('applied');

    const second = await uc.manageRelease({
      action: 'install',
      root: rootA,
      sha: A,
      source: '/src',
      keep: 3,
      apply: true,
      projectId: PROJECT,
    });

    expect(second.outcome).toBe('refused');
    // The consumed grant was not re-authorised and current still points at A.
    expect(await store.list({ root: rootA })).toMatchObject({ outcome: 'read', current: A });
  });
});
