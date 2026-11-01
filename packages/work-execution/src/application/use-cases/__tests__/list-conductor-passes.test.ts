// ListConductorPassesUseCase tests — VZ5b.
/**
 * The read-only pass listing returns the recorded passes newest first, at most
 * a bounded limit, and never carries the stored holder id; an unreadable store
 * is reported unreadable, never an error.
 */

import { describe, expect, it } from 'vitest';

import { ListConductorPassesUseCase } from '../ListConductorPassesUseCase.use-case.js';
import type { ConductorPassTracePort } from '../../ports/out/ConductorPassTracePort.out-port.js';
import { conductorPassTraceOf } from '../../../domain/conductor-pass-trace.js';
import type { ConductorPassTraceRecord } from '../../../domain/conductor-pass-trace.js';

const NOW = '2026-10-27T10:00:00.000Z';
const HOLDER = 'driver-secret-1';
const LIMITS = { maxActiveRuns: 2, passConcurrency: 1, dispatchStaggerMs: 20000 };

function trace(passId: string): ConductorPassTraceRecord {
  const read = conductorPassTraceOf(
    {
      passId,
      nowIso: NOW,
      holderId: HOLDER,
      halted: false,
      progressed: true,
      runs: [],
      attention: [],
    },
    LIMITS,
  );
  expect(read.ok).toBe(true);
  if (!read.ok) {
    throw new Error('fixture must be a valid trace');
  }
  return read.record;
}

function fakeTraceList(traces: readonly ConductorPassTraceRecord[]): Pick<ConductorPassTracePort, 'list'> {
  return {
    list: async () => ({ outcome: 'listed', traces }),
  };
}

describe('ListConductorPassesUseCase (VZ5b)', () => {
  it('throws Not implemented when unconfigured', async () => {
    const useCase = new ListConductorPassesUseCase();
    await expect(useCase.listConductorPasses({})).rejects.toThrow(
      'Not implemented: ListConductorPassesUseCase',
    );
    await expect(useCase.execute({})).rejects.toThrow(
      'Not implemented: ListConductorPassesUseCase',
    );
  });

  it('lists the newest pass first with totals and truncation', async () => {
    const useCase = new ListConductorPassesUseCase({
      passTrace: fakeTraceList([trace('pass-1'), trace('pass-2'), trace('pass-3')]),
    });
    const result = await useCase.listConductorPasses({});
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      return;
    }
    expect(result.store).toBe('readable');
    expect(result.passes.map((pass) => pass.passId)).toEqual(['pass-3', 'pass-2', 'pass-1']);
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.passes[0]).toEqual({
      schemaVersion: 1,
      passId: 'pass-3',
      nowIso: NOW,
      halted: false,
      progressed: true,
      maxActiveRuns: 2,
      passConcurrency: 1,
      dispatchStaggerMs: 20000,
      runs: [],
      attention: [],
    });

    const limited = await useCase.listConductorPasses({ limit: 2 });
    expect(limited.outcome).toBe('listed');
    if (limited.outcome !== 'listed') {
      return;
    }
    expect(limited.passes.map((pass) => pass.passId)).toEqual(['pass-3', 'pass-2']);
    expect(limited.total).toBe(3);
    expect(limited.truncated).toBe(true);
  });

  it('never carries the stored holder id in the serialized result', async () => {
    const useCase = new ListConductorPassesUseCase({
      passTrace: fakeTraceList([trace('pass-1'), trace('pass-2')]),
    });
    const result = await useCase.listConductorPasses({});
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('holderId');
    expect(serialized).not.toContain(HOLDER);
  });

  it('rejects invalid limits and normalises a digit-string limit in execute', async () => {
    const useCase = new ListConductorPassesUseCase({
      passTrace: fakeTraceList([trace('pass-1'), trace('pass-2'), trace('pass-3')]),
    });
    for (const limit of [0, 33, 1.5]) {
      await expect(useCase.listConductorPasses({ limit })).resolves.toEqual({
        outcome: 'rejected',
        reason: 'invalid-limit',
      });
    }
    const listed = await useCase.execute({ limit: '2' });
    expect(listed.outcome).toBe('listed');
    if (listed.outcome !== 'listed') {
      return;
    }
    expect(listed.passes).toHaveLength(2);
    expect(listed.total).toBe(3);
    expect(listed.truncated).toBe(true);
    await expect(useCase.execute('x')).resolves.toEqual({
      outcome: 'rejected',
      reason: 'invalid-limit',
    });
  });

  it('reports an unreadable store without throwing', async () => {
    const useCase = new ListConductorPassesUseCase({
      passTrace: {
        list: async () => ({ outcome: 'unreadable', reason: 'store-unreadable' }),
      },
    });
    await expect(useCase.listConductorPasses({})).resolves.toEqual({
      outcome: 'listed',
      store: 'unreadable',
      passes: [],
      total: 0,
      truncated: false,
    });
  });
});
