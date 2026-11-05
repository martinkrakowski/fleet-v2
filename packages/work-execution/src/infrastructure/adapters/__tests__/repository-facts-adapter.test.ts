// Lane CO16: read-only repository facts adapter tests.
import { describe, expect, it } from 'vitest';

import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import { RepositoryFactsAdapter } from '../RepositoryFactsAdapter.adapter.js';

const REPOSITORY = '/srv/fleet-v2';
const COMMIT = 'a'.repeat(40);

interface RecordedRun {
  readonly argv: readonly string[];
  readonly options: CommandRunOptions | undefined;
}

/** A scripted executor that records argv and answers by argv string. */
function makeExecutor(answers: Record<string, CommandRunResult>) {
  const recorded: RecordedRun[] = [];
  const executor: CommandExecutorPort = {
    async run(argv, options) {
      recorded.push({ argv: [...argv], options });
      return answers[argv.join(' ')] ?? {
        exitCode: 1,
        signal: null,
        stdout: '',
        stderr: 'no scripted answer',
      };
    },
  };
  return { executor, recorded };
}

const BLOB = ['first line', 'second line', 'third line'].join('\n');
const BLOB_PATH = 'docs/notes.md';

function sizeAnswer(bytes: number): CommandRunResult {
  return { exitCode: 0, signal: null, stdout: `${bytes}\n`, stderr: '' };
}

const HAPPY_ANSWERS = {
  [`env GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL=none GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/nonexistent/fleet-v2-repository-facts-no-grafts git --no-replace-objects -c core.pager=cat -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null -c protocol.allow=never -C ${REPOSITORY} cat-file -s ${COMMIT}:${BLOB_PATH}`]: sizeAnswer(BLOB.length),
  [`env GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL=none GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/nonexistent/fleet-v2-repository-facts-no-grafts git --no-replace-objects -c core.pager=cat -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null -c protocol.allow=never -C ${REPOSITORY} cat-file blob ${COMMIT}:${BLOB_PATH}`]: { exitCode: 0, signal: null, stdout: BLOB, stderr: '' },
};

function makeAdapter(executor: CommandExecutorPort, overrides: { maxFactBytes?: number } = {}): RepositoryFactsAdapter {
  return new RepositoryFactsAdapter({
    executor,
    ...overrides,
  });
}

describe('RepositoryFactsAdapter', () => {
  it('reads a file range at the pinned commit with read-only git argv', async () => {
    const { executor, recorded } = makeExecutor(HAPPY_ANSWERS);
    const adapter = makeAdapter(executor);

    const read = await adapter.readFileRangeAtCommit({
      repositoryPath: REPOSITORY,
      commit: COMMIT,
      path: BLOB_PATH,
      fromLine: 2,
      toLine: 3,
    });

    expect(read).toEqual({ status: 'read', text: 'second line\nthird line' });
    const blobCall = recorded.find((call) => call.argv.includes('blob'));
    expect(blobCall).toBeDefined();
    if (blobCall === undefined) {
      return;
    }
    expect(blobCall.argv[0]).toBe('env');
    expect(blobCall.argv).toContain('GIT_NO_REPLACE_OBJECTS=1');
    // No read may reach the network: no lazy fetch, no transport at all.
    expect(blobCall.argv).toContain('GIT_NO_LAZY_FETCH=1');
    expect(blobCall.argv).toContain('GIT_ALLOW_PROTOCOL=none');
    const allowIndex = blobCall.argv.indexOf('protocol.allow=never');
    expect(allowIndex).toBeGreaterThan(0);
    expect(blobCall.argv[allowIndex - 1]).toBe('-c');
    const gitIndex = blobCall.argv.indexOf('git');
    expect(blobCall.argv[gitIndex + 1]).toBe('--no-replace-objects');
    const dashCIndex = blobCall.argv.indexOf('-C');
    expect(blobCall.argv[dashCIndex + 1]).toBe(REPOSITORY);
    expect(blobCall.argv.slice(-3)).toEqual(['cat-file', 'blob', `${COMMIT}:${BLOB_PATH}`]);
  });

  it('lists the files under a prefix at the pinned commit', async () => {
    const listingArgvKey = `env GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL=none GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/nonexistent/fleet-v2-repository-facts-no-grafts git --no-replace-objects -c core.pager=cat -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null -c protocol.allow=never -C ${REPOSITORY} ls-tree -r --name-only ${COMMIT} -- packages/work-execution`;
    const { executor, recorded } = makeExecutor({
      [listingArgvKey]: { exitCode: 0, signal: null, stdout: 'packages/work-execution/a.ts\npackages/work-execution/b.ts\n', stderr: '' },
    });
    const adapter = makeAdapter(executor);

    const listing = await adapter.listFilesAtCommit({
      repositoryPath: REPOSITORY,
      commit: COMMIT,
      pathPrefix: 'packages/work-execution',
    });

    expect(listing).toEqual({
      status: 'read',
      paths: ['packages/work-execution/a.ts', 'packages/work-execution/b.ts'],
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].argv.slice(-6)).toEqual([
      'ls-tree', '-r', '--name-only', COMMIT, '--', 'packages/work-execution',
    ]);
  });

  it('reports an oversized blob without reading its content', async () => {
    const { executor, recorded } = makeExecutor({
      ...HAPPY_ANSWERS,
      // The size answer now exceeds the default 1 MiB cap.
      [`env GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL=none GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/nonexistent/fleet-v2-repository-facts-no-grafts git --no-replace-objects -c core.pager=cat -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null -c protocol.allow=never -C ${REPOSITORY} cat-file -s ${COMMIT}:${BLOB_PATH}`]: sizeAnswer(2 * 1024 * 1024),
    });
    const adapter = makeAdapter(executor);

    const read = await adapter.readFileRangeAtCommit({
      repositoryPath: REPOSITORY,
      commit: COMMIT,
      path: BLOB_PATH,
      fromLine: 1,
      toLine: 1,
    });

    expect(read).toEqual({ status: 'oversized' });
    expect(recorded.some((call) => call.argv.includes('blob'))).toBe(false);
  });

  it('reports an unreadable file when git fails', async () => {
    const { executor } = makeExecutor({
      [`env GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL=none GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1 GIT_GRAFT_FILE=/nonexistent/fleet-v2-repository-facts-no-grafts git --no-replace-objects -c core.pager=cat -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null -c protocol.allow=never -C ${REPOSITORY} cat-file -s ${COMMIT}:${BLOB_PATH}`]: { exitCode: 5, signal: null, stdout: '', stderr: 'boom' },
    });
    const adapter = makeAdapter(executor);

    const read = await adapter.readMatchingLinesAtCommit({
      repositoryPath: REPOSITORY,
      commit: COMMIT,
      path: BLOB_PATH,
      token: 'line',
    });

    expect(read).toEqual({ status: 'unreadable' });
  });

  it('refuses a pathspec-magic or glob prefix without running git', async () => {
    const { executor, recorded } = makeExecutor({});
    const adapter = makeAdapter(executor);

    for (const pathPrefix of [':(top,glob)**/*.md', 'packages/*', 'packages/..', '/abs/path']) {
      const listing = await adapter.listFilesAtCommit({
        repositoryPath: REPOSITORY,
        commit: COMMIT,
        pathPrefix,
      });
      expect(listing).toEqual({ status: 'unreadable', paths: [] });
    }
    expect(recorded).toHaveLength(0);
  });

  it('refuses a commit that is not a plain object name without running git', async () => {
    const { executor, recorded } = makeExecutor({});
    const adapter = makeAdapter(executor);

    for (const commit of ['HEAD', 'A'.repeat(40), 'a'.repeat(39), `${'a'.repeat(64)}x`]) {
      const listing = await adapter.listFilesAtCommit({
        repositoryPath: REPOSITORY,
        commit,
        pathPrefix: 'packages',
      });
      const read = await adapter.readFileRangeAtCommit({
        repositoryPath: REPOSITORY,
        commit,
        path: BLOB_PATH,
        fromLine: 1,
        toLine: 1,
      });
      expect(listing).toEqual({ status: 'unreadable', paths: [] });
      expect(read).toEqual({ status: 'unreadable' });
    }
    expect(recorded).toHaveLength(0);
  });

  it('never runs a git command that writes', async () => {
    const { executor, recorded } = makeExecutor(HAPPY_ANSWERS);
    const adapter = makeAdapter(executor);

    await adapter.listFilesAtCommit({
      repositoryPath: REPOSITORY,
      commit: COMMIT,
      pathPrefix: 'packages',
    });
    await adapter.readFileRangeAtCommit({
      repositoryPath: REPOSITORY,
      commit: COMMIT,
      path: BLOB_PATH,
      fromLine: 1,
      toLine: 3,
    });
    await adapter.readMatchingLinesAtCommit({
      repositoryPath: REPOSITORY,
      commit: COMMIT,
      path: BLOB_PATH,
      token: 'line',
    });

    expect(recorded.length).toBeGreaterThanOrEqual(4);
    for (const call of recorded) {
      const dashCIndex = call.argv.indexOf('-C');
      const subcommand = call.argv[dashCIndex + 2];
      expect(['ls-tree', 'cat-file']).toContain(subcommand);
    }
  });
});
