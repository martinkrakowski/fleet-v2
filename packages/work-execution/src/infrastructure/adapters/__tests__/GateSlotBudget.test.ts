// GateSlotBudget tests — KS3: the in-process slot budget never exceeds its capacity.
import { describe, expect, it } from 'vitest';

import {
  GATE_SLOT_BUDGET_DEFAULT_CAPACITY,
  GateSlotBudget,
  readGateSlotCapacity,
} from '../GateSlotBudget.helper.js';

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('GateSlotBudget', () => {
  it('reads only whole capacities in range and falls back to one otherwise', () => {
    expect(readGateSlotCapacity(3)).toBe(3);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 65, '4', null, undefined, {}]) {
      expect(readGateSlotCapacity(bad)).toBe(GATE_SLOT_BUDGET_DEFAULT_CAPACITY);
    }
    expect(new GateSlotBudget(0).capacity).toBe(1);
  });

  it('never runs more tasks than its capacity, and uses all of it', async () => {
    const budget = new GateSlotBudget(3);
    let active = 0;
    let observedPeak = 0;
    const tasks = Array.from({ length: 20 }, (_, index) =>
      budget.run(async () => {
        active += 1;
        observedPeak = Math.max(observedPeak, active);
        await tick(2);
        active -= 1;
        return index;
      }),
    );
    const results = await Promise.all(tasks);
    expect(observedPeak).toBe(3);
    expect(budget.peak).toBe(3);
    expect(budget.inUse).toBe(0);
    expect(budget.waiting).toBe(0);
    expect(results.map((result) => (result.ok ? result.value : -1))).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('serves waiters first come, first served', async () => {
    const budget = new GateSlotBudget(1);
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3].map((index) =>
        budget.run(async () => {
          await tick(1);
          order.push(index);
        }),
      ),
    );
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('releases the slot when a task throws and reports no message', async () => {
    const budget = new GateSlotBudget(1);
    const failed = await budget.run(async () => {
      throw new Error('boom with ghp_secret text');
    });
    expect(failed).toEqual({ ok: false });
    const next = await budget.run(async () => 'fine');
    expect(next).toEqual({ ok: true, value: 'fine' });
    expect(budget.inUse).toBe(0);
  });

  it('one task throwing does not disturb a task already running or waiting', async () => {
    const budget = new GateSlotBudget(2);
    const results = await Promise.all([
      budget.run(async () => {
        await tick(5);
        return 'a';
      }),
      budget.run(async () => {
        throw new Error('x');
      }),
      budget.run(async () => 'c'),
    ]);
    expect(results).toEqual([{ ok: true, value: 'a' }, { ok: false }, { ok: true, value: 'c' }]);
    expect(budget.peak).toBeLessThanOrEqual(2);
  });
});
