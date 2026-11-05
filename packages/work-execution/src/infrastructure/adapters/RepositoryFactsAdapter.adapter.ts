// Lane CO16: read-only repository facts at a pinned commit, read through the command executor.
/**
 * Every git call is an argv array through `CommandExecutorPort.run` — no
 * shell, no write, no fetch, no network transport, no credential path. Only
 * the read-only subcommands `ls-tree` and `cat-file` run, under the hardened
 * replace-ref/grafts prefix (`env GIT_NO_REPLACE_OBJECTS=1 ...`), so the
 * pinned commit the facts are read at cannot be re-pointed underneath the
 * read. Nothing is ever truncated silently: a blob above the cap is reported
 * as `oversized` before its content is read, and a listing above the entry
 * cap is reported rather than cut.
 */

import type {
  RepositoryFactRead,
  RepositoryFactsPort,
  RepositoryFactsRequest,
  RepositoryFileListing,
} from '../../application/ports/out/RepositoryFactsPort.out-port.js';
import type { CommandExecutorPort } from '../../application/ports/out/CommandExecutorPort.out-port.js';

export interface RepositoryFactsAdapterOptions {
  readonly executor: CommandExecutorPort;
  /** Largest blob read, in bytes. Default 1 MiB. */
  readonly maxFactBytes?: number;
  /** Largest listing, in entries. Default 5000. */
  readonly maxListEntries?: number;
  /** Largest matching-line block, in lines. Default 200. */
  readonly maxMatchingLines?: number;
}

/** A plain object name: 40–64 lowercase hex digits. */
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;

/** Wall-clock budget for one git read. */
const GIT_TIMEOUT_MS = 30_000;

/**
 * Applied to every git command: the replace-ref pin and a grafts path that
 * never exists travel inside the command itself (`env ...` first), so the
 * setting survives an ssh transport — mirroring LaneDiffCheckAdapter.
 */
const GIT_ARGV_PREFIX = [
  'env',
  'GIT_NO_REPLACE_OBJECTS=1',
  'GIT_GRAFT_FILE=/nonexistent/fleet-v2-repository-facts-no-grafts',
  'git',
  '--no-replace-objects',
  '-c',
  'core.pager=cat',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.attributesFile=/dev/null',
  '-C',
] as const;

interface CommandOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly failed: boolean;
}

const OVERSIZED_READ: RepositoryFactRead = { status: 'oversized' };
const UNREADABLE_READ: RepositoryFactRead = { status: 'unreadable' };
const ABSENT_READ: RepositoryFactRead = { status: 'absent' };

export class RepositoryFactsAdapter implements RepositoryFactsPort {
  private readonly executor: CommandExecutorPort;
  private readonly maxFactBytes: number;
  private readonly maxListEntries: number;
  private readonly maxMatchingLines: number;

  public constructor(options: RepositoryFactsAdapterOptions) {
    this.executor = options.executor;
    this.maxFactBytes = options.maxFactBytes ?? 1024 * 1024;
    this.maxListEntries = options.maxListEntries ?? 5000;
    this.maxMatchingLines = options.maxMatchingLines ?? 200;
  }

  public async listFilesAtCommit(
    request: RepositoryFactsRequest & { readonly pathPrefix: string },
  ): Promise<RepositoryFileListing> {
    if (!COMMIT_PATTERN.test(request.commit)) {
      return { status: 'unreadable', paths: [] };
    }
    const outcome = await this.runGit(request.repositoryPath, [
      'ls-tree',
      '-r',
      '--name-only',
      request.commit,
      '--',
      request.pathPrefix,
    ]);
    if (outcome.failed) {
      return { status: 'unreadable', paths: [] };
    }
    const paths = outcome.stdout.split('\n').filter((line) => line.length > 0);
    if (paths.length > this.maxListEntries) {
      return { status: 'oversized', paths: [] };
    }
    return { status: 'read', paths };
  }

  public async readFileRangeAtCommit(
    request: RepositoryFactsRequest & { readonly path: string; readonly fromLine: number; readonly toLine: number },
  ): Promise<RepositoryFactRead> {
    const blob = await this.readBlob(request.repositoryPath, request.commit, request.path);
    if (blob.status !== 'read') {
      return blob;
    }
    const lines = blob.text.split('\n');
    // 1-based, inclusive; a range past the end of the file is an empty read.
    const selected = lines.slice(request.fromLine - 1, request.toLine);
    return { status: 'read', text: selected.join('\n') };
  }

  public async readMatchingLinesAtCommit(
    request: RepositoryFactsRequest & { readonly path: string; readonly token: string },
  ): Promise<RepositoryFactRead> {
    const blob = await this.readBlob(request.repositoryPath, request.commit, request.path);
    if (blob.status !== 'read') {
      return blob;
    }
    const matches = blob.text.split('\n').filter((line) => line.includes(request.token));
    if (matches.length > this.maxMatchingLines) {
      return OVERSIZED_READ;
    }
    return { status: 'read', text: matches.join('\n') };
  }

  /** Size check first, content second: an oversized blob is never read. */
  private async readBlob(
    repositoryPath: string,
    commit: string,
    path: string,
  ): Promise<RepositoryFactRead> {
    if (!COMMIT_PATTERN.test(commit)) {
      return UNREADABLE_READ;
    }
    const object = `${commit}:${path}`;
    const size = await this.runGit(repositoryPath, ['cat-file', '-s', object]);
    if (size.failed) {
      // `cat-file -s` exits 128 exactly when the object does not exist.
      return size.exitCode === 128 ? ABSENT_READ : UNREADABLE_READ;
    }
    const blobBytes = Number.parseInt(size.stdout.trim(), 10);
    if (!Number.isFinite(blobBytes) || blobBytes < 0) {
      return UNREADABLE_READ;
    }
    if (blobBytes > this.maxFactBytes) {
      return OVERSIZED_READ;
    }
    const content = await this.runGit(repositoryPath, ['cat-file', 'blob', object], this.maxFactBytes + 1024);
    if (content.failed) {
      return UNREADABLE_READ;
    }
    return { status: 'read', text: content.stdout };
  }

  private async runGit(
    repositoryPath: string,
    argv: readonly string[],
    maxBufferBytes?: number,
  ): Promise<CommandOutcome> {
    const run = await this.executor.run(
      [
        ...GIT_ARGV_PREFIX,
        repositoryPath,
        ...argv,
      ],
      {
        cwd: repositoryPath,
        timeoutMs: GIT_TIMEOUT_MS,
        ...(maxBufferBytes !== undefined ? { maxBufferBytes } : {}),
      },
    );
    return {
      exitCode: run.exitCode,
      stdout: run.stdout,
      failed: run.error !== undefined || run.exitCode !== 0,
    };
  }
}
