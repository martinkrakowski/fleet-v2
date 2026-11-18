/**
 * SH18a tests: `readShadowConformanceRuns`, the fail-closed reader of the
 * conducted-run facts S6' evaluates. In-memory fakes implementing only the
 * picked read members (no mutator exists on any fake); fixture values are
 * `example-*`. Hostile input never throws: every refusal is a typed
 * `unknown` result with a code, and no error message is echoed.
 */

import { describe, expect, it } from 'vitest';

import {
  SHADOW_FACTS_MAX_ATTEMPTS_PER_RUN,
  SHADOW_FACTS_MAX_RECEIPTS_PER_HEAD,
  SHADOW_FACTS_MAX_MERGED_PULL_REQUESTS,
  readMergedPullRequestIds,
  readShadowConformanceRuns,
  type ShadowConformanceRunsDependencies,
} from '../shadow-day/index.js';
import {
  SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN,
  SHADOW_CONFORMANCE_MAX_RUNS,
} from '../../../domain/shadow-day-conformance.js';
import { LANE_RUN_RECORD_VERSION, type LaneRunRecord } from '../../../domain/lane-run-records.js';
import {
  LANE_RUN_JOURNAL_ENTRY_VERSION,
  type LaneRunJournalEntryRecord,
} from '../../../domain/lane-run-journal.js';
import type { AttemptRecord, CollectedAttemptArtifacts } from '../../../domain/execution-records.js';
import type {
  ReadReceiptsForHeadResult,
  ReviewReceiptProjection,
} from '../../ports/out/AcceptanceReceiptReadPort.out-port.js';

const RUN_MERGED = 'run-01JB0000000000000000000000';
const RUN_OTHER = 'run-01JC0000000000000000000000';
const RUN_UNMERGED = 'run-01JD0000000000000000000000';
const PR = 41;
const OTHER_PR = 42;
const HEAD_1 = 'a'.repeat(40);
const HEAD_2 = 'b'.repeat(40);
const ATTEMPT_1 = 'attempt-01JB0000000000000000000000';
const ATTEMPT_2 = 'attempt-01JC0000000000000000000000';
const WORK_ORDER_ID = 'example-work-order-1';
const WORKTREE_PATH = '/example/worktree';
const ENTRY_RECORDED_AT = '2026-11-28T12:00:00.000Z';
const DEADLINE_ISO = '2026-11-30T00:00:00.000Z';
/** Before the deadline by instant. */
const BEFORE_DEADLINE = '2026-11-29T23:00:00.000Z';
/** Equal to the deadline instant (the `>=` rule). */
const AT_DEADLINE = '2026-11-30T00:00:00.000Z';
const UNREADABLE_ERROR = 'example-unreadable-store-error';

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mergedPullRequests: [PR],
    deadlineIso: DEADLINE_ISO,
    ...overrides,
  };
}

function makeRun(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  return {
    version: LANE_RUN_RECORD_VERSION,
    runId: RUN_MERGED,
    workOrderId: WORK_ORDER_ID,
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': null, fix: null, review: null },
    round: 0,
    attemptIds: [],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-1',
    ...overrides,
  };
}

function collectedRun(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  return makeRun({ attemptIds: [ATTEMPT_1, ATTEMPT_2], prNumber: PR, ...overrides });
}

function makeAttempt(
  id: string,
  artifacts: CollectedAttemptArtifacts | null,
): AttemptRecord {
  return {
    id,
    workOrderId: WORK_ORDER_ID,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE_PATH,
    baseCommit: HEAD_1,
    state: 'collected',
    outcome: 'done',
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts,
    createdAtIso: ENTRY_RECORDED_AT,
    updatedAtIso: ENTRY_RECORDED_AT,
  };
}

function artifactsOf(headCommit: string): CollectedAttemptArtifacts {
  return { headCommit, commitsSinceBase: [], collectedArtifactPaths: [], notes: 'missing' };
}

function journalEntry(
  runId: string,
  kind: LaneRunJournalEntryRecord['kind'],
): LaneRunJournalEntryRecord {
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: `01JB00000000000000000000${kind === 'result' ? 'Z' : 'Y'}`,
    kind,
    key: null,
    runId,
    recordedAtIso: ENTRY_RECORDED_AT,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: kind === 'result' ? 'completed' : null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: 'merged',
  };
}

function receipt(
  kind: ReviewReceiptProjection['kind'],
  result: ReviewReceiptProjection['result'],
): ReviewReceiptProjection {
  return {
    receiptId: 'example-receipt-id' as unknown as ReviewReceiptProjection['receiptId'],
    kind,
    result,
    findings: { blocker: 0, major: 0, minor: 0, nit: 0 },
    completedAtIso: ENTRY_RECORDED_AT,
  };
}

interface ReadCalls {
  runsList: number;
  attemptsRead: string[];
  receiptsRead: number;
  listForRunRead: string[];
  listForRunsCalls: number;
}

/**
 * Deps whose every fake implements exactly the read member it names, and
 * nothing else. An `Error` option makes the port throw; a missing option
 * falls back to the empty read. `journalNonMap` makes the journal port
 * return a non-`Map` (grouped path) or a non-array (per-run path).
 */
function makeDeps(options: {
  runs?: readonly LaneRunRecord[] | Error;
  runsNonArray?: boolean;
  attempts?: ReadonlyMap<string, AttemptRecord | null> | Error;
  journalByRun?: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]> | Error;
  journalNonMap?: unknown;
  journalMissingKey?: boolean;
  withListForRuns?: boolean;
  receipts?: () => ReadReceiptsForHeadResult | undefined;
  nowIso?: () => string;
}): ShadowConformanceRunsDependencies & { calls: ReadCalls } {
  const calls: ReadCalls = { runsList: 0, attemptsRead: [], receiptsRead: 0, listForRunRead: [], listForRunsCalls: 0 };
  const runsList = (): Promise<readonly LaneRunRecord[]> => {
    calls.runsList += 1;
    if (options.runsNonArray === true) {
      return Promise.resolve({ notAnArray: true } as unknown as readonly LaneRunRecord[]);
    }
    if (options.runs instanceof Error) {
      return Promise.reject(options.runs);
    }
    return Promise.resolve(options.runs ?? []);
  };
  const attempts = {
    findAttemptById: (attemptId: string): Promise<AttemptRecord | null> => {
      calls.attemptsRead.push(attemptId);
      if (options.attempts instanceof Error) {
        return Promise.reject(options.attempts);
      }
      return Promise.resolve(options.attempts?.get(attemptId) ?? null);
    },
  };
  const receiptsPort = {
    readReceiptsForHead: (): Promise<ReadReceiptsForHeadResult> => {
      calls.receiptsRead += 1;
      const outcome = options.receipts?.();
      return outcome === undefined
        ? Promise.reject(new Error(UNREADABLE_ERROR))
        : Promise.resolve(outcome);
    },
  };
  const groupedMap = options.journalByRun instanceof Map ? options.journalByRun : new Map();
  const listForRun = (runId: string): Promise<unknown> => {
    calls.listForRunRead.push(runId);
    if (options.journalByRun instanceof Error) {
      return Promise.reject(options.journalByRun);
    }
    if (options.journalNonMap !== undefined) {
      return Promise.resolve(options.journalNonMap);
    }
    return Promise.resolve(groupedMap.get(runId) ?? []);
  };
  const listForRuns = (runIds: readonly string[]): Promise<unknown> => {
    calls.listForRunsCalls += 1;
    if (options.journalByRun instanceof Error) {
      return Promise.reject(options.journalByRun);
    }
    if (options.journalNonMap !== undefined) {
      return Promise.resolve(options.journalNonMap);
    }
    if (options.journalMissingKey === true) {
      return Promise.resolve(new Map(groupedMap));
    }
    const grouped = new Map(groupedMap);
    for (const runId of runIds) {
      if (!grouped.has(runId)) {
        grouped.set(runId, []);
      }
    }
    return Promise.resolve(grouped);
  };
  return {
    runs: { list: runsList },
    journal:
      options.withListForRuns === false
        ? ({ listForRun } as unknown as ShadowConformanceRunsDependencies['journal'])
        : ({ listForRun, listForRuns } as unknown as ShadowConformanceRunsDependencies['journal']),
    attempts: attempts as ShadowConformanceRunsDependencies['attempts'],
    receipts: receiptsPort,
    nowIso: options.nowIso ?? ((): string => BEFORE_DEADLINE),
    calls,
  };
}

/**
 * A fake clock that is before the deadline for the first `pastFrom - 1`
 * `nowIso` calls and at the deadline from the `pastFrom`-th call on: it
 * advances per call, so the deadline passes mid-read.
 */
function clockPastFromCall(pastFrom: number): () => string {
  let calls = 0;
  return () => {
    calls += 1;
    return calls >= pastFrom ? AT_DEADLINE : BEFORE_DEADLINE;
  };
}

describe('readShadowConformanceRuns', () => {
  describe('conformance runs', () => {
    it('a run whose PR merged yields its latest collected head, receipts and journal, sorted by runId', async () => {
      const deps = makeDeps({
        runs: [
          collectedRun(),
          makeRun({ runId: RUN_OTHER, prNumber: OTHER_PR, attemptIds: [ATTEMPT_2] }),
          collectedRun({ runId: RUN_UNMERGED, attemptIds: [ATTEMPT_2] }),
        ],
        attempts: new Map([
          [ATTEMPT_1, makeAttempt(ATTEMPT_1, null)],
          [ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_1))],
        ]),
        journalByRun: new Map([
          [RUN_MERGED, [journalEntry(RUN_MERGED, 'conduct'), journalEntry(RUN_MERGED, 'result')]],
          [RUN_UNMERGED, [journalEntry(RUN_UNMERGED, 'conduct')]],
        ]),
        receipts: () => ({
          outcome: 'found',
          verification: [],
          review: [receipt('brief-check', 'pass'), receipt('code-review', 'fail')],
        }),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({
        status: 'ok',
        runs: [
          {
            runId: RUN_MERGED,
            tier: 2,
            pullRequest: PR,
            headOid: HEAD_1,
            reviewReceipts: [
              { kind: 'brief-check', result: 'pass' },
              { kind: 'code-review', result: 'fail' },
            ],
            journal: [
              { kind: 'conduct', key: null, recordedAtIso: ENTRY_RECORDED_AT, outcome: null, reasonCode: null, state: 'merged' },
              { kind: 'result', key: null, recordedAtIso: ENTRY_RECORDED_AT, outcome: 'completed', reasonCode: null, state: 'merged' },
            ],
          },
          {
            runId: RUN_UNMERGED,
            tier: 2,
            pullRequest: PR,
            headOid: HEAD_1,
            reviewReceipts: [
              { kind: 'brief-check', result: 'pass' },
              { kind: 'code-review', result: 'fail' },
            ],
            journal: [
              { kind: 'conduct', key: null, recordedAtIso: ENTRY_RECORDED_AT, outcome: null, reasonCode: null, state: 'merged' },
            ],
          },
        ],
      });
    });

    it('the latest attempt without artifacts falls back to the previous attempt head', async () => {
      const deps = makeDeps({
        runs: [collectedRun()],
        attempts: new Map([
          [ATTEMPT_1, makeAttempt(ATTEMPT_1, artifactsOf(HEAD_1))],
          [ATTEMPT_2, makeAttempt(ATTEMPT_2, null)],
        ]),
        receipts: () => ({ outcome: 'none' }),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.runs[0]?.headOid).toBe(HEAD_1);
      }
    });

    it('receipts none yields an empty reviewReceipts list', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        receipts: () => ({ outcome: 'none' }),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({
        status: 'ok',
        runs: [{
          runId: RUN_MERGED,
          tier: 2,
          pullRequest: PR,
          headOid: HEAD_2,
          reviewReceipts: [],
          journal: [],
        }],
      });
    });

    it('receipts unavailable yields unknown/receipts-unavailable and echoes no error text', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        receipts: () => ({ outcome: 'unavailable', reason: 'evidence-unreadable' }),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'receipts-unavailable' });
      expect(JSON.stringify(result)).not.toContain('evidence-unreadable');
    });

    it('a throwing receipt read yields unknown/receipts-unavailable and echoes no thrown message', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'receipts-unavailable' });
      expect(JSON.stringify(result)).not.toContain(UNREADABLE_ERROR);
    });

    it('a found receipt result whose review value is malformed reaches the outer catch as a typed unknown, never a rejection', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        receipts: () => ({
          outcome: 'found',
          verification: [],
          // The `found` `review` value is read at the per-head cap check
          // outside the interior refusal wraps, so a `get` trap that throws
          // reaches the reader's outer catch — the typed `unknown` result,
          // never a rejection.
          review: new Proxy([], { get: () => { throw 42; } }),
        }) as unknown as ReadReceiptsForHeadResult,
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'runs-unreadable' });
      expect(JSON.stringify(result)).not.toContain('42');
    });

    it('a review receipts list over the per-head cap yields unknown/too-many-receipts', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        receipts: () => ({
          outcome: 'found',
          verification: [],
          review: Array.from(
            { length: SHADOW_FACTS_MAX_RECEIPTS_PER_HEAD + 1 },
            () => receipt('code-review', 'pass'),
          ),
        }),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'too-many-receipts' });
    });

    it('a run whose PR is not in the set is omitted and never read', async () => {
      const deps = makeDeps({
        runs: [
          collectedRun(),
          makeRun({ runId: RUN_OTHER, prNumber: OTHER_PR, attemptIds: [ATTEMPT_1] }),
        ],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        receipts: () => ({ outcome: 'none' }),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.runs.map((run) => run.runId)).toEqual([RUN_MERGED]);
      }
      expect(deps.calls.attemptsRead).toEqual([ATTEMPT_2]);
      expect(deps.calls.receiptsRead).toBe(1);
    });

    it('a run with no collected head yields unknown/head-unresolved', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_1] })],
        attempts: new Map([[ATTEMPT_1, makeAttempt(ATTEMPT_1, null)]]),
        receipts: () => ({ outcome: 'none' }),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'head-unresolved' });
    });

    it('a collected headCommit that is not 40-hex yields unknown/head-unresolved', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf('short-head'))]]),
        receipts: () => ({ outcome: 'none' }),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'head-unresolved' });
    });

    it('findAttemptById returning null for an id in attemptIds yields unknown/attempt-unreadable even when an older attempt has a collected head', async () => {
      const deps = makeDeps({
        runs: [collectedRun()],
        attempts: new Map([[ATTEMPT_1, makeAttempt(ATTEMPT_1, artifactsOf(HEAD_1))]]),
        receipts: () => ({ outcome: 'none' }),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'attempt-unreadable' });
      expect(deps.calls.attemptsRead).toEqual([ATTEMPT_2]);
    });

    it('a throwing findAttemptById yields unknown/attempt-unreadable', async () => {
      const deps = makeDeps({
        runs: [collectedRun()],
        attempts: new Error(UNREADABLE_ERROR),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'attempt-unreadable' });
      expect(JSON.stringify(result)).not.toContain(UNREADABLE_ERROR);
    });
  });

  describe('journal and candidates', () => {
    it('without listForRuns the reader falls back to listForRun once per candidate', async () => {
      const deps = makeDeps({
        runs: [
          collectedRun(),
          collectedRun({ runId: RUN_OTHER, attemptIds: [ATTEMPT_2] }),
        ],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        journalByRun: new Map(),
        receipts: () => ({ outcome: 'none' }),
        withListForRuns: false,
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result.status).toBe('ok');
      expect(deps.calls.listForRunRead).toEqual([RUN_MERGED, RUN_OTHER]);
    });

    it('a listForRuns Map missing a requested runId yields unknown/journal-unreadable', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        journalByRun: new Map(),
        journalMissingKey: true,
        receipts: () => ({ outcome: 'none' }),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'journal-unreadable' });
    });

    it('a listForRuns non-Map yield yields unknown/journal-unreadable', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        journalNonMap: { notAMap: true },
        receipts: () => ({ outcome: 'none' }),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'journal-unreadable' });
    });

    it('a non-array listForRuns value yields unknown/journal-unreadable', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        journalByRun: new Map([
          [RUN_MERGED, { notAnArray: true } as unknown as readonly LaneRunJournalEntryRecord[]],
        ]),
        receipts: () => ({ outcome: 'none' }),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'journal-unreadable' });
    });

    it('a listForRuns yield that is an array (not a Map) yields unknown/journal-unreadable', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        journalNonMap: [],
        receipts: () => ({ outcome: 'none' }),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'journal-unreadable' });
    });

    it('a grouped Map value that is a string — on an unrequested run id — yields unknown/journal-unreadable', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        journalByRun: new Map([
          [RUN_MERGED, []],
          [RUN_OTHER, 'not-an-array' as unknown as readonly LaneRunJournalEntryRecord[]],
        ]),
        receipts: () => ({ outcome: 'none' }),
      });
      const result = await readShadowConformanceRuns(deps, request());
      // Every value in the grouped Map is validated, not only the requested
      // ids: a malformed extra entry refuses the whole answer.
      expect(result).toEqual({ status: 'unknown', reason: 'journal-unreadable' });
    });

    it('a non-array listForRun yield yields unknown/journal-unreadable', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        journalNonMap: { notAnArray: true },
        withListForRuns: false,
        receipts: () => ({ outcome: 'none' }),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'journal-unreadable' });
    });

    it('a throwing listForRun yields unknown/journal-unreadable', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        journalByRun: new Error(UNREADABLE_ERROR),
        withListForRuns: false,
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'journal-unreadable' });
      expect(JSON.stringify(result)).not.toContain(UNREADABLE_ERROR);
    });

    it('a candidate journal over the entry cap yields unknown/too-many-journal-entries', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        journalByRun: new Map([
          [RUN_MERGED, Array.from({ length: SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN + 1 }, () => journalEntry(RUN_MERGED, 'conduct'))],
        ]),
        receipts: () => ({ outcome: 'none' }),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'too-many-journal-entries' });
    });

    it('attemptIds over the per-run cap yield unknown/too-many-attempts before any attempt read', async () => {
      const deps = makeDeps({
        runs: [
          collectedRun({
            attemptIds: Array.from(
              { length: SHADOW_FACTS_MAX_ATTEMPTS_PER_RUN + 1 },
              (_, index) => `attempt-01JB${String(index).padStart(22, '0')}`,
            ),
          }),
        ],
        attempts: new Map(),
        receipts: () => ({ outcome: 'none' }),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'too-many-attempts' });
      expect(deps.calls.attemptsRead).toEqual([]);
    });

    it('candidates over the run cap yield unknown/too-many-runs', async () => {
      const runs = Array.from(
        { length: SHADOW_CONFORMANCE_MAX_RUNS + 1 },
        (_, index) => collectedRun({ runId: `run-01JB00000000000000000${String(index).padStart(5, '0')}` }),
      );
      const deps = makeDeps({
        runs,
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        receipts: () => ({ outcome: 'none' }),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'too-many-runs' });
      expect(deps.calls.attemptsRead).toEqual([]);
    });

    it('a throwing runs.list yields unknown/runs-unreadable', async () => {
      const deps = makeDeps({ runs: new Error(UNREADABLE_ERROR) });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'runs-unreadable' });
      expect(JSON.stringify(result)).not.toContain(UNREADABLE_ERROR);
    });

    it('a non-array runs.list yield yields unknown/runs-unreadable', async () => {
      const deps = makeDeps({ runsNonArray: true });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'runs-unreadable' });
    });

    it('a revoked Proxy from runs.list yields unknown/runs-unreadable and nothing rejects', async () => {
      const { proxy, revoke } = Proxy.revocable<readonly LaneRunRecord[]>([], {});
      revoke();
      const deps = makeDeps({});
      const revoking = { ...deps, runs: { list: () => Promise.resolve(proxy) } };
      const result = await readShadowConformanceRuns(revoking, request());
      // The revocation fires at the thenability check inside the fake (the
      // `get` of `then` throws), so the interior catch maps it — and the
      // outer catch stands behind it: rethrowing there fails this test.
      expect(result).toEqual({ status: 'unknown', reason: 'runs-unreadable' });
      expect(JSON.stringify(result)).not.toContain('undefined');
    });

    it('a revoked Proxy from listForRun yields unknown/journal-unreadable and nothing rejects', async () => {
      const { proxy, revoke } = Proxy.revocable<LaneRunJournalEntryRecord[]>([], {});
      revoke();
      const deps = makeDeps({ withListForRuns: false, runs: [collectedRun()] });
      const revoking = { ...deps, journal: { listForRun: () => Promise.resolve(proxy) } };
      const result = await readShadowConformanceRuns(revoking, request());
      // The revoked Proxy reads as a non-array here; the interior journal
      // read refuses it with the journal code — exactly one code, never a
      // rejection.
      expect(result).toEqual({ status: 'unknown', reason: 'journal-unreadable' });
    });

    it('a run field getter throwing a non-Error after all port calls yields a typed unknown and nothing rejects', async () => {
      const run = collectedRun({ attemptIds: [ATTEMPT_2] });
      const hostileRun = {
        ...run,
        get tier(): number {
          throw 42;
        },
      } as unknown as LaneRunRecord;
      const deps = makeDeps({
        runs: [hostileRun],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        receipts: () => ({ outcome: 'none' }),
      });
      const result = await readShadowConformanceRuns(deps, request());
      // Every read of caller-supplied structure after the port calls sits in
      // a per-read inner catch (`readOrRefuse`), so the `42` from the getter
      // never reaches the outer catch: the inner mapping of the tier read
      // refuses with runs-unreadable — the typed unknown, never a rejection.
      expect(result.status).toBe('unknown');
      expect(result.status === 'unknown' && result.reason).toBe('runs-unreadable');
      expect(deps.calls.runsList).toBe(1);
      expect(deps.calls.attemptsRead).toEqual([ATTEMPT_2]);
      expect(deps.calls.receiptsRead).toBe(1);
      expect(JSON.stringify(result)).not.toContain('42');
    });

    it('runs.list() rejecting a non-Error (42) yields unknown/runs-unreadable and nothing rejects', async () => {
      const deps = makeDeps({});
      const throwing = { ...deps, runs: { list: (): Promise<never> => Promise.reject(42) } };
      const result = await readShadowConformanceRuns(throwing, request());
      // The interior catch maps the non-Error rejection; the outer catch
      // stands behind it — rethrowing there fails this test.
      expect(result).toEqual({ status: 'unknown', reason: 'runs-unreadable' });
      expect(JSON.stringify(result)).not.toContain('42');
    });

    it('a port method throwing a non-Error value yields a typed unknown and nothing rejects', async () => {
      const deps = makeDeps({ runs: [collectedRun({ attemptIds: [ATTEMPT_2] })] });
      const throwing = {
        ...deps,
        attempts: { findAttemptById: (): Promise<AttemptRecord> => Promise.reject(42) },
      };
      const result = await readShadowConformanceRuns(throwing, request());
      expect(result.status).toBe('unknown');
      expect(result.status === 'unknown' && result.reason).toBe('attempt-unreadable');
      expect(JSON.stringify(result)).not.toContain('42');
    });
  });

  describe('deadline', () => {
    it('a now past the deadline yields unknown/deadline-exceeded with zero outbound calls', async () => {
      const deps = makeDeps({
        runs: [collectedRun()],
        attempts: new Map(),
        receipts: () => ({ outcome: 'none' }),
        nowIso: () => AT_DEADLINE,
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'deadline-exceeded' });
      expect(deps.calls.runsList).toBe(0);
      expect(deps.calls.attemptsRead).toEqual([]);
      expect(deps.calls.receiptsRead).toBe(0);
    });

    it('a now past the deadline instant but before it lexically yields unknown/deadline-exceeded (instant comparison)', async () => {
      const deps = makeDeps({
        runs: [collectedRun()],
        attempts: new Map(),
        receipts: () => ({ outcome: 'none' }),
        // 2026-11-29T23:00:00Z: past the deadline instant
        // (2026-11-29T22:00:00Z) but lexically smaller, so a string
        // comparison would wrongly read as before the deadline and pass.
        nowIso: () => '2026-11-29T23:00:00.000Z',
      });
      const result = await readShadowConformanceRuns(
        deps,
        request({ deadlineIso: '2026-11-30T00:00:00.000+02:00' }),
      );
      expect(result).toEqual({ status: 'unknown', reason: 'deadline-exceeded' });
      expect(deps.calls.runsList).toBe(0);
    });

    it('a now before the deadline only in instant terms yields ok (a lexical comparison would refuse)', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        receipts: () => ({ outcome: 'none' }),
        nowIso: () => '2026-11-29T23:30:00.000Z',
      });
      const result = await readShadowConformanceRuns(
        deps,
        request({ deadlineIso: '2026-11-29T22:00:00.000-02:00' }),
      );
      expect(result.status).toBe('ok');
    });

    it('a throwing nowIso yields unknown/deadline-exceeded with zero outbound calls', async () => {
      const deps = makeDeps({
        runs: [collectedRun()],
        attempts: new Map(),
        receipts: () => ({ outcome: 'none' }),
        nowIso: () => {
          throw new Error(UNREADABLE_ERROR);
        },
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'deadline-exceeded' });
      expect(deps.calls.runsList).toBe(0);
    });

    it('a non-zoned nowIso yield yields unknown/deadline-exceeded', async () => {
      const deps = makeDeps({
        runs: [collectedRun()],
        attempts: new Map(),
        receipts: () => ({ outcome: 'none' }),
        nowIso: () => 'not-a-zoned-instant',
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'deadline-exceeded' });
    });

    it('the deadline passing between the fallback per-run journal reads yields unknown/deadline-exceeded after one read', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_2] }), collectedRun({ runId: RUN_OTHER })],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        receipts: () => ({ outcome: 'none' }),
        withListForRuns: false,
        // Calls 1-3: the initial check, the pre-journal check and the
        // per-run check before the FIRST `listForRun` — still before the
        // deadline; call 4: the per-run check before the second
        // `listForRun` — past from there.
        nowIso: clockPastFromCall(4),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'deadline-exceeded' });
      expect(deps.calls.listForRunRead).toEqual([RUN_MERGED]);
    });

    it('the deadline passing before the grouped journal read yields unknown/deadline-exceeded with no grouped read', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        receipts: () => ({ outcome: 'none' }),
        // Calls 1-2: the initial and pre-journal checks; call 3: the check
        // immediately before the grouped `listForRuns` call — past there.
        nowIso: clockPastFromCall(3),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'deadline-exceeded' });
      expect(deps.calls.listForRunsCalls).toBe(0);
      expect(deps.calls.attemptsRead).toEqual([]);
    });

    it('the deadline passing between the attempt reads of the head walk yields unknown/deadline-exceeded after one attempt read', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_1, ATTEMPT_2] })],
        attempts: new Map([
          [ATTEMPT_2, makeAttempt(ATTEMPT_2, null)],
          [ATTEMPT_1, makeAttempt(ATTEMPT_1, artifactsOf(HEAD_2))],
        ]),
        receipts: () => ({ outcome: 'none' }),
        // Calls 1-4: the initial, pre-journal and grouped-journal checks,
        // then the per-attempt check before the FIRST `findAttemptById` —
        // still before the deadline; call 5: the per-attempt check before
        // the second attempt read — past from there.
        nowIso: clockPastFromCall(5),
      });
      const result = await readShadowConformanceRuns(deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'deadline-exceeded' });
      expect(deps.calls.attemptsRead).toEqual([ATTEMPT_2]);
      expect(deps.calls.receiptsRead).toBe(0);
    });
  });

  describe('fakes', () => {
    it('no fake has a mutating method; only the picked read members exist', async () => {
      const deps = makeDeps({
        runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
        attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
        receipts: () => ({ outcome: 'none' }),
      });
      expect(Object.keys(deps.runs).sort()).toEqual(['list']);
      expect(Object.keys(deps.attempts).sort()).toEqual(['findAttemptById']);
      expect(Object.keys(deps.receipts).sort()).toEqual(['readReceiptsForHead']);
      expect(Object.keys(deps.journal).sort()).toEqual(['listForRun', 'listForRuns']);
      expect(await readShadowConformanceRuns(deps, request())).toEqual({
        status: 'ok',
        runs: [{
          runId: RUN_MERGED,
          tier: 2,
          pullRequest: PR,
          headOid: HEAD_2,
          reviewReceipts: [],
          journal: [],
        }],
      });
    });
  });
});

describe('readShadowConformanceRuns hostile input', () => {
  it('refuses null with unknown/invalid-request', async () => {
    const result = await readShadowConformanceRuns(makeDeps({}), null);
    expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
  });

  it('refuses undefined with unknown/invalid-request', async () => {
    const result = await readShadowConformanceRuns(makeDeps({}), undefined);
    expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
  });

  it('refuses a malformed deadlineIso with unknown/invalid-request', async () => {
    const deps = makeDeps({});
    const result = await readShadowConformanceRuns(deps, request({ deadlineIso: 'not-a-zoned-instant' }));
    expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
    expect(deps.calls.runsList).toBe(0);
  });

  it('refuses a number where the request record is due with unknown/invalid-request', async () => {
    const result = await readShadowConformanceRuns(makeDeps({}), 42);
    expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
  });

  it('refuses a string where the merged list is due with unknown/invalid-request', async () => {
    const result = await readShadowConformanceRuns(makeDeps({}), request({ mergedPullRequests: '41' }));
    expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
  });

  it('refuses a non-iterable object where the merged list is due with unknown/invalid-request', async () => {
    const result = await readShadowConformanceRuns(makeDeps({}), request({ mergedPullRequests: { [0]: PR } }));
    expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
  });

  it('refuses an array-like object where the merged list is due with unknown/invalid-request', async () => {
    const result = await readShadowConformanceRuns(
      makeDeps({}),
      request({ mergedPullRequests: { length: 1, 0: PR } }),
    );
    expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
  });

  it('refuses a foreign own key on the merged list (e.g. a constructor key) with unknown/invalid-request', async () => {
    const deps = makeDeps({});
    const items: number[] = [PR];
    Object.defineProperty(items, 'constructor', { enumerable: true, value: Object });
    const result = await readShadowConformanceRuns(deps, request({ mergedPullRequests: items }));
    expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
    expect(deps.calls.runsList).toBe(0);
  });

  it('refuses a negative index own key on the merged list (runs[-1]) with unknown/invalid-request', async () => {
    const deps = makeDeps({});
    const items: number[] = [PR];
    Object.defineProperty(items, '-1', { enumerable: true, value: {} });
    const result = await readShadowConformanceRuns(deps, request({ mergedPullRequests: items }));
    expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
    expect(deps.calls.runsList).toBe(0);
  });

  it('refuses a sparse array (a hole) with unknown/invalid-request', async () => {
    const sparse: number[] = [PR];
    sparse.length = 2;
    const result = await readShadowConformanceRuns(makeDeps({}), request({ mergedPullRequests: sparse }));
    expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
  });

  it('refuses an enormous length before any traversal with unknown/invalid-request', async () => {
    const deps = makeDeps({});
    const sparse: number[] = [];
    sparse.length = 2 ** 32 - 1;
    const result = await readShadowConformanceRuns(deps, request({ mergedPullRequests: sparse }));
    expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
    expect(deps.calls.runsList).toBe(0);
  });

  it('refuses a dense list over the request cap with unknown/invalid-request', async () => {
    const deps = makeDeps({});
    const overCap = Array.from(
      { length: SHADOW_FACTS_MAX_MERGED_PULL_REQUESTS + 1 },
      (_, index) => index + 1,
    );
    const result = await readShadowConformanceRuns(deps, request({ mergedPullRequests: overCap }));
    expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
    expect(deps.calls.runsList).toBe(0);
  });

  it('refuses a non-integer or sub-1 pull request id with unknown/invalid-request', async () => {
    const deps = makeDeps({});
    for (const bad of [0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await readShadowConformanceRuns(deps, request({ mergedPullRequests: [bad] }));
      expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
    }
    expect(deps.calls.runsList).toBe(0);
  });

  it('refuses a getter on a merged item without running it (unknown/invalid-request)', async () => {
    const deps = makeDeps({});
    const items: number[] = [PR];
    let itemGetCalls = 0;
    Object.defineProperty(items, 0, {
      enumerable: true,
      get: () => {
        itemGetCalls += 1;
        return PR;
      },
    });
    const result = await readShadowConformanceRuns(deps, request({ mergedPullRequests: items }));
    expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
    expect(itemGetCalls).toBe(0);
  });

  it('refuses a getter on the request root without running it (unknown/invalid-request)', async () => {
    const deps = makeDeps({});
    let rootGetCalls = 0;
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'mergedPullRequests', {
      enumerable: true,
      get: () => {
        rootGetCalls += 1;
        return [PR];
      },
    });
    const result = await readShadowConformanceRuns(deps, hostile);
    expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
    expect(rootGetCalls).toBe(0);
  });

  it('a Proxy over a valid request yields exactly the plain result and runs no get trap', async () => {
    const deps = makeDeps({
      runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
      attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
      receipts: () => ({ outcome: 'none' }),
    });
    const plain = request();
    let getCalls = 0;
    const proxied = new Proxy(plain, {
      get: (target, property) => {
        getCalls += 1;
        return Reflect.get(target, property);
      },
    });
    const plainResult = await readShadowConformanceRuns(deps, plain);
    const proxiedResult = await readShadowConformanceRuns(deps, proxied);
    expect(proxiedResult).toEqual(plainResult);
    expect(getCalls).toBe(0);
  });

  it('a request Proxy whose ownKeys trap throws yields unknown/invalid-request and nothing rejects', async () => {
    const deps = makeDeps({});
    let ownKeysCalls = 0;
    const proxied = new Proxy(request(), {
      ownKeys: () => {
        ownKeysCalls += 1;
        throw new Error(UNREADABLE_ERROR);
      },
    });
    const result = await readShadowConformanceRuns(deps, proxied);
    expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
    expect(deps.calls.runsList).toBe(0);
    expect(ownKeysCalls).toBeLessThanOrEqual(1);
    expect(JSON.stringify(result)).not.toContain(UNREADABLE_ERROR);
  });

  it('a request Proxy whose getPrototypeOf trap throws yields unknown/invalid-request and nothing rejects', async () => {
    const deps = makeDeps({});
    const proxied = new Proxy(request(), {
      getPrototypeOf: () => {
        throw new Error(UNREADABLE_ERROR);
      },
    });
    const result = await readShadowConformanceRuns(deps, proxied);
    expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
    expect(deps.calls.runsList).toBe(0);
    expect(JSON.stringify(result)).not.toContain(UNREADABLE_ERROR);
  });

  it('the mergedPullRequests Proxy whose ownKeys trap throws yields unknown/invalid-request and nothing rejects', async () => {
    const deps = makeDeps({
      runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
      attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
      receipts: () => ({ outcome: 'none' }),
    });
    let ownKeysCalls = 0;
    const plain = request();
    const hostile = {
      ...plain,
      mergedPullRequests: new Proxy(plain.mergedPullRequests as object, {
        ownKeys: (target) => {
          ownKeysCalls += 1;
          Reflect.ownKeys(target);
          throw new Error(UNREADABLE_ERROR);
        },
      }),
    };
    const result = await readShadowConformanceRuns(deps, hostile);
    // The reader walks the merged list's own keys, so the trap actually fires
    // and the throw is refused, never propagated.
    expect(ownKeysCalls).toBe(1);
    expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
    expect(deps.calls.runsList).toBe(0);
    expect(JSON.stringify(result)).not.toContain(UNREADABLE_ERROR);
  });

  it('refuses a prototype-polluting own key from JSON.parse with unknown/invalid-request', async () => {
    const deps = makeDeps({});
    const hostile = JSON.parse(
      `{"__proto__":{},"constructor":1,"prototype":2,"mergedPullRequests":[${PR}],"deadlineIso":"${DEADLINE_ISO}"}`,
    ) as Record<string, unknown>;
    const result = await readShadowConformanceRuns(deps, hostile);
    expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
    expect(deps.calls.runsList).toBe(0);
  });

  it('readMergedPullRequestIds called directly with a Proxy whose ownKeys trap throws returns null and never throws', () => {
    const hostile = new Proxy([PR], {
      ownKeys: () => { throw 42; },
    });
    expect(() => readMergedPullRequestIds(hostile)).not.toThrow();
    expect(readMergedPullRequestIds(hostile)).toBeNull();
  });

  it('the reader is not a constant: the same deps flip the answer when the request changes', async () => {
    const deps = makeDeps({
      runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
      attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
      receipts: () => ({ outcome: 'none' }),
    });
    const okResult = await readShadowConformanceRuns(deps, request());
    const refusedResult = await readShadowConformanceRuns(deps, request({ mergedPullRequests: 'no' }));
    expect(okResult.status).toBe('ok');
    expect(refusedResult).toEqual({ status: 'unknown', reason: 'invalid-request' });
  });

  it('the reader is not an identity echo: the ok result carries exactly the evaluator facts', async () => {
    const deps = makeDeps({
      runs: [collectedRun({ attemptIds: [ATTEMPT_2] })],
      attempts: new Map([[ATTEMPT_2, makeAttempt(ATTEMPT_2, artifactsOf(HEAD_2))]]),
      receipts: () => ({ outcome: 'none' }),
    });
    const result = await readShadowConformanceRuns(deps, request());
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      status: 'ok',
      runs: [{
        runId: RUN_MERGED,
        tier: 2,
        pullRequest: PR,
        headOid: HEAD_2,
        reviewReceipts: [],
        journal: [],
      }],
    });
  });
});
