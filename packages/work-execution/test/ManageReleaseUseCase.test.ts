/**
 * CO14 tests: `release install | swap | rollback` use case, with a fake store,
 * a fake driver lease and a fake command executor (no filesystem, no process).
 */

import { describe, expect, it } from 'vitest';

import { ManageReleaseUseCase } from '../src/application/use-cases/ManageReleaseUseCase.use-case.js';
import type {
  ManageReleaseRequest,
  ManageReleaseResult,
} from '../src/application/ports/in/ManageReleasePort.in-port.js';
import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../src/application/ports/out/CommandExecutorPort.out-port.js';
import type { ConductorDriverLeasePort } from '../src/application/ports/out/ConductorDriverLeasePort.out-port.js';
import type {
  ReleaseBuildRecord,
  ReleaseStoreListing,
  ReleaseStorePort,
  ReleaseStorePruneResult,
  ReleaseStoreWriteResult,
} from '../src/application/ports/out/ReleaseStorePort.out-port.js';
import type { ConductorDriverLeaseRecord } from '../src/domain/lane-run-lease.js';

const ROOT = '/srv/fleet-releases';
const SOURCE = '/srv/fleet-v2';
const NOW = '2026-11-06T10:00:00.000Z';
const AUTHORITY = 'owner-deploy-2026-11-06';

const sha = (digit: string): string => digit.repeat(40);
const A = sha('a');
const B = sha('b');
const C = sha('c');
const D = sha('d');
const E = sha('e');
const F = sha('f');

function build(digit: string, minute: number): ReleaseBuildRecord {
  return { sha: sha(digit), builtAtIso: `2026-11-0${minute}T09:00:00.000Z` };
}

class FakeStore implements ReleaseStorePort {
  builds: ReleaseBuildRecord[];
  current: string | null;
  unreadable = false;
  entryMissing = false;
  pruneUnreadable = false;
  readonly calls: string[] = [];
  readonly removed: string[] = [];

  constructor(builds: ReleaseBuildRecord[] = [], current: string | null = null) {
    this.builds = [...builds];
    this.current = current;
  }

  async prepare(input: { root: string; sha: string }): Promise<ReleaseStoreWriteResult> {
    this.calls.push(`prepare ${input.sha}`);
    return { outcome: 'ok' };
  }

  async list(): Promise<ReleaseStoreListing> {
    if (this.unreadable) {
      return { outcome: 'unreadable' };
    }
    return { outcome: 'read', current: this.current, builds: [...this.builds] };
  }

  async markVerified(input: { root: string; sha: string; builtAtIso: string }): Promise<ReleaseStoreWriteResult> {
    this.calls.push(`markVerified ${input.sha}`);
    if (this.entryMissing) {
      return { outcome: 'not-verified' };
    }
    this.builds = this.builds.filter((entry) => entry.sha !== input.sha);
    this.builds.push({ sha: input.sha, builtAtIso: input.builtAtIso });
    this.builds.sort((x, y) => Date.parse(x.builtAtIso) - Date.parse(y.builtAtIso) || (x.sha < y.sha ? -1 : 1));
    return { outcome: 'ok' };
  }

  async repoint(input: { root: string; sha: string }): Promise<ReleaseStoreWriteResult> {
    this.calls.push(`repoint ${input.sha}`);
    if (!this.builds.some((entry) => entry.sha === input.sha)) {
      return { outcome: 'not-found' };
    }
    this.current = input.sha;
    return { outcome: 'ok' };
  }

  async prune(input: { root: string; keep: number }): Promise<ReleaseStorePruneResult> {
    this.calls.push(`prune ${input.keep}`);
    if (this.pruneUnreadable) {
      return { outcome: 'unreadable' };
    }
    const keepSet = new Set(this.builds.slice(Math.max(0, this.builds.length - input.keep)).map((entry) => entry.sha));
    const index = this.builds.findIndex((entry) => entry.sha === this.current);
    if (index >= 0) {
      keepSet.add(this.builds[index].sha);
      if (index > 0) {
        keepSet.add(this.builds[index - 1].sha);
      }
    }
    const removed = this.builds.filter((entry) => !keepSet.has(entry.sha)).map((entry) => entry.sha);
    this.builds = this.builds.filter((entry) => keepSet.has(entry.sha));
    this.removed.push(...removed);
    return { outcome: 'pruned', removed };
  }

  async discard(input: { root: string; sha: string }): Promise<ReleaseStoreWriteResult> {
    this.calls.push(`discard ${input.sha}`);
    return { outcome: 'ok' };
  }

  get writes(): string[] {
    return this.calls;
  }
}

class FakeExecutor implements CommandExecutorPort {
  readonly runs: Array<{ argv: readonly string[]; options: CommandRunOptions | undefined }> = [];
  failAt: number | null = null;

  async run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
    this.runs.push({ argv, options });
    const failing = this.failAt === this.runs.length - 1;
    return { exitCode: failing ? 1 : 0, signal: null, stdout: 'out', stderr: failing ? 'secret-ish stderr' : '' };
  }
}

function fakeLease(lease: ConductorDriverLeaseRecord | null | Error): ConductorDriverLeasePort {
  return {
    read: async () => {
      if (lease instanceof Error) {
        throw lease;
      }
      return lease;
    },
  } as unknown as ConductorDriverLeasePort;
}

const LIVE_LEASE: ConductorDriverLeaseRecord = {
  version: 1,
  holderId: 'driver-1',
  fence: 1,
  leaseUntilIso: '2026-11-06T10:05:00.000Z',
};
const LAPSED_LEASE: ConductorDriverLeaseRecord = { ...LIVE_LEASE, leaseUntilIso: '2026-11-06T09:59:00.000Z' };

function request(overrides: Partial<ManageReleaseRequest> = {}): ManageReleaseRequest {
  return {
    action: 'install',
    root: ROOT,
    sha: A,
    source: SOURCE,
    keep: 5,
    apply: false,
    authority: null,
    ...overrides,
  };
}

function applyRequest(overrides: Partial<ManageReleaseRequest> = {}): ManageReleaseRequest {
  return request({ apply: true, authority: AUTHORITY, ...overrides });
}

function make(
  options: {
    store?: FakeStore;
    lease?: ConductorDriverLeaseRecord | null | Error;
    executor?: FakeExecutor;
  } = {},
): { useCase: ManageReleaseUseCase; store: FakeStore; executor: FakeExecutor } {
  const store = options.store ?? new FakeStore();
  const executor = options.executor ?? new FakeExecutor();
  const useCase = new ManageReleaseUseCase({
    store,
    lease: fakeLease(options.lease === undefined ? null : options.lease),
    executor,
    nowIso: () => NOW,
    env: () => ({ PATH: '/usr/bin', HOME: '/home/example', UNSET: undefined }),
  });
  return { useCase, store, executor };
}

async function manage(useCase: ManageReleaseUseCase, input: unknown): Promise<ManageReleaseResult> {
  return useCase.manageRelease(input as ManageReleaseRequest);
}

describe('ManageReleaseUseCase', () => {
  it('refuses invalid-request for a null request', async () => {
    const { useCase } = make();
    expect(await manage(useCase, null)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await manage(useCase, 'install')).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('refuses invalid-request for a request with a missing field', async () => {
    const { useCase } = make();
    const { authority: _authority, ...partial } = request();
    expect(await manage(useCase, partial)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await manage(useCase, { ...request(), extra: 1 })).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('refuses invalid-request for a request with a wrong-typed field', async () => {
    const { useCase } = make();
    for (const bad of [
      { keep: '5' },
      { keep: 1 },
      { keep: 65 },
      { keep: 2.5 },
      { apply: 'yes' },
      { sha: 'ABC' },
      { sha: null },
      { root: 'relative/root' },
      { root: 42 },
      { source: null },
      { authority: '' },
      { authority: 'x'.repeat(257) },
    ]) {
      expect(await manage(useCase, { ...request(), ...bad })).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
    expect(await manage(useCase, { ...request({ action: 'rollback', source: null }), sha: A })).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(await manage(useCase, { ...request({ action: 'swap' }), source: SOURCE })).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
  });

  it('refuses invalid-request for a sparse array request', async () => {
    const { useCase } = make();
    // eslint-disable-next-line no-sparse-arrays
    expect(await manage(useCase, [, , ,])).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await manage(useCase, [request()])).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('refuses invalid-request for an unknown action enum value', async () => {
    const { useCase } = make();
    expect(await manage(useCase, { ...request(), action: 'upgrade' })).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
  });

  it('refuses invalid-request for a request whose getter throws', async () => {
    const { useCase } = make();
    const hostile = { ...request() };
    Object.defineProperty(hostile, 'root', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(await manage(useCase, hostile)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('refuses invalid-request when the root is too long or holds a .. segment', async () => {
    const { useCase } = make();
    for (const root of [`/${'a'.repeat(4096)}`, '/srv/../etc', '/srv/releases/..', '/srv/a\0b']) {
      expect(await manage(useCase, request({ root }))).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
    expect(await manage(useCase, request({ source: '/srv/../x' }))).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
  });

  it('refuses authority-required when apply is true without authority', async () => {
    const { useCase, store, executor } = make();
    for (const authority of [null, '   ']) {
      expect(await manage(useCase, request({ apply: true, authority }))).toEqual({
        outcome: 'refused',
        reason: 'authority-required',
      });
    }
    expect(store.calls).toEqual([]);
    expect(executor.runs).toEqual([]);
  });

  it('refuses driver-lease-live while the conductor driver lease is live', async () => {
    const { useCase, store, executor } = make({ lease: LIVE_LEASE });
    expect(await manage(useCase, applyRequest())).toEqual({ outcome: 'refused', reason: 'driver-lease-live' });
    expect(store.calls).toEqual([]);
    expect(executor.runs).toEqual([]);
    const lapsed = make({ lease: LAPSED_LEASE });
    expect((await manage(lapsed.useCase, applyRequest())).outcome).toBe('applied');
  });

  it('refuses lease-unknown when the lease read throws', async () => {
    const { useCase, store } = make({ lease: new Error('unreadable lease file') });
    expect(await manage(useCase, applyRequest())).toEqual({ outcome: 'refused', reason: 'lease-unknown' });
    expect(await manage(useCase, request())).toEqual({ outcome: 'refused', reason: 'lease-unknown' });
    expect(store.calls).toEqual([]);
  });

  it('refuses store-unreadable when the store listing is unreadable', async () => {
    const store = new FakeStore();
    store.unreadable = true;
    const { useCase } = make({ store });
    expect(await manage(useCase, request())).toEqual({ outcome: 'refused', reason: 'store-unreadable' });
  });

  it('refuses not-found when swap names a sha that is not kept', async () => {
    const { useCase, store } = make({ store: new FakeStore([build('a', 1)], A) });
    expect(await manage(useCase, applyRequest({ action: 'swap', sha: B, source: null }))).toEqual({
      outcome: 'refused',
      reason: 'not-found',
    });
    expect(store.calls).toEqual([]);
  });

  it('refuses not-found when rollback has no previous build', async () => {
    const { useCase } = make({ store: new FakeStore([build('a', 1)], A) });
    expect(await manage(useCase, applyRequest({ action: 'rollback', sha: null, source: null }))).toEqual({
      outcome: 'refused',
      reason: 'not-found',
    });
    const noCurrent = make({ store: new FakeStore([build('a', 1), build('b', 2)], null) });
    expect(await manage(noCurrent.useCase, request({ action: 'rollback', sha: null, source: null }))).toEqual({
      outcome: 'refused',
      reason: 'not-found',
    });
  });

  it('refuses build-failed when the build step exits non-zero and never marks or repoints', async () => {
    for (let failAt = 0; failAt < 4; failAt += 1) {
      const executor = new FakeExecutor();
      executor.failAt = failAt;
      const { useCase, store } = make({ executor });
      expect(await manage(useCase, applyRequest())).toEqual({ outcome: 'refused', reason: 'build-failed' });
      expect(store.calls).toEqual([`prepare ${A}`, `discard ${A}`]);
      expect(store.current).toBeNull();
      expect(executor.runs).toHaveLength(failAt + 1);
    }
  });

  it('refuses verify-failed when the built tree has no CLI entry', async () => {
    const store = new FakeStore();
    store.entryMissing = true;
    const { useCase } = make({ store });
    expect(await manage(useCase, applyRequest())).toEqual({ outcome: 'refused', reason: 'verify-failed' });
    expect(store.calls).toEqual([`prepare ${A}`, `markVerified ${A}`, `discard ${A}`]);
    expect(store.current).toBeNull();
  });

  it('prints the plan without applying and writes nothing', async () => {
    const store = new FakeStore([build('a', 1), build('b', 2), build('c', 3)], C);
    const { useCase, executor } = make({ store, lease: LIVE_LEASE });
    const result = await manage(useCase, request({ action: 'swap', sha: A, source: null }));
    expect(result).toEqual({
      outcome: 'planned',
      action: 'swap',
      target: A,
      current: C,
      previous: B,
      kept: [A, B, C],
      wouldPrune: [],
      lease: 'live',
    });
    expect(store.calls).toEqual([]);
    expect(executor.runs).toEqual([]);

    const install = make({ store: new FakeStore([build('a', 1)], A) });
    expect(await manage(install.useCase, request({ sha: B }))).toMatchObject({
      outcome: 'planned',
      target: B,
      current: A,
      previous: null,
      kept: [A],
      lease: 'free',
    });
    expect(install.store.calls).toEqual([]);
    expect(install.executor.runs).toEqual([]);
  });

  it('install builds, verifies and repoints current', async () => {
    const { useCase, store, executor } = make();
    const result = await manage(useCase, applyRequest());
    expect(result).toEqual({
      outcome: 'applied',
      action: 'install',
      target: A,
      current: A,
      kept: [A],
      pruned: [],
      pruneOutcome: 'pruned',
      rebuilt: true,
    });
    expect(store.calls).toEqual([`prepare ${A}`, `markVerified ${A}`, `repoint ${A}`, 'prune 5']);
    expect(executor.runs.map((run) => run.argv)).toEqual([
      [
        'git',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-C',
        SOURCE,
        'archive',
        '--format=tar',
        '--output',
        `${ROOT}/${A}.tar`,
        A,
      ],
      ['tar', '-xf', `${ROOT}/${A}.tar`, '-C', `${ROOT}/${A}`],
      ['yarn', 'install', '--immutable'],
      ['yarn', 'build'],
    ]);
    for (const run of executor.runs) {
      expect(run.options?.timeoutMs).toBeGreaterThan(0);
      expect(run.options?.maxBufferBytes).toBeGreaterThan(0);
    }
    expect(executor.runs[2].options?.cwd).toBe(`${ROOT}/${A}`);
  });

  it('install of an already built sha does not build twice', async () => {
    const { useCase, store, executor } = make({ store: new FakeStore([build('a', 1), build('b', 2)], B) });
    const result = await manage(useCase, applyRequest({ sha: A }));
    expect(result).toMatchObject({ outcome: 'applied', target: A, current: A, rebuilt: false });
    expect(executor.runs).toEqual([]);
    expect(store.calls).toEqual([`repoint ${A}`, 'prune 5']);
    expect(store.builds.filter((entry) => entry.sha === A)).toHaveLength(1);
  });

  it('completes a crash between the build and the repoint on the next install', async () => {
    const store = new FakeStore([build('a', 1)], null);
    const { useCase, executor } = make({ store });
    const result = await manage(useCase, applyRequest({ sha: A }));
    expect(result).toMatchObject({ outcome: 'applied', current: A, rebuilt: false });
    expect(store.current).toBe(A);
    expect(executor.runs).toEqual([]);
  });

  it('swap repoints current to a kept build', async () => {
    const { useCase, store } = make({ store: new FakeStore([build('a', 1), build('b', 2), build('c', 3)], C) });
    const result = await manage(useCase, applyRequest({ action: 'swap', sha: A, source: null }));
    expect(result).toMatchObject({ outcome: 'applied', action: 'swap', target: A, current: A, rebuilt: false });
    expect(store.current).toBe(A);
  });

  it('rollback repoints current to the previous kept build', async () => {
    const { useCase, store } = make({ store: new FakeStore([build('a', 1), build('b', 2), build('c', 3)], C) });
    const result = await manage(useCase, applyRequest({ action: 'rollback', sha: null, source: null }));
    expect(result).toMatchObject({ outcome: 'applied', action: 'rollback', target: B, current: B, rebuilt: false });
    expect(store.current).toBe(B);
  });

  it('prunes to the keep count and never removes current or previous', async () => {
    const builds = [build('a', 1), build('b', 2), build('c', 3), build('d', 4), build('e', 5)];
    const plan = make({ store: new FakeStore(builds, E) });
    expect(await manage(plan.useCase, request({ action: 'swap', sha: B, source: null, keep: 2 }))).toMatchObject({
      outcome: 'planned',
      wouldPrune: [C],
    });

    const { useCase, store } = make({ store: new FakeStore(builds, E) });
    const result = await manage(useCase, applyRequest({ action: 'swap', sha: B, source: null, keep: 2 }));
    expect(result).toMatchObject({ outcome: 'applied', current: B, pruned: [C], kept: [A, B, D, E] });
    expect(store.removed).toEqual([C]);

    const fresh = make({ store: new FakeStore(builds, E) });
    expect(await manage(fresh.useCase, applyRequest({ sha: F, keep: 2 }))).toMatchObject({
      outcome: 'applied',
      current: F,
      kept: [E, F],
      pruned: [A, B, C, D],
    });
  });

  it('the result carries no path and no secret-shaped value', async () => {
    const plan = await manage(make().useCase, request());
    const applied = await manage(make().useCase, applyRequest());
    const executor = new FakeExecutor();
    executor.failAt = 3;
    const refused = await manage(make({ executor }).useCase, applyRequest());
    for (const result of [plan, applied, refused]) {
      const text = JSON.stringify(result);
      expect(text).not.toContain(ROOT);
      expect(text).not.toContain(SOURCE);
      expect(text).not.toContain(AUTHORITY);
      expect(text).not.toContain('secret-ish');
      expect(text).not.toContain('/srv');
    }
  });

  it('the git step runs with GIT_ALLOW_PROTOCOL none, GIT_NO_LAZY_FETCH 1 and no hooks path', async () => {
    const { useCase, executor } = make();
    await manage(useCase, applyRequest());
    const git = executor.runs[0];
    expect(git.argv).toContain('core.hooksPath=/dev/null');
    expect(git.argv).toContain('core.fsmonitor=false');
    expect(git.options?.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/example',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'none',
      GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0',
    });
    expect(git.options?.cwd).toBe(SOURCE);
    expect(git.options?.killProcessTree).toBe(true);
  });

  it('the git child never sees the operator environment beyond the allowlist', async () => {
    const { useCase, executor } = make();
    await manage(useCase, applyRequest());
    const env = executor.runs[0].options?.env ?? {};
    for (const key of Object.keys(env)) {
      expect(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'GIT_CONFIG_NOSYSTEM', 'GIT_ALLOW_PROTOCOL', 'GIT_NO_LAZY_FETCH', 'GIT_TERMINAL_PROMPT']).toContain(key);
    }
  });

  it('reports an unreadable prune instead of a false success', async () => {
    const store = new FakeStore([build('a', 1), build('b', 2), build('c', 3), build('d', 4), build('e', 5)], E);
    store.pruneUnreadable = true;
    const { useCase } = make({ store });
    const result = await manage(useCase, applyRequest({ action: 'swap', sha: B, source: null }));
    expect(result).toMatchObject({ outcome: 'applied', action: 'swap', target: B, current: B, pruned: [], pruneOutcome: 'unreadable' });
  });

  it('a failed build step discards the archive and the partial build dir so a retry starts clean', async () => {
    const executor = new FakeExecutor();
    executor.failAt = 3;
    const { useCase, store } = make({ executor });
    expect(await manage(useCase, applyRequest())).toEqual({ outcome: 'refused', reason: 'build-failed' });
    expect(store.calls).toEqual([`prepare ${A}`, `discard ${A}`]);

    const verifiedStore = new FakeStore();
    verifiedStore.entryMissing = true;
    const verifyCase = make({ store: verifiedStore });
    expect(await manage(verifyCase.useCase, applyRequest())).toEqual({ outcome: 'refused', reason: 'verify-failed' });
    expect(verifiedStore.calls).toEqual([`prepare ${A}`, `markVerified ${A}`, `discard ${A}`]);
  });
});
