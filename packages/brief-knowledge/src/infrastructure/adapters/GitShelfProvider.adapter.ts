// Implemented for lane o7-git-shelf (plan section 4, decision D1): the `git`
// shelf provider. This module supplies the publish callback handed to
// KeeperPublicationAdapter when the installation's shelf provider is `git`.
/**
 * GitShelfProvider writes accepted keepers into a shelf git repository using
 * plumbing only, never touching any working tree, never running hooks and
 * never signing or pushing. Every command runs through an injected argv
 * runner (argument arrays, never a shell) in `repoDir` with both
 * `-c core.hooksPath=/dev/null -c commit.gpgsign=false`, with every `GIT_*`
 * variable removed from the child environment (the allow-list is empty for
 * `GIT_*`; only the temporary `GIT_INDEX_FILE` is added back, for the three
 * index commands). Before any command writes, `rev-parse --show-toplevel`
 * must equal `repoDir`.
 *
 * Sequence per keeper: `hash-object -w --stdin`; with a temporary index
 * (`GIT_INDEX_FILE=<tmp>`), `read-tree <parent>` (skipped for the first
 * commit), `update-index --add --cacheinfo 100644,<blob>,<path>`,
 * `write-tree`; `commit-tree <tree> [-p <parent>] -m <message>` (no `-p` for
 * the first commit); `update-ref refs/heads/<branch> <new> <old>` — a
 * compare-and-swap whose old value is the current tip or the all-zero OID
 * for the first commit, so a concurrent update is refused. Prior keepers
 * stay in the tree because the parent's tree is read first.
 *
 * The provider refuses (writing nothing) when `branch` is the shelf
 * repository's checked-out HEAD branch, when the entry id fails
 * `^[A-Za-z0-9._-]{1,128}$` or contains `..`, or when `repoDir` is the
 * fleet-v2 checkout itself. Failures come back as failed publication
 * results for reconciliation; publication never throws.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  PublishKeeperToShelfRequest,
  PublishKeeperToShelfResult,
} from '../../application/ports/out/KeeperPublicationPort.out-port.js';
import type { KnowledgeEntryRecord } from '../../domain/knowledge-records.js';
import type { KeeperPublicationCallback } from './KeeperPublicationAdapter.adapter.js';

const ZERO_OID = '0'.repeat(40);
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
/** Applied to every command: no repository hooks, no commit signing. */
const GIT_CONFIG_ARGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false'] as const;

/**
 * Runs one git argv (element 0 is the `git` executable) with an explicit
 * child environment and optional stdin. Argument arrays only — no shell.
 */
export interface GitArgvRunner {
  run(
    argv: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly stdin?: string;
    },
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
}

/** Default runner: `spawn` with the exact argv and environment it is given. */
export class NodeGitArgvRunner implements GitArgvRunner {
  async run(
    argv: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly stdin?: string;
    },
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
    const argvList = [...argv];
    return new Promise((settle) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(argvList[0] as string, argvList.slice(1), {
        cwd: options.cwd,
        env: { ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error: Error) => {
        settle({ exitCode: 1, stdout, stderr: `${stderr}${error.message}`.trim() });
      });
      child.on('close', (code) => {
        settle({ exitCode: code ?? 1, stdout, stderr });
      });
      // A child that exits without reading stdin (e.g. `rev-parse`) makes the
      // pipe write fail with EPIPE; that is not a command failure.
      child.stdin.on('error', () => {});
      child.stdin.end(options.stdin ?? '');
    });
  }
}

export interface GitShelfProviderDependencies {
  /** The shelf git repository's working tree root. Must not be the fleet-v2 checkout. */
  readonly repoDir: string;
  /** Branch the keepers are written to. Must not be the repository's checked-out HEAD branch. */
  readonly branch: string;
  /** Path prefix inside the tree; keepers become `<pathPrefix>/<entryId>.md`. */
  readonly pathPrefix: string;
  /** Injected argv runner; defaults to NodeGitArgvRunner. */
  readonly run?: GitArgvRunner;
}

export class GitShelfProvider {
  private readonly run: GitArgvRunner;

  constructor(private readonly deps: GitShelfProviderDependencies) {
    this.run = deps.run ?? new NodeGitArgvRunner();
  }

  /** Publish callback for KeeperPublicationAdapter. */
  readonly publish: KeeperPublicationCallback = (request) => this.publishKeeper(request);

  async publishKeeper(request: PublishKeeperToShelfRequest): Promise<PublishKeeperToShelfResult> {
    const entry = request?.entry;
    if (!entry || typeof entry !== 'object') {
      return refused('GitShelfProvider requires a request with an entry');
    }
    if (typeof entry.id !== 'string' || !SAFE_ID_PATTERN.test(entry.id) || entry.id.includes('..')) {
      return refused(
        `keeper entry id ${typeof entry.id === 'string' ? entry.id : ''} is not a safe shelf path segment`,
      );
    }
    if (!this.deps.repoDir || !this.deps.branch || typeof this.deps.pathPrefix !== 'string') {
      return refused('GitShelfProvider requires repoDir, branch and pathPrefix');
    }

    const childEnv = sanitizedChildEnv();
    const shelfPath = shelfFilePath(this.deps.pathPrefix, entry.id);

    // Fail closed before anything is written: the target must be the shelf
    // repository itself, not another repository and not the fleet-v2 checkout.
    const toplevel = await this.git(childEnv, 'rev-parse', '--show-toplevel');
    if (toplevel.exitCode !== 0 || !(await isSameDirectory(toplevel.stdout.trim(), this.deps.repoDir))) {
      return refused(`repoDir ${this.deps.repoDir} is not the git repository the commands would act on`);
    }
    if (isFleetV2Checkout(this.deps.repoDir)) {
      return refused('repoDir is the fleet-v2 checkout; the shelf repository must be a separate repository');
    }

    const head = await this.git(childEnv, 'symbolic-ref', '--short', 'HEAD');
    if (head.exitCode === 0 && head.stdout.trim() === this.deps.branch) {
      return refused(`branch ${this.deps.branch} is the repository's checked-out HEAD branch`);
    }

    const tip = await this.git(childEnv, 'rev-parse', '--verify', '--quiet', `refs/heads/${this.deps.branch}`);
    const parent = tip.exitCode === 0 ? tip.stdout.trim() : null;
    const oldOid = parent ?? ZERO_OID;

    const blob = await this.git(childEnv, 'hash-object', '-w', '--stdin', { stdin: keeperMarkdown(entry) });
    if (blob.exitCode !== 0) {
      return failed(`git hash-object failed: ${gitError(blob)}`);
    }
    const blobOid = blob.stdout.trim();

    // The three index commands run with a temporary index so no working
    // tree and no shared repository state beside object creation moves.
    const indexDir = await mkdtemp(join(tmpdir(), 'fleet-git-shelf-index-'));
    try {
      const indexEnv: Record<string, string> = { ...childEnv, GIT_INDEX_FILE: join(indexDir, 'index') };
      if (parent !== null) {
        const readTree = await this.git(indexEnv, 'read-tree', parent);
        if (readTree.exitCode !== 0) {
          return failed(`git read-tree failed: ${gitError(readTree)}`);
        }
      }
      const updateIndex = await this.git(
        indexEnv,
        'update-index',
        '--add',
        '--cacheinfo',
        `100644,${blobOid},${shelfPath}`,
      );
      if (updateIndex.exitCode !== 0) {
        return failed(`git update-index failed: ${gitError(updateIndex)}`);
      }
      const writeTree = await this.git(indexEnv, 'write-tree');
      if (writeTree.exitCode !== 0) {
        return failed(`git write-tree failed: ${gitError(writeTree)}`);
      }
      const treeOid = writeTree.stdout.trim();

      const commit = await this.git(
        childEnv,
        'commit-tree',
        treeOid,
        ...(parent !== null ? ['-p', parent] : []),
        '-m',
        commitMessage(entry),
      );
      if (commit.exitCode !== 0) {
        return failed(`git commit-tree failed: ${gitError(commit)}`);
      }
      const newOid = commit.stdout.trim();

      // Compare-and-swap: a concurrent update of the branch is refused.
      const updateRef = await this.git(childEnv, 'update-ref', `refs/heads/${this.deps.branch}`, newOid, oldOid);
      if (updateRef.exitCode !== 0) {
        return refused(`branch ${this.deps.branch} moved during publication; refused by compare-and-swap`, true);
      }
      return { outcome: 'published', externalRef: `git:${this.deps.branch}:${shelfPath}#${newOid}` };
    } finally {
      await rm(indexDir, { recursive: true, force: true });
    }
  }

  private git(
    env: Readonly<Record<string, string>>,
    subcommand: string,
    ...rest: readonly (string | { stdin: string })[]
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
    const args: string[] = [];
    let stdin: string | undefined;
    for (const part of rest) {
      if (typeof part === 'string') {
        args.push(part);
      } else {
        stdin = part.stdin;
      }
    }
    return this.run.run(['git', ...GIT_CONFIG_ARGS, subcommand, ...args], {
      cwd: this.deps.repoDir,
      env,
      stdin,
    });
  }
}

/** Child environment with every `GIT_*` variable removed (empty GIT_* allow-list). */
export function sanitizedChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^GIT_/i.test(key)) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * The fleet-v2 checkout is recognized by its `.architecture/manifest.yaml`
 * sentinel; the shelf repository must be a separate repository.
 */
export function isFleetV2Checkout(dir: string): boolean {
  return existsSync(join(dir, '.architecture', 'manifest.yaml'));
}

/** `<pathPrefix>/<entryId>.md`, with an empty pathPrefix allowed by the plan's optional form. */
export function shelfFilePath(pathPrefix: string, entryId: string): string {
  return pathPrefix ? `${pathPrefix}/${entryId}.md` : `${entryId}.md`;
}

function keeperMarkdown(entry: KnowledgeEntryRecord): string {
  const frontMatter = [
    '---',
    `id: ${entry.id}`,
    `project: ${entry.projectId}`,
    `sourceAttempt: ${entry.sourceAttemptId}`,
    `sourceCommit: ${entry.sourceCommitSha}`,
    `author: ${entry.checkerId ?? 'unknown'}`,
    '---',
    '',
  ].join('\n');
  return `${frontMatter}${entry.claimText}\n`;
}

function commitMessage(entry: KnowledgeEntryRecord): string {
  return `Add keeper ${entry.id} (${entry.projectId})`;
}

async function isSameDirectory(resolvedByGit: string, repoDir: string): Promise<boolean> {
  const a = resolve(resolvedByGit);
  const b = resolve(repoDir);
  if (a === b) return true;
  // /tmp and /private/tmp style symlink mismatches must not fail a valid repo.
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

function refused(reason: string, retryable = false): PublishKeeperToShelfResult {
  return { outcome: 'failed', reason, retryable };
}

function failed(reason: string): PublishKeeperToShelfResult {
  return { outcome: 'failed', reason, retryable: true };
}

function gitError(result: { readonly stderr: string; readonly exitCode: number }): string {
  return result.stderr.trim() || `exit ${result.exitCode}`;
}
