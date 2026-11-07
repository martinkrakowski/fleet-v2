/**
 * CO14b 4.1: a release install and swap end to end over a temporary root with
 * the real `ReleaseStoreAdapter`, the real `ConductorDriverLeaseAdapter`
 * (constructed with `{ stateDir }`) and the real release grant path: the real
 * `CoordinationRequestRepositoryAdapter`, `ResolveActionAuthorizationUseCase`
 * and `RecordAuthorizationConsumptionUseCase`, wired through the same
 * `ActionAuthorizationAdapter` delegation the CLI uses for `release:install`.
 * No mocks of those. The entry point driven is the same use case the CLI calls
 * (`ManageReleaseUseCase`).
 *
 * Install creates the build and leaves `current` unmoved; swap repoints
 * `current` atomically. A live driver lease in the root's state directory
 * refuses the swap. A swap interrupted after the grant was consumed but before
 * the repoint is resumed by the next pass.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CoordinationRequestRepositoryAdapter,
  RecordAuthorizationConsumptionUseCase,
  ResolveActionAuthorizationUseCase,
  type CoordinationRequestRecord,
} from '@fleet/operator-coordination';
import {
  consumptionId,
  releaseActionScope,
  sha256HexDigest,
} from '@fleet/work-execution';

import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import { ActionAuthorizationAdapter } from '../ActionAuthorizationAdapter.adapter.js';
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

/** The root-scoped coordination scope the CLI builds for a release action. */
function releaseScopeForRoot(actionScope: string, root: string): string {
  return `${actionScope}@${sha256HexDigest(root)}`;
}

describe('release install and swap integration', () => {
  let tempDir: string;
  let root: string;
  let leaseStateDir: string;
  let coordinationStateDir: string;
  let store: ReleaseStoreAdapter;
  let requestRepo: CoordinationRequestRepositoryAdapter;
  let executor: RecordingExecutor;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-release-integration-test-'));
    root = path.join(tempDir, 'releases');
    leaseStateDir = path.join(tempDir, 'lease-state');
    coordinationStateDir = path.join(tempDir, 'coordination-state');
    store = new ReleaseStoreAdapter();
    requestRepo = new CoordinationRequestRepositoryAdapter({ stateDir: coordinationStateDir });
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

  /** Record a real approved owner grant: scope `release:<action>` bound to the root. */
  async function recordGrant(kind: 'release-install' | 'release-swap', head: string, grantId: string): Promise<void> {
    const actionScope = releaseScopeForRoot(releaseActionScope(kind) as string, root);
    const record: CoordinationRequestRecord = {
      id: `request-${grantId}`,
      projectId: PROJECT,
      kind: 'action-decision',
      state: 'approved',
      actionScope,
      expectedHeadSha: head,
      proposalDigest: `digest-${grantId}`,
      policyRevision: 'policy-7',
      decisionRevision: 'decision-3',
      grantId,
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'delivered',
      deliveryGapReason: null,
      revision: 1,
      createdAtIso: NOW,
      updatedAtIso: NOW,
    };
    await requestRepo.saveRequest(record);
  }

  /** The real release grant path, wired exactly as the CLI wires it. */
  function authorization() {
    const resolve = new ResolveActionAuthorizationUseCase({ requestRepo });
    const consume = new RecordAuthorizationConsumptionUseCase({ requestRepo });
    return new ActionAuthorizationAdapter({
      resolveGrant: async (request) => {
        const actionScope = releaseActionScope(request.actionKind);
        if (actionScope === null) {
          return { outcome: 'blocked', reason: 'not a release action' };
        }
        const result = await resolve.execute({
          projectId: request.projectId,
          actionScope: releaseScopeForRoot(actionScope, request.root as string),
          expectedHeadSha: request.expectedHeadSha,
        });
        return result.outcome === 'authorized'
          ? { outcome: 'granted', authorizationGrantId: result.grantId, root: request.root }
          : { outcome: 'blocked', reason: result.reason };
      },
      consumeGrant: async (request) => {
        const actionScope = releaseActionScope(request.actionKind);
        if (actionScope === null || request.expectedHeadSha === undefined) {
          return { outcome: 'refused', reason: 'not a release grant consumption' };
        }
        const result = await consume.execute({
          consumptionId: consumptionId(request.actionId),
          grantId: request.authorizationGrantId,
          actionId: request.actionId,
          actionScope: releaseScopeForRoot(actionScope, request.root as string),
          attemptId: request.attemptId ?? request.actionId,
          expectedHeadSha: request.expectedHeadSha,
        });
        return result.outcome === 'consumed'
          ? { outcome: 'consumed', actionId: request.actionId }
          : { outcome: 'refused', reason: result.reason };
      },
    });
  }

  function useCase() {
    return new ManageReleaseUseCase({
      store,
      lease: new ConductorDriverLeaseAdapter({ stateDir: leaseStateDir }),
      authorization: authorization(),
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

  it('release install creates the build and leaves current unmoved', async () => {
    await recordGrant('release-install', A, 'grant-install');
    const result = await useCase().manageRelease(installRequest(A));
    expect(result).toMatchObject({ outcome: 'applied', action: 'install', target: A, current: null });
    await expect(fs.lstat(path.join(root, A))).resolves.toBeDefined();
    // Install never moves `current`.
    await expect(fs.lstat(path.join(root, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.list({ root })).toMatchObject({ outcome: 'read', current: null });
  });

  it('release swap repoints current atomically; the previous build and the current link survive', async () => {
    await verified('a', 1);
    await verified('b', 2);
    await recordGrant('release-install', A, 'grant-install');
    await recordGrant('release-swap', B, 'grant-swap');
    const uc = useCase();
    expect(await uc.manageRelease(installRequest(A))).toMatchObject({ outcome: 'applied', current: null });
    expect(await uc.manageRelease(swapRequest(B))).toMatchObject({ outcome: 'applied', action: 'swap', current: B });
    expect(await fs.readlink(path.join(root, 'current'))).toBe(B);
    // The previous build survives and the store lists exactly one current.
    await expect(fs.lstat(path.join(root, A))).resolves.toBeDefined();
    expect(await store.list({ root })).toMatchObject({ outcome: 'read', current: B, builds: [{ sha: A }, { sha: B }] });
  });

  it('the release:install grant is consumed exactly once', async () => {
    await recordGrant('release-install', A, 'grant-install');
    const uc = useCase();
    expect(await uc.manageRelease(installRequest(A))).toMatchObject({ outcome: 'applied' });
    const stored = (await requestRepo.findRequestByGrantId('grant-install')) as CoordinationRequestRecord;
    expect(stored.consumptions).toHaveLength(1);
    // A second identical release is refused by the consumed grant, not re-authorised.
    const second = await uc.manageRelease(installRequest(A));
    expect(second).toEqual({ outcome: 'refused', reason: 'authority-refused' });
    const again = (await requestRepo.findRequestByGrantId('grant-install')) as CoordinationRequestRecord;
    expect(again.consumptions).toHaveLength(1);
  });

  it('a live driver lease in the root’s state directory refuses the swap', async () => {
    await verified('a', 1);
    await verified('b', 2);
    await recordGrant('release-install', A, 'grant-install');
    await recordGrant('release-swap', B, 'grant-swap');
    const uc = useCase();
    expect(await uc.manageRelease(installRequest(A))).toMatchObject({ outcome: 'applied', current: null });
    const lease = new ConductorDriverLeaseAdapter({ stateDir: leaseStateDir });
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
    await expect(fs.lstat(path.join(root, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('the release build call is deadline-guarded and a cut-short build leaves resumable state', async () => {
    await recordGrant('release-install', A, 'grant-install');
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
    expect(resumed).toMatchObject({ outcome: 'applied', current: null });
    await expect(fs.lstat(path.join(root, A))).resolves.toBeDefined();
  });

  it('a release swap survives a crash after the grant is consumed but before the repoint', async () => {
    await verified('a', 1);
    await verified('b', 2);
    await recordGrant('release-install', A, 'grant-install');
    await recordGrant('release-swap', B, 'grant-swap');
    const uc = useCase();
    expect(await uc.manageRelease(installRequest(A))).toMatchObject({ outcome: 'applied', current: null });
    // Consume the swap grant, then crash between intent and result: the temp
    // link exists, `current` is unmoved, and the grant is already consumed.
    const consume = new RecordAuthorizationConsumptionUseCase({ requestRepo });
    const actionId = `release-swap-${B}`;
    expect(
      await consume.execute({
        consumptionId: consumptionId(actionId),
        grantId: 'grant-swap',
        actionId,
        actionScope: releaseScopeForRoot(releaseActionScope('release-swap') as string, root),
        attemptId: actionId,
        expectedHeadSha: B,
      }),
    ).toMatchObject({ outcome: 'consumed' });
    await fs.symlink(B, path.join(root, '.current.crashed.abcd1234.tmp'));

    // The next pass resumes the interrupted repoint and reaches one consistent state.
    const resumed = await uc.manageRelease(swapRequest(B));
    expect(resumed).toMatchObject({ outcome: 'applied', action: 'swap', current: B });
    expect(await fs.readlink(path.join(root, 'current'))).toBe(B);
    const stored = (await requestRepo.findRequestByGrantId('grant-swap')) as CoordinationRequestRecord;
    expect(stored.consumptions).toHaveLength(1);
    const entries = await fs.readdir(root);
    expect(entries.filter((entry) => entry === 'current')).toHaveLength(1);
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    // The consumed grant refuses a second identical swap and current stays put.
    const second = await uc.manageRelease(swapRequest(B));
    expect(second.outcome).toBe('refused');
    expect(await fs.readlink(path.join(root, 'current'))).toBe(B);
  });

  it('release git reads write nothing and stay offline', async () => {
    await recordGrant('release-install', A, 'grant-install');
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
