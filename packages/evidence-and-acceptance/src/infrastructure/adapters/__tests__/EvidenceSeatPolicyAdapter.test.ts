import { describe, expect, it } from 'vitest';

import type { EvidenceCatalogueSeat } from '../../../application/ports/out/EvidenceSeatPolicyPort.out-port.js';
import { EvidenceSeatPolicyAdapter } from '../EvidenceSeatPolicyAdapter.adapter.js';

const FREE_SEAT: EvidenceCatalogueSeat = {
  id: 'mm',
  model: 'opencode/minimax-m3.1-flash-free',
  costClass: 'free',
};

describe('EvidenceSeatPolicyAdapter', () => {
  it('allows any reviewer when useFreeSeats is absent', async () => {
    const adapter = new EvidenceSeatPolicyAdapter({ seats: [FREE_SEAT] });

    await expect(adapter.checkReviewerSeat({ reviewerModel: FREE_SEAT.model })).resolves.toEqual({
      outcome: 'allowed',
    });
  });

  it('allows any reviewer when useFreeSeats is true', async () => {
    const adapter = new EvidenceSeatPolicyAdapter({
      useFreeSeats: true,
      seats: [FREE_SEAT],
    });

    await expect(adapter.checkReviewerSeat({ reviewerModel: FREE_SEAT.model })).resolves.toEqual({
      outcome: 'allowed',
    });
  });

  it('allows a paid seat model when useFreeSeats is false', async () => {
    const adapter = new EvidenceSeatPolicyAdapter({
      useFreeSeats: false,
      seats: [{ id: 'luna', model: 'openrouter/openai/gpt-6-luna', costClass: 'paid' }],
    });

    await expect(
      adapter.checkReviewerSeat({ reviewerModel: 'openrouter/openai/gpt-6-luna' }),
    ).resolves.toEqual({ outcome: 'allowed' });
  });

  it('allows a paid seat with a variant when useFreeSeats is false', async () => {
    const adapter = new EvidenceSeatPolicyAdapter({
      useFreeSeats: false,
      seats: [{ id: 'low-seat', model: 'x/y', variant: 'low', costClass: 'paid' }],
    });

    await expect(adapter.checkReviewerSeat({ reviewerModel: 'x/y' })).resolves.toEqual({
      outcome: 'allowed',
    });
    await expect(adapter.checkReviewerSeat({ reviewerModel: 'x/y:LOW' })).resolves.toEqual({
      outcome: 'allowed',
    });
  });

  it('refuses a free seat model when useFreeSeats is false', async () => {
    const adapter = new EvidenceSeatPolicyAdapter({
      useFreeSeats: false,
      seats: [FREE_SEAT],
    });

    const result = await adapter.checkReviewerSeat({ reviewerModel: FREE_SEAT.model });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('mm');
      expect(result.reason).toContain('policy.useFreeSeats is false');
    }
  });

  it('refuses a free variant when the seat does not carry it', async () => {
    const adapter = new EvidenceSeatPolicyAdapter({
      useFreeSeats: false,
      seats: [{ id: 'paid-seat', model: 'x/y', costClass: 'paid' }],
    });

    const result = await adapter.checkReviewerSeat({ reviewerModel: 'x/y:free' });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('not a seat in the installation catalogue');
    }
  });

  it('refuses a free seat whose model itself carries the free variant', async () => {
    const adapter = new EvidenceSeatPolicyAdapter({
      useFreeSeats: false,
      seats: [{ id: 'free-seat', model: 'p/m:free', costClass: 'free' }],
    });

    const result = await adapter.checkReviewerSeat({ reviewerModel: 'p/m:free' });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('is free seat');
    }
  });

  it('refuses an unknown model when seats are undefined', async () => {
    const adapter = new EvidenceSeatPolicyAdapter({ useFreeSeats: false });

    const result = await adapter.checkReviewerSeat({ reviewerModel: 'some/model' });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('not a seat in the installation catalogue');
    }
  });

  it('refuses a model matched by seats of mixed cost class as ambiguous', async () => {
    const adapter = new EvidenceSeatPolicyAdapter({
      useFreeSeats: false,
      seats: [
        { id: 'free-x', model: 'x/y', costClass: 'free' },
        { id: 'paid-x', model: 'x/y', costClass: 'paid' },
      ],
    });

    const result = await adapter.checkReviewerSeat({ reviewerModel: 'x/y' });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('refused as ambiguous');
      expect(result.reason).toContain('free-x');
      expect(result.reason).toContain('paid-x');
    }
  });
});
