import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_BUFFER_BYTES,
  runSpawnOutcome,
  type SpawnRunOptions,
  type SpawnRunOutcome,
} from '../spawn-run.js';
import {
  defaultSpawn,
  DEFAULT_REVIEW_TIMEOUT_MS,
  REVIEW_KILL_GRACE_MS,
} from '../OcmReviewTransport.adapter.js';

describe('runSpawnOutcome kill grace', () => {
  it('honors an explicit killGraceMs between the SIGTERM and the SIGKILL', async () => {
    const startedAt = Date.now();
    const outcome = await runSpawnOutcome(
      '/bin/sh',
      ['-c', 'trap "" TERM; while :; do sleep 0.05; done'],
      { timeoutMs: 20, killGraceMs: 20 },
    );
    // The child ignores SIGTERM, so only the grace's SIGKILL ends it. With
    // the default 500ms grace this would take well over 400ms; the custom
    // grace proves the option reached runSpawnOutcome.
    expect(Date.now() - startedAt).toBeLessThan(400);
    expect(outcome.exitCode).toBeNull();
    expect(outcome.signal).toBe('SIGKILL');
    expect(outcome.error).toContain('timeout');
  });

  it('still terminates a TERM-ignoring child under the default grace', async () => {
    const outcome = await runSpawnOutcome(
      '/bin/sh',
      ['-c', 'trap "" TERM; while :; do sleep 0.05; done'],
      { timeoutMs: 20 },
    );
    expect(outcome.exitCode).toBeNull();
    expect(outcome.signal).toBe('SIGKILL');
  });
});

describe('defaultSpawn', () => {
  it('forwards the review budget, output cap and kill grace to runSpawnOutcome', async () => {
    const received: SpawnRunOptions[] = [];
    const fakeRunner = async (
      _file: string,
      _args: readonly string[],
      options: SpawnRunOptions = {},
    ): Promise<SpawnRunOutcome> => {
      received.push(options);
      return { exitCode: 0, signal: null, stdout: '', stderr: '' };
    };

    const result = await defaultSpawn('/bin/true', [], {}, { timeoutMs: 1234 }, fakeRunner);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      env: {},
      timeoutMs: 1234,
      maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
      killGraceMs: REVIEW_KILL_GRACE_MS,
    });
  });

  it('defaults the timeout to the review budget and surfaces a runner error as stderr', async () => {
    const received: SpawnRunOptions[] = [];
    const fakeRunner = async (
      _file: string,
      _args: readonly string[],
      options: SpawnRunOptions = {},
    ): Promise<SpawnRunOutcome> => {
      received.push(options);
      return {
        exitCode: null,
        signal: 'SIGTERM',
        stdout: '',
        stderr: '',
        error: 'command exceeded its budget and its process tree was killed',
      };
    };

    const result = await defaultSpawn('/bin/true', [], {}, undefined, fakeRunner);

    expect(received[0]?.timeoutMs).toBe(DEFAULT_REVIEW_TIMEOUT_MS);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toBe('command exceeded its budget and its process tree was killed');
  });
});
