import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { AttemptArtifactAdapter, sha256HexDigest } from '../AttemptArtifactAdapter.adapter.js';
import { LocalExecutor } from '../LocalExecutor.adapter.js';
import type { AttemptArtifactPort } from '../../../application/ports/out/AttemptArtifactPort.out-port.js';
import type {
  CommandRunOptions,
  CommandRunResult,
  CommandExecutorPort,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import {
  ARTIFACT_MANIFEST_RELATIVE_PATH,
  artifactManifestRelativePath,
  buildArtifactManifest,
  parseArtifactManifest,
  serializeArtifactManifest,
} from '../../../domain/artifact-manifest.js';

const execFileAsync = promisify(execFile);

type RunCall = { argv: readonly string[]; options?: CommandRunOptions };

/** A recording fake executor with scripted outcomes per call. */
function fakeExecutor(respond: (call: RunCall, index: number) => Partial<CommandRunResult>): {
  executor: CommandExecutorPort;
  calls: RunCall[];
} {
  const calls: RunCall[] = [];
  return {
    executor: {
      run: async (argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> => {
        const index = calls.length;
        const call: RunCall = { argv, options };
        calls.push(call);
        return { exitCode: 0, signal: null, stdout: '', stderr: '', ...respond(call, index) };
      },
    },
    calls,
  };
}

const HEX64 = 'a'.repeat(64);

function makeFake(overrides: Record<string, Partial<CommandRunResult>> = {}): {
  executor: CommandExecutorPort;
  calls: RunCall[];
  getTeeInput: () => string;
} {
  let teeInput = '';
  const { executor, calls } = fakeExecutor((call) => {
    const override = overrides[call.argv[0]];
    if (override !== undefined) {
      return override;
    }
    switch (call.argv[0]) {
      case 'git':
        return {};
      case 'realpath':
        return { stdout: call.argv[call.argv.length - 1] + '\n' };
      case 'test': {
        const flag = call.argv[1];
        return flag === '-L' ? { exitCode: 1 } : { exitCode: 0 };
      }
      case 'wc':
        return { stdout: '      6 /wt/x\n' };
      case 'sha256sum':
        return { stdout: HEX64 + '  /wt/x\n' };
      case 'tee': {
        teeInput = call.options?.input ?? '';
        return {};
      }
      case 'mv':
      case 'mkdir':
      case 'rm':
        return {};
      case 'cat':
        return { stdout: teeInput };
      default:
        return {};
    }
  });
  return { executor, calls, getTeeInput: () => teeInput };
}

function sealWith(fake: { executor: CommandExecutorPort }, paths: readonly string[]) {
  const adapter = new AttemptArtifactAdapter({ executor: fake.executor });
  return adapter.sealArtifactManifest({
    attemptId: 'attempt-1',
    worktreePath: '/wt',
    artifactPaths: paths,
  });
}

describe('AttemptArtifactAdapter artifact manifest (fake executor)', () => {
  it('writes atomically: tee the temp path before mv, never the final path directly', async () => {
    const fake = makeFake();
    const result = await sealWith(fake, ['docs/a.md']);
    expect(result.outcome).toBe('sealed');
    if (result.outcome !== 'sealed') return;
    const expectedManifestSha256 = sha256HexDigest(fake.getTeeInput());
    const expectedManifestPath = artifactManifestRelativePath(expectedManifestSha256);
    const teeCalls = fake.calls.filter((c) => c.argv[0] === 'tee');
    expect(teeCalls).toHaveLength(1);
    const tempTarget = teeCalls[0].argv[1];
    expect(tempTarget).toMatch(
      /^\/wt\/\.lane\/artifacts-manifest-[0-9a-f]{16}\.json\.tmp-[0-9a-f]{8}$/,
    );
    expect(tempTarget.startsWith('/wt/' + expectedManifestPath + '.tmp-')).toBe(true);
    const teeIndex = fake.calls.findIndex((c) => c.argv[0] === 'tee');
    const mvIndex = fake.calls.findIndex((c) => c.argv[0] === 'mv');
    expect(mvIndex).toBeGreaterThan(teeIndex);
    expect(fake.calls[mvIndex].argv).toEqual([
      'mv',
      '-f',
      tempTarget,
      '/wt/' + expectedManifestPath,
    ]);
    expect(
      fake.calls.some((c) => c.argv[0] === 'tee' && c.argv[1] === '/wt/' + expectedManifestPath),
    ).toBe(false);
    expect(result.manifestPath).toBe(expectedManifestPath);
    expect(result.manifestSha256).toBe(expectedManifestSha256);
    expect(result.manifest.files).toEqual([{ path: 'docs/a.md', size: 6, sha256: HEX64 }]);
    expect(result.manifest.total).toEqual({ files: 1, bytes: 6 });
  });

  it('refuses when the rename fails and removes the temp file', async () => {
    const fake = makeFake({ mv: { exitCode: 1, stderr: 'permission denied' } });
    const result = await sealWith(fake, ['docs/a.md']);
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.reason).toContain('Unable to move artifact manifest into place');
    const teeCall = fake.calls.find((c) => c.argv[0] === 'tee');
    const rmIndex = fake.calls.findIndex((c) => c.argv[0] === 'rm');
    expect(rmIndex).toBeGreaterThan(-1);
    expect(fake.calls[rmIndex].argv).toEqual(['rm', '-f', teeCall?.argv[1]]);
  });

  it('refuses when the read-back differs', async () => {
    const fake = makeFake({ cat: { stdout: 'something else' } });
    const result = await sealWith(fake, ['docs/a.md']);
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.reason).toContain('read-back');
  });

  it('refuses when the manifest paths are not gitignored and never tees', async () => {
    const fake = makeFake({ git: { exitCode: 1 } });
    const result = await sealWith(fake, ['docs/a.md']);
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.reason).toBe('Artifact manifest paths are not gitignored');
    expect(fake.calls.some((c) => c.argv[0] === 'tee')).toBe(false);
  });

  it('refuses an escaping path with no executor calls', async () => {
    const fake = makeFake();
    const result = await sealWith(fake, ['../x']);
    expect(result.outcome).toBe('refused');
    expect(fake.calls).toEqual([]);
  });

  it('refuses a symbolic link as not a regular file', async () => {
    const fake = makeFake({ test: { exitCode: 0 } });
    const result = await sealWith(fake, ['docs/a.md']);
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.reason).toContain('not a regular file');
  });

  it('hardens every git call during sealArtifactManifest and artifact collection with core.fsmonitor=false and core.hooksPath=/dev/null', async () => {
    const fake = makeFake();
    const adapter = new AttemptArtifactAdapter({ executor: fake.executor });
    const collected = await adapter.collectCompletedAttemptArtifacts({
      attemptId: 'attempt-1',
      worktreePath: '/wt',
      baseCommit: '0'.repeat(40),
      expectedArtifactPaths: ['docs/a.md'],
      completionReceipt: {
        attemptId: 'attempt-1',
        sessionId: 'session-1',
        endedAtIso: '2026-04-19T00:00:00.000Z',
        authoritative: true,
        exitStatus: 0,
        stoppedByRequest: false,
      },
    });
    expect(collected.outcome).toBe('collected');
    const sealed = await adapter.sealArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: '/wt',
      artifactPaths: ['docs/a.md'],
    });
    expect(sealed.outcome).toBe('sealed');
    const gitCalls = fake.calls.filter((c) => c.argv[0] === 'git');
    expect(gitCalls).toHaveLength(4);
    for (const call of gitCalls) {
      expect(call.argv.slice(0, 7)).toEqual([
        'git',
        '-C',
        '/wt',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
      ]);
      expect(call.argv).toContain('core.fsmonitor=false');
      expect(call.argv).toContain('core.hooksPath=/dev/null');
    }
  });

  it('resolves canonical paths with realpath -- (no -e flag)', async () => {
    const fake = makeFake();
    const result = await sealWith(fake, ['docs/a.md']);
    expect(result.outcome).toBe('sealed');
    const realpathCalls = fake.calls.filter((c) => c.argv[0] === 'realpath');
    expect(realpathCalls.map((c) => c.argv)).toEqual([
      ['realpath', '--', '/wt'],
      ['realpath', '--', '/wt/docs/a.md'],
    ]);
  });

  it('rejects a manifestPath that does not match the content-addressed shape with no executor probes', async () => {
    const fake = makeFake();
    const port: AttemptArtifactPort = new AttemptArtifactAdapter({ executor: fake.executor });
    const escapingVerdict = await port.verifyArtifactManifest?.({
      attemptId: 'attempt-1',
      worktreePath: '/wt',
      manifestPath: '../x.json',
    });
    expect(escapingVerdict).toEqual({
      outcome: 'mismatch',
      mismatches: [{ path: '../x.json', kind: 'manifest-invalid' }],
    });
    const otherVerdict = await port.verifyArtifactManifest?.({
      attemptId: 'attempt-1',
      worktreePath: '/wt',
      manifestPath: '.lane/other.json',
    });
    expect(otherVerdict).toEqual({
      outcome: 'mismatch',
      mismatches: [{ path: '.lane/other.json', kind: 'manifest-invalid' }],
    });
    expect(fake.calls).toEqual([]);
  });
});

describe('AttemptArtifactAdapter artifact manifest (real filesystem)', () => {
  const dirs: string[] = [];

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
  });

  async function makeTempRepo(): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fleet-artifact-manifest-'));
    dirs.push(dir);
    await execFileAsync('git', ['init', '-q'], { cwd: dir });
    await fsp.writeFile(path.join(dir, '.gitignore'), '.lane/\n');
    await fsp.mkdir(path.join(dir, 'docs'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'docs', 'a.md'), 'alpha\n');
    await fsp.mkdir(path.join(dir, '.lane'), { recursive: true });
    await fsp.writeFile(path.join(dir, '.lane', 'notes.md'), 'notes\n');
    return dir;
  }

  function digestOf(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  it('seals and verifies; no temp file is left behind', async () => {
    const dir = await makeTempRepo();
    const adapter = new AttemptArtifactAdapter({ executor: new LocalExecutor() });
    const sealed = await adapter.sealArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
      artifactPaths: ['docs/a.md', '.lane/notes.md'],
    });
    expect(sealed.outcome).toBe('sealed');
    if (sealed.outcome !== 'sealed') return;
    expect(sealed.manifestPath).toBe(artifactManifestRelativePath(sealed.manifestSha256));
    const manifestText = await fsp.readFile(path.join(dir, sealed.manifestPath), 'utf8');
    const manifest = parseArtifactManifest(manifestText);
    expect(manifest).not.toBeNull();
    expect(manifest?.attemptId).toBe('attempt-1');
    expect(manifest?.files.map((f) => f.path)).toEqual(['.lane/notes.md', 'docs/a.md']);
    expect(manifest?.files[0].size).toBe(6);
    expect(manifest?.files[1].size).toBe(6);
    expect(manifest?.files[0].sha256).toBe(digestOf('notes\n'));
    expect(manifest?.files[1].sha256).toBe(digestOf('alpha\n'));
    expect(manifest?.total).toEqual({ files: 2, bytes: 12 });
    expect(sealed.manifestSha256).toBe(sha256HexDigest(manifestText));
    const verdict = await adapter.verifyArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
      expectedManifestSha256: sealed.manifestSha256,
    });
    expect(verdict.outcome).toBe('sealed');
    const laneEntries = await fsp.readdir(path.join(dir, '.lane'));
    expect(laneEntries.some((entry) => entry.includes('.tmp'))).toBe(false);
  });

  it('answers missing when no manifest exists', async () => {
    const dir = await makeTempRepo();
    const adapter = new AttemptArtifactAdapter({ executor: new LocalExecutor() });
    const verdict = await adapter.verifyArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
    });
    expect(verdict).toEqual({ outcome: 'missing' });
  });

  it('detects content mismatch: same size different digest, then different size', async () => {
    const dir = await makeTempRepo();
    const adapter = new AttemptArtifactAdapter({ executor: new LocalExecutor() });
    const sealed = await adapter.sealArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
      artifactPaths: ['docs/a.md'],
    });
    expect(sealed.outcome).toBe('sealed');
    if (sealed.outcome !== 'sealed') return;
    await fsp.writeFile(path.join(dir, 'docs', 'a.md'), 'alphX\n');
    let verdict = await adapter.verifyArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
      expectedManifestSha256: sealed.manifestSha256,
    });
    expect(verdict).toEqual({
      outcome: 'mismatch',
      mismatches: [{ path: 'docs/a.md', kind: 'sha256' }],
    });
    await fsp.writeFile(path.join(dir, 'docs', 'a.md'), 'longer\n');
    verdict = await adapter.verifyArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
      expectedManifestSha256: sealed.manifestSha256,
    });
    expect(verdict).toEqual({
      outcome: 'mismatch',
      mismatches: [{ path: 'docs/a.md', kind: 'size' }],
    });
  });

  it('detects a deleted file as absent', async () => {
    const dir = await makeTempRepo();
    const adapter = new AttemptArtifactAdapter({ executor: new LocalExecutor() });
    const sealed = await adapter.sealArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
      artifactPaths: ['docs/a.md'],
    });
    expect(sealed.outcome).toBe('sealed');
    if (sealed.outcome !== 'sealed') return;
    await fsp.rm(path.join(dir, 'docs', 'a.md'));
    const verdict = await adapter.verifyArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
      expectedManifestSha256: sealed.manifestSha256,
    });
    expect(verdict).toEqual({
      outcome: 'mismatch',
      mismatches: [{ path: 'docs/a.md', kind: 'absent' }],
    });
  });

  it('catches a rewritten manifest via the recorded digest', async () => {
    const dir = await makeTempRepo();
    const adapter = new AttemptArtifactAdapter({ executor: new LocalExecutor() });
    const sealed = await adapter.sealArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
      artifactPaths: ['docs/a.md'],
    });
    expect(sealed.outcome).toBe('sealed');
    if (sealed.outcome !== 'sealed') return;
    const rewritten = buildArtifactManifest('attempt-1', [
      { path: 'docs/a.md', size: 99, sha256: 'b'.repeat(64) },
    ]);
    await fsp.writeFile(
      path.join(dir, sealed.manifestPath),
      serializeArtifactManifest(rewritten),
    );
    const verdict = await adapter.verifyArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
      expectedManifestSha256: sealed.manifestSha256,
    });
    expect(verdict).toEqual({
      outcome: 'mismatch',
      mismatches: [{ path: sealed.manifestPath, kind: 'manifest-changed' }],
    });
  });

  it('reports an invalid manifest', async () => {
    const dir = await makeTempRepo();
    const adapter = new AttemptArtifactAdapter({ executor: new LocalExecutor() });
    await fsp.writeFile(path.join(dir, '.lane', 'artifacts-manifest.json'), '{}');
    const verdict = await adapter.verifyArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
    });
    expect(verdict).toEqual({
      outcome: 'mismatch',
      mismatches: [{ path: ARTIFACT_MANIFEST_RELATIVE_PATH, kind: 'manifest-invalid' }],
    });
  });

  it('refuses a directory artifact as not a regular file', async () => {
    const dir = await makeTempRepo();
    const adapter = new AttemptArtifactAdapter({ executor: new LocalExecutor() });
    const result = await adapter.sealArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
      artifactPaths: ['docs'],
    });
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.reason).toContain('not a regular file');
  });

  it('refuses a parent-directory symlink (docs -> outside dir) and leaves the outside file untouched', async () => {
    const dir = await makeTempRepo();
    const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fleet-artifact-outside-'));
    dirs.push(outsideDir);
    const outsideFile = path.join(outsideDir, 'a.md');
    await fsp.writeFile(outsideFile, 'outside secret\n');
    await fsp.rm(path.join(dir, 'docs'), { recursive: true, force: true });
    await fsp.symlink(outsideDir, path.join(dir, 'docs'));
    const adapter = new AttemptArtifactAdapter({ executor: new LocalExecutor() });
    const result = await adapter.sealArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
      artifactPaths: ['docs/a.md'],
    });
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.reason).toContain('not a regular file');
    expect(await fsp.readFile(outsideFile, 'utf8')).toBe('outside secret\n');
  });

  it('refuses a pre-existing symlink at the final manifest path', async () => {
    const dir = await makeTempRepo();
    const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fleet-manifest-outside-'));
    dirs.push(outsideDir);
    const outsideTarget = path.join(outsideDir, 'hijack.json');
    await fsp.writeFile(outsideTarget, 'untouched\n');
    const expectedManifest = buildArtifactManifest('attempt-1', [
      { path: 'docs/a.md', size: 6, sha256: digestOf('alpha\n') },
    ]);
    const expectedDigest = sha256HexDigest(serializeArtifactManifest(expectedManifest));
    const finalRelPath = artifactManifestRelativePath(expectedDigest);
    await fsp.symlink(outsideTarget, path.join(dir, finalRelPath));
    const adapter = new AttemptArtifactAdapter({ executor: new LocalExecutor() });
    const result = await adapter.sealArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
      artifactPaths: ['docs/a.md'],
    });
    expect(result.outcome).toBe('refused');
    expect(await fsp.readFile(outsideTarget, 'utf8')).toBe('untouched\n');
  });

  it('refuses .lane as a symlink', async () => {
    const dir = await makeTempRepo();
    const outsideLane = await fsp.mkdtemp(path.join(os.tmpdir(), 'fleet-lane-outside-'));
    dirs.push(outsideLane);
    await fsp.rm(path.join(dir, '.lane'), { recursive: true, force: true });
    await fsp.symlink(outsideLane, path.join(dir, '.lane'));
    const adapter = new AttemptArtifactAdapter({ executor: new LocalExecutor() });
    const result = await adapter.sealArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
      artifactPaths: ['docs/a.md'],
    });
    expect(result.outcome).toBe('refused');
    expect(await fsp.readdir(outsideLane)).toEqual([]);
  });

  it('verify does not read a manifest through a symlinked .lane (Luna re-review)', async () => {
    const dir = await makeTempRepo();
    const outsideLane = await fsp.mkdtemp(path.join(os.tmpdir(), 'fleet-lane-outside-'));
    dirs.push(outsideLane);
    await fsp.writeFile(path.join(outsideLane, path.basename(ARTIFACT_MANIFEST_RELATIVE_PATH)), '{}');
    await fsp.rm(path.join(dir, '.lane'), { recursive: true, force: true });
    await fsp.symlink(outsideLane, path.join(dir, '.lane'));
    const adapter = new AttemptArtifactAdapter({ executor: new LocalExecutor() });
    const verdict = await adapter.verifyArtifactManifest({ attemptId: 'attempt-1', worktreePath: dir });
    expect(verdict.outcome).toBe('mismatch');
  });

  it('gives mismatch / manifest-invalid (not missing) when verify encounters a directory or symlink at the manifest path', async () => {
    const dir = await makeTempRepo();
    const adapter = new AttemptArtifactAdapter({ executor: new LocalExecutor() });
    const manifestAbsPath = path.join(dir, ARTIFACT_MANIFEST_RELATIVE_PATH);
    await fsp.mkdir(manifestAbsPath, { recursive: true });
    const dirVerdict = await adapter.verifyArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
    });
    expect(dirVerdict).toEqual({
      outcome: 'mismatch',
      mismatches: [{ path: ARTIFACT_MANIFEST_RELATIVE_PATH, kind: 'manifest-invalid' }],
    });

    await fsp.rm(manifestAbsPath, { recursive: true, force: true });
    await fsp.symlink(path.join(dir, 'docs', 'a.md'), manifestAbsPath);
    const symlinkVerdict = await adapter.verifyArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
    });
    expect(symlinkVerdict).toEqual({
      outcome: 'mismatch',
      mismatches: [{ path: ARTIFACT_MANIFEST_RELATIVE_PATH, kind: 'manifest-invalid' }],
    });
  });

  it('produces two different file names for two sealings with different content, and verify against the first digest still says sealed', async () => {
    const dir = await makeTempRepo();
    await fsp.writeFile(path.join(dir, 'docs', 'b.md'), 'bravo\n');
    const adapter = new AttemptArtifactAdapter({ executor: new LocalExecutor() });
    const first = await adapter.sealArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
      artifactPaths: ['docs/a.md'],
    });
    const second = await adapter.sealArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
      artifactPaths: ['docs/a.md', 'docs/b.md'],
    });
    expect(first.outcome).toBe('sealed');
    expect(second.outcome).toBe('sealed');
    if (first.outcome !== 'sealed' || second.outcome !== 'sealed') return;
    expect(first.manifestPath).not.toBe(second.manifestPath);
    expect(first.manifestPath).toMatch(/^\.lane\/artifacts-manifest-[0-9a-f]{16}\.json$/);
    expect(second.manifestPath).toMatch(/^\.lane\/artifacts-manifest-[0-9a-f]{16}\.json$/);
    const verdict = await adapter.verifyArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
      expectedManifestSha256: first.manifestSha256,
    });
    expect(verdict.outcome).toBe('sealed');
  });

  it('verifies through AttemptArtifactPort with the recorded manifestPath, and reports manifest-invalid for ../x.json or .lane/other.json', async () => {
    const dir = await makeTempRepo();
    const port: AttemptArtifactPort = new AttemptArtifactAdapter({ executor: new LocalExecutor() });
    const sealed = await port.sealArtifactManifest?.({
      attemptId: 'attempt-1',
      worktreePath: dir,
      artifactPaths: ['docs/a.md'],
    });
    expect(sealed?.outcome).toBe('sealed');
    if (sealed?.outcome !== 'sealed') return;
    const verdict = await port.verifyArtifactManifest?.({
      attemptId: 'attempt-1',
      worktreePath: dir,
      manifestPath: sealed.manifestPath,
      expectedManifestSha256: sealed.manifestSha256,
    });
    expect(verdict).toEqual({ outcome: 'sealed' });

    const escapingVerdict = await port.verifyArtifactManifest?.({
      attemptId: 'attempt-1',
      worktreePath: dir,
      manifestPath: '../x.json',
    });
    expect(escapingVerdict).toEqual({
      outcome: 'mismatch',
      mismatches: [{ path: '../x.json', kind: 'manifest-invalid' }],
    });

    const otherVerdict = await port.verifyArtifactManifest?.({
      attemptId: 'attempt-1',
      worktreePath: dir,
      manifestPath: '.lane/other.json',
    });
    expect(otherVerdict).toEqual({
      outcome: 'mismatch',
      mismatches: [{ path: '.lane/other.json', kind: 'manifest-invalid' }],
    });
  });
});
