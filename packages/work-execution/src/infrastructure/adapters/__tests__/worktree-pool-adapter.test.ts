// Lane KS4b: warm worktree pool adapter tests, against an in-memory host.
import { describe, expect, it } from 'vitest';

import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';
import { WorktreePoolAdapter } from '../WorktreePoolAdapter.adapter.js';

const BASE = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const REPO = '/srv/repo';
const ROOT = '/srv/pool';
const POOL = `${ROOT}/proj`;
const CLAIMS = `${POOL}/.claims`;
const HOST: AttemptRunnerRecord = {
  kind: 'opencode', remotePort: 4001, host: 'h', hostName: 'h', agent: 'a', model: 'm', variant: null,
};

const OK = (stdout = ''): CommandRunResult => ({ exitCode: 0, signal: null, stdout, stderr: '' });
const FAIL = (stderr = 'nope'): CommandRunResult => ({ exitCode: 1, signal: null, stdout: '', stderr });

interface Call { readonly argv: readonly string[]; readonly options: CommandRunOptions | undefined }

/** A host with git worktrees, claim links and a scripted failure hook. */
class FakeHost implements CommandExecutorPort {
  readonly calls: Call[] = [];
  readonly worktrees = new Map<string, { head: string; dirty: boolean; prunable?: boolean }>();
  readonly claims = new Map<string, string>();
  readonly stale = new Set<string>();
  readonly commits = new Set<string>([BASE, NEXT]);
  claimsDir = true;
  filters = false;
  clock = 0;
  /** Return a result to override a command, keyed on its joined tail. */
  override: ((tail: string[]) => CommandRunResult | undefined) | undefined;
  tickPerCall = 0;

  add(n: number, head = BASE, dirty = false): void {
    this.worktrees.set(`${POOL}/w${n}`, { head, dirty });
  }

  async run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ argv: [...argv], options });
    this.clock += this.tickPerCall;
    await Promise.resolve();
    let words = [...argv];
    let dir = '';
    let isGit = false;
    if (words[0] === 'env') {
      const c = words.indexOf('-C');
      dir = words[c + 1] ?? '';
      words = words.slice(c + 2);
      isGit = true;
    }
    const hooked = this.override?.(words);
    if (hooked !== undefined) return hooked;
    if (isGit) return this.git(dir, words);
    const [cmd, ...a] = words;
    if (cmd === 'test') {
      if (a[0] === '-L') return this.claims.has(a[1] ?? '') ? OK() : FAIL();
      return this.claimsDir ? OK() : FAIL();
    }
    if (cmd === 'mkdir') { this.claimsDir = true; return OK(); }
    if (cmd === 'ls') {
      return OK([...this.claims.keys()].map((k) => k.slice(CLAIMS.length + 1)).join('\n'));
    }
    if (cmd === 'readlink') {
      const owner = this.claims.get(a[1] ?? '');
      return owner === undefined ? FAIL() : OK(`${owner}\n`);
    }
    if (cmd === 'ln') {
      const link = a[3] ?? '';
      if (this.claims.has(link)) return FAIL('exists');
      this.claims.set(link, a[2] ?? '');
      return OK();
    }
    if (cmd === 'rm') {
      if (a[0] === '-f') this.claims.delete(a[2] ?? '');
      return OK();
    }
    if (cmd === 'find') {
      return OK([...this.stale].map((s) => `${CLAIMS}/${s}`).join('\n'));
    }
    return FAIL('unscripted');
  }

  private git(dir: string, a: string[]): CommandRunResult {
    const wt = this.worktrees.get(dir);
    switch (a[0]) {
      case 'worktree':
        if (a[1] === 'list') {
          const blocks = [`worktree ${REPO}\nHEAD ${BASE}\nbranch refs/heads/main`];
          for (const [p, w] of this.worktrees) {
            blocks.push(`worktree ${p}\nHEAD ${w.head}\ndetached${w.prunable ? '\nprunable gone' : ''}`);
          }
          return OK(blocks.join('\n\n') + '\n');
        }
        if (a[1] === 'add') {
          if (this.worktrees.has(a[3] ?? '')) return FAIL('exists');
          this.worktrees.set(a[3] ?? '', { head: a[4] ?? '', dirty: false });
          return OK();
        }
        if (a[1] === 'remove') { this.worktrees.delete(a[3] ?? ''); return OK(); }
        if (a[1] === 'prune') {
          for (const [p, w] of [...this.worktrees]) if (w.prunable) this.worktrees.delete(p);
          return OK();
        }
        return FAIL();
      case 'rev-parse': return wt === undefined ? FAIL() : OK(`${wt.head}\n`);
      case 'status': return wt === undefined ? FAIL() : OK(wt.dirty ? ' M file\n' : '');
      case 'config': return this.filters ? OK('filter.x.smudge cmd\n') : FAIL();
      case 'cat-file': return this.commits.has((a[2] ?? '').split('^')[0] ?? '') ? OK() : FAIL();
      case 'checkout': if (wt) { wt.head = a[3] ?? wt.head; } return wt ? OK() : FAIL();
      case 'clean': if (wt) wt.dirty = false; return wt ? OK() : FAIL();
      default: return FAIL();
    }
  }
}

function make(host: FakeHost, extra: Record<string, unknown> = {}) {
  return new WorktreePoolAdapter({
    executorFor: () => host,
    projects: { proj: { repositoryPath: REPO, poolRoot: ROOT, targetSize: 2 } },
    now: () => host.clock,
    ...extra,
  });
}

const take = (adapter: WorktreePoolAdapter, runId: string | null = 'run-1', baseCommit = BASE) =>
  adapter.take({ projectId: 'proj', baseCommit, runId, recordedHost: HOST });

describe('WorktreePoolAdapter take', () => {
  it('takes a clean warm worktree at the base and records it as taken', async () => {
    const host = new FakeHost();
    host.add(1);
    const result = await take(make(host));
    expect(result).toMatchObject({ outcome: 'taken', entry: { entryId: 'proj#1', state: 'taken', takenByRunId: 'run-1', worktreePath: `${POOL}/w1` } });
    expect(host.claims.size).toBe(1);
  });

  it('is empty when nothing warm sits at the base, or the worktree is dirty', async () => {
    const host = new FakeHost();
    host.add(1, NEXT);
    host.add(2, BASE, true);
    expect(await take(make(host))).toEqual({ outcome: 'empty' });
    expect(host.claims.size).toBe(0);
  });

  it('never hands one worktree to two claimants', async () => {
    const host = new FakeHost();
    host.add(1);
    host.add(2);
    const adapter = make(host);
    const results = await Promise.all([take(adapter, 'run-a'), take(adapter, 'run-b'), take(adapter, 'run-c')]);
    const taken = results.filter((r) => r.outcome === 'taken');
    const paths = taken.map((r) => (r.outcome === 'taken' ? r.entry.worktreePath : ''));
    expect(taken).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
    expect(results.filter((r) => r.outcome === 'empty')).toHaveLength(1);
  });

  it('gives the same entry back to the same run, even after a crash and a new adapter', async () => {
    const host = new FakeHost();
    host.add(1);
    const first = await take(make(host), 'run-1');
    host.worktrees.get(`${POOL}/w1`)!.head = NEXT; // the lane moved on
    const again = await take(make(host), 'run-1');
    // The same entry, reported at the commit the worktree really sits at now.
    expect(again).toMatchObject({ outcome: 'taken', entry: { entryId: 'proj#1', takenByRunId: 'run-1', baseCommit: NEXT } });
    expect(first).toMatchObject({ outcome: 'taken', entry: { entryId: 'proj#1', baseCommit: BASE } });
    expect(host.claims.size).toBe(1);
    expect(await take(make(host), 'run-2', NEXT)).toEqual({ outcome: 'empty' });
  });

  it('does not hand a slot back to its run while a reset holds it', async () => {
    const host = new FakeHost();
    host.add(1);
    const adapter = make(host);
    await take(adapter, 'run-1');
    host.claims.set(`${CLAIMS}/w1.reset`, 'reset');
    expect(await take(adapter, 'run-1', NEXT)).toEqual({ outcome: 'empty' });
    host.claims.delete(`${CLAIMS}/w1.reset`);
    expect((await take(adapter, 'run-1')).outcome).toBe('taken');
  });

  it('keeps unknown unknown: unreadable claims, listings and status never read as free', async () => {
    const host = new FakeHost();
    host.add(1);
    host.override = (t) => (t[0] === 'ls' ? { exitCode: null, signal: null, stdout: '', stderr: '', error: 'x' } : undefined);
    host.claims.set(`${CLAIMS}/w1`, 'run-other');
    expect(await take(make(host))).toEqual({ outcome: 'empty' });
    host.override = (t) => (t[0] === 'readlink' ? FAIL() : undefined);
    expect(await take(make(host))).toEqual({ outcome: 'empty' }); // claimed by an unreadable owner

    const host2 = new FakeHost();
    host2.add(1);
    host2.override = (t) => (t[1] === 'list' ? { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '' } : undefined);
    expect(await take(make(host2))).toEqual({ outcome: 'empty' });
    expect(host2.claims.size).toBe(0);

    const host3 = new FakeHost();
    host3.add(1);
    host3.override = (t) => (t[0] === 'status' ? { exitCode: null, signal: null, stdout: '', stderr: '', error: 'timed out' } : undefined);
    expect(await take(make(host3))).toEqual({ outcome: 'empty' });
  });

  it('keeps the claim when cleanliness cannot be read after claiming', async () => {
    const host = new FakeHost();
    host.add(1);
    host.override = (t) => (t[0] === 'status' ? { exitCode: null, signal: null, stdout: '', stderr: '', error: 'x' } : undefined);
    const adapter = make(host);
    expect(await take(adapter)).toEqual({ outcome: 'empty' });
    expect(host.claims.size).toBe(1);
    host.override = undefined;
    expect(await take(adapter, 'run-2')).toEqual({ outcome: 'empty' });
  });

  it('does not return a retaken slot whose claim moved after the snapshot', async () => {
    const host = new FakeHost();
    host.add(1);
    const adapter = make(host);
    await take(adapter, 'run-1');
    let reads = 0;
    host.override = (t) => {
      if (t[0] === 'readlink' && (reads += 1) === 2) host.claims.delete(`${CLAIMS}/w1`);
      return undefined;
    };
    expect(await take(adapter, 'run-1')).toEqual({ outcome: 'empty' });
  });

  it('skips a prunable worktree', async () => {
    const host = new FakeHost();
    host.worktrees.set(`${POOL}/w1`, { head: BASE, dirty: false, prunable: true });
    expect(await take(make(host))).toEqual({ outcome: 'empty' });
  });

  it('never throws on runtime input and refuses with a typed reason', async () => {
    const host = new FakeHost();
    const adapter = make(host);
    const bad: unknown[] = [
      null, undefined, 7, 'x', [], {}, { projectId: 'proj' },
      { projectId: 'proj', baseCommit: 'zz', recordedHost: HOST },
      { projectId: '../x', baseCommit: BASE, recordedHost: HOST },
      { projectId: 'nope', baseCommit: BASE, recordedHost: HOST },
      { projectId: 'proj', baseCommit: BASE, recordedHost: null },
      { projectId: 'proj', baseCommit: BASE, runId: 'r'.repeat(300), recordedHost: HOST },
      { projectId: 'proj', baseCommit: BASE, runId: 5, recordedHost: HOST },
      { projectId: 'toString', baseCommit: BASE, recordedHost: HOST },
    ];
    for (const request of bad) {
      expect(await adapter.take(request as never)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
      expect((await adapter.resetToBase(request as never)).outcome).toBe('refused');
      expect((await adapter.refillAfterMerge(request as never)).outcome).toBe('refused');
    }
    const throwing = new WorktreePoolAdapter({
      executorFor: () => ({ run: () => { throw new Error('boom'); } }),
      projects: { proj: { repositoryPath: REPO, poolRoot: ROOT } },
    });
    expect(await take(throwing)).toEqual({ outcome: 'empty' });
    expect((await throwing.refillAfterMerge({ projectId: 'proj', mergedBaseCommit: BASE, recordedHost: HOST })).outcome).toBe('unknown');
    const noHost = new WorktreePoolAdapter({ executorFor: () => { throw new Error('x'); }, projects: {} });
    expect((await take(noHost)).outcome).toBe('refused');
  });

  it('refuses a host the executor resolver does not confirm', async () => {
    const adapter = new WorktreePoolAdapter({ executorFor: () => null, projects: { proj: { repositoryPath: REPO, poolRoot: ROOT } } });
    expect(await take(adapter)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
  });

  it('refuses unsafe configured paths', async () => {
    for (const poolRoot of ['rel', '/a/../b', '/a//b', '/a/b/', '/a\\b']) {
      const adapter = new WorktreePoolAdapter({ executorFor: () => new FakeHost(), projects: { proj: { repositoryPath: REPO, poolRoot } } });
      expect((await take(adapter)).outcome).toBe('refused');
    }
  });
});

describe('WorktreePoolAdapter deadlines, git hardening, bounds and secrecy', () => {
  it('gives every call a timeout within the remaining budget and stops when it is spent', async () => {
    const host = new FakeHost();
    host.add(1);
    host.tickPerCall = 400;
    const adapter = make(host, { budgetsMs: { take: 1000 }, callTimeoutMs: 5000 });
    expect(await take(adapter)).toEqual({ outcome: 'empty' });
    for (const call of host.calls) {
      expect(call.options?.timeoutMs).toBeGreaterThan(0);
      expect(call.options?.timeoutMs).toBeLessThanOrEqual(1000);
    }
    expect(host.calls.length).toBeLessThan(6);
    expect(host.claims.size).toBe(0);
  });

  it('runs git with no network, no lazy fetch and hooks off', async () => {
    const host = new FakeHost();
    host.add(1);
    await take(make(host));
    await make(host).resetToBase({ worktreePath: `${POOL}/w1`, baseCommit: NEXT, recordedHost: HOST });
    const gits = host.calls.filter((c) => c.argv.includes('git'));
    expect(gits.length).toBeGreaterThan(3);
    for (const { argv } of gits) {
      expect(argv[0]).toBe('env');
      expect(argv).toContain('GIT_ALLOW_PROTOCOL=none');
      expect(argv).toContain('GIT_NO_LAZY_FETCH=1');
      expect(argv).toContain('core.hooksPath=/dev/null');
      expect(argv).toContain('protocol.allow=never');
      expect(argv.some((w) => ['fetch', 'pull', 'push', 'clone', 'remote'].includes(w))).toBe(false);
    }
  });

  it('echoes no command output, error text or credential path', async () => {
    const host = new FakeHost();
    host.add(1);
    host.override = (t) => (t[0] === 'status' ? FAIL('fatal: /home/u/.ssh/id_ed25519 ghp_abcdefghijklmnopqrstuvwxyz0123456789') : undefined);
    const results = [
      await take(make(host)),
      await make(host).resetToBase({ worktreePath: `${POOL}/w1`, baseCommit: BASE, recordedHost: HOST }),
      await make(host).refillAfterMerge({ projectId: 'proj', mergedBaseCommit: BASE, recordedHost: HOST }),
    ];
    const text = JSON.stringify(results);
    expect(text).not.toMatch(/ghp_|id_ed25519|fatal/);
  });

  it('bounds the pool: slots past the cap are ignored, the cap is clamped, listings are size-capped', async () => {
    const host = new FakeHost();
    host.add(3);
    const adapter = make(host, { maxEntries: 2 });
    expect(await take(adapter)).toEqual({ outcome: 'empty' });
    expect((await adapter.resetToBase({ worktreePath: `${POOL}/w3`, baseCommit: BASE, recordedHost: HOST })).outcome).toBe('refused');

    const huge = make(new FakeHost(), { maxEntries: 9999 });
    const empty = new FakeHost();
    const refilled = await make(empty, { maxEntries: 9999 }).refillAfterMerge({ projectId: 'proj', mergedBaseCommit: BASE, recordedHost: HOST });
    expect(refilled.outcome).toBe('refilled');
    expect(huge).toBeDefined();
    expect([...empty.worktrees.keys()].every((p) => Number(p.split('/w')[1]) <= 16)).toBe(true);
    for (const call of host.calls) expect(call.options?.maxBufferBytes).toBeLessThanOrEqual(1024 * 1024);
  });
});

describe('WorktreePoolAdapter resetToBase', () => {
  it('moves a taken worktree to the new base, clears residue and releases it warm', async () => {
    const host = new FakeHost();
    host.add(1);
    const adapter = make(host);
    await take(adapter);
    host.worktrees.get(`${POOL}/w1`)!.dirty = true;
    const result = await adapter.resetToBase({ worktreePath: `${POOL}/w1`, baseCommit: NEXT, recordedHost: HOST });
    expect(result).toMatchObject({ outcome: 'reset', entry: { state: 'warm', baseCommit: NEXT, takenByRunId: null } });
    expect(host.claims.size).toBe(0);
    expect(host.calls.some((c) => c.argv.includes('--') && c.argv.includes(`${POOL}/w1/.lane`))).toBe(true);
  });

  it('runs the prepare steps after the reset, and keeps the slot unserved when one fails', async () => {
    const host = new FakeHost();
    host.add(1);
    const adapter = new WorktreePoolAdapter({
      executorFor: () => host,
      projects: { proj: { repositoryPath: REPO, poolRoot: ROOT, prepare: [(p) => ['yarn', '--cwd', p, 'install']] } },
      now: () => host.clock,
    });
    host.override = (t) => (t[0] === 'yarn' ? FAIL('install failed with token abc') : undefined);
    const result = await adapter.resetToBase({ worktreePath: `${POOL}/w1`, baseCommit: NEXT, recordedHost: HOST });
    expect(result).toEqual({ outcome: 'unknown' });
    expect([...host.claims.values()][0]).toMatch(/^prepare-/);
    expect(await take(adapter, 'r', NEXT)).toEqual({ outcome: 'empty' });
  });

  it('refuses unknown, unlisted, being-prepared and unknown-commit trees without deleting anything', async () => {
    const host = new FakeHost();
    host.add(1);
    host.claims.set(`${CLAIMS}/w1`, 'prepare-x');
    const adapter = make(host);
    const reset = (worktreePath: string, baseCommit = NEXT) => adapter.resetToBase({ worktreePath, baseCommit, recordedHost: HOST });
    expect(await reset('/etc')).toEqual({ outcome: 'refused', reason: 'unknown-worktree' });
    expect(await reset(`${POOL}/w1/sub`)).toEqual({ outcome: 'refused', reason: 'unknown-worktree' });
    expect(await reset(`${POOL}/w2`)).toEqual({ outcome: 'refused', reason: 'not-accounted-for' });
    expect(await reset(`${POOL}/w1`)).toEqual({ outcome: 'refused', reason: 'not-accounted-for' });
    host.claims.clear();
    expect(await reset(`${POOL}/w1`, 'c'.repeat(40))).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(host.calls.some((c) => c.argv.includes('rm') && c.argv.includes('-rf') && !c.argv.some((w) => w.endsWith('/.lane')))).toBe(false);
  });

  it('lets only one reset run on a claimed slot, and never reaps a reset guard by age', async () => {
    const host = new FakeHost();
    host.add(1);
    const adapter = make(host);
    await take(adapter, 'run-1');
    const req = { worktreePath: `${POOL}/w1`, baseCommit: NEXT, recordedHost: HOST };
    const results = await Promise.all([adapter.resetToBase(req), adapter.resetToBase(req)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['reset', 'unknown']);
    host.claims.set(`${CLAIMS}/w1.reset`, 'reset');
    host.stale.add('w1.reset');
    await adapter.refillAfterMerge({ projectId: 'proj', mergedBaseCommit: NEXT, recordedHost: HOST });
    expect(host.claims.has(`${CLAIMS}/w1.reset`)).toBe(true);
    expect((await adapter.resetToBase(req)).outcome).toBe('unknown');
  });

  it('prunes a listed prunable worktree even when no claim exists, so its slot can be refilled', async () => {
    const host = new FakeHost();
    host.worktrees.set(`${POOL}/w1`, { head: BASE, dirty: false, prunable: true });
    const result = await make(host, { maxEntries: 1 }).refillAfterMerge({ projectId: 'proj', mergedBaseCommit: BASE, recordedHost: HOST });
    expect(result.outcome).toBe('refilled');
    expect(host.worktrees.get(`${POOL}/w1`)?.prunable).toBeUndefined();
  });

  it('does not rebuild a slot whose claim owner cannot be read', async () => {
    const host = new FakeHost();
    host.add(1);
    host.claims.set(`${CLAIMS}/w1`, 'run-x');
    host.override = (t) => (t[0] === 'readlink' ? FAIL() : undefined);
    const result = await make(host).resetToBase({ worktreePath: `${POOL}/w1`, baseCommit: NEXT, recordedHost: HOST });
    expect(result).toEqual({ outcome: 'refused', reason: 'not-accounted-for' });
    expect(host.worktrees.get(`${POOL}/w1`)!.head).toBe(BASE);
    expect(host.claims.size).toBe(1);
  });

  it('refill never rebuilds a slot a run claimed after its snapshot', async () => {
    const host = new FakeHost();
    host.add(1, BASE, true);
    const adapter = make(host, { maxEntries: 1 });
    let lists = 0;
    host.override = (t) => {
      if (t[0] === 'worktree' && t[1] === 'list' && (lists += 1) === 2) host.claims.set(`${CLAIMS}/w1`, 'run-late');
      return undefined;
    };
    const result = await adapter.refillAfterMerge({ projectId: 'proj', mergedBaseCommit: NEXT, recordedHost: HOST });
    expect(result.outcome).not.toBe('refilled');
    expect(host.worktrees.get(`${POOL}/w1`)!.head).toBe(BASE);
    expect(host.claims.get(`${CLAIMS}/w1`)).toBe('run-late');
  });

  it('clears ignored files too, keeping only node_modules', async () => {
    const host = new FakeHost();
    host.add(1);
    await make(host).resetToBase({ worktreePath: `${POOL}/w1`, baseCommit: NEXT, recordedHost: HOST });
    const clean = host.calls.find((c) => c.argv.includes('clean'));
    expect(clean?.argv.slice(clean.argv.indexOf('clean'))).toEqual(['clean', '-fdx', '-e', 'node_modules']);
  });

  it('reports unknown when the executor does not answer', async () => {
    const host = new FakeHost();
    host.add(1);
    host.override = (t) => (t[0] === 'checkout' ? { exitCode: null, signal: null, stdout: '', stderr: '', error: 'timeout' } : undefined);
    const result = await make(host).resetToBase({ worktreePath: `${POOL}/w1`, baseCommit: NEXT, recordedHost: HOST });
    expect(result).toEqual({ outcome: 'unknown' });
  });
});

describe('WorktreePoolAdapter refillAfterMerge', () => {
  it('creates warm entries up to the target at the merged base and is idempotent', async () => {
    const host = new FakeHost();
    const adapter = make(host);
    const first = await adapter.refillAfterMerge({ projectId: 'proj', mergedBaseCommit: NEXT, recordedHost: HOST });
    expect(first).toMatchObject({ outcome: 'refilled' });
    expect(first.outcome === 'refilled' ? first.entries.map((e) => e.entryId) : []).toEqual(['proj#1', 'proj#2']);
    expect(host.claims.size).toBe(0);
    const second = await adapter.refillAfterMerge({ projectId: 'proj', mergedBaseCommit: NEXT, recordedHost: HOST });
    expect(second).toEqual(first);
    expect(host.worktrees.size).toBe(2);
  });

  it('moves idle warm entries to the merged base and leaves taken ones alone', async () => {
    const host = new FakeHost();
    host.add(1);
    host.add(2);
    const adapter = make(host);
    await take(adapter, 'run-1');
    const result = await adapter.refillAfterMerge({ projectId: 'proj', mergedBaseCommit: NEXT, recordedHost: HOST });
    expect(result.outcome).toBe('refilled');
    expect(host.worktrees.get(`${POOL}/w1`)!.head).toBe(BASE);
    expect(host.worktrees.get(`${POOL}/w2`)!.head).toBe(NEXT);
    expect(host.claims.get(`${CLAIMS}/w1`)).toMatch(/^run-/);
  });

  it('reaps dangling claims and stale prepare claims with their half-built tree', async () => {
    const host = new FakeHost();
    host.add(2);
    host.claims.set(`${CLAIMS}/w1`, 'run-gone'); // no worktree behind it
    host.claims.set(`${CLAIMS}/w2`, 'prepare-old');
    host.claims.set(`${CLAIMS}/w3`, 'run-live'); // dangling too
    host.stale.add('w2');
    const result = await make(host).refillAfterMerge({ projectId: 'proj', mergedBaseCommit: BASE, recordedHost: HOST });
    expect(result.outcome).toBe('refilled');
    expect(host.claims.size).toBe(0);
    expect(host.worktrees.has(`${POOL}/w2`)).toBe(true); // recreated clean after the reap
  });

  it('never reaps a claim whose owner cannot be read, even with no worktree behind it', async () => {
    const host = new FakeHost();
    host.claims.set(`${CLAIMS}/w1`, 'run-x');
    host.override = (t) => (t[0] === 'readlink' ? FAIL() : undefined);
    await make(host).refillAfterMerge({ projectId: 'proj', mergedBaseCommit: BASE, recordedHost: HOST });
    expect(host.claims.has(`${CLAIMS}/w1`)).toBe(true);
  });

  it('a stale reaper cannot remove a claim another process created after its snapshot', async () => {
    const host = new FakeHost();
    host.claims.set(`${CLAIMS}/w1`, 'run-gone'); // dangling at snapshot time
    let reads = 0;
    host.override = (t) => {
      // Between the reaper's snapshot and its guarded recheck, another process replaces the claim.
      if (t[0] === 'readlink' && (reads += 1) === 2) host.claims.set(`${CLAIMS}/w1`, 'prepare-new');
      return undefined;
    };
    await make(host, { maxEntries: 1 }).refillAfterMerge({ projectId: 'proj', mergedBaseCommit: BASE, recordedHost: HOST });
    expect(host.claims.get(`${CLAIMS}/w1`)).toBe('prepare-new');
    expect(host.claims.has(`${CLAIMS}/w1.reset`)).toBe(false);
  });

  it('a reset whose claim snapshot went stale under the guard does nothing', async () => {
    const host = new FakeHost();
    host.add(1);
    host.claims.set(`${CLAIMS}/w1`, 'run-A');
    let tests = 0;
    host.override = (t) => {
      if (t[0] === 'test' && t[1] === '-L' && (tests += 1) === 1) host.claims.delete(`${CLAIMS}/w1`);
      return undefined;
    };
    const result = await make(host).resetToBase({ worktreePath: `${POOL}/w1`, baseCommit: NEXT, recordedHost: HOST });
    expect(result).toEqual({ outcome: 'unknown' });
    expect(host.worktrees.get(`${POOL}/w1`)!.head).toBe(BASE);
  });

  it('leaves a fresh prepare claim alone even while its worktree is not yet listed', async () => {
    const host = new FakeHost();
    host.claims.set(`${CLAIMS}/w1`, 'prepare-fresh');
    await make(host).refillAfterMerge({ projectId: 'proj', mergedBaseCommit: BASE, recordedHost: HOST });
    expect(host.claims.get(`${CLAIMS}/w1`)).toBe('prepare-fresh');
    expect(host.worktrees.has(`${POOL}/w1`)).toBe(false);
  });

  it('never sets the stale window below the longest live operation', async () => {
    const host = new FakeHost();
    const adapter = make(host, { stalePrepareMinutes: 1, budgetsMs: { reset: 600_000, refill: 1_200_000 } });
    await adapter.refillAfterMerge({ projectId: 'proj', mergedBaseCommit: BASE, recordedHost: HOST });
    const windows = host.calls
      .filter((c) => c.argv[0] === 'find')
      .map((c) => Number((c.argv[c.argv.indexOf('-mmin') + 1] ?? '').replace('+', '')));
    expect(windows.length).toBeGreaterThan(0);
    for (const minutes of windows) expect(minutes).toBeGreaterThanOrEqual(21);
  });

  it('does not reap a fresh prepare claim or a live taken claim', async () => {
    const host = new FakeHost();
    host.add(1);
    host.add(2);
    host.claims.set(`${CLAIMS}/w1`, 'prepare-fresh');
    host.claims.set(`${CLAIMS}/w2`, 'run-live');
    const result = await make(host, { maxEntries: 2 }).refillAfterMerge({ projectId: 'proj', mergedBaseCommit: BASE, recordedHost: HOST });
    expect(result).toEqual({ outcome: 'refused', reason: 'pool-full' });
    expect(host.claims.size).toBe(2);
  });

  it('never serves a half-built entry: a failed prepare removes the tree, a timed-out one keeps its guard', async () => {
    const host = new FakeHost();
    const config = { repositoryPath: REPO, poolRoot: ROOT, targetSize: 1, prepare: [(p: string) => ['yarn', p]] };
    const adapter = new WorktreePoolAdapter({ executorFor: () => host, projects: { proj: config }, now: () => host.clock });
    host.override = (t) => (t[0] === 'yarn' ? FAIL() : undefined);
    expect((await adapter.refillAfterMerge({ projectId: 'proj', mergedBaseCommit: BASE, recordedHost: HOST })).outcome).toBe('unknown');
    expect(host.worktrees.size).toBe(0);
    host.override = (t) => (t[0] === 'yarn' ? { exitCode: null, signal: null, stdout: '', stderr: '', error: 'timeout' } : undefined);
    expect((await adapter.refillAfterMerge({ projectId: 'proj', mergedBaseCommit: BASE, recordedHost: HOST })).outcome).toBe('unknown');
    expect([...host.claims.values()].every((v) => v.startsWith('prepare-'))).toBe(true);
    expect(await take(adapter)).toEqual({ outcome: 'empty' });
  });

  it('is unknown when the listing cannot be read, and leaves an unlisted directory alone', async () => {
    const host = new FakeHost();
    host.override = (t) => (t[1] === 'list' ? FAIL() : undefined);
    expect((await make(host).refillAfterMerge({ projectId: 'proj', mergedBaseCommit: BASE, recordedHost: HOST })).outcome).toBe('unknown');
    expect(host.calls.every((c) => !c.argv.includes('add'))).toBe(true);
  });
});
