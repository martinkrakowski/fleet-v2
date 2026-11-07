// O9 fix (cb782839): the in-pass heartbeat gap is measured from the last beat,
// never from the pass start.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runPassWithHeartbeat } from '../conductor.js';

describe('o9-heartbeat-gap-anchored-to-last-beat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('first in-pass beat waits the remainder reported by nextBeatDelayMs, not a fresh 60 s', async () => {
    let finishPass: (value: unknown) => void = () => undefined;
    const passPromise = new Promise((resolve) => {
      finishPass = resolve;
    });
    const driver = { pass: { runPass: () => passPromise } } as never;
    const beats: number[] = [];
    const start = Date.now();
    const run = runPassWithHeartbeat(
      {
        driver,
        heartbeatDuringPass: async () => {
          beats.push(Date.now() - start);
        },
        // 50 s of the 60 s gap already elapsed since the last beat.
        nextBeatDelayMs: () => 10_000,
      },
      { holderId: 'h', nowIso: '2026-11-06T00:00:00.000Z' },
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(beats).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(beats).toEqual([10_000]);
    finishPass({ outcome: 'completed' });
    await expect(run).resolves.toEqual({ outcome: 'completed' });
  });

  it('without a last beat the first wait is the full 60 s gap', async () => {
    let finishPass: (value: unknown) => void = () => undefined;
    const passPromise = new Promise((resolve) => {
      finishPass = resolve;
    });
    const driver = { pass: { runPass: () => passPromise } } as never;
    const beats: number[] = [];
    const start = Date.now();
    const run = runPassWithHeartbeat(
      {
        driver,
        heartbeatDuringPass: async () => {
          beats.push(Date.now() - start);
        },
      },
      { holderId: 'h', nowIso: '2026-11-06T00:00:00.000Z' },
    );
    await vi.advanceTimersByTimeAsync(59_999);
    expect(beats).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(beats).toEqual([60_000]);
    finishPass({ outcome: 'completed' });
    await run;
  });
});
