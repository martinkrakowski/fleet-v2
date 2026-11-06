import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, type TestContext } from 'vitest';

import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { LaneEditSaveRequest } from '../../../application/ports/out/LaneEditSavePort.out-port.js';
import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';
import { LaneEditSaveAdapter } from '../LaneEditSaveAdapter.adapter.js';
import { LocalExecutor } from '../LocalExecutor.adapter.js';

const CLONE = '/srv/lanes/clone';
const WORKTREE = '/srv/lanes/worktrees/lane-1';
const SAVE_REF = 'refs/fleet/saved/abcdef012345-lane-1';
const TREE = 'a'.repeat(40);
const OTHER_TREE = 'c'.repeat(40);
const HEAD = 'd'.repeat(40);
const COMMIT = 'e'.repeat(40);
const EMPTY_TREE = '1'.repeat(40);

/** A git command (the adapter's other argv commands are `rm` and `cat`). */
const isGit = (argv: readonly string[]): boolean => argv[0] === 'env' && argv.includes('git');

interface Call {
  readonly argv: readonly string[];
  readonly options: CommandRunOptions | undefined;
}

interface World {
  cloneCommon: string;
  worktreeCommon: string;
  worktreeTree: string | null;
  existing: { commit: string; tree: string } | null;
  headExists: boolean;
  refWritten: boolean;
  timeoutOn?: string;
  /** `.git/info/attributes` state: absent, present without a filter, or selecting a clean filter. */
  gitVersion: string;
  infoAttributes: 'absent' | 'harmless' | 'filter' | 'quoted-filter' | 'probe-error' | 'unsearchable' | 'enoent-midline';
  /** Result of `git config --get-regexp ^filter.`: none (exit 1), a driver defined, or a failure. */
  filterConfig: 'none' | 'command-only' | 'defined' | 'exit-128' | 'exit-0-empty';
  /** When set, the first update-ref fails and the ref appears as this concurrent save (null: still absent). */
  updateRefFailsOnce?: { commit: string; tree: string } | null;
}

class FakeExecutor implements CommandExecutorPort {
  readonly calls: Call[] = [];
  readonly world: World = {
    cloneCommon: '/srv/lanes/clone/.git',
    worktreeCommon: '/srv/lanes/clone/.git',
    worktreeTree: TREE,
    existing: null,
    headExists: true,
    refWritten: false,
    timeoutOn: undefined,
    gitVersion: 'git version 2.43.0',
    infoAttributes: 'absent',
    filterConfig: 'none',
    updateRefFailsOnce: undefined,
  };

  async run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ argv, options });
    const ok = (stdout = ''): CommandRunResult => ({ exitCode: 0, signal: null, stdout: `${stdout}\n`, stderr: '' });
    const exit = (exitCode: number): CommandRunResult => ({ exitCode, signal: null, stdout: '', stderr: '' });
    const sub = argv.slice(argv.indexOf('-C') + 2).join(' ');
    if (this.world.timeoutOn !== undefined && sub.startsWith(this.world.timeoutOn)) {
      return { exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '', error: 'timed out' };
    }
    if (argv[0] === 'sh') return exit(127);
    if (argv[0] === 'env' && argv.includes('cat')) {
      const missing = { exitCode: 1, signal: null, stdout: '', stderr: 'cat: x: No such file or directory\n' };
      const denied = { exitCode: 1, signal: null, stdout: '', stderr: 'cat: x: Permission denied\n' };
      const states = {
        absent: missing,
        harmless: { exitCode: 0, signal: null, stdout: '# comment filter=x\n*.png binary\n', stderr: '' },
        filter: { exitCode: 0, signal: null, stdout: '*.c text\n* filter=x\n', stderr: '' },
        'probe-error': denied,
        unsearchable: { exitCode: 1, signal: null, stdout: '', stderr: 'cat: x: Is a directory\n' },
        'quoted-filter': { exitCode: 0, signal: null, stdout: '"*"filter=x\n', stderr: '' },
        'enoent-midline': { exitCode: 1, signal: null, stdout: '', stderr: 'cat: x: No such file or directory: Permission denied\n' },
      } as const;
      return states[this.world.infoAttributes];
    }
    if (argv[0] === 'rm') return ok();
    const inClone = argv[argv.indexOf('-C') + 1] === CLONE;
    if (sub.startsWith('rev-parse --path-format=absolute --git-common-dir')) {
      return ok(inClone ? this.world.cloneCommon : this.world.worktreeCommon);
    }
    if (sub === '--version') return ok(this.world.gitVersion);
    if (sub.startsWith('config --show-scope --get-regexp ^filter\\.')) {
      const states = {
        none: exit(1),
        'command-only': ok('command\tfilter.lfs.clean\t'),
        defined: ok('local\tfilter.x.clean\ttouch m; cat'),
        'exit-128': exit(128),
        'exit-0-empty': { exitCode: 0, signal: null, stdout: '', stderr: '' },
      } as const;
      return states[this.world.filterConfig];
    }
    if (sub === 'rev-parse --path-format=absolute --git-path info/attributes') return ok(`${this.world.worktreeCommon}/info/attributes`);
    if (sub === 'rev-parse --verify --quiet HEAD^{commit}') return this.world.headExists ? ok(HEAD) : exit(1);
    if (sub === 'hash-object -w -t tree /dev/null') return ok(EMPTY_TREE);
    if (sub === 'read-tree HEAD' || sub === 'read-tree --empty' || sub.startsWith('add -A')) return ok();
    if (sub === 'write-tree') return this.world.worktreeTree === null ? exit(128) : ok(this.world.worktreeTree);
    if (sub === `rev-parse --verify --quiet ${SAVE_REF}^{commit}`) {
      const commit = this.world.existing?.commit ?? (this.world.refWritten ? COMMIT : null);
      return commit === null ? exit(1) : ok(commit);
    }
    if (sub === `rev-parse --verify --quiet ${SAVE_REF}^{tree}`) {
      const tree = this.world.existing?.tree ?? (this.world.refWritten ? this.world.worktreeTree : null);
      return tree === null ? exit(1) : ok(tree);
    }
    if (sub.startsWith('commit-tree')) return ok(COMMIT);
    if (sub.startsWith('update-ref')) {
      const concurrent = this.world.updateRefFailsOnce;
      if (concurrent !== undefined) {
        this.world.existing = concurrent;
        this.world.updateRefFailsOnce = undefined;
        return exit(1);
      }
      this.world.refWritten = true;
      return ok();
    }
    return exit(2);
  }

  subcommands(): string[] {
    return this.calls.filter((call) => isGit(call.argv)).map((call) => call.argv.slice(call.argv.indexOf('-C') + 2).join(' '));
  }
}

const host = (hostName: string | null = 'lanehost'): AttemptRunnerRecord => ({
  kind: 'opencode', remotePort: 46000, host: null, hostName, agent: null, model: null, variant: null,
});

const request = (over: Partial<LaneEditSaveRequest> = {}): LaneEditSaveRequest => ({
  recordedHost: host(),
  clonePath: CLONE,
  worktreePath: WORKTREE,
  saveRef: SAVE_REF,
  commitMessage: 'fleet-v2 lane save abcdef012345',
  ...over,
});

describe('LaneEditSaveAdapter', () => {
  it('the save writes one commit object on the save ref', async () => {
    const executor = new FakeExecutor();
    const result = await new LaneEditSaveAdapter(executor).saveLaneEdits(request());
    expect(result).toEqual({ outcome: 'saved', saveRef: SAVE_REF, commitId: COMMIT, treeDigest: TREE, worktreeTreeDigest: TREE });
    const subs = executor.subcommands();
    expect(subs.filter((sub) => sub.startsWith('commit-tree'))).toEqual([
      `commit-tree ${TREE} -p ${HEAD} -m fleet-v2 lane save abcdef012345`,
    ]);
    expect(subs.filter((sub) => sub.startsWith('update-ref'))).toEqual([
      `update-ref ${SAVE_REF} ${COMMIT} ${'0'.repeat(COMMIT.length)}`,
    ]);
  });

  it('the real index, HEAD and the branch are untouched (argv assertion)', async () => {
    const executor = new FakeExecutor();
    await new LaneEditSaveAdapter(executor).saveLaneEdits(request());
    for (const call of executor.calls.filter((entry) => isGit(entry.argv))) {
      const sub = call.argv.slice(call.argv.indexOf('-C') + 2);
      if (['read-tree', 'add', 'write-tree'].includes(sub[0] ?? '')) {
        expect(call.argv.some((word) => /^GIT_INDEX_FILE=\/srv\/lanes\/clone\/\.git\/fleet-save-index-/.test(word))).toBe(true);
      }
      if (sub[0] === 'add') {
        // Attribute lookups are pinned to the empty tree, so no repository-configured clean filter runs.
        expect(call.argv.some((word) => word.startsWith('GIT_ATTR_SOURCE='))).toBe(true);
      }
    }
    const updates = executor.subcommands().filter((sub) => sub.startsWith('update-ref'));
    expect(updates.every((sub) => sub.startsWith(`update-ref ${SAVE_REF} `))).toBe(true);
    expect(executor.subcommands().some((sub) => /^(symbolic-ref|checkout|switch|reset)/.test(sub))).toBe(false);
  });

  it('an existing save ref with the same tree is already saved', async () => {
    const executor = new FakeExecutor();
    executor.world.existing = { commit: 'f'.repeat(40), tree: TREE };
    const result = await new LaneEditSaveAdapter(executor).saveLaneEdits(request());
    expect(result).toEqual({
      outcome: 'already-saved', saveRef: SAVE_REF, commitId: 'f'.repeat(40), treeDigest: TREE, worktreeTreeDigest: TREE,
    });
    expect(executor.subcommands().some((sub) => /^(commit-tree|update-ref)/.test(sub))).toBe(false);
  });

  it('an existing save ref with another tree is refused as save-ref-conflict', async () => {
    const executor = new FakeExecutor();
    executor.world.existing = { commit: 'f'.repeat(40), tree: OTHER_TREE };
    expect(await new LaneEditSaveAdapter(executor).saveLaneEdits(request())).toEqual({
      outcome: 'refused', reason: 'save-ref-conflict',
    });
    expect(executor.subcommands().some((sub) => /^(commit-tree|update-ref)/.test(sub))).toBe(false);
  });

  it('an unreadable tree is refused, never a guess', async () => {
    const executor = new FakeExecutor();
    executor.world.worktreeTree = null;
    expect(await new LaneEditSaveAdapter(executor).saveLaneEdits(request())).toEqual({
      outcome: 'refused', reason: 'unreadable-tree',
    });
    expect(executor.subcommands().some((sub) => /^(commit-tree|update-ref)/.test(sub))).toBe(false);
    expect(executor.calls.filter((call) => call.argv[0] === 'rm')).toHaveLength(2);
  });

  it('a lost update-ref race re-reads the ref and reports the concurrent save', async () => {
    const executor = new FakeExecutor();
    executor.world.updateRefFailsOnce = { commit: 'f'.repeat(40), tree: TREE };
    expect(await new LaneEditSaveAdapter(executor).saveLaneEdits(request())).toEqual({
      outcome: 'already-saved', saveRef: SAVE_REF, commitId: 'f'.repeat(40), treeDigest: TREE, worktreeTreeDigest: TREE,
    });
    const conflict = new FakeExecutor();
    conflict.world.updateRefFailsOnce = { commit: 'f'.repeat(40), tree: OTHER_TREE };
    expect(await new LaneEditSaveAdapter(conflict).saveLaneEdits(request())).toEqual({
      outcome: 'refused', reason: 'save-ref-conflict',
    });
    const gone = new FakeExecutor();
    gone.world.updateRefFailsOnce = null;
    expect(await new LaneEditSaveAdapter(gone).saveLaneEdits(request())).toEqual({
      outcome: 'refused', reason: 'unreadable-tree',
    });
    expect(gone.world.refWritten).toBe(false);
  });

  it('no recorded host is refused as no-recorded-host', async () => {
    const executor = new FakeExecutor();
    const adapter = new LaneEditSaveAdapter(executor);
    expect(await adapter.saveLaneEdits(request({ recordedHost: null }))).toEqual({ outcome: 'refused', reason: 'no-recorded-host' });
    expect(await adapter.saveLaneEdits(request({ recordedHost: host(' ') }))).toEqual({ outcome: 'refused', reason: 'no-recorded-host' });
    expect(executor.calls).toHaveLength(0);
  });

  it('a host that cannot be routed is refused as host-not-routable', async () => {
    const executor = new FakeExecutor();
    const adapter = new LaneEditSaveAdapter(executor, { executorForRecordedHost: () => null });
    expect(await adapter.saveLaneEdits(request())).toEqual({ outcome: 'refused', reason: 'host-not-routable' });
    expect(executor.calls).toHaveLength(0);
    const routed = new FakeExecutor();
    const viaHost = new LaneEditSaveAdapter(executor, { executorForRecordedHost: () => routed });
    expect((await viaHost.saveLaneEdits(request())).outcome).toBe('saved');
    expect(executor.calls).toHaveLength(0);
    expect(routed.calls.length).toBeGreaterThan(0);
  });

  it('a worktree outside the clone is refused', async () => {
    const executor = new FakeExecutor();
    executor.world.worktreeCommon = '/srv/other/clone/.git';
    expect(await new LaneEditSaveAdapter(executor).saveLaneEdits(request())).toEqual({
      outcome: 'refused', reason: 'worktree-not-in-clone',
    });
    expect(executor.subcommands().some((sub) => /^(read-tree|add|write-tree|commit-tree|update-ref)/.test(sub))).toBe(false);
  });

  it('every git command carries the hardening args and the network guards', async () => {
    const executor = new FakeExecutor();
    await new LaneEditSaveAdapter(executor).saveLaneEdits(request());
    const gits = executor.calls.filter((call) => isGit(call.argv));
    expect(gits.length).toBeGreaterThan(8);
    for (const { argv } of gits) {
      const git = argv.indexOf('git');
      expect(argv.slice(1, 3)).toEqual(['-u', 'GIT_CONFIG']);
      expect(argv.slice(3, 6)).toEqual(['GIT_ALLOW_PROTOCOL=none', 'GIT_NO_LAZY_FETCH=1', 'GIT_TERMINAL_PROMPT=0']);
      expect(argv).toContain('GIT_ATTR_NOSYSTEM=1');
      for (const guard of ['GIT_CONFIG_NOSYSTEM=1', 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_SYSTEM=/dev/null', 'GIT_CONFIG_COUNT=0', 'GIT_CONFIG_PARAMETERS=']) {
        expect(argv.slice(0, git)).toContain(guard);
      }
      const config = argv.slice(git + 1, argv.indexOf('-C'));
      for (const setting of [
        'color.ui=never', 'core.quotePath=false', 'diff.mnemonicPrefix=false', 'diff.noprefix=false',
        'core.fsmonitor=false', 'core.hooksPath=/dev/null', 'core.attributesFile=/dev/null', 'diff.submodule=short',
        'diff.external=', 'filter.lfs.clean=', 'filter.lfs.smudge=', 'filter.lfs.process=', 'filter.lfs.required=false',
      ]) {
        expect(config).toContain(setting);
      }
    }
  });

  it('no command pushes, fetches, checks out, resets, commits on a branch or runs a hook', async () => {
    const executor = new FakeExecutor();
    await new LaneEditSaveAdapter(executor).saveLaneEdits(request());
    const verbs = executor.subcommands().map((sub) => sub.split(' ')[0]);
    for (const banned of ['push', 'fetch', 'pull', 'checkout', 'switch', 'reset', 'commit', 'remote', 'credential', 'clean', 'rm', 'gc']) {
      expect(verbs).not.toContain(banned);
    }
    expect(new Set(verbs)).toEqual(new Set(['--version', 'rev-parse', 'read-tree', 'add', 'write-tree', 'commit-tree', 'update-ref', 'hash-object', 'config']));
    expect(executor.calls.every((call) => call.argv.every((word) => !/--no-verify|credential|push/.test(word)))).toBe(true);
  });

  it('a command that times out is reported as unknown and leaves no ref', async () => {
    const executor = new FakeExecutor();
    executor.world.timeoutOn = 'add -A';
    const result = await new LaneEditSaveAdapter(executor).saveLaneEdits(request());
    expect(result.outcome).toBe('unknown');
    expect(executor.world.refWritten).toBe(false);
    expect(executor.calls.filter((call) => call.argv[0] === 'rm')).toHaveLength(2);
    const late = new FakeExecutor();
    late.world.timeoutOn = 'update-ref';
    expect((await new LaneEditSaveAdapter(late).saveLaneEdits(request())).outcome).toBe('unknown');
    expect(late.world.refWritten).toBe(false);
  });

  it('every command sets a timeout and a max output size', async () => {
    const executor = new FakeExecutor();
    await new LaneEditSaveAdapter(executor).saveLaneEdits(request());
    expect(executor.calls.length).toBeGreaterThan(8);
    for (const call of executor.calls) {
      expect(call.options?.timeoutMs).toBe(20_000);
      expect(call.options?.maxBufferBytes).toBe(8 * 1024 * 1024);
    }
  });

  it('the commit message carries no path and no secret-shaped text', async () => {
    const executor = new FakeExecutor();
    const adapter = new LaneEditSaveAdapter(executor);
    for (const commitMessage of ['saved /srv/lanes/clone', `token ${'A1b2'.repeat(10)}`, '', 'a\nb']) {
      expect(await adapter.saveLaneEdits(request({ commitMessage }))).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
    expect(executor.calls).toHaveLength(0);
    await adapter.saveLaneEdits(request());
    const message = executor.subcommands().find((sub) => sub.startsWith('commit-tree')) ?? '';
    expect(message.split(' -m ')[1]).toBe('fleet-v2 lane save abcdef012345');
  });

  it('the temp index file is removed after the save and each save uses its own index', async () => {
    const executor = new FakeExecutor();
    await new LaneEditSaveAdapter(executor).saveLaneEdits(request());
    await new LaneEditSaveAdapter(executor).saveLaneEdits(request());
    const removals = executor.calls
      .map((call, order) => ({ argv: call.argv, order }))
      .filter(({ argv }) => argv[0] === 'rm');
    const indexes = removals.map(({ argv }) => argv[3] ?? '');
    expect(indexes).toHaveLength(4);
    for (const index of indexes) {
      expect(index).toMatch(/^\/srv\/lanes\/clone\/\.git\/fleet-save-index-[0-9a-f]+$/);
    }
    expect(new Set(indexes).size).toBe(2);
    expect(removals[0]?.argv).toEqual(removals[1]?.argv);
    expect(removals[2]?.argv).toEqual(removals[3]?.argv);
    const lastSeed = executor.calls.findIndex((call) => call.argv.join(' ').includes(' read-tree'));
    const writeTree = executor.calls.findIndex((call) => call.argv.join(' ').includes(' write-tree'));
    expect(removals[0]?.order).toBeLessThan(lastSeed);
    expect(removals[1]?.order).toBeGreaterThan(writeTree);
    expect(removals[1]?.order).toBeLessThan(executor.calls.findIndex((call) => call.argv.join(' ').includes(' commit-tree')));
  });

  it('an invalid save ref is refused', async () => {
    const executor = new FakeExecutor();
    const adapter = new LaneEditSaveAdapter(executor);
    for (const saveRef of ['refs/heads/main', 'refs/fleet/saved/', 'refs/fleet/saved/../heads/main', 'refs/fleet/saved/a b', 'refs/fleet/saved/x.lock', 'HEAD']) {
      expect(await adapter.saveLaneEdits(request({ saveRef }))).toEqual({ outcome: 'refused', reason: 'save-ref-invalid' });
    }
    expect(executor.calls).toHaveLength(0);
  });

  it('the empty tree is written with hash-object -w before staging', async () => {
    const executor = new FakeExecutor();
    await new LaneEditSaveAdapter(executor).saveLaneEdits(request());
    expect(executor.subcommands().filter((sub) => sub.startsWith('hash-object'))).toEqual([
      'hash-object -w -t tree /dev/null',
    ]);
  });

  it('an info/attributes file that selects a clean filter refuses the save', async () => {
    const executor = new FakeExecutor();
    executor.world.infoAttributes = 'filter';
    expect(await new LaneEditSaveAdapter(executor).saveLaneEdits(request())).toEqual({
      outcome: 'refused', reason: 'unreadable-tree',
    });
    const envSubs = executor.subcommands();
    for (const verb of ['add', 'write-tree', 'commit-tree', 'update-ref']) {
      expect(envSubs.some((sub) => sub.startsWith(verb))).toBe(false);
    }
  });

  it.each(['quoted-filter', 'enoent-midline'] as const)('a %s attributes file refuses the save before any staging', async (state) => {
    const executor = new FakeExecutor();
    executor.world.infoAttributes = state;
    expect(await new LaneEditSaveAdapter(executor).saveLaneEdits(request())).toEqual({ outcome: 'refused', reason: 'unreadable-tree' });
    expect(executor.subcommands().some((sub) => sub.startsWith('add'))).toBe(false);
  });

  it.each(['defined', 'exit-128'] as const)('a %s filter-config probe refuses the save before add', async (state) => {
    const executor = new FakeExecutor();
    executor.world.filterConfig = state;
    expect(await new LaneEditSaveAdapter(executor).saveLaneEdits(request())).toEqual({ outcome: 'refused', reason: 'unreadable-tree' });
    const subs = executor.subcommands();
    for (const verb of ['add', 'write-tree', 'commit-tree', 'update-ref']) expect(subs.some((sub) => sub.startsWith(verb))).toBe(false);
  });

  it.each(['none', 'command-only', 'exit-0-empty'] as const)('a %s filter-config probe lets the save proceed', async (state) => {
    const executor = new FakeExecutor();
    executor.world.filterConfig = state;
    expect(await new LaneEditSaveAdapter(executor).saveLaneEdits(request())).toMatchObject({ outcome: 'saved' });
  });

  it.each(['probe-error', 'unsearchable'] as const)('a %s attributes probe refuses the save before any staging', async (state) => {
    const executor = new FakeExecutor();
    executor.world.infoAttributes = state;
    expect(await new LaneEditSaveAdapter(executor).saveLaneEdits(request())).toEqual({
      outcome: 'refused', reason: 'unreadable-tree',
    });
    const envSubs = executor.subcommands();
    for (const verb of ['add', 'write-tree', 'commit-tree', 'update-ref']) {
      expect(envSubs.some((sub) => sub.startsWith(verb))).toBe(false);
    }
  });

  it('the attributes check uses argv commands only and runs immediately before add', async () => {
    const executor = new FakeExecutor();
    await new LaneEditSaveAdapter(executor).saveLaneEdits(request());
    expect(executor.calls.some((call) => call.argv[0] === 'sh' || call.argv.includes('-c') && call.argv[0] !== 'env')).toBe(false);
    const order = executor.calls.map((call) => call.argv.join(' '));
    const cat = order.findIndex((line) => line.includes(' cat '));
    const add = order.findIndex((line) => line.includes(' add -A'));
    expect(cat).toBeGreaterThan(-1);
    const config = order.findIndex((line) => line.includes(' config --show-scope --get-regexp '));
    expect(config).toBeGreaterThan(cat);
    expect(order[add - 1]).toContain(' config --show-scope --get-regexp ');
    expect(order[config]).toContain('GIT_CONFIG_NOSYSTEM=1');
    expect(order[config]).toContain('GIT_CONFIG_GLOBAL=/dev/null');
    expect(order[config]).toContain('GIT_ALLOW_PROTOCOL=none');
    expect(order[config]).toContain(`-C ${WORKTREE}`);
    expect(order[config]).toContain('core.hooksPath=/dev/null');
    expect(cat).toBeLessThan(add);
    expect(executor.subcommands()).toContain('rev-parse --path-format=absolute --git-path info/attributes');
  });

  it.each(['git version 2.39.5', 'git version 1.9.0', 'git version garbage', ''])('git %j (before 2.40 or unparseable) refuses the save before any staging', async (gitVersion) => {
    const executor = new FakeExecutor();
    executor.world.gitVersion = gitVersion;
    expect(await new LaneEditSaveAdapter(executor).saveLaneEdits(request())).toEqual({ outcome: 'refused', reason: 'unreadable-tree' });
    const envSubs = executor.subcommands();
    for (const verb of ['read-tree', 'add', 'write-tree', 'commit-tree', 'update-ref']) {
      expect(envSubs.some((sub) => sub.startsWith(verb))).toBe(false);
    }
  });

  it.each(['git version 2.40.0', 'git version 2.50.1 (Apple Git-155)', 'git version 3.0.0'])('git %j is new enough', async (gitVersion) => {
    const executor = new FakeExecutor();
    executor.world.gitVersion = gitVersion;
    expect(await new LaneEditSaveAdapter(executor).saveLaneEdits(request())).toMatchObject({ outcome: 'saved' });
  });

  it('a confirmed-absent attributes file proceeds to the save', async () => {
    const executor = new FakeExecutor();
    executor.world.infoAttributes = 'absent';
    expect(await new LaneEditSaveAdapter(executor).saveLaneEdits(request())).toMatchObject({ outcome: 'saved' });
  });

  it('an info/attributes file without a clean filter does not refuse the save', async () => {
    const executor = new FakeExecutor();
    executor.world.infoAttributes = 'harmless';
    expect(await new LaneEditSaveAdapter(executor).saveLaneEdits(request())).toMatchObject({ outcome: 'saved' });
  });

  describe('against a real repository with a linked worktree', () => {
    const git = (cwd: string, args: string[]): string =>
      execFileSync('git', args, {
        cwd, encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
      }).trim();
    let skipReason: string | null = null;
    try {
      const version = execFileSync('git', ['--version'], { encoding: 'utf8' });
      const match = /^git version (\d+)\.(\d+)/.exec(version);
      if (match === null || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 40)) {
        skipReason = `git >= 2.40 is required (GIT_ATTR_SOURCE); found ${version.trim()}`;
      }
    } catch {
      skipReason = 'no git binary is available on the host running the tests';
    }
    const needGit = (context: TestContext): void => {
      if (skipReason !== null) context.skip(skipReason);
    };
    const setup = (): { clone: string; worktree: string } => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-edit-save-')));
      const clone = path.join(root, 'clone');
      fs.mkdirSync(clone);
      git(clone, ['init', '-q', '-b', 'main']);
      fs.writeFileSync(path.join(clone, 'a.txt'), 'one\n');
      git(clone, ['add', '.']);
      git(clone, ['commit', '-q', '-m', 'init']);
      const worktree = path.join(root, 'wt');
      git(clone, ['worktree', 'add', '-q', '-b', 'lane', worktree]);
      fs.writeFileSync(path.join(worktree, 'b.txt'), 'two\n');
      return { clone, worktree };
    };
    const realRequest = (clone: string, worktree: string): LaneEditSaveRequest => request({ clonePath: clone, worktreePath: worktree });

    // Skipped, with the reason stated, when git is missing or older than 2.40.
    it('saves a linked worktree when no attributes file and no filter config exist (control)', async (context) => {
      needGit(context);
      const { clone, worktree } = setup();
      const result = await new LaneEditSaveAdapter(new LocalExecutor()).saveLaneEdits(realRequest(clone, worktree));
      expect(result).toMatchObject({ outcome: 'saved' });
    });

    it('refuses a linked worktree when the COMMON info/attributes assigns a filter', async (context) => {
      needGit(context);
      const { clone, worktree } = setup();
      fs.mkdirSync(path.join(clone, '.git', 'info'), { recursive: true });
      fs.writeFileSync(path.join(clone, '.git', 'info', 'attributes'), '* filter=x\n');
      const marker = path.join(path.dirname(clone), 'filter-ran');
      git(clone, ['config', 'filter.x.clean', `touch ${marker}; cat`]);
      const result = await new LaneEditSaveAdapter(new LocalExecutor()).saveLaneEdits(realRequest(clone, worktree));
      expect(result).toEqual({ outcome: 'refused', reason: 'unreadable-tree' });
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('refuses a filter glued to a C-quoted pattern (git reads "*"filter=x as a filter)', async (context) => {
      needGit(context);
      const { clone, worktree } = setup();
      fs.mkdirSync(path.join(clone, '.git', 'info'), { recursive: true });
      fs.writeFileSync(path.join(clone, '.git', 'info', 'attributes'), '"*"filter=x\n');
      const marker = path.join(path.dirname(clone), 'filter-ran');
      git(clone, ['config', 'filter.x.clean', `touch ${marker}; cat`]);
      const result = await new LaneEditSaveAdapter(new LocalExecutor()).saveLaneEdits(realRequest(clone, worktree));
      expect(result).toEqual({ outcome: 'refused', reason: 'unreadable-tree' });
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('an inherited GIT_CONFIG_COUNT filter driver is neutralised: git never sees it, so it never runs', async (context) => {
      needGit(context);
      const { clone, worktree } = setup();
      const marker = path.join(path.dirname(clone), 'filter-ran');
      const filterProbes: string[] = [];
      const local = new LocalExecutor();
      const recording: CommandExecutorPort = {
        async run(argv, options) {
          // The executor's environment carries a command-scope filter driver, as an ssh executor's login shell could.
          const inherited = {
            ...process.env,
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'filter.x.clean',
            GIT_CONFIG_VALUE_0: `touch ${marker}; cat`,
          } as Record<string, string>;
          const result = await local.run(argv, { ...options, env: inherited });
          if (argv.includes('--get-regexp')) filterProbes.push(result.stdout);
          return result;
        },
      };
      const result = await new LaneEditSaveAdapter(recording).saveLaneEdits(realRequest(clone, worktree));
      expect(result).toMatchObject({ outcome: 'saved' });
      expect(filterProbes.length).toBe(1);
      expect(/filter\.x\./.test(filterProbes.join(''))).toBe(false);
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('an inherited legacy GIT_CONFIG file cannot hide a repository-config filter driver from the probe', async (context) => {
      needGit(context);
      const { clone, worktree } = setup();
      const marker = path.join(path.dirname(clone), 'filter-ran');
      const emptyConfig = path.join(path.dirname(clone), 'empty-gitconfig');
      fs.writeFileSync(emptyConfig, '');
      git(clone, ['config', 'filter.x.clean', `touch ${marker}; cat`]);
      const local = new LocalExecutor();
      const wrapped: CommandExecutorPort = {
        run: (argv, options) => local.run(argv, { ...options, env: { ...process.env, GIT_CONFIG: emptyConfig } as Record<string, string> }),
      };
      const result = await new LaneEditSaveAdapter(wrapped).saveLaneEdits(realRequest(clone, worktree));
      expect(result).toEqual({ outcome: 'refused', reason: 'unreadable-tree' });
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('refuses when a filter driver is defined in the repository config, even with no attributes file', async (context) => {
      needGit(context);
      const { clone, worktree } = setup();
      const marker = path.join(path.dirname(clone), 'filter-ran');
      git(clone, ['config', 'filter.x.clean', `touch ${marker}; cat`]);
      const result = await new LaneEditSaveAdapter(new LocalExecutor()).saveLaneEdits(realRequest(clone, worktree));
      expect(result).toEqual({ outcome: 'refused', reason: 'unreadable-tree' });
      expect(fs.existsSync(marker)).toBe(false);
    });
  });
});
