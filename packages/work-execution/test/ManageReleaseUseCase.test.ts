/**
 * CO14 tests: `release install | swap | rollback` use case, with a fake store,
 * a fake driver lease, a fake grant store behind ActionAuthorizationPort and a
 * fake command executor (no filesystem, no process).
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ManageReleaseUseCase } from '../src/application/use-cases/ManageReleaseUseCase.use-case.js';
import { ReleaseStoreAdapter } from '../src/infrastructure/adapters/ReleaseStoreAdapter.adapter.js';
import type {
  ManageReleaseRequest,
  ManageReleaseResult,
} from '../src/application/ports/in/ManageReleasePort.in-port.js';
import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../src/application/ports/out/CommandExecutorPort.out-port.js';
import type {
  ActionAuthorizationPort,
  ConsumeActionAuthorizationRequest,
  ConsumeActionAuthorizationResult,
  ResolveActionAuthorizationRequest,
  ResolveActionAuthorizationResult,
} from '../src/application/ports/out/ActionAuthorizationPort.out-port.js';
import type {
  ConductorDriverLeasePort,
  ConductorDriverLeaseResult,
} from '../src/application/ports/out/ConductorDriverLeasePort.out-port.js';
import type {
  ReleaseBuildRecord,
  ReleaseStagingResult,
  ReleaseStoreListing,
  ReleaseStorePort,
  ReleaseStorePruneResult,
  ReleaseStoreWriteResult,
} from '../src/application/ports/out/ReleaseStorePort.out-port.js';
import type {
  ConductorDriverLeaseRecord,
  LeaseAcquireRequest,
  LeaseHoldRequest,
  LeaseRefusal,
  LeaseRenewRequest,
} from '../src/domain/lane-run-lease.js';

const ROOT = '/srv/fleet-releases';
const SOURCE = '/srv/fleet-v2';
const NOW = '2026-11-06T10:00:00.000Z';
const PROJECT = 'fleet-v2';
const GRANT = 'grant-release-0001';

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

  prepared = 0;
  discardUnreadable = false;
  rootChanged = false;
  rootChangedLeftovers: string[] = [];
  readonly preparedIds: string[] = [];

  async prepare(input: { root: string; sha: string }): Promise<ReleaseStagingResult> {
    this.calls.push(`prepare ${input.sha}`);
    if (this.rootChanged) {
      return { outcome: 'root-changed', leftovers: this.rootChangedLeftovers };
    }
    this.prepared += 1;
    const buildId = `${input.sha}-${String(this.prepared).padStart(16, '0')}`;
    this.preparedIds.push(buildId);
    const buildDir = `${input.root}/.staging-${buildId}`;
    return { outcome: 'prepared', buildId, buildDir, archivePath: `${buildDir}.tar`, homeDir: `${buildDir}.home` };
  }

  async list(): Promise<ReleaseStoreListing> {
    if (this.unreadable) {
      return { outcome: 'unreadable' };
    }
    return { outcome: 'read', current: this.current, builds: [...this.builds] };
  }

  readonly verifiedIds: string[] = [];

  async markVerified(input: {
    root: string;
    sha: string;
    buildId: string;
    builtAtIso: string;
  }): Promise<ReleaseStoreWriteResult> {
    this.calls.push(`markVerified ${input.sha}`);
    this.verifiedIds.push(input.buildId);
    if (this.entryMissing) {
      return { outcome: 'not-verified' };
    }
    this.builds = this.builds.filter((entry) => entry.sha !== input.sha);
    this.builds.push({ sha: input.sha, builtAtIso: input.builtAtIso });
    this.builds.sort((x, y) => Date.parse(x.builtAtIso) - Date.parse(y.builtAtIso) || (x.sha < y.sha ? -1 : 1));
    return { outcome: 'ok' };
  }

  async repoint(input: {
    root: string;
    sha: string;
    fence?: () => Promise<boolean>;
  }): Promise<ReleaseStoreWriteResult | { outcome: 'fenced' }> {
    this.calls.push(`repoint ${input.sha}`);
    if (!this.builds.some((entry) => entry.sha === input.sha)) {
      return { outcome: 'not-found' };
    }
    if (input.fence !== undefined && !(await input.fence())) {
      return { outcome: 'fenced' };
    }
    this.current = input.sha;
    return { outcome: 'ok' };
  }

  async prune(input: { root: string; keep: number; fence?: () => Promise<boolean> }): Promise<ReleaseStorePruneResult> {
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

  async discard(input: { root: string; buildId: string }): Promise<ReleaseStoreWriteResult> {
    this.calls.push(`discard ${input.buildId.slice(0, 40)}`);
    return this.discardUnreadable ? { outcome: 'unreadable' } : { outcome: 'ok' };
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

/**
 * A driver lease store with the real CAS rules in miniature. `reads` scripts
 * what each read returns (the last entry repeats); `takeOverOnAcquire` makes a
 * driver win the race between the read and the acquire.
 */
class FakeLease implements ConductorDriverLeasePort {
  readonly events: string[] = [];
  reads: Array<ConductorDriverLeaseRecord | null | Error>;
  held: ConductorDriverLeaseRecord | null = null;
  takeOverOnAcquire = false;
  /** The store grants less time than asked (as a clamped or slow store would). */
  grantedMs: number | null = null;
  checkRefusal: LeaseRefusal | null = null;
  /** Called inside each renew, before the caller reads its clock again. */
  onCheck: (() => void) | null = null;
  private readCount = 0;

  constructor(lease: ConductorDriverLeaseRecord | null | Error) {
    this.reads = [lease];
  }

  async read(): Promise<ConductorDriverLeaseRecord | null> {
    const next = this.reads[Math.min(this.readCount, this.reads.length - 1)];
    this.readCount += 1;
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }

  async acquire(request: LeaseAcquireRequest): Promise<ConductorDriverLeaseResult> {
    this.events.push(`acquire ${request.observedFence}`);
    if (this.takeOverOnAcquire) {
      return { outcome: 'refused', reason: 'lease-held' };
    }
    const leaseUntilIso =
      this.grantedMs === null ? request.leaseUntilIso : new Date(Date.parse(request.nowIso) + this.grantedMs).toISOString();
    this.held = { version: 1, holderId: request.holderId, fence: request.observedFence + 1, leaseUntilIso };
    return { outcome: 'ok', lease: this.held };
  }

  async renew(request: LeaseRenewRequest): Promise<ConductorDriverLeaseResult> {
    this.events.push(`renew ${request.fence}`);
    this.onCheck?.();
    const held = this.held;
    if (this.checkRefusal !== null || held === null || held.fence !== request.fence || held.holderId !== request.holderId) {
      return { outcome: 'refused', reason: this.checkRefusal ?? 'lease-not-held' };
    }
    const leaseUntilIso =
      this.grantedMs === null ? request.leaseUntilIso : new Date(Date.parse(request.nowIso) + this.grantedMs).toISOString();
    this.held = { ...held, leaseUntilIso };
    return { outcome: 'ok', lease: this.held };
  }

  async release(request: LeaseHoldRequest): Promise<ConductorDriverLeaseResult> {
    this.events.push(`release ${request.fence}`);
    const released = this.held as ConductorDriverLeaseRecord;
    this.held = null;
    return { outcome: 'ok', lease: released };
  }

  async check(request: LeaseHoldRequest): Promise<LeaseRefusal | null> {
    this.events.push(`check ${request.fence}`);
    this.onCheck?.();
    return this.checkRefusal;
  }
}

/**
 * A recorded grant store: one approved owner grant for one scope at one sha,
 * consumed at most once. `answer` overrides the resolve outcome.
 */
class FakeAuthorization implements ActionAuthorizationPort {
  readonly resolves: ResolveActionAuthorizationRequest[] = [];
  readonly consumes: ConsumeActionAuthorizationRequest[] = [];
  grant: { kind: string; sha: string; projectId: string } | null;
  answer: ResolveActionAuthorizationResult | Error | null = null;
  consumeAnswer: ConsumeActionAuthorizationResult | Error | null = null;
  consumedBy: string | null = null;

  constructor(grant: { kind: string; sha: string; projectId: string } | null) {
    this.grant = grant;
  }

  async resolveActionAuthorization(
    request: ResolveActionAuthorizationRequest,
  ): Promise<ResolveActionAuthorizationResult> {
    this.resolves.push(request);
    if (this.answer instanceof Error) {
      throw this.answer;
    }
    if (this.answer !== null) {
      return this.answer;
    }
    const grant = this.grant;
    if (
      grant === null ||
      this.consumedBy !== null ||
      grant.kind !== request.actionKind ||
      grant.sha !== request.expectedHeadSha ||
      grant.projectId !== request.projectId
    ) {
      return { outcome: 'blocked', reason: 'no recorded decision authorizes this' };
    }
    return { outcome: 'granted', authorizationGrantId: GRANT };
  }

  async consumeActionAuthorization(
    request: ConsumeActionAuthorizationRequest,
  ): Promise<ConsumeActionAuthorizationResult> {
    this.consumes.push(request);
    if (this.consumeAnswer instanceof Error) {
      throw this.consumeAnswer;
    }
    if (this.consumeAnswer !== null) {
      return this.consumeAnswer;
    }
    if (this.consumedBy !== null || request.authorizationGrantId !== GRANT) {
      return { outcome: 'refused', reason: 'already consumed' };
    }
    this.consumedBy = request.actionId;
    return { outcome: 'consumed', actionId: request.actionId };
  }
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
    projectId: null,
    ...overrides,
  };
}

function applyRequest(overrides: Partial<ManageReleaseRequest> = {}): ManageReleaseRequest {
  return request({ apply: true, projectId: PROJECT, ...overrides });
}

interface Made {
  useCase: ManageReleaseUseCase;
  store: FakeStore;
  executor: FakeExecutor;
  lease: FakeLease;
  authorization: FakeAuthorization;
}

/** The default grant authorizes whatever the test applies: same kind, same target. */
function make(
  options: {
    store?: FakeStore;
    lease?: ConductorDriverLeaseRecord | null | Error | FakeLease;
    executor?: FakeExecutor;
    authorization?: FakeAuthorization;
    clock?: () => string;
  } = {},
): Made {
  const store = options.store ?? new FakeStore();
  const executor = options.executor ?? new FakeExecutor();
  const lease = options.lease instanceof FakeLease ? options.lease : new FakeLease(options.lease ?? null);
  const authorization = options.authorization ?? new FakeAuthorization(null);
  const useCase = new ManageReleaseUseCase({
    store,
    lease,
    authorization,
    executor,
    nowIso: options.clock ?? (() => NOW),
    env: () => ({
      PATH: '/usr/bin',
      HOME: '/home/example',
      UNSET: undefined,
      YARN_NM_MODE: 'classic',
      GH_TOKEN: 'ghp_operatorSecretValue000000000000000',
      FLEET_NTFY_TOKEN: 'tk_operator',
    }),
  });
  return { useCase, store, executor, lease, authorization };
}

/** A use case whose recorded grant matches `kind` at `target`. */
function granted(kind: string, target: string, options: Parameters<typeof make>[0] = {}): Made {
  return make({ ...options, authorization: new FakeAuthorization({ kind, sha: target, projectId: PROJECT }) });
}

async function manage(useCase: ManageReleaseUseCase, input: unknown): Promise<ManageReleaseResult> {
  return useCase.manageRelease(input as ManageReleaseRequest);
}

const INSTALL = 'release-install';
const SWAP = 'release-swap';
const ROLLBACK = 'release-rollback';

describe('ManageReleaseUseCase', () => {
  it('refuses invalid-request for a null request', async () => {
    const { useCase } = make();
    expect(await manage(useCase, null)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await manage(useCase, 'install')).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('refuses invalid-request for a request with a missing field', async () => {
    const { useCase } = make();
    const { projectId: _projectId, ...partial } = request();
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
      { projectId: '' },
      { projectId: ' padded ' },
      { projectId: 'x'.repeat(257) },
      { projectId: 7 },
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

  it('refuses invalid-request for a free-text authority field', async () => {
    const { useCase, store } = granted(INSTALL, A);
    const { projectId: _projectId, ...rest } = applyRequest();
    expect(await manage(useCase, { ...rest, authority: 'owner-said-yes' })).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(store.calls).toEqual([]);
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

  it('refuses authority-required when apply is true without a project', async () => {
    const { useCase, store, executor, authorization } = granted(INSTALL, A);
    expect(await manage(useCase, request({ apply: true, projectId: null }))).toEqual({
      outcome: 'refused',
      reason: 'authority-required',
    });
    expect(store.calls).toEqual([]);
    expect(executor.runs).toEqual([]);
    expect(authorization.resolves).toEqual([]);
  });

  it('refuses authority-refused when no recorded grant exists and builds nothing', async () => {
    const { useCase, store, executor, lease } = make();
    expect(await manage(useCase, applyRequest())).toEqual({ outcome: 'refused', reason: 'authority-refused' });
    expect(store.calls).toEqual([]);
    expect(executor.runs).toEqual([]);
    expect(lease.events).toEqual([]);
  });

  it('refuses authority-refused for a grant that names another action, another sha or another project', async () => {
    for (const grant of [
      { kind: SWAP, sha: A, projectId: PROJECT },
      { kind: 'push-and-open-pr', sha: A, projectId: PROJECT },
      { kind: INSTALL, sha: B, projectId: PROJECT },
      { kind: INSTALL, sha: A, projectId: 'other-project' },
    ]) {
      const { useCase, store, executor } = make({ authorization: new FakeAuthorization(grant) });
      expect(await manage(useCase, applyRequest())).toEqual({ outcome: 'refused', reason: 'authority-refused' });
      expect(store.calls).toEqual([]);
      expect(executor.runs).toEqual([]);
    }
  });

  it('resolves the grant for the release action at the target sha, rollback included', async () => {
    const install = granted(INSTALL, A);
    await manage(install.useCase, applyRequest());
    expect(install.authorization.resolves).toEqual([
      expect.objectContaining({ actionKind: INSTALL, expectedHeadSha: A, projectId: PROJECT }),
    ]);
    const rollback = granted(ROLLBACK, B, { store: new FakeStore([build('a', 1), build('b', 2), build('c', 3)], C) });
    expect(await manage(rollback.useCase, applyRequest({ action: 'rollback', sha: null, source: null }))).toMatchObject({
      outcome: 'applied',
      target: B,
    });
    expect(rollback.authorization.resolves[0]).toMatchObject({ actionKind: ROLLBACK, expectedHeadSha: B });
    // A grant for the sha that is current now does not authorize rolling back from it.
    const wrong = granted(ROLLBACK, C, { store: new FakeStore([build('a', 1), build('b', 2), build('c', 3)], C) });
    expect(await manage(wrong.useCase, applyRequest({ action: 'rollback', sha: null, source: null }))).toEqual({
      outcome: 'refused',
      reason: 'authority-refused',
    });
    expect(wrong.store.current).toBe(C);
  });

  it('refuses authority-unknown when the grant read throws or answers unknown', async () => {
    for (const answer of [new Error('coordination store unreadable'), { outcome: 'unknown', reason: 'x' } as const]) {
      const made = granted(INSTALL, A);
      made.authorization.answer = answer;
      expect(await manage(made.useCase, applyRequest())).toEqual({ outcome: 'refused', reason: 'authority-unknown' });
      expect(made.store.calls).toEqual([]);
      expect(made.executor.runs).toEqual([]);
    }
  });

  it('refuses when the grant cannot be consumed and repoints nothing', async () => {
    for (const [answer, reason] of [
      [{ outcome: 'refused', reason: 'grant expired' }, 'authority-refused'],
      [{ outcome: 'consumed', actionId: 'some-other-action' }, 'authority-refused'],
      [new Error('journal unreadable'), 'authority-unknown'],
    ] as const) {
      const made = granted(SWAP, A, { store: new FakeStore([build('a', 1), build('b', 2)], B) });
      made.authorization.consumeAnswer = answer;
      expect(await manage(made.useCase, applyRequest({ action: 'swap', sha: A, source: null }))).toEqual({
        outcome: 'refused',
        reason,
      });
      expect(made.store.current).toBe(B);
      expect(made.store.calls).not.toContain(`repoint ${A}`);
      expect(made.lease.events.at(-1)).toMatch(/^release /);
    }
  });

  it('a consumed grant never authorizes a second release', async () => {
    const made = granted(SWAP, A, { store: new FakeStore([build('a', 1), build('b', 2)], B) });
    expect((await manage(made.useCase, applyRequest({ action: 'swap', sha: A, source: null }))).outcome).toBe('applied');
    made.store.current = B;
    expect(await manage(made.useCase, applyRequest({ action: 'swap', sha: A, source: null }))).toEqual({
      outcome: 'refused',
      reason: 'authority-refused',
    });
    expect(made.store.current).toBe(B);
  });

  it('refuses driver-lease-live while the conductor driver lease is live', async () => {
    const { useCase, store, executor } = granted(INSTALL, A, { lease: LIVE_LEASE });
    expect(await manage(useCase, applyRequest())).toEqual({ outcome: 'refused', reason: 'driver-lease-live' });
    expect(store.calls).toEqual([]);
    expect(executor.runs).toEqual([]);
    const lapsed = granted(INSTALL, A, { lease: LAPSED_LEASE });
    expect((await manage(lapsed.useCase, applyRequest())).outcome).toBe('applied');
    expect(lapsed.lease.events).toEqual([`acquire ${LAPSED_LEASE.fence}`, `renew ${LAPSED_LEASE.fence + 1}`, `release ${LAPSED_LEASE.fence + 1}`]);
  });

  it('refuses driver-lease-live when a driver starts during the build and repoints nothing', async () => {
    const lease = new FakeLease(null);
    lease.reads = [null, LIVE_LEASE];
    const { useCase, store, executor } = granted(INSTALL, A, { lease });
    expect(await manage(useCase, applyRequest())).toEqual({ outcome: 'refused', reason: 'driver-lease-live' });
    expect(executor.runs).toHaveLength(4);
    expect(store.calls).not.toContain(`repoint ${A}`);
    expect(store.current).toBeNull();
    expect(lease.events).toEqual([]);
  });

  it('refuses driver-lease-live when a driver wins the acquire race and repoints nothing', async () => {
    const lease = new FakeLease(null);
    lease.takeOverOnAcquire = true;
    const made = granted(SWAP, A, { lease, store: new FakeStore([build('a', 1), build('b', 2)], B) });
    expect(await manage(made.useCase, applyRequest({ action: 'swap', sha: A, source: null }))).toEqual({
      outcome: 'refused',
      reason: 'driver-lease-live',
    });
    expect(made.store.current).toBe(B);
    expect(made.authorization.consumes).toEqual([]);
  });

  it('refuses driver-lease-live when the held lease fails the check right before the repoint', async () => {
    const lease = new FakeLease(null);
    lease.checkRefusal = 'lease-expired';
    const made = granted(SWAP, A, { lease, store: new FakeStore([build('a', 1), build('b', 2)], B) });
    expect(await manage(made.useCase, applyRequest({ action: 'swap', sha: A, source: null }))).toEqual({
      outcome: 'refused',
      reason: 'driver-lease-live',
    });
    expect(made.store.current).toBe(B);
    expect(lease.events).toEqual(['acquire 0', 'renew 1', 'release 1']);
  });

  it('refuses driver-lease-live when too little lease time is left at the rename and repoints nothing', async () => {
    const lease = new FakeLease(null);
    lease.grantedMs = 30_000;
    const made = granted(SWAP, A, { lease, store: new FakeStore([build('a', 1), build('b', 2)], B) });
    expect(await manage(made.useCase, applyRequest({ action: 'swap', sha: A, source: null }))).toEqual({
      outcome: 'refused',
      reason: 'driver-lease-live',
    });
    expect(made.store.current).toBe(B);
    expect(lease.held).toBeNull();
  });

  it('refuses driver-lease-live when the lease renew itself runs past the margin', async () => {
    let now = NOW;
    const lease = new FakeLease(null);
    // The renew answers "held" until 120 s past its start, but by the time it returns 90 s are gone.
    lease.onCheck = () => {
      now = new Date(Date.parse(NOW) + 90_000).toISOString();
    };
    const made = granted(SWAP, A, { lease, clock: () => now, store: new FakeStore([build('a', 1), build('b', 2)], B) });
    expect(await manage(made.useCase, applyRequest({ action: 'swap', sha: A, source: null }))).toEqual({
      outcome: 'refused',
      reason: 'driver-lease-live',
    });
    expect(made.store.current).toBe(B);
  });

  it('prunes while the driver lease is still held, so no other release can repoint mid-prune', async () => {
    const lease = new FakeLease(null);
    const made = granted(SWAP, A, { lease, store: new FakeStore([build('a', 1), build('b', 2)], B) });
    const order: string[] = [];
    const prune = made.store.prune.bind(made.store);
    made.store.prune = async (input) => {
      order.push(`prune while held=${lease.held !== null}`);
      const fence = input.fence as () => Promise<boolean>;
      order.push(`fence=${await fence()}`);
      // A driver takes the lease over mid-prune: the next removal's fence fails.
      const mine = lease.held;
      lease.held = { ...(mine as ConductorDriverLeaseRecord), holderId: 'driver-2', fence: 99 };
      order.push(`fence after takeover=${await fence()}`);
      lease.held = mine;
      return prune(input);
    };
    expect((await manage(made.useCase, applyRequest({ action: 'swap', sha: A, source: null }))).outcome).toBe('applied');
    expect(order).toEqual(['prune while held=true', 'fence=true', 'fence after takeover=false']);
    expect(lease.held).toBeNull();
  });

  it('holds the driver lease around the repoint and releases it after', async () => {
    const lease = new FakeLease(null);
    const made = granted(SWAP, A, { lease, store: new FakeStore([build('a', 1), build('b', 2)], B) });
    const order: string[] = [];
    const repoint = made.store.repoint.bind(made.store);
    made.store.repoint = async (input) => {
      order.push(`repoint while held=${lease.held !== null} fenced=${input.fence !== undefined}`);
      return repoint(input);
    };
    expect((await manage(made.useCase, applyRequest({ action: 'swap', sha: A, source: null }))).outcome).toBe('applied');
    expect(order).toEqual(['repoint while held=true fenced=true']);
    expect(lease.events).toEqual(['acquire 0', 'renew 1', 'release 1']);
    expect(lease.held).toBeNull();
  });

  it('refuses lease-unknown when the lease read throws', async () => {
    const { useCase, store } = granted(INSTALL, A, { lease: new Error('unreadable lease file') });
    expect(await manage(useCase, applyRequest())).toEqual({ outcome: 'refused', reason: 'lease-unknown' });
    expect(await manage(useCase, request())).toEqual({ outcome: 'refused', reason: 'lease-unknown' });
    expect(store.calls).toEqual([]);
    const lease = new FakeLease(null);
    lease.reads = [null, new Error('unreadable lease file')];
    const late = granted(SWAP, A, { lease, store: new FakeStore([build('a', 1), build('b', 2)], B) });
    expect(await manage(late.useCase, applyRequest({ action: 'swap', sha: A, source: null }))).toEqual({
      outcome: 'refused',
      reason: 'lease-unknown',
    });
    expect(late.store.current).toBe(B);
  });

  it('refuses store-unreadable when the store listing is unreadable', async () => {
    const store = new FakeStore();
    store.unreadable = true;
    const { useCase } = make({ store });
    expect(await manage(useCase, request())).toEqual({ outcome: 'refused', reason: 'store-unreadable' });
  });

  it('refuses not-found when swap names a sha that is not kept', async () => {
    const { useCase, store } = granted(SWAP, B, { store: new FakeStore([build('a', 1)], A) });
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
      const { useCase, store, authorization } = granted(INSTALL, A, { executor });
      expect(await manage(useCase, applyRequest())).toEqual({ outcome: 'refused', reason: 'build-failed' });
      expect(store.calls).toEqual([`prepare ${A}`, `discard ${A}`]);
      expect(store.current).toBeNull();
      expect(executor.runs).toHaveLength(failAt + 1);
      expect(authorization.consumes).toEqual([]);
    }
  });

  it('refuses verify-failed when the built tree has no CLI entry', async () => {
    const store = new FakeStore();
    store.entryMissing = true;
    const { useCase } = granted(INSTALL, A, { store });
    expect(await manage(useCase, applyRequest())).toEqual({ outcome: 'refused', reason: 'verify-failed' });
    expect(store.calls).toEqual([`prepare ${A}`, `markVerified ${A}`, `discard ${A}`]);
    expect(store.current).toBeNull();
  });

  it('a failed cleanup never lets a retry reuse the stale build directory', async () => {
    const executor = new FakeExecutor();
    executor.failAt = 3;
    const store = new FakeStore();
    store.discardUnreadable = true;
    const first = granted(INSTALL, A, { executor, store });
    expect(await manage(first.useCase, applyRequest())).toEqual({ outcome: 'refused', reason: 'build-failed' });
    executor.failAt = null;
    const retry = granted(INSTALL, A, { executor, store });
    expect((await manage(retry.useCase, applyRequest())).outcome).toBe('applied');
    expect(store.preparedIds).toHaveLength(2);
    expect(store.preparedIds[0]).not.toBe(store.preparedIds[1]);
    // Only the directory this run created is verified, and the build ran in it.
    expect(store.verifiedIds).toEqual([store.preparedIds[1]]);
    expect(executor.runs.at(-1)?.options?.cwd).toBe(`${ROOT}/.staging-${store.preparedIds[1]}`);
  });

  it('prints the plan without applying and writes nothing', async () => {
    const store = new FakeStore([build('a', 1), build('b', 2), build('c', 3)], C);
    const { useCase, executor, authorization, lease } = make({ store, lease: LIVE_LEASE });
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
    expect(authorization.resolves).toEqual([]);
    expect(lease.events).toEqual([]);

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
    const { useCase, store, executor } = granted(INSTALL, A);
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
    const staging = `${ROOT}/.staging-${store.preparedIds[0]}`;
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
        `${staging}.tar`,
        A,
      ],
      ['tar', '-xf', `${staging}.tar`, '-C', staging],
      ['yarn', 'install', '--immutable'],
      ['yarn', 'build'],
    ]);
    for (const run of executor.runs) {
      expect(run.options?.timeoutMs).toBeGreaterThan(0);
      expect(run.options?.maxBufferBytes).toBeGreaterThan(0);
    }
    expect(executor.runs[2].options?.cwd).toBe(staging);
  });

  it('install of an already built sha does not build twice', async () => {
    const { useCase, store, executor } = granted(INSTALL, A, { store: new FakeStore([build('a', 1), build('b', 2)], B) });
    const result = await manage(useCase, applyRequest({ sha: A }));
    expect(result).toMatchObject({ outcome: 'applied', target: A, current: A, rebuilt: false });
    expect(executor.runs).toEqual([]);
    expect(store.calls).toEqual([`repoint ${A}`, 'prune 5']);
    expect(store.builds.filter((entry) => entry.sha === A)).toHaveLength(1);
  });

  it('completes a crash between the build and the repoint on the next install', async () => {
    const store = new FakeStore([build('a', 1)], null);
    const { useCase, executor } = granted(INSTALL, A, { store });
    const result = await manage(useCase, applyRequest({ sha: A }));
    expect(result).toMatchObject({ outcome: 'applied', current: A, rebuilt: false });
    expect(store.current).toBe(A);
    expect(executor.runs).toEqual([]);
  });

  it('swap repoints current to a kept build', async () => {
    const { useCase, store } = granted(SWAP, A, { store: new FakeStore([build('a', 1), build('b', 2), build('c', 3)], C) });
    const result = await manage(useCase, applyRequest({ action: 'swap', sha: A, source: null }));
    expect(result).toMatchObject({ outcome: 'applied', action: 'swap', target: A, current: A, rebuilt: false });
    expect(store.current).toBe(A);
  });

  it('rollback repoints current to the previous kept build', async () => {
    const { useCase, store } = granted(ROLLBACK, B, {
      store: new FakeStore([build('a', 1), build('b', 2), build('c', 3)], C),
    });
    const result = await manage(useCase, applyRequest({ action: 'rollback', sha: null, source: null }));
    expect(result).toMatchObject({ outcome: 'applied', action: 'rollback', target: B, current: B, rebuilt: false });
    expect(store.current).toBe(B);
  });

  it('the rollback plan prunes what the rollback would prune, with no phantom build', async () => {
    const builds = [build('a', 1), build('b', 2), build('c', 3), build('d', 4), build('e', 5)];
    const plan = make({ store: new FakeStore(builds, E) });
    const planned = await manage(plan.useCase, request({ action: 'rollback', sha: null, source: null, keep: 2 }));
    expect(planned).toMatchObject({ outcome: 'planned', target: D, previous: D, wouldPrune: [A, B] });
    const applied = granted(ROLLBACK, D, { store: new FakeStore(builds, E) });
    expect(
      await manage(applied.useCase, applyRequest({ action: 'rollback', sha: null, source: null, keep: 2 })),
    ).toMatchObject({ outcome: 'applied', current: D, pruned: [A, B], kept: [C, D, E] });
  });

  it('prunes to the keep count and never removes current or previous', async () => {
    const builds = [build('a', 1), build('b', 2), build('c', 3), build('d', 4), build('e', 5)];
    const plan = make({ store: new FakeStore(builds, E) });
    expect(await manage(plan.useCase, request({ action: 'swap', sha: B, source: null, keep: 2 }))).toMatchObject({
      outcome: 'planned',
      wouldPrune: [C],
    });

    const { useCase, store } = granted(SWAP, B, { store: new FakeStore(builds, E) });
    const result = await manage(useCase, applyRequest({ action: 'swap', sha: B, source: null, keep: 2 }));
    expect(result).toMatchObject({ outcome: 'applied', current: B, pruned: [C], kept: [A, B, D, E] });
    expect(store.removed).toEqual([C]);

    const fresh = granted(INSTALL, F, { store: new FakeStore(builds, E) });
    expect(await manage(fresh.useCase, applyRequest({ sha: F, keep: 2 }))).toMatchObject({
      outcome: 'applied',
      current: F,
      kept: [E, F],
      pruned: [A, B, C, D],
    });
  });

  it('the result carries no path, no grant id and no secret-shaped value', async () => {
    const plan = await manage(make().useCase, request());
    const applied = await manage(granted(INSTALL, A).useCase, applyRequest());
    const executor = new FakeExecutor();
    executor.failAt = 3;
    const refused = await manage(granted(INSTALL, A, { executor }).useCase, applyRequest());
    for (const result of [plan, applied, refused]) {
      const text = JSON.stringify(result);
      expect(text).not.toContain(ROOT);
      expect(text).not.toContain(SOURCE);
      expect(text).not.toContain(GRANT);
      expect(text).not.toContain('secret-ish');
      expect(text).not.toContain('/srv');
      expect(text).not.toContain('staging');
    }
  });

  it('the git step runs with GIT_ALLOW_PROTOCOL none, GIT_NO_LAZY_FETCH 1 and no hooks path', async () => {
    const { useCase, executor, store } = granted(INSTALL, A);
    await manage(useCase, applyRequest());
    const git = executor.runs[0];
    expect(git.argv).toContain('core.hooksPath=/dev/null');
    expect(git.argv).toContain('core.fsmonitor=false');
    expect(git.options?.env).toEqual({
      PATH: '/usr/bin',
      HOME: `${ROOT}/.staging-${store.preparedIds[0]}.home`,
      YARN_NM_MODE: 'classic',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'none',
      GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0',
    });
    expect(git.options?.cwd).toBe(SOURCE);
    expect(git.options?.killProcessTree).toBe(true);
  });

  it('the git child never sees the operator environment beyond the allowlist', async () => {
    const { useCase, executor } = granted(INSTALL, A);
    await manage(useCase, applyRequest());
    const env = executor.runs[0].options?.env ?? {};
    for (const key of Object.keys(env)) {
      expect(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'YARN_NM_MODE', 'COREPACK_ENABLE_DOWNLOAD_PROMPT', 'GIT_CONFIG_NOSYSTEM', 'GIT_ALLOW_PROTOCOL', 'GIT_NO_LAZY_FETCH', 'GIT_TERMINAL_PROMPT']).toContain(key);
    }
  });

  it('the tar, install and build children never see an operator token or the operator home', async () => {
    const { useCase, executor, store } = granted(INSTALL, A);
    await manage(useCase, applyRequest());
    expect(executor.runs).toHaveLength(4);
    const home = `${ROOT}/.staging-${store.preparedIds[0]}.home`;
    for (const run of executor.runs.slice(1)) {
      expect(run.options?.env).toEqual({ PATH: '/usr/bin', HOME: home, YARN_NM_MODE: 'classic' });
    }
    for (const run of executor.runs) {
      const text = JSON.stringify(run.options?.env);
      expect(text).not.toContain('operator');
      expect(text).not.toContain('/home/example');
    }
  });

  it('a prune that throws after the repoint is still an applied release', async () => {
    const store = new FakeStore([build('a', 1), build('b', 2)], B);
    store.prune = async () => {
      throw new Error('disk vanished');
    };
    const { useCase } = granted(SWAP, A, { store });
    expect(await manage(useCase, applyRequest({ action: 'swap', sha: A, source: null }))).toEqual({
      outcome: 'applied',
      action: 'swap',
      target: A,
      current: A,
      kept: [A, B],
      pruned: [],
      pruneOutcome: 'unreadable',
      rebuilt: false,
    });
    expect(store.current).toBe(A);
  });

  it('refuses current-moved when another release repointed before this one took the lease', async () => {
    const builds = [build('a', 1), build('b', 2), build('c', 3)];
    for (const [action, sha, target, kind] of [
      ['rollback', null, B, ROLLBACK],
      ['swap', A, A, SWAP],
    ] as const) {
      const lease = new FakeLease(null);
      const store = new FakeStore(builds, C);
      const made = granted(kind, target, { lease, store });
      const acquire = lease.acquire.bind(lease);
      lease.acquire = async (input) => {
        store.current = B; // a concurrent release (holding the lease before us) repointed to B
        return acquire(input);
      };
      expect(
        await manage(made.useCase, applyRequest({ action, sha, source: null })),
      ).toEqual({ outcome: 'refused', reason: 'current-moved' });
      expect(store.current).toBe(B);
      expect(store.calls).not.toContain(`repoint ${target}`);
      expect(made.authorization.consumes).toEqual([]);
      expect(lease.held).toBeNull();
    }
  });

  it('an unfinished prune still reports the builds it removed, never as kept', async () => {
    const store = new FakeStore([build('a', 1), build('b', 2), build('c', 3), build('d', 4), build('e', 5)], E);
    store.prune = async () => ({ outcome: 'unreadable', removed: [A] });
    const { useCase } = granted(SWAP, D, { store });
    expect(await manage(useCase, applyRequest({ action: 'swap', sha: D, source: null, keep: 2 }))).toMatchObject({
      outcome: 'applied',
      current: D,
      pruned: [A],
      kept: [B, C, D, E],
      pruneOutcome: 'unreadable',
    });
  });

  it('reports an unreadable prune instead of a false success', async () => {
    const store = new FakeStore([build('a', 1), build('b', 2), build('c', 3), build('d', 4), build('e', 5)], E);
    store.pruneUnreadable = true;
    const { useCase } = granted(SWAP, B, { store });
    const result = await manage(useCase, applyRequest({ action: 'swap', sha: B, source: null }));
    expect(result).toMatchObject({ outcome: 'applied', action: 'swap', target: B, current: B, pruned: [], pruneOutcome: 'unreadable' });
  });

  // CO14c fix round 3: a re-check that caught a swapped root is its own
  // refusal, distinct from an unreadable store, and creates nothing.
  it('refuses release-root-changed when the store reports the root swapped under it', async () => {
    const store = new FakeStore([build('a', 1), build('b', 2), build('c', 3), build('d', 4), build('e', 5)], E);
    store.rootChanged = true;
    const { useCase } = granted(INSTALL, F, { store });
    const result = await manage(useCase, applyRequest({ root: ROOT, source: SOURCE, sha: F }));
    expect(result).toEqual({ outcome: 'refused', reason: 'release-root-changed', leftovers: [] });
  });

  // CO14c fix round 4: the release-root-changed refusal carries the staging
  // names the store left in place after a swap; no other refusal carries any.
  it('a root-changed refusal carries the leftovers the store left in place', async () => {
    const store = new FakeStore([build('a', 1), build('b', 2), build('c', 3), build('d', 4), build('e', 5)], E);
    store.rootChanged = true;
    store.rootChangedLeftovers = ['/srv/fleet-releases/.staging-left-over.home'];
    const { useCase } = granted(INSTALL, F, { store });
    const result = await manage(useCase, applyRequest({ root: ROOT, source: SOURCE, sha: F }));
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'release-root-changed',
      leftovers: ['/srv/fleet-releases/.staging-left-over.home'],
    });
  });

  // CO14c fix round 2: the store never creates the release root, so even an
  // applied, approved install of a missing root creates nothing at all.
  it('an applied install against a missing root refuses and creates neither the root nor any ancestor', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-release-missing-root-test-'));
    try {
      const parent = path.join(tempDir, 'srv');
      const root = path.join(parent, 'fleet-releases');
      const { useCase } = granted(INSTALL, A, { store: new ReleaseStoreAdapter() as unknown as FakeStore });
      const result = await manage(useCase, applyRequest({ root }));
      expect(result).toMatchObject({ outcome: 'refused', reason: 'store-unreadable' });
      expect(await fs.lstat(tempDir).then(() => true, () => null)).not.toBeNull();
      expect(await fs.lstat(parent).then(() => true, () => null)).toBeNull();
      expect(await fs.lstat(root).then(() => true, () => null)).toBeNull();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
