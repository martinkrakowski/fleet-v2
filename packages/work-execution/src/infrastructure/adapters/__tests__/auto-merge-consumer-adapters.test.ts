// Delegate adapter tests for AM5-1: PolicyMergeGrantAdapter and
// AutoMergeOwnerRoutingAdapter map the coordination context's typed answers.
// The fakes are object-literal recordings; nothing here touches a store, a
// forge, a process or the network.

import { describe, expect, it } from 'vitest';

import type {
  AskOwnerQuestionPort,
  AskOwnerQuestionRequest,
  AttentionItemRecord,
  IssuePolicyForgeGrantPort,
  IssuePolicyForgeGrantRequest,
  IssuePolicyForgeGrantResult,
  OwnerQuestionRecord,
  RecordAttentionItemBody,
  RecordAttentionItemPort,
  RecordAttentionItemResult,
} from '@fleet/operator-coordination';

import { PolicyMergeGrantAdapter } from '../PolicyMergeGrantAdapter.adapter.js';
import { AutoMergeOwnerRoutingAdapter } from '../AutoMergeOwnerRoutingAdapter.adapter.js';
import type { PolicyMergeGrantRequest } from '../../../application/ports/out/PolicyMergeGrantPort.out-port.js';
import type { AutoMergeNotice } from '../../../application/ports/out/AutoMergeOwnerRoutingPort.out-port.js';

type GrantPortDelegate = Pick<IssuePolicyForgeGrantPort, 'issuePolicyForgeGrant'>;
type AskPortDelegate = Pick<AskOwnerQuestionPort, 'askOwnerQuestion'>;
type AttentionPortDelegate = Pick<RecordAttentionItemPort, 'recordAttentionItem'>;

const HEAD_ONE = '1111111111111111111111111111111111111111';
const HEAD_TWO = '2222222222222222222222222222222222222222';

function makeGrantRequest(
  overrides: Partial<PolicyMergeGrantRequest> = {},
): PolicyMergeGrantRequest {
  return {
    projectId: 'project-example-1',
    workOrderId: 'work-order-example-1',
    attemptId: 'attempt-example-1',
    expectedHeadSha: HEAD_ONE,
    policyRevision: 'policy-revision-1',
    acceptanceReceiptId: 'receipt-1',
    settingRevision: '111111111111',
    ...overrides,
  };
}

function makeNotice(overrides: Partial<AutoMergeNotice> = {}): AutoMergeNotice {
  return {
    key: 'auto-merge/attempt-example-1/111111111111/high-risk',
    projectId: 'project-example-1',
    workOrderId: 'work-order-example-1',
    attemptId: 'attempt-example-1',
    headSha: HEAD_ONE,
    reason: 'high-risk',
    lines: [],
    ...overrides,
  };
}

function grantedAnswer(
  request: PolicyMergeGrantRequest,
  patch: {
    readonly workOrderId?: string;
    readonly attemptId?: string;
    readonly expectedHeadSha?: string;
  } = {},
): IssuePolicyForgeGrantResult {
  return {
    outcome: 'issued',
    requestId: 'grant-request-1',
    grantId: 'grant-1',
    actionScope: 'forge:merge-pr',
    decisionRevision: 'policy:autoMerge@111111111111',
    workOrderId: patch.workOrderId ?? request.workOrderId,
    attemptId: patch.attemptId ?? request.attemptId,
    expectedHeadSha: patch.expectedHeadSha ?? request.expectedHeadSha,
    cancelledGrantIds: [],
  };
}

function attentionItem(): AttentionItemRecord {
  return {
    itemId: 'attention-item-1',
    projectId: 'project-example-1',
    kind: 'auto-merge',
    subject: { kind: 'attempt', ref: 'attempt-example-1' },
    workOrderId: 'work-order-example-1',
    summary: 'high-risk',
    state: 'open',
    raisedBy: 'auto-merge',
    firstRaisedAtIso: '2026-10-28T00:00:00.000Z',
    lastRaisedAtIso: '2026-10-28T00:00:00.000Z',
    raisedCount: 1,
    clearance: null,
  };
}

function questionRecord(): OwnerQuestionRecord {
  return {
    questionId: 'question-1',
    revision: 1,
    askedBy: 'auto-merge',
    title: 'Auto-merge held attempt attempt-example-1: high-risk',
    body: 'Auto-merge did not merge attempt attempt-example-1 (work order work-order-example-1).\nReason: high-risk\nHead: ' + HEAD_ONE,
    options: [{ id: 'hold', label: 'Leave it held', consequence: 'Nothing merges.' }],
    recommendation: { optionId: 'hold', because: 'Auto-merge stopped.' },
    doorKind: 'two-way',
    linkedRequestId: null,
    blocks: [{ kind: 'work-order', ref: 'work-order-example-1' }],
    state: 'open',
    askedAt: '2026-10-28T00:00:00.000Z',
    expiresAt: null,
    answer: null,
    acknowledgement: null,
  };
}

describe('PolicyMergeGrantAdapter', () => {
  it('passes forgeKind merge-pr, source autoMerge and every request field unchanged', async () => {
    const request = makeGrantRequest();
    let received: IssuePolicyForgeGrantRequest | undefined;
    const delegate: GrantPortDelegate = {
      issuePolicyForgeGrant: async (req) => {
        received = req;
        return grantedAnswer(request);
      },
    };
    const adapter = new PolicyMergeGrantAdapter({ issuePolicyForgeGrant: delegate });

    await adapter.issuePolicyMergeGrant(request);

    expect(received).toEqual({ ...request, forgeKind: 'merge-pr', source: 'autoMerge' });
  });

  it('maps issued with matching coordinates to issued with the grant id and decision revision', async () => {
    const request = makeGrantRequest();
    const delegate: GrantPortDelegate = {
      issuePolicyForgeGrant: async () => grantedAnswer(request),
    };
    const adapter = new PolicyMergeGrantAdapter({ issuePolicyForgeGrant: delegate });

    await expect(adapter.issuePolicyMergeGrant(request)).resolves.toEqual({
      outcome: 'issued',
      grantId: 'grant-1',
      decisionRevision: 'policy:autoMerge@111111111111',
    });
  });

  it.each([
    ['another attempt id', { attemptId: 'attempt-example-2' }],
    ['another head', { expectedHeadSha: HEAD_TWO }],
    ['another work order', { workOrderId: 'work-order-example-2' }],
  ])('refuses issued with coordinates that do not match the request: %s', async (_label, patch) => {
    const request = makeGrantRequest();
    const delegate: GrantPortDelegate = {
      issuePolicyForgeGrant: async () => grantedAnswer(request, patch),
    };
    const adapter = new PolicyMergeGrantAdapter({ issuePolicyForgeGrant: delegate });

    await expect(adapter.issuePolicyMergeGrant(request)).resolves.toEqual({
      outcome: 'refused',
      reason: 'policy grant coordinates do not match the request',
    });
  });

  it('calls a class-based grant port through its object, keeping its receiver', async () => {
    const request = makeGrantRequest();
    class GrantPort {
      private readonly answer = grantedAnswer(request);
      async issuePolicyForgeGrant() {
        return this.answer;
      }
    }
    const adapter = new PolicyMergeGrantAdapter({ issuePolicyForgeGrant: new GrantPort() as unknown as GrantPortDelegate });

    await expect(adapter.issuePolicyMergeGrant(request)).resolves.toMatchObject({ outcome: 'issued', grantId: 'grant-1' });
  });

  it('maps superseded to superseded', async () => {
    const request = makeGrantRequest();
    const delegate: GrantPortDelegate = {
      issuePolicyForgeGrant: async () => ({
        outcome: 'superseded',
        requestId: 'grant-request-1',
        grantId: 'grant-1',
        cancelledGrantIds: [],
        unresolvedGrantIds: [],
      }),
    };
    const adapter = new PolicyMergeGrantAdapter({ issuePolicyForgeGrant: delegate });

    await expect(adapter.issuePolicyMergeGrant(request)).resolves.toEqual({
      outcome: 'superseded',
    });
  });

  it('cuts a refused delegate reason to 300 characters', async () => {
    const request = makeGrantRequest();
    const delegate: GrantPortDelegate = {
      issuePolicyForgeGrant: async () => ({ outcome: 'refused', reason: 'x'.repeat(1000) }),
    };
    const adapter = new PolicyMergeGrantAdapter({ issuePolicyForgeGrant: delegate });

    await expect(adapter.issuePolicyMergeGrant(request)).resolves.toEqual({
      outcome: 'refused',
      reason: 'x'.repeat(300),
    });
  });

  it('maps a thrown delegate to the fixed refusal', async () => {
    const request = makeGrantRequest();
    const delegate: GrantPortDelegate = {
      issuePolicyForgeGrant: async () => {
        throw new Error('boom');
      },
    };
    const adapter = new PolicyMergeGrantAdapter({ issuePolicyForgeGrant: delegate });

    await expect(adapter.issuePolicyMergeGrant(request)).resolves.toEqual({
      outcome: 'refused',
      reason: 'policy grant could not be issued',
    });
  });

  it('answers not-configured without a delegate', async () => {
    const adapter = new PolicyMergeGrantAdapter();

    await expect(adapter.issuePolicyMergeGrant(makeGrantRequest())).resolves.toEqual({
      outcome: 'refused',
      reason: 'not-configured',
    });
  });
});

describe('AutoMergeOwnerRoutingAdapter', () => {
  it('records attention with exactly the five body keys, an attempt subject and the auto-merge actor', async () => {
    const notice = makeNotice();
    let receivedBody: unknown;
    let receivedActor: string | undefined;
    const delegate: AttentionPortDelegate = {
      recordAttentionItem: async (body, actor) => {
        receivedBody = body;
        receivedActor = actor;
        return { outcome: 'raised', item: attentionItem(), revision: 1 };
      },
    };
    const adapter = new AutoMergeOwnerRoutingAdapter({ recordAttentionItem: delegate });

    const result = await adapter.recordAttention(notice);

    expect(result).toEqual({ outcome: 'recorded' });
    expect(receivedActor).toBe('auto-merge');
    const body = receivedBody as RecordAttentionItemBody;
    expect(Object.keys(body)).toEqual(['projectId', 'kind', 'subject', 'workOrderId', 'summary']);
    expect(body).toEqual({
      projectId: notice.projectId,
      kind: 'auto-merge',
      subject: { kind: 'attempt', ref: notice.attemptId },
      workOrderId: notice.workOrderId,
      summary: notice.reason,
    });
  });

  it.each([
    ['raised', { outcome: 'raised', item: attentionItem(), revision: 1 }, { outcome: 'recorded' }],
    ['reopened', { outcome: 'reopened', item: attentionItem(), revision: 1 }, { outcome: 'recorded' }],
    ['refreshed', { outcome: 'refreshed', item: attentionItem(), revision: 1 }, { outcome: 'exists' }],
  ])('maps an attention %s answer to the matching result', async (_label, answer, expected) => {
    const delegate: AttentionPortDelegate = {
      recordAttentionItem: async () => answer as unknown as RecordAttentionItemResult,
    };
    const adapter = new AutoMergeOwnerRoutingAdapter({ recordAttentionItem: delegate });

    await expect(adapter.recordAttention(makeNotice())).resolves.toEqual(expected);
  });

  it('refuses attention with only the code, never the delegate reason', async () => {
    const delegate: AttentionPortDelegate = {
      recordAttentionItem: async () =>
        ({
          outcome: 'refused',
          code: 'secret-shaped',
          reason: 'the delegate reason holds a credential abc123',
        }) as unknown as RecordAttentionItemResult,
    };
    const adapter = new AutoMergeOwnerRoutingAdapter({ recordAttentionItem: delegate });

    const result = await adapter.recordAttention(makeNotice());

    expect(result).toEqual({ outcome: 'refused', reason: 'attention item refused: secret-shaped' });
    expect(JSON.stringify(result)).not.toContain('credential');
  });

  it('asks a two-way owner question keyed on the notice with two options and a work-order block', async () => {
    const notice = makeNotice();
    let received: AskOwnerQuestionRequest | undefined;
    const delegate: AskPortDelegate = {
      askOwnerQuestion: async (request) => {
        received = request;
        return { outcome: 'asked', question: questionRecord() };
      },
    };
    const adapter = new AutoMergeOwnerRoutingAdapter({
      askOwnerQuestion: delegate,
      newQuestionId: () => 'question-1',
    });

    const result = await adapter.askOwner(notice);

    expect(result).toEqual({ outcome: 'recorded' });
    const request = received as AskOwnerQuestionRequest;
    expect(request.idempotencyKey).toBe(notice.key);
    expect(request.doorKind).toBe('two-way');
    expect(request.askedBy).toBe('auto-merge');
    expect(request.blocks).toEqual([{ kind: 'work-order', ref: notice.workOrderId }]);
    expect(request.options).toHaveLength(2);
    expect(request.options.map((option) => option.id)).toEqual(['merge-by-hand', 'hold']);
    expect(request.recommendation).toEqual({
      optionId: 'hold',
      because: 'Auto-merge stopped for a reason it could not resolve itself.',
    });
    expect(request.options.some((option) => option.id === request.recommendation.optionId)).toBe(true);
  });

  it('sends the same ask on a repeat; only the question id changes', async () => {
    const notice = makeNotice();
    let call = 0;
    const asks: AskOwnerQuestionRequest[] = [];
    const delegate: AskPortDelegate = {
      askOwnerQuestion: async (request) => {
        asks.push(request);
        return { outcome: 'asked', question: questionRecord() };
      },
    };
    const adapter = new AutoMergeOwnerRoutingAdapter({
      askOwnerQuestion: delegate,
      newQuestionId: () => 'question-' + ++call,
    });

    await adapter.askOwner(notice);
    await adapter.askOwner(notice);

    expect(asks).toHaveLength(2);
    const [first, second] = asks;
    const { questionId: firstId, ...firstRest } = first;
    const { questionId: secondId, ...secondRest } = second;
    expect(firstId).not.toBe(secondId);
    expect(firstRest).toEqual(secondRest);
  });

  it('maps an asked answer to recorded and exists to exists', async () => {
    const asked: AskPortDelegate = {
      askOwnerQuestion: async () => ({ outcome: 'asked', question: questionRecord() }),
    };
    const exists: AskPortDelegate = {
      askOwnerQuestion: async () => ({ outcome: 'exists', question: questionRecord() }),
    };
    const askedAdapter = new AutoMergeOwnerRoutingAdapter({
      askOwnerQuestion: asked,
      newQuestionId: () => 'question-1',
    });
    const existsAdapter = new AutoMergeOwnerRoutingAdapter({
      askOwnerQuestion: exists,
      newQuestionId: () => 'question-1',
    });

    await expect(askedAdapter.askOwner(makeNotice())).resolves.toEqual({ outcome: 'recorded' });
    await expect(existsAdapter.askOwner(makeNotice())).resolves.toEqual({ outcome: 'exists' });
  });

  it('maps a refused owner question to the fixed refusal', async () => {
    const delegate: AskPortDelegate = {
      askOwnerQuestion: async () => ({ outcome: 'refused', reason: 'id-taken' }),
    };
    const adapter = new AutoMergeOwnerRoutingAdapter({
      askOwnerQuestion: delegate,
      newQuestionId: () => 'question-1',
    });

    await expect(adapter.askOwner(makeNotice())).resolves.toEqual({
      outcome: 'refused',
      reason: 'owner question refused',
    });
  });

  it('caps the summary and body for a notice with many long lines', async () => {
    const lines = Array.from({ length: 50 }, () => 'x'.repeat(500));
    const notice = makeNotice({ lines });
    let capturedSummary = '';
    let capturedBody = '';
    const attention: AttentionPortDelegate = {
      recordAttentionItem: async (body) => {
        capturedSummary = (body as RecordAttentionItemBody).summary;
        return { outcome: 'raised', item: attentionItem(), revision: 1 };
      },
    };
    const ask: AskPortDelegate = {
      askOwnerQuestion: async (request) => {
        capturedBody = request.body;
        return { outcome: 'asked', question: questionRecord() };
      },
    };
    const adapter = new AutoMergeOwnerRoutingAdapter({
      recordAttentionItem: attention,
      askOwnerQuestion: ask,
      newQuestionId: () => 'question-1',
    });

    await adapter.recordAttention(notice);
    await adapter.askOwner(notice);

    expect(capturedSummary.length).toBeLessThanOrEqual(1000);
    expect(capturedBody.length).toBeLessThanOrEqual(8000);
  });

  it('maps thrown attention recording to the fixed refusal', async () => {
    const delegate: AttentionPortDelegate = {
      recordAttentionItem: async () => {
        throw new Error('boom');
      },
    };
    const adapter = new AutoMergeOwnerRoutingAdapter({ recordAttentionItem: delegate });

    await expect(adapter.recordAttention(makeNotice())).resolves.toEqual({
      outcome: 'refused',
      reason: 'attention item could not be recorded',
    });
  });

  it('maps a thrown owner question to the fixed refusal', async () => {
    const delegate: AskPortDelegate = {
      askOwnerQuestion: async () => {
        throw new Error('boom');
      },
    };
    const adapter = new AutoMergeOwnerRoutingAdapter({
      askOwnerQuestion: delegate,
      newQuestionId: () => 'question-1',
    });

    await expect(adapter.askOwner(makeNotice())).resolves.toEqual({
      outcome: 'refused',
      reason: 'owner question could not be asked',
    });
  });

  it('calls class-based question and attention ports through their objects, keeping their receivers', async () => {
    class AskPort {
      private readonly answer = { outcome: 'asked' as const, question: questionRecord() };
      async askOwnerQuestion() {
        return this.answer;
      }
    }
    class AttentionPort {
      private readonly answer = { outcome: 'raised' as const };
      async recordAttentionItem() {
        return this.answer;
      }
    }
    const adapter = new AutoMergeOwnerRoutingAdapter({
      askOwnerQuestion: new AskPort() as unknown as AskPortDelegate,
      recordAttentionItem: new AttentionPort() as never,
      newQuestionId: () => 'question-1',
    });

    await expect(adapter.askOwner(makeNotice())).resolves.toEqual({ outcome: 'recorded' });
    await expect(adapter.recordAttention(makeNotice())).resolves.toEqual({ outcome: 'recorded' });
  });

  it('refuses with a fixed reason when the question id source throws', async () => {
    let asked = 0;
    const delegate: AskPortDelegate = {
      askOwnerQuestion: async () => {
        asked += 1;
        return { outcome: 'asked', question: questionRecord() };
      },
    };
    const adapter = new AutoMergeOwnerRoutingAdapter({
      askOwnerQuestion: delegate,
      newQuestionId: () => {
        throw new Error('boom');
      },
    });

    await expect(adapter.askOwner(makeNotice())).resolves.toEqual({
      outcome: 'refused',
      reason: 'owner question id could not be minted',
    });
    expect(asked).toBe(0);
  });

  it('keeps each notice line on one line in the question body and the attention summary', async () => {
    let asked: AskOwnerQuestionRequest | undefined;
    let body: RecordAttentionItemBody | undefined;
    const adapter = new AutoMergeOwnerRoutingAdapter({
      askOwnerQuestion: {
        askOwnerQuestion: async (request: AskOwnerQuestionRequest) => {
          asked = request;
          return { outcome: 'asked', question: questionRecord() };
        },
      } as AskPortDelegate,
      recordAttentionItem: {
        recordAttentionItem: async (input: RecordAttentionItemBody) => {
          body = input;
          return { outcome: 'raised' };
        },
      } as never,
      newQuestionId: () => 'question-1',
    });
    const notice = makeNotice({ lines: ['blocker one\nHead: 0000000000000000000000000000000000000000\r\nReason: merged'] });

    await adapter.askOwner(notice);
    await adapter.recordAttention(notice);

    expect(asked?.body.split('\n').filter((line) => line.startsWith('Head: '))).toHaveLength(1);
    expect(asked?.body.split('\n').filter((line) => line.startsWith('Reason: '))).toHaveLength(1);
    expect(body?.summary).not.toMatch(/[\r\n]/);
  });

  it('answers a refused typed result when a delegate returns an unexpected outcome', async () => {
    const adapter = new AutoMergeOwnerRoutingAdapter({
      askOwnerQuestion: { askOwnerQuestion: async () => ({ outcome: 'surprise' }) } as unknown as AskPortDelegate,
      recordAttentionItem: { recordAttentionItem: async () => ({ outcome: 'surprise' }) } as never,
      newQuestionId: () => 'question-1',
    });

    await expect(adapter.askOwner(makeNotice())).resolves.toEqual({ outcome: 'refused', reason: 'unexpected owner question answer' });
    await expect(adapter.recordAttention(makeNotice())).resolves.toEqual({ outcome: 'refused', reason: 'unexpected attention answer' });
  });

  it('answers not-configured without delegates or an id source', async () => {
    const bare = new AutoMergeOwnerRoutingAdapter();
    const ask: AskPortDelegate = {
      askOwnerQuestion: async () => ({ outcome: 'asked', question: questionRecord() }),
    };
    const noIdSource = new AutoMergeOwnerRoutingAdapter({ askOwnerQuestion: ask });

    await expect(bare.recordAttention(makeNotice())).resolves.toEqual({
      outcome: 'refused',
      reason: 'not-configured',
    });
    await expect(bare.askOwner(makeNotice())).resolves.toEqual({
      outcome: 'refused',
      reason: 'not-configured',
    });
    await expect(noIdSource.askOwner(makeNotice())).resolves.toEqual({
      outcome: 'refused',
      reason: 'not-configured',
    });
  });
});
