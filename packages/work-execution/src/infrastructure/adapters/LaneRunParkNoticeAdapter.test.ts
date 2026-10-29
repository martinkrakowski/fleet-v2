import { describe, expect, it, vi } from 'vitest';

import { LaneRunParkNoticeAdapter } from './LaneRunParkNoticeAdapter.adapter.js';

const REQUEST = {
  key: 'park:proj-1:wo-7:one-way-door',
  projectId: 'proj-1',
  workOrderId: 'wo-7',
  runId: 'run-42',
  reason: 'one-way-door',
} as const;

function attentionDelegate() {
  return vi.fn(async (_body: unknown, _actor: string) => ({
    outcome: 'raised',
    item: { itemId: 'att-1' },
    revision: 1,
  }));
}

describe('LaneRunParkNoticeAdapter', () => {
  describe('recordParkAttention', () => {
    it('refuses as not-configured when unbound', async () => {
      const adapter = new LaneRunParkNoticeAdapter();
      expect(await adapter.recordParkAttention(REQUEST)).toEqual({
        outcome: 'refused',
        reason: 'not-configured',
      });
    });

    it('raises the fixed attention body naming the reason code, as the conductor', async () => {
      const recordAttentionItem = attentionDelegate();
      const adapter = new LaneRunParkNoticeAdapter({ recordAttentionItem });
      expect(await adapter.recordParkAttention(REQUEST)).toEqual({ outcome: 'recorded' });
      expect(recordAttentionItem).toHaveBeenCalledWith(
        {
          projectId: 'proj-1',
          kind: 'conductor-park',
          subject: { kind: 'run', ref: 'run-42' },
          workOrderId: 'wo-7',
          summary: 'The conductor parked run-42 with reason one-way-door.',
        },
        'conductor',
      );
    });

    it('names the qualifier code in the summary when one is given', async () => {
      const recordAttentionItem = attentionDelegate();
      const adapter = new LaneRunParkNoticeAdapter({ recordAttentionItem });
      await adapter.recordParkAttention({ ...REQUEST, qualifier: 'ci-unknown' });
      expect(recordAttentionItem).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: 'The conductor parked run-42 with reason one-way-door, qualifier ci-unknown.',
        }),
        'conductor',
      );
    });

    it('maps refreshed and reopened outcomes to recorded', async () => {
      for (const outcome of ['refreshed', 'reopened']) {
        const adapter = new LaneRunParkNoticeAdapter({
          recordAttentionItem: vi.fn(async (_request: unknown) => ({ outcome, item: {}, revision: 2 })),
        });
        expect(await adapter.recordParkAttention(REQUEST)).toEqual({ outcome: 'recorded' });
      }
    });

    it('maps a refused delegate answer and a throw to refused unreadable', async () => {
      const refused = new LaneRunParkNoticeAdapter({
        recordAttentionItem: vi.fn(async (_request: unknown) => ({ outcome: 'refused', code: 'request', reason: 'bad' })),
      });
      expect(await refused.recordParkAttention(REQUEST)).toEqual({ outcome: 'refused', reason: 'unreadable' });

      const thrown = new LaneRunParkNoticeAdapter({
        recordAttentionItem: vi.fn(async (_body: unknown, _actor: string) => {
          throw new Error('store down');
        }),
      });
      expect(await thrown.recordParkAttention(REQUEST)).toEqual({ outcome: 'refused', reason: 'unreadable' });
    });
  });

  describe('askParkQuestion', () => {
    it('refuses as not-configured when unbound', async () => {
      const adapter = new LaneRunParkNoticeAdapter();
      expect(await adapter.askParkQuestion(REQUEST)).toEqual({
        outcome: 'refused',
        reason: 'not-configured',
      });
    });

    it('refuses an unknown reason code without asking', async () => {
      const askOwnerQuestion = vi.fn(async (_request: unknown) => ({ outcome: 'asked', question: { questionId: 'q-1' } }));
      const adapter = new LaneRunParkNoticeAdapter({ askOwnerQuestion });
      expect(await adapter.askParkQuestion({ ...REQUEST, reason: 'mystery' })).toEqual({
        outcome: 'refused',
        reason: 'unknown-reason',
      });
      expect(askOwnerQuestion).not.toHaveBeenCalled();
    });

    it.each(['one-way-door', 'owner-merge', 'blocker-after-round-2', 'seat-plan-exhausted'] as const)(
      'asks the fixed question for %s with the keyed idempotency key',
      async (reason) => {
        const askOwnerQuestion = vi.fn(async (_request: unknown) => ({ outcome: 'asked', question: { questionId: 'q-1' } }));
        const adapter = new LaneRunParkNoticeAdapter({ askOwnerQuestion });
        expect(await adapter.askParkQuestion({ ...REQUEST, reason })).toEqual({
          outcome: 'recorded',
          questionId: 'q-1',
        });
        const ask = askOwnerQuestion.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(ask.askedBy).toBe('conductor');
        expect(ask.idempotencyKey).toBe(REQUEST.key);
        expect(ask.questionId).toBe(`park-question:${REQUEST.key}`);
        expect(ask.linkedRequestId).toBeNull();
        expect(ask.doorKind).toBe(reason === 'one-way-door' ? 'one-way' : 'two-way');
        expect(ask.options).toEqual([
          {
            id: 'resume',
            label: 'Resume the run',
            consequence: 'The lane run continues from its parked state.',
          },
          { id: 'stop', label: 'Stop the run', consequence: 'The lane run stops and stays parked.' },
        ]);
        expect(ask.recommendation).toEqual({
          optionId: 'resume',
          because: 'The parked run should continue once the owner has seen the notice.',
        });
        const title = ask.title as string;
        const body = ask.body as string;
        expect(title).toContain(reason);
        expect(body).toContain('run-42');
        expect(body).toContain('wo-7');
        expect(body).toContain('proj-1');
        expect(body).toContain(reason);
      },
    );

    it('maps a keyed repeat to exists with the stored question id', async () => {
      const askOwnerQuestion = vi.fn(async (_request: unknown) => ({
        outcome: 'exists',
        question: { questionId: 'q-stored' },
      }));
      const adapter = new LaneRunParkNoticeAdapter({ askOwnerQuestion });
      expect(await adapter.askParkQuestion(REQUEST)).toEqual({ outcome: 'exists', questionId: 'q-stored' });
    });

    it('maps a refused delegate answer and a throw to refused unreadable', async () => {
      const refused = new LaneRunParkNoticeAdapter({
        askOwnerQuestion: vi.fn(async (_request: unknown) => ({ outcome: 'refused', reason: 'no' })),
      });
      expect(await refused.askParkQuestion(REQUEST)).toEqual({ outcome: 'refused', reason: 'unreadable' });

      const thrown = new LaneRunParkNoticeAdapter({
        askOwnerQuestion: vi.fn(async (_request: unknown) => {
          throw new Error('store down');
        }),
      });
      expect(await thrown.askParkQuestion(REQUEST)).toEqual({ outcome: 'refused', reason: 'unreadable' });
    });
  });

  describe('findParkQuestion', () => {
    it('reports unavailable when unbound', async () => {
      const adapter = new LaneRunParkNoticeAdapter();
      expect(await adapter.findParkQuestion(REQUEST.key)).toEqual({ outcome: 'unavailable' });
    });

    it('looks the question up by the key and maps the open state', async () => {
      const findOwnerQuestionByKey = vi.fn(async (_request: unknown) => ({
        outcome: 'found',
        question: { questionId: 'q-9', state: 'open' },
      }));
      const adapter = new LaneRunParkNoticeAdapter({ findOwnerQuestionByKey });
      expect(await adapter.findParkQuestion(REQUEST.key)).toEqual({
        outcome: 'found',
        questionId: 'q-9',
        state: 'open',
      });
      expect(findOwnerQuestionByKey).toHaveBeenCalledWith({ idempotencyKey: REQUEST.key });
    });

    it.each([
      ['answered', 'answered'],
      ['acknowledged', 'answered'],
      ['rejected', 'answered'],
      ['expired', 'expired'],
    ] as const)('maps owner-question state %s to %s', async (state, expected) => {
      const adapter = new LaneRunParkNoticeAdapter({
        findOwnerQuestionByKey: vi.fn(async (_request: unknown) => ({
          outcome: 'found',
          question: { questionId: 'q-9', state },
        })),
      });
      expect(await adapter.findParkQuestion(REQUEST.key)).toEqual({
        outcome: 'found',
        questionId: 'q-9',
        state: expected,
      });
    });

    it('maps known absence to not-found and malformed or thrown answers to unavailable', async () => {
      const absent = new LaneRunParkNoticeAdapter({
        findOwnerQuestionByKey: vi.fn(async (_request: unknown) => ({ outcome: 'not-found' })),
      });
      expect(await absent.findParkQuestion(REQUEST.key)).toEqual({ outcome: 'not-found' });

      const malformed = new LaneRunParkNoticeAdapter({
        findOwnerQuestionByKey: vi.fn(async (_request: unknown) => ({ outcome: 'found', question: {} })),
      });
      expect(await malformed.findParkQuestion(REQUEST.key)).toEqual({ outcome: 'unavailable' });

      const thrown = new LaneRunParkNoticeAdapter({
        findOwnerQuestionByKey: vi.fn(async (_request: unknown) => {
          throw new Error('store down');
        }),
      });
      expect(await thrown.findParkQuestion(REQUEST.key)).toEqual({ outcome: 'unavailable' });
    });
  });
});
