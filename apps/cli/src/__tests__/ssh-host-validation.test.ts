import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { readGitHead, createFleetCliRuntime } from '../composition.js';

describe('apps/cli readGitHead SSH host validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses to read HEAD over SSH when sshHost is -oProxyCommand=x and spawns no subprocess', async () => {
    await expect(
      readGitHead('/nonexistent/remote/worktree', '-oProxyCommand=x'),
    ).rejects.toThrow(/unsafe host/);

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('inserts -- before the command when invoking ssh on a safe host', async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: readonly string[], cb?: ExecFileCallback) => {
        if (cb) {
          cb(null, 'abc1234567890\n', '');
        }
      },
    );

    const head = await readGitHead('/nonexistent/remote/worktree', 'lanehost');

    expect(head).toBe('abc1234567890');
    expect(execFileMock).toHaveBeenCalled();
    const [file, args] = execFileMock.mock.calls[0] as [string, readonly string[]];
    expect(file).toBe('ssh');
    expect(args[0]).toBe('lanehost');
    expect(args[1]).toBe('--');
  });

  it('refuses verifyCurrentHeadSha with unsafe worktreeSshHost in runtime', async () => {
    const runtime = createFleetCliRuntime({
      worktreeSshHost: '-oProxyCommand=x',
    });

    await runtime.coordination.projectProfileRepository.saveProfile({
      projectId: 'proj-1',
      displayName: 'Project 1',
      repository: 'https://github.com/example/repo',
      designatedDispatcherHost: 'host-1',
      policyRevision: 'pol-1',
      maxConcurrentLanes: 1,
      runnerCapabilities: {},
      revision: 0,
      updatedAtIso: '2026-10-15T00:00:00Z',
      status: 'active',
      defaultBranch: null,
      clones: {},
      gateProcedures: [],
      defaultAllowedPathPrefixes: [],
      lastProbe: null,
    });

    await runtime.execution.attemptRepository.saveAttempt({
      id: 'att-test-1',
      workOrderId: 'wo-1',
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: '/nonexistent/remote/worktree',
      baseCommit: 'abc1234567890',
      state: 'running',
      outcome: null,
      briefDigest: 'sha256:abc',
      briefPackagePath: null,
      sessionId: null,
      completionReceipt: null,
      artifacts: null,
      createdAtIso: '2026-10-15T00:00:00Z',
      updatedAtIso: '2026-10-15T00:00:00Z',
    });

    // Attempting forgeAction with unsafe host must refuse
    const result = await runtime.execution.forgeAction.performForgeAction({
      actionId: 'act-1',
      attemptId: 'att-test-1',
      workOrderId: 'wo-1',
      kind: 'push-and-open-pr',
      expectedHeadSha: 'abc1234567890',
      branchName: 'feat/lane-1',
    });

    expect(result.outcome).toBe('ambiguous');
    expect((result as { reason: string }).reason).toMatch(/unsafe host/);

    expect(execFileMock).not.toHaveBeenCalled();
  });
});
