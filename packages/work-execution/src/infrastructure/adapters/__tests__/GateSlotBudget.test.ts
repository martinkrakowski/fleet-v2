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

  it('reconciles a new declaration conservatively while busy and fully once idle', async () => {
    const budget = new GateSlotBudget(2);
    const running = budget.run(() => tick(10));
    budget.reconcile(5);
    expect(budget.capacity).toBe(2);
    budget.reconcile(1);
    expect(budget.capacity).toBe(1);
    await running;
    budget.reconcile(4);
    expect(budget.capacity).toBe(4);
    budget.reconcile('nonsense');
    expect(budget.capacity).toBe(1);
  });

  it('never starts a waiter while a lowered capacity is still full', async () => {
    const budget = new GateSlotBudget(2);
    let releaseA: () => void = () => undefined;
    let releaseB: () => void = () => undefined;
    let active = 0;
    let observedPeak = 0;
    const hold = (setRelease: (fn: () => void) => void): (() => Promise<void>) => () => {
      active += 1;
      observedPeak = Math.max(observedPeak, active);
      return new Promise<void>((resolve) => {
        setRelease(() => {
          active -= 1;
          resolve();
        });
      });
    };
    const a = budget.run(hold((fn) => (releaseA = fn)));
    const b = budget.run(hold((fn) => (releaseB = fn)));
    let thirdStarted = false;
    const c = budget.run(async () => {
      thirdStarted = true;
      expect(active).toBe(0);
    });
    await tick(2);
    budget.reconcile(1);
    releaseA();
    await a;
    await tick(2);
    expect(thirdStarted).toBe(false);
    releaseB();
    await b;
    await c;
    expect(thirdStarted).toBe(true);
    expect(observedPeak).toBe(2);
  });
});
