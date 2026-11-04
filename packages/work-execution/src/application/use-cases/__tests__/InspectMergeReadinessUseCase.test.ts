// Lane CO25: the read-only merge readiness check for one pull request.
import { describe, expect, it } from 'vitest';

import type {
  ForgeMergeReadPort,
  ReadForgeMergeRequest,
  ReadForgeMergeResult,
} from '../../ports/out/ForgeMergeReadPort.out-port.js';
import type {
  InspectMergeReadinessRequest,
  InspectMergeReadinessResult,
} from '../../ports/in/InspectMergeReadinessPort.in-port.js';
import { InspectMergeReadinessUseCase } from '../InspectMergeReadinessUseCase.use-case.js';

const NOW_ISO = '2026-11-04T00:00:00.000Z';
const DEADLINE_ISO = '2026-11-04T00:01:00.000Z';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const OTHER_HEAD = '0123456789abcdef0123456789abcdef01234568';
const REPO = { owner: 'fleet', repo: 'v2' };

const baseRequest: InspectMergeReadinessRequest = {
  repository: REPO,
  pullRequest: 202,
  expectedHeadOid: null,
  requiredContexts: ['gate'],
  deadlineIso: DEADLINE_ISO,
};

function okResult(
  overrides: Partial<Extract<ReadForgeMergeResult, { outcome: 'ok' }>> = {},
): ReadForgeMergeResult {
  return {
    outcome: 'ok',
    prState: 'open',
    liveHeadSha: HEAD,
    mergeState: 'clean',
    contexts: [context('gate', 'SUCCESS')],
    unresolvedThreads: 0,
    ...overrides,
  };
}

function context(name: string, state: string) {
  return { name, state, isGreen: state === 'SUCCESS', creatorLogin: null };
}

class FakeForgeMergeReadPort implements ForgeMergeReadPort {
  calls: Array<{ request: ReadForgeMergeRequest }> = [];

  constructor(
    private readonly result: () => ReadForgeMergeResult,
    private readonly configured = true,
  ) {}

  isConfigured(): boolean {
    return this.configured;
  }

  async readForgeMerge(request: ReadForgeMergeRequest): Promise<ReadForgeMergeResult> {
    this.calls.push({ request });
    return this.result();
  }
}

function makeUseCase(port: ForgeMergeReadPort): InspectMergeReadinessUseCase {
  return new InspectMergeReadinessUseCase({
    mergeRead: port,
    nowIso: () => NOW_ISO,
  });
}

describe('InspectMergeReadinessUseCase', () => {
  it('ready for an open PR, one SUCCESS context, zero unresolved threads, mergeState clean', async () => {
    const port = new FakeForgeMergeReadPort(() =>
      okResult({ contexts: [context('gate', 'SUCCESS')] }),
    );
    const useCase = makeUseCase(port);

    await expect(useCase.inspectMergeReadiness(baseRequest)).resolves.toEqual({
      outcome: 'ready',
      headOid: HEAD,
    });
  });

  it('still-waiting / not-open for a merged pull request', async () => {
    const port = new FakeForgeMergeReadPort(() => okResult({ prState: 'merged' }));
    const useCase = makeUseCase(port);

    await expect(useCase.inspectMergeReadiness(baseRequest)).resolves.toEqual({
      outcome: 'still-waiting',
      reason: 'not-open',
    });
  });

  it('still-waiting / head-moved when the live head differs; ready when it matches', async () => {
    const moved = makeUseCase(
      new FakeForgeMergeReadPort(() => okResult({ liveHeadSha: OTHER_HEAD })),
    );
    await expect(
      moved.inspectMergeReadiness({ ...baseRequest, expectedHeadOid: HEAD }),
    ).resolves.toEqual({ outcome: 'still-waiting', reason: 'head-moved' });

    const matched = makeUseCase(
      new FakeForgeMergeReadPort(() => okResult({ liveHeadSha: HEAD })),
    );
    await expect(
      matched.inspectMergeReadiness({ ...baseRequest, expectedHeadOid: HEAD }),
    ).resolves.toEqual({ outcome: 'ready', headOid: HEAD });
  });

  it('still-waiting / checks-pending for an IN_PROGRESS context', async () => {
    const port = new FakeForgeMergeReadPort(() =>
      okResult({ contexts: [context('gate', 'IN_PROGRESS')] }),
    );
    const useCase = makeUseCase(port);

    await expect(useCase.inspectMergeReadiness(baseRequest)).resolves.toEqual({
      outcome: 'still-waiting',
      reason: 'checks-pending',
    });
  });

  it('still-waiting / checks-missing for a missing context', async () => {
    const port = new FakeForgeMergeReadPort(() => okResult({ contexts: [] }));
    const useCase = makeUseCase(port);

    await expect(useCase.inspectMergeReadiness(baseRequest)).resolves.toEqual({
      outcome: 'still-waiting',
      reason: 'checks-missing',
    });
  });

  it('still-waiting / checks-failed for a FAILURE context', async () => {
    const port = new FakeForgeMergeReadPort(() =>
      okResult({ contexts: [context('gate', 'FAILURE')] }),
    );
    const useCase = makeUseCase(port);

    await expect(useCase.inspectMergeReadiness(baseRequest)).resolves.toEqual({
      outcome: 'still-waiting',
      reason: 'checks-failed',
    });
  });

  it('unknown / contexts-unknown for a state token outside the known sets', async () => {
    const port = new FakeForgeMergeReadPort(() =>
      okResult({ contexts: [context('gate', 'WEIRD')] }),
    );
    const useCase = makeUseCase(port);

    await expect(useCase.inspectMergeReadiness(baseRequest)).resolves.toEqual({
      outcome: 'unknown',
      reason: 'contexts-unknown',
    });
  });

  it('still-waiting / threads-unresolved for one unresolved thread; unknown / threads-unknown when the count is unknown', async () => {
    const unresolved = makeUseCase(
      new FakeForgeMergeReadPort(() => okResult({ unresolvedThreads: 1 })),
    );
    await expect(unresolved.inspectMergeReadiness(baseRequest)).resolves.toEqual({
      outcome: 'still-waiting',
      reason: 'threads-unresolved',
    });

    const unknown = makeUseCase(
      new FakeForgeMergeReadPort(() => okResult({ unresolvedThreads: 'unknown' })),
    );
    await expect(unknown.inspectMergeReadiness(baseRequest)).resolves.toEqual({
      outcome: 'unknown',
      reason: 'threads-unknown',
    });
  });

  it('still-waiting / not-mergeable for behind; unknown / merge-state-unknown for unknown', async () => {
    const behind = makeUseCase(
      new FakeForgeMergeReadPort(() => okResult({ mergeState: 'behind' })),
    );
    await expect(behind.inspectMergeReadiness(baseRequest)).resolves.toEqual({
      outcome: 'still-waiting',
      reason: 'not-mergeable',
    });

    const unknown = makeUseCase(
      new FakeForgeMergeReadPort(() => okResult({ mergeState: 'unknown' })),
    );
    await expect(unknown.inspectMergeReadiness(baseRequest)).resolves.toEqual({
      outcome: 'unknown',
      reason: 'merge-state-unknown',
    });
  });

  it('unknown / forge-not-configured when unconfigured and the read is never called', async () => {
    const port = new FakeForgeMergeReadPort(() => okResult(), false);
    const useCase = makeUseCase(port);

    await expect(useCase.inspectMergeReadiness(baseRequest)).resolves.toEqual({
      outcome: 'unknown',
      reason: 'forge-not-configured',
    });
    expect(port.calls).toHaveLength(0);
  });

  it('unknown for the three read failure outcomes', async () => {
    const notFound = makeUseCase(new FakeForgeMergeReadPort(() => ({ outcome: 'not-found' })));
    await expect(notFound.inspectMergeReadiness(baseRequest)).resolves.toEqual({
      outcome: 'unknown',
      reason: 'pr-not-found',
    });

    const budget = makeUseCase(
      new FakeForgeMergeReadPort(() => ({ outcome: 'budget-exhausted' })),
    );
    await expect(budget.inspectMergeReadiness(baseRequest)).resolves.toEqual({
      outcome: 'unknown',
      reason: 'budget-exhausted',
    });

    const unavailable = makeUseCase(
      new FakeForgeMergeReadPort(() => ({
        outcome: 'unavailable',
        code: 'forge-error',
        reason: 'gh api graphql failed (exit 1)',
      })),
    );
    await expect(unavailable.inspectMergeReadiness(baseRequest)).resolves.toEqual({
      outcome: 'unknown',
      reason: 'forge-unavailable',
    });
  });

  it('unknown / invalid-request for a malformed repository and a pull request below 1', async () => {
    const port = new FakeForgeMergeReadPort(() => okResult());
    const useCase = makeUseCase(port);

    await expect(
      useCase.inspectMergeReadiness({ ...baseRequest, repository: { owner: '.', repo: 'v2' } }),
    ).resolves.toEqual({ outcome: 'unknown', reason: 'invalid-request' });

    await expect(
      useCase.inspectMergeReadiness({ ...baseRequest, pullRequest: 0 }),
    ).resolves.toEqual({ outcome: 'unknown', reason: 'invalid-request' });

    expect(port.calls).toHaveLength(0);
  });

  it('calls the port exactly once with the expected request and no posterLogin', async () => {
    const port = new FakeForgeMergeReadPort(() => okResult({ contexts: [context('gate', 'SUCCESS')] }));
    const useCase = makeUseCase(port);

    const result: InspectMergeReadinessResult = await useCase.inspectMergeReadiness(baseRequest);
    expect(result).toEqual({ outcome: 'ready', headOid: HEAD });
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0].request).toEqual({
      repository: REPO,
      pullRequestNumber: 202,
      headSha: '',
      requiredContexts: ['gate'],
      nowIso: NOW_ISO,
      deadlineIso: DEADLINE_ISO,
    });
    expect('posterLogin' in port.calls[0].request).toBe(false);
  });
});
