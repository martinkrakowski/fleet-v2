import { describe, expect, it } from 'vitest';

import {
  evaluateShadowStateIntegrity,
  evaluateShadowTickHealth,
  SHADOW_OPEN_INTENT_GRACE_MS,
  SHADOW_MAX_HEALTH_ITEMS,
  SHADOW_MIN_TICKS_PER_DAY,
  SHADOW_LAST_TICK_GRACE_MS,
  SHADOW_MAX_TICK_GAP_MS,
  type ShadowTickHealthEvaluation,
} from '../shadow-day-health.js';

const HOUR_MS = 3_600_000;

const DAY = '2026-11-10';
const PREV_23 = (minute: number): string => `2026-11-09T23:${String(minute).padStart(2, '0')}:00.000Z`;
const DAY_AT = (minute: number): string => `2026-11-10T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00.000Z`;
const DAY_START_MS = Date.UTC(2026, 10, 10);
const isoAtOffsetMs = (offsetMs: number): string => new Date(DAY_START_MS + offsetMs).toISOString();
const SAMPLE_AT = '2026-11-11T00:00:00.000Z';
const CHARSET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DIGEST = '0123456789ab';

function ulidBody(counter: number): string {
  let n = counter;
  let body = '';
  for (let i = 0; i < 25; i += 1) {
    body = CHARSET[n % 32] + body;
    n = Math.floor(n / 32) + 1;
  }
  return body;
}

function eventId(counter: number): string {
  return `0${ulidBody(counter)}`;
}

function tickId(counter: number): string {
  return `tick-0${ulidBody(counter)}`;
}

function jobEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    eventId: eventId(1),
    tickId: tickId(1),
    jobId: 'notifier',
    kind: 'job',
    key: null,
    entryId: null,
    outcome: 'completed',
    reasonCode: null,
    recordedAtIso: DAY_AT(0),
    ...overrides,
  };
}

/**
 * OD7a3: `count` clean ticks inside day D, one job event each, spread evenly
 * across the WHOLE day `[00:00Z, 24:00Z)` so every fixture meets the S12
 * coverage guards (`SHADOW_LAST_TICK_GRACE_MS` / `SHADOW_MAX_TICK_GAP_MS`)
 * whenever coverage is not the thing under test.
 */
function cleanDay(count: number, startCounter = 1): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i += 1) {
    const offsetMs = Math.round((i * 86_400_000) / count);
    events.push(jobEvent({
      eventId: eventId(startCounter + i),
      tickId: tickId(startCounter + i),
      recordedAtIso: isoAtOffsetMs(offsetMs),
    }));
  }
  return events;
}

function starveEvent(spec: { iso: string; counter: number; outcome?: string; reasonCode?: string }): Record<string, unknown> {
  return jobEvent({
    eventId: eventId(100_000 + spec.counter),
    tickId: tickId(100_000 + spec.counter),
    jobId: `chain-refresh:${DIGEST}`,
    outcome: spec.outcome ?? 'budget-exhausted',
    reasonCode: spec.outcome === 'skipped' ? spec.reasonCode ?? 'lease-skip' : spec.reasonCode ?? null,
    recordedAtIso: spec.iso,
  });
}

function s12(input: unknown): ShadowTickHealthEvaluation {
  return evaluateShadowTickHealth(input);
}

function dayInput(events: unknown[]): Record<string, unknown> {
  return { day: DAY, events };
}

describe('evaluateShadowTickHealth (S12)', () => {
  it('passes 1,440 clean evenly-spread ticks with no budget issues', () => {
    expect(s12(dayInput(cleanDay(1440)))).toEqual({
      status: 'pass',
      reason: 'ticks-within-budget',
      totalTicks: 1440,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
  });

  it('fails with too-few-ticks at exactly 719 ticks', () => {
    expect(s12(dayInput(cleanDay(719)))).toEqual({
      status: 'fail',
      reason: 'too-few-ticks',
      totalTicks: 719,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
  });

  it('passes at the 720-tick boundary', () => {
    expect(s12(dayInput(cleanDay(720)))).toEqual({
      status: 'pass',
      reason: 'ticks-within-budget',
      totalTicks: 720,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
  });

  it('fails tick-budget-overrun when exactly 2% of 800 ticks had a budget-exhausted job', () => {
    const events = cleanDay(800);
    for (let i = 0; i < 16; i += 1) {
      events[i] = jobEvent({
        ...events[i],
        jobId: `merge-pass:${DIGEST.slice(0, 10)}${String(i).padStart(2, '0')}`,
        outcome: 'budget-exhausted',
      });
    }
    expect(s12(dayInput(events))).toEqual({
      status: 'fail',
      reason: 'tick-budget-overrun',
      totalTicks: 800,
      budgetOverruns: 16,
      starvedJobs: 0,
    });
  });

  it('passes at the exactly-1% boundary (8 of 800 ticks budget-exhausted)', () => {
    const events = cleanDay(800);
    for (let i = 0; i < 8; i += 1) {
      events[i] = jobEvent({
        ...events[i],
        jobId: `merge-pass:${DIGEST.slice(0, 10)}${String(i).padStart(2, '0')}`,
        outcome: 'budget-exhausted',
      });
    }
    expect(s12(dayInput(events))).toEqual({
      status: 'pass',
      reason: 'ticks-within-budget',
      totalTicks: 800,
      budgetOverruns: 8,
      starvedJobs: 0,
    });
  });

  it('fails job-starved for 10 consecutive budget-exhausted outcomes spanning midnight, last inside day D', () => {
    const events = cleanDay(720, 400);
    for (let i = 0; i < 9; i += 1) {
      events.push(starveEvent({ iso: PREV_23(45 + i), counter: i }));
    }
    events.push(starveEvent({ iso: DAY_AT(0), counter: 9 }));
    expect(s12(dayInput(events))).toEqual({
      status: 'fail',
      reason: 'job-starved',
      totalTicks: 721,
      budgetOverruns: 1,
      starvedJobs: 1,
    });
  });

  it('passes with only 9 consecutive budget-exhausted outcomes spanning midnight', () => {
    const events = cleanDay(720, 400);
    for (let i = 0; i < 8; i += 1) {
      events.push(starveEvent({ iso: PREV_23(45 + i), counter: i }));
    }
    events.push(starveEvent({ iso: DAY_AT(0), counter: 8 }));
    expect(s12(dayInput(events))).toEqual({
      status: 'pass',
      reason: 'ticks-within-budget',
      totalTicks: 721,
      budgetOverruns: 1,
      starvedJobs: 0,
    });
  });

  it('passes a 10-run of budget-exhausted outcomes entirely on D-1 with no member inside day D', () => {
    const events = cleanDay(720, 400);
    for (let i = 0; i < 10; i += 1) {
      events.push(starveEvent({ iso: PREV_23(50 + i), counter: i }));
    }
    expect(s12(dayInput(events))).toEqual({
      status: 'pass',
      reason: 'ticks-within-budget',
      totalTicks: 720,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
  });

  it('fails job-starved when a skip preserves the run: 9 exhausted, a skip, then 1 exhausted', () => {
    const events = cleanDay(720, 400);
    for (let i = 0; i < 9; i += 1) {
      events.push(starveEvent({ iso: PREV_23(40 + i), counter: i }));
    }
    events.push(starveEvent({ iso: PREV_23(49), counter: 100, outcome: 'skipped', reasonCode: 'lease-skip' }));
    events.push(starveEvent({ iso: DAY_AT(0), counter: 101 }));
    expect(s12(dayInput(events))).toEqual({
      status: 'fail',
      reason: 'job-starved',
      totalTicks: 721,
      budgetOverruns: 1,
      starvedJobs: 1,
    });
  });

  it('passes when 8 exhausted, a skip, then 1 exhausted keep the run under the threshold', () => {
    const events = cleanDay(720, 400);
    for (let i = 0; i < 8; i += 1) {
      events.push(starveEvent({ iso: PREV_23(40 + i), counter: i }));
    }
    events.push(starveEvent({ iso: PREV_23(49), counter: 100, outcome: 'skipped', reasonCode: 'lease-skip' }));
    events.push(starveEvent({ iso: DAY_AT(0), counter: 101 }));
    expect(s12(dayInput(events))).toEqual({
      status: 'pass',
      reason: 'ticks-within-budget',
      totalTicks: 721,
      budgetOverruns: 1,
      starvedJobs: 0,
    });
  });

  it('reports unknown/daemon-events-invalid with one malformed event in an otherwise clean day', () => {
    const events = [...cleanDay(720), { nope: true }];
    expect(s12(dayInput(events))).toEqual({
      status: 'unknown',
      reason: 'daemon-events-invalid',
      totalTicks: 0,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
  });

  it('is not satisfiable by a constant verdict: clean and overrun days differ', () => {
    const clean = s12(dayInput(cleanDay(720)));
    const overrun = s12(dayInput([...cleanDay(720), ...Array.from({ length: 10 }, (_, i) => jobEvent({
      eventId: eventId(400_000 + i),
      tickId: tickId(400_000 + i),
      jobId: `merge-pass:${DIGEST.slice(0, 10)}${String(i).padStart(2, '0')}`,
      outcome: 'budget-exhausted',
      recordedAtIso: DAY_AT(i),
    }))]));
    expect(clean).toEqual({
      status: 'pass',
      reason: 'ticks-within-budget',
      totalTicks: 720,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
    expect(overrun).toEqual({
      status: 'fail',
      reason: 'tick-budget-overrun',
      totalTicks: 730,
      budgetOverruns: 10,
      starvedJobs: 0,
    });
  });

  it('never echoes its input', () => {
    const input = dayInput(cleanDay(720));
    const result = s12(input) as unknown as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['budgetOverruns', 'reason', 'starvedJobs', 'status', 'totalTicks']);
    expect(result).not.toHaveProperty('day');
    expect(result).not.toHaveProperty('events');
  });

  it('returns zero tick-health counts for invalid-input', () => {
    const zero = { totalTicks: 0, budgetOverruns: 0, starvedJobs: 0 };
    expect(s12(null)).toEqual({ status: 'unknown', reason: 'invalid-input', ...zero });
    expect(s12(undefined)).toEqual({ status: 'unknown', reason: 'invalid-input', ...zero });
    expect(s12({ day: 42, events: [] })).toEqual({ status: 'unknown', reason: 'invalid-input', ...zero });
  });

  it('returns zero tick-health counts for daemon-events-invalid', () => {
    const zero = { totalTicks: 0, budgetOverruns: 0, starvedJobs: 0 };
    expect(s12({ day: DAY, events: 'nope' })).toEqual({ status: 'unknown', reason: 'daemon-events-invalid', ...zero });
    expect(s12({ day: DAY, events: {} })).toEqual({ status: 'unknown', reason: 'daemon-events-invalid', ...zero });
    expect(s12(dayInput([...cleanDay(1), { nope: true }]))).toEqual({
      status: 'unknown',
      reason: 'daemon-events-invalid',
      ...zero,
    });
  });

  it('returns zero tick-health counts for a revoked Proxy', () => {
    const { proxy, revoke } = Proxy.revocable(dayInput(cleanDay(720)), {});
    revoke();
    expect(evaluateShadowTickHealth(proxy)).toEqual({
      status: 'unknown',
      reason: 'invalid-input',
      totalTicks: 0,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
  });

  it('returns zero tick-health counts for a Proxy whose ownKeys trap throws', () => {
    const proxy = new Proxy(dayInput(cleanDay(720)), {
      ownKeys() {
        throw new Error('trap');
      },
    });
    expect(evaluateShadowTickHealth(proxy)).toEqual({
      status: 'unknown',
      reason: 'invalid-input',
      totalTicks: 0,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
  });

  it('an own symbol key on events is daemon-events-invalid (Object.keys used to ignore it)', () => {
    const events = cleanDay(720);
    Object.defineProperty(events, Symbol('extra'), { value: 1, enumerable: true });
    expect(s12(dayInput(events))).toEqual({
      status: 'unknown',
      reason: 'daemon-events-invalid',
      totalTicks: 0,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
  });

  it('a non-enumerable extra own key on events is daemon-events-invalid (Object.keys used to ignore it)', () => {
    const events = cleanDay(720);
    Object.defineProperty(events, 'extra', { value: 1, enumerable: false });
    expect(s12(dayInput(events))).toEqual({
      status: 'unknown',
      reason: 'daemon-events-invalid',
      totalTicks: 0,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
  });

  it('an accessor element refuses the whole events list before any item reader runs', () => {
    let calls = 0;
    const accessorList: unknown[] = [];
    Object.defineProperty(accessorList, 0, {
      enumerable: true,
      get() {
        calls += 1;
        return jobEvent({});
      },
    });
    accessorList.length = 1;
    expect(s12(dayInput(accessorList))).toEqual({
      status: 'unknown',
      reason: 'daemon-events-invalid',
      totalTicks: 0,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
    expect(calls).toBe(0);
  });

  it('reports computed budgetOverruns and starvedJobs on too-few-ticks', () => {
    const events = Array.from({ length: 10 }, (_, i) => jobEvent({
      eventId: eventId(i + 1),
      tickId: tickId(i + 1),
      jobId: `chain-refresh:${DIGEST}`,
      outcome: 'budget-exhausted',
      recordedAtIso: DAY_AT(i),
    }));
    expect(s12(dayInput(events))).toEqual({
      status: 'fail',
      reason: 'too-few-ticks',
      totalTicks: 10,
      budgetOverruns: 10,
      starvedJobs: 1,
    });
  });

  it('reports starvedJobs 2 when two jobs each have a starved run', () => {
    const events = cleanDay(720, 400);
    const jobs = [
      { jobId: `chain-refresh:${DIGEST}`, inDayMinute: 0, counterBase: 200_000 },
      { jobId: `merge-pass:${DIGEST}`, inDayMinute: 1, counterBase: 200_100 },
    ];
    for (const spec of jobs) {
      for (let i = 0; i < 9; i += 1) {
        events.push(jobEvent({
          eventId: eventId(spec.counterBase + i),
          tickId: tickId(spec.counterBase + i),
          jobId: spec.jobId,
          outcome: 'budget-exhausted',
          recordedAtIso: PREV_23(30 + i),
        }));
      }
      events.push(jobEvent({
        eventId: eventId(spec.counterBase + 9),
        tickId: tickId(spec.counterBase + 9),
        jobId: spec.jobId,
        outcome: 'budget-exhausted',
        recordedAtIso: DAY_AT(spec.inDayMinute),
      }));
    }
    expect(s12(dayInput(events))).toEqual({
      status: 'fail',
      reason: 'job-starved',
      totalTicks: 722,
      budgetOverruns: 2,
      starvedJobs: 2,
    });
  });

  it('two pass/ticks-within-budget inputs with different tick counts carry different totalTicks', () => {
    const fewer = s12(dayInput(cleanDay(720)));
    const more = s12(dayInput(cleanDay(721)));
    expect(fewer).toEqual({
      status: 'pass',
      reason: 'ticks-within-budget',
      totalTicks: 720,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
    expect(more).toEqual({
      status: 'pass',
      reason: 'ticks-within-budget',
      totalTicks: 721,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
    expect(fewer.totalTicks).not.toBe(more.totalTicks);
  });

  it('two fail/too-few-ticks inputs with different tick counts carry different totalTicks', () => {
    const fewer = s12(dayInput(cleanDay(10)));
    const more = s12(dayInput(cleanDay(11)));
    expect(fewer).toEqual({
      status: 'fail',
      reason: 'too-few-ticks',
      totalTicks: 10,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
    expect(more).toEqual({
      status: 'fail',
      reason: 'too-few-ticks',
      totalTicks: 11,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
    expect(fewer.totalTicks).not.toBe(more.totalTicks);
  });

  it('returns a frozen ShadowTickHealthEvaluation', () => {
    const pass = s12(dayInput(cleanDay(720)));
    const refused = s12(null);
    expect(Object.isFrozen(pass)).toBe(true);
    expect(Object.isFrozen(refused)).toBe(true);
  });

  it('fails late-last-tick when the daemon is dead from 13:00Z', () => {
    const events = cleanDay(1440).filter((event) => Date.parse(event.recordedAtIso as string) < DAY_START_MS + 13 * HOUR_MS);
    expect(events.length).toBeGreaterThanOrEqual(SHADOW_MIN_TICKS_PER_DAY);
    expect(s12(dayInput(events))).toEqual({
      status: 'fail',
      reason: 'late-last-tick',
      totalTicks: events.length,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
  });

  it('fails coverage-gap for a 40-minute hole at 09:00Z', () => {
    const events = cleanDay(1440).filter((event) => {
      const offset = Date.parse(event.recordedAtIso as string) - DAY_START_MS;
      return offset <= 540 * 60_000 || offset >= 580 * 60_000;
    });
    expect(events.length).toBeGreaterThanOrEqual(SHADOW_MIN_TICKS_PER_DAY);
    expect(s12(dayInput(events))).toEqual({
      status: 'fail',
      reason: 'coverage-gap',
      totalTicks: events.length,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
  });

  it('passes a full day of regular ticks', () => {
    expect(s12(dayInput(cleanDay(1440)))).toEqual({
      status: 'pass',
      reason: 'ticks-within-budget',
      totalTicks: 1440,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
  });

  it('passes at the exact late-last-tick boundary: last tick at dayEndMs - SHADOW_LAST_TICK_GRACE_MS', () => {
    const events = cleanDay(1440).map((event, i) => jobEvent({
      ...event,
      recordedAtIso: isoAtOffsetMs(Math.round((i * (86_400_000 - SHADOW_LAST_TICK_GRACE_MS)) / 1439)),
    }));
    expect(s12(dayInput(events))).toEqual({
      status: 'pass',
      reason: 'ticks-within-budget',
      totalTicks: 1440,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
  });

  it('fails late-last-tick 1 ms before the boundary', () => {
    const events = cleanDay(1440).map((event, i) => jobEvent({
      ...event,
      recordedAtIso: isoAtOffsetMs(Math.round((i * (86_400_000 - SHADOW_LAST_TICK_GRACE_MS - 1)) / 1439)),
    }));
    expect(s12(dayInput(events))).toEqual({
      status: 'fail',
      reason: 'late-last-tick',
      totalTicks: 1440,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
  });

  it('passes at the exact coverage-gap boundary: a hole of exactly SHADOW_MAX_TICK_GAP_MS', () => {
    const gapStart = 540 * 60_000;
    const events = cleanDay(1440).filter((event) => {
      const offset = Date.parse(event.recordedAtIso as string) - DAY_START_MS;
      return offset <= gapStart || offset >= gapStart + SHADOW_MAX_TICK_GAP_MS;
    });
    expect(events.length).toBeGreaterThanOrEqual(SHADOW_MIN_TICKS_PER_DAY);
    expect(s12(dayInput(events))).toEqual({
      status: 'pass',
      reason: 'ticks-within-budget',
      totalTicks: events.length,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
  });

  it('pins the max-gap boundary: a hole of exactly the limit passes, the limit + 1 ms fails', () => {
    // OD7a3 fix round: builds the events array ITSELF — a full day of regular
    // one-minute ticks with exactly ONE hole — so the S12 verdict is pinned to
    // the millisecond on both sides of `SHADOW_MAX_TICK_GAP_MS`. Changing the
    // limit by even 1 ms in either direction fails one of the two assertions.
    const gapStartOffset = 540 * 60_000;
    const dayWithOneGap = (gapMs: number): Record<string, unknown>[] => {
      // Ticks every minute up to and including the last before the hole, then
      // the first tick AFTER the hole, then every minute to 23:59Z. The single
      // consecutive gap is exactly `gapMs`.
      const gapEndOffset = gapStartOffset + gapMs;
      const offsets: number[] = [];
      for (let offset = 0; offset <= gapStartOffset; offset += 60_000) offsets.push(offset);
      for (let offset = gapEndOffset; offset < 86_400_000; offset += 60_000) offsets.push(offset);
      return offsets.map((offset, index) => jobEvent({
        eventId: eventId(index + 1),
        tickId: tickId(index + 1),
        recordedAtIso: isoAtOffsetMs(offset),
      }));
    };

    // (a) A gap of EXACTLY `SHADOW_MAX_TICK_GAP_MS` passes.
    const exact = dayWithOneGap(SHADOW_MAX_TICK_GAP_MS);
    // Sanity: the hole is the single consecutive-pair concern — the last
    // pre-gap tick (index 540) and the first post-gap tick (index 541) are
    // exactly `gapMs` apart.
    expect(Date.parse((exact[541] as { recordedAtIso: string }).recordedAtIso) - Date.parse((exact[540] as { recordedAtIso: string }).recordedAtIso)).toBe(SHADOW_MAX_TICK_GAP_MS);
    expect(s12(dayInput(exact))).toEqual({
      status: 'pass',
      reason: 'ticks-within-budget',
      totalTicks: exact.length,
      budgetOverruns: 0,
      starvedJobs: 0,
    });

    // (b) A gap of the limit + 1 ms fails with `coverage-gap`.
    const beyond = dayWithOneGap(SHADOW_MAX_TICK_GAP_MS + 1);
    expect(Date.parse((beyond[541] as { recordedAtIso: string }).recordedAtIso) - Date.parse((beyond[540] as { recordedAtIso: string }).recordedAtIso)).toBe(SHADOW_MAX_TICK_GAP_MS + 1);
    expect(s12(dayInput(beyond))).toEqual({
      status: 'fail',
      reason: 'coverage-gap',
      totalTicks: beyond.length,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
  });
});

function journalEntry(key: string, kind: string, outcome: string | null, recordedAtIso: string): Record<string, unknown> {
  return { key, kind, outcome, recordedAtIso };
}

/** A `conduct` entry, as the real journal shapes it: no key, no outcome. */
function conductEntry(recordedAtIso: string): Record<string, unknown> {
  return { key: null, kind: 'conduct', outcome: null, recordedAtIso };
}

function stateInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stateCheck: { checked: 5, bad: 0 },
    journal: [],
    sampledAtIso: SAMPLE_AT,
    ...overrides,
  };
}

/** Every S9 count. Early refusals expect this set unchanged. */
const S9_ZERO = {
  stateChecked: 0,
  stateBad: 0,
  journalKeys: 0,
  duplicateIntents: 0,
  duplicateResults: 0,
  resultsAfterFinal: 0,
  orphanResults: 0,
  unreconciledIntents: 0,
};

/** A full S9 evaluation: `counts` overrides `S9_ZERO`, and `toEqual` sees all eight. */
function s9Eval(
  status: 'pass' | 'fail' | 'unknown',
  reason: string,
  counts: Partial<typeof S9_ZERO> = {},
): { status: 'pass' | 'fail' | 'unknown'; reason: string } & typeof S9_ZERO {
  return { status, reason, ...S9_ZERO, ...counts };
}

describe('evaluateShadowStateIntegrity (S9)', () => {
  it('passes a fully clean day', () => {
    expect(evaluateShadowStateIntegrity(stateInput())).toEqual(
      s9Eval('pass', 'state-consistent', { stateChecked: 5 }),
    );
  });

  it('an own symbol key on journal is invalid-input (Object.keys used to ignore it)', () => {
    const journal = [journalEntry('lane:k1', 'intent', null, SAMPLE_AT)];
    Object.defineProperty(journal, Symbol('extra'), { value: 1, enumerable: true });
    expect(evaluateShadowStateIntegrity(stateInput({ journal }))).toEqual(
      s9Eval('unknown', 'invalid-input'),
    );
  });

  it('a non-enumerable extra own key on journal is invalid-input (Object.keys used to ignore it)', () => {
    const journal = [journalEntry('lane:k1', 'intent', null, SAMPLE_AT)];
    Object.defineProperty(journal, 'extra', { value: 1, enumerable: false });
    expect(evaluateShadowStateIntegrity(stateInput({ journal }))).toEqual(
      s9Eval('unknown', 'invalid-input'),
    );
  });

  it('an accessor element refuses the whole journal list before any entry reader runs', () => {
    let calls = 0;
    const accessorList: unknown[] = [];
    Object.defineProperty(accessorList, 0, {
      enumerable: true,
      get() {
        calls += 1;
        return journalEntry('lane:k1', 'intent', null, SAMPLE_AT);
      },
    });
    accessorList.length = 1;
    expect(evaluateShadowStateIntegrity(stateInput({ journal: accessorList }))).toEqual(
      s9Eval('unknown', 'invalid-input'),
    );
    expect(calls).toBe(0);
  });

  it('#4ac: a malformed journal entry wins invalid-input over state-check-failed (bad: 1)', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      stateCheck: { checked: 5, bad: 1 },
      journal: [{ kind: 'intent', recordedAtIso: SAMPLE_AT }],
    }))).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it('#4ac: a non-array journal wins invalid-input over state-check-failed (bad: 1)', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      stateCheck: { checked: 5, bad: 1 },
      journal: 'nope',
    }))).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it('#4ac: a journal over SHADOW_MAX_HEALTH_ITEMS wins invalid-input over state-check-failed (bad: 1)', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      stateCheck: { checked: 5, bad: 1 },
      journal: Array.from({ length: SHADOW_MAX_HEALTH_ITEMS + 1 }, () => journalEntry('lane:k1', 'intent', null, SAMPLE_AT)),
    }))).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it('#4ac: a bad sampledAtIso wins invalid-input over state-check-failed (bad: 1)', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      stateCheck: { checked: 5, bad: 1 },
      sampledAtIso: 'not-a-date',
    }))).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it('#4ac: a malformed journal entry wins invalid-input over state-check-unavailable (stateCheck: null)', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      stateCheck: null,
      journal: [{ kind: 'intent', recordedAtIso: SAMPLE_AT }],
    }))).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it('#4ac: a bad sampledAtIso wins invalid-input over state-check-unavailable (stateCheck: null)', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      stateCheck: null,
      sampledAtIso: 'not-a-date',
    }))).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it('#4ac: a malformed journal entry wins invalid-input over state-check-unavailable (checked: 0)', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      stateCheck: { checked: 0, bad: 0 },
      journal: [{ kind: 'intent', recordedAtIso: SAMPLE_AT }],
    }))).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it('#4ac: a bad sampledAtIso wins invalid-input over state-check-unavailable (checked: 0)', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      stateCheck: { checked: 0, bad: 0 },
      sampledAtIso: 'not-a-date',
    }))).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it('#4ac: invalid stateCheck counts refuse as invalid-input even with checked: 0', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      stateCheck: { checked: 0, bad: 'nope' },
    }))).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it('fails state-check-failed when stateCheck.bad is 1', () => {
    expect(evaluateShadowStateIntegrity(stateInput({ stateCheck: { checked: 5, bad: 1 } }))).toEqual(
      s9Eval('fail', 'state-check-failed', { stateChecked: 5, stateBad: 1 }),
    );
  });

  it('fails journal-duplicate-intent for a key with two intent entries', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry('k1', 'intent', null, PREV_23(50)),
        journalEntry('k1', 'intent', null, PREV_23(51)),
        journalEntry('k1', 'result', 'completed', PREV_23(52)),
      ],
    }))).toEqual(s9Eval('fail', 'journal-duplicate-intent', {
      stateChecked: 5,
      journalKeys: 1,
      duplicateIntents: 1,
    }));
  });

  it('reports unknown for a misspelled journal kind instead of silently ignoring it', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [journalEntry('k1', 'invent', 'completed', PREV_23(50))],
    }))).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it('reports unknown for an unrecognized journal outcome instead of silently ignoring it', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [journalEntry('k1', 'intent', 'finshed', PREV_23(50))],
    }))).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it('fails journal-orphan-result when a result appears before its matching intent', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry('k1', 'result', 'completed', PREV_23(51)),
        journalEntry('k1', 'intent', null, PREV_23(52)),
      ],
    }))).toEqual(s9Eval('fail', 'journal-orphan-result', {
      stateChecked: 5,
      journalKeys: 1,
      orphanResults: 1,
    }));
  });

  it('fails journal-orphan-result for a key with a result but no intent', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [journalEntry('k2', 'result', 'completed', PREV_23(50))],
    }))).toEqual(s9Eval('fail', 'journal-orphan-result', {
      stateChecked: 5,
      journalKeys: 1,
      orphanResults: 1,
    }));
  });

  it('fails journal-duplicate-result for a key with two non-ambiguous results', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry('k3', 'intent', null, PREV_23(50)),
        journalEntry('k3', 'result', 'completed', PREV_23(51)),
        journalEntry('k3', 'result', 'refused', PREV_23(52)),
      ],
    }))).toEqual(s9Eval('fail', 'journal-duplicate-result', {
      stateChecked: 5,
      journalKeys: 1,
      duplicateResults: 1,
      resultsAfterFinal: 1,
    }));
  });

  it('fails unreconciled-intent when an intent has been open for 16 minutes before the sample', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [journalEntry('k4', 'intent', null, '2026-11-10T23:44:00.000Z')],
    }))).toEqual(s9Eval('fail', 'unreconciled-intent', {
      stateChecked: 5,
      journalKeys: 1,
      unreconciledIntents: 1,
    }));
  });

  it('passes when an intent has been open for only 14 minutes', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [journalEntry('k5', 'intent', null, '2026-11-10T23:46:00.000Z')],
    }))).toEqual(s9Eval('pass', 'state-consistent', { stateChecked: 5, journalKeys: 1 }));
  });

  it('passes a lone operator stop intent open for 16 minutes: control keys are never pending', () => {
    // A stop intent legitimately never gets a matching result at all — the
    // real journal model (`lane-run-journal.ts`'s `pendingStepIntent`, and
    // its comment: "Control keys (stop, resume, request, reaper) are never
    // pending: they are not external actions.") never expects a result for
    // this key, so the open-intent grace deadline must not apply to it. An
    // operator stop is a normal, common action; without this exemption any
    // day where one happened more than 15 minutes before the sample would
    // wrongly fail S9 outright.
    const STOP_KEY = 'run-01JB0000000000000000000000/stop@web';
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [journalEntry(STOP_KEY, 'intent', null, '2026-11-10T23:44:00.000Z')],
    }))).toEqual(s9Eval('pass', 'state-consistent', { stateChecked: 5, journalKeys: 1 }));
  });

  it('passes when an ambiguous result is followed later by a real final result', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry('k6', 'intent', null, '2026-11-10T10:00:00.000Z'),
        journalEntry('k6', 'result', 'ambiguous', '2026-11-10T10:05:00.000Z'),
        journalEntry('k6', 'result', 'completed', '2026-11-10T10:10:00.000Z'),
      ],
    }))).toEqual(s9Eval('pass', 'state-consistent', { stateChecked: 5, journalKeys: 1 }));
  });

  it('accepts a null-outcome intent entry, as the real journal model shapes it, and evaluates it rather than refusing it as malformed', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry('k7', 'intent', null, PREV_23(50)),
        journalEntry('k7', 'intent', null, PREV_23(51)),
      ],
    }))).toEqual(s9Eval('fail', 'journal-duplicate-intent', {
      stateChecked: 5,
      journalKeys: 1,
      duplicateIntents: 1,
      unreconciledIntents: 1,
    }));
  });

  it('passes a key whose intent precedes both results in true append order even though the results\' timestamps are not in position order', () => {
    // A real journal never accepts a result before its key's intent — the
    // array's own POSITION is the only order the real store ever produces or
    // checks against. Here the array is in the one order the real journal
    // writer could have produced (intent, then the ambiguous result, then
    // the final result), but the timestamps attached to those same entries
    // are NOT monotonic with that position order (the intent's own clock
    // reading is latest, the ambiguous result's is earliest): a timestamp-
    // based evaluator would wrongly call the earliest result's timestamp
    // earlier than the intent's and fail this as an orphan result. The
    // evaluator must use position, not recordedAtIso, to get this right.
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry('k8', 'intent', null, '2026-11-10T09:10:00.000Z'),
        journalEntry('k8', 'result', 'ambiguous', '2026-11-10T09:00:00.000Z'),
        journalEntry('k8', 'result', 'completed', '2026-11-10T09:05:00.000Z'),
      ],
    }))).toEqual(s9Eval('pass', 'state-consistent', { stateChecked: 5, journalKeys: 1 }));
  });

  it('fails journal-result-after-final when a completed result and a later ambiguous result share one timestamp, in real append order', () => {
    // The real journal store's `resultRefusal` is decided from append order
    // alone, never from `recordedAtIso`: two entries can carry the exact
    // same timestamp. Here the completed (closing) result is appended
    // before the ambiguous result, at the same recorded timestamp — a
    // timestamp-only comparison (`latestResultIso > finalResultIso`) cannot
    // tell them apart and would wrongly pass this; position can.
    const sameIso = '2026-11-10T09:20:00.000Z';
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry('k12', 'intent', null, PREV_23(50)),
        journalEntry('k12', 'result', 'completed', sameIso),
        journalEntry('k12', 'result', 'ambiguous', sameIso),
      ],
    }))).toEqual(s9Eval('fail', 'journal-result-after-final', {
      stateChecked: 5,
      journalKeys: 1,
      resultsAfterFinal: 1,
    }));
  });

  it('accepts a normal conduct entry (key null, outcome null) and excludes it from tallying, evaluating the rest normally', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        conductEntry(PREV_23(40)),
        journalEntry('k9', 'intent', null, PREV_23(50)),
        journalEntry('k9', 'result', 'completed', PREV_23(51)),
      ],
    }))).toEqual(s9Eval('pass', 'state-consistent', { stateChecked: 5, journalKeys: 1 }));
  });

  it('fails journal-result-after-final when an ambiguous result is recorded after the key\'s final result', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry('k10', 'intent', null, PREV_23(50)),
        journalEntry('k10', 'result', 'completed', PREV_23(51)),
        journalEntry('k10', 'result', 'ambiguous', PREV_23(52)),
      ],
    }))).toEqual(s9Eval('fail', 'journal-result-after-final', {
      stateChecked: 5,
      journalKeys: 1,
      resultsAfterFinal: 1,
    }));
  });

  it('passes a not-started result on a request-channel key followed by a later final result', () => {
    // The request channel (O2c, lane-run-journal.ts's `isClosedByFinalResult`)
    // treats `not-started` as non-final: it never moves the request, so the
    // real journal writer still accepts a later final result for the same
    // key. REQUEST_KEY below is a real `request/<ULID>` key, the same shape
    // `parseLaneRunKey` and the writer both require.
    const REQUEST_KEY = 'request/01JB0000000000000000000000';
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry(REQUEST_KEY, 'intent', null, PREV_23(50)),
        journalEntry(REQUEST_KEY, 'result', 'not-started', PREV_23(51)),
        journalEntry(REQUEST_KEY, 'result', 'completed', PREV_23(52)),
      ],
    }))).toEqual(s9Eval('pass', 'state-consistent', { stateChecked: 5, journalKeys: 1 }));
  });

  it('passes a request-channel key whose only result is not-started, 16 minutes old: reconciled, not an open intent', () => {
    // A `not-started` result on the request channel does not close the key
    // (`isFinalResultEntry` above, matching the real writer's
    // `isClosedByFinalResult`), so `finalResults` stays 0 for it — but a
    // request-channel key is a control key (`isControlKeyKind`) and is
    // exempt from the open-intent grace check regardless, so this must not
    // be flagged as an open, unresolved intent.
    const REQUEST_KEY = 'request/01JB0000000000000000000001';
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry(REQUEST_KEY, 'intent', null, '2026-11-10T23:44:00.000Z'),
        journalEntry(REQUEST_KEY, 'result', 'not-started', '2026-11-10T23:45:00.000Z'),
      ],
    }))).toEqual(s9Eval('pass', 'state-consistent', { stateChecked: 5, journalKeys: 1 }));
  });

  it('fails for a not-started result on a non-request key followed by a later result (the carve-out is request-channel only)', () => {
    // The carve-out above is specific to the request channel: on every other
    // key kind, `not-started` closes the key exactly like any other
    // non-`ambiguous` outcome. Both results here count as closing, so this
    // is caught as two closing results for one key, the same as any other
    // duplicate-final case.
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry('k11', 'intent', null, PREV_23(50)),
        journalEntry('k11', 'result', 'not-started', PREV_23(51)),
        journalEntry('k11', 'result', 'completed', PREV_23(52)),
      ],
    }))).toEqual(s9Eval('fail', 'journal-duplicate-result', {
      stateChecked: 5,
      journalKeys: 1,
      duplicateResults: 1,
      resultsAfterFinal: 1,
    }));
  });

  it('reports unknown/state-check-unavailable when stateCheck is null', () => {
    expect(evaluateShadowStateIntegrity(stateInput({ stateCheck: null }))).toEqual(
      s9Eval('unknown', 'state-check-unavailable'),
    );
  });

  it('reports unknown/state-check-unavailable when no stores were checked', () => {
    expect(evaluateShadowStateIntegrity(stateInput({ stateCheck: { checked: 0, bad: 0 } }))).toEqual(
      s9Eval('unknown', 'state-check-unavailable'),
    );
  });

  it('is not satisfiable by a constant verdict: clean and failing journals differ', () => {
    const clean = evaluateShadowStateIntegrity(stateInput());
    const failing = evaluateShadowStateIntegrity(stateInput({ stateCheck: { checked: 5, bad: 1 } }));
    expect(clean).toEqual(s9Eval('pass', 'state-consistent', { stateChecked: 5 }));
    expect(failing).toEqual(s9Eval('fail', 'state-check-failed', { stateChecked: 5, stateBad: 1 }));
  });

  it('never echoes its input', () => {
    const input = stateInput();
    const result = evaluateShadowStateIntegrity(input) as unknown as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual([
      'duplicateIntents',
      'duplicateResults',
      'journalKeys',
      'orphanResults',
      'reason',
      'resultsAfterFinal',
      'stateBad',
      'stateChecked',
      'status',
      'unreconciledIntents',
    ]);
    expect(result).not.toHaveProperty('journal');
    expect(result).not.toHaveProperty('stateCheck');
    expect(result).not.toHaveProperty('sampledAtIso');
  });

  it('two pass/state-consistent inputs with different stateChecked or journalKeys carry different counts', () => {
    const empty = evaluateShadowStateIntegrity(stateInput());
    const moreChecked = evaluateShadowStateIntegrity(stateInput({ stateCheck: { checked: 10, bad: 0 } }));
    const withKey = evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry('k', 'intent', null, PREV_23(50)),
        journalEntry('k', 'result', 'completed', PREV_23(51)),
      ],
    }));
    expect(empty).toEqual(s9Eval('pass', 'state-consistent', { stateChecked: 5 }));
    expect(moreChecked).toEqual(s9Eval('pass', 'state-consistent', { stateChecked: 10 }));
    expect(withKey).toEqual(s9Eval('pass', 'state-consistent', { stateChecked: 5, journalKeys: 1 }));
    expect(empty.stateChecked).not.toBe(moreChecked.stateChecked);
    expect(empty.journalKeys).not.toBe(withKey.journalKeys);
  });

  it('two fail/journal-duplicate-intent inputs with different anomaly counts carry different counts', () => {
    const oneKey = [
      journalEntry('k1', 'intent', null, '2026-11-10T23:50:00.000Z'),
      journalEntry('k1', 'intent', null, '2026-11-10T23:51:00.000Z'),
      journalEntry('k1', 'result', 'completed', '2026-11-10T23:52:00.000Z'),
    ];
    const twoKeys = [
      ...oneKey,
      journalEntry('k2', 'intent', null, '2026-11-10T23:50:00.000Z'),
      journalEntry('k2', 'intent', null, '2026-11-10T23:51:00.000Z'),
      journalEntry('k2', 'result', 'completed', '2026-11-10T23:52:00.000Z'),
    ];
    const one = evaluateShadowStateIntegrity(stateInput({ journal: oneKey }));
    const two = evaluateShadowStateIntegrity(stateInput({ journal: twoKeys }));
    expect(one).toEqual(s9Eval('fail', 'journal-duplicate-intent', {
      stateChecked: 5,
      journalKeys: 1,
      duplicateIntents: 1,
    }));
    expect(two).toEqual(s9Eval('fail', 'journal-duplicate-intent', {
      stateChecked: 5,
      journalKeys: 2,
      duplicateIntents: 2,
    }));
    expect(one.duplicateIntents).not.toBe(two.duplicateIntents);
  });

  it('counts every anomaly across keys independently and keeps the first failing tally reason in map and check order', () => {
    // k-open is inserted first, so a single pass that treated unreconciled-intent
    // as just another per-key check would name it the reason. Loop 1 runs first
    // and finds k-dup's duplicate intent, so that reason wins while every other
    // anomaly is still counted.
    const result = evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry('k-open', 'intent', null, '2026-11-10T23:44:00.000Z'),
        journalEntry('k-dup', 'intent', null, '2026-11-10T23:50:00.000Z'),
        journalEntry('k-dup', 'intent', null, '2026-11-10T23:51:00.000Z'),
        journalEntry('k-dup', 'result', 'completed', '2026-11-10T23:52:00.000Z'),
        journalEntry('k-dup-result', 'intent', null, '2026-11-10T23:40:00.000Z'),
        journalEntry('k-dup-result', 'result', 'completed', '2026-11-10T23:41:00.000Z'),
        journalEntry('k-dup-result', 'result', 'refused', '2026-11-10T23:42:00.000Z'),
        journalEntry('k-after', 'intent', null, '2026-11-10T23:30:00.000Z'),
        journalEntry('k-after', 'result', 'completed', '2026-11-10T23:31:00.000Z'),
        journalEntry('k-after', 'result', 'ambiguous', '2026-11-10T23:32:00.000Z'),
        journalEntry('k-orphan', 'result', 'completed', '2026-11-10T23:20:00.000Z'),
      ],
    }));
    expect(result).toEqual(s9Eval('fail', 'journal-duplicate-intent', {
      stateChecked: 5,
      journalKeys: 5,
      duplicateIntents: 1,
      duplicateResults: 1,
      resultsAfterFinal: 2,
      orphanResults: 1,
      unreconciledIntents: 1,
    }));
  });

  it('returns all-zero counts for invalid-input and state-check-unavailable', () => {
    expect(evaluateShadowStateIntegrity(null)).toEqual(s9Eval('unknown', 'invalid-input'));
    expect(evaluateShadowStateIntegrity(undefined)).toEqual(s9Eval('unknown', 'invalid-input'));
    expect(evaluateShadowStateIntegrity(stateInput({ stateCheck: null }))).toEqual(
      s9Eval('unknown', 'state-check-unavailable'),
    );
    expect(evaluateShadowStateIntegrity(stateInput({ stateCheck: { checked: 0, bad: 0 } }))).toEqual(
      s9Eval('unknown', 'state-check-unavailable'),
    );
  });

  it('S9 refuses: a prototype-polluting prototype key', () => {
    const input = JSON.parse(
      `{"prototype": 1, "stateCheck": {"checked": 1, "bad": 0}, "journal": [], "sampledAtIso": "${SAMPLE_AT}"}`,
    );
    expect(evaluateShadowStateIntegrity(input)).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it('a key with both a duplicate intent and a duplicate result fails as journal-duplicate-intent', () => {
    // Pins tallySequenceReason's order: duplicate-intent is checked before
    // duplicate-result. Both anomalies are present on this one key, so
    // reversing those two checks would name journal-duplicate-result.
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry('k', 'intent', null, PREV_23(50)),
        journalEntry('k', 'intent', null, PREV_23(51)),
        journalEntry('k', 'result', 'completed', PREV_23(52)),
        journalEntry('k', 'result', 'refused', PREV_23(53)),
      ],
    }))).toEqual(s9Eval('fail', 'journal-duplicate-intent', {
      stateChecked: 5,
      journalKeys: 1,
      duplicateIntents: 1,
      duplicateResults: 1,
      resultsAfterFinal: 1,
    }));
  });

  it('a key with both a duplicate result and a result-after-final fails as journal-duplicate-result', () => {
    // Pins tallySequenceReason's order: duplicate-result is checked before
    // result-after-final. Reversing those two checks would name
    // journal-result-after-final while both counts stay 1.
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry('k', 'intent', null, PREV_23(50)),
        journalEntry('k', 'result', 'completed', PREV_23(51)),
        journalEntry('k', 'result', 'refused', PREV_23(52)),
      ],
    }))).toEqual(s9Eval('fail', 'journal-duplicate-result', {
      stateChecked: 5,
      journalKeys: 1,
      duplicateResults: 1,
      resultsAfterFinal: 1,
    }));
  });

  it('a key with both an orphan result and a duplicate result fails as journal-duplicate-result', () => {
    // Pins tallySequenceReason's order: duplicate-result is checked before
    // orphan-result. The result appended before the intent is an orphan, and
    // the second closing result is a duplicate; checking the orphan first
    // would name journal-orphan-result.
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry('k', 'result', 'completed', PREV_23(50)),
        journalEntry('k', 'intent', null, PREV_23(51)),
        journalEntry('k', 'result', 'refused', PREV_23(52)),
      ],
    }))).toEqual(s9Eval('fail', 'journal-duplicate-result', {
      stateChecked: 5,
      journalKeys: 1,
      duplicateResults: 1,
      resultsAfterFinal: 1,
      orphanResults: 1,
    }));
  });

  it('a key with both an orphan result and a result-after-final fails as journal-result-after-final', () => {
    // Pins tallySequenceReason's order: result-after-final is checked before
    // orphan-result. One closing result followed by an ambiguous result is
    // not a duplicate result, so the orphan is the only other candidate;
    // checking it first would name journal-orphan-result.
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry('k', 'result', 'completed', PREV_23(50)),
        journalEntry('k', 'intent', null, PREV_23(51)),
        journalEntry('k', 'result', 'ambiguous', PREV_23(52)),
      ],
    }))).toEqual(s9Eval('fail', 'journal-result-after-final', {
      stateChecked: 5,
      journalKeys: 1,
      duplicateResults: 0,
      resultsAfterFinal: 1,
      orphanResults: 1,
    }));
  });

  it('counts one key that is both a duplicate intent and an orphan in both counts', () => {
    // Pins suppression of one count by the other. The result precedes both
    // intents, so the key is an orphan and, with two intents, a duplicate
    // intent. Dropping either predicate when the other matches would leave
    // that count at 0.
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry('k', 'result', 'completed', PREV_23(50)),
        journalEntry('k', 'intent', null, PREV_23(51)),
        journalEntry('k', 'intent', null, PREV_23(52)),
      ],
    }))).toEqual(s9Eval('fail', 'journal-duplicate-intent', {
      stateChecked: 5,
      journalKeys: 1,
      duplicateIntents: 1,
      orphanResults: 1,
    }));
  });

  it('does not flag an open intent exactly one grace window old, and does flag one 1 ms older', () => {
    // Pins `>` versus `>=` in isPastOpenIntentGrace. The sample is taken
    // exactly SHADOW_OPEN_INTENT_GRACE_MS after the intent, which is not yet
    // past, and one millisecond later, which is.
    const exactly = '2026-11-10T23:45:00.000Z';
    const pastByOneMs = '2026-11-10T23:44:59.999Z';
    expect(Date.parse(SAMPLE_AT) - Date.parse(exactly)).toBe(SHADOW_OPEN_INTENT_GRACE_MS);
    expect(Date.parse(SAMPLE_AT) - Date.parse(pastByOneMs)).toBe(SHADOW_OPEN_INTENT_GRACE_MS + 1);
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [journalEntry('k-grace', 'intent', null, exactly)],
    }))).toEqual(s9Eval('pass', 'state-consistent', { stateChecked: 5, journalKeys: 1 }));
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [journalEntry('k-grace', 'intent', null, pastByOneMs)],
    }))).toEqual(s9Eval('fail', 'unreconciled-intent', {
      stateChecked: 5,
      journalKeys: 1,
      unreconciledIntents: 1,
    }));
  });

  it.each([
    ['checked', -1],
    ['checked', 1.5],
    ['checked', Number.MAX_SAFE_INTEGER + 1],
    ['bad', -1],
    ['bad', 1.5],
    ['bad', Number.MAX_SAFE_INTEGER + 1],
  ] as const)(
    'S9 refuses stateCheck.%s=%s the same as a wrong-typed count',
    (field, value) => {
      // Pins isCount's range: a negative, a non-integer (1.5) and a value
      // above Number.MAX_SAFE_INTEGER are each refused with the same
      // unknown/invalid-input zeros as a string where a count is due.
      const stateCheck = { checked: 5, bad: 0, [field]: value };
      const refused = evaluateShadowStateIntegrity(stateInput({ stateCheck }));
      const wrongTyped = evaluateShadowStateIntegrity(stateInput({
        stateCheck: { checked: 'many', bad: 0 },
      }));
      expect(wrongTyped).toEqual(s9Eval('unknown', 'invalid-input'));
      expect(refused).toEqual(wrongTyped);
    },
  );
});

describe('evaluateShadowStateIntegrity (S9) day scoping', () => {
  it('counts only entries whose instants fall inside [D, D+1), mapped through Date.parse', () => {
    const result = evaluateShadowStateIntegrity(stateInput({
      day: DAY,
      journal: [
        // Inside: the inclusive start boundary D 00:00:00.000Z.
        journalEntry('k-start', 'intent', null, `${DAY}T00:00:00.000Z`),
        journalEntry('k-start', 'result', 'completed', `${DAY}T00:01:00.000Z`),
        // Outside: the day before D.
        journalEntry('k-before', 'intent', null, PREV_23(50)),
        journalEntry('k-before', 'result', 'completed', PREV_23(51)),
        // Outside: the exclusive end boundary D+1 00:00:00.000Z.
        journalEntry('k-after', 'intent', null, '2026-11-11T00:00:00.000Z'),
        journalEntry('k-after', 'result', 'completed', '2026-11-11T00:00:30.000Z'),
        // Inside: a non-UTC offset (`2026-11-09T23:30:00-02:00` is D 01:30Z).
        journalEntry('k-offset', 'intent', null, '2026-11-09T23:30:00-02:00'),
        journalEntry('k-offset', 'result', 'completed', '2026-11-09T23:40:00-02:00'),
      ],
    }));
    expect(result).toEqual(s9Eval('pass', 'state-consistent', {
      stateChecked: 5,
      journalKeys: 2,
    }));
  });

  it('counts a D-1 intent closed by a D result as one day-touching key with no orphan result', () => {
    const result = evaluateShadowStateIntegrity(stateInput({
      day: DAY,
      journal: [
        journalEntry('k-cross', 'intent', null, '2026-11-09T23:59:00.000Z'),
        journalEntry('k-cross', 'result', 'completed', `${DAY}T00:00:30.000Z`),
      ],
    }));
    expect(result).toEqual(s9Eval('pass', 'state-consistent', {
      stateChecked: 5,
      journalKeys: 1,
      orphanResults: 0,
    }));
  });

  it('stays pass for an intent at D 23:59 closed at D+1 00:01, and a D+1 append does not change the counts', () => {
    const base = {
      day: DAY,
      sampledAtIso: '2026-11-11T12:00:00.000Z',
    };
    const first = evaluateShadowStateIntegrity(stateInput({
      ...base,
      journal: [
        journalEntry('k-late', 'intent', null, `${DAY}T23:59:00.000Z`),
        journalEntry('k-late', 'result', 'completed', '2026-11-11T00:01:00.000Z'),
      ],
    }));
    expect(first).toEqual(s9Eval('pass', 'state-consistent', {
      stateChecked: 5,
      journalKeys: 1,
      unreconciledIntents: 0,
    }));
    const second = evaluateShadowStateIntegrity(stateInput({
      ...base,
      journal: [
        journalEntry('k-late', 'intent', null, `${DAY}T23:59:00.000Z`),
        journalEntry('k-late', 'result', 'completed', '2026-11-11T00:01:00.000Z'),
        journalEntry('k-late', 'result', 'ambiguous', '2026-11-11T02:00:00.000Z'),
      ],
    }));
    expect(second).toEqual(first);
  });

  it('still fails a stale open intent dated D-2 with unreconciled-intent even with day: D (unscoped grace check)', () => {
    const result = evaluateShadowStateIntegrity(stateInput({
      day: DAY,
      journal: [journalEntry('k-stale', 'intent', null, '2026-11-08T10:00:00.000Z')],
    }));
    expect(result).toEqual(s9Eval('fail', 'unreconciled-intent', {
      stateChecked: 5,
      journalKeys: 0,
      unreconciledIntents: 1,
    }));
  });

  it('refuses a malformed entry (a bad kind) dated outside D with invalid-input', () => {
    const result = evaluateShadowStateIntegrity(stateInput({
      day: DAY,
      journal: [{ key: 'k-bad', kind: 'nope', outcome: null, recordedAtIso: '2026-11-08T10:00:00.000Z' }],
    }));
    expect(result).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it('excludes an entry at exactly D+1 00:00:00.000Z from the scoped tallies, leaving every count unchanged', () => {
    const dayEntries = [
      journalEntry('k', 'intent', null, `${DAY}T01:00:00.000Z`),
      journalEntry('k', 'result', 'completed', `${DAY}T01:01:00.000Z`),
    ];
    const withoutBoundary = evaluateShadowStateIntegrity(stateInput({ day: DAY, journal: dayEntries }));
    const withBoundary = evaluateShadowStateIntegrity(stateInput({
      day: DAY,
      journal: [
        ...dayEntries,
        // A duplicate intent at exactly dayEndMs. A `<=` end comparison would
        // pull it into the scoped tally and flip the verdict to
        // journal-duplicate-intent; the half-open interval excludes it.
        journalEntry('k', 'intent', null, '2026-11-11T00:00:00.000Z'),
      ],
    }));
    expect(withoutBoundary).toEqual(s9Eval('pass', 'state-consistent', {
      stateChecked: 5,
      journalKeys: 1,
    }));
    expect(withBoundary).toEqual(withoutBoundary);
  });

  it('counts a duplicate-intent key instanced at D+1T00:30:00+02:00, inside D as an instant but outside as a string', () => {
    const result = evaluateShadowStateIntegrity(stateInput({
      day: DAY,
      journal: [
        // 2026-11-10T22:30:00Z / 22:40Z / 22:50Z: inside [D, D+1) as
        // instants. A string-prefix comparison would read these as D+1 and
        // exclude both the key and its anomaly.
        journalEntry('k-offset', 'intent', null, '2026-11-11T00:30:00+02:00'),
        journalEntry('k-offset', 'intent', null, '2026-11-11T00:40:00+02:00'),
        journalEntry('k-offset', 'result', 'completed', '2026-11-11T00:50:00+02:00'),
      ],
    }));
    // The touches-day test: journalKeys counts the key. The scoped-entries
    // filter: the duplicate intent is tallied and names the reason.
    expect(result).toEqual(s9Eval('fail', 'journal-duplicate-intent', {
      stateChecked: 5,
      journalKeys: 1,
      duplicateIntents: 1,
    }));
  });

  it('does not count a duplicate-intent key instanced at DT23:30:00-02:00, outside D as an instant but inside as a string', () => {
    const result = evaluateShadowStateIntegrity(stateInput({
      day: DAY,
      journal: [
        // 2026-11-11T01:30:00Z / 01:40Z / 01:50Z: outside [D, D+1) as
        // instants. A string-prefix comparison would read these as inside D
        // and count both the key and its anomaly.
        journalEntry('k-offset', 'intent', null, '2026-11-10T23:30:00-02:00'),
        journalEntry('k-offset', 'intent', null, '2026-11-10T23:40:00-02:00'),
        journalEntry('k-offset', 'result', 'completed', '2026-11-10T23:50:00-02:00'),
      ],
    }));
    // Neither the touches-day test (journalKeys stays 0) nor the
    // scoped-entries filter (no anomaly tallied) sees the key.
    expect(result).toEqual(s9Eval('pass', 'state-consistent', {
      stateChecked: 5,
      journalKeys: 0,
      duplicateIntents: 0,
    }));
  });

  it('excludes keys whose duplicate-intent sequences lie entirely before D or entirely at or after D+1', () => {
    const dupSeq = (key: string, at: (minute: number) => string) => [
      journalEntry(key, 'intent', null, at(0)),
      journalEntry(key, 'intent', null, at(1)),
      journalEntry(key, 'result', 'completed', at(2)),
    ];
    const result = evaluateShadowStateIntegrity(stateInput({
      day: DAY,
      journal: [
        // Exists only before D: a duplicate-intent sequence entirely on D-1.
        ...dupSeq('k-before', (minute) => `2026-11-09T2${minute}:00:00.000Z`),
        // Exists only at or after D+1: a duplicate-intent sequence entirely
        // on D+1.
        ...dupSeq('k-after', (minute) => `2026-11-11T0${minute}:00:00.000Z`),
      ],
    }));
    expect(result).toEqual(s9Eval('pass', 'state-consistent', {
      stateChecked: 5,
      journalKeys: 0,
      duplicateIntents: 0,
      duplicateResults: 0,
      resultsAfterFinal: 0,
      orphanResults: 0,
    }));
  });

  it('is not satisfiable by a constant verdict under day scoping either', () => {
    const clean = evaluateShadowStateIntegrity(stateInput({
      day: DAY,
      journal: [
        journalEntry('k', 'intent', null, `${DAY}T01:00:00.000Z`),
        journalEntry('k', 'result', 'completed', `${DAY}T01:01:00.000Z`),
      ],
    }));
    const duplicated = evaluateShadowStateIntegrity(stateInput({
      day: DAY,
      journal: [
        journalEntry('k', 'intent', null, `${DAY}T01:00:00.000Z`),
        journalEntry('k', 'intent', null, `${DAY}T01:02:00.000Z`),
        journalEntry('k', 'result', 'completed', `${DAY}T01:03:00.000Z`),
      ],
    }));
    expect(clean).toEqual(s9Eval('pass', 'state-consistent', { stateChecked: 5, journalKeys: 1 }));
    expect(duplicated).toEqual(s9Eval('fail', 'journal-duplicate-intent', {
      stateChecked: 5,
      journalKeys: 1,
      duplicateIntents: 1,
    }));
  });
});

describe('evaluateShadowStateIntegrity (S9) hostile day input', () => {
  it('S9 refuses a present day: null — a present day key must carry a valid day, null is not absence', () => {
    expect(evaluateShadowStateIntegrity(stateInput({ day: null }))).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it('S9 refuses a present day: undefined under a present day key', () => {
    const input: Record<string, unknown> = stateInput();
    input.day = undefined;
    expect(evaluateShadowStateIntegrity(input)).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it('S9 refuses a day: 42 (a number where a string is due)', () => {
    expect(evaluateShadowStateIntegrity(stateInput({ day: 42 }))).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it("S9 refuses an impossible calendar day '2026-02-30'", () => {
    expect(evaluateShadowStateIntegrity(stateInput({ day: '2026-02-30' }))).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it("S9 refuses a full timestamp where a day is due: '2026-11-16T00:00:00Z'", () => {
    expect(evaluateShadowStateIntegrity(stateInput({ day: '2026-11-16T00:00:00Z' }))).toEqual(
      s9Eval('unknown', 'invalid-input'),
    );
  });

  it('S9 never runs an enumerable getter on day (SH10a)', () => {
    let calls = 0;
    const input: Record<string, unknown> = stateInput();
    Object.defineProperty(input, 'day', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return DAY;
      },
    });
    const result = evaluateShadowStateIntegrity(input);
    expect(calls).toBe(0);
    expect(result).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it('S9 over a Proxy root carrying day yields the plain result with no get trap (SH10a)', () => {
    const plain = stateInput({
      day: DAY,
      journal: [
        journalEntry('k', 'intent', null, `${DAY}T01:00:00.000Z`),
        journalEntry('k', 'result', 'completed', `${DAY}T01:01:00.000Z`),
      ],
    });
    let getTraps = 0;
    const proxy = new Proxy(plain, {
      get(target, key, receiver) {
        getTraps += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const expected = s9Eval('pass', 'state-consistent', { stateChecked: 5, journalKeys: 1 });
    expect(evaluateShadowStateIntegrity(plain)).toEqual(expected);
    expect(evaluateShadowStateIntegrity(proxy)).toEqual(expected);
    expect(getTraps).toBe(0);
  });
});

/** A built hostile input plus an optional getter-call probe. */
interface Hostile {
  readonly input: unknown;
  readonly calls?: () => number;
}

/**
 * The shared hostile-input battery: each case is built fresh for each
 * evaluator and the specific refusal code is asserted. Shapes whose refusal
 * is the events array report `daemon-events-invalid`; every other malformed
 * field reports `invalid-input`.
 */
function hostileCases(
  buildFor: (kind: HostileKind) => Hostile,
  listExpected: string,
): { title: string; hostile: Hostile; expected: string }[] {
  return [
    { title: 'null input', hostile: buildFor('null'), expected: 'invalid-input' },
    { title: 'undefined input', hostile: buildFor('undefined'), expected: 'invalid-input' },
    {
      title: 'a number where a string is due',
      hostile: buildFor('number-for-string'),
      expected: 'invalid-input',
    },
    {
      title: 'a string where a list is due',
      hostile: buildFor('string-for-list'),
      expected: listExpected,
    },
    {
      title: 'a non-iterable object where a list is due',
      hostile: buildFor('object-for-list'),
      expected: listExpected,
    },
    { title: 'an array hole', hostile: buildFor('hole'), expected: listExpected },
    { title: 'an array-like object', hostile: buildFor('array-like'), expected: listExpected },
    {
      title: 'an enormous sparse length refused before any traversal',
      hostile: buildFor('huge'),
      expected: listExpected,
    },
    {
      title: 'a dense list over the cost cap refused before any traversal',
      hostile: buildFor('over-cap'),
      expected: listExpected,
    },
    { title: 'a getter on the root never runs', hostile: buildFor('root-getter'), expected: 'invalid-input' },
    { title: 'a getter on an item never runs', hostile: buildFor('item-getter'), expected: listExpected },
    { title: 'a prototype-polluting __proto__ key', hostile: buildFor('proto'), expected: 'invalid-input' },
    { title: 'a prototype-polluting constructor key', hostile: buildFor('ctor'), expected: 'invalid-input' },
  ];
}

type HostileKind =
  | 'null'
  | 'undefined'
  | 'number-for-string'
  | 'string-for-list'
  | 'object-for-list'
  | 'hole'
  | 'array-like'
  | 'huge'
  | 'over-cap'
  | 'root-getter'
  | 'item-getter'
  | 'proto'
  | 'ctor';

function s12Hostile(kind: HostileKind): Hostile {
  const hole = (): unknown[] => {
    const array = [jobEvent(), jobEvent()];
    delete array[0];
    return array;
  };
  const huge = (): unknown[] => {
    const array: unknown[] = [];
    array[2 ** 32 - 2] = jobEvent();
    return array;
  };
  const getterOn = (key: 'day' | 'item'): Hostile => {
    if (key === 'day') {
      let calls = 0;
      const root: Record<string, unknown> = { events: [] };
      Object.defineProperty(root, 'day', {
        enumerable: true,
        get() {
          calls += 1;
          return DAY;
        },
      });
      return { input: root, calls: () => calls };
    }
    let calls = 0;
    const events: unknown[] = [];
    Object.defineProperty(events, '0', {
      enumerable: true,
      get() {
        calls += 1;
        return jobEvent();
      },
    });
    events.length = 1;
    return { input: { day: DAY, events }, calls: () => calls };
  };
  const polluted = (key: string): Hostile => {
    return {
      input: JSON.parse(`{"${key}": 1, "day": "${DAY}", "events": []}`),
    };
  };
  switch (kind) {
    case 'null':
      return { input: null };
    case 'undefined':
      return { input: undefined };
    case 'number-for-string':
      return { input: { day: 42, events: [] } };
    case 'string-for-list':
      return { input: { day: DAY, events: 'nope' } };
    case 'object-for-list':
      return { input: { day: DAY, events: {} } };
    case 'hole':
      return { input: { day: DAY, events: hole() } };
    case 'array-like':
      return { input: { day: DAY, events: { length: 1, 0: jobEvent() } } };
    case 'huge':
      return { input: { day: DAY, events: huge() } };
    case 'over-cap':
      return { input: { day: DAY, events: new Array(500_001).fill(jobEvent()) } };
    case 'root-getter':
      return getterOn('day');
    case 'item-getter':
      return getterOn('item');
    case 'proto':
      return polluted('__proto__');
    case 'ctor':
      return polluted('constructor');
  }
}

function s9Hostile(kind: HostileKind): Hostile {
  const hole = (): unknown[] => {
    const array = [journalEntry('k', 'intent', null, PREV_23(1)), journalEntry('k', 'result', 'completed', PREV_23(2))];
    delete array[0];
    return array;
  };
  const huge = (): unknown[] => {
    const array: unknown[] = [];
    array[2 ** 32 - 2] = journalEntry('k', 'intent', null, PREV_23(1));
    return array;
  };
  const getterOn = (key: 'sampledAtIso' | 'item'): Hostile => {
    if (key === 'sampledAtIso') {
      let calls = 0;
      const root: Record<string, unknown> = { stateCheck: { checked: 1, bad: 0 }, journal: [] };
      Object.defineProperty(root, 'sampledAtIso', {
        enumerable: true,
        get() {
          calls += 1;
          return SAMPLE_AT;
        },
      });
      return { input: root, calls: () => calls };
    }
    let calls = 0;
    const journal: unknown[] = [];
    Object.defineProperty(journal, '0', {
      enumerable: true,
      get() {
        calls += 1;
        return journalEntry('k', 'intent', null, PREV_23(1));
      },
    });
    journal.length = 1;
    return { input: { stateCheck: { checked: 1, bad: 0 }, journal, sampledAtIso: SAMPLE_AT }, calls: () => calls };
  };
  const polluted = (key: string): Hostile => {
    return {
      input: JSON.parse(`{"${key}": 1, "stateCheck": {"checked": 1, "bad": 0}, "journal": [], "sampledAtIso": "${SAMPLE_AT}"}`),
    };
  };
  switch (kind) {
    case 'null':
      return { input: null };
    case 'undefined':
      return { input: undefined };
    case 'number-for-string':
      return { input: { stateCheck: { checked: 'many', bad: 0 }, journal: [], sampledAtIso: SAMPLE_AT } };
    case 'string-for-list':
      return { input: { stateCheck: { checked: 1, bad: 0 }, journal: 'nope', sampledAtIso: SAMPLE_AT } };
    case 'object-for-list':
      return { input: { stateCheck: { checked: 1, bad: 0 }, journal: {}, sampledAtIso: SAMPLE_AT } };
    case 'hole':
      return { input: { stateCheck: { checked: 1, bad: 0 }, journal: hole(), sampledAtIso: SAMPLE_AT } };
    case 'array-like':
      return { input: { stateCheck: { checked: 1, bad: 0 }, journal: { length: 1, 0: journalEntry('k', 'intent', null, PREV_23(1)) }, sampledAtIso: SAMPLE_AT } };
    case 'huge':
      return { input: { stateCheck: { checked: 1, bad: 0 }, journal: huge(), sampledAtIso: SAMPLE_AT } };
    case 'over-cap':
      return { input: { stateCheck: { checked: 1, bad: 0 }, journal: new Array(500_001).fill(journalEntry('k', 'intent', null, PREV_23(1))), sampledAtIso: SAMPLE_AT } };
    case 'root-getter':
      return getterOn('sampledAtIso');
    case 'item-getter':
      return getterOn('item');
    case 'proto':
      return polluted('__proto__');
    case 'ctor':
      return polluted('constructor');
  }
}

describe('hostile input', () => {
  for (const [evaluate, label, build] of [
    [s12, 'S12', s12Hostile] as const,
    [evaluateShadowStateIntegrity, 'S9', s9Hostile] as const,
  ]) {
    for (const { title, hostile, expected } of hostileCases(build, label === 'S12' ? 'daemon-events-invalid' : 'invalid-input')) {
      it(`${label} refuses: ${title}`, () => {
        const result = evaluate(hostile.input);
        expect(result.status).toBe('unknown');
        expect(result.reason).toBe(expected);
        if (label === 'S12') {
          expect(result).toEqual({
            status: 'unknown',
            reason: expected,
            totalTicks: 0,
            budgetOverruns: 0,
            starvedJobs: 0,
          });
        }
        if (label === 'S9') {
          expect(result).toEqual(s9Eval('unknown', expected));
        }
        if (hostile.calls !== undefined) {
          expect(hostile.calls()).toBe(0);
        }
      });
    }
  }

  it('S12 over a Proxy of a valid input yields the plain result with no get trap', () => {
    const plain = dayInput(cleanDay(720));
    let getTraps = 0;
    const proxy = new Proxy(plain, {
      get(target, key, receiver) {
        getTraps += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(evaluateShadowTickHealth(proxy)).toEqual(evaluateShadowTickHealth(plain));
    expect(getTraps).toBe(0);
  });

  it('S9 over a Proxy of a valid input yields the plain result with no get trap', () => {
    const plain = stateInput({
      journal: [journalEntry('k', 'intent', null, PREV_23(59))],
    });
    let getTraps = 0;
    const proxy = new Proxy(plain, {
      get(target, key, receiver) {
        getTraps += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const expected = s9Eval('fail', 'unreconciled-intent', {
      stateChecked: 5,
      journalKeys: 1,
      unreconciledIntents: 1,
    });
    expect(evaluateShadowStateIntegrity(plain)).toEqual(expected);
    expect(evaluateShadowStateIntegrity(proxy)).toEqual(expected);
    expect(getTraps).toBe(0);
  });

  it('S12 refuses a revoked Proxy instead of throwing', () => {
    const { proxy, revoke } = Proxy.revocable(dayInput(cleanDay(720)), {});
    revoke();
    expect(evaluateShadowTickHealth(proxy)).toEqual({
      status: 'unknown',
      reason: 'invalid-input',
      totalTicks: 0,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
  });

  it('S9 refuses a revoked Proxy instead of throwing', () => {
    const { proxy, revoke } = Proxy.revocable(stateInput({}), {});
    revoke();
    expect(evaluateShadowStateIntegrity(proxy)).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it('S12 refuses a Proxy whose ownKeys trap throws', () => {
    const proxy = new Proxy(dayInput(cleanDay(720)), {
      ownKeys() {
        throw new Error('trap');
      },
    });
    expect(evaluateShadowTickHealth(proxy)).toEqual({
      status: 'unknown',
      reason: 'invalid-input',
      totalTicks: 0,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
  });

  it('S9 refuses a Proxy whose getOwnPropertyDescriptor trap throws', () => {
    const proxy = new Proxy(stateInput({}), {
      getOwnPropertyDescriptor() {
        throw new Error('trap');
      },
    });
    expect(evaluateShadowStateIntegrity(proxy)).toEqual(s9Eval('unknown', 'invalid-input'));
  });

  it('S9 never runs an enumerable getter on the nested stateCheck object (SH5b)', () => {
    let getterCalls = 0;
    const hostileStateCheck: Record<string, unknown> = { bad: 0 };
    Object.defineProperty(hostileStateCheck, 'checked', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return 5;
      },
    });
    const result = evaluateShadowStateIntegrity(stateInput({ stateCheck: hostileStateCheck }));
    // The getter never runs: validation reads `checked`'s own property
    // descriptor, which is an accessor with no stored `value`, so the
    // validated snapshot carries `checked: undefined`, never the getter's
    // lying `5`.
    expect(getterCalls).toBe(0);
    expect(result).toEqual(s9Eval('unknown', 'invalid-input'));
    expect(result).toEqual(evaluateShadowStateIntegrity(stateInput({ stateCheck: { checked: undefined, bad: 0 } })));
  });

  it('S9 over a Proxy stateCheck with a lying get trap yields the honest plain result with no get trap (SH5b)', () => {
    const plainStateCheck = { checked: 0, bad: 0 };
    let getTraps = 0;
    const hostileStateCheck = new Proxy(plainStateCheck, {
      get(target, key, receiver) {
        getTraps += 1;
        if (key === 'checked') {
          return 5;
        }
        if (key === 'bad') {
          return 0;
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const result = evaluateShadowStateIntegrity(stateInput({ stateCheck: hostileStateCheck }));
    // No `get` trap runs: validation reads `checked`/`bad` through
    // `Object.getOwnPropertyDescriptor`, which the Proxy does not intercept,
    // so the real target values (0, 0) are copied into the snapshot, never
    // the trap's lying `5`.
    expect(getTraps).toBe(0);
    expect(result).toEqual(s9Eval('unknown', 'state-check-unavailable'));
    expect(result).toEqual(evaluateShadowStateIntegrity(stateInput({ stateCheck: plainStateCheck })));
  });

  it('S9 over a Proxy journal array with a lying length-0 get trap still returns the honest fail, not a false pass (SH5b)', () => {
    // `readBoundedArray` validates the journal array's `length` through its
    // own property descriptor (`getOwnPropertyDescriptor`, never `get`) and
    // returns that length alongside the array (see `BoundedArray` in
    // shadow-day-health.ts). The S9 journal loop iterates on THAT returned
    // length, never a plain `.length` read on the array value itself — so
    // even a journal array whose `get` trap lies about `length` (claiming 0
    // for a two-entry array) is never consulted for its length: a plain
    // `.length` read on it would have been, letting the loop silently skip
    // both entries and turn this real `fail/journal-duplicate-intent` into
    // a false `pass/state-consistent`.
    const honestJournal = [
      journalEntry('k1', 'intent', null, PREV_23(50)),
      journalEntry('k1', 'intent', null, PREV_23(51)),
    ];
    let getTraps = 0;
    const lyingJournal = new Proxy(honestJournal, {
      get(target, property, receiver) {
        getTraps += 1;
        return property === 'length' ? 0 : Reflect.get(target, property, receiver);
      },
    });
    const honestResult = evaluateShadowStateIntegrity(stateInput({ journal: honestJournal }));
    expect(honestResult).toEqual(s9Eval('fail', 'journal-duplicate-intent', {
      stateChecked: 5,
      journalKeys: 1,
      duplicateIntents: 1,
      unreconciledIntents: 1,
    }));
    expect(evaluateShadowStateIntegrity(stateInput({ journal: lyingJournal }))).toEqual(honestResult);
    expect(getTraps).toBe(0);
  });

  it('S12 over a Proxy events array with a lying length-0 get trap still returns the honest pass, not a false fail (SH5b)', () => {
    // The S12 twin of the test above: the daemon-tick evaluator's events
    // loop also iterates on the length `readBoundedArray` returns, never a
    // plain `.length` read on the events value. Without that fix, the
    // lying trap below (claiming 0 for a 720-event clean day) would make
    // the loop skip every event, so `totalTicks` would stay 0 and this real
    // `pass/ticks-within-budget` would wrongly become `fail/too-few-ticks`.
    const honestEvents = cleanDay(720);
    let getTraps = 0;
    const lyingEvents = new Proxy(honestEvents, {
      get(target, property, receiver) {
        getTraps += 1;
        return property === 'length' ? 0 : Reflect.get(target, property, receiver);
      },
    });
    const honestResult = s12(dayInput(honestEvents));
    expect(honestResult).toEqual({
      status: 'pass',
      reason: 'ticks-within-budget',
      totalTicks: 720,
      budgetOverruns: 0,
      starvedJobs: 0,
    });
    expect(s12(dayInput(lyingEvents))).toEqual(honestResult);
    expect(getTraps).toBe(0);
  });
});

describe('constants', () => {
  it('keeps the brief-pinned values', () => {
    expect(SHADOW_MIN_TICKS_PER_DAY).toBe(720);
    expect(SHADOW_OPEN_INTENT_GRACE_MS).toBe(900_000);
  });
});
