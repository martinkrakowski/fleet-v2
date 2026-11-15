import { describe, expect, it } from 'vitest';

import { buildLaneRunStepKey } from '../lane-run-keys.js';
import type { LaneRunKeyResult } from '../lane-run-keys.js';
import type { LaneRunJournalEntryRecord, LaneRunJournalOutcome } from '../lane-run-journal.js';
import { laneRunIntentEntry, laneRunResultEntry } from '../lane-run-step-facts.js';
import type { LaneRunResultReasonCode } from '../lane-run-step-facts.js';
import { laneRunReviewConfirmationFact, laneRunReviewFact } from '../lane-run-review-facts.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const OTHER_RUN_ID = 'run-01JB0000000000000000000001';
const NOW = '2026-10-27T10:00:00.000Z';
const HEAD = '0123456789ab';
const OTHER_HEAD = 'fedcba987654';
const BAD_RUN_ID = 'not-a-run-id';

function mustBuild(result: LaneRunKeyResult): string {
  if (!result.ok) {
    throw new Error('unreachable: key builder');
  }
  return result.key;
}

function reviewKey(
  step: 'brief-check' | 'code-review' | 'pre-merge',
  opts: { runId?: string; seatIndex: number; head12?: string | null; retry?: number | null },
): string {
  return mustBuild(buildLaneRunStepKey({
    runId: opts.runId ?? RUN_ID,
    round: 0,
    step,
    seatIndex: opts.seatIndex,
    attemptOrdinal: null,
    head12: opts.head12 === undefined ? HEAD : opts.head12,
    retry: opts.retry ?? null,
  }));
}

let entryIdCounter = 0;
function nextEntryId(): string {
  const ordinal = String(entryIdCounter).padStart(22, '0').slice(-22);
  entryIdCounter += 1;
  return '01JB' + ordinal;
}

function intent(key: string, opts: { runId?: string } = {}): LaneRunJournalEntryRecord {
  return laneRunIntentEntry(nextEntryId(), opts.runId ?? RUN_ID, key, null, NOW);
}

function result(key: string, outcome: LaneRunJournalOutcome, reasonCode: LaneRunResultReasonCode | null = null): LaneRunJournalEntryRecord {
  return laneRunResultEntry(nextEntryId(), RUN_ID, key, outcome, reasonCode, NOW);
}

describe('laneRunReviewFact', () => {
  it('returns none when no intent of the kind exists at the head', () => {
    const entries: LaneRunJournalEntryRecord[] = [];
    expect(laneRunReviewFact(entries, RUN_ID, 'brief-check', HEAD)).toEqual({ verdict: 'none', seatIndex: null, retries: 0 });
  });

  it('returns none for a null head12', () => {
    const key = reviewKey('brief-check', { seatIndex: 0 });
    const entries = [intent(key), result(key, 'completed', 'review-passed')];
    expect(laneRunReviewFact(entries, RUN_ID, 'brief-check', null)).toEqual({ verdict: 'none', seatIndex: null, retries: 0 });
  });

  it('returns pending when the latest intent has no final result', () => {
    const key = reviewKey('brief-check', { seatIndex: 1 });
    const entries = [intent(key)];
    expect(laneRunReviewFact(entries, RUN_ID, 'brief-check', HEAD)).toEqual({ verdict: 'pending', seatIndex: 1, retries: 0 });
  });

  it('maps a final review-passed to passed', () => {
    const key = reviewKey('code-review', { seatIndex: 2 });
    const entries = [intent(key), result(key, 'completed', 'review-passed')];
    expect(laneRunReviewFact(entries, RUN_ID, 'code-review', HEAD)).toEqual({ verdict: 'passed', seatIndex: 2, retries: 0 });
  });

  it('maps a final review-failed to failed', () => {
    const key = reviewKey('code-review', { seatIndex: 0 });
    const entries = [intent(key), result(key, 'completed', 'review-failed')];
    expect(laneRunReviewFact(entries, RUN_ID, 'code-review', HEAD)).toEqual({ verdict: 'failed', seatIndex: 0, retries: 0 });
  });

  it('maps a final review-no-receipt to no-receipt', () => {
    const key = reviewKey('brief-check', { seatIndex: 3 });
    const entries = [intent(key), result(key, 'completed', 'review-no-receipt')];
    expect(laneRunReviewFact(entries, RUN_ID, 'brief-check', HEAD)).toEqual({ verdict: 'no-receipt', seatIndex: 3, retries: 0 });
  });

  it('maps a final result with no reason code to unknown, never pending', () => {
    const key = reviewKey('code-review', { seatIndex: 2 });
    const entries = [intent(key), result(key, 'completed', null)];
    expect(laneRunReviewFact(entries, RUN_ID, 'code-review', HEAD)).toEqual({ verdict: 'unknown', seatIndex: 2, retries: 0 });
  });

  it('maps any other final reason code to unknown', () => {
    const key = reviewKey('pre-merge', { seatIndex: 1 });
    const entries = [intent(key), result(key, 'completed', 'review-refused')];
    expect(laneRunReviewFact(entries, RUN_ID, 'pre-merge', HEAD)).toEqual({ verdict: 'unknown', seatIndex: 1, retries: 0 });
  });

  it('maps a final review-unknown reason code to unknown', () => {
    const key = reviewKey('pre-merge', { seatIndex: 1 });
    const entries = [intent(key), result(key, 'completed', 'review-unknown')];
    expect(laneRunReviewFact(entries, RUN_ID, 'pre-merge', HEAD)).toEqual({ verdict: 'unknown', seatIndex: 1, retries: 0 });
  });

  it('maps a final assessment-unavailable reason code to unknown', () => {
    const key = reviewKey('pre-merge', { seatIndex: 1 });
    const entries = [intent(key), result(key, 'refused', 'assessment-unavailable')];
    expect(laneRunReviewFact(entries, RUN_ID, 'pre-merge', HEAD)).toEqual({ verdict: 'unknown', seatIndex: 1, retries: 0 });
  });

  it('lets the latest intent override an earlier one', () => {
    const firstKey = reviewKey('brief-check', { seatIndex: 0 });
    const secondKey = reviewKey('brief-check', { seatIndex: 2, retry: 1 });
    const entries = [
      intent(firstKey),
      result(firstKey, 'completed', 'review-failed'),
      intent(secondKey),
    ];
    expect(laneRunReviewFact(entries, RUN_ID, 'brief-check', HEAD)).toEqual({ verdict: 'pending', seatIndex: 2, retries: 1 });
  });

  it('counts retry intents of the latest seat at the head in retries', () => {
    const firstKey = reviewKey('code-review', { seatIndex: 4 });
    const retryKey = reviewKey('code-review', { seatIndex: 4, retry: 1 });
    const entries = [
      intent(firstKey),
      result(firstKey, 'completed', 'review-no-receipt'),
      intent(retryKey),
      result(retryKey, 'completed', 'review-passed'),
    ];
    expect(laneRunReviewFact(entries, RUN_ID, 'code-review', HEAD)).toEqual({ verdict: 'passed', seatIndex: 4, retries: 1 });
  });

  it('counts a retry intent without a final result as pending with retries counted', () => {
    const firstKey = reviewKey('brief-check', { seatIndex: 0 });
    const retryKey = reviewKey('brief-check', { seatIndex: 0, retry: 1 });
    const entries = [
      intent(firstKey),
      result(firstKey, 'completed', 'review-no-receipt'),
      intent(retryKey),
    ];
    expect(laneRunReviewFact(entries, RUN_ID, 'brief-check', HEAD)).toEqual({ verdict: 'pending', seatIndex: 0, retries: 1 });
  });

  it("ignores another run's entries", () => {
    const otherKey = reviewKey('brief-check', { runId: OTHER_RUN_ID, seatIndex: 0 });
    const entries = [intent(otherKey, { runId: OTHER_RUN_ID }), result(otherKey, 'completed', 'review-passed')];
    expect(laneRunReviewFact(entries, RUN_ID, 'brief-check', HEAD)).toEqual({ verdict: 'none', seatIndex: null, retries: 0 });
  });

  it("ignores another head's entries", () => {
    const otherHeadKey = reviewKey('brief-check', { seatIndex: 0, head12: OTHER_HEAD });
    const entries = [intent(otherHeadKey), result(otherHeadKey, 'completed', 'review-passed')];
    expect(laneRunReviewFact(entries, RUN_ID, 'brief-check', HEAD)).toEqual({ verdict: 'none', seatIndex: null, retries: 0 });
  });

  it('never lets a code-review entry answer brief-check', () => {
    const codeReviewKey = reviewKey('code-review', { seatIndex: 0 });
    const entries = [intent(codeReviewKey), result(codeReviewKey, 'completed', 'review-passed')];
    expect(laneRunReviewFact(entries, RUN_ID, 'brief-check', HEAD)).toEqual({ verdict: 'none', seatIndex: null, retries: 0 });
  });

  it('never throws for a malformed run id and returns none', () => {
    const key = reviewKey('brief-check', { seatIndex: 0 });
    const entries = [intent(key), result(key, 'completed', 'review-passed')];
    expect(laneRunReviewFact(entries, BAD_RUN_ID, 'brief-check', HEAD)).toEqual({ verdict: 'none', seatIndex: null, retries: 0 });
  });
});

describe('laneRunReviewConfirmationFact', () => {
  it('returns no prior pass and no confirming retries when nothing ran at the head', () => {
    expect(laneRunReviewConfirmationFact([], RUN_ID, 'brief-check', HEAD)).toEqual({
      priorPassedAtHead: false,
      confirmingRetries: 0,
    });
  });

  it('returns no prior pass for a null head12', () => {
    const key = reviewKey('brief-check', { seatIndex: 0 });
    const entries = [intent(key), result(key, 'completed', 'review-passed')];
    expect(laneRunReviewConfirmationFact(entries, RUN_ID, 'brief-check', null)).toEqual({
      priorPassedAtHead: false,
      confirmingRetries: 0,
    });
  });

  it("returns no prior pass at another head's key", () => {
    const otherHeadKey = reviewKey('brief-check', { seatIndex: 0, head12: OTHER_HEAD });
    const entries = [intent(otherHeadKey), result(otherHeadKey, 'completed', 'review-passed')];
    expect(laneRunReviewConfirmationFact(entries, RUN_ID, 'brief-check', HEAD)).toEqual({
      priorPassedAtHead: false,
      confirmingRetries: 0,
    });
  });

  it("returns no prior pass for another run's entries", () => {
    const otherRunKey = reviewKey('brief-check', { runId: OTHER_RUN_ID, seatIndex: 0 });
    const entries = [intent(otherRunKey, { runId: OTHER_RUN_ID }), result(otherRunKey, 'completed', 'review-passed')];
    expect(laneRunReviewConfirmationFact(entries, RUN_ID, 'brief-check', HEAD)).toEqual({
      priorPassedAtHead: false,
      confirmingRetries: 0,
    });
  });

  it('returns no prior pass for another review kind', () => {
    const codeReviewKey = reviewKey('code-review', { seatIndex: 0 });
    const entries = [intent(codeReviewKey), result(codeReviewKey, 'completed', 'review-passed')];
    expect(laneRunReviewConfirmationFact(entries, RUN_ID, 'brief-check', HEAD)).toEqual({
      priorPassedAtHead: false,
      confirmingRetries: 0,
    });
  });

  it('returns no prior pass when the only verdict is a review-failed', () => {
    const key = reviewKey('brief-check', { seatIndex: 0 });
    const entries = [intent(key), result(key, 'completed', 'review-failed')];
    expect(laneRunReviewConfirmationFact(entries, RUN_ID, 'brief-check', HEAD)).toEqual({
      priorPassedAtHead: false,
      confirmingRetries: 0,
    });
  });

  it('reports a prior pass after a passed then a contradictory failed at the same head', () => {
    const firstKey = reviewKey('brief-check', { seatIndex: 0 });
    const secondKey = reviewKey('brief-check', { seatIndex: 0, retry: 1 });
    const entries = [
      intent(firstKey),
      result(firstKey, 'completed', 'review-passed'),
      intent(secondKey),
      result(secondKey, 'completed', 'review-failed'),
    ];
    expect(laneRunReviewConfirmationFact(entries, RUN_ID, 'brief-check', HEAD)).toEqual({
      priorPassedAtHead: true,
      confirmingRetries: 0,
    });
  });

  it('counts the confirming re-review intents after the contradictory failed', () => {
    const passedKey = reviewKey('brief-check', { seatIndex: 0 });
    const failedKey = reviewKey('brief-check', { seatIndex: 0, retry: 1 });
    const confirmKey = reviewKey('brief-check', { seatIndex: 0, retry: 2 });
    const entries = [
      intent(passedKey),
      result(passedKey, 'completed', 'review-passed'),
      intent(failedKey),
      result(failedKey, 'completed', 'review-failed'),
      intent(confirmKey),
      result(confirmKey, 'completed', 'review-failed'),
    ];
    expect(laneRunReviewConfirmationFact(entries, RUN_ID, 'brief-check', HEAD)).toEqual({
      priorPassedAtHead: true,
      confirmingRetries: 1,
    });
  });

  it('ignores seat-busy and review-superseded intents between the pass and the failed', () => {
    const passedKey = reviewKey('brief-check', { seatIndex: 0 });
    const busyKey = reviewKey('brief-check', { seatIndex: 0, retry: 1 });
    const failedKey = reviewKey('brief-check', { seatIndex: 0, retry: 2 });
    const entries = [
      intent(passedKey),
      result(passedKey, 'completed', 'review-passed'),
      intent(busyKey),
      result(busyKey, 'completed', 'seat-busy'),
      intent(failedKey),
      result(failedKey, 'completed', 'review-failed'),
    ];
    expect(laneRunReviewConfirmationFact(entries, RUN_ID, 'brief-check', HEAD)).toEqual({
      priorPassedAtHead: true,
      confirmingRetries: 0,
    });
  });

  it('never throws and fails closed on a sparse array with a hole', () => {
    const key = reviewKey('brief-check', { seatIndex: 0 });
    const validEntry = intent(key);
    const sparse: LaneRunJournalEntryRecord[] = new Array(2);
    sparse[1] = validEntry;
    expect(() => laneRunReviewConfirmationFact(sparse, RUN_ID, 'brief-check', HEAD)).not.toThrow();
    expect(laneRunReviewConfirmationFact(sparse, RUN_ID, 'brief-check', HEAD)).toEqual({
      priorPassedAtHead: false,
      confirmingRetries: 0,
    });
  });

  it('never throws and fails closed on a non-plain object entry, prototype-polluting key, or throwing getter', () => {
    const key = reviewKey('brief-check', { seatIndex: 0 });
    // A prototype-derived (non-plain) intent whose result would otherwise count as a pass.
    const inherited = Object.create({ kind: 'intent', runId: RUN_ID, key });
    const throwingGetter = Object.defineProperty({}, 'kind', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    const polluting = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const cases: unknown[] = [inherited, throwingGetter, polluting];
    for (const hostile of cases) {
      const entries = [hostile as LaneRunJournalEntryRecord];
      expect(() => laneRunReviewConfirmationFact(entries, RUN_ID, 'brief-check', HEAD)).not.toThrow();
      expect(laneRunReviewConfirmationFact(entries, RUN_ID, 'brief-check', HEAD)).toEqual({
        priorPassedAtHead: false,
        confirmingRetries: 0,
      });
    }
  });

  it('fails closed on a wrong-kind or empty head12 string', () => {
    const key = reviewKey('brief-check', { seatIndex: 0 });
    const entries = [intent(key), result(key, 'completed', 'review-passed')];
    expect(laneRunReviewConfirmationFact(entries, RUN_ID, 'brief-check', 'short')).toEqual({
      priorPassedAtHead: false,
      confirmingRetries: 0,
    });
    expect(laneRunReviewConfirmationFact('not-an-array' as unknown as LaneRunJournalEntryRecord[], RUN_ID, 'brief-check', HEAD)).toEqual({
      priorPassedAtHead: false,
      confirmingRetries: 0,
    });
  });
});
