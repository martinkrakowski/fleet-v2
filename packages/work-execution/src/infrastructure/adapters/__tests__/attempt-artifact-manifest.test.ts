import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { AttemptArtifactAdapter, sha256HexDigest } from '../AttemptArtifactAdapter.adapter.js';
import { LocalExecutor } from '../LocalExecutor.adapter.js';
import type {
  CommandRunOptions,
  CommandRunResult,
  CommandExecutorPort,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import {
  ARTIFACT_MANIFEST_RELATIVE_PATH,
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
    const teeCalls = fake.calls.filter((c) => c.argv[0] === 'tee');
    expect(teeCalls).toHaveLength(1);
    expect(teeCalls[0].argv[1]).toBe('/wt/.lane/artifacts-manifest.json.tmp');
    const teeIndex = fake.calls.findIndex((c) => c.argv[0] === 'tee');
    const mvIndex = fake.calls.findIndex((c) => c.argv[0] === 'mv');
    expect(mvIndex).toBeGreaterThan(teeIndex);
    expect(fake.calls[mvIndex].argv).toEqual([
      'mv',
      '-f',
      '/wt/.lane/artifacts-manifest.json.tmp',
      '/wt/.lane/artifacts-manifest.json',
    ]);
    expect(
      fake.calls.some((c) => c.argv[0] === 'tee' && c.argv[1] === '/wt/.lane/artifacts-manifest.json'),
    ).toBe(false);
    expect(result.manifestPath).toBe(ARTIFACT_MANIFEST_RELATIVE_PATH);
    expect(result.manifestSha256).toBe(sha256HexDigest(fake.getTeeInput()));
    expect(result.manifest.files).toEqual([{ path: 'docs/a.md', size: 6, sha256: HEX64 }]);
    expect(result.manifest.total).toEqual({ files: 1, bytes: 6 });
  });

  it('refuses when the rename fails and removes the temp file', async () => {
    const fake = makeFake({ mv: { exitCode: 1, stderr: 'permission denied' } });
    const result = await sealWith(fake, ['docs/a.md']);
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.reason).toContain('Unable to move artifact manifest into place');
    const rmIndex = fake.calls.findIndex((c) => c.argv[0] === 'rm');
    expect(rmIndex).toBeGreaterThan(-1);
    expect(fake.calls[rmIndex].argv).toEqual(['rm', '-f', '/wt/.lane/artifacts-manifest.json.tmp']);
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
    const manifestText = await fsp.readFile(path.join(dir, '.lane', 'artifacts-manifest.json'), 'utf8');
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
    expect(laneEntries).not.toContain('artifacts-manifest.json.tmp');
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
      path.join(dir, '.lane', 'artifacts-manifest.json'),
      serializeArtifactManifest(rewritten),
    );
    const verdict = await adapter.verifyArtifactManifest({
      attemptId: 'attempt-1',
      worktreePath: dir,
      expectedManifestSha256: sealed.manifestSha256,
    });
    expect(verdict).toEqual({
      outcome: 'mismatch',
      mismatches: [{ path: ARTIFACT_MANIFEST_RELATIVE_PATH, kind: 'manifest-changed' }],
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
});
