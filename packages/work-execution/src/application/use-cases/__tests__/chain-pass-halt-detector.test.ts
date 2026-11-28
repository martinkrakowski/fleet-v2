// KA3-1 fix round 3: the Proxy detector is a REQUIRED injected parameter that
// is really consulted, and an accessor `read` on a port is never invoked.
import { types } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import {
  isChainPassHalted,
  isKillallHalted,
  isKillallTrainPaused,
  isRequiredPassHalted,
  isTrainStepBlocked,
} from '../chain-pass-halt.js';
import { readDataProperty } from '../../../domain/plain-record-reads.js';
import { EnqueueMergeUseCase } from '../EnqueueMergeUseCase.use-case.js';
import type { MergeQueueRepositoryPort } from '../../ports/out/MergeQueueRepositoryPort.out-port.js';

const clearHaltPort = () => ({ read: async () => ({ state: 'clear', record: null }) });
const clearMarkerPort = () => ({ read: async () => ({ state: 'clear' }) });
const clearPausePort = () => ({ read: async () => ({ status: 'clear' }) });

const reads: ReadonlyArray<readonly [string, (port: object, isProxy: (v: unknown) => boolean) => Promise<boolean>, () => object]> = [
  ['isChainPassHalted', (p, d) => isChainPassHalted(p as never, d), clearHaltPort],
  ['isRequiredPassHalted', (p, d) => isRequiredPassHalted(p as never, d), clearHaltPort],
  ['isKillallHalted', (p, d) => isKillallHalted(p as never, d), clearMarkerPort],
  ['isKillallTrainPaused', (p, d) => isKillallTrainPaused(p as never, d), clearPausePort],
];

describe('the injected Proxy detector is required and consulted', () => {
  it.each(reads)('%s: a clear port reads clear only when the detector accepts it', async (_name, read, make) => {
    // Guard: with the real detector the clear port is not halted; a detector
    // that flags the port makes the same port halted. A neutral default (or an
    // ignored parameter) would answer "clear" for both and fail the second.
    await expect(read(make(), types.isProxy)).resolves.toBe(false);
    const seen: unknown[] = [];
    const flagging = (value: unknown): boolean => {
      seen.push(value);
      return true;
    };
    const port = make();
    await expect(read(port, flagging)).resolves.toBe(true);
    expect(seen[0]).toBe(port);
  });

  it('isTrainStepBlocked passes the detector to every read', async () => {
    const deps = { halt: clearHaltPort(), killallHalt: clearMarkerPort(), killallTrainPause: clearPausePort() };
    await expect(isTrainStepBlocked(deps, true, types.isProxy)).resolves.toBe(false);
    const seen = new Set<unknown>();
    const flagAll = (value: unknown): boolean => {
      seen.add(value);
      return true;
    };
    await expect(isTrainStepBlocked(deps, true, flagAll)).resolves.toBe(true);
    expect(seen.has(deps.halt)).toBe(true);
    expect(seen.has(deps.killallHalt)).toBe(true);
    expect(seen.has(deps.killallTrainPause)).toBe(true);
  });

  it('the detector cannot be omitted (compile-time)', () => {
    // @ts-expect-error isProxy is required: there is no neutral default.
    void isChainPassHalted(clearHaltPort());
    // @ts-expect-error isProxy is required: there is no neutral default.
    void isKillallHalted(clearMarkerPort());
    // @ts-expect-error isProxy is required: there is no neutral default.
    void isTrainStepBlocked({}, false);
    expect(true).toBe(true);
  });

  it('EnqueueMergeUseCase threads its detector: a flagging detector refuses before the queue', async () => {
    const queue = { enqueueMergeEntry: vi.fn() } as unknown as MergeQueueRepositoryPort;
    const useCase = new EnqueueMergeUseCase({
      queue,
      halt: clearHaltPort() as never,
      killallHalt: clearMarkerPort() as never,
      killallTrainPause: clearPausePort() as never,
      isProxy: () => true,
    });
    const result = await useCase.enqueue({
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
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'halted' });
    expect((queue.enqueueMergeEntry as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});

describe('an accessor `read` on a port is refused without being invoked', () => {
  function accessorPorts(counter: { n: number }): ReadonlyArray<readonly [string, object]> {
    const answer = { state: 'clear', record: null };
    const own = {} as { read?: unknown };
    Object.defineProperty(own, 'read', {
      enumerable: true,
      get() {
        counter.n += 1;
        return async () => answer;
      },
    });
    const proto = {};
    Object.defineProperty(proto, 'read', {
      get() {
        counter.n += 1;
        return async () => answer;
      },
    });
    return [
      ['own accessor', own],
      ['inherited accessor', Object.create(proto) as object],
    ];
  }

  it.each(reads)('%s: the getter never runs and the port fails closed', async (_name, read) => {
    // Guard: a plain `port.read` lookup would run the getter (counter 1) and,
    // because the getter answers clear, read the port as clear.
    const counter = { n: 0 };
    for (const [, port] of accessorPorts(counter)) {
      await expect(read(port, types.isProxy)).resolves.toBe(true);
    }
    expect(counter.n).toBe(0);
  });

  it('a Proxy hidden in the prototype chain is refused with no trap run', async () => {
    let traps = 0;
    const hidden = new Proxy(
      {},
      {
        getOwnPropertyDescriptor(): undefined {
          traps += 1;
          return undefined;
        },
        get(): unknown {
          traps += 1;
          return async () => ({ state: 'clear' });
        },
      },
    );
    const port = Object.create(hidden) as object;
    await expect(isKillallHalted(port as never, types.isProxy)).resolves.toBe(true);
    expect(traps).toBe(0);
  });

  it('class-style and plain data-property read methods still work', async () => {
    class Adapter {
      async read(): Promise<{ state: 'clear' }> {
        return { state: 'clear' };
      }
    }
    await expect(isKillallHalted(new Adapter(), types.isProxy)).resolves.toBe(false);
    await expect(isKillallHalted({ read: async () => ({ state: 'clear' }) } as never, types.isProxy)).resolves.toBe(false);
  });

  it('readDataProperty reports a missing key as an ok undefined and a deep chain as refused', () => {
    expect(readDataProperty({}, 'read', types.isProxy)).toEqual({ ok: true, value: undefined });
    let deep: object = {};
    for (let i = 0; i < 40; i += 1) {
      deep = Object.create(deep) as object;
    }
    expect(readDataProperty(deep, 'read', types.isProxy)).toEqual({ ok: false });
  });
});
