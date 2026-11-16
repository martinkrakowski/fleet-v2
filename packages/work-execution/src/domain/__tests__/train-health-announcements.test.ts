import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TRAIN_HEALTH_RESPEAK_MINUTES,
  TRAIN_HEALTH_ANNOUNCEMENT_CODES,
  TRAIN_HEALTH_ANNOUNCEMENT_FALLBACK_SENTENCE,
  TRAIN_HEALTH_ANNOUNCEMENT_PRIORITY,
  TRAIN_HEALTH_SENTENCE_MAX_LENGTH,
  decideTrainHealthAnnouncements,
} from '../train-health-announcements.js';
import { TRAIN_HEALTH_RULES } from '../train-health-rules.js';

const NOW = '2026-11-16T12:04:00.000Z';
const TICK = { rule: 'tick-stale' } as const;

const REFUSED_INPUT = {
  outcome: 'refused',
  reasonCode: 'invalid-input',
  sentences: [TRAIN_HEALTH_ANNOUNCEMENT_FALLBACK_SENTENCE],
};

const REFUSED_CLOCK = {
  outcome: 'refused',
  reasonCode: 'invalid-clock',
  sentences: [TRAIN_HEALTH_ANNOUNCEMENT_FALLBACK_SENTENCE],
};

const SENTENCES: Record<string, string> = {
  'watchdog-blind': 'The merge train watchdog cannot read the train state.',
  'findings-truncated': 'The merge train has more problems than the watchdog can list.',
  'queue-too-large': 'The merge train queue is too long to check completely.',
  'tick-stale': 'The merge train has stopped ticking.',
  'stalled-head': 'The head of the merge train is stalled.',
  'stale-queue-entry': 'Pull request 7 is closed or merged but still on the merge train.',
  'repeated-park': 'Pull request 7 keeps being parked on the merge train.',
};

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { targets: [], openItemsKnown: true, openItems: [], nowIso: NOW, ...overrides };
}

function targetFor(rule: string): Record<string, unknown> {
  return rule === 'stale-queue-entry' || rule === 'repeated-park'
    ? { rule, pullRequest: 7 }
    : { rule };
}

function queueTargets(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({ rule: 'stale-queue-entry', pullRequest: index + 1 }));
}

describe('train health announcements', () => {
  it('every code has its exact sentence', () => {
    for (const code of TRAIN_HEALTH_ANNOUNCEMENT_CODES) {
      const decision = decideTrainHealthAnnouncements(input({ targets: [targetFor(code)] }));
      expect(decision).toEqual({
        outcome: 'decided',
        sentences: [SENTENCES[code]],
        due: 1,
        suppressed: 0,
      });
    }
  });

  it('every sentence is short and holds only letters, digits, spaces and a full stop', () => {
    const sentences: string[] = [];
    for (const code of TRAIN_HEALTH_ANNOUNCEMENT_CODES) {
      const decision = decideTrainHealthAnnouncements(
        input({ targets: [{ ...targetFor(code), ...(code === 'stale-queue-entry' || code === 'repeated-park' ? { pullRequest: 2147483647 } : {}) }] }),
      );
      if (decision.outcome === 'decided') {
        sentences.push(...decision.sentences);
      }
    }
    const overflow = decideTrainHealthAnnouncements(input({ targets: queueTargets(202) }));
    expect(overflow).toEqual({
      outcome: 'decided',
      sentences: expect.any(Array),
      due: 202,
      suppressed: 200,
    });
    if (overflow.outcome === 'decided') {
      sentences.push(overflow.sentences[2]);
    }
    sentences.push(TRAIN_HEALTH_ANNOUNCEMENT_FALLBACK_SENTENCE);
    for (const sentence of sentences) {
      expect(sentence).toMatch(/^[A-Za-z0-9 .]+$/);
      expect(sentence.length).toBeLessThanOrEqual(TRAIN_HEALTH_SENTENCE_MAX_LENGTH);
    }
  });

  it('the first five codes are the CO-WD1 rules in order', () => {
    expect(TRAIN_HEALTH_ANNOUNCEMENT_CODES.slice(0, 5)).toEqual([...TRAIN_HEALTH_RULES]);
    expect([...TRAIN_HEALTH_ANNOUNCEMENT_PRIORITY].sort()).toEqual([...TRAIN_HEALTH_ANNOUNCEMENT_CODES].sort());
  });

  it('a target with no open item is spoken', () => {
    expect(decideTrainHealthAnnouncements(input({ targets: [TICK] }))).toEqual({
      outcome: 'decided',
      sentences: ['The merge train has stopped ticking.'],
      due: 1,
      suppressed: 0,
    });
  });

  it('an item raised earlier in the same ten-minute bucket silences its target', () => {
    expect(
      decideTrainHealthAnnouncements(
        input({
          targets: [TICK],
          openItems: [{ rule: 'tick-stale', lastRaisedAtIso: '2026-11-16T12:03:00.000Z' }],
        }),
      ),
    ).toEqual({ outcome: 'decided', sentences: [], due: 0, suppressed: 0 });
  });

  it('an item raised nine minutes ago in the same bucket still silences', () => {
    expect(
      decideTrainHealthAnnouncements(
        input({
          nowIso: '2026-11-16T12:09:30.000Z',
          targets: [TICK],
          openItems: [{ rule: 'tick-stale', lastRaisedAtIso: '2026-11-16T12:00:30.000Z' }],
        }),
      ),
    ).toEqual({ outcome: 'decided', sentences: [], due: 0, suppressed: 0 });
  });

  it('an item raised one millisecond before the bucket boundary is spoken again', () => {
    expect(
      decideTrainHealthAnnouncements(
        input({
          nowIso: '2026-11-16T12:00:00.000Z',
          targets: [TICK],
          openItems: [{ rule: 'tick-stale', lastRaisedAtIso: '2026-11-16T11:59:59.999Z' }],
        }),
      ),
    ).toEqual({
      outcome: 'decided',
      sentences: ['The merge train has stopped ticking.'],
      due: 1,
      suppressed: 0,
    });
  });

  it('an offset time is compared as an instant', () => {
    expect(
      decideTrainHealthAnnouncements(
        input({
          targets: [TICK],
          openItems: [{ rule: 'tick-stale', lastRaisedAtIso: '2026-11-16T13:03:00.000+01:00' }],
        }),
      ),
    ).toEqual({ outcome: 'decided', sentences: [], due: 0, suppressed: 0 });
  });

  it('respeakMinutes 1 speaks across a one-minute boundary and is silent inside the minute', () => {
    const silent = decideTrainHealthAnnouncements(
      input({
        nowIso: '2026-11-16T12:04:30.000Z',
        respeakMinutes: 1,
        targets: [TICK],
        openItems: [{ rule: 'tick-stale', lastRaisedAtIso: '2026-11-16T12:04:00.000Z' }],
      }),
    );
    expect(silent).toEqual({ outcome: 'decided', sentences: [], due: 0, suppressed: 0 });
    const spoken = decideTrainHealthAnnouncements(
      input({
        nowIso: '2026-11-16T12:05:00.000Z',
        respeakMinutes: 1,
        targets: [TICK],
        openItems: [{ rule: 'tick-stale', lastRaisedAtIso: '2026-11-16T12:04:30.000Z' }],
      }),
    );
    expect(spoken).toEqual({
      outcome: 'decided',
      sentences: ['The merge train has stopped ticking.'],
      due: 1,
      suppressed: 0,
    });
  });

  it('openItemsKnown false speaks every target even when openItems lists it as just raised', () => {
    expect(
      decideTrainHealthAnnouncements(
        input({
          targets: [TICK],
          openItemsKnown: false,
          openItems: [{ rule: 'tick-stale', lastRaisedAtIso: NOW }],
        }),
      ),
    ).toEqual({
      outcome: 'decided',
      sentences: ['The merge train has stopped ticking.'],
      due: 1,
      suppressed: 0,
    });
  });

  it('an open item with a missing, unparseable or future lastRaisedAtIso does not silence its target', () => {
    const missing = decideTrainHealthAnnouncements(
      input({ targets: [TICK], openItems: [{ rule: 'tick-stale' }] }),
    );
    expect(missing).toEqual({
      outcome: 'decided',
      sentences: ['The merge train has stopped ticking.'],
      due: 1,
      suppressed: 0,
    });
    const unparseable = decideTrainHealthAnnouncements(
      input({ targets: [TICK], openItems: [{ rule: 'tick-stale', lastRaisedAtIso: 'yesterday' }] }),
    );
    expect(unparseable).toEqual({
      outcome: 'decided',
      sentences: ['The merge train has stopped ticking.'],
      due: 1,
      suppressed: 0,
    });
    const future = decideTrainHealthAnnouncements(
      input({ targets: [TICK], openItems: [{ rule: 'tick-stale', lastRaisedAtIso: '2026-11-16T13:04:00.000Z' }] }),
    );
    expect(future).toEqual({
      outcome: 'decided',
      sentences: ['The merge train has stopped ticking.'],
      due: 1,
      suppressed: 0,
    });
  });

  it('one unknown time among two items of the same identity wins over a valid recent time', () => {
    const spoken = {
      outcome: 'decided',
      sentences: ['The merge train has stopped ticking.'],
      due: 1,
      suppressed: 0,
    };
    const unknownFirst = [{ rule: 'tick-stale', lastRaisedAtIso: 'yesterday' }, { rule: 'tick-stale', lastRaisedAtIso: NOW }];
    const validFirst = [{ rule: 'tick-stale', lastRaisedAtIso: NOW }, { rule: 'tick-stale', lastRaisedAtIso: 'yesterday' }];
    expect(decideTrainHealthAnnouncements(input({ targets: [TICK], openItems: unknownFirst }))).toEqual(spoken);
    expect(decideTrainHealthAnnouncements(input({ targets: [TICK], openItems: validFirst }))).toEqual(spoken);
  });

  it('two valid items of one identity use the later time', () => {
    expect(
      decideTrainHealthAnnouncements(
        input({
          targets: [TICK],
          openItems: [
            { rule: 'tick-stale', lastRaisedAtIso: '2026-11-16T11:50:00.000Z' },
            { rule: 'tick-stale', lastRaisedAtIso: '2026-11-16T12:03:00.000Z' },
          ],
        }),
      ),
    ).toEqual({ outcome: 'decided', sentences: [], due: 0, suppressed: 0 });
  });

  it('identity is rule plus pull request', () => {
    const target = { rule: 'stale-queue-entry', pullRequest: 4 };
    const sentence = 'Pull request 4 is closed or merged but still on the merge train.';
    const spoken = { outcome: 'decided', sentences: [sentence], due: 1, suppressed: 0 };
    expect(
      decideTrainHealthAnnouncements(
        input({ targets: [target], openItems: [{ rule: 'stale-queue-entry', pullRequest: 5, lastRaisedAtIso: NOW }] }),
      ),
    ).toEqual(spoken);
    expect(
      decideTrainHealthAnnouncements(
        input({ targets: [target], openItems: [{ rule: 'repeated-park', pullRequest: 4, lastRaisedAtIso: NOW }] }),
      ),
    ).toEqual(spoken);
    expect(
      decideTrainHealthAnnouncements(
        input({ targets: [target], openItems: [{ rule: 'stale-queue-entry', pullRequest: 4, lastRaisedAtIso: NOW }] }),
      ),
    ).toEqual({ outcome: 'decided', sentences: [], due: 0, suppressed: 0 });
  });

  it('an open item with an unknown rule is ignored', () => {
    expect(
      decideTrainHealthAnnouncements(
        input({ targets: [TICK], openItems: [{ rule: 'something-else', lastRaisedAtIso: NOW }] }),
      ),
    ).toEqual({
      outcome: 'decided',
      sentences: ['The merge train has stopped ticking.'],
      due: 1,
      suppressed: 0,
    });
  });

  it('a repeated target is spoken once', () => {
    expect(decideTrainHealthAnnouncements(input({ targets: [TICK, TICK] }))).toEqual({
      outcome: 'decided',
      sentences: ['The merge train has stopped ticking.'],
      due: 1,
      suppressed: 0,
    });
  });

  it('three due targets are spoken in priority order whatever the input order', () => {
    const targets = [{ rule: 'repeated-park', pullRequest: 9 }, TICK, { rule: 'watchdog-blind' }];
    const expected = {
      outcome: 'decided',
      sentences: [
        'The merge train watchdog cannot read the train state.',
        'The merge train has stopped ticking.',
        'Pull request 9 keeps being parked on the merge train.',
      ],
      due: 3,
      suppressed: 0,
    };
    expect(decideTrainHealthAnnouncements(input({ targets }))).toEqual(expected);
    expect(decideTrainHealthAnnouncements(input({ targets: [...targets].reverse() }))).toEqual(expected);
  });

  it('more than three due targets speak the two most severe and then the overflow sentence', () => {
    const decision = decideTrainHealthAnnouncements(
      input({
        targets: [
          { rule: 'stale-queue-entry', pullRequest: 12 },
          { rule: 'stale-queue-entry', pullRequest: 3 },
          { rule: 'stalled-head' },
          { rule: 'findings-truncated' },
          { rule: 'watchdog-blind' },
        ],
      }),
    );
    expect(decision).toEqual({
      outcome: 'decided',
      sentences: [
        'The merge train watchdog cannot read the train state.',
        'The merge train has more problems than the watchdog can list.',
        '3 more merge train problems are not announced.',
      ],
      due: 5,
      suppressed: 3,
    });
  });

  it('silenced targets do not count toward the cap', () => {
    expect(
      decideTrainHealthAnnouncements(
        input({
          targets: [TICK, { rule: 'stalled-head' }, { rule: 'queue-too-large' }, { rule: 'findings-truncated' }],
          openItems: [
            { rule: 'tick-stale', lastRaisedAtIso: '2026-11-16T12:03:00.000Z' },
            { rule: 'stalled-head', lastRaisedAtIso: '2026-11-16T12:03:00.000Z' },
          ],
        }),
      ),
    ).toEqual({
      outcome: 'decided',
      sentences: [
        'The merge train has more problems than the watchdog can list.',
        'The merge train queue is too long to check completely.',
      ],
      due: 2,
      suppressed: 0,
    });
  });

  it('per-entry targets are ordered by pull request number', () => {
    const decision = decideTrainHealthAnnouncements(
      input({
        targets: [
          { rule: 'stale-queue-entry', pullRequest: 12 },
          { rule: 'stale-queue-entry', pullRequest: 3 },
        ],
      }),
    );
    expect(decision).toEqual({
      outcome: 'decided',
      sentences: [
        'Pull request 3 is closed or merged but still on the merge train.',
        'Pull request 12 is closed or merged but still on the merge train.',
      ],
      due: 2,
      suppressed: 0,
    });
  });

  it('no targets gives no sentences', () => {
    expect(decideTrainHealthAnnouncements(input())).toEqual({
      outcome: 'decided',
      sentences: [],
      due: 0,
      suppressed: 0,
    });
  });

  it('the decision and its sentence list are frozen', () => {
    const decided = decideTrainHealthAnnouncements(input({ targets: [TICK] }));
    expect(decided.outcome).toBe('decided');
    if (decided.outcome === 'decided') {
      expect(Object.isFrozen(decided)).toBe(true);
      expect(Object.isFrozen(decided.sentences)).toBe(true);
    }
    const refused = decideTrainHealthAnnouncements(42);
    expect(Object.isFrozen(refused)).toBe(true);
    if (refused.outcome === 'refused') {
      expect(Object.isFrozen(refused.sentences)).toBe(true);
    }
  });

  it('refuses null, undefined and wrong primitives as invalid-input', () => {
    for (const bad of [null, undefined, 42, 'x', true]) {
      expect(decideTrainHealthAnnouncements(bad)).toEqual(REFUSED_INPUT);
    }
  });

  it('refuses input with a non-plain prototype', () => {
    expect(decideTrainHealthAnnouncements(new Date())).toEqual(REFUSED_INPUT);
    expect(decideTrainHealthAnnouncements(Object.create({ targets: [] }))).toEqual(REFUSED_INPUT);
  });

  it('refuses an input missing a required field', () => {
    for (const key of ['targets', 'openItemsKnown', 'openItems', 'nowIso']) {
      const partial = input();
      delete partial[key];
      expect(decideTrainHealthAnnouncements(partial)).toEqual(REFUSED_INPUT);
    }
  });

  it('refuses array-like objects for targets and openItems', () => {
    const arrayLike = { length: 2, 0: TICK, 1: TICK };
    expect(decideTrainHealthAnnouncements(input({ targets: arrayLike }))).toEqual(REFUSED_INPUT);
    expect(decideTrainHealthAnnouncements(input({ targets: { length: 1e9 } }))).toEqual(REFUSED_INPUT);
    expect(decideTrainHealthAnnouncements(input({ openItems: arrayLike }))).toEqual(REFUSED_INPUT);
    expect(decideTrainHealthAnnouncements(input({ openItems: { length: 1e9 } }))).toEqual(REFUSED_INPUT);
  });

  it('refuses over-long arrays before reading elements', () => {
    expect(decideTrainHealthAnnouncements(input({ targets: queueTargets(203) }))).toEqual(REFUSED_INPUT);
    expect(
      decideTrainHealthAnnouncements(
        input({ openItems: Array.from({ length: 1001 }, () => ({ rule: 'x' })) }),
      ),
    ).toEqual(REFUSED_INPUT);
    expect(decideTrainHealthAnnouncements(input({ targets: new Array(4294967295) }))).toEqual(REFUSED_INPUT);
    const exactTargets = decideTrainHealthAnnouncements(input({ targets: queueTargets(202) }));
    expect(exactTargets).toEqual({
      outcome: 'decided',
      sentences: expect.any(Array),
      due: 202,
      suppressed: 200,
    });
    const exactOpenItems = decideTrainHealthAnnouncements(
      input({ targets: [TICK], openItems: Array.from({ length: 1000 }, () => ({ rule: 'x' })) }),
    );
    expect(exactOpenItems).toEqual({
      outcome: 'decided',
      sentences: ['The merge train has stopped ticking.'],
      due: 1,
      suppressed: 0,
    });
  });

  it('refuses arrays with holes', () => {
    expect(decideTrainHealthAnnouncements(input({ targets: new Array(1) }))).toEqual(REFUSED_INPUT);
    const deleted = [TICK];
    delete deleted[0];
    expect(decideTrainHealthAnnouncements(input({ targets: deleted }))).toEqual(REFUSED_INPUT);
    expect(decideTrainHealthAnnouncements(input({ openItems: new Array(1) }))).toEqual(REFUSED_INPUT);
  });

  it('refuses a getter on a schema key without invoking it', () => {
    let calls = 0;
    const getter = (key: string, value: unknown): PropertyDescriptor => ({
      get() {
        calls += 1;
        return value;
      },
      enumerable: true,
    });
    const withInputGetter: Record<string, unknown> = { targets: [], openItemsKnown: true, openItems: [] };
    Object.defineProperty(withInputGetter, 'nowIso', getter('nowIso', NOW));
    expect(decideTrainHealthAnnouncements(withInputGetter)).toEqual(REFUSED_INPUT);
    const targetWithGetter: Record<string, unknown> = {};
    Object.defineProperty(targetWithGetter, 'rule', getter('rule', 'tick-stale'));
    expect(decideTrainHealthAnnouncements(input({ targets: [targetWithGetter] }))).toEqual(REFUSED_INPUT);
    const itemWithGetter: Record<string, unknown> = { rule: 'tick-stale' };
    Object.defineProperty(itemWithGetter, 'lastRaisedAtIso', getter('lastRaisedAtIso', NOW));
    expect(decideTrainHealthAnnouncements(input({ targets: [TICK], openItems: [itemWithGetter] }))).toEqual(
      REFUSED_INPUT,
    );
    expect(calls).toBe(0);
  });

  it('refuses a Proxy whose trap throws without throwing', () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
      },
    );
    expect(decideTrainHealthAnnouncements(hostile)).toEqual(REFUSED_INPUT);
  });

  it('decides a transparent Proxy like the record it wraps', () => {
    const base = input({ targets: [TICK] });
    expect(decideTrainHealthAnnouncements(new Proxy(base, {}))).toEqual(decideTrainHealthAnnouncements(base));
  });

  it('ignores prototype-polluting own keys without polluting', () => {
    const prototypeKeysBefore = Object.getOwnPropertyNames(Object.prototype).length;
    const polluted = JSON.parse(
      '{"targets":[{"rule":"tick-stale","__proto__":{"x":1}}],"openItemsKnown":true,"openItems":[{"rule":"tick-stale","constructor":1,"prototype":2}],"nowIso":"2026-11-16T12:04:00.000Z","__proto__":{"y":2}}',
    );
    expect(decideTrainHealthAnnouncements(polluted)).toEqual(
      decideTrainHealthAnnouncements(input({ targets: [TICK], openItems: [{ rule: 'tick-stale' }] })),
    );
    const defined: Record<string, unknown> = input({ targets: [TICK] });
    Object.defineProperty(defined, 'constructor', { value: 1, enumerable: true });
    Object.defineProperty(defined, 'prototype', { value: 2, enumerable: true });
    expect(decideTrainHealthAnnouncements(defined)).toEqual(
      decideTrainHealthAnnouncements(input({ targets: [TICK] })),
    );
    expect(Object.getOwnPropertyNames(Object.prototype).length).toBe(prototypeKeysBefore);
  });

  it('refuses a target with an unknown rule', () => {
    for (const rule of ['Tick', 'train-health:tick-stale', 7]) {
      expect(decideTrainHealthAnnouncements(input({ targets: [{ rule }] }))).toEqual(REFUSED_INPUT);
    }
  });

  it('refuses a target with an invalid pull request', () => {
    for (const pullRequest of [0, -1, 1.5, '7', 2147483648, null]) {
      expect(
        decideTrainHealthAnnouncements(input({ targets: [{ rule: 'stale-queue-entry', pullRequest }] })),
      ).toEqual(REFUSED_INPUT);
    }
  });

  it('refuses a per-entry rule without a pull request and a train-wide rule with one', () => {
    expect(decideTrainHealthAnnouncements(input({ targets: [{ rule: 'stale-queue-entry' }] }))).toEqual(REFUSED_INPUT);
    expect(decideTrainHealthAnnouncements(input({ targets: [{ rule: 'repeated-park' }] }))).toEqual(REFUSED_INPUT);
    expect(decideTrainHealthAnnouncements(input({ targets: [{ rule: 'tick-stale', pullRequest: 7 }] }))).toEqual(
      REFUSED_INPUT,
    );
    expect(decideTrainHealthAnnouncements(input({ targets: [{ rule: 'watchdog-blind', pullRequest: 7 }] }))).toEqual(
      REFUSED_INPUT,
    );
  });

  it('refuses a malformed open item', () => {
    const longRule = 'x'.repeat(41);
    const longTime = 'y'.repeat(41);
    const cases: unknown[] = [
      null,
      'x',
      { rule: 7 },
      { rule: longRule },
      { rule: 'tick-stale', pullRequest: null },
      { rule: 'tick-stale', pullRequest: 0 },
      { rule: 'tick-stale', lastRaisedAtIso: 42 },
      { rule: 'tick-stale', lastRaisedAtIso: null },
      { rule: 'tick-stale', lastRaisedAtIso: longTime },
    ];
    for (const item of cases) {
      expect(decideTrainHealthAnnouncements(input({ targets: [TICK], openItems: [item] }))).toEqual(REFUSED_INPUT);
    }
  });

  it('refuses invalid respeakMinutes', () => {
    for (const respeakMinutes of [0, 1441, 1.5, '10', undefined]) {
      expect(decideTrainHealthAnnouncements(input({ respeakMinutes }))).toEqual(REFUSED_INPUT);
    }
  });

  it('refuses a non-string nowIso as invalid-input', () => {
    for (const nowIso of [42, null]) {
      expect(decideTrainHealthAnnouncements(input({ nowIso }))).toEqual(REFUSED_INPUT);
    }
  });

  it('refuses an invalid nowIso as invalid-clock', () => {
    for (const nowIso of ['now', '2026-11-16T12:04:00', '2026-02-30T12:00:00.000Z']) {
      expect(decideTrainHealthAnnouncements(input({ nowIso }))).toEqual(REFUSED_CLOCK);
    }
  });

  it('keeps the documented default respeak minutes', () => {
    expect(DEFAULT_TRAIN_HEALTH_RESPEAK_MINUTES).toBe(10);
  });
});
