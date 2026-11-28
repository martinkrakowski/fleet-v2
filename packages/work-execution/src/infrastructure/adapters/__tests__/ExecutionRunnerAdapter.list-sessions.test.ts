// AB-CB12A: read-only `listSessions` on `ExecutionRunnerAdapter`. Every
// failure or unknown path fails closed (`unreachable` / `unreadable`), and
// every untrusted value is read only through `snapshotPlainData`.
import { types } from 'node:util';

import { describe, expect, it } from 'vitest';

import { parseListSessionsPayload } from '../ExecutionRunnerAdapter.adapter.js';
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

const worktree = '/tmp/fleet-list-sessions-worktree';

const refused = (reason: string) => ({ ok: false, error: 'unreadable', reason: expect.stringMatching(reason) });
const unreachable = { ok: false, error: 'unreachable', reason: expect.any(String) };

interface RecordedCall {
  readonly args: readonly string[];
}

/** Scripted subprocess runner: replays results in order (last repeats) and records calls. */
function scriptedRunner(
  results: readonly (SubprocessResult | Error)[],
): { readonly runner: SubprocessRunner; readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let cursor = 0;
  const runner: SubprocessRunner = async (_command, args) => {
    calls.push({ args: [...args] });
    const result = results[Math.min(cursor, results.length - 1)];
    cursor += 1;
    if (result instanceof Error) throw result;
    return result;
  };
  return { runner, calls };
}

function adapterWith(runner: SubprocessRunner, extra?: { remotePort?: number }): ExecutionRunnerAdapter {
  return new ExecutionRunnerAdapter({ runSubprocess: runner, remotePort: extra?.remotePort ?? 4166 });
}

describe('ExecutionRunnerAdapter listSessions refusals', () => {
  it('missing worktreePath returns unreadable without invoking runner', async () => {
    const { runner, calls } = scriptedRunner([{ exitCode: 0, stdout: '', stderr: '' }]);
    const adapter = adapterWith(runner);
    expect(await adapter.listSessions({})).toEqual(refused('Missing or invalid worktreePath'));
    expect(await adapter.listSessions({ worktreePath: '   ' })).toEqual(refused('Missing or invalid worktreePath'));
    expect(await adapter.listSessions()).toEqual(refused('Missing or invalid worktreePath'));
    expect(calls).toHaveLength(0);
  });

  it('mismatched runner port returns unreadable', async () => {
    const { runner, calls } = scriptedRunner([{ exitCode: 0, stdout: '', stderr: '' }]);
    const adapter = adapterWith(runner, { remotePort: 9999 }); // recorded 4166
    const result = await adapter.listSessions({ worktreePath: worktree, runner: runnerRecord });
    expect(result).toEqual(refused('Configured runner port or host differs from recorded runner'));
    expect(calls).toHaveLength(0);
  });

  it('a runner record without a port returns unreadable without invoking runner', async () => {
    const { runner, calls } = scriptedRunner([{ exitCode: 0, stdout: '', stderr: '' }]);
    const adapter = adapterWith(runner);
    const result = await adapter.listSessions({
      worktreePath: worktree,
      runner: { ...runnerRecord, remotePort: null },
    });
    expect(result).toEqual(refused('Attempt has no recorded runner port'));
    expect(calls).toHaveLength(0);
  });

  it('thrown runner subprocess returns unreachable', async () => {
    const { runner, calls } = scriptedRunner([new Error('spawn boom')]);
    const adapter = adapterWith(runner);
    const result = await adapter.listSessions({ worktreePath: worktree, runner: runnerRecord });
    expect(result).toEqual(unreachable);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['--status', '--dir', worktree]);
  });

  it('exit code 1 returns unreachable', async () => {
    const { runner } = scriptedRunner([{ exitCode: 1, stdout: 'connection refused', stderr: '' }]);
    const adapter = adapterWith(runner);
    expect(await adapter.listSessions({ worktreePath: worktree, runner: runnerRecord })).toEqual(unreachable);
  });

  it('exit code 2 or unexpected exit code returns unreadable', async () => {
    for (const exitCode of [2, 4]) {
      const { runner } = scriptedRunner([{ exitCode, stdout: 'boom', stderr: '' }]);
      const adapter = adapterWith(runner);
      expect(await adapter.listSessions({ worktreePath: worktree, runner: runnerRecord })).toEqual(
        refused('usage error \\(exit 2\\)|exited 4'),
      );
    }
  });

  it('exit code 3 without valid session ids returns unreadable', async () => {
    for (const stdout of ['nothing runs here', 'ocm-run: running in /tmp/x:\nno ids on these lines']) {
      const { runner } = scriptedRunner([{ exitCode: 3, stdout, stderr: '' }]);
      const adapter = adapterWith(runner);
      expect(await adapter.listSessions({ worktreePath: worktree, runner: runnerRecord })).toEqual(
        refused('no valid session ids'),
      );
    }
  });

  it('malformed JSON stdout returns unreadable', async () => {
    for (const exitCode of [0, 3]) {
      const { runner } = scriptedRunner([{ exitCode, stdout: '{not json', stderr: '' }]);
      const adapter = adapterWith(runner);
      expect(await adapter.listSessions({ worktreePath: worktree, runner: runnerRecord })).toEqual(
        refused('not valid JSON'),
      );
    }
  });

  it('a getter on the subprocess result returns unreadable without running the getter', async () => {
    let getterRan = false;
    const getterResult = {
      get exitCode(): number {
        getterRan = true;
        return 0;
      },
      stdout: '{"sessions":[]}',
      stderr: '',
    };
    const { runner } = scriptedRunner([getterResult as unknown as SubprocessResult]);
    const adapter = adapterWith(runner);
    expect(await adapter.listSessions({ worktreePath: worktree, runner: runnerRecord })).toEqual(
      refused('Unreadable'),
    );
    expect(getterRan).toBe(false);
  });
});

describe('ExecutionRunnerAdapter listSessions valid responses', () => {
  it('exit 0 returns empty sessions and exit 3 returns parsed session ids', async () => {
    const idle = scriptedRunner([{ exitCode: 0, stdout: 'nothing running', stderr: '' }]);
    expect(await adapterWith(idle.runner).listSessions({ worktreePath: worktree, runner: runnerRecord })).toEqual({
      ok: true,
      sessions: [],
    });

    const textRunning = scriptedRunner([
      { exitCode: 3, stdout: `ocm-run: running in ${worktree}:\nses_running1\nnoise\nses_running2`, stderr: '' },
    ]);
    expect(await adapterWith(textRunning.runner).listSessions({ worktreePath: worktree, runner: runnerRecord })).toEqual({
      ok: true,
      sessions: ['ses_running1', 'ses_running2'],
    });

    const jsonRunning = scriptedRunner([
      { exitCode: 3, stdout: '{"sessions":["ses_json1"]}', stderr: '' },
    ]);
    expect(await adapterWith(jsonRunning.runner).listSessions({ worktreePath: worktree, runner: runnerRecord })).toEqual({
      ok: true,
      sessions: ['ses_json1'],
    });
  });

  it('exit 0 with a JSON session payload parses through the pure helper', async () => {
    const { runner } = scriptedRunner([{ exitCode: 0, stdout: '{"sessions":["ses_idle0"]}', stderr: '' }]);
    expect(await adapterWith(runner).listSessions({ worktreePath: worktree, runner: runnerRecord })).toEqual({
      ok: true,
      sessions: ['ses_idle0'],
    });
  });
});

describe('parseListSessionsPayload hostile shapes', () => {
  const payloadRefusal = refused('Unreadable runner session payload|not a session list|invalid session id');
  it('refuses null, undefined, non-iterable, array hole, wrong primitive, getter, a Proxy, array-like, enormous length, and prototype-polluting keys as unreadable', () => {
    expect(parseListSessionsPayload(null, types.isProxy)).toEqual(
      payloadRefusal,
    );
    expect(parseListSessionsPayload(undefined, types.isProxy)).toEqual(
      payloadRefusal,
    );
    // Non-iterable primitives and exotic objects.
    expect(parseListSessionsPayload(42, types.isProxy)).toEqual(payloadRefusal);
    expect(parseListSessionsPayload('ses_str', types.isProxy)).toEqual(payloadRefusal);
    expect(parseListSessionsPayload(() => 1, types.isProxy)).toEqual(payloadRefusal);
    // An array hole is a sparse array.
    const holed: string[] = ['ses_ok'] as string[];
    delete (holed as { 0?: string })[0];
    expect(parseListSessionsPayload(holed, types.isProxy)).toEqual(payloadRefusal);
    // A wrong primitive inside the list.
    expect(parseListSessionsPayload([42], types.isProxy)).toEqual(payloadRefusal);
    expect(parseListSessionsPayload(['ses_ok', ''], types.isProxy)).toEqual(
      payloadRefusal,
    );
    // A getter is refused without its body running.
    let getterRan = false;
    const getterPayload = {
      get sessions(): string[] {
        getterRan = true;
        return ['ses_ok'];
      },
    };
    expect(parseListSessionsPayload(getterPayload, types.isProxy)).toEqual(
      payloadRefusal,
    );
    expect(getterRan).toBe(false);
    // A Proxy is refused without any trap running.
    let trapRan = false;
    const hostileProxy = new Proxy(
      { sessions: ['ses_ok'] },
      {
        get(): never {
          trapRan = true;
          throw new Error('trap must not run');
        },
      },
    );
    expect(parseListSessionsPayload(hostileProxy, types.isProxy)).toEqual(
      payloadRefusal,
    );
    expect(trapRan).toBe(false);
    // An array-like record without a `sessions` array is not a session list.
    expect(parseListSessionsPayload({ length: 2, 0: 'ses_a', 1: 'ses_b' }, types.isProxy)).toEqual(
      payloadRefusal,
    );
    // An enormous declared length is refused before its keys are walked.
    const enormous: unknown[] = [];
    Object.defineProperty(enormous, 'length', { value: 2_000_000 });
    expect(parseListSessionsPayload(enormous, types.isProxy)).toEqual(
      payloadRefusal,
    );
    const enormousSessions = { sessions: enormous };
    expect(parseListSessionsPayload(enormousSessions, types.isProxy)).toEqual(
      payloadRefusal,
    );
    // A `__proto__` own key never pollutes the prototype.
    const polluting = JSON.parse('{"__proto__": {"polluted": true}, "sessions": ["ses_ok"]}');
    expect(parseListSessionsPayload(polluting, types.isProxy)).toEqual({ ok: true, sessions: ['ses_ok'] });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('accepts an array of session-id strings and a record with a sessions array', () => {
    expect(parseListSessionsPayload(['ses_a-1_B'], types.isProxy)).toEqual({ ok: true, sessions: ['ses_a-1_B'] });
    expect(parseListSessionsPayload({ sessions: [] }, types.isProxy)).toEqual({ ok: true, sessions: [] });
    expect(parseListSessionsPayload({ sessions: ['ses_x', 'ses_y'] }, types.isProxy)).toEqual({
      ok: true,
      sessions: ['ses_x', 'ses_y'],
    });
  });
});
