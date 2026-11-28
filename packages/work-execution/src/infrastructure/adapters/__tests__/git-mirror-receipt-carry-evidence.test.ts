// GitMirrorReceiptCarryEvidenceAdapter tests (U6): the read-only git evidence
// for a premerge carry, over a REAL bare mirror built in a temporary directory.

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GitMirrorReceiptCarryEvidenceAdapter } from '../GitMirrorReceiptCarryEvidenceAdapter.adapter.js';
import { qualifyBaseMergeCarry } from '../../../domain/receipt-carry.js';
import type { CommandExecutorPort } from '../../../application/ports/out/CommandExecutorPort.out-port.js';

const DIGEST = '0123456789ab';
const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
}

async function write(dir: string, file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await fs.writeFile(path.join(dir, file), content);
}

interface Fixture {
  readonly stateDir: string;
  readonly lane: string;
  readonly mergeHead: string;
  readonly handEditedHead: string;
  readonly mainTip: string;
}

/** main: M1 then M2 (touches other.txt); lane from M1: L1 (touches src/a.ts); lane merges M2 cleanly; a second merge is hand-edited. */
async function fixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'carry-evidence-'));
  roots.push(root);
  const work = path.join(root, 'work');
  await fs.mkdir(work);
  git(work, 'init', '-q', '-b', 'main');
  await write(work, 'base.txt', 'base\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'M1');
  git(work, 'checkout', '-q', '-b', 'lane');
  await write(work, 'src/a.ts', 'lane\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'L1');
  const lane = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', 'main');
  await write(work, 'other.txt', 'main moved\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'M2');
  const mainTip = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', 'lane');
  git(work, 'merge', '-q', '--no-ff', '-m', 'merge main', 'main');
  const mergeHead = git(work, 'rev-parse', 'HEAD');
  // A hand-edited merge of the same parents: the tree differs from the automatic merge.
  git(work, 'checkout', '-q', '-b', 'edited', lane);
  git(work, 'merge', '-q', '--no-ff', '--no-commit', 'main');
  await write(work, 'src/lane-authored.ts', 'sneaked in\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'merge main with an edit');
  const handEditedHead = git(work, 'rev-parse', 'HEAD');
  const stateDir = path.join(root, 'state');
  await fs.mkdir(path.join(stateDir, 'mirrors'), { recursive: true });
  git(root, 'clone', '-q', '--mirror', work, path.join(stateDir, 'mirrors', `${DIGEST}.git`));
  return { stateDir, lane, mergeHead, handEditedHead, mainTip };
}

afterEach(async () => {
  while (roots.length > 0) {
    await fs.rm(roots.pop() as string, { recursive: true, force: true });
  }
});

const DEADLINE = (): string => new Date(Date.now() + 60_000).toISOString();

describe('GitMirrorReceiptCarryEvidenceAdapter', () => {
  it('reads the clean-merge evidence that qualifies a carry', async () => {
    const f = await fixture();
    const adapter = new GitMirrorReceiptCarryEvidenceAdapter({ stateDir: f.stateDir });
    const evidence = await adapter.readCarryEvidence({
      repositoryDigest: DIGEST, reviewedHeadSha: f.lane, newHeadSha: f.mergeHead, baseBranch: 'main', deadlineIso: DEADLINE(),
    });
    expect(evidence).toMatchObject({
      ok: true,
      newHeadParents: [f.lane, f.mainTip],
      secondParentOnBase: true,
      prChangedPaths: ['src/a.ts'],
    });
    if (!evidence.ok) {
      throw new Error('expected evidence');
    }
    expect(evidence.automaticMergeTreeSha).toBe(evidence.newHeadTreeSha);
    const verdict = qualifyBaseMergeCarry({
      attemptId: 'attempt-1', reviewedHeadSha: f.lane, newHeadSha: f.mergeHead,
      newHeadParents: evidence.newHeadParents, secondParentOnBase: evidence.secondParentOnBase,
      mainRangeBaseSha: evidence.mainRangeBaseSha, automaticMergeTreeSha: evidence.automaticMergeTreeSha,
      newHeadTreeSha: evidence.newHeadTreeSha, prChangedPaths: evidence.prChangedPaths,
      laneChangedPaths: ['src/a.ts'], ci: 'passed', decidedAtIso: '2026-11-27T12:00:00.000Z',
    });
    expect(verdict.carry).toBe(true);
  });

  it('reads a hand-edited merge as a different tree and a lane-authored path, so it does not carry', async () => {
    const f = await fixture();
    const adapter = new GitMirrorReceiptCarryEvidenceAdapter({ stateDir: f.stateDir });
    const evidence = await adapter.readCarryEvidence({
      repositoryDigest: DIGEST, reviewedHeadSha: f.lane, newHeadSha: f.handEditedHead, baseBranch: 'main', deadlineIso: DEADLINE(),
    });
    if (!evidence.ok) {
      throw new Error('expected evidence');
    }
    expect(evidence.automaticMergeTreeSha).not.toBe(evidence.newHeadTreeSha);
    expect(evidence.prChangedPaths).toEqual(['src/a.ts', 'src/lane-authored.ts']);
  });

  it('reads a non-merge head as one parent with no merge evidence', async () => {
    const f = await fixture();
    const adapter = new GitMirrorReceiptCarryEvidenceAdapter({ stateDir: f.stateDir });
    const evidence = await adapter.readCarryEvidence({
      repositoryDigest: DIGEST, reviewedHeadSha: f.lane, newHeadSha: f.lane, baseBranch: 'main', deadlineIso: DEADLINE(),
    });
    expect(evidence).toMatchObject({ ok: true, secondParentOnBase: null, automaticMergeTreeSha: null });
    if (evidence.ok) {
      expect(evidence.newHeadParents).toHaveLength(1);
    }
  });

  it('refuses a bad digest, a bad sha, a bad base branch and a missing mirror without running git', async () => {
    const f = await fixture();
    const calls: string[][] = [];
    const executor: CommandExecutorPort = {
      run: async (argv) => {
        calls.push([...argv]);
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
    };
    const adapter = new GitMirrorReceiptCarryEvidenceAdapter({ stateDir: f.stateDir, executor });
    const base = { repositoryDigest: DIGEST, reviewedHeadSha: f.lane, newHeadSha: f.mergeHead, baseBranch: 'main', deadlineIso: DEADLINE() };
    expect(await adapter.readCarryEvidence({ ...base, repositoryDigest: '../x' })).toEqual({ ok: false, reason: 'refused', code: 'bad-digest' });
    expect(await adapter.readCarryEvidence({ ...base, newHeadSha: 'abc' })).toEqual({ ok: false, reason: 'refused', code: 'bad-sha' });
    expect(await adapter.readCarryEvidence({ ...base, baseBranch: '--upload-pack=x' })).toEqual({ ok: false, reason: 'refused', code: 'bad-base' });
    expect(await adapter.readCarryEvidence({ ...base, repositoryDigest: 'ffffffffffff' })).toEqual({ ok: false, reason: 'refused', code: 'no-mirror' });
    expect(calls).toEqual([]);
  });

  it('maps a throwing executor, a failed command and an expired deadline to unknown evidence', async () => {
    const f = await fixture();
    const base = { repositoryDigest: DIGEST, reviewedHeadSha: f.lane, newHeadSha: f.mergeHead, baseBranch: 'main' };
    const throwing = new GitMirrorReceiptCarryEvidenceAdapter({
      stateDir: f.stateDir, executor: { run: async () => { throw new Error('spawn failed'); } },
    });
    expect(await throwing.readCarryEvidence({ ...base, deadlineIso: DEADLINE() })).toMatchObject({ ok: true, newHeadParents: null, automaticMergeTreeSha: null });
    const failing = new GitMirrorReceiptCarryEvidenceAdapter({
      stateDir: f.stateDir, executor: { run: async () => ({ exitCode: 128, signal: null, stdout: '', stderr: 'fatal' }) },
    });
    expect(await failing.readCarryEvidence({ ...base, deadlineIso: DEADLINE() })).toMatchObject({ ok: true, newHeadParents: null });
    const real = new GitMirrorReceiptCarryEvidenceAdapter({ stateDir: f.stateDir });
    expect(await real.readCarryEvidence({ ...base, deadlineIso: new Date(Date.now() - 1000).toISOString() })).toMatchObject({
      ok: true, newHeadParents: null, prChangedPaths: null,
    });
  });
});
