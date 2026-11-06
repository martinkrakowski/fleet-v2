/**
 * ManageReleaseUseCase implements ManageReleasePort (cutover row CO14).
 *
 * Flow: read the request defensively, read the conductor driver lease (an
 * unreadable lease is `lease-unknown`, never "no lease"), read the store,
 * resolve the target, then either report the plan or apply it.
 *
 * Apply is fenced three ways:
 * - Authority: a recorded owner grant for `release:<action>` at the target sha
 *   is resolved through ActionAuthorizationPort before any write, and consumed
 *   (once, durably) just before the repoint. A missing, mismatched, expired or
 *   consumed grant is `authority-refused`; a grant read that fails or answers
 *   unknown is `authority-unknown`. No free-text value is ever authority.
 * - The driver: a live lease refuses before any write; the build then runs
 *   outside any lock, and the repoint runs only while this process holds the
 *   conductor driver lease itself (acquired by CAS just before the repoint,
 *   renewed and re-checked by the store's fence immediately before its one
 *   rename and before each build the prune takes out, with a margin of lease
 *   time left, and released after the prune). A driver that took
 *   the lease meanwhile makes the acquire fail, and nothing is repointed.
 * - Stale trees: the build runs in a staging directory the store creates
 *   exclusively for this run; only that directory is verified and moved to
 *   <root>/<sha>. A failed cleanup leaves a uniquely named directory nothing
 *   will reuse.
 *
 * The build is four reviewed argv steps through the command executor (no
 * shell); the git step is a local read with no hooks and no network, and every
 * step runs on a filtered environment that never hands the operator's full
 * environment (tokens, credentials) to a child. Nothing is echoed from a command, and no result carries a path or a
 * grant id; an unfinished prune is reported, never smoothed over.
 */

import { containsSecretShape } from '@fleet/shared';

import type { ReleaseActionKind } from '../../domain/coordination-keys.js';
import { isLeaseLapsed, type ConductorDriverLeaseRecord } from '../../domain/lane-run-lease.js';
import { snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import type {
  ManageReleaseApplied,
  ManageReleasePlan,
  ManageReleasePort,
  ManageReleaseRefusal,
  ManageReleaseRequest,
  ManageReleaseResult,
  ReleaseAction,
} from '../ports/in/ManageReleasePort.in-port.js';
import type { ActionAuthorizationPort } from '../ports/out/ActionAuthorizationPort.out-port.js';
import type { CommandExecutorPort, CommandRunOptions } from '../ports/out/CommandExecutorPort.out-port.js';
import type { ConductorDriverLeasePort } from '../ports/out/ConductorDriverLeasePort.out-port.js';
import type { ReleaseBuildRecord, ReleaseStorePort, ReleaseStorePruneResult } from '../ports/out/ReleaseStorePort.out-port.js';

export interface ManageReleaseDependencies {
  readonly store: ReleaseStorePort;
  readonly lease: ConductorDriverLeasePort;
  /** Resolves and consumes the recorded owner grant for `release:<action>` at the target sha. */
  readonly authorization: ActionAuthorizationPort;
  readonly executor: CommandExecutorPort;
  readonly nowIso: () => string;
  /** The operator environment the composition root supplies; only a filtered
   *  allowlist of it reaches the git child, never the operator's full set. */
  readonly env: () => Record<string, string | undefined>;
}

const REQUEST_KEYS = ['action', 'root', 'sha', 'source', 'keep', 'apply', 'projectId'] as const;
const ACTIONS: readonly ReleaseAction[] = ['install', 'swap', 'rollback'];
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_PATH_BYTES = 4096;
const MAX_PROJECT_ID_BYTES = 256;
const MIN_KEEP = 2;
const MAX_KEEP = 64;
const GIT_STEP_TIMEOUT_MS = 300_000;
const GIT_STEP_MAX_BUFFER_BYTES = 1_048_576;
const YARN_STEP_TIMEOUT_MS = 900_000;
const YARN_STEP_MAX_BUFFER_BYTES = 4_194_304;
/** How long the release holds the driver lease around the repoint; well inside the lease maximum. */
const REPOINT_FENCE_MS = 120_000;
/** The lease time that must remain when the fence passes; the rename after it is one local syscall. */
const REPOINT_MARGIN_MS = 60_000;
/** The only operator variables the git child may see; everything else (tokens, credentials) stays out. */
/**
 * The only operator variables any build child (git, tar, yarn) may see: none
 * of them a credential, a token or a home directory. HOME is never passed:
 * every child gets this run's own empty home from the store, so neither an
 * operator dotfile (`.npmrc`, `.yarnrc.yml`, `.gitconfig`, `.netrc`) nor an
 * operator cache reaches the commit's own install and build scripts.
 */
const CHILD_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'YARN_NM_MODE',
  'COREPACK_ENABLE_DOWNLOAD_PROMPT',
];

type ValidRequest = ManageReleaseRequest;

interface HeldLease {
  readonly holderId: string;
  readonly fence: number;
  /** Moves forward each time the fence renews the lease. */
  leaseUntilIso: string;
}

export class ManageReleaseUseCase implements ManageReleasePort {
  constructor(private readonly deps: ManageReleaseDependencies) {}

  async manageRelease(request: ManageReleaseRequest): Promise<ManageReleaseResult> {
    try {
      return await this.run(request);
    } catch {
      return refuse('failed');
    }
  }

  private async run(raw: unknown): Promise<ManageReleaseResult> {
    const request = readRequest(raw);
    if (request === null) {
      return refuse('invalid-request');
    }
    if (request.apply && request.projectId === null) {
      return refuse('authority-required');
    }
    const live = await this.leaseIsLive();
    if (live === null) {
      return refuse('lease-unknown');
    }
    const listing = await this.deps.store.list({ root: request.root });
    if (listing.outcome !== 'read') {
      return refuse('store-unreadable');
    }
    const { builds, current } = listing;
    const kept = builds.map((build) => build.sha);
    const previous = previousBuild(builds, current);
    const target = request.action === 'rollback' ? previous : request.sha;
    if (target === null || (request.action === 'swap' && !kept.includes(target))) {
      return refuse('not-found');
    }
    const alreadyBuilt = kept.includes(target);
    if (!request.apply) {
      const plan: ManageReleasePlan = {
        outcome: 'planned',
        action: request.action,
        target,
        current,
        previous,
        kept,
        wouldPrune: this.wouldPrune(builds, target, alreadyBuilt, request.keep),
        lease: live ? 'live' : 'free',
      };
      return plan;
    }
    if (live) {
      return refuse('driver-lease-live');
    }
    return this.apply(request, target, kept, alreadyBuilt);
  }

  /** The apply path: grant, build when needed, the fenced repoint, then prune. */
  private async apply(
    request: ValidRequest,
    target: string,
    kept: readonly string[],
    alreadyBuilt: boolean,
  ): Promise<ManageReleaseResult> {
    const grant = await this.resolveGrant(request, target);
    if (typeof grant !== 'string') {
      return refuse(grant.refusal);
    }
    let rebuilt = false;
    if (request.action === 'install' && !alreadyBuilt) {
      const built = await this.build(request, target);
      if (built !== null) {
        return refuse(built);
      }
      rebuilt = true;
    }
    const repointed = await this.fencedRepoint(request, target, grant);
    if ('refusal' in repointed) {
      return refuse(repointed.refusal);
    }
    const { pruned } = repointed;
    const afterShas = rebuilt ? [...kept, target] : kept;
    const removed = pruned.outcome === 'pruned' ? pruned.removed : [];
    const applied: ManageReleaseApplied = {
      outcome: 'applied',
      action: request.action,
      target,
      current: target,
      kept: afterShas.filter((sha) => !removed.includes(sha)),
      pruned: [...removed],
      pruneOutcome: pruned.outcome === 'pruned' ? 'pruned' : 'unreadable',
      rebuilt,
    };
    return applied;
  }

  /** true when a driver holds an unexpired lease; null when the lease cannot be read. */
  private async leaseIsLive(): Promise<boolean | null> {
    try {
      const lease = await this.deps.lease.read();
      return lease !== null && !isLeaseLapsed(lease, this.deps.nowIso());
    } catch {
      return null;
    }
  }

  /** The grant id of an applicable recorded owner grant, or the refusal. Writes nothing. */
  private async resolveGrant(
    request: ValidRequest,
    target: string,
  ): Promise<string | { readonly refusal: ManageReleaseRefusal }> {
    const coordinates = grantCoordinates(request, target);
    try {
      const resolved = await this.deps.authorization.resolveActionAuthorization({
        actionId: coordinates.actionId,
        projectId: request.projectId as string,
        workOrderId: coordinates.actionId,
        attemptId: coordinates.actionId,
        actionKind: coordinates.actionKind,
        expectedHeadSha: target,
        policyRevision: coordinates.actionKind,
      });
      if (resolved.outcome === 'granted') {
        return typeof resolved.authorizationGrantId === 'string' && resolved.authorizationGrantId.trim() !== ''
          ? resolved.authorizationGrantId
          : { refusal: 'authority-unknown' };
      }
      return { refusal: resolved.outcome === 'blocked' ? 'authority-refused' : 'authority-unknown' };
    } catch {
      return { refusal: 'authority-unknown' };
    }
  }

  /**
   * Repoint `current` and prune only while this process holds the conductor
   * driver lease: re-read it, acquire it by CAS, consume the grant, repoint
   * behind the store's fence, prune, release. Another release needs the same
   * lease to repoint, so no repoint can land between this prune's snapshot of
   * `current` and its removals. The prune result when repointed; the refusal
   * otherwise.
   */
  private async fencedRepoint(
    request: ValidRequest,
    target: string,
    grantId: string,
  ): Promise<{ readonly refusal: ManageReleaseRefusal } | { readonly pruned: ReleaseStorePruneResult }> {
    const held = await this.acquireLease(request, target);
    if (typeof held === 'string') {
      return { refusal: held };
    }
    try {
      const consumed = await this.consumeGrant(request, target, grantId);
      if (consumed !== null) {
        return { refusal: consumed };
      }
      const repointed = await this.deps.store.repoint({
        root: request.root,
        sha: target,
        fence: () => this.stillHolds(held),
      });
      if (repointed.outcome !== 'ok') {
        return { refusal: repointRefusal(repointed.outcome) };
      }
      // The repoint stands from here on: a prune that throws is an unfinished
      // prune of an applied release, never a refusal a caller would retry.
      try {
        return {
          pruned: await this.deps.store.prune({
            root: request.root,
            keep: request.keep,
            fence: () => this.stillHolds(held),
          }),
        };
      } catch {
        return { pruned: { outcome: 'unreadable' } };
      }
    } finally {
      await this.releaseLease(held);
    }
  }

  /**
   * The fence the store awaits right before its rename (repoint) and before
   * each build it takes out (prune): renew this process's lease for another
   * fence window, then require, on a clock read after the renew returned, at
   * least REPOINT_MARGIN_MS left. A lease this process no longer holds cannot
   * be renewed, so a driver that took it over fails the fence.
   */
  private async stillHolds(held: HeldLease): Promise<boolean> {
    const nowIso = this.deps.nowIso();
    const renewed = await this.deps.lease.renew({
      holderId: held.holderId,
      fence: held.fence,
      leaseUntilIso: new Date(Date.parse(nowIso) + REPOINT_FENCE_MS).toISOString(),
      nowIso,
    });
    if (renewed.outcome !== 'ok' || renewed.lease.fence !== held.fence) {
      return false;
    }
    held.leaseUntilIso = renewed.lease.leaseUntilIso;
    // The margin is measured on a clock read after the renew returned, so a
    // slow lease store can never leave a stale "time left" behind it.
    return Date.parse(held.leaseUntilIso) - Date.parse(this.deps.nowIso()) >= REPOINT_MARGIN_MS;
  }

  private async acquireLease(request: ValidRequest, target: string): Promise<HeldLease | ManageReleaseRefusal> {
    let lease: ConductorDriverLeaseRecord | null;
    try {
      lease = await this.deps.lease.read();
    } catch {
      return 'lease-unknown';
    }
    const nowIso = this.deps.nowIso();
    if (lease !== null && !isLeaseLapsed(lease, nowIso)) {
      return 'driver-lease-live';
    }
    const holderId = `release-${request.action}-${target}`;
    try {
      const acquired = await this.deps.lease.acquire({
        holderId,
        observedFence: lease?.fence ?? 0,
        leaseUntilIso: new Date(Date.parse(nowIso) + REPOINT_FENCE_MS).toISOString(),
        nowIso,
      });
      return acquired.outcome === 'ok'
        ? { holderId, fence: acquired.lease.fence, leaseUntilIso: acquired.lease.leaseUntilIso }
        : 'driver-lease-live';
    } catch {
      return 'lease-unknown';
    }
  }

  /** Best effort: a release that fails leaves a lease that lapses on its own within the fence window. */
  private async releaseLease(held: HeldLease): Promise<void> {
    try {
      await this.deps.lease.release({ holderId: held.holderId, fence: held.fence, nowIso: this.deps.nowIso() });
    } catch {
      // The lease expires by itself; the repoint result stands.
    }
  }

  private async consumeGrant(
    request: ValidRequest,
    target: string,
    grantId: string,
  ): Promise<ManageReleaseRefusal | null> {
    const coordinates = grantCoordinates(request, target);
    try {
      const consumed = await this.deps.authorization.consumeActionAuthorization({
        authorizationGrantId: grantId,
        actionId: coordinates.actionId,
        actionKind: coordinates.actionKind,
        expectedHeadSha: target,
        attemptId: coordinates.actionId,
      });
      return consumed.outcome === 'consumed' && consumed.actionId === coordinates.actionId ? null : 'authority-refused';
    } catch {
      return 'authority-unknown';
    }
  }

  /** The shas a prune would remove once `target` is current (and, for a new install, built). */
  private wouldPrune(
    builds: readonly ReleaseBuildRecord[],
    target: string,
    alreadyBuilt: boolean,
    keep: number,
  ): readonly string[] {
    const after = alreadyBuilt
      ? builds
      : [...builds, { sha: target, builtAtIso: this.deps.nowIso() }].sort(compareBuilds);
    return shasToPrune(after, target, keep);
  }

  /** null when the build is verified and in place; the refusal otherwise. Nothing is repointed here. */
  private async build(request: ValidRequest, sha: string): Promise<ManageReleaseRefusal | null> {
    const source = request.source as string;
    const staging = await this.deps.store.prepare({ root: request.root, sha });
    if (staging.outcome !== 'prepared') {
      return 'store-unreadable';
    }
    const { buildId, buildDir, archivePath, homeDir } = staging;
    const baseEnv = this.deps.env();
    const buildEnv = { ...allowlisted(baseEnv, CHILD_ENV_ALLOWLIST), HOME: homeDir };
    const env: Record<string, string> = {
      ...buildEnv,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'none',
      GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0',
    };
    const gitBudget = { timeoutMs: GIT_STEP_TIMEOUT_MS, maxBufferBytes: GIT_STEP_MAX_BUFFER_BYTES, killProcessTree: true };
    const yarnBudget = { timeoutMs: YARN_STEP_TIMEOUT_MS, maxBufferBytes: YARN_STEP_MAX_BUFFER_BYTES, killProcessTree: true };
    const steps: ReadonlyArray<{ argv: readonly string[]; options: CommandRunOptions }> = [
      {
        argv: [
          'git',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-C',
          source,
          'archive',
          '--format=tar',
          '--output',
          archivePath,
          sha,
        ],
        options: { cwd: source, env, ...gitBudget },
      },
      { argv: ['tar', '-xf', archivePath, '-C', buildDir], options: { cwd: request.root, env: buildEnv, ...gitBudget } },
      { argv: ['yarn', 'install', '--immutable'], options: { cwd: buildDir, env: buildEnv, ...yarnBudget } },
      { argv: ['yarn', 'build'], options: { cwd: buildDir, env: buildEnv, ...yarnBudget } },
    ];
    for (const step of steps) {
      if (!(await this.stepSucceeds(step.argv, step.options))) {
        await this.discardBuild(request.root, buildId);
        return 'build-failed';
      }
    }
    const marked = await this.deps.store.markVerified({
      root: request.root,
      sha,
      buildId,
      builtAtIso: this.deps.nowIso(),
    });
    if (marked.outcome === 'ok') {
      return null;
    }
    await this.discardBuild(request.root, buildId);
    if (marked.outcome === 'not-verified') {
      return 'verify-failed';
    }
    return marked.outcome === 'not-found' ? 'build-failed' : 'store-unreadable';
  }

  /**
   * Cleanup of this run's staging directory. A failed cleanup is safe: the
   * directory's name is unique to this run, `prepare` never hands it out
   * again, and only `markVerified` with its build id moves it into place.
   */
  private async discardBuild(root: string, buildId: string): Promise<void> {
    try {
      await this.deps.store.discard({ root, buildId });
    } catch {
      // The refusal stands; the staging directory is never reused.
    }
  }

  private async stepSucceeds(argv: readonly string[], options: CommandRunOptions): Promise<boolean> {
    try {
      const result = await this.deps.executor.run(argv, options);
      return result.exitCode === 0 && result.signal === null && result.error === undefined;
    } catch {
      return false;
    }
  }
}

function repointRefusal(outcome: 'fenced' | 'not-found' | 'not-verified' | 'unreadable'): ManageReleaseRefusal {
  if (outcome === 'fenced') {
    return 'driver-lease-live';
  }
  return outcome === 'not-found' ? 'not-found' : 'store-unreadable';
}

function allowlisted(
  source: Record<string, string | undefined>,
  keys: readonly string[],
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') {
      picked[key] = value;
    }
  }
  return picked;
}

/** The release action kind and the deterministic action id one grant is bound to. */
function grantCoordinates(
  request: ValidRequest,
  target: string,
): { readonly actionKind: ReleaseActionKind; readonly actionId: string } {
  const actionKind: ReleaseActionKind = `release-${request.action}`;
  return { actionKind, actionId: `${actionKind}-${target}` };
}

function refuse(reason: ManageReleaseRefusal): ManageReleaseResult {
  return { outcome: 'refused', reason };
}

function compareBuilds(a: ReleaseBuildRecord, b: ReleaseBuildRecord): number {
  const byTime = Date.parse(a.builtAtIso) - Date.parse(b.builtAtIso);
  if (byTime !== 0) {
    return byTime;
  }
  return a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0;
}

/** The kept build immediately older than `current`; null when current is not a kept build or is the oldest. */
function previousBuild(builds: readonly ReleaseBuildRecord[], current: string | null): string | null {
  const index = current === null ? -1 : builds.findIndex((build) => build.sha === current);
  return index > 0 ? builds[index - 1].sha : null;
}

/** The shas outside the newest `keep` builds, never `current` nor the build just older than it; oldest first. */
function shasToPrune(builds: readonly ReleaseBuildRecord[], current: string, keep: number): string[] {
  const protectedShas = new Set(builds.slice(Math.max(0, builds.length - keep)).map((build) => build.sha));
  protectedShas.add(current);
  const previous = previousBuild(builds, current);
  if (previous !== null) {
    protectedShas.add(previous);
  }
  return builds.filter((build) => !protectedShas.has(build.sha)).map((build) => build.sha);
}

function readRequest(raw: unknown): ValidRequest | null {
  const snapshot = snapshotPlainDataRecord(raw);
  if (snapshot === null || !hasExactlyRequestKeys(snapshot)) {
    return null;
  }
  const { action, root, sha, source, keep, apply, projectId } = snapshot;
  if (
    !isAction(action) ||
    !isAbsolutePath(root) ||
    typeof apply !== 'boolean' ||
    !isKeep(keep) ||
    !isNullOr(sha, isSha) ||
    !isNullOr(source, isAbsolutePath) ||
    !isNullOr(projectId, isProjectId)
  ) {
    return null;
  }
  // install and swap name a sha, rollback never does; only install takes a source.
  if ((sha === null) !== (action === 'rollback') || (source === null) === (action === 'install')) {
    return null;
  }
  return { action, root, sha, source, keep, apply, projectId };
}

function hasExactlyRequestKeys(snapshot: Record<string, unknown>): boolean {
  const keys = Object.keys(snapshot);
  return keys.length === REQUEST_KEYS.length && REQUEST_KEYS.every((key) => keys.includes(key));
}

function isAction(value: unknown): value is ReleaseAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

function isKeep(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_KEEP && value <= MAX_KEEP;
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && SHA_PATTERN.test(value);
}

function isNullOr<T>(value: unknown, guard: (candidate: unknown) => candidate is T): value is T | null {
  return value === null || guard(value);
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value !== '' && new TextEncoder().encode(value).length <= maxBytes;
}

function isProjectId(value: unknown): value is string {
  return isBoundedString(value, MAX_PROJECT_ID_BYTES) && value.trim() === value && !containsSecretShape(value);
}

function isAbsolutePath(value: unknown): value is string {
  return (
    isBoundedString(value, MAX_PATH_BYTES) &&
    value.startsWith('/') &&
    !value.includes('\0') &&
    !value.split('/').includes('..') &&
    !containsSecretShape(value)
  );
}
