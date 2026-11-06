import { describe, expect, it } from 'vitest';

import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { LaneEditSaveRequest } from '../../../application/ports/out/LaneEditSavePort.out-port.js';
import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';
import { LaneEditSaveAdapter } from '../LaneEditSaveAdapter.adapter.js';

const CLONE = '/srv/lanes/clone';
const WORKTREE = '/srv/lanes/worktrees/lane-1';
const SAVE_REF = 'refs/fleet/saved/abcdef012345-lane-1';
const TREE = 'a'.repeat(40);
const OTHER_TREE = 'c'.repeat(40);
const HEAD = 'd'.repeat(40);
const COMMIT = 'e'.repeat(40);
const EMPTY_TREE = '1'.repeat(40);

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
  infoAttributes: 'absent' | 'harmless' | 'filter' | 'probe-error' | 'unsearchable';
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
    infoAttributes: 'absent',
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
    if (argv[0] === 'sh' && argv[1] === '-c') {
      // Exit codes of the adapter's probe script: 10 filter, 11 harmless, 20 confirmed absent, else unknown.
      const codes = { absent: 20, harmless: 11, filter: 10, 'probe-error': 2, unsearchable: 21 } as const;
      return exit(codes[this.world.infoAttributes]);
    }
    if (argv[0] === 'rm') return ok();
    const inClone = argv[argv.indexOf('-C') + 1] === CLONE;
    if (sub.startsWith('rev-parse --path-format=absolute --git-common-dir')) {
      return ok(inClone ? this.world.cloneCommon : this.world.worktreeCommon);
    }
    if (sub === 'rev-parse --absolute-git-dir') return ok(this.world.worktreeCommon);
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
    return this.calls.filter((call) => call.argv[0] === 'env').map((call) => call.argv.slice(call.argv.indexOf('-C') + 2).join(' '));
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
    for (const call of executor.calls.filter((entry) => entry.argv[0] === 'env')) {
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
    const gits = executor.calls.filter((call) => call.argv[0] === 'env');
    expect(gits.length).toBeGreaterThan(8);
    for (const { argv } of gits) {
      const git = argv.indexOf('git');
      expect(argv.slice(1, 4)).toEqual(['GIT_ALLOW_PROTOCOL=none', 'GIT_NO_LAZY_FETCH=1', 'GIT_TERMINAL_PROMPT=0']);
      expect(argv).toContain('GIT_ATTR_NOSYSTEM=1');
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
    expect(new Set(verbs)).toEqual(new Set(['rev-parse', 'read-tree', 'add', 'write-tree', 'commit-tree', 'update-ref', 'hash-object']));
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
    for (const verb of ['read-tree', 'add', 'write-tree', 'commit-tree', 'update-ref']) {
      expect(envSubs.some((sub) => sub.startsWith(verb))).toBe(false);
    }
  });

  it.each(['probe-error', 'unsearchable'] as const)('a %s attributes probe refuses the save before any staging', async (state) => {
    const executor = new FakeExecutor();
    executor.world.infoAttributes = state;
    expect(await new LaneEditSaveAdapter(executor).saveLaneEdits(request())).toEqual({
      outcome: 'refused', reason: 'unreadable-tree',
    });
    const envSubs = executor.subcommands();
    for (const verb of ['read-tree', 'add', 'write-tree', 'commit-tree', 'update-ref']) {
      expect(envSubs.some((sub) => sub.startsWith(verb))).toBe(false);
    }
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
});
