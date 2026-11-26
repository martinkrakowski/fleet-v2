/**
 * The node doctor probes against injected fake executors. Every test asserts
 * the exact argv the probes run (local execFile vs the
 * `ssh <alias> -- sh -c '<quoted command line>'` wrapper), the timeout
 * budget they pass, and that no probe ever reads a credential file's
 * contents — fileMode only stats.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// `resolveRepoRoot` walks up from this module's own URL; pointing
// `fileURLToPath` at a path with no `bin/ocm-run` ancestor makes the
// auto-resolution fail, which is how the unresolved-repoRoot tests force
// the refusal path. Every other `node:url` export stays real.
vi.mock('node:url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:url')>();
  return {
    ...actual,
    fileURLToPath: () => '/nonexistent-fleet-doctor-probes-root',
  };
});

import { BUILT_IN_TOOLS, type ToolId } from '@fleet/tooling';

import type { SeatModel } from '@fleet/installation';

import { GH_BINARY_CANDIDATES, hasGhTokenEnv } from '../gh-binary.js';
import type {
  DoctorCommandExecutor,
  DoctorCommandRunOptions,
  DoctorCommandRunResult,
} from '../probes-node.js';
import {
  createNodeDoctorExecutor,
  createNodeDoctorProbes,
  DISK_QUOTA_FILE,
  DISK_QUOTA_MAX_CHARS,
  LOGIN_SHELL_CANARY,
  parseDiskQuotaUsage,
  seatProbeArgv,
  serverModelIds,
} from '../probes-node.js';
import { posixQuote } from '../ssh-remote.js';

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
      'sh',
      '-c',
      "''\\''true'\\'''",
    ]);
    expect(local.calls[0]?.options?.timeoutMs).toBe(10_000);
  });

  it('sends the commandAvailable probe over ssh as one quoted sh -c word', async () => {
    const ssh = fakeExecutor({});
    const probes = createNodeDoctorProbes({ localExecutor: ssh.executor });
    await expect(probes.commandAvailable('lane-host', 'nc')).resolves.toBe(true);
    expect(ssh.calls[0]?.argv).toEqual([
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      'lane-host',
      '--',
      'sh',
      '-c',
      "''\\''sh'\\'' '\\''-c'\\'' '\\''command -v nc'\\'''",
    ]);
    expect(ssh.calls[0]?.options?.timeoutMs).toBe(10_000);
  });

  it('refuses an unsafe ssh host or a NUL-bearing argv without reaching the executor', async () => {
    const ssh = fakeExecutor({});
    const probes = createNodeDoctorProbes({
      localExecutor: ssh.executor,
      worktreeRoot: '/worktrees',
    });
    await expect(probes.hostReachable('bad host')).resolves.toBe(false);
    await expect(probes.worktreeRootWritable('-dash-alias')).resolves.toBe(false);
    await expect(probes.fileMode('lane-host', '/bad\0path')).resolves.toBeUndefined();
    expect(ssh.calls).toHaveLength(0);
  });

  it('maps a refused ssh alias to the failed answer of commandAvailable, toolVersion and serverProbe without spawning', async () => {
    const ssh = fakeExecutor({});
    const probes = createNodeDoctorProbes({ localExecutor: ssh.executor });
    for (const alias of ['bad host', '-dash-alias', '']) {
      await expect(probes.commandAvailable(alias, 'sh')).resolves.toBe(false);
      await expect(probes.toolVersion(alias, 'claude-code')).resolves.toBeUndefined();
      await expect(probes.serverProbe(alias, 4096)).resolves.toEqual({
        outcome: 'unknown',
        reason: 'the server probe could not be run',
      });
    }
    expect(ssh.calls).toHaveLength(0);
  });

  it('answers commandAvailable over ssh through the real /bin/sh quoted form', async () => {
    // The ssh executor is translated, not faked: ssh hands the words after
    // `--` to the remote login shell as one space-joined command line, so
    // the translation runs that line through the real local /bin/sh.
    const real = createNodeDoctorExecutor();
    const translated: DoctorCommandExecutor = {
      async run(argv, options) {
        const split = argv.indexOf('--');
        return real.run(['/bin/sh', '-c', argv.slice(split + 1).join(' ')], options);
      },
    };
    const probes = createNodeDoctorProbes({ sshExecutor: translated });
    await expect(probes.commandAvailable('lane-host', 'sh')).resolves.toBe(true);
    await expect(probes.commandAvailable('lane-host', 'no-such-doctor-tool-anywhere')).resolves.toBe(
      false,
    );
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
      'sh',
      '-c',
      "''\\''claude'\\'' '\\''--version'\\'''",
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

  it('passes the configured budget to every ssh probe and the fixed connect budget to reachability', async () => {
    const fake = fakeExecutor({ stdout: '200' });
    const probes = createNodeDoctorProbes({ localExecutor: fake.executor, timeoutMs: 2_500 });
    await probes.hostReachable('lane-host');
    await probes.commandAvailable('lane-host', 'sh');
    await probes.toolVersion('lane-host', 'claude-code');
    await probes.ciRunnerSlot!('lane-host', 'fleet-ci@1.service');
    await probes.serverProbe('lane-host', 4166);
    // serverProbe makes two runs: the first answers 200, so the model list is asked too.
    expect(fake.calls.map((call) => call.options?.timeoutMs)).toEqual([
      10_000, 2_500, 2_500, 2_500, 2_500, 2_500,
    ]);
    expect(fake.calls.map((call) => call.argv[0])).toEqual(['ssh', 'ssh', 'ssh', 'ssh', 'ssh', 'ssh']);
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

  it('resolves gh from injected ghBinaryCandidates via real filesystem checks', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'gh-probes-'));
    try {
      const executablePath = join(tempDir, 'gh-exec');
      writeFileSync(executablePath, '#!/bin/sh\n');
      chmodSync(executablePath, 0o755);
      const candidates = [executablePath, '/nonexistent/gh'];
      const probes = createNodeDoctorProbes({ ghBinaryCandidates: candidates });
      await expect(probes.ghBinary!()).resolves.toEqual({ resolved: executablePath, candidates });

      const nonExecutablePath = join(tempDir, 'gh-noexec');
      writeFileSync(nonExecutablePath, '#!/bin/sh\n');
      chmodSync(nonExecutablePath, 0o644);
      const probes2 = createNodeDoctorProbes({ ghBinaryCandidates: [nonExecutablePath] });
      await expect(probes2.ghBinary!()).resolves.toEqual({
        resolved: undefined,
        candidates: [nonExecutablePath],
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('defaults gh binary candidates to the fixed reviewed list', async () => {
    const probes = createNodeDoctorProbes();
    const result = await probes.ghBinary!();
    expect(result?.candidates).toEqual(GH_BINARY_CANDIDATES);
  });

  it('returns fail without spawning gh when no token variable is present', async () => {
    const local = fakeExecutor({});
    const probes = createNodeDoctorProbes({ localExecutor: local.executor, serviceEnv: {} });
    await expect(probes.ghAuth!('/usr/bin/gh')).resolves.toEqual({
      tokenPresent: false,
      authCheck: { outcome: 'fail', reason: 'no GH_TOKEN or GITHUB_TOKEN in service environment' },
    });
    // An empty-string token is as good as absent; nothing is spawned either way.
    await expect(
      probes.ghAuth!('/usr/bin/gh'),
    ).resolves.toMatchObject({ tokenPresent: false });
    expect(local.calls).toHaveLength(0);
    const emptyTokenProbes = createNodeDoctorProbes({
      localExecutor: fakeExecutor({}).executor,
      serviceEnv: { GH_TOKEN: '' },
    });
    await expect(emptyTokenProbes.ghAuth!('/usr/bin/gh')).resolves.toMatchObject({
      tokenPresent: false,
      authCheck: { outcome: 'fail' },
    });
  });

  it('maps non-zero gh auth status exit to fail without leaking stdout or stderr', async () => {
    const local = fakeExecutor({
      exitCode: 1,
      signal: null,
      stdout: 'Logged in to github.com account octocat',
      stderr: 'secret detail',
    });
    const probes = createNodeDoctorProbes({
      localExecutor: local.executor,
      serviceEnv: { GH_TOKEN: 'token-value' },
    });
    await expect(probes.ghAuth!('/usr/bin/gh')).resolves.toEqual({
      tokenPresent: true,
      authCheck: { outcome: 'fail', reason: 'gh auth status failed' },
    });
    expect(local.calls).toEqual([
      { argv: ['/usr/bin/gh', 'auth', 'status'], options: { timeoutMs: 5_000 } },
    ]);
  });

  it('maps spawn error or empty binary path to unknown', async () => {
    const local = fakeExecutor({
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: 'spawn ENOENT',
    });
    const probes = createNodeDoctorProbes({
      localExecutor: local.executor,
      serviceEnv: { GH_TOKEN: 'token-value' },
    });
    await expect(probes.ghAuth!('/usr/bin/gh')).resolves.toEqual({
      tokenPresent: true,
      authCheck: { outcome: 'unknown', reason: 'gh auth status timed out or could not be run' },
    });
    await expect(probes.ghAuth!('   ')).resolves.toEqual({
      tokenPresent: true,
      authCheck: { outcome: 'unknown', reason: 'gh auth status could not be run' },
    });
  });

  it('maps timed-out or signaled gh auth status to unknown', async () => {
    const local = fakeExecutor({
      exitCode: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
    });
    const probes = createNodeDoctorProbes({
      localExecutor: local.executor,
      serviceEnv: { GH_TOKEN: 'token-value' },
    });
    await expect(probes.ghAuth!('/usr/bin/gh')).resolves.toEqual({
      tokenPresent: true,
      authCheck: { outcome: 'unknown', reason: 'gh auth status timed out or could not be run' },
    });
    expect(local.calls).toHaveLength(1);
  });

  it('returns unknown when ghAuthTimeoutMs budget is exhausted', async () => {
    const local = fakeExecutor({});
    const probes = createNodeDoctorProbes({
      localExecutor: local.executor,
      serviceEnv: { GH_TOKEN: 'token-value' },
      ghAuthTimeoutMs: 0,
    });
    await expect(probes.ghAuth!('/usr/bin/gh')).resolves.toEqual({
      tokenPresent: true,
      authCheck: { outcome: 'unknown', reason: 'gh auth status could not be run' },
    });
    const negative = createNodeDoctorProbes({
      localExecutor: local.executor,
      serviceEnv: { GH_TOKEN: 'token-value' },
      ghAuthTimeoutMs: -1,
    });
    await expect(negative.ghAuth!('/usr/bin/gh')).resolves.toMatchObject({
      authCheck: { outcome: 'unknown' },
    });
    expect(local.calls).toHaveLength(0);
  });

  it('passes a positive ghAuthTimeoutMs budget to the executor', async () => {
    const local = fakeExecutor({});
    const probes = createNodeDoctorProbes({
      localExecutor: local.executor,
      serviceEnv: { GH_TOKEN: 'token-value' },
      ghAuthTimeoutMs: 1_234,
    });
    await expect(probes.ghAuth!('/usr/bin/gh')).resolves.toMatchObject({
      authCheck: { outcome: 'pass', reason: 'gh auth status succeeded' },
    });
    expect(local.calls).toEqual([
      { argv: ['/usr/bin/gh', 'auth', 'status'], options: { timeoutMs: 1_234 } },
    ]);
  });

  it('honours a serviceEnv function and treats null or undefined env as no token', async () => {
    const local = fakeExecutor({});
    const probes = createNodeDoctorProbes({
      localExecutor: local.executor,
      serviceEnv: () => ({ GITHUB_TOKEN: 'token-value' }),
    });
    await expect(probes.ghAuth!('/usr/bin/gh')).resolves.toMatchObject({ tokenPresent: true });
    const nullEnv = createNodeDoctorProbes({
      localExecutor: fakeExecutor({}).executor,
      // The guard exists for embedders that hand a null environment through
      // the wider `Readonly<Record<...>>` type.
      serviceEnv: null as unknown as Readonly<Record<string, string | undefined>>,
    });
    await expect(nullEnv.ghAuth!('/usr/bin/gh')).resolves.toMatchObject({
      tokenPresent: false,
    });
    // Only the token-bearing reader spawned `gh`; the null env did not.
    expect(local.calls).toEqual([
      { argv: ['/usr/bin/gh', 'auth', 'status'], options: { timeoutMs: 5_000 } },
    ]);
  });

  it('rejects on a throwing serviceEnv getter so doctor turns it into unknown', async () => {
    const throwingEnv = Object.defineProperties(
      {} as Record<string, string | undefined>,
      {
        GH_TOKEN: {
          get() {
            throw new Error('unreadable');
          },
          enumerable: true,
        },
      },
    );
    const probes = createNodeDoctorProbes({ serviceEnv: throwingEnv });
    await expect(probes.ghAuth!('/usr/bin/gh')).rejects.toThrow('unreadable');
    const throwingReader = createNodeDoctorProbes({
      serviceEnv: () => {
        throw new Error('env unavailable');
      },
    });
    await expect(throwingReader.ghAuth!('/usr/bin/gh')).rejects.toThrow('env unavailable');
  });

  it('hasGhTokenEnv checks both variable names and never exposes values', () => {
    expect(hasGhTokenEnv(undefined)).toBe(false);
    expect(hasGhTokenEnv(null)).toBe(false);
    expect(hasGhTokenEnv({} as Record<string, string | undefined>)).toBe(false);
    expect(hasGhTokenEnv([] as unknown as Record<string, string | undefined>)).toBe(false);
    expect(hasGhTokenEnv({ GH_TOKEN: '  ' })).toBe(false);
    expect(hasGhTokenEnv({ GITHUB_TOKEN: 'x' })).toBe(true);
    expect(hasGhTokenEnv({ GH_TOKEN: 'x' })).toBe(true);
  });

  it('probes the server with two curl runs and parses the listed models', async () => {
    const local = fakeExecutor(({ argv }) =>
      argv.some((arg) => arg.endsWith('/api/model'))
        ? {
            exitCode: 0,
            signal: null,
            stdout: '{"data":{"models":{"acme/alpha-1":{"variants":["high"]}}}}',
            stderr: '',
          }
        : { exitCode: 0, signal: null, stdout: '200', stderr: '' },
    );
    const probes = createNodeDoctorProbes({ localExecutor: local.executor });
    await expect(probes.serverProbe('local', 4096)).resolves.toEqual({
      outcome: 'pass',
      reason: 'the opencode server on 127.0.0.1:4096 answered',
      models: ['acme/alpha-1', 'acme/alpha-1#high'],
    });
    expect(local.calls.map((call) => call.argv)).toEqual([
      [
        'curl',
        '-sS',
        '--max-time',
        '5',
        '--noproxy',
        '127.0.0.1,localhost',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        'http://127.0.0.1:4096/api/info',
      ],
      ['curl', '-sS', '--max-time', '5', '--noproxy', '127.0.0.1,localhost', 'http://127.0.0.1:4096/api/model'],
    ]);
  });

  it('bypasses any proxy for loopback (--noproxy 127.0.0.1,localhost, no glob for a remote shell) in every loopback curl probe', async () => {
    const local = fakeExecutor(({ argv }) =>
      argv.some((arg) => arg.endsWith('/api/model'))
        ? { exitCode: 0, signal: null, stdout: '{"data":{"models":{}}}', stderr: '' }
        : { exitCode: 0, signal: null, stdout: '200', stderr: '' },
    );
    const probes = createNodeDoctorProbes({ localExecutor: local.executor });
    await probes.serverProbe('local', 4096);

    expect(local.calls).toHaveLength(2);
    for (const call of local.calls) {
      const noproxyIndex = call.argv.indexOf('--noproxy');
      expect(noproxyIndex).toBeGreaterThan(-1);
      expect(call.argv[noproxyIndex + 1]).toBe('127.0.0.1,localhost');
    }
  });

  it('sends the server probe argv over ssh without a tunnel or credential', async () => {
    const ssh = fakeExecutor(({ argv }) =>
      argv.some((arg) => arg.includes('/api/model'))
        ? {
            exitCode: 0,
            signal: null,
            stdout: '{"data":{"models":{"acme/alpha-1":{"variants":["high"]}}}}',
            stderr: '',
          }
        : { exitCode: 0, signal: null, stdout: '200', stderr: '' },
    );
    const probes = createNodeDoctorProbes({ localExecutor: ssh.executor });
    await expect(probes.serverProbe('lane-host', 4166)).resolves.toEqual({
      outcome: 'pass',
      reason: 'the opencode server on 127.0.0.1:4166 answered',
      models: ['acme/alpha-1', 'acme/alpha-1#high'],
    });
    expect(ssh.calls[0]?.argv).toEqual([
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      'lane-host',
      '--',
      'sh',
      '-c',
      "''\\''curl'\\'' '\\''-sS'\\'' '\\''--max-time'\\'' '\\''5'\\'' '\\''--noproxy'\\'' '\\''127.0.0.1,localhost'\\'' '\\''-o'\\'' '\\''/dev/null'\\'' '\\''-w'\\'' '\\''%{http_code}'\\'' '\\''http://127.0.0.1:4166/api/info'\\'''",
    ]);
    expect(ssh.calls).toHaveLength(2);
    expect(ssh.calls[1]?.argv).toEqual([
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      'lane-host',
      '--',
      'sh',
      '-c',
      "''\\''curl'\\'' '\\''-sS'\\'' '\\''--max-time'\\'' '\\''5'\\'' '\\''--noproxy'\\'' '\\''127.0.0.1,localhost'\\'' '\\''http://127.0.0.1:4166/api/model'\\'''",
    ]);
    expect(ssh.calls[0]?.options?.timeoutMs).toBe(10_000);
    expect(ssh.calls[1]?.options?.timeoutMs).toBe(10_000);
  });

  it('maps a non-zero exit and a spawn error to UNKNOWN without printing a body', async () => {
    const down = fakeExecutor({ exitCode: 7, stdout: '', stderr: '' });
    const downProbes = createNodeDoctorProbes({ localExecutor: down.executor });
    await expect(downProbes.serverProbe('local', 4096)).resolves.toEqual({
      outcome: 'unknown',
      reason: 'the opencode server on 127.0.0.1:4096 did not answer',
    });

    const erroring = fakeExecutor({
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: 'spawn ENOENT',
    });
    const errorProbes = createNodeDoctorProbes({ localExecutor: erroring.executor });
    await expect(errorProbes.serverProbe('local', 4096)).resolves.toEqual({
      outcome: 'unknown',
      reason: 'the server probe could not be run',
    });
  });

  it('maps 401 and 403 to unknown, another status to fail, and an unreadable model list to a pass without models', async () => {
    for (const code of ['401', '403']) {
      const locked = fakeExecutor({ stdout: code });
      const probes = createNodeDoctorProbes({ localExecutor: locked.executor });
      await expect(probes.serverProbe('local', 4096)).resolves.toEqual({
        outcome: 'unknown',
        reason: 'the opencode server on 127.0.0.1:4096 requires authentication',
      });
      expect(locked.calls).toHaveLength(1);
    }

    const broken = fakeExecutor({ stdout: '500' });
    const brokenProbes = createNodeDoctorProbes({ localExecutor: broken.executor });
    await expect(brokenProbes.serverProbe('local', 4096)).resolves.toEqual({
      outcome: 'fail',
      reason: 'the opencode server on 127.0.0.1:4096 answered HTTP 500',
    });
    expect(broken.calls).toHaveLength(1);

    const modelAnswers: DoctorCommandRunResult[] = [
      { exitCode: 22, signal: null, stdout: '', stderr: '' },
      { exitCode: null, signal: null, stdout: '', stderr: '', error: 'spawn ENOENT' },
      { exitCode: 0, signal: null, stdout: 'not json', stderr: '' },
    ];
    for (const modelAnswer of modelAnswers) {
      const fake = fakeExecutor(({ argv }) =>
        argv.some((arg) => arg.endsWith('/api/model'))
          ? modelAnswer
          : { exitCode: 0, signal: null, stdout: '200', stderr: '' },
      );
      const probes = createNodeDoctorProbes({ localExecutor: fake.executor });
      await expect(probes.serverProbe('local', 4096)).resolves.toEqual({
        outcome: 'pass',
        reason: 'the opencode server on 127.0.0.1:4096 answered',
      });
      expect(fake.calls).toHaveLength(2);
    }
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

describe('createNodeDoctorProbes pinned-build (DB1)', () => {
  const HEAD = 'a'.repeat(40);
  const TIP = 'b'.repeat(40);

  /** A fake executor answering per git subcommand. */
  function gitExecutor(
    answers: Record<string, Partial<DoctorCommandRunResult>>,
  ): { executor: DoctorCommandExecutor; calls: RecordedCall[] } {
    return fakeExecutor(({ argv }) => {
      const key = argv.slice(0, 2).join(' ');
      const answer = answers[key];
      if (answer === undefined) {
        throw new Error(`unexpected argv ${key}`);
      }
      return {
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        ...answer,
      };
    });
  }

  it('reads pinnedCommit, baseTipCommit, behindCount, and installRootName via git argv arrays', async () => {
    // `rev-parse` answers HEAD first, the base branch second; distinguish
    // them by the third argv element.
    const calls: RecordedCall[] = [];
    const executor: DoctorCommandExecutor = {
      async run(argv, options) {
        calls.push({ argv, options });
        if (argv[2] === 'HEAD') {
          return { exitCode: 0, signal: null, stdout: `${TIP}\n`, stderr: '' };
        }
        if (argv[2] === 'origin/main') {
          return { exitCode: 0, signal: null, stdout: `${TIP}\n`, stderr: '' };
        }
        throw new Error(`unexpected argv ${argv.join(' ')}`);
      },
    };
    const probes = createNodeDoctorProbes({
      localExecutor: executor,
      repoRoot: '/srv/fleet/instances/prod-1',
    });
    await expect(probes.pinnedBuild!()).resolves.toEqual({
      pinnedCommit: TIP,
      baseTipCommit: TIP,
      behindCount: 0,
      installRootName: 'prod-1',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].argv).toEqual(['git', 'rev-parse', 'HEAD']);
    expect(calls[0].options).toEqual({ cwd: '/srv/fleet/instances/prod-1', timeoutMs: 10_000 });
    expect(calls[1].argv).toEqual(['git', 'rev-parse', 'origin/main']);
  });

  it('runs rev-list --count with the commit range when the commits differ', async () => {
    const calls: RecordedCall[] = [];
    const executor: DoctorCommandExecutor = {
      async run(argv, options) {
        calls.push({ argv, options });
        if (argv[2] === 'HEAD') {
          return { exitCode: 0, signal: null, stdout: `${HEAD}\n`, stderr: '' };
        }
        if (argv[2] === 'origin/main') {
          return { exitCode: 0, signal: null, stdout: `${TIP}\n`, stderr: '' };
        }
        return { exitCode: 0, signal: null, stdout: '8\n', stderr: '' };
      },
    };
    const probes = createNodeDoctorProbes({ localExecutor: executor, repoRoot: '/repo' });
    await expect(probes.pinnedBuild!()).resolves.toEqual({
      pinnedCommit: HEAD,
      baseTipCommit: TIP,
      behindCount: 8,
      installRootName: 'repo',
    });
    expect(calls[2].argv).toEqual(['git', 'rev-list', '--count', `${HEAD}..${TIP}`]);
    expect(calls[2].options).toEqual({ cwd: '/repo', timeoutMs: 10_000 });
  });

  it('honours a custom baseBranch dependency', async () => {
    const calls: RecordedCall[] = [];
    const executor: DoctorCommandExecutor = {
      async run(argv) {
        calls.push({ argv });
        if (argv[2] === 'HEAD') {
          return { exitCode: 0, signal: null, stdout: `${HEAD}\n`, stderr: '' };
        }
        return { exitCode: 0, signal: null, stdout: `${HEAD}\n`, stderr: '' };
      },
    };
    const probes = createNodeDoctorProbes({
      localExecutor: executor,
      repoRoot: '/repo',
      baseBranch: 'origin/trunk',
    });
    await expect(probes.pinnedBuild!()).resolves.toMatchObject({ behindCount: 0 });
    expect(calls[1].argv).toEqual(['git', 'rev-parse', 'origin/trunk']);
  });

  it('returns undefined commits when repoRoot is unresolved', async () => {
    const local = fakeExecutor({});
    const probes = createNodeDoctorProbes({ localExecutor: local.executor });
    await expect(probes.pinnedBuild!()).resolves.toEqual({
      pinnedCommit: undefined,
      baseTipCommit: undefined,
      behindCount: undefined,
    });
    expect(local.calls).toHaveLength(0);
  });

  it('returns undefined pinnedCommit when git rev-parse HEAD fails or times out', async () => {
    const calls: RecordedCall[] = [];
    const executor: DoctorCommandExecutor = {
      async run(argv) {
        calls.push({ argv });
        if (argv[2] === 'HEAD') {
          return { exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '' };
        }
        return { exitCode: 0, signal: null, stdout: `${TIP}\n`, stderr: '' };
      },
    };
    const probes = createNodeDoctorProbes({ localExecutor: executor, repoRoot: '/repo' });
    const result = (await probes.pinnedBuild!())!;
    expect(result.pinnedCommit).toBeUndefined();
    expect(result.baseTipCommit).toBe(TIP);
    expect(result.behindCount).toBeUndefined();
    const erroring = gitExecutor({ 'git rev-parse': { error: 'spawn ENOENT' } });
    const probes2 = createNodeDoctorProbes({
      localExecutor: erroring.executor,
      repoRoot: '/repo',
    });
    await expect(probes2.pinnedBuild!()).resolves.toMatchObject({
      pinnedCommit: undefined,
      baseTipCommit: undefined,
      behindCount: undefined,
    });
  });

  it('returns undefined baseTipCommit when git rev-parse base branch fails', async () => {
    const executor: DoctorCommandExecutor = {
      async run(argv) {
        if (argv[2] === 'HEAD') {
          return { exitCode: 0, signal: null, stdout: `${HEAD}\n`, stderr: '' };
        }
        return { exitCode: 128, signal: null, stdout: '', stderr: 'unknown revision' };
      },
    };
    const probes = createNodeDoctorProbes({ localExecutor: executor, repoRoot: '/repo' });
    const result = (await probes.pinnedBuild!())!;
    expect(result.pinnedCommit).toBe(HEAD);
    expect(result.baseTipCommit).toBeUndefined();
    expect(result.behindCount).toBeUndefined();
  });

  it('rejects malformed rev-parse output as an unreadable commit', async () => {
    const executor: DoctorCommandExecutor = {
      async run(argv) {
        if (argv[2] === 'HEAD') {
          return { exitCode: 0, signal: null, stdout: 'not-a-sha\n', stderr: '' };
        }
        return { exitCode: 0, signal: null, stdout: `${TIP}\n`, stderr: '' };
      },
    };
    const probes = createNodeDoctorProbes({ localExecutor: executor, repoRoot: '/repo' });
    const result = (await probes.pinnedBuild!())!;
    expect(result.pinnedCommit).toBeUndefined();
    expect(result.baseTipCommit).toBe(TIP);
  });

  it('accepts only one well-formed sha line from git rev-parse', async () => {
    const bad = [
      `not-a-sha\n${HEAD}\n`,
      `${HEAD}\nnot-a-sha\n`,
      `${HEAD}\n${HEAD}\n`,
      `\n${HEAD}\n`,
      `${HEAD}\r\n`,
      `${HEAD}\n\n`,
      ` ${HEAD}\n`,
      `${'A'.repeat(40)}\n`,
      `${'a'.repeat(39)}\n`,
      `${'a'.repeat(41)}\n`,
      '',
    ];
    for (const stdout of bad) {
      const executor: DoctorCommandExecutor = {
        async run(argv) {
          return {
            exitCode: 0,
            signal: null,
            stdout: argv[2] === 'HEAD' ? stdout : `${TIP}\n`,
            stderr: '',
          };
        },
      };
      const probes = createNodeDoctorProbes({ localExecutor: executor, repoRoot: '/repo' });
      const result = (await probes.pinnedBuild!())!;
      expect(result.pinnedCommit, JSON.stringify(stdout)).toBeUndefined();
    }
    for (const stdout of [HEAD, `${HEAD}\n`]) {
      const executor: DoctorCommandExecutor = {
        async run(argv) {
          return { exitCode: 0, signal: null, stdout: argv[2] === 'HEAD' ? stdout : `${TIP}\n`, stderr: '' };
        },
      };
      const probes = createNodeDoctorProbes({ localExecutor: executor, repoRoot: '/repo' });
      expect((await probes.pinnedBuild!())!.pinnedCommit).toBe(HEAD);
    }
  });

  it('accepts only one well-formed integer from git rev-list --count', async () => {
    const run = async (countOut: string) => {
      const executor: DoctorCommandExecutor = {
        async run(argv) {
          if (argv[1] === 'rev-list') {
            return { exitCode: 0, signal: null, stdout: countOut, stderr: '' };
          }
          return { exitCode: 0, signal: null, stdout: argv[2] === 'HEAD' ? `${HEAD}\n` : `${TIP}\n`, stderr: '' };
        },
      };
      const probes = createNodeDoctorProbes({ localExecutor: executor, repoRoot: '/repo' });
      return (await probes.pinnedBuild!())!.behindCount;
    };
    for (const bad of ['3\n4\n', 'x\n3\n', '\n3\n', '3\r\n', '3\n\n', ' 3\n', '', '99999999999999999999\n']) {
      expect(await run(bad), JSON.stringify(bad)).toBeUndefined();
    }
    expect(await run('7\n')).toBe(7);
    expect(await run('7')).toBe(7);
  });

  it('returns undefined behindCount when git rev-list fails or outputs non-integer', async () => {
    for (const answer of [
      { exitCode: 1, signal: null, stdout: '', stderr: 'boom' },
      { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '' },
      { exitCode: 0, signal: null, stdout: 'many\n', stderr: '' },
      { exitCode: 0, signal: null, stdout: '-3\n', stderr: '' },
      { exitCode: 0, signal: null, stdout: '2.5\n', stderr: '' },
    ] satisfies Partial<DoctorCommandRunResult>[]) {
      const executor: DoctorCommandExecutor = {
        async run(argv) {
          if (argv[0] === 'git' && argv[1] === 'rev-list') {
            return answer;
          }
          return {
            exitCode: 0,
            signal: null,
            stdout: argv[2] === 'HEAD' ? `${HEAD}\n` : `${TIP}\n`,
            stderr: '',
          };
        },
      };
      const probes = createNodeDoctorProbes({ localExecutor: executor, repoRoot: '/repo' });
      const result = (await probes.pinnedBuild!())!;
      expect(result.behindCount).toBeUndefined();
      expect(result.pinnedCommit).toBe(HEAD);
      expect(result.baseTipCommit).toBe(TIP);
    }
  });

  it('delegates to an injected readPinnedBuild without spawning git', async () => {
    const local = fakeExecutor({});
    const probes = createNodeDoctorProbes({
      localExecutor: local.executor,
      repoRoot: '/repo',
      readPinnedBuild: async () => ({
        pinnedCommit: HEAD,
        baseTipCommit: HEAD,
        behindCount: 0,
        installRootName: 'override',
      }),
    });
    await expect(probes.pinnedBuild!()).resolves.toEqual({
      pinnedCommit: HEAD,
      baseTipCommit: HEAD,
      behindCount: 0,
      installRootName: 'override',
    });
    expect(local.calls).toHaveLength(0);
  });
});

describe('createNodeDoctorProbes ciRunnerSlot (OG-28c)', () => {
  const UNIT = 'fleet-ci@1.service';

  it('runs systemctl is-active as one local argv with the probe budget and maps active', async () => {
    const local = fakeExecutor({ stdout: 'active\n' });
    const probes = createNodeDoctorProbes({ localExecutor: local.executor });
    await expect(probes.ciRunnerSlot!('local', UNIT)).resolves.toBe('active');
    expect(local.calls).toHaveLength(1);
    expect(local.calls[0]?.argv).toEqual(['systemctl', 'is-active', UNIT]);
    expect(local.calls[0]?.options?.timeoutMs).toBe(10_000);

    const noNewline = fakeExecutor({ stdout: 'active' });
    const probesNoNewline = createNodeDoctorProbes({ localExecutor: noNewline.executor });
    await expect(probesNoNewline.ciRunnerSlot!('local', UNIT)).resolves.toBe('active');
  });

  it('sends the slot probe over ssh as one quoted sh -c word', async () => {
    const ssh = fakeExecutor({ stdout: 'active\n' });
    const probes = createNodeDoctorProbes({ localExecutor: ssh.executor });
    await expect(probes.ciRunnerSlot!('lane-host', UNIT)).resolves.toBe('active');
    expect(ssh.calls).toHaveLength(1);
    expect(ssh.calls[0]?.argv).toEqual([
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      'lane-host',
      '--',
      'sh',
      '-c',
      "''\\''systemctl'\\'' '\\''is-active'\\'' '\\''fleet-ci@1.service'\\'''",
    ]);
  });

  it('maps a non-zero exit with a not-active state word to inactive', async () => {
    for (const word of ['inactive', 'failed', 'activating', 'deactivating', 'unknown']) {
      const withNewline = fakeExecutor({ exitCode: 3, stdout: `${word}\n` });
      const probesNewline = createNodeDoctorProbes({ localExecutor: withNewline.executor });
      await expect(probesNewline.ciRunnerSlot!('local', UNIT)).resolves.toBe('inactive');

      const bare = fakeExecutor({ exitCode: 3, stdout: word });
      const probesBare = createNodeDoctorProbes({ localExecutor: bare.executor });
      await expect(probesBare.ciRunnerSlot!('local', UNIT)).resolves.toBe('inactive');
    }
  });

  it('maps every other outcome to unknown', async () => {
    const outcomes: Partial<DoctorCommandRunResult>[] = [
      { exitCode: 0, stdout: '' },
      { exitCode: 0, stdout: 'inactive\n' },
      { exitCode: 0, stdout: 'Active\n' },
      { exitCode: 0, stdout: 'active\nactive\n' },
      { exitCode: 0, stdout: 'active\n\n' },
      { exitCode: 0, stdout: ' active\n' },
      { exitCode: 3, stdout: 'active\n' },
      { exitCode: 3, stdout: '' },
      { exitCode: 3, stdout: 'reloading\n' },
      { exitCode: 3, stdout: 'inactive\nextra\n' },
      { exitCode: 255, stdout: '' },
      { exitCode: null, signal: null, stdout: '', error: 'spawn ENOENT' },
      { exitCode: null, signal: 'SIGTERM', stdout: 'active\n' },
      { exitCode: 0, signal: 'SIGTERM', stdout: 'active\n' },
      { exitCode: 3, stdout: 42 as unknown as string },
    ];
    for (const outcome of outcomes) {
      const fake = fakeExecutor(outcome);
      const probes = createNodeDoctorProbes({ localExecutor: fake.executor });
      await expect(probes.ciRunnerSlot!('local', UNIT)).resolves.toBe('unknown');
    }
  });

  it('maps a CRLF answer, a reloading unit and a maintenance unit to unknown', async () => {
    const outcomes: Partial<DoctorCommandRunResult>[] = [
      { exitCode: 0, stdout: 'active\r\n' },
      { exitCode: 0, stdout: 'reloading\n' },
      { exitCode: 3, stdout: 'inactive\r\n' },
      { exitCode: 3, stdout: 'maintenance\n' },
      { exitCode: 0, stdout: 'maintenance\n' },
    ];
    for (const outcome of outcomes) {
      const fake = fakeExecutor(outcome);
      const probes = createNodeDoctorProbes({ localExecutor: fake.executor });
      await expect(probes.ciRunnerSlot!('local', UNIT)).resolves.toBe('unknown');
      expect(fake.calls).toHaveLength(1);
    }
  });

  it('refuses a unit that is not a plain service name without running anything', async () => {
    const fake = fakeExecutor({ stdout: 'active\n' });
    const probes = createNodeDoctorProbes({ localExecutor: fake.executor });
    for (const unit of [
      '-x.service',
      'fleet-ci@1.timer',
      'a b.service',
      'x;y.service',
      'x.service\n',
      '',
      `${'a'.repeat(129)}.service`,
      undefined as unknown as string,
    ]) {
      await expect(probes.ciRunnerSlot!('local', unit)).resolves.toBe('unknown');
      await expect(probes.ciRunnerSlot!('lane-host', unit)).resolves.toBe('unknown');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('maps a throwing executor and an unsafe ssh alias to unknown', async () => {
    const throwing = createNodeDoctorProbes({
      localExecutor: {
        async run() {
          throw new Error('boom');
        },
      },
    });
    await expect(throwing.ciRunnerSlot!('local', UNIT)).resolves.toBe('unknown');

    const safe = fakeExecutor({ stdout: 'active\n' });
    const probes = createNodeDoctorProbes({ localExecutor: safe.executor });
    await expect(probes.ciRunnerSlot!('bad host', UNIT)).resolves.toBe('unknown');
    expect(safe.calls).toHaveLength(0);
  });
});

describe('createNodeDoctorProbes loginShell (SHP1)', () => {
  const C = LOGIN_SHELL_CANARY;

  it('pins the canary text', () => {
    expect(LOGIN_SHELL_CANARY).toBe(
      "fleet-canary a  b $HOME \\n \\\\ 'q' \"d\" * ~ ; -- #x ! line\nend",
    );
    expect(LOGIN_SHELL_CANARY).toHaveLength(60);
  });

  it('sends the canary over ssh as one quoted sh -c word, once, with the probe budget', async () => {
    const fake = fakeExecutor({ stdout: C });
    const probes = createNodeDoctorProbes({ localExecutor: fake.executor });
    await expect(probes.loginShell!('lane-host')).resolves.toBe('intact');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.argv).toEqual([
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      'lane-host',
      '--',
      'sh',
      '-c',
      posixQuote(['printf', '%s', C].map(posixQuote).join(' ')),
    ]);
    expect(fake.calls[0]?.options?.timeoutMs).toBe(10_000);
  });

  const viaRealShell = (prefix: string): DoctorCommandExecutor => {
    const real = createNodeDoctorExecutor();
    return {
      async run(argv, options) {
        const remoteLine = argv.slice(argv.indexOf('--') + 1).join(' ');
        return real.run(['/bin/sh', '-c', prefix + remoteLine], options);
      },
    };
  };

  it('answers intact through the real /bin/sh quoted form', async () => {
    const probes = createNodeDoctorProbes({ sshExecutor: viaRealShell('') });
    await expect(probes.loginShell!('lane-host')).resolves.toBe('intact');
  });

  it('answers mangled when the login shell prints a banner before the echo (real /bin/sh)', async () => {
    const probes = createNodeDoctorProbes({ sshExecutor: viaRealShell('echo banner; ') });
    await expect(probes.loginShell!('lane-host')).resolves.toBe('mangled');
  });

  it('answers unknown, never mangled or intact, when the answer exceeds the executor output cap (real /bin/sh)', async () => {
    const real = createNodeDoctorExecutor();
    const overflow = await real.run(['/bin/sh', '-c', 'head -c 1100000 /dev/zero']);
    expect(overflow.exitCode).toBeNull();
    expect(typeof overflow.error).toBe('string');
    expect(overflow.stdout).toBe('');

    const probes = createNodeDoctorProbes({
      sshExecutor: viaRealShell('head -c 1100000 /dev/zero; '),
    });
    await expect(probes.loginShell!('lane-host')).resolves.toBe('unknown');
  });

  it('maps an altered echo or a non-zero exit to mangled', async () => {
    const outcomes: Partial<DoctorCommandRunResult>[] = [
      { stdout: '' },
      { stdout: `${C}\n` },
      { stdout: `banner\n${C}` },
      { stdout: C.replace('a  b', 'a b') },
      // True of the pure mapper only: the real executor never returns 2 MB, it
      // reports the 1 MiB cap as an error, which is `unknown` (see the test above).
      { stdout: 'x'.repeat(2_000_000) },
      { exitCode: 1, stdout: C },
      { exitCode: 127, stdout: '' },
    ];
    for (const outcome of outcomes) {
      const fake = fakeExecutor(outcome);
      const probes = createNodeDoctorProbes({ localExecutor: fake.executor });
      await expect(probes.loginShell!('lane-host')).resolves.toBe('mangled');
    }
  });

  it('maps a run that did not complete to unknown', async () => {
    const outcomes: Partial<DoctorCommandRunResult>[] = [
      { exitCode: 255, stdout: C },
      { exitCode: null, signal: null, stdout: '', error: 'spawn ENOENT' },
      { exitCode: 0, stdout: C, error: 'late' },
      { exitCode: null, signal: 'SIGTERM', stdout: C },
      { exitCode: 0, signal: 'SIGTERM', stdout: C },
      { exitCode: 0, stdout: 42 as unknown as string },
    ];
    for (const outcome of outcomes) {
      const fake = fakeExecutor(outcome);
      const probes = createNodeDoctorProbes({ localExecutor: fake.executor });
      await expect(probes.loginShell!('lane-host')).resolves.toBe('unknown');
    }
  });

  it('answers unknown without running anything for local, an unsafe alias or an exhausted budget', async () => {
    const fake = fakeExecutor({ stdout: C });
    const probes = createNodeDoctorProbes({ localExecutor: fake.executor });
    await expect(probes.loginShell!('local')).resolves.toBe('unknown');
    await expect(probes.loginShell!('bad host')).resolves.toBe('unknown');
    await expect(probes.loginShell!('-dash-alias')).resolves.toBe('unknown');
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const budgeted = createNodeDoctorProbes({ localExecutor: fake.executor, timeoutMs });
      await expect(budgeted.loginShell!('lane-host')).resolves.toBe('unknown');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('maps a throwing executor to unknown', async () => {
    const probes = createNodeDoctorProbes({
      localExecutor: {
        async run() {
          throw new Error('boom');
        },
      },
    });
    await expect(probes.loginShell!('lane-host')).resolves.toBe('unknown');
  });
});

/** A successful run: every probe maps this to its success answer. */
const GOOD_RUN = { exitCode: 0, signal: null, stdout: 'active\n', stderr: '' } as const;

interface HostileCase {
  readonly label: string;
  readonly make: (counter: { getters: number }) => unknown;
}

function accessorOn(field: string, value: unknown) {
  return (counter: { getters: number }): unknown =>
    Object.defineProperty({ ...GOOD_RUN }, field, {
      enumerable: true,
      get() {
        counter.getters += 1;
        return value;
      },
    });
}

class RunResultClass {
  exitCode = 0;
  signal = null;
  stdout = 'active\n';
  stderr = '';
}

const HOSTILE_RUN_RESULTS: readonly HostileCase[] = [
  { label: 'a getter on exitCode', make: accessorOn('exitCode', 0) },
  { label: 'a getter on stdout', make: accessorOn('stdout', 'active\n') },
  { label: 'a getter on error', make: accessorOn('error', undefined) },
  { label: 'a getter on signal', make: accessorOn('signal', null) },
  { label: 'a non-throwing Proxy', make: () => new Proxy({ ...GOOD_RUN }, {}) },
  {
    label: 'a Proxy whose descriptor trap throws',
    make: () =>
      new Proxy({ ...GOOD_RUN }, {
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
        getPrototypeOf() {
          throw new Error('trap');
        },
      }),
  },
  { label: 'a non-plain prototype carrying the answer', make: () => Object.create({ ...GOOD_RUN }) },
  { label: 'a class instance', make: () => new RunResultClass() },
  {
    label: 'an own __proto__ key',
    make: () => Object.defineProperty({ ...GOOD_RUN }, '__proto__', { value: {}, enumerable: true }),
  },
  { label: 'an own constructor key', make: () => ({ ...GOOD_RUN, constructor: 'x' }) },
  { label: 'an own prototype key', make: () => ({ ...GOOD_RUN, prototype: 'x' }) },
  { label: 'an array-like with an enormous length', make: () => ({ length: 1_000_000, 0: 'a' }) },
  { label: 'an array', make: () => [GOOD_RUN] },
  { label: 'more than 64 own keys', make: () => ({ ...GOOD_RUN, ...Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`k${i}`, i])) }) },
  { label: 'a string stdout replaced by a number', make: () => ({ ...GOOD_RUN, stdout: 42 }) },
  { label: 'a fractional exit code', make: () => ({ ...GOOD_RUN, exitCode: 0.5 }) },
  { label: 'null', make: () => null },
  { label: 'undefined', make: () => undefined },
  { label: 'the number 42', make: () => 42 },
  { label: 'the string active', make: () => 'active' },
];

describe('createNodeDoctorProbes untrusted executor answers', () => {
  it.each(HOSTILE_RUN_RESULTS)('refuses $label on every executor-backed probe and never runs a getter', async ({ make }) => {
    const counter = { getters: 0 };
    const executor: DoctorCommandExecutor = {
      async run() {
        return make(counter) as DoctorCommandRunResult;
      },
    };
    const probes = createNodeDoctorProbes({
      localExecutor: executor,
      sshExecutor: executor,
      repoRoot: '/nonexistent-fleet-doctor-probes-root',
      serviceEnv: { GH_TOKEN: 'x' },
    });
    const toolId = BUILT_IN_TOOLS[0].id;
    expect(await probes.hostReachable('lane-host')).toBe(false);
    expect(await probes.commandAvailable('lane-host', 'git')).toBe(false);
    expect(await probes.toolVersion('lane-host', toolId)).toBeUndefined();
    expect(await probes.fileMode('lane-host', '/etc/x')).toBeUndefined();
    expect(await probes.worktreeRootWritable('lane-host')).toBe(false);
    expect(await probes.ciRunnerSlot!('lane-host', 'runner.service')).toBe('unknown');
    expect(await probes.loginShell!('lane-host')).toBe('unknown');
    expect((await probes.serverProbe('lane-host', 4096)).outcome).toBe('unknown');
    expect((await probes.ghAuth!('/usr/bin/gh')).authCheck.outcome).toBe('unknown');
    expect((await probes.seatProbe(seat)).outcome).toBe('unknown');
    expect(await probes.pinnedBuild!()).toEqual({
      pinnedCommit: undefined,
      baseTipCommit: undefined,
      behindCount: undefined,
      installRootName: expect.any(String),
    });
    expect(counter.getters).toBe(0);
  });

  it('refuses an executor that throws as a failed run on every probe', async () => {
    const executor: DoctorCommandExecutor = {
      async run() {
        throw new Error('spawn exploded');
      },
    };
    const probes = createNodeDoctorProbes({ localExecutor: executor, sshExecutor: executor });
    expect(await probes.hostReachable('lane-host')).toBe(false);
    expect(await probes.ciRunnerSlot!('lane-host', 'runner.service')).toBe('unknown');
    expect((await probes.seatProbe(seat)).outcome).toBe('unknown');
  });

  it('still maps a well-formed answer to its success outcome, so refusal is not a constant', async () => {
    const executor: DoctorCommandExecutor = {
      async run() {
        return { ...GOOD_RUN };
      },
    };
    const probes = createNodeDoctorProbes({ localExecutor: executor, sshExecutor: executor });
    expect(await probes.hostReachable('lane-host')).toBe(true);
    expect(await probes.ciRunnerSlot!('lane-host', 'runner.service')).toBe('active');
    expect((await probes.seatProbe(seat)).outcome).toBe('pass');
  });

  it('reads a null-prototype answer as data, so plain-object detection is not a prototype-equality check only', async () => {
    const executor: DoctorCommandExecutor = {
      async run() {
        return Object.assign(Object.create(null), GOOD_RUN) as DoctorCommandRunResult;
      },
    };
    const probes = createNodeDoctorProbes({ localExecutor: executor, sshExecutor: executor });
    expect(await probes.hostReachable('lane-host')).toBe(true);
  });
});

describe('createNodeDoctorProbes untrusted pinned-build answers', () => {
  const GOOD_BUILD = { pinnedCommit: 'a'.repeat(40), baseTipCommit: 'b'.repeat(40), behindCount: 3, installRootName: 'fleet' };
  const probesFor = (answer: unknown) =>
    createNodeDoctorProbes({ readPinnedBuild: async () => answer as never });

  it('returns a fresh copy of a well-formed answer, not the injected object', async () => {
    const answer = { ...GOOD_BUILD };
    const read = await probesFor(answer).pinnedBuild!();
    expect(read).toEqual(GOOD_BUILD);
    expect(read).not.toBe(answer);
  });

  it.each([
    ['null', () => null],
    ['undefined', () => undefined],
    ['a string', () => 'pinned'],
    ['an array', () => [GOOD_BUILD]],
    ['a Proxy', () => new Proxy({ ...GOOD_BUILD }, {})],
    ['a foreign prototype', () => Object.create({ ...GOOD_BUILD })],
    ['a non-integer behindCount', () => ({ ...GOOD_BUILD, behindCount: 1.5 })],
    ['a numeric pinnedCommit', () => ({ ...GOOD_BUILD, pinnedCommit: 7 })],
    ['an own constructor key', () => ({ ...GOOD_BUILD, constructor: 'x' })],
  ])('refuses %s as undefined', async (_label, make) => {
    expect(await probesFor(make()).pinnedBuild!()).toBeUndefined();
  });

  it.each(['pinnedCommit', 'baseTipCommit', 'behindCount', 'installRootName'])(
    'refuses a getter on %s without running it',
    async (field) => {
      let getters = 0;
      const answer = Object.defineProperty({ ...GOOD_BUILD }, field, {
        enumerable: true,
        get() {
          getters += 1;
          return (GOOD_BUILD as Record<string, unknown>)[field];
        },
      });
      expect(await probesFor(answer).pinnedBuild!()).toBeUndefined();
      expect(getters).toBe(0);
    },
  );

  it('refuses a reader that throws as undefined', async () => {
    const probes = createNodeDoctorProbes({
      readPinnedBuild: async () => {
        throw new Error('boom');
      },
    });
    expect(await probes.pinnedBuild!()).toBeUndefined();
  });
});

describe('createNodeDoctorProbes untrusted gh candidates, seat and model list', () => {
  it.each([
    ['a non-iterable', () => 42],
    ['an array hole', () => {
      const holey = ['/usr/bin/gh', '/usr/bin/gh'];
      delete holey[0];
      return holey;
    }],
    ['an enormous sparse array', () => new Array(10_000)],
    ['a dense list longer than 64 entries', () => Array.from({ length: 65 }, () => '/nonexistent/gh')],
    ['a non-string element', () => [42]],
    ['an array-like', () => ({ length: 1, 0: '/usr/bin/gh' })],
    ['a Proxy over an array', () => new Proxy(['/usr/bin/gh'], {})],
    ['an array with a foreign prototype', () => Object.setPrototypeOf(['/usr/bin/gh'], { evil: true })],
  ])('refuses %s as ghBinaryCandidates with undefined', async (_label, make) => {
    const probes = createNodeDoctorProbes({ ghBinaryCandidates: make() as never });
    expect(await probes.ghBinary!()).toBeUndefined();
  });

  it('refuses an accessor element of ghBinaryCandidates without running it', async () => {
    let getters = 0;
    const candidates = ['/nonexistent/gh'];
    Object.defineProperty(candidates, 0, {
      enumerable: true,
      get() {
        getters += 1;
        return '/usr/bin/gh';
      },
    });
    const probes = createNodeDoctorProbes({ ghBinaryCandidates: candidates });
    expect(await probes.ghBinary!()).toBeUndefined();
    expect(getters).toBe(0);
  });

  it('reports a well-formed candidate list as unresolved with the same candidates', async () => {
    const probes = createNodeDoctorProbes({ ghBinaryCandidates: ['/nonexistent/gh'] });
    expect(await probes.ghBinary!()).toEqual({ resolved: undefined, candidates: ['/nonexistent/gh'] });
  });

  it.each(['model', 'variant', 'tool'])('refuses a getter on seat.%s without running it', async (field) => {
    let getters = 0;
    const hostileSeat = Object.defineProperty({ ...seat }, field, {
      enumerable: true,
      get() {
        getters += 1;
        return (seat as unknown as Record<string, unknown>)[field];
      },
    });
    const local = fakeExecutor({});
    const probes = createNodeDoctorProbes({ localExecutor: local.executor });
    expect((await probes.seatProbe(hostileSeat)).outcome).toBe('unknown');
    expect(local.calls).toEqual([]);
    expect(getters).toBe(0);
  });

  it('gives no argv for a getter on seat.model, a Proxy seat, or a template with a hole', () => {
    let getters = 0;
    const getterSeat = Object.defineProperty({ ...seat }, 'model', {
      enumerable: true,
      get() {
        getters += 1;
        return 'm';
      },
    });
    expect(seatProbeArgv(getterSeat, ['run', '{model}'])).toEqual([]);
    expect(getters).toBe(0);
    expect(seatProbeArgv(new Proxy({ ...seat }, {}), ['run', '{model}'])).toEqual([]);
    const holeyTemplate = ['run', '{model}'];
    delete holeyTemplate[0];
    expect(seatProbeArgv(seat, holeyTemplate)).toEqual([]);
    expect(seatProbeArgv(seat, ['run', '{model}'])).toEqual(['run', 'glm-5.3']);
  });

  it('answers undefined for a model list that is not a string', () => {
    expect(serverModelIds(42 as never)).toBeUndefined();
    expect(serverModelIds(null as never)).toBeUndefined();
  });
});

describe('createNodeDoctorProbes diskQuotaUsage (OPQ1)', () => {
  it('pins the fixed file path and the parse budget', () => {
    expect(DISK_QUOTA_FILE).toBe('/etc/fleet/disk-quota-bytes');
    expect(DISK_QUOTA_MAX_CHARS).toBe(256);
  });

  it('runs cat on the fixed disk-quota file through sshRemoteArgv with the probe budget', async () => {
    const fake = fakeExecutor({ stdout: '100 1000\n' });
    const probes = createNodeDoctorProbes({ localExecutor: fake.executor });
    await expect(probes.diskQuotaUsage!('lane-host')).resolves.toEqual({
      usedBytes: 100,
      totalBytes: 1000,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.argv).toEqual([
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      'lane-host',
      '--',
      'sh',
      '-c',
      posixQuote(['cat', DISK_QUOTA_FILE].map(posixQuote).join(' ')),
    ]);
    expect(fake.calls[0]?.options?.timeoutMs).toBe(10_000);

    const local = fakeExecutor({ stdout: '100 1000' });
    const localProbes = createNodeDoctorProbes({ localExecutor: local.executor });
    await expect(localProbes.diskQuotaUsage!('local')).resolves.toBeUndefined();
    expect(local.calls).toHaveLength(0);
  });

  it('returns undefined without spawning for local, unsafe alias, or exhausted budget', async () => {
    const fake = fakeExecutor({ stdout: '100 1000\n' });
    const probes = createNodeDoctorProbes({ localExecutor: fake.executor });
    await expect(probes.diskQuotaUsage!('local')).resolves.toBeUndefined();
    await expect(probes.diskQuotaUsage!('bad host')).resolves.toBeUndefined();
    await expect(probes.diskQuotaUsage!('-dash-alias')).resolves.toBeUndefined();
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const budgeted = createNodeDoctorProbes({ localExecutor: fake.executor, timeoutMs });
      await expect(budgeted.diskQuotaUsage!('lane-host')).resolves.toBeUndefined();
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('maps a failing, signalled, or erroring diskQuotaUsage run to undefined', async () => {
    const outcomes: Partial<DoctorCommandRunResult>[] = [
      // `cat` on a missing file: exit 1, no usable answer.
      { exitCode: 1, stdout: '' },
      { exitCode: 1, stdout: 'cat: no such file\n' },
      { exitCode: 2, stdout: '100 1000\n' },
      { exitCode: null, signal: 'SIGTERM', stdout: '100 1000\n' },
      { exitCode: 0, stdout: '100 1000\n', error: 'late failure' },
      { exitCode: null, signal: null, stdout: '', error: 'spawn ENOENT' },
      { exitCode: 0, stdout: 42 as unknown as string },
    ];
    for (const outcome of outcomes) {
      const fake = fakeExecutor(outcome);
      const probes = createNodeDoctorProbes({ localExecutor: fake.executor });
      await expect(probes.diskQuotaUsage!('lane-host')).resolves.toBeUndefined();
      expect(fake.calls).toHaveLength(1);
    }
  });

  it('returns undefined for malformed, oversized, or out-of-range disk quota output', async () => {
    for (const stdout of [
      '',
      '   ',
      '\n',
      '100 1000 extra\n',
      '100\n',
      '1000 100\n',
      '10.5 100\n',
      '-1 100\n',
      'NaN 100\n',
      '１００ 1000\n',
      '1,000 10000\n',
      `${'9'.repeat(10_000)} ${'9'.repeat(10_000)}`,
      `${'7'.repeat(257)} 1000`,
      '100 0\n',
      '100 -5\n',
      `${Number.MAX_SAFE_INTEGER + 1} ${Number.MAX_SAFE_INTEGER + 2}\n`,
      'abc def\n',
    ]) {
      expect(parseDiskQuotaUsage(stdout)).toBeUndefined();
    }
    // A 256-character answer at the boundary still parses.
    const padded = `${' '.repeat(100)}100 1000${' '.repeat(148)}`;
    expect(padded).toHaveLength(256);
    expect(parseDiskQuotaUsage(padded)).toEqual({ usedBytes: 100, totalBytes: 1000 });
    expect(parseDiskQuotaUsage('0 1\n')).toEqual({ usedBytes: 0, totalBytes: 1 });
    expect(parseDiskQuotaUsage('  100\t1000 \n')).toEqual({
      usedBytes: 100,
      totalBytes: 1000,
    });
    expect(parseDiskQuotaUsage(undefined as unknown as string)).toBeUndefined();
    expect(parseDiskQuotaUsage(42 as unknown as string)).toBeUndefined();
  });
});
