/**
 * CO14 follow-up, item 4.1: a release install and a swap driven end to end
 * through the same use case the CLI drives, over a real recorded
 * `release:install` grant, the real `ConductorDriverLeaseAdapter` and the real
 * `ReleaseStoreAdapter` — none of the three is mocked. The only stand-in is
 * the command executor, which performs the file effects the four reviewed
 * build steps would (the tree, the marker entry) without running yarn.
 */

import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ActionAuthorizationAdapter,
  ConductorDriverLeaseAdapter,
  ManageReleaseUseCase,
  ReleaseStoreAdapter,
  consumptionId,
  releaseActionScope,
  type CommandExecutorPort,
  type CommandRunOptions,
  type CommandRunResult,
} from '@fleet/work-execution';
import { CoordinationRequestRepositoryAdapter } from '../../../../../operator-coordination/src/infrastructure/adapters/CoordinationRequestRepositoryAdapter.adapter.js';
import { RecordAuthorizationConsumptionUseCase } from '../../../../../operator-coordination/src/application/use-cases/RecordAuthorizationConsumptionUseCase.use-case.js';
import { ResolveActionAuthorizationUseCase } from '../../../../../operator-coordination/src/application/use-cases/ResolveActionAuthorizationUseCase.use-case.js';
import type { CoordinationRequestRecord } from '../../../../../operator-coordination/src/domain/coordination-records.js';

const NOW = '2026-11-10T10:00:00.000Z';

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

/** The executor stand-in: the build step leaves the CLI entry the marker check requires. */
class ScriptedBuildExecutor implements CommandExecutorPort {
  readonly argvs: string[][] = [];
  async run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
    this.argvs.push([...argv]);
    if (argv[0] === 'yarn' && argv[1] === 'build' && options?.cwd !== undefined) {
      const entry = join(options.cwd, 'apps', 'cli', 'dist');
      await mkdir(entry, { recursive: true });
      await writeFile(join(entry, 'bin.js'), '// built\n');
    }
    return { exitCode: 0, signal: null, stdout: '', stderr: '' };
  }
}

/** A recorded, approved, unconsumed owner grant for one release scope at one head, bound to one root. */
function releaseGrant(grantId: string, scope: string, sha: string, root: string): CoordinationRequestRecord {
  return {
    id: `req-${grantId}`,
    projectId: 'p',
    kind: 'action-decision',
    state: 'approved',
    actionScope: scope,
    expectedHeadSha: sha,
    proposalDigest: 'prop-1',
    policyRevision: 'pol-1',
    decisionRevision: 'dec-1',
    grantId,
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'delivered',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    releaseRoot: root,
  } as CoordinationRequestRecord;
}

interface Harness {
  readonly useCase: ManageReleaseUseCase;
  readonly authorization: ActionAuthorizationAdapter;
  readonly executor: ScriptedBuildExecutor;
  readonly lease: ConductorDriverLeaseAdapter;
  readonly store: ReleaseStoreAdapter;
  readonly grants: CoordinationRequestRepositoryAdapter;
  readonly root: string;
  readonly stateDir: string;
}

async function harness(storeOverride?: ReleaseStoreAdapter): Promise<Harness> {
  const stateDir = await tempDir('co14b-state-');
  const root = await tempDir('co14b-root-');
  const grants = new CoordinationRequestRepositoryAdapter({ stateDir });
  // The real grant path: the same adapter-over-coordination-use-cases wiring the CLI uses.
  const authorization = new ActionAuthorizationAdapter({
    resolveGrant: async (request) => {
      const actionScope = releaseActionScope(request.actionKind);
      if (actionScope === null) {
        return { outcome: 'blocked', reason: 'not a release action' };
      }
      const result = await new ResolveActionAuthorizationUseCase({ requestRepo: grants }).resolveActionAuthorization({
        projectId: request.projectId,
        actionScope,
        expectedHeadSha: request.expectedHeadSha,
        attemptId: request.attemptId,
        releaseRoot: request.releaseRoot,
        resumeActionId: request.actionId,
      });
      return result.outcome === 'authorized'
        ? {
            outcome: 'granted',
            authorizationGrantId: result.grantId,
            ...(result.releaseRoot !== undefined ? { releaseRoot: result.releaseRoot } : {}),
          }
        : { outcome: 'blocked', reason: result.reason };
    },
    consumeGrant: async (request) => {
      const actionScope = releaseActionScope(request.actionKind);
      if (actionScope === null || request.expectedHeadSha === undefined) {
        return { outcome: 'refused', reason: 'not a release grant consumption' };
      }
      const result = await new RecordAuthorizationConsumptionUseCase({ requestRepo: grants }).recordAuthorizationConsumption({
        consumptionId: consumptionId(request.actionId),
        grantId: request.authorizationGrantId,
        actionId: request.actionId,
        actionScope,
        attemptId: request.attemptId ?? request.actionId,
        expectedHeadSha: request.expectedHeadSha,
        releaseRoot: request.releaseRoot,
      });
      return result.outcome === 'consumed'
        ? { outcome: 'consumed', actionId: request.actionId }
        : { outcome: 'refused', reason: result.reason };
    },
  });
  const executor = new ScriptedBuildExecutor();
  const useCase = new ManageReleaseUseCase({
    store: storeOverride ?? new ReleaseStoreAdapter(),
    lease: new ConductorDriverLeaseAdapter({ stateDir }),
    authorization,
    executor,
    nowIso: () => NOW,
    env: () => ({ PATH: '/usr/bin' }),
  });
  return { useCase, authorization, executor, lease: new ConductorDriverLeaseAdapter({ stateDir }), store: new ReleaseStoreAdapter(), grants, root, stateDir };
}

const shaOf = (c: string) => c.repeat(40);

describe('release install and swap end to end (CO14 follow-up, real grant, real lease, real store)', () => {
  let h: Harness;
  const shaA = shaOf('a');
  const shaB = shaOf('b');

  beforeEach(async () => {
    h = await harness();
  });

  it('install stages the build and leaves current unmoved; swap repoints current atomically', async () => {
    await h.grants.saveRequest(releaseGrant('grant-a', 'release:install', shaA, h.root));
    const installA = await h.useCase.manageRelease({
      action: 'install',
      root: h.root,
      sha: shaA,
      source: h.root,
      keep: 5,
      apply: true,
      projectId: 'p',
    });
    expect(installA.outcome).toBe('applied');
    // <root>/<sha> exists and is a verified build; `current` is untouched.
    expect(await readFile(join(h.root, shaA, '.fleet-release-verified'), 'utf8')).toContain(shaA);
    expect(await readlinkSha(h.root)).toBeNull();
    // The grant was consumed exactly once.
    expect((await h.grants.findRequestByGrantId('grant-a'))?.consumptions).toHaveLength(1);

    await h.grants.saveRequest(releaseGrant('grant-b', 'release:install', shaB, h.root));
    const installB = await h.useCase.manageRelease({
      action: 'install',
      root: h.root,
      sha: shaB,
      source: h.root,
      keep: 5,
      apply: true,
      projectId: 'p',
    });
    expect(installB.outcome).toBe('applied');
    const afterInstall = await h.store.list({ root: h.root });
    expect(afterInstall.outcome).toBe('read');
    if (afterInstall.outcome === 'read') {
      // Install never moves `current`, not even when it is already set.
      expect(afterInstall.current).toBeNull();
      expect(afterInstall.builds.map((build) => build.sha).sort()).toEqual([shaA, shaB].sort());
    }

    await h.grants.saveRequest(releaseGrant('grant-swap', 'release:swap', shaA, h.root));
    const swap = await h.useCase.manageRelease({
      action: 'swap',
      root: h.root,
      sha: shaA,
      source: null,
      keep: 5,
      apply: true,
      projectId: 'p',
    });
    expect(swap.outcome).toBe('applied');
    // The repoint is a symlink to the target; the previous build survived.
    expect(await readlinkSha(h.root)).toBe(shaA);
    expect(await h.store.list({ root: h.root })).toMatchObject({
      outcome: 'read',
      current: shaA,
      builds: expect.arrayContaining([
        expect.objectContaining({ sha: shaB }),
      ]),
    });
  });

  it('a second release for another target and an identical second release are both refused by the consumed grant', async () => {
    await h.grants.saveRequest(releaseGrant('grant-a', 'release:install', shaA, h.root));
    const first = await h.useCase.manageRelease({
      action: 'install',
      root: h.root,
      sha: shaA,
      source: h.root,
      keep: 5,
      apply: true,
      projectId: 'p',
    });
    expect(first.outcome).toBe('applied');
    const second = await h.useCase.manageRelease({
      action: 'install',
      root: h.root,
      sha: shaB,
      source: h.root,
      keep: 5,
      apply: true,
      projectId: 'p',
    });
    expect(second).toEqual({ outcome: 'refused', reason: 'authority-refused' });
    expect((await h.grants.findRequestByGrantId('grant-a'))?.consumptions).toHaveLength(1);
    // The brief: a second identical release is refused by the consumed grant,
    // never re-authorized. The operation is complete, so nothing resumes it.
    const replay = await h.useCase.manageRelease({
      action: 'install',
      root: h.root,
      sha: shaA,
      source: h.root,
      keep: 5,
      apply: true,
      projectId: 'p',
    });
    expect(replay).toEqual({ outcome: 'refused', reason: 'authority-refused' });
    expect((await h.grants.findRequestByGrantId('grant-a'))?.consumptions).toHaveLength(1);
    expect(await h.store.list({ root: h.root })).toMatchObject({ outcome: 'read', current: null });
  });

  const apply = (action: 'install' | 'swap' | 'rollback', sha: string | null) =>
    h.useCase.manageRelease({
      action,
      root: h.root,
      sha,
      source: action === 'install' ? h.root : null,
      keep: 5,
      apply: true,
      projectId: 'p',
    });

  async function installBuilds(...shas: string[]): Promise<void> {
    for (const sha of shas) {
      await h.grants.saveRequest(releaseGrant(`grant-install-${sha[0]}`, 'release:install', sha, h.root));
      expect((await apply('install', sha)).outcome).toBe('applied');
    }
  }

  it('swap A, swap B, swap A again with no new grant: the third is refused and current stays on B', async () => {
    await installBuilds(shaA, shaB);
    await h.grants.saveRequest(releaseGrant('grant-swap-a', 'release:swap', shaA, h.root));
    await h.grants.saveRequest(releaseGrant('grant-swap-b', 'release:swap', shaB, h.root));
    expect((await apply('swap', shaA)).outcome).toBe('applied');
    expect((await apply('swap', shaB)).outcome).toBe('applied');
    expect(await readlinkSha(h.root)).toBe(shaB);
    expect(await apply('swap', shaA)).toEqual({ outcome: 'refused', reason: 'authority-refused' });
    expect(await readlinkSha(h.root)).toBe(shaB);
    expect((await h.grants.findRequestByGrantId('grant-swap-a'))?.consumptions).toHaveLength(1);
  });

  it('a rollback replay with no new grant is refused', async () => {
    const shaC = shaOf('c');
    await installBuilds(shaA, shaB, shaC);
    await h.grants.saveRequest(releaseGrant('grant-swap-c', 'release:swap', shaC, h.root));
    await h.grants.saveRequest(releaseGrant('grant-rollback-b', 'release:rollback', shaB, h.root));
    expect((await apply('swap', shaC)).outcome).toBe('applied');
    expect((await apply('rollback', null)).outcome).toBe('applied');
    expect(await readlinkSha(h.root)).toBe(shaB);
    await h.grants.saveRequest(releaseGrant('grant-swap-c2', 'release:swap', shaC, h.root));
    expect((await apply('swap', shaC)).outcome).toBe('applied');
    expect(await readlinkSha(h.root)).toBe(shaC);
    // The same rollback again, with the grant already spent: refused, current unmoved.
    expect(await apply('rollback', null)).toEqual({ outcome: 'refused', reason: 'authority-refused' });
    expect(await readlinkSha(h.root)).toBe(shaC);
  });

  it('install of a pruned sha with a spent grant is refused and no build script runs', async () => {
    await installBuilds(shaA);
    const ran = h.executor.argvs.length;
    await rm(join(h.root, shaA), { recursive: true, force: true });
    expect(await apply('install', shaA)).toEqual({ outcome: 'refused', reason: 'authority-refused' });
    expect(h.executor.argvs).toHaveLength(ran);
  });

  it('a genuine crash between consume and repoint resumes exactly once, then refuses', async () => {
    await installBuilds(shaA, shaB);
    await h.grants.saveRequest(releaseGrant('grant-swap-a', 'release:swap', shaA, h.root));
    // First run: the repoint crashes after the grant was consumed.
    const crashingUseCase = new ManageReleaseUseCase({
      store: new (class extends ReleaseStoreAdapter {
        override async repoint(): Promise<never> {
          throw new Error('crash');
        }
      })(),
      lease: new ConductorDriverLeaseAdapter({ stateDir: h.stateDir }),
      authorization: h.authorization,
      executor: h.executor,
      nowIso: () => NOW,
      env: () => ({ PATH: '/usr/bin' }),
    });
    const crashed = await crashingUseCase.manageRelease({
      action: 'swap', root: h.root, sha: shaA, source: null, keep: 5, apply: true, projectId: 'p',
    });
    expect(crashed.outcome).toBe('refused');
    expect(await readlinkSha(h.root)).toBeNull();
    expect((await h.grants.findRequestByGrantId('grant-swap-a'))?.consumptions).toHaveLength(1);
    // The retry resumes the same operation exactly once and completes it.
    expect((await apply('swap', shaA)).outcome).toBe('applied');
    expect(await readlinkSha(h.root)).toBe(shaA);
    expect((await h.grants.findRequestByGrantId('grant-swap-a'))?.consumptions).toHaveLength(1);
    // Once completed, the same grant is refused for any further operation.
    await apply('swap', shaB).then((r) => expect(r.outcome).toBe('refused'));
    expect(await apply('swap', shaA)).toEqual({ outcome: 'refused', reason: 'authority-refused' });
    expect(await readlinkSha(h.root)).toBe(shaA);
  });

  it('two concurrent identical requests: exactly one proceeds', async () => {
    await h.grants.saveRequest(releaseGrant('grant-install-a', 'release:install', shaA, h.root));
    const results = await Promise.all([apply('install', shaA), apply('install', shaA)]);
    expect(results.filter((r) => r.outcome === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'refused')).toHaveLength(1);
    expect((await h.grants.findRequestByGrantId('grant-install-a'))?.consumptions).toHaveLength(1);
  });

  it('the swap removes an orphaned repoint temp link under the lease and never a build or current', async () => {
    await installBuilds(shaA, shaB);
    await symlink(shaA, join(h.root, '.current.orphan.tmp'));
    await h.grants.saveRequest(releaseGrant('grant-swap-a', 'release:swap', shaA, h.root));
    expect((await apply('swap', shaA)).outcome).toBe('applied');
    const names = await readdir(h.root);
    expect(names).not.toContain('.current.orphan.tmp');
    expect(names).toEqual(expect.arrayContaining(['current', shaA, shaB]));
  });

  it('a live driver lease in the root\'s state directory refuses the swap and current stays on the old build', async () => {
    await h.grants.saveRequest(releaseGrant('grant-a', 'release:install', shaA, h.root));
    await h.useCase.manageRelease({
      action: 'install',
      root: h.root,
      sha: shaA,
      source: h.root,
      keep: 5,
      apply: true,
      projectId: 'p',
    });
    // An old verified build is already current before the lease is held.
    await h.grants.saveRequest(releaseGrant('grant-swap-old', 'release:swap', shaA, h.root));
    const firstSwap = await h.useCase.manageRelease({
      action: 'swap',
      root: h.root,
      sha: shaA,
      source: null,
      keep: 5,
      apply: true,
      projectId: 'p',
    });
    expect(firstSwap.outcome).toBe('applied');
    expect(await readlinkSha(h.root)).toBe(shaA);
    await h.grants.saveRequest(releaseGrant('grant-b', 'release:install', shaB, h.root));
    await h.useCase.manageRelease({
      action: 'install',
      root: h.root,
      sha: shaB,
      source: h.root,
      keep: 5,
      apply: true,
      projectId: 'p',
    });
    const installsRan = h.executor.argvs.length;
    // A driver holds an unexpired lease in the release's own state directory.
    const holder = new ConductorDriverLeaseAdapter({ stateDir: h.stateDir });
    const existing = await holder.read();
    const held = await holder.acquire({
      holderId: 'driver-1',
      observedFence: existing?.fence ?? 0,
      leaseUntilIso: '2026-11-10T10:05:00.000Z',
      nowIso: NOW,
    });
    expect(held.outcome).toBe('ok');
    await h.grants.saveRequest(releaseGrant('grant-swap', 'release:swap', shaB, h.root));
    const refused = await h.useCase.manageRelease({
      action: 'swap',
      root: h.root,
      sha: shaB,
      source: null,
      keep: 5,
      apply: true,
      projectId: 'p',
    });
    expect(refused).toEqual({ outcome: 'refused', reason: 'driver-lease-live' });
    // The refused swap repointed nothing: `current` still names the old verified build.
    expect(await readlinkSha(h.root)).toBe(shaA);
    expect(await h.store.list({ root: h.root })).toMatchObject({ outcome: 'read', current: shaA });
    // No build was started for the refused release.
    expect(h.executor.argvs).toHaveLength(installsRan);
  });
});

/** The sha `current` names, or null when there is no current link. */
async function readlinkSha(root: string): Promise<string | null> {
  try {
    const target = await realpath(join(root, 'current'));
    const name = target.split('/').pop() ?? null;
    return name !== null && /^[0-9a-f]{40}$/.test(name) ? name : null;
  } catch {
    return null;
  }
}
