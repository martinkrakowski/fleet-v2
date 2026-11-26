// Unit AB-CB12A: read-only listSessions on ExecutionRunnerAdapter.
import { describe, expect, it } from 'vitest';
import { types } from 'node:util';

import type { SubprocessResult, SubprocessRunner } from '../ExecutionRunnerAdapter.adapter.js';
import { ExecutionRunnerAdapter, parseListSessionsPayload } from '../ExecutionRunnerAdapter.adapter.js';
import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';

interface RecordedSubprocessCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

const runnerWorktreePath = '/tmp/fleet-test-worktree';

function scriptedRunner(
  results: readonly (SubprocessResult | Error)[],
): { readonly runner: SubprocessRunner; readonly calls: RecordedSubprocessCall[] } {
  const calls: RecordedSubprocessCall[] = [];
  let cursor = 0;
  const runner: SubprocessRunner = async (command, args, env) => {
    calls.push({ command, args: [...args], env });
    const result = results[Math.min(cursor, results.length - 1)];
    cursor += 1;
    if (result instanceof Error) throw result;
    return result;
  };
  return { runner, calls };
}

const runnerRecord: AttemptRunnerRecord = {
  kind: 'opencode',
  remotePort: 4166,
  host: null,
  agent: null,
  model: 'glm-5',
  variant: null,
};

function idleAdapter(results: readonly (SubprocessResult | Error)[]) {
  const { runner, calls } = scriptedRunner(results);
  const adapter = new ExecutionRunnerAdapter({ runSubprocess: runner, remotePort: 4166 });
  return { adapter, calls };
}

describe('ExecutionRunnerAdapter.listSessions', () => {
  it('missing worktreePath returns unreadable without invoking runner', async () => {
    const { adapter, calls } = idleAdapter([{ exitCode: 0, stdout: '', stderr: '' }]);

    const omitted = await adapter.listSessions();
    expect(omitted).toEqual({
      ok: false,
      error: 'unreadable',
      reason: 'Missing or invalid worktreePath',
    });

    const blank = await adapter.listSessions({ worktreePath: '   ', runner: runnerRecord });
    expect(blank).toEqual({
      ok: false,
      error: 'unreadable',
      reason: 'Missing or invalid worktreePath',
    });

    expect(calls).toHaveLength(0);
  });

  it('mismatched runner port returns unreadable', async () => {
    const { adapter, calls } = idleAdapter([{ exitCode: 0, stdout: '', stderr: '' }]);
    const status = await adapter.listSessions({
      worktreePath: runnerWorktreePath,
      runner: { ...runnerRecord, remotePort: 5199 },
    });
    expect(status).toEqual({
      ok: false,
      error: 'unreadable',
      reason: 'Configured runner port or host differs from recorded runner',
    });
    expect(calls).toHaveLength(0);
  });

  it('unsafe recorded runner host returns unreadable without invoking runner', async () => {
    const { adapter, calls } = idleAdapter([{ exitCode: 0, stdout: '', stderr: '' }]);
    const status = await adapter.listSessions({
      worktreePath: runnerWorktreePath,
      runner: { ...runnerRecord, host: '-oProxyCommand=evil' },
    });
    expect(status).toEqual({
      ok: false,
      error: 'unreadable',
      reason: 'Unsafe recorded runner host: -oProxyCommand=evil',
    });
    expect(calls).toHaveLength(0);
  });

  it('thrown runner subprocess returns unreachable', async () => {
    const { adapter } = idleAdapter([new Error('RunnerSubprocessError: connection refused')]);
    const status = await adapter.listSessions({ worktreePath: runnerWorktreePath, runner: runnerRecord });
    expect(status.ok).toBe(false);
    if (status.ok) return;
    expect(status.error).toBe('unreachable');
    expect(status.reason).toContain('connection refused');
  });

  it('exit code 1 returns unreachable', async () => {
    const { adapter } = idleAdapter([{ exitCode: 1, stdout: '', stderr: 'daemon not running' }]);
    const status = await adapter.listSessions({ worktreePath: runnerWorktreePath, runner: runnerRecord });
    expect(status).toEqual({
      ok: false,
      error: 'unreachable',
      reason: 'status command exited 1: daemon not running',
    });
  });

  it('exit code 2 or unexpected exit code returns unreadable', async () => {
    const { adapter } = idleAdapter([
      { exitCode: 2, stdout: '', stderr: 'usage error' },
      { exitCode: 4, stdout: '', stderr: '' },
    ]);
    const usage = await adapter.listSessions({ worktreePath: runnerWorktreePath, runner: runnerRecord });
    expect(usage).toEqual({
      ok: false,
      error: 'unreadable',
      reason: 'status command exited 2: usage error',
    });

    const unexpected = await adapter.listSessions({ worktreePath: runnerWorktreePath, runner: runnerRecord });
    expect(unexpected).toEqual({
      ok: false,
      error: 'unreadable',
      reason: 'status command exited 4: no output',
    });
  });

  it('exit code 3 without valid session ids returns unreadable', async () => {
    const { adapter } = idleAdapter([
      { exitCode: 3, stdout: 'ocm-run: running in /tmp/fleet-test-worktree:\nnot-a-session-id\n', stderr: '' },
      { exitCode: 3, stdout: 'ocm-run: running in /tmp/fleet-test-worktree:\nses_bad!!\n', stderr: '' },
    ]);
    const noIds = await adapter.listSessions({ worktreePath: runnerWorktreePath, runner: runnerRecord });
    expect(noIds).toEqual({
      ok: false,
      error: 'unreadable',
      reason: 'status exit 3 listed no valid session ids',
    });

    const invalidId = await adapter.listSessions({ worktreePath: runnerWorktreePath, runner: runnerRecord });
    expect(invalidId).toEqual({
      ok: false,
      error: 'unreadable',
      reason: 'status exit 3 listed no valid session ids',
    });
  });

  it('malformed JSON stdout returns unreadable', async () => {
    const { adapter } = idleAdapter([
      { exitCode: 0, stdout: '{"sessions": [ses_a}', stderr: '' },
      { exitCode: 3, stdout: '{"sessions": ["ses_a"', stderr: '' },
    ]);
    const exitZero = await adapter.listSessions({ worktreePath: runnerWorktreePath, runner: runnerRecord });
    expect(exitZero).toEqual({
      ok: false,
      error: 'unreadable',
      reason: 'Malformed JSON in runner status output',
    });

    const exitThree = await adapter.listSessions({ worktreePath: runnerWorktreePath, runner: runnerRecord });
    expect(exitThree).toEqual({
      ok: false,
      error: 'unreadable',
      reason: 'Malformed JSON in runner status output',
    });
  });

  it('exit 0 returns empty sessions and exit 3 returns parsed session ids', async () => {
    const { adapter, calls } = idleAdapter([
      { exitCode: 0, stdout: 'runner idle', stderr: '' },
      { exitCode: 3, stdout: 'ocm-run: running in /tmp/fleet-test-worktree:\nses_a\nses_b\n', stderr: '' },
      { exitCode: 3, stdout: '{"sessions": ["ses_c", "ses_d"]}', stderr: '' },
    ]);

    const idle = await adapter.listSessions({ worktreePath: runnerWorktreePath, runner: runnerRecord });
    expect(idle).toEqual({ ok: true, sessions: [] });

    const runningText = await adapter.listSessions({ worktreePath: runnerWorktreePath, runner: runnerRecord });
    expect(runningText).toEqual({ ok: true, sessions: ['ses_a', 'ses_b'] });

    const runningJson = await adapter.listSessions({ worktreePath: runnerWorktreePath, runner: runnerRecord });
    expect(runningJson).toEqual({ ok: true, sessions: ['ses_c', 'ses_d'] });

    for (const call of calls) {
      expect(call.args).toEqual(['--status', '--dir', runnerWorktreePath]);
    }
  });

  it('exit 0 JSON payload with a valid sessions array returns those sessions', async () => {
    const { adapter } = idleAdapter([{ exitCode: 0, stdout: '{"sessions": ["ses_x"]}', stderr: '' }]);
    const status = await adapter.listSessions({ worktreePath: runnerWorktreePath, runner: runnerRecord });
    expect(status).toEqual({ ok: true, sessions: ['ses_x'] });
  });
});

describe('parseListSessionsPayload', () => {
  it('parseListSessionsPayload refuses null, undefined, non-iterable, array hole, wrong primitive, getter, a Proxy, array-like, enormous length, and prototype-polluting keys as unreadable', () => {
    const unreadable = (value: unknown) => parseListSessionsPayload(value, types.isProxy);

    expect(unreadable(null).ok).toBe(false);
    expect(unreadable(undefined).ok).toBe(false);
    expect(unreadable(42).ok).toBe(false);
    expect(unreadable('ses_a').ok).toBe(false);
    // A non-iterable plain record without a `sessions` own property.
    expect(unreadable({ nope: true }).ok).toBe(false);
    // `sessions` present but not an array of valid ids.
    expect(unreadable({ sessions: 'ses_a' }).ok).toBe(false);
    expect(unreadable({ sessions: [42] }).ok).toBe(false);
    expect(unreadable({ sessions: [''] }).ok).toBe(false);
    expect(unreadable({ sessions: ['ses_'.repeat(33)] }).ok).toBe(false);
    expect(unreadable({ sessions: ['nope'] }).ok).toBe(false);

    // An array hole: sparse arrays are refused by snapshotPlainData.
    const holed: string[] = ['ses_a', 'ses_b'];
    delete holed[1];
    expect(unreadable(holed).ok).toBe(false);

    // A getter: its body must never execute (snapshotPlainData reads own
    // property descriptors; an accessor is refused, not invoked).
    let getterRan = false;
    const withGetter = {
      get sessions(): unknown {
        getterRan = true;
        return ['ses_a'];
      },
    };
    expect(unreadable(withGetter).ok).toBe(false);
    expect(getterRan).toBe(false);

    // A Proxy: the detector refuses it before any trap fires.
    const proxy = new Proxy({ sessions: ['ses_a'] }, {});
    expect(unreadable(proxy).ok).toBe(false);

    // An array-like object (not a real array, no `sessions` property).
    expect(unreadable({ 0: 'ses_a', length: 1 }).ok).toBe(false);

    // An enormous length: a too-long string is refused.
    expect(unreadable('ses_'.repeat(4096)).ok).toBe(false);
    const enormous = new Array(2000).fill('ses_a');
    expect(unreadable(enormous).ok).toBe(false);

    // Prototype-polluting keys: the plain record's `sessions` is read, but a
    // polluted prototype chain is not a plain object, and `__proto__`-shaped
    // keys are refused.
    const polluted = JSON.parse('{"sessions": ["ses_a"], "__proto__": {"x": 1}}');
    expect(unreadable(polluted).ok).toBe(false);
    expect(unreadable(Object.create({ sessions: ['ses_a'] })).ok).toBe(false);
  });

  it('parseListSessionsPayload accepts an array of session ids and a record with a sessions property', () => {
    const fromArray = parseListSessionsPayload(['ses_a', 'ses_b'], types.isProxy);
    expect(fromArray).toEqual({ ok: true, sessions: ['ses_a', 'ses_b'] });

    const fromRecord = parseListSessionsPayload({ sessions: ['ses_c'] }, types.isProxy);
    expect(fromRecord).toEqual({ ok: true, sessions: ['ses_c'] });

    const malformed = parseListSessionsPayload(['ses_a', 'oops'], types.isProxy);
    expect(malformed).toEqual({
      ok: false,
      error: 'unreadable',
      reason: 'Runner session payload holds an invalid session id',
    });
  });
});
