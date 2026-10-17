/**
 * The probe plan for one host: the exact argv every step runs (BatchMode,
 * ConnectTimeout and `--` on the remote ones, no shell string anywhere), and
 * the doctor lines an injected fake executor produces. No step may touch a
 * real host, and `mktemp`'s answer may only ever lead to `rm` of that one
 * path inside the worktree root.
 */

import { describe, expect, it } from 'vitest';

import type { DoctorCommandRunResult } from '../../doctor/probes-node.js';
import type { HostProbeExecutor } from '../probe-plan.js';
import type { HostProbeSpec, HostProbeStep } from '../probe-plan.js';
import {
  hostProbeSpecFromDraft,
  hostProbesHaveFailure,
  planHostProbes,
  probeHost,
} from '../probe-plan.js';
import { draftHost } from '../draft.js';

interface RecordedCall {
  readonly argv: readonly string[];
  readonly options?: { readonly timeoutMs?: number };
}

type Outcome = (call: RecordedCall) => Partial<DoctorCommandRunResult>;

function fakeExecutor(outcome: Outcome): {
  executor: HostProbeExecutor;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    executor: {
      async run(argv, options) {
        const call: RecordedCall = { argv, options };
        calls.push(call);
        return {
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: '',
          ...outcome(call),
        };
      },
    },
  };
}

function succeeded(stdout = ''): Partial<DoctorCommandRunResult> {
  return { stdout };
}

const sshSpec: HostProbeSpec = {
  name: 'midnight',
  transport: 'ssh',
  sshAlias: 'midnight',
  worktreeRoot: '/srv/fleet-v2/worktrees',
  runner: {
    kind: 'opencode',
    port: 4166,
    authFile: '/home/dev/.local/share/opencode/auth.json',
    capabilities: {
      networkEgressRestricted: true,
      cpuAndMemoryLimited: true,
      processTreeTermination: true,
      filesystemScope: 'scoped-worktree',
    },
  },
};

const localSpec: HostProbeSpec = {
  name: 'here',
  transport: 'local',
  worktreeRoot: '/home/dev/fleet-v2',
};

/** The `ssh <alias> --` prefix every remote argv of `alias` starts with. */
function sshPrefixOf(alias: string): string[] {
  return ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', alias, '--'];
}

const SSH_PREFIX = sshPrefixOf('midnight');

/**
 * A fake executor that answers every step of `spec` the way a healthy host
 * would: a path created inside the worktree root, the orchestrator uid, a 600
 * regular file, and no output for the version and reachability commands.
 */
function healthyExecutor(
  spec: HostProbeSpec,
  overrides: Outcome = () => ({}),
): { executor: HostProbeExecutor; calls: RecordedCall[] } {
  const uid = '1000';
  return fakeExecutor((call) => {
    const override = overrides(call);
    if (Object.keys(override).length > 0) {
      return override;
    }
    if (call.argv.includes('mktemp')) {
      return succeeded(`${spec.worktreeRoot}/tmp.probe01\n`);
    }
    if (call.argv[0] === 'id') {
      return succeeded(`${uid}\n`);
    }
    if (call.argv[0] === 'stat') {
      return succeeded(`${uid} 600 regular file\n`);
    }
    return succeeded();
  });
}

function argvsOf(steps: readonly HostProbeStep[]): string[][] {
  return steps
    .map((step) =>
      step.kind === 'note' || step.kind === 'auth-file' ? undefined : step.argv,
    )
    .filter((argv): argv is string[] => argv !== undefined);
}

/** The `run` step of `check`, narrowed by kind so its `argv` is readable. */
function runStepOf(
  steps: readonly HostProbeStep[],
  check: string,
): Extract<HostProbeStep, { kind: 'run' }> | undefined {
  return steps.find(
    (step): step is Extract<HostProbeStep, { kind: 'run' }> =>
      step.kind === 'run' && step.check === check,
  );
}

/** The `note` step of `check`, narrowed by kind so its status and detail are readable. */
function noteStepOf(
  steps: readonly HostProbeStep[],
  check: string,
): Extract<HostProbeStep, { kind: 'note' }> | undefined {
  return steps.find(
    (step): step is Extract<HostProbeStep, { kind: 'note' }> =>
      step.kind === 'note' && step.check === check,
  );
}

describe('planHostProbes', () => {
  it('plans reachability, the platform versions, the worktree check, the loopback server, the capability source and the auth file', () => {
    const checks = planHostProbes(sshSpec).map((step) => step.check);
    expect(checks).toEqual([
      'reachable',
      'version-sh',
      'version-git',
      'version-node',
      'version-opencode',
      'worktree-root-writable',
      'server-loopback',
      'runner-capabilities',
      'file-owner-mode',
    ]);
  });

  it('wraps every remote step in BatchMode, ConnectTimeout and -- before the alias', () => {
    const argvs = argvsOf(planHostProbes(sshSpec));
    expect(argvs).toEqual([
      [...SSH_PREFIX, 'true'],
      [...SSH_PREFIX, 'sh', '--version'],
      [...SSH_PREFIX, 'git', '--version'],
      [...SSH_PREFIX, 'node', '--version'],
      [...SSH_PREFIX, 'opencode', '--version'],
      [...SSH_PREFIX, 'mktemp', '/srv/fleet-v2/worktrees/.fleet-probe.XXXXXX'],
      [
        ...SSH_PREFIX,
        'curl',
        '-fsS',
        '--max-time',
        '5',
        'http://127.0.0.1:4166/',
      ],
    ]);
  });

  it('builds no argv at all on a local host: the commands run in place', () => {
    const argvs = argvsOf(planHostProbes(localSpec));
    expect(argvs).toEqual([
      ['true'],
      ['sh', '--version'],
      ['git', '--version'],
      ['node', '--version'],
      ['mktemp', '/home/dev/fleet-v2/.fleet-probe.XXXXXX'],
    ]);
  });

  it('never builds a shell string: every argv element is a plain token', () => {
    const shellShape = /[;&|`$(){}<>\n]/;
    for (const argv of argvsOf(planHostProbes(sshSpec))) {
      expect(argv.join(' ')).not.toMatch(shellShape);
    }
    for (const argv of argvsOf(planHostProbes(localSpec))) {
      expect(argv.join(' ')).not.toMatch(shellShape);
    }
  });

  it('plans the opencode server on the host loopback with a five second bound', () => {
    const server = runStepOf(planHostProbes(sshSpec), 'server-loopback');
    expect(server?.argv).toContain('http://127.0.0.1:4166/');
    expect(server?.failureStatus).toBe('UNKNOWN');
  });

  it('plans no loopback server step for an agy runner, only its tool version', () => {
    const steps = planHostProbes({
      name: 'agy-host',
      transport: 'ssh',
      sshAlias: 'agy-host',
      worktreeRoot: '/srv/fleet-v2/agy',
      runner: { kind: 'agy', port: 4166 },
    });
    expect(steps.map((step) => step.check)).toEqual([
      'reachable',
      'version-sh',
      'version-git',
      'version-node',
      'version-agy',
      'worktree-root-writable',
      'runner-capabilities',
    ]);
    const version = runStepOf(steps, 'version-agy');
    expect(version?.argv).toEqual([
      ...sshPrefixOf('agy-host'),
      'agy',
      '--version',
    ]);
  });

  it('plans the lane-runner worktree root visibility step only for a verifier', () => {
    const withoutIt = planHostProbes(sshSpec);
    expect(
      withoutIt.some((step) => step.check === 'lane-runner-worktree-visible'),
    ).toBe(false);

    const withIt = planHostProbes({
      ...localSpec,
      name: 'sunrise',
      laneRunnerWorktreeRoot: {
        hostName: 'midnight',
        worktreeRoot: '/srv/fleet-v2/worktrees',
      },
    });
    const step = runStepOf(withIt, 'lane-runner-worktree-visible');
    expect(step?.argv).toEqual(['test', '-d', '/srv/fleet-v2/worktrees']);
  });

  it('reports an undeclared capability source as unknown, never as a pass', () => {
    const declared = noteStepOf(planHostProbes(sshSpec), 'runner-capabilities');
    expect(declared?.status).toBe('PASS');
    expect(declared?.detail).toBe(
      'capability source declared, filesystemScope scoped-worktree',
    );

    const undeclared = noteStepOf(
      planHostProbes({
        name: 'here',
        transport: 'local',
        worktreeRoot: '/home/dev/fleet-v2',
        runner: { kind: 'opencode', port: 46000 },
      }),
      'runner-capabilities',
    );
    expect(undeclared?.status).toBe('UNKNOWN');
    expect(undeclared?.detail).toBe(
      'capability source undeclared, filesystemScope unknown',
    );
  });

  it('plans the auth-file owner and mode steps locally, with a BSD stat fallback', () => {
    const step = planHostProbes(sshSpec).find(
      (entry) => entry.check === 'file-owner-mode',
    );
    expect(step?.kind).toBe('auth-file');
    if (step?.kind !== 'auth-file') {
      return;
    }
    expect(step.scope).toBe('credential');
    expect(step.subject).toBe('/home/dev/.local/share/opencode/auth.json');
    expect(step.ownerArgv).toEqual(['id', '-u']);
    expect(step.statArgv).toEqual([
      'stat',
      '-c',
      '%u %a %F',
      '/home/dev/.local/share/opencode/auth.json',
    ]);
    expect(step.statFallbackArgv).toEqual([
      'stat',
      '-f',
      '%u %Lp %HT',
      '/home/dev/.local/share/opencode/auth.json',
    ]);
  });

  it('plans nothing to run for an alias that could be read as an ssh option', () => {
    const steps = planHostProbes({
      ...sshSpec,
      sshAlias: '-oProxyCommand=touch /tmp/pwn',
    });
    expect(steps).toEqual([
      {
        kind: 'note',
        scope: 'host',
        subject: 'midnight',
        check: 'ssh-alias',
        status: 'FAIL',
        detail:
          'the ssh alias is not a safe host string; no command was run on this host',
      },
    ]);
  });

  it('carries the timeout each step needs', () => {
    const steps = planHostProbes(sshSpec);
    expect(steps.find((step) => step.check === 'reachable')).toMatchObject({
      timeoutMs: 10_000,
    });
    expect(
      steps.find((step) => step.check === 'server-loopback'),
    ).toMatchObject({
      timeoutMs: 10_000,
    });
  });

  it('maps a drafted host onto its probe spec', () => {
    const drafted = draftHost({
      name: 'midnight',
      transport: 'ssh',
      sshAlias: 'midnight',
      worktreeRoot: '/srv/fleet-v2/worktrees',
      tmpDir: '/tmp/fleet-v2',
      roles: ['lane-runner'],
      runner: {
        kind: 'opencode',
        port: 4166,
        authFile: '/home/dev/.local/share/opencode/auth.json',
      },
    });
    expect(drafted.ok).toBe(true);
    if (!drafted.ok) {
      return;
    }
    expect(hostProbeSpecFromDraft(drafted.draft)).toEqual({
      name: 'midnight',
      transport: 'ssh',
      sshAlias: 'midnight',
      worktreeRoot: '/srv/fleet-v2/worktrees',
      tmpDir: '/tmp/fleet-v2',
      runner: {
        kind: 'opencode',
        port: 4166,
        authFile: '/home/dev/.local/share/opencode/auth.json',
      },
    });
  });
});

describe('runHostProbes', () => {
  it('creates one path inside the worktree root and removes exactly that path', async () => {
    const { executor, calls } = fakeExecutor((call) => {
      if (call.argv.includes('mktemp')) {
        return succeeded('/home/dev/fleet-v2/tmp.a1b2c3\n');
      }
      return succeeded();
    });
    const lines = await probeHost(localSpec, executor);
    expect(calls.map((call) => call.argv)).toEqual([
      ['true'],
      ['sh', '--version'],
      ['git', '--version'],
      ['node', '--version'],
      ['mktemp', '/home/dev/fleet-v2/.fleet-probe.XXXXXX'],
      ['rm', '--', '/home/dev/fleet-v2/tmp.a1b2c3'],
    ]);
    const writable = lines.find(
      (line) => line.check === 'worktree-root-writable',
    );
    expect(writable?.status).toBe('PASS');
    expect(writable?.detail).toContain('/home/dev/fleet-v2');
  });

  it('removes the created path through the same ssh transport on a remote host', async () => {
    const { executor, calls } = fakeExecutor((call) => {
      if (call.argv.includes('mktemp')) {
        return succeeded('/srv/fleet-v2/worktrees/tmp.zz9\n');
      }
      return succeeded();
    });
    await probeHost(sshSpec, executor);
    expect(calls[5]?.argv).toEqual([
      ...SSH_PREFIX,
      'mktemp',
      '/srv/fleet-v2/worktrees/.fleet-probe.XXXXXX',
    ]);
    expect(calls[6]?.argv).toEqual([
      ...SSH_PREFIX,
      'rm',
      '--',
      '/srv/fleet-v2/worktrees/tmp.zz9',
    ]);
  });

  it('refuses a mktemp answer outside the worktree root and removes nothing', async () => {
    for (const answer of [
      '/etc/passwd',
      '/srv/fleet-v2/worktrees/../secrets',
      '/tmp/tmp.x',
    ]) {
      const { executor, calls } = fakeExecutor(() => succeeded(`${answer}\n`));
      const lines = await probeHost(localSpec, executor);
      const writable = lines.find(
        (line) => line.check === 'worktree-root-writable',
      );
      expect(writable?.status).toBe('FAIL');
      expect(writable?.detail).toContain('nothing was removed');
      expect(calls.some((call) => call.argv.includes('rm'))).toBe(false);
    }
  });

  it('fails the worktree check when mktemp cannot create a path there', async () => {
    const { executor } = fakeExecutor((call) =>
      call.argv.includes('mktemp')
        ? { exitCode: 1, stderr: 'mktemp: failed to create file via template' }
        : succeeded(),
    );
    const lines = await probeHost(localSpec, executor);
    const writable = lines.find(
      (line) => line.check === 'worktree-root-writable',
    );
    expect(writable?.status).toBe('FAIL');
    expect(writable?.detail).toContain('not writable');
  });

  it('reports a path that was created but not removed, naming the path', async () => {
    const { executor } = fakeExecutor((call) => {
      if (call.argv.includes('mktemp')) {
        return succeeded('/home/dev/fleet-v2/tmp.left\n');
      }
      if (call.argv.includes('rm')) {
        return { exitCode: 1 };
      }
      return succeeded();
    });
    const lines = await probeHost(localSpec, executor);
    const writable = lines.find(
      (line) => line.check === 'worktree-root-writable',
    );
    expect(writable?.status).toBe('FAIL');
    expect(writable?.detail).toContain('/home/dev/fleet-v2/tmp.left');
  });

  it('reports a version, and treats a shell without --version as unknown, not a failure', async () => {
    const { executor } = fakeExecutor((call) => {
      if (call.argv[1] === '--version') {
        return succeeded('git version 2.43.0\n');
      }
      return succeeded();
    });
    const lines = await probeHost(localSpec, executor);
    const git = lines.find((line) => line.check === 'version-git');
    expect(git?.status).toBe('PASS');
    expect(git?.detail).toBe('git: version git version 2.43.0');

    const dash = fakeExecutor((call) =>
      call.argv[0] === 'sh'
        ? { exitCode: 2, stderr: 'sh: 0: Illegal option --' }
        : succeeded(),
    );
    const dashLines = await probeHost(localSpec, dash.executor);
    const sh = dashLines.find((line) => line.check === 'version-sh');
    expect(sh?.status).toBe('UNKNOWN');
    expect(sh?.detail).toContain('no version answer');
  });

  it('fails a version check when the command is not there at all', async () => {
    const { executor } = fakeExecutor((call) =>
      call.argv[0] === 'git' ? { error: 'spawn git ENOENT' } : succeeded(),
    );
    const lines = await probeHost(localSpec, executor);
    expect(lines.find((line) => line.check === 'version-git')?.status).toBe(
      'FAIL',
    );
  });

  it('reports an unanswered loopback server as unknown so the host is still addable', async () => {
    const { executor } = healthyExecutor(sshSpec, (call) =>
      call.argv.includes('curl')
        ? { exitCode: 7, stderr: 'curl: (7) failed to connect' }
        : {},
    );
    const lines = await probeHost(sshSpec, executor);
    const server = lines.find((line) => line.check === 'server-loopback');
    expect(server?.status).toBe('UNKNOWN');
    expect(hostProbesHaveFailure(lines)).toBe(false);
  });

  it('passes a reachable host and its answered server', async () => {
    const { executor } = fakeExecutor((call) =>
      call.argv.includes('curl') ? succeeded('opencode 1.2.3\n') : succeeded(),
    );
    const lines = await probeHost(sshSpec, executor);
    expect(lines.find((line) => line.check === 'reachable')?.detail).toBe(
      'reachable via midnight',
    );
    const server = lines.find((line) => line.check === 'server-loopback');
    expect(server?.status).toBe('PASS');
    expect(server?.detail).toContain("on the host's own loopback");
  });

  it('bounds and redacts a probe detail exactly as the doctor engine does', async () => {
    // A synthetic token, deliberately short of the credential-shaped patterns
    // the lane diff check flags; the redaction rule still catches it.
    const secret = 'sk-testtoken';
    const { executor } = fakeExecutor((call) =>
      call.argv[0] === 'git'
        ? succeeded(`${secret} ${'v'.repeat(400)}\n`)
        : succeeded(),
    );
    const lines = await probeHost(localSpec, executor);
    const git = lines.find((line) => line.check === 'version-git');
    expect(git?.detail).not.toContain(secret);
    expect(git?.detail.length).toBeLessThanOrEqual(200);
    expect(git?.detail).toContain('[redacted]');
  });

  it('passes the auth file when it is a 600 regular file owned by the orchestrator', async () => {
    const { executor } = fakeExecutor((call) => {
      if (call.argv[0] === 'id') {
        return succeeded('1000\n');
      }
      if (call.argv[1] === '-c') {
        return succeeded('1000 600 regular file\n');
      }
      return succeeded();
    });
    const lines = await probeHost(sshSpec, executor);
    const auth = lines.find((line) => line.check === 'file-owner-mode');
    expect(auth?.status).toBe('PASS');
    expect(auth?.detail).toBe(
      '/home/dev/.local/share/opencode/auth.json: mode 0600, a regular file owned by the orchestrator user',
    );
  });

  it('falls back to the BSD stat form and reads its Regular File type', async () => {
    const { executor } = fakeExecutor((call) => {
      if (call.argv[0] === 'id') {
        return succeeded('501\n');
      }
      if (call.argv[1] === '-c') {
        return { exitCode: 1, stderr: 'stat: illegal option -- c' };
      }
      return succeeded('501 600 Regular File\n');
    });
    const lines = await probeHost(sshSpec, executor);
    expect(lines.find((line) => line.check === 'file-owner-mode')?.status).toBe(
      'PASS',
    );
  });

  it('fails the auth file on a foreign owner, a group-readable mode or a directory', async () => {
    const cases = [
      {
        stat: '1001 600 regular file\n',
        detail: 'not by the orchestrator user',
      },
      { stat: '1000 644 regular file\n', detail: 'group- or world-accessible' },
      { stat: '1000 700 directory\n', detail: 'not a regular file' },
    ];
    for (const testCase of cases) {
      const { executor } = fakeExecutor((call) => {
        if (call.argv[0] === 'id') {
          return succeeded('1000\n');
        }
        if (call.argv[1] === '-c') {
          return succeeded(testCase.stat);
        }
        return succeeded();
      });
      const lines = await probeHost(sshSpec, executor);
      const auth = lines.find((line) => line.check === 'file-owner-mode');
      expect(auth?.status).toBe('FAIL');
      expect(auth?.detail).toContain(testCase.detail);
    }
  });

  it('never runs rm and reports unknown when the orchestrator user id is unavailable', async () => {
    const { executor, calls } = fakeExecutor((call) =>
      call.argv[0] === 'id' ? { error: 'spawn id ENOENT' } : succeeded('nope'),
    );
    const lines = await probeHost(sshSpec, executor);
    const auth = lines.find((line) => line.check === 'file-owner-mode');
    expect(auth?.status).toBe('UNKNOWN');
    expect(auth?.detail).toContain('ownership was not checked');
    expect(calls.some((call) => call.argv.includes('rm'))).toBe(false);
  });

  it('turns a throwing executor into unknown lines rather than a crash', async () => {
    const executor: HostProbeExecutor = {
      async run() {
        throw new Error('executor exploded');
      },
    };
    const steps = planHostProbes(localSpec);
    const lines = await probeHost(localSpec, executor);
    expect(lines).toHaveLength(steps.length);
    expect(lines.every((line) => line.status === 'UNKNOWN')).toBe(true);
  });

  it('refuses when any line failed and not when a line is merely unknown', async () => {
    const { executor } = healthyExecutor(sshSpec, (call) =>
      call.argv.includes('curl') ? { exitCode: 7 } : {},
    );
    const unknownOnly = await probeHost(sshSpec, executor);
    expect(unknownOnly.some((line) => line.status === 'FAIL')).toBe(false);
    expect(hostProbesHaveFailure(unknownOnly)).toBe(false);

    const failing = await probeHost(
      sshSpec,
      fakeExecutor(() => ({ exitCode: 255 })).executor,
    );
    expect(hostProbesHaveFailure(failing)).toBe(true);
  });
});
