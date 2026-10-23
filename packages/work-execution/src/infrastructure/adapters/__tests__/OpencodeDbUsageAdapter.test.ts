// Adapter tests for OpencodeDbUsageAdapter over a fake CommandExecutorPort:
// the argv shape (node --no-warnings -e <script> -- <sessionId> <path>,
// never a shell), the read mapping and every unavailable path.
/**
 * The fake executor records the argv array and returns scripted outcomes; no
 * subprocess, filesystem or network is exercised.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord } from '../../../domain/execution-records.js';
import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import {
  OpencodeDbUsageAdapter,
  OPENCODE_DB_READ_SCRIPT,
} from '../OpencodeDbUsageAdapter.adapter.js';

type RunCall = { argv: readonly string[]; options?: CommandRunOptions };

/** A recording fake executor with scripted outcomes per call. */
function fakeExecutor(
  respond: (call: RunCall, index: number) => Partial<CommandRunResult>,
): { executor: CommandExecutorPort; calls: RunCall[] } {
  const calls: RunCall[] = [];
  return {
    executor: {
      run: async (
        argv: readonly string[],
        options?: CommandRunOptions,
      ): Promise<CommandRunResult> => {
        const index = calls.length;
        const call: RunCall = { argv, options };
        calls.push(call);
        return {
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: '',
          ...respond(call, index),
        };
      },
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
    sessionId: 'session-1',
    completionReceipt: null,
    artifacts: null,
    createdAtIso: '2026-10-15T08:00:00.000Z',
    updatedAtIso: '2026-10-15T08:00:00.000Z',
    ...overrides,
  };
}

const USAGE_LINE = JSON.stringify({
  steps: 3,
  wallSeconds: 12.5,
  tokensInput: 100,
  tokensOutput: 50,
  tokensReasoning: 10,
  tokensCacheRead: 20,
  tokensCacheWrite: 5,
  costUsd: 0.02,
  model: 'inception/mercury-3',
  agent: 'opencode',
});

describe('OpencodeDbUsageAdapter', () => {
  it('runs the argv array through the executor, never a shell', async () => {
    const fake = fakeExecutor(() => ({ exitCode: 0, stdout: `${USAGE_LINE}\n` }));
    const adapter = new OpencodeDbUsageAdapter({
      executorForRecordedHost: () => fake.executor,
      databasePath: '/remote/.local/share/opencode/opencode.db',
      now: () => new Date('2026-10-23T12:00:00.000Z'),
    });

    const result = await adapter.readUsage({ attempt: attempt() });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].argv).toEqual([
      'node',
      '--no-warnings',
      '-e',
      OPENCODE_DB_READ_SCRIPT,
      '--',
      'session-1',
      '/remote/.local/share/opencode/opencode.db',
    ]);
    expect(fake.calls[0].options?.timeoutMs).toBe(20000);
    expect(result).toEqual({
      outcome: 'read',
      usage: {
        source: 'opencode-db',
        readAtIso: '2026-10-23T12:00:00.000Z',
        sessionId: 'session-1',
        steps: 3,
        wallSeconds: 12.5,
        tokensInput: 100,
        tokensOutput: 50,
        tokensReasoning: 10,
        tokensCacheRead: 20,
        tokensCacheWrite: 5,
        costUsd: 0.02,
        model: 'inception/mercury-3',
        agent: 'opencode',
        reason: null,
      },
    });
  });

  it('honors the nodeBin and timeoutMs options', async () => {
    const fake = fakeExecutor(() => ({ exitCode: 0, stdout: `${USAGE_LINE}\n` }));
    const adapter = new OpencodeDbUsageAdapter({
      executorForRecordedHost: () => fake.executor,
      nodeBin: '/custom/node',
      timeoutMs: 5000,
    });

    await adapter.readUsage({ attempt: attempt() });

    expect(fake.calls[0].argv[0]).toBe('/custom/node');
    expect(fake.calls[0].argv[5]).toBe('session-1');
    expect(fake.calls[0].options?.timeoutMs).toBe(5000);
  });

  it('reports unavailable with a schema reason when the script exits 3', async () => {
    const fake = fakeExecutor(() => ({
      exitCode: 3,
      stdout: '{"error":"schema"}\n',
    }));
    const adapter = new OpencodeDbUsageAdapter({
      executorForRecordedHost: () => fake.executor,
    });

    const result = await adapter.readUsage({ attempt: attempt() });

    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.usage.source).toBe('unavailable');
      expect(result.usage.reason).toContain('schema');
      expect(result.usage.steps).toBeNull();
    }
  });

  it('reports unavailable with a no-session reason when the script exits 1', async () => {
    const fake = fakeExecutor(() => ({
      exitCode: 1,
      stdout: '{"error":"no-session"}\n',
    }));
    const adapter = new OpencodeDbUsageAdapter({
      executorForRecordedHost: () => fake.executor,
    });

    const result = await adapter.readUsage({ attempt: attempt() });

    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.usage.reason).toContain('no-session');
    }
  });

  it('reports unavailable and never leaks unparseable stdout into the reason', async () => {
    const fake = fakeExecutor(() => ({ exitCode: 0, stdout: 'not json at all' }));
    const adapter = new OpencodeDbUsageAdapter({
      executorForRecordedHost: () => fake.executor,
    });

    const result = await adapter.readUsage({ attempt: attempt() });

    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.usage.reason).not.toContain('not json');
    }
  });

  it('uses the first 120 characters of stderr when stdout has no error field', async () => {
    const stderr = 'x'.repeat(200);
    const fake = fakeExecutor(() => ({
      exitCode: 7,
      stderr,
    }));
    const adapter = new OpencodeDbUsageAdapter({
      executorForRecordedHost: () => fake.executor,
    });

    const result = await adapter.readUsage({ attempt: attempt() });

    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.usage.reason).toContain('exit 7');
      expect(result.usage.reason).toContain('x'.repeat(120));
      expect(result.usage.reason).not.toContain('x'.repeat(121));
    }
  });

  it('reports unavailable when the executor reports an error or times out', async () => {
    const errorFake = fakeExecutor(() => ({ error: 'spawn failed' }));
    const errorAdapter = new OpencodeDbUsageAdapter({
      executorForRecordedHost: () => errorFake.executor,
    });
    const errorResult = await errorAdapter.readUsage({ attempt: attempt() });
    expect(errorResult.outcome).toBe('unavailable');

    const timeoutFake = fakeExecutor(() => ({
      error: 'killed by timeout',
      exitCode: null,
      signal: null,
    }));
    const timeoutAdapter = new OpencodeDbUsageAdapter({
      executorForRecordedHost: () => timeoutFake.executor,
    });
    const timeoutResult = await timeoutAdapter.readUsage({ attempt: attempt() });
    expect(timeoutResult.outcome).toBe('unavailable');
  });

  it('reports unavailable without running anything when sessionId is null', async () => {
    const fake = fakeExecutor(() => ({}));
    const adapter = new OpencodeDbUsageAdapter({
      executorForRecordedHost: () => fake.executor,
    });

    const result = await adapter.readUsage({ attempt: attempt({ sessionId: null }) });

    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.usage.sessionId).toBeNull();
      expect(result.usage.reason).toBe('no session id');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('never throws: an executor-resolution failure is unavailable', async () => {
    const adapter = new OpencodeDbUsageAdapter({
      executorForRecordedHost: () => {
        throw new Error('recorded host removed');
      },
    });

    const result = await adapter.readUsage({ attempt: attempt() });

    expect(result.outcome).toBe('unavailable');
  });
});
