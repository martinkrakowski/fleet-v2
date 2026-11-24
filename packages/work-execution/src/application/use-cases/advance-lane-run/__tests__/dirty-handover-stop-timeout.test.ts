import { describe, expect, it, vi } from 'vitest';
import {
  MAX_JOURNAL_SCAN_ENTRIES,
  lastStopLeftTimedOutSeat,
} from '../dirty-handover.js';
import { performStop, STOP_TIMEOUT_PATCH_SUFFIX, STOP_TIMEOUT_PRESERVE_DETAIL } from '../stop-cancel.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from '../step-context.js';
import type { LaneRunJournalEntryRecord, LaneRunJournalOutcome } from '../../../../domain/lane-run-journal.js';
import type { LaneRunRecord } from '../../../../domain/lane-run-records.js';
import type { LaneRunDecision } from '../../../../domain/lane-run-decider.js';
import type { AttemptRecord } from '../../../../domain/execution-records.js';
import type { AdvanceLaneRunRequest } from '../../../ports/in/AdvanceLaneRunPort.in-port.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const ATTEMPT_ID = 'attempt-01JB0000000000000000000001';
const WORKTREE = '/var/lane/run-01JB0000000000000000000000';
const STOP_KEY = `${RUN_ID}/r1/stop/0`;
const DISPATCH_KEY = `${RUN_ID}/r1/dispatch/0/a1`;
const COLLECT_KEY = `${RUN_ID}/r1/collect/0/a1`;

let entryCounter = 0;

/** A minimal valid run-journal result entry; every field is overridden per test. */
function entryOf(overrides: {
  kind?: 'intent' | 'result' | 'conduct';
  key?: string | null;
  runId?: string | null;
  outcome?: LaneRunJournalOutcome | null;
  reasonCode?: string | null;
}): LaneRunJournalEntryRecord {
  entryCounter += 1;
  return {
    version: 1,
    entryId: `01JB00000000000000000000${String(entryCounter).padStart(2, '0')}`,
    kind: overrides.kind ?? 'result',
    key: overrides.key ?? null,
    runId: overrides.runId ?? RUN_ID,
    recordedAtIso: '2026-11-20T00:00:00.000Z',
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: overrides.outcome ?? null,
    reasonCode: overrides.reasonCode ?? null,
    detail: null,
    grantId: null,
    state: null,
  };
}

function stopTimeoutEntry(overrides?: Parameters<typeof entryOf>[0]): LaneRunJournalEntryRecord {
  return entryOf({ key: STOP_KEY, outcome: 'completed', reasonCode: 'stop-timeout', ...overrides });
}

describe('lastStopLeftTimedOutSeat', () => {
  it('reads true for a stop-timeout stop result', () => {
    expect(lastStopLeftTimedOutSeat([stopTimeoutEntry()], RUN_ID)).toBe(true);
  });

  it('reads true for the latest stop result when earlier journal noise precedes it', () => {
    const dispatchRefused = entryOf({ key: DISPATCH_KEY, outcome: 'refused', reasonCode: 'dispatch-refused' });
    expect(lastStopLeftTimedOutSeat([dispatchRefused, stopTimeoutEntry()], RUN_ID)).toBe(true);
  });

  it('reads false for a non-timeout stop result resetting the condition', () => {
    expect(lastStopLeftTimedOutSeat(
      [stopTimeoutEntry(), entryOf({ key: STOP_KEY, outcome: 'completed', reasonCode: 'stop-unconfirmed' })],
      RUN_ID,
    )).toBe(false);
  });

  it('reads false when a completed dispatch result follows the stop-timeout', () => {
    expect(lastStopLeftTimedOutSeat(
      [stopTimeoutEntry(), entryOf({ key: DISPATCH_KEY, outcome: 'completed' })],
      RUN_ID,
    )).toBe(false);
  });

  it('reads false when a collect result follows the stop-timeout', () => {
    expect(lastStopLeftTimedOutSeat(
      [stopTimeoutEntry(), entryOf({ key: COLLECT_KEY, outcome: 'completed' })],
      RUN_ID,
    )).toBe(false);
  });

  it('reads true when only an ambiguous stop result follows the stop-timeout (ambiguous never counts)', () => {
    expect(lastStopLeftTimedOutSeat(
      [stopTimeoutEntry(), entryOf({ key: STOP_KEY, outcome: 'ambiguous' })],
      RUN_ID,
    )).toBe(true);
  });

  it('reads false when the latest stop result is ambiguous-only and no earlier stop-timeout exists', () => {
    expect(lastStopLeftTimedOutSeat(
      [entryOf({ key: DISPATCH_KEY, outcome: 'ambiguous' }), entryOf({ key: STOP_KEY, outcome: 'ambiguous' })],
      RUN_ID,
    )).toBe(false);
  });

  it('reads false for entries belonging to another run id', () => {
    expect(lastStopLeftTimedOutSeat([stopTimeoutEntry({ runId: 'run-01JB00000000000000000000ZZ' })], RUN_ID)).toBe(false);
  });

  it('reads false for an empty entry list', () => {
    expect(lastStopLeftTimedOutSeat([], RUN_ID)).toBe(false);
  });

  it('reads false for a stopped-but-healthy stop result (any other final stop reason resets)', () => {
    expect(lastStopLeftTimedOutSeat(
      [entryOf({ key: STOP_KEY, outcome: 'completed', reasonCode: 'stop-force' })],
      RUN_ID,
    )).toBe(false);
  });

  it('reads false for null entries', () => {
    expect(lastStopLeftTimedOutSeat(null as never, RUN_ID)).toBe(false);
  });

  it('reads false for undefined entries', () => {
    expect(lastStopLeftTimedOutSeat(undefined as never, RUN_ID)).toBe(false);
  });

  it('reads false for a non-iterable wrong primitive (a number, a string, a boolean)', () => {
    expect(lastStopLeftTimedOutSeat(42 as never, RUN_ID)).toBe(false);
    expect(lastStopLeftTimedOutSeat('entries' as never, RUN_ID)).toBe(false);
    expect(lastStopLeftTimedOutSeat(true as never, RUN_ID)).toBe(false);
  });

  it('reads false for an array-like object that is not a real array', () => {
    const arrayLike = { length: 1, 0: stopTimeoutEntry() };
    expect(lastStopLeftTimedOutSeat(arrayLike as never, RUN_ID)).toBe(false);
  });

  it('reads false for a sparse array hole', () => {
    const sparse: unknown[] = [stopTimeoutEntry()];
    sparse.length = 3;
    sparse[2] = stopTimeoutEntry();
    expect(lastStopLeftTimedOutSeat(sparse as never, RUN_ID)).toBe(false);
  });

  it('reads false when the journal length exceeds MAX_JOURNAL_SCAN_ENTRIES', () => {
    const long = new Array(MAX_JOURNAL_SCAN_ENTRIES + 1).fill(stopTimeoutEntry());
    expect(long.length).toBe(MAX_JOURNAL_SCAN_ENTRIES + 1);
    expect(lastStopLeftTimedOutSeat(long, RUN_ID)).toBe(false);
  });

  it('reads a journal exactly at MAX_JOURNAL_SCAN_ENTRIES normally', () => {
    const atBound = new Array(MAX_JOURNAL_SCAN_ENTRIES).fill(0).map((_, index) =>
      index === MAX_JOURNAL_SCAN_ENTRIES - 1
        ? stopTimeoutEntry()
        : entryOf({ key: COLLECT_KEY, outcome: 'completed' }),
    );
    expect(atBound.length).toBe(MAX_JOURNAL_SCAN_ENTRIES);
    expect(lastStopLeftTimedOutSeat(atBound, RUN_ID)).toBe(true);
  });

  it('reads false when the entries array itself carries a prototype-polluting own key', () => {
    const polluting: unknown[] = [stopTimeoutEntry()];
    Object.defineProperty(polluting, 'constructor', {
      value: {}, enumerable: false, configurable: true, writable: true,
    });
    expect(lastStopLeftTimedOutSeat(polluting as never, RUN_ID)).toBe(false);
  });

  it('reads false when an entry carries a prototype-polluting own key', () => {
    const polluting = stopTimeoutEntry() as unknown as Record<string, unknown>;
    Object.defineProperty(polluting, 'constructor', { value: Object, enumerable: false, configurable: true, writable: true });
    expect(lastStopLeftTimedOutSeat([polluting as never], RUN_ID)).toBe(false);
  });

  it('never invokes a getter on an entry property', () => {
    const getterEntry = {} as Record<string, unknown>;
    let getterRuns = 0;
    Object.defineProperty(getterEntry, 'kind', {
      enumerable: true,
      configurable: true,
      get: () => {
        getterRuns += 1;
        return 'result';
      },
    });
    expect(lastStopLeftTimedOutSeat([getterEntry as never], RUN_ID)).toBe(false);
    expect(getterRuns).toBe(0);
  });

  it('never invokes a getter on an array element', () => {
    const holder = [stopTimeoutEntry()] as unknown as Record<number, unknown>;
    let elementGetterRuns = 0;
    Object.defineProperty(holder, '0', {
      enumerable: true,
      configurable: true,
      get: () => {
        elementGetterRuns += 1;
        return stopTimeoutEntry();
      },
    });
    expect(lastStopLeftTimedOutSeat(holder as never, RUN_ID)).toBe(false);
    expect(elementGetterRuns).toBe(0);
  });

  it('never invokes a getter on an element reached through a forwarding Proxy', () => {
    const target: unknown[] = [];
    let elementGetterRuns = 0;
    Object.defineProperty(target, '0', {
      enumerable: true,
      configurable: true,
      get: () => {
        elementGetterRuns += 1;
        return stopTimeoutEntry();
      },
    });
    const proxy = new Proxy(target, {});
    expect(lastStopLeftTimedOutSeat(proxy as never, RUN_ID)).toBe(false);
    expect(elementGetterRuns).toBe(0);
  });

  it('reads false for a non-plain entry (class instance with a foreign prototype)', () => {
    class ForeignEntry {}
    const foreign = new ForeignEntry() as unknown;
    Object.assign(foreign as object, { kind: 'result', runId: RUN_ID, key: STOP_KEY, outcome: 'completed', reasonCode: 'stop-timeout' });
    expect(lastStopLeftTimedOutSeat([foreign as never], RUN_ID)).toBe(false);
  });

  it('reads false for a non-string or empty runId', () => {
    expect(lastStopLeftTimedOutSeat([stopTimeoutEntry()], '')).toBe(false);
    expect(lastStopLeftTimedOutSeat([stopTimeoutEntry()], undefined as never)).toBe(false);
    expect(lastStopLeftTimedOutSeat([stopTimeoutEntry()], 42 as never)).toBe(false);
  });

  it('reads false when an entry reports an own name it will not describe (lying descriptor)', () => {
    const lying = stopTimeoutEntry() as unknown as Record<string, unknown>;
    const proxy = new Proxy(lying, {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'ghost') {
          return undefined; // ownKeys reports it, the descriptor read denies it
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      ownKeys(target) {
        return [...Reflect.ownKeys(target), 'ghost'];
      },
    });
    expect(lastStopLeftTimedOutSeat([proxy as never], RUN_ID)).toBe(false);
  });

  it('reads false when a getPrototypeOf trap throws (hostile Proxy)', () => {
    const hostile = new Proxy(stopTimeoutEntry(), {
      getPrototypeOf() {
        throw new Error('getPrototypeOf refused');
      },
    });
    expect(() => lastStopLeftTimedOutSeat([hostile as never], RUN_ID)).not.toThrow();
    expect(lastStopLeftTimedOutSeat([hostile as never], RUN_ID)).toBe(false);
  });

  it('reads false when the entries object is hostile to getPrototypeOf too', () => {
    const hostileArray = new Proxy([stopTimeoutEntry()], {
      getPrototypeOf() {
        throw new Error('getPrototypeOf refused');
      },
    });
    expect(lastStopLeftTimedOutSeat(hostileArray as never, RUN_ID)).toBe(false);
  });

  it('reads false when the ownKeys trap of the entries object throws', () => {
    const hostileArray = new Proxy([stopTimeoutEntry()], {
      ownKeys() {
        throw new Error('ownKeys refused');
      },
    });
    expect(lastStopLeftTimedOutSeat(hostileArray as never, RUN_ID)).toBe(false);
  });

  it('reads false for a valid stop-timeout entry carrying an unrelated own getter (getter never runs)', () => {
    const entry = stopTimeoutEntry() as unknown as Record<string, unknown>;
    let getterRuns = 0;
    Object.defineProperty(entry, 'extra', {
      enumerable: true,
      configurable: true,
      get: () => {
        getterRuns += 1;
        return 'hostile';
      },
    });
    expect(lastStopLeftTimedOutSeat([entry as never], RUN_ID)).toBe(false);
    expect(getterRuns).toBe(0);
  });

  it('reads false for a valid stop-timeout entry carrying an own setter', () => {
    const entry = stopTimeoutEntry() as unknown as Record<string, unknown>;
    Object.defineProperty(entry, 'extra', {
      enumerable: true,
      configurable: true,
      set: () => {},
    });
    expect(lastStopLeftTimedOutSeat([entry as never], RUN_ID)).toBe(false);
  });

  it('reads false for a valid stop-timeout entry carrying an own symbol-keyed getter (getter never runs)', () => {
    const entry = stopTimeoutEntry() as unknown as Record<string, unknown>;
    let getterRuns = 0;
    const symbolKey = Symbol('hostile');
    Object.defineProperty(entry, symbolKey, {
      enumerable: true,
      configurable: true,
      get: () => {
        getterRuns += 1;
        return 'hostile';
      },
    });
    expect(lastStopLeftTimedOutSeat([entry as never], RUN_ID)).toBe(false);
    expect(getterRuns).toBe(0);
  });

  it('reads false for an entry that is a revoked Proxy (throws are read as false, never fatal)', () => {
    const { proxy, revoke } = Proxy.revocable(stopTimeoutEntry(), {});
    revoke();
    expect(() => lastStopLeftTimedOutSeat([proxy as never], RUN_ID)).not.toThrow();
    expect(lastStopLeftTimedOutSeat([proxy as never], RUN_ID)).toBe(false);
  });

  it('reads false when the entries object itself is a revoked Proxy', () => {
    const { proxy, revoke } = Proxy.revocable([stopTimeoutEntry()], {});
    revoke();
    expect(() => lastStopLeftTimedOutSeat(proxy as never, RUN_ID)).not.toThrow();
    expect(lastStopLeftTimedOutSeat(proxy as never, RUN_ID)).toBe(false);
  });

  it('reads false when the entries array carries an own symbol-keyed getter (getter never runs)', () => {
    const entries: unknown[] = [stopTimeoutEntry()];
    let getterRuns = 0;
    const symbolKey = Symbol('hostile');
    Object.defineProperty(entries, symbolKey, {
      enumerable: true,
      configurable: true,
      get: () => {
        getterRuns += 1;
        return 'hostile';
      },
    });
    expect(lastStopLeftTimedOutSeat(entries as never, RUN_ID)).toBe(false);
    expect(getterRuns).toBe(0);
  });

  it('reads false when the entries array has an inherited getter on a foreign prototype (getter never runs)', () => {
    let getterRuns = 0;
    const proto = Object.create(Object.prototype, {
      hostile: {
        enumerable: true,
        configurable: true,
        get: () => {
          getterRuns += 1;
          return 'hostile';
        },
      },
    });
    const entries: unknown[] = [stopTimeoutEntry()];
    Object.setPrototypeOf(entries, proto);
    expect(lastStopLeftTimedOutSeat(entries as never, RUN_ID)).toBe(false);
    expect(getterRuns).toBe(0);
  });
});

describe('lastStopLeftTimedOutSeat inherited getters on the shared prototypes', () => {
  for (const [label, proto] of [
    ['Array.prototype', Array.prototype],
    ['Object.prototype', Object.prototype],
  ] as const) {
    it(`reads false, never running the getter, when ${label} carries an unrelated accessor, and true again once it is removed`, () => {
      const entries = [stopTimeoutEntry()];
      expect(lastStopLeftTimedOutSeat(entries, RUN_ID)).toBe(true);
      let getterRuns = 0;
      Object.defineProperty(proto, 'cb3UnrelatedGetter', {
        configurable: true,
        enumerable: false,
        get: () => {
          getterRuns += 1;
          return 'hostile';
        },
      });
      try {
        expect(lastStopLeftTimedOutSeat(entries, RUN_ID)).toBe(false);
        expect(getterRuns).toBe(0);
      } finally {
        Reflect.deleteProperty(proto, 'cb3UnrelatedGetter');
      }
      expect(lastStopLeftTimedOutSeat(entries, RUN_ID)).toBe(true);
    });
  }

  it('reads false instead of throwing when Object.prototype carries a throwing accessor named get', () => {
    const entries = [stopTimeoutEntry()];
    Object.defineProperty(Object.prototype, 'get', {
      configurable: true,
      get: () => {
        throw new Error('inherited get must never be read');
      },
    });
    let result: boolean | 'threw' = 'threw';
    try {
      result = lastStopLeftTimedOutSeat(entries, RUN_ID);
    } catch {
      result = 'threw';
    } finally {
      Reflect.deleteProperty(Object.prototype, 'get');
    }
    expect(result).toBe(false);
  });
});

describe('performStop stop-timeout preserve (CB3)', () => {
  const mockRecord: LaneRunRecord = {
    version: 1,
    runId: RUN_ID,
    workOrderId: 'wo-1',
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': 0, fix: 0, review: null },
    round: 1,
    attemptIds: [ATTEMPT_ID],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-1',
    branchName: 'feat/test',
  };

  const mockRequest: AdvanceLaneRunRequest = {
    runId: RUN_ID,
    lease: { holderId: 'test-holder', fence: 1 },
    halted: false,
    nowIso: '2026-11-20T00:02:00.000Z',
  };

  const stopDecision: Extract<LaneRunDecision, { kind: 'act' }> = {
    kind: 'act',
    step: 'stop',
    key: STOP_KEY,
    round: 1,
    seatIndex: 0,
    head12: null,
    retry: null,
  };

  /** The timed-out attempt: ended with no receipt, so the stop completes. */
  const timedOutAttempt: AttemptRecord = {
    schemaVersion: 1,
    id: ATTEMPT_ID,
    workOrderId: 'wo-1',
    kind: 'fix',
    fixNumber: 1,
    priorAttemptId: 'attempt-01JB0000000000000000000000',
    state: 'ended',
    worktreePath: WORKTREE,
    baseCommit: '0'.repeat(40),
    outcome: null,
    briefPackagePath: '.lane/brief.md',
    briefDigest: 'b'.repeat(64),
    seatPlan: {
      version: 1,
      'first-pass': [{ id: 'fp1', model: 'alpha-1', tool: 'opencode' }],
      fix: [{ id: 'fx1', model: 'beta-1', tool: 'opencode' }],
      review: [],
    },
    seatSelection: { seatId: 'fx1', role: 'fix', model: 'beta-1', tool: 'opencode', agent: null, variant: null, seatIndex: 0 },
    runner: { kind: 'opencode', hostName: 'lane-host', host: null, remotePort: 1234, agent: null, model: null, variant: null },
    completionReceipt: null,
    artifacts: null,
    sessionId: null,
    stopReason: 'runner-refused',
    createdAtIso: '2026-11-20T00:00:00.000Z',
    updatedAtIso: '2026-11-20T00:01:00.000Z',
  };

  function gatheredOf(latest: AttemptRecord | null): GatheredLaneRunFacts {
    return {
      facts: {
        state: 'running',
        halted: false,
        stopMode: 'graceful',
        stopRequestedAtIso: '2026-11-20T00:01:30.000Z',
        stopGraceMinutes: 45,
        pendingIntent: null,
        admission: 'admitted',
        costCeilingReached: false,
        implementerSeat: { ok: true, seatIndex: 0 },
        reviewSeat: { ok: true, seatIndex: 0 },
        roundSeatIndexes: [],
        attempt: null,
        head12: null,
        acceptedHead12: null,
        gate: 'none',
        gateCongestion: null,
        briefCheck: { verdict: 'none', seatIndex: null, retries: 0 },
        codeReview: { verdict: 'none', seatIndex: null, retries: 0 },
        preMerge: 'none',
        premergePost: 'none',
        mergeEnqueue: 'none',
        acceptance: 'none',
        acceptanceRetry: null,
        ci: 'pending',
        pr: null,
        refusedStep: null,
        merge: { oneWayDoor: false, policyGrant: true },
      },
      deadlineUnknown: false,
      latestAttempt: latest,
      attemptRecords: latest === null ? [] : [latest],
    };
  }

  function ctxOf(latest: AttemptRecord | null, journalEntries: Array<{ attemptId?: string; detail: string | null }>) {
    const preserveWorktreeEdits = vi.fn().mockResolvedValue({
      outcome: 'preserved',
      patchPath: WORKTREE + '.' + ATTEMPT_ID + STOP_TIMEOUT_PATCH_SUFFIX,
      patchBytes: 100,
    });
    const appendJournalEntry = vi.fn().mockImplementation(async (entry: { attemptId?: string; detail: string | null }) => {
      journalEntries.push(entry);
    });
    const ctx: AdvanceStepContext = {
      deps: {
        runRepo: {
          save: vi.fn().mockImplementation(async (r: LaneRunRecord) => ({ outcome: 'saved', record: r })),
          get: vi.fn().mockResolvedValue(null),
        } as never,
        runJournal: {
          append: vi.fn().mockImplementation(async (e: unknown) => ({ outcome: 'appended', entry: e })),
          listForKey: vi.fn().mockResolvedValue([]),
          listForRun: vi.fn().mockResolvedValue([]),
        } as never,
        attemptRepo: { findAttemptById: vi.fn().mockResolvedValue(latest), saveAttempt: vi.fn() } as never,
        executionJournal: {
          listActiveReservations: vi.fn().mockResolvedValue([]),
          listJournalEntriesForAttempt: vi.fn().mockImplementation(
            async (attemptId: string) => journalEntries.filter((entry) => entry.attemptId === attemptId),
          ),
          appendJournalEntry,
        } as never,
        worktreeRecovery: { preserveWorktreeEdits },
        stopAttempt: {
          stopAttempt: vi.fn().mockResolvedValue({ outcome: 'terminated', capacityReleased: true }),
        },
        newUlid: () => '01JBNEWULID00000000000000',
      } as never,
    };
    return { ctx, preserveWorktreeEdits, appendJournalEntry };
  }

  it('preserves the timed-out seat tracked edits and journals the patch path once', async () => {
    const journalEntries: Array<{ attemptId?: string; detail: string | null }> = [];
    const { ctx, preserveWorktreeEdits, appendJournalEntry } = ctxOf(timedOutAttempt, journalEntries);
    const result = await performStop(ctx, mockRecord, gatheredOf(timedOutAttempt), stopDecision, mockRequest);
    expect(result).toMatchObject({ outcome: 'acted', result: 'completed', reasonCode: 'stop-timeout' });
    expect(preserveWorktreeEdits).toHaveBeenCalledWith({
      worktreePath: WORKTREE,
      patchPath: WORKTREE + '.' + ATTEMPT_ID + STOP_TIMEOUT_PATCH_SUFFIX,
      recordedHost: timedOutAttempt.runner,
    });
    const preserved = journalEntries.filter(
      (entry) => entry.detail !== null && entry.detail.startsWith(STOP_TIMEOUT_PRESERVE_DETAIL),
    );
    expect(preserved).toHaveLength(1);
    expect(preserved[0]?.detail).toBe(STOP_TIMEOUT_PRESERVE_DETAIL + WORKTREE + '.' + ATTEMPT_ID + STOP_TIMEOUT_PATCH_SUFFIX);
    expect(appendJournalEntry).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate the patch entry on a second stop-timeout of the same attempt', async () => {
    const patchPath = WORKTREE + '.' + ATTEMPT_ID + STOP_TIMEOUT_PATCH_SUFFIX;
    const journalEntries: Array<{ attemptId?: string; detail: string | null }> = [
      { attemptId: ATTEMPT_ID, detail: STOP_TIMEOUT_PRESERVE_DETAIL + patchPath },
    ];
    const { ctx, preserveWorktreeEdits, appendJournalEntry } = ctxOf(timedOutAttempt, journalEntries);
    const result = await performStop(ctx, mockRecord, gatheredOf(timedOutAttempt), stopDecision, mockRequest);
    expect(result).toMatchObject({ outcome: 'acted', result: 'completed', reasonCode: 'stop-timeout' });
    expect(preserveWorktreeEdits).not.toHaveBeenCalled();
    expect(appendJournalEntry).not.toHaveBeenCalled();
    expect(journalEntries).toHaveLength(1);
  });

  it('builds a distinct patch path for a new attempt and handles destination-exists silently', async () => {
    const secondAttempt: AttemptRecord = {
      ...timedOutAttempt,
      id: 'attempt-01JB0000000000000000000002',
      priorAttemptId: ATTEMPT_ID,
    };
    const secondPatchPath = WORKTREE + '.' + secondAttempt.id + STOP_TIMEOUT_PATCH_SUFFIX;
    const journalEntries: Array<{ attemptId?: string; detail: string | null }> = [
      { attemptId: ATTEMPT_ID, detail: STOP_TIMEOUT_PRESERVE_DETAIL + WORKTREE + '.' + ATTEMPT_ID + STOP_TIMEOUT_PATCH_SUFFIX },
    ];
    const { ctx, preserveWorktreeEdits } = ctxOf(secondAttempt, journalEntries);
    preserveWorktreeEdits.mockResolvedValue({ outcome: 'refused', reason: 'destination-exists' });
    const gathered = gatheredOf(secondAttempt);
    const result = await performStop(ctx, mockRecord, gathered, stopDecision, mockRequest);
    expect(result).toMatchObject({ outcome: 'acted', result: 'completed', reasonCode: 'stop-timeout' });
    expect(preserveWorktreeEdits).toHaveBeenCalledWith(
      expect.objectContaining({ patchPath: secondPatchPath }),
    );
    // destination-exists still journals where the patch lives (idempotent re-handover).
    expect(journalEntries.some((entry) => entry.detail === STOP_TIMEOUT_PRESERVE_DETAIL + secondPatchPath)).toBe(true);
  });

  it('is silent and still returns acted stop-timeout when nothing can be preserved', async () => {
    const journalEntries: Array<{ attemptId?: string; detail: string | null }> = [];
    const { ctx, preserveWorktreeEdits, appendJournalEntry } = ctxOf(timedOutAttempt, journalEntries);
    preserveWorktreeEdits.mockResolvedValue({ outcome: 'nothing-to-preserve' });
    const result = await performStop(ctx, mockRecord, gatheredOf(timedOutAttempt), stopDecision, mockRequest);
    expect(result).toMatchObject({ outcome: 'acted', result: 'completed', reasonCode: 'stop-timeout' });
    expect(preserveWorktreeEdits).toHaveBeenCalled();
    expect(appendJournalEntry).not.toHaveBeenCalled();
  });

  it('is silent and still returns acted stop-timeout when the worktreeRecovery port is missing', async () => {
    const journalEntries: Array<{ attemptId?: string; detail: string | null }> = [];
    const { ctx, preserveWorktreeEdits } = ctxOf(timedOutAttempt, journalEntries);
    (ctx.deps as { worktreeRecovery?: unknown }).worktreeRecovery = undefined;
    const result = await performStop(ctx, mockRecord, gatheredOf(timedOutAttempt), stopDecision, mockRequest);
    expect(result).toMatchObject({ outcome: 'acted', result: 'completed', reasonCode: 'stop-timeout' });
    expect(preserveWorktreeEdits).not.toHaveBeenCalled();
    expect(journalEntries).toHaveLength(0);
  });

  it('is silent and still returns acted stop-timeout when the preserve call throws', async () => {
    const journalEntries: Array<{ attemptId?: string; detail: string | null }> = [];
    const { ctx, preserveWorktreeEdits, appendJournalEntry } = ctxOf(timedOutAttempt, journalEntries);
    preserveWorktreeEdits.mockRejectedValue(new Error('host unreachable'));
    const result = await performStop(ctx, mockRecord, gatheredOf(timedOutAttempt), stopDecision, mockRequest);
    expect(result).toMatchObject({ outcome: 'acted', result: 'completed', reasonCode: 'stop-timeout' });
    expect(appendJournalEntry).not.toHaveBeenCalled();
  });
});
