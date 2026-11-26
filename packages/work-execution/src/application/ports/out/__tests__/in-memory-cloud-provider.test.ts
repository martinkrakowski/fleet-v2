import { describe, expect, it } from 'vitest';

import { InMemoryCloudProvider } from './in-memory-cloud-provider.js';
import { describeCloudProviderContract } from './cloud-provider.contract.js';

const FIXED_CLOCK = (): string => '2026-01-01T00:00:00.000Z';

describeCloudProviderContract('in-memory', (options) => {
  return new InMemoryCloudProvider({
    quota: options?.quota ?? 2,
    unavailable: options?.unavailable,
    clock: options?.clock ?? FIXED_CLOCK,
  });
});

describe('InMemoryCloudProvider fake-specific behaviour', () => {
  it('records every validated request with the timestamp from the injected clock', async () => {
    let now = 0;
    const clock = (): string => {
      const stamp = `2026-01-01T00:00:${String(now).padStart(2, '0')}.000Z`;
      now += 1;
      return stamp;
    };
    const provider = new InMemoryCloudProvider({ quota: 2, clock });

    const provisioned = await provider.provision({ requestId: 'req-1', hostClass: 'standard' });
    expect(provisioned.ok).toBe(true);
    if (!provisioned.ok) {
      throw new Error('unreachable: provision must succeed here');
    }
    await provider.drain({ hostId: provisioned.hostId });
    await provider.terminate({ hostId: provisioned.hostId });

    const recorded = provider.getRecordedRequests();
    expect(recorded.map((entry) => entry.kind)).toEqual(['provision', 'drain', 'terminate']);
    expect(recorded[0]).toEqual({
      kind: 'provision',
      requestId: 'req-1',
      hostClass: 'standard',
      hostId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(recorded[1]).toEqual({
      kind: 'drain',
      requestId: null,
      hostClass: null,
      hostId: provisioned.hostId,
      timestamp: '2026-01-01T00:00:01.000Z',
    });
    expect(recorded[2]).toEqual({
      kind: 'terminate',
      requestId: null,
      hostClass: null,
      hostId: provisioned.hostId,
      timestamp: '2026-01-01T00:00:02.000Z',
    });
  });

  it('refuses provisions with quota when the injected quota is negative or NaN', async () => {
    for (const quota of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      const provider = new InMemoryCloudProvider({ quota, clock: FIXED_CLOCK });
      const provisioned = await provider.provision({
        requestId: 'req-1',
        hostClass: 'standard',
      });
      expect(provisioned, `quota ${String(quota)}`).toEqual({ ok: false, reason: 'quota' });
    }
  });

  it('refuses a first provision with quota when quota is 0', async () => {
    const provider = new InMemoryCloudProvider({ quota: 0, clock: FIXED_CLOCK });
    const provisioned = await provider.provision({ requestId: 'req-1', hostClass: 'standard' });
    expect(provisioned).toEqual({ ok: false, reason: 'quota' });
  });
});
