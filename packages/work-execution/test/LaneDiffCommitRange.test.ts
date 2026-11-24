/**
 * SN2 tests: `LaneDiffCheckAdapter.checkLaneDiffCommitRange` scans every
 * commit of an adoption range on its own diff, in real git. Every test title
 * states what it asserts. Secret-shaped strings are built at runtime by
 * concatenation, so no secret shape exists in this source file.
 *
 * Mutation proof: with the per-commit walk replaced by a scan of the final
 * tree only (the `commits` list cut to its last entry), "refuses a secret
 * added by one commit and removed by a later one" failed (clean instead of
 * findings); with the commit cap removed, "answers range-too-large past the
 * commit cap" failed; both were restored afterwards.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { CommandExecutorPort } from '../src/application/ports/out/CommandExecutorPort.out-port.js';
import { LaneDiffCheckAdapter, MAX_RANGE_COMMITS } from '../src/infrastructure/adapters/LaneDiffCheckAdapter.adapter.js';

const executor: CommandExecutorPort = {
  async run(argv, options) {
    const result = spawnSync(argv[0]!, argv.slice(1), {
      cwd: options?.cwd,
      input: options?.input,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { exitCode: result.status, signal: null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  },
};

const repos: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

/** A GitHub-token-shaped string, assembled at runtime. */
function fakeToken(): string {
  return 'gh' + 'p_' + 'a1B2c3D4e5'.repeat(3);
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'sn2-range-'));
  repos.push(repo);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'x',
    GIT_AUTHOR_EMAIL: 'x@example.invalid',
    GIT_COMMITTER_NAME: 'x',
    GIT_COMMITTER_EMAIL: 'x@example.invalid',
  };
  const git = (...args: string[]): string => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
    return result.stdout.trim();
  };
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  git('init', '-q', '-b', 'main');
  write('packages/example/src/base.ts', 'export const base = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { repo, git, write, base: git('rev-parse', 'HEAD') };
}

function request(repo: string, base: string, head: string) {
  return {
    worktreePath: repo,
    baseCommit: base,
    headCommit: head,
    allowedPathPrefixes: ['packages/example/src'],
  };
}

describe('LaneDiffCheckAdapter.checkLaneDiffCommitRange (SN2)', () => {
  it('refuses a secret added by one commit and removed by a later one, though the final tree is clean', async () => {
    const { repo, git, write, base } = makeRepo();
    write('packages/example/src/leak.ts', `export const key = '${fakeToken()}';\n`);
    git('add', '-A');
    git('commit', '-q', '-m', 'A adds the token');
    git('rm', '-q', 'packages/example/src/leak.ts');
    git('commit', '-q', '-m', 'B removes the token');
    const head = git('rev-parse', 'HEAD');
    const adapter = new LaneDiffCheckAdapter(executor);
    // The final tree alone is clean: this is what the adoption check missed.
    expect(await adapter.checkLaneDiff({ worktreePath: repo, baseCommit: base, allowedPathPrefixes: ['packages/example/src'] })).toEqual({
      outcome: 'clean',
    });
    const verdict = await adapter.checkLaneDiffCommitRange(request(repo, base, head));
    expect(verdict.outcome).toBe('findings');
    if (verdict.outcome === 'findings') {
      expect(verdict.findings.map((finding) => [finding.path, finding.rule])).toEqual([
        ['packages/example/src/leak.ts', 'secret-pattern:github-token'],
      ]);
      expect(JSON.stringify(verdict)).not.toContain(fakeToken());
    }
  });

  it('refuses a commit that touches a path outside the allowed prefixes even when a later commit reverts it', async () => {
    const { repo, git, write, base } = makeRepo();
    write('docs/outside.md', 'hello\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'A adds an outside file');
    git('rm', '-q', 'docs/outside.md');
    git('commit', '-q', '-m', 'B removes it');
    const verdict = await new LaneDiffCheckAdapter(executor).checkLaneDiffCommitRange(
      request(repo, base, git('rev-parse', 'HEAD')),
    );
    expect(verdict.outcome).toBe('findings');
  });

  it('answers clean for a range whose every commit is clean', async () => {
    const { repo, git, write, base } = makeRepo();
    write('packages/example/src/one.ts', 'export const one = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'one');
    write('packages/example/src/two.ts', 'export const two = 2;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'two');
    expect(
      await new LaneDiffCheckAdapter(executor).checkLaneDiffCommitRange(request(repo, base, git('rev-parse', 'HEAD'))),
    ).toEqual({ outcome: 'clean' });
  });

  it('answers range-too-large past the commit cap, before reading any content', async () => {
    const { repo, git, write, base } = makeRepo();
    for (let index = 0; index <= MAX_RANGE_COMMITS; index += 1) {
      write(`packages/example/src/f${index}.ts`, `export const v${index} = ${index};\n`);
      git('add', '-A');
      git('commit', '-q', '-m', `c${index}`);
    }
    expect(
      await new LaneDiffCheckAdapter(executor).checkLaneDiffCommitRange(request(repo, base, git('rev-parse', 'HEAD'))),
    ).toEqual({ outcome: 'range-too-large', limit: 'commits' });
  });

  it('errors on a merge commit in the range and on a malformed commit id, never a pass', async () => {
    const { repo, git, write, base } = makeRepo();
    git('checkout', '-q', '-b', 'side');
    write('packages/example/src/side.ts', 'export const side = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'side');
    git('checkout', '-q', 'main');
    write('packages/example/src/main.ts', 'export const main = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'main');
    git('merge', '-q', '--no-ff', '-m', 'merge', 'side');
    const adapter = new LaneDiffCheckAdapter(executor);
    expect((await adapter.checkLaneDiffCommitRange(request(repo, base, git('rev-parse', 'HEAD')))).outcome).toBe('error');
    expect((await adapter.checkLaneDiffCommitRange(request(repo, base, '--output=x'))).outcome).toBe('error');
    expect((await adapter.checkLaneDiffCommitRange(request(repo, 'HEAD', git('rev-parse', 'HEAD')))).outcome).toBe('error');
  });
});
