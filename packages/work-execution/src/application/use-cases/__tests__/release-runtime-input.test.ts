/**
 * CO14 follow-up: the release robustness bar. One named test per item:
 * hostile runtime input never throws, the build steps are deadline-guarded
 * and a cut-short build leaves resumable state, a swap is keyed idempotent,
 * an unreadable store is unknown (never empty), no secret-shaped text and no
 * path reaches any output, git reads stay offline and write nothing, and
 * inputs and outputs are size-bounded.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ManageReleaseUseCase,
  ReleaseStoreAdapter,
  type ActionAuthorizationPort,
  type CommandExecutorPort,
  type CommandRunOptions,
  type CommandRunResult,
  type ConductorDriverLeasePort,
  type ResolveActionAuthorizationRequest,
  type ConsumeActionAuthorizationRequest,
} from '@fleet/work-execution';
import { CoordinationRequestRepositoryAdapter } from '../../../../../operator-coordination/src/infrastructure/adapters/CoordinationRequestRepositoryAdapter.adapter.js';
import { RecordAuthorizationConsumptionUseCase } from '../../../../../operator-coordination/src/application/use-cases/RecordAuthorizationConsumptionUseCase.use-case.js';
import { ResolveActionAuthorizationUseCase } from '../../../../../operator-coordination/src/application/use-cases/ResolveActionAuthorizationUseCase.use-case.js';
import type { CoordinationRequestRecord } from '../../../../../operator-coordination/src/domain/coordination-records.js';
import { RELEASE_GRANT_DIGEST_PREFIX } from '../../../../../operator-coordination/src/domain/coordination-records.js';

const NOW = '2026-11-10T10:00:00.000Z';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ROOT = '/nonexistent-co14b-robustness-root';

// RR1: a release grant's request id carries the digest of its coordinates
// ({ scope, projectId, expectedHeadSha, releaseRoot, nonce }), so a recorded grant
// must be saved under that id and the resolve/consume use cases must be given
// the same digest function the request id was derived with.
const digest = (payload: string): string => createHash('sha256').update(payload).digest('hex');
const NONCE = '0123456789abcdef0123456789abcdef';
const releaseGrantId = (scope: string, projectId: string, sha: string, root: string, nonce: string = NONCE): string =>
  `${RELEASE_GRANT_DIGEST_PREFIX}${digest(JSON.stringify({ scope, projectId, expectedHeadSha: sha, releaseRoot: root, nonce }))}`;

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
    deliveryStatus: 'pending',
    deliveryGapReason: null,
    revision: 0,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    releaseRoot: root,
    releaseNonce: NONCE,
  } as CoordinationRequestRecord;
}

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

/** Always grants, echoing the release root the request names; the consume always succeeds. */
const grantingAuthorization: ActionAuthorizationPort = {
  resolveActionAuthorization: async (request: ResolveActionAuthorizationRequest) => ({
    outcome: 'granted',
    authorizationGrantId: 'grant-1',
    ...(request.releaseRoot !== undefined ? { releaseRoot: request.releaseRoot } : {}),
  }),
  consumeActionAuthorization: async (request: ConsumeActionAuthorizationRequest) => ({
    outcome: 'consumed',
    actionId: request.actionId,
  }),
};

/** A lease port that never reads a live lease and lets any acquire/renew/release through. */
const freeLease: ConductorDriverLeasePort = {
  read: async () => null,
  acquire: async (request: { readonly holderId: string; readonly observedFence: number; readonly leaseUntilIso: string }) => ({
    outcome: 'ok',
    lease: { holderId: request.holderId, fence: request.observedFence + 1, leaseUntilIso: request.leaseUntilIso },
  }),
  renew: async (request: { readonly holderId: string; readonly fence: number; readonly leaseUntilIso: string }) => ({
    outcome: 'ok',
    lease: { holderId: request.holderId, fence: request.fence, leaseUntilIso: request.leaseUntilIso },
  }),
  release: async (request: { readonly holderId: string; readonly fence: number; readonly nowIso: string }) => ({
    outcome: 'ok',
    lease: { holderId: request.holderId, fence: request.fence, leaseUntilIso: request.nowIso },
  }),
} as unknown as ConductorDriverLeasePort;

function useCase(
  overrides: Partial<ConstructorParameters<typeof ManageReleaseUseCase>[0]> = {},
  authorization: ActionAuthorizationPort = grantingAuthorization,
): { useCase: ManageReleaseUseCase; executor: RecordingExecutor } {
  const executor = new RecordingExecutor();
  return {
    executor,
    useCase: new ManageReleaseUseCase({
      store: new ReleaseStoreAdapter(),
      lease: freeLease,
      authorization,
      executor,
      nowIso: () => NOW,
      env: () => ({ PATH: '/usr/bin', SNEAKY_TOKEN: 'x' }),
      // CO14b fix round 8: only the bind-when-unbound step reads this; any
      // fixed value works for this suite, which is about input validation.
      stateDir: '/co14b-release-runtime-input-state',
      ...overrides,
    }),
  };
}

/** Records every invocation with its environment, and can be told to fail one step. */
class RecordingExecutor implements CommandExecutorPort {
  readonly invocations: Array<{ argv: string[]; options?: CommandRunOptions }> = [];
  failStep: string | null = null;
  async run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
    this.invocations.push({ argv: [...argv], options });
    if (this.failStep !== null && argv[0] === this.failStep) {
      return { exitCode: 1, signal: null, stdout: '', stderr: '' };
    }
    if (argv[0] === 'yarn' && argv[1] === 'build' && options?.cwd !== undefined) {
      const entry = join(options.cwd, 'apps', 'cli', 'dist');
      await mkdir(entry, { recursive: true });
      await writeFile(join(entry, 'bin.js'), '// built\n');
    }
    return { exitCode: 0, signal: null, stdout: '', stderr: '' };
  }
}

const installRequest = {
  action: 'install' as const,
  root: ROOT,
  sha: SHA_A,
  source: '/nonexistent-co14b-source',
  keep: 5,
  apply: false,
  projectId: null,
};

describe('release robustness bar (CO14 follow-up)', () => {
  it('release never throws on runtime input', async () => {
    const { useCase: uc } = useCase();
    const trap = () => {
      throw new Error('trap');
    };
    // Each hostile input with the exact typed refusal it must return; none may be planned.
    const hostile: Array<[unknown, 'invalid-request' | 'failed']> = [
      [null, 'invalid-request'],
      [42, 'invalid-request'],
      ['install', 'invalid-request'],
      [[], 'invalid-request'],
      [{}, 'invalid-request'],
      [{ ...installRequest, root: null }, 'invalid-request'],
      [{ ...installRequest, root: 7 }, 'invalid-request'],
      [{ ...installRequest, root: '/a/../b' }, 'invalid-request'],
      [{ ...installRequest, sha: ['a'.repeat(40)] }, 'invalid-request'],
      [{ ...installRequest, keep: 'many' }, 'invalid-request'],
      [{ ...installRequest, action: 'deploy' }, 'invalid-request'],
      [
        new Proxy({ ...installRequest }, { get: trap, getOwnPropertyDescriptor: trap, ownKeys: trap }),
        'failed',
      ],
      [
        Object.defineProperty({ ...installRequest }, 'root', { enumerable: true, get: trap }),
        'invalid-request',
      ],
      [Object.assign(Object.create({ get root() { throw new Error('getter'); } }), {}), 'invalid-request'],
    ];
    for (const [request, reason] of hostile) {
      const result = await uc.manageRelease(request as never);
      // Exactly the typed refusal: an accidentally accepted (planned) hostile request fails.
      expect(result).toEqual({ outcome: 'refused', reason });
    }
  });

  it('the release build call is deadline-guarded and a cut-short build leaves resumable state', async () => {
    const root = await tempDir('co14b-deadline-');
    const { useCase: uc, executor } = useCase();
    const built = await uc.manageRelease({ ...installRequest, root, source: root, apply: true, projectId: 'p' });
    expect(built.outcome).toBe('applied');
    // The steps carry a wall-clock budget: every invocation names a timeout and a buffer bound.
    expect(executor.invocations.length).toBeGreaterThan(0);
    for (const invocation of executor.invocations) {
      expect(invocation.options?.timeoutMs).toBeGreaterThan(0);
      expect(invocation.options?.maxBufferBytes).toBeGreaterThan(0);
      expect(invocation.options?.killProcessTree).toBe(true);
    }
    const { useCase: uc2, executor: executor2 } = useCase();
    executor2.failStep = 'yarn';
    const cutShort = await uc2.manageRelease({
      action: 'install',
      root,
      sha: SHA_B,
      source: root,
      keep: 5,
      apply: true,
      projectId: 'p',
    });
    expect(cutShort).toEqual({ outcome: 'refused', reason: 'build-failed-grant-spent' });
    for (const invocation of executor2.invocations) {
      expect(invocation.options?.timeoutMs).toBeGreaterThan(0);
      expect(invocation.options?.maxBufferBytes).toBeGreaterThan(0);
    }
    // The store still lists the same builds and the same `current`, and the
    // next pass with a working executor completes the build.
    const listing = await new ReleaseStoreAdapter().list({ root });
    expect(listing).toMatchObject({ outcome: 'read', current: null, builds: [expect.objectContaining({ sha: SHA_A })] });
    const { useCase: uc3 } = useCase();
    const nextPass = await uc3.manageRelease({
      action: 'install',
      root,
      sha: SHA_B,
      source: root,
      keep: 5,
      apply: true,
      projectId: 'p',
    });
    expect(nextPass.outcome).toBe('applied');
    // Install stages the build and never moves `current` (CO14 follow-up).
    expect(await new ReleaseStoreAdapter().list({ root })).toMatchObject({ outcome: 'read', current: null });
  });

  it('a release swap is keyed idempotent and survives a crash between the consumption and the repoint', async () => {
    const root = await tempDir('co14b-idem-');
    const stateDir = await tempDir('co14b-idem-state-');
    const store = new ReleaseStoreAdapter();
    for (const sha of [SHA_A, SHA_B]) {
      const staging = await store.prepare({ root, sha });
      if (staging.outcome !== 'prepared') throw new Error('prepare failed');
      const entry = join(staging.buildDir, 'apps', 'cli', 'dist');
      await mkdir(entry, { recursive: true });
      await writeFile(join(entry, 'bin.js'), '// built\n');
      expect((await store.markVerified({ root, sha, buildId: staging.buildId, builtAtIso: NOW })).outcome).toBe('ok');
    }
    await store.repoint({ root, sha: SHA_A });
    // The real grant path: a recorded, approved `release:swap` grant bound to
    // this release root, resolved and consumed through the coordination use
    // cases — never a stub that grants and consumes every replay.
    const grants = new CoordinationRequestRepositoryAdapter({ stateDir });
    await grants.saveRequest(releaseGrant('grant-1', 'release:swap', SHA_B, root));
    // The crash window: the first attempt's consume succeeds durably and then
    // the process dies before the repoint, so the caller sees a refusal while
    // the grant is already consumed and `current` is unmoved.
    let crashed = true;
    const resolve = async (request: ResolveActionAuthorizationRequest) => {
      const result = await new ResolveActionAuthorizationUseCase({ requestRepo: grants, computeDigest: digest }).resolveActionAuthorization({
        projectId: request.projectId,
        actionScope: 'release:swap',
        expectedHeadSha: request.expectedHeadSha,
        releaseRoot: request.releaseRoot,
        resumeActionId: request.actionId,
      });
      return result.outcome === 'authorized'
        ? {
            outcome: 'granted' as const,
            authorizationGrantId: result.grantId,
            ...(result.releaseRoot !== undefined ? { releaseRoot: result.releaseRoot } : {}),
          }
        : { outcome: 'blocked' as const, reason: result.reason };
    };
    const consume = async (request: ConsumeActionAuthorizationRequest) => {
      const result = await new RecordAuthorizationConsumptionUseCase({ requestRepo: grants, computeDigest: digest }).recordAuthorizationConsumption({
        consumptionId: `c-${request.actionId}`,
        grantId: request.authorizationGrantId,
        actionId: request.actionId,
        actionScope: 'release:swap',
        attemptId: request.attemptId ?? request.actionId,
        expectedHeadSha: request.expectedHeadSha ?? SHA_B,
        releaseRoot: request.releaseRoot,
      });
      return result.outcome === 'consumed'
        ? { outcome: 'consumed' as const, actionId: request.actionId }
        : { outcome: 'refused' as const, reason: result.reason };
    };
    const crashAuthorization: ActionAuthorizationPort = {
      resolveActionAuthorization: resolve,
      consumeActionAuthorization: async (request: ConsumeActionAuthorizationRequest) => {
        const result = await consume(request);
        if (crashed) {
          crashed = false;
          return { outcome: 'refused', reason: 'simulated crash between the consumption and the repoint' };
        }
        return result;
      },
    };
    const { useCase: uc } = useCase({}, crashAuthorization);
    const interrupted = await uc.manageRelease({ action: 'swap', root, sha: SHA_B, source: null, keep: 5, apply: true, projectId: 'p' });
    expect(interrupted).toEqual({ outcome: 'refused', reason: 'authority-refused' });
    // The consumption is durable and `current` is unmoved: the crash left one
    // intent with no result.
    expect((await grants.findRequestByGrantId('grant-1'))?.consumptions).toHaveLength(1);
    expect(await store.list({ root })).toMatchObject({ outcome: 'read', current: SHA_A });
    // The next pass resumes the same consumed grant by its own deterministic
    // action id, replays the consumption idempotently and reaches one
    // consistent state: a single `current` on the target, one consumption.
    const { useCase: uc2 } = useCase({}, crashAuthorization);
    const replay = await uc2.manageRelease({ action: 'swap', root, sha: SHA_B, source: null, keep: 5, apply: true, projectId: 'p' });
    expect(replay).toMatchObject({ outcome: 'applied', action: 'swap', target: SHA_B });
    expect((await grants.findRequestByGrantId('grant-1'))?.consumptions).toHaveLength(1);
    expect(await store.list({ root })).toMatchObject({ outcome: 'read', current: SHA_B });
    // Once the operation's result is recorded, the grant authorizes nothing
    // more: a further identical request is refused, records no second
    // consumption and never leaves two `current` pointers.
    const { useCase: uc3 } = useCase({}, crashAuthorization);
    const again = await uc3.manageRelease({ action: 'swap', root, sha: SHA_B, source: null, keep: 5, apply: true, projectId: 'p' });
    expect(again).toEqual({ outcome: 'refused', reason: 'authority-refused' });
    expect((await grants.findRequestByGrantId('grant-1'))?.consumptions).toHaveLength(1);
    expect(await store.list({ root })).toMatchObject({ outcome: 'read', current: SHA_B });
  });

  it('an unreadable release store is reported as unknown, never as empty', async () => {
    const root = await tempDir('co14b-unreadable-');
    // A root that is a file: every read is unreadable, never an empty store.
    const filePath = join(root, 'not-a-directory');
    await writeFile(filePath, 'x');
    const { useCase: uc } = useCase();
    const planned = await uc.manageRelease({ ...installRequest, root: filePath });
    expect(planned).toEqual({ outcome: 'refused', reason: 'store-unreadable' });
    const applied = await uc.manageRelease({ ...installRequest, root: filePath, apply: true, projectId: 'p' });
    expect(applied).toEqual({ outcome: 'refused', reason: 'store-unreadable' });
    expect(await new ReleaseStoreAdapter().removeOrphanCurrentTemps({ root: filePath })).toEqual({ outcome: 'unknown' });
  });

  it('release output carries ids and codes only', async () => {
    const root = await tempDir('co14b-secret-');
    // Synthetic, obviously fake secret-shaped values, built here and never real.
    const fakeToken = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    const fakeKey = ['sk', '-', 'FAKE0synthetic1value2for3tests4only5'].join('');
    const { useCase: uc } = useCase({ env: () => ({ PATH: '/usr/bin', SNEAKY_TOKEN: fakeToken }) });
    const results = [
      await uc.manageRelease({ ...installRequest, root }),
      await uc.manageRelease({ ...installRequest, root, apply: true, projectId: 'p' }),
      await uc.manageRelease({ ...installRequest, root, apply: true }),
      // A secret-shaped value supplied as runtime input is refused, never echoed.
      await uc.manageRelease({ ...installRequest, root, sha: fakeToken }),
      await uc.manageRelease({ ...installRequest, root, projectId: fakeKey, apply: true }),
    ];
    for (const result of results) {
      const text = JSON.stringify(result);
      expect(text).not.toContain(fakeToken);
      expect(text).not.toContain(fakeKey);
      expect(text).not.toContain(root);
      expect(text).not.toContain('TOKEN');
      expect(text).not.toContain('/nonexistent-co14b-source');
    }
  });

  it('release git reads write nothing and stay offline', async () => {
    const root = await tempDir('co14b-gitenv-');
    const { useCase: uc, executor } = useCase();
    await uc.manageRelease({ action: 'install', root, sha: SHA_A, source: root, keep: 5, apply: true, projectId: 'p' });
    expect(executor.invocations.length).toBeGreaterThan(0);
    for (const { argv, options } of executor.invocations) {
      const childVars = options?.env ?? {};
      if (argv[0] === 'git') {
        expect(childVars['GIT_ALLOW_PROTOCOL']).toBe('none');
        expect(childVars['GIT_NO_LAZY_FETCH']).toBe('1');
        expect(childVars['GIT_TERMINAL_PROMPT']).toBe('0');
        expect(childVars['GIT_CONFIG_NOSYSTEM']).toBe('1');
        expect(argv).toContain('core.hooksPath=/dev/null');
        expect(argv).toContain('core.fsmonitor=false');
      }
      // No operator environment value beyond the allowlist reaches a child,
      // and nothing the child sees is the operator's home.
      expect(Object.keys(childVars).every((key) => ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'YARN_NM_MODE', 'COREPACK_ENABLE_DOWNLOAD_PROMPT', 'GIT_ALLOW_PROTOCOL', 'GIT_NO_LAZY_FETCH', 'GIT_TERMINAL_PROMPT', 'GIT_CONFIG_NOSYSTEM', 'HOME'].includes(key))).toBe(true);
      expect(childVars['SNEAKY_TOKEN']).toBeUndefined();
    }
  });

  it('release inputs and outputs are size-bounded', async () => {
    const { useCase: uc } = useCase();
    const oversizedRoot = `/${'r'.repeat(5000)}`;
    const oversizedProject = 'p'.repeat(300);
    const oversizedSha = `${'a'.repeat(41)}`;
    const results = [
      await uc.manageRelease({ ...installRequest, root: oversizedRoot }),
      await uc.manageRelease({ ...installRequest, projectId: oversizedProject, apply: true }),
      await uc.manageRelease({ ...installRequest, sha: oversizedSha }),
      await uc.manageRelease({ ...installRequest, keep: 65 }),
    ];
    for (const result of results) {
      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
    // The printed plan and stored records stay inside their bound.
    const root = await tempDir('co14b-bounds-');
    const plan = await uc.manageRelease({ ...installRequest, root });
    expect(JSON.stringify(plan).length).toBeLessThan(4096);
  });
});
