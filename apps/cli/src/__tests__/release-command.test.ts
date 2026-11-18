/**
 * CO14 CLI tests: `release install | swap | rollback` through
 * `manageReleaseFromPayload` with a fake lease and a fake executor, and through
 * the registered command group with a real in-memory runtime (whose
 * coordination store holds no grant). The root does not exist, so the real
 * store adapter reads an empty store and nothing touches the filesystem.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * CO14c-1 fix round 2: the fs seam used to force a `realpath` failure. The
 * wrapper delegates to the real `node:fs/promises` unless a failure is armed
 * (and armed failures are consumed once), so every other test in this file
 * keeps the real filesystem behavior.
 */
const realpathFailure = vi.hoisted(() => ({ code: null as string | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const injectedRealpath = (path: string) => {
    const code = realpathFailure.code;
    if (code !== null) {
      throw Object.assign(new Error(`injected realpath failure (${code})`), { code });
    }
    return actual.realpath(path);
  };
  return { ...actual, realpath: Object.assign(injectedRealpath, { native: actual.realpath }) };
});

import {
  ConductorDriverLeaseAdapter,
  ReleaseStoreAdapter,
  type ActionAuthorizationPort,
  type CommandExecutorPort,
  type CommandRunOptions,
  type CommandRunResult,
  type ConductorDriverLeaseRecord,
  type ConductorDriverLeasePort,
} from '@fleet/work-execution';

import { CliUsageError } from '../commands/payload.js';
import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import {
  manageReleaseFromPayload,
  parseConfiguredCliPath,
  releaseAuthorization,
  releaseCommands,
} from '../release.js';

const ROOT = '/nonexistent-fleet-release-root-co14';
const SOURCE = '/nonexistent-fleet-v2-source-co14';
const SHA = 'a'.repeat(40);
const NOW = '2026-11-06T10:00:00.000Z';
const PROJECT = 'fleet-v2';
const DEFAULT_STATE_DIR = '/nonexistent-fleet-v2-driver-state-co14b';

const LIVE_LEASE: ConductorDriverLeaseRecord = {
  version: 1,
  holderId: 'driver-1',
  fence: 1,
  leaseUntilIso: '2026-11-06T10:05:00.000Z',
};

class RecordingExecutor implements CommandExecutorPort {
  readonly runs: string[][] = [];
  async run(argv: readonly string[], _options?: CommandRunOptions): Promise<CommandRunResult> {
    this.runs.push([...argv]);
    return { exitCode: 0, signal: null, stdout: '', stderr: '' };
  }
}

/** No grant is recorded: every resolve is blocked. */
const NO_GRANT: ActionAuthorizationPort = {
  resolveActionAuthorization: async () => ({ outcome: 'blocked', reason: 'no recorded decision' }),
  consumeActionAuthorization: async () => ({ outcome: 'refused', reason: 'no grant' }),
};

/** Every resolve is granted for `root`, and every consumption of that grant succeeds. */
function grantingAuthorization(root: string): ActionAuthorizationPort {
  return {
    resolveActionAuthorization: async (request) => ({
      outcome: 'granted',
      authorizationGrantId: `grant-${request.actionId}`,
      releaseRoot: root,
    }),
    consumeActionAuthorization: async (request) => ({ outcome: 'consumed', actionId: request.actionId }),
  };
}

function deps(lease: ConductorDriverLeaseRecord | null = null): {
  lease: ConductorDriverLeasePort;
  authorization: ActionAuthorizationPort;
  executor: RecordingExecutor;
  nowIso: () => string;
  env: () => Record<string, string | undefined>;
  stateDir: string;
} {
  return {
    lease: { read: async () => lease } as unknown as ConductorDriverLeasePort,
    authorization: NO_GRANT,
    executor: new RecordingExecutor(),
    nowIso: () => NOW,
    env: () => ({ PATH: '/usr/bin' }),
    stateDir: DEFAULT_STATE_DIR,
  };
}

const installPayload = { action: 'install', root: ROOT, sha: SHA, source: SOURCE };

describe('release command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'CO14b fix round 8: two different drivers race the SAME unbound root; the loser is still ' +
      'refused by the binding, but only once BOTH are genuinely authorized -- the original ' +
      'round 3 race protection, now reached only after authorization (finding 1)',
    async () => {
      // Historical note: through round 7, this test went through
      // `releaseCommands['install']` with NO grant recorded, and witnessed
      // the race by `ConductorDriverLeaseAdapter.prototype.read`'s call
      // count: the loser was refused by `releaseHandler`'s own bind-before-
      // apply write, entirely before `manageReleaseFromPayload` ever ran, so
      // the lease was never even read for it. Round 8 moved that bind to
      // AFTER authorization (see the two tests below, and the use-case-level
      // tests in ManageReleaseUseCase.test.ts): an unauthorized request now
      // never reaches the bind at all, so two UNAUTHORIZED racers are no
      // longer distinguishable this way -- both are refused identically
      // (`authority-refused`), before either's bind is ever attempted. This
      // test is rewritten to race two GENUINELY authorized callers instead,
      // which is the only way the binding race remains observable.
      const root = '/race-fleet-release-root-co14b';
      const stateDirA = '/race-fleet-release-state-a-co14b';
      const stateDirB = '/race-fleet-release-state-b-co14b';

      // Both racers read the root as unbound, exactly as they would before either has written
      // the binding file.
      const readSpy = vi
        .spyOn(ReleaseStoreAdapter.prototype, 'readDriverBinding')
        .mockResolvedValue({ outcome: 'unbound' });
      // A's bindDriver call wins the exclusive-create. B's own bindDriver call then loses the
      // race and, as the real adapter's EEXIST-reread does, reports A's stateDir — not B's own.
      const bindSpy = vi
        .spyOn(ReleaseStoreAdapter.prototype, 'bindDriver')
        .mockResolvedValueOnce({ outcome: 'bound', stateDir: stateDirA })
        .mockResolvedValueOnce({ outcome: 'bound', stateDir: stateDirA });

      const payload = { action: 'install', root, sha: SHA, source: SOURCE, apply: true, project: PROJECT };
      const depsFor = (stateDir: string): ReturnType<typeof deps> => ({
        ...deps(),
        authorization: grantingAuthorization(root),
        stateDir,
      });

      const winnerResult = await manageReleaseFromPayload(payload, depsFor(stateDirA));
      // The winner's bind matched its own state directory, so it is never refused for the
      // binding reason (whatever it is ultimately refused or applied for afterward).
      expect(winnerResult).not.toEqual({ outcome: 'refused', reason: 'release-root-state-dir-unknown' });

      const loserResult = await manageReleaseFromPayload(payload, depsFor(stateDirB));
      // The loser's own bindDriver call lost the race (it saw A's stateDir, not its own).
      expect(loserResult).toEqual({ outcome: 'refused', reason: 'release-root-state-dir-unknown' });

      expect(readSpy).toHaveBeenCalledTimes(2);
      expect(bindSpy).toHaveBeenCalledTimes(2);
    },
  );

  it(
    'CO14b fix round 8 (finding 1): an unauthorized apply on a fresh, unbound root never ' +
      'calls bindDriver, and never creates the root directory',
    async () => {
      const base = await mkdtemp(join(tmpdir(), 'co14b-r8-no-auth-base-'));
      const root = join(base, 'release-root');
      const stateDir = await mkdtemp(join(tmpdir(), 'co14b-r8-no-auth-state-'));
      const bindSpy = vi.spyOn(ReleaseStoreAdapter.prototype, 'bindDriver');
      const result = await manageReleaseFromPayload(
        { action: 'install', root, sha: SHA, source: SOURCE, apply: true, project: PROJECT },
        { ...deps(), store: new ReleaseStoreAdapter(), stateDir },
      );
      // No project / no matching grant: refused for lack of authority, never for a binding reason.
      expect(result).toEqual({ outcome: 'refused', reason: 'authority-refused' });
      expect(bindSpy).not.toHaveBeenCalled();
      // No bind means no `fs.mkdir(root, { recursive: true })` and no `.release-driver` marker:
      // the root directory itself was never created on disk.
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it(
    'CO14b fix round 8 (finding 1): a genuinely authorized apply on a fresh, unbound root ' +
      'still binds it correctly',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'co14b-r8-auth-root-'));
      const stateDir = await mkdtemp(join(tmpdir(), 'co14b-r8-auth-state-'));
      const store = new ReleaseStoreAdapter();
      // A pre-seeded verified build, so a swap needs no real build of its own.
      const staging = await store.prepare({ root, sha: SHA });
      if (staging.outcome !== 'prepared') throw new Error('prepare failed');
      const entry = join(staging.buildDir, 'apps', 'cli', 'dist');
      await mkdir(entry, { recursive: true });
      await writeFile(join(entry, 'bin.js'), '// built\n');
      expect(await store.markVerified({ root, sha: SHA, buildId: staging.buildId, builtAtIso: NOW })).toEqual({
        outcome: 'ok',
      });
      expect(await store.readDriverBinding({ root })).toEqual({ outcome: 'unbound' });

      const result = await manageReleaseFromPayload(
        { action: 'swap', root, sha: SHA, apply: true, project: PROJECT },
        {
          // A swap goes through the fenced repoint, which needs a real
          // acquire/renew/release lease -- `deps()`'s bare `{ read }` stub
          // (sufficient for every other test in this file, none of which
          // reaches that path) is not enough here.
          lease: new ConductorDriverLeaseAdapter({ stateDir }),
          authorization: grantingAuthorization(root),
          executor: new RecordingExecutor(),
          nowIso: () => NOW,
          env: () => ({ PATH: '/usr/bin' }),
          store,
          stateDir,
        },
      );
      expect(result).toMatchObject({ outcome: 'applied', action: 'swap', target: SHA });
      expect(await store.readDriverBinding({ root })).toEqual({ outcome: 'bound', stateDir });
    },
  );

  it(
    'CO14b fix round 4 investigation: two appliers configured with the SAME state directory ' +
      "cannot both land -- the driver lease's own CAS serializes them, not the binding, which " +
      'tells both callers they match',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'co14b-same-state-root-'));
      const sharedStateDir = await mkdtemp(join(tmpdir(), 'co14b-same-state-shared-'));
      const SHA_X = 'b'.repeat(40);
      const SHA_Y = 'c'.repeat(40);

      // Two already-verified builds under the same root, so a swap to either needs no build
      // of its own and the two callers' only shared mutable resource is `current` and the lease
      // that guards repointing it.
      const store = new ReleaseStoreAdapter();
      for (const sha of [SHA_X, SHA_Y]) {
        const staging = await store.prepare({ root, sha });
        if (staging.outcome !== 'prepared') throw new Error('prepare failed');
        const entry = join(staging.buildDir, 'apps', 'cli', 'dist');
        await mkdir(entry, { recursive: true });
        await writeFile(join(entry, 'bin.js'), '// built\n');
        expect(
          await store.markVerified({ root, sha, buildId: staging.buildId, builtAtIso: NOW }),
        ).toEqual({ outcome: 'ok' });
      }

      // Both appliers are configured with the SAME state directory, so once each passes the
      // (mocked) binding check below with a value that matches its own configuration, the
      // binding layer alone cannot tell them apart -- A's hypothetical fresh `wx` create and
      // B's hypothetical EEXIST re-read would report the identical stateDir either way. What
      // is NOT mocked is the lease: each gets its own real `ConductorDriverLeaseAdapter`
      // pointed at that one real, shared state directory, exactly as `releaseHandler`
      // constructs it per call.
      const depsFor = (): {
        lease: ConductorDriverLeaseAdapter;
        authorization: ActionAuthorizationPort;
        executor: RecordingExecutor;
        nowIso: () => string;
        env: () => Record<string, string | undefined>;
        store: ReleaseStoreAdapter;
        stateDir: string;
      } => ({
        lease: new ConductorDriverLeaseAdapter({ stateDir: sharedStateDir }),
        authorization: grantingAuthorization(root),
        executor: new RecordingExecutor(),
        nowIso: () => NOW,
        env: () => ({ PATH: '/usr/bin' }),
        store: new ReleaseStoreAdapter(),
        // CO14b fix round 8: the bind-when-unbound write now lives in the use
        // case, keyed off this same field -- both appliers share it here
        // exactly as they share `sharedStateDir` for their lease adapters
        // above, so the binding layer still cannot tell them apart (the
        // point of this test).
        stateDir: sharedStateDir,
      });

      const [resultA, resultB] = await Promise.all([
        manageReleaseFromPayload({ action: 'swap', root, sha: SHA_X, apply: true, project: PROJECT }, depsFor()),
        manageReleaseFromPayload({ action: 'swap', root, sha: SHA_Y, apply: true, project: PROJECT }, depsFor()),
      ]);

      // Both callers were configured identically (same shared state directory), so if the
      // binding's coincidental match were the real safety net, nothing would stop both from
      // landing. Exactly one actually applies; the other is refused specifically by the
      // lease's own CAS (decideLeaseAcquire's `lease-held`, read fresh under the state
      // directory's exclusive lock file), surfaced here as `driver-lease-live` --
      // proving the lease adapter, not the binding, is what keeps two same-state-dir
      // appliers from both landing.
      const results = [resultA, resultB];
      const applied = results.filter((r) => (r as { outcome: string }).outcome === 'applied');
      const refused = results.filter((r) => (r as { outcome: string }).outcome === 'refused');
      expect(applied).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect((refused[0] as { reason: string }).reason).toBe('driver-lease-live');
    },
  );

  it('install without apply returns the plan and runs no command', async () => {
    const d = deps();
    const result = await manageReleaseFromPayload(installPayload, d);
    expect(result).toEqual({
      outcome: 'planned',
      action: 'install',
      target: SHA,
      current: null,
      previous: null,
      kept: [],
      wouldPrune: [],
      lease: 'free',
    });
    expect(d.executor.runs).toEqual([]);
  });

  it('install with apply and no project is refused', async () => {
    const d = deps();
    expect(await manageReleaseFromPayload({ ...installPayload, apply: true }, d)).toEqual({
      outcome: 'refused',
      reason: 'authority-required',
    });
    expect(d.executor.runs).toEqual([]);
  });

  it('install with apply and no recorded grant is refused', async () => {
    const d = deps();
    expect(await manageReleaseFromPayload({ ...installPayload, apply: true, project: PROJECT }, d)).toEqual({
      outcome: 'refused',
      reason: 'authority-refused',
    });
    expect(d.executor.runs).toEqual([]);
  });

  it('a free-text --authority flag is a usage error, never authority', async () => {
    const d = deps();
    await expect(
      manageReleaseFromPayload({ ...installPayload, apply: true, authority: 'owner-said-yes' }, d),
    ).rejects.toBeInstanceOf(CliUsageError);
    expect(d.executor.runs).toEqual([]);
  });

  it('the registered release group refuses apply on a runtime with no recorded grant', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'co14-cli-release-'));
    // A real, writable root (rather than the nonexistent ROOT sentinel under
    // `/`). CO14b fix round 8: the bind-when-unbound write now happens only
    // AFTER authorization grants (ManageReleaseUseCase.bindRootIfUnbound), so
    // this runtime's empty coordination store refuses the apply for lack of
    // authority before the bind is ever attempted either way; a real root is
    // kept here only so a future lane that adds a recorded grant to this test
    // exercises the same bind path the two tests above cover directly.
    const root = await mkdtemp(join(tmpdir(), 'co14-cli-release-root-'));
    const rt = createFleetCliRuntime({
      stateDir,
      installation: {
        schemaVersion: 2,
        forge: { mode: 'none' },
        hosts: {},
        daemon: {
          nodePath: '/usr/bin/node',
          // CO14c-1: the entry point must be the served root's own, so the
          // handler can extract the root lexically and re-check `--root`.
          cliPath: `${root}/current/apps/cli/dist/bin.js`,
          stateDir,
          unitDir: join(stateDir, 'units'),
          installationFile: join(stateDir, 'fleet.json'),
        },
      } as never,
    });
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ['release', 'install', '--root', root, '--sha', SHA, '--source', SOURCE, '--project', PROJECT, '--apply'],
      { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      rt,
    );
    expect(err.join('')).toBe('');
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'refused', reason: 'authority-refused' });
    const authorization = releaseAuthorization(rt);
    expect(
      await authorization.resolveActionAuthorization({
        actionId: `release-install-${SHA}`,
        projectId: PROJECT,
        workOrderId: 'w',
        attemptId: 'a',
        actionKind: 'release-install',
        expectedHeadSha: SHA,
        policyRevision: 'p',
      }),
    ).toMatchObject({ outcome: 'blocked' });
    // A forge action kind is never resolved through the release grant path.
    expect(
      await authorization.resolveActionAuthorization({
        actionId: 'x',
        projectId: PROJECT,
        workOrderId: 'w',
        attemptId: 'a',
        actionKind: 'merge-pr',
        expectedHeadSha: SHA,
        policyRevision: 'p',
      }),
    ).toEqual({ outcome: 'blocked', reason: 'not a release action' });
  });

  /** A real runtime whose installation serves `root` through `daemon.cliPath`. */
  async function runtimeServingRoot(root: string, stateDir: string): Promise<FleetCliRuntime> {
    return createFleetCliRuntime({
      stateDir,
      installation: {
        schemaVersion: 2,
        forge: { mode: 'none' },
        hosts: {},
        daemon: {
          nodePath: '/usr/bin/node',
          cliPath: `${root}/current/apps/cli/dist/bin.js`,
          stateDir,
          unitDir: join(stateDir, 'units'),
          installationFile: join(stateDir, 'fleet.json'),
        },
      } as never,
    });
  }

  it(
    'CO14c-1: a symlinked --root that resolves to the configured root is accepted, ' +
      'and RR1: the grant coordinates use the realpath-resolved canonical root',
    async () => {
      const base = await mkdtemp(join(tmpdir(), 'co14c-symlink-base-'));
      const root = join(base, 'releases');
      await mkdir(root, { recursive: true });
      const link = join(base, 'root-link');
      await symlink(root, link);
      const stateDir = await mkdtemp(join(tmpdir(), 'co14c-symlink-state-'));
      const rt = await runtimeServingRoot(root, stateDir);
      // RR1: the realpath-resolved root travels with the grant coordinates, so
      // `coordination request-decision --release-root` binds the same canonical
      // root the release resolves — the store sees the canonical root, never
      // the symlink path, which would strand a crashed operation's consumed
      // grant under a path no grant was bound to.
      const listSpy = vi.spyOn(ReleaseStoreAdapter.prototype, 'list');
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(
        ['release', 'install', '--root', link, '--sha', SHA, '--source', link],
        { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
        rt,
      );
      expect(err.join('')).toBe('');
      expect(code).toBe(0);
      expect(JSON.parse(out.join('')).outcome).toBe('planned');
      expect(listSpy).toHaveBeenCalledWith({ root });
      listSpy.mockRestore();
    },
  );

  it('CO14c-1: a symlink to an unrelated directory, with no bin.js entry there, is refused', async () => {
    const base = await mkdtemp(join(tmpdir(), 'co14c-unrelated-base-'));
    const root = join(base, 'releases');
    await mkdir(root, { recursive: true });
    const unrelated = join(base, 'unrelated');
    await mkdir(unrelated, { recursive: true });
    const link = join(base, 'root-link');
    await symlink(unrelated, link);
    const stateDir = await mkdtemp(join(tmpdir(), 'co14c-unrelated-state-'));
    const rt = await runtimeServingRoot(root, stateDir);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ['release', 'install', '--root', link, '--sha', SHA, '--source', link],
      { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      rt,
    );
    expect(err.join('')).toBe('');
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'refused', reason: 'release-root-state-dir-unknown' });
  });

  it('CO14c-1: a nonexistent root is refused even on install --apply (the operator pre-creates it)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'co14c-missing-base-'));
    const root = join(base, 'releases');
    const stateDir = await mkdtemp(join(tmpdir(), 'co14c-missing-state-'));
    const rt = await runtimeServingRoot(root, stateDir);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ['release', 'install', '--root', root, '--sha', SHA, '--source', root, '--project', PROJECT, '--apply'],
      { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      rt,
    );
    expect(err.join('')).toBe('');
    expect(code).toBe(1);
    // CO14c-1 fix round 2: the missing root keeps its own reason, but the
    // message echoes no path — it says only that the release root does not
    // exist and must be created before the first install, and points to the
    // runbook step.
    const refused = JSON.parse(out.join('')) as { message?: string };
    expect(refused).toEqual({
      outcome: 'refused',
      reason: 'release-root-missing',
      message: "the release root does not exist; create it before the first install " +
        "(runbook: cutover, step 'Before the first release install')",
    });
    expect(refused.message).not.toContain(root);
    expect(refused.message).not.toContain(base);
    // Nothing was created under the missing root's parent.
    expect(await stat(root).then(() => true, () => false)).toBe(false);
  });

  it('CO14c-1 fix round 2: a realpath failing with EACCES on --root gives release-root-state-dir-unknown', async () => {
    // Seam: this suite's fs seam is its `node:fs/promises` module mock (see
    // the top of the file): the test arms one injected `EACCES` failure on
    // `realpath` and delegates everything else to the real module. (A
    // chmod-000 directory was not used: these tests can run as root, where
    // permission bits do not refuse, so the module seam is deterministic.)
    const base = await mkdtemp(join(tmpdir(), 'co14c-eacces-base-'));
    const root = join(base, 'releases');
    await mkdir(root, { recursive: true });
    const stateDir = await mkdtemp(join(tmpdir(), 'co14c-eacces-state-'));
    const rt = await runtimeServingRoot(root, stateDir);
    try {
      realpathFailure.code = 'EACCES';
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(
        ['release', 'install', '--root', root, '--sha', SHA, '--source', root],
        { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
        rt,
      );
      expect(err.join('')).toBe('');
      expect(code).toBe(1);
      // `EACCES` is not a missing root: the refusal is the unknown-state-dir
      // one, with no message (so no path echo).
      expect(JSON.parse(out.join(''))).toEqual({
        outcome: 'refused',
        reason: 'release-root-state-dir-unknown',
      });
    } finally {
      realpathFailure.code = null;
    }
  });

  it('CO14c-1: an existing root that is not the configured root is refused (realpath mismatch)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'co14c-mismatch-base-'));
    const servedRoot = join(base, 'served');
    const otherRoot = join(base, 'other');
    await mkdir(servedRoot, { recursive: true });
    await mkdir(otherRoot, { recursive: true });
    const stateDir = await mkdtemp(join(tmpdir(), 'co14c-mismatch-state-'));
    const rt = await runtimeServingRoot(servedRoot, stateDir);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ['release', 'install', '--root', otherRoot, '--sha', SHA, '--source', otherRoot],
      { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      rt,
    );
    expect(err.join('')).toBe('');
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'refused', reason: 'release-root-state-dir-unknown' });
  });

  it(
    'CO14c-1 fix round 1: a configured served root that does not exist on disk is refused, ' +
      'even though --root exists (the configured root is resolved on disk, never trusted as a string)',
    async () => {
      const base = await mkdtemp(join(tmpdir(), 'co14c-config-missing-base-'));
      // `--root` exists on disk: a real directory.
      const root = join(base, 'served');
      await mkdir(root, { recursive: true });
      const stateDir = await mkdtemp(join(tmpdir(), 'co14c-config-missing-state-'));
      // The configured served root does NOT exist on disk, so only its
      // lexical string could ever be compared; the pre-check resolves it on
      // disk instead and refuses. (A configured root whose lexical string
      // equalled --root's real path while missing on disk cannot exist: the
      // realpath of an existing `--root` is itself an existing path. So the
      // property pinned here is that the configured root is always resolved
      // on disk — a missing one refuses, never falls back to a string
      // comparison.)
      const configured = join(base, 'served-configured');
      const rt = await runtimeServingRoot(configured, stateDir);
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(
        ['release', 'install', '--root', root, '--sha', SHA, '--source', root],
        { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
        rt,
      );
      expect(err.join('')).toBe('');
      expect(code).toBe(1);
      expect(JSON.parse(out.join(''))).toEqual({ outcome: 'refused', reason: 'release-root-state-dir-unknown' });
    },
  );

  it(
    "CO14c-1 fix round 1: an uncheckable --root with an installation that has no daemon.cliPath " +
      "is the usage error, not a root refusal",
    async () => {
      const stateDir = await mkdtemp(join(tmpdir(), 'co14c-uncheckable-state-'));
      // The installation records a driver state directory but no
      // `daemon.cliPath`.
      const rt = createFleetCliRuntime({
        stateDir,
        installation: { daemon: { stateDir } } as never,
      });
      // A relative root is uncheckable, so the whole root pre-check —
      // including the missing-`cliPath` refusal — is gated off, and the
      // request falls through unchanged. It is `parseRequest`, inside
      // `manageReleaseFromPayload` (the CLI usage layer), that decides this
      // outcome: a `CliUsageError`, which `runCli` reports as exit 2.
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(
        ['release', 'install', '--root', 'release-root-relative', '--sha', SHA, '--source', 'source'],
        { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
        rt,
      );
      expect(code).toBe(2);
      expect(out.join('')).toBe('');
      expect(err.join('')).toContain("--root <absolute path without '..'>");
    },
  );

  it('install with a live driver lease is refused', async () => {
    const d = deps(LIVE_LEASE);
    expect(await manageReleaseFromPayload({ ...installPayload, apply: true, project: PROJECT }, d)).toEqual({
      outcome: 'refused',
      reason: 'driver-lease-live',
    });
    expect(d.executor.runs).toEqual([]);
  });

  it('a usage error is a CliUsageError, not a refusal', async () => {
    const d = deps();
    const bad: Array<Record<string, unknown>> = [
      { action: 'install', sha: SHA, source: SOURCE },
      { action: 'install', root: 'relative', sha: SHA },
      { action: 'install', root: '/a/../b', sha: SHA },
      { action: 'install', root: ROOT, sha: 'XYZ' },
      { action: 'install', root: ROOT },
      { action: 'install', root: ROOT, sha: SHA, keep: '1' },
      { action: 'install', root: ROOT, sha: SHA, keep: '65' },
      { action: 'install', root: ROOT, sha: SHA, keep: 'many' },
      { action: 'install', root: ROOT, sha: SHA, bogus: '1' },
      { action: 'install', root: ROOT, sha: SHA, apply: 'maybe' },
      { action: 'install', root: ROOT, sha: SHA, project: '' },
      { action: 'rollback', root: ROOT, sha: SHA },
      { action: 'swap', root: ROOT, sha: SHA, source: SOURCE },
      { action: 'upgrade', root: ROOT, sha: SHA },
    ];
    for (const payload of bad) {
      await expect(manageReleaseFromPayload(payload, d)).rejects.toBeInstanceOf(CliUsageError);
    }
    const handler = releaseCommands['install'];
    await expect(handler({ root: ROOT, sha: SHA, action: 'swap' }, {} as never)).rejects.toBeInstanceOf(CliUsageError);
  });

  it('the command result carries no path and no project or grant value', async () => {
    const d = deps();
    const results = [
      await manageReleaseFromPayload({ ...installPayload, keep: '3' }, d),
      await manageReleaseFromPayload({ ...installPayload, apply: true }, d),
      await manageReleaseFromPayload({ action: 'swap', root: ROOT, sha: SHA, apply: true, project: PROJECT }, d),
      await manageReleaseFromPayload({ action: 'rollback', root: ROOT, apply: true, project: PROJECT }, d),
    ];
    for (const result of results) {
      const text = JSON.stringify(result);
      expect(text).not.toContain(ROOT);
      expect(text).not.toContain(SOURCE);
      expect(text).not.toContain(PROJECT);
      expect(text).not.toContain('nonexistent');
    }
    expect(results[2]).toEqual({ outcome: 'refused', reason: 'not-found' });
    expect(results[3]).toEqual({ outcome: 'refused', reason: 'not-found' });
  });
});

describe('parseConfiguredCliPath (CO14c-1)', () => {
  const VALID_ROOT = '/srv/current/releases';
  const VALID = `${VALID_ROOT}/current/apps/cli/dist/bin.js`;
  const REFUSAL = { outcome: 'refused', reason: 'release-root-state-dir-unknown' };

  it('accepts a lexically valid configured entry point and extracts its root prefix', () => {
    expect(parseConfiguredCliPath(VALID)).toEqual({ outcome: 'ok', root: VALID_ROOT });
  });

  it('accepts a root that itself contains a `current` segment (the parse is lexical, not segment-matching)', () => {
    expect(parseConfiguredCliPath('/srv/current/releases/current/apps/cli/dist/bin.js')).toEqual({
      outcome: 'ok',
      root: '/srv/current/releases',
    });
  });

  it('accepts the entry point lexically even when nothing exists on disk', () => {
    expect(parseConfiguredCliPath('/nonexistent-co14c/current/apps/cli/dist/bin.js')).toEqual({
      outcome: 'ok',
      root: '/nonexistent-co14c',
    });
  });

  it('refuses null', () => {
    expect(parseConfiguredCliPath(null)).toEqual(REFUSAL);
  });

  it('refuses undefined', () => {
    expect(parseConfiguredCliPath(undefined)).toEqual(REFUSAL);
  });

  it('refuses a wrong primitive (a number where a string is due)', () => {
    expect(parseConfiguredCliPath(4096)).toEqual(REFUSAL);
  });

  it('refuses a boolean where a string is due', () => {
    expect(parseConfiguredCliPath(true)).toEqual(REFUSAL);
  });

  it('refuses an array where a string is due', () => {
    expect(parseConfiguredCliPath([VALID])).toEqual(REFUSAL);
  });

  it('refuses a sparse array (an array hole where a string is due)', () => {
    const sparse: unknown[] = new Array(3);
    sparse[2] = VALID;
    expect(parseConfiguredCliPath(sparse)).toEqual(REFUSAL);
  });

  it('refuses an array-like object where a string is due', () => {
    expect(parseConfiguredCliPath({ length: 1, 0: VALID })).toEqual(REFUSAL);
  });

  it('refuses an enormous length before any traversal', () => {
    const enormous: unknown[] = new Array(2 ** 32 - 1);
    expect(parseConfiguredCliPath(enormous)).toEqual(REFUSAL);
  });

  it('refuses a string over the named length cap before any traversal', () => {
    const longRoot = `/${'a'.repeat(4096)}`;
    expect(parseConfiguredCliPath(`${longRoot}/current/apps/cli/dist/bin.js`)).toEqual(REFUSAL);
  });

  it('refuses a hostile object and never invokes a getter on it', () => {
    let getterCalls = 0;
    const hostile = {
      get toStringValue(): string {
        getterCalls += 1;
        return VALID;
      },
    };
    expect(parseConfiguredCliPath(hostile)).toEqual(REFUSAL);
    expect(getterCalls).toBe(0);
  });

  it('refuses a Proxy over a valid-shaped input and runs no get trap', () => {
    let getTraps = 0;
    const proxy = new Proxy(
      { value: VALID },
      {
        get(target, key) {
          getTraps += 1;
          return Reflect.get(target, key);
        },
      },
    );
    expect(parseConfiguredCliPath(proxy)).toEqual(REFUSAL);
    expect(getTraps).toBe(0);
  });

  it('refuses an object whose own key is prototype-polluting (via JSON.parse)', () => {
    const polluting: Record<string, unknown> = JSON.parse('{"__proto__": {}, "value": "/srv"}');
    expect(parseConfiguredCliPath(polluting)).toEqual(REFUSAL);
    expect(Object.keys(polluting)).toContain('value');
  });

  it('refuses a value missing the exact `/current/apps/cli/dist/bin.js` suffix', () => {
    expect(parseConfiguredCliPath('/usr/bin/fleet-v2')).toEqual(REFUSAL);
    expect(parseConfiguredCliPath('/srv/current/apps/cli/dist/bin.mjs')).toEqual(REFUSAL);
  });

  it('refuses an empty or relative prefix', () => {
    expect(parseConfiguredCliPath('/current/apps/cli/dist/bin.js')).toEqual(REFUSAL);
    expect(parseConfiguredCliPath('srv/current/apps/cli/dist/bin.js')).toEqual(REFUSAL);
  });

  it('refuses a prefix with a `..` segment', () => {
    expect(parseConfiguredCliPath('/srv/../etc/current/apps/cli/dist/bin.js')).toEqual(REFUSAL);
  });

  it('refuses a prefix with a `.` segment', () => {
    expect(parseConfiguredCliPath('/srv/./releases/current/apps/cli/dist/bin.js')).toEqual(REFUSAL);
  });

  it('refuses a prefix with an empty (`//`) segment', () => {
    expect(parseConfiguredCliPath('/srv//releases/current/apps/cli/dist/bin.js')).toEqual(REFUSAL);
  });

  it('refuses a prefix with a NUL byte', () => {
    expect(parseConfiguredCliPath('/srv\0/releases/current/apps/cli/dist/bin.js')).toEqual(REFUSAL);
  });

  it('is not satisfiable by a constant refusal: a valid input succeeds', () => {
    // A function that always returned REFUSAL would fail this assertion.
    expect(parseConfiguredCliPath(VALID)).toEqual({ outcome: 'ok', root: VALID_ROOT });
  });

  it('is not an identity echo of its input: the result is the prefix, not the whole string', () => {
    const parsed = parseConfiguredCliPath(VALID);
    if (parsed.outcome !== 'ok') throw new Error('expected ok');
    expect(parsed.root).not.toBe(VALID);
    expect(parsed.root).toBe(VALID_ROOT);
    // And a refusal does not echo its input either.
    const refused = parseConfiguredCliPath('/srv/current/apps/cli/dist/bin.js/../bin.js');
    expect(refused).toEqual(REFUSAL);
  });
});
