// Tests for lane o7-git-shelf (plan section 4, D1): the git shelf provider
// against a real temporary git repository, plus the restored SECRET_PATTERNS
// count check that was removed with the old transport tests (review of #60).
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitShelfProvider, NodeGitArgvRunner } from '../GitShelfProvider.adapter.js';
import type { GitArgvRunner, GitShelfProviderDependencies } from '../GitShelfProvider.adapter.js';
import { KeeperPublicationAdapter, SECRET_PATTERNS } from '../KeeperPublicationAdapter.adapter.js';
import type { KnowledgeEntryRecord } from '../../../domain/knowledge-records.js';

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runGit(cwd: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** A real repository with one commit on `main`, so HEAD is a checked-out branch. */
async function makeShelfRepo(): Promise<string> {
  const repoDir = await makeTempDir('git-shelf-repo-');
  await runGit(repoDir, 'init', '-b', 'main');
  await writeFile(join(repoDir, 'README.md'), '# shelf\n', 'utf8');
  await runGit(repoDir, 'add', 'README.md');
  await runGit(repoDir, '-c', 'user.name=setup', '-c', 'user.email=setup@example.com', 'commit', '-m', 'init');
  return repoDir;
}

async function installFailingHook(repoDir: string, name: string, markerPath: string): Promise<void> {
  const hooksDir = join(repoDir, '.git', 'hooks');
  await mkdir(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, name);
  await writeFile(
    hookPath,
    `#!/bin/sh\necho ran >> '${markerPath}'\nexit 1\n`,
    'utf8',
  );
  await chmod(hookPath, 0o755);
}

function makeEntry(overrides: Partial<KnowledgeEntryRecord> = {}): KnowledgeEntryRecord {
  return {
    id: 'entry-1',
    version: '1.0.0',
    projectId: 'proj-1',
    sourceAttemptId: 'attempt-1',
    sourceCommitSha: 'abc123',
    claimText: 'Always run the typecheck before committing',
    pathPrefixes: [],
    sharedAcrossProjects: false,
    disposition: 'accepted',
    verification: 'supported',
    checkerId: 'checker-1',
    dispositionReason: 'verified by procedure',
    supersededById: null,
    checks: [],
    reuses: [],
    revision: 1,
    createdAtIso: '2026-10-16T00:00:00.000Z',
    updatedAtIso: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

function makeProvider(
  repoDir: string,
  overrides: Partial<GitShelfProviderDependencies> = {},
  run?: GitArgvRunner,
): GitShelfProvider {
  return new GitShelfProvider({ repoDir, branch: 'keepers', pathPrefix: 'keepers', run, ...overrides });
}

describe('GitShelfProvider against a real git repository', () => {
  it('creates the branch with the keeper file on first publish', async () => {
    const repoDir = await makeShelfRepo();
    const provider = makeProvider(repoDir);

    const result = await provider.publish({ entry: makeEntry() });

    expect(result.outcome).toBe('published');
    const file = await runGit(repoDir, 'show', 'refs/heads/keepers:keepers/entry-1.md');
    expect(file).toContain('id: entry-1');
    expect(file).toContain('project: proj-1');
    expect(file).toContain('sourceAttempt: attempt-1');
    expect(file).toContain('sourceCommit: abc123');
    expect(file).toContain('author: checker-1');
    expect(file).toContain('Always run the typecheck before committing');
    // The working tree and HEAD stay untouched.
    expect(await runGit(repoDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(await runGit(repoDir, 'status', '--porcelain')).toBe('');
  });

  it('keeps the first file in the tree when a second keeper is published', async () => {
    const repoDir = await makeShelfRepo();
    const provider = makeProvider(repoDir);
    await provider.publish({ entry: makeEntry({ id: 'entry-1' }) });

    const result = await provider.publish({ entry: makeEntry({ id: 'entry-2' }) });

    expect(result.outcome).toBe('published');
    const listing = await runGit(repoDir, 'ls-tree', '-r', '--name-only', 'refs/heads/keepers');
    // The branch's first commit carries only the keeper (no read-tree), and
    // the second keeper reuses the parent's tree, keeping the first file.
    expect(listing.split('\n').sort()).toEqual(['keepers/entry-1.md', 'keepers/entry-2.md']);
  });

  it('does not run repository hooks — a failing post-index-change and reference-transaction are ignored', async () => {
    const repoDir = await makeShelfRepo();
    const markerPath = join(await makeTempDir('git-shelf-hooks-'), 'hooks-ran');
    await installFailingHook(repoDir, 'post-index-change', markerPath);
    await installFailingHook(repoDir, 'reference-transaction', markerPath);
    const provider = makeProvider(repoDir);

    const result = await provider.publish({ entry: makeEntry() });

    expect(result.outcome).toBe('published');
    await expect(readFile(markerPath, 'utf8')).rejects.toThrow();
    expect(await runGit(repoDir, 'ls-tree', '-r', '--name-only', 'refs/heads/keepers')).toContain('entry-1');
  });

  it('refuses a concurrent update through the compare-and-swap', async () => {
    const repoDir = await makeShelfRepo();
    const branch = 'keepers';
    await makeProvider(repoDir).publish({ entry: makeEntry({ id: 'entry-1' }) });
    const realRunner = new NodeGitArgvRunner();
    let competing = false;
    const racingRunner: GitArgvRunner = {
      async run(argv, options) {
        if (!competing && argv.includes('update-ref')) {
          competing = true;
          // Simulate a concurrent writer landing between the provider's tip
          // read and its update-ref compare-and-swap.
          const tree = await runGit(repoDir, 'rev-parse', `refs/heads/${branch}^{tree}`);
          const tip = await runGit(repoDir, 'rev-parse', `refs/heads/${branch}`);
          const competingCommit = await runGit(
            repoDir,
            '-c', 'user.name=other', '-c', 'user.email=other@example.com',
            'commit-tree', tree, '-p', tip, '-m', 'competing',
          );
          await runGit(repoDir, 'update-ref', `refs/heads/${branch}`, competingCommit, tip);
        }
        return realRunner.run(argv, options);
      },
    };

    const result = await makeProvider(repoDir, {}, racingRunner).publish({ entry: makeEntry({ id: 'entry-2' }) });

    expect(result).toEqual({
      outcome: 'failed',
      reason: expect.stringContaining('refused by compare-and-swap'),
      retryable: true,
    });
    const listing = await runGit(repoDir, 'ls-tree', '-r', '--name-only', `refs/heads/${branch}`);
    expect(listing).not.toContain('entry-2.md');
  });

  it('refuses when the branch is the repository’s checked-out HEAD branch', async () => {
    const repoDir = await makeShelfRepo();
    const provider = makeProvider(repoDir, { branch: 'main' });

    const result = await provider.publish({ entry: makeEntry() });

    expect(result).toEqual({
      outcome: 'failed',
      reason: expect.stringContaining('checked-out HEAD branch'),
      retryable: false,
    });
    const listing = await runGit(repoDir, 'ls-tree', '-r', '--name-only', 'refs/heads/main');
    expect(listing).toBe('README.md');
  });

  it('refuses when the branch is checked out in ANY worktree of the shelf repository', async () => {
    const repoDir = await makeShelfRepo();
    const provider = makeProvider(repoDir);
    // The keepers branch must exist before a worktree can be added on it.
    await provider.publish({ entry: makeEntry({ id: 'entry-1' }) });
    const worktreeDir = await makeTempDir('git-shelf-worktree-');
    await runGit(repoDir, 'worktree', 'add', worktreeDir, 'keepers');
    const tipBefore = await runGit(repoDir, 'rev-parse', 'refs/heads/keepers');

    const result = await provider.publish({ entry: makeEntry({ id: 'entry-2' }) });

    expect(result).toEqual({
      outcome: 'failed',
      reason: expect.stringContaining('checked out in a worktree'),
      retryable: false,
    });
    expect(await runGit(repoDir, 'rev-parse', 'refs/heads/keepers')).toBe(tipBefore);
    const listing = await runGit(repoDir, 'ls-tree', '-r', '--name-only', 'refs/heads/keepers');
    expect(listing).not.toContain('entry-2.md');
    // Cleanup before the temp dirs are removed.
    await runGit(repoDir, 'worktree', 'remove', '--force', worktreeDir);
  });

  it('commits with the fixed configured identity, not the host defaults or operator identity', async () => {
    const repoDir = await makeShelfRepo();
    // No user identity anywhere: HOME points at an empty temp dir, and the
    // repository carries no user.name/user.email config (setup used -c only).
    const emptyHome = await makeTempDir('git-shelf-empty-home-');
    const previousHome = process.env.HOME;
    process.env.HOME = emptyHome;

    try {
      const provider = makeProvider(repoDir, { authorName: 'shelf bot', authorEmail: 'bot@shelf.invalid' });
      const result = await provider.publish({ entry: makeEntry() });
      expect(result.outcome).toBe('published');

      const identity = await runGit(repoDir, 'log', '-1', '--format=%an|%ae|%cn|%ce', 'refs/heads/keepers');
      expect(identity).toBe('shelf bot|bot@shelf.invalid|shelf bot|bot@shelf.invalid');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('defaults the commit identity to the fleet-v2 shelf identity', async () => {
    const repoDir = await makeShelfRepo();
    const emptyHome = await makeTempDir('git-shelf-empty-home-');
    const previousHome = process.env.HOME;
    process.env.HOME = emptyHome;

    try {
      const provider = makeProvider(repoDir);
      const result = await provider.publish({ entry: makeEntry() });
      expect(result.outcome).toBe('published');

      const identity = await runGit(repoDir, 'log', '-1', '--format=%an|%ae|%cn|%ce', 'refs/heads/keepers');
      expect(identity).toBe('fleet-v2 shelf|shelf@fleet-v2.invalid|fleet-v2 shelf|shelf@fleet-v2.invalid');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('refuses an unsafe pathPrefix explicitly and writes nothing', async () => {
    const repoDir = await makeShelfRepo();
    for (const badPrefix of ['/absolute', 'a/../b', '.git/keepers', 'x/.git', 'x//y']) {
      const provider = makeProvider(repoDir, { pathPrefix: badPrefix });

      const result = await provider.publish({ entry: makeEntry() });

      expect(result, badPrefix).toEqual({
        outcome: 'failed',
        reason: expect.stringContaining('not a safe shelf path prefix'),
        retryable: false,
      });
      expect(await runGit(repoDir, 'for-each-ref', 'refs/heads/keepers')).toBe('');
    }

    // A safe prefix still publishes.
    const provider = makeProvider(repoDir, { pathPrefix: 'shared/note' });
    const result = await provider.publish({ entry: makeEntry() });
    expect(result.outcome).toBe('published');
    expect(await runGit(repoDir, 'ls-tree', '-r', '--name-only', 'refs/heads/keepers')).toBe(
      'shared/note/entry-1.md',
    );
  });

  it('refuses an entry id that fails the safe-id rule and writes nothing', async () => {
    const repoDir = await makeShelfRepo();
    const provider = makeProvider(repoDir);
    await provider.publish({ entry: makeEntry({ id: 'entry-1' }) });
    const tipBefore = await runGit(repoDir, 'rev-parse', 'refs/heads/keepers');

    for (const badId of ['../escape', 'a..b', 'bad/id', 'bad id!', 'x'.repeat(129), '']) {
      const result = await provider.publish({ entry: makeEntry({ id: badId }) });
      expect(result).toEqual({
        outcome: 'failed',
        reason: expect.stringContaining('not a safe shelf path segment'),
        retryable: false,
      });
    }

    expect(await runGit(repoDir, 'rev-parse', 'refs/heads/keepers')).toBe(tipBefore);
  });

  it('refuses when repoDir is the fleet-v2 checkout', async () => {
    const repoDir = await makeShelfRepo();
    // The checkout sentinel the provider recognizes.
    await mkdir(join(repoDir, '.architecture'), { recursive: true });
    await writeFile(join(repoDir, '.architecture', 'manifest.yaml'), 'sentinel\n', 'utf8');
    const provider = makeProvider(repoDir);

    const result = await provider.publish({ entry: makeEntry() });

    expect(result).toEqual({
      outcome: 'failed',
      reason: expect.stringContaining('fleet-v2 checkout'),
      retryable: false,
    });
  });

  it('runs every command with the plan’s argv shape and a GIT_*-free child environment', async () => {
    const repoDir = await makeShelfRepo();
    const realRunner = new NodeGitArgvRunner();
    const observed: { argv: readonly string[]; envKeys: readonly string[]; stdin?: string }[] = [];
    const recordingRunner: GitArgvRunner = {
      async run(argv, options) {
        observed.push({ argv, envKeys: Object.keys(options.env), stdin: options.stdin });
        return realRunner.run(argv, options);
      },
    };
    // Plant a hostile environment: it must be stripped from every child.
    process.env.GIT_DIR = '/elsewhere/.git';
    process.env.GIT_WORK_TREE = '/elsewhere';
    process.env.GIT_CONFIG_COUNT = '1';

    try {
      const provider = makeProvider(repoDir, {}, recordingRunner);
      const result = await provider.publish({ entry: makeEntry() });
      expect(result.outcome).toBe('published');
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
      delete process.env.GIT_CONFIG_COUNT;
    }

    expect(observed.length).toBeGreaterThanOrEqual(6);
    for (const call of observed) {
      expect(call.argv[0]).toBe('git');
      expect(call.argv.slice(1, 7)).toEqual([
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
      ]);
      expect(call.envKeys.filter((key) => /^GIT_/i.test(key))).toEqual(
        call.argv.includes('read-tree') || call.argv.includes('update-index') || call.argv.includes('write-tree')
          ? ['GIT_INDEX_FILE']
          : [],
      );
    }
    const hashObject = observed.find((call) => call.argv.includes('hash-object'));
    expect(hashObject?.stdin).toContain('Always run the typecheck before committing');
    const updateRef = observed.find((call) => call.argv.includes('update-ref'));
    expect(updateRef?.argv.slice(7)).toEqual([
      'update-ref',
      'refs/heads/keepers',
      expect.any(String),
      '0'.repeat(40),
    ]);
    const commitTree = observed.find((call) => call.argv.includes('commit-tree'));
    expect(commitTree?.argv).not.toContain('-p');
  });

  it('sends `-p <parent>` to commit-tree for a second keeper', async () => {
    const repoDir = await makeShelfRepo();
    const realRunner = new NodeGitArgvRunner();
    const observed: string[][] = [];
    const recordingRunner: GitArgvRunner = {
      async run(argv, options) {
        if (argv.includes('commit-tree')) observed.push([...argv]);
        return realRunner.run(argv, options);
      },
    };
    const provider = makeProvider(repoDir, {}, recordingRunner);
    await provider.publish({ entry: makeEntry({ id: 'entry-1' }) });
    await provider.publish({ entry: makeEntry({ id: 'entry-2' }) });

    expect(observed).toHaveLength(2);
    const [first, second] = observed;
    expect(first).not.toContain('-p');
    expect(second).toEqual(expect.arrayContaining(['-p']));
  });
});

describe('KeeperPublicationAdapter with the git provider (composition)', () => {
  it('refuses a secret keeper before the git provider and writes nothing', async () => {
    const repoDir = await makeShelfRepo();
    const run = vi.fn<GitArgvRunner['run']>();
    const provider = makeProvider(repoDir, {}, { run } as unknown as GitArgvRunner);
    const publication = new KeeperPublicationAdapter({ publish: provider.publish });

    const result = await publication.publishKeeperToShelf({
      entry: makeEntry({
        id: 'secret-keeper',
        claimText: 'Private key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
      }),
    });

    expect(result).toEqual({
      outcome: 'failed',
      reason: 'keeper text matches a secret pattern; not published',
      retryable: false,
    });
    expect(run).not.toHaveBeenCalled();
    expect(await runGit(repoDir, 'for-each-ref', 'refs/heads/keepers')).toBe('');
  });
});

describe('SECRET_PATTERNS registry', () => {
  // Restored should-fix from the review of #60: the count check guards the
  // refusal coverage of every pattern family.
  it('exports the six secret patterns', () => {
    expect(Array.isArray(SECRET_PATTERNS)).toBe(true);
    expect(SECRET_PATTERNS).toHaveLength(6);
  });

  it('refuses keeper text matching each pattern family', async () => {
    const samples: Record<string, string> = {
      'PEM private key': 'Private key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
      'GitHub token': 'Found leak: ghp_12345678901234567890 in log',
      'API key': 'Key sk-12345678901234567890 must not leak',
      'AWS access key': 'Credential AKIAIOSFODNN7EXAMPLE configured',
      'Slack token': 'Token xoxb-1234567890-abcdefghij used',
      JWT: 'Expired eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c here',
    };
    for (const [name, text] of Object.entries(samples)) {
      const stateDir = await makeTempDir('git-shelf-secret-');
      const publication = new KeeperPublicationAdapter({ stateDir });
      const result = await publication.publishKeeperToShelf({
        entry: makeEntry({ id: `secret-${name.toLowerCase().replace(/\W+/g, '-')}`, claimText: text }),
      });
      expect(result, name).toEqual({
        outcome: 'failed',
        reason: 'keeper text matches a secret pattern; not published',
        retryable: false,
      });
      await expect(readFile(join(stateDir, 'keepers-shelf.json'), 'utf8')).rejects.toThrow();
    }
  });
});
