import { describe, expect, it, vi } from 'vitest';

import { LaneRunParkNoticeAdapter } from '../LaneRunParkNoticeAdapter.adapter.js';

const REQUEST = {
  key: 'run-42/park@1',
  projectId: 'proj-1',
  workOrderId: 'wo-7',
  runId: 'run-42',
  reason: 'owner-merge',
  parkCount: 1,
} as const;

describe('LaneRunParkNoticeAdapter park occurrence summaries', () => {
  it('names the park occurrence in the summary as the conductor', async () => {
    const recordAttentionItem = vi.fn(async (_body: unknown, _actor: string) => ({ outcome: 'raised', item: {}, revision: 1 }));
    const adapter = new LaneRunParkNoticeAdapter({ recordAttentionItem });
    expect(await adapter.recordParkAttention({ ...REQUEST, parkCount: 3 })).toEqual({ outcome: 'recorded' });
    const body = recordAttentionItem.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.summary).toBe('The conductor parked run-42 with reason owner-merge (park 3).');
    expect(body.kind).toBe('conductor-park');
    expect(recordAttentionItem.mock.calls[0]?.[1]).toBe('conductor');
  });

  it('keeps the old summary text when parkCount is omitted', async () => {
    const recordAttentionItem = vi.fn(async (_body: unknown, _actor: string) => ({ outcome: 'raised', item: {}, revision: 1 }));
    const adapter = new LaneRunParkNoticeAdapter({ recordAttentionItem });
    const { parkCount: _omitted, ...withoutParkCount } = REQUEST;
    void _omitted;
    await adapter.recordParkAttention(withoutParkCount);
    const body = recordAttentionItem.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.summary).toBe('The conductor parked run-42 with reason owner-merge.');
    expect(String(body.summary)).not.toContain('(park');
  });

  it.each([0, 1.5, -1])('refuses a parkCount of %s before calling the delegate', async (parkCount) => {
    const recordAttentionItem = vi.fn(async (_body: unknown, _actor: string) => ({ outcome: 'raised', item: {}, revision: 1 }));
    const adapter = new LaneRunParkNoticeAdapter({ recordAttentionItem });
    expect(await adapter.recordParkAttention({ ...REQUEST, parkCount })).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(recordAttentionItem).not.toHaveBeenCalled();
  });

  it('builds byte-identical bodies for two identical requests', async () => {
    const recordAttentionItem = vi.fn(async (_body: unknown, _actor: string) => ({ outcome: 'raised', item: {}, revision: 1 }));
    const adapter = new LaneRunParkNoticeAdapter({ recordAttentionItem });
    await adapter.recordParkAttention(REQUEST);
    await adapter.recordParkAttention(REQUEST);
    expect(recordAttentionItem).toHaveBeenCalledTimes(2);
    expect(recordAttentionItem.mock.calls[0]?.[0]).toEqual(recordAttentionItem.mock.calls[1]?.[0]);
  });

  it('maps refreshed to exists and raised to recorded', async () => {
    const refreshed = new LaneRunParkNoticeAdapter({
      recordAttentionItem: vi.fn(async (_body: unknown, _actor: string) => ({ outcome: 'refreshed', item: {}, revision: 1 })),
    });
    expect(await refreshed.recordParkAttention(REQUEST)).toEqual({ outcome: 'exists' });
    const raised = new LaneRunParkNoticeAdapter({
      recordAttentionItem: vi.fn(async (_body: unknown, _actor: string) => ({ outcome: 'raised', item: {}, revision: 1 })),
    });
    expect(await raised.recordParkAttention(REQUEST)).toEqual({ outcome: 'recorded' });
  });
});
