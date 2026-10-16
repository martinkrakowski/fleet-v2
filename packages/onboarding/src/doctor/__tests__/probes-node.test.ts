/**
 * The node doctor probes against injected fake executors. Every test asserts
 * the exact argv the probes run (local execFile vs the `ssh <alias> --`
 * wrapper), the timeout budget they pass, and that no probe ever reads a
 * credential file's contents — fileMode only stats.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BUILT_IN_TOOLS, type ToolId } from '@fleet/tooling';

import type { SeatModel } from '@fleet/installation';

import type {
  DoctorCommandExecutor,
  DoctorCommandRunOptions,
  DoctorCommandRunResult,
} from '../probes-node.js';
import { createNodeDoctorProbes, seatProbeArgv } from '../probes-node.js';

interface RecordedCall {
  readonly argv: readonly string[];
  readonly options?: DoctorCommandRunOptions;
}

function fakeExecutor(
  outcome: Partial<DoctorCommandRunResult> | ((call: RecordedCall) => DoctorCommandRunResult),
): { executor: DoctorCommandExecutor; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    executor: {
      async run(argv, options) {
        calls.push({ argv, options });
        if (typeof outcome === 'function') {
          return outcome({ argv, options });
        }
        return {
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: '',
          ...outcome,
        };
      },
    },
  };
}

const seat: SeatModel = {
  id: 'seat-1',
  tool: 'claude-code',
  model: 'glm-5.3',
  variant: 'none',
  roles: ['implementer'],
  costClass: 'plan-quota',
};

describe('createNodeDoctorProbes', () => {
  it('reports local hosts reachable without running a command', async () => {
    const local = fakeExecutor({});
    const probes = createNodeDoctorProbes({ localExecutor: local.executor });
    await expect(probes.hostReachable('local')).resolves.toBe(true);
    expect(local.calls).toHaveLength(0);
  });

  it('checks ssh reachability through the BatchMode wrapper argv', async () => {
    const local = fakeExecutor({});
    const probes = createNodeDoctorProbes({ localExecutor: local.executor });
    await expect(probes.hostReachable('lane-host')).resolves.toBe(true);
    expect(local.calls[0]?.argv).toEqual([
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      'lane-host',
      '--',
      'true',
    ]);
  });

  it('maps a failing ssh reachability run to false', async () => {
    const local = fakeExecutor({ exitCode: 255 });
    const probes = createNodeDoctorProbes({ localExecutor: local.executor });
    await expect(probes.hostReachable('lane-host')).resolves.toBe(false);
  });

  it('probes command availability through `sh -c command -v` with no shell metacharacters', async () => {
    const local = fakeExecutor({});
    const probes = createNodeDoctorProbes({ localExecutor: local.executor });
    await expect(probes.commandAvailable('local', 'nc')).resolves.toBe(true);
    expect(local.calls[0]?.argv).toEqual(['sh', '-c', 'command -v nc']);

    await expect(probes.commandAvailable('local', 'x; rm -rf /')).resolves.toBe(false);
    expect(local.calls).toHaveLength(1);
  });

  it('runs each tool descriptor version argv locally and over ssh, first line only', async () => {
    const local = fakeExecutor({ stdout: 'claude 1.2.3 (build 9)\nextra line\n' });
    const ssh = fakeExecutor({ stdout: 'claude 1.2.3 (build 9)\n' });
    const probes = createNodeDoctorProbes({
      localExecutor: local.executor,
      sshExecutor: ssh.executor,
    });
    await expect(probes.toolVersion('local', 'claude-code')).resolves.toBe(
      'claude 1.2.3 (build 9)',
    );
    expect(local.calls[0]?.argv).toEqual(['claude', '--version']);

    await expect(probes.toolVersion('lane-host', 'claude-code')).resolves.toBe(
      'claude 1.2.3 (build 9)',
    );
    expect(ssh.calls[0]?.argv).toEqual([
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      'lane-host',
      '--',
      'claude',
      '--version',
    ]);
  });

  it('returns undefined for an unparsable, failing or unknown tool version', async () => {
    const failing = fakeExecutor({ exitCode: 1, stdout: '' });
    const empty = fakeExecutor({ exitCode: 0, stdout: '\n' });
    const probes = createNodeDoctorProbes({ localExecutor: failing.executor });
    await expect(probes.toolVersion('local', 'claude-code')).resolves.toBeUndefined();
    await expect(probes.toolVersion('local', 'nope' as ToolId)).resolves.toBeUndefined();
    const emptyProbes = createNodeDoctorProbes({ localExecutor: empty.executor });
    await expect(emptyProbes.toolVersion('local', 'agy')).resolves.toBeUndefined();
  });

  it('stats the file mode only and never reads contents', async () => {
    const local = fakeExecutor(({ argv }) =>
      argv.includes('/missing.json')
        ? { exitCode: 1, signal: null, stdout: '', stderr: '' }
        : { exitCode: 0, signal: null, stdout: '600\n', stderr: '' },
    );
    const probes = createNodeDoctorProbes({ localExecutor: local.executor });
    await expect(probes.fileMode('local', '/secrets/auth.json')).resolves.toBe(0o600);
    expect(local.calls[0]?.argv).toEqual(['stat', '-c', '%a', '/secrets/auth.json']);
    // Only the stat argv ran: no `cat`, no other reader.
    expect(local.calls[0]?.argv[0]).toBe('stat');
    await expect(probes.fileMode('local', '/missing.json')).resolves.toBeUndefined();
    const bad = fakeExecutor({ exitCode: 0, stdout: 'rw-r--r--' });
    const badProbes = createNodeDoctorProbes({ localExecutor: bad.executor });
    await expect(badProbes.fileMode('local', '/x')).resolves.toBeUndefined();
  });

  it('falls back to the BSD `stat -f %Lp` form when GNU `stat -c %a` fails', async () => {
    const local = fakeExecutor(({ argv }) =>
      argv[1] === '-c'
        ? { exitCode: 1, signal: null, stdout: '', stderr: 'usage: stat [-FLnqxs] file' }
        : { exitCode: 0, signal: null, stdout: '600\n', stderr: '' },
    );
    const probes = createNodeDoctorProbes({ localExecutor: local.executor });
    await expect(probes.fileMode('local', '/secrets/auth.json')).resolves.toBe(0o600);
    expect(local.calls.map((call) => call.argv)).toEqual([
      ['stat', '-c', '%a', '/secrets/auth.json'],
      ['stat', '-f', '%Lp', '/secrets/auth.json'],
    ]);
  });

  it('tests worktree root writability with `test -w`', async () => {
    const local = fakeExecutor({});
    const probes = createNodeDoctorProbes({
      localExecutor: local.executor,
      worktreeRoot: '/worktrees',
    });
    await expect(probes.worktreeRootWritable('local')).resolves.toBe(true);
    expect(local.calls[0]?.argv).toEqual(['test', '-w', '/worktrees']);
    expect(local.calls[0]?.options?.timeoutMs).toBe(10_000);
  });

  it('passes a configured timeout budget to every platform probe', async () => {
    const local = fakeExecutor({});
    const probes = createNodeDoctorProbes({ localExecutor: local.executor, timeoutMs: 2_500 });
    await probes.commandAvailable('local', 'sh');
    expect(local.calls[0]?.options?.timeoutMs).toBe(2_500);
  });

  it('resolves the bundled ocm-run binary and its sha256 through the executor', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'doctor-probes-'));
    const binaryPath = join(repoRoot, 'bin', 'ocm-run');
    mkdirSync(join(repoRoot, 'bin'), { recursive: true });
    writeFileSync(binaryPath, '#!/bin/sh\n');
    const hash = '5'.repeat(64);
    const local = fakeExecutor({ stdout: `${hash}  ${binaryPath}\n` });
    const probes = createNodeDoctorProbes({ localExecutor: local.executor, repoRoot });
    await expect(probes.ocmRunBinary()).resolves.toEqual({
      path: binaryPath,
      sha256: hash,
    });
    expect(local.calls[0]?.argv).toEqual(['sha256sum', binaryPath]);
  });

  it('falls back to `shasum -a 256` when sha256sum is missing', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'doctor-probes-'));
    const binaryPath = join(repoRoot, 'bin', 'ocm-run');
    mkdirSync(join(repoRoot, 'bin'), { recursive: true });
    writeFileSync(binaryPath, '#!/bin/sh\n');
    const hash = '6'.repeat(64);
    const local = fakeExecutor(({ argv }) =>
      argv[0] === 'sha256sum'
        ? { exitCode: null, signal: null, stdout: '', stderr: '', error: 'spawn ENOENT' }
        : { exitCode: 0, signal: null, stdout: `${hash}  ${binaryPath}\n`, stderr: '' },
    );
    const probes = createNodeDoctorProbes({ localExecutor: local.executor, repoRoot });
    await expect(probes.ocmRunBinary()).resolves.toEqual({
      path: binaryPath,
      sha256: hash,
    });
    expect(local.calls.map((call) => call.argv)).toEqual([
      ['sha256sum', binaryPath],
      ['shasum', '-a', '256', binaryPath],
    ]);
  });

  it('returns undefined when the bundled binary or a well-formed hash is missing', async () => {
    const probes = createNodeDoctorProbes({
      repoRoot: mkdtempSync(join(tmpdir(), 'doctor-probes-')),
    });
    await expect(probes.ocmRunBinary()).resolves.toBeUndefined();

    const shortHash = fakeExecutor({ stdout: 'tooshort  /bin/ocm-run\n' });
    const repoRoot = mkdtempSync(join(tmpdir(), 'doctor-probes-'));
    mkdirSync(join(repoRoot, 'bin'), { recursive: true });
    writeFileSync(join(repoRoot, 'bin', 'ocm-run'), '#!/bin/sh\n');
    const shortProbes = createNodeDoctorProbes({
      localExecutor: shortHash.executor,
      repoRoot,
    });
    await expect(shortProbes.ocmRunBinary()).resolves.toBeUndefined();
  });

  it('reads the expected ocm-run hash as the first field of the pin file', async () => {
    const hash = 'a'.repeat(64);
    const probes = createNodeDoctorProbes({
      repoRoot: '/repo',
      readTextFile: async (path) => {
        expect(path).toBe('/repo/scripts/ocm-run-hash.txt');
        return `${hash}  bin/ocm-run\n`;
      },
    });
    await expect(probes.expectedOcmRunHash()).resolves.toBe(hash);

    const unreadable = createNodeDoctorProbes({
      repoRoot: '/repo',
      readTextFile: async () => {
        throw new Error('ENOENT');
      },
    });
    await expect(unreadable.expectedOcmRunHash()).resolves.toBeUndefined();

    const malformed = createNodeDoctorProbes({
      repoRoot: '/repo',
      readTextFile: async () => 'not a hash\n',
    });
    await expect(malformed.expectedOcmRunHash()).resolves.toBeUndefined();
  });

  it('builds and runs the one-step seat probe only when called', async () => {
    const local = fakeExecutor({});
    const probes = createNodeDoctorProbes({ localExecutor: local.executor });
    await expect(probes.seatProbe(seat)).resolves.toEqual({
      outcome: 'pass',
      reason: 'one-step seat probe answered',
    });
    expect(local.calls[0]?.argv).toEqual([
      'claude',
      '-p',
      '--model',
      'glm-5.3',
      'Reply with the single word OK and nothing else.',
    ]);
    expect(local.calls[0]?.options?.timeoutMs).toBe(60_000);
    expect(local.calls).toHaveLength(1);
  });

  it('maps a failing or erroring seat probe to fail or unknown', async () => {
    const failing = fakeExecutor({ exitCode: 1, stdout: '' });
    const probes = createNodeDoctorProbes({ localExecutor: failing.executor });
    await expect(probes.seatProbe(seat)).resolves.toEqual({
      outcome: 'fail',
      reason: 'one-step seat probe exited 1',
    });

    const erroring = fakeExecutor({
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: 'spawn ENOENT',
    });
    const errorProbes = createNodeDoctorProbes({ localExecutor: erroring.executor });
    await expect(errorProbes.seatProbe(seat)).resolves.toEqual({
      outcome: 'unknown',
      reason: 'seat probe failed to run (spawn ENOENT)',
    });

    const unknownTool = createNodeDoctorProbes({ localExecutor: fakeExecutor({}).executor });
    await expect(
      unknownTool.seatProbe({ ...seat, tool: 'nope' }),
    ).resolves.toEqual({
      outcome: 'unknown',
      reason: 'seat tool nope has no probe descriptor',
    });
  });

  it('probes every built-in tool through its own descriptor version argv', async () => {
    const local = fakeExecutor({ stdout: '1.0.0\n' });
    const probes = createNodeDoctorProbes({ localExecutor: local.executor });
    for (const descriptor of BUILT_IN_TOOLS) {
      await expect(probes.toolVersion('local', descriptor.id)).resolves.toBe('1.0.0');
    }
    expect(local.calls.map((call) => call.argv)).toEqual(
      BUILT_IN_TOOLS.map((tool) => [...tool.detect.argv]),
    );
  });
});

describe('seatProbeArgv', () => {
  it('keeps the variant flag when the seat pins one', () => {
    expect(
      seatProbeArgv(
        { ...seat, tool: 'agy' },
        ['agy', 'run', '-m', '{model}', '--variant', '{variant}', '{prompt}'],
      ),
    ).toEqual(['agy', 'run', '-m', 'glm-5.3', '--variant', 'none', 'Reply with the single word OK and nothing else.']);
  });

  it('drops the variant flag and its value slot when the seat pins none', () => {
    expect(
      seatProbeArgv(
        { ...seat, tool: 'agy', variant: undefined },
        ['agy', 'run', '-m', '{model}', '--variant', '{variant}', '{prompt}'],
      ),
    ).toEqual(['agy', 'run', '-m', 'glm-5.3', 'Reply with the single word OK and nothing else.']);
  });

  it('folds opencode’s combined model#variant token back to the bare model without a variant', () => {
    expect(
      seatProbeArgv(
        { ...seat, tool: 'opencode', variant: 'none' },
        ['opencode', 'run', '-m', '{model}#{variant}', '{prompt}'],
      ),
    ).toEqual(['opencode', 'run', '-m', 'glm-5.3#none', 'Reply with the single word OK and nothing else.']);
    expect(
      seatProbeArgv(
        { ...seat, tool: 'opencode', variant: undefined },
        ['opencode', 'run', '-m', '{model}#{variant}', '{prompt}'],
      ),
    ).toEqual(['opencode', 'run', '-m', 'glm-5.3', 'Reply with the single word OK and nothing else.']);
  });
});
