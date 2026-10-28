import { describe, expect, it } from 'vitest';

import { buildLaneRunStepKey } from '../lane-run-keys.js';
import type { LaneRunKeyResult } from '../lane-run-keys.js';
import { LANE_RUN_JOURNAL_REASON_CODE_PATTERN } from '../lane-run-journal.js';
import type { LaneRunJournalEntryRecord, LaneRunJournalOutcome } from '../lane-run-journal.js';
import {
  LANE_RUN_RESULT_REASON_CODES,
  laneRunAttemptDispatchResult,
  laneRunAttemptPlacement,
  laneRunConductEntry,
  laneRunDispatchedAtIso,
  laneRunGateFact,
  laneRunIntentEntry,
  laneRunParkedConductCount,
  laneRunRefusedStep,
  laneRunResultEntry,
  laneRunStopsIssued,
  laneRunTimedOut,
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
});

describe('laneRunRefusedStep', () => {
  const collectKey = keyOf({ round: 0, step: 'collect', seatIndex: 0 });

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
