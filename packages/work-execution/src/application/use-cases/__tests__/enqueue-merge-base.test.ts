// CO3: EnqueueMergeUseCase resolves the base from the forge when the request
// names none, and passes a named base through without touching the forge.
import { describe, expect, it } from 'vitest';

import { EnqueueMergeUseCase } from '../EnqueueMergeUseCase.use-case.js';
import type { MergeQueueEnqueueCommand, MergeQueueRepositoryPort } from '../../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { ForgeReadPort, ReadPullRequestResult } from '../../ports/out/ForgeReadPort.out-port.js';
import type { MergeEnqueueDecision } from '../../../domain/merge-queue-operations.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';

function command(overrides: Partial<MergeQueueEnqueueCommand> = {}): MergeQueueEnqueueCommand {
  return {
    repository: { owner: 'fleet', repo: 'v2' },
    pullRequest: 7,
    headOid: HEAD,
    tier: 2,
    enqueuedBy: 'cli',
    runId: null,
    entryId: '01JB0000000000000000000001',
    successorEntryId: '01JB0000000000000000000002',
    enqueuedAtIso: '2026-11-01T11:00:00.000Z',
    deadlineIso: '2026-11-02T11:00:00.000Z',
    ...overrides,
  };
}

function found(baseRef: string): ReadPullRequestResult {
  return {
    outcome: 'found',
    pullRequest: {
      number: 7,
      state: 'open',
      mergeState: 'clean',
      headSha: HEAD,
      headRef: 'feature',
      baseRef,
      mergedAtIso: null,
      closedAtIso: null,
      mergeCommitSha: null,
    },
  };
}

function fakeForge(result: ReadPullRequestResult | (() => ReadPullRequestResult)): ForgeReadPort {
  const call = typeof result === 'function' ? result : () => result;
  return {
    isConfigured: () => true,
    readPullRequest: () => Promise.resolve(call()),
  };
}

function recordingQueue(): { queue: MergeQueueRepositoryPort; calls: MergeQueueEnqueueCommand[] } {
  const calls: MergeQueueEnqueueCommand[] = [];
  const queue: MergeQueueRepositoryPort = {
    enqueueMergeEntry: async (request) => {
      calls.push(request);
      return { outcome: 'refused', reason: 'invalid-head' } as MergeEnqueueDecision;
    },
    dropMergeEntry: async () => ({ outcome: 'refused', reason: 'unknown-entry' }),
    retryMergeEntry: async () => ({ outcome: 'refused', reason: 'unknown-entry' }),
    listMergeEntries: async () => [],
  };
  return { queue, calls };
}

describe('EnqueueMergeUseCase base resolution', () => {
  it('reads the base from the forge when no base is named', async () => {
    const { queue, calls } = recordingQueue();
    const useCase = new EnqueueMergeUseCase({ queue, forge: fakeForge(found('chain/dt')) });
    await useCase.enqueue(command());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.baseBranch).toBe('chain/dt');
    expect(Object.hasOwn(calls[0]!, 'baseBranch')).toBe(true);
  });

  it('passes a named base through without calling the forge', async () => {
    let forgeCalled = false;
    const forge: ForgeReadPort = {
      isConfigured: () => true,
      readPullRequest: async () => {
        forgeCalled = true;
        return { outcome: 'not-found' };
      },
    };
    const { queue, calls } = recordingQueue();
    const useCase = new EnqueueMergeUseCase({ queue, forge });
    await useCase.enqueue(command({ baseBranch: 'main' }));
    expect(forgeCalled).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.baseBranch).toBe('main');
  });

  it('returns base-unavailable without calling the queue when the forge is unavailable', async () => {
    const { queue, calls } = recordingQueue();
    const useCase = new EnqueueMergeUseCase({
      queue,
      forge: fakeForge({ outcome: 'unavailable', reason: 'network' }),
    });
    const decision = await useCase.enqueue(command());
    expect(decision).toEqual({ outcome: 'refused', reason: 'base-unavailable' });
    expect(calls).toHaveLength(0);
  });

  it('returns base-unavailable for an unparsable forge base without echoing it', async () => {
    const { queue, calls } = recordingQueue();
    const useCase = new EnqueueMergeUseCase({ queue, forge: fakeForge(found('release')) });
    const decision = await useCase.enqueue(command());
    expect(decision).toEqual({ outcome: 'refused', reason: 'base-unavailable' });
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(decision)).not.toContain('release');
  });

  it('returns base-unavailable when the forge is not configured', async () => {
    const { queue, calls } = recordingQueue();
    const forge: ForgeReadPort = {
      isConfigured: () => false,
      readPullRequest: async () => {
        throw new Error('must not be called');
      },
    };
    const useCase = new EnqueueMergeUseCase({ queue, forge });
    const decision = await useCase.enqueue(command());
    expect(decision).toEqual({ outcome: 'refused', reason: 'base-unavailable' });
    expect(calls).toHaveLength(0);
  });
});
