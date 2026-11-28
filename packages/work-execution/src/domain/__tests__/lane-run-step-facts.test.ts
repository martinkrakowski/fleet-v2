import { describe, expect, it } from 'vitest';

import { buildLaneRunStepKey, laneRunMergeEnqueueKey, laneRunPremergeKey } from '../lane-run-keys.js';
import type { LaneRunKeyResult } from '../lane-run-keys.js';
import { LANE_RUN_JOURNAL_REASON_CODE_PATTERN, laneRunJournalPendingIntent, prepareLaneRunJournalAppend } from '../lane-run-journal.js';
import type { LaneRunJournalEntryRecord, LaneRunJournalOutcome } from '../lane-run-journal.js';
import {
  LANE_RUN_INTENT_ABANDONED_REASON_CODE,
  LANE_RUN_RESULT_REASON_CODES,
  laneRunAttemptDispatchResult,
  laneRunAttemptPlacement,
  laneRunCiFailureRecorded,
  laneRunConductEntry,
  laneRunDispatchedAtIso,
  laneRunGateCongestion,
  laneRunGateFailed,
  laneRunGateFact,
  laneRunGateLatestRound,
  laneRunFixRoundGateDriven,
  laneRunGateUnknown,
  laneRunIntentEntry,
  laneRunMergeEnqueueFact,
  laneRunParkedConductCount,
  laneRunPremergePost,
  laneRunRecordedSeatAdvance,
  laneRunRefusedStep,
  laneRunResultEntry,
  laneRunStopsIssued,
  laneRunTimedOut,
  planGateFailedRetry,
} from '../lane-run-step-facts.js';
import type { LaneRunResultReasonCode } from '../lane-run-step-facts.js';
import type { LaneRunKeyStep } from '../lane-run-records.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const OTHER_RUN_ID = 'run-01JB0000000000000000000001';
const NOW = '2026-10-27T10:00:00.000Z';
const ATTEMPT = 'attempt-example-1';
const HEAD = '0123456789ab';
const OTHER_HEAD = 'fedcba987654';
const BAD_RUN_ID = 'not-a-run-id';

function mustBuild(result: LaneRunKeyResult): string {
  if (!result.ok) {
    throw new Error('unreachable: key builder');
  }
  return result.key;
}

interface KeyParts {
  runId?: string;
  round: number;
  step: LaneRunKeyStep;
  seatIndex: number;
  attemptOrdinal?: number | null;
  head12?: string | null;
  retry?: number | null;
}

function keyOf(parts: KeyParts): string {
  return mustBuild(buildLaneRunStepKey({
    runId: parts.runId ?? RUN_ID,
    round: parts.round,
    step: parts.step,
    seatIndex: parts.seatIndex,
    attemptOrdinal: parts.attemptOrdinal ?? null,
    head12: parts.head12 ?? null,
    retry: parts.retry ?? null,
  }));
}

let entryIdCounter = 0;
function nextEntryId(): string {
  const ordinal = String(entryIdCounter).padStart(22, '0').slice(-22);
  entryIdCounter += 1;
  return '01JB' + ordinal;
}

function intent(key: string, opts: { runId?: string; mintedId?: string | null; now?: string } = {}): LaneRunJournalEntryRecord {
  return laneRunIntentEntry(nextEntryId(), opts.runId ?? RUN_ID, key, opts.mintedId ?? null, opts.now ?? NOW);
}

function result(key: string, outcome: LaneRunJournalOutcome, reasonCode: LaneRunResultReasonCode | null = null): LaneRunJournalEntryRecord {
  return laneRunResultEntry(nextEntryId(), RUN_ID, key, outcome, reasonCode, NOW);
}

function conduct(state: NonNullable<LaneRunJournalEntryRecord['state']>): LaneRunJournalEntryRecord {
  return laneRunConductEntry(nextEntryId(), RUN_ID, state, NOW);
}

describe('builders', () => {
  it('builds a frozen conduct entry with key null and the state set', () => {
    const entry = laneRunConductEntry(nextEntryId(), RUN_ID, 'parked', NOW);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry.version).toBe(1);
    expect(entry.kind).toBe('conduct');
    expect(entry.key).toBeNull();
    expect(entry.runId).toBe(RUN_ID);
    expect(entry.recordedAtIso).toBe(NOW);
    expect(entry.mode).toBeNull();
    expect(entry.expectedRevision).toBeNull();
    expect(entry.mintedId).toBeNull();
    expect(entry.outcome).toBeNull();
    expect(entry.reasonCode).toBeNull();
    expect(entry.grantId).toBeNull();
    expect(entry.state).toBe('parked');
  });

  it('builds a frozen intent entry with the minted id as given', () => {
    const entry = laneRunIntentEntry(nextEntryId(), RUN_ID, keyOf({ round: 0, step: 'dispatch', seatIndex: 0, attemptOrdinal: 1 }), ATTEMPT, NOW);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry.version).toBe(1);
    expect(entry.kind).toBe('intent');
    expect(entry.key).not.toBeNull();
    expect(entry.runId).toBe(RUN_ID);
    expect(entry.recordedAtIso).toBe(NOW);
    expect(entry.mintedId).toBe(ATTEMPT);
    expect(entry.mode).toBeNull();
    expect(entry.expectedRevision).toBeNull();
    expect(entry.outcome).toBeNull();
    expect(entry.reasonCode).toBeNull();
    expect(entry.grantId).toBeNull();
    expect(entry.state).toBeNull();
  });

  it('builds a frozen result entry with outcome, reason code and null grant id', () => {
    const entry = laneRunResultEntry(nextEntryId(), RUN_ID, keyOf({ round: 0, step: 'dispatch', seatIndex: 0, attemptOrdinal: 1 }), 'completed', 'dispatch-started', NOW);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry.version).toBe(1);
    expect(entry.kind).toBe('result');
    expect(entry.key).not.toBeNull();
    expect(entry.runId).toBe(RUN_ID);
    expect(entry.recordedAtIso).toBe(NOW);
    expect(entry.outcome).toBe('completed');
    expect(entry.reasonCode).toBe('dispatch-started');
    expect(entry.grantId).toBeNull();
    expect(entry.mode).toBeNull();
    expect(entry.expectedRevision).toBeNull();
    expect(entry.mintedId).toBeNull();
    expect(entry.state).toBeNull();
  });

  it('every reason code matches the pattern and is unique', () => {
    const seen = new Set<string>();
    for (const code of LANE_RUN_RESULT_REASON_CODES) {
      expect(LANE_RUN_JOURNAL_REASON_CODE_PATTERN.test(code)).toBe(true);
      expect(seen.has(code)).toBe(false);
      seen.add(code);
    }
  });
});

describe('laneRunAttemptPlacement', () => {
  it('reads round and seat from a prepare intent', () => {
    const entries = [
      intent(keyOf({ round: 0, step: 'prepare', seatIndex: 1, attemptOrdinal: 1 }), { mintedId: ATTEMPT }),
    ];
    expect(laneRunAttemptPlacement(entries, RUN_ID, ATTEMPT)).toEqual({ round: 0, seatIndex: 1 });
  });

  it('never places an attempt from a stop intent that comes first', () => {
    const entries = [
      intent(keyOf({ round: 2, step: 'stop', seatIndex: 3 }), { mintedId: ATTEMPT }),
      intent(keyOf({ round: 0, step: 'prepare', seatIndex: 1, attemptOrdinal: 1 }), { mintedId: ATTEMPT }),
    ];
    expect(laneRunAttemptPlacement(entries, RUN_ID, ATTEMPT)).toEqual({ round: 0, seatIndex: 1 });
  });

  it('reads round and seat from a dispatch intent when no prepare exists', () => {
    const entries = [
      intent(keyOf({ round: 1, step: 'dispatch', seatIndex: 2, attemptOrdinal: 1 }), { mintedId: ATTEMPT }),
    ];
    expect(laneRunAttemptPlacement(entries, RUN_ID, ATTEMPT)).toEqual({ round: 1, seatIndex: 2 });
  });

  it('ignores another run\'s entries', () => {
    const entries = [
      intent(keyOf({ runId: OTHER_RUN_ID, round: 0, step: 'prepare', seatIndex: 1, attemptOrdinal: 1 }), { runId: OTHER_RUN_ID, mintedId: ATTEMPT }),
    ];
    expect(laneRunAttemptPlacement(entries, RUN_ID, ATTEMPT)).toBeNull();
  });

  it('returns null with no intent', () => {
    expect(laneRunAttemptPlacement([], RUN_ID, ATTEMPT)).toBeNull();
  });
});

describe('laneRunAttemptDispatchResult', () => {
  const dispatchKey = keyOf({ round: 0, step: 'dispatch', seatIndex: 0, attemptOrdinal: 1 });

  it('returns none without a dispatch intent', () => {
    expect(laneRunAttemptDispatchResult([], RUN_ID, ATTEMPT)).toBe('none');
  });

  it('returns started for an intent with no result', () => {
    const entries = [intent(dispatchKey, { mintedId: ATTEMPT })];
    expect(laneRunAttemptDispatchResult(entries, RUN_ID, ATTEMPT)).toBe('started');
  });

  it.each<LaneRunJournalOutcome>(['not-started', 'refused', 'dry-run'])('returns not-started for a final %s result', (outcome) => {
    const entries = [
      intent(dispatchKey, { mintedId: ATTEMPT }),
      result(dispatchKey, outcome),
    ];
    expect(laneRunAttemptDispatchResult(entries, RUN_ID, ATTEMPT)).toBe('not-started');
  });

  it('returns started for a final completed result', () => {
    const entries = [
      intent(dispatchKey, { mintedId: ATTEMPT }),
      result(dispatchKey, 'completed', 'dispatch-started'),
    ];
    expect(laneRunAttemptDispatchResult(entries, RUN_ID, ATTEMPT)).toBe('started');
  });
});

describe('laneRunStopsIssued', () => {
  it('counts two stop intents for round 0 seat 0', () => {
    const entries = [
      intent(keyOf({ round: 0, step: 'stop', seatIndex: 0 })),
      intent(keyOf({ round: 0, step: 'stop', seatIndex: 0, retry: 1 })),
    ];
    expect(laneRunStopsIssued(entries, RUN_ID, 0, 0)).toBe(2);
  });

  it('counts zero for seat 1', () => {
    const entries = [
      intent(keyOf({ round: 0, step: 'stop', seatIndex: 0 })),
    ];
    expect(laneRunStopsIssued(entries, RUN_ID, 0, 1)).toBe(0);
  });
});

describe('laneRunTimedOut', () => {
  const stopKey = keyOf({ round: 0, step: 'stop', seatIndex: 0 });

  it('is true when a stop final result has reason stop-timeout', () => {
    const entries = [
      intent(stopKey),
      result(stopKey, 'completed', 'stop-timeout'),
    ];
    expect(laneRunTimedOut(entries, RUN_ID, 0, 0)).toBe(true);
  });

  it('is false for a stop-force result', () => {
    const entries = [
      intent(stopKey),
      result(stopKey, 'completed', 'stop-force'),
    ];
    expect(laneRunTimedOut(entries, RUN_ID, 0, 0)).toBe(false);
  });

  it('is false with no result', () => {
    const entries = [intent(stopKey)];
    expect(laneRunTimedOut(entries, RUN_ID, 0, 0)).toBe(false);
  });
});

describe('laneRunGateFact', () => {
  const gateKey = keyOf({ round: 0, step: 'gate', seatIndex: 0, head12: HEAD });

  it('returns none for a null head', () => {
    expect(laneRunGateFact([], RUN_ID, null)).toBe('none');
  });

  it('returns none with no gate intent', () => {
    expect(laneRunGateFact([], RUN_ID, HEAD)).toBe('none');
  });

  it('returns pending for an intent without a result', () => {
    const entries = [intent(gateKey)];
    expect(laneRunGateFact(entries, RUN_ID, HEAD)).toBe('pending');
  });

  it('returns passed for a final gate-passed', () => {
    const entries = [
      intent(gateKey),
      result(gateKey, 'completed', 'gate-passed'),
    ];
    expect(laneRunGateFact(entries, RUN_ID, HEAD)).toBe('passed');
  });

  it('returns failed for a final gate-failed', () => {
    const entries = [
      intent(gateKey),
      result(gateKey, 'completed', 'gate-failed'),
    ];
    expect(laneRunGateFact(entries, RUN_ID, HEAD)).toBe('failed');
  });

  it('returns unknown for a final refused result', () => {
    const entries = [
      intent(gateKey),
      result(gateKey, 'refused', 'gate-unknown'),
    ];
    expect(laneRunGateFact(entries, RUN_ID, HEAD)).toBe('unknown');
  });

  it('returns pending when only ambiguous results exist', () => {
    const entries = [
      intent(gateKey),
      result(gateKey, 'ambiguous'),
    ];
    expect(laneRunGateFact(entries, RUN_ID, HEAD)).toBe('pending');
  });

  it('returns none for another head', () => {
    const entries = [intent(gateKey)];
    expect(laneRunGateFact(entries, RUN_ID, OTHER_HEAD)).toBe('none');
  });

  it('returns congested for a final gate-congested run', () => {
    const entries = [
      intent(gateKey),
      result(gateKey, 'completed', 'gate-congested'),
    ];
    expect(laneRunGateFact(entries, RUN_ID, HEAD)).toBe('congested');
  });

  it('decides by the highest-retry intent: an old congested run 0 and a passed retry 1 pass', () => {
    const retryKey = keyOf({ round: 0, step: 'gate', seatIndex: 0, head12: HEAD, retry: 1 });
    const entries = [
      intent(gateKey),
      result(gateKey, 'completed', 'gate-congested'),
      intent(retryKey),
      result(retryKey, 'completed', 'gate-passed'),
    ];
    expect(laneRunGateFact(entries, RUN_ID, HEAD)).toBe('passed');
  });

  it('a congested retry 1 overrides a passed run 0', () => {
    const retryKey = keyOf({ round: 0, step: 'gate', seatIndex: 0, head12: HEAD, retry: 1 });
    const entries = [
      intent(gateKey),
      result(gateKey, 'completed', 'gate-passed'),
      intent(retryKey),
      result(retryKey, 'completed', 'gate-congested'),
    ];
    expect(laneRunGateFact(entries, RUN_ID, HEAD)).toBe('congested');
  });

  // GD1: the round decides before the retry — the highest round present at the
  // head wins even when an earlier round carries a higher retry ordinal.
  it('decides by the highest round first: a round 1 run 0 beats a round 0 retry 1 at the same head', () => {
    const round0Retry1 = keyOf({ round: 0, step: 'gate', seatIndex: 0, head12: HEAD, retry: 1 });
    const round1Run0 = keyOf({ round: 1, step: 'gate', seatIndex: 0, head12: HEAD });
    const entries = [
      intent(round0Retry1),
      result(round0Retry1, 'completed', 'gate-passed'),
      intent(round1Run0),
      result(round1Run0, 'completed', 'gate-failed'),
    ];
    expect(laneRunGateFact(entries, RUN_ID, HEAD)).toBe('failed');
  });
});

describe('laneRunGateLatestRound', () => {
  const round0 = keyOf({ round: 0, step: 'gate', seatIndex: 0, head12: HEAD });
  const round1 = keyOf({ round: 1, step: 'gate', seatIndex: 0, head12: HEAD });

  it('returns the highest round present at the head', () => {
    const entries = [
      intent(round0),
      result(round0, 'completed', 'gate-failed'),
      intent(round1),
    ];
    expect(laneRunGateLatestRound(entries, RUN_ID, HEAD)).toBe(1);
  });

  it('returns 0 for a lone run 0 gate intent', () => {
    expect(laneRunGateLatestRound([intent(round0)], RUN_ID, HEAD)).toBe(0);
  });

  it('returns null with no gate intent at the head', () => {
    expect(laneRunGateLatestRound([intent(round0)], RUN_ID, OTHER_HEAD)).toBe(null);
    expect(laneRunGateLatestRound([], RUN_ID, HEAD)).toBe(null);
  });

  it('returns null for hostile input: null, non-arrays, array-likes, holes, huge lengths, bad ids and bad heads', () => {
    const entry = intent(round0);
    const holed: unknown[] = [entry];
    delete holed[0];
    const huge: unknown[] = [];
    huge.length = 100_001;
    for (const badEntries of [null, undefined, 42, 'entries', { length: 1, 0: entry }, holed, huge]) {
      expect(laneRunGateLatestRound(badEntries, RUN_ID, HEAD)).toBe(null);
    }
    for (const badRunId of [null, undefined, 7, BAD_RUN_ID]) {
      expect(laneRunGateLatestRound([entry], badRunId, HEAD)).toBe(null);
    }
    for (const badHead of [null, undefined, 42, '']) {
      expect(laneRunGateLatestRound([entry], RUN_ID, badHead)).toBe(null);
    }
  });

  it('refuses a getter on an array slot or an entry field without running it, and a prototype-polluting key', () => {
    const entry = intent(round0);
    const throwingSlot: unknown[] = [entry];
    Object.defineProperty(throwingSlot, 0, {
      enumerable: true,
      get: () => {
        throw new Error('slot getter must never run');
      },
    });
    expect(laneRunGateLatestRound(throwingSlot, RUN_ID, HEAD)).toBe(null);
    const throwingField: Record<string, unknown> = { kind: 'intent', runId: RUN_ID };
    let reads = 0;
    Object.defineProperty(throwingField, 'key', {
      enumerable: true,
      get: () => {
        reads += 1;
        return round0;
      },
    });
    expect(laneRunGateLatestRound([throwingField], RUN_ID, HEAD)).toBe(null);
    expect(reads).toBe(0);
    expect(
      laneRunGateLatestRound([entry, JSON.parse('{"__proto__": {}, "kind": "intent"}') as object], RUN_ID, HEAD),
    ).toBe(null);
  });
});

describe('laneRunGateFailed', () => {
  const run0 = keyOf({ round: 0, step: 'gate', seatIndex: 0, head12: HEAD });
  const retry1 = keyOf({ round: 0, step: 'gate', seatIndex: 0, head12: HEAD, retry: 1 });

  it('returns the failed run 0 as retry 0 with failedCount 1', () => {
    const entries = [intent(run0), result(run0, 'completed', 'gate-failed')];
    expect(laneRunGateFailed(entries, RUN_ID, HEAD)).toEqual({ retry: 0, failedCount: 1 });
  });

  it('returns the failed retry after congestion retries, still failedCount 1', () => {
    const entries = [
      intent(run0),
      result(run0, 'completed', 'gate-congested'),
      intent(retry1),
      result(retry1, 'completed', 'gate-failed'),
    ];
    expect(laneRunGateFailed(entries, RUN_ID, HEAD)).toEqual({ retry: 1, failedCount: 1 });
  });

  it('returns null when the highest run did not fail', () => {
    const entries = [intent(run0), result(run0, 'completed', 'gate-passed')];
    expect(laneRunGateFailed(entries, RUN_ID, HEAD)).toBe(null);
  });

  it('returns null when the highest gate intent has no final result', () => {
    expect(laneRunGateFailed([intent(run0)], RUN_ID, HEAD)).toBe(null);
  });

  it('counts a second gate-failed intent at the same (round, head12) in failedCount 2', () => {
    const otherSeat = keyOf({ round: 0, step: 'gate', seatIndex: 1, head12: HEAD });
    const entries = [
      intent(run0),
      result(run0, 'completed', 'gate-failed'),
      intent(otherSeat),
      result(otherSeat, 'completed', 'gate-failed'),
      intent(retry1),
      result(retry1, 'completed', 'gate-failed'),
    ];
    // The highest (round, retry) is retry1; three distinct failed intents at round 0.
    expect(laneRunGateFailed(entries, RUN_ID, HEAD)).toEqual({ retry: 1, failedCount: 3 });
  });

  it('returns null for hostile input and refuses getters and polluted entries', () => {
    const entry = intent(run0);
    const holed: unknown[] = [entry];
    delete holed[0];
    for (const badEntries of [null, undefined, { length: 1, 0: entry }, holed]) {
      expect(laneRunGateFailed(badEntries, RUN_ID, HEAD)).toBe(null);
    }
    for (const badRunId of [null, 7, BAD_RUN_ID]) {
      expect(laneRunGateFailed([entry], badRunId, HEAD)).toBe(null);
    }
    expect(laneRunGateFailed([entry], RUN_ID, null)).toBe(null);
    const throwing: Record<string, unknown> = { kind: 'intent' };
    Object.defineProperty(throwing, 'key', {
      enumerable: true,
      get: () => {
        throw new Error('getter must never run');
      },
    });
    expect(laneRunGateFailed([entry, throwing], RUN_ID, HEAD)).toBe(null);
    expect(
      laneRunGateFailed([entry, JSON.parse('{"__proto__": {}, "kind": "intent"}') as object], RUN_ID, HEAD),
    ).toBe(null);
  });
});

describe('laneRunFixRoundGateDriven', () => {
  it('is true when the latest fixing conduct is immediately preceded by gating', () => {
    const entries = [
      intent(keyOf({ round: 0, step: 'gate', seatIndex: 0, head12: HEAD })),
      laneRunConductEntry(nextEntryId(), RUN_ID, 'gating', NOW),
      laneRunConductEntry(nextEntryId(), RUN_ID, 'fixing', NOW),
    ];
    expect(laneRunFixRoundGateDriven(entries, RUN_ID)).toBe(true);
  });

  it('is false when the latest fixing conduct follows another state', () => {
    for (const before of ['collecting', 'seat-failed', 'parked']) {
      const entries = [
        laneRunConductEntry(nextEntryId(), RUN_ID, before as 'ready', NOW),
        laneRunConductEntry(nextEntryId(), RUN_ID, 'fixing', NOW),
      ];
      expect(laneRunFixRoundGateDriven(entries, RUN_ID)).toBe(false);
    }
  });

  it('is false with no fixing conduct or an older fixing not preceded by gating', () => {
    expect(laneRunFixRoundGateDriven([], RUN_ID)).toBe(false);
    const entries = [
      laneRunConductEntry(nextEntryId(), RUN_ID, 'gating', NOW),
      laneRunConductEntry(nextEntryId(), RUN_ID, 'fixing', NOW),
      laneRunConductEntry(nextEntryId(), RUN_ID, 'collecting', NOW),
      laneRunConductEntry(nextEntryId(), RUN_ID, 'fixing', NOW),
    ];
    expect(laneRunFixRoundGateDriven(entries, RUN_ID)).toBe(false);
  });

  it('skips parked conducts between gating and fixing', () => {
    const entries = [
      laneRunConductEntry(nextEntryId(), RUN_ID, 'gating', NOW),
      laneRunConductEntry(nextEntryId(), RUN_ID, 'parked', NOW),
      laneRunConductEntry(nextEntryId(), RUN_ID, 'fixing', NOW),
    ];
    expect(laneRunFixRoundGateDriven(entries, RUN_ID)).toBe(true);
  });

  it('is false for hostile input: bad run ids, holes, non-arrays, throwing getters and polluted entries', () => {
    const entry = laneRunConductEntry(nextEntryId(), RUN_ID, 'gating', NOW);
    for (const badRunId of [null, undefined, 7, BAD_RUN_ID]) {
      expect(laneRunFixRoundGateDriven([entry], badRunId)).toBe(false);
    }
    const holed: unknown[] = [entry];
    delete holed[0];
    for (const badEntries of [null, undefined, 42, { length: 1, 0: entry }, holed]) {
      expect(laneRunFixRoundGateDriven(badEntries, RUN_ID)).toBe(false);
    }
    const throwing: Record<string, unknown> = { kind: 'conduct', runId: RUN_ID };
    Object.defineProperty(throwing, 'state', {
      enumerable: true,
      get: () => {
        throw new Error('getter must never run');
      },
    });
    expect(laneRunFixRoundGateDriven([entry, throwing], RUN_ID)).toBe(false);
    expect(
      laneRunFixRoundGateDriven([entry, JSON.parse('{"__proto__": {}, "kind": "conduct", "runId": "run-01JB0000000000000000000000"}') as object], RUN_ID),
    ).toBe(false);
  });
});

describe('laneRunGateCongestion', () => {
  const run0 = keyOf({ round: 0, step: 'gate', seatIndex: 0, head12: HEAD });
  const run1 = keyOf({ round: 0, step: 'gate', seatIndex: 0, head12: HEAD, retry: 1 });

  it('returns the latest congested run\'s retry and time', () => {
    const entries = [
      intent(run0),
      result(run0, 'completed', 'gate-congested'),
    ];
    expect(laneRunGateCongestion(entries, RUN_ID, HEAD)).toEqual({ retry: 0, atIso: NOW });
  });

  it('returns the later retry when several runs are congested', () => {
    const entries = [
      intent(run0),
      result(run0, 'completed', 'gate-congested'),
      intent(run1),
      result(run1, 'completed', 'gate-congested'),
    ];
    expect(laneRunGateCongestion(entries, RUN_ID, HEAD)).toEqual({ retry: 1, atIso: NOW });
  });

  it('returns null when the latest gate result is not a congestion', () => {
    const entries = [
      intent(run0),
      result(run0, 'completed', 'gate-congested'),
      intent(run1),
      result(run1, 'completed', 'gate-passed'),
    ];
    expect(laneRunGateCongestion(entries, RUN_ID, HEAD)).toBeNull();
  });

  it('returns null with no gate intent or a null head', () => {
    expect(laneRunGateCongestion([], RUN_ID, HEAD)).toBeNull();
    expect(laneRunGateCongestion([], RUN_ID, null)).toBeNull();
  });
});

describe('laneRunGateUnknown', () => {
  const run0 = keyOf({ round: 0, step: 'gate', seatIndex: 0, head12: HEAD });
  const run1 = keyOf({ round: 0, step: 'gate', seatIndex: 0, head12: HEAD, retry: 1 });

  it('returns null for an ambiguous-only gate-unknown, leaving the gate fact pending', () => {
    const entries = [intent(run0), result(run0, 'ambiguous', 'gate-unknown')];
    expect(laneRunGateUnknown(entries, RUN_ID, HEAD)).toBeNull();
    expect(laneRunGateFact(entries, RUN_ID, HEAD)).toBe('pending');
  });

  it('returns { retry: 0, operatorAbandoned: true } for a final intent-abandoned-by-operator and keeps the gate fact unknown', () => {
    const entries = [
      intent(run0),
      result(run0, 'ambiguous', 'gate-unknown'),
      laneRunResultEntry(nextEntryId(), RUN_ID, run0, 'overtaken', LANE_RUN_INTENT_ABANDONED_REASON_CODE, NOW),
    ];
    expect(laneRunGateUnknown(entries, RUN_ID, HEAD)).toEqual({ retry: 0, operatorAbandoned: true });
    expect(laneRunGateFact(entries, RUN_ID, HEAD)).toBe('unknown');
  });

  it('returns { retry: 0, operatorAbandoned: false } for a final refused gate-unknown', () => {
    const entries = [intent(run0), result(run0, 'refused', 'gate-unknown')];
    expect(laneRunGateUnknown(entries, RUN_ID, HEAD)).toEqual({ retry: 0, operatorAbandoned: false });
  });

  it('returns null when a later retry passed after an overtaken run 0', () => {
    const entries = [
      intent(run0),
      laneRunResultEntry(nextEntryId(), RUN_ID, run0, 'overtaken', LANE_RUN_INTENT_ABANDONED_REASON_CODE, NOW),
      intent(run1),
      result(run1, 'completed', 'gate-passed'),
    ];
    expect(laneRunGateUnknown(entries, RUN_ID, HEAD)).toBeNull();
  });

  it('returns null for a null head', () => {
    expect(laneRunGateUnknown([], RUN_ID, null)).toBeNull();
  });
});

describe('laneRunRefusedStep', () => {
  const collectKey = keyOf({ round: 0, step: 'collect', seatIndex: 0, attemptOrdinal: 1 });

  it('returns the step of the latest refused final result in the round', () => {
    const entries = [
      intent(collectKey),
      result(collectKey, 'refused', 'collect-refused'),
    ];
    expect(laneRunRefusedStep(entries, RUN_ID, 0)).toBe('collect');
  });

  it('returns null when the round differs', () => {
    const entries = [
      intent(collectKey),
      result(collectKey, 'refused', 'collect-refused'),
    ];
    expect(laneRunRefusedStep(entries, RUN_ID, 1)).toBeNull();
  });

  it('returns null when a later completed result exists on another step', () => {
    const gateKey = keyOf({ round: 0, step: 'gate', seatIndex: 0, head12: HEAD });
    const entries = [
      intent(collectKey),
      result(collectKey, 'refused', 'collect-refused'),
      intent(gateKey),
      result(gateKey, 'completed', 'gate-passed'),
    ];
    expect(laneRunRefusedStep(entries, RUN_ID, 0)).toBeNull();
  });
});

describe('intent-abandoned-by-operator', () => {
  it('LANE_RUN_RESULT_REASON_CODES includes intent-abandoned-by-operator and keeps gate unknown, refusedStep null, and premergePost none', () => {
    expect(LANE_RUN_INTENT_ABANDONED_REASON_CODE).toBe('intent-abandoned-by-operator');
    expect(LANE_RUN_RESULT_REASON_CODES).toContain(LANE_RUN_INTENT_ABANDONED_REASON_CODE);
    expect(LANE_RUN_JOURNAL_REASON_CODE_PATTERN.test(LANE_RUN_INTENT_ABANDONED_REASON_CODE)).toBe(true);

    const gateKey = keyOf({ round: 0, step: 'gate', seatIndex: 0, head12: HEAD });
    const ambiguous = [intent(gateKey), result(gateKey, 'ambiguous', 'gate-unknown')];
    expect(laneRunJournalPendingIntent(ambiguous, RUN_ID)).toEqual({ key: gateKey, step: 'gate', reconciliation: 'ambiguous' });

    const abandoned = [
      ...ambiguous,
      laneRunResultEntry(nextEntryId(), RUN_ID, gateKey, 'overtaken', LANE_RUN_INTENT_ABANDONED_REASON_CODE, NOW),
    ];
    expect(laneRunJournalPendingIntent(abandoned, RUN_ID)).toBeNull();
    expect(laneRunGateFact(abandoned, RUN_ID, HEAD)).toBe('unknown');
    expect(laneRunRefusedStep(abandoned, RUN_ID, 0)).toBeNull();

    const premergeKey = mustBuild(laneRunPremergeKey(RUN_ID, 0, HEAD));
    const premerge = [
      intent(premergeKey),
      result(premergeKey, 'ambiguous', 'forge-ambiguous'),
      laneRunResultEntry(nextEntryId(), RUN_ID, premergeKey, 'overtaken', LANE_RUN_INTENT_ABANDONED_REASON_CODE, NOW),
    ];
    expect(laneRunPremergePost(premerge, RUN_ID, HEAD)).toBe('none');
  });
});

describe('laneRunDispatchedAtIso', () => {
  const dispatchKey = keyOf({ round: 0, step: 'dispatch', seatIndex: 0, attemptOrdinal: 1 });

  it('returns the dispatch intent time', () => {
    const entries = [intent(dispatchKey, { mintedId: ATTEMPT })];
    expect(laneRunDispatchedAtIso(entries, RUN_ID, ATTEMPT)).toBe(NOW);
  });

  it('returns null with no intent', () => {
    expect(laneRunDispatchedAtIso([], RUN_ID, ATTEMPT)).toBeNull();
  });
});

describe('laneRunParkedConductCount', () => {
  it('counts parked conducts only', () => {
    const entries = [
      conduct('parked'),
      conduct('parked'),
      conduct('running'),
    ];
    expect(laneRunParkedConductCount(entries, RUN_ID)).toBe(2);
  });
});

describe('laneRunRecordedSeatAdvance', () => {
  const dispatchKey = keyOf({ round: 0, step: 'dispatch', seatIndex: 0, attemptOrdinal: 1 });

  it('parses seat advance with outcome and seat index', () => {
    const entries = [
      laneRunResultEntry(nextEntryId(), RUN_ID, dispatchKey, 'refused', 'runner-refused', NOW, 'next-seat-rate-limited-1'),
    ];
    expect(laneRunRecordedSeatAdvance(entries, RUN_ID, 0)).toEqual({
      kind: 'seat',
      seatIndex: 1,
      outcome: 'rate-limited',
    });
  });

  it('parses exhausted advance with outcome', () => {
    const entries = [
      laneRunResultEntry(nextEntryId(), RUN_ID, dispatchKey, 'refused', 'runner-refused', NOW, 'next-seat-timeout-none'),
    ];
    expect(laneRunRecordedSeatAdvance(entries, RUN_ID, 0)).toEqual({
      kind: 'exhausted',
      outcome: 'timeout',
    });
  });

  it('parses unmapped exhausted advance (next-seat-none)', () => {
    const entries = [
      laneRunResultEntry(nextEntryId(), RUN_ID, dispatchKey, 'refused', 'runner-refused', NOW, 'next-seat-none'),
    ];
    expect(laneRunRecordedSeatAdvance(entries, RUN_ID, 0)).toEqual({
      kind: 'exhausted',
      outcome: null,
    });
  });

  it('returns none for non-matching or absent detail', () => {
    expect(laneRunRecordedSeatAdvance([], RUN_ID, 0)).toEqual({ kind: 'none' });
    const otherEntries = [
      laneRunResultEntry(nextEntryId(), RUN_ID, dispatchKey, 'refused', 'runner-refused', NOW, 'rate-limited'),
    ];
    expect(laneRunRecordedSeatAdvance(otherEntries, RUN_ID, 0)).toEqual({ kind: 'none' });
  });
});

describe('a malformed run id', () => {
  const entries = [
    intent(keyOf({ round: 0, step: 'dispatch', seatIndex: 0, attemptOrdinal: 1 }), { mintedId: ATTEMPT }),
    conduct('parked'),
  ];

  it('returns empty values and never throws', () => {
    expect(() => laneRunAttemptPlacement(entries, BAD_RUN_ID, ATTEMPT)).not.toThrow();
    expect(() => laneRunAttemptDispatchResult(entries, BAD_RUN_ID, ATTEMPT)).not.toThrow();
    expect(() => laneRunStopsIssued(entries, BAD_RUN_ID, 0, 0)).not.toThrow();
    expect(() => laneRunTimedOut(entries, BAD_RUN_ID, 0, 0)).not.toThrow();
    expect(() => laneRunGateFact(entries, BAD_RUN_ID, HEAD)).not.toThrow();
    expect(() => laneRunRefusedStep(entries, BAD_RUN_ID, 0)).not.toThrow();
    expect(() => laneRunDispatchedAtIso(entries, BAD_RUN_ID, ATTEMPT)).not.toThrow();
    expect(() => laneRunParkedConductCount(entries, BAD_RUN_ID)).not.toThrow();
    expect(laneRunAttemptPlacement(entries, BAD_RUN_ID, ATTEMPT)).toBeNull();
    expect(laneRunAttemptDispatchResult(entries, BAD_RUN_ID, ATTEMPT)).toBe('none');
    expect(laneRunStopsIssued(entries, BAD_RUN_ID, 0, 0)).toBe(0);
    expect(laneRunTimedOut(entries, BAD_RUN_ID, 0, 0)).toBe(false);
    expect(laneRunGateFact(entries, BAD_RUN_ID, HEAD)).toBe('none');
    expect(laneRunRefusedStep(entries, BAD_RUN_ID, 0)).toBeNull();
    expect(laneRunDispatchedAtIso(entries, BAD_RUN_ID, ATTEMPT)).toBeNull();
    expect(laneRunParkedConductCount(entries, BAD_RUN_ID)).toBe(0);
  });
});

describe('planGateFailedRetry', () => {
  function gateKeyOf(round: number, seatIndex: number, head12: string | null, retry: number | null): string {
    return keyOf({ round, step: 'gate', seatIndex, head12, retry });
  }

  function failedEntries(parts: { round?: number; seatIndex?: number; head12?: string; retries?: number[]; reason?: LaneRunResultReasonCode } = {}): LaneRunJournalEntryRecord[] {
    const round = parts.round ?? 0;
    const seatIndex = parts.seatIndex ?? 0;
    const head12 = parts.head12 ?? HEAD;
    const reason = parts.reason ?? 'gate-failed';
    const base = gateKeyOf(round, seatIndex, head12, null);
    const out: LaneRunJournalEntryRecord[] = [intent(base)];
    if (parts.retries === undefined || parts.retries.length === 0) {
      out.push(result(base, 'completed', reason));
      return out;
    }
    out.push(result(base, 'completed', parts.reason === undefined ? 'gate-failed' : reason));
    for (const retry of parts.retries) {
      const key = gateKeyOf(round, seatIndex, head12, retry);
      out.push(intent(key));
      out.push(result(key, 'completed', reason));
    }
    return out;
  }

  it('mints retry1 when the round\u2019s last gate intent settled gate-failed', () => {
    const plan = planGateFailedRetry(failedEntries(), RUN_ID, 0);
    expect(plan).toEqual({
      kind: 'mint',
      key: gateKeyOf(0, 0, HEAD, null) + '/retry1',
      retry: 1,
      head12: HEAD,
      seatIndex: 0,
    });
  });

  it('uses the LAST gate intent\u2019s head12 and seatIndex when the round has several heads', () => {
    const entries = [
      ...failedEntries({ head12: HEAD, seatIndex: 0 }),
      ...failedEntries({ head12: OTHER_HEAD, seatIndex: 1 }),
    ];
    const plan = planGateFailedRetry(entries, RUN_ID, 0);
    expect(plan).toEqual({
      kind: 'mint',
      key: gateKeyOf(0, 1, OTHER_HEAD, null) + '/retry1',
      retry: 1,
      head12: OTHER_HEAD,
      seatIndex: 1,
    });
  });

  it('mints past six congestion retries when the highest run settled gate-failed (the failed run is retry7, next is retry8)', () => {
    // Six congestion retries (over their congested base run) never mint and
    // never count; the failed run at retry7 is the highest, so next is 8.
    const entries = failedEntries({ reason: 'gate-congested', retries: [1, 2, 3, 4, 5, 6] });
    const failedKey = gateKeyOf(0, 0, HEAD, 7);
    entries.push(intent(failedKey), result(failedKey, 'completed', 'gate-failed'));
    const plan = planGateFailedRetry(entries, RUN_ID, 0);
    expect(plan).toEqual({
      kind: 'mint',
      key: gateKeyOf(0, 0, HEAD, null) + '/retry8',
      retry: 8,
      head12: HEAD,
      seatIndex: 0,
    });
  });

  it('counts a retry whose predecessor failed but not one whose predecessor was congested', () => {
    // base failed, retry1 congested (its predecessor failed: it counts),
    // retry2 failed: failedRetries 1, next 3 — the congestion retry is not counted.
    const entries = failedEntries();
    const congestedKey = gateKeyOf(0, 0, HEAD, 1);
    entries.push(intent(congestedKey), result(congestedKey, 'completed', 'gate-congested'));
    const failedKey = gateKeyOf(0, 0, HEAD, 2);
    entries.push(intent(failedKey), result(failedKey, 'completed', 'gate-failed'));
    expect(planGateFailedRetry(entries, RUN_ID, 0)).toEqual({
      kind: 'mint',
      key: gateKeyOf(0, 0, HEAD, null) + '/retry3',
      retry: 3,
      head12: HEAD,
      seatIndex: 0,
    });
  });

  it('returns cap-reached with failedRetries 3 after three gate-failed-predecessor retries', () => {
    const plan = planGateFailedRetry(failedEntries({ retries: [1, 2, 3] }), RUN_ID, 0);
    expect(plan).toEqual({ kind: 'cap-reached', failedRetries: 3, next: 4 });
  });

  it('returns cap-reached when next exceeds LANE_RUN_MAX_RETRY (eight congestion retries and a failed retry9)', () => {
    const entries = failedEntries({ reason: 'gate-congested', retries: [1, 2, 3, 4, 5, 6, 7, 8] });
    const failedKey = gateKeyOf(0, 0, HEAD, 9);
    entries.push(intent(failedKey), result(failedKey, 'completed', 'gate-failed'));
    const plan = planGateFailedRetry(entries, RUN_ID, 0);
    expect(plan).toEqual({ kind: 'cap-reached', failedRetries: 0, next: 10 });
  });

  it('returns none when the highest retry\u2019s final result is not gate-failed', () => {
    for (const reason of ['gate-passed', 'gate-congested', 'gate-unknown', LANE_RUN_INTENT_ABANDONED_REASON_CODE] as const) {
      expect(planGateFailedRetry(failedEntries({ reason }), RUN_ID, 0)).toEqual({ kind: 'none' });
    }
  });

  it('returns none when the highest retry has no final result (pending) or only an ambiguous one', () => {
    const base = gateKeyOf(0, 0, HEAD, null);
    expect(planGateFailedRetry([intent(base)], RUN_ID, 0)).toEqual({ kind: 'none' });
    expect(planGateFailedRetry([intent(base), result(base, 'ambiguous', 'gate-unknown')], RUN_ID, 0)).toEqual({ kind: 'none' });
  });

  it('returns none when the round has no gate intent or the last one carries no head', () => {
    expect(planGateFailedRetry([], RUN_ID, 0)).toEqual({ kind: 'none' });
    const otherRound = failedEntries({ round: 1 });
    expect(planGateFailedRetry(otherRound, RUN_ID, 0)).toEqual({ kind: 'none' });
  });

  it('ignores another run\u2019s entries', () => {
    const entries = failedEntries().map((entry) => (
      entry.kind === 'conduct' ? entry : { ...entry, runId: OTHER_RUN_ID }
    )) as LaneRunJournalEntryRecord[];
    expect(planGateFailedRetry(entries, RUN_ID, 0)).toEqual({ kind: 'none' });
  });

  it('ignores a final result whose key matches but whose runId belongs to another run', () => {
    // A result for the target key stamped with another run's id must never be
    // read as this run's gate failure: the runId participates in the lookup.
    const base = gateKeyOf(0, 0, HEAD, null);
    const foreign = { ...result(base, 'completed', 'gate-failed'), runId: OTHER_RUN_ID };
    expect(planGateFailedRetry([intent(base), foreign], RUN_ID, 0)).toEqual({ kind: 'none' });
    // The same entries wholly under their own run still plan the retry, so the
    // refusal above comes from the runId mismatch, not from the entries.
    const foreignBase = { ...intent(base), runId: OTHER_RUN_ID };
    const foreignResult = { ...result(base, 'completed', 'gate-failed'), runId: OTHER_RUN_ID };
    // The key embeds the run id, so the foreign pair needs its own key.
    const foreignKey = foreignBase.key === null ? null : foreignBase.key.replace(RUN_ID, OTHER_RUN_ID);
    expect(planGateFailedRetry([{ ...foreignBase, key: foreignKey }, { ...foreignResult, key: foreignKey }], OTHER_RUN_ID, 0)).toMatchObject({ kind: 'mint', retry: 1 });
  });

  it('refuses a getter installed at an array index without running it', () => {
    let getterRan = false;
    const lying = intent(gateKeyOf(0, 0, HEAD, null));
    const entries: unknown[] = [];
    entries.length = 1;
    Object.defineProperty(entries, 0, {
      enumerable: true,
      get: () => {
        getterRan = true;
        return lying;
      },
    });
    // A plain gate-failed entry alone would mint; the accessor slot must not
    // be read (no getter ever runs) and must not contribute a mintable entry.
    const plan = planGateFailedRetry(entries, RUN_ID, 0);
    expect(plan).toEqual({ kind: 'none' });
    expect(getterRan).toBe(false);
  });

  it('refuses the whole input when an accessor slot sits beside valid gate-failed entries', () => {
    let reads = 0;
    const entries: unknown[] = [...failedEntries(), undefined];
    Object.defineProperty(entries, entries.length - 1, {
      enumerable: true,
      get: () => {
        reads += 1;
        return intent(gateKeyOf(0, 0, HEAD, null));
      },
    });
    expect(planGateFailedRetry(entries, RUN_ID, 0)).toEqual({ kind: 'none' });
    expect(reads).toBe(0);
  });

  it('refuses the whole input when an entry has an accessor field, getter or setter, never running it', () => {
    let reads = 0;
    for (const accessor of [
      { get: () => { reads += 1; return 'x'; } },
      { set: () => { reads += 1; } },
    ]) {
      const hostile: Record<string, unknown> = { kind: 'intent', runId: RUN_ID };
      Object.defineProperty(hostile, 'key', { enumerable: true, ...accessor });
      expect(planGateFailedRetry([...failedEntries(), hostile], RUN_ID, 0)).toEqual({ kind: 'none' });
      expect(reads).toBe(0);
    }
  });

  it('refuses the whole input when any entry carries a prototype-polluting own key, even with a valid gate-failed entry present', () => {
    const polluting = JSON.parse('{"__proto__": {}, "kind": "intent"}') as object;
    const plan = planGateFailedRetry([...failedEntries(), polluting], RUN_ID, 0);
    expect(plan).toEqual({ kind: 'none' });
  });

  it('refuses hostile inputs without throwing or running getters', () => {
    const entry = intent(gateKeyOf(0, 0, HEAD, null));
    const throwing: Record<string, unknown> = { kind: 'intent' };
    Object.defineProperty(throwing, 'key', {
      enumerable: true,
      get: () => {
        throw new Error('getter must never run');
      },
    });
    const holed: unknown[] = [entry, intent(gateKeyOf(0, 0, HEAD, 1))];
    delete holed[0];
    const huge: unknown[] = [];
    huge.length = 100_001;
    const badEntries: unknown[] = [
      null,
      undefined,
      42,
      'entries',
      { length: 1, 0: entry }, // array-like, not an array
      holed,
      huge,
      [entry, throwing],
      [entry, JSON.parse('{"__proto__": {}, "kind": "intent"}') as object],
    ];
    for (const bad of badEntries) {
      expect(planGateFailedRetry(bad, RUN_ID, 0)).toEqual({ kind: 'none' });
    }
    for (const badRunId of [null, undefined, 7, BAD_RUN_ID]) {
      expect(planGateFailedRetry(failedEntries(), badRunId, 0)).toEqual({ kind: 'none' });
    }
    for (const badRound of [null, undefined, '0', 1.5, -1, 3, Number.NaN]) {
      expect(planGateFailedRetry(failedEntries(), RUN_ID, badRound)).toEqual({ kind: 'none' });
    }
  });

  it('refuses the whole input for a throwing-getter entry instead of planning from the rest', () => {
    const base = gateKeyOf(0, 0, HEAD, null);
    const throwing: Record<string, unknown> = { kind: 'intent' };
    Object.defineProperty(throwing, 'key', {
      enumerable: true,
      get: () => {
        throw new Error('getter must never run');
      },
    });
    const plan = planGateFailedRetry([throwing, intent(base), result(base, 'completed', 'gate-failed')], RUN_ID, 0);
    expect(plan).toEqual({ kind: 'none' });
  });

  it('stays under the cap for one or two gate-failed retries and mints the next retry', () => {
    // A lone failed base run is under the cap: one mint is planned.
    expect(planGateFailedRetry(failedEntries(), RUN_ID, 0)).toMatchObject({ kind: 'mint', retry: 1 });
    // A failed base run plus two failed retries stays under the cap of three.
    expect(planGateFailedRetry(failedEntries({ retries: [1, 2] }), RUN_ID, 0)).toMatchObject({ kind: 'mint', retry: 3 });
  });
});

describe('uncertain results read like ambiguous ones (UN1)', () => {
  const premergeKey = mustBuild(laneRunPremergeKey(RUN_ID, 0, HEAD));
  const enqueueKey = mustBuild(laneRunMergeEnqueueKey(RUN_ID, 0, HEAD));
  const gateKey = keyOf({ round: 0, step: 'gate', seatIndex: 0, head12: HEAD });
  const ciKey = keyOf({ round: 0, step: 'ci', seatIndex: 0, head12: HEAD });
  const collectKey = keyOf({ round: 0, step: 'collect', seatIndex: 0, attemptOrdinal: 1 });

  it('an uncertain premerge result is read as no recorded premerge post', () => {
    expect(laneRunPremergePost([intent(premergeKey), result(premergeKey, 'uncertain', 'unobservable')], RUN_ID, HEAD)).toBe('none');
    expect(laneRunPremergePost([intent(premergeKey), result(premergeKey, 'ambiguous', 'forge-ambiguous')], RUN_ID, HEAD)).toBe('none');
    expect(laneRunPremergePost([intent(premergeKey), result(premergeKey, 'completed', 'premerge-success')], RUN_ID, HEAD)).toBe('success');
  });

  it('an uncertain merge-enqueue result is read as not enqueued', () => {
    expect(laneRunMergeEnqueueFact([intent(enqueueKey), result(enqueueKey, 'uncertain', 'unobservable')], RUN_ID, 0, HEAD)).toBe('none');
    expect(laneRunMergeEnqueueFact([intent(enqueueKey), result(enqueueKey, 'ambiguous', 'forge-ambiguous')], RUN_ID, 0, HEAD)).toBe('none');
    expect(laneRunMergeEnqueueFact([intent(enqueueKey), result(enqueueKey, 'completed', 'merged')], RUN_ID, 0, HEAD)).toBe('merged');
  });

  it('an uncertain result is not read as a refused step', () => {
    const uncertain = [intent(collectKey), result(collectKey, 'uncertain', 'unobservable')];
    expect(laneRunRefusedStep(uncertain, RUN_ID, 0)).toBeNull();
    const refused = [intent(collectKey), result(collectKey, 'refused', 'collect-refused')];
    expect(laneRunRefusedStep(refused, RUN_ID, 0)).toBe('collect');
  });

  it('an uncertain result is not read as a recorded CI failure', () => {
    const uncertain = [intent(ciKey), result(ciKey, 'uncertain', 'unobservable')];
    expect(laneRunCiFailureRecorded(uncertain, RUN_ID, 0, HEAD)).toBe(false);
    const failed = [intent(ciKey), result(ciKey, 'completed', 'ci-failed')];
    expect(laneRunCiFailureRecorded(failed, RUN_ID, 0, HEAD)).toBe(true);
  });

  it('finalResultOf treats an uncertain result like an ambiguous one', () => {
    const uncertain = [intent(gateKey), result(gateKey, 'uncertain', 'gate-unknown')];
    expect(laneRunGateFact(uncertain, RUN_ID, HEAD)).toBe('pending');
    const ambiguous = [intent(gateKey), result(gateKey, 'ambiguous', 'gate-unknown')];
    expect(laneRunGateFact(ambiguous, RUN_ID, HEAD)).toBe('pending');
    const settled = [...uncertain, result(gateKey, 'completed', 'gate-passed')];
    expect(laneRunGateFact(settled, RUN_ID, HEAD)).toBe('passed');
  });

  it('finalSnapshotResultOf treats an uncertain result like an ambiguous one', () => {
    const uncertain = [intent(gateKey), result(gateKey, 'uncertain', 'gate-unknown')];
    expect(planGateFailedRetry(uncertain, RUN_ID, 0)).toEqual({ kind: 'none' });
    const ambiguous = [intent(gateKey), result(gateKey, 'ambiguous', 'gate-unknown')];
    expect(planGateFailedRetry(ambiguous, RUN_ID, 0)).toEqual({ kind: 'none' });
    const settled = [...uncertain, result(gateKey, 'refused', 'gate-failed')];
    expect(planGateFailedRetry(settled, RUN_ID, 0).kind).toBe('mint');
  });

  it('planGateFailedRetry treats an uncertain result like an ambiguous one', () => {
    // Upstream, the append decision refuses an uncertain result on a gate intent.
    expect(prepareLaneRunJournalAppend([intent(gateKey)], result(gateKey, 'uncertain', 'gate-unknown'))).toEqual({
      ok: false,
      reason: 'invalid-entry',
      detail: expect.any(String),
    });
    // If one is passed directly, it reads like `ambiguous`: no retry mints.
    expect(planGateFailedRetry([intent(gateKey), result(gateKey, 'uncertain', 'gate-unknown')], RUN_ID, 0)).toEqual({ kind: 'none' });
    expect(planGateFailedRetry([intent(gateKey), result(gateKey, 'ambiguous', 'gate-unknown')], RUN_ID, 0)).toEqual({ kind: 'none' });
  });

  it('laneRunGateFailed treats an uncertain result like an ambiguous one', () => {
    expect(prepareLaneRunJournalAppend([intent(gateKey)], result(gateKey, 'uncertain', 'gate-unknown')).ok).toBe(false);
    expect(laneRunGateFailed([intent(gateKey), result(gateKey, 'uncertain', 'gate-unknown')], RUN_ID, HEAD)).toBeNull();
    expect(laneRunGateFailed([intent(gateKey), result(gateKey, 'ambiguous', 'gate-unknown')], RUN_ID, HEAD)).toBeNull();
    const failed = [intent(gateKey), result(gateKey, 'refused', 'gate-failed')];
    expect(laneRunGateFailed(failed, RUN_ID, HEAD)).toEqual({ retry: 0, failedCount: 1 });
  });
});
