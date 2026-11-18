// DT9a: the shadow merge pass — one repository, keyed dry-run journal, no forge write.
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
import type { MergeNotificationPort } from '../../ports/out/MergeNotificationPort.out-port.js';
import type { MergeVetoPort } from '../../ports/out/MergeVetoPort.out-port.js';
import type { MergeVetoStatePort } from '../../ports/out/MergeVetoStatePort.out-port.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { MergeQueueRepositoryAdapter, mergeQueueRepositoryDigest } from '../../../infrastructure/adapters/MergeQueueRepositoryAdapter.adapter.js';
import {
  MERGE_QUEUE_ENTRY_VERSION,
  MERGE_QUEUE_ENTRY_V2_VERSION,
} from '../../../domain/merge-queue-records.js';
import type { MergeQueueEntryRecord } from '../../../domain/merge-queue-records.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type { MergeRepoPolicy } from '../../../domain/merge-queue-decider.js';

const OWNER = 'fleet';
const REPO = 'v2';
const DIGEST = '0123456789ab';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const HEAD3 = 'fedcba987654ef0123456789abcdef0123456789';
const HEAD3_12 = 'fedcba987654';
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
  halt: Pick<ConductorHaltPort, 'read'> = haltFake,
  extras: {
    queueWriter?: Pick<MergeQueueRepositoryPort, 'applyMergeTransition'>;
    notifier?: Pick<MergeNotificationPort, 'notifyMergeEvent'>;
    vetoState?: Pick<MergeVetoStatePort, 'readMergeVetoState'>;
    vetoAdvice?: Pick<MergeVetoPort, 'adviseMergeVeto'>;
  } = {},
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
    halt,
    newUlid: () => `01JB${String(++ulid).padStart(22, '0').slice(-22)}`,
    nowIso: () => NOW,
    ...extras,
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

function queueWriterSpy(): { calls: number; adapter: Pick<MergeQueueRepositoryPort, 'applyMergeTransition'> } {
  type TransitionInput = Parameters<Pick<MergeQueueRepositoryPort, 'applyMergeTransition'>['applyMergeTransition']>[0];
  type TransitionResult = Awaited<ReturnType<Pick<MergeQueueRepositoryPort, 'applyMergeTransition'>['applyMergeTransition']>>;
  const spy = {
    calls: 0,
    adapter: {
      async applyMergeTransition(input: TransitionInput): Promise<TransitionResult> {
        spy.calls += 1;
        return { outcome: 'applied', entries: [input.next], record: input.next, successor: null };
      },
    },
  };
  return spy;
}

function recordingQueueWriter(): {
  transitions: Array<{ next: MergeQueueEntryRecord; successor: MergeQueueEntryRecord | null }>;
  adapter: Pick<MergeQueueRepositoryPort, 'applyMergeTransition'>;
} {
  type TransitionInput = Parameters<Pick<MergeQueueRepositoryPort, 'applyMergeTransition'>['applyMergeTransition']>[0];
  type TransitionResult = Awaited<ReturnType<Pick<MergeQueueRepositoryPort, 'applyMergeTransition'>['applyMergeTransition']>>;
  const recorder = {
    transitions: [] as Array<{ next: MergeQueueEntryRecord; successor: MergeQueueEntryRecord | null }>,
    adapter: {
      async applyMergeTransition(input: TransitionInput): Promise<TransitionResult> {
        recorder.transitions.push({ next: input.next, successor: input.successor });
        return { outcome: 'applied', entries: [input.next], record: input.next, successor: null };
      },
    },
  };
  return recorder;
}

function notifierSpy(): { calls: number; adapter: { notifyMergeEvent(): Promise<{ outcome: 'notified' }> } } {
  const spy = {
    calls: 0,
    adapter: {
      async notifyMergeEvent() {
        spy.calls += 1;
        return { outcome: 'notified' as const };
      },
    },
  };
  return spy;
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

function makeChainEntry(): MergeQueueEntryRecord {
  return makeEntry({ version: MERGE_QUEUE_ENTRY_V2_VERSION, baseBranch: 'chain/example' });
}

describe('RunMergePassUseCase observed base (OG-7)', () => {
  // A chain entry is never selected by runPass today: orderMergeQueue/findMergeQueueHead
  // default an omitted base to DEFAULT_BASE_BRANCH (CO3b review fixes, 7748fd4d), and
  // runPass calls them with no base (OG-7 fix round: runPass is unchanged from
  // origin/main, by the brief's own rule). observedBaseFact is still correctly wired in
  // gatherFacts, but it has no effect for a chain entry until a later unit makes runPass
  // base-partition-aware; that gap is tracked separately and is out of OG-7's scope. The
  // decider's own chain-base behaviour (base-unobserved, base-mismatch, would-merge,
  // checks) is pinned directly against decideMergeStep in merge-queue-decider.test.ts
  // (the observed base gate block, D1-D3), independent of this selection gap.
  const laneSoloChainCases: ReadonlyArray<[string, ReadForgeMergeResult]> = [
    ["the entry's own base", { ...greenForge, baseRef: 'chain/example' }],
    ['no base', greenForge],
    ['main', { ...greenForge, baseRef: 'main' }],
    [
      "the entry's own base with a failed gate",
      {
        ...greenForge,
        baseRef: 'chain/example',
        contexts: [
          { name: 'gate', state: 'FAILURE', isGreen: false, creatorLogin: null },
          { name: 'premerge', state: 'SUCCESS', isGreen: true, creatorLogin: POSTER },
        ],
      },
    ],
  ];

  it.each(laneSoloChainCases)(
    'a lone chain entry is excluded from the pass before any forge read, whatever the forge would report as the base (%s)',
    async (_label, forgeResult) => {
      const { useCase, deps, request } = makeUseCase([makeChainEntry()], forgeResult);

      const result = await useCase.runMergePass(request);

      expect(result.entries).toHaveLength(0);
      expect(deps.forgeRead.calls).toBe(0);
      expect(await journalOf(deps.journal)).toHaveLength(0);
    },
  );

  it('a main entry read on chain/example waits base-mismatch and journals nothing', async () => {
    const { useCase, deps, request } = makeUseCase([makeEntry()], {
      ...greenForge,
      baseRef: 'chain/example',
    });

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('no-action');
    expect(result.entries[0].reasonCode).toBe('base-mismatch');
    expect(await journalOf(deps.journal)).toHaveLength(0);
  });

  it('a main entry read on main journals would-merge', async () => {
    const { useCase, request } = makeUseCase([makeEntry()], {
      ...greenForge,
      baseRef: 'main',
    });

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('journalled');
    expect(result.entries[0].reasonCode).toBe('would-merge');
  });

  it.each([42, null, '', 'Main', 'chain/Example'])(
    'passes a malformed base %s through, and the decider waits facts-inconsistent',
    async (value) => {
      const { useCase, deps, request } = makeUseCase([makeEntry()], {
        ...greenForge,
        baseRef: value as unknown as string,
      });

      const result = await useCase.runMergePass(request);

      expect(result.entries[0].decision).toBe('no-action');
      expect(result.entries[0].reasonCode).toBe('facts-inconsistent');
      expect(await journalOf(deps.journal)).toHaveLength(0);
    },
  );
});

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

  it('a shadow tick on a veto-hold PR leaves the queue unchanged and journals would-park', async () => {
    // Owner decision A+ (2026-11-18): the `veto-hold` park is the only park the
    // conductor treats as final, so shadow suppresses it and journals would-park.
    const writer = queueWriterSpy();
    const entry = makeEntry({
      state: 'parked',
      reason: 'veto-hold',
      verifiedHeadOid: HEAD,
      verifiedBy: 'contexts',
      policyRevision: 'rev-1',
      veto: { outcome: 'hold-for-human', confidence: 0.9, mode: 'live', decisionReceiptId: null },
    });
    const { useCase, deps, request } = makeUseCase([entry], greenForge, { veto: { mode: 'live' } }, haltFake, {
      queueWriter: writer.adapter,
    });

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('journalled');
    expect(result.entries[0].reasonCode).toBe('would-park');
    expect(result.entries[0].journalKey).toBe(`merge/${DIGEST}/1/${HEAD12}/would-park`);
    expect(writer.calls).toBe(0);
    expect(entry.state).toBe('parked');
    const after = await deps.journal.listForKey(`merge/${DIGEST}/1/${HEAD12}/would-park`);
    expect(after.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(after[1].outcome).toBe('dry-run');
    expect(after[1].reasonCode).toBe('would-park');
    expect(after[1].detail).toBe('veto-hold');
  });

  it('a shadow park with a real notifier persists and does not notify (silent)', async () => {
    // Owner decision A+ (2026-11-18): an ordinary park persists as on main,
    // but SHADOW IS SILENT — the notification step is skipped and journalled
    // as would-notify, so a persisted shadow park never notifies anyone.
    const writer = queueWriterSpy();
    const notifier = notifierSpy();
    const { useCase, deps, request } = makeUseCase([makeEntry()], {
      outcome: 'unavailable',
      code: 'forge-error',
      reason: 'gh failed',
    }, {}, haltFake, { queueWriter: writer.adapter, notifier: notifier.adapter });

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('recorded');
    expect(result.entries[0].reasonCode).toBe('forge-error');
    expect(writer.calls).toBe(1);
    expect(notifier.calls).toBe(0);
    const after = await deps.journal.listForKey(`merge/${DIGEST}/1/${HEAD12}/would-notify`);
    expect(after.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(after[1].outcome).toBe('dry-run');
    expect(after[1].reasonCode).toBe('would-notify');
    expect(after[1].detail).toBe('parked');
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

  it('a moved live head is superseded in memory only: would-supersede then would-merge on the new head', async () => {
    // SH24a: the supersession is never persisted; the in-memory successor
    // re-runs the decider in the same pass and reaches would-merge, whose
    // result carries the successor's own 40-hex head as its linkedId.
    // Fix round 2 (Fable): asserted against a RECORDING queue writer — on
    // main the supersession went through `applyMergeTransition`, so this
    // test fails there and passes here only because nothing is written.
    const moved: ReadForgeMergeResult = { ...greenForge, liveHeadSha: HEAD3 };
    const writer = recordingQueueWriter();
    const { useCase, deps, request } = makeUseCase([makeEntry()], moved, {}, haltFake, {
      queueWriter: writer.adapter,
    });

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('journalled');
    expect(result.entries[0].reasonCode).toBe('would-merge');
    expect(result.entries[0].journalKey).toBe(`merge/${DIGEST}/1/${HEAD3_12}/merge-pr`);
    // The writer received no drop and no supersede — in fact nothing at all.
    expect(writer.transitions).toEqual([]);
    const superseded = await deps.journal.listForKey(`merge/${DIGEST}/1/${HEAD12}/would-supersede`);
    expect(superseded.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(superseded[1].outcome).toBe('dry-run');
    expect(superseded[1].reasonCode).toBe('would-supersede');
    expect(superseded[1].detail).toBe(null);
    const merged = await deps.journal.listForKey(`merge/${DIGEST}/1/${HEAD3_12}/merge-pr`);
    expect(merged.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(merged[1].reasonCode).toBe('would-merge');
    // Fix round 2 (Fable): the journaled record names the SUCCESSOR, not the
    // original entry — its key carries the successor's head12 and its
    // linkedId is the successor's own 40-hex head.
    expect(merged[0].key).toBe(`merge/${DIGEST}/1/${HEAD3_12}/merge-pr`);
    expect(merged[1].linkedId).toBe(HEAD3);
    expect(merged[1].linkedId).not.toBe(HEAD);
    expect(deps.forgeRead.calls).toBe(2);
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

  it('waits with reason halted and records no journal entry when halted', async () => {
    // OG-15: a halted marker fails the whole pass closed, entry by entry.
    const halted: Pick<ConductorHaltPort, 'read'> = {
      async read() {
        return { state: 'halted', record: {} } as unknown as ConductorHaltState;
      },
    };
    const { useCase, deps, request } = makeUseCase([makeEntry()], greenForge, {}, halted);

    const result = await useCase.runMergePass(request);

    expect(result.outcome).toBe('completed');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].decision).toBe('no-action');
    expect(result.entries[0].reasonCode).toBe('halted');
    expect(result.entries[0].journalKey).toBe(null);
    expect(await journalOf(deps.journal)).toHaveLength(0);
  });

  it('treats an unreadable or throwing halt read as halted', async () => {
    // Fail closed: `unreadable` and a throw both read as halted, never as clear.
    for (const answer of [{ state: 'unreadable' } as ConductorHaltState, new Error('store gone')]) {
      const halt: Pick<ConductorHaltPort, 'read'> = {
        async read(): Promise<ConductorHaltState> {
          if (answer instanceof Error) {
            throw answer;
          }
          return answer;
        },
      };
      const { useCase, deps, request } = makeUseCase([makeEntry()], greenForge, {}, halt);

      const result = await useCase.runMergePass(request);

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].decision).toBe('no-action');
      expect(result.entries[0].reasonCode).toBe('halted');
      expect(await journalOf(deps.journal)).toHaveLength(0);
    }
  });

  it('re-reads the halt before each entry: a halt raised after the first entry stops the second', async () => {
    let reads = 0;
    const flippingHalt: Pick<ConductorHaltPort, 'read'> = {
      async read(): Promise<ConductorHaltState> {
        reads += 1;
        if (reads === 1) {
          return haltClear;
        }
        return { state: 'halted', record: { version: 1, halted: true, changedAtIso: NOW } } as unknown as ConductorHaltState;
      },
    };
    const { useCase, deps, request } = makeUseCase(
      [
        makeEntry(),
        makeEntry({ pullRequest: 2, enqueuedAtIso: '2026-11-01T10:05:00.000Z' }),
      ],
      greenForge,
      {},
      flippingHalt,
    );

    const result = await useCase.runMergePass(request);

    expect(result.outcome).toBe('completed');
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].decision).toBe('journalled');
    expect(result.entries[0].reasonCode).toBe('would-merge');
    expect(result.entries[1].decision).toBe('no-action');
    expect(result.entries[1].reasonCode).toBe('halted');
    expect(result.entries[1].journalKey).toBe(null);
    expect(await deps.journal.listForKey(`merge/${DIGEST}/2/${HEAD12}/merge-pr`)).toHaveLength(0);
    expect(reads).toBe(2);
  });

  it('reads an off-contract halt answer as halted', async () => {
    const garbageHalt: Pick<ConductorHaltPort, 'read'> = {
      async read() {
        return { state: 'garbage' } as unknown as ConductorHaltState;
      },
    };
    const { useCase, deps, request } = makeUseCase([makeEntry()], greenForge, {}, garbageHalt);

    const result = await useCase.runMergePass(request);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].decision).toBe('no-action');
    expect(result.entries[0].reasonCode).toBe('halted');
    expect(await journalOf(deps.journal)).toHaveLength(0);
  });

  it('reads a missing halt dependency as halted', async () => {
    let ulid = 0;
    const useCase = new RunMergePassUseCase({
      queue: queueFake([makeEntry()]),
      forgeRead: forgeReadFake(greenForge),
      verification: verificationFake(),
      journal: new LaneRunJournalAdapter() as LaneRunJournalPort,
      nowIso: () => NOW,
      newUlid: () => `01JB${String(++ulid).padStart(22, '0').slice(-22)}`,
      halt: undefined as unknown as Pick<ConductorHaltPort, 'read'>,
    });
    const request: RunMergePassRequest = {
      repository: { owner: OWNER, repo: REPO },
      repoDigest: DIGEST,
      projectId: 'proj-1',
      policy: makePolicy(),
      deadlineIso: DEADLINE,
    };

    const result = await useCase.runMergePass(request);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].decision).toBe('no-action');
    expect(result.entries[0].reasonCode).toBe('halted');
  });
});

describe('RunMergePassUseCase shadow mode never mutates the queue (SH24a)', () => {
  function exhaustedForge(): ReadForgeMergeResult {
    return {
      outcome: 'unavailable',
      code: 'forge-error',
      reason: 'gh failed',
    } as ReadForgeMergeResult;
  }

  function closedForge(): ReadForgeMergeResult {
    return { ...greenForge, prState: 'closed' } as ReadForgeMergeResult;
  }

  function mergedForge(): ReadForgeMergeResult {
    return { ...greenForge, prState: 'merged' } as ReadForgeMergeResult;
  }

  it.each([
    ['a conflicting PR', { ...greenForge, mergeState: 'dirty' } as unknown as ReadForgeMergeResult, 'conflict'],
    ['a closed PR', closedForge(), 'closed'],
  ])('a shadow tick on %s leaves merge-queue.json byte-identical and journals would-drop', async (
    _label,
    forgeResult,
    detail,
  ) => {
    // Luna (minor): the byte-identity check reads the queue FILE's bytes, not
    // an in-memory copy, so a persisted shadow drop can never hide here.
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-merge-queue-bytes-'));
    try {
      const entry = makeEntry();
      const queue = new MergeQueueRepositoryAdapter({ stateDir });
      // The file-backed adapter computes the repoDigest from the repository,
      // so the pass's request must carry the same digest to select the entry.
      const repoDigest = mergeQueueRepositoryDigest({ owner: OWNER, repo: REPO });
      // The file-backed adapter refuses a stale deadline, so the enqueue and
      // the pass both carry a fresh one (the fake queue in `makeUseCase`
      // never checks it).
      const freshDeadline = new Date(Date.now() + 60_000).toISOString();
      const enqueued = await queue.enqueueMergeEntry({
        repository: { owner: OWNER, repo: REPO },
        pullRequest: entry.pullRequest,
        headOid: entry.headOid,
        tier: entry.tier,
        enqueuedBy: 'conductor',
        runId: null,
        entryId: entry.entryId,
        successorEntryId: '01JB0000000000000000000000',
        enqueuedAtIso: entry.enqueuedAtIso,
        deadlineIso: freshDeadline,
      });
      expect(enqueued.outcome).toBe('created');
      const queueFile = path.join(stateDir, 'merge-queue.json');
      const before = await fs.readFile(queueFile, 'utf8');

      const writer = queueWriterSpy();
      const notifier = notifierSpy();
      const journal = new LaneRunJournalAdapter();
      let ulid = 0;
      const useCase = new RunMergePassUseCase({
        queue,
        forgeRead: forgeReadFake(forgeResult),
        verification: verificationFake(),
        journal: journal as LaneRunJournalPort,
        halt: haltFake,
        newUlid: () => `01JB${String(++ulid).padStart(22, '0').slice(-22)}`,
        nowIso: () => NOW,
        queueWriter: writer.adapter,
        notifier: notifier.adapter,
      });
      const request: RunMergePassRequest = {
        repository: { owner: OWNER, repo: REPO },
        repoDigest,
        projectId: 'proj-1',
        policy: makePolicy(),
        deadlineIso: freshDeadline,
      };

      const result = await useCase.runMergePass(request);

      expect(result.outcome).toBe('completed');
      expect(result.entries[0].decision).toBe('journalled');
      expect(result.entries[0].reasonCode).toBe('would-drop');
      expect(result.entries[0].journalKey).toBe(`merge/${repoDigest}/1/${HEAD12}/would-drop`);
      expect(writer.calls).toBe(0);
      expect(notifier.calls).toBe(0);
      // The queue file's bytes are exactly what the tick found.
      expect(await fs.readFile(queueFile, 'utf8')).toBe(before);
      const after = await journal.listForKey(`merge/${repoDigest}/1/${HEAD12}/would-drop`);
      expect(after.map((entry) => entry.kind)).toEqual(['intent', 'result']);
      expect(after[1].outcome).toBe('dry-run');
      expect(after[1].reasonCode).toBe('would-drop');
      expect(after[1].detail).toBe(detail);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it('a shadow tick on a forge-confirmed merged PR journals would-already-merged', async () => {
    const writer = queueWriterSpy();
    const { useCase, deps, request } = makeUseCase([makeEntry()], mergedForge(), {}, haltFake, {
      queueWriter: writer.adapter,
    });

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('journalled');
    expect(result.entries[0].reasonCode).toBe('would-already-merged');
    expect(writer.calls).toBe(0);
    const after = await deps.journal.listForKey(`merge/${DIGEST}/1/${HEAD12}/would-already-merged`);
    expect(after.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(after[1].outcome).toBe('dry-run');
    expect(after[1].reasonCode).toBe('would-already-merged');
    expect(after[1].detail).toBe(null);
  });

  it('a shadow tick on a green entry with a macOS procedure persists the ready entry as on main', async () => {
    // Owner decision A+ (2026-11-18): enter-ready persists as on main, also
    // under a shadow policy. The first decision is enter ready ('contexts');
    // the persisted ready record still owes the procedure row, so the second
    // decision is enter ready ('procedure') and the pass reports recorded.
    const journal = new LaneRunJournalAdapter();
    const writer = queueWriterSpy();
    const verification = {
      calls: 0,
      async readVerification() {
        return { outcome: 'verified', receiptHeadOid: HEAD } as MergeVerificationResult;
      },
      async runVerification(): Promise<MergeVerificationResult> {
        throw new Error('runVerification must never be called in DT9a');
      },
    };
    let ulid = 0;
    const useCase = new RunMergePassUseCase({
      queue: queueFake([makeEntry()]),
      forgeRead: forgeReadFake(greenForge),
      verification: verification as unknown as MergeVerificationPort & { calls: number },
      journal: journal as LaneRunJournalPort,
      halt: haltFake,
      newUlid: () => `01JB${String(++ulid).padStart(22, '0').slice(-22)}`,
      nowIso: () => NOW,
      queueWriter: writer.adapter,
    });
    const request: RunMergePassRequest = {
      repository: { owner: OWNER, repo: REPO },
      repoDigest: DIGEST,
      projectId: 'proj-1',
      policy: makePolicy({ macosProcedure: 'macos-procedure' }),
      deadlineIso: DEADLINE,
    };

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('recorded');
    expect(result.entries[0].reasonCode).toBe('enter-ready');
    expect(writer.calls).toBe(1);
    expect(await journal.listForKey(`merge/${DIGEST}/1/${HEAD12}/would-ready`)).toHaveLength(0);
  });

  it('a shadow tick with an advisory veto records the veto row as on main', async () => {
    // Owner decision A+ (2026-11-18): the shadow-veto record persists as on
    // main, so the veto ports are called and the row is written; the pass
    // reports no-action / veto and no merge intent is journalled this tick.
    const writer = queueWriterSpy();
    const calls = { state: 0, advice: 0 };
    const vetoState = {
      async readMergeVetoState(): Promise<unknown> {
        calls.state += 1;
        return {
          status: 'read',
          state: {
            tier: '0', title: 'A change', changedPaths: ['packages/x/a.ts'], additions: 10, deletions: 2,
            hardToUndo: 'no', fixRounds: 0, reviewerFamilies: ['gate'], replyResolvedThreads: 0,
            majorBlockerFindings: 0, headChangedAfterReview: false,
          },
        };
      },
    };
    const vetoAdvice = {
      async adviseMergeVeto(): Promise<never> {
        calls.advice += 1;
        throw new Error('vetoAdvice threw (the pass must treat it as unknown)');
      },
    };
    const { useCase, deps, request } = makeUseCase([makeEntry()], greenForge, { veto: { mode: 'shadow' } }, haltFake, {
      queueWriter: writer.adapter,
      vetoState: vetoState as Pick<MergeVetoStatePort, 'readMergeVetoState'>,
      vetoAdvice: vetoAdvice as Pick<MergeVetoPort, 'adviseMergeVeto'>,
    });

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('no-action');
    expect(result.entries[0].reasonCode).toBe('veto');
    expect(calls.state).toBe(1);
    expect(calls.advice).toBe(1);
    // Two writes, as on main: the ready entry is recorded first, then the
    // advisory veto row is stored behind its own CAS write.
    expect(writer.calls).toBe(2);
    expect(await deps.journal.listForKey(`merge/${DIGEST}/1/${HEAD12}/merge-pr`)).toHaveLength(0);
  });

  it('an interrupted would-drop intent is completed, not closed as shadow-intent-closed', async () => {
    const { useCase, deps, request } = makeUseCase([makeEntry()], closedForge());
    const key = `merge/${DIGEST}/1/${HEAD12}/would-drop`;
    await deps.journal.append({
      version: 1, entryId: '01JB0000000000000000000099', kind: 'intent', key, runId: null,
      recordedAtIso: NOW, mode: null, expectedRevision: null, mintedId: null, outcome: null,
      reasonCode: null, detail: null, grantId: null, state: null,
    } as LaneRunJournalEntryRecord);

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('journalled');
    expect(result.entries[0].reasonCode).toBe('would-drop');
    const after = await deps.journal.listForKey(key);
    expect(after.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(after[1].outcome).toBe('dry-run');
    expect(after[1].reasonCode).toBe('would-drop');
    expect(after[1].detail).toBe('closed');
  });

  it('a live tick on an exhausted PR still drops through the queue writer and the notifier', async () => {
    const writer = queueWriterSpy();
    const notifier = notifierSpy();
    const { useCase, deps, request } = makeUseCase(
      [makeEntry({ attempt: 9 })],
      exhaustedForge(),
      { shadow: false },
      haltFake,
      { queueWriter: writer.adapter, notifier: notifier.adapter },
    );

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('recorded');
    expect(result.entries[0].reasonCode).toBe('forge-error-exhausted');
    expect(writer.calls).toBe(1);
    expect(notifier.calls).toBe(1);
    expect(await deps.journal.listForKey(`merge/${DIGEST}/1/${HEAD12}/would-drop`)).toHaveLength(0);
    expect(await journalOf(deps.journal)).toHaveLength(0);
  });

  it('a live tick on a veto-hold PR parks through the queue writer and the notifier', async () => {
    const writer = queueWriterSpy();
    const notifier = notifierSpy();
    const entry = makeEntry({
      veto: { outcome: 'hold-for-human', confidence: 0.9, mode: 'live', decisionReceiptId: null },
    });
    const { useCase, deps, request } = makeUseCase(
      [entry],
      greenForge,
      { shadow: false, veto: { mode: 'live' } },
      haltFake,
      { queueWriter: writer.adapter, notifier: notifier.adapter },
    );

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('recorded');
    expect(result.entries[0].reasonCode).toBe('veto-hold');
    // Two transitions, as on main: the ready entry is recorded first, then the
    // veto-hold park is written behind its own notification.
    expect(writer.calls).toBe(2);
    expect(notifier.calls).toBe(1);
    expect(await deps.journal.listForKey(`merge/${DIGEST}/1/${HEAD12}/would-park`)).toHaveLength(0);
  });

  it('a live tick on a moved head persists the supersession (predecessor and successor)', async () => {
    const writer = queueWriterSpy();
    const moved: ReadForgeMergeResult = { ...greenForge, liveHeadSha: HEAD3 };
    const { useCase, deps, request } = makeUseCase(
      [makeEntry()],
      moved,
      { shadow: false, unattended: true },
      haltFake,
      { queueWriter: writer.adapter },
    );

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('recorded');
    expect(result.entries[0].reasonCode).toBe('superseded');
    expect(writer.calls).toBe(1);
    expect(await deps.journal.listForKey(`merge/${DIGEST}/1/${HEAD12}/would-supersede`)).toHaveLength(0);
    expect(await deps.journal.listForKey(`merge/${DIGEST}/1/${HEAD3_12}/merge-pr`)).toHaveLength(0);
  });

  it('after a shadow tick on a CLOSED PR the live conductor reads no dropped entry', async () => {
    // Fix round 2 (Fable): rewritten against a RECORDING queue writer (on
    // main this scenario wired no writer and asserted only on the input
    // array, so it asserted nothing). The merge-enqueue step
    // (advance-lane-run/merge-enqueue.ts) journals `merge-dropped` as final
    // when it reads `state === 'dropped'`; shadow mode must never hand it
    // one, and the writer must have received no drop.
    const records = [makeEntry()];
    const writer = recordingQueueWriter();
    const { useCase, deps, request } = makeUseCase(records, closedForge(), {}, haltFake, {
      queueWriter: writer.adapter,
    });

    await useCase.runMergePass(request);

    expect(writer.transitions).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0].state).toBe('queued');
    const dropped = await deps.journal.listForKey(`merge/${DIGEST}/1/${HEAD12}/would-drop`);
    expect(dropped.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(dropped[1].outcome).toBe('dry-run');
    expect(dropped[1].reasonCode).toBe('would-drop');
    expect(dropped[1].detail).toBe('closed');
  });

  it('after a shadow tick on an EXHAUSTED PR the live conductor reads no dropped entry', async () => {
    // Fix round 2 (Fable): the exhausted case is covered separately from the
    // closed one, against the same recording writer.
    const records = [makeEntry({ attempt: 9 })];
    const writer = recordingQueueWriter();
    const { useCase, deps, request } = makeUseCase(records, exhaustedForge(), {}, haltFake, {
      queueWriter: writer.adapter,
    });

    await useCase.runMergePass(request);

    expect(writer.transitions).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0].state).toBe('queued');
    const dropped = await deps.journal.listForKey(`merge/${DIGEST}/1/${HEAD12}/would-drop`);
    expect(dropped.map((entry) => entry.kind)).toEqual(['intent', 'result']);
    expect(dropped[1].outcome).toBe('dry-run');
    expect(dropped[1].reasonCode).toBe('would-drop');
    expect(dropped[1].detail).toBe('forge-error-exhausted');
  });

  it('a moved head whose in-memory successor PARKS journals would-park and never persists (real queue adapter)', async () => {
    // Fix round 2 (Fable, major): with the real file-backed queue adapter as
    // BOTH the reader and the writer, a shadow supersede whose successor then
    // parks must not call `persist` on the unpersisted successor id (the real
    // adapter refuses it with `unknown-entry`); the park is journalled as
    // `would-park` on the successor's own head, and the queue file's bytes
    // are exactly what the tick found.
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-merge-queue-successor-park-'));
    try {
      const entry = makeEntry();
      const queue = new MergeQueueRepositoryAdapter({ stateDir });
      const repoDigest = mergeQueueRepositoryDigest({ owner: OWNER, repo: REPO });
      const freshDeadline = new Date(Date.now() + 60_000).toISOString();
      const enqueued = await queue.enqueueMergeEntry({
        repository: { owner: OWNER, repo: REPO },
        pullRequest: entry.pullRequest,
        headOid: entry.headOid,
        tier: entry.tier,
        enqueuedBy: 'conductor',
        runId: null,
        entryId: entry.entryId,
        successorEntryId: '01JB0000000000000000000000',
        enqueuedAtIso: entry.enqueuedAtIso,
        deadlineIso: freshDeadline,
      });
      expect(enqueued.outcome).toBe('created');
      const queueFile = path.join(stateDir, 'merge-queue.json');
      const before = await fs.readFile(queueFile, 'utf8');

      // The head moved (supersede) and the moved head has unresolved threads
      // (park), read twice in one pass: once for the predecessor, once for
      // the in-memory successor.
      const movedWithThreads: ReadForgeMergeResult = {
        ...greenForge,
        liveHeadSha: HEAD3,
        unresolvedThreads: 2,
      };
      const journal = new LaneRunJournalAdapter();
      let ulid = 0;
      const useCase = new RunMergePassUseCase({
        queue,
        queueWriter: queue, // the real adapter, not a spy-only fake
        forgeRead: forgeReadFake(movedWithThreads),
        verification: verificationFake(),
        journal: journal as LaneRunJournalPort,
        halt: haltFake,
        newUlid: () => `01JB${String(++ulid).padStart(22, '0').slice(-22)}`,
        nowIso: () => NOW,
      });
      const request: RunMergePassRequest = {
        repository: { owner: OWNER, repo: REPO },
        repoDigest,
        projectId: 'proj-1',
        policy: makePolicy(),
        deadlineIso: freshDeadline,
      };

      const result = await useCase.runMergePass(request);

      expect(result.outcome).toBe('completed');
      expect(result.entries[0].decision).toBe('journalled');
      expect(result.entries[0].reasonCode).toBe('would-park');
      // Keyed on the in-memory SUCCESSOR's head (the mutation-gap pin), with
      // the successor's own park reason.
      expect(result.entries[0].journalKey).toBe(`merge/${repoDigest}/1/${HEAD3_12}/would-park`);
      const parked = await journal.listForKey(`merge/${repoDigest}/1/${HEAD3_12}/would-park`);
      expect(parked.map((record) => record.kind)).toEqual(['intent', 'result']);
      expect(parked[1].outcome).toBe('dry-run');
      expect(parked[1].reasonCode).toBe('would-park');
      expect(parked[1].detail).toBe('threads');
      const superseded = await journal.listForKey(`merge/${repoDigest}/1/${HEAD12}/would-supersede`);
      expect(superseded.map((record) => record.kind)).toEqual(['intent', 'result']);
      // No `persist-refused` anywhere in the report, no `would-notify` for a
      // park that was never stored, and a byte-identical merge-queue.json.
      for (const reported of result.entries) {
        expect(reported.reasonCode).not.toBe('persist-refused');
        expect(reported.reasonCode).not.toBe('persist-failed');
      }
      for (const head12 of [HEAD12, HEAD3_12]) {
        expect(await journal.listForKey(`merge/${repoDigest}/1/${head12}/would-notify`)).toHaveLength(0);
      }
      expect(await fs.readFile(queueFile, 'utf8')).toBe(before);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it('a shadow supersede closes the PREDECESSOR head\'s open shadow intents', async () => {
    // Fix round 2 (Fable, mutation gap): an open intent seeded on the
    // predecessor's head is closed by the shadow supersede, which closes the
    // predecessor's open intents before acting on the successor.
    const moved: ReadForgeMergeResult = { ...greenForge, liveHeadSha: HEAD3 };
    const { useCase, deps, request } = makeUseCase([makeEntry()], moved);
    const key = `merge/${DIGEST}/1/${HEAD12}/would-park`;
    await deps.journal.append({
      version: 1, entryId: '01JB0000000000000000000098', kind: 'intent', key, runId: null,
      recordedAtIso: NOW, mode: null, expectedRevision: null, mintedId: null, outcome: null,
      reasonCode: null, detail: null, grantId: null, state: null,
    } as LaneRunJournalEntryRecord);

    await useCase.runMergePass(request);

    const after = await deps.journal.listForKey(key);
    expect(after.map((record) => record.kind)).toEqual(['intent', 'result']);
    expect(after[1].outcome).toBe('dry-run');
    expect(after[1].reasonCode).toBe('shadow-intent-closed');
  });

  it('a refused result append cannot leave an open would-notify intent: it is closed', async () => {
    // Fix round 2 (Fable, minor): `closeOpenShadowIntents` now includes
    // `would-notify`, so an interrupted silent-notification intent from a
    // prior tick gets its result instead of staying open forever.
    const { useCase, deps, request } = makeUseCase([makeEntry()], closedForge());
    const key = `merge/${DIGEST}/1/${HEAD12}/would-notify`;
    await deps.journal.append({
      version: 1, entryId: '01JB0000000000000000000097', kind: 'intent', key, runId: null,
      recordedAtIso: NOW, mode: null, expectedRevision: null, mintedId: null, outcome: null,
      reasonCode: null, detail: null, grantId: null, state: null,
    } as LaneRunJournalEntryRecord);

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('journalled');
    expect(result.entries[0].reasonCode).toBe('would-drop');
    const after = await deps.journal.listForKey(key);
    expect(after.map((record) => record.kind)).toEqual(['intent', 'result']);
    expect(after[1].outcome).toBe('dry-run');
    expect(after[1].reasonCode).toBe('shadow-intent-closed');
  });

  it('a live tick on a DIRTY PR drops with reason conflict through the writer and notifier, as on main', async () => {
    // Fix round 2 (Fable, minor): the `dirty: 'DIRTY'` drop in updateRowStep
    // is unchanged from origin/main, so live behaviour must stay
    // byte-identical: the drop persists and notifies exactly as before.
    const writer = queueWriterSpy();
    const notifier = notifierSpy();
    const { useCase, deps, request } = makeUseCase(
      [makeEntry()],
      { ...greenForge, mergeState: 'dirty' } as unknown as ReadForgeMergeResult,
      { shadow: false },
      haltFake,
      { queueWriter: writer.adapter, notifier: notifier.adapter },
    );

    const result = await useCase.runMergePass(request);

    expect(result.entries[0].decision).toBe('recorded');
    expect(result.entries[0].reasonCode).toBe('conflict');
    expect(writer.calls).toBe(1);
    expect(notifier.calls).toBe(1);
    expect(await deps.journal.listForKey(`merge/${DIGEST}/1/${HEAD12}/would-drop`)).toHaveLength(0);
    expect(await journalOf(deps.journal)).toHaveLength(0);
  });
});
