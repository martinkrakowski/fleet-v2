import { describe, expect, it } from 'vitest';

import { AttemptArtifactAdapter } from '../AttemptArtifactAdapter.adapter.js';
import { WorktreePathRefusedError } from '../../../application/ports/out/WorkspacePort.out-port.js';
import type {
  CommandRunOptions,
  CommandRunResult,
  CommandExecutorPort,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { CommandCompletionReceipt } from '../../../domain/execution-records.js';

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

function receiptFor(attemptId: string): CommandCompletionReceipt {
  return {
    attemptId,
    sessionId: 'session-1',
    endedAtIso: '2026-10-24T10:00:00.000Z',
    authoritative: true,
    exitStatus: 0,
    stoppedByRequest: false,
  };
}

describe('AttemptArtifactAdapter path containment', () => {
  it('refuses an absolute manifestPath before any cat', async () => {
    const { executor, calls } = fakeExecutor(() => ({}));
    const adapter = new AttemptArtifactAdapter({ executor });

    await expect(adapter.readBriefManifest('/wt', '/etc/passwd')).rejects.toBeInstanceOf(
      WorktreePathRefusedError,
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses an escaping manifestPath before any cat', async () => {
    const { executor, calls } = fakeExecutor(() => ({}));
    const adapter = new AttemptArtifactAdapter({ executor });

    await expect(adapter.readBriefManifest('/wt', '../x')).rejects.toBeInstanceOf(
      WorktreePathRefusedError,
    );
    expect(calls).toHaveLength(0);
  });

  it('reads the default manifest path under the worktree', async () => {
    const { executor, calls } = fakeExecutor(() => ({ stdout: 'manifest-bytes' }));
    const adapter = new AttemptArtifactAdapter({ executor });

    expect(await adapter.readBriefManifest('/wt')).toBe('manifest-bytes');
    expect(calls[0].argv).toEqual(['cat', '/wt/.lane/brief-manifest.json']);
  });

  it('refuses an escaping expected artifact before any probe in collection', async () => {
    const { executor, calls } = fakeExecutor((call) =>
      call.argv[0] === 'git' ? { stdout: 'abc123\n' } : { exitCode: 1 },
    );
    const adapter = new AttemptArtifactAdapter({ executor });

    await expect(
      adapter.collectCompletedAttemptArtifacts({
        attemptId: 'att-1',
        worktreePath: '/wt',
        baseCommit: 'abc123',
        expectedArtifactPaths: ['../x'],
        completionReceipt: receiptFor('att-1'),
      }),
    ).rejects.toBeInstanceOf(WorktreePathRefusedError);
    expect(
      calls.filter((call) =>
        call.argv.some(
          (argument) =>
            /(^|\/)\.\.(\/|$)/.test(argument) ||
            (argument.startsWith('/') && argument !== '/wt' && !argument.startsWith('/wt/')),
        ),
      ),
    ).toHaveLength(0);
  });

  it('refuses a bad worktree root before any command in brief placement', async () => {
    const { executor, calls } = fakeExecutor(() => ({}));
    const adapter = new AttemptArtifactAdapter({ executor });

    for (const worktreePath of ['/', '', 'wt']) {
      const result = await adapter.placeFrozenBrief({
        attemptId: 'att-1',
        worktreePath,
        proseMarkdown: 'prose',
        manifestJson: '{}',
      });
      expect(result.outcome).toBe('refused');
    }
    expect(calls).toHaveLength(0);
  });
});
