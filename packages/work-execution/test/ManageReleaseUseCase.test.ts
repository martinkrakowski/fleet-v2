/**
 * CO14 tests: `release install | swap | rollback` use case, with a fake store,
 * a fake driver lease, a fake grant store behind ActionAuthorizationPort and a
 * fake command executor (no filesystem, no process).
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
  ReleaseDriverBinding,
  ReleaseOperationBegin,
  ReleaseOperationRef,
  ReleaseOrphanCurrentTempsResult,
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
const STATE_DIR = '/srv/fleet-v2-driver-state';

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
  readonly preparedIds: string[] = [];

  async prepare(input: { root: string; sha: string }): Promise<ReleaseStagingResult> {
    this.calls.push(`prepare ${input.sha}`);
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

  /** In-memory release operations: one open intent per (action, sha), a claim while a run holds it. */
  readonly operations = new Map<string, { opId: string; claimed: boolean; repointed: boolean }>();
  readonly completed: string[] = [];
  private operationCount = 0;
  orphanPasses = 0;

  async beginOperation(input: { action: string; sha: string; opId: string }): Promise<ReleaseOperationBegin> {
    const key = `${input.action}-${input.sha}`;
    const open = this.operations.get(key);
    if (open !== undefined) {
      if (open.claimed || open.opId !== input.opId) {
        return { outcome: 'busy' };
      }
      open.claimed = true;
      return { outcome: 'resumed', opId: open.opId };
    }
    this.operations.set(key, { opId: input.opId, claimed: true, repointed: false });
    return { outcome: 'started', opId: input.opId };
  }

  readonly markRepointedCalls: ReleaseOperationRef[] = [];

  /** CO14b fix round 10: only the exact opId that owns the intent may mark it. */
  async markRepointed(input: ReleaseOperationRef): Promise<ReleaseStoreWriteResult> {
    this.markRepointedCalls.push(input);
    const open = this.operations.get(`${input.action}-${input.sha}`);
    if (open === undefined) {
      return { outcome: 'not-found' };
    }
    if (open.opId !== input.opId) {
      return { outcome: 'unreadable' };
    }
    open.repointed = true;
    return { outcome: 'ok' };
  }

  async peekOperation(input: { action: string; sha: string }): Promise<{ outcome: 'open'; opId: string } | { outcome: 'none' }> {
    const open = this.operations.get(`${input.action}-${input.sha}`);
    return open === undefined ? { outcome: 'none' } : { outcome: 'open', opId: open.opId };
  }

  newOperationId(): string {
    this.operationCount += 1;
    return this.operationCount.toString(16).padStart(32, '0');
  }

  async completeOperation(input: ReleaseOperationRef): Promise<ReleaseStoreWriteResult> {
    this.operations.delete(`${input.action}-${input.sha}`);
    this.completed.push(input.opId);
    return { outcome: 'ok' };
  }

  async cancelOperation(input: ReleaseOperationRef): Promise<ReleaseStoreWriteResult> {
    this.operations.delete(`${input.action}-${input.sha}`);
    return { outcome: 'ok' };
  }

  async releaseOperation(input: ReleaseOperationRef): Promise<ReleaseStoreWriteResult> {
    const open = this.operations.get(`${input.action}-${input.sha}`);
    if (open !== undefined) {
      open.claimed = false;
    }
    return { outcome: 'ok' };
  }

  async removeOrphanCurrentTemps(): Promise<ReleaseOrphanCurrentTempsResult> {
    this.orphanPasses += 1;
    return { outcome: 'cleaned', removed: 0, findings: 0 };
  }

  /** Stateful enough to simulate "first binding wins" across repeated calls on one store. */
  binding: ReleaseDriverBinding = { outcome: 'unbound' };
  readonly bindCalls: Array<{ root: string; stateDir: string }> = [];
  readonly readBindingCalls: string[] = [];

  async readDriverBinding(input: { root: string }): Promise<ReleaseDriverBinding> {
    this.readBindingCalls.push(input.root);
    return this.binding;
  }

  async bindDriver(input: { root: string; stateDir: string }): Promise<ReleaseDriverBinding> {
    this.bindCalls.push({ root: input.root, stateDir: input.stateDir });
    if (this.binding.outcome === 'bound') {
      // The real adapter's EEXIST re-read: the first binding wins.
      return this.binding;
    }
    this.binding = { outcome: 'bound', stateDir: input.stateDir };
    return this.binding;
  }

  /** Scans the in-memory operations map for an open intent of `action`, without knowing its sha. */
  async peekAnyOpenOperation(input: {
    action: string;
  }): Promise<{ outcome: 'open'; opId: string; sha: string; repointed: boolean } | { outcome: 'none' }> {
    const prefix = `${input.action}-`;
    for (const [key, value] of this.operations) {
      if (key.startsWith(prefix)) {
        return { outcome: 'open', opId: value.opId, sha: key.slice(prefix.length), repointed: value.repointed };
      }
    }
    return { outcome: 'none' };
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
    // A grant already consumed by THIS actionId is a resume replaying its own
    // earlier, deterministic id (CO14b round 7): the real recorded-grant store
    // resolves it idempotently rather than refusing its own resumed operation.
    // Consumed by any OTHER actionId still blocks, which is what keeps "a
    // consumed grant never authorizes a second release" true.
    if (
      grant === null ||
      (this.consumedBy !== null && this.consumedBy !== request.actionId) ||
      grant.kind !== request.actionKind ||
      grant.sha !== request.expectedHeadSha ||
      grant.projectId !== request.projectId
    ) {
      return { outcome: 'blocked', reason: 'no recorded decision authorizes this' };
    }
    // The release grant is bound to the root it names: a grant resolved for
    // one root never authorizes another, so the fake echoes the request's own
    // root the way the real recorded grant path does.
    return {
      outcome: 'granted',
      authorizationGrantId: GRANT,
      ...(request.releaseRoot !== undefined ? { releaseRoot: request.releaseRoot } : {}),
    };
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
    // Same replay allowance as resolve, just above: a second consumption
    // attempt under the SAME actionId (a resumed operation) replays as
    // consumed instead of refusing, matching the real store's documented
    // idempotent-consumption guarantee.
    if ((this.consumedBy !== null && this.consumedBy !== request.actionId) || request.authorizationGrantId !== GRANT) {
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
    stateDir?: string;
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
      GH_TOKEN: 'tk_gh',
      FLEET_NTFY_TOKEN: 'tk_operator',
    }),
    stateDir: options.stateDir ?? STATE_DIR,
  });
  return { useCase, store, executor, lease, authorization };
}

/** A use case whose recorded grant matches `kind` at `target`. */
function granted(kind: string, target: string, options: Parameters<typeof make>[0] = {}): Made {
  return make({ ...options, authorization: new FakeAuthorization({ kind, sha: target, projectId: PROJECT }) });
}

/** Grants and consumes unconditionally, echoing back whatever root the request names. */
function alwaysGrants(): ActionAuthorizationPort {
  return {
    resolveActionAuthorization: async (req) => ({
      outcome: 'granted',
      authorizationGrantId: GRANT,
      ...(req.releaseRoot !== undefined ? { releaseRoot: req.releaseRoot } : {}),
    }),
    consumeActionAuthorization: async (req) => ({ outcome: 'consumed', actionId: req.actionId }),
  };
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
    const holed = ['a', 'b', 'c'];
    delete holed[0];
    delete holed[1];
    delete holed[2];
    expect(await manage(useCase, holed)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
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

  it(
    'CO14b fix round 8 (finding 1): an unauthorized apply against a fresh, unbound root ' +
      'never binds it, and the root is refused for lack of authority, never for a binding reason',
    async () => {
      // No project, so this is refused even before a grant is resolved, and
      // the bind-after-auth step (which runs only after a grant resolves) is
      // never reached either way.
      const noProject = make();
      expect(await manage(noProject.useCase, request({ apply: true, projectId: null }))).toEqual({
        outcome: 'refused',
        reason: 'authority-required',
      });
      expect(noProject.store.bindCalls).toEqual([]);
      expect(noProject.store.readBindingCalls).toEqual([]);

      // A project is named, but no matching grant exists: refused for lack of
      // authority, and `bindDriver` is never called -- the root stays unbound.
      const noGrant = make();
      expect(await manage(noGrant.useCase, applyRequest())).toEqual({
        outcome: 'refused',
        reason: 'authority-refused',
      });
      expect(noGrant.store.bindCalls).toEqual([]);
      expect(noGrant.store.binding).toEqual({ outcome: 'unbound' });
    },
  );

  it(
    'CO14b fix round 8 (finding 1): a genuinely authorized apply on a fresh, unbound root ' +
      'still binds it, to this driver\'s own state directory',
    async () => {
      const { useCase, store } = granted(INSTALL, A, { stateDir: STATE_DIR });
      expect(store.binding).toEqual({ outcome: 'unbound' });
      const result = await manage(useCase, applyRequest());
      expect(result.outcome).toBe('applied');
      expect(store.bindCalls).toEqual([{ root: ROOT, stateDir: STATE_DIR }]);
      expect(store.binding).toEqual({ outcome: 'bound', stateDir: STATE_DIR });
      // A second, separately authorized apply on the now-bound root reads
      // the binding but never writes it again (it already matches).
      const again = granted(INSTALL, A, { store, stateDir: STATE_DIR });
      expect((await manage(again.useCase, applyRequest())).outcome).toBe('applied');
      expect(store.bindCalls).toHaveLength(1);
    },
  );

  it(
    'refuses release-root-state-dir-unknown when the root is already bound to a different state directory',
    async () => {
      const store = new FakeStore();
      store.binding = { outcome: 'bound', stateDir: '/some/other/driver' };
      const { useCase } = granted(INSTALL, A, { store, stateDir: STATE_DIR });
      expect(await manage(useCase, applyRequest())).toEqual({
        outcome: 'refused',
        reason: 'release-root-state-dir-unknown',
      });
      expect(store.bindCalls).toEqual([]);
      expect(store.calls).toEqual([]);
    },
  );

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

  it('install builds nothing when its grant cannot be consumed (consumed before the build)', async () => {
    for (const answer of [
      { outcome: 'refused', reason: 'grant cancelled' } as const,
      new Error('journal unreadable'),
    ]) {
      const made = granted(INSTALL, A);
      made.authorization.consumeAnswer = answer;
      const result = await manage(made.useCase, applyRequest());
      expect(result.outcome).toBe('refused');
      expect(made.executor.runs).toEqual([]);
      expect(made.store.calls).toEqual([]);
      expect(made.store.builds).toEqual([]);
    }
  });

  it('a grant spent for one operation resumes only that operation; a completed one is never resumed', async () => {
    const store = new FakeStore([build('a', 1), build('b', 2)], B);
    const made = granted(SWAP, A, { store });
    made.authorization.consumeAnswer = new Error('crash after the consume was recorded');
    expect((await manage(made.useCase, applyRequest({ action: 'swap', sha: A, source: null }))).outcome).toBe('refused');
    // The intent survives with its operation id, unclaimed, so the retry resumes it.
    expect(store.operations.size).toBe(1);
    const firstId = made.authorization.consumes[0].actionId;
    made.authorization.consumeAnswer = null;
    const retry = await manage(made.useCase, applyRequest({ action: 'swap', sha: A, source: null }));
    expect(retry.outcome).toBe('applied');
    expect(made.authorization.consumes[1].actionId).toBe(firstId);
    expect(firstId).toMatch(/^release-swap-a{40}-[0-9a-f]{32}$/);
    expect(store.operations.size).toBe(0);
    expect(store.completed).toHaveLength(1);
    // A new request after completion is a new operation with a new, different id.
    store.current = B;
    made.authorization.consumedBy = 'spent';
    expect((await manage(made.useCase, applyRequest({ action: 'swap', sha: A, source: null }))).outcome).toBe('refused');
    expect(made.authorization.resolves.at(-1)?.actionId).not.toBe(firstId);
    expect(store.current).toBe(B);
  });

  it('a second run on a claimed operation is refused release-in-progress', async () => {
    const store = new FakeStore([build('a', 1), build('b', 2)], B);
    await store.beginOperation({ action: 'swap', sha: A, opId: store.newOperationId() });
    const made = granted(SWAP, A, { store });
    expect(await manage(made.useCase, applyRequest({ action: 'swap', sha: A, source: null }))).toEqual({
      outcome: 'refused',
      reason: 'release-in-progress',
    });
    expect(made.authorization.consumes).toEqual([]);
    expect(store.current).toBe(B);
  });

  it('a swap still repoints normally when the fresh plan is not yet at target', async () => {
    // Guards the CO14b round 7 short-circuit: an ordinary (non-resumed) swap
    // whose `current` genuinely differs from `target` must still call
    // `store.repoint`, exactly once.
    const store = new FakeStore([build('a', 1), build('b', 2), build('c', 3)], C);
    const made = granted(SWAP, A, { store });
    const repoint = store.repoint.bind(store);
    let repointCalls = 0;
    store.repoint = async (input) => {
      repointCalls += 1;
      return repoint(input);
    };
    const result = await manage(made.useCase, applyRequest({ action: 'swap', sha: A, source: null }));
    expect(result).toMatchObject({ outcome: 'applied', action: 'swap', target: A, current: A });
    expect(repointCalls).toBe(1);
    expect(store.current).toBe(A);
  });

  it('a resumed swap that already repointed before the crash never repoints twice (CO14b round 7)', async () => {
    // Luna's finding: a swap repoints `current` successfully, then the
    // process crashes before `completeOperation` writes the `.done` marker.
    // On resume, `stillTargets` legitimately re-validates the already-achieved
    // state as a good plan (current === plannedCurrent, target is kept), so
    // without a short-circuit `store.repoint` would run a second, redundant
    // time against a target it already reached.
    const store = new FakeStore([build('a', 1), build('b', 2)], B);
    const made = granted(SWAP, A, { store });

    // Instrument `repoint` to do its real work (the rename lands for real,
    // exactly as a crash right after a successful OS-level rename would leave
    // it) and then throw, so nothing downstream of the call — not even this
    // same `fencedRepoint` invocation's own `if (repointed.outcome !== 'ok')`
    // check — ever runs. This is what lets the operation's intent survive
    // unclaimed under the same opId (via the normal `releaseOperation` path
    // `apply()` already takes for any failure once `operation.consumed` is
    // true), the same mechanism the existing "a grant spent for one
    // operation..." test above relies on, just triggered one step later.
    const repoint = store.repoint.bind(store);
    let repointCalls = 0;
    store.repoint = async (input) => {
      repointCalls += 1;
      const applied = await repoint(input);
      if (repointCalls === 1) {
        throw new Error('crash immediately after the repoint rename landed');
      }
      return applied;
    };

    const crashed = await manage(made.useCase, applyRequest({ action: 'swap', sha: A, source: null }));
    expect(crashed).toEqual({ outcome: 'refused', reason: 'failed' });
    // The rename landed for real before the crash; the intent survives,
    // unclaimed, under the same opId — no `.done` marker, exactly a crashed
    // run's residue, never a hand-rolled store mutation.
    expect(store.current).toBe(A);
    expect(store.operations.size).toBe(1);
    expect(repointCalls).toBe(1);
    const firstId = made.authorization.consumes[0].actionId;
    expect(made.authorization.consumedBy).toBe(firstId);
    const firstOpId = [...store.operations.values()][0]?.opId;

    // Resume through the normal beginOperation/EEXIST-resumed path: the same
    // request, dispatched again, finds the open-but-unclaimed intent and
    // reuses its opId.
    const resumed = await manage(made.useCase, applyRequest({ action: 'swap', sha: A, source: null }));
    expect(resumed).toMatchObject({ outcome: 'applied', action: 'swap', target: A, current: A, kept: [A, B], pruned: [] });
    // `store.repoint` is never called again: the resumed call's `fresh.current`
    // already equals `target`, so the short-circuit skips it. One call total
    // across both attempts.
    expect(repointCalls).toBe(1);
    // The grant's consumption replays idempotently under the same actionId
    // (never a second, different one), and the operation is then properly
    // completed: claim released, intent moved out of the open map (the
    // fake's stand-in for the real store's `.done` marker).
    expect(made.authorization.consumes[1].actionId).toBe(firstId);
    expect(store.operations.size).toBe(0);
    expect(store.completed).toEqual([firstOpId]);
    // The orphan-temps pass is unconditional cleanup, not part of the plan:
    // it still runs on the already-achieved resume, same as on the original.
    expect(store.orphanPasses).toBe(2);
  });

  it(
    'a resumed rollback resumes ITS OWN recorded target, never a freshly (and wrongly) ' +
      'recomputed one (CO14b round 8, finding 2)',
    async () => {
      // Oldest-to-newest: C, A, B. Rolling back from B lands on A. If a retry
      // recomputed its target fresh from `current` AFTER the real repoint to
      // A had already landed, it would derive A's own predecessor -- C -- an
      // entirely different, unintended rollback.
      const store = new FakeStore([build('c', 1), build('a', 2), build('b', 3)], B);
      const useCase = new ManageReleaseUseCase({
        store,
        lease: new FakeLease(null),
        authorization: alwaysGrants(),
        executor: new FakeExecutor(),
        nowIso: () => NOW,
        env: () => ({ PATH: '/usr/bin' }),
        stateDir: STATE_DIR,
      });

      const repoint = store.repoint.bind(store);
      let repointCalls = 0;
      store.repoint = async (input) => {
        repointCalls += 1;
        const applied = await repoint(input);
        if (repointCalls === 1) {
          // The real rename landed for real before this throws, exactly as a
          // process crash right after a successful OS-level rename would.
          throw new Error('crash immediately after the repoint rename landed');
        }
        return applied;
      };

      const crashed = await manage(useCase, applyRequest({ action: 'rollback', sha: null, source: null }));
      expect(crashed).toEqual({ outcome: 'refused', reason: 'failed' });
      expect(store.current).toBe(A);
      expect(store.operations.size).toBe(1);
      expect(repointCalls).toBe(1);
      const firstOpId = [...store.operations.values()][0]?.opId;

      // Resume with the SAME original rollback request (rollback never takes
      // --sha). The fix must recover and reuse A -- the crashed attempt's own
      // recorded target -- rather than recomputing one fresh from `current`
      // (which is now A, so a fresh computation would derive C).
      const resumed = await manage(useCase, applyRequest({ action: 'rollback', sha: null, source: null }));
      expect(resumed).toMatchObject({ outcome: 'applied', action: 'rollback', target: A, current: A });
      // Only one real repoint happened in total, across both attempts.
      expect(repointCalls).toBe(1);
      // `current` was never silently moved to C.
      expect(store.current).toBe(A);
      // The ORIGINAL crashed operation completed; no second, different-target
      // operation was ever started.
      expect(store.operations.size).toBe(0);
      expect(store.completed).toEqual([firstOpId]);
    },
  );

  it(
    'a plan-only rollback reports an in-flight crashed rollback\'s real target, ' +
      'never a freshly (and wrongly) recomputed one (CO14b round 8, finding 2)',
    async () => {
      const store = new FakeStore([build('c', 1), build('a', 2), build('b', 3)], B);
      const useCase = new ManageReleaseUseCase({
        store,
        lease: new FakeLease(null),
        authorization: alwaysGrants(),
        executor: new FakeExecutor(),
        nowIso: () => NOW,
        env: () => ({ PATH: '/usr/bin' }),
        stateDir: STATE_DIR,
      });
      const repoint = store.repoint.bind(store);
      let repointCalls = 0;
      store.repoint = async (input) => {
        repointCalls += 1;
        const applied = await repoint(input);
        if (repointCalls === 1) {
          throw new Error('crash immediately after the repoint rename landed');
        }
        return applied;
      };
      await manage(useCase, applyRequest({ action: 'rollback', sha: null, source: null }));
      expect(store.current).toBe(A);
      // A plan-only call now, against the same store: it must report the
      // crashed attempt's real, recorded target (A), not a fresh
      // previousBuild(builds, current=A), which would wrongly say C.
      const planned = await manage(useCase, request({ action: 'rollback', sha: null, source: null }));
      expect(planned).toMatchObject({ outcome: 'planned', action: 'rollback', target: A, previous: A, current: A });
    },
  );

  it(
    "a genuinely new rollback operation that merely finds the goal already met is refused, " +
      'never falsely applied for work it never itself did (CO14b round 9, completion race)',
    async () => {
      // Oldest-to-newest: C, A, B. Call X rolls back for real from B to A.
      // Call Y is a SEPARATE, independently and validly authorized rollback
      // request -- its own real grant, not a replay of X -- that races in
      // after X's lease is released but before X's own `completeOperation`
      // has run. If Y's own `peekOperation` happens only once X's intent is
      // already gone, Y begins a brand-new operation (`'started'`, never
      // `'resumed'`) under its own fresh opId, even though `fresh.current`
      // already sits at A from X's work. Before round 9, `stillTargets`'s
      // `current === target` disjunct and `fencedRepoint`'s `alreadyAtTarget`
      // skip did not care whose work it was: Y would consume its own real
      // grant and report `applied` without ever calling `store.repoint`. The
      // round 9 fix gates both short-circuits on `begun.outcome === 'resumed'`
      // for THIS call, so Y's fresh operation instead takes the ordinary
      // rollback check -- previousBuild(builds, current=A) is C, not A -- and
      // is correctly refused `current-moved`.
      const store = new FakeStore([build('c', 1), build('a', 2), build('b', 3)], B);
      const authorization = alwaysGrants();
      const useCase = new ManageReleaseUseCase({
        store,
        lease: new FakeLease(null),
        authorization,
        executor: new FakeExecutor(),
        nowIso: () => NOW,
        env: () => ({ PATH: '/usr/bin' }),
        stateDir: STATE_DIR,
      });

      // X runs to a REAL, successful repoint and prune (no crash this time),
      // but `completeOperation` is intercepted so X's own intent stays open
      // in the store even after X's call has already returned `applied` --
      // exactly "lease released, intent not yet completed".
      let deferredComplete: (() => Promise<unknown>) | null = null;
      const realComplete = store.completeOperation.bind(store);
      store.completeOperation = async (ref) => {
        deferredComplete = () => realComplete(ref);
        return { outcome: 'ok' };
      };

      const x = await manage(useCase, applyRequest({ action: 'rollback', sha: null, source: null }));
      expect(x).toMatchObject({ outcome: 'applied', action: 'rollback', target: A, current: A });
      expect(store.current).toBe(A);
      // X's lease was released (the fenced repoint's `finally`), but its own
      // intent is still open: `completeOperation` was intercepted, never for
      // real run.
      expect(store.operations.size).toBe(1);
      expect(deferredComplete).not.toBeNull();

      // Y races in now: intercept `peekOperation` -- the first thing Y's own
      // `apply()` reads from the operations table -- to run X's deferred
      // completion exactly once, right before Y looks. This simulates X
      // finishing between its own lease release and Y's own planning step,
      // without any real concurrency.
      const realPeek = store.peekOperation.bind(store);
      store.peekOperation = async (input) => {
        if (deferredComplete !== null) {
          const complete = deferredComplete;
          deferredComplete = null;
          await complete();
        }
        return realPeek(input);
      };
      const beginOutcomes: string[] = [];
      const realBegin = store.beginOperation.bind(store);
      store.beginOperation = async (input) => {
        const begun = await realBegin(input);
        beginOutcomes.push(begun.outcome);
        return begun;
      };
      let repointCallsForY = 0;
      const realRepoint = store.repoint.bind(store);
      store.repoint = async (input) => {
        repointCallsForY += 1;
        return realRepoint(input);
      };
      const consumesForY: string[] = [];
      const realConsume = authorization.consumeActionAuthorization.bind(authorization);
      authorization.consumeActionAuthorization = async (req) => {
        consumesForY.push(req.actionId);
        return realConsume(req);
      };

      const y = await manage(useCase, applyRequest({ action: 'rollback', sha: null, source: null }));
      // Y's own `beginOperation` genuinely started a fresh operation: X's
      // intent was already gone by the time Y looked.
      expect(beginOutcomes).toEqual(['started']);
      // Y is refused, never falsely `applied`: it never performed the
      // mutation it would otherwise have claimed, and never spent its own
      // grant for work it did not do.
      expect(y).toEqual({ outcome: 'refused', reason: 'current-moved' });
      expect(repointCallsForY).toBe(0);
      expect(consumesForY).toEqual([]);
      expect(store.current).toBe(A);
      // Y's own freshly begun intent is cleanly cancelled, not left open:
      // X's own operation is gone (completed above), and Y's own is gone too.
      expect(store.operations.size).toBe(0);
    },
  );

  /**
   * Seeds the FakeStore directly with the exact state a real crash leaves,
   * rather than deriving it from a live call: the rollback to `sha` already
   * repointed `current` for real, its intent is still open under a fresh
   * opId with `repointed: true` (the real adapter's `markRepointed` already
   * ran), and its claim is released (the process died before
   * `completeOperation`/`cancelOperation` ever ran). Round 7/8/9's own
   * crash tests reach an analogous state by throwing from an instrumented
   * `store.repoint` -- but `repointed: true` specifically can never be
   * reached that way under round 10's fix: `markRepointed` and everything
   * after it inside `fencedRepoint` is best effort (wrapped in its own
   * `try`/`catch`), by design, so a THROWN exception can never propagate
   * from there to crash the whole operation -- only an actual process death
   * can, which a unit test cannot literally reproduce. Seeding the state
   * directly tests the one thing that matters: what a LATER call does when
   * it finds exactly this on disk.
   */
  function seedCrashedRollback(store: FakeStore, sha: string, current: string): string {
    const opId = store.newOperationId();
    store.current = current;
    store.operations.set(`rollback-${sha}`, { opId, claimed: false, repointed: true });
    return opId;
  }

  /**
   * CO14b fix round 11 (finding 1): a store whose successive `list()` reads
   * answer a SCRIPTED sequence of `current` values (the last entry repeats),
   * so a test can simulate another call's repoint landing between two of
   * THIS call's own reads -- the exact "stale snapshot vs. a later fresh
   * read" race the finding describes. Only `list()` is scripted; every other
   * method still behaves exactly as `FakeStore`'s.
   */
  class ScriptedListStore extends FakeStore {
    private listCalls = 0;

    constructor(
      builds: ReleaseBuildRecord[],
      private readonly currentSequence: ReadonlyArray<string | null>,
    ) {
      super(builds, currentSequence[0] ?? null);
    }

    async list(): Promise<ReleaseStoreListing> {
      if (this.unreadable) {
        return { outcome: 'unreadable' };
      }
      const index = Math.min(this.listCalls, this.currentSequence.length - 1);
      this.listCalls += 1;
      return { outcome: 'read', current: this.currentSequence[index], builds: [...this.builds] };
    }
  }

  /** CO14b fix round 11 (finding 3): counts `cancelOperation` calls, to prove a write never happens. */
  class SpyStore extends FakeStore {
    cancelCalls = 0;

    async cancelOperation(input: ReleaseOperationRef): Promise<ReleaseStoreWriteResult> {
      this.cancelCalls += 1;
      return super.cancelOperation(input);
    }
  }

  it(
    'never retires a live, just-repointed rollback intent when the retire decision reads a fresh ' +
      'current instead of the stale snapshot run() captured earlier (CO14b round 11, finding 1)',
    async () => {
      // Oldest-to-newest: A, B, C. X is a separate rollback intent (C -> B)
      // whose own repoint has already landed for real (repointed: true),
      // but whose claim was released, not completed. Y (this call) is a
      // SEPARATE, freshly dispatched rollback request: its own `run()`
      // captures `current` while it is still C -- X's repoint has not
      // landed from Y's point of view yet -- but by the time Y's own
      // retire decision runs (the fresh read my round-11 fix performs),
      // X's repoint HAS landed. That is the exact ordering the finding
      // describes.
      const store = new ScriptedListStore([build('a', 1), build('b', 2), build('c', 3)], [C, B]);
      const xOpId = store.newOperationId();
      store.operations.set(`rollback-${B}`, { opId: xOpId, claimed: false, repointed: true });
      const useCase = new ManageReleaseUseCase({
        store,
        lease: new FakeLease(null),
        authorization: alwaysGrants(),
        executor: new FakeExecutor(),
        nowIso: () => NOW,
        env: () => ({ PATH: '/usr/bin' }),
        stateDir: STATE_DIR,
      });

      const result = await manage(useCase, applyRequest({ action: 'rollback', sha: null, source: null }));
      // Y's own apply correctly refuses -- its plannedCurrent (C, from its
      // own stale snapshot) no longer matches the real, now-fresh current
      // (B) -- but that is `stillTargets`'s own ordinary safety net, not
      // the thing under test here.
      expect(result).toMatchObject({ outcome: 'refused', reason: 'current-moved' });
      // X's own legitimate intent must survive untouched: never retired
      // just because Y's STALE snapshot made it look like a mismatch.
      expect(await store.peekAnyOpenOperation({ action: 'rollback' })).toEqual({
        outcome: 'open',
        opId: xOpId,
        sha: B,
        repointed: true,
      });
    },
  );

  it(
    'never cancels a not-yet-repointed rollback intent for a different sha, during a no-op ' +
      "swap's own proactive cleanup (CO14b round 11, finding 2)",
    async () => {
      // current is already C; a rollback-to-B intent exists but has not
      // reached its own repoint step yet (repointed: false) -- it may be a
      // different, legitimate, still-pending operation.
      const store = new FakeStore([build('a', 1), build('b', 2), build('c', 3)], C);
      store.operations.set(`rollback-${B}`, { opId: 'pending-rollback-op', claimed: false, repointed: false });
      const useCase = new ManageReleaseUseCase({
        store,
        lease: new FakeLease(null),
        authorization: alwaysGrants(),
        executor: new FakeExecutor(),
        nowIso: () => NOW,
        env: () => ({ PATH: '/usr/bin' }),
        stateDir: STATE_DIR,
      });

      // A no-op swap to C (current is already C) reaches `fencedRepoint`'s
      // own proactive cleanup once its (no-op) repoint is confirmed.
      const result = await manage(useCase, applyRequest({ action: 'swap', sha: C, source: null }));
      expect(result).toMatchObject({ outcome: 'applied', action: 'swap', target: C, current: C });
      // The pending, not-yet-repointed rollback-to-B intent must survive
      // untouched: a differing sha alone never proves it stale.
      expect(await store.peekAnyOpenOperation({ action: 'rollback' })).toEqual({
        outcome: 'open',
        opId: 'pending-rollback-op',
        sha: B,
        repointed: false,
      });
    },
  );

  it(
    'reports the correct fresh target but never mutates the store for a plan-only rollback that ' +
      'finds a genuinely stale repointed intent (CO14b round 11, finding 3)',
    async () => {
      // Oldest-to-newest: A, B, C, D. The crashed rollback already
      // repointed B -> ... no: repointed TO B for real (current is now D,
      // moved on by other activity), then died before `prune`/`complete`.
      // The intent is genuinely, provably stale right now.
      const store = new SpyStore([build('a', 1), build('b', 2), build('c', 3), build('d', 4)], null);
      const staleOpId = seedCrashedRollback(store, B, D);
      const useCase = new ManageReleaseUseCase({
        store,
        lease: new FakeLease(null),
        authorization: alwaysGrants(),
        executor: new FakeExecutor(),
        nowIso: () => NOW,
        env: () => ({ PATH: '/usr/bin' }),
        stateDir: STATE_DIR,
      });

      // A plan-only request (apply: false, the default of `request()`).
      const planned = await manage(useCase, request({ action: 'rollback', sha: null, source: null }));
      // The plan reports the CORRECT, fresh target -- previousBuild(D) ===
      // C -- never the stale B.
      expect(planned).toMatchObject({ outcome: 'planned', action: 'rollback', target: C, previous: C, current: D });
      // A plan prints and writes nothing: the stale intent survives
      // untouched, and `cancelOperation` is never called.
      expect(store.cancelCalls).toBe(0);
      expect(await store.peekAnyOpenOperation({ action: 'rollback' })).toEqual({
        outcome: 'open',
        opId: staleOpId,
        sha: B,
        repointed: true,
      });
    },
  );

  /**
   * CO14b fix round 12: a store whose successive `list()` reads answer a
   * SCRIPTED sequence of FULL listings (`current` AND `builds`, unlike
   * round 11's `ScriptedListStore`, which only scripts `current`). This
   * round's finding is specifically about `builds`/`current` together: an
   * install or a prune elsewhere can change the kept set between `run()`'s
   * own first read and `resolveTarget`'s internal fresh re-read, not only
   * `current` alone.
   */
  class ScriptedFullListingStore extends FakeStore {
    private listCalls = 0;

    constructor(private readonly sequence: ReadonlyArray<{ current: string | null; builds: ReleaseBuildRecord[] }>) {
      super(sequence[0]?.builds ?? [], sequence[0]?.current ?? null);
    }

    async list(): Promise<ReleaseStoreListing> {
      if (this.unreadable) {
        return { outcome: 'unreadable' };
      }
      const index = Math.min(this.listCalls, this.sequence.length - 1);
      this.listCalls += 1;
      const snapshot = this.sequence[index];
      return { outcome: 'read', current: snapshot.current, builds: [...snapshot.builds] };
    }
  }

  it(
    "reports a plan-only rollback consistently from whichever listing resolveTarget actually " +
      "used -- never run()'s own earlier, now-stale snapshot (CO14b round 12)",
    async () => {
      // run()'s own first `list()` read sees an OLD reality: builds A..E,
      // current B. Between that read and resolveTarget's own fresh re-read
      // (triggered below by an open, repointed:true rollback-to-C intent
      // that is no longer live), an unrelated install added F and a prune
      // elsewhere removed A: the fresh read sees builds B..F, current E.
      const stale = { current: B, builds: [build('a', 1), build('b', 2), build('c', 3), build('d', 4), build('e', 5)] };
      const fresh = { current: E, builds: [build('b', 2), build('c', 3), build('d', 4), build('e', 5), build('f', 6)] };
      const store = new ScriptedFullListingStore([stale, fresh]);
      const openOpId = store.newOperationId();
      store.operations.set(`rollback-${C}`, { opId: openOpId, claimed: false, repointed: true });
      const useCase = new ManageReleaseUseCase({
        store,
        lease: new FakeLease(null),
        authorization: alwaysGrants(),
        executor: new FakeExecutor(),
        nowIso: () => NOW,
        env: () => ({ PATH: '/usr/bin' }),
        stateDir: STATE_DIR,
      });

      // The fresh read shows current = E, not matching the open intent's
      // own sha (C), so it is proven stale right here: the target is
      // recomputed fresh -- previousBuild([B..F], E) = D -- and the WHOLE
      // plan must report consistently from that SAME fresh listing, never a
      // `current` (B) or a `kept` set (still including A) carried over from
      // run()'s own earlier snapshot.
      const planned = await manage(useCase, request({ action: 'rollback', sha: null, source: null, keep: 2 }));
      expect(planned).toMatchObject({
        outcome: 'planned',
        action: 'rollback',
        target: D,
        previous: D,
        current: E,
      });
      if (planned.outcome === 'planned') {
        expect(planned.kept).toEqual([B, C, D, E, F]);
        // Under the pre-round-12 bug, `wouldPrune` was computed from the
        // STALE outer builds (A..E, keep 2): protected = {current-target D,
        // previousBuild C, newest-2 D&E} = {C,D,E}, leaving [A, B] to prune
        // -- A included, even though A was not even part of the fresh
        // reality `target` was actually resolved against. Fixed, it is
        // computed from the SAME fresh listing (B..F) that produced
        // `target`: protected = {C,D,E,F}, leaving only [B].
        expect(planned.wouldPrune).toEqual([B]);
      }
      // A plan writes nothing: the stale-looking intent survives untouched
      // (it is only ever retired on a genuine apply).
      expect(await store.peekAnyOpenOperation({ action: 'rollback' })).toEqual({
        outcome: 'open',
        opId: openOpId,
        sha: C,
        repointed: true,
      });
    },
  );

  it(
    'a stale rollback intent whose own repoint already landed is retired, never poisoning ' +
      'every later rollback forever (CO14b round 10, finding 1)',
    async () => {
      // Oldest-to-newest: A, B, C, D. The crashed rollback already
      // repointed C -> B for real, then died before `prune`/`complete`.
      const store = new FakeStore([build('a', 1), build('b', 2), build('c', 3), build('d', 4)], null);
      const firstOpId = seedCrashedRollback(store, B, B);
      const useCase = new ManageReleaseUseCase({
        store,
        lease: new FakeLease(null),
        authorization: alwaysGrants(),
        executor: new FakeExecutor(),
        nowIso: () => NOW,
        env: () => ({ PATH: '/usr/bin' }),
        stateDir: STATE_DIR,
      });
      expect(store.current).toBe(B);
      expect(store.operations.size).toBe(1);

      // "The operator sees current=B, accepts that, and moves on -- does
      // other installs/swaps, eventually landing on current=D": a real,
      // unrelated swap. Its own `fencedRepoint` call, confirming `current`
      // is now at D, proves the open rollback intent (sha=B) stale right
      // then and retires it proactively (CO14b round 10).
      const swapped = await manage(useCase, applyRequest({ action: 'swap', sha: D, source: null }));
      expect(swapped).toMatchObject({ outcome: 'applied', action: 'swap', target: D, current: D });
      expect(store.current).toBe(D);
      // Retired, not merely ignored: a later call's own `peekAnyOpenOperation`
      // can never rediscover it.
      expect(await store.peekAnyOpenOperation({ action: 'rollback' })).toEqual({ outcome: 'none' });
      expect(store.operations.size).toBe(0);

      // Before round 10, EVERY later rollback was hijacked to the stale B
      // and refused `current-moved` forever (finding 1). A plan-only call
      // now must report the CORRECT fresh target (previousBuild(D) === C),
      // never the stale B.
      const planned = await manage(useCase, request({ action: 'rollback', sha: null, source: null }));
      expect(planned).toMatchObject({ outcome: 'planned', action: 'rollback', target: C, previous: C, current: D });

      // And an apply of that same fresh rollback actually succeeds, using a
      // brand-new operation id -- never the stale one from the crash.
      const fresh = await manage(useCase, applyRequest({ action: 'rollback', sha: null, source: null }));
      expect(fresh).toMatchObject({ outcome: 'applied', action: 'rollback', target: C, current: C });
      expect(store.current).toBe(C);
      expect(store.completed).not.toContain(firstOpId);
    },
  );

  it(
    'a stale repointed rollback intent never lets its already-consumed grant replay to ' +
      'authorize a second, independently requested repoint (CO14b round 10, finding 2)',
    async () => {
      // Oldest-to-newest: A, B, C. The crashed rollback already repointed
      // C -> B for real, consuming a real grant under its own opId, then
      // died before `prune`/`complete`.
      const store = new FakeStore([build('a', 1), build('b', 2), build('c', 3)], null);
      const firstOpId = seedCrashedRollback(store, B, B);
      const staleActionId = `release-rollback-${B}-${firstOpId}`;
      const consumes: string[] = [];
      const authorization: ActionAuthorizationPort = {
        resolveActionAuthorization: async (req) => ({
          outcome: 'granted',
          authorizationGrantId: GRANT,
          ...(req.releaseRoot !== undefined ? { releaseRoot: req.releaseRoot } : {}),
        }),
        consumeActionAuthorization: async (req) => {
          consumes.push(req.actionId);
          return { outcome: 'consumed', actionId: req.actionId };
        },
      };
      const useCase = new ManageReleaseUseCase({
        store,
        lease: new FakeLease(null),
        authorization,
        executor: new FakeExecutor(),
        nowIso: () => NOW,
        env: () => ({ PATH: '/usr/bin' }),
        stateDir: STATE_DIR,
      });

      // "the operator runs other operations and eventually swap C (current=C
      // again)": a real, independently authorized swap -- NOT a resume of
      // anything -- whose own `fencedRepoint` call proactively retires the
      // stale rollback intent (sha=B), proven stale the instant `current`
      // is confirmed at C.
      const swapped = await manage(useCase, applyRequest({ action: 'swap', sha: C, source: null }));
      expect(swapped).toMatchObject({ outcome: 'applied', action: 'swap', target: C, current: C });
      expect(store.current).toBe(C);
      expect(await store.peekAnyOpenOperation({ action: 'rollback' })).toEqual({ outcome: 'none' });
      expect(consumes).toHaveLength(1);
      expect(consumes[0]).not.toBe(staleActionId);

      // A fresh rollback request now independently computes
      // previousBuild(C) === B -- the SAME target the crashed attempt had,
      // by the exact coincidence the finding describes -- but it must get
      // its OWN, freshly resolved and freshly consumed grant, never a
      // replay of the stale one.
      const fresh = await manage(useCase, applyRequest({ action: 'rollback', sha: null, source: null }));
      expect(fresh).toMatchObject({ outcome: 'applied', action: 'rollback', target: B, current: B });
      expect(store.current).toBe(B);
      expect(consumes).toHaveLength(2);
      // The discriminating assertion: under the finding-2 bug, this fresh
      // request would reuse the stale intent's own opId (found by its sha,
      // B), so its actionId would be IDENTICAL to the crashed attempt's --
      // the replay itself. Under the fix, a brand-new opId is used.
      expect(consumes[1]).not.toBe(staleActionId);
      // Exactly two real repoints happened in total: the unrelated swap's
      // own (to C) and this fresh, properly authorized rollback's own (to
      // B) -- never an extra repoint slipped in by a grant replay of the
      // stale, already-spent consumption.
      expect(store.calls.filter((call) => call.startsWith('repoint ')).length).toBe(2);
    },
  );

  it(
    "current coincidentally cycling back to a retired rollback intent's own sha never " +
      'resurrects it (CO14b round 10, finding 2 residual case)',
    async () => {
      // Oldest-to-newest: A, B, C, D. The crashed rollback already
      // repointed C -> B for real, then died before `prune`/`complete`.
      const store = new FakeStore([build('a', 1), build('b', 2), build('c', 3), build('d', 4)], null);
      seedCrashedRollback(store, B, B);
      const useCase = new ManageReleaseUseCase({
        store,
        lease: new FakeLease(null),
        authorization: alwaysGrants(),
        executor: new FakeExecutor(),
        nowIso: () => NOW,
        env: () => ({ PATH: '/usr/bin' }),
        stateDir: STATE_DIR,
      });

      // Two real, unrelated repoints: first AWAY from B -- proactively
      // retiring the stale intent (CO14b round 10) the instant it is proven
      // stale -- then BACK to EXACTLY B again, through an entirely separate,
      // freshly authorized swap, never through the crashed rollback's own
      // work.
      const away = await manage(useCase, applyRequest({ action: 'swap', sha: D, source: null }));
      expect(away).toMatchObject({ outcome: 'applied', target: D, current: D });
      expect(await store.peekAnyOpenOperation({ action: 'rollback' })).toEqual({ outcome: 'none' });
      const back = await manage(useCase, applyRequest({ action: 'swap', sha: B, source: null }));
      expect(back).toMatchObject({ outcome: 'applied', target: B, current: B });
      expect(store.current).toBe(B);

      // A fresh rollback request now, with `current` coincidentally back at
      // EXACTLY the retired intent's own sha. `resolveTarget`'s reactive
      // check alone (current === the old sha) cannot tell this apart from a
      // genuine resume; the proactive retirement above is what guarantees
      // there is nothing left to (mis)adopt. The CORRECT fresh target is
      // previousBuild(B) === A, never B itself -- a build's own predecessor
      // is never itself.
      const fresh = await manage(useCase, applyRequest({ action: 'rollback', sha: null, source: null }));
      expect(fresh).toMatchObject({ outcome: 'applied', action: 'rollback', target: A, current: A });
      expect(store.current).toBe(A);
    },
  );

  function round14UseCase(store: FakeStore, authorization: ActionAuthorizationPort = alwaysGrants()): ManageReleaseUseCase {
    return new ManageReleaseUseCase({
      store,
      lease: new FakeLease(null),
      authorization,
      executor: new FakeExecutor(),
      nowIso: () => NOW,
      env: () => ({ PATH: '/usr/bin' }),
      stateDir: STATE_DIR,
    });
  }

  it(
    'an unrepointed stale rollback intent left behind by a swap to a newer build is retired and the target ' +
      'recomputed fresh, apply and plan alike (CO14b round 14, finding 1)',
    async () => {
      // A<B<C<D, current C. A rollback to B began its intent and died before
      // its repoint (repointed: false); the operator then swapped to D.
      const store = new SpyStore([build('a', 1), build('b', 2), build('c', 3), build('d', 4)], D);
      const staleOpId = store.newOperationId();
      store.operations.set(`rollback-${B}`, { opId: staleOpId, claimed: false, repointed: false });
      const useCase = round14UseCase(store);

      const planned = await manage(useCase, request({ action: 'rollback', sha: null, source: null }));
      expect(planned).toMatchObject({ outcome: 'planned', target: C, previous: C, current: D });
      expect(store.cancelCalls).toBe(0);
      expect(store.operations.has(`rollback-${B}`)).toBe(true);

      const applied = await manage(useCase, applyRequest({ action: 'rollback', sha: null, source: null }));
      expect(applied).toMatchObject({ outcome: 'applied', action: 'rollback', target: C, current: C });
      expect(store.current).toBe(C);
      expect(store.operations.has(`rollback-${B}`)).toBe(false);
      expect(store.cancelCalls).toBe(1);
    },
  );

  it('a repointed:false rollback intent that is still legitimately resumable is still adopted (CO14b round 14)', async () => {
    const store = new FakeStore([build('a', 1), build('b', 2), build('c', 3)], C);
    const opId = store.newOperationId();
    store.operations.set(`rollback-${B}`, { opId, claimed: false, repointed: false });
    const consumes: string[] = [];
    const authorization: ActionAuthorizationPort = {
      resolveActionAuthorization: async (req) => ({
        outcome: 'granted',
        authorizationGrantId: GRANT,
        ...(req.releaseRoot !== undefined ? { releaseRoot: req.releaseRoot } : {}),
      }),
      consumeActionAuthorization: async (req) => {
        consumes.push(req.actionId);
        return { outcome: 'consumed', actionId: req.actionId };
      },
    };
    const result = await manage(
      round14UseCase(store, authorization),
      applyRequest({ action: 'rollback', sha: null, source: null }),
    );
    expect(result).toMatchObject({ outcome: 'applied', action: 'rollback', target: B, current: B });
    expect(consumes).toEqual([`release-rollback-${B}-${opId}`]);
  });

  it(
    'a rollback that dies right after the rename is already marked repointed, so a swap back retires it and a ' +
      'later rollback never replays the spent grant (CO14b round 14, finding 2)',
    async () => {
      class DiesAfterRename extends FakeStore {
        dieNext = true;
        async repoint(input: { root: string; sha: string; fence?: () => Promise<boolean> }) {
          const result = await super.repoint(input);
          if (this.dieNext && result.outcome === 'ok') {
            this.dieNext = false;
            throw new Error('process died after the rename');
          }
          return result;
        }
      }
      const store = new DiesAfterRename([build('a', 1), build('b', 2), build('c', 3)], C);
      const consumes: string[] = [];
      const authorization: ActionAuthorizationPort = {
        resolveActionAuthorization: async (req) => ({
          outcome: 'granted',
          authorizationGrantId: GRANT,
          ...(req.releaseRoot !== undefined ? { releaseRoot: req.releaseRoot } : {}),
        }),
        consumeActionAuthorization: async (req) => {
          consumes.push(req.actionId);
          return { outcome: 'consumed', actionId: req.actionId };
        },
      };
      const useCase = round14UseCase(store, authorization);

      const died = await manage(useCase, applyRequest({ action: 'rollback', sha: null, source: null }));
      expect(died.outcome).toBe('refused');
      expect(store.current).toBe(B);
      const crashed = await store.peekAnyOpenOperation({ action: 'rollback' });
      expect(crashed).toMatchObject({ outcome: 'open', sha: B, repointed: true });
      const staleActionId = `release-rollback-${B}-${(crashed as { opId: string }).opId}`;

      // Swap back to C: the marked intent is proven stale and retired.
      const swapped = await manage(useCase, applyRequest({ action: 'swap', sha: C, source: null }));
      expect(swapped).toMatchObject({ outcome: 'applied', target: C, current: C });
      expect(await store.peekAnyOpenOperation({ action: 'rollback' })).toEqual({ outcome: 'none' });

      const again = await manage(useCase, applyRequest({ action: 'rollback', sha: null, source: null }));
      expect(again).toMatchObject({ outcome: 'applied', target: B, current: B });
      expect(consumes.filter((id) => id === staleActionId)).toHaveLength(1);
    },
  );

  it('a failing cancelOperation refuses the rollback and never opens a second intent (CO14b round 14, finding 3)', async () => {
    class FailingCancel extends FakeStore {
      async cancelOperation(): Promise<ReleaseStoreWriteResult> {
        return { outcome: 'unreadable' };
      }
    }
    const store = new FailingCancel([build('a', 1), build('b', 2), build('c', 3), build('d', 4)], D);
    store.operations.set(`rollback-${B}`, { opId: store.newOperationId(), claimed: false, repointed: false });
    const result = await manage(round14UseCase(store), applyRequest({ action: 'rollback', sha: null, source: null }));
    expect(result).toEqual({ outcome: 'refused', reason: 'store-unreadable' });
    expect(store.operations.size).toBe(1);
    expect(store.current).toBe(D);
    expect(store.calls.filter((call) => call.startsWith('repoint '))).toEqual([]);
  });

  it('refuses driver-lease-live while the conductor driver lease is live', async () => {
    const { useCase, store, executor } = granted(INSTALL, A, { lease: LIVE_LEASE });
    expect(await manage(useCase, applyRequest())).toEqual({ outcome: 'refused', reason: 'driver-lease-live' });
    expect(store.calls).toEqual([]);
    expect(executor.runs).toEqual([]);
    const lapsed = granted(INSTALL, A, { lease: LAPSED_LEASE });
    expect((await manage(lapsed.useCase, applyRequest())).outcome).toBe('applied');
    // Install stages a release and never repoints, so it takes no lease fence
    // around a rename: nothing is acquired, renewed or released.
    expect(lapsed.lease.events).toEqual([]);
  });

  it('a driver that starts during an install build does not block the staged install', async () => {
    const lease = new FakeLease(null);
    lease.reads = [null, LIVE_LEASE];
    const { useCase, executor, store } = granted(INSTALL, A, { lease });
    const result = await manage(useCase, applyRequest());
    // The live lease appears only after the run-start read, and install stages
    // a build without repointing, so nothing is fenced and nothing is refused.
    expect(result).toMatchObject({ outcome: 'applied', target: A, current: null, rebuilt: true });
    expect(executor.runs).toHaveLength(4);
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
      // The grant is consumed before the build, so a failed build says it is spent.
      expect(await manage(useCase, applyRequest())).toEqual({ outcome: 'refused', reason: 'build-failed-grant-spent' });
      expect(store.calls).toEqual([`prepare ${A}`, `discard ${A}`]);
      expect(store.current).toBeNull();
      expect(store.builds).toEqual([]);
      expect(executor.runs).toHaveLength(failAt + 1);
      expect(authorization.consumes).toHaveLength(1);
    }
  });

  it('refuses verify-failed when the built tree has no CLI entry', async () => {
    const store = new FakeStore();
    store.entryMissing = true;
    const { useCase } = granted(INSTALL, A, { store });
    expect(await manage(useCase, applyRequest())).toEqual({ outcome: 'refused', reason: 'build-failed-grant-spent' });
    expect(store.calls).toEqual([`prepare ${A}`, `markVerified ${A}`, `discard ${A}`]);
    expect(store.builds).toEqual([]);
    expect(store.current).toBeNull();
  });

  it('a failed cleanup never lets a retry reuse the stale build directory', async () => {
    const executor = new FakeExecutor();
    executor.failAt = 3;
    const store = new FakeStore();
    store.discardUnreadable = true;
    const first = granted(INSTALL, A, { executor, store });
    expect(await manage(first.useCase, applyRequest())).toEqual({ outcome: 'refused', reason: 'build-failed-grant-spent' });
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

  it('install builds and verifies the target and leaves current unmoved', async () => {
    const { useCase, store, executor } = granted(INSTALL, A);
    const result = await manage(useCase, applyRequest());
    expect(result).toEqual({
      outcome: 'applied',
      action: 'install',
      target: A,
      // CO14 follow-up: install stages a release; only a swap or a rollback
      // serves it, so `current` is left where it was and nothing is pruned.
      current: null,
      kept: [A],
      pruned: [],
      pruneOutcome: 'pruned',
      rebuilt: true,
    });
    expect(store.calls).toEqual([`prepare ${A}`, `markVerified ${A}`]);
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

  it('install of an already built sha does not build twice and leaves current where it is', async () => {
    const { useCase, store, executor } = granted(INSTALL, A, { store: new FakeStore([build('a', 1), build('b', 2)], B) });
    const result = await manage(useCase, applyRequest({ sha: A }));
    expect(result).toMatchObject({ outcome: 'applied', target: A, current: B, rebuilt: false });
    expect(executor.runs).toEqual([]);
    expect(store.calls).toEqual([]);
    expect(store.builds.filter((entry) => entry.sha === A)).toHaveLength(1);
  });

  it('completes a crash between the build and the consumption on the next install', async () => {
    const store = new FakeStore([build('a', 1)], null);
    const { useCase, executor } = granted(INSTALL, A, { store });
    const result = await manage(useCase, applyRequest({ sha: A }));
    expect(result).toMatchObject({ outcome: 'applied', current: null, rebuilt: false });
    expect(store.current).toBeNull();
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
      // Install stages the new build and leaves `current` and the kept builds
      // exactly where they were; only a swap or a rollback prunes.
      current: E,
      kept: [A, B, C, D, E, F],
      pruned: [],
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
});
