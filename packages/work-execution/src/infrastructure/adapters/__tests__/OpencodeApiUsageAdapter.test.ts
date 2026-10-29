// Adapter tests for OpencodeApiUsageAdapter over a fake subprocess runner:
// the argv shape (--usage <session-id>, never a shell), the route-derived
// environment, the two-line stdout mapping and every unavailable path.
/**
 * The fake runner records the command, argv, environment, environment options
 * and timeout options and returns scripted outcomes; no subprocess,
 * filesystem or network is exercised.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord } from '../../../domain/execution-records.js';
import {
  RunnerSubprocessError,
  runViaExecFile,
  type RunnerEnvOptions,
  type SubprocessResult,
} from '../ExecutionRunnerAdapter.adapter.js';
import {
  OpencodeApiUsageAdapter,
  type UsageRoute,
  type UsageRouteRefusal,
} from '../OpencodeApiUsageAdapter.adapter.js';

type RunCall = {
  command: string;
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  envOptions?: RunnerEnvOptions;
  options?: { readonly timeoutMs?: number };
};

/** A recording fake subprocess runner with scripted outcomes per call. */
function fakeRun(
  respond: (call: RunCall, index: number) => Partial<SubprocessResult>,
): { run: typeof runViaExecFile; calls: RunCall[] } {
  const calls: RunCall[] = [];
  return {
    run: async (command, args, env, envOptions, options) => {
      const index = calls.length;
      const call: RunCall = { command, args, env, envOptions, options };
      calls.push(call);
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        ...respond(call, index),
      };
    },
    calls,
  };
}

function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-1',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/lanes/attempt-1',
    baseCommit: 'abc123',
    state: 'ended',
    outcome: null,
    briefDigest: 'digest-1',
    briefPackagePath: '.lane/brief.md',
    sessionId: 'ses_test_123',
    completionReceipt: null,
    artifacts: null,
    createdAtIso: '2026-10-15T08:00:00.000Z',
    updatedAtIso: '2026-10-15T08:00:00.000Z',
    ...overrides,
  };
}

function route(overrides: Partial<UsageRoute> = {}): UsageRoute {
  return {
    ok: true,
    remotePort: 4166,
    sshHost: null,
    authFile: null,
    transport: 'local',
    ...overrides,
  };
}

function refusal(reason: string): UsageRouteRefusal {
  return { ok: false, reason };
}

const SESSION_BODY = JSON.stringify({
  data: {
    id: 'ses_test_123',
    cost: 0.00791861,
    tokens: {
      input: 25563,
      output: 3775,
      reasoning: 4494,
      cache: { read: 246651, write: 0 },
    },
    time: { created: 1793313007225, updated: 1793313077884, idle: 0 },
    agent: 'lane',
    model: { id: 'inception/mercury-3', providerID: 'openrouter', variant: 'cnt' },
    title: 'Fleet work order wo-1',
    location: 'local',
  },
});

const MESSAGE_LIST = JSON.stringify({
  data: [
    ...Array.from({ length: 17 }, (_, i) => ({ id: `assistant-${i}`, type: 'assistant' })),
    { id: 'user-1', type: 'user' },
    { id: 'idle-1', type: 'idle' },
    { id: 'switched-1', type: 'agent-switched' },
    { id: 'model-switched-1', type: 'model-switched' },
  ],
});

describe('OpencodeApiUsageAdapter', () => {
  it('runs the argv array through the injected bin and maps every field of a two-line stdout', async () => {
    const fake = fakeRun(() => ({ exitCode: 0, stdout: `${SESSION_BODY}\n${MESSAGE_LIST}\n` }));
    const adapter = new OpencodeApiUsageAdapter({
      routeForAttempt: () => route(),
      ocmRunBin: '/custom/ocm-run',
      run: fake.run,
      now: () => new Date('2026-10-23T12:00:00.000Z'),
    });

    const result = await adapter.readUsage({ attempt: attempt() });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].command).toBe('/custom/ocm-run');
    expect(fake.calls[0].args).toEqual(['--usage', 'ses_test_123']);
    expect(result).toEqual({
      outcome: 'read',
      usage: {
        source: 'opencode-api',
        readAtIso: '2026-10-23T12:00:00.000Z',
        sessionId: 'ses_test_123',
        steps: 17,
        wallSeconds: 70.7,
        tokensInput: 25563,
        tokensOutput: 3775,
        tokensReasoning: 4494,
        tokensCacheRead: 246651,
        tokensCacheWrite: 0,
        costUsd: 0.00791861,
        model: 'inception/mercury-3',
        agent: 'lane',
        reason: null,
      },
    });
  });

  it('passes the route as environment and inherits nothing beyond the allow-list', async () => {
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'x';
    try {
      const fake = fakeRun(() => ({ exitCode: 0, stdout: `${SESSION_BODY}\n` }));
      const adapter = new OpencodeApiUsageAdapter({
        routeForAttempt: () =>
          route({ sshHost: 'runner-node-01.internal', authFile: '/auth/env.txt', transport: 'ssh' }),
        ocmRunBin: '/custom/ocm-run',
        run: fake.run,
      });

      const result = await adapter.readUsage({ attempt: attempt() });

      expect(result.outcome).toBe('read');
      const call = fake.calls[0];
      expect(call.command).toBe('/custom/ocm-run');
      expect(call.args).toEqual(['--usage', 'ses_test_123']);
      expect(call.env?.OCM_REMOTE_PORT).toBe('4166');
      expect(call.env?.OCM_HOST).toBe('runner-node-01.internal');
      expect(call.env?.OPENCODE_AUTH_FILE).toBe('/auth/env.txt');
      expect(call.env?.GH_TOKEN).toBeUndefined();
      expect(call.envOptions).toEqual({ transport: 'ssh' });
      expect(call.options).toEqual({ timeoutMs: 20000 });
    } finally {
      if (previous === undefined) {
        delete process.env.GH_TOKEN;
      } else {
        process.env.GH_TOKEN = previous;
      }
    }
  });

  it('sets no OCM_HOST for a local route and honors the timeoutMs option', async () => {
    const fake = fakeRun(() => ({ exitCode: 0, stdout: `${SESSION_BODY}\n` }));
    const adapter = new OpencodeApiUsageAdapter({
      routeForAttempt: () => route(),
      run: fake.run,
      timeoutMs: 5000,
    });

    await adapter.readUsage({ attempt: attempt() });

    expect(fake.calls[0].env?.OCM_HOST).toBeUndefined();
    expect(fake.calls[0].envOptions).toEqual({ transport: 'local' });
    expect(fake.calls[0].options).toEqual({ timeoutMs: 5000 });
  });

  it('leaves steps null when the message list is absent, still a read', async () => {
    const fake = fakeRun(() => ({ exitCode: 0, stdout: `${SESSION_BODY}\n` }));
    const adapter = new OpencodeApiUsageAdapter({ routeForAttempt: () => route(), run: fake.run });

    const result = await adapter.readUsage({ attempt: attempt() });

    expect(result.outcome).toBe('read');
    if (result.outcome === 'read') {
      expect(result.usage.steps).toBeNull();
      expect(result.usage.source).toBe('opencode-api');
      expect(result.usage.reason).toBeNull();
    }
  });

  it('maps a data object without tokens to nulls, still a read', async () => {
    const body = JSON.stringify({ data: { id: 'ses_test_123' } });
    const fake = fakeRun(() => ({ exitCode: 0, stdout: `${body}\n${MESSAGE_LIST}\n` }));
    const adapter = new OpencodeApiUsageAdapter({ routeForAttempt: () => route(), run: fake.run });

    const result = await adapter.readUsage({ attempt: attempt() });

    expect(result.outcome).toBe('read');
    if (result.outcome === 'read') {
      expect(result.usage.tokensInput).toBeNull();
      expect(result.usage.tokensOutput).toBeNull();
      expect(result.usage.tokensReasoning).toBeNull();
      expect(result.usage.tokensCacheRead).toBeNull();
      expect(result.usage.tokensCacheWrite).toBeNull();
      expect(result.usage.costUsd).toBeNull();
      expect(result.usage.model).toBeNull();
      expect(result.usage.agent).toBeNull();
      expect(result.usage.wallSeconds).toBeNull();
      expect(result.usage.steps).toBe(17);
    }
  });

  it('reports unavailable with no-session when ocm-run exits 1', async () => {
    const fake = fakeRun(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'ocm-run: no session ses_test_123 on the server (HTTP 404)\n',
    }));
    const adapter = new OpencodeApiUsageAdapter({ routeForAttempt: () => route(), run: fake.run });

    const result = await adapter.readUsage({ attempt: attempt() });

    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.usage.source).toBe('unavailable');
      expect(result.usage.reason).toBe('no-session');
    }
  });

  it('reports exit <code>: <first stderr line> for other non-zero exits', async () => {
    const fake = fakeRun(() => ({
      exitCode: 3,
      stdout: '',
      stderr: 'ocm-run: could not read session ses_test_123 … (HTTP 500)\n',
    }));
    const adapter = new OpencodeApiUsageAdapter({ routeForAttempt: () => route(), run: fake.run });

    const result = await adapter.readUsage({ attempt: attempt() });

    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.usage.reason).toBe('exit 3: ocm-run: could not read session ses_test_123 … (HTTP 500)');
    }
  });

  it('reports executor error when the subprocess throws', async () => {
    const fake = fakeRun(() => {
      throw new Error('spawn failed');
    });
    const adapter = new OpencodeApiUsageAdapter({ routeForAttempt: () => route(), run: fake.run });

    const result = await adapter.readUsage({ attempt: attempt() });

    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.usage.reason).toBe('executor error');
    }
  });

  it('reports timeout when ocm-run is killed by its timeout', async () => {
    const fake = fakeRun(() => {
      throw new RunnerSubprocessError('killed by timeout', '', '');
    });
    const adapter = new OpencodeApiUsageAdapter({ routeForAttempt: () => route(), run: fake.run });

    const result = await adapter.readUsage({ attempt: attempt() });

    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.usage.reason).toBe('timeout');
    }
  });

  it('reports unavailable with no session id without running anything', async () => {
    const fake = fakeRun(() => ({}));
    let routeCalls = 0;
    const adapter = new OpencodeApiUsageAdapter({
      routeForAttempt: () => {
        routeCalls += 1;
        return route();
      },
      run: fake.run,
    });

    const result = await adapter.readUsage({ attempt: attempt({ sessionId: null }) });

    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.usage.sessionId).toBeNull();
      expect(result.usage.reason).toBe('no session id');
    }
    expect(fake.calls).toHaveLength(0);
    expect(routeCalls).toBe(0);
  });

  it('reports unavailable with the route reason when the route refuses', async () => {
    const fake = fakeRun(() => ({}));
    const adapter = new OpencodeApiUsageAdapter({
      routeForAttempt: () => refusal('no runner port for this attempt'),
      run: fake.run,
    });

    const result = await adapter.readUsage({ attempt: attempt() });

    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.usage.reason).toBe('no runner port for this attempt');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('reports unavailable with invalid session id for a malformed id without running anything', async () => {
    const fake = fakeRun(() => ({}));
    const adapter = new OpencodeApiUsageAdapter({ routeForAttempt: () => route(), run: fake.run });

    const result = await adapter.readUsage({ attempt: attempt({ sessionId: 'not-a-session-id' }) });

    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.usage.reason).toBe('invalid session id');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('reports unparseable when line 1 is not JSON', async () => {
    const fake = fakeRun(() => ({ exitCode: 0, stdout: 'not json at all\n' }));
    const adapter = new OpencodeApiUsageAdapter({ routeForAttempt: () => route(), run: fake.run });

    const result = await adapter.readUsage({ attempt: attempt() });

    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.usage.reason).toBe('unparseable');
    }
  });
});
