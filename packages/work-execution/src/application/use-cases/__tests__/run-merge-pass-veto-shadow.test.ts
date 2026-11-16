// OG-16a: the advisory merge veto in shadow mode — one recorded row per entry,
// log-only, and the next pass merges (or would-hold) over the stored answer.
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
import type { MergeVetoPort, MergeVetoAdvice } from '../../ports/out/MergeVetoPort.out-port.js';
import type {
  MergeVetoStatePort,
  MergeVetoStateRequest,
  MergeVetoStateResult,
} from '../../ports/out/MergeVetoStatePort.out-port.js';
import type { ConductorHaltPort } from '../../ports/out/ConductorHaltPort.out-port.js';
import type { ConductorHaltState } from '../../../domain/conductor-halt.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import {
  MERGE_QUEUE_ENTRY_VERSION,
  type MergeQueueEntryRecord,
  type MergeQueueVetoRecord,
} from '../../../domain/merge-queue-records.js';
import { decideMergeStep, type MergeRepoPolicy } from '../../../domain/merge-queue-decider.js';

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
    veto: { mode: 'shadow' },
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

function verificationFake(): MergeVerificationPort & { calls: number } {
  const adapter = {
    calls: 0,
    async readVerification(): Promise<MergeVerificationResult> {
      adapter.calls += 1;
      return { outcome: 'unknown', reasonCode: 'no-receipt' };
    },
    async runVerification(): Promise<MergeVerificationResult> {
      throw new Error('runVerification must never be called in the shadow pass');
    },
  };
  return adapter as MergeVerificationPort & { calls: number };
}

/**
 * An in-memory CAS queue: `listMergeEntries` reads the stored records, so a
 * second pass sees the recorded veto exactly as a real store would.
 */
function casQueueFake(initial: readonly MergeQueueEntryRecord[]): MergeQueueRepositoryPort & {
  records: Map<string, MergeQueueEntryRecord>;
} {
  const records = new Map<string, MergeQueueEntryRecord>(
    initial.map((record) => [record.entryId, record]),
  );
  const adapter = {
    records,
    async listMergeEntries(): Promise<MergeQueueEntryRecord[]> {
      return [...records.values()];
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
    async applyMergeTransition(request: {
      entryId: string;
      expectedRevision: number;
      next: MergeQueueEntryRecord;
      successor: MergeQueueEntryRecord | null;
    }): Promise<{ outcome: 'applied'; record: MergeQueueEntryRecord } | { outcome: 'refused'; reason: string }> {
      const current = records.get(request.entryId);
      if (current === undefined || current.revision !== request.expectedRevision) {
        return { outcome: 'refused', reason: 'revision-conflict' };
      }
      records.set(request.next.entryId, request.next);
      if (request.successor !== null) {
        records.set(request.successor.entryId, request.successor);
      }
      return { outcome: 'applied', record: request.next };
    },
  };
  return adapter as MergeQueueRepositoryPort & { records: Map<string, MergeQueueEntryRecord> };
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

function vetoStateFake(
  result: MergeVetoStateResult | Error,
): MergeVetoStatePort & { calls: number; requests: MergeVetoStateRequest[] } {
  const adapter = {
    calls: 0,
    requests: [] as MergeVetoStateRequest[],
    async readMergeVetoState(request: MergeVetoStateRequest): Promise<MergeVetoStateResult> {
      adapter.calls += 1;
      adapter.requests.push(request);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
  return adapter as MergeVetoStatePort & { calls: number; requests: MergeVetoStateRequest[] };
}

function vetoAdviceFake(
  result: MergeVetoAdvice | Error,
): MergeVetoPort & { calls: number; heads: string[] } {
  const adapter = {
    calls: 0,
    heads: [] as string[],
    async adviseMergeVeto(request: { verifiedHeadOid: string }): Promise<MergeVetoAdvice> {
      adapter.calls += 1;
      adapter.heads.push(request.verifiedHeadOid);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
  return adapter as unknown as MergeVetoPort & { calls: number; heads: string[] };
}

function journalFake(): LaneRunJournalAdapter {
  return new LaneRunJournalAdapter();
}

const greenForge: ReadForgeMergeResult = {
  outcome: 'ok',
  prState: 'open',
  liveHeadSha: HEAD,
  mergeState: 'clean',
  contexts: greenContexts(),
  unresolvedThreads: 0,
};

const readableState: MergeVetoStateResult = {
  status: 'read',
  state: {
    tier: '0',
    title: 'A change',
    changedPaths: ['packages/x/a.ts'],
    additions: 10,
    deletions: 2,
    hardToUndo: 'no',
    fixRounds: 0,
    reviewerFamilies: ['gate'],
    replyResolvedThreads: 0,
    majorBlockerFindings: 0,
    headChangedAfterReview: false,
  },
};

interface Wiring {
  useCase: RunMergePassUseCase;
  queue: ReturnType<typeof casQueueFake>;
  vetoState: ReturnType<typeof vetoStateFake>;
  vetoAdvice: ReturnType<typeof vetoAdviceFake>;
  journal: LaneRunJournalAdapter;
  request: RunMergePassRequest;
}

function wire(
  records: readonly MergeQueueEntryRecord[],
  forgeResult: ReadForgeMergeResult = greenForge,
  options: {
    policy?: Record<string, unknown>;
    vetoStateResult?: MergeVetoStateResult | Error;
    vetoAdviceResult?: MergeVetoAdvice | Error;
    bindVetoPorts?: boolean;
    nowIso?: () => string;
  } = {},
): Wiring {
  const queue = casQueueFake(records);
  const journal = journalFake();
  const vetoState = vetoStateFake(
    'vetoStateResult' in options && options.vetoStateResult !== undefined
      ? (options.vetoStateResult as MergeVetoStateResult | Error)
      : readableState,
  );
  const vetoAdvice = vetoAdviceFake(
    'vetoAdviceResult' in options && options.vetoAdviceResult !== undefined
      ? (options.vetoAdviceResult as MergeVetoAdvice | Error)
      : {
          status: 'answered',
          choice: 'merge-safe',
          confidence: 0.9,
          decisionReceiptId: 'receipt-1',
          mode: 'shadow',
        },
  );
  let ulid = 0;
  const useCase = new RunMergePassUseCase({
    queue,
    queueWriter: queue,
    forgeRead: forgeReadFake(forgeResult),
    verification: verificationFake(),
    journal: journal as LaneRunJournalPort,
    halt: haltFake,
    newUlid: () => `01JB${String(++ulid).padStart(22, '0').slice(-22)}`,
    nowIso: options.nowIso ?? (() => NOW),
    ...(options.bindVetoPorts === false
      ? {}
      : { vetoAdvice, vetoState }),
  });
  return {
    useCase,
    queue,
    vetoState,
    vetoAdvice,
    journal,
    request: {
      repository: { owner: OWNER, repo: REPO },
      repoDigest: DIGEST,
      projectId: 'proj-1',
      policy: makePolicy(options.policy ?? {}),
      deadlineIso: DEADLINE,
    },
  };
}

async function journalOf(journal: LaneRunJournalAdapter): Promise<number> {
  let count = 0;
  for (const action of ['merge-pr', 'update-branch', 'post-status']) {
    count += (await journal.listForKey(`merge/${DIGEST}/1/${HEAD12}/${action}`)).length;
  }
  return count;
}

function storedVeto(queue: Wiring['queue'], entryId: string): MergeQueueVetoRecord | null {
  const record = queue.records.get(entryId);
  return record === undefined ? null : record.veto;
}

function factsForGreenHead(entry: MergeQueueEntryRecord) {
  return {
    halted: false,
    paused: false,
    isQueueHead: true,
    pr: { status: 'open', headOid: entry.headOid, mergeStateStatus: 'CLEAN' } as const,
    reReadHeadOid: entry.headOid,
    headObservedAtIso: entry.enqueuedAtIso,
    contexts: { gate: { state: 'success' }, premerge: { state: 'success', creatorLogin: POSTER } },
    unresolvedThreads: { status: 'known', count: 0 } as const,
    updatesInLastHour: 0,
    premergeCarry: { status: 'unknown' } as const,
    disjointness: 'not-applicable' as const,
    macosVerification: { status: 'none' } as const,
    // veto omitted: the decider reads the stored record.
  };
}

describe('RunMergePassUseCase advisory veto (OG-16a, shadow mode)', () => {
  it('shadow mode records one shadow row per entry', async () => {
    const entry = makeEntry();
    const w = wire([entry]);

    const result = await w.useCase.runMergePass(w.request);

    expect(result.outcome).toBe('completed');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].decision).toBe('no-action');
    expect(result.entries[0].reasonCode).toBe('veto');
    expect(w.vetoState.calls).toBe(1);
    expect(w.vetoAdvice.calls).toBe(1);
    const recorded = storedVeto(w.queue, entry.entryId);
    expect(recorded).toEqual({
      outcome: 'merge-safe',
      confidence: 0.9,
      mode: 'shadow',
      decisionReceiptId: 'receipt-1',
    });
  });

  it('a second pass over the same entry asks nothing again', async () => {
    const entry = makeEntry();
    const w = wire([entry]);

    const first = await w.useCase.runMergePass(w.request);
    expect(first.entries[0].reasonCode).toBe('veto');
    expect(w.vetoState.calls).toBe(1);
    expect(w.vetoAdvice.calls).toBe(1);

    const second = await w.useCase.runMergePass(w.request);
    expect(second.entries[0].decision).toBe('journalled');
    expect(second.entries[0].reasonCode).toBe('would-merge');
    expect(w.vetoState.calls).toBe(1); // no second ask
    expect(w.vetoAdvice.calls).toBe(1);
  });

  it('an answered hold-for-human at high confidence in shadow mode leaves the merge decision a would-merge, with vetoShadow: would-hold', async () => {
    const entry = makeEntry();
    const w = wire([entry], greenForge, {
      vetoAdviceResult: {
        status: 'answered',
        choice: 'hold-for-human',
        confidence: 0.95,
        decisionReceiptId: 'receipt-hold',
        mode: 'shadow',
      },
      policy: { veto: { mode: 'shadow', holdConfidence: 0.8 } },
    });

    const first = await w.useCase.runMergePass(w.request);
    expect(first.entries[0].reasonCode).toBe('veto');
    expect(storedVeto(w.queue, entry.entryId)).toMatchObject({
      outcome: 'hold-for-human',
      confidence: 0.95,
      mode: 'shadow',
    });

    // The next pass still reaches would-merge; the veto is advisory only.
    const second = await w.useCase.runMergePass(w.request);
    expect(second.entries[0].decision).toBe('journalled');
    expect(second.entries[0].reasonCode).toBe('would-merge');
    expect(await journalOf(w.journal)).toBeGreaterThanOrEqual(2);

    // The decider, re-run on the persisted entry, carries vetoShadow.
    const persisted = w.queue.records.get(entry.entryId) as MergeQueueEntryRecord;
    const decision = decideMergeStep(
      persisted,
      factsForGreenHead(persisted),
      makePolicy({ veto: { mode: 'shadow', holdConfidence: 0.8 } }),
      NOW,
    );
    expect(decision.kind).toBe('act');
    if (decision.kind === 'act') {
      expect(decision.action).toBe('merge-pr');
      expect(decision.vetoShadow).toBe('would-hold');
    }
  });

  it('a port throw, an unknown advice and an unavailable state each record outcome unknown and block nothing', async () => {
    // vetoState throwing
    const thrown = makeEntry();
    const wThrow = wire([thrown], greenForge, { vetoStateResult: new Error('state down') });
    const rThrow = await wThrow.useCase.runMergePass(wThrow.request);
    expect(rThrow.outcome).toBe('completed');
    expect(rThrow.entries[0].reasonCode).toBe('veto');
    expect(wThrow.vetoAdvice.calls).toBe(0); // advise skipped
    expect(storedVeto(wThrow.queue, thrown.entryId)).toEqual({
      outcome: 'unknown',
      confidence: null,
      mode: 'shadow',
      decisionReceiptId: null,
    });
    expect((await wThrow.useCase.runMergePass(wThrow.request)).entries[0].reasonCode).toBe('would-merge');

    // vetoState unavailable
    const unavailable = makeEntry();
    const wUnavail = wire([unavailable], greenForge, {
      vetoStateResult: { status: 'unavailable', reason: 'not-configured' },
    });
    const rUnavail = await wUnavail.useCase.runMergePass(wUnavail.request);
    expect(rUnavail.entries[0].reasonCode).toBe('veto');
    expect(wUnavail.vetoAdvice.calls).toBe(0);
    expect(storedVeto(wUnavail.queue, unavailable.entryId)).toMatchObject({ outcome: 'unknown' });

    // vetoAdvice throwing
    const adviceThrow = makeEntry();
    const wAdviceThrow = wire([adviceThrow], greenForge, { vetoAdviceResult: new Error('timeout') });
    const rAdviceThrow = await wAdviceThrow.useCase.runMergePass(wAdviceThrow.request);
    expect(rAdviceThrow.entries[0].reasonCode).toBe('veto');
    expect(storedVeto(wAdviceThrow.queue, adviceThrow.entryId)).toMatchObject({ outcome: 'unknown' });

    // vetoAdvice unknown
    const adviceUnknown = makeEntry();
    const wUnknown = wire([adviceUnknown], greenForge, {
      vetoAdviceResult: { status: 'unknown', reason: 'low-confidence' },
    });
    const rUnknown = await wUnknown.useCase.runMergePass(wUnknown.request);
    expect(rUnknown.entries[0].reasonCode).toBe('veto');
    expect(storedVeto(wUnknown.queue, adviceUnknown.entryId)).toMatchObject({ outcome: 'unknown' });

    // Every unknown row still lets the next pass reach would-merge.
    const again = await wUnknown.useCase.runMergePass(wUnknown.request);
    expect(again.entries[0].reasonCode).toBe('would-merge');
  });

  it('live and off modes never call the port', async () => {
    for (const mode of ['live', 'off'] as const) {
      const w = wire([makeEntry()], greenForge, { policy: { veto: { mode } } });
      await w.useCase.runMergePass(w.request);
      expect(w.vetoState.calls).toBe(0);
      expect(w.vetoAdvice.calls).toBe(0);
    }
  });

  it('a missing optional dependency never calls either veto port', async () => {
    const w = wire([makeEntry()], greenForge, { bindVetoPorts: false });
    const result = await w.useCase.runMergePass(w.request);
    expect(result.outcome).toBe('completed');
    expect(result.entries[0].decision).toBe('journalled');
    expect(result.entries[0].reasonCode).toBe('would-merge');
  });

  it('the head passed is the verified head, never a moved one', async () => {
    const entry = makeEntry();
    const w = wire([entry]);

    await w.useCase.runMergePass(w.request);

    expect(w.vetoState.requests).toHaveLength(1);
    expect(w.vetoState.requests[0].headOid).toBe(entry.headOid);
    expect(w.vetoAdvice.heads).toEqual([entry.headOid]);
  });

  it('a moved live head triggers superseded with 0 veto port calls', async () => {
    const w = wire([makeEntry()], { ...greenForge, liveHeadSha: HEAD_MOVED });

    const result = await w.useCase.runMergePass(w.request);

    expect(result.entries[0].decision).toBe('recorded');
    expect(w.vetoState.calls).toBe(0);
    expect(w.vetoAdvice.calls).toBe(0);
  });

  it('treats malformed advice or throwing getter as unknown', async () => {
    const malformed: Array<MergeVetoAdvice | Error> = [
      null as unknown as MergeVetoAdvice,
      'answered' as unknown as MergeVetoAdvice,
      { status: 'answered', choice: 'maybe', confidence: 0.5, mode: 'shadow' } as unknown as MergeVetoAdvice,
      { status: 'answered', choice: 'merge-safe', confidence: Number.NaN, mode: 'shadow' } as unknown as MergeVetoAdvice,
      { status: 'answered', choice: 'merge-safe', confidence: 1.5, mode: 'shadow' } as unknown as MergeVetoAdvice,
      new Error('getter threw'),
    ];
    for (const [index, bad] of malformed.entries()) {
      const entry = makeEntry({ pullRequest: 100 + index });
      const w = wire([entry], greenForge, { vetoAdviceResult: bad });
      const result = await w.useCase.runMergePass(w.request);
      expect(result.entries[0].reasonCode).toBe('veto');
      expect(storedVeto(w.queue, entry.entryId)).toEqual({
        outcome: 'unknown',
        confidence: null,
        mode: 'shadow',
        decisionReceiptId: null,
      });
    }
    // A getter that throws while the answer is being read is unknown too.
    const entry = makeEntry({ pullRequest: 199 });
    const throwing = {
      get status(): string {
        throw new Error('status getter');
      },
    };
    const wThrowing = wire([entry], greenForge, {
      vetoAdviceResult: throwing as unknown as MergeVetoAdvice,
    });
    const result = await wThrowing.useCase.runMergePass(wThrowing.request);
    expect(result.entries[0].reasonCode).toBe('veto');
    expect(storedVeto(wThrowing.queue, entry.entryId)).toMatchObject({ outcome: 'unknown' });
  });

  it('a vetoState that throws or returns null records unknown and skips adviseMergeVeto', async () => {
    const cases: Array<MergeVetoStateResult | Error> = [
      new Error('state down'),
      null as unknown as MergeVetoStateResult,
    ];
    for (const [index, stateResult] of cases.entries()) {
      const entry = makeEntry({ pullRequest: 300 + index });
      const w = wire([entry], greenForge, { vetoStateResult: stateResult });
      const first = await w.useCase.runMergePass(w.request);
      expect(first.outcome).toBe('completed');
      expect(first.entries[0].reasonCode).toBe('veto');
      expect(w.vetoState.calls).toBe(1);
      expect(w.vetoAdvice.calls).toBe(0);
      expect(storedVeto(w.queue, entry.entryId)).toEqual({
        outcome: 'unknown',
        confidence: null,
        mode: 'shadow',
        decisionReceiptId: null,
      });
      const second = await w.useCase.runMergePass(w.request);
      expect(second.entries[0].reasonCode).toBe('would-merge');
      expect(w.vetoState.calls).toBe(1);
    }
  });

  it('a null decisionReceiptId in an answered advice is accepted as no receipt', async () => {
    const entry = makeEntry();
    const w = wire([entry], greenForge, {
      vetoAdviceResult: {
        status: 'answered',
        choice: 'merge-safe',
        confidence: 0.7,
        decisionReceiptId: null,
        mode: 'shadow',
      } as unknown as MergeVetoAdvice,
    });
    await w.useCase.runMergePass(w.request);
    expect(storedVeto(w.queue, entry.entryId)).toEqual({
      outcome: 'merge-safe',
      confidence: 0.7,
      mode: 'shadow',
      decisionReceiptId: null,
    });
  });

  type WriteFailure = 'conflict' | 'refused' | 'throws' | 'lands-then-throws';

  /** After the enter-ready write, the next queue write fails in the given way. */
  function failVetoWrite(queue: Wiring['queue'], how: WriteFailure): void {
    const original = queue.applyMergeTransition.bind(queue);
    let writes = 0;
    (queue as unknown as Record<string, unknown>).applyMergeTransition = async (
      request: Parameters<MergeQueueRepositoryPort['applyMergeTransition']>[0],
    ) => {
      writes += 1;
      if (writes < 2) {
        return original(request);
      }
      if (how === 'throws') {
        throw new Error('store down');
      }
      if (how === 'lands-then-throws') {
        await original(request);
        throw new Error('store died after the write');
      }
      return { outcome: 'refused', reason: how === 'conflict' ? 'revision-conflict' : 'invalid' };
    };
  }

  /** The pass went on to the shadow merge row; nothing was merged or stored as a veto. */
  function expectUnrecordedVetoReachedWouldMerge(
    w: Wiring,
    entryId: string,
    result: Awaited<ReturnType<RunMergePassUseCase['runMergePass']>>,
    adviceCalls: number,
    report: { decision: string; reasonCode: string } = { decision: 'journalled', reasonCode: 'would-merge' },
  ): void {
    expect(result.outcome).toBe('completed');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      entryId,
      ...report,
    });
    expect(w.vetoAdvice.calls).toBe(adviceCalls);
    expect(storedVeto(w.queue, entryId)).toBeNull();
    const stored = w.queue.records.get(entryId) as MergeQueueEntryRecord;
    expect(stored.state).toBe('ready');
    expect(stored.mergeCommitOid).toBeNull();
  }

  it('a veto that cannot be recorded (writer absent) is unknown for the pass, reaches would-merge and never asks', async () => {
    const entry = makeEntry();
    const w = wire([entry]);
    let ulid = 0;
    const useCase = new RunMergePassUseCase({
      queue: w.queue,
      forgeRead: forgeReadFake(greenForge),
      verification: verificationFake(),
      journal: w.journal as LaneRunJournalPort,
      halt: haltFake,
      newUlid: () => `01JB${String(++ulid).padStart(22, '0').slice(-22)}`,
      nowIso: () => NOW,
      vetoAdvice: w.vetoAdvice,
      vetoState: w.vetoState,
    });

    const first = await useCase.runMergePass(w.request);
    expect(first.entries[0]).toMatchObject({ decision: 'journalled', reasonCode: 'would-merge' });
    // The second pass reaches the same row; its journal entry already exists.
    const second = await useCase.runMergePass(w.request);
    expect(second.entries[0]).toMatchObject({ decision: 'no-action', reasonCode: 'already-journalled' });

    expect(w.vetoState.calls).toBe(0); // never asked, on any pass
    expect(w.vetoAdvice.calls).toBe(0);
    expect(storedVeto(w.queue, entry.entryId)).toBeNull();
  });

  it('a veto entry the record validation refuses is unknown for the pass and reaches would-merge', async () => {
    const entry = makeEntry();
    const w = wire([entry], greenForge, {
      vetoAdviceResult: {
        status: 'answered',
        choice: 'hold-for-human',
        confidence: 0.99,
        decisionReceiptId: `receipt-${'x'.repeat(300)}`,
        mode: 'shadow',
      },
    });

    const result = await w.useCase.runMergePass(w.request);

    expectUnrecordedVetoReachedWouldMerge(w, entry.entryId, result, 1);
  });

  it('after a refused veto entry advice IS asked again on a later pass (known cost: nothing is stored)', async () => {
    const entry = makeEntry();
    const w = wire([entry], greenForge, {
      vetoAdviceResult: {
        status: 'answered',
        choice: 'merge-safe',
        confidence: 0.9,
        decisionReceiptId: `receipt-${'x'.repeat(300)}`,
        mode: 'shadow',
      },
    });

    await w.useCase.runMergePass(w.request);
    expect(w.vetoAdvice.calls).toBe(1);
    const second = await w.useCase.runMergePass(w.request);

    expectUnrecordedVetoReachedWouldMerge(w, entry.entryId, second, 2, {
      decision: 'no-action',
      reasonCode: 'already-journalled',
    });
  });

  it('a failed veto write returns its reason code and stops the entry for the pass', async () => {
    const cases: Array<[WriteFailure, string]> = [
      ['conflict', 'persist-conflict'],
      ['refused', 'persist-refused'],
      ['throws', 'persist-failed'],
    ];
    for (const [index, [how, code]] of cases.entries()) {
      const entry = makeEntry({ pullRequest: 400 + index });
      const w = wire([entry]);
      failVetoWrite(w.queue, how);

      const result = await w.useCase.runMergePass(w.request);

      expect(w.vetoAdvice.calls).toBe(1); // the answer was asked, the write failed
      expect(result.entries[0].decision).toBe('no-action');
      expect(result.entries[0].reasonCode).toBe(code);
      expect(storedVeto(w.queue, entry.entryId)).toBeNull();
    }
  });

  it('a write that lands and then throws reports persist-failed and gives no same-pass would-merge', async () => {
    const entry = makeEntry();
    const w = wire([entry]);
    failVetoWrite(w.queue, 'lands-then-throws');

    const result = await w.useCase.runMergePass(w.request);

    expect(result.entries[0].decision).toBe('no-action');
    expect(result.entries[0].reasonCode).toBe('persist-failed');
    expect(w.vetoAdvice.calls).toBe(1);
    // The write did land: the next pass reads the stored veto and asks nothing.
    expect(storedVeto(w.queue, entry.entryId)).toMatchObject({ outcome: 'merge-safe' });
    expect(await journalOf(w.journal)).toBe(0);
  });

  it('a recorded hold-for-human is never replaced or re-asked: the next pass keeps it and only would-merges', async () => {
    const entry = makeEntry();
    const w = wire([entry], greenForge, {
      vetoAdviceResult: {
        status: 'answered',
        choice: 'hold-for-human',
        confidence: 0.95,
        decisionReceiptId: 'receipt-hold',
        mode: 'shadow',
      },
    });
    const first = await w.useCase.runMergePass(w.request);
    expect(first.entries[0].reasonCode).toBe('veto');
    const stored = storedVeto(w.queue, entry.entryId);
    expect(stored).toMatchObject({ outcome: 'hold-for-human' });

    const second = await w.useCase.runMergePass(w.request);

    expect(second.entries[0]).toMatchObject({ decision: 'journalled', reasonCode: 'would-merge' });
    expect(storedVeto(w.queue, entry.entryId)).toEqual(stored);
    expect(w.vetoAdvice.calls).toBe(1);
    expect(w.vetoState.calls).toBe(1);
  });

  /** A clock that lapses the deadline once `lapsed()` is true. */
  function lapsingUseCase(w: Wiring, lapsed: () => boolean): RunMergePassUseCase {
    let ulid = 0;
    return new RunMergePassUseCase({
      queue: w.queue,
      queueWriter: w.queue,
      forgeRead: forgeReadFake(greenForge),
      verification: verificationFake(),
      journal: w.journal as LaneRunJournalPort,
      halt: haltFake,
      newUlid: () => `01JB${String(++ulid).padStart(22, '0').slice(-22)}`,
      nowIso: () => (lapsed() ? '2026-11-01T12:20:00.000Z' : NOW),
      vetoAdvice: w.vetoAdvice,
      vetoState: w.vetoState,
    });
  }

  it('returns budget-exhausted without calling veto ports when the budget lapses before the state read', async () => {
    const entry = makeEntry();
    const w = wire([entry]);
    // The deadline lapses once the enter-ready write has landed, so the veto
    // step's own first budget guard is the next one to run.
    const original = w.queue.applyMergeTransition.bind(w.queue);
    let writes = 0;
    (w.queue as unknown as Record<string, unknown>).applyMergeTransition = async (
      request: Parameters<MergeQueueRepositoryPort['applyMergeTransition']>[0],
    ) => {
      const result = await original(request);
      writes += 1;
      return result;
    };
    const useCase = lapsingUseCase(w, () => writes >= 1);
    // Policy shadow off: the open-intent sweep, which has its own budget
    // guards, does not run, so only the veto step's guard can abort here.
    const request: RunMergePassRequest = { ...w.request, policy: makePolicy({ shadow: false }) };

    const result = await useCase.runMergePass(request);

    expect(writes).toBe(1);
    expect(result.outcome).toBe('budget-exhausted');
    expect(result.reasonCode).toBeNull();
    expect(w.vetoState.calls).toBe(0);
    expect(w.vetoAdvice.calls).toBe(0);
  });

  it('returns budget-exhausted without asking advice when the budget lapses after the state read', async () => {
    const entry = makeEntry();
    const w = wire([entry]);
    const useCase = lapsingUseCase(w, () => w.vetoState.calls >= 1);
    const request: RunMergePassRequest = { ...w.request, policy: makePolicy({ shadow: false }) };

    const result = await useCase.runMergePass(request);

    expect(result.outcome).toBe('budget-exhausted');
    expect(w.vetoState.calls).toBe(1);
    expect(w.vetoAdvice.calls).toBe(0);
    expect(storedVeto(w.queue, entry.entryId)).toBeNull();
  });

  it('a null request or one without a repository is refused, never thrown on', async () => {
    const w = wire([makeEntry()], greenForge, { bindVetoPorts: false });
    for (const bad of [
      null,
      { ...w.request, repository: undefined },
      { ...w.request, repoDigest: 'nope' },
      { ...w.request, deadlineIso: 'not-a-date' },
    ]) {
      const result = await w.useCase.runMergePass(bad as unknown as RunMergePassRequest);
      expect(result).toEqual({ outcome: 'refused', reasonCode: 'invalid-request', entries: [] });
    }
    expect(w.vetoState.calls).toBe(0);
    expect(w.vetoAdvice.calls).toBe(0);
  });
});
