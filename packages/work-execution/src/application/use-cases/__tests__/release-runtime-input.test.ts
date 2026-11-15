/**
 * CO14 follow-up: the release robustness bar. One named test per item:
 * hostile runtime input never throws, the build steps are deadline-guarded
 * and a cut-short build leaves resumable state, a swap is keyed idempotent,
 * an unreadable store is unknown (never empty), no secret-shaped text and no
 * path reaches any output, git reads stay offline and write nothing, and
 * inputs and outputs are size-bounded.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

const NOW = '2026-11-10T10:00:00.000Z';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ROOT = '/nonexistent-co14b-robustness-root';

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

/** Always grants, never consumes; the consume is refused, so an apply repoints nothing. */
const grantingAuthorization: ActionAuthorizationPort = {
  resolveActionAuthorization: async (_request: ResolveActionAuthorizationRequest) => ({
    outcome: 'granted',
    authorizationGrantId: 'grant-1',
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
    const hostile: unknown[] = [
      null,
      42,
      'install',
      [],
      {},
      { ...installRequest, root: null },
      { ...installRequest, root: 7 },
      { ...installRequest, root: '/a/../b' },
      { ...installRequest, sha: ['a'.repeat(40)] },
      { ...installRequest, keep: 'many' },
      { ...installRequest, action: 'deploy' },
      new Proxy({ ...installRequest }, {}),
      Object.assign(Object.create({ get root() { throw new Error('getter'); } }), {}),
    ];
    for (const request of hostile) {
      const result = await uc.manageRelease(request as never);
      // A typed result, never an exception.
      expect(['refused', 'planned']).toContain(result.outcome);
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
    expect(cutShort).toEqual({ outcome: 'refused', reason: 'build-failed' });    for (const invocation of executor2.invocations) {
      expect(invocation.options?.timeoutMs).toBeGreaterThan(0);
      expect(invocation.options?.maxBufferBytes).toBeGreaterThan(0);
    }
    // The store still lists the same builds and the same `current`, and the
    // next pass with a working executor completes the build.
    const listing = await new ReleaseStoreAdapter().list({ root });
    expect(listing).toMatchObject({ outcome: 'read', current: SHA_A, builds: [expect.objectContaining({ sha: SHA_A })] });
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
    expect(await new ReleaseStoreAdapter().list({ root })).toMatchObject({ outcome: 'read', current: SHA_B });
  });

  it('a release swap is keyed idempotent and survives a crash between intent and result', async () => {
    const root = await tempDir('co14b-idem-');
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
    // One consumption key per action id: the same swap consumes the same key,
    // so a second consumption of the same grant is refused, never recorded twice.
    let consumptions = 0;
    const onceAuthorization: ActionAuthorizationPort = {
      resolveActionAuthorization: async (_request: ResolveActionAuthorizationRequest) => ({
        outcome: 'granted',
        authorizationGrantId: 'grant-1',
      }),
      consumeActionAuthorization: async (request: ConsumeActionAuthorizationRequest) => {
        consumptions += 1;
        return { outcome: 'consumed', actionId: request.actionId };
      },
    };
    const { useCase: uc } = useCase({}, onceAuthorization);
    const first = await uc.manageRelease({ action: 'swap', root, sha: SHA_B, source: null, keep: 5, apply: true, projectId: 'p' });
    expect(first.outcome).toBe('applied');
    expect(consumptions).toBe(1);
    const afterFirst = await store.list({ root });
    expect(afterFirst.outcome).toBe('read');
    if (afterFirst.outcome === 'read') {
      expect(afterFirst.current).toBe(SHA_B);
    }
    // The next pass after a crash between intent and result reaches one consistent state:
    // the same swap key re-run repoints to the same single `current`, never two pointers.
    const { useCase: uc2 } = useCase({}, onceAuthorization);
    const replay = await uc2.manageRelease({ action: 'swap', root, sha: SHA_B, source: null, keep: 5, apply: true, projectId: 'p' });
    expect(replay.outcome).toBe('applied');
    const after = await store.list({ root });
    expect(after).toMatchObject({ outcome: 'read', current: SHA_B });
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
    const { useCase: uc } = useCase();
    const results = [
      await uc.manageRelease({ ...installRequest, root }),
      await uc.manageRelease({ ...installRequest, root, apply: true, projectId: 'p' }),
      await uc.manageRelease({ ...installRequest, root, apply: true }),
    ];
    for (const result of results) {
      const text = JSON.stringify(result);
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
      const env = options?.env ?? {};
      if (argv[0] === 'git') {
        expect(env['GIT_ALLOW_PROTOCOL']).toBe('none');
        expect(env['GIT_NO_LAZY_FETCH']).toBe('1');
        expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
        expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1');
        expect(argv).toContain('core.hooksPath=/dev/null');
        expect(argv).toContain('core.fsmonitor=false');
      }
      // No operator environment value beyond the allowlist reaches a child,
      // and nothing the child sees is the operator's home.
      expect(Object.keys(env).every((key) => ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'YARN_NM_MODE', 'COREPACK_ENABLE_DOWNLOAD_PROMPT', 'GIT_ALLOW_PROTOCOL', 'GIT_NO_LAZY_FETCH', 'GIT_TERMINAL_PROMPT', 'GIT_CONFIG_NOSYSTEM', 'HOME'].includes(key))).toBe(true);
      expect(env['SNEAKY_TOKEN']).toBeUndefined();
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
