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
  runHostProbes,
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
  name: 'lanehost',
  transport: 'ssh',
  sshAlias: 'lanehost',
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

/** The fixed words every remote argv of `alias` starts with. */
const sshHead = (alias: string): string[] => [
  'ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', alias, '--', 'sh', '-c',
];

/** The bare program words of an argv: decodes the twice-quoted ssh form. */
function logicalArgv(argv: readonly string[]): readonly string[] {
  if (argv[0] !== 'ssh') {
    return argv;
  }
  const inner = argv[argv.length - 1] ?? '';
  const joined = inner.slice(1, -1).replaceAll("'\\''", "'");
  return [...joined.matchAll(/'((?:[^']|'\\'')*)'/g)].map((match) =>
    (match[1] ?? '').replaceAll("'\\''", "'"),
  );
}

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
    if (logicalArgv(call.argv).includes('mktemp')) {
      return succeeded(`${spec.worktreeRoot}/.fleet-probe.probe1\n`);
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

  it('wraps every remote step through sh -c with one quoted line', () => {
    const argvs = argvsOf(planHostProbes(sshSpec));
    expect(argvs).toEqual([
      [...sshHead('lanehost'), "''\\''true'\\'''"],
      [...sshHead('lanehost'), "''\\''sh'\\'' '\\''--version'\\'''"],
      [...sshHead('lanehost'), "''\\''git'\\'' '\\''--version'\\'''"],
      [...sshHead('lanehost'), "''\\''node'\\'' '\\''--version'\\'''"],
      [...sshHead('lanehost'), "''\\''opencode'\\'' '\\''--version'\\'''"],
      [
        ...sshHead('lanehost'),
        "''\\''mktemp'\\'' '\\''/srv/fleet-v2/worktrees/.fleet-probe.XXXXXX'\\'''",
      ],
      [
        ...sshHead('lanehost'),
        "''\\''curl'\\'' '\\''-fsS'\\'' '\\''--max-time'\\'' '\\''5'\\'' '\\''http://127.0.0.1:4166/'\\'''",
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
      expect(logicalArgv(argv).join(' ')).not.toMatch(shellShape);
    }
    for (const argv of argvsOf(planHostProbes(localSpec))) {
      expect(argv.join(' ')).not.toMatch(shellShape);
    }
  });

  it('plans the opencode server on the host loopback with a five second bound', () => {
    const server = runStepOf(planHostProbes(sshSpec), 'server-loopback');
    expect(logicalArgv(server?.argv ?? [])).toContain('http://127.0.0.1:4166/');
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
      ...sshHead('agy-host'),
      "''\\''agy'\\'' '\\''--version'\\'''",
    ]);
  });

  it('plans the lane-runner worktree root visibility step only for a verifier', () => {
    const withoutIt = planHostProbes(sshSpec);
    expect(
      withoutIt.some((step) => step.check === 'lane-runner-worktree-visible'),
    ).toBe(false);

    const withIt = planHostProbes({
      ...localSpec,
      name: 'verifyhost',
      laneRunnerWorktreeRoot: {
        hostName: 'lanehost',
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
        subject: 'lanehost',
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

  // KF-30b: the doctor --host gate-slot warning lives in the probe plan, the
  // same convention `hostLines` uses for the full sweep.
  it('warns that conducted gates run unthrottled when a lane runner declares no gateSlot', () => {
    const steps = planHostProbes({ ...sshSpec, isLaneRunner: true });
    expect(steps.filter((step) => step.check === 'gate-slot')).toEqual([
      {
        kind: 'note',
        scope: 'host',
        subject: 'lanehost',
        check: 'gate-slot',
        status: 'PASS',
        detail:
          'warning: conducted acceptance gates run unthrottled; declare runner.gateSlot to route them through the host-wide gate slot',
      },
    ]);
  });

  it('emits no gate-slot note when the runner declares a gateSlot', () => {
    const steps = planHostProbes({
      ...sshSpec,
      isLaneRunner: true,
      runner: { ...sshSpec.runner!, gateSlot: { path: '/usr/local/bin/gate-slot', slots: 8 } },
    });
    expect(steps.filter((step) => step.check === 'gate-slot')).toEqual([]);
  });

  it('emits no gate-slot note for a host that is not the lane runner', () => {
    expect(
      planHostProbes(sshSpec).filter((step) => step.check === 'gate-slot'),
    ).toEqual([]);
  });

  it('maps a drafted host onto its probe spec', () => {
    const drafted = draftHost({
      name: 'lanehost',
      transport: 'ssh',
      sshAlias: 'lanehost',
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
      name: 'lanehost',
      transport: 'ssh',
      sshAlias: 'lanehost',
      worktreeRoot: '/srv/fleet-v2/worktrees',
      tmpDir: '/tmp/fleet-v2',
      isLaneRunner: true,
      runner: {
        kind: 'opencode',
        port: 4166,
        authFile: '/home/dev/.local/share/opencode/auth.json',
      },
    });
  });

  it('carries the drafted gateSlot and lane-runner flag onto the probe spec (KF-30b)', () => {
    const drafted = draftHost({
      name: 'lanehost',
      transport: 'ssh',
      sshAlias: 'lanehost',
      worktreeRoot: '/srv/fleet-v2/worktrees',
      roles: ['lane-runner'],
      runner: {
        kind: 'opencode',
        port: 4166,
        gateSlot: { path: '/usr/local/bin/gate-slot', slots: 8 },
      },
    });
    expect(drafted.ok).toBe(true);
    if (!drafted.ok) {
      return;
    }
    expect(hostProbeSpecFromDraft(drafted.draft)).toMatchObject({
      isLaneRunner: true,
      runner: {
        kind: 'opencode',
        port: 4166,
        gateSlot: { path: '/usr/local/bin/gate-slot', slots: 8 },
      },
    });
  });
});

describe('runHostProbes', () => {
  it('creates one path inside the worktree root and removes exactly that path', async () => {
    const { executor, calls } = fakeExecutor((call) => {
      if (logicalArgv(call.argv).includes('mktemp')) {
        return succeeded('/home/dev/fleet-v2/.fleet-probe.a1b2c3\n');
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
      ['rm', '--', '/home/dev/fleet-v2/.fleet-probe.a1b2c3'],
    ]);
    const writable = lines.find(
      (line) => line.check === 'worktree-root-writable',
    );
    expect(writable?.status).toBe('PASS');
    expect(writable?.detail).toContain('/home/dev/fleet-v2');
  });

  it('removes the created path through the same ssh transport on a remote host', async () => {
    const { executor, calls } = fakeExecutor((call) => {
      if (logicalArgv(call.argv).includes('mktemp')) {
        return succeeded('/srv/fleet-v2/worktrees/.fleet-probe.zz9abc\n');
      }
      return succeeded();
    });
    await probeHost(sshSpec, executor);
    expect(calls[5]?.argv).toEqual([
      ...sshHead('lanehost'),
      "''\\''mktemp'\\'' '\\''/srv/fleet-v2/worktrees/.fleet-probe.XXXXXX'\\'''",
    ]);
    expect(calls[6]?.argv).toEqual([
      ...sshHead('lanehost'),
      "''\\''rm'\\'' '\\''--'\\'' '\\''/srv/fleet-v2/worktrees/.fleet-probe.zz9abc'\\'''",
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
      logicalArgv(call.argv).includes('mktemp')
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
      if (logicalArgv(call.argv).includes('mktemp')) {
        return succeeded('/home/dev/fleet-v2/.fleet-probe.left12\n');
      }
      if (logicalArgv(call.argv).includes('rm')) {
        return { exitCode: 1 };
      }
      return succeeded();
    });
    const lines = await probeHost(localSpec, executor);
    const writable = lines.find(
      (line) => line.check === 'worktree-root-writable',
    );
    expect(writable?.status).toBe('FAIL');
    expect(writable?.detail).toContain('/home/dev/fleet-v2/.fleet-probe.left12');
  });

  it('reports a version, and treats a shell without --version as unknown, not a failure', async () => {
    const { executor } = fakeExecutor((call) => {
      if (logicalArgv(call.argv)[1] === '--version') {
        return succeeded('git version 2.43.0\n');
      }
      return succeeded();
    });
    const lines = await probeHost(localSpec, executor);
    const git = lines.find((line) => line.check === 'version-git');
    expect(git?.status).toBe('PASS');
    expect(git?.detail).toBe('git: version git version 2.43.0');

    const dash = fakeExecutor((call) =>
      logicalArgv(call.argv)[0] === 'sh'
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
      logicalArgv(call.argv)[0] === 'git' ? { error: 'spawn git ENOENT' } : succeeded(),
    );
    const lines = await probeHost(localSpec, executor);
    expect(lines.find((line) => line.check === 'version-git')?.status).toBe(
      'FAIL',
    );
  });

  it('reports an unanswered loopback server as unknown so the host is still addable', async () => {
    const { executor } = healthyExecutor(sshSpec, (call) =>
      logicalArgv(call.argv).includes('curl')
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
      logicalArgv(call.argv).includes('curl') ? succeeded('opencode 1.2.3\n') : succeeded(),
    );
    const lines = await probeHost(sshSpec, executor);
    expect(lines.find((line) => line.check === 'reachable')?.detail).toBe(
      'reachable via lanehost',
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
      logicalArgv(call.argv)[0] === 'git'
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
    expect(calls.some((call) => logicalArgv(call.argv).includes('rm'))).toBe(false);
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
      logicalArgv(call.argv).includes('curl') ? { exitCode: 7 } : {},
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

  it('decodes the planned ssh form back to the bare program words', () => {
    const reachable = runStepOf(planHostProbes(sshSpec), 'reachable');
    expect(logicalArgv(reachable?.argv ?? [])).toEqual(['true']);

    const quoted = planHostProbes({
      ...sshSpec,
      worktreeRoot: "/srv/it's here",
    });
    const mktemp = quoted.find(
      (step): step is Extract<HostProbeStep, { kind: 'mktemp-then-rm' }> =>
        step.kind === 'mktemp-then-rm',
    );
    expect(logicalArgv(mktemp?.argv ?? [])).toEqual([
      'mktemp',
      "/srv/it's here/.fleet-probe.XXXXXX",
    ]);
  });

  it('wraps ssh steps through sh -c for a worktree root with a space, a single quote and $(id)', () => {
    const steps = planHostProbes({
      ...sshSpec,
      worktreeRoot: "/srv/a b/it's $(id)",
    });
    const mktemp = steps.find(
      (step): step is Extract<HostProbeStep, { kind: 'mktemp-then-rm' }> =>
        step.kind === 'mktemp-then-rm',
    );
    expect(mktemp?.argv).toEqual([
      ...sshHead('lanehost'),
      "''\\''mktemp'\\'' '\\''/srv/a b/it'\\''\\'\\'''\\''s $(id)/.fleet-probe.XXXXXX'\\'''",
    ]);
  });

  it('keeps local argvs bare and carries no ssh alias', () => {
    for (const spec of [localSpec, { ...localSpec, sshAlias: 'lanehost' }]) {
      const steps = planHostProbes(spec);
      const mktemp = steps.find(
        (step): step is Extract<HostProbeStep, { kind: 'mktemp-then-rm' }> =>
          step.kind === 'mktemp-then-rm',
      );
      expect(mktemp?.sshAlias).toBeUndefined();
      expect(argvsOf(steps)).toEqual([
        ['true'],
        ['sh', '--version'],
        ['git', '--version'],
        ['node', '--version'],
        ['mktemp', '/home/dev/fleet-v2/.fleet-probe.XXXXXX'],
      ]);
    }
    const sshMktemp = planHostProbes(sshSpec).find(
      (step): step is Extract<HostProbeStep, { kind: 'mktemp-then-rm' }> =>
        step.kind === 'mktemp-then-rm',
    );
    expect(sshMktemp?.sshAlias).toBe('lanehost');
  });

  it('plans a FAIL note and no mktemp run for a worktree root containing NUL', async () => {
    const spec = { ...sshSpec, worktreeRoot: '/srv/r\0oot' };
    const steps = planHostProbes(spec);
    const note = noteStepOf(steps, 'worktree-root-writable');
    expect(note?.status).toBe('FAIL');
    expect(note?.detail).not.toContain('/srv/r');
    expect(
      steps.some((step) => step.kind === 'mktemp-then-rm'),
    ).toBe(false);
    const { executor, calls } = fakeExecutor(() => succeeded());
    const lines = await probeHost(spec, executor);
    expect(lines.some((line) => line.status === 'PASS')).toBe(true);
    expect(
      calls.some((call) => logicalArgv(call.argv).includes('mktemp')),
    ).toBe(false);
    const writable = lines.find((entry) => entry.check === 'worktree-root-writable');
    expect(writable?.status).toBe('FAIL');
    expect(writable?.detail).toBe(
      'the worktree root contains a control character; no command was run',
    );
  });

  it('plans a FAIL note for a lane-runner root containing NUL', () => {
    const steps = planHostProbes({
      ...sshSpec,
      laneRunnerWorktreeRoot: {
        hostName: 'lanehost',
        worktreeRoot: '/srv/other\0root',
      },
    });
    const note = noteStepOf(steps, 'lane-runner-worktree-visible');
    expect(note?.status).toBe('FAIL');
    expect(
      steps.some(
        (step) =>
          step.kind === 'run' && step.check === 'lane-runner-worktree-visible',
      ),
    ).toBe(false);
  });

  it('plans a single-slash template and passes for a root written with a trailing slash', async () => {
    const spec = { ...localSpec, worktreeRoot: '/srv/worktrees/' };
    const mktemp = planHostProbes(spec).find(
      (step): step is Extract<HostProbeStep, { kind: 'mktemp-then-rm' }> =>
        step.kind === 'mktemp-then-rm',
    );
    expect(mktemp?.argv).toEqual(['mktemp', '/srv/worktrees/.fleet-probe.XXXXXX']);

    const { executor, calls } = fakeExecutor((call) =>
      logicalArgv(call.argv).includes('mktemp')
        ? succeeded('/srv/worktrees/.fleet-probe.abc123\n')
        : succeeded(),
    );
    const lines = await probeHost(spec, executor);
    const writable = lines.find((entry) => entry.check === 'worktree-root-writable');
    expect(writable?.status).toBe('PASS');
    expect(calls[calls.length - 1]?.argv).toEqual([
      'rm',
      '--',
      '/srv/worktrees/.fleet-probe.abc123',
    ]);
  });

  it('removes a legitimate answer with a bare rm locally and a quoted sh -c over ssh', async () => {
    const local = fakeExecutor((call) =>
      logicalArgv(call.argv).includes('mktemp')
        ? succeeded('/home/dev/fleet-v2/.fleet-probe.zz9abc\n')
        : succeeded(),
    );
    await probeHost(localSpec, local.executor);
    expect(local.calls[local.calls.length - 1]?.argv).toEqual([
      'rm',
      '--',
      '/home/dev/fleet-v2/.fleet-probe.zz9abc',
    ]);

    const ssh = fakeExecutor((call) =>
      logicalArgv(call.argv).includes('mktemp')
        ? succeeded('/srv/fleet-v2/worktrees/.fleet-probe.zz9abc\n')
        : succeeded(),
    );
    await probeHost(sshSpec, ssh.executor);
    const last = ssh.calls.find((call) => logicalArgv(call.argv).includes('rm'));
    expect(last?.argv).toEqual([
      ...sshHead('lanehost'),
      "''\\''rm'\\'' '\\''--'\\'' '\\''/srv/fleet-v2/worktrees/.fleet-probe.zz9abc'\\'''",
    ]);
    expect(logicalArgv(last?.argv ?? [])).toEqual([
      'rm',
      '--',
      '/srv/fleet-v2/worktrees/.fleet-probe.zz9abc',
    ]);
  });

  it('refuses a mktemp answer that is not exactly root/.fleet-probe.<six alphanumerics>', async () => {
    const root = localSpec.worktreeRoot;
    for (const answer of [
      `${root}/.fleet-probe.abc12;id`,
      `${root}/$(id)`,
      `${root}/tmp.abc123`,
      `${root}/.fleet-probe.abc1234`,
      `${root}/.fleet-probe.abc12`,
      `${root}/.fleet-probe.abc-12`,
      `${root}/a/.fleet-probe.abc123`,
      `${root}/.fleet-probe.abc123/x`,
      `${root}x/.fleet-probe.abc123`,
    ]) {
      const { executor, calls } = fakeExecutor(() => succeeded(`${answer}\n`));
      const lines = await probeHost(localSpec, executor);
      const writable = lines.find(
        (line) => line.check === 'worktree-root-writable',
      );
      expect(writable?.status).toBe('FAIL');
      expect(writable?.detail).toContain('nothing was removed');
      expect(
        calls.some((call) => logicalArgv(call.argv).includes('rm')),
      ).toBe(false);
    }
  });

  it('runs no rm and reports unknown when the step\u2019s ssh alias is refused', async () => {
    const { executor, calls } = fakeExecutor(() =>
      succeeded('/srv/r/.fleet-probe.abc123\n'),
    );
    const lines = await runHostProbes(
      [
        {
          kind: 'mktemp-then-rm',
          scope: 'host',
          subject: 'lanehost',
          check: 'worktree-root-writable',
          worktreeRoot: '/srv/r',
          argv: ['mktemp', '/srv/r/.fleet-probe.XXXXXX'],
          sshAlias: '-oProxyCommand=x',
          timeoutMs: 1000,
        },
      ],
      executor,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.status).toBe('UNKNOWN');
    expect(lines[0]?.detail).toContain('could not be checked for removal');
    expect(calls.map((call) => call.argv)).toEqual([
      ['mktemp', '/srv/r/.fleet-probe.XXXXXX'],
    ]);
  });

  it('refuses a relative, empty or control-character worktree root before any command, locally and over ssh', async () => {
    const NOT_ABSOLUTE = 'the worktree root is not an absolute path; no command was run';
    const CONTROL = 'the worktree root contains a control character; no command was run';
    const cases: readonly (readonly [string, string])[] = [
      ['srv/worktrees', NOT_ABSOLUTE],
      ['./worktrees', NOT_ABSOLUTE],
      ['', NOT_ABSOLUTE],
      ['rel\nroot', NOT_ABSOLUTE],
      ['/srv/a\nb', CONTROL],
      ['/srv/a\rb', CONTROL],
      ['/srv/a\u001bb', CONTROL],
      ['/srv/r\0oot', CONTROL],
      ['/srv/a\u2028b', CONTROL],
      ['/srv/a‮b', CONTROL],
    ];
    for (const [root, detail] of cases) {
      for (const base of [localSpec, sshSpec]) {
        const spec = { ...base, worktreeRoot: root };
        const steps = planHostProbes(spec);
        expect(steps.some((step) => step.kind === 'mktemp-then-rm')).toBe(false);
        expect(noteStepOf(steps, 'worktree-root-writable')).toEqual({
          kind: 'note',
          scope: 'host',
          subject: spec.name,
          check: 'worktree-root-writable',
          status: 'FAIL',
          detail,
        });
        const { executor, calls } = fakeExecutor(() => succeeded());
        const lines = await probeHost(spec, executor);
        expect(lines.find((entry) => entry.check === 'worktree-root-writable')).toEqual({
          scope: 'host',
          subject: spec.name,
          check: 'worktree-root-writable',
          status: 'FAIL',
          detail,
        });
        expect(
          calls.some((call) => {
            const words = logicalArgv(call.argv);
            return words.includes('mktemp') || words.includes('rm');
          }),
        ).toBe(false);
        expect(hostProbesHaveFailure(lines)).toBe(true);
      }
    }
  });

  it('runs nothing for a hand-built step whose root is refused', async () => {
    for (const [worktreeRoot, detail] of [
      ['rel/root', 'the worktree root is not an absolute path; no command was run'],
      ['/srv/a\nb', 'the worktree root contains a control character; no command was run'],
      [42 as unknown as string, 'the worktree root is not an absolute path; no command was run'],
    ] as const) {
      const { executor, calls } = fakeExecutor(() =>
        succeeded('rel/root/.fleet-probe.abc123\n'),
      );
      const lines = await runHostProbes(
        [
          {
            kind: 'mktemp-then-rm',
            scope: 'host',
            subject: 'lanehost',
            check: 'worktree-root-writable',
            worktreeRoot,
            argv: ['mktemp', 'rel/root/.fleet-probe.XXXXXX'],
            timeoutMs: 1000,
          },
        ],
        executor,
      );
      expect(lines).toEqual([
        {
          scope: 'host',
          subject: 'lanehost',
          check: 'worktree-root-writable',
          status: 'FAIL',
          detail,
        },
      ]);
      expect(calls).toEqual([]);
    }
  });

  it('refuses each malformed mktemp answer over ssh too and sends no rm', async () => {
    const root = sshSpec.worktreeRoot;
    for (const answer of [
      `${root}/.fleet-probe.abc12;id`,
      `${root}/$(id)`,
      `${root}/tmp.abc123`,
      `${root}/.fleet-probe.abc1234`,
      `${root}/.fleet-probe.abc12`,
      `${root}/.fleet-probe.abc-12`,
      `${root}/a/.fleet-probe.abc123`,
      `${root}/.fleet-probe.abc123/x`,
      `${root}x/.fleet-probe.abc123`,
    ]) {
      const { executor, calls } = healthyExecutor(
        sshSpec,
        (call) => (logicalArgv(call.argv).includes('mktemp') ? succeeded(`${answer}\n`) : {}),
      );
      const lines = await probeHost(sshSpec, executor);
      const writable = lines.find(
        (line) => line.check === 'worktree-root-writable',
      );
      expect(writable?.status).toBe('FAIL');
      expect(writable?.detail).toContain('nothing was removed');
      expect(
        calls.some((call) => logicalArgv(call.argv).includes('mktemp')),
      ).toBe(true);
      expect(
        calls.some((call) => logicalArgv(call.argv).includes('rm')),
      ).toBe(false);
    }
  });

  it('plans a single-slash template and removes the answer over ssh for a root written with a trailing slash', async () => {
    const spec = { ...sshSpec, worktreeRoot: '/srv/worktrees/' };
    const mktemp = planHostProbes(spec).find(
      (step): step is Extract<HostProbeStep, { kind: 'mktemp-then-rm' }> =>
        step.kind === 'mktemp-then-rm',
    );
    expect(logicalArgv(mktemp?.argv ?? [])).toEqual([
      'mktemp',
      '/srv/worktrees/.fleet-probe.XXXXXX',
    ]);
    expect(mktemp?.argv.slice(0, 9)).toEqual(sshHead('lanehost'));

    const { executor, calls } = healthyExecutor(
      spec,
      (call) =>
        logicalArgv(call.argv).includes('mktemp')
          ? succeeded('/srv/worktrees/.fleet-probe.abc123\n')
          : {},
    );
    const lines = await probeHost(spec, executor);
    const writable = lines.find(
      (line) => line.check === 'worktree-root-writable',
    );
    expect(writable?.status).toBe('PASS');
    const rmCalls = calls.filter((call) => logicalArgv(call.argv).includes('rm'));
    expect(rmCalls).toHaveLength(1);
    expect(logicalArgv(rmCalls[0]?.argv ?? [])).toEqual([
      'rm',
      '--',
      '/srv/worktrees/.fleet-probe.abc123',
    ]);
  });

  it('treats a root with regex metacharacters as a literal prefix', async () => {
    const root = '/srv/a.b+c (x)[1]$^*';
    const spec = { ...localSpec, worktreeRoot: root };
    const mktemp = planHostProbes(spec).find(
      (step): step is Extract<HostProbeStep, { kind: 'mktemp-then-rm' }> =>
        step.kind === 'mktemp-then-rm',
    );
    expect(mktemp?.argv).toEqual(['mktemp', `${root}/.fleet-probe.XXXXXX`]);

    const good = fakeExecutor((call) =>
      call.argv[0] === 'mktemp'
        ? succeeded(`${root}/.fleet-probe.abc123\n`)
        : succeeded(),
    );
    const goodLines = await probeHost(spec, good.executor);
    const goodWritable = goodLines.find(
      (line) => line.check === 'worktree-root-writable',
    );
    expect(goodWritable?.status).toBe('PASS');
    expect(good.calls[good.calls.length - 1]?.argv).toEqual([
      'rm',
      '--',
      `${root}/.fleet-probe.abc123`,
    ]);

    const sneaky = fakeExecutor((call) =>
      call.argv[0] === 'mktemp'
        ? succeeded('/srv/aXb+c (x)[1]$^*/.fleet-probe.abc123\n')
        : succeeded(),
    );
    const sneakyLines = await probeHost(spec, sneaky.executor);
    const sneakyWritable = sneakyLines.find(
      (line) => line.check === 'worktree-root-writable',
    );
    expect(sneakyWritable?.status).toBe('FAIL');
    expect(sneakyWritable?.detail).toContain('nothing was removed');
    expect(
      sneaky.calls.some((call) => call.argv.includes('rm')),
    ).toBe(false);
  });

  it('accepts the filesystem root as a worktree root', async () => {
    const spec = { ...localSpec, worktreeRoot: '/' };
    const mktemp = planHostProbes(spec).find(
      (step): step is Extract<HostProbeStep, { kind: 'mktemp-then-rm' }> =>
        step.kind === 'mktemp-then-rm',
    );
    expect(mktemp?.argv).toEqual(['mktemp', '/.fleet-probe.XXXXXX']);

    const good = fakeExecutor((call) =>
      call.argv[0] === 'mktemp' ? succeeded('/.fleet-probe.abc123\n') : succeeded(),
    );
    const goodLines = await probeHost(spec, good.executor);
    const goodWritable = goodLines.find(
      (line) => line.check === 'worktree-root-writable',
    );
    expect(goodWritable?.status).toBe('PASS');
    expect(good.calls[good.calls.length - 1]?.argv).toEqual([
      'rm',
      '--',
      '/.fleet-probe.abc123',
    ]);

    const sneaky = fakeExecutor((call) =>
      call.argv[0] === 'mktemp'
        ? succeeded('/etc/.fleet-probe.abc123\n')
        : succeeded(),
    );
    const sneakyLines = await probeHost(spec, sneaky.executor);
    const sneakyWritable = sneakyLines.find(
      (line) => line.check === 'worktree-root-writable',
    );
    expect(sneakyWritable?.status).toBe('FAIL');
    expect(
      sneaky.calls.some((call) => call.argv.includes('rm')),
    ).toBe(false);
  });
});
