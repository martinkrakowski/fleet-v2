import { describe, expect, it } from 'vitest';

import type { RecordOwnerItemResult, ResolveOwnerItemResult } from '@fleet/operator-coordination';

import {
  OwnerItemsWriteAdapter,
  type OwnerItemsWriteDelegate,
} from '../OwnerItemsWriteAdapter.adapter.js';

const OPEN_REQUEST = {
  projectId: 'example-project',
  planId: 'plan-1',
  decisionId: 'd1',
  subject: 'Which database engine?',
  blocks: [{ kind: 'lane' as const, ref: 'plan-1/lane-1' }],
};

const RESOLVE_REQUEST = {
  projectId: 'example-project',
  planId: 'plan-1',
  decisionId: 'd1',
  outcome: 'decided' as const,
  planRevision: 3,
};

function delegateWith(
  recordAnswer?: () => Promise<RecordOwnerItemResult>,
  resolveAnswer?: () => Promise<ResolveOwnerItemResult>,
): OwnerItemsWriteDelegate {
  return {
    recordOwnerItem: recordAnswer === undefined ? undefined : async () => recordAnswer(),
    resolveOwnerItem: resolveAnswer === undefined ? undefined : async () => resolveAnswer(),
  };
}

describe('OwnerItemsWriteAdapter', () => {
  it('refuses not-configured when a delegate is unbound', async () => {
    const adapter = new OwnerItemsWriteAdapter({});
    expect(await adapter.openDecisionItem(OPEN_REQUEST)).toEqual({
      outcome: 'refused',
      code: 'not-configured',
      reason: 'no owner-item recorder is bound',
    });
    expect(await adapter.resolvePlanDecision(RESOLVE_REQUEST)).toEqual({
      outcome: 'refused',
      code: 'not-configured',
      reason: 'no owner-item resolver is bound',
    });
  });

  it('refuses unreadable when a delegate throws or answers unrecognized', async () => {
    const throwing: OwnerItemsWriteDelegate = {
      recordOwnerItem: async () => {
        throw new Error('boom');
      },
      resolveOwnerItem: async () => {
        throw new Error('boom');
      },
    };
    expect(await new OwnerItemsWriteAdapter(throwing).openDecisionItem(OPEN_REQUEST)).toEqual({
      outcome: 'refused',
      code: 'unreadable',
      reason: 'the owner-item recorder threw',
    });
    expect(await new OwnerItemsWriteAdapter(throwing).resolvePlanDecision(RESOLVE_REQUEST)).toEqual({
      outcome: 'refused',
      code: 'unreadable',
      reason: 'the owner-item resolver threw',
    });

    const strange = delegateWith(
      async () => ({ outcome: 'mystery' }) as unknown as RecordOwnerItemResult,
      async () => ({ outcome: 'mystery' }) as unknown as ResolveOwnerItemResult,
    );
    expect((await new OwnerItemsWriteAdapter(strange).openDecisionItem(OPEN_REQUEST)).outcome).toBe('refused');
    expect((await new OwnerItemsWriteAdapter(strange).resolvePlanDecision(RESOLVE_REQUEST)).outcome).toBe('refused');
  });

  it('maps recorded/exists and key-held/refused through with the delegate reason', async () => {
    const recorded = delegateWith(async () => ({ outcome: 'recorded', item: {}, revision: 1 }) as RecordOwnerItemResult);
    expect(await new OwnerItemsWriteAdapter(recorded).openDecisionItem(OPEN_REQUEST)).toEqual({ outcome: 'opened' });

    const exists = delegateWith(async () => ({ outcome: 'exists', item: {}, revision: 1 }) as RecordOwnerItemResult);
    expect(await new OwnerItemsWriteAdapter(exists).openDecisionItem(OPEN_REQUEST)).toEqual({ outcome: 'exists' });

    const keyHeld = delegateWith(async () => ({ outcome: 'key-held', heldByItemId: 'x', reason: 'key held elsewhere' }) as RecordOwnerItemResult);
    expect(await new OwnerItemsWriteAdapter(keyHeld).openDecisionItem(OPEN_REQUEST)).toEqual({
      outcome: 'refused',
      code: 'refused',
      reason: 'key held elsewhere',
    });

    const refused = delegateWith(async () => ({ outcome: 'refused', code: 'request', reason: 'bad request' }) as RecordOwnerItemResult);
    expect(await new OwnerItemsWriteAdapter(refused).openDecisionItem(OPEN_REQUEST)).toEqual({
      outcome: 'refused',
      code: 'refused',
      reason: 'bad request',
    });

    const resolved = delegateWith(undefined, async () => ({ outcome: 'resolved', item: {}, revision: 2 }) as ResolveOwnerItemResult);
    expect(await new OwnerItemsWriteAdapter(resolved).resolvePlanDecision(RESOLVE_REQUEST)).toEqual({ outcome: 'resolved' });

    const notFound = delegateWith(undefined, async () => ({ outcome: 'not-found' }) as ResolveOwnerItemResult);
    expect(await new OwnerItemsWriteAdapter(notFound).resolvePlanDecision(RESOLVE_REQUEST)).toEqual({ outcome: 'not-found' });

    const refusedResolve = delegateWith(undefined, async () => ({ outcome: 'refused', code: 'conflict', reason: 'conflict' }) as ResolveOwnerItemResult);
    expect(await new OwnerItemsWriteAdapter(refusedResolve).resolvePlanDecision(RESOLVE_REQUEST)).toEqual({
      outcome: 'refused',
      code: 'refused',
      reason: 'conflict',
    });
  });

  it('the delegate body carries exactly the fixed keys and never an id, time or state', async () => {
    let seenBody: unknown;
    let seenActor: string | null = null;
    const adapter = new OwnerItemsWriteAdapter({
      recordOwnerItem: async (body, actor) => {
        seenBody = body;
        seenActor = actor;
        return { outcome: 'recorded', item: {}, revision: 1 } as RecordOwnerItemResult;
      },
    }, 'plan-import');
    await adapter.openDecisionItem(OPEN_REQUEST);
    expect(seenBody).toEqual({
      projectId: 'example-project',
      kind: 'decision',
      subject: 'Which database engine?',
      refs: [{ kind: 'plan-decision', planId: 'plan-1', decisionId: 'd1' }],
      blocks: [{ kind: 'lane', ref: 'plan-1/lane-1' }],
    });
    expect(seenActor).toBe('plan-import');
    expect(Object.keys(seenBody as Record<string, unknown>).sort()).toEqual([
      'blocks', 'kind', 'projectId', 'refs', 'subject',
    ]);
  });
});
