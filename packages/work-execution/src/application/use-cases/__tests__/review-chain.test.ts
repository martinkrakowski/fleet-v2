import { describe, expect, it } from 'vitest';

import {
  applyChainOutcome,
  applyChainReviewPin,
  createChainRecord,
  reviewPinOf,
} from '../../../domain/chain-records.js';
import type { ChainRecord } from '../../../domain/chain-records.js';
import { telemetryHashInput } from '../../../domain/run-telemetry-ids.js';
import { REVIEW_CHAIN_REASONS } from '../../ports/in/ReviewChainPort.in-port.js';
import type { ReviewChainCompleteResult, ReviewChainStartResult } from '../../ports/in/ReviewChainPort.in-port.js';
import type { ReadReceiptsForHeadResult, ReviewReceiptProjection } from '../../ports/out/AcceptanceReceiptReadPort.out-port.js';
import type {
  ChainRecordRead,
  ChainRepositoryPort,
  ChainReviewPinCommand,
  ChainReviewPinDecision,
} from '../../ports/out/ChainRepositoryPort.out-port.js';
import type { ListOpenPullRequestsByBaseResult } from '../../ports/out/ForgeReadPort.out-port.js';
import type { MergeBranchHeadResult } from '../../ports/out/MergeForgeActionPort.out-port.js';
import type {
  FindReviewReceiptResult,
  ReviewReceiptSummary,
  ReviewRequest,
  ReviewRequestResult,
} from '../../ports/out/ReviewRequestPort.out-port.js';
import { ReviewChainUseCase } from '../ReviewChainUseCase.use-case.js';

const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';
const TIP = 'fedcba9876543210fedcba9876543210fedcba98';
const MOVED = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REPO = { owner: 'fleet', repo: 'fleet-v2' };
const NOW = '2026-11-06T10:00:00.000Z';
const DEADLINE = '2026-11-06T10:05:00.000Z';
const CHAIN = 'example';
const KEY = `chain-review/${CHAIN}@${TIP.slice(0, 12)}`;
const REQUEST_ID = `chain-review:${CHAIN}:${TIP.slice(0, 12)}`;
const IMPLEMENTER = 'provider/glm-5.3';
const REVIEWER = 'provider/grok-4.7';
const LEAK = '/home/someone/secret-worktree REVIEWER SAID: rewrite everything';

function startCommand(overrides: Record<string, unknown> = {}): never {
  return {
    projectId: 'project-1', repository: REPO, chainName: CHAIN, chainHeadSha: TIP, policyRevision: 'policy-1',
    reviewerModel: REVIEWER, nowIso: NOW, deadlineIso: DEADLINE, ...overrides,
  } as never;
}

function completeCommand(overrides: Record<string, unknown> = {}): never {
  return {
    projectId: 'project-1', repository: REPO, chainName: CHAIN, requestId: REQUEST_ID, nowIso: NOW, deadlineIso: DEADLINE,
    ...overrides,
  } as never;
}

function startedRecord(): ChainRecord {
  const created = createChainRecord({
    repository: REPO, chainName: CHAIN, expectedHeadSha: BASE_SHA, actionKey: 'chain-start-1', createdAtIso: NOW,
  });
  if (!created.ok) throw new Error('setup');
  return applyChainOutcome(created.record, { state: 'started', reason: null });
}

function pinnedRecord(): ChainRecord {
  return applyChainReviewPin(startedRecord(), { headSha: TIP, requestId: REQUEST_ID, key: KEY, pinnedAtIso: NOW }, NOW);
}

interface Link {
  readonly runId: string;
  readonly pr: number | null;
  readonly attemptId: string;
  readonly model: string | null;
  readonly completed: boolean;
  readonly head: string;
  readonly queue: readonly string[];
}

function link(overrides: Partial<Link> = {}): Link {
  return {
    runId: 'run-1', pr: 11, attemptId: 'attempt-1', model: IMPLEMENTER, completed: true,
    head: '1'.repeat(40), queue: ['merged'], ...overrides,
  };
}

function reviewProjection(overrides: Partial<ReviewReceiptProjection> = {}): ReviewReceiptProjection {
  const id = telemetryHashInput('link-receipt-1');
  if (id === null) throw new Error('setup');
  return {
    receiptId: id, kind: 'pre-merge', result: 'pass', findings: { blocker: 0, major: 0, minor: 0, nit: 0 },
    completedAtIso: '2026-11-06T09:00:00.000Z', ...overrides,
  };
}

function summary(overrides: Partial<ReviewReceiptSummary> = {}): ReviewReceiptSummary {
  return {
    receiptId: 'rr-chain-1', requestId: REQUEST_ID, kind: 'pre-merge', reviewerModel: REVIEWER, candidateHeadSha: TIP,
    verdict: 'passed',
    findings: [{ findingId: 'f-1', severity: 'major', summary: LEAK, filePath: '/home/someone/secret.ts', line: 3 }],
    ...overrides,
  };
}

interface Script {
  record?: ChainRecord | null;
  read?: ChainRecordRead | 'throw';
  tip?: MergeBranchHeadResult | 'throw';
  links?: readonly Link[];
  listRuns?: 'throw';
  listQueue?: 'throw';
  attemptThrows?: boolean;
  open?: ListOpenPullRequestsByBaseResult | 'throw';
  onList?: () => void;
  pin?: ChainReviewPinDecision | 'throw';
  review?: ReviewRequestResult | 'throw';
  find?: FindReviewReceiptResult | 'throw';
  linkReceipts?: Record<string, ReadReceiptsForHeadResult | 'throw'>;
  clock?: () => string;
}

function harness(script: Script = {}) {
  const calls: string[] = [];
  const pins: ChainReviewPinCommand[] = [];
  const reviews: ReviewRequest[] = [];
  const finds: unknown[] = [];
  const state = { record: script.record === undefined ? startedRecord() : script.record, pinRecordedCount: 0 };
  const links = script.links ?? [link()];
  const receiptReads: string[] = [];
  const listTimeouts: (number | undefined)[] = [];

  const chains: ChainRepositoryPort = {
    async readChain() {
      calls.push('read-chain');
      if (script.read === 'throw') throw new Error(LEAK);
      if (script.read !== undefined) return script.read;
      return state.record === null ? { status: 'not-found' } : { status: 'ok', record: state.record };
    },
    async recordChainIntent() {
      throw new Error('not used');
    },
    async recordChainOutcome() {
      throw new Error('not used');
    },
    async recordChainReviewPin(command: ChainReviewPinCommand) {
            calls.push('pin');
            pins.push(command);
            if (script.pin === 'throw') throw new Error(LEAK);
            if (script.pin !== undefined) return script.pin;
            const current = state.record;
            if (current === null) return { outcome: 'refused', reason: 'chain-not-found' } as const;
            const stored = reviewPinOf(current);
            if (stored !== null) {
              return stored.key === command.pin.key && stored.headSha === command.pin.headSha
                ? ({ outcome: 'already-recorded' } as const)
                : ({ outcome: 'refused', reason: 'chain-record-stale' } as const);
            }
            if (current.revision !== command.expectedRevision) return { outcome: 'refused', reason: 'chain-record-stale' } as const;
            state.record = applyChainReviewPin(current, command.pin, command.pin.pinnedAtIso);
            state.pinRecordedCount += 1;
            return { outcome: 'recorded' } as const;
    },
  };

  const useCase = new ReviewChainUseCase({
    chains,
    forge: {
      isConfigured: () => true,
      async readPullRequest() {
        throw new Error('not used');
      },
      async listOpenPullRequestsByBase(request) {
        calls.push('list-open');
        listTimeouts.push(request.timeoutMs);
        script.onList?.();
        if (script.open === 'throw') throw new Error(LEAK);
        return script.open === undefined ? { outcome: 'listed', pullRequests: [] } : script.open;
      },
    },
    branches: {
      async readMergeBranchHead() {
        calls.push('read-tip');
        if (script.tip === 'throw') throw new Error(LEAK);
        return script.tip ?? { outcome: 'found', headSha: TIP };
      },
    },
    reviews: {
      async requestReview(request) {
        calls.push('request-review');
        reviews.push(request);
        if (script.review === 'throw') throw new Error(LEAK);
        return script.review ?? { outcome: 'receipt', receipt: summary() };
      },
      async findReviewReceipt(request) {
        calls.push('find-receipt');
        finds.push(request);
        if (script.find === 'throw') throw new Error(LEAK);
        return script.find ?? { outcome: 'found', receipt: summary() };
      },
      async findLatestReceiptOfKind() {
        throw new Error('not used');
      },
    },
    receipts: {
      async readReceiptsForHead(attemptId) {
        calls.push('read-link-receipts');
        receiptReads.push(attemptId);
        const scripted = script.linkReceipts?.[attemptId];
        if (scripted === 'throw') throw new Error(LEAK);
        return scripted ?? { outcome: 'found', verification: [], review: [reviewProjection()] };
      },
    },
    laneRuns: {
      async list() {
        calls.push('list-runs');
        if (script.listRuns === 'throw') throw new Error(LEAK);
        return [
          ...links.map((entry) => ({
            runId: entry.runId, workOrderId: 'wo-1', prNumber: entry.pr, attemptIds: [entry.attemptId], baseBranch: `chain/${CHAIN}`,
          })),
          // A run against main is not a link of this chain.
          { runId: 'run-main', workOrderId: 'wo-2', prNumber: 99, attemptIds: ['attempt-main'], baseBranch: 'main' },
        ] as never;
      },
    },
    attempts: {
      async findAttemptById(attemptId) {
        calls.push('find-attempt');
        if (script.attemptThrows === true) throw new Error(LEAK);
        const entry = links.find((candidate) => candidate.attemptId === attemptId);
        if (entry === undefined) return null;
        return {
          id: entry.attemptId, workOrderId: 'wo-1',
          seatSelection: entry.model === null ? null : { role: 'implement', seatIndex: 0, seatId: 's', model: entry.model, tool: null, variant: null, agent: null },
          completionReceipt: entry.completed ? { attemptId: entry.attemptId, sessionId: 's', endedAtIso: NOW, authoritative: true, exitStatus: 0, stoppedByRequest: false } : null,
          artifacts: { headCommit: entry.head, commitsSinceBase: [], collectedArtifactPaths: [], notes: 'present' },
        } as never;
      },
    },
    mergeQueue: {
      async listMergeEntries() {
        calls.push('list-queue');
        if (script.listQueue === 'throw') throw new Error(LEAK);
        return links.flatMap((entry) =>
          entry.pr === null ? [] : entry.queue.map((state, index) => ({ entryId: `e-${entry.pr}-${index}`, pullRequest: entry.pr, state })),
        ) as never;
      },
    },
    ...(script.clock !== undefined ? { clock: script.clock } : {}),
  });
  return { useCase, calls, pins, reviews, finds, state, receiptReads, listTimeouts };
}

function assertFixedCodes(result: unknown): void {
  const text = JSON.stringify(result);
  expect(text).not.toContain('/home/someone');
  expect(text).not.toContain('REVIEWER SAID');
  expect(text).not.toContain('secret');
  expect(text).not.toContain('rewrite everything');
  const reason = (result as { reason?: string }).reason;
  if (reason !== undefined) expect((REVIEW_CHAIN_REASONS as readonly string[]).includes(reason)).toBe(true);
}

describe('start: input and budget', () => {
  it('returns invalid-request for a null command', async () => {
    const { useCase, calls } = harness();
    expect(await useCase.startChainReview(null as never)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(await useCase.completeChainReview(null as never)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(calls).toEqual([]);
  });

  it('returns invalid-request for malformed fields and refuses without a clock or nowIso', async () => {
    const { useCase, calls } = harness();
    for (const bad of [{ chainName: 'Bad/Name' }, { chainHeadSha: 'abc' }, { reviewerModel: 3 }, { nowIso: 'now' }, { projectId: undefined }]) {
      expect(await useCase.startChainReview(startCommand(bad))).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
    expect(await useCase.startChainReview(startCommand({ nowIso: undefined, deadlineIso: undefined }))).toEqual({
      outcome: 'refused', reason: 'invalid-request',
    });
    expect(calls).toEqual([]);
  });

  it('uses the injected clock only when the command has no nowIso, and derives the deadline from it', async () => {
    const { useCase, pins } = harness({ clock: () => NOW });
    const result = await useCase.startChainReview(startCommand({ nowIso: undefined, deadlineIso: undefined }));
    expect(result.outcome).toBe('started');
    expect(pins[0].pin.pinnedAtIso).toBe(NOW);
    expect(Date.parse(pins[0].deadlineIso)).toBeGreaterThan(Date.parse(NOW));
  });

  it('a spent budget refuses with budget-exhausted before any call', async () => {
    const { useCase, calls } = harness();
    expect(await useCase.startChainReview(startCommand({ deadlineIso: NOW }))).toEqual({ outcome: 'refused', reason: 'budget-exhausted' });
    expect(await useCase.completeChainReview(completeCommand({ deadlineIso: '2026-11-06T09:00:00.000Z' }))).toEqual({
      outcome: 'refused', reason: 'budget-exhausted',
    });
    expect(calls).toEqual([]);
  });

  it('passes the open-PR read a timeout derived from the deadline, and refuses budget-exhausted when the read ends past it', async () => {
    let now = NOW;
    const slow = harness({ clock: () => now, onList: () => { now = '2026-11-06T10:06:00.000Z'; } });
    expect(await slow.useCase.startChainReview(startCommand())).toEqual({ outcome: 'refused', reason: 'budget-exhausted' });
    expect(slow.listTimeouts).toEqual([5 * 60 * 1000]);
    expect(slow.pins).toHaveLength(0);
    expect(slow.reviews).toHaveLength(0);
  });

  it('refuses before the forge call when the clock runs out between steps', async () => {
    const instants = [NOW, NOW, '2026-11-06T10:06:00.000Z'];
    let at = 0;
    const { useCase, calls } = harness({ clock: () => instants[Math.min(at++, instants.length - 1)] });
    const result = await useCase.startChainReview(startCommand());
    expect(result).toEqual({ outcome: 'refused', reason: 'budget-exhausted' });
    expect(calls).not.toContain('request-review');
  });
});

describe('start refuses while a link is queued or in progress', () => {
  it.each([
    ['queued', { queue: ['queued'] }],
    ['updating', { queue: ['updating'] }],
    ['awaiting-checks', { queue: ['awaiting-checks'] }],
    ['ready', { queue: ['ready'] }],
    ['verifying', { queue: ['verifying'] }],
    ['vetoing', { queue: ['vetoing'] }],
    ['merging', { queue: ['merging'] }],
    ['parked', { queue: ['parked'] }],
    ['a retry still queued next to a merged entry', { queue: ['merged', 'queued'] }],
    ['dropped only', { queue: ['dropped'] }],
    ['no merge-queue entry at all', { queue: [] }],
    ['no collected completion receipt', { completed: false }],
    ['no pull request yet', { pr: null }],
  ] as const)('link-unsettled: %s', async (_name, overrides) => {
    const { useCase, calls, pins } = harness({ links: [link(), link({ runId: 'run-2', attemptId: 'attempt-2', pr: 12, ...overrides })] });
    const result = await useCase.startChainReview(startCommand());
    expect(result).toEqual({ outcome: 'refused', reason: 'link-unsettled' });
    expect(calls).not.toContain('list-open');
    expect(calls).not.toContain('request-review');
    expect(pins).toHaveLength(0);
  });

  it('too-many-links: 51 settled links refuse before any pin or review; 50 proceed', async () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) => link({ runId: `run-${i}`, attemptId: `attempt-${i}`, pr: 100 + i }));
    const over = harness({ links: many(51) });
    expect(await over.useCase.startChainReview(startCommand())).toEqual({ outcome: 'refused', reason: 'too-many-links' });
    expect(over.calls).not.toContain('list-open');
    expect(over.calls).not.toContain('request-review');
    expect(over.pins).toHaveLength(0);
    expect(over.reviews).toHaveLength(0);
    const at = harness({ links: many(50) });
    expect((await at.useCase.startChainReview(startCommand())).outcome).toBe('started');
  });

  it('treats a merged entry next to a dropped or superseded one as settled', async () => {
    const { useCase } = harness({ links: [link({ queue: ['superseded', 'dropped', 'merged'] })] });
    expect((await useCase.startChainReview(startCommand())).outcome).toBe('started');
  });
});

describe('start refuses while a pull request against chain/<name> is open', () => {
  it('integration-pr-open, listing by the chain base and never pinning', async () => {
    const { useCase, calls, pins } = harness({
      open: { outcome: 'listed', pullRequests: [{ number: 40, headSha: TIP, baseRef: `chain/${CHAIN}` }] },
    });
    expect(await useCase.startChainReview(startCommand())).toEqual({ outcome: 'refused', reason: 'integration-pr-open' });
    expect(pins).toHaveLength(0);
    expect(calls).not.toContain('request-review');
  });
});

describe('start refuses when the forge or the chain record cannot be read', () => {
  it('reports unknown with forge-unavailable for an unavailable list and a throw', async () => {
    for (const open of [{ outcome: 'unavailable', reason: 'gh api pulls failed (exit 1)' } as const, 'throw'] as const) {
      const { useCase, pins } = harness({ open });
      const result = await useCase.startChainReview(startCommand());
      expect(result).toEqual({ outcome: 'unknown', reason: 'forge-unavailable' });
      expect(pins).toHaveLength(0);
    }
  });

  it('reports unknown with chain-unreadable for an unreadable or throwing record read and never pins', async () => {
    for (const read of [{ status: 'unreadable', reason: 'record-too-large' } as const, 'throw'] as const) {
      const { useCase, calls } = harness({ read });
      expect(await useCase.startChainReview(startCommand())).toEqual({ outcome: 'unknown', reason: 'chain-unreadable' });
      expect(calls).toEqual(['read-chain']);
    }
  });

  it('reports a record for another chain or repository as chain-unreadable', async () => {
    const other = createChainRecord({ repository: REPO, chainName: 'other', expectedHeadSha: BASE_SHA, actionKey: 'k', createdAtIso: NOW });
    if (!other.ok) throw new Error('setup');
    const { useCase } = harness({ read: { status: 'ok', record: other.record } });
    expect(await useCase.startChainReview(startCommand())).toEqual({ outcome: 'unknown', reason: 'chain-unreadable' });
  });

  it('refuses chain-not-found for an unknown chain, an unstarted chain and a missing branch', async () => {
    expect(await harness({ record: null }).useCase.startChainReview(startCommand())).toEqual({ outcome: 'refused', reason: 'chain-not-found' });
    const created = createChainRecord({ repository: REPO, chainName: CHAIN, expectedHeadSha: BASE_SHA, actionKey: 'k', createdAtIso: NOW });
    if (!created.ok) throw new Error('setup');
    expect(await harness({ record: created.record }).useCase.startChainReview(startCommand())).toEqual({
      outcome: 'refused', reason: 'chain-not-found',
    });
    expect(await harness({ tip: { outcome: 'not-found' } }).useCase.startChainReview(startCommand())).toEqual({
      outcome: 'refused', reason: 'chain-not-found',
    });
  });

  it('reports an unreadable tip as unknown with forge-unavailable, never a guess', async () => {
    for (const tip of [{ outcome: 'unavailable', reason: 'x' } as const, 'throw', { outcome: 'found', headSha: 'nope' } as const] as const) {
      const { useCase, pins } = harness({ tip });
      expect(await useCase.startChainReview(startCommand())).toEqual({ outcome: 'unknown', reason: 'forge-unavailable' });
      expect(pins).toHaveLength(0);
    }
  });

  it('reports unreadable links as unknown with store-unavailable and never reads the forge', async () => {
    for (const script of [{ listRuns: 'throw' }, { listQueue: 'throw' }, { attemptThrows: true }] as const) {
      const { useCase, calls } = harness(script);
      expect(await useCase.startChainReview(startCommand())).toEqual({ outcome: 'unknown', reason: 'store-unavailable' });
      expect(calls).not.toContain('list-open');
    }
  });

  it('an unreadable store is unknown and never a pass', async () => {
    const { useCase } = harness({ pin: 'throw' });
    const result = await useCase.startChainReview(startCommand());
    expect(result).toEqual({ outcome: 'unknown', reason: 'store-unavailable' });
  });

  it('refuses chain-tip-moved when the branch is no longer at the commanded head', async () => {
    const { useCase, pins } = harness({ tip: { outcome: 'found', headSha: MOVED } });
    expect(await useCase.startChainReview(startCommand())).toEqual({ outcome: 'refused', reason: 'chain-tip-moved' });
    expect(pins).toHaveLength(0);
  });
});

describe('start pins the tip by CAS and requests exactly one pre-merge review on the chain subject', () => {
  it('pins at the record revision under the key and requests one review with the chain subject', async () => {
    const { useCase, pins, reviews, state, calls } = harness();
    const result = await useCase.startChainReview(startCommand());
    expect(result).toEqual({ outcome: 'started', requestId: REQUEST_ID, key: KEY, headSha: TIP, reviewerModel: REVIEWER });
    expect(pins).toEqual([
      {
        repository: REPO, chainName: CHAIN, expectedRevision: 2,
        pin: { headSha: TIP, requestId: REQUEST_ID, key: KEY, pinnedAtIso: NOW }, deadlineIso: DEADLINE,
      },
    ]);
    expect(state.record && reviewPinOf(state.record)).toMatchObject({ headSha: TIP, key: KEY });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      requestId: REQUEST_ID, kind: 'pre-merge', projectId: 'project-1', candidateHeadSha: TIP, policyRevision: 'policy-1',
      implementerModel: IMPLEMENTER, reviewerModel: REVIEWER,
      subject: { kind: 'chain', projectId: 'project-1', chainName: CHAIN, integrationHeadSha: TIP },
    });
    expect(reviews[0].diffSummary).toBe(`Combined review of chain ${CHAIN} against main at ${TIP.slice(0, 12)}`);
    expect(calls.indexOf('pin')).toBeLessThan(calls.indexOf('request-review'));
    expect(calls.indexOf('list-open')).toBeLessThan(calls.indexOf('pin'));
  });

  it('names the model the receipt records as the reviewer', async () => {
    const { useCase } = harness({ review: { outcome: 'receipt', receipt: summary({ reviewerModel: 'provider/grok-4.8' }) } });
    const result = await useCase.startChainReview(startCommand());
    expect(result).toMatchObject({ outcome: 'started', reviewerModel: 'provider/grok-4.8' });
  });

  it('retries a stale CAS once after re-reading the record, then refuses chain-record-stale', async () => {
    let attempts = 0;
    const h = harness();
    const original = h.state.record as ChainRecord;
    // A concurrent writer advanced the record after our read: the first CAS is stale, the retry lands.
    const chains = (h.useCase as unknown as { deps: { chains: ChainRepositoryPort } }).deps.chains;
    const realPin = chains.recordChainReviewPin as (c: ChainReviewPinCommand) => Promise<ChainReviewPinDecision>;
    chains.recordChainReviewPin = async (command) => {
      attempts += 1;
      if (attempts === 1) {
        h.state.record = { ...original, revision: original.revision + 1 };
        return { outcome: 'refused', reason: 'chain-record-stale' };
      }
      return realPin(command);
    };
    const result = await h.useCase.startChainReview(startCommand());
    expect(result.outcome).toBe('started');
    expect(attempts).toBe(2);
    expect(h.pins.map((p) => p.expectedRevision)).toEqual([3]);

    const always = harness({ pin: { outcome: 'refused', reason: 'chain-record-stale' } });
    expect(await always.useCase.startChainReview(startCommand())).toEqual({ outcome: 'refused', reason: 'chain-record-stale' });
    expect(always.pins).toHaveLength(2);
    expect(always.reviews).toHaveLength(0);
  });

  it('refuses a stored pin of another head as chain-record-stale and never requests a review', async () => {
    const other = applyChainReviewPin(startedRecord(), { headSha: MOVED, requestId: 'chain-review:example:aaaaaaaaaaaa', key: `chain-review/${CHAIN}@${MOVED.slice(0, 12)}`, pinnedAtIso: NOW }, NOW);
    const { useCase, reviews } = harness({ record: other });
    expect(await useCase.startChainReview(startCommand())).toEqual({ outcome: 'refused', reason: 'chain-record-stale' });
    expect(reviews).toHaveLength(0);
  });

  it('maps a pin refusal that is not a stale record to store-unavailable and an unreadable one to chain-unreadable', async () => {
    expect(await harness({ pin: { outcome: 'refused', reason: 'store-busy' } }).useCase.startChainReview(startCommand())).toEqual({
      outcome: 'unknown', reason: 'store-unavailable',
    });
    expect(await harness({ pin: { outcome: 'refused', reason: 'chain-unreadable' } }).useCase.startChainReview(startCommand())).toEqual({
      outcome: 'unknown', reason: 'chain-unreadable',
    });
  });
});

describe('start refuses a reviewer that wrote the chain code', () => {
  it('reviewer-not-independent for a reviewer of the implementer family, whatever the provider', async () => {
    for (const reviewerModel of [IMPLEMENTER, 'other-provider/glm-5.2', 'nvidia/z-ai/glm-5.3-flash#high']) {
      const { useCase, pins, reviews } = harness({ links: [link(), link({ runId: 'run-2', attemptId: 'attempt-2', pr: 12, model: 'provider/claude-sonnet-4-5' })] });
      expect(await useCase.startChainReview(startCommand({ reviewerModel }))).toEqual({
        outcome: 'refused', reason: 'reviewer-not-independent',
      });
      expect(pins).toHaveLength(0);
      expect(reviews).toHaveLength(0);
    }
  });

  it('refuses when only the second link used the reviewer family', async () => {
    const { useCase } = harness({ links: [link(), link({ runId: 'run-2', attemptId: 'attempt-2', pr: 12, model: 'other/grok-code-fast-4.7' })] });
    expect(await useCase.startChainReview(startCommand())).toEqual({ outcome: 'refused', reason: 'reviewer-not-independent' });
  });

  it('implementer-models-unknown for an attempt without a model and for a chain with no link', async () => {
    const unknownModel = harness({ links: [link({ model: null })] });
    expect(await unknownModel.useCase.startChainReview(startCommand())).toEqual({ outcome: 'refused', reason: 'implementer-models-unknown' });
    const noLinks = harness({ links: [] });
    expect(await noLinks.useCase.startChainReview(startCommand())).toEqual({ outcome: 'refused', reason: 'implementer-models-unknown' });
    expect(unknownModel.pins).toHaveLength(0);
    expect(noLinks.reviews).toHaveLength(0);
  });
});

describe('start is idempotent under the key', () => {
  it('a repeated start returns already-recorded from the CAS and requests no second review', async () => {
    const h = harness();
    const first = await h.useCase.startChainReview(startCommand());
    const second = await h.useCase.startChainReview(startCommand());
    expect(second).toEqual(first);
    expect(h.state.pinRecordedCount).toBe(1);
    expect(h.pins).toHaveLength(2);
    expect(h.reviews).toHaveLength(1);
  });

  it('a cut-short review leaves the pin so the next pass completes', async () => {
    const script: Script = { review: 'throw' };
    const h = harness(script);
    expect(await h.useCase.startChainReview(startCommand())).toEqual({ outcome: 'unknown', reason: 'review-unknown' });
    expect(h.state.record && reviewPinOf(h.state.record)?.key).toBe(KEY);
    // The next pass: the pin is already recorded, no receipt exists yet, so the one review runs now.
    script.review = undefined;
    script.find = { outcome: 'not-found' };
    const next = await h.useCase.startChainReview(startCommand());
    expect(next).toMatchObject({ outcome: 'started', requestId: REQUEST_ID });
    expect(h.state.pinRecordedCount).toBe(1);
    expect(h.reviews).toHaveLength(2);
  });

  it('a repeat after a recorded receipt asks for the receipt first and never runs a review', async () => {
    const h = harness({ record: pinnedRecord(), find: { outcome: 'found', receipt: summary() } });
    const result = await h.useCase.startChainReview(startCommand());
    expect(result).toMatchObject({ outcome: 'started', requestId: REQUEST_ID, headSha: TIP });
    expect(h.reviews).toHaveLength(0);
    expect(h.finds).toHaveLength(1);
  });
});

describe('start maps the review outcome', () => {
  it('no receipt is review-no-receipt, a refusal carries its mapped reason and unknown is review-unknown', async () => {
    const noReceipt = harness({ review: { outcome: 'no-receipt', reason: 'review-unavailable', detail: 'transport-failed' } });
    expect(await noReceipt.useCase.startChainReview(startCommand())).toEqual({ outcome: 'refused', reason: 'review-no-receipt' });
    const cases: [string, string][] = [
      ['invalid-request', 'invalid-request'],
      ['not-configured', 'review-not-configured'],
      ['not-independent', 'reviewer-not-independent'],
      ['subject-not-implemented', 'subject-not-implemented'],
      ['seat-refused', 'review-refused'],
      ['assessment-mismatch', 'review-refused'],
      ['request-id-reused', 'review-refused'],
      ['unclassified', 'review-refused'],
    ];
    for (const [port, mapped] of cases) {
      const h = harness({ review: { outcome: 'refused', reason: port as never, detail: LEAK } });
      const result = await h.useCase.startChainReview(startCommand());
      expect(result).toEqual({ outcome: 'refused', reason: mapped });
      assertFixedCodes(result);
    }
    const unknown = harness({ review: { outcome: 'unknown', reason: 'delegate-failed' } });
    expect(await unknown.useCase.startChainReview(startCommand())).toEqual({ outcome: 'unknown', reason: 'review-unknown' });
  });
});

describe('complete', () => {
  function pinned(script: Script = {}) {
    return harness({ record: pinnedRecord(), ...script });
  }

  it('refuses when the tip moved past the pin (chain-tip-moved) and reads no receipt', async () => {
    const h = pinned({ tip: { outcome: 'found', headSha: MOVED } });
    expect(await h.useCase.completeChainReview(completeCommand())).toEqual({ outcome: 'refused', reason: 'chain-tip-moved' });
    expect(h.finds).toHaveLength(0);
  });

  it('returns the receipt id, reviewer model and verdict with each link\'s own pre-merge receipt', async () => {
    const h = pinned({
      links: [link(), link({ runId: 'run-2', attemptId: 'attempt-2', pr: 12 })],
      linkReceipts: {
        'attempt-1': { outcome: 'found', verification: [], review: [reviewProjection({ findings: { blocker: 0, major: 1, minor: 2, nit: 3 } })] },
        'attempt-2': { outcome: 'found', verification: [], review: [reviewProjection()] },
      },
    });
    const result = (await h.useCase.completeChainReview(completeCommand())) as Extract<ReviewChainCompleteResult, { outcome: 'completed' }>;
    expect(result.outcome).toBe('completed');
    expect(result).toMatchObject({ requestId: REQUEST_ID, receiptId: 'rr-chain-1', reviewerModel: REVIEWER, verdict: 'passed' });
    expect(result.links.map((entry) => [entry.pullRequestNumber, entry.attemptId, entry.result, entry.kind])).toEqual([
      [11, 'attempt-1', 'pass', 'pre-merge'],
      [12, 'attempt-2', 'pass', 'pre-merge'],
    ]);
    expect(result.links[0].findings).toEqual({ blocker: 0, major: 1, minor: 2, nit: 3 });
    expect(h.receiptReads).toEqual(['attempt-1', 'attempt-2']);
    expect(h.finds[0]).toMatchObject({
      requestId: REQUEST_ID, candidateHeadSha: TIP, subject: { kind: 'chain', chainName: CHAIN, integrationHeadSha: TIP },
    });
    // ids and codes only: no finding text of the chain review crosses.
    assertFixedCodes(result);
    expect(Object.keys(result).sort()).toEqual(['links', 'outcome', 'receiptId', 'requestId', 'reviewerModel', 'verdict']);
  });

  it('a failed chain verdict, or a failed link, is a failed verdict, never a pass', async () => {
    const chainFailed = pinned({ find: { outcome: 'found', receipt: summary({ verdict: 'failed' }) } });
    expect(await chainFailed.useCase.completeChainReview(completeCommand())).toMatchObject({ outcome: 'completed', verdict: 'failed' });
    const linkFailed = pinned({
      linkReceipts: { 'attempt-1': { outcome: 'found', verification: [], review: [reviewProjection({ result: 'fail' })] } },
    });
    const result = await linkFailed.useCase.completeChainReview(completeCommand());
    expect(result).toMatchObject({ outcome: 'completed', verdict: 'failed' });
    expect(result.outcome === 'completed' && result.links[0].result).toBe('fail');
  });

  it('refuses link-receipt-missing when a link has no receipt, only another kind, or none to read', async () => {
    const none = pinned({ linkReceipts: { 'attempt-1': { outcome: 'none' } } });
    expect(await none.useCase.completeChainReview(completeCommand())).toEqual({ outcome: 'refused', reason: 'link-receipt-missing' });
    const otherKind = pinned({
      linkReceipts: { 'attempt-1': { outcome: 'found', verification: [], review: [reviewProjection({ kind: 'code-review' })] } },
    });
    expect(await otherKind.useCase.completeChainReview(completeCommand())).toEqual({ outcome: 'refused', reason: 'link-receipt-missing' });
    const empty = pinned({ linkReceipts: { 'attempt-1': { outcome: 'found', verification: [], review: [] } } });
    expect(await empty.useCase.completeChainReview(completeCommand())).toEqual({ outcome: 'refused', reason: 'link-receipt-missing' });
    const noLinks = pinned({ links: [] });
    expect(await noLinks.useCase.completeChainReview(completeCommand())).toEqual({ outcome: 'refused', reason: 'link-receipt-missing' });
  });

  it('refuses link-unsettled when a link is no longer settled', async () => {
    const h = pinned({ links: [link({ queue: ['queued'] })] });
    expect(await h.useCase.completeChainReview(completeCommand())).toEqual({ outcome: 'refused', reason: 'link-unsettled' });
  });

  it('an unknown verdict is never a pass', async () => {
    for (const find of [
      { outcome: 'found', receipt: summary({ verdict: 'unknown' }) } as const,
      { outcome: 'found', receipt: summary({ kind: 'code-review' }) } as const,
      { outcome: 'found', receipt: summary({ candidateHeadSha: MOVED }) } as const,
      { outcome: 'unavailable', reason: 'receipt-mismatch' } as const,
    ]) {
      const h = pinned({ find });
      expect(await h.useCase.completeChainReview(completeCommand())).toEqual({ outcome: 'unknown', reason: 'verdict-unknown' });
    }
    const linkUnknown = pinned({
      linkReceipts: { 'attempt-1': { outcome: 'found', verification: [], review: [reviewProjection({ result: 'unknown' })] } },
    });
    expect(await linkUnknown.useCase.completeChainReview(completeCommand())).toEqual({ outcome: 'unknown', reason: 'verdict-unknown' });
  });

  it('no receipt is never a pass: not-found and an absent or other pin are receipt-missing', async () => {
    const notFound = pinned({ find: { outcome: 'not-found' } });
    expect(await notFound.useCase.completeChainReview(completeCommand())).toEqual({ outcome: 'refused', reason: 'receipt-missing' });
    const noPin = harness();
    expect(await noPin.useCase.completeChainReview(completeCommand())).toEqual({ outcome: 'refused', reason: 'receipt-missing' });
    expect(noPin.finds).toHaveLength(0);
    const otherRequest = pinned();
    expect(await otherRequest.useCase.completeChainReview(completeCommand({ requestId: 'chain-review:example:bbbbbbbbbbbb' }))).toEqual({
      outcome: 'refused', reason: 'receipt-missing',
    });
  });

  it('an unreadable store is unknown and never a pass', async () => {
    const cases: [Script, string][] = [
      [{ find: { outcome: 'unavailable', reason: 'unreadable' } }, 'store-unavailable'],
      [{ find: 'throw' }, 'store-unavailable'],
      [{ linkReceipts: { 'attempt-1': { outcome: 'unavailable', reason: 'evidence-unreadable' } } }, 'store-unavailable'],
      [{ linkReceipts: { 'attempt-1': 'throw' } }, 'store-unavailable'],
      [{ listRuns: 'throw' }, 'store-unavailable'],
      [{ listQueue: 'throw' }, 'store-unavailable'],
      [{ read: 'throw' }, 'chain-unreadable'],
      [{ read: { status: 'unreadable', reason: 'x' } }, 'chain-unreadable'],
      [{ tip: 'throw' }, 'forge-unavailable'],
    ];
    for (const [script, reason] of cases) {
      const h = pinned(script);
      const result = await h.useCase.completeChainReview(completeCommand());
      expect(result).toEqual({ outcome: 'unknown', reason });
    }
    expect(await pinned({ find: { outcome: 'unavailable', reason: 'not-configured' } }).useCase.completeChainReview(completeCommand())).toEqual({
      outcome: 'refused', reason: 'review-not-configured',
    });
  });

  it('refuses chain-not-found for an unknown chain and invalid-request for a malformed command', async () => {
    expect(await harness({ record: null }).useCase.completeChainReview(completeCommand())).toEqual({ outcome: 'refused', reason: 'chain-not-found' });
    for (const bad of [{ requestId: 'has space' }, { chainName: 'Bad' }, { nowIso: 'x' }]) {
      expect(await pinned().useCase.completeChainReview(completeCommand(bad))).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    }
  });
});

describe('every refusal carries a fixed code and no path, diff or reviewer text', () => {
  it('holds across every start and complete scenario that touches hostile text', async () => {
    const results: unknown[] = [];
    const starts: Script[] = [
      { read: 'throw' }, { tip: 'throw' }, { listRuns: 'throw' }, { listQueue: 'throw' }, { attemptThrows: true }, { open: 'throw' },
      { pin: 'throw' }, { review: 'throw' }, { review: { outcome: 'refused', reason: 'seat-refused', detail: LEAK } },
      { review: { outcome: 'no-receipt', reason: 'review-unavailable', detail: LEAK } },
      { open: { outcome: 'unavailable', reason: LEAK } }, { tip: { outcome: 'unavailable', reason: LEAK } },
      { read: { status: 'unreadable', reason: LEAK } },
    ];
    for (const script of starts) results.push(await harness(script).useCase.startChainReview(startCommand()));
    const completes: Script[] = [
      { find: 'throw' }, { find: { outcome: 'found', receipt: summary({ verdict: 'unknown' }) } }, { tip: 'throw' }, { read: 'throw' },
      { linkReceipts: { 'attempt-1': 'throw' } }, { linkReceipts: { 'attempt-1': { outcome: 'none' } } },
      { find: { outcome: 'unavailable', reason: LEAK as never } },
    ];
    for (const script of completes) results.push(await harness({ record: pinnedRecord(), ...script }).useCase.completeChainReview(completeCommand()));
    for (const result of results) {
      assertFixedCodes(result);
      expect((result as { outcome: string }).outcome).not.toBe('started');
      expect((result as { outcome: string }).outcome).not.toBe('completed');
    }
    expect(results.length).toBe(starts.length + completes.length);
  });

  it('a started result and a completed result carry ids and codes only', async () => {
    const started = (await harness().useCase.startChainReview(startCommand())) as ReviewChainStartResult;
    assertFixedCodes(started);
    expect(Object.keys(started).sort()).toEqual(['headSha', 'key', 'outcome', 'requestId', 'reviewerModel']);
  });
});
