/**
 * CO14 CLI tests: `release install | swap | rollback` through
 * `manageReleaseFromPayload` with a fake lease and a fake executor, and through
 * the registered command group with a real in-memory runtime (whose
 * coordination store holds no grant). The root does not exist, so the real
 * store adapter reads an empty store and nothing touches the filesystem.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { createFleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import { manageReleaseFromPayload, releaseAuthorization, releaseCommands } from '../release.js';

const ROOT = '/nonexistent-fleet-release-root-co14';
const SOURCE = '/nonexistent-fleet-v2-source-co14';
const SHA = 'a'.repeat(40);
const NOW = '2026-11-06T10:00:00.000Z';
const PROJECT = 'fleet-v2';

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
} {
  return {
    lease: { read: async () => lease } as unknown as ConductorDriverLeasePort,
    authorization: NO_GRANT,
    executor: new RecordingExecutor(),
    nowIso: () => NOW,
    env: () => ({ PATH: '/usr/bin' }),
  };
}

const installPayload = { action: 'install', root: ROOT, sha: SHA, source: SOURCE };

describe('release command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'CO14b fix round 3: a concurrent-apply race refuses the loser before it ever reaches ' +
      'manageReleaseFromPayload, and the winner still proceeds',
    async () => {
      const root = '/race-fleet-release-root-co14b';
      const stateDirA = await mkdtemp(join(tmpdir(), 'co14b-race-state-a-'));
      const stateDirB = await mkdtemp(join(tmpdir(), 'co14b-race-state-b-'));
      // Two drivers, configured with DIFFERENT state directories, racing the same unbound root.
      const rtA = createFleetCliRuntime({
        stateDir: stateDirA,
        installation: { daemon: { stateDir: stateDirA } } as never,
      });
      const rtB = createFleetCliRuntime({
        stateDir: stateDirB,
        installation: { daemon: { stateDir: stateDirB } } as never,
      });

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
      // `leaseIsLive()` calls `lease.read()` unconditionally, for a plan or an apply alike, as
      // the very first thing `ManageReleaseUseCase.run` does once a request parses (see the
      // 'planned' result's `lease: 'free'` field in the plan test above). Its call count is
      // therefore a direct, source-independent witness of whether `manageReleaseFromPayload`
      // ever ran for a given call.
      const leaseReadSpy = vi.spyOn(ConductorDriverLeaseAdapter.prototype, 'read');

      // CO14b fix round 4: the early bind this race protects is now gated on an actual
      // apply (plan-only calls never bind), so the payload must really be an apply — with
      // a project, or it would bail at 'authority-required' before ever reading the lease —
      // for this to still exercise the race it claims to.
      const payload = { root, sha: SHA, source: SOURCE, apply: true, project: PROJECT };
      const install = releaseCommands['install'];
      if (install === undefined) throw new Error('install command not registered');

      const winnerResult = await install(payload, rtA);
      expect(winnerResult).not.toEqual({ outcome: 'refused', reason: 'release-root-state-dir-unknown' });
      expect(leaseReadSpy).toHaveBeenCalledTimes(1);

      const loserResult = await install(payload, rtB);
      expect(loserResult).toEqual({ outcome: 'refused', reason: 'release-root-state-dir-unknown' });
      // The loser's own bindDriver call lost the race (it saw A's stateDir, not its own), so the
      // apply logic — witnessed by the lease check — is never reached for it: the call count is
      // unchanged from right after the winner's call.
      expect(leaseReadSpy).toHaveBeenCalledTimes(1);

      expect(readSpy).toHaveBeenCalledTimes(2);
      expect(bindSpy).toHaveBeenCalledTimes(2);
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
      } => ({
        lease: new ConductorDriverLeaseAdapter({ stateDir: sharedStateDir }),
        authorization: grantingAuthorization(root),
        executor: new RecordingExecutor(),
        nowIso: () => NOW,
        env: () => ({ PATH: '/usr/bin' }),
        store: new ReleaseStoreAdapter(),
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
    // CO14b fix round 3: the release handler now binds an unbound root to this
    // driver BEFORE calling into the authorization check, so the root must be
    // a real, writable directory for that bind to succeed (and the test to
    // reach the authorization refusal it means to exercise) rather than the
    // nonexistent ROOT sentinel under `/`, which a bind could never write to.
    const root = await mkdtemp(join(tmpdir(), 'co14-cli-release-root-'));
    const rt = createFleetCliRuntime({
      stateDir,
      installation: {
        schemaVersion: 2,
        forge: { mode: 'none' },
        hosts: {},
        daemon: {
          nodePath: '/usr/bin/node',
          cliPath: '/usr/bin/fleet-v2',
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
