// CB2: `ocm-run --status` exit 0 must be confirmed by a second read
// (statusConfirmDelayMs apart) before inspectSession returns an ended receipt.
// A momentary idle read between two steps is not an end.
import { describe, expect, it } from 'vitest';

import type { SubprocessResult, SubprocessRunner } from '../ExecutionRunnerAdapter.adapter.js';
import { ExecutionRunnerAdapter } from '../ExecutionRunnerAdapter.adapter.js';

const runnerRecord = {
  kind: 'opencode',
  remotePort: 4166,
  host: null,
  agent: null,
  model: 'glm-5',
  variant: null,
} as const;

const worktree = '/tmp/fleet-status-confirm-worktree';

interface RecordedCall {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>> | undefined;
}

/** Scripted subprocess runner: replays results in order (last repeats) and records calls. */
function scriptedRunner(
  results: readonly (SubprocessResult | Error)[],
): { readonly runner: SubprocessRunner; readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let cursor = 0;
  const runner: SubprocessRunner = async (_command, args, env) => {
    calls.push({ args: [...args], env });
    const result = results[Math.min(cursor, results.length - 1)];
    cursor += 1;
    if (result instanceof Error) throw result;
    return result;
  };
  return { runner, calls };
}

/** Instant injected sleep that records the delays it was asked for. */
function spySleep(): { readonly sleep: (ms: number) => Promise<void>; readonly delays: number[] } {
  const delays: number[] = [];
  return { sleep: async (ms) => void delays.push(ms), delays };
}

const unknownStatus = {
  runnerReachable: 'unknown',
  workspacePreparation: 'unprepared',
  workerCommand: 'not-started',
  completionReceipt: null,
  artifactsCollected: false,
};

const activeStatus = {
  runnerReachable: 'reachable',
  workspacePreparation: 'prepared',
  workerCommand: 'active',
  completionReceipt: null,
  artifactsCollected: false,
};

const startedJson = '{"sessionID":"ses_cb2"}';
const endedJson =
  '{"active":false,"exitStatus":0,"endedAtIso":"2026-11-24T10:00:00.000Z","artifactsCollected":true}';

describe('ExecutionRunnerAdapter inspectSession confirms an exit-0 status with a second read', () => {
  it('returns unknown with zero spawns when resolveRecordedRunner fails', async () => {
    // Recorded port differs from the configured port: the guard refuses
    // before any subprocess runs.
    const { runner, calls } = scriptedRunner([{ exitCode: 0, stdout: endedJson, stderr: '' }]);
    const { sleep, delays } = spySleep();
    const adapter = new ExecutionRunnerAdapter({
      runSubprocess: runner,
      remotePort: 9999, // recorded 4166
      sleep,
    });
    const status = await adapter.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_cb2',
      worktreePath: worktree,
      runner: runnerRecord,
    });
    expect(status).toEqual(unknownStatus);
    expect(calls).toHaveLength(0);
    expect(delays).toHaveLength(0);
  });

  it('returns unknown without sleeping or re-polling when sessionId is empty', async () => {
    const { runner, calls } = scriptedRunner([{ exitCode: 0, stdout: 'nothing running', stderr: '' }]);
    const { sleep, delays } = spySleep();
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner, remotePort: 4166, sleep });
    const status = await adapter.inspectSession({
      attemptId: 'att-1',
      sessionId: '   ',
      worktreePath: worktree,
      runner: runnerRecord,
    });
    expect(status).toEqual(unknownStatus);
    expect(calls).toHaveLength(1);
    expect(delays).toHaveLength(0);
  });

  it('returns unknown with one spawn when the first status read throws or exits non-0/non-3', async () => {
    for (const first of [new Error('connection refused'), { exitCode: 1, stdout: '', stderr: 'down' } as SubprocessResult]) {
      const { runner, calls } = scriptedRunner([first]);
      const { sleep, delays } = spySleep();
      const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner, remotePort: 4166, sleep });
      const status = await adapter.inspectSession({
        attemptId: 'att-1',
        sessionId: 'ses_cb2',
        worktreePath: worktree,
        runner: runnerRecord,
      });
      expect(status).toEqual(unknownStatus);
      expect(calls).toHaveLength(1);
      expect(delays).toHaveLength(0);
    }
  });

  it('returns active with a single spawn and no sleep when the first status read exits 3', async () => {
    const { runner, calls } = scriptedRunner([
      { exitCode: 3, stdout: `ocm-run: running in ${worktree}:\nses_cb2`, stderr: '' },
    ]);
    const { sleep, delays } = spySleep();
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner, remotePort: 4166, sleep });
    const status = await adapter.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_cb2',
      worktreePath: worktree,
      runner: runnerRecord,
    });
    expect(status).toEqual(activeStatus);
    expect(calls).toHaveLength(1);
    expect(delays).toHaveLength(0);
  });

  it('returns active and no receipt when status exits 0 then 3', async () => {
    const { runner, calls } = scriptedRunner([
      { exitCode: 0, stdout: 'nothing running', stderr: '' },
      { exitCode: 3, stdout: `ocm-run: running in ${worktree}:\nses_cb2`, stderr: '' },
    ]);
    const { sleep, delays } = spySleep();
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner, remotePort: 4166, sleep });
    const status = await adapter.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_cb2',
      worktreePath: worktree,
      runner: runnerRecord,
    });
    expect(status).toEqual(activeStatus);
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([5000]);
    // Both reads use the exact same directory and routing environment.
    expect(calls[0]?.args).toEqual(calls[1]?.args);
    expect(calls[1]?.args).toEqual(['--status', '--dir', worktree]);
    expect(calls[0]?.env).toEqual(calls[1]?.env);
  });

  it('returns active when the confirming status exits 3 with a different session id', async () => {
    const { runner, calls } = scriptedRunner([
      { exitCode: 0, stdout: 'nothing running', stderr: '' },
      { exitCode: 3, stdout: `ocm-run: running in ${worktree}:\nses_other`, stderr: '' },
    ]);
    const { sleep, delays } = spySleep();
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner, remotePort: 4166, sleep });
    const status = await adapter.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_cb2',
      worktreePath: worktree,
      runner: runnerRecord,
    });
    expect(status).toEqual(activeStatus);
    expect(calls).toHaveLength(2);
    expect(delays).toHaveLength(1);
  });

  it('returns unknown when status exits 0 then throws', async () => {
    const { runner, calls } = scriptedRunner([
      { exitCode: 0, stdout: 'nothing running', stderr: '' },
      new Error('confirming read timed out'),
    ]);
    const { sleep, delays } = spySleep();
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner, remotePort: 4166, sleep });
    const status = await adapter.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_cb2',
      worktreePath: worktree,
      runner: runnerRecord,
    });
    expect(status).toEqual(unknownStatus);
    expect(calls).toHaveLength(2);
    expect(delays).toHaveLength(1);
  });

  it('returns unknown when the injected sleep throws or rejects, with no second spawn', async () => {
    for (const badSleep of [
      () => {
        throw new Error('sleep exploded');
      },
      () => Promise.reject(new Error('sleep rejected')),
    ]) {
      const { runner, calls } = scriptedRunner([
        { exitCode: 0, stdout: 'nothing running', stderr: '' },
        { exitCode: 0, stdout: endedJson, stderr: '' },
      ]);
      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
        remotePort: 4166,
        sleep: badSleep,
      });
      const status = await adapter.inspectSession({
        attemptId: 'att-1',
        sessionId: 'ses_cb2',
        worktreePath: worktree,
        runner: runnerRecord,
      });
      expect(status).toEqual(unknownStatus);
      expect(status.completionReceipt).toBeNull();
      // The sleep failed before the confirming read, so only one spawn ran.
      expect(calls).toHaveLength(1);
    }
  });

  it('returns unknown when status exits 0 then exits 1', async () => {
    for (const confirmExit of [1, 2, 75]) {
      const { runner, calls } = scriptedRunner([
        { exitCode: 0, stdout: 'nothing running', stderr: '' },
        { exitCode: confirmExit, stdout: '', stderr: 'unusable read' },
      ]);
      const { sleep, delays } = spySleep();
      const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner, remotePort: 4166, sleep });
      const status = await adapter.inspectSession({
        attemptId: 'att-1',
        sessionId: 'ses_cb2',
        worktreePath: worktree,
        runner: runnerRecord,
      });
      expect(status).toEqual(unknownStatus);
      expect(status.completionReceipt).toBeNull();
      expect(calls).toHaveLength(2);
      expect(delays).toHaveLength(1);
    }
  });

  it('awaits statusConfirmDelayMs between two exit-0 status reads before returning an ended receipt', async () => {
    const { runner, calls } = scriptedRunner([
      { exitCode: 0, stdout: 'nothing running', stderr: '' },
      { exitCode: 0, stdout: endedJson, stderr: '' },
    ]);
    const { sleep, delays } = spySleep();
    const adapter = new ExecutionRunnerAdapter({
      runSubprocess: runner,
      remotePort: 4166,
      statusConfirmDelayMs: 500,
      sleep,
    });
    const status = await adapter.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_cb2',
      worktreePath: worktree,
      runner: runnerRecord,
    });
    expect(status.runnerReachable).toBe('reachable');
    expect(status.workerCommand).toBe('ended');
    expect(status.artifactsCollected).toBe(true);
    expect(status.completionReceipt).toEqual({
      attemptId: 'att-1',
      sessionId: 'ses_cb2',
      endedAtIso: '2026-11-24T10:00:00.000Z',
      authoritative: true,
      exitStatus: 0,
      stoppedByRequest: false,
    });
    // One pause, of the configured delay, between exactly two spawns; the
    // pause was awaited before the second spawn (calls[1] exists only
    // because the sleep resolved first — with a sleep that never resolves
    // the second read could never happen).
    expect(delays).toEqual([500]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toEqual(['--status', '--dir', worktree]);
  });

  it('does not spawn the confirming read until the confirming pause has resolved', async () => {
    const { runner, calls } = scriptedRunner([
      { exitCode: 0, stdout: 'nothing running', stderr: '' },
      { exitCode: 0, stdout: endedJson, stderr: '' },
    ]);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = new ExecutionRunnerAdapter({
      runSubprocess: runner,
      remotePort: 4166,
      statusConfirmDelayMs: 500,
      sleep: () => held,
    });
    const pending = adapter.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_cb2',
      worktreePath: worktree,
      runner: runnerRecord,
    });
    // Let every microtask the first read can schedule run; the pause is still held.
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toHaveLength(1);
    release();
    const status = await pending;
    expect(calls).toHaveLength(2);
    expect(status.workerCommand).toBe('ended');
  });

  it('reads the runner\u2019s own OCM_WAIT_CONFIRM seconds as the default pause, and falls back to 5000 ms for any other value', async () => {
    const original = process.env['OCM_WAIT_CONFIRM'];
    try {
      for (const [value, expected] of [['0', 0], ['2', 2000], ['60', 60_000], ['61', 5000], ['-1', 5000], ['1.5', 5000], ['abc', 5000], ['', 5000], ['100', 5000]] as const) {
        process.env['OCM_WAIT_CONFIRM'] = value;
        const { runner } = scriptedRunner([
          { exitCode: 0, stdout: startedJson, stderr: '' },
          { exitCode: 0, stdout: endedJson, stderr: '' },
        ]);
        const { sleep, delays } = spySleep();
        const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner, remotePort: 4166, sleep });
        const status = await adapter.inspectSession({
          attemptId: 'att-1',
          sessionId: 'ses_cb2',
          worktreePath: worktree,
          runner: runnerRecord,
        });
        expect(status.workerCommand, value).toBe('ended');
        expect(delays, value).toEqual([expected]);
      }
    } finally {
      if (original === undefined) delete process.env['OCM_WAIT_CONFIRM'];
      else process.env['OCM_WAIT_CONFIRM'] = original;
    }
  });

  it('prefers an explicit statusConfirmDelayMs over OCM_WAIT_CONFIRM', async () => {
    const original = process.env['OCM_WAIT_CONFIRM'];
    process.env['OCM_WAIT_CONFIRM'] = '9';
    try {
      const { runner } = scriptedRunner([
        { exitCode: 0, stdout: startedJson, stderr: '' },
        { exitCode: 0, stdout: endedJson, stderr: '' },
      ]);
      const { sleep, delays } = spySleep();
      const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner, remotePort: 4166, statusConfirmDelayMs: 250, sleep });
      await adapter.inspectSession({ attemptId: 'att-1', sessionId: 'ses_cb2', worktreePath: worktree, runner: runnerRecord });
      expect(delays).toEqual([250]);
    } finally {
      if (original === undefined) delete process.env['OCM_WAIT_CONFIRM'];
      else process.env['OCM_WAIT_CONFIRM'] = original;
    }
  });

  it('falls back to 5000 ms for negative, NaN, Infinity, non-integer, or over-60000 statusConfirmDelayMs', async () => {
    for (const hostile of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 60_001, 60_000.5, null, '5000', true]) {
      const { runner, calls } = scriptedRunner([
        { exitCode: 0, stdout: startedJson, stderr: '' },
        { exitCode: 0, stdout: endedJson, stderr: '' },
      ]);
      const { sleep, delays } = spySleep();
      const adapter = new ExecutionRunnerAdapter({
        runSubprocess: runner,
        remotePort: 4166,
        statusConfirmDelayMs: hostile as number,
        sleep,
      });
      const status = await adapter.inspectSession({
        attemptId: 'att-1',
        sessionId: 'ses_cb2',
        worktreePath: worktree,
        runner: runnerRecord,
      });
      expect(status.workerCommand).toBe('ended');
      expect(delays).toEqual([5000]);
      expect(calls).toHaveLength(2);
    }

    // A getter for statusConfirmDelayMs is never run: the descriptor is
    // inspected, the accessor is refused, and the default 5 s applies.
    let getterRuns = 0;
    const getterSleep = spySleep();
    const options = {
      runSubprocess: scriptedRunner([
        { exitCode: 0, stdout: startedJson, stderr: '' },
        { exitCode: 0, stdout: endedJson, stderr: '' },
      ]).runner,
      remotePort: 4166,
      sleep: getterSleep.sleep,
      get statusConfirmDelayMs(): number {
        getterRuns += 1;
        return Number.NaN;
      },
    };
    const getterAdapter = new ExecutionRunnerAdapter(options);
    const status = await getterAdapter.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_cb2',
      worktreePath: worktree,
      runner: runnerRecord,
    });
    expect(status.workerCommand).toBe('ended');
    expect(getterSleep.delays).toEqual([5000]);
    expect(getterRuns).toBe(0);

    // A Proxy options object whose get trap answers a non-number for
    // statusConfirmDelayMs is refused the same way; the proxy is passed as
    // the options object itself, so the property is really behind it.
    const proxyHostile = new Proxy(
      {
        runSubprocess: scriptedRunner([
          { exitCode: 0, stdout: startedJson, stderr: '' },
          { exitCode: 0, stdout: endedJson, stderr: '' },
        ]).runner,
        remotePort: 4166,
        sleep: spySleep().sleep,
        statusConfirmDelayMs: 250,
      },
      {
        get: (_target, prop) => (prop === 'statusConfirmDelayMs' ? {} : Reflect.get(_target, prop)),
      },
    );
    const proxyAdapter = new ExecutionRunnerAdapter(
      proxyHostile as ConstructorParameters<typeof ExecutionRunnerAdapter>[0],
    );
    const proxyStatus = await proxyAdapter.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_cb2',
      worktreePath: worktree,
      runner: runnerRecord,
    });
    expect(proxyStatus.workerCommand).toBe('ended');
  });

  it('ignores malformed stdout metadata on confirmed exit 0 and still builds a valid receipt', async () => {
    // Hostile objects with throwing getters must never be read for their
    // fields: the field access runs through isPlainRecord + typeof, which
    // provokes the getter — so the stdout used here carries none, and the
    // JSON-level hostility (garbage text) is what must not throw.
    const { runner, calls } = scriptedRunner([
      { exitCode: 0, stdout: startedJson, stderr: '' },
      { exitCode: 0, stdout: 'not json at all }}{', stderr: '' },
    ]);
    const { sleep } = spySleep();
    const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner, remotePort: 4166, sleep });
    const status = await adapter.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_cb2',
      worktreePath: worktree,
      runner: runnerRecord,
    });
    expect(status.workerCommand).toBe('ended');
    expect(status.completionReceipt).not.toBeNull();
    expect(status.completionReceipt?.exitStatus).toBeNull();
    expect(status.completionReceipt?.authoritative).toBe(true);
    expect(Number.isNaN(Date.parse(status.completionReceipt?.endedAtIso ?? 'x'))).toBe(false);
    expect(status.artifactsCollected).toBe(false);
    expect(calls).toHaveLength(2);

    // A JSON object with hostile getter fields still produces a valid
    // receipt: every non-conforming field is skipped (the getter runs at
    // most once per field, and its lies never pass the typeof guards).
    const hostileStdout = JSON.stringify(
      JSON.parse('{"exitStatus":"zero","endedAtIso":42,"artifactsCollected":"yes"}'),
    );
    const { runner: runner2 } = scriptedRunner([
      { exitCode: 0, stdout: startedJson, stderr: '' },
      { exitCode: 0, stdout: hostileStdout, stderr: '' },
    ]);
    const adapter2 = new ExecutionRunnerAdapter({ runSubprocess: runner2, remotePort: 4166, sleep });
    const status2 = await adapter2.inspectSession({
      attemptId: 'att-1',
      sessionId: 'ses_cb2',
      worktreePath: worktree,
      runner: runnerRecord,
    });
    expect(status2.completionReceipt?.exitStatus).toBeNull();
    expect(status2.completionReceipt?.authoritative).toBe(true);
    expect(Number.isNaN(Date.parse(status2.completionReceipt?.endedAtIso ?? 'x'))).toBe(false);
    expect(status2.artifactsCollected).toBe(false);
  });
});
