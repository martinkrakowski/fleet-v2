// The e2e fixture's port pair (KF-35b): a runner forward dials the fake
// server's port plus one, so both must be free and outside the ephemeral range.
import { describe, expect, it } from 'vitest';

import {
  PORT_PAIR_MAX,
  PORT_PAIR_MIN,
  loopbackPortIsFree,
  pickDialablePortPair,
} from './e2e/port-pair.js';

describe('pickDialablePortPair (KF-35b)', () => {
  it('always returns a pair below the ephemeral range', async () => {
    for (const r of [0, 0.5, 0.999999]) {
      const port = await pickDialablePortPair(async () => true, () => r);
      expect(port).toBeGreaterThanOrEqual(PORT_PAIR_MIN);
      expect(port + 1).toBeLessThanOrEqual(PORT_PAIR_MAX);
      expect(port + 1).toBeLessThan(32768);
    }
  });

  it('skips a candidate whose dial port (port + 1) is taken', async () => {
    const candidates = [0.1, 0.2];
    let call = 0;
    const evenPortAt = (x: number) => PORT_PAIR_MIN + 2 * Math.floor(x * Math.floor((PORT_PAIR_MAX - PORT_PAIR_MIN) / 2));
    const first = evenPortAt(0.1);
    const port = await pickDialablePortPair(
      async (p) => p !== first + 1,
      () => candidates[Math.min(call++, candidates.length - 1)]!,
    );
    expect(port).not.toBe(first);
    expect(port).toBe(evenPortAt(0.2));
    // Even server ports only, so two fixtures' pairs never overlap (CodeRabbit).
    expect(port % 2).toBe(0);
  });

  it('gives up after a bounded number of attempts', async () => {
    await expect(pickDialablePortPair(async () => false, () => 0.3)).rejects.toThrow(/no free port pair/);
  });

  it('a real pick leaves both ports bindable', async () => {
    const port = await pickDialablePortPair();
    expect(await loopbackPortIsFree(port)).toBe(true);
    expect(await loopbackPortIsFree(port + 1)).toBe(true);
  });
});
