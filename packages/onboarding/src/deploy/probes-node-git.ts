/**
 * The node git readers of the deploy probes. Git is resolved from fixed
 * absolute paths, never `PATH`; only read-only commands run here; every
 * failure rejects so a caller never sees a false "no merge" or a `HEAD`
 * read from another repository.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { DeployProbes } from './types.js';

export const GIT_BINARY_CANDIDATES: readonly string[] = [
  '/usr/bin/git',
  '/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
];

export type DeployGitProbes = Pick<DeployProbes, 'mergeInProgress' | 'headCommit'>;

export interface DeployGitExecOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly windowsHide: true;
  readonly encoding: 'utf8';
}

export type DeployGitExec = (
  file: string,
  args: readonly string[],
  options: DeployGitExecOptions,
) => Promise<{ stdout: string }>;

export interface NodeDeployGitProbesDeps {
  /** Fixed absolute candidates; defaults to GIT_BINARY_CANDIDATES. */
  readonly gitBinaryCandidates?: readonly string[];
  /** Wall-clock limit of one git call in milliseconds; default 10000. */
  readonly timeoutMs?: number;
  /** Injected only so tests can observe the exact call. */
  readonly execFile?: DeployGitExec;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 65_536;
const GIT_HARDENING = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'] as const;
const MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'] as const;

const defaultExecFile: DeployGitExec = (file, args, options) =>
  promisify(execFileCallback)(file, [...args], options);

function fixedError(message: string): Error {
  return new Error('deploy probe: ' + message);
}

function assertRepoPath(repoPath: string): void {
  if (
    typeof repoPath !== 'string' ||
    repoPath.includes('\0') ||
    !isAbsolute(repoPath) ||
    resolve(repoPath) !== repoPath
  ) {
    throw fixedError('invalid repository path');
  }
}

async function resolveGitBinary(candidates: readonly string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      const stats = await stat(candidate);
      if (stats.isFile() && (stats.mode & 0o111) !== 0) {
        return candidate;
      }
    } catch {
      // any stat error means "not this one"
    }
  }
  throw fixedError('no git binary');
}

function gitEnv(root: string): Record<string, string> {
  return {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CEILING_DIRECTORIES: dirname(root),
    LC_ALL: 'C',
  };
}

async function markerPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

interface ResolvedDeps {
  readonly candidates: readonly string[];
  readonly timeoutMs: number;
  readonly execFile: DeployGitExec;
}

async function runGit(
  repoPath: string,
  gitArgs: readonly string[],
  resolvedDeps: ResolvedDeps,
): Promise<{ root: string; stdout: string }> {
  assertRepoPath(repoPath);
  const gitBin = await resolveGitBinary(resolvedDeps.candidates);
  const root = await realpath(repoPath);
  try {
    const { stdout } = await resolvedDeps.execFile(gitBin, [...GIT_HARDENING, ...gitArgs], {
      cwd: root,
      env: gitEnv(root),
      timeout: resolvedDeps.timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
      encoding: 'utf8',
    });
    return { root, stdout };
  } catch (error) {
    throw new Error('deploy probe: git command failed', { cause: error });
  }
}

/** Reads the marker files git leaves during a merge, cherry-pick, revert or rebase. */
async function mergeInProgress(repoPath: string, resolved: ResolvedDeps): Promise<boolean> {
  const markerArgs = MARKERS.flatMap((marker) => ['--git-path', marker]);
  const { root, stdout } = await runGit(repoPath, ['rev-parse', ...markerArgs], resolved);
  const lines = stdout.split('\n');
  if (!(lines.length === 6 && lines[5] === '' && lines.slice(0, 5).every((line) => line.length > 0))) {
    throw fixedError('git printed unexpected marker paths');
  }
  const present = await Promise.all(
    lines.slice(0, 5).map(async (line) => markerPresent(resolve(root, line))),
  );
  return present.some((exists) => exists);
}

/** Reads and validates the commit id `HEAD` points at. */
async function headCommit(repoPath: string, resolved: ResolvedDeps): Promise<string> {
  const { stdout } = await runGit(repoPath, ['rev-parse', '--verify', 'HEAD^{commit}'], resolved);
  const id = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(id)) {
    throw fixedError('git printed no commit id');
  }
  return id;
}

/** Builds the read-only git probes of a checked deploy. */
export function createNodeDeployGitProbes(deps?: NodeDeployGitProbesDeps): DeployGitProbes {
  const timeoutMs = deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new Error('deploy probe: invalid git timeout');
  }
  const candidates = deps?.gitBinaryCandidates ?? GIT_BINARY_CANDIDATES;
  const execFile = deps?.execFile ?? defaultExecFile;
  const resolved: ResolvedDeps = { candidates, timeoutMs, execFile };
  return {
    mergeInProgress: (repoPath: string) => mergeInProgress(repoPath, resolved),
    headCommit: (repoPath: string) => headCommit(repoPath, resolved),
  };
}
