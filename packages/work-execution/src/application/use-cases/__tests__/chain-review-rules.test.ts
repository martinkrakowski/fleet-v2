import { describe, expect, it } from 'vitest';
import { REVIEW_REQUEST_ID_PATTERN } from '@fleet/evidence-and-acceptance';

import { telemetryHashInput } from '../../../domain/run-telemetry-ids.js';
import {
  CHAIN_REVIEW_MAX_ATTEMPT_ID_BYTES,
  CHAIN_REVIEW_MAX_LINKS,
  CHAIN_REVIEW_MAX_MODEL_BYTES,
  aggregateLinkReceipts,
  chainReviewKey,
  chainReviewRequestId,
  decideChainReviewStart,
  isBudgetLeft,
  isIndependentReviewer,
  parseChainReviewCommand,
  parseChainReviewCompleteCommand,
} from '../ReviewChainUseCase.use-case.js';
import type { ChainLinkReceiptCandidate, ChainLinkReceiptInput } from '../ReviewChainUseCase.use-case.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const NOW = '2026-11-06T10:00:00.000Z';
const DEADLINE = '2026-11-06T10:05:00.000Z';

function command(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: 'project-1',
    repository: { owner: 'fleet', repo: 'fleet-v2' },
    chainName: 'example',
    headSha: HEAD,
    policyRevision: 'policy-1',
    reviewerModel: 'provider/grok-4.7',
    nowIso: NOW,
    deadlineIso: DEADLINE,
    ...overrides,
  };
}

function receipt(overrides: Record<string, unknown> = {}): ChainLinkReceiptCandidate {
  const id = telemetryHashInput('rr-link-1');
  if (id === null) throw new Error('setup');
  return {
    receiptId: id,
    kind: 'pre-merge',
    result: 'pass',
    findings: { blocker: 0, major: 0, minor: 1, nit: 2 },
    completedAtIso: '2026-11-06T09:00:00.000Z',
    ...overrides,
  } as ChainLinkReceiptCandidate;
}

function link(overrides: Record<string, unknown> = {}): ChainLinkReceiptInput {
  return { pullRequestNumber: 7, attemptId: 'attempt-1', receipts: [receipt()], ...overrides } as ChainLinkReceiptInput;
}

describe('chain review key and request id', () => {
  it('builds exactly chain-review/<name>@<head12>', () => {
    expect(chainReviewKey('example', HEAD)).toBe('chain-review/example@0123456789ab');
    expect(chainReviewKey('a-b-1', HEAD)).toBe('chain-review/a-b-1@0123456789ab');
  });

  it('derives a request id that satisfies the evidence pattern from the chain name and head only', () => {
    const id = chainReviewRequestId('example', HEAD);
    expect(id).toBe('chain-review:example:0123456789ab');
    expect(REVIEW_REQUEST_ID_PATTERN.test(id)).toBe(true);
    expect(chainReviewRequestId('example', HEAD)).toBe(id);
    expect(chainReviewRequestId('example', 'f'.repeat(40))).not.toBe(id);
    expect(chainReviewRequestId('other', HEAD)).not.toBe(id);
  });
});

describe('parseChainReviewCommand', () => {
  it('accepts a well-formed command and freezes the result', () => {
    const parsed = parseChainReviewCommand(command());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.command).toMatchObject({
      projectId: 'project-1', chainName: 'example', branchName: 'chain/example', headSha: HEAD, links: [],
    });
    expect(Object.isFrozen(parsed.command)).toBe(true);
  });

  it('rejects a null request', () => {
    expect(parseChainReviewCommand(null)).toEqual({ ok: false, reason: 'invalid-request' });
    expect(parseChainReviewCommand(undefined)).toEqual({ ok: false, reason: 'invalid-request' });
  });

  it('rejects a non-object request', () => {
    for (const value of ['x', 3, true, () => command(), Symbol('s'), [], [command()]]) {
      expect(parseChainReviewCommand(value)).toEqual({ ok: false, reason: 'invalid-request' });
    }
  });

  it('rejects a missing field', () => {
    for (const field of ['projectId', 'repository', 'chainName', 'headSha', 'policyRevision', 'reviewerModel', 'nowIso', 'deadlineIso']) {
      const input = command();
      delete input[field];
      expect(parseChainReviewCommand(input)).toEqual({ ok: false, reason: 'invalid-request' });
    }
  });

  it('rejects a wrong-typed field', () => {
    const wrong: Record<string, unknown[]> = {
      projectId: [1, null, {}, ''],
      repository: ['fleet/fleet-v2', null, { owner: 'fleet' }, { owner: 1, repo: 2 }],
      chainName: [1, null, '', 'chain/example', 'Example', 'a--b', 'a/b'],
      headSha: [1, null, '', 'abc', HEAD.toUpperCase(), `${HEAD}0`],
      policyRevision: [1, null, '', '   '],
      reviewerModel: [1, null, '', '   ', {}],
      nowIso: [1, null, '', 'now', '2026-11-06T10:00:00', 'yesterday'],
      deadlineIso: [1, null, '', 'soon', '2026-13-45T10:00:00Z'],
    };
    for (const [field, values] of Object.entries(wrong)) {
      for (const value of values) {
        expect(parseChainReviewCommand(command({ [field]: value }))).toEqual({ ok: false, reason: 'invalid-request' });
      }
    }
  });

  it('rejects a sparse links array and a non-array links value', () => {
    const sparse = new Array(2);
    sparse[1] = { pullRequestNumber: 1, attemptId: 'attempt-1' };
    expect(parseChainReviewCommand(command({ links: sparse }))).toEqual({ ok: false, reason: 'invalid-request' });
    expect(parseChainReviewCommand(command({ links: 'x' }))).toEqual({ ok: false, reason: 'invalid-request' });
    expect(parseChainReviewCommand(command({ links: { length: 0 } }))).toEqual({ ok: false, reason: 'invalid-request' });
    expect(parseChainReviewCommand(command({ links: [{ pullRequestNumber: 0, attemptId: 'a' }] }))).toEqual({
      ok: false, reason: 'invalid-request',
    });
    expect(parseChainReviewCommand(command({ links: [{ pullRequestNumber: 1 }] }))).toEqual({ ok: false, reason: 'invalid-request' });
    expect(parseChainReviewCommand(command({ links: [{ pullRequestNumber: 1, attemptId: 'attempt-1' }] })).ok).toBe(true);
  });

  it('rejects an unknown subject kind', () => {
    expect(parseChainReviewCommand(command({ subjectKind: 'attempt' }))).toEqual({ ok: false, reason: 'invalid-request' });
    expect(parseChainReviewCommand(command({ subjectKind: 'brief' }))).toEqual({ ok: false, reason: 'invalid-request' });
    expect(parseChainReviewCommand(command({ subjectKind: 'galaxy' }))).toEqual({ ok: false, reason: 'invalid-request' });
    expect(parseChainReviewCommand(command({ subjectKind: 'chain' })).ok).toBe(true);
  });

  it('rejects a throwing getter without invoking it', () => {
    let ran = false;
    const input = command();
    Object.defineProperty(input, 'reviewerModel', {
      enumerable: true,
      get() {
        ran = true;
        return 'provider/grok-4.7';
      },
    });
    expect(parseChainReviewCommand(input)).toEqual({ ok: false, reason: 'invalid-request' });
    expect(ran).toBe(false);
    const proxy = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error('trap ran');
      },
    });
    expect(parseChainReviewCommand(proxy)).toEqual({ ok: false, reason: 'invalid-request' });
    const throwingLinks = command({ links: [{ get pullRequestNumber(): number { throw new Error('getter ran'); }, attemptId: 'a' }] });
    expect(parseChainReviewCommand(throwingLinks)).toEqual({ ok: false, reason: 'invalid-request' });
  });

  it('a secret-shaped input is refused with a fixed code', () => {
    // Assembled at run time so no token-shaped literal sits in the file.
    const secret = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
    for (const field of ['policyRevision', 'reviewerModel']) {
      const parsed = parseChainReviewCommand(command({ [field]: secret }));
      expect(parsed).toEqual({ ok: false, reason: 'invalid-request' });
      expect(JSON.stringify(parsed)).not.toContain('ghp_');
    }
    expect(parseChainReviewCommand(command({ links: [{ pullRequestNumber: 1, attemptId: secret }] }))).toEqual({
      ok: false, reason: 'invalid-request',
    });
    expect(parseChainReviewCommand(command({ projectId: secret }))).toEqual({ ok: false, reason: 'invalid-request' });
  });

  it('bounds the chain name, the link count and the model names', () => {
    expect(parseChainReviewCommand(command({ chainName: 'a'.repeat(201) }))).toEqual({ ok: false, reason: 'invalid-request' });
    // A valid chain name too long for the 128-character request id is refused, never truncated.
    expect(parseChainReviewCommand(command({ chainName: 'a'.repeat(103) }))).toEqual({ ok: false, reason: 'invalid-request' });
    expect(parseChainReviewCommand(command({ chainName: 'a'.repeat(100) })).ok).toBe(true);
    expect(REVIEW_REQUEST_ID_PATTERN.test(chainReviewRequestId('a'.repeat(100), HEAD))).toBe(true);

    const fifty = Array.from({ length: CHAIN_REVIEW_MAX_LINKS }, (_, i) => ({ pullRequestNumber: i + 1, attemptId: `attempt-${i}` }));
    expect(parseChainReviewCommand(command({ links: fifty })).ok).toBe(true);
    expect(parseChainReviewCommand(command({ links: [...fifty, { pullRequestNumber: 99, attemptId: 'attempt-x' }] }))).toEqual({
      ok: false, reason: 'invalid-request',
    });
    expect(
      parseChainReviewCommand(command({ links: [{ pullRequestNumber: 1, attemptId: 'a'.repeat(CHAIN_REVIEW_MAX_ATTEMPT_ID_BYTES + 1) }] })),
    ).toEqual({ ok: false, reason: 'invalid-request' });
    expect(
      parseChainReviewCommand(command({ links: [{ pullRequestNumber: 1, attemptId: 'a'.repeat(CHAIN_REVIEW_MAX_ATTEMPT_ID_BYTES) }] })).ok,
    ).toBe(true);

    expect(parseChainReviewCommand(command({ reviewerModel: 'm'.repeat(CHAIN_REVIEW_MAX_MODEL_BYTES + 1) }))).toEqual({
      ok: false, reason: 'invalid-request',
    });
    expect(parseChainReviewCommand(command({ reviewerModel: 'm'.repeat(CHAIN_REVIEW_MAX_MODEL_BYTES) })).ok).toBe(true);
    // The bound is in bytes, not characters.
    expect(parseChainReviewCommand(command({ reviewerModel: 'é'.repeat(101) }))).toEqual({ ok: false, reason: 'invalid-request' });
  });
});

describe('parseChainReviewCompleteCommand', () => {
  const complete = (overrides: Record<string, unknown> = {}) => ({
    projectId: 'project-1',
    repository: { owner: 'fleet', repo: 'fleet-v2' },
    chainName: 'example',
    requestId: chainReviewRequestId('example', HEAD),
    nowIso: NOW,
    deadlineIso: DEADLINE,
    ...overrides,
  });

  it('accepts a well-formed command and rejects the rest with a fixed code', () => {
    expect(parseChainReviewCompleteCommand(complete()).ok).toBe(true);
    for (const bad of [null, 'x', [], complete({ requestId: 'has space' }), complete({ requestId: '' }), complete({ requestId: 3 }),
      complete({ chainName: 'Bad' }), complete({ nowIso: 'now' }), complete({ repository: null })]) {
      expect(parseChainReviewCompleteCommand(bad)).toEqual({ ok: false, reason: 'invalid-request' });
    }
  });
});

describe('isIndependentReviewer', () => {
  it('refuses the same model', () => {
    expect(isIndependentReviewer('provider/glm-5.3', ['provider/glm-5.3'])).toBe(false);
  });

  it('refuses the same family under another provider, tier or variant', () => {
    expect(isIndependentReviewer('nvidia/z-ai/glm-5.3-flash', ['openrouter/z-ai/glm-5.3'])).toBe(false);
    expect(isIndependentReviewer('claude-sonnet-4-5#high', ['anthropic/claude-3-5-sonnet-20241022'])).toBe(false);
  });

  it('accepts a different family', () => {
    expect(isIndependentReviewer('provider/grok-4.7', ['provider/glm-5.3'])).toBe(true);
    expect(isIndependentReviewer('provider/grok-4.7', ['provider/glm-5.3', 'provider/claude-sonnet-4-5'])).toBe(true);
  });

  it('refuses when any one implementer shares the reviewer family', () => {
    expect(isIndependentReviewer('provider/grok-4.7', ['provider/glm-5.3', 'other/grok-code-fast-4.7'])).toBe(false);
  });

  it('treats an empty implementer list and unusable names as unknown, not independent', () => {
    expect(isIndependentReviewer('provider/grok-4.7', [])).toBe(false);
    expect(isIndependentReviewer('', ['provider/glm-5.3'])).toBe(false);
    expect(isIndependentReviewer('provider/grok-4.7', [''])).toBe(false);
    expect(isIndependentReviewer('4o-mini', ['provider/glm-5.3'])).toBe(false);
    expect(isIndependentReviewer('provider/grok-4.7', ['z-ai/'])).toBe(false);
    expect(isIndependentReviewer('provider/grok-4.7', 'glm' as never)).toBe(false);
    expect(isIndependentReviewer(null as never, ['provider/glm-5.3'])).toBe(false);
  });

  it('never throws on a sparse list or a throwing getter', () => {
    const sparse = new Array(1) as string[];
    expect(isIndependentReviewer('provider/grok-4.7', sparse)).toBe(false);
    const list = ['provider/glm-5.3'];
    Object.defineProperty(list, '0', { get() { throw new Error('getter ran'); } });
    expect(isIndependentReviewer('provider/grok-4.7', list)).toBe(false);
  });
});

describe('isBudgetLeft', () => {
  it('is true only strictly before the deadline and false for an invalid instant', () => {
    expect(isBudgetLeft(NOW, DEADLINE)).toBe(true);
    expect(isBudgetLeft(DEADLINE, DEADLINE)).toBe(false);
    expect(isBudgetLeft('2026-11-06T10:06:00.000Z', DEADLINE)).toBe(false);
    expect(isBudgetLeft('now', DEADLINE)).toBe(false);
    expect(isBudgetLeft(NOW, undefined as never)).toBe(false);
  });
});

describe('decideChainReviewStart', () => {
  const facts = (overrides: Record<string, unknown> = {}) => ({
    chainName: 'example', headSha: HEAD, reviewerModel: 'provider/grok-4.7',
    links: [{ settled: true }], openPullRequests: 0, implementerModels: ['provider/glm-5.3'], ...overrides,
  }) as Parameters<typeof decideChainReviewStart>[0];

  it('proceeds with the key and the pinned head when every gate passes', () => {
    expect(decideChainReviewStart(facts())).toEqual({
      outcome: 'proceed', key: 'chain-review/example@0123456789ab', requestId: 'chain-review:example:0123456789ab', headSha: HEAD,
    });
  });

  it('runs the gates in order', () => {
    expect(decideChainReviewStart(facts({ links: 'unreadable' }))).toEqual({ outcome: 'unknown', reason: 'store-unavailable' });
    expect(decideChainReviewStart(facts({ links: [{ settled: true }, { settled: false }], openPullRequests: 'unreadable' }))).toEqual({
      outcome: 'refused', reason: 'link-unsettled',
    });
    expect(decideChainReviewStart(facts({ openPullRequests: 'unreadable' }))).toEqual({ outcome: 'unknown', reason: 'forge-unavailable' });
    expect(decideChainReviewStart(facts({ openPullRequests: 'skipped' }))).toEqual({ outcome: 'unknown', reason: 'forge-unavailable' });
    expect(decideChainReviewStart(facts({ openPullRequests: 2, implementerModels: null }))).toEqual({
      outcome: 'refused', reason: 'integration-pr-open',
    });
    expect(decideChainReviewStart(facts({ implementerModels: null }))).toEqual({ outcome: 'refused', reason: 'implementer-models-unknown' });
    expect(decideChainReviewStart(facts({ implementerModels: [] }))).toEqual({ outcome: 'refused', reason: 'implementer-models-unknown' });
    expect(decideChainReviewStart(facts({ reviewerModel: 'other/glm-5.2' }))).toEqual({
      outcome: 'refused', reason: 'reviewer-not-independent',
    });
  });

  it('never proceeds on a malformed count and never throws', () => {
    for (const openPullRequests of [-1, 1.5, Number.NaN, 'x']) {
      expect(decideChainReviewStart(facts({ openPullRequests })).outcome).not.toBe('proceed');
    }
    expect(decideChainReviewStart(null as never).outcome).toBe('unknown');
  });
});

describe('aggregateLinkReceipts', () => {
  it('projects each link to its own pre-merge receipt, keeping the receipt id as the hash input', () => {
    const source = receipt();
    const aggregated = aggregateLinkReceipts([link({ receipts: [source] })]);
    expect(aggregated.ok).toBe(true);
    if (!aggregated.ok) return;
    const [only] = aggregated.links;
    expect(only.receiptId).toBe(source.receiptId);
    expect(only).toMatchObject({
      pullRequestNumber: 7, attemptId: 'attempt-1', result: 'pass', kind: 'pre-merge',
      findings: { blocker: 0, major: 0, minor: 1, nit: 2 }, completedAtIso: '2026-11-06T09:00:00.000Z',
    });
    expect(JSON.stringify(only)).toContain('"receiptId":{}');
    expect(Object.keys(only).sort()).toEqual(
      ['attemptId', 'completedAtIso', 'findings', 'kind', 'pullRequestNumber', 'receiptId', 'result'],
    );
    expect(Object.isFrozen(only)).toBe(true);
  });

  it('returns a frozen success result', () => {
    const aggregated = aggregateLinkReceipts([link({ receipts: [receipt()] })]);
    expect(aggregated.ok).toBe(true);
    expect(Object.isFrozen(aggregated)).toBe(true);
  });

  it('picks the latest pre-merge receipt and ignores receipts of other kinds', () => {
    const older = receipt({ result: 'fail', completedAtIso: '2026-11-06T08:00:00.000Z' });
    const newer = receipt({ result: 'pass', completedAtIso: '2026-11-06T09:30:00.000Z' });
    const other = receipt({ kind: 'code-review', result: 'fail', completedAtIso: '2026-11-06T10:00:00.000Z' });
    const aggregated = aggregateLinkReceipts([link({ receipts: [newer, older, other] })]);
    expect(aggregated.ok && aggregated.links[0].result).toBe('pass');
  });

  it('a link with no receipt, or only receipts of another kind, is never a pass', () => {
    expect(aggregateLinkReceipts([link({ receipts: [] })])).toEqual({ ok: false, reason: 'link-receipt-missing' });
    expect(aggregateLinkReceipts([link({ receipts: [receipt({ kind: 'code-review' })] })])).toEqual({
      ok: false, reason: 'link-receipt-missing',
    });
    expect(aggregateLinkReceipts([link(), link({ receipts: [] })])).toEqual({ ok: false, reason: 'link-receipt-missing' });
    expect(aggregateLinkReceipts([])).toEqual({ ok: false, reason: 'link-receipt-missing' });
  });

  it('reports a failed receipt as a fail and an unknown verdict as verdict-unknown', () => {
    const failed = aggregateLinkReceipts([link({ receipts: [receipt({ result: 'fail' })] })]);
    expect(failed.ok && failed.links[0].result).toBe('fail');
    for (const result of ['pending', 'unknown', 'not-applicable', 'galaxy', undefined]) {
      expect(aggregateLinkReceipts([link({ receipts: [receipt({ result })] })])).toEqual({ ok: false, reason: 'verdict-unknown' });
    }
  });

  it('never throws on malformed input', () => {
    for (const bad of [null, 'x', [null], [{}], [link({ attemptId: 5 })], [link({ pullRequestNumber: 0 })], [link({ receipts: 'x' })],
      [link({ receipts: [receipt({ findings: { blocker: -1, major: 0, minor: 0, nit: 0 } })] })],
      [link({ receipts: [receipt({ receiptId: 'rr-raw' })] })]]) {
      const result = aggregateLinkReceipts(bad as never);
      expect(result.ok).toBe(false);
    }
    const tooMany = Array.from({ length: CHAIN_REVIEW_MAX_LINKS + 1 }, () => link());
    expect(aggregateLinkReceipts(tooMany).ok).toBe(false);
  });
});
