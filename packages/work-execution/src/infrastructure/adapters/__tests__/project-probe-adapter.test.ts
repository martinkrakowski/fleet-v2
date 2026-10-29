// Adapter tests for ProjectProbeAdapter over scripted fake CommandExecutorPorts:
// a recording fake executor returns canned results keyed by a substring of the
// joined argv, so no subprocess, filesystem or network is exercised.

import { describe, expect, it } from 'vitest';

import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { ExecutorForRecordedHostResult } from '../ExecutorForHost.helper.js';
import { ProjectProbeAdapter, redactUserinfo } from '../ProjectProbeAdapter.adapter.js';
import { physicalPathArgv } from '../ResolvePhysicalPath.helper.js';

type RunCall = { argv: readonly string[]; options?: CommandRunOptions };

const EXPECTED_GIT_HARDENING = [
  '-c',
  'core.pager=cat',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.https.allow=always',
  '-c',
  'protocol.ssh.allow=always',
  '-c',
  'protocol.git.allow=always',
  '-c',
  'protocol.file.allow=always',
  '-c',
  'protocol.version=2',
];

/**
 * Recording fake executor. Canned results are matched by the first marker that
 * is a substring of the joined argv; unmatched runs default to exit 2 so an
 * unscripted argv is never a silent pass.
 */
function fakeExecutor(
  canned: Readonly<Record<string, Partial<CommandRunResult>>> = {},
): { executor: CommandExecutorPort; calls: RunCall[] } {
  const calls: RunCall[] = [];
  return {
    executor: {
      run: async (
        argv: readonly string[],
        options?: CommandRunOptions,
      ): Promise<CommandRunResult> => {
        const call: RunCall = { argv, options };
        calls.push(call);
        const joined = argv.join(' ');
        const marker = Object.keys(canned).find((key) => joined.includes(key));
        const partial =
          marker !== undefined ? { exitCode: 0, ...canned[marker] } : { exitCode: 2 };
        return { signal: null, stdout: '', stderr: '', ...partial };
      },
    },
    calls,
  };
}

/** A host-name → (executor | refusal) map, turned into the injected selector. */
type HostExecutorMap = Record<
  string,
  { executor: CommandExecutorPort } | { reason: string }
>;

function executorForHostFrom(map: HostExecutorMap): {
  (hostName: string): ExecutorForRecordedHostResult;
} {
  return (hostName: string): ExecutorForRecordedHostResult => {
    const entry = map[hostName];
    if (entry === undefined) return { ok: false, reason: `no executor for ${hostName}` };
    if ('executor' in entry) return { ok: true, executor: entry.executor };
    return { ok: false, reason: entry.reason };
  };
}

const REPO = 'git@github.com:o/r';
const NOW = new Date('2026-10-25T09:00:00.000Z');

const SYMREF_STDOUT =
  'ref: refs/heads/main\tHEAD\n' +
  '0123456789abcdef0123456789abcdef01234567\tHEAD\n';

/** Canned responses for a fully passing host clone at `path`. */
function passingHostCanned(
  path = '/lanes/a',
): Readonly<Record<string, Partial<CommandRunResult>>> {
  return {
    'rev-parse --show-toplevel': { exitCode: 0, stdout: `${path}\n` },
    'remote get-url origin': { exitCode: 0, stdout: `${REPO}.git\n` },
    'test -d': { exitCode: 0 },
    'check-ignore -q .lane/probe.md': { exitCode: 0 },
    'ls-files --error-unmatch AGENTS.md': { exitCode: 0 },
    'cat-file blob HEAD:package.json': {
      exitCode: 0,
      stdout: JSON.stringify({
        scripts: {
          build: 'tsc',
          'x; rm -rf': 'echo bad',
          lint: 'eslint',
          zzz: 'z',
          '01-start': 'node start',
        },
      }),
    },
  };
}

function makeAdapter(
  orchestrator: CommandExecutorPort,
  hosts: HostExecutorMap,
): ProjectProbeAdapter {
  return new ProjectProbeAdapter({
    orchestrator,
    executorForHost: executorForHostFrom(hosts),
    now: () => NOW,
  });
}

describe('ProjectProbeAdapter', () => {
  it('reports every pass in order with the default branch and only safe script names', async () => {
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: 0, stdout: SYMREF_STDOUT },
    });
    const hostA = fakeExecutor(passingHostCanned('/lanes/a'));
    const hostB = fakeExecutor(passingHostCanned('/lanes/b'));
    const adapter = makeAdapter(orch.executor, {
      a: { executor: hostA.executor },
      b: { executor: hostB.executor },
    });

    const report = await adapter.probe({
      repository: REPO,
      clones: {
        a: { path: '/lanes/a', worktreeRoot: '/lanes/a-root' },
        b: { path: '/lanes/b', worktreeRoot: '/lanes/b-root' },
      },
    });

    expect(report.probedAtIso).toBe(NOW.toISOString());
    expect(report.probedFrom).toBe('orchestrator');
    expect(report.defaultBranch).toBe('main');
    expect(report.checks.map((check) => check.name)).toEqual([
      'repository-answers',
      'clone-is-work-tree',
      'origin-matches',
      'worktree-root-exists',
      'lane-dir-ignored',
      'agent-instructions-tracked',
      'clone-is-work-tree',
      'origin-matches',
      'worktree-root-exists',
      'lane-dir-ignored',
      'agent-instructions-tracked',
    ]);
    for (const check of report.checks) expect(check.result).toBe('pass');
    expect(report.detectedScripts).toEqual(['01-start', 'build', 'lint', 'zzz']);
    expect(orch.calls).toHaveLength(1);
    expect(orch.calls[0].options?.cwd).toBe('/');
    const catFileCall = hostA.calls.find((call) => call.argv.includes('cat-file'))!;
    expect(catFileCall.argv).toEqual([
      'git',
      ...EXPECTED_GIT_HARDENING,
      '-C',
      '/lanes/a',
      'cat-file',
      'blob',
      'HEAD:package.json',
    ]);
    expect(catFileCall.options?.maxBufferBytes).toBe(1048576);
  });

  it('passes flag-shaped clone paths as the operand of -C in every host command', async () => {
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: 0, stdout: SYMREF_STDOUT },
    });
    const hostA = fakeExecutor(passingHostCanned('--git-dir=/x'));
    const adapter = makeAdapter(orch.executor, { a: { executor: hostA.executor } });

    const report = await adapter.probe({
      repository: REPO,
      clones: { a: { path: '--git-dir=/x', worktreeRoot: '-x' } },
    });

    for (const check of report.checks) expect(check.result).toBe('pass');
    expect(hostA.calls.map((call) => call.argv)).toEqual([
      ['git', ...EXPECTED_GIT_HARDENING, '-C', '--git-dir=/x', 'rev-parse', '--show-toplevel'],
      physicalPathArgv('--git-dir=/x'),
      ['git', ...EXPECTED_GIT_HARDENING, '-C', '--git-dir=/x', 'remote', 'get-url', 'origin'],
      ['test', '-d', '-x'],
      ['git', ...EXPECTED_GIT_HARDENING, '-C', '--git-dir=/x', 'check-ignore', '-q', '.lane/probe.md'],
      ['git', ...EXPECTED_GIT_HARDENING, '-C', '--git-dir=/x', 'ls-files', '--error-unmatch', 'AGENTS.md'],
      ['git', ...EXPECTED_GIT_HARDENING, '-C', '--git-dir=/x', 'cat-file', 'blob', 'HEAD:package.json'],
    ]);
  });

  it.each([
    ['-oProxyCommand=x'],
    [' -oProxyCommand=x'],
    ['ext::sh -c x'],
    [''],
  ])('refuses a non-plain repository %j without running anything', async (repository: string) => {
    const orch = fakeExecutor();
    const adapter = makeAdapter(orch.executor, {});
    const report = await adapter.probe({ repository, clones: {} });
    expect(report.checks).toEqual([
      {
        name: 'repository-answers',
        host: null,
        result: 'fail',
        detail: 'repository is not a plain URL or path',
      },
    ]);
    expect(orch.calls).toEqual([]);
  });

  it.each([
    ['https://user:pw@host/r.git', 'pw'],
    ['https://ghp_abc@github.com/o/r.git', 'ghp_abc'],
    ['user:pw@host:o/r', 'pw'],
  ])(
    'refuses a credential-bearing repository URL %s without running anything',
    async (repository: string, secret: string) => {
      const orch = fakeExecutor();
      const hostA = fakeExecutor();
      const adapter = makeAdapter(orch.executor, { a: { executor: hostA.executor } });

      const report = await adapter.probe({
        repository,
        clones: { a: { path: '/lanes/a', worktreeRoot: '/lanes/a-root' } },
      });

      expect(report.checks).toEqual([
        {
          name: 'repository-answers',
          host: null,
          result: 'fail',
          detail: 'repository URL carries a credential; register it without one',
        },
      ]);
      expect(orch.calls).toEqual([]);
      expect(hostA.calls).toEqual([]);
      expect(JSON.stringify(report)).not.toContain(secret);
    },
  );

  it('allows a bare ssh login name in ssh://git@host/p and runs ls-remote', async () => {
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: 0, stdout: SYMREF_STDOUT },
    });
    const adapter = makeAdapter(orch.executor, {});

    const report = await adapter.probe({
      repository: 'ssh://git@host/p',
      clones: {},
    });

    expect(report.checks).toEqual([
      {
        name: 'repository-answers',
        host: null,
        result: 'pass',
        detail: 'default branch main',
      },
    ]);
    expect(orch.calls.map((call) => call.argv)).toEqual([
      ['git', ...EXPECTED_GIT_HARDENING, 'ls-remote', '--symref', 'ssh://git@host/p', 'HEAD'],
    ]);
  });

  it('never copies credential-bearing stderr into a detail', async () => {
    const orch = fakeExecutor({
      'ls-remote --symref': {
        exitCode: 128,
        stderr: 'fatal: https://user:secret@host rejected\n',
      },
    });
    const adapter = makeAdapter(orch.executor, {});
    const report = await adapter.probe({ repository: 'https://example.com/repo.git', clones: {} });

    expect(report.checks[0]).toEqual({
      name: 'repository-answers',
      host: null,
      result: 'fail',
      detail: 'git ls-remote exited 128',
    });
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('reports repository-answers unknown when ls-remote exits with null exitCode and no error', async () => {
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: null },
    });
    const adapter = makeAdapter(orch.executor, {});
    const report = await adapter.probe({ repository: REPO, clones: {} });

    expect(report.checks).toEqual([
      {
        name: 'repository-answers',
        host: null,
        result: 'unknown',
        detail: 'orchestrator could not run git',
      },
    ]);
    expect(report.defaultBranch).toBeNull();
  });

  it('rejects an unsafe defaultBranch ref name from ls-remote symref output', async () => {
    const orch = fakeExecutor({
      'ls-remote --symref': {
        exitCode: 0,
        stdout:
          'ref: refs/heads/https://u:s@x\tHEAD\n' +
          '0123456789abcdef0123456789abcdef01234567\tHEAD\n',
      },
    });
    const adapter = makeAdapter(orch.executor, {});
    const report = await adapter.probe({ repository: REPO, clones: {} });

    expect(report.defaultBranch).toBeNull();
    expect(report.checks).toEqual([
      {
        name: 'repository-answers',
        host: null,
        result: 'pass',
        detail: 'remote answered; default branch not named',
      },
    ]);
    expect(JSON.stringify(report)).not.toContain('u:s');
  });

  it('reports a single host-reachable unknown when a host has no executor', async () => {
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: 0, stdout: SYMREF_STDOUT },
    });
    const adapter = new ProjectProbeAdapter({
      orchestrator: orch.executor,
      executorForHost: () => ({ ok: false, reason: 'host not installed' }),
      now: () => NOW,
    });

    const report = await adapter.probe({
      repository: REPO,
      clones: { a: { path: '/lanes/a', worktreeRoot: '/lanes/a-root' } },
    });

    expect(report.checks).toEqual([
      expect.objectContaining({ name: 'repository-answers', result: 'pass' }),
      { name: 'host-reachable', host: 'a', result: 'unknown', detail: 'host not installed' },
    ]);
  });

  it('hints at git clone when the clone is not a work tree and still runs later checks', async () => {
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: 0, stdout: SYMREF_STDOUT },
    });
    const hostA = fakeExecutor({
      'rev-parse --show-toplevel': {
        exitCode: 128,
        stderr: 'fatal: not a git repository\n',
      },
    });
    const adapter = makeAdapter(orch.executor, { a: { executor: hostA.executor } });

    const report = await adapter.probe({
      repository: REPO,
      clones: { a: { path: '/lanes/a', worktreeRoot: '/lanes/a-root' } },
    });

    const cloneCheck = report.checks.find((check) => check.name === 'clone-is-work-tree')!;
    expect(cloneCheck.result).toBe('fail');
    expect(cloneCheck.detail).toBe(
      "no git work tree at /lanes/a; on a run: git clone 'git@github.com:o/r' '/lanes/a'",
    );
    expect(report.checks.map((check) => check.name)).toEqual([
      'repository-answers',
      'clone-is-work-tree',
      'origin-matches',
      'worktree-root-exists',
      'lane-dir-ignored',
      'agent-instructions-tracked',
    ]);
    expect(report.detectedScripts).toEqual([]);
  });

  it('fails clone-is-work-tree without a clone hint when path is inside another repository', async () => {
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: 0, stdout: SYMREF_STDOUT },
    });
    const hostA = fakeExecutor({
      'rev-parse --show-toplevel': { exitCode: 0, stdout: '/lanes\n' },
    });
    const adapter = makeAdapter(orch.executor, { a: { executor: hostA.executor } });

    const report = await adapter.probe({
      repository: REPO,
      clones: { a: { path: '/lanes/a', worktreeRoot: '/lanes/a-root' } },
    });

    const cloneCheck = report.checks.find((check) => check.name === 'clone-is-work-tree')!;
    expect(cloneCheck.result).toBe('fail');
    expect(cloneCheck.detail).toBe(
      "/lanes/a is inside another repository at /lanes; use the clone's own root",
    );
    expect(cloneCheck.detail).not.toContain('git clone');
    expect(report.detectedScripts).toEqual([]);
  });

  it('passes clone-is-work-tree when --show-toplevel prints the physical path of a symlinked clone', async () => {
    const GIVEN = '/var/example/clone';
    const PHYSICAL = '/private/var/example/clone';
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: 0, stdout: SYMREF_STDOUT },
    });
    const hostA = fakeExecutor({
      ...passingHostCanned(GIVEN),
      'rev-parse --show-toplevel': { exitCode: 0, stdout: `${PHYSICAL}\n` },
      'pwd -P': { exitCode: 0, stdout: `${PHYSICAL}\n` },
    });
    const adapter = makeAdapter(orch.executor, { a: { executor: hostA.executor } });

    const report = await adapter.probe({
      repository: REPO,
      clones: { a: { path: GIVEN, worktreeRoot: `${GIVEN}-root` } },
    });

    const cloneCheck = report.checks.find((check) => check.name === 'clone-is-work-tree')!;
    expect(cloneCheck.result).toBe('pass');
    expect(cloneCheck.detail).toBe(`git work tree at ${GIVEN}`);
    const pwdCall = hostA.calls.find((call) => call.argv[0] === 'sh')!;
    expect(pwdCall.argv).toEqual(physicalPathArgv(GIVEN));
    expect(pwdCall.argv).toEqual(['sh', '-c', 'cd -- "$1" && pwd -P', 'sh', GIVEN]);
    expect(pwdCall.options?.timeoutMs).toBe(30_000);
    expect(pwdCall.argv[2]).toBe('cd -- "$1" && pwd -P');
    expect(pwdCall.argv).not.toContain(PHYSICAL);
  });

  it('fails clone-is-work-tree with today\'s detail when the physical path is another repository', async () => {
    const GIVEN = '/var/example/clone';
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: 0, stdout: SYMREF_STDOUT },
    });
    const hostA = fakeExecutor({
      'rev-parse --show-toplevel': { exitCode: 0, stdout: '/private/other/repo\n' },
      'pwd -P': { exitCode: 0, stdout: '/private/var/example/clone\n' },
    });
    const adapter = makeAdapter(orch.executor, { a: { executor: hostA.executor } });

    const report = await adapter.probe({
      repository: REPO,
      clones: { a: { path: GIVEN, worktreeRoot: `${GIVEN}-root` } },
    });

    const cloneCheck = report.checks.find((check) => check.name === 'clone-is-work-tree')!;
    expect(cloneCheck.result).toBe('fail');
    expect(cloneCheck.detail).toBe(
      `${GIVEN} is inside another repository at /private/other/repo; use the clone's own root`,
    );
  });

  it('falls back to the plain comparison when the physical path cannot be resolved', async () => {
    const GIVEN = '/var/example/clone';
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: 0, stdout: SYMREF_STDOUT },
    });
    const hostA = fakeExecutor({
      ...passingHostCanned(GIVEN),
      'pwd -P': { exitCode: 1 },
    });
    const adapter = makeAdapter(orch.executor, { a: { executor: hostA.executor } });

    const report = await adapter.probe({
      repository: REPO,
      clones: { a: { path: GIVEN, worktreeRoot: `${GIVEN}-root` } },
    });

    const cloneCheck = report.checks.find((check) => check.name === 'clone-is-work-tree')!;
    expect(cloneCheck.result).toBe('pass');
    expect(cloneCheck.detail).toBe(`git work tree at ${GIVEN}`);
  });

  it('redacts userinfo and single-quotes paths with apostrophes in hints', async () => {
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: 0, stdout: SYMREF_STDOUT },
    });
    const hostA = fakeExecutor({
      'rev-parse --show-toplevel': { exitCode: 128 },
      'test -d': { exitCode: 1 },
      'check-ignore -q .lane/probe.md': { exitCode: 1 },
    });
    const adapter = makeAdapter(orch.executor, { a: { executor: hostA.executor } });

    const report = await adapter.probe({
      repository: 'ssh://user@host/p',
      clones: { a: { path: "/srv/it's here", worktreeRoot: "/srv/it's here-root" } },
    });

    const cloneCheck = report.checks.find((check) => check.name === 'clone-is-work-tree')!;
    expect(cloneCheck.result).toBe('fail');
    expect(cloneCheck.detail).toBe(
      "no git work tree at /srv/it's here; on a run: git clone 'ssh://host/p' '/srv/it'\\''s here'",
    );
    expect(cloneCheck.detail).toContain("'ssh://host/p'");
    expect(cloneCheck.detail).not.toContain('user');
    expect(cloneCheck.detail).toContain("'/srv/it'\\''s here'");

    const ipv6Report = await adapter.probe({
      repository: 'ssh://u@[::1]:8443/p',
      clones: { a: { path: '/lanes/a', worktreeRoot: '/lanes/a-root' } },
    });
    const ipv6CloneCheck = ipv6Report.checks.find((check) => check.name === 'clone-is-work-tree')!;
    expect(ipv6CloneCheck.detail).toContain("'ssh://[::1]:8443/p'");

    const tagReport = await adapter.probe({
      repository: 'ssh://host/path@tag',
      clones: { a: { path: '/lanes/a', worktreeRoot: '/lanes/a-root' } },
    });
    const tagCloneCheck = tagReport.checks.find((check) => check.name === 'clone-is-work-tree')!;
    expect(tagCloneCheck.detail).toContain("'ssh://host/path@tag'");

    expect(redactUserinfo('https://u@[::1]:8443/p')).toBe('https://[::1]:8443/p');
    expect(redactUserinfo('ssh://host/path@tag')).toBe('ssh://host/path@tag');
  });

  it('fails clone-is-work-tree when rev-parse exits non-zero even if stdout matches path', async () => {
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: 0, stdout: SYMREF_STDOUT },
    });
    const hostA = fakeExecutor({
      'rev-parse --show-toplevel': { exitCode: 1, stdout: '/lanes/a\n' },
    });
    const adapter = makeAdapter(orch.executor, { a: { executor: hostA.executor } });

    const report = await adapter.probe({
      repository: REPO,
      clones: { a: { path: '/lanes/a', worktreeRoot: '/lanes/a-root' } },
    });

    const cloneCheck = report.checks.find((check) => check.name === 'clone-is-work-tree')!;
    expect(cloneCheck.result).toBe('fail');
    expect(report.detectedScripts).toEqual([]);
  });

  it('reports unknown and emits no further checks for an unreachable host', async () => {
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: 0, stdout: SYMREF_STDOUT },
    });
    const hostA = fakeExecutor({
      'rev-parse --show-toplevel': { error: 'spawn failed', exitCode: null },
    });
    const adapter = makeAdapter(orch.executor, { a: { executor: hostA.executor } });

    const report = await adapter.probe({
      repository: REPO,
      clones: { a: { path: '/lanes/a', worktreeRoot: '/lanes/a-root' } },
    });

    expect(report.checks.map((check) => [check.name, check.result])).toEqual([
      ['repository-answers', 'pass'],
      ['clone-is-work-tree', 'unknown'],
    ]);
    expect(report.checks[1].detail).toBe('a did not answer');
    expect(hostA.calls).toHaveLength(1);
  });

  it('does not leak the origin URL when origins differ', async () => {
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: 0, stdout: SYMREF_STDOUT },
    });
    const hostA = fakeExecutor({
      'rev-parse --show-toplevel': { exitCode: 0, stdout: '/lanes/a\n' },
      'remote get-url origin': { exitCode: 0, stdout: 'https://token@evil.example/x.git\n' },
    });
    const adapter = makeAdapter(orch.executor, { a: { executor: hostA.executor } });

    const report = await adapter.probe({
      repository: 'https://example.com/repo.git',
      clones: { a: { path: '/lanes/a', worktreeRoot: '/lanes/a-root' } },
    });

    const originCheck = report.checks.find((check) => check.name === 'origin-matches')!;
    expect(originCheck.result).toBe('fail');
    expect(originCheck.detail).toBe("origin does not match the profile's repository");
    expect(JSON.stringify(report)).not.toContain('evil');
    expect(JSON.stringify(report)).not.toContain('token');
  });

  it('normalises a trailing .git before comparing origins', async () => {
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: 0, stdout: SYMREF_STDOUT },
    });
    const hostA = fakeExecutor({
      'rev-parse --show-toplevel': { exitCode: 0, stdout: '/lanes/a\n' },
      'remote get-url origin': { exitCode: 0, stdout: 'git@github.com:o/r.git\n' },
    });
    const adapter = makeAdapter(orch.executor, { a: { executor: hostA.executor } });

    const report = await adapter.probe({
      repository: 'git@github.com:o/r',
      clones: { a: { path: '/lanes/a', worktreeRoot: '/lanes/a-root' } },
    });

    const originCheck = report.checks.find((check) => check.name === 'origin-matches')!;
    expect(originCheck.result).toBe('pass');
  });

  it('hints at .gitignore when .lane/ is not ignored', async () => {
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: 0, stdout: SYMREF_STDOUT },
    });
    const hostA = fakeExecutor({
      'rev-parse --show-toplevel': { exitCode: 0, stdout: '/lanes/a\n' },
      'check-ignore -q .lane/probe.md': { exitCode: 1 },
    });
    const adapter = makeAdapter(orch.executor, { a: { executor: hostA.executor } });

    const report = await adapter.probe({
      repository: REPO,
      clones: { a: { path: '/lanes/a', worktreeRoot: '/lanes/a-root' } },
    });

    const laneCheck = report.checks.find((check) => check.name === 'lane-dir-ignored')!;
    expect(laneCheck.result).toBe('fail');
    expect(laneCheck.detail).toBe(
      ".lane/ is not ignored; add the line .lane/ to '/lanes/a/.gitignore'",
    );
  });

  it('hints at mkdir -p when the worktree root is missing', async () => {
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: 0, stdout: SYMREF_STDOUT },
    });
    const hostA = fakeExecutor({
      'rev-parse --show-toplevel': { exitCode: 0, stdout: '/lanes/a\n' },
      'test -d': { exitCode: 1 },
    });
    const adapter = makeAdapter(orch.executor, { a: { executor: hostA.executor } });

    const report = await adapter.probe({
      repository: REPO,
      clones: { a: { path: '/lanes/a', worktreeRoot: '/lanes/a-root' } },
    });

    const rootCheck = report.checks.find((check) => check.name === 'worktree-root-exists')!;
    expect(rootCheck.result).toBe('fail');
    expect(rootCheck.detail).toBe("missing; on a run: mkdir -p '/lanes/a-root'");
  });

  it('passes agent instructions when only CLAUDE.md is tracked', async () => {
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: 0, stdout: SYMREF_STDOUT },
    });
    const hostA = fakeExecutor({
      'rev-parse --show-toplevel': { exitCode: 0, stdout: '/lanes/a\n' },
      'ls-files --error-unmatch AGENTS.md': { exitCode: 1 },
      'ls-files --error-unmatch CLAUDE.md': { exitCode: 0 },
    });
    const adapter = makeAdapter(orch.executor, { a: { executor: hostA.executor } });

    const report = await adapter.probe({
      repository: REPO,
      clones: { a: { path: '/lanes/a', worktreeRoot: '/lanes/a-root' } },
    });

    const agentsCheck = report.checks.find(
      (check) => check.name === 'agent-instructions-tracked',
    )!;
    expect(agentsCheck.result).toBe('pass');
    expect(agentsCheck.detail).toBe('CLAUDE.md');
    expect(hostA.calls.map((call) => call.argv)).toContainEqual([
      'git',
      ...EXPECTED_GIT_HARDENING,
      '-C',
      '/lanes/a',
      'ls-files',
      '--error-unmatch',
      'CLAUDE.md',
    ]);
  });

  it('caps detectedScripts at the first 200 sorted names and sets maxBufferBytes to 1 MiB', async () => {
    const scripts: Record<string, string> = {};
    for (let i = 299; i >= 0; i -= 1) {
      scripts[`script-${String(i).padStart(3, '0')}`] = 'echo ok';
    }
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: 0, stdout: SYMREF_STDOUT },
    });
    const hostA = fakeExecutor({
      ...passingHostCanned('/lanes/a'),
      'cat-file blob HEAD:package.json': {
        exitCode: 0,
        stdout: JSON.stringify({ scripts }),
      },
    });
    const adapter = makeAdapter(orch.executor, { a: { executor: hostA.executor } });

    const report = await adapter.probe({
      repository: REPO,
      clones: { a: { path: '/lanes/a', worktreeRoot: '/lanes/a-root' } },
    });

    expect(report.detectedScripts).toHaveLength(200);
    expect(report.detectedScripts[0]).toBe('script-000');
    expect(report.detectedScripts[199]).toBe('script-199');
    const catFileCall = hostA.calls.find((call) => call.argv.includes('cat-file'))!;
    expect(catFileCall.options?.maxBufferBytes).toBe(1048576);
  });

  it('hardens every git argv, passes minimal env with SSH_AUTH_SOCK only to orchestrator, and leaves host env unset', async () => {
    const orch = fakeExecutor({
      'ls-remote --symref': { exitCode: 0, stdout: SYMREF_STDOUT },
    });
    const hostA = fakeExecutor(passingHostCanned('/lanes/a'));
    const hostB = fakeExecutor(passingHostCanned('/lanes/b'));
    const adapter = makeAdapter(orch.executor, {
      a: { executor: hostA.executor },
      b: { executor: hostB.executor },
    });

    const previousSock = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = '/tmp/probe-agent.sock';
    try {
      await adapter.probe({
        repository: REPO,
        clones: {
          a: { path: '/lanes/a', worktreeRoot: '/lanes/a-root' },
          b: { path: '/lanes/b', worktreeRoot: '/lanes/b-root' },
        },
      });
    } finally {
      if (previousSock === undefined) {
        delete process.env.SSH_AUTH_SOCK;
      } else {
        process.env.SSH_AUTH_SOCK = previousSock;
      }
    }

    expect(orch.calls).toHaveLength(1);
    expect(orch.calls[0].argv.slice(1, 1 + EXPECTED_GIT_HARDENING.length)).toEqual(
      EXPECTED_GIT_HARDENING,
    );
    expect(orch.calls[0].options?.env?.GIT_TERMINAL_PROMPT).toBe('0');
    expect(orch.calls[0].options?.env?.GIT_ASKPASS).toBe('/bin/false');
    expect(orch.calls[0].options?.env?.SSH_ASKPASS).toBe('/bin/false');
    expect(orch.calls[0].options?.env?.SSH_AUTH_SOCK).toBe('/tmp/probe-agent.sock');

    for (const [calls, worktreeRoot] of [
      [hostA.calls, '/lanes/a-root'],
      [hostB.calls, '/lanes/b-root'],
    ] as const) {
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        if (call.argv[0] === 'git') {
          expect(call.argv.slice(1, 1 + EXPECTED_GIT_HARDENING.length)).toEqual(
            EXPECTED_GIT_HARDENING,
          );
        } else if (call.argv[0] === 'sh') {
          expect(call.argv).toEqual(physicalPathArgv(call.argv[4]!));
        } else {
          expect(call.argv).toEqual(['test', '-d', worktreeRoot]);
        }
        expect(call.options?.env).toBeUndefined();
      }
    }
  });

  it.each([
    'user:secret@host://x',
    'u:p@h/path://repo.git',
  ])('refuses a credential before a later scheme marker: %s', async (repository) => {
    const orch = fakeExecutor({});
    const adapter = makeAdapter(orch.executor, {});
    const report = await adapter.probe({ repository, clones: {} });
    const check = report.checks.find((c) => c.name === 'repository-answers')!;
    expect(check.result).toBe('fail');
    expect(check.detail).toBe('repository URL carries a credential; register it without one');
    expect(orch.calls).toHaveLength(0);
  });

  it.each(['https://host/o/r.git', 'ssh://git@host/p', 'git@github.com:o/r'])(
    'still probes a credential-free repository: %s',
    async (repository) => {
      const orch = fakeExecutor({ 'ls-remote --symref': { exitCode: 0, stdout: '' } });
      const adapter = makeAdapter(orch.executor, {});
      await adapter.probe({ repository, clones: {} });
      expect(orch.calls.some((c) => c.argv.includes('ls-remote'))).toBe(true);
    },
  );
});
