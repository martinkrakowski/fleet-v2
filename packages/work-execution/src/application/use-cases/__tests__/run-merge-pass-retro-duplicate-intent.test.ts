// FX07B: a duplicate-key or replay on the retro would-merge must be checked
// against the merge-pr key before would-already-merged is written.
import { describe, expect, it } from 'vitest';

import { MERGE_QUEUE_ENTRY_VERSION } from '../../../domain/merge-queue-records.js';
import type { MergeQueueEntryRecord } from '../../../domain/merge-queue-records.js';
import type { MergeRepoPolicy } from '../../../domain/merge-queue-decider.js';
import {
  LANE_RUN_JOURNAL_ENTRY_VERSION,
  type LaneRunJournalEntryRecord,
} from '../../../domain/lane-run-journal.js';
import { RunMergePassUseCase } from '../RunMergePassUseCase.use-case.js';
import type { RunMergePassRequest, RunMergePassResult } from '../../ports/in/RunMergePassPort.in-port.js';
import type {
  ForgeMergeReadPort,
  MergeContextSnapshot,
  ReadForgeMergeResult,
} from '../../ports/out/ForgeMergeReadPort.out-port.js';
import type { MergeVerificationPort } from '../../ports/out/MergeVerificationPort.out-port.js';
import type { MergeQueueRepositoryPort } from '../../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { ConductorHaltPort } from '../../ports/out/ConductorHaltPort.out-port.js';
import type { ConductorHaltState } from '../../../domain/conductor-halt.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';

/** The journal methods this pass calls. `listForKeyPrefix` stays optional, as on the port. */
type ShadowJournalPort = Pick<LaneRunJournalPort, 'append' | 'listForKey' | 'listForKeyPrefix'>;
import type { LaneRunJournalOutcome } from '../../../domain/lane-run-journal.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';

const OWNER = 'fleet';
const REPO = 'v2';
const DIGEST = '0123456789ab';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const OTHER_HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD3 = 'fedcba987654ef0123456789abcdef0123456789';
const HEAD3_12 = 'fedcba987654';
const HEAD12 = '0123456789ab';
const NOW = '2026-11-01T12:00:00.000Z';
const DEADLINE = '2026-11-01T12:10:00.000Z';
const TIGHT_DEADLINE = '2026-11-01T12:00:03.000Z';
const SPENT = '2026-11-01T12:00:02.000Z';
const POSTER = 'premerge-bot';
const MERGED_AT = '2026-11-01T11:00:00.000Z';
const CREATED_AT = '2026-11-01T10:30:00.000Z';
const MERGE_KEY = `merge/${DIGEST}/1/${HEAD12}/merge-pr`;
const ALREADY_KEY = `merge/${DIGEST}/1/${HEAD12}/would-already-merged`;
const SUCCESSOR_MERGE = `merge/${DIGEST}/1/${HEAD3_12}/merge-pr`;
const SUCCESSOR_ALREADY = `merge/${DIGEST}/1/${HEAD3_12}/would-already-merged`;
const HEAD_OID = /^[0-9a-f]{40}$/;

let entryIdCounter = 0;
function makeEntry(overrides: Partial<MergeQueueEntryRecord> = {}): MergeQueueEntryRecord {
  return {
    version: MERGE_QUEUE_ENTRY_VERSION,
    entryId: `01JB${String(++entryIdCounter).padStart(22, '0').slice(-22)}`,
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

const verificationFake: MergeVerificationPort = {
  async readVerification() {
    return { outcome: 'unknown', reasonCode: 'no-receipt' };
  },
  async runVerification(): Promise<never> {
    throw new Error('runVerification must never be called in the shadow pass');
  },
} as unknown as MergeVerificationPort;

function makeQueue(records: readonly MergeQueueEntryRecord[]): MergeQueueRepositoryPort {
  return {
    async listMergeEntries(): Promise<readonly MergeQueueEntryRecord[]> {
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

function retroForge(overrides: Record<string, unknown> = {}): ReadForgeMergeResult {
  const contexts: MergeContextSnapshot[] = [
    {
      name: 'gate',
      state: 'SUCCESS',
      isGreen: true,
      creatorLogin: null,
      createdAtIso: CREATED_AT,
    },
    {
      name: 'premerge',
      state: 'SUCCESS',
      isGreen: true,
      creatorLogin: POSTER,
      createdAtIso: CREATED_AT,
    },
  ];
  return {
    outcome: 'ok',
    prState: 'merged',
    liveHeadSha: HEAD,
    mergeState: 'clean',
    mergedAtIso: MERGED_AT,
    contexts,
    unresolvedThreads: 0,
    ...overrides,
  } as ReadForgeMergeResult;
}

function makeIds(prefix: '01JB' | '01JC'): () => string {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(22, '0').slice(-22)}`;
}

const seedId = makeIds('01JC');

function journalRecord(
  kind: 'intent' | 'result',
  key: string,
  fields: {
    reasonCode?: string | null;
    detail?: string | null;
    linkedId?: string | null;
    outcome?: LaneRunJournalOutcome;
  } = {},
): LaneRunJournalEntryRecord {
  const result = kind === 'result';
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: seedId(),
    kind,
    key,
    runId: null,
    recordedAtIso: NOW,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: result ? (fields.outcome ?? 'dry-run') : null,
    reasonCode: result ? (fields.reasonCode ?? null) : null,
    detail: result ? (fields.detail ?? null) : null,
    grantId: null,
    state: null,
    ...(result && fields.linkedId !== undefined ? { linkedId: fields.linkedId } : {}),
  };
}

async function seed(
  journal: LaneRunJournalAdapter,
  kind: 'intent' | 'result',
  key: string,
  fields: {
    reasonCode?: string | null;
    detail?: string | null;
    linkedId?: string | null;
    outcome?: LaneRunJournalOutcome;
  } = {},
): Promise<void> {
  const appended = await journal.append(journalRecord(kind, key, fields));
  if (appended.outcome !== 'appended') {
    throw new Error(`seed refused: ${appended.reason}`);
  }
}

interface Harness {
  readonly useCase: RunMergePassUseCase;
  readonly journal: LaneRunJournalAdapter;
  readonly request: RunMergePassRequest;
  readonly forge: ForgeMergeReadPort & { calls: number };
  again(): Promise<RunMergePassResult>;
}

function harness(options: {
  forgeResult?: ReadForgeMergeResult;
  records?: readonly MergeQueueEntryRecord[];
  journal?: LaneRunJournalAdapter;
  port?: ShadowJournalPort;
  deadlineIso?: string;
  nowIso?: () => string;
  policy?: Record<string, unknown>;
} = {}): Harness {
  const journal = options.journal ?? new LaneRunJournalAdapter();
  const forge = forgeReadFake(options.forgeResult ?? retroForge());
  const ids = makeIds('01JB');
  const records = options.records ?? [makeEntry()];
  const request: RunMergePassRequest = {
    repository: { owner: OWNER, repo: REPO },
    repoDigest: DIGEST,
    projectId: 'proj-1',
    policy: makePolicy(options.policy),
    deadlineIso: options.deadlineIso ?? DEADLINE,
  };
  const port = options.port ?? journal;
  const build = (clock: () => string, deadlineIso: string) =>
    new RunMergePassUseCase({
      queue: makeQueue(records),
      forgeRead: forge,
      verification: verificationFake,
      journal: port,
      halt: haltFake,
      newUlid: ids,
      nowIso: clock,
    }).runMergePass({ ...request, deadlineIso });
  const nowIso = options.nowIso ?? (() => NOW);
  return {
    journal,
    request,
    forge,
    useCase: new RunMergePassUseCase({
      queue: makeQueue(records),
      forgeRead: forge,
      verification: verificationFake,
      journal: port,
      halt: haltFake,
      newUlid: ids,
      nowIso,
    }),
    again: () => build(() => NOW, DEADLINE),
  };
}

function expectRetro(
  row: { outcome: string | null; reasonCode: string | null; detail: string | null; linkedId?: string | null },
  head: string,
): void {
  expect(row.outcome).toBe('dry-run');
  expect(row.reasonCode).toBe('would-merge');
  expect(row.detail).toBe('retro');
  expect(row.linkedId).toBe(head);
  expect(HEAD_OID.test(typeof row.linkedId === 'string' ? row.linkedId : '')).toBe(true);
}

async function expectAlreadyMerged(journal: LaneRunJournalAdapter, key: string = ALREADY_KEY): Promise<void> {
  const already = await journal.listForKey(key);
  expect(already.map((row) => row.kind)).toEqual(['intent', 'result']);
  expect(already[1]?.outcome).toBe('dry-run');
  expect(already[1]?.reasonCode).toBe('would-already-merged');
}

describe('RunMergePassUseCase retro duplicate-key and replay', () => {
  it('completes a retro would-merge then would-already-merged on the first eligible already-merged observation', async () => {
    const pass = harness();
    const result = await pass.useCase.runMergePass(pass.request);

    expect(result.outcome).toBe('completed');
    expect(result.entries[0]?.decision).toBe('journalled');
    expect(result.entries[0]?.reasonCode).toBe('would-already-merged');
    const merge = await pass.journal.listForKey(MERGE_KEY);
    expect(merge.map((row) => row.kind)).toEqual(['intent', 'result']);
    expectRetro(merge[1]!, HEAD);
    await expectAlreadyMerged(pass.journal);
    expect(merge[0]!.entryId.localeCompare((await pass.journal.listForKey(ALREADY_KEY))[0]!.entryId)).toBeLessThan(0);
    const seen = pass.forge.calls;
    const second = await pass.again();
    expect(second.entries).toEqual([]);
    expect(pass.forge.calls).toBe(seen);
  });

  it('journals only would-already-merged when the merged head is not retro eligible', async () => {
    const pass = harness({ forgeResult: retroForge({ mergedAtIso: null }) });
    const result = await pass.useCase.runMergePass(pass.request);

    expect(result.entries[0]?.reasonCode).toBe('would-already-merged');
    expect(await pass.journal.listForKey(MERGE_KEY)).toHaveLength(0);
    await expectAlreadyMerged(pass.journal);
    const seen = pass.forge.calls;
    await pass.again();
    expect(pass.forge.calls).toBe(seen);
  });

  it('completes an open merge-pr intent as retro then writes would-already-merged when the head is eligible', async () => {
    const journal = new LaneRunJournalAdapter();
    await seed(journal, 'intent', MERGE_KEY);
    const pass = harness({ journal });
    const result = await pass.useCase.runMergePass(pass.request);

    expect(result.entries[0]?.reasonCode).toBe('would-already-merged');
    const merge = await journal.listForKey(MERGE_KEY);
    expect(merge.map((row) => row.kind)).toEqual(['intent', 'result']);
    expectRetro(merge[1]!, HEAD);
    expect(merge.filter((row) => row.reasonCode === 'shadow-intent-closed')).toHaveLength(0);
    await expectAlreadyMerged(journal);
  });

  it('closes an open merge-pr intent as shadow-intent-closed and writes would-already-merged when the head is not retro eligible', async () => {
    const journal = new LaneRunJournalAdapter();
    await seed(journal, 'intent', MERGE_KEY);
    const pass = harness({ journal, forgeResult: retroForge({ mergedAtIso: null }) });
    const result = await pass.useCase.runMergePass(pass.request);

    expect(result.entries[0]?.reasonCode).toBe('would-already-merged');
    const merge = await journal.listForKey(MERGE_KEY);
    expect(merge.map((row) => row.kind)).toEqual(['intent', 'result']);
    expect(merge[1]?.reasonCode).toBe('shadow-intent-closed');
    expect(merge[1]?.outcome).toBe('dry-run');
    expect(merge.filter((row) => row.detail === 'retro')).toHaveLength(0);
    await expectAlreadyMerged(journal);
    const seen = pass.forge.calls;
    await pass.again();
    expect(pass.forge.calls).toBe(seen);
  });

  it('re-lists after duplicate-key and completes the open merge-pr intent as retro before would-already-merged', async () => {
    const journal = new LaneRunJournalAdapter();
    await seed(journal, 'intent', MERGE_KEY);
    const seen = hideFirstMergeList(journal, MERGE_KEY);
    const pass = harness({ journal, port: seen.port });
    const result = await pass.useCase.runMergePass(pass.request);

    expect(seen.duplicateKeys()).toBe(1);
    expect(seen.mergeLists()).toBe(2);
    expect(result.entries[0]?.reasonCode).toBe('would-already-merged');
    const merge = await journal.listForKey(MERGE_KEY);
    expect(merge.map((row) => row.kind)).toEqual(['intent', 'result']);
    expectRetro(merge[1]!, HEAD);
    await expectAlreadyMerged(journal);
  });

  it('re-lists after duplicate-key and writes would-already-merged without a second retro row when a retro row is already seeded', async () => {
    const journal = new LaneRunJournalAdapter();
    await seed(journal, 'intent', MERGE_KEY);
    await seed(journal, 'result', MERGE_KEY, {
      reasonCode: 'would-merge',
      detail: 'retro',
      linkedId: HEAD,
    });
    const seen = hideFirstMergeList(journal, MERGE_KEY);
    const pass = harness({ journal, port: seen.port });
    const result = await pass.useCase.runMergePass(pass.request);

    expect(seen.duplicateKeys()).toBe(1);
    expect(seen.mergeLists()).toBe(2);
    expect(seen.retroAppends()).toBe(0);
    expect(result.entries[0]?.reasonCode).toBe('would-already-merged');
    const merge = await journal.listForKey(MERGE_KEY);
    expect(merge).toHaveLength(2);
    expect(merge.filter((row) => row.detail === 'retro')).toHaveLength(1);
    expectRetro(merge[1]!, HEAD);
    await expectAlreadyMerged(journal);
    const calls = pass.forge.calls;
    await pass.again();
    expect(pass.forge.calls).toBe(calls);
  });

  it('writes would-already-merged and no retro row when duplicate-key re-list finds only an ordinary would-merge result', async () => {
    const journal = new LaneRunJournalAdapter();
    await seedOrdinaryMerge(journal);
    const seen = hideFirstMergeList(journal, MERGE_KEY);
    const pass = harness({ journal, port: seen.port });
    const result = await pass.useCase.runMergePass(pass.request);

    expect(seen.duplicateKeys()).toBe(1);
    expect(seen.mergeLists()).toBe(2);
    expect(seen.retroAppends()).toBe(0);
    expect(result.entries[0]?.reasonCode).toBe('would-already-merged');
    const merge = await journal.listForKey(MERGE_KEY);
    expect(merge.filter((row) => row.detail === 'retro')).toHaveLength(0);
    expect(merge[1]?.detail).toBeNull();
    expect(merge[1]?.reasonCode).toBe('would-merge');
    await expectAlreadyMerged(journal);
    const calls = pass.forge.calls;
    await pass.again();
    expect(pass.forge.calls).toBe(calls);
  });

  it('writes would-already-merged and no retro row when an ordinary would-merge result already exists on the key', async () => {
    const journal = new LaneRunJournalAdapter();
    await seedOrdinaryMerge(journal);
    let mergeLists = 0;
    const port: ShadowJournalPort = {
      append: (entry) => journal.append(entry),
      async listForKey(key: string) {
        if (key === MERGE_KEY) {
          mergeLists += 1;
        }
        return journal.listForKey(key);
      },
      listForKeyPrefix: (prefix) => journal.listForKeyPrefix(prefix),
    };
    const pass = harness({ journal, port });
    const result = await pass.useCase.runMergePass(pass.request);

    expect(mergeLists).toBe(2);
    expect(result.entries[0]?.reasonCode).toBe('would-already-merged');
    const merge = await journal.listForKey(MERGE_KEY);
    expect(merge.filter((row) => row.detail === 'retro')).toHaveLength(0);
    expect(merge).toHaveLength(2);
    await expectAlreadyMerged(journal);
    const calls = pass.forge.calls;
    await pass.again();
    expect(pass.forge.calls).toBe(calls);
  });

  it('writes would-already-merged and no retro row when re-list holds only non-retro results', async () => {
    const variants: Array<{
      label: string;
      fields: {
        reasonCode: string;
        detail: string | null;
        linkedId: string | null;
        outcome: LaneRunJournalOutcome;
      };
      retroDetails: number;
    }> = [
      {
        label: 'wrong detail',
        fields: { reasonCode: 'would-merge', detail: 'live', linkedId: HEAD, outcome: 'dry-run' },
        retroDetails: 0,
      },
      {
        label: 'wrong linkedId',
        fields: { reasonCode: 'would-merge', detail: 'retro', linkedId: OTHER_HEAD, outcome: 'dry-run' },
        retroDetails: 1,
      },
      {
        label: 'wrong reasonCode',
        fields: { reasonCode: 'would-park', detail: null, linkedId: HEAD, outcome: 'dry-run' },
        retroDetails: 0,
      },
      {
        label: 'outcome not dry-run',
        fields: { reasonCode: 'would-merge', detail: null, linkedId: HEAD, outcome: 'completed' },
        retroDetails: 0,
      },
      {
        label: 'shadow-intent-closed',
        fields: { reasonCode: 'shadow-intent-closed', detail: null, linkedId: null, outcome: 'dry-run' },
        retroDetails: 0,
      },
    ];
    for (const variant of variants) {
      const journal = new LaneRunJournalAdapter();
      await seed(journal, 'intent', MERGE_KEY);
      await seed(journal, 'result', MERGE_KEY, variant.fields);
      let retroAppends = 0;
      const port: ShadowJournalPort = {
        async append(entry) {
          if (entry.kind === 'result' && entry.detail === 'retro' && entry.linkedId === HEAD) {
            retroAppends += 1;
          }
          return journal.append(entry);
        },
        listForKey: (key) => journal.listForKey(key),
        listForKeyPrefix: (prefix) => journal.listForKeyPrefix(prefix),
      };
      const pass = harness({ journal, port });
      const result = await pass.useCase.runMergePass(pass.request);

      expect(result.entries[0]?.reasonCode, variant.label).toBe('would-already-merged');
      expect(retroAppends, variant.label).toBe(0);
      const merge = await journal.listForKey(MERGE_KEY);
      expect(merge.filter((row) => row.detail === 'retro'), variant.label).toHaveLength(variant.retroDetails);
      expect(
        merge.filter((row) => row.detail === 'retro' && row.linkedId === HEAD && row.outcome === 'dry-run' && row.reasonCode === 'would-merge'),
        variant.label,
      ).toHaveLength(0);
      await expectAlreadyMerged(journal);
      const calls = pass.forge.calls;
      await pass.again();
      expect(pass.forge.calls, variant.label).toBe(calls);
    }
  });

  it('refuses retro-incomplete when re-list after already-journalled is empty', async () => {
    const journal = new LaneRunJournalAdapter();
    const seen = emptyRelist(journal, MERGE_KEY);
    const pass = harness({ journal, port: seen.port });
    const result = await pass.useCase.runMergePass(pass.request);

    expect(seen.mergeLists()).toBe(2);
    expect(result.outcome).toBe('completed');
    expect(result.entries[0]?.decision).toBe('no-action');
    expect(result.entries[0]?.reasonCode).toBe('retro-incomplete');
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(0);
    const calls = pass.forge.calls;
    await pass.again();
    expect(pass.forge.calls).toBeGreaterThan(calls);
  });

  it('returns no-action entry-failed when retro re-list throws', async () => {
    const journal = new LaneRunJournalAdapter();
    let mergeLists = 0;
    const port: ShadowJournalPort = {
      async listForKey(key: string) {
        if (key === MERGE_KEY) {
          mergeLists += 1;
          if (mergeLists === 1) {
            return [];
          }
          throw new Error('retro re-list failed');
        }
        return journal.listForKey(key);
      },
      async append(entry) {
        if (entry.kind === 'intent' && entry.key === MERGE_KEY) {
          return { outcome: 'refused', reason: 'duplicate-key', detail: null };
        }
        return journal.append(entry);
      },
      listForKeyPrefix: (prefix) => journal.listForKeyPrefix(prefix),
    };
    const pass = harness({ journal, port });
    const result = await pass.useCase.runMergePass(pass.request);

    expect(mergeLists).toBe(2);
    expect(result.outcome).toBe('completed');
    expect(result.entries[0]?.decision).toBe('no-action');
    expect(result.entries[0]?.reasonCode).toBe('entry-failed');
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(0);
    const calls = pass.forge.calls;
    await pass.again();
    expect(pass.forge.calls).toBeGreaterThan(calls);
  });

  it('returns no-action entry-failed when retro re-list returns null, non-array, hole, or getter', async () => {
    const shapes: Array<{ label: string; value: () => { list: unknown; invoked: () => boolean } }> = [
      { label: 'null', value: () => ({ list: null, invoked: () => false }) },
      {
        label: 'non-array',
        value: () => ({
          list: { length: 1, 0: { kind: 'intent', runId: null } },
          invoked: () => false,
        }),
      },
      {
        label: 'hole',
        value: () => {
          let calls = 0;
          const hole: unknown[] = [];
          hole.length = 1;
          const proto: object = {};
          Object.defineProperty(proto, '0', {
            get() {
              calls += 1;
              return { kind: 'intent', runId: null };
            },
            enumerable: true,
            configurable: true,
          });
          Object.setPrototypeOf(hole, proto);
          return { list: hole, invoked: () => calls > 0 };
        },
      },
      {
        label: 'getter element',
        value: () => {
          let calls = 0;
          const list: unknown[] = [];
          Object.defineProperty(list, '0', {
            get() {
              calls += 1;
              throw new Error('getter element');
            },
            enumerable: true,
            configurable: true,
          });
          return { list, invoked: () => calls > 0 };
        },
      },
      {
        label: 'getter field',
        value: () => {
          let calls = 0;
          const element = { outcome: null, reasonCode: null, detail: null, linkedId: null, runId: null };
          Object.defineProperty(element, 'kind', {
            get() {
              calls += 1;
              return 'intent';
            },
            enumerable: true,
            configurable: true,
          });
          return { list: [element], invoked: () => calls > 0 };
        },
      },
    ];
    for (const shape of shapes) {
      const built = shape.value();
      const seen = await runHostileRelist(built.list);
      expect(seen.reasonCode, shape.label).toBe('entry-failed');
      expect(seen.decision, shape.label).toBe('no-action');
      expect(seen.already, shape.label).toBe(0);
      expect(seen.merge, shape.label).toBe(0);
      expect(built.invoked(), shape.label).toBe(false);
      expect(seen.reread, shape.label).toBe(true);
    }
  });

  it('returns no-action entry-failed when retro re-list returns undefined, a primitive, an array-like, a throwing proxy, an enormous length, or a prototype-polluting key', async () => {
    const intent = {
      kind: 'intent',
      runId: null,
      outcome: null,
      reasonCode: null,
      detail: null,
      linkedId: null,
    };
    const shapes: Array<{ label: string; value: () => { list: unknown; invoked: () => boolean } }> = [
      { label: 'undefined', value: () => ({ list: undefined, invoked: () => false }) },
      { label: 'primitive', value: () => ({ list: 42, invoked: () => false }) },
      { label: 'string', value: () => ({ list: 'intent', invoked: () => false }) },
      {
        label: 'array-like',
        value: () => ({ list: { length: 1, 0: intent }, invoked: () => false }),
      },
      {
        label: 'wrong primitive element',
        value: () => ({ list: [1, 'nope', true], invoked: () => false }),
      },
      {
        label: 'throwing proxy',
        value: () => ({
          list: new Proxy([], {
            getOwnPropertyDescriptor() {
              throw new Error('proxy trap');
            },
          }),
          invoked: () => false,
        }),
      },
      {
        label: 'enormous length',
        value: () => {
          let calls = 0;
          const huge: unknown[] = [];
          Object.defineProperty(huge, '0', {
            get() {
              calls += 1;
              return intent;
            },
            enumerable: true,
            configurable: true,
          });
          huge.length = 100_000;
          return { list: huge, invoked: () => calls > 0 };
        },
      },
      {
        label: 'prototype-polluting key',
        value: () => {
          const element: Record<string, unknown> = { ...intent };
          Object.defineProperty(element, 'constructor', {
            value: {},
            enumerable: false,
            configurable: true,
            writable: true,
          });
          const list = [element];
          Object.defineProperty(list, '__proto__', {
            value: {},
            enumerable: true,
            configurable: true,
            writable: true,
          });
          return { list, invoked: () => false };
        },
      },
    ];
    for (const shape of shapes) {
      const built = shape.value();
      const seen = await runHostileRelist(built.list);
      expect(seen.reasonCode, shape.label).toBe('entry-failed');
      expect(seen.already, shape.label).toBe(0);
      expect(seen.merge, shape.label).toBe(0);
      expect(built.invoked(), shape.label).toBe(false);
      expect(seen.reread, shape.label).toBe(true);
    }
  });

  it('returns budget-exhausted when deadline is spent before retro re-list', async () => {
    const journal = new LaneRunJournalAdapter();
    await seed(journal, 'intent', MERGE_KEY);
    let clockSpent = false;
    let mergeLists = 0;
    let duplicateKeys = 0;
    const port: ShadowJournalPort = {
      async listForKey(key: string) {
        if (key === MERGE_KEY) {
          mergeLists += 1;
          if (mergeLists === 1) {
            return [];
          }
        }
        return journal.listForKey(key);
      },
      async append(entry) {
        const result = await journal.append(entry);
        if (entry.kind === 'intent' && entry.key === MERGE_KEY) {
          if (result.outcome === 'refused' && result.reason === 'duplicate-key') {
            duplicateKeys += 1;
          }
          clockSpent = true;
        }
        return result;
      },
      listForKeyPrefix: (prefix) => journal.listForKeyPrefix(prefix),
    };
    const pass = harness({
      journal,
      port,
      deadlineIso: TIGHT_DEADLINE,
      nowIso: () => (clockSpent ? SPENT : NOW),
    });
    const result = await pass.useCase.runMergePass(pass.request);

    expect(duplicateKeys).toBe(1);
    expect(mergeLists).toBe(1);
    expect(result.outcome).toBe('budget-exhausted');
    expect(result.reasonCode).toBeNull();
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(1);
    expect((await journal.listForKey(MERGE_KEY))[0]?.kind).toBe('intent');
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(0);
    const calls = pass.forge.calls;
    await pass.again();
    expect(pass.forge.calls).toBeGreaterThan(calls);
  });

  it('returns budget-exhausted when deadline is spent before retro completion append', async () => {
    const journal = new LaneRunJournalAdapter();
    await seed(journal, 'intent', MERGE_KEY);
    let clockSpent = false;
    let mergeLists = 0;
    let resultAppends = 0;
    const port: ShadowJournalPort = {
      async listForKey(key: string) {
        if (key === MERGE_KEY) {
          mergeLists += 1;
          if (mergeLists === 1) {
            return [];
          }
          const rows = await journal.listForKey(key);
          clockSpent = true;
          return rows;
        }
        return journal.listForKey(key);
      },
      async append(entry) {
        if (entry.kind === 'result' && entry.key === MERGE_KEY) {
          resultAppends += 1;
        }
        return journal.append(entry);
      },
      listForKeyPrefix: (prefix) => journal.listForKeyPrefix(prefix),
    };
    const pass = harness({
      journal,
      port,
      deadlineIso: TIGHT_DEADLINE,
      nowIso: () => (clockSpent ? SPENT : NOW),
    });
    const result = await pass.useCase.runMergePass(pass.request);

    expect(mergeLists).toBe(2);
    expect(resultAppends).toBe(0);
    expect(result.outcome).toBe('budget-exhausted');
    expect(result.reasonCode).toBeNull();
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(1);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(0);
    const calls = pass.forge.calls;
    await pass.again();
    expect(pass.forge.calls).toBeGreaterThan(calls);
  });

  it('returns no-action refusal when retro completion append is refused', async () => {
    // duplicate-key stays mapped to already-journalled. Either refusal must
    // still leave would-already-merged unwritten.
    for (const reason of ['invalid-entry', 'duplicate-key'] as const) {
      const journal = new LaneRunJournalAdapter();
      await seed(journal, 'intent', MERGE_KEY);
      const port: ShadowJournalPort = {
        listForKey: (key) => journal.listForKey(key),
        listForKeyPrefix: (prefix) => journal.listForKeyPrefix(prefix),
        async append(entry) {
          if (entry.kind === 'result' && entry.key === MERGE_KEY && entry.reasonCode === 'would-merge') {
            return { outcome: 'refused', reason, detail: null };
          }
          return journal.append(entry);
        },
      };
      const pass = harness({ journal, port });
      const result = await pass.useCase.runMergePass(pass.request);

      expect(result.outcome, reason).toBe('completed');
      expect(result.entries[0]?.decision, reason).toBe('no-action');
      expect(result.entries[0]?.reasonCode, reason).toBe(
        reason === 'duplicate-key' ? 'already-journalled' : reason,
      );
      expect(await journal.listForKey(MERGE_KEY), reason).toHaveLength(1);
      expect(await journal.listForKey(ALREADY_KEY), reason).toHaveLength(0);
      const calls = pass.forge.calls;
      await pass.again();
      expect(pass.forge.calls, reason).toBeGreaterThan(calls);
    }
  });

  it('returns no-action entry-failed when retro completion append throws', async () => {
    const journal = new LaneRunJournalAdapter();
    await seed(journal, 'intent', MERGE_KEY);
    const port: ShadowJournalPort = {
      listForKey: (key) => journal.listForKey(key),
      listForKeyPrefix: (prefix) => journal.listForKeyPrefix(prefix),
      async append(entry) {
        if (entry.kind === 'result' && entry.key === MERGE_KEY) {
          throw new Error('retro completion append failed');
        }
        return journal.append(entry);
      },
    };
    const pass = harness({ journal, port });
    const result = await pass.useCase.runMergePass(pass.request);

    expect(result.outcome).toBe('completed');
    expect(result.entries[0]?.decision).toBe('no-action');
    expect(result.entries[0]?.reasonCode).toBe('entry-failed');
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(1);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(0);
    const calls = pass.forge.calls;
    await pass.again();
    expect(pass.forge.calls).toBeGreaterThan(calls);
  });

  it('closes an open merge-pr intent as shadow-intent-closed when would-already-merged is already journalled and writes no would-merge', async () => {
    const journal = new LaneRunJournalAdapter();
    await seed(journal, 'intent', ALREADY_KEY);
    await seed(journal, 'result', ALREADY_KEY, { reasonCode: 'would-already-merged', detail: null });
    await seed(journal, 'intent', MERGE_KEY);
    // No prefix read: the shadow skip would drop the entry before the close.
    const port: ShadowJournalPort = {
      append: (entry) => journal.append(entry),
      listForKey: (key) => journal.listForKey(key),
    };
    const pass = harness({ journal, port });
    const result = await pass.useCase.runMergePass(pass.request);

    expect(pass.forge.calls).toBe(1);
    expect(result.entries[0]?.decision).toBe('no-action');
    expect(result.entries[0]?.reasonCode).toBe('already-journalled');
    const merge = await journal.listForKey(MERGE_KEY);
    expect(merge.map((row) => row.kind)).toEqual(['intent', 'result']);
    expect(merge[1]?.reasonCode).toBe('shadow-intent-closed');
    expect(merge.filter((row) => row.reasonCode === 'would-merge')).toHaveLength(0);
    expect(merge.filter((row) => row.detail === 'retro')).toHaveLength(0);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(2);
  });

  it('returns the close refusal and writes no would-already-merged when closing an open merge-pr intent is refused', async () => {
    for (const reason of ['invalid-entry', 'duplicate-key'] as const) {
      const journal = new LaneRunJournalAdapter();
      await seed(journal, 'intent', MERGE_KEY);
      const port: ShadowJournalPort = {
        listForKey: (key) => journal.listForKey(key),
        listForKeyPrefix: (prefix) => journal.listForKeyPrefix(prefix),
        async append(entry) {
          if (entry.kind === 'result' && entry.reasonCode === 'shadow-intent-closed' && entry.key === MERGE_KEY) {
            return { outcome: 'refused' as const, reason, detail: null };
          }
          return journal.append(entry);
        },
      };
      const pass = harness({
        journal,
        port,
        forgeResult: retroForge({ mergedAtIso: null }),
      });
      const result = await pass.useCase.runMergePass(pass.request);

      expect(result.outcome, reason).toBe('completed');
      expect(result.entries[0]?.decision, reason).toBe('no-action');
      expect(result.entries[0]?.reasonCode, reason).toBe(
        reason === 'duplicate-key' ? 'already-journalled' : reason,
      );
      expect(await journal.listForKey(ALREADY_KEY), reason).toHaveLength(0);
      const merge = await journal.listForKey(MERGE_KEY);
      expect(merge, reason).toHaveLength(1);
      expect(merge[0]?.kind, reason).toBe('intent');
      const calls = pass.forge.calls;
      await pass.again();
      expect(pass.forge.calls, reason).toBeGreaterThan(calls);
    }
  });

  it('preserves an open merge-pr intent on a moved merged successor head, completes it as retro, and writes would-already-merged', async () => {
    const journal = new LaneRunJournalAdapter();
    await seed(journal, 'intent', SUCCESSOR_MERGE);
    const pass = harness({
      journal,
      forgeResult: retroForge({ liveHeadSha: HEAD3 }),
    });
    const result = await pass.useCase.runMergePass(pass.request);

    expect(result.entries[0]?.decision).toBe('journalled');
    expect(result.entries[0]?.reasonCode).toBe('would-already-merged');
    expect(await journal.listForKey(MERGE_KEY)).toHaveLength(0);
    expect(await journal.listForKey(ALREADY_KEY)).toHaveLength(0);
    const superseded = await journal.listForKey(`merge/${DIGEST}/1/${HEAD12}/would-supersede`);
    expect(superseded.map((row) => row.kind)).toEqual(['intent', 'result']);
    const merge = await journal.listForKey(SUCCESSOR_MERGE);
    expect(merge.map((row) => row.kind)).toEqual(['intent', 'result']);
    expectRetro(merge[1]!, HEAD3);
    expect(merge.filter((row) => row.reasonCode === 'shadow-intent-closed')).toHaveLength(0);
    await expectAlreadyMerged(journal, SUCCESSOR_ALREADY);
  });
});

async function seedOrdinaryMerge(journal: LaneRunJournalAdapter): Promise<void> {
  await seed(journal, 'intent', MERGE_KEY);
  await seed(journal, 'result', MERGE_KEY, {
    reasonCode: 'would-merge',
    detail: null,
    linkedId: HEAD,
  });
}

function hideFirstMergeList(journal: LaneRunJournalAdapter, key: string): {
  port: ShadowJournalPort;
  mergeLists: () => number;
  duplicateKeys: () => number;
  retroAppends: () => number;
} {
  let mergeLists = 0;
  let duplicateKeys = 0;
  let retroAppends = 0;
  const port: ShadowJournalPort = {
    async listForKey(asked: string) {
      if (asked === key) {
        mergeLists += 1;
        if (mergeLists === 1) {
          return [];
        }
      }
      return journal.listForKey(asked);
    },
    async append(entry) {
      if (entry.kind === 'result' && entry.detail === 'retro') {
        retroAppends += 1;
      }
      const result = await journal.append(entry);
      if (result.outcome === 'refused' && result.reason === 'duplicate-key') {
        duplicateKeys += 1;
      }
      return result;
    },
    listForKeyPrefix: (prefix) => journal.listForKeyPrefix(prefix),
  };
  return {
    port,
    mergeLists: () => mergeLists,
    duplicateKeys: () => duplicateKeys,
    retroAppends: () => retroAppends,
  };
}

function emptyRelist(journal: LaneRunJournalAdapter, key: string): {
  port: ShadowJournalPort;
  mergeLists: () => number;
} {
  let mergeLists = 0;
  const port: ShadowJournalPort = {
    async listForKey(asked: string) {
      if (asked === key) {
        mergeLists += 1;
        return [];
      }
      return journal.listForKey(asked);
    },
    async append(entry) {
      if (entry.kind === 'intent' && entry.key === key) {
        return { outcome: 'refused', reason: 'duplicate-key', detail: null };
      }
      return journal.append(entry);
    },
    listForKeyPrefix: (prefix) => journal.listForKeyPrefix(prefix),
  };
  return { port, mergeLists: () => mergeLists };
}

async function runHostileRelist(list: unknown): Promise<{
  reasonCode: string | null;
  decision: string;
  already: number;
  merge: number;
  reread: boolean;
}> {
  const journal = new LaneRunJournalAdapter();
  let mergeLists = 0;
  const port: ShadowJournalPort = {
    async listForKey(key: string) {
      if (key === MERGE_KEY) {
        mergeLists += 1;
        if (mergeLists === 1) {
          return [];
        }
        return list as readonly LaneRunJournalEntryRecord[];
      }
      return journal.listForKey(key);
    },
    async append(entry) {
      if (entry.kind === 'intent' && entry.key === MERGE_KEY) {
        return { outcome: 'refused', reason: 'duplicate-key', detail: null };
      }
      return journal.append(entry);
    },
    listForKeyPrefix: (prefix) => journal.listForKeyPrefix(prefix),
  };
  const pass = harness({ journal, port });
  const result = await pass.useCase.runMergePass(pass.request);
  const calls = pass.forge.calls;
  await pass.again();
  return {
    reasonCode: result.entries[0]?.reasonCode ?? null,
    decision: result.entries[0]?.decision ?? '',
    already: (await journal.listForKey(ALREADY_KEY)).length,
    merge: (await journal.listForKey(MERGE_KEY)).length,
    reread: pass.forge.calls > calls,
  };
}
