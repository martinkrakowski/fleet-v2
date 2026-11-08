// PT1a: the stall attention adapter composes fixed text from ids, a class and an age, and never throws.
import { describe, expect, it } from 'vitest';

import { StallAttentionAdapter } from '../StallAttentionAdapter.adapter.js';

const RUN = 'run-01M63WPH4GMF2CA3NQ7JAM4HS1';
const COMMAND = {
  projectId: 'fleet-v2',
  workOrderId: 'wo-fleet-v2-sr1c-dedupe-2026-10-29',
  runId: RUN,
  parkClass: 'blocker',
  ageMinutes: 47,
} as const;

describe('StallAttentionAdapter (PT1a)', () => {
  it('raises one run-subject conductor-stall item with fixed text and the age rounded down to five minutes', async () => {
    const calls: { body: unknown; actor: string }[] = [];
    const adapter = new StallAttentionAdapter({
      recordAttentionItem: async (body, actor) => {
        calls.push({ body, actor });
        return { outcome: 'raised' };
      },
    });
    expect(await adapter.raiseStallAttention(COMMAND)).toEqual({ outcome: 'raised', reasonCode: null });
    expect(calls).toEqual([
      {
        actor: 'conductor',
        body: {
          projectId: 'fleet-v2',
          kind: 'conductor-stall',
          subject: { kind: 'run', ref: RUN },
          workOrderId: 'wo-fleet-v2-sr1c-dedupe-2026-10-29',
          summary: `stall:${RUN} class=blocker parked>=45m work-order=wo-fleet-v2-sr1c-dedupe-2026-10-29`,
        },
      },
    ]);
  });

  it('refuses a malformed command without calling the store and without echoing it', async () => {
    let called = false;
    const adapter = new StallAttentionAdapter({
      recordAttentionItem: async () => {
        called = true;
        return { outcome: 'raised' };
      },
    });
    const secret = 'sk-' + 'a1'.repeat(15);
    for (const bad of [
      { ...COMMAND, runId: 'not-a-run' },
      { ...COMMAND, projectId: secret },
      { ...COMMAND, workOrderId: 'x y' },
      { ...COMMAND, parkClass: 'made-up' },
      { ...COMMAND, ageMinutes: -1 },
      { ...COMMAND, ageMinutes: 1.5 },
      { ...COMMAND, state: 'gating' },
      { ...COMMAND, parkClass: undefined },
      { projectId: 'fleet-v2', workOrderId: 'wo-fleet-v2-sr1c-dedupe-2026-10-29', runId: RUN, parkClass: undefined, state: 'gating', ageMinutes: 47 },
      { projectId: 'fleet-v2', workOrderId: 'wo-fleet-v2-sr1c-dedupe-2026-10-29', runId: RUN, ageMinutes: 47 },
      null,
    ]) {
      const answer = await adapter.raiseStallAttention(bad as never);
      expect(answer).toEqual({ outcome: 'refused', reasonCode: 'invalid-request' });
      expect(JSON.stringify(answer)).not.toContain(secret);
    }
    expect(called).toBe(false);
  });

  it('raises an idle item with a state= summary and no class or parked text', async () => {
    const calls: { body: unknown; actor: string }[] = [];
    const adapter = new StallAttentionAdapter({
      recordAttentionItem: async (body, actor) => {
        calls.push({ body, actor });
        return { outcome: 'raised' };
      },
    });
    const idleCommand = {
      projectId: 'fleet-v2',
      workOrderId: 'wo-fleet-v2-sr1c-dedupe-2026-10-29',
      runId: RUN,
      state: 'gating',
      ageMinutes: 47,
      lastAdvancedAtIso: '2026-11-06T19:00:00.000Z',
    } as const;
    expect(await adapter.raiseStallAttention(idleCommand)).toEqual({ outcome: 'raised', reasonCode: null });
    expect(calls[0]!.body).toEqual({
      projectId: 'fleet-v2',
      kind: 'conductor-stall',
      subject: { kind: 'run', ref: RUN },
      workOrderId: 'wo-fleet-v2-sr1c-dedupe-2026-10-29',
      summary: `stall:${RUN} state=gating idle>=45m work-order=wo-fleet-v2-sr1c-dedupe-2026-10-29`,
    });
    const body = calls[0]!.body as { summary: string };
    expect(body.summary).not.toContain('class=');
    expect(body.summary).not.toContain('parked');
  });

  it('refuses an unknown state without calling the store', async () => {
    let called = false;
    const adapter = new StallAttentionAdapter({
      recordAttentionItem: async () => {
        called = true;
        return { outcome: 'raised' };
      },
    });
    const answer = await adapter.raiseStallAttention({
      projectId: 'fleet-v2',
      workOrderId: 'wo-fleet-v2-sr1c-dedupe-2026-10-29',
      runId: RUN,
      state: 'made-up',
      ageMinutes: 47,
      lastAdvancedAtIso: '2026-11-06T19:00:00.000Z',
    } as never);
    expect(answer).toEqual({ outcome: 'refused', reasonCode: 'invalid-request' });
    expect(called).toBe(false);
  });

  it('reports not-configured, a refused delegate and a thrown delegate as values', async () => {
    expect(await new StallAttentionAdapter().raiseStallAttention(COMMAND)).toEqual({ outcome: 'refused', reasonCode: 'not-configured' });
    const refused = new StallAttentionAdapter({ recordAttentionItem: async () => ({ outcome: 'refused', code: 'store-unreadable' }) });
    expect(await refused.raiseStallAttention(COMMAND)).toEqual({ outcome: 'refused', reasonCode: 'store-unreadable' });
    const thrown = new StallAttentionAdapter({
      recordAttentionItem: async () => {
        throw new Error('boom with /home/martin/secret/path');
      },
    });
    const answer = await thrown.raiseStallAttention(COMMAND);
    expect(answer).toEqual({ outcome: 'refused', reasonCode: 'unreadable' });
  });

  it('clears by key as resolved via machine, and lists only the open stall items of runs', async () => {
    const requests: { request: unknown; via: string; actor: string }[] = [];
    const adapter = new StallAttentionAdapter({
      clearAttentionItem: async (request, via, actor) => {
        requests.push({ request, via, actor });
        return { outcome: 'cleared' };
      },
      listAttentionItems: async () => ({
        items: [
          { item: { projectId: 'fleet-v2', kind: 'conductor-stall', subject: { kind: 'run', ref: RUN } } },
          { item: { projectId: 'fleet-v2', kind: 'conductor-park', subject: { kind: 'run', ref: RUN } } },
          { item: { projectId: 'fleet-v2', kind: 'conductor-stall', subject: { kind: 'pr', ref: 'a/b#1' } } },
          { item: { projectId: 'fleet-v2', kind: 'conductor-stall', subject: { kind: 'run', ref: 'not-a-run' } } },
        ],
      }),
    });
    expect(await adapter.clearStallAttention({ projectId: 'fleet-v2', runId: RUN })).toEqual({ outcome: 'cleared', reasonCode: null });
    expect(requests[0]).toEqual({
      via: 'machine',
      actor: 'conductor',
      request: { action: 'resolve', projectId: 'fleet-v2', kind: 'conductor-stall', subject: { kind: 'run', ref: RUN }, reason: 'resolved' },
    });
    expect(await adapter.listOpenStallAttention()).toEqual({ outcome: 'found', items: [{ projectId: 'fleet-v2', runId: RUN }] });
    expect(await new StallAttentionAdapter().listOpenStallAttention()).toEqual({ outcome: 'unavailable' });
  });
});
