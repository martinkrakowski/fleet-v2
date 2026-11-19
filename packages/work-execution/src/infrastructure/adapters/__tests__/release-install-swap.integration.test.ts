/**
 * CO14 follow-up, item 4.1: a release install and a swap driven end to end
 * through the same use case the CLI drives, over a real recorded
 * `release:install` grant, the real `ConductorDriverLeaseAdapter` and the real
 * `ReleaseStoreAdapter` — none of the three is mocked. The only stand-in is
 * the command executor, which performs the file effects the four reviewed
 * build steps would (the tree, the marker entry) without running yarn.
 */

import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
import { RequestScopedDecisionUseCase } from '../../../../../operator-coordination/src/application/use-cases/RequestScopedDecisionUseCase.use-case.js';
import { ResolveActionAuthorizationUseCase } from '../../../../../operator-coordination/src/application/use-cases/ResolveActionAuthorizationUseCase.use-case.js';
import type { CoordinationRequestRecord } from '../../../../../operator-coordination/src/domain/coordination-records.js';
import { RELEASE_GRANT_DIGEST_PREFIX } from '../../../../../operator-coordination/src/domain/coordination-records.js';
import { createSignedDecisionFixture, type SignedDecisionFixture } from '../../../application/use-cases/__tests__/signed-decision-fixture.js';

// RR1: a release grant's request id carries the digest of its coordinates
// ({ scope, projectId, expectedHeadSha, releaseRoot, nonce }), so a recorded grant
// must be saved under that id and the resolve/consume use cases must be given
// the same digest function the request id was derived with.
const digest = (payload: string): string => createHash('sha256').update(payload).digest('hex');
const NONCE = '0123456789abcdef0123456789abcdef';
const releaseGrantId = (scope: string, projectId: string, sha: string, root: string, nonce: string = NONCE): string =>
  `${RELEASE_GRANT_DIGEST_PREFIX}${digest(JSON.stringify({ scope, projectId, expectedHeadSha: sha, releaseRoot: root, nonce }))}`;

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

/**
 * The executor stand-in: the build step leaves the CLI entry the marker check
 * requires. It is told how to behave: `failStep` makes the first argv whose
 * leading words match it exit non-zero (the build is then not performed), and
 * `skipBuildOutput` lets `yarn build` succeed without leaving the CLI entry,
 * so only the verify step can catch it.
 */
class ScriptedBuildExecutor implements CommandExecutorPort {
  readonly argvs: string[][] = [];
  failStep: readonly string[] | null = null;
  skipBuildOutput = false;
  async run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
    this.argvs.push([...argv]);
    const failing = this.failStep;
    if (failing !== null && failing.every((word, i) => argv[i] === word)) {
      return { exitCode: 1, signal: null, stdout: '', stderr: 'scripted failure' };
    }
    if (argv[0] === 'yarn' && argv[1] === 'build' && options?.cwd !== undefined && !this.skipBuildOutput) {
      const entry = join(options.cwd, 'apps', 'cli', 'dist');
      await mkdir(entry, { recursive: true });
      await writeFile(join(entry, 'bin.js'), '// built\n');
    }
    return { exitCode: 0, signal: null, stdout: '', stderr: '' };
  }
}

/** A recorded, approved, unconsumed owner grant for one release scope at one head, bound to one root. */
function releaseGrant(_grantId: string, scope: string, sha: string, root: string): CoordinationRequestRecord {
  return {
    id: releaseGrantId(scope, 'p', sha, root),
    projectId: 'p',
    kind: 'action-decision',
    state: 'approved',
    actionScope: scope,
    expectedHeadSha: sha,
    proposalDigest: 'prop-1',
    policyRevision: 'pol-1',
    decisionRevision: 'dec-1',
    grantId: _grantId,
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'delivered',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    releaseRoot: root,
    releaseNonce: NONCE,
  } as CoordinationRequestRecord;
}

interface Harness {
  readonly useCase: ManageReleaseUseCase;
  readonly authorization: ActionAuthorizationAdapter;
  readonly executor: ScriptedBuildExecutor;
  readonly lease: ConductorDriverLeaseAdapter;
  readonly store: ReleaseStoreAdapter;
  readonly grants: CoordinationRequestRepositoryAdapter;
  readonly signer: SignedDecisionFixture;
  readonly root: string;
  readonly stateDir: string;
}

async function harness(storeOverride?: ReleaseStoreAdapter): Promise<Harness> {
  const stateDir = await tempDir('co14b-state-');
  const root = await tempDir('co14b-root-');
  const grants = new CoordinationRequestRepositoryAdapter({ stateDir });
  // KEY0c1a: the release owner grants are paired with Ed25519-signed answers
  // recorded under an ephemeral test signer's key, next to the state dir.
  const signer = createSignedDecisionFixture({ decisionsDir: join(stateDir, 'decisions') });
  // The real grant path: the same adapter-over-coordination-use-cases wiring the CLI uses.
  const authorization = new ActionAuthorizationAdapter({
    resolveGrant: async (request) => {
      const actionScope = releaseActionScope(request.actionKind);
      if (actionScope === null) {
        return { outcome: 'blocked', reason: 'not a release action' };
      }
      const result = await new ResolveActionAuthorizationUseCase({
        requestRepo: grants,
        ...signer.deps,
        computeDigest: digest,
      }).resolveActionAuthorization({
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
      const result = await new RecordAuthorizationConsumptionUseCase({
        requestRepo: grants,
        ...signer.deps,
        computeDigest: digest,
      }).recordAuthorizationConsumption({
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
    // CO14b fix round 8: the same state directory this harness already uses
    // for the lease adapter above -- the bind-when-unbound step binds the
    // root to it too, now that it runs only after authorization grants.
    stateDir,
  });
  return { useCase, authorization, executor, lease: new ConductorDriverLeaseAdapter({ stateDir }), store: new ReleaseStoreAdapter(), grants, signer, root, stateDir };
}

const shaOf = (c: string) => c.repeat(40);

describe('release install and swap end to end (CO14 follow-up, real grant, real lease, real store)', () => {
  let h: Harness;
  const shaA = shaOf('a');
  const shaB = shaOf('b');

  beforeEach(async () => {
    h = await harness();
  });

  /** KEY0c1a: seeds the grant and its signed answer under the ephemeral test signer. */
  const seedGrant = async (record: CoordinationRequestRecord): Promise<void> => {
    await h.grants.saveRequest(record);
    await h.signer.writeApprovedAnswer(record);
  };

  it('install stages the build and leaves current unmoved; swap repoints current atomically', async () => {
    await seedGrant(releaseGrant('grant-a', 'release:install', shaA, h.root));
    // KEY0c1a self-check: the seeded answer verifies back as `approved`.
    await h.signer.assertApprovedAnswerReadsBackApproved(releaseGrant('grant-a', 'release:install', shaA, h.root));
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

    await seedGrant(releaseGrant('grant-b', 'release:install', shaB, h.root));
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

    await seedGrant(releaseGrant('grant-swap', 'release:swap', shaA, h.root));
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
    await seedGrant(releaseGrant('grant-a', 'release:install', shaA, h.root));
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
      const grant = releaseGrant(`grant-install-${sha[0]}`, 'release:install', sha, h.root);
      await seedGrant(grant);
      // KEY0c1a self-check: the seeded answer reads back as `approved`.
      await h.signer.assertApprovedAnswerReadsBackApproved(grant);
      expect((await apply('install', sha)).outcome).toBe('applied');
    }
  }

  it('swap A, swap B, swap A again with no new grant: the third is refused and current stays on B', async () => {
    await installBuilds(shaA, shaB);
    await seedGrant(releaseGrant('grant-swap-a', 'release:swap', shaA, h.root));
    await seedGrant(releaseGrant('grant-swap-b', 'release:swap', shaB, h.root));
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
    await seedGrant(releaseGrant('grant-swap-c', 'release:swap', shaC, h.root));
    await seedGrant(releaseGrant('grant-rollback-b', 'release:rollback', shaB, h.root));
    expect((await apply('swap', shaC)).outcome).toBe('applied');
    expect((await apply('rollback', null)).outcome).toBe('applied');
    expect(await readlinkSha(h.root)).toBe(shaB);
    // RR1: a fresh swap grant for the same coordinates is a NEW request: it
    // carries a new per-request nonce, so it gets a new id and is issued
    // through `request-decision` instead of overwriting the spent record.
    const nonce2 = 'fedcba9876543210fedcba9876543210';
    // KEY0c1a: the fresh swap grant's answer is a signed one under the
    // ephemeral test signer, derived from the exact request it names.
    const signedRequestId = releaseGrantId('release:swap', 'p', shaC, h.root, nonce2);
    await h.signer.writeApprovedAnswer({
      id: signedRequestId,
      projectId: 'p',
      actionScope: 'release:swap',
      expectedHeadSha: shaC,
      decisionRevision: 'dec-2',
      grantId: 'grant-swap-c2',
    });
    const issued = await new RequestScopedDecisionUseCase({
      requestRepo: h.grants,
      decisionTransport: h.signer.deps.decisionTransport,
      computeDigest: digest,
    }).requestScopedDecision({
      requestId: releaseGrantId('release:swap', 'p', shaC, h.root, nonce2),
      projectId: 'p',
      kind: 'action-decision',
      actionScope: 'release:swap',
      expectedHeadSha: shaC,
      proposalDigest: 'prop-2',
      policyRevision: 'pol-1',
      releaseRoot: h.root,
      releaseNonce: nonce2,
    });
    expect(issued.outcome).toBe('requested');
    // KEY0c1a self-check: the new request's answer verifies back as `approved`.
    await h.signer.assertApprovedAnswerReadsBackApproved({
      id: signedRequestId,
      projectId: 'p',
      actionScope: 'release:swap',
      expectedHeadSha: shaC,
      decisionRevision: 'dec-2',
      grantId: 'grant-swap-c2',
    });
    expect((await h.grants.findRequestByGrantId('grant-swap-c'))?.consumptions).toHaveLength(1);
    expect((await apply('swap', shaC)).outcome).toBe('applied');
    expect(await readlinkSha(h.root)).toBe(shaC);
    // The same rollback again, with the grant already spent: refused, current unmoved.
    expect(await apply('rollback', null)).toEqual({ outcome: 'refused', reason: 'authority-refused' });
    expect(await readlinkSha(h.root)).toBe(shaC);
  });

  describe.each([
    { step: ['git', '-c'], label: 'archive', ran: 1 },
    { step: ['tar'], label: 'extract', ran: 2 },
    { step: ['yarn', 'install'], label: 'install', ran: 3 },
    { step: ['yarn', 'build'], label: 'build', ran: 4 },
  ])('a failing $label step', ({ step, ran }) => {
    it('refuses the install, stops the sequence there, leaves no build and moves nothing', async () => {
      h.executor.failStep = step;
      await seedGrant(releaseGrant('grant-a', 'release:install', shaA, h.root));
      const result = await apply('install', shaA);
      expect(result).toEqual({ outcome: 'refused', reason: 'build-failed-grant-spent' });
      // The reviewed sequence ran in order and stopped at the failing step.
      const expected = [['git', '-c'], ['tar'], ['yarn', 'install'], ['yarn', 'build']];
      expect(h.executor.argvs).toHaveLength(ran);
      h.executor.argvs.forEach((argv, i) => expect(argv.slice(0, expected[i].length)).toEqual(expected[i]));
      expect(await h.store.list({ root: h.root })).toMatchObject({ outcome: 'read', current: null, builds: [] });
      expect(await readlinkSha(h.root)).toBeNull();
      // The grant is spent: a failed build is never silently retried under it.
      expect((await h.grants.findRequestByGrantId('grant-a'))?.consumptions).toHaveLength(1);
    });
  });

  it('a build that succeeds but leaves no verifiable CLI entry is refused and installs nothing', async () => {
    h.executor.skipBuildOutput = true;
    await seedGrant(releaseGrant('grant-a', 'release:install', shaA, h.root));
    expect(await apply('install', shaA)).toEqual({ outcome: 'refused', reason: 'build-failed-grant-spent' });
    expect(await h.store.list({ root: h.root })).toMatchObject({ outcome: 'read', current: null, builds: [] });
    // The grant is spent: a build that cannot be verified is never silently retried under it.
    expect((await h.grants.findRequestByGrantId('grant-a'))?.consumptions).toHaveLength(1);
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
    await seedGrant(releaseGrant('grant-swap-a', 'release:swap', shaA, h.root));
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
      stateDir: h.stateDir,
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
    await seedGrant(releaseGrant('grant-install-a', 'release:install', shaA, h.root));
    const results = await Promise.all([apply('install', shaA), apply('install', shaA)]);
    expect(results.filter((r) => r.outcome === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'refused')).toHaveLength(1);
    expect((await h.grants.findRequestByGrantId('grant-install-a'))?.consumptions).toHaveLength(1);
  });

  it('the swap removes an orphaned repoint temp link under the lease and never a build or current', async () => {
    await installBuilds(shaA, shaB);
    await symlink(shaA, join(h.root, '.current.orphan.tmp'));
    await seedGrant(releaseGrant('grant-swap-a', 'release:swap', shaA, h.root));
    expect((await apply('swap', shaA)).outcome).toBe('applied');
    const names = await readdir(h.root);
    expect(names).not.toContain('.current.orphan.tmp');
    expect(names).toEqual(expect.arrayContaining(['current', shaA, shaB]));
  });

  it('a live driver lease in the root\'s state directory refuses the swap and current stays on the old build', async () => {
    await seedGrant(releaseGrant('grant-a', 'release:install', shaA, h.root));
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
    await seedGrant(releaseGrant('grant-swap-old', 'release:swap', shaA, h.root));
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
    await seedGrant(releaseGrant('grant-b', 'release:install', shaB, h.root));
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
    await seedGrant(releaseGrant('grant-swap', 'release:swap', shaB, h.root));
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
