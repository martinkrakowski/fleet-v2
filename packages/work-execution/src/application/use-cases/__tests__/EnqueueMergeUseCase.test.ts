// KA3-1: the enqueue guard — a halted conductor, a halted killall marker or a
// paused killall train refuses before the queue is touched; a clear trio
// delegates; an invalid request refuses before any halt or pause read.
import { types } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import { EnqueueMergeUseCase } from '../EnqueueMergeUseCase.use-case.js';
import type { MergeQueueEnqueueCommand, MergeQueueRepositoryPort } from '../../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { ConductorHaltPort } from '../../ports/out/ConductorHaltPort.out-port.js';
import type { KillallHaltMarkerPort } from '../../ports/out/KillallHaltMarkerPort.out-port.js';
import type { KillallTrainPausePort } from '../../ports/out/KillallTrainPausePort.out-port.js';

const command: MergeQueueEnqueueCommand = {
  repository: { owner: 'fleet', repo: 'v2' },
  pullRequest: 7,
  headOid: 'a'.repeat(40),
  tier: 0,
  enqueuedBy: 'cli',
  runId: null,
  entryId: '01JB0000000000000000000000',
  successorEntryId: '01JB0000000000000000000001',
  enqueuedAtIso: '2026-11-01T12:00:00.000Z',
  deadlineIso: '2026-11-01T12:10:00.000Z',
};

const clearHalt = { read: async () => ({ state: 'clear', record: null }) } as Pick<ConductorHaltPort, 'read'>;
const clearMarker = { read: async () => ({ state: 'clear' }) } as unknown as Pick<KillallHaltMarkerPort, 'read'>;
const clearPause = { read: async () => ({ status: 'clear' }) } as unknown as Pick<KillallTrainPausePort, 'read'>;

function makeQueue(): MergeQueueRepositoryPort & { calls: number } {
  const queue = {
    calls: 0,
    async enqueueMergeEntry(): Promise<never> {
      queue.calls += 1;
      throw new Error('queue must not be reached by these tests');
    },
  };
  return queue as unknown as MergeQueueRepositoryPort & { calls: number };
}

describe('EnqueueMergeUseCase (KA3-1 halt and pause guards)', () => {
  it('enqueue refuses with halted without calling queue when killallHalt is halted', async () => {
    // Guard: `isKillallHalted` under a 'halted' marker blocks the enqueue
    // before `queue.enqueueMergeEntry`; a queue spy proves it is untouched.
    const queue = makeQueue();
    const useCase = new EnqueueMergeUseCase({ isProxy: types.isProxy,
      queue,
      halt: clearHalt,
      killallHalt: { read: async () => ({ state: 'halted' }) } as unknown as Pick<KillallHaltMarkerPort, 'read'>,
      killallTrainPause: clearPause,
    });
    await expect(useCase.enqueue(command)).resolves.toEqual({ outcome: 'refused', reason: 'halted' });
    expect(queue.calls).toBe(0);
  });

  it('enqueue refuses with halted without calling queue for a Proxy killallHalt whose traps hide the read method', async () => {
    // Guard: fix round 2, item 1 — the use case threads the trusted detector
    // (`types.isProxy`) into the halt read, so a Proxy port that hides `read`
    // and reports a null prototype is refused fail-closed (halted) instead of
    // reading as an absent method (not halted, guard bypassed).
    const queue = makeQueue();
    const useCase = new EnqueueMergeUseCase({
      queue,
      halt: clearHalt,
      killallHalt: new Proxy(
        { read: async () => ({ state: 'clear' }) },
        {
          getOwnPropertyDescriptor(): undefined {
            return undefined;
          },
          getPrototypeOf(): null {
            return null;
          },
        },
      ) as unknown as Pick<KillallHaltMarkerPort, 'read'>,
      killallTrainPause: clearPause,
      isProxy: types.isProxy,
    });
    await expect(useCase.enqueue(command)).resolves.toEqual({ outcome: 'refused', reason: 'halted' });
    expect(queue.calls).toBe(0);
  });

  it('enqueue refuses with halted without calling queue when killallHalt is unreadable', async () => {
    // Guard: `isKillallHalted` fails closed on an unreadable marker answer.
    const queue = makeQueue();
    const useCase = new EnqueueMergeUseCase({ isProxy: types.isProxy,
      queue,
      halt: clearHalt,
      killallHalt: { read: async () => ({ state: 'unreadable' }) } as unknown as Pick<KillallHaltMarkerPort, 'read'>,
      killallTrainPause: clearPause,
    });
    await expect(useCase.enqueue(command)).resolves.toEqual({ outcome: 'refused', reason: 'halted' });
    expect(queue.calls).toBe(0);
  });

  it('enqueue refuses with halted without calling queue when killallTrainPause is paused', async () => {
    // Guard: `isKillallTrainPaused` under a 'paused' status blocks the enqueue.
    const queue = makeQueue();
    const useCase = new EnqueueMergeUseCase({ isProxy: types.isProxy,
      queue,
      halt: clearHalt,
      killallHalt: clearMarker,
      killallTrainPause: { read: async () => ({ status: 'paused' }) } as unknown as Pick<KillallTrainPausePort, 'read'>,
    });
    await expect(useCase.enqueue(command)).resolves.toEqual({ outcome: 'refused', reason: 'halted' });
    expect(queue.calls).toBe(0);
  });

  it('enqueue refuses with halted without calling queue when killallTrainPause is unreadable', async () => {
    // Guard: `isKillallTrainPaused` fails closed on an unreadable pause.
    const queue = makeQueue();
    const useCase = new EnqueueMergeUseCase({ isProxy: types.isProxy,
      queue,
      halt: clearHalt,
      killallHalt: clearMarker,
      killallTrainPause: { read: async () => ({ status: 'unreadable' }) } as unknown as Pick<KillallTrainPausePort, 'read'>,
    });
    await expect(useCase.enqueue(command)).resolves.toEqual({ outcome: 'refused', reason: 'halted' });
    expect(queue.calls).toBe(0);
  });

  it('enqueue refuses with halted without calling queue when conductor halt is halted', async () => {
    // Guard: the conductor halt arm of `isTrainStepBlocked` (read here with
    // `requireConductorHalt: false`, so a clear-with-agreeing-record answer
    // is the only non-halt).
    const queue = makeQueue();
    const useCase = new EnqueueMergeUseCase({ isProxy: types.isProxy,
      queue,
      halt: {
        read: async () => ({
          state: 'halted',
          record: { version: 1, halted: true, changedAtIso: '2026-11-01T12:00:00.000Z' },
        }),
      } as unknown as Pick<ConductorHaltPort, 'read'>,
      killallHalt: clearMarker,
      killallTrainPause: clearPause,
    });
    await expect(useCase.enqueue(command)).resolves.toEqual({ outcome: 'refused', reason: 'halted' });
    expect(queue.calls).toBe(0);
  });

  it('enqueue delegates to queue when halt, killallHalt, and killallTrainPause are all clear', async () => {
    // Guard: the three clear reads leave the enqueue untouched, so a
    // constant-halted implementation fails here while the four refusal cases
    // above rule out a constant-clear one.
    const queue = makeQueue();
    let delegateCalls = 0;
    queue.enqueueMergeEntry = async () => {
      delegateCalls += 1;
      return { outcome: 'created', entries: [], record: {} as never };
    };
    const useCase = new EnqueueMergeUseCase({ isProxy: types.isProxy,
      queue,
      halt: clearHalt,
      killallHalt: clearMarker,
      killallTrainPause: clearPause,
    });
    await expect(useCase.enqueue(command)).resolves.toEqual({ outcome: 'created', entries: [], record: {} });
    expect(delegateCalls).toBe(1);
  });

  it('enqueue refuses with invalid-repository before reading halt or pause when repository is invalid', async () => {
    // Guard: the `isValidRequest` short-circuit — the halt and pause reads
    // are spies, and a zero read count proves the request envelope is
    // validated before any guard port is touched.
    const queue = makeQueue();
    const haltRead = vi.fn(async () => ({ state: 'halted', record: null }) as never);
    const killallRead = vi.fn(async () => ({ state: 'halted' }) as never);
    const pauseRead = vi.fn(async () => ({ status: 'paused' }) as never);
    const useCase = new EnqueueMergeUseCase({ isProxy: types.isProxy,
      queue,
      halt: { read: haltRead } as unknown as Pick<ConductorHaltPort, 'read'>,
      killallHalt: { read: killallRead } as unknown as Pick<KillallHaltMarkerPort, 'read'>,
      killallTrainPause: { read: pauseRead } as unknown as Pick<KillallTrainPausePort, 'read'>,
    });
    await expect(
      useCase.enqueue({ ...command, repository: { owner: '..', repo: 'v2' } }),
    ).resolves.toEqual({ outcome: 'refused', reason: 'invalid-repository' });
    expect(haltRead).not.toHaveBeenCalled();
    expect(killallRead).not.toHaveBeenCalled();
    expect(pauseRead).not.toHaveBeenCalled();
    expect(queue.calls).toBe(0);
  });
});
