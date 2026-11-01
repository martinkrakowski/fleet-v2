import { describe, expect, it } from 'vitest';

import {
  LANE_RUN_JOURNAL_ENTRY_VERSION,
  LANE_RUN_JOURNAL_SCHEMA_VERSION,
  laneRunJournalDispatchResult,
  laneRunJournalPendingIntent,
  laneRunJournalState,
  laneRunJournalStopFacts,
  prepareLaneRunJournalAppend,
  readLaneRunJournalEntry,
  readLaneRunJournalEntryRecord,
} from '../lane-run-journal.js';
import type {
  LaneRunJournalEntryKind,
  LaneRunJournalEntryRecord,
  LaneRunJournalOutcome,
} from '../lane-run-journal.js';
import {
  buildLaneRunStepKey,
  laneRunPremergeKey,
  laneRunResumeKey,
  laneRunStopForceKey,
  laneRunStopKey,
  parseLaneRunKey,
  reaperRepairKey,
  requestKey,
} from '../lane-run-keys.js';
import type { LaneRunKeyResult, LaneRunStopKeyMode } from '../lane-run-keys.js';
import type { LaneRunStateValue } from '../value-objects/LaneRunState.vo.js';

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal; the scanner still recognises the
 * shape, which is the point under test.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

const RUN_ID = 'run-01JB0000000000000000000000';
const RUN_ID_2 = 'run-01JB0000000000000000000001';
const HEAD12 = '0123456789ab';
const ULID = '01JB0000000000000000000000';

function mustBuild(result: LaneRunKeyResult): string {
  if (!result.ok) {
    throw new Error('unreachable: key builder');
  }
  return result.key;
}

const STEP_KEY = mustBuild(buildLaneRunStepKey({
  runId: RUN_ID, round: 1, step: 'gate', seatIndex: 0, attemptOrdinal: null, head12: HEAD12, retry: null,
}));
const DISPATCH_KEY = mustBuild(buildLaneRunStepKey({
  runId: RUN_ID, round: 0, step: 'dispatch', seatIndex: 0, attemptOrdinal: 1, head12: null, retry: null,
}));
const STOP_KEY = mustBuild(laneRunStopKey(RUN_ID));
const STOP_CLI_KEY = mustBuild(laneRunStopKey(RUN_ID, 'cli'));
const FORCE_KEY = mustBuild(laneRunStopForceKey(RUN_ID, 'cli'));
const FORCE_WEB_KEY = mustBuild(laneRunStopForceKey(RUN_ID, 'web'));
const RESUME_KEY = mustBuild(laneRunResumeKey(RUN_ID, 1));
const PREMERGE_KEY = mustBuild(laneRunPremergeKey(RUN_ID, 1, HEAD12));
const REQUEST_KEY = mustBuild(requestKey(ULID));
const REAPER_KEY = mustBuild(reaperRepairKey('attempt-example-1', 'dead-attempt', ULID));

let entryIdCounter = 0;
function nextEntryId(): string {
  const ordinal = String(entryIdCounter).padStart(22, '0').slice(-22);
  entryIdCounter += 1;
  return '01JB' + ordinal;
}

function baseEntry(kind: LaneRunJournalEntryKind): LaneRunJournalEntryRecord {
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: nextEntryId(),
    kind,
    key: null,
    runId: null,
    recordedAtIso: '2026-10-27T10:00:00.000Z',
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: null,
  };
}

function intent(key: string, extra: Partial<LaneRunJournalEntryRecord> = {}): LaneRunJournalEntryRecord {
  const parsed = parseLaneRunKey(key);
  const runId =
    parsed !== null &&
    (parsed.kind === 'step' || parsed.kind === 'stop' || parsed.kind === 'resume' || parsed.kind === 'premerge')
      ? parsed.runId
      : null;
  const mode = parsed !== null && parsed.kind === 'stop' ? parsed.mode : null;
  const expectedRevision = parsed !== null && (parsed.kind === 'stop' || parsed.kind === 'resume') ? 1 : null;
  return { ...baseEntry('intent'), key, runId, mode, expectedRevision, ...extra };
}

function result(key: string, outcome: LaneRunJournalOutcome, extra: Partial<LaneRunJournalEntryRecord> = {}): LaneRunJournalEntryRecord {
  const parsed = parseLaneRunKey(key);
  const runId =
    parsed !== null &&
    (parsed.kind === 'step' || parsed.kind === 'stop' || parsed.kind === 'resume' || parsed.kind === 'premerge')
      ? parsed.runId
      : null;
  return { ...baseEntry('result'), key, runId, outcome, ...extra };
}

function conduct(state: string, extra: Partial<LaneRunJournalEntryRecord> = {}): LaneRunJournalEntryRecord {
  return { ...baseEntry('conduct'), runId: RUN_ID, state: state as LaneRunStateValue, ...extra };
}

function withoutKey(entry: LaneRunJournalEntryRecord): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...entry };
  delete copy.key;
  return copy;
}

describe('readLaneRunJournalEntry', () => {
  it('accepts one valid entry per kind and key form', () => {
    const entries = [
      intent(STEP_KEY),
      intent(STOP_KEY),
      intent(FORCE_KEY),
      intent(RESUME_KEY),
      intent(PREMERGE_KEY),
      intent(REQUEST_KEY),
      intent(REAPER_KEY),
      result(STEP_KEY, 'completed'),
      result(STOP_KEY, 'completed'),
      result(STOP_CLI_KEY, 'completed'),
      result(FORCE_KEY, 'completed'),
      result(FORCE_WEB_KEY, 'completed'),
      result(RESUME_KEY, 'completed'),
      result(PREMERGE_KEY, 'completed'),
      conduct('running'),
    ];
    for (const entry of entries) {
      const read = readLaneRunJournalEntry(entry);
      expect(read.ok).toBe(true);
      if (!read.ok) {
        continue;
      }
      expect(read.entry).toEqual(entry);
      expect(Object.isFrozen(read.entry)).toBe(true);
      expect(read.entry).not.toBe(entry);
    }
  });

  it('normalises recordedAtIso to UTC', () => {
    const read = readLaneRunJournalEntry(intent(STEP_KEY, { recordedAtIso: '2026-10-27T10:00:00+02:00' }));
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.entry.recordedAtIso).toBe('2026-10-27T08:00:00.000Z');
  });

  const validationRows: Array<[unknown, string]> = [
    [null, 'LaneRunJournal entry must be a record with exactly the entry keys'],
    [{ ...intent(STEP_KEY), extra: true }, 'LaneRunJournal entry must be a record with exactly the entry keys'],
    [withoutKey(intent(STEP_KEY)), 'LaneRunJournal entry must be a record with exactly the entry keys'],
    [{ ...intent(STEP_KEY), version: 2 }, 'LaneRunJournal version must be 1'],
    [{ ...intent(STEP_KEY), entryId: 'x' }, 'LaneRunJournal entryId must be a ULID'],
    [{ ...intent(STEP_KEY), kind: 'note' }, 'LaneRunJournal kind must be intent, result or conduct'],
    [{ ...intent(STEP_KEY), recordedAtIso: '2026-10-27T10:00:00' }, 'LaneRunJournal recordedAtIso must be an ISO-8601 time with a zone'],
    [{ ...intent(STEP_KEY), recordedAtIso: '2026-02-31T10:00:00Z' }, 'LaneRunJournal recordedAtIso must be an ISO-8601 time with a zone'],
    [{ ...intent(STEP_KEY), key: null }, 'LaneRunJournal key must be a run journal key for intents and results and null for conduct'],
    [{ ...conduct('running'), key: STEP_KEY }, 'LaneRunJournal key must be a run journal key for intents and results and null for conduct'],
    [{ ...intent(STOP_KEY), mode: null }, 'LaneRunJournal mode does not match its key'],
    [{ ...result(STOP_KEY, 'completed'), mode: 'graceful' as LaneRunStopKeyMode }, 'LaneRunJournal mode does not match its key'],
    [{ ...result(FORCE_WEB_KEY, 'completed'), mode: 'force' as LaneRunStopKeyMode }, 'LaneRunJournal mode does not match its key'],
    [{ ...result(RESUME_KEY, 'completed'), expectedRevision: 1 }, 'LaneRunJournal expectedRevision must be a positive integer on stop and resume intents and null elsewhere'],
    [{ ...result(STOP_CLI_KEY, 'completed'), expectedRevision: 1 }, 'LaneRunJournal expectedRevision must be a positive integer on stop and resume intents and null elsewhere'],
    [{ ...intent(STEP_KEY), grantId: 'example-id' }, 'LaneRunJournal grantId must be null except on a result'],
    [{ ...conduct('running'), grantId: 'example-id' }, 'LaneRunJournal grantId must be null except on a result'],
    [{ ...intent(STEP_KEY), runId: RUN_ID_2 }, 'LaneRunJournal runId does not match its key'],
    [{ ...intent(PREMERGE_KEY), runId: null }, 'LaneRunJournal runId does not match its key'],
    [{ ...intent(PREMERGE_KEY), runId: RUN_ID_2 }, 'LaneRunJournal runId does not match its key'],
    [{ ...conduct('running'), runId: null }, 'LaneRunJournal runId does not match its key'],
    [{ ...intent(RESUME_KEY), expectedRevision: null }, 'LaneRunJournal expectedRevision must be a positive integer on stop and resume intents and null elsewhere'],
    [{ ...intent(STEP_KEY), expectedRevision: 3 }, 'LaneRunJournal expectedRevision must be a positive integer on stop and resume intents and null elsewhere'],
    [{ ...result(STEP_KEY, 'completed'), mintedId: 'example-id' }, 'LaneRunJournal mintedId must be null except on an intent'],
    [{ ...intent(STEP_KEY), outcome: 'completed' }, 'LaneRunJournal outcome must be a known outcome on a result and null elsewhere'],
    [{ ...result(STEP_KEY, 'completed'), reasonCode: 'Bad Code' }, 'LaneRunJournal reasonCode must be null or a lowercase token on a result'],
    [{ ...conduct('running'), state: 'sleeping' }, 'LaneRunJournal state must be a lane run state on conduct and null elsewhere'],
    [{ ...result(STEP_KEY, 'completed'), state: 'running' }, 'LaneRunJournal state must be a lane run state on conduct and null elsewhere'],
  ];

  it.each(validationRows)('refuses %j with the fixed message', (input, message) => {
    const read = readLaneRunJournalEntry(input);
    expect(read.ok).toBe(false);
    if (read.ok) {
      return;
    }
    expect(read.error).toBe(message);
  });

  it('refuses secret-shaped mintedId and grantId without echoing them', () => {
    const mintedRead = readLaneRunJournalEntry({ ...intent(STEP_KEY), mintedId: fakeSecretShape() });
    expect(mintedRead.ok).toBe(false);
    if (mintedRead.ok) {
      return;
    }
    expect(mintedRead.error).toContain('secret-shaped');
    expect(mintedRead.error).not.toContain(fakeSecretShape());

    const grantRead = readLaneRunJournalEntry({ ...result(STEP_KEY, 'completed'), grantId: fakeSecretShape() });
    expect(grantRead.ok).toBe(false);
    if (grantRead.ok) {
      return;
    }
    expect(grantRead.error).toContain('secret-shaped');
    expect(grantRead.error).not.toContain(fakeSecretShape());
  });

  it('never echoes distinctive input values', () => {
    const read = readLaneRunJournalEntry({ ...intent(STEP_KEY), entryId: 'XYZZY' });
    expect(read.ok).toBe(false);
    if (read.ok) {
      return;
    }
    expect(read.error).not.toContain('XYZZY');
  });

  it('never throws on a throwing getter or a hostile proxy', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'key', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
      configurable: true,
    });
    const read = readLaneRunJournalEntry(hostile);
    expect(read.ok).toBe(false);
    if (read.ok) {
      return;
    }
    expect(read.error).not.toContain('boom');

    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    const proxyRead = readLaneRunJournalEntry(proxy);
    expect(proxyRead.ok).toBe(false);
    if (proxyRead.ok) {
      return;
    }
    expect(proxyRead.error).not.toContain('boom');
  });
});

describe('detail (KF-14a)', () => {
  it('round-trips a result entry carrying a pattern-matching detail', () => {
    const entry = result(STEP_KEY, 'completed', { detail: 'route-no-auth-file' });
    const read = readLaneRunJournalEntry(entry);
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.entry).toEqual(entry);
    expect(read.entry.detail).toBe('route-no-auth-file');
  });

  it('round-trips a result entry carrying a chain base branch detail (CB-D2)', () => {
    const entry = result(STEP_KEY, 'completed', { detail: 'chain/example' });
    const read = readLaneRunJournalEntry(entry);
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.entry).toEqual(entry);
    expect(read.entry.detail).toBe('chain/example');
  });

  it('round-trips a result entry carrying a main base branch detail (CB-D2)', () => {
    const entry = result(STEP_KEY, 'completed', { detail: 'main' });
    const read = readLaneRunJournalEntry(entry);
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.entry.detail).toBe('main');
  });

  it('refuses a detail on an intent or conduct entry, like a reason code (KF-14a review)', () => {
    const intentEntry = { ...result(STEP_KEY, 'completed', { detail: null }), kind: 'intent', outcome: null, reasonCode: null, detail: 'route-no-port' };
    const read = readLaneRunJournalEntry(intentEntry);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error).toBe('LaneRunJournal detail must be null on an intent or conduct entry');
    }
  });

  it('refuses a free-text detail like a bad reason code', () => {
    const read = readLaneRunJournalEntry(result(STEP_KEY, 'completed', { detail: 'Host lane-host refuses' }));
    expect(read.ok).toBe(false);
    if (read.ok) {
      return;
    }
    expect(read.error).toBe('LaneRunJournal detail must be null or a lowercase token');
  });

  it('reads an old stored entry without the detail field as detail null', () => {
    const legacy = { ...result(STEP_KEY, 'completed') } as Record<string, unknown>;
    delete legacy.detail;
    const read = readLaneRunJournalEntry(legacy);
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.entry.detail).toBeNull();
  });
});

describe('prepareLaneRunJournalAppend', () => {
  it('refuses a duplicate step key intent', () => {
    const decision = prepareLaneRunJournalAppend([intent(STEP_KEY)], intent(STEP_KEY));
    expect(decision).toEqual({ ok: false, reason: 'duplicate-key', detail: null });
  });

  it('refuses a duplicate entry id', () => {
    const entry = intent(STEP_KEY);
    const decision = prepareLaneRunJournalAppend([entry], { ...intent(REQUEST_KEY), entryId: entry.entryId });
    expect(decision).toEqual({ ok: false, reason: 'duplicate-entry-id', detail: null });
  });

  it('appends the same step key under a retry key', () => {
    const retryKey = mustBuild(buildLaneRunStepKey({
      runId: RUN_ID, round: 1, step: 'gate', seatIndex: 0, attemptOrdinal: null, head12: HEAD12, retry: 1,
    }));
    const decision = prepareLaneRunJournalAppend([intent(STEP_KEY)], intent(retryKey));
    expect(decision.ok).toBe(true);
  });

  it('appends valid results under stop and resume keys after their intents', () => {
    for (const key of [STOP_KEY, STOP_CLI_KEY, FORCE_KEY, FORCE_WEB_KEY, RESUME_KEY]) {
      const decision = prepareLaneRunJournalAppend([intent(key)], result(key, 'completed'));
      expect(decision.ok).toBe(true);
    }
  });

  it('refuses a result under a stop or resume key that carries intent-only fields', () => {
    for (const key of [STOP_KEY, STOP_CLI_KEY, FORCE_KEY, FORCE_WEB_KEY, RESUME_KEY]) {
      expect(prepareLaneRunJournalAppend([intent(key)], { ...result(key, 'completed'), mode: 'force' as LaneRunStopKeyMode }).ok).toBe(false);
      expect(prepareLaneRunJournalAppend([intent(key)], { ...result(key, 'completed'), expectedRevision: 1 }).ok).toBe(false);
    }
  });

  it('still refuses an intent under a stop key with no mode', () => {
    const decision = prepareLaneRunJournalAppend([], { ...intent(STOP_KEY), mode: null });
    expect(decision).toEqual({ ok: false, reason: 'stop-mode-mismatch', detail: null });
    const read = readLaneRunJournalEntry({ ...intent(STOP_KEY), mode: null });
    expect(read.ok).toBe(false);
    if (read.ok) {
      return;
    }
    expect(read.error).toBe('LaneRunJournal mode does not match its key');
  });

  it('refuses a result without its intent', () => {
    const decision = prepareLaneRunJournalAppend([], result(STEP_KEY, 'completed'));
    expect(decision).toEqual({ ok: false, reason: 'result-without-intent', detail: null });
  });

  it('allows ambiguous results and then one final result, refusing anything after', () => {
    const intentEntry = intent(STEP_KEY);
    const ambiguous1 = result(STEP_KEY, 'ambiguous');
    const ambiguous2 = result(STEP_KEY, 'ambiguous');
    const final = result(STEP_KEY, 'completed');
    const after = result(STEP_KEY, 'reconciled');

    expect(prepareLaneRunJournalAppend([intentEntry], ambiguous1).ok).toBe(true);
    expect(prepareLaneRunJournalAppend([intentEntry, ambiguous1], ambiguous2).ok).toBe(true);
    expect(prepareLaneRunJournalAppend([intentEntry, ambiguous1, ambiguous2], final).ok).toBe(true);
    expect(prepareLaneRunJournalAppend([intentEntry, ambiguous1, ambiguous2, final], after)).toEqual({
      ok: false,
      reason: 'result-after-final',
      detail: null,
    });
  });

  it('refuses a result whose runId differs from its intent', () => {
    const decision = prepareLaneRunJournalAppend([intent(REQUEST_KEY)], result(REQUEST_KEY, 'completed', { runId: RUN_ID }));
    expect(decision).toEqual({
      ok: false,
      reason: 'invalid-entry',
      detail: "LaneRunJournal result runId must equal its intent's",
    });
  });

  it('refuses a stop intent whose mode does not match its key before anything else', () => {
    expect(prepareLaneRunJournalAppend([], { ...intent(STOP_KEY), mode: 'force' as LaneRunStopKeyMode })).toEqual({
      ok: false,
      reason: 'stop-mode-mismatch',
      detail: null,
    });
    expect(prepareLaneRunJournalAppend([], { ...intent(FORCE_KEY), mode: 'graceful' as LaneRunStopKeyMode })).toEqual({
      ok: false,
      reason: 'stop-mode-mismatch',
      detail: null,
    });
    expect(prepareLaneRunJournalAppend([], { ...intent(STOP_KEY), mode: null })).toEqual({
      ok: false,
      reason: 'stop-mode-mismatch',
      detail: null,
    });
  });

  it('applies the per-run stop check across channels', () => {
    const stopWebEntry = intent(STOP_KEY);
    const stopCliEntry = intent(STOP_CLI_KEY);
    const forceWebEntry = intent(FORCE_WEB_KEY);
    const forceCliEntry = intent(FORCE_KEY);

    expect(prepareLaneRunJournalAppend([stopWebEntry], stopCliEntry)).toEqual({
      ok: false,
      reason: 'stop-already-requested',
      detail: null,
    });
    expect(prepareLaneRunJournalAppend([stopCliEntry], stopWebEntry)).toEqual({
      ok: false,
      reason: 'stop-already-requested',
      detail: null,
    });
    expect(prepareLaneRunJournalAppend([stopWebEntry], { ...stopWebEntry, entryId: nextEntryId() })).toEqual({
      ok: false,
      reason: 'stop-already-requested',
      detail: null,
    });
    expect(prepareLaneRunJournalAppend([forceWebEntry], forceCliEntry)).toEqual({
      ok: false,
      reason: 'stop-already-requested',
      detail: null,
    });
    expect(prepareLaneRunJournalAppend([forceCliEntry], stopWebEntry)).toEqual({
      ok: false,
      reason: 'stop-already-forced',
      detail: null,
    });
    expect(prepareLaneRunJournalAppend([stopCliEntry], forceWebEntry).ok).toBe(true);
    expect(prepareLaneRunJournalAppend([intent(mustBuild(laneRunStopKey(RUN_ID_2)))], stopWebEntry).ok).toBe(true);
  });
});

describe('laneRunJournalStopFacts', () => {
  it('returns empty facts with no stop intents', () => {
    expect(laneRunJournalStopFacts([], RUN_ID)).toEqual({ stopMode: null, stopRequestedAtIso: null });
    expect(laneRunJournalStopFacts([intent(STEP_KEY)], RUN_ID)).toEqual({ stopMode: null, stopRequestedAtIso: null });
  });

  it('reports the first stop time and the strongest mode', () => {
    const stopWebEntry = { ...intent(STOP_KEY), recordedAtIso: '2026-10-27T09:00:00.000Z' };
    const forceCliEntry = { ...intent(FORCE_KEY), recordedAtIso: '2026-10-27T10:00:00.000Z' };
    expect(laneRunJournalStopFacts([stopWebEntry], RUN_ID)).toEqual({
      stopMode: 'graceful',
      stopRequestedAtIso: '2026-10-27T09:00:00.000Z',
    });
    expect(laneRunJournalStopFacts([stopWebEntry, forceCliEntry], RUN_ID)).toEqual({
      stopMode: 'force',
      stopRequestedAtIso: '2026-10-27T09:00:00.000Z',
    });
  });

  it('ignores entries of another run and malformed run ids', () => {
    const stopWebEntry = intent(STOP_KEY);
    expect(laneRunJournalStopFacts([stopWebEntry], RUN_ID_2)).toEqual({ stopMode: null, stopRequestedAtIso: null });
    expect(laneRunJournalStopFacts([stopWebEntry], 42 as unknown as string)).toEqual({
      stopMode: null,
      stopRequestedAtIso: null,
    });
  });
});

describe('laneRunJournalPendingIntent', () => {
  it('returns null with no entries or every intent settled', () => {
    expect(laneRunJournalPendingIntent([], RUN_ID)).toBeNull();
    expect(laneRunJournalPendingIntent([intent(DISPATCH_KEY), result(DISPATCH_KEY, 'completed')], RUN_ID)).toBeNull();
  });

  it('reports an unread pending intent', () => {
    expect(laneRunJournalPendingIntent([intent(DISPATCH_KEY)], RUN_ID)).toEqual({
      key: DISPATCH_KEY,
      step: 'dispatch',
      reconciliation: 'unread',
    });
  });

  it('reports an ambiguous pending intent', () => {
    expect(laneRunJournalPendingIntent([intent(DISPATCH_KEY), result(DISPATCH_KEY, 'ambiguous')], RUN_ID)).toEqual({
      key: DISPATCH_KEY,
      step: 'dispatch',
      reconciliation: 'ambiguous',
    });
  });

  it('never treats a stop intent as pending', () => {
    expect(laneRunJournalPendingIntent([intent(STOP_KEY)], RUN_ID)).toBeNull();
  });

  it('reports an unread premerge intent as pending', () => {
    expect(laneRunJournalPendingIntent([intent(PREMERGE_KEY)], RUN_ID)).toEqual({
      key: PREMERGE_KEY,
      step: 'premerge',
      reconciliation: 'unread',
    });
  });

  it('returns null for a premerge intent with a final result', () => {
    expect(laneRunJournalPendingIntent([intent(PREMERGE_KEY), result(PREMERGE_KEY, 'completed')], RUN_ID)).toBeNull();
  });

  it('reports an ambiguous premerge intent as pending', () => {
    expect(laneRunJournalPendingIntent([intent(PREMERGE_KEY), result(PREMERGE_KEY, 'ambiguous')], RUN_ID)).toEqual({
      key: PREMERGE_KEY,
      step: 'premerge',
      reconciliation: 'ambiguous',
    });
  });

  it('prefers the later of two open step intents', () => {
    const dispatch2 = mustBuild(buildLaneRunStepKey({
      runId: RUN_ID, round: 0, step: 'dispatch', seatIndex: 0, attemptOrdinal: 2, head12: null, retry: null,
    }));
    expect(laneRunJournalPendingIntent([intent(DISPATCH_KEY), intent(dispatch2)], RUN_ID)).toEqual({
      key: dispatch2,
      step: 'dispatch',
      reconciliation: 'unread',
    });
  });

  it('returns null for a malformed run id', () => {
    expect(laneRunJournalPendingIntent([], 42 as unknown as string)).toBeNull();
  });
});

describe('laneRunJournalState', () => {
  it('returns ready with no conduct entries', () => {
    expect(laneRunJournalState([], RUN_ID)).toBe('ready');
    expect(laneRunJournalState([intent(STEP_KEY)], RUN_ID)).toBe('ready');
  });

  it('returns the last conduct state', () => {
    expect(laneRunJournalState([conduct('running'), conduct('collecting')], RUN_ID)).toBe('collecting');
  });

  it('returns ready for a malformed run id', () => {
    expect(laneRunJournalState([], 42 as unknown as string)).toBe('ready');
  });
});

describe('laneRunJournalDispatchResult', () => {
  it('returns none with no intent or a malformed key', () => {
    expect(laneRunJournalDispatchResult([], DISPATCH_KEY)).toBe('none');
    expect(laneRunJournalDispatchResult([], 42 as unknown as string)).toBe('none');
  });

  it('returns started with an intent and no final result', () => {
    expect(laneRunJournalDispatchResult([intent(DISPATCH_KEY)], DISPATCH_KEY)).toBe('started');
    expect(laneRunJournalDispatchResult([intent(DISPATCH_KEY), result(DISPATCH_KEY, 'ambiguous')], DISPATCH_KEY)).toBe('started');
  });

  it('returns not-started for final not-started, refused and dry-run', () => {
    for (const outcome of ['not-started', 'refused', 'dry-run'] as const) {
      expect(laneRunJournalDispatchResult([intent(DISPATCH_KEY), result(DISPATCH_KEY, outcome)], DISPATCH_KEY)).toBe('not-started');
    }
  });

  it('returns started for any other final outcome', () => {
    expect(laneRunJournalDispatchResult([intent(DISPATCH_KEY), result(DISPATCH_KEY, 'completed')], DISPATCH_KEY)).toBe('started');
  });
});

describe('readLaneRunJournalEntryRecord and schemaVersion (Q5a)', () => {
  it('keeps LANE_RUN_JOURNAL_SCHEMA_VERSION at 1', () => {
    expect(LANE_RUN_JOURNAL_SCHEMA_VERSION).toBe(1);
  });

  it('round-trips an explicit schemaVersion 1 and omits the key when absent', () => {
    const withSchema = { ...intent(STEP_KEY), schemaVersion: 1 };
    const read = readLaneRunJournalEntry(withSchema);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.entry).toEqual(withSchema);
    expect(Object.hasOwn(read.entry, 'schemaVersion')).toBe(true);

    const absent = readLaneRunJournalEntry(intent(STEP_KEY));
    expect(absent.ok).toBe(true);
    if (!absent.ok) return;
    expect(Object.hasOwn(absent.entry, 'schemaVersion')).toBe(false);
  });

  it('refuses schemaVersion 2 with the fixed message under the default current version', () => {
    const read = readLaneRunJournalEntry({ ...intent(STEP_KEY), schemaVersion: 2 });
    expect(read).toEqual({ ok: false, error: 'LaneRunJournal schemaVersion is not supported' });
  });

  it('refuses a future schemaVersion before the unknown-key check', () => {
    const read = readLaneRunJournalEntry({ ...intent(STEP_KEY), schemaVersion: 99, unknownFutureField: 'x' });
    expect(read).toEqual({ ok: false, error: 'LaneRunJournal schemaVersion is not supported' });
  });

  it('readLaneRunJournalEntryRecord always stamps schemaVersion (absent reads as 1)', () => {
    const read = readLaneRunJournalEntryRecord(intent(STEP_KEY));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.record.schemaVersion).toBe(1);
    expect(Object.hasOwn(read.record, 'schemaVersion')).toBe(true);
    expect(Object.isFrozen(read.record)).toBe(true);
  });

  it('accepts schemaVersion 2 under { currentVersion: 2 } on a version 1 entry', () => {
    const read = readLaneRunJournalEntryRecord({ ...intent(STEP_KEY), schemaVersion: 2 }, { currentVersion: 2 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.record.schemaVersion).toBe(2);
    expect(read.record.version).toBe(LANE_RUN_JOURNAL_ENTRY_VERSION);
  });

  it('reports unknown-schema-version for versions outside the accepted window', () => {
    expect(readLaneRunJournalEntryRecord({ ...intent(STEP_KEY), schemaVersion: 3 }, { currentVersion: 2 })).toEqual({
      ok: false,
      reason: 'unknown-schema-version',
    });
    expect(readLaneRunJournalEntryRecord({ ...intent(STEP_KEY), schemaVersion: 1 }, { currentVersion: 3 })).toEqual({
      ok: false,
      reason: 'unknown-schema-version',
    });
    expect(readLaneRunJournalEntryRecord(intent(STEP_KEY), { currentVersion: 3 })).toEqual({
      ok: false,
      reason: 'unknown-schema-version',
    });
  });

  it('reports malformed for an aggregate version 2 even with an accepted schemaVersion', () => {
    const aggregateTwo = { ...intent(STEP_KEY), version: 2, schemaVersion: 2 };
    expect(readLaneRunJournalEntryRecord(aggregateTwo, { currentVersion: 2 })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    // The twin refusal without a schemaVersion keeps the aggregate message.
    const twin = readLaneRunJournalEntry({ ...intent(STEP_KEY), version: 2 });
    expect(twin).toEqual({ ok: false, error: 'LaneRunJournal version must be 1' });
  });

  it('does not throw on hostile input and never echoes a refused value', () => {
    const throwingProxy = new Proxy(intent(STEP_KEY), {
      ownKeys() {
        throw new Error('boom');
      },
    });
    expect(readLaneRunJournalEntryRecord(throwingProxy)).toEqual({ ok: false, reason: 'malformed' });
    expect(readLaneRunJournalEntryRecord({ ...intent(STEP_KEY), schemaVersion: 'XYZZY' })).toEqual({
      ok: false,
      reason: 'unknown-schema-version',
    });
    expect(readLaneRunJournalEntryRecord(null)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('still reads a legacy entry without detail as detail: null', () => {
    const legacy = intent(STEP_KEY);
    const raw: Record<string, unknown> = { ...legacy };
    delete raw.detail;
    const read = readLaneRunJournalEntry(raw);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.entry.detail).toBeNull();
    expect(Object.hasOwn(read.entry, 'schemaVersion')).toBe(false);
  });
});
