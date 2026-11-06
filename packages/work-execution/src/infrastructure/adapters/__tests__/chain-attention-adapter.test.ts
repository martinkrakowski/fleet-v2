// ChainAttentionAdapter tests (lane CO8): the adapter delegates in-process to
// operator coordination's RecordAttentionItemPort and ClearAttentionItemPort,
// composing the summary from ids and codes only. A refused delegate call is
// reported with the delegate's code and never retried; unknown kinds refuse
// without throwing.

import { describe, expect, it } from 'vitest';

import { ChainAttentionAdapter } from '../ChainAttentionAdapter.adapter.js';
import type { ChainAttentionCommand } from '../../../application/ports/out/ChainAttentionPort.out-port.js';

const PROJECT = 'proj-1';
const CHAIN = 'example';
const KIND = 'chain-refresh-conflict';

function raiseCommand(overrides: Partial<ChainAttentionCommand> = {}): ChainAttentionCommand {
  return { projectId: PROJECT, chainName: CHAIN, kind: KIND, ...overrides };
}

describe('ChainAttentionAdapter raise', () => {
  it('raises a chain attention item through operator coordination and refreshes a repeat', async () => {
    const bodies: { body: unknown; actor: string }[] = [];
    const delegate = {
      recordAttentionItem: async (body: unknown, actor: string) => {
        bodies.push({ body, actor });
        return { outcome: 'raised', item: {}, revision: 1 };
      },
    };
    const adapter = new ChainAttentionAdapter(delegate);
    const first = await adapter.raiseChainAttention(raiseCommand());
    expect(first).toEqual({ outcome: 'raised', reasonCode: null });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.actor).toBe('chain-refresh');
    const body = bodies[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      projectId: PROJECT,
      kind: KIND,
      workOrderId: null,
      subject: { kind: 'run', ref: CHAIN },
      summary: `chain-refresh-conflict chain=${CHAIN}`,
    });

    delegate.recordAttentionItem = async () => ({ outcome: 'refreshed', item: {}, revision: 2 });
    expect(await adapter.raiseChainAttention(raiseCommand())).toEqual({ outcome: 'refreshed', reasonCode: null });
  });

  it('uses the link pull request subject and repository in the summary when one is carried', async () => {
    const bodies: unknown[] = [];
    const adapter = new ChainAttentionAdapter({
      recordAttentionItem: async (body) => {
        bodies.push(body);
        return { outcome: 'raised', item: {}, revision: 1 };
      },
    });
    await adapter.raiseChainAttention(raiseCommand({ kind: 'link-not-landed', linkPullRequest: { owner: 'fleet', repo: 'v2', number: 7 } }));
    const body = bodies[0] as Record<string, unknown>;
    expect(body.subject).toEqual({ kind: 'pr', ref: 'fleet/v2#7' });
    expect(body.summary).toBe('link-not-landed chain=example repo=fleet/v2');
  });

  it('a refused raise is reported and never retried blindly', async () => {
    let calls = 0;
    const adapter = new ChainAttentionAdapter({
      recordAttentionItem: async () => {
        calls += 1;
        return { outcome: 'refused', code: 'store-unreadable', reason: 'x' };
      },
    });
    const result = await adapter.raiseChainAttention(raiseCommand());
    expect(result).toEqual({ outcome: 'refused', reasonCode: 'store-unreadable' });
    expect(calls).toBe(1);
  });

  it('an unknown attention kind is refused without throwing', async () => {
    const adapter = new ChainAttentionAdapter({
      recordAttentionItem: async () => ({ outcome: 'raised', item: {}, revision: 1 }),
    });
    const result = await adapter.raiseChainAttention(raiseCommand({ kind: 'made-up' as never }));
    expect(result).toEqual({ outcome: 'refused', reasonCode: 'invalid-request' });
  });

  it('a throwing delegate is a refusal, never a throw', async () => {
    const adapter = new ChainAttentionAdapter({
      recordAttentionItem: async () => {
        throw new Error('boom');
      },
    });
    expect((await adapter.raiseChainAttention(raiseCommand())).outcome).toBe('refused');
    expect(await adapter.raiseChainAttention(null as never)).toEqual({ outcome: 'refused', reasonCode: 'invalid-request' });
  });
});

describe('ChainAttentionAdapter clear', () => {
  it('clears a chain attention item as resolved through operator coordination', async () => {
    const requests: { request: unknown; via: string; actor: string }[] = [];
    const adapter = new ChainAttentionAdapter({
      clearAttentionItem: async (request, via, actor) => {
        requests.push({ request, via, actor });
        return { outcome: 'cleared', items: [] };
      },
    });
    const result = await adapter.clearChainAttention(raiseCommand());
    expect(result).toEqual({ outcome: 'cleared', reasonCode: null });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.via).toBe('machine');
    expect(requests[0]!.actor).toBe('chain-refresh');
    expect(requests[0]!.request).toEqual({
      action: 'resolve',
      projectId: PROJECT,
      kind: KIND,
      subject: { kind: 'run', ref: CHAIN },
      reason: 'resolved',
    });
  });

  it('reports not-found and unchanged, and a refusal with the delegate code', async () => {
    const adapter = new ChainAttentionAdapter({
      clearAttentionItem: async (request) => {
        const ref = (request as { subject?: { ref?: string } }).subject?.ref;
        if (ref === 'missing') return { outcome: 'not-found' };
        if (ref === 'unchanged') return { outcome: 'unchanged', items: [] };
        return { outcome: 'refused', code: 'conflict', reason: 'x' };
      },
    });
    expect(await adapter.clearChainAttention(raiseCommand({ chainName: 'missing' }))).toEqual({ outcome: 'not-found', reasonCode: null });
    expect(await adapter.clearChainAttention(raiseCommand({ chainName: 'unchanged' }))).toEqual({ outcome: 'unchanged', reasonCode: null });
    expect(await adapter.clearChainAttention(raiseCommand())).toEqual({ outcome: 'refused', reasonCode: 'conflict' });
  });
});
