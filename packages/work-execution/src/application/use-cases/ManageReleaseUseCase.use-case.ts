/**
 * ManageReleaseUseCase implements ManageReleasePort (cutover row CO14).
 *
 * Flow: read the request defensively, check the authority, read the conductor
 * driver lease (an unreadable lease is `lease-unknown`, never "no lease"), read
 * the store, resolve the target, then either report the plan or apply it: build
 * when the sha is not yet a verified build, repoint `current` atomically, prune.
 * A live driver lease refuses before any write. The build is four reviewed argv
 * steps through the command executor (no shell); the git step is a local read
 * with no hooks and no network. Nothing is echoed from a command, and no result
 * carries a path or the authority.
 */

import { containsSecretShape } from '@fleet/shared';

import { isLeaseLapsed } from '../../domain/lane-run-lease.js';
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
import type { CommandExecutorPort, CommandRunOptions } from '../ports/out/CommandExecutorPort.out-port.js';
import type { ConductorDriverLeasePort } from '../ports/out/ConductorDriverLeasePort.out-port.js';
import type { ReleaseBuildRecord, ReleaseStorePort } from '../ports/out/ReleaseStorePort.out-port.js';

export interface ManageReleaseDependencies {
  readonly store: ReleaseStorePort;
  readonly lease: ConductorDriverLeasePort;
  readonly executor: CommandExecutorPort;
  readonly nowIso: () => string;
  /** Complete environment for the git step; the CLI passes () => process.env. */
  readonly env?: () => Record<string, string | undefined>;
}

const REQUEST_KEYS = ['action', 'root', 'sha', 'source', 'keep', 'apply', 'authority'] as const;
const ACTIONS: readonly ReleaseAction[] = ['install', 'swap', 'rollback'];
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_PATH_BYTES = 4096;
const MAX_AUTHORITY_BYTES = 256;
const MIN_KEEP = 2;
const MAX_KEEP = 64;
const GIT_STEP_TIMEOUT_MS = 300_000;
const GIT_STEP_MAX_BUFFER_BYTES = 1_048_576;
const YARN_STEP_TIMEOUT_MS = 900_000;
const YARN_STEP_MAX_BUFFER_BYTES = 4_194_304;

type ValidRequest = ManageReleaseRequest;

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
    if (request.apply && (request.authority === null || request.authority.trim() === '')) {
      return refuse('authority-required');
    }
    let live: boolean;
    try {
      const lease = await this.deps.lease.read();
      live = lease !== null && !isLeaseLapsed(lease, this.deps.nowIso());
    } catch {
      return refuse('lease-unknown');
    }
    const listing = await this.deps.store.list({ root: request.root });
    if (listing.outcome !== 'read') {
      return refuse('store-unreadable');
    }
    const { builds, current } = listing;
    const kept = builds.map((build) => build.sha);
    const previous = previousBuild(builds, current);
    const alreadyBuilt = request.sha !== null && kept.includes(request.sha);
    let target: string;
    if (request.action === 'install') {
      target = request.sha as string;
    } else if (request.action === 'swap') {
      if (!alreadyBuilt) {
        return refuse('not-found');
      }
      target = request.sha as string;
    } else {
      if (previous === null) {
        return refuse('not-found');
      }
      target = previous;
    }
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
    let rebuilt = false;
    if (request.action === 'install' && !alreadyBuilt) {
      const built = await this.build(request, target);
      if (built !== null) {
        return refuse(built);
      }
      rebuilt = true;
    }
    const repointed = await this.deps.store.repoint({ root: request.root, sha: target });
    if (repointed.outcome === 'not-found') {
      return refuse('not-found');
    }
    if (repointed.outcome !== 'ok') {
      return refuse('store-unreadable');
    }
    const afterShas = rebuilt ? [...kept, target] : kept;
    const pruned = await this.deps.store.prune({ root: request.root, keep: request.keep });
    const removed = pruned.outcome === 'pruned' ? pruned.removed : [];
    const applied: ManageReleaseApplied = {
      outcome: 'applied',
      action: request.action,
      target,
      current: target,
      kept: afterShas.filter((sha) => !removed.includes(sha)),
      pruned: [...removed],
      rebuilt,
    };
    return applied;
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

  /** null when the build is verified; the refusal otherwise. Nothing is repointed here. */
  private async build(request: ValidRequest, sha: string): Promise<ManageReleaseRefusal | null> {
    const source = request.source as string;
    const buildDir = `${request.root}/${sha}`;
    const archive = `${buildDir}.tar`;
    const prepared = await this.deps.store.prepare({ root: request.root, sha });
    if (prepared.outcome !== 'ok') {
      return 'store-unreadable';
    }
    const gitEnv: Record<string, string> = { GIT_ALLOW_PROTOCOL: 'none', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };
    const baseEnv = this.deps.env?.() ?? process.env;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(baseEnv)) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }
    Object.assign(env, gitEnv);
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
          archive,
          sha,
        ],
        options: { cwd: source, env, ...gitBudget },
      },
      { argv: ['tar', '-xf', archive, '-C', buildDir], options: { cwd: request.root, ...gitBudget } },
      { argv: ['yarn', 'install', '--immutable'], options: { cwd: buildDir, ...yarnBudget } },
      { argv: ['yarn', 'build'], options: { cwd: buildDir, ...yarnBudget } },
    ];
    for (const step of steps) {
      if (!(await this.stepSucceeds(step.argv, step.options))) {
        return 'build-failed';
      }
    }
    const marked = await this.deps.store.markVerified({ root: request.root, sha, builtAtIso: this.deps.nowIso() });
    if (marked.outcome === 'ok') {
      return null;
    }
    if (marked.outcome === 'not-verified') {
      return 'verify-failed';
    }
    return marked.outcome === 'not-found' ? 'build-failed' : 'store-unreadable';
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
  if (snapshot === null) {
    return null;
  }
  const keys = Object.keys(snapshot);
  if (keys.length !== REQUEST_KEYS.length || !REQUEST_KEYS.every((key) => keys.includes(key))) {
    return null;
  }
  const { action, root, sha, source, keep, apply, authority } = snapshot;
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return null;
  }
  if (!isAbsolutePath(root) || typeof apply !== 'boolean') {
    return null;
  }
  if (typeof keep !== 'number' || !Number.isInteger(keep) || keep < MIN_KEEP || keep > MAX_KEEP) {
    return null;
  }
  if (sha !== null && (typeof sha !== 'string' || !SHA_PATTERN.test(sha))) {
    return null;
  }
  if (source !== null && !isAbsolutePath(source)) {
    return null;
  }
  if (authority !== null && !isBoundedString(authority, MAX_AUTHORITY_BYTES)) {
    return null;
  }
  const needsSha = action !== 'rollback';
  if ((sha === null) === needsSha || (source === null) === (action === 'install')) {
    return null;
  }
  return {
    action: action as ReleaseAction,
    root,
    sha: sha as string | null,
    source: source as string | null,
    keep,
    apply,
    authority: authority as string | null,
  };
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value !== '' && new TextEncoder().encode(value).length <= maxBytes;
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
