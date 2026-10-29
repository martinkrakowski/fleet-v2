// Adapter tests for ProcessTreeTerminationAdapter over a recording fake
// executor and a fake executorForHost: no subprocess, filesystem or network
// is exercised (the default-script case reads the repository's bundled
// bin/kill-worktree-tree file only).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';
import type { ExecutorForRecordedHostResult } from '../ExecutorForHost.helper.js';
import { ProcessTreeTerminationAdapter } from '../ProcessTreeTerminationAdapter.adapter.js';

type RunCall = { argv: readonly string[]; options?: CommandRunOptions };

const SCRIPT_TEXT = 'echo killed=0\n';
const WORKTREE = '/srv/fleet/worktrees/attempt-1';

/** A recording fake executor: every run is recorded and returns `canned`. */
function fakeExecutor(
  canned: Partial<CommandRunResult> = {},
): { executor: CommandExecutorPort; calls: RunCall[] } {
  const calls: RunCall[] = [];
  return {
    executor: {
      run: async (
        argv: readonly string[],
        options?: CommandRunOptions,
      ): Promise<CommandRunResult> => {
        calls.push({ argv, options });
        return { exitCode: 0, signal: null, stdout: '', stderr: '', ...canned };
      },
    },
    calls,
  };
}

/** A host-name → (executor | refusal) map, turned into the injected helper. */
type HostExecutorMap = Record<
  string,
  { executor: CommandExecutorPort } | { reason: string }
>;

function executorForHostFrom(map: HostExecutorMap): {
  executorForRecordedHost(
    recorded: AttemptRunnerRecord | null | undefined,
  ): ExecutorForRecordedHostResult;
  calls: (AttemptRunnerRecord | null | undefined)[];
} {
  const calls: (AttemptRunnerRecord | null | undefined)[] = [];
  return {
    calls,
    executorForRecordedHost(
      recorded: AttemptRunnerRecord | null | undefined,
    ): ExecutorForRecordedHostResult {
      calls.push(recorded);
      const name = recorded?.hostName ?? undefined;
      const entry = name === undefined ? undefined : map[name];
      if (entry === undefined) {
        return { ok: false, reason: `no executor for ${String(name)}` };
      }
      if ('executor' in entry) return { ok: true, executor: entry.executor };
      return { ok: false, reason: entry.reason };
    },
  };
}

const recordedRunner: AttemptRunnerRecord = {
  kind: 'opencode',
  remotePort: 4321,
  host: 'lane-host',
  hostName: 'lane-host',
  agent: 'opencode',
  model: 'model-x',
  variant: null,
};

/**
 * An adapter wired to one shared recording fixture: the fake executor the
 * helper returns is the same instance the test reads `calls` from.
 */
function adapterWith(
  canned: Partial<CommandRunResult> = {},
): {
  adapter: ProcessTreeTerminationAdapter;
  calls: RunCall[];
  helperCalls: (AttemptRunnerRecord | null | undefined)[];
} {
  const { executor, calls } = fakeExecutor(canned);
  const helper = executorForHostFrom({ 'lane-host': { executor } });
  return {
    calls,
    helperCalls: helper.calls,
    adapter: new ProcessTreeTerminationAdapter({
      executorForHost: {
        executorForRecordedHost: helper.executorForRecordedHost,
      },
      scriptText: SCRIPT_TEXT,
    }),
  };
}

function request(
  overrides: Partial<Parameters<ProcessTreeTerminationAdapter['terminateWorktreeProcesses']>[0]> = {},
): Parameters<ProcessTreeTerminationAdapter['terminateWorktreeProcesses']>[0] {
  return {
    attemptId: 'att-1',
    worktreePath: WORKTREE,
    runner: recordedRunner,
    gracePeriodSeconds: 5,
    ...overrides,
  };
}

describe('ProcessTreeTerminationAdapter', () => {
  it('runs the script on the recorded host with the path and grace as their own argv elements', async () => {
    const { adapter, calls } = adapterWith({ stdout: 'killed=0\n' });
    const result = await adapter.terminateWorktreeProcesses(
      request({ gracePeriodSeconds: 7 }),
    );
    expect(result).toEqual({ outcome: 'terminated', killed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual([
      'sh',
      '-c',
      SCRIPT_TEXT,
      'kill-worktree-tree',
      WORKTREE,
      '7',
    ]);
    // The worktree path never occurs inside the script element.
    expect(calls[0].argv[2]).not.toContain(WORKTREE);
  });

  it('passes the grace budget plus 20 s as the timeout and kills the process tree', async () => {
    const { adapter, calls } = adapterWith();
    await adapter.terminateWorktreeProcesses(request({ gracePeriodSeconds: 0 }));
    expect(calls[0].options).toEqual({ timeoutMs: 20_000, killProcessTree: true });
  });

  it('refuses a legacy record (no recorded host name) without a run', async () => {
    const { adapter, calls, helperCalls } = adapterWith();
    const result = await adapter.terminateWorktreeProcesses(
      request({ runner: null }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'attempt has no recorded host' });
    expect(calls).toHaveLength(0);
    expect(helperCalls).toHaveLength(0);
  });

  it('refuses with the helper reason when no executor exists for the recorded host', async () => {
    const helper = executorForHostFrom({});
    const adapter = new ProcessTreeTerminationAdapter({
      executorForHost: {
        executorForRecordedHost: helper.executorForRecordedHost,
      },
      scriptText: SCRIPT_TEXT,
    });
    const result = await adapter.terminateWorktreeProcesses(request());
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'no executor for lane-host',
    });
  });

  it.each([['relative/path'], [`${WORKTREE}\nescaped`]])(
    'refuses a non-absolute worktree path (%s) without a run',
    async (path) => {
      const { adapter, calls } = adapterWith();
      const result = await adapter.terminateWorktreeProcesses(
        request({ worktreePath: path }),
      );
      expect(result).toEqual({ outcome: 'refused', reason: 'worktree path is not absolute' });
      expect(calls).toHaveLength(0);
    },
  );

  it.each([-1, 601, 1.5, Number.NaN])(
    'refuses a grace period outside 0..600 (%p) without a run',
    async (grace) => {
      const { adapter, calls } = adapterWith();
      const result = await adapter.terminateWorktreeProcesses(
        request({ gracePeriodSeconds: grace }),
      );
      expect(result.outcome).toBe('refused');
      expect(calls).toHaveLength(0);
    },
  );

  it('refuses a shallow worktree path (fewer than three segments) without a run (PK-1a Fable)', async () => {
    for (const shallow of ['/', '/home', '/home/user', '//']) {
      const { adapter, calls } = adapterWith();
      const result = await adapter.terminateWorktreeProcesses(request({ worktreePath: shallow }));
      expect(result).toEqual({ outcome: 'refused', reason: 'worktree path is too shallow' });
      expect(calls).toHaveLength(0);
    }
  });

  it('ignores an unavailable= line that is not one word (PK-1a Fable)', async () => {
    const { adapter } = adapterWith({ exitCode: 3, stdout: 'unavailable=no-proc extra words\n', stderr: '' });
    const result = await adapter.terminateWorktreeProcesses(request());
    expect(result).toEqual({ outcome: 'unavailable', reason: 'kill-worktree-tree failed (exit 3)' });
  });

  it('parses the killed count from the last non-blank stdout line', async () => {
    const { adapter } = adapterWith({ stdout: 'warning noise\nkilled=3\n' });
    const result = await adapter.terminateWorktreeProcesses(request());
    expect(result).toEqual({ outcome: 'terminated', killed: 3 });
  });

  it('reports unavailable with the unavailable= line on exit 3', async () => {
    const { adapter } = adapterWith({
      exitCode: 3,
      stdout: 'unavailable=no-proc\n',
    });
    const result = await adapter.terminateWorktreeProcesses(request());
    expect(result).toEqual({ outcome: 'unavailable', reason: 'unavailable=no-proc' });
  });

  it('reports unavailable on any other exit and never echoes stderr into the reason', async () => {
    const { adapter } = adapterWith({
      exitCode: 1,
      stdout: '',
      stderr: 'secret detail from the remote host',
    });
    const result = await adapter.terminateWorktreeProcesses(request());
    expect(result).toEqual({
      outcome: 'unavailable',
      reason: 'kill-worktree-tree failed (exit 1)',
    });
  });

  it('reports unavailable when the script printed no kill count', async () => {
    const { adapter } = adapterWith({ exitCode: 0, stdout: '\n' });
    const result = await adapter.terminateWorktreeProcesses(request());
    expect(result).toEqual({
      outcome: 'unavailable',
      reason: 'script printed no kill count',
    });
  });

  it('reports unavailable when the run ended without an exit code', async () => {
    const { adapter } = adapterWith({ exitCode: null, signal: 'SIGTERM' });
    const result = await adapter.terminateWorktreeProcesses(request());
    expect(result).toEqual({
      outcome: 'unavailable',
      reason: 'kill-worktree-tree failed (exit SIGTERM)',
    });
  });

  it('reports unavailable with the not-found reason when the bundled script is absent', async () => {
    const { executor, calls } = fakeExecutor();
    const helper = executorForHostFrom({ 'lane-host': { executor } });
    const adapter = new ProcessTreeTerminationAdapter({
      executorForHost: {
        executorForRecordedHost: helper.executorForRecordedHost,
      },
      // The seam for the bundled file being missing.
      scriptText: null,
    });
    const result = await adapter.terminateWorktreeProcesses(request());
    expect(result).toEqual({
      outcome: 'unavailable',
      reason: 'kill-worktree-tree script not found',
    });
    expect(calls).toHaveLength(0);
  });

  it('defaults scriptText to the bundled bin/kill-worktree-tree file bytes', async () => {
    const { executor, calls } = fakeExecutor();
    const helper = executorForHostFrom({ 'lane-host': { executor } });
    const adapter = new ProcessTreeTerminationAdapter({
      executorForHost: {
        executorForRecordedHost: helper.executorForRecordedHost,
      },
    });
    await adapter.terminateWorktreeProcesses(request());
    const bundled = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        '..',
        '..',
        '..',
        'bin',
        'kill-worktree-tree',
      ),
      'utf8',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].argv[2]).toBe(bundled);
  });
});
