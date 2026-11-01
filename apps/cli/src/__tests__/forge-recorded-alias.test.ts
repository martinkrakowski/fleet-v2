// Forge head verification for recorded runner blocks: every recorded block
// resolves through the ExecutorForHost helper (SEC-1b). An alias-only record
// resolves through the single installation ssh `lane-runner` host with that
// alias, or is refused (owner decision D2) — never the legacy local read. The
// no-runner-block and legacy cases are regression guards: they pass before
// and after the change and keep today's behaviour exactly.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type ExecFileCallback = (
  error: Error | null,
  stdout?: string,
  stderr?: string,
) => void;

const execFileMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: readonly string[],
    optionsOrCallback?: unknown,
    callback?: ExecFileCallback,
  ) => {
    const cb = typeof optionsOrCallback === 'function'
      ? (optionsOrCallback as ExecFileCallback)
      : callback;
    return execFileMock(file, args, cb);
  },
}));

import type { FleetInstallation, ForgeSectionV2 } from '@fleet/installation';
import type { AttemptRunnerRecord } from '@fleet/work-execution';

import { createFleetCliRuntime } from '../composition.js';

const WORKTREE_PATH = '/nonexistent/remote/worktree';
const EXPECTED_HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_HEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BRANCH = 'feat/lane-1';

/** Minimal v2 installation: one local host plus one ssh lane-runner host. */
function makeInstallation(forge: ForgeSectionV2): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {
      local: {
        transport: 'local',
        worktreeRoot: '/tmp/fleet-sec-1b-worktrees',
        roles: ['orchestrator', 'lane-runner'],
        runner: {
          kind: 'opencode',
          port: 46000,
          capabilities: {
            networkEgressRestricted: true,
            cpuAndMemoryLimited: true,
            processTreeTermination: true,
            filesystemScope: 'scoped-worktree',
          },
          maxLanes: 2,
        },
      },
      'lane-host': {
        transport: 'ssh',
        sshAlias: 'lane.example',
        worktreeRoot: '/srv/fleet/worktrees',
        roles: ['lane-runner'],
        runner: {
          kind: 'opencode',
          port: 46001,
          capabilities: {
            networkEgressRestricted: true,
            cpuAndMemoryLimited: true,
            processTreeTermination: true,
            filesystemScope: 'scoped-worktree',
          },
          maxLanes: 2,
        },
      },
    },
    forge,
  };
}

/** A full recorded runner block with the requested host fields. */
function makeRunner(host: string | null, hostName: string | null): AttemptRunnerRecord {
  return {
    kind: 'opencode',
    remotePort: 46001,
    host,
    hostName,
    agent: 'opencode',
    model: 'test-model',
    variant: null,
  };
}

async function saveAttempt(
  runtime: ReturnType<typeof createFleetCliRuntime>,
  runner: AttemptRunnerRecord | null,
): Promise<void> {
  await runtime.coordination.projectProfileRepository.saveProfile({
    projectId: 'proj-1',
    displayName: 'Project 1',
    repository: 'https://github.com/example/repo',
    designatedDispatcherHost: 'host-1',
    policyRevision: 'pol-1',
    maxConcurrentLanes: 1,
    runnerCapabilities: {},
    revision: 0,
    updatedAtIso: '2026-10-31T00:00:00Z',
    status: 'active',
    defaultBranch: null,
    clones: {},
    gateProcedures: [],
    defaultAllowedPathPrefixes: [],
    lastProbe: null,
  });
  await runtime.execution.attemptRepository.saveAttempt({
    id: 'att-sec-1b-1',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE_PATH,
    baseCommit: EXPECTED_HEAD,
    state: 'running',
    outcome: null,
    briefDigest: 'sha256:abc',
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner,
    createdAtIso: '2026-10-31T00:00:00Z',
    updatedAtIso: '2026-10-31T00:00:00Z',
  });
}

function performAction(
  runtime: ReturnType<typeof createFleetCliRuntime>,
): Promise<unknown> {
  return runtime.execution.forgeAction.performForgeAction({
    actionId: 'act-1',
    attemptId: 'att-sec-1b-1',
    workOrderId: 'wo-1',
    kind: 'push-and-open-pr',
    expectedHeadSha: EXPECTED_HEAD,
    branchName: BRANCH,
  });
}

describe('forge head verification resolves the recorded host through the helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The legacy route reads FLEET_WORKTREE_SSH_HOST when no host is configured; keep the shell's value out.
    vi.stubEnv('FLEET_WORKTREE_SSH_HOST', '');
    vi.stubEnv('FLEET_FORGE_PUSH_ORIGIN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses an alias-only record whose alias matches no installation host (fails before the change)', async () => {
    const runtime = createFleetCliRuntime({
      installation: makeInstallation({
        mode: 'github',
        owner: 'example-owner',
        repo: 'example-repo',
      }),
      forgeActionDelegate: {
        runGh: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      },
    });
    await saveAttempt(runtime, makeRunner('other.example', null));
    // A pre-change local read returns a mismatch instead of timing out.
    execFileMock.mockImplementation(
      (_file: string, _args: readonly string[], cb?: ExecFileCallback) => {
        if (cb) {
          cb(null, `${OTHER_HEAD}\n`, '');
        }
      },
    );

    const result = (await performAction(runtime)) as { outcome: string; reason: string };

    expect(result.outcome).toBe('ambiguous');
    expect(result.reason).toMatch(
      /the attempt names a host alias that matches no single installation host/,
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('resolves an alias-only record through the matching ssh lane-runner host and pushes from it (fails before the change)', async () => {
    const runtime = createFleetCliRuntime({
      installation: makeInstallation({
        mode: 'github',
        owner: 'example-owner',
        repo: 'example-repo',
      }),
      forgeActionDelegate: {
        runGh: async () => ({
          exitCode: 0,
          stdout: 'https://github.com/example-owner/example-repo/pull/7',
          stderr: '',
        }),
      },
    });
    await saveAttempt(runtime, makeRunner('lane.example', null));
    execFileMock.mockImplementation(
      (_file: string, _args: readonly string[], cb?: ExecFileCallback) => {
        if (cb) {
          cb(null, `${EXPECTED_HEAD}\n`, '');
        }
      },
    );

    const result = (await performAction(runtime)) as { outcome: string };

    expect(result.outcome).toBe('executed');
    expect(execFileMock.mock.calls).toEqual([
      [
        'ssh',
        [
          'lane.example',
          '--',
          expect.stringContaining(
            `'git' '-C' '${WORKTREE_PATH}' 'rev-parse' 'HEAD'`,
          ),
        ],
        expect.any(Function),
      ],
      [
        'git',
        [
          'fetch',
          `lane.example:${WORKTREE_PATH}`,
          `${EXPECTED_HEAD}:refs/heads/${BRANCH}`,
          '--force',
        ],
        expect.any(Function),
      ],
      [
        'git',
        ['push', '-f', 'origin', `${EXPECTED_HEAD}:refs/heads/${BRANCH}`],
        expect.any(Function),
      ],
    ]);
  });

  it('keeps the legacy local HEAD read when no runner block is recorded (regression guard)', async () => {
    const runtime = createFleetCliRuntime({
      forgeActionDelegate: {
        runGh: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      },
    });
    await saveAttempt(runtime, null);
    // Keep the sha mismatch so the case stops at the HEAD check
    // (FLEET_FORGE_PUSH_ORIGIN comes from process.env).
    execFileMock.mockImplementation(
      (_file: string, _args: readonly string[], cb?: ExecFileCallback) => {
        if (cb) {
          cb(null, `${OTHER_HEAD}\n`, '');
        }
      },
    );

    const result = (await performAction(runtime)) as { outcome: string };

    expect(result.outcome).toBe('refused');
    expect(String(execFileMock.mock.calls[0])).toContain('rev-parse');
    expect(execFileMock.mock.calls[0]![0]).toBe('git');
    expect(execFileMock.mock.calls[0]![1]).toEqual([
      '-C',
      WORKTREE_PATH,
      'rev-parse',
      'HEAD',
    ]);
    expect(
      execFileMock.mock.calls.some(([file]) => file === 'ssh'),
    ).toBe(false);
  });

  it('reads HEAD over the configured legacy ssh host for an alias-only record with no installation hosts (regression guard)', async () => {
    const runtime = createFleetCliRuntime({
      worktreeSshHost: 'legacy.example',
      forgeActionDelegate: {
        runGh: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      },
    });
    // A recorded alias different from the configured host: the read must go to worktreeSshHost.
    await saveAttempt(runtime, makeRunner('recorded-only.example', null));
    // Keep the sha mismatch so the case stops at the HEAD check.
    execFileMock.mockImplementation(
      (_file: string, _args: readonly string[], cb?: ExecFileCallback) => {
        if (cb) {
          cb(null, `${OTHER_HEAD}\n`, '');
        }
      },
    );

    const result = (await performAction(runtime)) as { outcome: string };

    expect(result.outcome).toBe('refused');
    expect(execFileMock.mock.calls[0]![0]).toBe('ssh');
    expect(execFileMock.mock.calls[0]![1]![0]).toBe('legacy.example');
    expect(
      execFileMock.mock.calls.some(([, args]) => (args as readonly string[])?.[0] === 'recorded-only.example'),
    ).toBe(false);
  });

  it('post-status verifies the live head and returns it unchanged, never building the push plumbing (KS7a-2)', async () => {
    const ghCalls: string[][] = [];
    const runtime = createFleetCliRuntime({
      installation: makeInstallation({
        mode: 'github',
        owner: 'example-owner',
        repo: 'example-repo',
      }),
      forgeActionDelegate: {
        runGh: async (args) => {
          ghCalls.push([...args]);
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
    });
    await saveAttempt(runtime, makeRunner('lane.example', null));
    execFileMock.mockImplementation(
      (_file: string, _args: readonly string[], cb?: ExecFileCallback) => {
        if (cb) {
          cb(null, `${EXPECTED_HEAD}\n`, '');
        }
      },
    );

    const result = (await runtime.execution.forgeAction.performForgeAction({
      actionId: 'act-status-1',
      attemptId: 'att-sec-1b-1',
      workOrderId: 'wo-1',
      kind: 'post-status',
      expectedHeadSha: EXPECTED_HEAD,
      branchName: BRANCH,
      status: { context: 'premerge', state: 'success', description: 'pre-merge receipt recorded' },
    })) as { outcome: string; headSha: string };

    expect(result.outcome).toBe('executed');
    expect(result.headSha).toBe(EXPECTED_HEAD);
    // Only the head read ran — no git fetch/push; the push arguments are never built.
    expect(execFileMock.mock.calls).toEqual([
      [
        'ssh',
        [
          'lane.example',
          '--',
          expect.stringContaining(
            `'git' '-C' '${WORKTREE_PATH}' 'rev-parse' 'HEAD'`,
          ),
        ],
        expect.any(Function),
      ],
    ]);
    expect(ghCalls).toEqual([
      [
        'api',
        '-X',
        'POST',
        `repos/example-owner/example-repo/statuses/${EXPECTED_HEAD}`,
        '-f',
        'state=success',
        '-f',
        'context=premerge',
        '-f',
        'description=pre-merge receipt recorded',
      ],
    ]);
  });

  it('push-to-pr still verifies the live head before pushing (KS7a-2)', async () => {
    let prReads = 0;
    const runtime = createFleetCliRuntime({
      installation: makeInstallation({
        mode: 'github',
        owner: 'example-owner',
        repo: 'example-repo',
      }),
      forgeActionDelegate: {
        runGh: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      },
      forgeGhRunner: async () => {
        prReads += 1;
        // The pre-push read shows an open PR at ANOTHER head so the push reaches
        // the live-head check; the post-push read shows the pushed head.
        const head = prReads === 1 ? OTHER_HEAD : EXPECTED_HEAD;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            baseRefName: 'main',
            closedAt: null,
            headRefName: BRANCH,
            headRefOid: head,
            mergeCommit: null,
            mergedAt: null,
            number: 7,
            state: 'OPEN',
          }),
          stderr: '',
        };
      },
    });
    await saveAttempt(runtime, makeRunner('lane.example', null));
    execFileMock.mockImplementation(
      (_file: string, _args: readonly string[], cb?: ExecFileCallback) => {
        if (cb) {
          cb(null, `${EXPECTED_HEAD}\n`, '');
        }
      },
    );

    const result = (await runtime.execution.forgeAction.performForgeAction({
      actionId: 'act-push-1',
      attemptId: 'att-sec-1b-1',
      workOrderId: 'wo-1',
      kind: 'push-to-pr',
      expectedHeadSha: EXPECTED_HEAD,
      branchName: BRANCH,
    })) as { outcome: string; pullRequestNumber: number; headSha: string };

    expect(result.outcome).toBe('executed');
    expect(result.pullRequestNumber).toBe(7);
    expect(result.headSha).toBe(EXPECTED_HEAD);
    expect(execFileMock.mock.calls).toEqual([
      [
        'ssh',
        [
          'lane.example',
          '--',
          expect.stringContaining(
            `'git' '-C' '${WORKTREE_PATH}' 'rev-parse' 'HEAD'`,
          ),
        ],
        expect.any(Function),
      ],
      [
        'git',
        [
          'fetch',
          `lane.example:${WORKTREE_PATH}`,
          `${EXPECTED_HEAD}:refs/heads/${BRANCH}`,
          '--force',
        ],
        expect.any(Function),
      ],
      [
        'git',
        ['push', 'origin', `${EXPECTED_HEAD}:refs/heads/${BRANCH}`],
        expect.any(Function),
      ],
    ]);
  });
});
