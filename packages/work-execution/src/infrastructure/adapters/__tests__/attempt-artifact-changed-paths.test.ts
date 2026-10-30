/**
 * Unit tests for the KF-33a changed-paths read: `readChangedPaths` runs one
 * hardened, NUL-separated `git diff --name-only` through the configured (or
 * recorded host's) executor, refuses non-hex commit ids before any command,
 * and turns any failure into null so callers fail closed. No subprocess, no
 * network — a recording fake executor only.
 */

import { describe, expect, it } from 'vitest';

import { AttemptArtifactAdapter } from '../AttemptArtifactAdapter.adapter.js';
import type {
  CommandRunOptions,
  CommandRunResult,
  CommandExecutorPort,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';

type RunCall = { argv: readonly string[]; options?: CommandRunOptions };

/** A recording fake executor with scripted outcomes per call (the containment test's pattern). */
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

const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const HARDENING = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

describe('AttemptArtifactAdapter.readChangedPaths (KF-33a)', () => {
  it('runs one hardened NUL-separated name-only diff and parses the paths', async () => {
    const { executor, calls } = fakeExecutor(() => ({
      stdout: 'src/a.ts\0a path with spaces.txt\0packages/b/c.ts\0',
    }));
    const adapter = new AttemptArtifactAdapter({ executor });

    const paths = await adapter.readChangedPaths!(WORKTREE, BASE, HEAD);
    expect(paths).toEqual(['src/a.ts', 'a path with spaces.txt', 'packages/b/c.ts']);
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual([
      'git', '-C', WORKTREE, ...HARDENING,
      'diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', BASE, HEAD, '--',
    ]);
  });

  it('drops the empty tail only: a trailing NUL adds no path, an interior empty field is kept', async () => {
    const { executor } = fakeExecutor(() => ({ stdout: 'src/a.ts\0src/b.ts\0' }));
    const adapter = new AttemptArtifactAdapter({ executor });
    expect(await adapter.readChangedPaths!(WORKTREE, BASE, HEAD)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('an empty diff yields an empty list', async () => {
    const { executor } = fakeExecutor(() => ({ stdout: '' }));
    const adapter = new AttemptArtifactAdapter({ executor });
    expect(await adapter.readChangedPaths!(WORKTREE, BASE, HEAD)).toEqual([]);
  });

  it('a non-zero git exit becomes null, never a throw', async () => {
    const { executor } = fakeExecutor(() => ({ exitCode: 128, stderr: 'bad object' }));
    const adapter = new AttemptArtifactAdapter({ executor });
    expect(await adapter.readChangedPaths!(WORKTREE, BASE, HEAD)).toBeNull();
  });

  it('a non-hex base or head is refused with no command run', async () => {
    const { executor, calls } = fakeExecutor(() => ({ stdout: 'src/a.ts\0' }));
    const adapter = new AttemptArtifactAdapter({ executor });
    expect(await adapter.readChangedPaths!(WORKTREE, 'HEAD~1', HEAD)).toBeNull();
    expect(await adapter.readChangedPaths!(WORKTREE, BASE, 'B'.repeat(40))).toBeNull();
    expect(await adapter.readChangedPaths!(WORKTREE, BASE, 'a'.repeat(41))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('accepts 64-hex commit ids too', async () => {
    const { executor, calls } = fakeExecutor(() => ({ stdout: 'src/a.ts\0' }));
    const adapter = new AttemptArtifactAdapter({ executor });
    expect(await adapter.readChangedPaths!(WORKTREE, 'a'.repeat(64), 'b'.repeat(64))).toEqual(['src/a.ts']);
    expect(calls).toHaveLength(1);
  });

  it('a throwing executor becomes null, never a throw', async () => {
    const executor: CommandExecutorPort = {
      run: async (): Promise<CommandRunResult> => {
        throw new Error('transport gone');
      },
    };
    const adapter = new AttemptArtifactAdapter({ executor });
    expect(await adapter.readChangedPaths!(WORKTREE, BASE, HEAD)).toBeNull();
  });

  it('uses the recorded host executor when one is wired and none of the default one', async () => {
    const recordedHost: AttemptRunnerRecord = {
      hostName: 'lane-example',
    } as AttemptRunnerRecord;
    const defaultScript = fakeExecutor(() => ({ stdout: 'wrong.txt\0' }));
    const recordedScript = fakeExecutor(() => ({ stdout: 'src/a.ts\0' }));
    const adapter = new AttemptArtifactAdapter({
      executor: defaultScript.executor,
      executorForRecordedHost: () => ({ ok: true, executor: recordedScript.executor }),
    });
    expect(await adapter.readChangedPaths!(WORKTREE, BASE, HEAD, recordedHost)).toEqual(['src/a.ts']);
    expect(recordedScript.calls).toHaveLength(1);
    expect(defaultScript.calls).toEqual([]);
  });
});
