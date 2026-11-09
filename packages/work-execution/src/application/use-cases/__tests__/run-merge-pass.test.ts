// DT9a: the shadow merge pass — one repository, keyed dry-run journal, no forge write.
import { describe, expect, it } from 'vitest';

import { RunMergePassUseCase } from '../RunMergePassUseCase.use-case.js';
import type { RunMergePassRequest } from '../../ports/in/RunMergePassPort.in-port.js';
import type {
  ForgeMergeReadPort,
  MergeContextSnapshot,
  ReadForgeMergeResult,
} from '../../ports/out/ForgeMergeReadPort.out-port.js';
import type {
  MergeVerificationPort,
  MergeVerificationResult,
} from '../../ports/out/MergeVerificationPort.out-port.js';
import type { MergeQueueRepositoryPort } from '../../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { ConductorHaltPort } from '../../ports/out/ConductorHaltPort.out-port.js';
import type { ConductorHaltState } from '../../../domain/conductor-halt.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { MERGE_QUEUE_ENTRY_VERSION } from '../../../domain/merge-queue-records.js';
import type { MergeQueueEntryRecord } from '../../../domain/merge-queue-records.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type { MergeRepoPolicy } from '../../../domain/merge-queue-decider.js';

const OWNER = 'fleet';
const REPO = 'v2';
const DIGEST = '0123456789ab';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const HEAD_MOVED = '0123456789abcdef0123456789abcdef01234599';
const HEAD12 = '0123456789ab';
const NOW = '2026-11-01T12:00:00.000Z';
const DEADLINE = '2026-11-01T12:10:00.000Z';
const POSTER = 'premerge-bot';

let entryIdCounter = 0;
function nextEntryId(): string {
  const ordinal = String(entryIdCounter).padStart(22, '0').slice(-22);
  entryIdCounter += 1;
  return '01JB' + ordinal;
}

function makeEntry(overrides: Partial<MergeQueueEntryRecord> = {}): MergeQueueEntryRecord {
  return {
    version: MERGE_QUEUE_ENTRY_VERSION,
    entryId: nextEntryId(),
    repository: { owner: OWNER, repo: REPO },
    repoDigest: DIGEST,
    pullRequest: 1,
    headOid: HEAD,
    state: 'queued',
    reason: null,
    attempt: 0,
    notBeforeIso: null,
    enqueuedAtIso: '2026-11-01T10:00:00.000Z',
    enqueuedBy: 'conductor',
    supersedes: null,
    runId: null,
    attemptId: null,
    workOrderId: null,
    tier: 0,
    verifiedHeadOid: null,
    verifiedBy: null,
    policyRevision: null,
    premergeReceiptHeadOid: null,
    veto: null,
    mergeCommitOid: null,
    mergedAtIso: null,
    revision: 1,
    ...overrides,
  };
}

function makePolicy(overrides: Record<string, unknown> = {}): MergeRepoPolicy {
  return {
    policyRevision: 'rev-1',
    shadow: true,
    unattended: true,
    updateBranch: false,
    premergePosterLogin: POSTER,
    macosProcedure: null,
    veto: { mode: 'off' },
    ...overrides,
  } as MergeRepoPolicy;
}

function greenContexts(): MergeContextSnapshot[] {
  return [
    { name: 'gate', state: 'SUCCESS', isGreen: true, creatorLogin: null },
    { name: 'premerge', state: 'SUCCESS', isGreen: true, creatorLogin: POSTER },
  ];
}

function forgeReadFake(result: ReadForgeMergeResult): ForgeMergeReadPort & { calls: number } {
  const adapter = {
    calls: 0,
    async readForgeMerge(): Promise<ReadForgeMergeResult> {
      adapter.calls += 1;
      return result;
    },
    isConfigured(): boolean {
      return true;
    },
  };
  return adapter as ForgeMergeReadPort & { calls: number };
}

function verificationFake(result: MergeVerificationResult = { outcome: 'unknown', reasonCode: 'no-receipt' }):
  MergeVerificationPort & { calls: number } {
  const adapter = {
    calls: 0,
    async readVerification(): Promise<MergeVerificationResult> {
      adapter.calls += 1;
      return result;
    },
    async runVerification(): Promise<MergeVerificationResult> {
      throw new Error('runVerification must never be called in DT9a');
    },
  };
  return adapter as MergeVerificationPort & { calls: number };
}

function queueFake(records: readonly MergeQueueEntryRecord[]): MergeQueueRepositoryPort {
  return {
    async listMergeEntries() {
      return records;
    },
    async enqueueMergeEntry() {
      throw new Error('not used');
    },
    async dropMergeEntry() {
      throw new Error('not used');
    },
    async retryMergeEntry() {
      throw new Error('not used');
    },
    async applyMergeTransition() {
      throw new Error('not used');
    },
  };
}

const haltClear: ConductorHaltState = { state: 'clear', record: null };
const haltFake: ConductorHaltPort = {
  async read(): Promise<ConductorHaltState> {
    return haltClear;
  },
  async set(): Promise<never> {
    throw new Error('not used');
  },
};

interface Deps {
  readonly journal: LaneRunJournalAdapter;
  readonly forgeRead: ForgeMergeReadPort & { calls: number };
  readonly verification: MergeVerificationPort & { calls: number };
}

function makeUseCase(
  records: readonly MergeQueueEntryRecord[],
  forgeResult: ReadForgeMergeResult,
  policyOverrides: Record<string, unknown> = {},
): { useCase: RunMergePassUseCase; deps: Deps; request: RunMergePassRequest } {
  const journal = new LaneRunJournalAdapter();
  const forgeRead = forgeReadFake(forgeResult);
  const verification = verificationFake();
  let ulid = 0;
  const useCase = new RunMergePassUseCase({
    queue: queueFake(records),
    forgeRead,
    verification,
    journal: journal as LaneRunJournalPort,
    halt: haltFake,
    newUlid: () => `01JB${String(++ulid).padStart(22, '0').slice(-22)}`,
    nowIso: () => NOW,
  });
  return {
    useCase,
    deps: { journal, forgeRead, verification },
    request: {
      repository: { owner: OWNER, repo: REPO },
      repoDigest: DIGEST,
      projectId: 'proj-1',
      policy: makePolicy(policyOverrides),
      deadlineIso: DEADLINE,
    },
  };
}

async function journalOf(journal: LaneRunJournalAdapter): Promise<LaneRunJournalEntryRecord[]> {
  const all: LaneRunJournalEntryRecord[] = [];
  for (const action of ['merge-pr', 'update-branch', 'post-status']) {
    const key = `merge/${DIGEST}/1/${HEAD12}/${action}`;
    all.push(...(await journal.listForKey(key)));
  }
  return all;
}

const greenForge: ReadForgeMergeResult = {
  outcome: 'ok',
  prState: 'open',
  liveHeadSha: HEAD,
  mergeState: 'clean',
  contexts: greenContexts(),
  unresolvedThreads: 0,
};

describe('RunMergePassUseCase (DT9a, shadow mode)', () => {
  it('journals one intent and one dry-run result for a green entry in shadow mode', async () => {
    const { useCase, deps, request } = makeUseCase([makeEntry()], greenForge);

    const result = await useCase.runMergePass(request);

    expect(result.outcome).toBe('completed');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      entryId: expect.any(String),
      head12: HEAD12,
      decision: 'journalled',
      reasonCode: 'would-merge',
      journalKey: `merge/${DIGEST}/1/${HEAD12}/merge-pr`,
    });
    const entries = await journalOf(deps.journal);
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe('intent');
    expect(entries[0].key).toBe(`merge/${DIGEST}/1/${HEAD12}/merge-pr`);
    expect(entries[1].kind).toBe('result');
    expect(entries[1].outcome).toBe('dry-run');
    expect(entries[1].reasonCode).toBe('would-merge');
    expect(entries[1].key).toBe(`merge/${DIGEST}/1/${HEAD12}/merge-pr`);
    // The forge read was called exactly once and nothing else was called.
    expect(deps.forgeRead.calls).toBe(1);
    expect(deps.verification.calls).toBe(0);
  });

  it('a second pass over the same entry journals nothing', async () => {
    const { useCase, deps, request } = makeUseCase([makeEntry()], greenForge);

    const first = await useCase.runMergePass(request);
    expect(first.entries[0].decision).toBe('journalled');
    const second = await useCase.runMergePass(request);

    expect(second.entries[0].decision).toBe('no-action');
    expect(second.entries[0].reasonCode).toBe('already-journalled');
    expect(await journalOf(deps.journal)).toHaveLength(2);
  });

  it('journals nothing while a required context is pending', async () => {
    const pending: ReadForgeMergeResult = {
      outcome: 'ok',
      prState: 'open',
      liveHeadSha: HEAD,
      mergeState: 'clean',
      contexts: [
        { name: 'gate', state: 'PENDING', isGreen: false, creatorLogin: null },
        { name: 'premerge', state: 'SUCCESS', isGreen: true, creatorLogin: POSTER },
      ],
      unresolvedThreads: 0,
    };
    const { useCase, deps, request } = makeUseCase([makeEntry()], pending);

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('no-action');
    expect(result.entries[0].reasonCode).toBe('checks-pending');
    expect(await journalOf(deps.journal)).toHaveLength(0);
  });

  it('journals nothing and parks forge-error when the forge read is unavailable', async () => {
    const { useCase, deps, request } = makeUseCase([makeEntry()], {
      outcome: 'unavailable',
      code: 'forge-error',
      reason: 'gh failed',
    });

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('no-action');
    expect(result.entries[0].reasonCode).toBe('forge-error');
    expect(await journalOf(deps.journal)).toHaveLength(0);
  });

  it('journals would-update-branch for a behind branch', async () => {
    const behind: ReadForgeMergeResult = {
      outcome: 'ok',
      prState: 'open',
      liveHeadSha: HEAD,
      mergeState: 'behind',
      contexts: greenContexts(),
      unresolvedThreads: 0,
    };
    const { useCase, deps, request } = makeUseCase([makeEntry()], behind, { updateBranch: true });

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('journalled');
    expect(result.entries[0].reasonCode).toBe('would-update-branch');
    expect(result.entries[0].journalKey).toBe(`merge/${DIGEST}/1/${HEAD12}/update-branch`);
    const entries = await journalOf(deps.journal);
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.key === `merge/${DIGEST}/1/${HEAD12}/update-branch`)).toBe(true);
  });

  it('journals nothing when the live head moved', async () => {
    const moved: ReadForgeMergeResult = { ...greenForge, liveHeadSha: HEAD_MOVED };
    const { useCase, deps, request } = makeUseCase([makeEntry()], moved);

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('no-action');
    expect(result.entries[0].reasonCode).toBe('superseded');
    expect(await journalOf(deps.journal)).toHaveLength(0);
  });

  it('journals nothing under a live policy and reports the action as deferred', async () => {
    const { useCase, deps, request } = makeUseCase([makeEntry()], greenForge, {
      shadow: false,
      unattended: true,
    });

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('live-deferred');
    expect(result.entries[0].reasonCode).toBe('merge-pr');
    expect(await journalOf(deps.journal)).toHaveLength(0);
  });

  it('stops as budget-exhausted without calling the forge when the deadline is too near', async () => {
    const { useCase, deps, request } = makeUseCase([makeEntry()], greenForge);
    const nearDeadline: RunMergePassRequest = { ...request, deadlineIso: '2026-11-01T12:00:01.000Z' };

    const result = await useCase.runMergePass(nearDeadline);

    expect(result.outcome).toBe('budget-exhausted');
    expect(result.entries).toHaveLength(0);
    expect(deps.forgeRead.calls).toBe(0);
  });

  it('a budget spent between the appends leaves the intent open, and the next pass completes the pair', async () => {
    // The pass clock jumps past the deadline the moment the intent is appended,
    // so the result append is not started (D-DT9 guards every journal call).
    // The next pass finds the open intent and writes only its result.
    const journal = new LaneRunJournalAdapter();
    let clock = NOW;
    const clockControlledJournal: Pick<LaneRunJournalPort, 'append' | 'listForKey'> = {
      async append(entry) {
        const appended = await journal.append(entry);
        if (appended.outcome === 'appended' && entry.kind === 'intent') {
          clock = '2026-11-01T12:15:00.000Z'; // past DEADLINE
        }
        return appended;
      },
      async listForKey(key) {
        return journal.listForKey(key);
      },
    };

    const forgeRead = forgeReadFake(greenForge);
    const verification = verificationFake();
    let ulid = 0;
    const useCase = new RunMergePassUseCase({
      queue: queueFake([makeEntry()]),
      forgeRead,
      verification,
      journal: clockControlledJournal,
      halt: haltFake,
      newUlid: () => `01JB${String(++ulid).padStart(22, '0').slice(-22)}`,
      nowIso: () => clock,
    });
    const request: RunMergePassRequest = {
      repository: { owner: OWNER, repo: REPO },
      repoDigest: DIGEST,
      projectId: 'proj-1',
      policy: makePolicy(),
      deadlineIso: DEADLINE,
    };

    const first = await useCase.runMergePass(request);
    expect(first.outcome).toBe('budget-exhausted');
    const afterFirst = await journalOf(journal);
    expect(afterFirst.map((entry) => entry.kind)).toEqual(['intent']);

    clock = NOW; // the next pass has a fresh budget
    const second = await useCase.runMergePass(request);
    expect(second.outcome).toBe('completed');
    expect(second.entries[0].decision).toBe('journalled');
    const afterSecond = await journalOf(journal);
    expect(afterSecond.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(afterSecond[1].outcome).toBe('dry-run');
    expect(afterSecond[1].reasonCode).toBe('would-merge');

    const third = await useCase.runMergePass(request);
    expect(third.entries[0].reasonCode).toBe('already-journalled');
    expect(await journalOf(journal)).toHaveLength(2);
  });

  it('an open shadow intent is closed on the next pass even when the decision changed', async () => {
    // The PR closed after an earlier pass appended its intent: the decider no
    // longer asks for a merge, and the open intent still gets its result.
    const closedForge = { ...greenForge, prState: 'closed' } as ReadForgeMergeResult;
    const { useCase, deps, request } = makeUseCase([makeEntry()], closedForge);
    const key = `merge/${DIGEST}/1/${HEAD12}/merge-pr`;
    await deps.journal.append({
      version: 1, entryId: '01JB0000000000000000000099', kind: 'intent', key, runId: makeEntry().runId,
      recordedAtIso: NOW, mode: null, expectedRevision: null, mintedId: null, outcome: null,
      reasonCode: null, detail: null, grantId: null, state: null,
    } as LaneRunJournalEntryRecord);

    await useCase.runMergePass(request);

    const after = await deps.journal.listForKey(key);
    expect(after.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(after[1].outcome).toBe('dry-run');
    expect(after[1].reasonCode).toBe('shadow-intent-closed');
  });

  it('a null request or one without a repository is refused, never thrown on', async () => {
    const { useCase, request } = makeUseCase([makeEntry()], greenForge);
    for (const bad of [null, { ...request, repository: undefined }, { ...request, repository: { owner: 1, repo: REPO } }]) {
      const result = await useCase.runMergePass(bad as unknown as RunMergePassRequest);
      expect(result).toEqual({ outcome: 'refused', reasonCode: 'invalid-request', entries: [] });
    }
  });

  it('an unknown veto never blocks the shadow merge', async () => {
    const { useCase, deps, request } = makeUseCase([makeEntry()], greenForge, {
      veto: { mode: 'shadow' },
    });

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('journalled');
    expect(result.entries[0].reasonCode).toBe('would-merge');
    expect(await journalOf(deps.journal)).toHaveLength(2);
  });
});
