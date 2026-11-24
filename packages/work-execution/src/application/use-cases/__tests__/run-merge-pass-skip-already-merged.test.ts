// MP1: a shadow merge pass skips entries whose current head already has a
// journaled `would-already-merged` dry-run, and fails open otherwise.
import { describe, expect, it } from 'vitest';

import { RunMergePassUseCase } from '../RunMergePassUseCase.use-case.js';
import type { RunMergePassDependencies } from '../RunMergePassUseCase.use-case.js';
import type { RunMergePassRequest } from '../../ports/in/RunMergePassPort.in-port.js';
import type {
  ForgeMergeReadPort,
  MergeContextSnapshot,
  ReadForgeMergeResult,
} from '../../ports/out/ForgeMergeReadPort.out-port.js';
import type { MergeVerificationPort } from '../../ports/out/MergeVerificationPort.out-port.js';
import type { MergeQueueRepositoryPort } from '../../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { ConductorHaltPort } from '../../ports/out/ConductorHaltPort.out-port.js';
import type { ConductorHaltState } from '../../../domain/conductor-halt.js';
import type { MergeRepoPolicy } from '../../../domain/merge-queue-decider.js';
import { MERGE_QUEUE_ENTRY_VERSION } from '../../../domain/merge-queue-records.js';
import type { MergeQueueEntryRecord } from '../../../domain/merge-queue-records.js';
import {
  LANE_RUN_JOURNAL_ENTRY_VERSION,
  type LaneRunJournalEntryRecord,
} from '../../../domain/lane-run-journal.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';

const OWNER = 'fleet';
const REPO = 'v2';
const DIGEST = '0123456789ab';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const HEAD12 = '0123456789ab';
const OTHER_HEAD12 = 'fedcba987654';
const NOW = '2026-11-01T12:00:00.000Z';
const DEADLINE = '2026-11-01T12:10:00.000Z';
const PAST_DEADLINE = '2026-11-01T12:10:01.000Z';
const POSTER = 'premerge-bot';
const MERGED_AT = '2026-11-01T11:00:00.000Z';
const CREATED_AT = '2026-11-01T10:30:00.000Z';
const MERGE_KEY = `merge/${DIGEST}/1/${HEAD12}/merge-pr`;
const PREFIX = `merge/${DIGEST}/`;

let queueIds = 0;
let journalIds = 0;

function ulid(prefix: string, n: number): string {
  return prefix + String(n).padStart(22, '0').slice(-22);
}

function makeEntry(overrides: Partial<MergeQueueEntryRecord> = {}): MergeQueueEntryRecord {
  queueIds += 1;
  return {
    version: MERGE_QUEUE_ENTRY_VERSION,
    entryId: ulid('01JB', queueIds),
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
    requiredContexts: ['gate', 'premerge'],
    veto: { mode: 'off' },
    ...overrides,
  } as MergeRepoPolicy;
}

function alreadyMergedKey(pullRequest: number, head12: string): string {
  return `merge/${DIGEST}/${pullRequest}/${head12}/would-already-merged`;
}

/** A merged forge read whose required contexts predate the merge commit (EV2-eligible). */
function retroForge(): ReadForgeMergeResult {
  const contexts: MergeContextSnapshot[] = [
    { name: 'gate', state: 'SUCCESS', isGreen: true, creatorLogin: null, createdAtIso: CREATED_AT },
    { name: 'premerge', state: 'SUCCESS', isGreen: true, creatorLogin: POSTER, createdAtIso: CREATED_AT },
  ];
  return {
    outcome: 'ok',
    prState: 'merged',
    liveHeadSha: HEAD,
    mergeState: 'clean',
    mergedAtIso: MERGED_AT,
    contexts,
    unresolvedThreads: 0,
  } as ReadForgeMergeResult;
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
  return adapter;
}

const verificationFake: MergeVerificationPort = {
  async readVerification() {
    return { outcome: 'unknown', reasonCode: 'no-receipt' };
  },
  async runVerification(): Promise<never> {
    throw new Error('runVerification must never be called in the shadow pass');
  },
} as unknown as MergeVerificationPort;

function queueOf(records: readonly MergeQueueEntryRecord[]): MergeQueueRepositoryPort {
  return {
    async listMergeEntries() {
      return records;
    },
    async enqueueMergeEntry(): Promise<never> {
      throw new Error('not used');
    },
    async dropMergeEntry(): Promise<never> {
      throw new Error('not used');
    },
    async retryMergeEntry(): Promise<never> {
      throw new Error('not used');
    },
    async applyMergeTransition(): Promise<never> {
      throw new Error('not used');
    },
  } as unknown as MergeQueueRepositoryPort;
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

interface PrefixCounter {
  calls: number;
}

function journalPort(
  inner: LaneRunJournalAdapter,
  prefix: PrefixCounter,
  options: { list?: (keyPrefix: string) => unknown; omit?: boolean } = {},
): RunMergePassDependencies['journal'] {
  const append = (entry: LaneRunJournalEntryRecord) => inner.append(entry);
  const listForKey = (key: string) => inner.listForKey(key);
  if (options.omit === true) {
    return { append, listForKey };
  }
  return {
    append,
    listForKey,
    async listForKeyPrefix(keyPrefix: string) {
      prefix.calls += 1;
      if (options.list !== undefined) {
        return options.list(keyPrefix) as readonly LaneRunJournalEntryRecord[];
      }
      return inner.listForKeyPrefix(keyPrefix);
    },
  };
}

interface Harness {
  readonly useCase: RunMergePassUseCase;
  readonly forge: ForgeMergeReadPort & { calls: number };
  readonly request: RunMergePassRequest;
  readonly journal: LaneRunJournalAdapter;
  readonly prefix: PrefixCounter;
}

function makeHarness(input: {
  readonly records: readonly MergeQueueEntryRecord[];
  readonly policy?: Record<string, unknown>;
  readonly nowIso?: () => string;
  readonly deadlineIso?: string;
  readonly list?: (keyPrefix: string) => unknown;
  readonly omitPrefix?: boolean;
  readonly journal?: LaneRunJournalAdapter;
} = { records: [] }): Harness {
  const journal = input.journal ?? new LaneRunJournalAdapter();
  const prefix: PrefixCounter = { calls: 0 };
  const forge = forgeReadFake(retroForge());
  let minted = 0;
  const useCase = new RunMergePassUseCase({
    queue: queueOf(input.records),
    forgeRead: forge,
    verification: verificationFake,
    journal: journalPort(journal, prefix, { list: input.list, omit: input.omitPrefix }),
    halt: haltFake,
    newUlid: () => {
      minted += 1;
      return ulid('01JD', minted);
    },
    nowIso: input.nowIso ?? (() => NOW),
  });
  return {
    useCase,
    forge,
    journal,
    prefix,
    request: {
      repository: { owner: OWNER, repo: REPO },
      repoDigest: DIGEST,
      projectId: 'proj-1',
      policy: makePolicy(input.policy),
      deadlineIso: input.deadlineIso ?? DEADLINE,
    },
  };
}

async function appendJournal(
  journal: LaneRunJournalAdapter,
  kind: 'intent' | 'result',
  key: string,
  reasonCode: string | null,
): Promise<void> {
  journalIds += 1;
  const appended = await journal.append({
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: ulid('01JC', journalIds),
    kind,
    key,
    runId: null,
    recordedAtIso: NOW,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: kind === 'result' ? 'dry-run' : null,
    reasonCode: kind === 'result' ? reasonCode : null,
    detail: null,
    grantId: null,
    state: null,
  });
  if (appended.outcome !== 'appended') {
    throw new Error(`journal seed refused: ${appended.reason}`);
  }
}

async function seedDryRun(journal: LaneRunJournalAdapter, key: string, reasonCode: string): Promise<void> {
  await appendJournal(journal, 'intent', key, null);
  await appendJournal(journal, 'result', key, reasonCode);
}

function dryRun(key: string, reasonCode: string, outcome = 'dry-run'): Record<string, unknown> {
  return { kind: 'result', outcome, reasonCode, key };
}

describe('RunMergePassUseCase shadow skip of journaled would-already-merged', () => {
  it('an entry with a journaled would-already-merged dry-run for its current head12 is not forge-read', async () => {
    const entry = makeEntry();
    const journal = new LaneRunJournalAdapter();
    await seedDryRun(journal, alreadyMergedKey(1, HEAD12), 'would-already-merged');
    const harness = makeHarness({ records: [entry], journal });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(result).toEqual({ outcome: 'completed', reasonCode: null, entries: [] });
    expect(harness.forge.calls).toBe(0);
    expect(harness.prefix.calls).toBe(1);
  });

  it('an entry with a journaled would-already-merged result for a different head12 is forge-read', async () => {
    const entry = makeEntry();
    const journal = new LaneRunJournalAdapter();
    await seedDryRun(journal, alreadyMergedKey(1, OTHER_HEAD12), 'would-already-merged');
    const harness = makeHarness({ records: [entry], journal });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(harness.forge.calls).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.entryId).toBe(entry.entryId);
    expect(result.entries[0]?.reasonCode).toBe('would-already-merged');
  });

  it('first observation is forge-read and journals would-already-merged after the retro merge-pr result', async () => {
    const harness = makeHarness({ records: [makeEntry()] });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(harness.forge.calls).toBe(1);
    expect(result.outcome).toBe('completed');
    expect(result.entries[0]?.reasonCode).toBe('would-already-merged');
    const listed = await harness.journal.listForKeyPrefix(PREFIX);
    const retro = listed.findIndex(
      (row) => row.kind === 'result' && row.key === MERGE_KEY && row.reasonCode === 'would-merge' && row.detail === 'retro',
    );
    const already = listed.findIndex(
      (row) => row.kind === 'result' && row.reasonCode === 'would-already-merged',
    );
    expect(retro).toBeGreaterThanOrEqual(0);
    expect(listed[retro]?.linkedId).toBe(HEAD);
    expect(already).toBeGreaterThan(retro);
  });

  it('live policy never skips entries with journaled would-already-merged', async () => {
    const entry = makeEntry();
    const journal = new LaneRunJournalAdapter();
    await seedDryRun(journal, alreadyMergedKey(1, HEAD12), 'would-already-merged');
    const harness = makeHarness({ records: [entry], journal, policy: { shadow: false } });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(harness.prefix.calls).toBe(0);
    expect(harness.forge.calls).toBe(1);
    expect(result.entries[0]).toMatchObject({
      entryId: entry.entryId,
      decision: 'no-action',
      reasonCode: 'already-merged',
    });
  });

  it('journal listing that throws leaves every entry live', async () => {
    const records = [makeEntry({ pullRequest: 1 }), makeEntry({ pullRequest: 2 }), makeEntry({ pullRequest: 3 })];
    const listings = [
      () => {
        throw new Error('unreadable journal');
      },
      () => Promise.reject(new Error('unreadable journal')),
    ];
    for (const list of listings) {
      const harness = makeHarness({ records, list });

      const result = await harness.useCase.runMergePass(harness.request);

      expect(result.outcome).toBe('completed');
      expect(harness.forge.calls).toBe(records.length);
      expect(result.entries).toHaveLength(records.length);
    }
  });

  it('listForKeyPrefix is called once per shadow pass regardless of entry count', async () => {
    const records = [1, 2, 3, 4, 5].map((pullRequest) => makeEntry({ pullRequest }));
    const journal = new LaneRunJournalAdapter();
    for (const record of records) {
      await seedDryRun(journal, alreadyMergedKey(record.pullRequest, HEAD12), 'would-already-merged');
    }
    const harness = makeHarness({ records, journal });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(harness.prefix.calls).toBe(1);
    expect(harness.forge.calls).toBe(0);
    expect(result).toEqual({ outcome: 'completed', reasonCode: null, entries: [] });
  });

  it('a would-already-merged intent with no result leaves the entry live', async () => {
    const entry = makeEntry();
    const journal = new LaneRunJournalAdapter();
    await appendJournal(journal, 'intent', alreadyMergedKey(1, HEAD12), null);
    const harness = makeHarness({ records: [entry], journal });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(harness.forge.calls).toBe(1);
    expect(result.entries[0]?.entryId).toBe(entry.entryId);
  });

  it('two consecutive shadow passes forge-read a merged pull request once and journal one would-already-merged result', async () => {
    const harness = makeHarness({ records: [makeEntry()] });

    await harness.useCase.runMergePass(harness.request);
    await harness.useCase.runMergePass(harness.request);

    expect(harness.forge.calls).toBe(1);
    const listed = await harness.journal.listForKeyPrefix(PREFIX);
    const results = listed.filter((row) => row.kind === 'result' && row.reasonCode === 'would-already-merged');
    expect(results).toHaveLength(1);
  });

  it('missing optional listForKeyPrefix method leaves every entry live', async () => {
    const entry = makeEntry();
    const journal = new LaneRunJournalAdapter();
    await seedDryRun(journal, alreadyMergedKey(1, HEAD12), 'would-already-merged');
    const harness = makeHarness({ records: [entry], journal, omitPrefix: true });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(harness.prefix.calls).toBe(0);
    expect(harness.forge.calls).toBe(1);
    expect(result.outcome).toBe('completed');
    expect(result.entries[0]?.entryId).toBe(entry.entryId);
  });

  it('non-array or null journal listing leaves every entry live', async () => {
    const listings: unknown[] = [null, undefined, { key: 'not-a-list' }];
    for (const listing of listings) {
      const entry = makeEntry();
      const harness = makeHarness({
        records: [entry],
        list: () => listing,
      });

      const result = await harness.useCase.runMergePass(harness.request);

      expect(result.outcome).toBe('completed');
      expect(harness.forge.calls).toBe(1);
      expect(result.entries[0]?.entryId).toBe(entry.entryId);
    }
  });

  it('malformed journal records and closed intents do not exclude entries', async () => {
    const matchedEarly = makeEntry({ pullRequest: 1 });
    const live = makeEntry({ pullRequest: 2 });
    const matchedLate = makeEntry({ pullRequest: 3 });
    const liveKey = alreadyMergedKey(2, HEAD12);
    const harness = makeHarness({
      records: [matchedEarly, live, matchedLate],
      list: () => [
        null,
        7,
        'not-a-record',
        dryRun(alreadyMergedKey(1, HEAD12), 'would-already-merged'),
        { kind: 'result', outcome: 'dry-run', reasonCode: 'would-already-merged', key: 2 },
        { kind: 'intent', outcome: null, reasonCode: null, key: liveKey },
        dryRun(liveKey, 'would-already-merged', 'completed'),
        dryRun(liveKey, 'shadow-intent-closed'),
        dryRun(liveKey, 'would-merge'),
        dryRun(alreadyMergedKey(3, HEAD12), 'would-already-merged'),
      ],
    });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(result.outcome).toBe('completed');
    expect(harness.forge.calls).toBe(1);
    expect(result.entries.map((row) => row.entryId)).toEqual([live.entryId]);
  });

  it('throwing getter on a journal record is ignored without failing the pass', async () => {
    const matchedEarly = makeEntry({ pullRequest: 1 });
    const live = makeEntry({ pullRequest: 2 });
    const matchedLate = makeEntry({ pullRequest: 3 });
    const throwingOnKey = {
      kind: 'result',
      outcome: 'dry-run',
      reasonCode: 'would-already-merged',
      get key(): string {
        throw new Error('key getter');
      },
    };
    const throwingOnReason = {
      kind: 'result',
      outcome: 'dry-run',
      key: alreadyMergedKey(2, HEAD12),
      get reasonCode(): string {
        throw new Error('reasonCode getter');
      },
    };
    const harness = makeHarness({
      records: [matchedEarly, live, matchedLate],
      list: () => [
        dryRun(alreadyMergedKey(1, HEAD12), 'would-already-merged'),
        throwingOnKey,
        throwingOnReason,
        dryRun(alreadyMergedKey(3, HEAD12), 'would-already-merged'),
      ],
    });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(result.outcome).toBe('completed');
    expect(result.reasonCode).toBeNull();
    expect(harness.forge.calls).toBe(1);
    expect(result.entries.map((row) => row.entryId)).toEqual([live.entryId]);
  });

  it('an entry with an invalid headOid is dropped by record validation and does not disturb the exclusion of others', async () => {
    // An invalid headOid never reaches the pass (queue-record validation drops
    // it before selection), so the exclusion cannot see it; this pins that the
    // valid matched entry is still excluded and the live one still read.
    const invalid = makeEntry({ pullRequest: 9, headOid: 'not-a-commit' });
    const matched = makeEntry({ pullRequest: 1 });
    const live = makeEntry({ pullRequest: 2 });
    const journal = new LaneRunJournalAdapter();
    await seedDryRun(journal, alreadyMergedKey(1, HEAD12), 'would-already-merged');
    const harness = makeHarness({ records: [invalid, matched, live], journal });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(result.outcome).toBe('completed');
    expect(result.reasonCode).toBeNull();
    expect(harness.forge.calls).toBe(1);
    expect(result.entries.map((row) => row.entryId)).toEqual([live.entryId]);
    expect(result.entries.some((row) => row.entryId === invalid.entryId)).toBe(false);
  });

  it('exhausted budget before journal prefix read returns budget-exhausted', async () => {
    let ticks = 0;
    const harness = makeHarness({
      records: [makeEntry()],
      nowIso: () => {
        ticks += 1;
        return ticks === 1 ? NOW : PAST_DEADLINE;
      },
      list: () => {
        throw new Error('listForKeyPrefix must not be called');
      },
    });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(result).toEqual({ outcome: 'budget-exhausted', reasonCode: null, entries: [] });
    expect(harness.prefix.calls).toBe(0);
    expect(harness.forge.calls).toBe(0);
  });
});
