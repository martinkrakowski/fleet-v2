// S1U1: DecideShadowMergeUseCase journals, for ONE (pullRequest, headOid)
// pair, the shadow merge decision RunMergePassUseCase would reach: keyed
// dry-run intents and results on the merge-pr key, no queue writes, no CLI.
import { describe, expect, it } from 'vitest';

import { DecideShadowMergeUseCase } from '../DecideShadowMergeUseCase.use-case.js';
import type { DecideShadowMergeRequest } from '../../ports/in/DecideShadowMergePort.in-port.js';
import type {
  ForgeMergeReadPort,
  MergeContextSnapshot,
  ReadForgeMergeResult,
} from '../../ports/out/ForgeMergeReadPort.out-port.js';
import type { MergeVerificationPort } from '../../ports/out/MergeVerificationPort.out-port.js';
import type { ConductorHaltPort } from '../../ports/out/ConductorHaltPort.out-port.js';
import type { ConductorHaltState } from '../../../domain/conductor-halt.js';
import type { MergeRepoPolicy } from '../../../domain/merge-queue-decider.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type { MergeQueueEntryRecord } from '../../../domain/merge-queue-records.js';
import type { MergeQueueRepositoryPort } from '../../ports/out/MergeQueueRepositoryPort.out-port.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';

const OWNER = 'fleet';
const REPO = 'v2';
const DIGEST = '0123456789ab';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const HEAD12 = '0123456789ab';
const MOVED_HEAD = 'fedcba987654ef0123456789abcdef0123456789';
const MOVED_HEAD12 = 'fedcba987654';
const NOW = '2026-11-01T12:00:00.000Z';
const DEADLINE = '2026-11-01T12:10:00.000Z';
const PAST_DEADLINE = '2026-11-01T11:59:00.000Z';
const POSTER = 'premerge-bot';
const MERGE_KEY = `merge/${DIGEST}/1/${HEAD12}/merge-pr`;

function mergeKeyFor(head12: string): string {
  return `merge/${DIGEST}/1/${head12}/merge-pr`;
}

let ulidCounter = 0;
function ulid(): string {
  ulidCounter += 1;
  return '01JD' + String(ulidCounter).padStart(22, '0').slice(-22);
}

function makePolicy(overrides: Record<string, unknown> = {}): MergeRepoPolicy {
  return {
    policyRevision: 'rev-1',
    shadow: true,
    unattended: true,
    updateBranch: false,
    premergePosterLogin: POSTER,
    macosProcedure: null,
    requiredContexts: ['gate', 'premerge'],
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

function greenForge(): Extract<ReadForgeMergeResult, { outcome: 'ok' }> {
  return {
    outcome: 'ok',
    prState: 'open',
    liveHeadSha: HEAD,
    mergeState: 'clean',
    mergedAtIso: null,
    contexts: greenContexts(),
    unresolvedThreads: 0,
  };
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

function sequencedForgeRead(results: readonly ReadForgeMergeResult[]): ForgeMergeReadPort & { calls: number } {
  const adapter = {
    calls: 0,
    async readForgeMerge(): Promise<ReadForgeMergeResult> {
      const result = results[Math.min(adapter.calls, results.length - 1)];
      adapter.calls += 1;
      return result;
    },
    isConfigured(): boolean {
      return true;
    },
  };
  return adapter as ForgeMergeReadPort & { calls: number };
}

function throwingForgeRead(): ForgeMergeReadPort & { calls: number } {
  const adapter = {
    calls: 0,
    async readForgeMerge(): Promise<ReadForgeMergeResult> {
      adapter.calls += 1;
      throw new Error('forge read failed');
    },
    isConfigured(): boolean {
      return true;
    },
  };
  return adapter as ForgeMergeReadPort & { calls: number };
}

const verificationFake: MergeVerificationPort = {
  async readVerification() {
    return { outcome: 'unknown', reasonCode: 'no-receipt' };
  },
  async runVerification(): Promise<never> {
    throw new Error('runVerification must never be called in the shadow pass');
  },
} as unknown as MergeVerificationPort;

const haltClear: ConductorHaltState = { state: 'clear', record: null };
const haltFake: Pick<ConductorHaltPort, 'read'> = {
  async read(): Promise<ConductorHaltState> {
    return haltClear;
  },
};

interface Harness {
  readonly useCase: DecideShadowMergeUseCase;
  readonly forge: ForgeMergeReadPort & { calls: number };
  readonly journal: LaneRunJournalAdapter;
  readonly resetClock: () => void;
  readonly request: DecideShadowMergeRequest;
  readonly appends: () => number;
}

/** One v2 merge-queue entry as the real queue adapter would store it. */
function makeQueueEntry(overrides: Partial<MergeQueueEntryRecord> = {}): MergeQueueEntryRecord {
  return {
    version: 2,
    entryId: ulid(),
    repository: { owner: OWNER, repo: REPO },
    repoDigest: DIGEST,
    pullRequest: 1,
    headOid: HEAD,
    state: 'queued',
    reason: null,
    attempt: 0,
    notBeforeIso: null,
    enqueuedAtIso: '2026-11-01T11:00:00.000Z',
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
    baseBranch: 'main',
    ...overrides,
  };
}

function queueFake(
  entries: unknown,
): Pick<MergeQueueRepositoryPort, 'listMergeEntries'> {
  return {
    async listMergeEntries() {
      if (typeof entries === 'object' && entries !== null && (entries as { throws?: unknown }).throws === true) {
        throw new Error('queue read failed');
      }
      return entries as readonly MergeQueueEntryRecord[];
    },
  };
}

function makeHarness(input: {
  readonly forgeResult?: ReadForgeMergeResult;
  readonly policy?: Record<string, unknown>;
  readonly deadlineIso?: string;
  readonly appendThrows?: boolean;
  readonly clockJumpsAfterIntent?: boolean;
  readonly forge?: ForgeMergeReadPort & { calls: number };
  readonly requestOverrides?: Record<string, unknown>;
  readonly queueEntries?: unknown;
} = {}): Harness {
  const journal = new LaneRunJournalAdapter();
  const forge = input.forge ?? forgeReadFake(input.forgeResult ?? greenForge());
  let clock = NOW;
  let appends = 0;
  const wrapped: Pick<LaneRunJournalAdapter, 'append' | 'listForKey' | 'listForKeyPrefix'> = {
    append: async (entry: LaneRunJournalEntryRecord) => {
      if (input.appendThrows === true) {
        throw new Error('append failed');
      }
      appends += 1;
      const appended = await journal.append(entry);
      if (input.clockJumpsAfterIntent === true && appended.outcome === 'appended' && entry.kind === 'intent') {
        clock = '2026-11-01T12:15:00.000Z'; // past both deadlines
      }
      return appended;
    },
    listForKey: (key: string) => journal.listForKey(key),
    listForKeyPrefix: (keyPrefix: string) => journal.listForKeyPrefix(keyPrefix),
  };
  const useCase = new DecideShadowMergeUseCase({
    forgeRead: forge,
    verification: verificationFake,
    journal: wrapped,
    halt: haltFake,
    queue: queueFake(input.queueEntries ?? []),
    newUlid: ulid,
    nowIso: () => clock,
  });
  return {
    useCase,
    forge,
    journal,
    resetClock: () => {
      clock = NOW;
    },
    appends: () => appends,
    request: {
      repository: { owner: OWNER, repo: REPO },
      repoDigest: DIGEST,
      projectId: 'proj-1',
      policy: makePolicy(input.policy),
      pullRequest: 1,
      headOid: HEAD,
      baseBranch: 'main',
      deadlineIso: input.deadlineIso ?? DEADLINE,
      ...input.requestOverrides,
    },
  };
}

async function rowsFor(journal: LaneRunJournalAdapter, key: string): Promise<readonly LaneRunJournalEntryRecord[]> {
  return journal.listForKey(key);
}

async function mergePrResultCount(journal: LaneRunJournalAdapter, key: string): Promise<number> {
  return (await rowsFor(journal, key)).filter((row) => row.kind === 'result').length;
}

describe('DecideShadowMergeUseCase', () => {
  it('a green head journals exactly one would-merge dry-run result on the merge-pr key with the full head as linkedId', async () => {
    const harness = makeHarness();

    const result = await harness.useCase.decideShadowMerge(harness.request);

    expect(result).toEqual({
      outcome: 'journalled',
      reasonCode: 'would-merge',
      journalKey: MERGE_KEY,
    });
    const rows = await rowsFor(harness.journal, MERGE_KEY);
    expect(rows.map((row) => row.kind)).toEqual(['intent', 'result']);
    expect(rows[1].outcome).toBe('dry-run');
    expect(rows[1].reasonCode).toBe('would-merge');
    expect(rows[1].linkedId).toBe(HEAD);
    expect(harness.forge.calls).toBe(1);
  });

  it('a repeat call for the same pair returns already-journalled and leaves the journal row count unchanged', async () => {
    const harness = makeHarness();

    const first = await harness.useCase.decideShadowMerge(harness.request);
    expect(first.outcome).toBe('journalled');
    const before = await rowsFor(harness.journal, MERGE_KEY);
    const second = await harness.useCase.decideShadowMerge(harness.request);

    expect(second).toEqual({
      outcome: 'already-journalled',
      reasonCode: 'already-journalled',
      journalKey: MERGE_KEY,
    });
    const after = await rowsFor(harness.journal, MERGE_KEY);
    expect(after).toHaveLength(before.length);
  });

  it('a moved head first journals the original head, then a second row under the new head key, and leaves the first key rows untouched', async () => {
    const harness = makeHarness({
      forge: sequencedForgeRead([greenForge(), { ...greenForge(), liveHeadSha: MOVED_HEAD }]),
    });

    const first = await harness.useCase.decideShadowMerge(harness.request);
    expect(first.outcome).toBe('journalled');
    expect(first.reasonCode).toBe('would-merge');
    const originalRows = await rowsFor(harness.journal, MERGE_KEY);
    expect(originalRows.map((row) => row.kind)).toEqual(['intent', 'result']);
    expect(originalRows[1].linkedId).toBe(HEAD);

    const result = await harness.useCase.decideShadowMerge({ ...harness.request, headOid: MOVED_HEAD });

    expect(result.outcome).toBe('journalled');
    expect(result.reasonCode).toBe('would-merge');
    const movedRows = await rowsFor(harness.journal, mergeKeyFor(MOVED_HEAD12));
    expect(movedRows.map((row) => row.kind)).toEqual(['intent', 'result']);
    expect(movedRows[1].reasonCode).toBe('would-merge');
    expect(movedRows[1].linkedId).toBe(MOVED_HEAD);
    expect(await rowsFor(harness.journal, MERGE_KEY)).toEqual(originalRows);
  });

  it.each([
    ['behind merge state', { ...greenForge(), mergeState: 'behind' }],
    ['a pending required check', {
      ...greenForge(),
      contexts: [
        { name: 'gate', state: 'PENDING', isGreen: false, creatorLogin: null },
        { name: 'premerge', state: 'SUCCESS', isGreen: true, creatorLogin: POSTER },
      ],
    }],
  ])('%s is not-ready with a named reason and journals no merge-pr result', async (_label, forgeResult) => {
    const harness = makeHarness({ forgeResult: forgeResult as ReadForgeMergeResult });

    const result = await harness.useCase.decideShadowMerge(harness.request);

    expect(result.outcome).toBe('not-ready');
    expect(typeof result.reasonCode).toBe('string');
    expect(result.reasonCode).not.toBe('');
    expect(result.journalKey).toBeNull();
    expect(await mergePrResultCount(harness.journal, MERGE_KEY)).toBe(0);
  });

  it('a live policy is refused as policy-not-shadow with zero journal appends and zero forge reads', async () => {
    const harness = makeHarness({ policy: { shadow: false } });

    const result = await harness.useCase.decideShadowMerge(harness.request);

    expect(result).toEqual({ outcome: 'refused', reasonCode: 'policy-not-shadow', journalKey: null });
    expect(harness.forge.calls).toBe(0);
    expect(harness.appends()).toBe(0);
  });

  it('append counts: a pending required check appends nothing, a green head appends one intent and one result on the merge-pr key', async () => {
    const pendingHarness = makeHarness({
      forgeResult: {
        ...greenForge(),
        contexts: [
          { name: 'gate', state: 'PENDING', isGreen: false, creatorLogin: null },
          { name: 'premerge', state: 'SUCCESS', isGreen: true, creatorLogin: POSTER },
        ],
      },
    });
    const pending = await pendingHarness.useCase.decideShadowMerge(pendingHarness.request);
    expect(pending.outcome).toBe('not-ready');
    expect(pendingHarness.appends()).toBe(0);

    const greenHarness = makeHarness();
    const green = await greenHarness.useCase.decideShadowMerge(greenHarness.request);
    expect(green.outcome).toBe('journalled');
    expect(greenHarness.appends()).toBe(2);
    const rows = await rowsFor(greenHarness.journal, MERGE_KEY);
    expect(rows.map((row) => row.kind)).toEqual(['intent', 'result']);
    expect(rows.every((row) => row.key === MERGE_KEY)).toBe(true);
  });

  it('a non-would-merge journalled action (would-update-branch) maps to not-ready, not journalled', async () => {
    const harness = makeHarness({
      policy: { updateBranch: true },
      forgeResult: { ...greenForge(), mergeState: 'behind' },
    });

    const result = await harness.useCase.decideShadowMerge(harness.request);

    expect(result.outcome).toBe('not-ready');
    expect(result.journalKey).toBeNull();
    expect(await mergePrResultCount(harness.journal, MERGE_KEY)).toBe(0);
  });

  it('a deadline in the past returns budget-exhausted with zero forge reads and zero journal appends', async () => {
    const harness = makeHarness({ deadlineIso: PAST_DEADLINE });

    const result = await harness.useCase.decideShadowMerge(harness.request);

    expect(result).toEqual({
      outcome: 'budget-exhausted',
      reasonCode: 'budget-exhausted',
      journalKey: null,
    });
    expect(harness.forge.calls).toBe(0);
    expect(harness.appends()).toBe(0);
  });

  it('a clock that passes the deadline right after the intent append closes the open intent with shadow-intent-closed, and a second call is already-journalled', async () => {
    const harness = makeHarness({ clockJumpsAfterIntent: true });

    const first = await harness.useCase.decideShadowMerge(harness.request);

    expect(first).toEqual({
      outcome: 'budget-exhausted',
      reasonCode: 'budget-exhausted',
      journalKey: null,
    });
    const rows = await rowsFor(harness.journal, MERGE_KEY);
    expect(rows.map((row) => row.kind)).toEqual(['intent', 'result']);
    expect(rows[1].outcome).toBe('dry-run');
    expect(rows[1].reasonCode).toBe('shadow-intent-closed');
    expect(rows[1].runId).toBe(rows[0].runId);

    harness.resetClock(); // the second call has a fresh budget
    const second = await harness.useCase.decideShadowMerge(harness.request);
    expect(second.outcome).toBe('already-journalled');
  });

  it('a throwing journal append and a throwing forge read each return refused decide-failed and never journalled', async () => {
    const appendHarness = makeHarness({ appendThrows: true });
    const appendResult = await appendHarness.useCase.decideShadowMerge(appendHarness.request);
    expect(appendResult).toEqual({ outcome: 'refused', reasonCode: 'decide-failed', journalKey: null });

    const forgeHarness = makeHarness({ forge: throwingForgeRead() });
    const forgeResult = await forgeHarness.useCase.decideShadowMerge(forgeHarness.request);
    expect(forgeResult).toEqual({ outcome: 'refused', reasonCode: 'decide-failed', journalKey: null });
  });

  it('a malformed request returns invalid-request with zero journal appends and zero forge reads', async () => {
    const badHeadHarness = makeHarness({ requestOverrides: { headOid: 'not-a-head' } });
    const badHead = await badHeadHarness.useCase.decideShadowMerge(badHeadHarness.request);
    expect(badHead).toEqual({ outcome: 'refused', reasonCode: 'invalid-request', journalKey: null });
    expect(badHeadHarness.forge.calls).toBe(0);
    expect(badHeadHarness.appends()).toBe(0);

    const badPrHarness = makeHarness({ requestOverrides: { pullRequest: 0 } });
    const badPr = await badPrHarness.useCase.decideShadowMerge(badPrHarness.request);
    expect(badPr).toEqual({ outcome: 'refused', reasonCode: 'invalid-request', journalKey: null });
    expect(badPrHarness.forge.calls).toBe(0);
    expect(badPrHarness.appends()).toBe(0);
  });

  it('a chain base is judged against its own base: a green head whose forge base is chain/example journals would-merge on the merge-pr key, never base-mismatch', async () => {
    const harness = makeHarness({
      forgeResult: { ...greenForge(), baseRef: 'chain/example' },
      requestOverrides: { baseBranch: 'chain/example' },
    });

    const result = await harness.useCase.decideShadowMerge(harness.request);

    expect(result).toEqual({
      outcome: 'journalled',
      reasonCode: 'would-merge',
      journalKey: MERGE_KEY,
    });
    const rows = await rowsFor(harness.journal, MERGE_KEY);
    expect(rows.map((row) => row.kind)).toEqual(['intent', 'result']);
    expect(rows[1].reasonCode).toBe('would-merge');
  });

  it('an earlier live entry on the same base holds the queue head: the decision is the not-queue-head wait with zero forge reads and zero journal appends', async () => {
    const harness = makeHarness({
      queueEntries: [
        makeQueueEntry({
          pullRequest: 7,
          headOid: 'a'.repeat(40),
          enqueuedAtIso: '2026-11-01T11:00:00.000Z',
          baseBranch: 'main',
        }),
      ],
    });

    const result = await harness.useCase.decideShadowMerge(harness.request);

    expect(result).toEqual({ outcome: 'not-ready', reasonCode: 'not-queue-head', journalKey: null });
    expect(harness.forge.calls).toBe(0);
    expect(harness.appends()).toBe(0);
    expect(await mergePrResultCount(harness.journal, MERGE_KEY)).toBe(0);
  });

  it('an earlier live entry on a different base does not block the decision', async () => {
    const harness = makeHarness({
      forgeResult: { ...greenForge(), baseRef: 'chain/example' },
      requestOverrides: { baseBranch: 'chain/example' },
      queueEntries: [makeQueueEntry({ pullRequest: 7, headOid: 'a'.repeat(40), baseBranch: 'main' })],
    });

    const result = await harness.useCase.decideShadowMerge(harness.request);

    expect(result).toEqual({ outcome: 'journalled', reasonCode: 'would-merge', journalKey: MERGE_KEY });
  });

  it('a parked earlier entry on the same base does not block the decision, because the head skips parked entries', async () => {
    const harness = makeHarness({
      queueEntries: [makeQueueEntry({ pullRequest: 7, headOid: 'a'.repeat(40), state: 'parked', reason: 'checks' })],
    });

    const result = await harness.useCase.decideShadowMerge(harness.request);

    expect(result).toEqual({ outcome: 'journalled', reasonCode: 'would-merge', journalKey: MERGE_KEY });
  });

  it('the pair already queued as its base head is still decided for its own key', async () => {
    const harness = makeHarness({
      queueEntries: [makeQueueEntry()],
    });

    const result = await harness.useCase.decideShadowMerge(harness.request);

    expect(result).toEqual({ outcome: 'journalled', reasonCode: 'would-merge', journalKey: MERGE_KEY });
  });

  it('a throwing, a non-array and an oversized queue peek each return refused decide-failed with zero forge reads and zero journal appends', async () => {
    const throwingHarness = makeHarness({ queueEntries: { throws: true } });
    const throwing = await throwingHarness.useCase.decideShadowMerge(throwingHarness.request);
    expect(throwing).toEqual({ outcome: 'refused', reasonCode: 'decide-failed', journalKey: null });
    expect(throwingHarness.forge.calls).toBe(0);
    expect(throwingHarness.appends()).toBe(0);

    const nonArrayHarness = makeHarness({ queueEntries: { not: 'an-array' } });
    const nonArray = await nonArrayHarness.useCase.decideShadowMerge(nonArrayHarness.request);
    expect(nonArray).toEqual({ outcome: 'refused', reasonCode: 'decide-failed', journalKey: null });
    expect(nonArrayHarness.forge.calls).toBe(0);

    const oversizeHarness = makeHarness({
      queueEntries: Array.from({ length: 5001 }, () => makeQueueEntry()),
    });
    const oversize = await oversizeHarness.useCase.decideShadowMerge(oversizeHarness.request);
    expect(oversize).toEqual({ outcome: 'refused', reasonCode: 'decide-failed', journalKey: null });
    expect(oversizeHarness.forge.calls).toBe(0);
    expect(oversizeHarness.appends()).toBe(0);
  });

  it('a malformed baseBranch is invalid-request with zero journal appends and zero forge reads', async () => {
    const harness = makeHarness({ requestOverrides: { baseBranch: 'release' } });

    const result = await harness.useCase.decideShadowMerge(harness.request);

    expect(result).toEqual({ outcome: 'refused', reasonCode: 'invalid-request', journalKey: null });
    expect(harness.forge.calls).toBe(0);
    expect(harness.appends()).toBe(0);
  });
});
