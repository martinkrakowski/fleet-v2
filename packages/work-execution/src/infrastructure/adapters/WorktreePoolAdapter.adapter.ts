// Lane KS4b: the warm worktree pool adapter (D35), through the recorded host's executor.
/**
 * The pool's state lives on the recorded host, never in this process:
 *
 * - A pooled worktree is a git worktree at `<poolRoot>/<projectId>/w<n>`
 *   (`n` in 1..maxEntries), listed by `git worktree list --porcelain` of the
 *   project's clone. A directory git does not list is never touched.
 * - A claim is a symlink `<poolRoot>/<projectId>/.claims/w<n>` whose target is
 *   the owner key. `ln -s` is atomic and fails when the link exists, so two
 *   claimants never share a worktree, and the owner is written by the same
 *   step that claims, so a crash cannot leave a claim without its owner. The
 *   same run claiming again finds its own link and gets the same entry back.
 * - A prepare claim (`prepare-<id>`) guards a worktree while it is created,
 *   installed, built or reset; the worktree turns warm only when that claim
 *   is removed after the steps passed. Reaping removes dangling claims and
 *   prepare claims older than the stale window, with their half-built tree.
 * - Every git call is an argv array through `CommandExecutorPort.run` with no
 *   shell, hooks off and no transport allowed. No outcome carries command
 *   output or error text, so no credential path or secret-shaped text is
 *   echoed. Unreadable state is never reported as free: the claim is kept and
 *   the answer is `empty` or `unknown`.
 * - Every public method is deadline-guarded and returns a typed outcome; none
 *   throws on runtime input.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { AttemptRunnerRecord } from '../../domain/execution-records.js';
import {
  isWorktreePoolBaseCommit,
  readWorktreePoolEntryRecord,
  type WorktreePoolEntryRecord,
} from '../../domain/worktree-pool-records.js';
import type { CommandExecutorPort } from '../../application/ports/out/CommandExecutorPort.out-port.js';
import type {
  RefillWorktreePoolRequest,
  RefillWorktreePoolResult,
  ResetWorktreeToBaseRequest,
  ResetWorktreeToBaseResult,
  TakeWarmWorktreeRequest,
  TakeWarmWorktreeResult,
  WorktreePoolPort,
} from '../../application/ports/out/WorktreePoolPort.out-port.js';

/** One project the pool serves, on the host the request records. */
export interface WorktreePoolProjectConfig {
  /** Absolute path of the project's clone on the host. */
  readonly repositoryPath: string;
  /** Absolute directory holding the pool; the pool lives in `<poolRoot>/<projectId>`. */
  readonly poolRoot: string;
  /** Warm entries the pool keeps. Default 2. */
  readonly targetSize?: number;
  /**
   * Prepare steps (install, build), each an argv built for one worktree path.
   * They run in order after create and after reset. The argv must carry its
   * own working directory (the executor's `cwd` does not cross ssh).
   */
  readonly prepare?: readonly ((worktreePath: string) => readonly string[])[];
}

export interface WorktreePoolAdapterOptions {
  /** The executor of the recorded host, or null when the host is not confirmed. */
  readonly executorFor: (host: AttemptRunnerRecord) => CommandExecutorPort | null;
  /** Projects by id. */
  readonly projects: Readonly<Record<string, WorktreePoolProjectConfig>>;
  /** Largest pool per project, 1..16. Default 8. */
  readonly maxEntries?: number;
  /** Wall-clock budget of one operation, in milliseconds. */
  readonly budgetsMs?: { readonly take?: number; readonly reset?: number; readonly refill?: number };
  /** Wall-clock budget of one git or file call. Default 30 s. */
  readonly callTimeoutMs?: number;
  /** Wall-clock budget of one prepare step. Default 10 min. */
  readonly prepareTimeoutMs?: number;
  /** A prepare claim older than this many minutes is reaped. Default 90. */
  readonly stalePrepareMinutes?: number;
  readonly now?: () => number;
}

const HARD_MAX_ENTRIES = 16;
const DEFAULT_MAX_ENTRIES = 8;
const MAX_LISTING_BYTES = 256 * 1024;
const MAX_PREPARE_OUTPUT_BYTES = 1024 * 1024;
const MAX_PATH_BYTES = 200;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUN_ID_MAX_BYTES = 256;

const GIT_PREFIX = [
  'env',
  'GIT_ALLOW_PROTOCOL=none',
  'GIT_NO_LAZY_FETCH=1',
  'GIT_TERMINAL_PROMPT=0',
  'GIT_CONFIG_NOSYSTEM=1',
  'git',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'protocol.allow=never',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.pager=cat',
] as const;

type Called =
  | { readonly kind: 'ok'; readonly stdout: string }
  | { readonly kind: 'fail' }
  | { readonly kind: 'unknown' };

interface ListedWorktree {
  readonly path: string;
  readonly head: string;
  readonly prunable: boolean;
}

interface PoolState {
  readonly slots: Map<number, ListedWorktree>;
  readonly claims: Map<number, string>;
}

interface PoolView {
  readonly poolDir: string;
  readonly claimsDir: string;
  readonly config: WorktreePoolProjectConfig;
  readonly executor: CommandExecutorPort;
}

function isSafeAbsolutePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length < 2) return false;
  if (new TextEncoder().encode(value).byteLength > MAX_PATH_BYTES) return false;
  if (value.includes('\\') || value.endsWith('/') || value.includes('//')) return false;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return !value.split('/').some((segment) => segment === '..' || segment === '.');
}

function isRunId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim().length === value.length &&
    new TextEncoder().encode(value).byteLength <= RUN_ID_MAX_BYTES
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}

export class WorktreePoolAdapter implements WorktreePoolPort {
  private readonly options: WorktreePoolAdapterOptions;
  private readonly maxEntries: number;
  private readonly now: () => number;

  public constructor(options: WorktreePoolAdapterOptions) {
    this.options = options;
    this.maxEntries = clampInt(options.maxEntries, DEFAULT_MAX_ENTRIES, 1, HARD_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
  }

  public async take(request: TakeWarmWorktreeRequest): Promise<TakeWarmWorktreeResult> {
    try {
      if (!isPlainObject(request) || !isWorktreePoolBaseCommit(request.baseCommit)) {
        return { outcome: 'refused', reason: 'invalid-request' };
      }
      const runId = request.runId ?? null;
      if (runId !== null && !isRunId(runId)) {
        return { outcome: 'refused', reason: 'invalid-request' };
      }
      const view = this.viewFor(request.projectId, request.recordedHost);
      if (view === null) return { outcome: 'refused', reason: 'invalid-request' };
      const deadline = this.now() + clampInt(this.options.budgetsMs?.take, 60_000, 1, 3_600_000);
      return await this.takeFrom(view, request.projectId, request.baseCommit, runId, deadline);
    } catch {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
  }

  public async resetToBase(request: ResetWorktreeToBaseRequest): Promise<ResetWorktreeToBaseResult> {
    try {
      if (
        !isPlainObject(request) ||
        !isWorktreePoolBaseCommit(request.baseCommit) ||
        !isSafeAbsolutePath(request.worktreePath)
      ) {
        return { outcome: 'refused', reason: 'invalid-request' };
      }
      const located = this.locate(request.worktreePath);
      if (located === null) return { outcome: 'refused', reason: 'unknown-worktree' };
      const view = this.viewFor(located.projectId, request.recordedHost);
      if (view === null) return { outcome: 'refused', reason: 'invalid-request' };
      const deadline = this.now() + clampInt(this.options.budgetsMs?.reset, 900_000, 1, 3_600_000);
      return await this.resetIn(view, located.projectId, located.index, request.baseCommit, deadline);
    } catch {
      return { outcome: 'unknown' };
    }
  }

  public async refillAfterMerge(request: RefillWorktreePoolRequest): Promise<RefillWorktreePoolResult> {
    try {
      if (!isPlainObject(request) || !isWorktreePoolBaseCommit(request.mergedBaseCommit)) {
        return { outcome: 'refused', reason: 'invalid-request' };
      }
      const view = this.viewFor(request.projectId, request.recordedHost);
      if (view === null) return { outcome: 'refused', reason: 'invalid-request' };
      const deadline = this.now() + clampInt(this.options.budgetsMs?.refill, 3_600_000, 1, 14_400_000);
      return await this.refillIn(view, request.projectId, request.mergedBaseCommit, deadline);
    } catch {
      return { outcome: 'unknown' };
    }
  }

  // ---- resolution -------------------------------------------------------

  private viewFor(projectId: unknown, host: unknown): PoolView | null {
    if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId) || !isPlainObject(host)) return null;
    if (!Object.prototype.hasOwnProperty.call(this.options.projects, projectId)) return null;
    const config = this.options.projects[projectId];
    if (config === undefined || !isSafeAbsolutePath(config.repositoryPath) || !isSafeAbsolutePath(config.poolRoot)) {
      return null;
    }
    const executor = this.options.executorFor(host as unknown as AttemptRunnerRecord);
    if (executor === null || executor === undefined) return null;
    const poolDir = `${config.poolRoot}/${projectId}`;
    return { poolDir, claimsDir: `${poolDir}/.claims`, config, executor };
  }

  /** Which pool slot a worktree path names, or null when it names none. */
  private locate(worktreePath: string): { projectId: string; index: number } | null {
    for (const projectId of Object.keys(this.options.projects)) {
      const config = this.options.projects[projectId];
      if (!PROJECT_ID.test(projectId) || config === undefined || !isSafeAbsolutePath(config.poolRoot)) continue;
      const prefix = `${config.poolRoot}/${projectId}/w`;
      if (!worktreePath.startsWith(prefix)) continue;
      const rest = worktreePath.slice(prefix.length);
      if (!/^[1-9][0-9]{0,2}$/.test(rest)) continue;
      const index = Number(rest);
      if (index <= this.maxEntries) return { projectId, index };
    }
    return null;
  }

  // ---- host calls --------------------------------------------------------

  private async call(
    view: PoolView,
    argv: readonly string[],
    deadline: number,
    options: { readonly timeoutMs?: number; readonly maxBufferBytes?: number } = {},
  ): Promise<Called> {
    const remaining = deadline - this.now();
    if (remaining <= 0) return { kind: 'unknown' };
    const perCall = options.timeoutMs ?? clampInt(this.options.callTimeoutMs, 30_000, 1, 3_600_000);
    try {
      const result = await view.executor.run(argv, {
        timeoutMs: Math.max(1, Math.min(perCall, remaining)),
        maxBufferBytes: options.maxBufferBytes ?? MAX_LISTING_BYTES,
      });
      if (result.error !== undefined || result.signal !== null || result.exitCode === null) {
        return { kind: 'unknown' };
      }
      if (typeof result.stdout !== 'string') return { kind: 'unknown' };
      return result.exitCode === 0 ? { kind: 'ok', stdout: result.stdout } : { kind: 'fail' };
    } catch {
      return { kind: 'unknown' };
    }
  }

  private git(view: PoolView, dir: string, args: readonly string[], deadline: number): Promise<Called> {
    return this.call(view, [...GIT_PREFIX, '-C', dir, ...args], deadline);
  }

  private slotPath(view: PoolView, index: number): string {
    return `${view.poolDir}/w${index}`;
  }

  private linkPath(view: PoolView, index: number): string {
    return `${view.claimsDir}/w${index}`;
  }

  /** The pool's listed worktrees by slot, or null when git could not answer. */
  private async listSlots(view: PoolView, deadline: number): Promise<Map<number, ListedWorktree> | null> {
    const listed = await this.git(view, view.config.repositoryPath, ['worktree', 'list', '--porcelain'], deadline);
    if (listed.kind !== 'ok') return null;
    const slots = new Map<number, ListedWorktree>();
    for (const block of listed.stdout.split('\n\n')) {
      let path = '';
      let head = '';
      let prunable = false;
      for (const line of block.split('\n')) {
        if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
        else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length);
        else if (line === 'prunable' || line.startsWith('prunable ')) prunable = true;
      }
      const prefix = `${view.poolDir}/w`;
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!/^[1-9][0-9]{0,2}$/.test(rest)) continue;
      const index = Number(rest);
      if (index > this.maxEntries) continue;
      slots.set(index, { path, head, prunable });
    }
    return slots;
  }

  /**
   * Claims by slot: the owner key, or '?' for a claim whose owner cannot be
   * read. Null when the claim directory cannot be read at all.
   */
  private async readClaims(view: PoolView, deadline: number): Promise<Map<number, string> | null> {
    const exists = await this.call(view, ['test', '-d', view.claimsDir], deadline);
    if (exists.kind === 'unknown') return null;
    const claims = new Map<number, string>();
    if (exists.kind === 'fail') return claims;
    const names = await this.call(view, ['ls', '-1A', '--', view.claimsDir], deadline);
    if (names.kind !== 'ok') return null;
    for (const name of names.stdout.split('\n')) {
      const match = /^w([1-9][0-9]{0,2})$/.exec(name);
      if (match === null) continue;
      const index = Number(match[1]);
      if (index > this.maxEntries) continue;
      const target = await this.call(view, ['readlink', '--', this.linkPath(view, index)], deadline);
      if (target.kind === 'unknown') return null;
      claims.set(index, target.kind === 'ok' && target.stdout.trim() !== '' ? target.stdout.trim() : '?');
    }
    return claims;
  }

  /** Atomically create the claim; true only when this call created it. */
  private async claim(view: PoolView, index: number, owner: string, deadline: number): Promise<boolean> {
    const made = await this.call(view, ['mkdir', '-p', '--', view.claimsDir], deadline);
    if (made.kind !== 'ok') return false;
    const linked = await this.call(view, ['ln', '-s', '--', owner, this.linkPath(view, index)], deadline);
    return linked.kind === 'ok';
  }

  /** Remove a claim; false when it may still exist. */
  private async release(view: PoolView, index: number, deadline: number): Promise<boolean> {
    const removed = await this.call(view, ['rm', '-f', '--', this.linkPath(view, index)], deadline);
    return removed.kind === 'ok';
  }

  /** Whether the worktree sits exactly at `base` with nothing modified or untracked. */
  private async isCleanAt(view: PoolView, path: string, base: string, deadline: number): Promise<'yes' | 'no' | 'unknown'> {
    const head = await this.git(view, path, ['rev-parse', '--verify', 'HEAD'], deadline);
    if (head.kind === 'unknown') return 'unknown';
    if (head.kind === 'fail' || head.stdout.trim() !== base) return 'no';
    const status = await this.git(view, path, ['status', '--porcelain', '--untracked-files=normal'], deadline);
    if (status.kind === 'unknown') return 'unknown';
    return status.kind === 'ok' && status.stdout === '' ? 'yes' : 'no';
  }

  private entry(
    projectId: string,
    index: number,
    path: string,
    base: string,
    state: 'warm' | 'taken',
    runId: string | null,
  ): WorktreePoolEntryRecord | null {
    const read = readWorktreePoolEntryRecord({
      schemaVersion: 1,
      entryId: `${projectId}#${index}`,
      projectId,
      worktreePath: path,
      baseCommit: base,
      state,
      takenByRunId: state === 'taken' ? runId : null,
      // The host is the store and keeps no counter: 1 warm, 2 taken.
      revision: state === 'taken' ? 2 : 1,
    });
    return read.ok ? read.record : null;
  }

  // ---- take --------------------------------------------------------------

  private async takeFrom(
    view: PoolView,
    projectId: string,
    base: string,
    runId: string | null,
    deadline: number,
  ): Promise<TakeWarmWorktreeResult> {
    const slots = await this.listSlots(view, deadline);
    const claims = slots === null ? null : await this.readClaims(view, deadline);
    // Nothing is known: nothing is handed out.
    if (slots === null || claims === null) return { outcome: 'empty' };
    const owner = runId === null ? `anon-${randomUUID()}` : `run-${createHash('sha256').update(runId).digest('hex')}`;
    const indexes = [...slots.keys()].sort((a, b) => a - b);

    if (runId !== null) {
      for (const index of indexes) {
        const slot = slots.get(index);
        if (slot !== undefined && !slot.prunable && claims.get(index) === owner) {
          const record = this.entry(projectId, index, slot.path, slot.head, 'taken', runId);
          if (record !== null && isWorktreePoolBaseCommit(slot.head)) return { outcome: 'taken', entry: record };
        }
      }
    }

    for (const index of indexes) {
      const slot = slots.get(index);
      if (slot === undefined || slot.prunable || slot.head !== base || claims.has(index)) continue;
      if (!(await this.claim(view, index, owner, deadline))) continue;
      const clean = await this.isCleanAt(view, slot.path, base, deadline);
      if (clean === 'yes') {
        const record = this.entry(projectId, index, slot.path, base, 'taken', runId);
        if (record !== null) return { outcome: 'taken', entry: record };
      }
      // Not provably warm: back out the claim; if that cannot be shown, keep it.
      await this.release(view, index, deadline);
    }
    return { outcome: 'empty' };
  }

  // ---- reset -------------------------------------------------------------

  private async resetIn(
    view: PoolView,
    projectId: string,
    index: number,
    base: string,
    deadline: number,
  ): Promise<ResetWorktreeToBaseResult> {
    const slots = await this.listSlots(view, deadline);
    const claims = slots === null ? null : await this.readClaims(view, deadline);
    if (slots === null || claims === null) return { outcome: 'unknown' };
    const slot = slots.get(index);
    if (slot === undefined || slot.prunable) return { outcome: 'refused', reason: 'not-accounted-for' };
    const holder = claims.get(index);
    if (holder !== undefined && holder.startsWith('prepare-')) {
      return { outcome: 'refused', reason: 'not-accounted-for' };
    }
    const known = await this.git(view, view.config.repositoryPath, ['cat-file', '-e', `${base}^{commit}`], deadline);
    if (known.kind === 'unknown') return { outcome: 'unknown' };
    if (known.kind === 'fail') return { outcome: 'refused', reason: 'invalid-request' };

    // One reset at a time per slot: an exclusive guard link beside the claim.
    // An unclaimed slot is also held by a prepare claim while it is rebuilt; a
    // claimed one stays under its holder's claim (never opened to others).
    const resetGuard = `${view.claimsDir}/w${index}.reset`;
    const made = await this.call(view, ['mkdir', '-p', '--', view.claimsDir], deadline);
    if (made.kind !== 'ok') return { outcome: 'unknown' };
    const guarded = await this.call(view, ['ln', '-s', '--', 'reset', resetGuard], deadline);
    if (guarded.kind !== 'ok') return { outcome: 'unknown' };
    try {
      return await this.resetGuarded(view, projectId, index, slot.path, holder, base, deadline);
    } finally {
      await this.call(view, ['rm', '-f', '--', resetGuard], Math.max(deadline, this.now() + 5000));
    }
  }

  private async resetGuarded(
    view: PoolView,
    projectId: string,
    index: number,
    path: string,
    holder: string | undefined,
    base: string,
    deadline: number,
  ): Promise<ResetWorktreeToBaseResult> {
    if (holder === undefined && !(await this.claim(view, index, `prepare-${randomUUID()}`, deadline))) {
      return { outcome: 'unknown' };
    }
    const ready = await this.rebuild(view, path, base, deadline);
    if (ready !== 'yes') return { outcome: 'unknown' }; // the guard stays: it is reaped, never served
    if (!(await this.release(view, index, deadline))) return { outcome: 'unknown' };
    const record = this.entry(projectId, index, path, base, 'warm', null);
    return record === null ? { outcome: 'unknown' } : { outcome: 'reset', entry: record };
  }

  /** Move a listed worktree to `base`, clear its residue, run the prepare steps, and prove it clean. */
  private async rebuild(view: PoolView, path: string, base: string, deadline: number): Promise<'yes' | 'no' | 'unknown'> {
    const steps: (readonly string[])[] = [
      [...GIT_PREFIX, '-C', path, 'checkout', '--detach', '--force', base],
      [...GIT_PREFIX, '-C', path, 'clean', '-fd', '-e', 'node_modules'],
      ['rm', '-rf', '--', `${path}/.lane`],
    ];
    for (const argv of steps) {
      const done = await this.call(view, argv, deadline);
      if (done.kind !== 'ok') return done.kind === 'fail' ? 'no' : 'unknown';
    }
    const prepared = await this.prepare(view, path, deadline);
    if (prepared !== 'yes') return prepared;
    return this.isCleanAt(view, path, base, deadline);
  }

  private async prepare(view: PoolView, path: string, deadline: number): Promise<'yes' | 'no' | 'unknown'> {
    for (const build of view.config.prepare ?? []) {
      let argv: readonly string[];
      try {
        argv = build(path);
      } catch {
        return 'no';
      }
      if (!Array.isArray(argv) || argv.length === 0 || argv.some((word) => typeof word !== 'string')) return 'no';
      const done = await this.call(view, argv, deadline, {
        timeoutMs: clampInt(this.options.prepareTimeoutMs, 600_000, 1, 3_600_000),
        maxBufferBytes: MAX_PREPARE_OUTPUT_BYTES,
      });
      if (done.kind !== 'ok') return done.kind === 'fail' ? 'no' : 'unknown';
    }
    return 'yes';
  }

  // ---- refill and reap ---------------------------------------------------

  private async refillIn(
    view: PoolView,
    projectId: string,
    merged: string,
    deadline: number,
  ): Promise<RefillWorktreePoolResult> {
    const state = await this.reap(view, deadline);
    if (state === null) return { outcome: 'unknown' };
    const { slots, claims } = state;
    const target = clampInt(view.config.targetSize, 2, 1, this.maxEntries);
    const ready = new Map<number, WorktreePoolEntryRecord>();
    let failed = await this.reconcileIdle(view, projectId, merged, state, ready, deadline);
    failed = (await this.createMissing(view, projectId, merged, state, target, ready, deadline)) || failed;

    const entries = [...ready.entries()].sort((a, b) => a[0] - b[0]).map(([, record]) => record);
    if (entries.length > 0) return { outcome: 'refilled', entries };
    let used = 0;
    for (let index = 1; index <= this.maxEntries; index += 1) {
      if (slots.has(index) || claims.has(index)) used += 1;
    }
    return used >= this.maxEntries && !failed ? { outcome: 'refused', reason: 'pool-full' } : { outcome: 'unknown' };
  }

  /**
   * Reap, then read the pool afresh. A claim with no worktree behind it is
   * dangling, except a prepare claim, which guards a worktree still being
   * added; a prepare claim is reaped only past the stale window, with its
   * half-built tree. Null when the pool could not be read.
   */
  private async reap(view: PoolView, deadline: number): Promise<PoolState | null> {
    const slots = await this.listSlots(view, deadline);
    const claims = slots === null ? null : await this.readClaims(view, deadline);
    if (slots === null || claims === null) return null;
    const stale = await this.stalePrepareClaims(view, deadline);
    if (stale === null) return null;
    // A reset guard left by a crashed reset, past the stale window.
    await this.call(
      view,
      ['find', view.claimsDir, '-mindepth', '1', '-maxdepth', '1', '-name', 'w*.reset', '-mmin', `+${this.staleMinutes()}`, '-delete'],
      deadline,
    );
    for (const [index, owner] of claims) {
      const slot = slots.get(index);
      const isPrepare = owner.startsWith('prepare-');
      const gone = slot === undefined || slot.prunable;
      if (isPrepare ? !stale.has(index) : !gone) continue;
      if (slot !== undefined && !slot.prunable) {
        const removed = await this.git(view, view.config.repositoryPath, ['worktree', 'remove', '--force', slot.path], deadline);
        if (removed.kind !== 'ok') continue;
      }
      await this.release(view, index, deadline);
    }
    if (claims.size === 0) return { slots, claims };
    await this.git(view, view.config.repositoryPath, ['worktree', 'prune'], deadline);
    const freshSlots = await this.listSlots(view, deadline);
    const freshClaims = freshSlots === null ? null : await this.readClaims(view, deadline);
    return freshSlots === null || freshClaims === null ? null : { slots: freshSlots, claims: freshClaims };
  }

  /** Move idle warm entries to the merged base; true when one could not be proved warm. */
  private async reconcileIdle(
    view: PoolView,
    projectId: string,
    merged: string,
    state: PoolState,
    ready: Map<number, WorktreePoolEntryRecord>,
    deadline: number,
  ): Promise<boolean> {
    let failed = false;
    for (const index of [...state.slots.keys()].sort((a, b) => a - b)) {
      const slot = state.slots.get(index);
      if (slot === undefined || slot.prunable || state.claims.has(index)) continue;
      let record: WorktreePoolEntryRecord | null = null;
      if (slot.head !== merged) {
        const reset = await this.resetIn(view, projectId, index, merged, deadline);
        record = reset.outcome === 'reset' ? reset.entry : null;
      } else if ((await this.isCleanAt(view, slot.path, merged, deadline)) === 'yes') {
        record = this.entry(projectId, index, slot.path, merged, 'warm', null);
      }
      if (record === null) failed = true;
      else ready.set(index, record);
    }
    return failed;
  }

  /** Create entries in free slots up to the target; true when one failed or time ran out. */
  private async createMissing(
    view: PoolView,
    projectId: string,
    merged: string,
    state: PoolState,
    target: number,
    ready: Map<number, WorktreePoolEntryRecord>,
    deadline: number,
  ): Promise<boolean> {
    let failed = false;
    for (let index = 1; index <= this.maxEntries && ready.size < target; index += 1) {
      if (state.slots.has(index) || state.claims.has(index)) continue;
      if (this.now() >= deadline) return true;
      const created = await this.createSlot(view, projectId, index, merged, deadline);
      if (created.kind === 'ready') ready.set(index, created.entry);
      else if (created.kind === 'failed') failed = true;
    }
    return failed;
  }

  private async createSlot(
    view: PoolView,
    projectId: string,
    index: number,
    merged: string,
    deadline: number,
  ): Promise<
    | { readonly kind: 'ready'; readonly entry: WorktreePoolEntryRecord }
    | { readonly kind: 'lost' }
    | { readonly kind: 'failed' }
  > {
    const guard = `prepare-${randomUUID()}`;
    if (!(await this.claim(view, index, guard, deadline))) return { kind: 'lost' };
    const path = this.slotPath(view, index);
    const added = await this.git(view, view.config.repositoryPath, ['worktree', 'add', '--detach', path, merged], deadline);
    if (added.kind === 'fail') {
      // Nothing was created (an existing directory is left alone): give the slot back.
      await this.release(view, index, deadline);
      return { kind: 'failed' };
    }
    if (added.kind === 'unknown') return { kind: 'failed' }; // the guard stays; reaping removes it
    const prepared = await this.prepare(view, path, deadline);
    if (prepared !== 'yes') {
      if (prepared === 'no') {
        const removed = await this.git(view, view.config.repositoryPath, ['worktree', 'remove', '--force', path], deadline);
        if (removed.kind === 'ok') await this.release(view, index, deadline);
      }
      return { kind: 'failed' };
    }
    const clean = await this.isCleanAt(view, path, merged, deadline);
    const record = clean === 'yes' ? this.entry(projectId, index, path, merged, 'warm', null) : null;
    if (record === null || !(await this.release(view, index, deadline))) return { kind: 'failed' };
    return { kind: 'ready', entry: record };
  }

  private staleMinutes(): number {
    return clampInt(this.options.stalePrepareMinutes, 90, 1, 100_000);
  }

  /** Slots whose claim link is older than the stale window; null when unreadable. */
  private async stalePrepareClaims(view: PoolView, deadline: number): Promise<Set<number> | null> {
    const exists = await this.call(view, ['test', '-d', view.claimsDir], deadline);
    if (exists.kind === 'unknown') return null;
    if (exists.kind === 'fail') return new Set();
    const minutes = this.staleMinutes();
    const found = await this.call(
      view,
      ['find', view.claimsDir, '-mindepth', '1', '-maxdepth', '1', '-name', 'w*', '-mmin', `+${minutes}`],
      deadline,
    );
    if (found.kind !== 'ok') return null;
    const stale = new Set<number>();
    for (const line of found.stdout.split('\n')) {
      const match = /\/w([1-9][0-9]{0,2})$/.exec(line);
      if (match !== null) stale.add(Number(match[1]));
    }
    return stale;
  }
}
