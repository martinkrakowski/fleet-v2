// @generated adapter scaffold — refined for lane CO27.
/**
 * LaneEditSaveAdapter implements LaneEditSavePort over an injected
 * CommandExecutorPort bound to the recorded lane host. It writes the
 * worktree's tracked and untracked changes (ignored paths excluded by git's
 * own rules) as one commit object on a save ref under `refs/fleet/saved/` in
 * the lane's clone. The worktree tree is built in a temporary index file with
 * a per-save random name beside the repository (never the real index), so
 * concurrent saves never share one: seed it from HEAD, `add -A`, `write-tree`,
 * remove it. The only writes are that temp index, blob and commit objects, and
 * the one save ref: no push, fetch, checkout, reset, branch commit, remote or
 * credential command, no hook, and no working-tree write. Every command
 * carries the hardened `-c` list and the network guards inside its argv (so
 * they reach a remote executor too), a 20 s deadline and an 8 MiB output cap;
 * a transport failure or timeout is `unknown`, a failed read is
 * `unreadable-tree`, never a guessed digest. Attribute lookups during `add`
 * are pinned to the empty tree, written with `hash-object -w`
 * (`GIT_ATTR_SOURCE`, honoured from git 2.40: an older or unparseable `git --version`
 * refuses the save as `unreadable-tree`), so no repository-configured
 * `.gitattributes` clean filter runs on untrusted worktree content; the one
 * higher-precedence source left, `info/attributes` in the COMMON git dir (found
 * with `rev-parse --git-path`, which is right for a linked worktree), is read with
 * `cat` and scanned in TypeScript, immediately before `add`: the save is refused
 * (`unreadable-tree`) if any non-comment line contains the text `filter` or the
 * file cannot be read; only an ENOENT answer counts as confirmed absence. A second
 * guard runs `git config --get-regexp '^filter\.'` just before `add`: any filter
 * driver defined in the repository config refuses the save. Argv commands only, no shell.
 * Git config is pinned too (no system or global config).
 * The `update-ref` carries the all-zeros expected old value, so a concurrent
 * save's ref can never be overwritten: a lost race re-reads the ref and
 * reports `already-saved` or `save-ref-conflict` instead. Nothing returned or
 * thrown carries a path, file content or a matched value.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';

import type { CommandExecutorPort } from '../../application/ports/out/CommandExecutorPort.out-port.js';
import type {
  LaneEditSavePort,
  LaneEditSaveRefusalCode,
  LaneEditSaveRequest,
  LaneEditSaveResult,
} from '../../application/ports/out/LaneEditSavePort.out-port.js';
import type { AttemptRunnerRecord } from '../../domain/execution-records.js';

export interface LaneEditSaveAdapterOptions {
  readonly executorForRecordedHost?: (recordedHost: AttemptRunnerRecord) => CommandExecutorPort | null;
}

const GIT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SAVE_REF_PATTERN = /^refs\/fleet\/saved\/[A-Za-z0-9._/-]{1,120}$/;
const SAVE_REF_FORBIDDEN = /\.\.|\/\/|\/\.|\/$|\.$|\.lock(\/|$)/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MESSAGE_PATTERN = /^[A-Za-z0-9 ._:-]{1,200}$/;
const SECRET_SHAPED_RUN = /[A-Za-z0-9_-]{32,}/;

/** Git's own wording for a missing file, anchored to the end of the message. */
const NO_SUCH_FILE = /: No such file or directory\s*$/;
const MIN_GIT: readonly [number, number] = [2, 40];

/**
 * Fail closed: true when ANY non-comment line contains the substring `filter`
 * (case-sensitive, as git is). No attribute-syntax parsing: git accepts forms
 * such as a C-quoted pattern glued to the attribute (`"*"filter=x`).
 */
const mentionsFilter = (text: string): boolean =>
  text.split(/\r?\n/).some((line) => !line.trimStart().startsWith('#') && line.includes('filter'));

/** Environment hardening that travels inside every argv so it reaches a remote ssh executor too. */
const ENV_GUARDS = [
  'GIT_ALLOW_PROTOCOL=none',
  'GIT_NO_LAZY_FETCH=1',
  'GIT_TERMINAL_PROMPT=0',
  'GIT_ATTR_NOSYSTEM=1',
  'GIT_CONFIG_NOSYSTEM=1',
  'GIT_CONFIG_GLOBAL=/dev/null',
  'GIT_CONFIG_SYSTEM=/dev/null',
  // Neutralise inherited command-scope config (it would pass the `command` exemption of the filter guard).
  'GIT_CONFIG_COUNT=0',
  'GIT_CONFIG_PARAMETERS=',
] as const;
const IDENTITY_ENV = [
  'GIT_AUTHOR_NAME=fleet-v2',
  'GIT_AUTHOR_EMAIL=fleet-v2@localhost',
  'GIT_COMMITTER_NAME=fleet-v2',
  'GIT_COMMITTER_EMAIL=fleet-v2@localhost',
] as const;

/** The lane diff check's hardened `-c` list, plus no commit signing. */
const GIT_CONFIG_ARGS = [
  '-c', 'color.ui=never',
  '-c', 'core.quotePath=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.noprefix=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'diff.submodule=short',
  '-c', 'diff.external=',
  '-c', 'filter.lfs.clean=',
  '-c', 'filter.lfs.smudge=',
  '-c', 'filter.lfs.process=',
  '-c', 'filter.lfs.required=false',
  '-c', 'commit.gpgSign=false',
] as const;

/** Carries a finished result out of a step; internal control flow only. */
class Stop extends Error {
  constructor(readonly result: LaneEditSaveResult) {
    super('lane edit save stopped');
  }
}

const refuse = (reason: LaneEditSaveRefusalCode): Stop => new Stop({ outcome: 'refused', reason });
const unknown = (reason: string): Stop => new Stop({ outcome: 'unknown', reason });

interface Ran {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const isAbsolute = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('/') && value.trim() === value && !value.includes('\0');

export class LaneEditSaveAdapter implements LaneEditSavePort {
  constructor(
    private readonly executor: CommandExecutorPort,
    private readonly options?: LaneEditSaveAdapterOptions,
  ) {}

  async saveLaneEdits(request: LaneEditSaveRequest): Promise<LaneEditSaveResult> {
    try {
      return await this.save(request);
    } catch (error: unknown) {
      return error instanceof Stop ? error.result : { outcome: 'unknown', reason: 'save-failed' };
    }
  }

  private async save(request: LaneEditSaveRequest): Promise<LaneEditSaveResult> {
    if (typeof request !== 'object' || request === null) throw refuse('invalid-request');
    const { recordedHost, clonePath: clone, worktreePath: worktree, saveRef, commitMessage } = request;
    if (!isAbsolute(clone) || !isAbsolute(worktree)) throw refuse('invalid-request');
    // A message with a path separator or a long token-shaped run is refused, never sent.
    if (typeof commitMessage !== 'string' || !MESSAGE_PATTERN.test(commitMessage) || SECRET_SHAPED_RUN.test(commitMessage)) {
      throw refuse('invalid-request');
    }
    if (typeof saveRef !== 'string' || !SAVE_REF_PATTERN.test(saveRef) || SAVE_REF_FORBIDDEN.test(saveRef)) {
      throw refuse('save-ref-invalid');
    }
    const hostName = recordedHost?.hostName;
    if (recordedHost === null || recordedHost === undefined || typeof hostName !== 'string' || hostName.trim() === '') {
      throw refuse('no-recorded-host');
    }
    const executor = this.resolveExecutor(recordedHost);

    const run = async (argv: readonly string[]): Promise<Ran> => {
      let result;
      try {
        result = await executor.run(argv, { cwd: clone, timeoutMs: GIT_TIMEOUT_MS, maxBufferBytes: MAX_OUTPUT_BYTES });
      } catch {
        throw unknown('command-failed');
      }
      if (result.error !== undefined || result.exitCode === null) throw unknown('command-failed');
      return { exitCode: result.exitCode, stdout: result.stdout.trim(), stderr: result.stderr };
    };
    const git = (dir: string, args: readonly string[], env: readonly string[] = []): readonly string[] => [
      'env', ...ENV_GUARDS, ...env, 'git', ...GIT_CONFIG_ARGS, '-C', dir, ...args,
    ];
    const step = async (argv: readonly string[]): Promise<void> => {
      if ((await run(argv)).exitCode !== 0) throw refuse('unreadable-tree');
    };
    const readId = async (dir: string, args: readonly string[], env: readonly string[] = []): Promise<string> => {
      const ran = await run(git(dir, args, env));
      if (ran.exitCode !== 0 || !OBJECT_ID.test(ran.stdout)) throw refuse('unreadable-tree');
      return ran.stdout;
    };
    const commonDir = async (dir: string): Promise<string> => {
      const absolute = await run(git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
      if (absolute.exitCode === 0 && isAbsolute(absolute.stdout)) {
        return path.posix.normalize(absolute.stdout).replace(/\/$/, '');
      }
      // An older git has no --path-format: resolve against the top level, or fail closed.
      const relative = await run(git(dir, ['rev-parse', '--git-common-dir']));
      const top = await run(git(dir, ['rev-parse', '--show-toplevel']));
      if (relative.exitCode !== 0 || top.exitCode !== 0 || relative.stdout === '' || !isAbsolute(top.stdout)) {
        throw refuse('unreadable-tree');
      }
      return path.posix.resolve(top.stdout, relative.stdout);
    };
    const removeIndex = async (index: string): Promise<void> => {
      if ((await run(['rm', '-f', '--', index])).exitCode !== 0) throw unknown('index-cleanup-failed');
    };

    const cloneCommon = await commonDir(clone);
    const worktreeCommon = await commonDir(worktree);
    if (cloneCommon !== worktreeCommon) throw refuse('worktree-not-in-clone');

    // `GIT_ATTR_SOURCE` is honoured only from git 2.40; an older git would ignore it
    // silently and run a lane-written `.gitattributes` clean filter. Refuse instead.
    const versionRan = await run(git(worktree, ['--version']));
    const versionMatch = /^git version (\d+)\.(\d+)/.exec(versionRan.stdout);
    if (versionRan.exitCode !== 0 || versionMatch === null) throw refuse('unreadable-tree');
    const major = Number(versionMatch[1]);
    const minor = Number(versionMatch[2]);
    if (major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])) throw refuse('unreadable-tree');

    // The only attribute source still able to select a clean filter is the
    // higher-precedence `info/attributes` of the COMMON git dir (a linked worktree's
    // own git dir is not read for it): `GIT_ATTR_SOURCE` covers the worktree's
    // `.gitattributes`, `core.attributesFile=/dev/null` the global file and
    // `GIT_ATTR_NOSYSTEM=1` the system file. Run immediately before `add` (the
    // residual window between this read and `add` is the executor round trip).
    const checkInfoAttributes = async (): Promise<void> => {
      const where = await run(git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'info/attributes']));
      if (where.exitCode !== 0 || !isAbsolute(where.stdout)) throw refuse('unreadable-tree');
      const read = await run(['env', 'LC_ALL=C', 'cat', '--', where.stdout]);
      if (read.exitCode === 0) {
        if (mentionsFilter(read.stdout)) throw refuse('unreadable-tree');
        return;
      }
      // Only a plain "no such file" is confirmed absence; any other failure is unknown.
      if (!NO_SUCH_FILE.test(read.stderr)) throw refuse('unreadable-tree');
    };

    // Second guard, immediately before `add`: no filter driver may be defined in the
    // repository's config at all. Exit 1 with no output is "none defined"; anything
    // else refuses. The hardening list itself sets `filter.lfs.*` on the command
    // line (scope `command`), which `--show-scope` lets us tell apart from config files.
    const checkNoFilterDriver = async (): Promise<void> => {
      const ran = await run(git(worktree, ['config', '--show-scope', '--get-regexp', '^filter\\.'], indexEnv));
      const defined = ran.stdout.split('\n').some((line) => line.trim() !== '' && !line.startsWith('command\t'));
      if (defined) throw refuse('unreadable-tree');
      if (ran.exitCode !== 0 && ran.exitCode !== 1) throw refuse('unreadable-tree');
    };

    // A per-save random name: concurrent saves for the same ref never share an index.
    const index = `${worktreeCommon}/fleet-save-index-${crypto.randomBytes(16).toString('hex')}`;
    const emptyTree = await readId(worktree, ['hash-object', '-w', '-t', 'tree', '/dev/null']);
    const indexEnv = [`GIT_INDEX_FILE=${index}`, `GIT_ATTR_SOURCE=${emptyTree}`];
    let parent: string | null = null;
    let worktreeTree = '';
    let failure: unknown = null;
    await removeIndex(index);
    try {
      const head = await run(git(worktree, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']));
      if (head.exitCode === 0 && OBJECT_ID.test(head.stdout)) {
        parent = head.stdout;
        await step(git(worktree, ['read-tree', 'HEAD'], indexEnv));
      } else {
        await step(git(worktree, ['read-tree', '--empty'], indexEnv));
      }
      await checkInfoAttributes();
      await checkNoFilterDriver();
      await step(git(worktree, ['add', '-A', '--', '.'], indexEnv));
      worktreeTree = await readId(worktree, ['write-tree'], indexEnv);
    } catch (error: unknown) {
      failure = error;
    }
    try {
      await removeIndex(index);
    } catch (error: unknown) {
      failure ??= error;
    }
    if (failure !== null) throw failure;

    const existing = await run(git(clone, ['rev-parse', '--verify', '--quiet', `${saveRef}^{commit}`]));
    if (existing.exitCode === 0 && OBJECT_ID.test(existing.stdout)) {
      const existingTree = await readId(clone, ['rev-parse', '--verify', '--quiet', `${saveRef}^{tree}`]);
      if (existingTree !== worktreeTree) throw refuse('save-ref-conflict');
      return {
        outcome: 'already-saved',
        saveRef,
        commitId: existing.stdout,
        treeDigest: existingTree,
        worktreeTreeDigest: worktreeTree,
      };
    }
    if (existing.exitCode !== 1) throw refuse('unreadable-tree');

    const commitId = await readId(
      clone,
      ['commit-tree', worktreeTree, ...(parent === null ? [] : ['-p', parent]), '-m', commitMessage],
      IDENTITY_ENV,
    );
    // The all-zeros old value refuses to overwrite a ref created by a concurrent save.
    const written = await run(git(clone, ['update-ref', saveRef, commitId, '0'.repeat(commitId.length)]));
    if (written.exitCode !== 0) {
      // A concurrent save created or moved the ref: re-read it and report, never overwrite.
      const concurrent = await run(git(clone, ['rev-parse', '--verify', '--quiet', `${saveRef}^{commit}`]));
      if (concurrent.exitCode !== 0 || !OBJECT_ID.test(concurrent.stdout)) throw refuse('unreadable-tree');
      const concurrentTree = await readId(clone, ['rev-parse', '--verify', '--quiet', `${saveRef}^{tree}`]);
      if (concurrentTree !== worktreeTree) throw refuse('save-ref-conflict');
      return {
        outcome: 'already-saved',
        saveRef,
        commitId: concurrent.stdout,
        treeDigest: concurrentTree,
        worktreeTreeDigest: worktreeTree,
      };
    }
    const treeDigest = await readId(clone, ['rev-parse', '--verify', '--quiet', `${saveRef}^{tree}`]);
    return { outcome: 'saved', saveRef, commitId, treeDigest, worktreeTreeDigest: worktreeTree };
  }

  private resolveExecutor(recordedHost: AttemptRunnerRecord): CommandExecutorPort {
    const resolve = this.options?.executorForRecordedHost;
    if (resolve === undefined) return this.executor;
    let resolved: CommandExecutorPort | null;
    try {
      resolved = resolve(recordedHost);
    } catch {
      resolved = null;
    }
    if (resolved === null || resolved === undefined) throw refuse('host-not-routable');
    return resolved;
  }
}
