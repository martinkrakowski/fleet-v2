// Lane RW2: the attempt review locator. It locates where an attempt under
// review lives — the attempt's recorded worktree path, the base commit, and
// which opencode server can see it — and exposes read-only git reads through
// the attempt's recorded host.
/**
 * The recorded host is the truth (H9b2 rule): a v2 attempt's route comes only
 * from the host it was recorded on, confirmed against the current
 * installation. A changed or removed recorded host refuses; there is never a
 * fallback to another host. Legacy attempts (no recorded host name) keep the
 * root-resolved legacy route.
 *
 * The reads are read-only git commands with no external diff or textconv
 * programs, run through the executor the recorded host resolved to. This
 * locator reads no environment variable.
 */

import type { AttemptRecord, AttemptRunnerRecord } from '../../domain/execution-records.js';
import type { CommandExecutorPort } from '../../application/ports/out/CommandExecutorPort.out-port.js';
import { ExecutorForHost } from './ExecutorForHost.helper.js';
import {
  confirmRecordedHost,
  hasRecordedHostName,
  type RunnerForAttemptHostSpec,
} from './ConfirmRecordedHost.js';

/**
 * The worktree (and a full clone's .git/config) is lane-writable, so every git call disables the
 * lane's fsmonitor and hooks, as C1's artifact adapter does: `status` refreshes the index and would
 * otherwise run a planted `core.fsmonitor` command on the recorded host (Fable, RW2 review).
 */
export const REVIEW_GIT_HARDENING: readonly string[] = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

export type AttemptReviewRoute =
  | { readonly kind: 'installation'; readonly remotePort: number; readonly remoteHost: string; readonly authFile?: string }
  | { readonly kind: 'legacy'; readonly remotePort?: number; readonly remoteHost?: string }
  | { readonly kind: 'none'; readonly reason: string; readonly code: RouteNoneCode };

/** The fixed code of each `none` review route refusal (KF-14a). */
export type RouteNoneCode = 'route-host-changed' | 'route-not-opencode' | 'route-no-port' | 'route-no-auth-file';

export interface AttemptReviewLocation {
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly route: AttemptReviewRoute;
  readHead(): Promise<string | null>;
  readStatus(): Promise<string | null>;
  readDiff(fromSha: string, toSha: string): Promise<string | null>;
}

export interface AttemptReviewLocatorOptions {
  readonly findAttempt: (attemptId: string) => Promise<AttemptRecord | null>;
  readonly executorForHost: ExecutorForHost;
  /** The current installation's hosts (v2); absent for v1 and no installation. */
  readonly hosts?: Readonly<Record<string, RunnerForAttemptHostSpec>>;
  /** Legacy routing (v1 or no installation), already resolved by the root. */
  readonly legacyRoute?: { readonly remotePort?: number; readonly remoteHost?: string };
  readonly gitTimeoutMs?: number; // default 30_000
}

const GIT_TIMEOUT_MS_DEFAULT = 30_000;
const DIFF_SHA_PATTERN = /^[0-9a-f]{7,64}$/;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export class AttemptReviewLocator {
  constructor(private readonly options: AttemptReviewLocatorOptions) {}

  async locate(attemptId: string): Promise<AttemptReviewLocation> {
    const attempt = await this.options.findAttempt(attemptId);
    if (attempt === null) {
      throw new Error(`No attempt is recorded for ${attemptId}`);
    }
    if (!attempt.worktreePath.startsWith('/')) {
      throw new Error(`Attempt ${attemptId} records no absolute worktree path`);
    }
    const resolved = this.options.executorForHost.executorForRecordedHost(attempt.runner ?? null);
    if (!resolved.ok) {
      throw new Error(resolved.reason);
    }
    const executor = resolved.executor;
    const worktreePath = attempt.worktreePath;
    const timeoutMs = this.options.gitTimeoutMs ?? GIT_TIMEOUT_MS_DEFAULT;
    return {
      worktreePath,
      baseCommit: attempt.baseCommit,
      route: this.routeFor(attempt.runner ?? null),
      readHead: () => this.readHead(executor, worktreePath, timeoutMs),
      readStatus: () => this.readStatus(executor, worktreePath, timeoutMs),
      readDiff: (fromSha: string, toSha: string) =>
        this.readDiff(executor, worktreePath, timeoutMs, fromSha, toSha),
    };
  }

  private routeFor(runner: AttemptRunnerRecord | null | undefined): AttemptReviewRoute {
    if (runner !== null && runner !== undefined && hasRecordedHostName(runner)) {
      const confirmed = confirmRecordedHost(runner, this.options.hosts);
      if (!confirmed.ok) {
        return { kind: 'none', reason: confirmed.reason, code: 'route-host-changed' };
      }
      if ((confirmed.spec.runner?.kind ?? 'opencode') !== 'opencode') {
        return {
          kind: 'none',
          reason: `Attempt ran on host ${confirmed.name}, whose runner is not opencode; an opencode reviewer cannot see its worktree`,
          code: 'route-not-opencode',
        };
      }
      const port = confirmed.spec.runner?.port;
      if (typeof port !== 'number') {
        return { kind: 'none', reason: `Host ${confirmed.name} declares no runner port`, code: 'route-no-port' };
      }
      let remoteHost = '';
      if (confirmed.transport === 'ssh') {
        remoteHost = confirmed.spec.sshAlias?.trim() ?? '';
      }
      const authFile = confirmed.spec.runner?.authFile?.trim();
      if (confirmed.transport === 'ssh' && (authFile === undefined || authFile === '')) {
        // A remote route needs the host's own authFile; ocm-run would otherwise fall back to the operator's $HOME credentials.
        return {
          kind: 'none',
          reason: 'Host ' + confirmed.name + ' declares no runner authFile for a remote review route',
          code: 'route-no-auth-file',
        };
      }
      let route: AttemptReviewRoute = { kind: 'installation', remotePort: port, remoteHost };
      if (authFile !== undefined && authFile !== '') {
        route = { ...route, authFile };
      }
      return route;
    }
    let route: AttemptReviewRoute = { kind: 'legacy' };
    const remotePort =
      typeof runner?.remotePort === 'number'
        ? runner.remotePort
        : this.options.legacyRoute?.remotePort;
    if (remotePort !== undefined) {
      route = { ...route, remotePort };
    }
    const recordedHost = runner?.host?.trim() ?? '';
    const remoteHost = recordedHost !== '' ? recordedHost : this.options.legacyRoute?.remoteHost;
    if (remoteHost !== undefined) {
      route = { ...route, remoteHost };
    }
    return route;
  }

  private async runGit(
    executor: CommandExecutorPort,
    worktreePath: string,
    timeoutMs: number,
    args: readonly string[],
  ): Promise<string | null> {
    try {
      const result = await executor.run(['git', '-C', worktreePath, ...REVIEW_GIT_HARDENING, ...args], {
        timeoutMs,
        maxBufferBytes: MAX_BUFFER_BYTES,
      });
      if (result.exitCode === 0 && result.error === undefined) {
        return result.stdout;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async readHead(
    executor: CommandExecutorPort,
    worktreePath: string,
    timeoutMs: number,
  ): Promise<string | null> {
    const stdout = await this.runGit(executor, worktreePath, timeoutMs, ['rev-parse', 'HEAD']);
    if (stdout === null) {
      return null;
    }
    const trimmed = stdout.trim();
    return trimmed === '' ? null : trimmed;
  }

  private async readStatus(
    executor: CommandExecutorPort,
    worktreePath: string,
    timeoutMs: number,
  ): Promise<string | null> {
    return this.runGit(executor, worktreePath, timeoutMs, ['status', '--porcelain=v1']);
  }

  private async readDiff(
    executor: CommandExecutorPort,
    worktreePath: string,
    timeoutMs: number,
    fromSha: string,
    toSha: string,
  ): Promise<string | null> {
    if (!DIFF_SHA_PATTERN.test(fromSha) || !DIFF_SHA_PATTERN.test(toSha)) {
      return null;
    }
    return this.runGit(executor, worktreePath, timeoutMs, [
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      fromSha,
      toSha,
      '--',
    ]);
  }
}
