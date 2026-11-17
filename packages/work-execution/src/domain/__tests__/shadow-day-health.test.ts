import { describe, expect, it } from 'vitest';

import {
  evaluateShadowStateIntegrity,
  evaluateShadowTickHealth,
  SHADOW_OPEN_INTENT_GRACE_MS,
  SHADOW_MIN_TICKS_PER_DAY,
} from '../shadow-day-health.js';
import type { ShadowCriterionEvaluation } from '../shadow-evidence-ledger.js';

const DAY = '2026-11-10';
const PREV_23 = (minute: number): string => `2026-11-09T23:${String(minute).padStart(2, '0')}:00.000Z`;
const DAY_AT = (minute: number): string => `2026-11-10T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00.000Z`;
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

/** `count` clean ticks inside day D, one job event each, a minute apart. */
function cleanDay(count: number, startCounter = 1): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i += 1) {
    events.push(jobEvent({
      eventId: eventId(startCounter + i),
      tickId: tickId(startCounter + i),
      recordedAtIso: DAY_AT(i % 1440),
    }));
  }
  return events;
}

function starveEvent(minuteOnPrevDayOrDay: { iso: string; counter: number; outcome?: string }): Record<string, unknown> {
  return jobEvent({
    eventId: eventId(100_000 + minuteOnPrevDayOrDay.counter),
    tickId: tickId(100_000 + minuteOnPrevDayOrDay.counter),
    jobId: `chain-refresh:${DIGEST}`,
    outcome: minuteOnPrevDayOrDay.outcome ?? 'budget-exhausted',
    recordedAtIso: minuteOnPrevDayOrDay.iso,
  });
}

function s12(input: unknown): ShadowCriterionEvaluation {
  return evaluateShadowTickHealth(input);
}

function dayInput(events: unknown[]): Record<string, unknown> {
  return { day: DAY, events };
}

describe('evaluateShadowTickHealth (S12)', () => {
  it('passes 1,440 clean evenly-spread ticks with no budget issues', () => {
    expect(s12(dayInput(cleanDay(1440)))).toEqual({ status: 'pass', reason: 'ticks-within-budget' });
  });

  it('fails with too-few-ticks at exactly 719 ticks', () => {
    expect(s12(dayInput(cleanDay(719)))).toEqual({ status: 'fail', reason: 'too-few-ticks' });
  });

  it('passes at the 720-tick boundary', () => {
    expect(s12(dayInput(cleanDay(720)))).toEqual({ status: 'pass', reason: 'ticks-within-budget' });
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
    expect(s12(dayInput(events))).toEqual({ status: 'fail', reason: 'tick-budget-overrun' });
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
    expect(s12(dayInput(events))).toEqual({ status: 'pass', reason: 'ticks-within-budget' });
  });

  it('fails job-starved for 10 consecutive budget-exhausted outcomes spanning midnight, last inside day D', () => {
    const events = cleanDay(720, 400);
    for (let i = 0; i < 9; i += 1) {
      events.push(starveEvent({ iso: PREV_23(45 + i), counter: i }));
    }
    events.push(starveEvent({ iso: DAY_AT(0), counter: 9 }));
    expect(s12(dayInput(events))).toEqual({ status: 'fail', reason: 'job-starved' });
  });

  it('passes with only 9 consecutive budget-exhausted outcomes spanning midnight', () => {
    const events = cleanDay(720, 400);
    for (let i = 0; i < 8; i += 1) {
      events.push(starveEvent({ iso: PREV_23(45 + i), counter: i }));
    }
    events.push(starveEvent({ iso: DAY_AT(0), counter: 8 }));
    expect(s12(dayInput(events))).toEqual({ status: 'pass', reason: 'ticks-within-budget' });
  });

  it('passes a 10-run of budget-exhausted outcomes entirely on D-1 with no member inside day D', () => {
    const events = cleanDay(720, 400);
    for (let i = 0; i < 10; i += 1) {
      events.push(starveEvent({ iso: PREV_23(50 + i), counter: i }));
    }
    expect(s12(dayInput(events))).toEqual({ status: 'pass', reason: 'ticks-within-budget' });
  });

  it('reports unknown/daemon-events-invalid with one malformed event in an otherwise clean day', () => {
    const events = [...cleanDay(720), { nope: true }];
    expect(s12(dayInput(events))).toEqual({ status: 'unknown', reason: 'daemon-events-invalid' });
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
    expect(clean.status).toBe('pass');
    expect(overrun).toEqual({ status: 'fail', reason: 'tick-budget-overrun' });
  });

  it('never echoes its input', () => {
    const input = dayInput(cleanDay(720));
    const result = s12(input) as unknown as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['reason', 'status']);
    expect(result).not.toHaveProperty('day');
    expect(result).not.toHaveProperty('events');
  });
});

function journalEntry(key: string, kind: string, outcome: string, recordedAtIso: string): Record<string, unknown> {
  return { key, kind, outcome, recordedAtIso };
}

function stateInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stateCheck: { checked: 5, bad: 0 },
    journal: [],
    sampledAtIso: SAMPLE_AT,
    ...overrides,
  };
}

describe('evaluateShadowStateIntegrity (S9)', () => {
  it('passes a fully clean day', () => {
    expect(evaluateShadowStateIntegrity(stateInput())).toEqual({ status: 'pass', reason: 'state-consistent' });
  });

  it('fails state-check-failed when stateCheck.bad is 1', () => {
    expect(evaluateShadowStateIntegrity(stateInput({ stateCheck: { checked: 5, bad: 1 } }))).toEqual({
      status: 'fail',
      reason: 'state-check-failed',
    });
  });

  it('fails journal-duplicate-intent for a key with two intent entries', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry('k1', 'intent', 'completed', PREV_23(50)),
        journalEntry('k1', 'intent', 'completed', PREV_23(51)),
        journalEntry('k1', 'result', 'completed', PREV_23(52)),
      ],
    }))).toEqual({ status: 'fail', reason: 'journal-duplicate-intent' });
  });

  it('fails journal-orphan-result for a key with a result but no intent', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [journalEntry('k2', 'result', 'completed', PREV_23(50))],
    }))).toEqual({ status: 'fail', reason: 'journal-orphan-result' });
  });

  it('fails journal-duplicate-result for a key with two non-ambiguous results', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry('k3', 'intent', 'completed', PREV_23(50)),
        journalEntry('k3', 'result', 'completed', PREV_23(51)),
        journalEntry('k3', 'result', 'refused', PREV_23(52)),
      ],
    }))).toEqual({ status: 'fail', reason: 'journal-duplicate-result' });
  });

  it('fails unreconciled-intent when an intent has been open for 16 minutes before the sample', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [journalEntry('k4', 'intent', 'completed', '2026-11-10T23:44:00.000Z')],
    }))).toEqual({ status: 'fail', reason: 'unreconciled-intent' });
  });

  it('passes when an intent has been open for only 14 minutes', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [journalEntry('k5', 'intent', 'completed', '2026-11-10T23:46:00.000Z')],
    }))).toEqual({ status: 'pass', reason: 'state-consistent' });
  });

  it('passes when an ambiguous result is followed later by a real final result', () => {
    expect(evaluateShadowStateIntegrity(stateInput({
      journal: [
        journalEntry('k6', 'intent', 'completed', '2026-11-10T10:00:00.000Z'),
        journalEntry('k6', 'result', 'ambiguous', '2026-11-10T10:05:00.000Z'),
        journalEntry('k6', 'result', 'completed', '2026-11-10T10:10:00.000Z'),
      ],
    }))).toEqual({ status: 'pass', reason: 'state-consistent' });
  });

  it('reports unknown/state-check-unavailable when stateCheck is null', () => {
    expect(evaluateShadowStateIntegrity(stateInput({ stateCheck: null }))).toEqual({
      status: 'unknown',
      reason: 'state-check-unavailable',
    });
  });

  it('reports unknown/state-check-unavailable when no stores were checked', () => {
    expect(evaluateShadowStateIntegrity(stateInput({ stateCheck: { checked: 0, bad: 0 } }))).toEqual({
      status: 'unknown',
      reason: 'state-check-unavailable',
    });
  });

  it('is not satisfiable by a constant verdict: clean and failing journals differ', () => {
    const clean = evaluateShadowStateIntegrity(stateInput());
    const failing = evaluateShadowStateIntegrity(stateInput({ stateCheck: { checked: 5, bad: 1 } }));
    expect(clean.status).toBe('pass');
    expect(failing).toEqual({ status: 'fail', reason: 'state-check-failed' });
  });

  it('never echoes its input', () => {
    const input = stateInput();
    const result = evaluateShadowStateIntegrity(input) as unknown as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['reason', 'status']);
    expect(result).not.toHaveProperty('journal');
    expect(result).not.toHaveProperty('stateCheck');
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
    const array = [journalEntry('k', 'intent', 'completed', PREV_23(1)), journalEntry('k', 'result', 'completed', PREV_23(2))];
    delete array[0];
    return array;
  };
  const huge = (): unknown[] => {
    const array: unknown[] = [];
    array[2 ** 32 - 2] = journalEntry('k', 'intent', 'completed', PREV_23(1));
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
        return journalEntry('k', 'intent', 'completed', PREV_23(1));
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
      return { input: { stateCheck: { checked: 1, bad: 0 }, journal: { length: 1, 0: journalEntry('k', 'intent', 'completed', PREV_23(1)) }, sampledAtIso: SAMPLE_AT } };
    case 'huge':
      return { input: { stateCheck: { checked: 1, bad: 0 }, journal: huge(), sampledAtIso: SAMPLE_AT } };
    case 'over-cap':
      return { input: { stateCheck: { checked: 1, bad: 0 }, journal: new Array(500_001).fill(journalEntry('k', 'intent', 'completed', PREV_23(1))), sampledAtIso: SAMPLE_AT } };
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
      journal: [journalEntry('k', 'intent', 'completed', PREV_23(59))],
    });
    let getTraps = 0;
    const proxy = new Proxy(plain, {
      get(target, key, receiver) {
        getTraps += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(evaluateShadowStateIntegrity(proxy)).toEqual(evaluateShadowStateIntegrity(plain));
    expect(getTraps).toBe(0);
  });
});

describe('constants', () => {
  it('keeps the brief-pinned values', () => {
    expect(SHADOW_MIN_TICKS_PER_DAY).toBe(720);
    expect(SHADOW_OPEN_INTENT_GRACE_MS).toBe(900_000);
  });
});
