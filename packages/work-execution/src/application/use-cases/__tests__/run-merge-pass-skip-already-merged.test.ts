// MP1: a shadow merge pass skips entries whose current head already has a
// journaled `would-already-merged` dry-run, and fails open otherwise.
// MP2: it also skips a head whose `would-supersede` dry-run is journaled
// once that pull request has a `would-already-merged` dry-run under any head.
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
const OTHER_HEAD = 'fedcba987654fedcba987654fedcba9876543210';
const OTHER_HEAD12 = 'fedcba987654';
const H3_12 = 'abcabcabcabc';
const OTHER_DIGEST = 'ffffffffffff';
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

function alreadyMergedKey(pullRequest: number, head12: string, digest: string = DIGEST): string {
  return `merge/${digest}/${pullRequest}/${head12}/would-already-merged`;
}

function supersedeKey(pullRequest: number, head12: string, digest: string = DIGEST): string {
  return `merge/${digest}/${pullRequest}/${head12}/would-supersede`;
}

/** `would-already-merged` under another head plus `would-supersede` for `head12`. */
function crossHeadRows(
  pullRequest: number,
  head12: string = HEAD12,
  mergedHead12: string = OTHER_HEAD12,
): Record<string, unknown>[] {
  return [
    dryRun(alreadyMergedKey(pullRequest, mergedHead12), 'would-already-merged'),
    dryRun(supersedeKey(pullRequest, head12), 'would-supersede'),
  ];
}

function countingQueueWriter(): {
  calls: number;
  readonly port: NonNullable<RunMergePassDependencies['queueWriter']>;
} {
  const writer = {
    calls: 0,
    port: {
      async applyMergeTransition(): Promise<never> {
        writer.calls += 1;
        throw new Error('queue write');
      },
    },
  };
  return writer;
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
  readonly forgeResult?: ReadForgeMergeResult;
  readonly queueWriter?: RunMergePassDependencies['queueWriter'];
} = { records: [] }): Harness {
  const journal = input.journal ?? new LaneRunJournalAdapter();
  const prefix: PrefixCounter = { calls: 0 };
  const forge = forgeReadFake(input.forgeResult ?? retroForge());
  let minted = 0;
  const useCase = new RunMergePassUseCase({
    queue: queueOf(input.records),
    queueWriter: input.queueWriter,
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

  it('an H1 entry with a would-already-merged result under H2 and a would-supersede result for H1 is not forge-read', async () => {
    const entry = makeEntry();
    const journal = new LaneRunJournalAdapter();
    await seedDryRun(journal, alreadyMergedKey(1, OTHER_HEAD12), 'would-already-merged');
    await seedDryRun(journal, supersedeKey(1, HEAD12), 'would-supersede');
    const before = await journal.listForKeyPrefix(PREFIX);
    const writer = countingQueueWriter();
    const harness = makeHarness({ records: [entry], journal, queueWriter: writer.port });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(result).toEqual({ outcome: 'completed', reasonCode: null, entries: [] });
    expect(harness.forge.calls).toBe(0);
    expect(harness.prefix.calls).toBe(1);
    expect(writer.calls).toBe(0);
    expect(await journal.listForKeyPrefix(PREFIX)).toEqual(before);
  });

  it('an H1 entry with would-already-merged under H2 but no would-supersede for H1 is forge-read and journals would-supersede', async () => {
    const entry = makeEntry();
    const journal = new LaneRunJournalAdapter();
    await seedDryRun(journal, alreadyMergedKey(1, OTHER_HEAD12), 'would-already-merged');
    const harness = makeHarness({
      records: [entry],
      journal,
      forgeResult: { ...(retroForge() as Extract<ReadForgeMergeResult, { outcome: 'ok' }>), liveHeadSha: OTHER_HEAD },
    });

    const result = await harness.useCase.runMergePass(harness.request);

    // The predecessor is read once, then the in-memory successor is read once.
    // The entry is not skipped: its would-supersede is journaled on H1.
    expect(result.outcome).toBe('completed');
    expect(harness.prefix.calls).toBe(1);
    expect(harness.forge.calls).toBe(2);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.head12).toBe(OTHER_HEAD12);
    expect(result.entries[0]?.reasonCode).toBe('already-journalled');
    const superseded = await harness.journal.listForKey(supersedeKey(1, HEAD12));
    expect(superseded.map((row) => row.kind)).toEqual(['intent', 'result']);
    expect(superseded[1]?.reasonCode).toBe('would-supersede');
    expect(superseded[1]?.outcome).toBe('dry-run');
  });

  it('a would-already-merged result for a different pull request or a different repoDigest does not exclude the H1 entry', async () => {
    const local = makeEntry({ pullRequest: 1 });
    const otherPrSettled = makeEntry({ pullRequest: 8 });
    const differentPr = makeHarness({
      records: [local, otherPrSettled],
      list: () => [
        dryRun(alreadyMergedKey(9, OTHER_HEAD12), 'would-already-merged'),
        dryRun(supersedeKey(1, HEAD12), 'would-supersede'),
        ...crossHeadRows(8),
      ],
    });

    const differentPrResult = await differentPr.useCase.runMergePass(differentPr.request);

    expect(differentPrResult.outcome).toBe('completed');
    expect(differentPr.forge.calls).toBe(1);
    expect(differentPrResult.entries.map((row) => row.entryId)).toEqual([local.entryId]);

    const foreign = makeEntry({ pullRequest: 1 });
    const sameRepoSettled = makeEntry({ pullRequest: 8 });
    const differentRepo = makeHarness({
      records: [foreign, sameRepoSettled],
      list: () => [
        dryRun(alreadyMergedKey(1, OTHER_HEAD12, OTHER_DIGEST), 'would-already-merged'),
        dryRun(supersedeKey(1, HEAD12), 'would-supersede'),
        ...crossHeadRows(8),
      ],
    });

    const differentRepoResult = await differentRepo.useCase.runMergePass(differentRepo.request);

    expect(differentRepoResult.outcome).toBe('completed');
    expect(differentRepo.forge.calls).toBe(1);
    expect(differentRepoResult.entries.map((row) => row.entryId)).toEqual([foreign.entryId]);
  });

  it('a live policy never excludes even when would-already-merged under H2 and would-supersede for H1 are journaled', async () => {
    const entry = makeEntry();
    const journal = new LaneRunJournalAdapter();
    await seedDryRun(journal, alreadyMergedKey(1, OTHER_HEAD12), 'would-already-merged');
    await seedDryRun(journal, supersedeKey(1, HEAD12), 'would-supersede');
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

  it('listForKeyPrefix is called at most once per pass across multiple cross-head entries', async () => {
    const excluded = [1, 2, 3].map((pullRequest) => makeEntry({ pullRequest }));
    const live = makeEntry({ pullRequest: 4 });
    const journal = new LaneRunJournalAdapter();
    for (const entry of excluded) {
      await seedDryRun(journal, alreadyMergedKey(entry.pullRequest, OTHER_HEAD12), 'would-already-merged');
      await seedDryRun(journal, supersedeKey(entry.pullRequest, HEAD12), 'would-supersede');
    }
    const harness = makeHarness({ records: [...excluded, live], journal });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(harness.prefix.calls).toBe(1);
    expect(harness.forge.calls).toBe(1);
    expect(result.entries.map((row) => row.entryId)).toEqual([live.entryId]);
  });

  it('would-already-merged under H2 plus would-supersede for the same PR under H3 does not exclude the H1 entry', async () => {
    const stale = makeEntry({ pullRequest: 1 });
    const settled = makeEntry({ pullRequest: 4 });
    const harness = makeHarness({
      records: [stale, settled],
      list: () => [
        dryRun(alreadyMergedKey(1, OTHER_HEAD12), 'would-already-merged'),
        dryRun(supersedeKey(1, H3_12), 'would-supersede'),
        ...crossHeadRows(4),
      ],
    });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(result.outcome).toBe('completed');
    expect(harness.forge.calls).toBe(1);
    expect(result.entries.map((row) => row.entryId)).toEqual([stale.entryId]);
  });

  it('refusal: missing listForKeyPrefix fails open', async () => {
    const entry = makeEntry();
    const journal = new LaneRunJournalAdapter();
    await seedDryRun(journal, alreadyMergedKey(1, OTHER_HEAD12), 'would-already-merged');
    await seedDryRun(journal, supersedeKey(1, HEAD12), 'would-supersede');
    const harness = makeHarness({ records: [entry], journal, omitPrefix: true });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(harness.prefix.calls).toBe(0);
    expect(harness.forge.calls).toBe(1);
    expect(result.outcome).toBe('completed');
    expect(result.entries[0]?.entryId).toBe(entry.entryId);
  });

  it('refusal: listForKeyPrefix rejection fails open', async () => {
    const records = [makeEntry({ pullRequest: 1 }), makeEntry({ pullRequest: 2 })];
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
      expect(result.reasonCode).not.toBe('pass-failed');
      expect(harness.forge.calls).toBe(records.length);
      expect(result.entries).toHaveLength(records.length);
    }
  });

  it('refusal: non-array from listForKeyPrefix fails open', async () => {
    const listings: unknown[] = [null, undefined, { key: 'not-a-list' }, 'merge/', 0];
    for (const listing of listings) {
      const entry = makeEntry();
      const harness = makeHarness({
        records: [entry],
        list: () => listing,
      });

      const result = await harness.useCase.runMergePass(harness.request);

      expect(result.outcome).toBe('completed');
      expect(result.reasonCode).toBeNull();
      expect(harness.forge.calls).toBe(1);
      expect(result.entries[0]?.entryId).toBe(entry.entryId);
    }
  });

  it('refusal: null or primitive element in listing is ignored', async () => {
    const settled = makeEntry({ pullRequest: 1 });
    const live = makeEntry({ pullRequest: 2 });
    const harness = makeHarness({
      records: [settled, live],
      list: () => [null, undefined, 7, 'not-a-record', true, ...crossHeadRows(1)],
    });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(result.outcome).toBe('completed');
    expect(result.reasonCode).toBeNull();
    expect(harness.forge.calls).toBe(1);
    expect(result.entries.map((row) => row.entryId)).toEqual([live.entryId]);
  });

  it('refusal: malformed record or key does not exclude', async () => {
    const live = makeEntry({ pullRequest: 1 });
    const settled = makeEntry({ pullRequest: 2 });
    const harness = makeHarness({
      records: [live, settled],
      list: () => [
        { kind: 'result', outcome: 'dry-run', reasonCode: 'would-already-merged', key: null },
        { kind: 'note', outcome: 'dry-run', reasonCode: 'would-already-merged', key: alreadyMergedKey(1, HEAD12) },
        dryRun(`merge/${DIGEST}/01/${HEAD12}/would-already-merged`, 'would-already-merged'),
        dryRun(`merge/${DIGEST}/01/${HEAD12}/would-supersede`, 'would-supersede'),
        dryRun(`merge/${OTHER_DIGEST}/1/${OTHER_HEAD12}/would-already-merged`, 'would-already-merged'),
        dryRun(`merge/${OTHER_DIGEST}/1/${HEAD12}/would-supersede`, 'would-supersede'),
        dryRun(`request/${DIGEST}`, 'would-already-merged'),
        dryRun(`merge/${DIGEST}/1/${HEAD12}/would-already-merged/extra`, 'would-already-merged'),
        dryRun(alreadyMergedKey(1, OTHER_HEAD12), 'would-merge'),
        dryRun(supersedeKey(1, HEAD12), 'would-park'),
        ...crossHeadRows(2),
      ],
    });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(result.outcome).toBe('completed');
    expect(harness.forge.calls).toBe(1);
    expect(result.entries.map((row) => row.entryId)).toEqual([live.entryId]);
  });

  it('refusal: throwing getter on journal record fails open', async () => {
    const settled = makeEntry({ pullRequest: 1 });
    const live = makeEntry({ pullRequest: 2 });
    const throwingOnKey = {
      kind: 'result',
      outcome: 'dry-run',
      reasonCode: 'would-supersede',
      get key(): string {
        throw new Error('key getter');
      },
    };
    const throwingOnKind = {
      outcome: 'dry-run',
      reasonCode: 'would-already-merged',
      key: alreadyMergedKey(2, OTHER_HEAD12),
      get kind(): string {
        throw new Error('kind getter');
      },
    };
    const harness = makeHarness({
      records: [settled, live],
      list: () => [
        throwingOnKind,
        dryRun(alreadyMergedKey(2, OTHER_HEAD12), 'would-already-merged'),
        throwingOnKey,
        ...crossHeadRows(1),
      ],
    });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(result.outcome).toBe('completed');
    expect(result.reasonCode).toBeNull();
    expect(harness.forge.calls).toBe(1);
    expect(result.entries.map((row) => row.entryId)).toEqual([live.entryId]);
  });

  it('refusal: open intent without result does not exclude', async () => {
    const pending = makeEntry({ pullRequest: 1 });
    const settled = makeEntry({ pullRequest: 2 });
    const harness = makeHarness({
      records: [pending, settled],
      list: () => [
        { kind: 'intent', outcome: null, reasonCode: null, key: alreadyMergedKey(1, OTHER_HEAD12) },
        { kind: 'intent', outcome: null, reasonCode: null, key: supersedeKey(1, HEAD12) },
        ...crossHeadRows(2),
      ],
    });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(result.outcome).toBe('completed');
    expect(harness.forge.calls).toBe(1);
    expect(result.entries.map((row) => row.entryId)).toEqual([pending.entryId]);
  });

  it('refusal: budget exhausted before listing returns budget-exhausted without listing', async () => {
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

  it('refusal: invalid entry headOid does not exclude', async () => {
    // An invalid headOid never reaches selection (queue-record validation
    // drops it), and head12Of of it is null, so the cross-head rule cannot
    // match would-supersede for that entry. A readable sibling with both
    // results is still excluded; a sibling with neither is still forge-read.
    const invalid = makeEntry({ pullRequest: 1, headOid: 'not-a-commit' });
    const settled = makeEntry({ pullRequest: 2 });
    const live = makeEntry({ pullRequest: 3 });
    const harness = makeHarness({
      records: [invalid, settled, live],
      list: () => [...crossHeadRows(1), ...crossHeadRows(2)],
    });

    const result = await harness.useCase.runMergePass(harness.request);

    expect(result.outcome).toBe('completed');
    expect(result.reasonCode).toBeNull();
    expect(harness.forge.calls).toBe(1);
    expect(result.entries.map((row) => row.entryId)).toEqual([live.entryId]);
    expect(result.entries.some((row) => row.entryId === invalid.entryId)).toBe(false);
  });

  it('refusal: shadow-intent-closed result on would-supersede@H1 or would-already-merged@H2 does not exclude', async () => {
    const closedSupersede = makeEntry({ pullRequest: 1 });
    const settled = makeEntry({ pullRequest: 2 });
    const supersedeClosed = makeHarness({
      records: [closedSupersede, settled],
      list: () => [
        dryRun(alreadyMergedKey(1, OTHER_HEAD12), 'would-already-merged'),
        dryRun(supersedeKey(1, HEAD12), 'shadow-intent-closed'),
        ...crossHeadRows(2),
      ],
    });

    const first = await supersedeClosed.useCase.runMergePass(supersedeClosed.request);

    expect(first.outcome).toBe('completed');
    expect(supersedeClosed.forge.calls).toBe(1);
    expect(first.entries.map((row) => row.entryId)).toEqual([closedSupersede.entryId]);

    const closedMerged = makeEntry({ pullRequest: 1 });
    const settledToo = makeEntry({ pullRequest: 2 });
    const mergedClosed = makeHarness({
      records: [closedMerged, settledToo],
      list: () => [
        dryRun(alreadyMergedKey(1, OTHER_HEAD12), 'shadow-intent-closed'),
        dryRun(supersedeKey(1, HEAD12), 'would-supersede'),
        ...crossHeadRows(2),
      ],
    });

    const second = await mergedClosed.useCase.runMergePass(mergedClosed.request);

    expect(second.outcome).toBe('completed');
    expect(mergedClosed.forge.calls).toBe(1);
    expect(second.entries.map((row) => row.entryId)).toEqual([closedMerged.entryId]);
  });
});
