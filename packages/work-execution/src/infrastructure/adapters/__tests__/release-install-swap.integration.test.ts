/**
 * CO14b 4.1: a release install and swap end to end over a temporary root with
 * the real `ReleaseStoreAdapter`, the real `ConductorDriverLeaseAdapter`
 * (constructed with `{ stateDir }`) and the real release grant path (the same
 * `ActionAuthorizationPort` implementation CO14 resolves `release:install`
 * through — the real `ActionAuthorizationAdapter` over a real grant map). No
 * mocks of those three. The entry point driven is the same use case the CLI
 * calls (`ManageReleaseUseCase`).
 *
 * The robustness bar is part of the lane: the build call is deadline-guarded
 * and a cut-short build leaves resumable state; a crash between intent and
 * result reaches one consistent state; release git reads write nothing and
 * stay offline.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import { ActionAuthorizationAdapter, type ActionAuthorizationGrantEntry } from '../ActionAuthorizationAdapter.adapter.js';
import { ConductorDriverLeaseAdapter } from '../ConductorDriverLeaseAdapter.adapter.js';
import { ReleaseStoreAdapter } from '../ReleaseStoreAdapter.adapter.js';
import { ManageReleaseUseCase } from '../../../application/use-cases/ManageReleaseUseCase.use-case.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const NOW = '2026-11-06T10:00:00.000Z';
const PROJECT = 'fleet-v2';
const LEASE_UNTIL = '2026-11-06T10:05:00.000Z';

class RecordingExecutor implements CommandExecutorPort {
  readonly runs: Array<{ argv: readonly string[]; options?: CommandRunOptions }> = [];
  failFirst: number = 0;

  async run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
    this.runs.push({ argv, options });
    if (this.failFirst > 0) {
      this.failFirst -= 1;
      return { exitCode: 1, signal: null, stdout: '', stderr: '' };
    }
    // Simulate the tar step extracting the CLI entry into the build dir, so
    // the real verifier (`markVerified`) can verify the build.
    if (argv[0] === 'tar') {
      const buildDir = argv[argv.indexOf('-C') + 1];
      if (buildDir !== undefined) {
        const entry = path.join(buildDir, 'apps', 'cli', 'dist');
        await fs.mkdir(entry, { recursive: true });
        await fs.writeFile(path.join(entry, 'bin.js'), '// cli\n');
      }
    }
    return { exitCode: 0, signal: null, stdout: '', stderr: '' };
  }
}

describe('release install and swap integration', () => {
  let tempDir: string;
  let root: string;
  let leaseStateDir: string;
  let store: ReleaseStoreAdapter;
  let grants: Map<string, ActionAuthorizationGrantEntry>;
  let executor: RecordingExecutor;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-release-integration-test-'));
    root = path.join(tempDir, 'releases');
    leaseStateDir = path.join(tempDir, 'lease-state');
    store = new ReleaseStoreAdapter();
    grants = new Map<string, ActionAuthorizationGrantEntry>();
    executor = new RecordingExecutor();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function verified(digit: string, day: number): Promise<string> {
    const id = digit.repeat(40);
    const prepared = await store.prepare({ root, sha: id });
    if (prepared.outcome !== 'prepared') {
      throw new Error(`prepare refused for ${id}`);
    }
    const entry = path.join(prepared.buildDir, 'apps', 'cli', 'dist');
    await fs.mkdir(entry, { recursive: true });
    await fs.writeFile(path.join(entry, 'bin.js'), '// cli\n');
    expect(await store.markVerified({ root, sha: id, buildId: prepared.buildId, builtAtIso: at(day) })).toEqual({
      outcome: 'ok',
    });
    return id;
  }

  function at(day: number): string {
    return `2026-11-0${day}T09:00:00.000Z`;
  }

  function seedGrants(): void {
    grants.set('grant-install', {
      expectedHeadSha: A,
      kind: 'release-install',
      root,
      consumedByActionId: null,
    });
    grants.set('grant-swap', {
      expectedHeadSha: B,
      kind: 'release-swap',
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

  function installRequest(sha: string, source: string = '/src') {
    return {
      action: 'install' as const,
      root,
      sha,
      source,
      keep: 3,
      apply: true,
      projectId: PROJECT,
    };
  }

  function swapRequest(sha: string) {
    return {
      action: 'swap' as const,
      root,
      sha,
      source: null,
      keep: 3,
      apply: true,
      projectId: PROJECT,
    };
  }

  it('release install creates the build and repoints current to it', async () => {
    seedGrants();
    const result = await useCase().manageRelease(installRequest(A));
    expect(result).toMatchObject({ outcome: 'applied', action: 'install', target: A, current: A });
    await expect(fs.lstat(path.join(root, A))).resolves.toBeDefined();
    expect(await fs.readlink(path.join(root, 'current'))).toBe(A);
  });

  it('release swap repoints current atomically; the previous build and the current link survive', async () => {
    await verified('a', 1);
    await verified('b', 2);
    seedGrants();
    const uc = useCase();
    expect(await uc.manageRelease(installRequest(A))).toMatchObject({ outcome: 'applied', current: A });
    expect(await uc.manageRelease(swapRequest(B))).toMatchObject({ outcome: 'applied', action: 'swap', current: B });
    expect(await fs.readlink(path.join(root, 'current'))).toBe(B);
    // The previous build survives and the store lists exactly one current.
    await expect(fs.lstat(path.join(root, A))).resolves.toBeDefined();
    expect(await store.list({ root })).toMatchObject({ outcome: 'read', current: B, builds: [{ sha: A }, { sha: B }] });
  });

  it('the release:install grant is consumed exactly once', async () => {
    seedGrants();
    const uc = useCase();
    expect(await uc.manageRelease(installRequest(A))).toMatchObject({ outcome: 'applied' });
    expect(grants.get('grant-install')?.consumedByActionId).not.toBeNull();
    // A second identical release is refused by the consumed grant, not re-authorised.
    const second = await uc.manageRelease(installRequest(A));
    expect(second).toEqual({ outcome: 'refused', reason: 'authority-refused' });
    expect(grants.get('grant-install')?.consumedByActionId).not.toBeNull();
  });

  it('a live driver lease in the root’s state directory refuses the swap', async () => {
    await verified('a', 1);
    await verified('b', 2);
    seedGrants();
    const uc = useCase();
    expect(await uc.manageRelease(installRequest(A))).toMatchObject({ outcome: 'applied', current: A });
    const lease = new ConductorDriverLeaseAdapter({ stateDir: leaseStateDir });
    // The install released its own lease (fence already advanced), so acquire
    // with the observed fence the lease store currently holds.
    const current = await lease.read();
    expect(
      await lease.acquire({
        holderId: 'driver-x',
        observedFence: current?.fence ?? 0,
        leaseUntilIso: LEASE_UNTIL,
        nowIso: NOW,
      }),
    ).toMatchObject({ outcome: 'ok' });

    const result = await uc.manageRelease(swapRequest(B));

    expect(result).toEqual({ outcome: 'refused', reason: 'driver-lease-live' });
    expect(await fs.readlink(path.join(root, 'current'))).toBe(A);
  });

  it('the release build call is deadline-guarded and a cut-short build leaves resumable state', async () => {
    seedGrants();
    const uc = useCase();
    // Cut the build short on the first attempt (the git step fails).
    executor.failFirst = 1;
    const cut = await uc.manageRelease(installRequest(A, '/src'));
    expect(cut).toEqual({ outcome: 'refused', reason: 'build-failed' });
    // The store still lists the same kept builds and the same current: nothing
    // partial is recorded.
    expect(await store.list({ root })).toMatchObject({ outcome: 'read', current: null, builds: [] });
    // Every step carried the unit's deadline budget.
    expect(executor.runs.length).toBeGreaterThan(0);
    for (const run of executor.runs) {
      expect(run.options?.timeoutMs).toBeGreaterThan(0);
      expect(run.options?.maxBufferBytes).toBeGreaterThan(0);
    }

    // The next pass completes the build.
    const resumed = await uc.manageRelease(installRequest(A, '/src'));
    expect(resumed).toMatchObject({ outcome: 'applied', current: A });
    await expect(fs.lstat(path.join(root, A))).resolves.toBeDefined();
  });

  it('a release swap survives a crash between intent and result and reaches one consistent state', async () => {
    await verified('a', 1);
    await verified('b', 2);
    seedGrants();
    const uc = useCase();
    expect(await uc.manageRelease(installRequest(A))).toMatchObject({ outcome: 'applied', current: A });
    // A crash between intent and result leaves the interrupted repoint's temp
    // link behind (like an orphan). The next pass must reach one consistent state.
    await fs.symlink(B, path.join(root, '.current.crashed.abcd1234.tmp'));
    expect(await uc.manageRelease(swapRequest(B))).toMatchObject({ outcome: 'applied', current: B });
    expect(await fs.readlink(path.join(root, 'current'))).toBe(B);
    const listing = await store.list({ root });
    expect(listing.outcome).toBe('read');
    // One consistent current pointer, never two.
    const entries = await fs.readdir(root);
    expect(entries.filter((entry) => entry === 'current')).toHaveLength(1);
    // The same swap key never repoints twice: the consumed grant refuses a
    // second identical swap and current stays put.
    const second = await uc.manageRelease(swapRequest(B));
    expect(second.outcome).toBe('refused');
    expect(await fs.readlink(path.join(root, 'current'))).toBe(B);
  });

  it('release git reads write nothing and stay offline', async () => {
    seedGrants();
    const uc = useCase();
    await uc.manageRelease(installRequest(A, '/src'));
    const gitStep = executor.runs[0];
    const env = gitStep.options?.env ?? {};
    expect(env.GIT_ALLOW_PROTOCOL).toBe('none');
    expect(env.GIT_NO_LAZY_FETCH).toBe('1');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    // The git argv itself disables hooks and fsmonitor and never writes.
    const argv = gitStep.argv.join(' ');
    expect(argv).toContain('core.hooksPath=/dev/null');
    expect(argv).toContain('core.fsmonitor=false');
    expect(argv).toContain('archive');
  });
});
