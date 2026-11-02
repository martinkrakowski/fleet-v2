// Delegate adapter tests for DT6b: MergeGrantAdapter routes the attempt-bound
// variant to the issuePolicyForgeGrant delegate exactly as PolicyMergeGrantAdapter
// does today, and the attempt-less variant to the issueMergeGrant delegate. The
// fakes are object-literal recordings; nothing here touches a store, a forge, a
// process or the network.

import { describe, expect, it } from 'vitest';

import type {
  IssueMergeGrantPort,
  IssueMergeGrantRequest,
  IssuePolicyForgeGrantPort,
  IssuePolicyForgeGrantRequest,
  IssuePolicyForgeGrantResult,
} from '@fleet/operator-coordination';

import { MergeGrantAdapter } from '../MergeGrantAdapter.adapter.js';
import type { MergeGrantRequest } from '../../../application/ports/out/MergeGrantPort.out-port.js';

type PolicyDelegate = Pick<IssuePolicyForgeGrantPort, 'issuePolicyForgeGrant'>;
type MergeDelegate = Pick<IssueMergeGrantPort, 'issueMergeGrant'>;
type AttemptBound = Extract<MergeGrantRequest, { kind: 'attempt-bound' }>;
type AttemptLess = Extract<MergeGrantRequest, { kind: 'attempt-less' }>;

const HEAD_ONE = '1111111111111111111111111111111111111111';
const DEADLINE = '2026-11-02T00:00:00.000Z';

function makeAttemptBoundRequest(overrides: Partial<AttemptBound> = {}): AttemptBound {
  return {
    kind: 'attempt-bound',
    projectId: 'project-example-1',
    repository: { owner: 'fleet', repo: 'fleet-v2' },
    pullRequestNumber: 101,
    expectedHeadSha: HEAD_ONE,
    settingRevision: '111111111111',
    deadlineIso: DEADLINE,
    workOrderId: 'work-order-example-1',
    attemptId: 'attempt-example-1',
    policyRevision: 'policy-revision-1',
    acceptanceReceiptId: 'receipt-1',
    ...overrides,
  };
}

function makeAttemptLessRequest(overrides: Partial<AttemptLess> = {}): AttemptLess {
  return {
    kind: 'attempt-less',
    projectId: 'project-example-1',
    repository: { owner: 'fleet', repo: 'fleet-v2' },
    pullRequestNumber: 101,
    expectedHeadSha: HEAD_ONE,
    settingRevision: '111111111111',
    deadlineIso: DEADLINE,
    forgeKind: 'merge-pr',
    ...overrides,
  };
}

function grantedPolicyAnswer(
  request: AttemptBound,
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

describe('MergeGrantAdapter', () => {
  it('routes an attempt-bound request to the issuePolicyForgeGrant delegate unchanged and maps issued', async () => {
    const request = makeAttemptBoundRequest();
    let received: IssuePolicyForgeGrantRequest | undefined;
    const delegate: PolicyDelegate = {
      issuePolicyForgeGrant: async (req) => {
        received = req;
        return grantedPolicyAnswer(request);
      },
    };
    const adapter = new MergeGrantAdapter({ issuePolicyForgeGrant: delegate });

    const result = await adapter.issueMergeGrant(request);

    expect(received).toEqual({
      projectId: 'project-example-1',
      workOrderId: 'work-order-example-1',
      attemptId: 'attempt-example-1',
      forgeKind: 'merge-pr',
      expectedHeadSha: HEAD_ONE,
      policyRevision: 'policy-revision-1',
      acceptanceReceiptId: 'receipt-1',
      source: 'autoMerge',
      settingRevision: '111111111111',
    });
    expect(result).toEqual({
      outcome: 'issued',
      requestId: 'grant-request-1',
      grantId: 'grant-1',
      decisionRevision: 'policy:autoMerge@111111111111',
      cancelledGrantIds: [],
    });
  });

  it('routes an attempt-less request to the issueMergeGrant delegate and surfaces the policy:merge decision revision', async () => {
    const request = makeAttemptLessRequest();
    let received: IssueMergeGrantRequest | undefined;
    const delegate: MergeDelegate = {
      issueMergeGrant: async (req) => {
        received = req;
        return {
          outcome: 'issued',
          requestId: 'grant-request-2',
          grantId: 'grant-2',
          decisionRevision: 'policy:merge@111111111111',
          cancelledGrantIds: [],
        };
      },
    };
    const adapter = new MergeGrantAdapter({ issueMergeGrant: delegate });

    const result = await adapter.issueMergeGrant(request);

    expect(received).toEqual({
      projectId: 'project-example-1',
      repository: { owner: 'fleet', repo: 'fleet-v2' },
      pullRequestNumber: 101,
      expectedHeadSha: HEAD_ONE,
      forgeKind: 'merge-pr',
      settingRevision: '111111111111',
      deadlineIso: DEADLINE,
    });
    expect(result).toEqual({
      outcome: 'issued',
      requestId: 'grant-request-2',
      grantId: 'grant-2',
      decisionRevision: 'policy:merge@111111111111',
      cancelledGrantIds: [],
    });
  });

  it('answers not-configured when the delegate for the request kind is missing', async () => {
    const attemptBoundOnly = new MergeGrantAdapter({
      issueMergeGrant: { issueMergeGrant: async () => ({ outcome: 'refused' as const, reason: '' }) },
    });
    await expect(attemptBoundOnly.issueMergeGrant(makeAttemptBoundRequest())).resolves.toEqual({
      outcome: 'refused',
      reason: 'not-configured',
    });

    const attemptLessOnly = new MergeGrantAdapter({
      issuePolicyForgeGrant: {
        issuePolicyForgeGrant: async () => ({ outcome: 'refused' as const, reason: '' }),
      },
    });
    await expect(attemptLessOnly.issueMergeGrant(makeAttemptLessRequest())).resolves.toEqual({
      outcome: 'refused',
      reason: 'not-configured',
    });

    const bare = new MergeGrantAdapter();
    await expect(bare.issueMergeGrant(makeAttemptLessRequest())).resolves.toEqual({
      outcome: 'refused',
      reason: 'not-configured',
    });
  });

  it('maps a throwing delegate to a fixed refusal, never a throw', async () => {
    const attemptLess = new MergeGrantAdapter({
      issueMergeGrant: {
        issueMergeGrant: async () => {
          throw new Error('boom');
        },
      },
    });
    await expect(attemptLess.issueMergeGrant(makeAttemptLessRequest())).resolves.toEqual({
      outcome: 'refused',
      reason: 'merge grant could not be issued',
    });

    const attemptBound = new MergeGrantAdapter({
      issuePolicyForgeGrant: {
        issuePolicyForgeGrant: async () => {
          throw new Error('boom');
        },
      },
    });
    await expect(attemptBound.issueMergeGrant(makeAttemptBoundRequest())).resolves.toEqual({
      outcome: 'refused',
      reason: 'policy grant could not be issued',
    });
  });

  it('refuses issued with coordinates that do not match the attempt-bound request', async () => {
    const request = makeAttemptBoundRequest();
    const adapter = new MergeGrantAdapter({
      issuePolicyForgeGrant: {
        issuePolicyForgeGrant: async () => grantedPolicyAnswer(request, { workOrderId: 'other-wo' }),
      },
    });
    await expect(adapter.issueMergeGrant(request)).resolves.toEqual({
      outcome: 'refused',
      reason: 'policy grant coordinates do not match the request',
    });
  });

  it('maps superseded through both variants', async () => {
    const attemptLess = new MergeGrantAdapter({
      issueMergeGrant: {
        issueMergeGrant: async () => ({
          outcome: 'superseded',
          requestId: 'r',
          grantId: 'g',
          cancelledGrantIds: ['g'],
          unresolvedGrantIds: [],
        }),
      },
    });
    await expect(attemptLess.issueMergeGrant(makeAttemptLessRequest())).resolves.toEqual({
      outcome: 'superseded',
      requestId: 'r',
      grantId: 'g',
      cancelledGrantIds: ['g'],
      unresolvedGrantIds: [],
    });

    const attemptBound = new MergeGrantAdapter({
      issuePolicyForgeGrant: {
        issuePolicyForgeGrant: async () => ({
          outcome: 'superseded',
          requestId: 'r',
          grantId: 'g',
          cancelledGrantIds: [],
          unresolvedGrantIds: ['g'],
        }),
      },
    });
    await expect(attemptBound.issueMergeGrant(makeAttemptBoundRequest())).resolves.toEqual({
      outcome: 'superseded',
      requestId: 'r',
      grantId: 'g',
      cancelledGrantIds: [],
      unresolvedGrantIds: ['g'],
    });
  });

  it('cuts a refused delegate reason to 300 characters', async () => {
    const adapter = new MergeGrantAdapter({
      issueMergeGrant: {
        issueMergeGrant: async () => ({ outcome: 'refused', reason: 'x'.repeat(1000) }),
      },
    });
    await expect(adapter.issueMergeGrant(makeAttemptLessRequest())).resolves.toEqual({
      outcome: 'refused',
      reason: 'x'.repeat(300),
    });
  });
});
