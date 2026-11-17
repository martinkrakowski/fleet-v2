/**
 * SH18b tests: `readShadowGateHeads`, the fail-closed reader of the conducted
 * gate-head facts S4' (SH11) evaluates. In-memory fakes implementing only the
 * picked read members (no mutator exists on any fake); fixture values are
 * `example-*`. Hostile input never throws: every refusal is a typed `unknown`
 * result with a code, and no error message is echoed.
 */

import { describe, expect, it } from 'vitest';

import {
  SHADOW_FACTS_MAX_ATTEMPTS_PER_RUN,
  SHADOW_FACTS_MAX_RUNS,
  readShadowGateHeads,
  type ShadowGateHeadsDependencies,
} from '../shadow-day/index.js';
import {
  SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN,
} from '../../../domain/shadow-day-conformance.js';
import {
  SHADOW_GATE_CONTEXT,
  SHADOW_GATE_MAX_HEADS,
} from '../../../domain/shadow-day-gate-agreement.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import { LANE_RUN_RECORD_VERSION, type LaneRunRecord } from '../../../domain/lane-run-records.js';
import {
  LANE_RUN_JOURNAL_ENTRY_VERSION,
  type LaneRunJournalEntryRecord,
} from '../../../domain/lane-run-journal.js';
import type { AttemptRecord } from '../../../domain/execution-records.js';

const DAY = '2026-11-28';
/** Day D-2 00:00Z: the window's inclusive start (D+1 00:00Z is the exclusive end). */
const WINDOW_START_ISO = '2026-11-26T00:00:00.000Z';
/** Day D-3: outside the window on the early side. */
const BEFORE_WINDOW_ISO = '2026-11-25T12:00:00.000Z';
const DEADLINE_ISO = '2026-11-30T00:00:00.000Z';
/** Before the deadline by instant. */
const NOW_ISO = '2026-11-29T23:00:00.000Z';
/** Equal to the deadline instant via a different offset (the instant rule). */
const AT_DEADLINE_OFFSET_ISO = '2026-11-29T21:00:00.000-03:00';
const HEAD_1 = 'a'.repeat(40);
const HEAD_2 = 'b'.repeat(40);
const HEAD_3 = 'c'.repeat(40);
const HEAD_12_1 = HEAD_1.slice(0, 12);
const HEAD_12_2 = HEAD_2.slice(0, 12);
const HEAD_12_3 = HEAD_3.slice(0, 12);
const RUN_1 = 'run-01JB0000000000000000000000';
const RUN_2 = 'run-01JC0000000000000000000000';
const ATTEMPT_1 = 'attempt-01JB0000000000000000000000';
const ATTEMPT_2 = 'attempt-01JC0000000000000000000000';
const REPOSITORY = { owner: 'example-owner', repo: 'example-repo' };
const UNREADABLE_ERROR = 'example-unreadable-store-error';

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    day: DAY,
    repository: REPOSITORY,
    deadlineIso: DEADLINE_ISO,
    ...overrides,
  };
}

function makeRun(runId: string, overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  return {
    version: LANE_RUN_RECORD_VERSION,
    runId,
    workOrderId: 'example-work-order-1',
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

function stepKey(runId: string, step: 'open-pr' | 'push' | 'gate', head12: string): string {
  const built = buildLaneRunStepKey({
    runId,
    round: 0,
    step,
    seatIndex: 0,
    attemptOrdinal: null,
    head12,
    retry: null,
  });
  if (!built.ok) {
    throw new Error('example-fixture-key-error');
  }
  return built.key;
}

interface EntryOverrides {
  readonly kind?: LaneRunJournalEntryRecord['kind'];
  readonly outcome?: LaneRunJournalEntryRecord['outcome'];
  readonly reasonCode?: string | null;
}

function makeEntry(
  key: string | null,
  recordedAtIso: string,
  overrides: EntryOverrides = {},
): LaneRunJournalEntryRecord {
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: 'entry-' + recordedAtIso + '-' + String(key),
    kind: overrides.kind ?? 'result',
    key,
    runId: null,
    recordedAtIso,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: overrides.outcome ?? 'completed',
    reasonCode: overrides.reasonCode ?? null,
  } as unknown as LaneRunJournalEntryRecord;
}

function makeAttempt(id: string, headCommit: string | null): AttemptRecord {
  return {
    id,
    workOrderId: 'example-work-order-1',
    kind: 'work',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/example/worktree',
    baseCommit: 'd'.repeat(40),
    state: 'collected',
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts:
      headCommit === null
        ? null
        : {
            headCommit,
            commitsSinceBase: [],
            collectedArtifactPaths: [],
            notes: 'missing',
          },
  } as unknown as AttemptRecord;
}

interface Fakes {
  readonly deps: ShadowGateHeadsDependencies;
  readonly forgeCalls: { readonly headSha: string; readonly contextName: string; readonly repository: unknown; readonly timeoutMs: number }[];
  readonly listForRunCalls: string[];
  readonly attemptCalls: string[];
  readonly runsListCalls: number;
}

interface FakesOverrides {
  readonly runRecords?: readonly LaneRunRecord[];
  readonly journals?: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>;
  readonly listForRuns?: unknown;
  readonly readCommitContext?: unknown;
  readonly attemptsById?: ReadonlyMap<string, AttemptRecord | null>;
  readonly nowIso?: () => string;
  readonly runsList?: () => Promise<unknown>;
}

function makeFakes(overrides: FakesOverrides = {}): Fakes {
  const forgeCalls: Fakes['forgeCalls'] = [];
  const listForRunCalls: string[] = [];
  const attemptCalls: string[] = [];
  let runsListCalls = 0;
  const runRecords = overrides.runRecords ?? [];
  const journals = overrides.journals ?? new Map();
  const attemptsById = overrides.attemptsById ?? new Map();
  const deps: ShadowGateHeadsDependencies = {
    runs: {
      list: overrides.runsList ?? (async () => {
        runsListCalls += 1;
        return runRecords;
      }),
    },
    journal: {
      listForRun: async (runId: string) => {
        listForRunCalls.push(runId);
        const entries = journals.get(runId);
        if (entries === undefined) {
          throw new Error(UNREADABLE_ERROR);
        }
        return entries;
      },
      ...(overrides.listForRuns !== undefined
        ? { listForRuns: overrides.listForRuns as never }
        : {}),
    },
    attempts: {
      findAttemptById: async (attemptId: string) => {
        attemptCalls.push(attemptId);
        if (!attemptsById.has(attemptId)) {
          throw new Error(UNREADABLE_ERROR);
        }
        return attemptsById.get(attemptId) ?? null;
      },
    },
    forge: {
      ...(overrides.readCommitContext !== undefined
        ? { readCommitContext: overrides.readCommitContext as never }
        : {}),
      ...(!('readCommitContext' in overrides)
        ? {
            readCommitContext: async (read: { readonly headSha: string; readonly contextName: string; readonly repository: unknown; readonly timeoutMs: number }) => {
              forgeCalls.push(read);
              return { outcome: 'found', headSha: read.headSha, state: 'success' };
            },
          }
        : {}),
    },
    nowIso: overrides.nowIso ?? ((): string => NOW_ISO),
  } as ShadowGateHeadsDependencies;
  return { deps, forgeCalls, listForRunCalls, attemptCalls, runsListCalls };
}

/** One run pushing and passing one head, with its attempt carrying the full sha. */
function passingRun(
  runId: string,
  attemptId: string,
  head12: string,
  headSha: string,
  pushedAtIso: string,
): { readonly run: LaneRunRecord; readonly entries: readonly LaneRunJournalEntryRecord[]; readonly attempt: AttemptRecord } {
  return {
    run: makeRun(runId, { attemptIds: [attemptId] }),
    entries: [
      makeEntry(stepKey(runId, 'push', head12), pushedAtIso),
      makeEntry(stepKey(runId, 'gate', head12), pushedAtIso, { reasonCode: 'gate-passed' }),
    ],
    attempt: makeAttempt(attemptId, headSha),
  };
}

describe('readShadowGateHeads', () => {
  it('reads three pushed heads across two runs, sorted by pushedAtIso then headOid', async () => {
    const first = passingRun(RUN_1, ATTEMPT_1, HEAD_12_1, HEAD_1, '2026-11-26T12:00:00.000Z');
    const second = passingRun(RUN_1.replace('01JB', '01JE'), ATTEMPT_2, HEAD_12_2, HEAD_2, '2026-11-27T12:00:00.000Z');
    const third = passingRun(RUN_2, 'attempt-01JD0000000000000000000000', HEAD_12_3, HEAD_3, '2026-11-28T06:00:00.000Z');
    const fakes = makeFakes({
      runRecords: [first.run, second.run, third.run],
      journals: new Map([
        [first.run.runId, first.entries],
        [second.run.runId, second.entries],
        [third.run.runId, third.entries],
      ]),
      attemptsById: new Map([
        [ATTEMPT_1, first.attempt],
        [ATTEMPT_2, second.attempt],
        ['attempt-01JD0000000000000000000000', third.attempt],
      ]),
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }
    expect(result.heads.map((head) => head.headOid)).toEqual([HEAD_1, HEAD_2, HEAD_3]);
    expect(result.heads.map((head) => head.pushedAtIso)).toEqual([
      '2026-11-26T12:00:00.000Z',
      '2026-11-27T12:00:00.000Z',
      '2026-11-28T06:00:00.000Z',
    ]);
    expect(result.heads.every((head) => head.conductorVerdict === 'pass' && head.ciGate === 'success')).toBe(true);
  });

  it('omits a head pushed on D-3, outside the trailing window', async () => {
    const first = passingRun(RUN_1, ATTEMPT_1, HEAD_12_1, HEAD_1, BEFORE_WINDOW_ISO);
    const fakes = makeFakes({
      runRecords: [first.run],
      journals: new Map([[first.run.runId, first.entries]]),
      attemptsById: new Map([[ATTEMPT_1, first.attempt]]),
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result).toEqual({ status: 'ok', heads: [] });
  });

  it('omits a pushed head whose only gate result is gate-congested', async () => {
    const entries = [
      makeEntry(stepKey(RUN_1, 'push', HEAD_12_1), '2026-11-27T12:00:00.000Z'),
      makeEntry(stepKey(RUN_1, 'gate', HEAD_12_1), '2026-11-27T13:00:00.000Z', { reasonCode: 'gate-congested' }),
    ];
    const fakes = makeFakes({
      runRecords: [makeRun(RUN_1, { attemptIds: [ATTEMPT_1] })],
      journals: new Map([[RUN_1, entries]]),
      attemptsById: new Map([[ATTEMPT_1, makeAttempt(ATTEMPT_1, HEAD_1)]]),
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result).toEqual({ status: 'ok', heads: [] });
    expect(fakes.attemptCalls).toEqual([]);
  });

  it('ignores an intent-kind record with a push key and a completed outcome', async () => {
    const entries = [
      makeEntry(stepKey(RUN_1, 'push', HEAD_12_1), '2026-11-27T10:00:00.000Z', { kind: 'intent' }),
      makeEntry(stepKey(RUN_1, 'gate', HEAD_12_1), '2026-11-27T11:00:00.000Z', { reasonCode: 'gate-passed' }),
    ];
    const fakes = makeFakes({
      runRecords: [makeRun(RUN_1, { attemptIds: [ATTEMPT_1] })],
      journals: new Map([[RUN_1, entries]]),
      attemptsById: new Map([[ATTEMPT_1, makeAttempt(ATTEMPT_1, HEAD_1)]]),
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result).toEqual({ status: 'ok', heads: [] });
    expect(fakes.attemptCalls).toEqual([]);
  });

  it('ignores an intent-kind record with a gate key and a completed outcome as a verdict', async () => {
    const entries = [
      makeEntry(stepKey(RUN_1, 'push', HEAD_12_1), '2026-11-27T10:00:00.000Z'),
      makeEntry(stepKey(RUN_1, 'gate', HEAD_12_1), '2026-11-27T11:00:00.000Z', {
        kind: 'intent',
        reasonCode: 'gate-passed',
      }),
    ];
    const fakes = makeFakes({
      runRecords: [makeRun(RUN_1, { attemptIds: [ATTEMPT_1] })],
      journals: new Map([[RUN_1, entries]]),
      attemptsById: new Map([[ATTEMPT_1, makeAttempt(ATTEMPT_1, HEAD_1)]]),
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result).toEqual({ status: 'ok', heads: [] });
    expect(fakes.attemptCalls).toEqual([]);
  });

  it('refuses journal-unreadable for a malformed record whose kind is not a journal kind', async () => {
    const entries = [
      makeEntry(stepKey(RUN_1, 'push', HEAD_12_1), '2026-11-27T10:00:00.000Z', {
        kind: 'diary' as unknown as 'result',
      }),
    ];
    const fakes = makeFakes({
      runRecords: [makeRun(RUN_1, { attemptIds: [ATTEMPT_1] })],
      journals: new Map([[RUN_1, entries]]),
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result).toEqual({ status: 'unknown', reason: 'journal-unreadable' });
  });

  it('carries conductorVerdict fail for a gate-failed head', async () => {
    const entries = [
      makeEntry(stepKey(RUN_1, 'push', HEAD_12_1), '2026-11-27T12:00:00.000Z'),
      makeEntry(stepKey(RUN_1, 'gate', HEAD_12_1), '2026-11-27T13:00:00.000Z', { reasonCode: 'gate-failed' }),
    ];
    const fakes = makeFakes({
      runRecords: [makeRun(RUN_1, { attemptIds: [ATTEMPT_1] })],
      journals: new Map([[RUN_1, entries]]),
      attemptsById: new Map([[ATTEMPT_1, makeAttempt(ATTEMPT_1, HEAD_1)]]),
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result).toEqual({
      status: 'ok',
      heads: [{ headOid: HEAD_1, conductorVerdict: 'fail', pushedAtIso: '2026-11-27T12:00:00.000Z', ciGate: 'success' }],
    });
  });

  it('ignores non-final gate results and takes the last final one in append order', async () => {
    const entries = [
      makeEntry(stepKey(RUN_1, 'push', HEAD_12_1), '2026-11-27T12:00:00.000Z'),
      makeEntry(stepKey(RUN_1, 'gate', HEAD_12_1), '2026-11-27T12:30:00.000Z', { outcome: 'ambiguous', reasonCode: 'gate-congested' }),
      makeEntry(stepKey(RUN_1, 'gate', HEAD_12_1), '2026-11-27T13:00:00.000Z', { reasonCode: 'gate-passed' }),
    ];
    const fakes = makeFakes({
      runRecords: [makeRun(RUN_1, { attemptIds: [ATTEMPT_1] })],
      journals: new Map([[RUN_1, entries]]),
      attemptsById: new Map([[ATTEMPT_1, makeAttempt(ATTEMPT_1, HEAD_1)]]),
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.heads[0]?.conductorVerdict).toBe('pass');
    }
  });

  it('dedupes repeated pushes of one head12 per run and keeps the earliest push in the window', async () => {
    const entries = [
      makeEntry(stepKey(RUN_1, 'push', HEAD_12_1), '2026-11-27T14:00:00.000Z'),
      makeEntry(stepKey(RUN_1, 'push', HEAD_12_1), '2026-11-27T10:00:00.000Z'),
      makeEntry(stepKey(RUN_1, 'gate', HEAD_12_1), '2026-11-27T15:00:00.000Z', { reasonCode: 'gate-passed' }),
    ];
    const fakes = makeFakes({
      runRecords: [makeRun(RUN_1, { attemptIds: [ATTEMPT_1] })],
      journals: new Map([[RUN_1, entries]]),
      attemptsById: new Map([[ATTEMPT_1, makeAttempt(ATTEMPT_1, HEAD_1)]]),
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result).toEqual({
      status: 'ok',
      heads: [{ headOid: HEAD_1, conductorVerdict: 'pass', pushedAtIso: '2026-11-27T10:00:00.000Z', ciGate: 'success' }],
    });
    expect(fakes.attemptCalls).toEqual([ATTEMPT_1]);
  });

  it('reads each attempt of a multi-head run exactly once', async () => {
    const entries = [
      makeEntry(stepKey(RUN_1, 'push', HEAD_12_1), '2026-11-27T10:00:00.000Z'),
      makeEntry(stepKey(RUN_1, 'gate', HEAD_12_1), '2026-11-27T11:00:00.000Z', { reasonCode: 'gate-passed' }),
      makeEntry(stepKey(RUN_1, 'push', HEAD_12_2), '2026-11-27T12:00:00.000Z'),
      makeEntry(stepKey(RUN_1, 'gate', HEAD_12_2), '2026-11-27T13:00:00.000Z', { reasonCode: 'gate-passed' }),
    ];
    const fakes = makeFakes({
      runRecords: [makeRun(RUN_1, { attemptIds: [ATTEMPT_1, ATTEMPT_2] })],
      journals: new Map([[RUN_1, entries]]),
      attemptsById: new Map([
        [ATTEMPT_1, makeAttempt(ATTEMPT_1, HEAD_1)],
        [ATTEMPT_2, makeAttempt(ATTEMPT_2, HEAD_2)],
      ]),
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result.status).toBe('ok');
    expect(fakes.attemptCalls).toEqual([ATTEMPT_1, ATTEMPT_2]);
  });

  it('reads one shared full headSha across two runs only once at the forge', async () => {
    const first = passingRun(RUN_1, ATTEMPT_1, HEAD_12_1, HEAD_1, '2026-11-27T10:00:00.000Z');
    const second = passingRun(RUN_2, ATTEMPT_2, HEAD_12_1, HEAD_1, '2026-11-27T12:00:00.000Z');
    const fakes = makeFakes({
      runRecords: [first.run, second.run],
      journals: new Map([
        [first.run.runId, first.entries],
        [second.run.runId, second.entries],
      ]),
      attemptsById: new Map([
        [ATTEMPT_1, first.attempt],
        [ATTEMPT_2, second.attempt],
      ]),
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result.status).toBe('ok');
    expect(fakes.forgeCalls.length).toBe(1);
    expect(fakes.forgeCalls[0]?.headSha).toBe(HEAD_1);
  });

  it('maps a forge not-found read to ciGate missing', async () => {
    const first = passingRun(RUN_1, ATTEMPT_1, HEAD_12_1, HEAD_1, '2026-11-27T10:00:00.000Z');
    const fakes = makeFakes({
      runRecords: [first.run],
      journals: new Map([[first.run.runId, first.entries]]),
      attemptsById: new Map([[ATTEMPT_1, first.attempt]]),
      readCommitContext: async () => ({ outcome: 'not-found' }),
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result).toEqual({
      status: 'ok',
      heads: [{ headOid: HEAD_1, conductorVerdict: 'pass', pushedAtIso: '2026-11-27T10:00:00.000Z', ciGate: 'missing' }],
    });
  });

  it('refuses forge-unavailable when a found read carries a mismatched headSha or an invalid state', async () => {
    for (const read of [
      { outcome: 'found', headSha: 'e'.repeat(40), state: 'success' },
      { outcome: 'found', headSha: HEAD_1, state: 'green' },
    ]) {
      const first = passingRun(RUN_1, ATTEMPT_1, HEAD_12_1, HEAD_1, '2026-11-27T10:00:00.000Z');
      const fakes = makeFakes({
        runRecords: [first.run],
        journals: new Map([[first.run.runId, first.entries]]),
        attemptsById: new Map([[ATTEMPT_1, first.attempt]]),
        readCommitContext: async () => read,
      });
      const result = await readShadowGateHeads(fakes.deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'forge-unavailable' });
    }
  });

  it('refuses forge-unavailable when the forge result is a non-object or carries an unexpected outcome', async () => {
    for (const read of [42, null, { outcome: 'boom' }, {}]) {
      const first = passingRun(RUN_1, ATTEMPT_1, HEAD_12_1, HEAD_1, '2026-11-27T10:00:00.000Z');
      const fakes = makeFakes({
        runRecords: [first.run],
        journals: new Map([[first.run.runId, first.entries]]),
        attemptsById: new Map([[ATTEMPT_1, first.attempt]]),
        readCommitContext: async () => read,
      });
      const result = await readShadowGateHeads(fakes.deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'forge-unavailable' });
    }
  });

  it('refuses forge-unavailable when the forge read is unavailable or throws', async () => {
    for (const read of [
      async () => ({ outcome: 'unavailable', reason: 'context-failed' }),
      async () => {
        throw new Error(UNREADABLE_ERROR);
      },
    ]) {
      const first = passingRun(RUN_1, ATTEMPT_1, HEAD_12_1, HEAD_1, '2026-11-27T10:00:00.000Z');
      const fakes = makeFakes({
        runRecords: [first.run],
        journals: new Map([[first.run.runId, first.entries]]),
        attemptsById: new Map([[ATTEMPT_1, first.attempt]]),
        readCommitContext: read,
      });
      const result = await readShadowGateHeads(fakes.deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'forge-unavailable' });
    }
  });

  it('refuses forge-read-missing when the forge read is absent', async () => {
    const first = passingRun(RUN_1, ATTEMPT_1, HEAD_12_1, HEAD_1, '2026-11-27T10:00:00.000Z');
    const deps = makeFakes({
      runRecords: [first.run],
      journals: new Map([[first.run.runId, first.entries]]),
      attemptsById: new Map([[ATTEMPT_1, first.attempt]]),
      readCommitContext: undefined,
    }).deps;
    const result = await readShadowGateHeads(deps, request());
    expect(result).toEqual({ status: 'unknown', reason: 'forge-read-missing' });
  });

  it('refuses runs-unreadable when runs.list throws or returns a non-array', async () => {
    for (const runsList of [
      async () => {
        throw new Error(UNREADABLE_ERROR);
      },
      async () => ({ length: 1 }),
    ]) {
      const fakes = makeFakes({ runsList });
      const result = await readShadowGateHeads(fakes.deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'runs-unreadable' });
    }
  });

  it('refuses runs-unreadable, without running the getter, when a run record field is an accessor', async () => {
    let getterRuns = 0;
    const hostileRun = { ...makeRun(RUN_1) } as Record<string, unknown>;
    Object.defineProperty(hostileRun, 'runId', {
      enumerable: true,
      get() {
        getterRuns += 1;
        return RUN_1;
      },
    });
    const fakes = makeFakes({ runRecords: [hostileRun as unknown as LaneRunRecord] });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result).toEqual({ status: 'unknown', reason: 'runs-unreadable' });
    expect(getterRuns).toBe(0);
  });

  it('refuses runs-unreadable, without rejecting, for a revoked Proxy from runs.list', async () => {
    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();
    const fakes = makeFakes({ runsList: async () => proxy });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result).toEqual({ status: 'unknown', reason: 'runs-unreadable' });
  });

  it('refuses too-many-runs when runs.list exceeds the stored-run cap', async () => {
    const fakes = makeFakes({
      runRecords: Array.from({ length: SHADOW_FACTS_MAX_RUNS + 1 }, (_, index) =>
        makeRun('run-01JB000000000000000000000' + String(index % 10)),
      ),
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result).toEqual({ status: 'unknown', reason: 'too-many-runs' });
  });

  it('falls back to one listForRun per run when listForRuns is absent', async () => {
    const first = passingRun(RUN_1, ATTEMPT_1, HEAD_12_1, HEAD_1, '2026-11-27T10:00:00.000Z');
    const second = passingRun(RUN_2, ATTEMPT_2, HEAD_12_2, HEAD_2, '2026-11-27T12:00:00.000Z');
    const fakes = makeFakes({
      runRecords: [first.run, second.run],
      journals: new Map([
        [first.run.runId, first.entries],
        [second.run.runId, second.entries],
      ]),
      attemptsById: new Map([
        [ATTEMPT_1, first.attempt],
        [ATTEMPT_2, second.attempt],
      ]),
      listForRuns: undefined,
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result.status).toBe('ok');
    expect(fakes.listForRunCalls).toEqual([first.run.runId, second.run.runId]);
  });

  it('refuses journal-unreadable when listForRuns is a non-Map, lacks a run, maps a non-array, or throws', async () => {
    const first = passingRun(RUN_1, ATTEMPT_1, HEAD_12_1, HEAD_1, '2026-11-27T10:00:00.000Z');
    for (const listForRuns of [
      async () => ({ [RUN_1]: first.entries }),
      async () => new Map<string, readonly LaneRunJournalEntryRecord[]>([]),
      async () => new Map([[RUN_1, { length: 1 }]]),
      async () => {
        throw new Error(UNREADABLE_ERROR);
      },
    ]) {
      const fakes = makeFakes({
        runRecords: [first.run],
        listForRuns,
      });
      const result = await readShadowGateHeads(fakes.deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'journal-unreadable' });
    }
  });

  it('refuses too-many-journal-entries when a run exceeds the per-run entry cap', async () => {
    const entries = Array.from({ length: SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN + 1 }, () =>
      makeEntry(null, WINDOW_START_ISO, { kind: 'conduct' }),
    );
    const fakes = makeFakes({
      runRecords: [makeRun(RUN_1)],
      journals: new Map([[RUN_1, entries]]),
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result).toEqual({ status: 'unknown', reason: 'too-many-journal-entries' });
  });

  it('refuses too-many-attempts when a verdicted run exceeds the per-run attempt cap', async () => {
    const entries = [
      makeEntry(stepKey(RUN_1, 'push', HEAD_12_1), '2026-11-27T10:00:00.000Z'),
      makeEntry(stepKey(RUN_1, 'gate', HEAD_12_1), '2026-11-27T11:00:00.000Z', { reasonCode: 'gate-passed' }),
    ];
    const attemptIds = Array.from({ length: SHADOW_FACTS_MAX_ATTEMPTS_PER_RUN + 1 }, (_, index) => 'attempt-' + String(index));
    const fakes = makeFakes({
      runRecords: [makeRun(RUN_1, { attemptIds })],
      journals: new Map([[RUN_1, entries]]),
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result).toEqual({ status: 'unknown', reason: 'too-many-attempts' });
    expect(fakes.attemptCalls).toEqual([]);
  });

  it('refuses attempt-unreadable when findAttemptById throws or returns null', async () => {
    for (const missing of ['throw', 'null'] as const) {
      const first = passingRun(RUN_1, ATTEMPT_1, HEAD_12_1, HEAD_1, '2026-11-27T10:00:00.000Z');
      const attemptsById = new Map<string, AttemptRecord | null>([
        [ATTEMPT_1, missing === 'null' ? null : first.attempt],
      ]);
      if (missing === 'throw') {
        attemptsById.delete(ATTEMPT_1);
      }
      const fakes = makeFakes({
        runRecords: [first.run],
        journals: new Map([[first.run.runId, first.entries]]),
        attemptsById,
      });
      const result = await readShadowGateHeads(fakes.deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'attempt-unreadable' });
    }
  });

  it('refuses head-unresolved when a verdicted head12 has zero or two distinct full shas', async () => {
    for (const headCommits of [[HEAD_2, HEAD_2], [HEAD_1, HEAD_12_1 + 'b'.repeat(28)]]) {
      const entries = [
        makeEntry(stepKey(RUN_1, 'push', HEAD_12_1), '2026-11-27T10:00:00.000Z'),
        makeEntry(stepKey(RUN_1, 'gate', HEAD_12_1), '2026-11-27T11:00:00.000Z', { reasonCode: 'gate-passed' }),
      ];
      const fakes = makeFakes({
        runRecords: [makeRun(RUN_1, { attemptIds: [ATTEMPT_1, ATTEMPT_2] })],
        journals: new Map([[RUN_1, entries]]),
        attemptsById: new Map(
          headCommits.map((headCommit, index) => [
            index === 0 ? ATTEMPT_1 : ATTEMPT_2,
            makeAttempt(index === 0 ? ATTEMPT_1 : ATTEMPT_2, headCommit),
          ]),
        ),
      });
      const result = await readShadowGateHeads(fakes.deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'head-unresolved' });
    }
  });

  it('refuses too-many-heads when the assembled heads exceed the SH11 cap', async () => {
    const headOf = (index: number): { head12: string; headSha: string } => {
      const head12 = index.toString(16).padStart(12, '0');
      return { head12, headSha: head12 + 'ab'.repeat(14) };
    };
    const runCount = Math.ceil((SHADOW_GATE_MAX_HEADS + 1) / SHADOW_FACTS_MAX_ATTEMPTS_PER_RUN);
    const runRecords: LaneRunRecord[] = [];
    const journals = new Map<string, readonly LaneRunJournalEntryRecord[]>();
    const attemptsById = new Map<string, AttemptRecord>();
    for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
      const runId = 'run-01JB' + '0'.repeat(20) + String(runIndex).padStart(2, '0');
      const attemptIds: string[] = [];
      const entries: LaneRunJournalEntryRecord[] = [];
      for (let headIndex = 0; headIndex < SHADOW_FACTS_MAX_ATTEMPTS_PER_RUN; headIndex += 1) {
        const serial = runIndex * SHADOW_FACTS_MAX_ATTEMPTS_PER_RUN + headIndex;
        const { head12, headSha } = headOf(serial);
        const attemptId = 'attempt-' + serial.toString().padStart(10, '0');
        attemptIds.push(attemptId);
        attemptsById.set(attemptId, makeAttempt(attemptId, headSha));
        entries.push(makeEntry(stepKey(runId, 'push', head12), '2026-11-27T10:00:00.000Z'));
        entries.push(makeEntry(stepKey(runId, 'gate', head12), '2026-11-27T11:00:00.000Z', { reasonCode: 'gate-passed' }));
      }
      runRecords.push(makeRun(runId, { attemptIds }));
      journals.set(runId, entries);
    }
    const fakes = makeFakes({ runRecords, journals, attemptsById });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result).toEqual({ status: 'unknown', reason: 'too-many-heads' });
  });

  it('refuses deadline-exceeded before any outbound call when the deadline instant is past or equal', async () => {
    for (const nowIso of [
      (): string => '2026-11-30T00:00:00.000Z',
      (): string => AT_DEADLINE_OFFSET_ISO,
      (): string => '2026-12-01T00:00:00.000Z',
    ]) {
      const fakes = makeFakes({ nowIso });
      const result = await readShadowGateHeads(fakes.deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'deadline-exceeded' });
      expect(fakes.forgeCalls).toEqual([]);
      expect(fakes.attemptCalls).toEqual([]);
    }
  });

  it('refuses deadline-exceeded with zero forge calls when nowIso throws or is not a zoned ISO time', async () => {
    for (const nowIso of [
      (): string => {
        throw new Error(UNREADABLE_ERROR);
      },
      (): string => 'not-a-time',
    ]) {
      const fakes = makeFakes({ nowIso });
      const result = await readShadowGateHeads(fakes.deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'deadline-exceeded' });
      expect(fakes.forgeCalls).toEqual([]);
    }
  });

  it('refuses deadline-exceeded with zero forge calls when nowIso degrades between reads and the forge call', async () => {
    const first = passingRun(RUN_1, ATTEMPT_1, HEAD_12_1, HEAD_1, '2026-11-27T10:00:00.000Z');
    let reads = 0;
    const fakes = makeFakes({
      runRecords: [first.run],
      journals: new Map([[first.run.runId, first.entries]]),
      attemptsById: new Map([[ATTEMPT_1, first.attempt]]),
      nowIso: (): string => {
        reads += 1;
        return reads === 1 ? NOW_ISO : 'not-a-time';
      },
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result).toEqual({ status: 'unknown', reason: 'deadline-exceeded' });
    expect(fakes.forgeCalls).toEqual([]);
  });

  it('passes contextName gate and the request repository with the remaining deadline budget to the forge', async () => {
    const first = passingRun(RUN_1, ATTEMPT_1, HEAD_12_1, HEAD_1, '2026-11-27T10:00:00.000Z');
    const fakes = makeFakes({
      runRecords: [first.run],
      journals: new Map([[first.run.runId, first.entries]]),
      attemptsById: new Map([[ATTEMPT_1, first.attempt]]),
      nowIso: (): string => '2026-11-29T23:00:00.500Z',
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result.status).toBe('ok');
    expect(fakes.forgeCalls).toEqual([
      {
        headSha: HEAD_1,
        contextName: SHADOW_GATE_CONTEXT,
        repository: REPOSITORY,
        timeoutMs: Date.parse(DEADLINE_ISO) - Date.parse('2026-11-29T23:00:00.500Z'),
      },
    ]);
  });

  it('never mutates: no fake carries a mutator and no mutator is called', async () => {
    const first = passingRun(RUN_1, ATTEMPT_1, HEAD_12_1, HEAD_1, '2026-11-27T10:00:00.000Z');
    const fakes = makeFakes({
      runRecords: [first.run],
      journals: new Map([[first.run.runId, first.entries]]),
      attemptsById: new Map([[ATTEMPT_1, first.attempt]]),
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result.status).toBe('ok');
    expect('append' in fakes.deps.journal).toBe(false);
    expect('save' in fakes.deps.runs).toBe(false);
    expect('lease' in fakes.deps.attempts).toBe(false);
  });

  it('echoes no error message from a throwing fake in an unknown result', async () => {
    const fakes = makeFakes({
      runsList: async () => {
        throw new Error(UNREADABLE_ERROR);
      },
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(JSON.stringify(result)).not.toContain(UNREADABLE_ERROR);
    expect(JSON.stringify(result)).not.toContain('Error');
  });

  it('fails a constant-verdict reader: a gate-failed head is reported as fail, not pass', async () => {
    const entries = [
      makeEntry(stepKey(RUN_1, 'push', HEAD_12_1), '2026-11-27T10:00:00.000Z'),
      makeEntry(stepKey(RUN_1, 'gate', HEAD_12_1), '2026-11-27T11:00:00.000Z', { reasonCode: 'gate-failed' }),
    ];
    const fakes = makeFakes({
      runRecords: [makeRun(RUN_1, { attemptIds: [ATTEMPT_1] })],
      journals: new Map([[RUN_1, entries]]),
      attemptsById: new Map([[ATTEMPT_1, makeAttempt(ATTEMPT_1, HEAD_1)]]),
    });
    const result = await readShadowGateHeads(fakes.deps, request());
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.heads[0]?.conductorVerdict).toBe('fail');
      expect(result.heads[0]?.ciGate).toBe('success');
    }
  });

  it('fails an identity-echo reader: the returned heads are facts, not the request', async () => {
    const first = passingRun(RUN_1, ATTEMPT_1, HEAD_12_1, HEAD_1, '2026-11-27T10:00:00.000Z');
    const fakes = makeFakes({
      runRecords: [first.run],
      journals: new Map([[first.run.runId, first.entries]]),
      attemptsById: new Map([[ATTEMPT_1, first.attempt]]),
    });
    const sent = request();
    const result = await readShadowGateHeads(fakes.deps, sent);
    expect(result).not.toBe(sent);
    expect(result).not.toEqual(sent);
    if (result.status === 'ok') {
      expect(result.heads[0]).toEqual({
        headOid: HEAD_1,
        conductorVerdict: 'pass',
        pushedAtIso: '2026-11-27T10:00:00.000Z',
        ciGate: 'success',
      });
    }
  });

  describe('hostile input', () => {
    it('refuses null', async () => {
      const fakes = makeFakes();
      const result = await readShadowGateHeads(fakes.deps, null);
      expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
    });

    it('refuses undefined', async () => {
      const fakes = makeFakes();
      const result = await readShadowGateHeads(fakes.deps, undefined);
      expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
    });

    it('refuses a number where the request object is due', async () => {
      const fakes = makeFakes();
      const result = await readShadowGateHeads(fakes.deps, 7);
      expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
    });

    it('refuses a sparse array where the request object is due', async () => {
      const fakes = makeFakes();
      const sparse: unknown[] = [];
      sparse[2] = DAY;
      const result = await readShadowGateHeads(fakes.deps, sparse);
      expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
    });

    it('refuses an array-like object where the request object is due', async () => {
      const fakes = makeFakes();
      const arrayLike = { length: 1, 0: DAY };
      const result = await readShadowGateHeads(fakes.deps, arrayLike);
      expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
    });

    it('refuses a string where the repository object is due', async () => {
      const fakes = makeFakes();
      const result = await readShadowGateHeads(fakes.deps, request({ repository: 'example-owner/example-repo' }));
      expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
    });

    it('refuses a wrong primitive for day and for deadlineIso', async () => {
      const fakes = makeFakes();
      for (const overrides of [{ day: 20261128 }, { deadlineIso: 0 }, { day: '2026-13-40' }, { day: '0026-01-01' }]) {
        const result = await readShadowGateHeads(fakes.deps, request(overrides));
        expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
      }
    });

    it('refuses a getter on the request root without running it', async () => {
      let getterRuns = 0;
      const hostile: Record<string, unknown> = {};
      Object.defineProperty(hostile, 'day', {
        enumerable: true,
        get() {
          getterRuns += 1;
          return DAY;
        },
      });
      hostile.repository = REPOSITORY;
      hostile.deadlineIso = DEADLINE_ISO;
      const fakes = makeFakes();
      const result = await readShadowGateHeads(fakes.deps, hostile);
      expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
      expect(getterRuns).toBe(0);
    });

    it('refuses a getter on the repository without running it', async () => {
      let getterRuns = 0;
      const hostileRepository: Record<string, unknown> = {};
      Object.defineProperty(hostileRepository, 'owner', {
        enumerable: true,
        get() {
          getterRuns += 1;
          return 'example-owner';
        },
      });
      hostileRepository.repo = 'example-repo';
      const fakes = makeFakes();
      const result = await readShadowGateHeads(fakes.deps, request({ repository: hostileRepository }));
      expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
      expect(getterRuns).toBe(0);
    });

    it('yields exactly the plain result for a Proxy over a valid request, running no get trap', async () => {
      let getTraps = 0;
      const valid = request();
      const proxy = new Proxy(valid, {
        get(target, key, receiver) {
          getTraps += 1;
          return Reflect.get(target, key, receiver);
        },
      });
      const fakes = makeFakes();
      const result = await readShadowGateHeads(fakes.deps, proxy);
      expect(result).toEqual({ status: 'ok', heads: [] });
      expect(getTraps).toBe(0);
    });

    it('refuses a request carrying a prototype-polluting own key', async () => {
      const hostileText = JSON.stringify({
        day: DAY,
        repository: REPOSITORY,
        deadlineIso: DEADLINE_ISO,
      }).replace('{', '{"__proto__":{"polluted":true},');
      const hostile: unknown = JSON.parse(hostileText);
      const fakes = makeFakes();
      const result = await readShadowGateHeads(fakes.deps, hostile);
      expect(result).toEqual({ status: 'unknown', reason: 'invalid-request' });
      expect((globalThis as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('refuses runs-unreadable, without running the getter, for a getter at index 0 of the runs array', async () => {
      let getterRuns = 0;
      const hostileRuns: unknown[] = [makeRun(RUN_1)];
      Object.defineProperty(hostileRuns, 0, {
        enumerable: true,
        get() {
          getterRuns += 1;
          return makeRun(RUN_1);
        },
      });
      const fakes = makeFakes({ runsList: async () => hostileRuns as unknown as LaneRunRecord[] });
      const result = await readShadowGateHeads(fakes.deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'runs-unreadable' });
      expect(getterRuns).toBe(0);
    });

    it('refuses journal-unreadable, without running the getter, for a getter at index 0 of a journal-entry array', async () => {
      let getterRuns = 0;
      const pushKey = stepKey(RUN_1, 'push', HEAD_12_1);
      const hostileEntries: unknown[] = [makeEntry(pushKey, WINDOW_START_ISO)];
      Object.defineProperty(hostileEntries, 0, {
        enumerable: true,
        get() {
          getterRuns += 1;
          return makeEntry(pushKey, WINDOW_START_ISO);
        },
      });
      const fakes = makeFakes({
        runRecords: [makeRun(RUN_1)],
        journals: new Map([[RUN_1, hostileEntries as unknown as readonly LaneRunJournalEntryRecord[]]]),
      });
      const result = await readShadowGateHeads(fakes.deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'journal-unreadable' });
      expect(getterRuns).toBe(0);
    });

    it('refuses an enormous sparse runs list before any traversal, with zero element reads', async () => {
      let getterRuns = 0;
      const hostileRuns: unknown[] = new Array(2 ** 32 - 1);
      Object.defineProperty(hostileRuns, 0, {
        enumerable: true,
        get() {
          getterRuns += 1;
          return null;
        },
      });
      const fakes = makeFakes({ runsList: async () => hostileRuns as unknown as LaneRunRecord[] });
      const result = await readShadowGateHeads(fakes.deps, request());
      expect(result).toEqual({ status: 'unknown', reason: 'too-many-runs' });
      expect(getterRuns).toBe(0);
    });

    it('refuses a string where a list is expected (runs list and journal list)', async () => {
      const stringRuns = makeFakes({ runsList: async () => 'example-runs-string' as unknown as LaneRunRecord[] });
      expect(await readShadowGateHeads(stringRuns.deps, request())).toEqual({
        status: 'unknown',
        reason: 'runs-unreadable',
      });
      const first = passingRun(RUN_1, ATTEMPT_1, HEAD_12_1, HEAD_1, '2026-11-27T10:00:00.000Z');
      const stringJournal = makeFakes({
        runRecords: [first.run],
        journals: new Map([[first.run.runId, 'example-entries-string' as unknown as readonly LaneRunJournalEntryRecord[]]]),
      });
      expect(await readShadowGateHeads(stringJournal.deps, request())).toEqual({
        status: 'unknown',
        reason: 'journal-unreadable',
      });
    });
  });
});
