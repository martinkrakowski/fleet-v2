import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TRAIN_HEALTH_THRESHOLDS,
  TRAIN_HEALTH_QUEUE_MAX,
  blindTrainHealthFinding,
  evaluateTrainHealth,
  trainHealthFindingKey,
} from '../train-health-rules.js';
import type { TrainHealthFinding, TrainHealthQueueEntry, TrainHealthSnapshot } from '../train-health-rules.js';

const NOW = '2026-11-16T12:00:00.000Z';

const FRESH_TICK = '2026-11-16T11:59:00.000Z';
const FRESH_MERGE = '2026-11-16T11:59:00.000Z';

/** A healthy queued entry one minute before `NOW`. */
function entry(overrides: Partial<TrainHealthQueueEntry> = {}): TrainHealthQueueEntry {
  return {
    pullRequest: 1,
    state: 'queued',
    forgeState: 'open',
    enqueuedAtIso: '2026-11-16T11:59:00.000Z',
    attempt: 0,
    ...overrides,
  };
}

type SnapshotOverrides = Partial<TrainHealthSnapshot> & Record<string, unknown>;

/**
 * A healthy train with a fresh tick. An override whose value is `undefined`
 * is treated as "not set", so the built snapshot does not carry the key at
 * all (an own key holding `undefined` is a malformed snapshot, not an absent
 * one).
 */
function snapshot(overrides: SnapshotOverrides = {}): TrainHealthSnapshot {
  const base: Record<string, unknown> = {
    queue: [],
    lastTickFinishedAtIso: FRESH_TICK,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      continue;
    }
    base[key] = value;
  }
  return base as unknown as TrainHealthSnapshot;
}

/** A refusal, written the way the tests assert it. */
function R(reasonCode: string): { outcome: string; reasonCode: string } {
  return { outcome: 'refused', reasonCode };
}

function keysOf(findings: readonly TrainHealthFinding[]): string[] {
  return findings.map((finding) => finding.key);
}

describe('evaluateTrainHealth', () => {
  describe('tick-stale', () => {
    it('is silent at exactly the threshold and fires 1 ms past it', () => {
      const atThreshold = evaluateTrainHealth(
        snapshot({ lastTickFinishedAtIso: '2026-11-16T11:55:00.000Z' }),
        undefined,
        NOW,
      );
      expect(atThreshold).toEqual({
        outcome: 'evaluated',
        findings: [],
        truncated: false,
        unknownForgeStates: 0,
      });
      const pastThreshold = evaluateTrainHealth(
        snapshot({ lastTickFinishedAtIso: '2026-11-16T11:54:59.999Z' }),
        undefined,
        NOW,
      );
      expect(pastThreshold).toEqual({
        outcome: 'evaluated',
        findings: [{
          rule: 'tick-stale',
          severity: 'page',
          key: 'train-health:tick-stale',
          pullRequest: null,
          evidence: { staleMinutes: 5 },
        }],
        truncated: false,
        unknownForgeStates: 0,
      });
    });

    it('honours a custom tickStaleMinutes', () => {
      const thresholds = { tickStaleMinutes: 10 };
      const atNine = evaluateTrainHealth(
        snapshot({ lastTickFinishedAtIso: '2026-11-16T11:51:00.000Z' }),
        thresholds,
        NOW,
      );
      expect(atNine).toEqual({
        outcome: 'evaluated',
        findings: [],
        truncated: false,
        unknownForgeStates: 0,
      });
      const atEleven = evaluateTrainHealth(
        snapshot({ lastTickFinishedAtIso: '2026-11-16T11:49:00.000Z' }),
        thresholds,
        NOW,
      );
      expect(atEleven).toEqual({
        outcome: 'evaluated',
        findings: [{
          rule: 'tick-stale',
          severity: 'page',
          key: 'train-health:tick-stale',
          pullRequest: null,
          evidence: { staleMinutes: 11 },
        }],
        truncated: false,
        unknownForgeStates: 0,
      });
    });

    it('a train that never ticked fires tick-stale only while an entry is live', () => {
      const withoutTick = snapshotWithoutTick([entry()]);
      expect(evaluateTrainHealth(withoutTick, undefined, NOW)).toEqual({
        outcome: 'evaluated',
        findings: [{
          rule: 'tick-stale',
          severity: 'page',
          key: 'train-health:tick-stale',
          pullRequest: null,
          evidence: { staleMinutes: null },
        }],
        truncated: false,
        unknownForgeStates: 0,
      });
      expect(evaluateTrainHealth(snapshotWithoutTick([]), undefined, NOW)).toEqual({
        outcome: 'evaluated',
        findings: [],
        truncated: false,
        unknownForgeStates: 0,
      });
      expect(evaluateTrainHealth(snapshotWithoutTick([entry({ state: 'merged' })]), undefined, NOW)).toEqual({
        outcome: 'evaluated',
        findings: [],
        truncated: false,
        unknownForgeStates: 0,
      });
    });
  });

  describe('stale-queue-entry', () => {
    it('fires for a live entry the forge reports closed or merged', () => {
      const result = evaluateTrainHealth(
        snapshot({ queue: [entry({ pullRequest: 3, forgeState: 'closed' }), entry({ pullRequest: 4, forgeState: 'merged' })] }),
        undefined,
        NOW,
      );
      expect(result).toEqual({
        outcome: 'evaluated',
        findings: [
          {
            rule: 'stale-queue-entry',
            severity: 'page',
            key: 'train-health:stale-queue-entry:3',
            pullRequest: 3,
            evidence: { forgeState: 'closed' },
          },
          {
            rule: 'stale-queue-entry',
            severity: 'page',
            key: 'train-health:stale-queue-entry:4',
            pullRequest: 4,
            evidence: { forgeState: 'merged' },
          },
        ],
        truncated: false,
        unknownForgeStates: 0,
      });
    });

    it('is silent for open, counts unknown, and ignores terminal entries', () => {
      const open = evaluateTrainHealth(snapshot({ queue: [entry()] }), undefined, NOW);
      expect(open).toEqual({ outcome: 'evaluated', findings: [], truncated: false, unknownForgeStates: 0 });

      const unknown = evaluateTrainHealth(snapshot({ queue: [entry({ forgeState: 'unknown' })] }), undefined, NOW);
      expect(unknown).toEqual({ outcome: 'evaluated', findings: [], truncated: false, unknownForgeStates: 1 });

      const mergedState = evaluateTrainHealth(
        snapshot({ queue: [entry({ state: 'merged', forgeState: 'merged' })] }),
        undefined,
        NOW,
      );
      expect(mergedState).toEqual({ outcome: 'evaluated', findings: [], truncated: false, unknownForgeStates: 0 });

      const droppedState = evaluateTrainHealth(
        snapshot({ queue: [entry({ state: 'dropped', forgeState: 'unknown' })] }),
        undefined,
        NOW,
      );
      expect(droppedState).toEqual({ outcome: 'evaluated', findings: [], truncated: false, unknownForgeStates: 0 });
    });
  });

  describe('stalled-head', () => {
    it('measures from the later of the head\'s enqueue and the last merge', () => {
      const headEnqueued31MinAgo = '2026-11-16T11:29:00.000Z';
      const stalled = evaluateTrainHealth(
        snapshot({ queue: [entry({ pullRequest: 5, enqueuedAtIso: headEnqueued31MinAgo })] }),
        undefined,
        NOW,
      );
      expect(stalled).toEqual({
        outcome: 'evaluated',
        findings: [{
          rule: 'stalled-head',
          severity: 'page',
          key: 'train-health:stalled-head',
          pullRequest: null,
          evidence: { stalledMinutes: 31, headPullRequest: 5, activeEntries: 1 },
        }],
        truncated: false,
        unknownForgeStates: 0,
      });

      const mergedAfterHead = evaluateTrainHealth(
        snapshot({
          queue: [entry({ pullRequest: 5, enqueuedAtIso: headEnqueued31MinAgo })],
          lastMergedAtIso: '2026-11-16T11:50:00.000Z',
        }),
        undefined,
        NOW,
      );
      expect(mergedAfterHead).toEqual({ outcome: 'evaluated', findings: [], truncated: false, unknownForgeStates: 0 });

      const headEnqueued5MinAgo = '2026-11-16T11:55:00.000Z';
      const mergedLongBefore = evaluateTrainHealth(
        snapshot({
          queue: [entry({ pullRequest: 5, enqueuedAtIso: headEnqueued5MinAgo })],
          lastMergedAtIso: '2026-11-16T09:00:00.000Z',
        }),
        undefined,
        NOW,
      );
      expect(mergedLongBefore).toEqual({ outcome: 'evaluated', findings: [], truncated: false, unknownForgeStates: 0 });
    });

    it('picks the earliest active entry, the smaller pull request on a tie, and never a parked one', () => {
      const sharedEnqueue = '2026-11-16T11:29:00.000Z';
      const tie = evaluateTrainHealth(
        snapshot({
          queue: [
            entry({ pullRequest: 9, enqueuedAtIso: sharedEnqueue }),
            entry({ pullRequest: 4, enqueuedAtIso: sharedEnqueue }),
          ],
        }),
        undefined,
        NOW,
      );
      expect(tie).toEqual({
        outcome: 'evaluated',
        findings: [{
          rule: 'stalled-head',
          severity: 'page',
          key: 'train-health:stalled-head',
          pullRequest: null,
          evidence: { stalledMinutes: 31, headPullRequest: 4, activeEntries: 2 },
        }],
        truncated: false,
        unknownForgeStates: 0,
      });

      const parkedNotCounted = evaluateTrainHealth(
        snapshot({
          queue: [
            entry({ pullRequest: 2, state: 'parked', attempt: 0, enqueuedAtIso: '2026-11-16T10:00:00.000Z' }),
            entry({ pullRequest: 6, enqueuedAtIso: FRESH_TICK }),
          ],
        }),
        undefined,
        NOW,
      );
      expect(parkedNotCounted).toEqual({ outcome: 'evaluated', findings: [], truncated: false, unknownForgeStates: 0 });

      const onlyParked = evaluateTrainHealth(
        snapshot({
          queue: [entry({ pullRequest: 2, state: 'parked', attempt: 0, enqueuedAtIso: '2026-11-16T10:00:00.000Z' })],
        }),
        undefined,
        NOW,
      );
      expect(onlyParked).toEqual({ outcome: 'evaluated', findings: [], truncated: false, unknownForgeStates: 0 });
    });
  });

  describe('repeated-park', () => {
    it('fires at the attempt threshold and only for parked entries', () => {
      const atTwo = evaluateTrainHealth(
        snapshot({ queue: [entry({ pullRequest: 8, state: 'parked', attempt: 2 })] }),
        undefined,
        NOW,
      );
      expect(atTwo).toEqual({ outcome: 'evaluated', findings: [], truncated: false, unknownForgeStates: 0 });

      const atThree = evaluateTrainHealth(
        snapshot({ queue: [entry({ pullRequest: 8, state: 'parked', attempt: 3 })] }),
        undefined,
        NOW,
      );
      expect(atThree).toEqual({
        outcome: 'evaluated',
        findings: [{
          rule: 'repeated-park',
          severity: 'page',
          key: 'train-health:repeated-park:8',
          pullRequest: 8,
          evidence: { attempt: 3 },
        }],
        truncated: false,
        unknownForgeStates: 0,
      });

      const queuedManyAttempts = evaluateTrainHealth(
        snapshot({ queue: [entry({ pullRequest: 8, state: 'queued', attempt: 9 })] }),
        undefined,
        NOW,
      );
      expect(queuedManyAttempts).toEqual({ outcome: 'evaluated', findings: [], truncated: false, unknownForgeStates: 0 });
    });
  });

  describe('finalise', () => {
    it('two live entries of one pull request yield one finding per key', () => {
      const result = evaluateTrainHealth(
        snapshot({
          queue: [
            entry({ pullRequest: 5, forgeState: 'closed', enqueuedAtIso: '2026-11-16T11:30:00.000Z' }),
            entry({ pullRequest: 5, forgeState: 'closed', enqueuedAtIso: '2026-11-16T11:30:00.000Z' }),
          ],
        }),
        undefined,
        NOW,
      );
      expect(result).toEqual({
        outcome: 'evaluated',
        findings: [{
          rule: 'stale-queue-entry',
          severity: 'page',
          key: 'train-health:stale-queue-entry:5',
          pullRequest: 5,
          evidence: { forgeState: 'closed' },
        }],
        truncated: false,
        unknownForgeStates: 0,
      });
    });

    it('findings are ordered by key', () => {
      const allRules = snapshot({
        queue: [
          entry({ pullRequest: 7, state: 'parked', attempt: 3, enqueuedAtIso: FRESH_TICK }),
          entry({ pullRequest: 9, forgeState: 'closed', enqueuedAtIso: '2026-11-16T11:29:00.000Z' }),
          entry({ pullRequest: 10, forgeState: 'closed', enqueuedAtIso: '2026-11-16T11:30:00.000Z' }),
        ],
        lastTickFinishedAtIso: '2026-11-16T11:54:00.000Z',
      });
      const result = evaluateTrainHealth(allRules, undefined, NOW);
      expect(result.outcome).toBe('evaluated');
      if (result.outcome !== 'evaluated') {
        return;
      }
      expect(keysOf(result.findings)).toEqual([
        'train-health:repeated-park:7',
        'train-health:stale-queue-entry:10',
        'train-health:stale-queue-entry:9',
        'train-health:stalled-head',
        'train-health:tick-stale',
      ]);
      for (const finding of result.findings) {
        expect(finding.key).toBe(trainHealthFindingKey(finding.rule, finding.pullRequest));
      }
    });

    it('more than 200 findings are cut to 200 and marked truncated', () => {
      const over = buildClosedQueue(250);
      const overResult = evaluateTrainHealth(snapshot({ queue: over }), undefined, NOW);
      expect(overResult.outcome).toBe('evaluated');
      if (overResult.outcome === 'evaluated') {
        expect(overResult.findings).toHaveLength(200);
        expect(overResult.truncated).toBe(true);
      }

      const atLimit = buildClosedQueue(200);
      const atLimitResult = evaluateTrainHealth(
        snapshot({ queue: atLimit, lastMergedAtIso: FRESH_MERGE }),
        undefined,
        NOW,
      );
      expect(atLimitResult.outcome).toBe('evaluated');
      if (atLimitResult.outcome === 'evaluated') {
        expect(atLimitResult.findings).toHaveLength(200);
        expect(atLimitResult.truncated).toBe(false);
      }
    });
  });

  it('the evaluation is frozen', () => {
    const result = evaluateTrainHealth(
      snapshot({ queue: [entry({ pullRequest: 3, forgeState: 'closed' })] }),
      undefined,
      NOW,
    );
    expect(result.outcome).toBe('evaluated');
    if (result.outcome !== 'evaluated') {
      return;
    }
    expect(Object.isFrozen(result.findings)).toBe(true);
    for (const finding of result.findings) {
      expect(Object.isFrozen(finding)).toBe(true);
      expect(Object.isFrozen(finding.evidence)).toBe(true);
    }
  });
});

describe('blindTrainHealthFinding', () => {
  it('returns the frozen watchdog-blind finding', () => {
    const blind = blindTrainHealthFinding();
    expect(blind).toEqual({
      rule: 'watchdog-blind',
      severity: 'page',
      key: 'train-health:watchdog-blind',
      pullRequest: null,
      evidence: {},
    });
    expect(Object.isFrozen(blind)).toBe(true);
    expect(Object.isFrozen(blind.evidence)).toBe(true);
  });
});

describe('trainHealthFindingKey', () => {
  it('builds the key from a rule and an optional pull request', () => {
    expect(trainHealthFindingKey('tick-stale', null)).toBe('train-health:tick-stale');
    expect(trainHealthFindingKey('stale-queue-entry', 12)).toBe('train-health:stale-queue-entry:12');
    expect(trainHealthFindingKey('repeated-park', 0)).toBe('train-health:repeated-park');
    expect(trainHealthFindingKey('repeated-park', 1.5)).toBe('train-health:repeated-park');
    expect(trainHealthFindingKey('repeated-park', '7')).toBe('train-health:repeated-park');
    expect(trainHealthFindingKey('repeated-park', undefined)).toBe('train-health:repeated-park');
    expect(trainHealthFindingKey('weird', 3)).toBe('train-health:unknown');
    expect(trainHealthFindingKey(null, 3)).toBe('train-health:unknown');
    expect(trainHealthFindingKey(42, null)).toBe('train-health:unknown');
    expect(trainHealthFindingKey({ toString() { throw new Error('no'); } }, 1)).toBe('train-health:unknown');
  });
});

/**
 * A snapshot whose optional tick key is genuinely absent: no own key at all.
 */
function snapshotWithoutTick(queue: TrainHealthQueueEntry[]): TrainHealthSnapshot {
  const raw: Record<string, unknown> = { queue };
  return raw as unknown as TrainHealthSnapshot;
}

/** One live `closed` entry per pull request, 1..count, enqueued a minute ago. */
function buildClosedQueue(count: number): TrainHealthQueueEntry[] {
  const queue: TrainHealthQueueEntry[] = [];
  for (let pullRequest = 1; pullRequest <= count; pullRequest += 1) {
    queue.push(entry({ pullRequest, forgeState: 'closed' }));
  }
  return queue;
}

describe('refusals', () => {
  it('refuses a nowIso that is not a zoned ISO time', () => {
    const cases = [undefined, null, 42, '2026-11-16', '2026-11-16T12:00:00', '2026-02-30T12:00:00.000Z'];
    for (const nowIso of cases) {
      expect(evaluateTrainHealth(snapshot(), undefined, nowIso)).toEqual(R('invalid-clock'));
    }
  });

  it('refuses a time more than 60 s in the future and accepts one 59 s ahead', () => {
    const future = '2026-11-16T12:01:01.000Z';
    const nearFuture = '2026-11-16T12:00:59.000Z';

    expect(evaluateTrainHealth(snapshot({ lastTickFinishedAtIso: future }), undefined, NOW))
      .toEqual(R('invalid-clock'));
    expect(evaluateTrainHealth(snapshot({ lastTickFinishedAtIso: nearFuture }), undefined, NOW).outcome)
      .toBe('evaluated');

    expect(evaluateTrainHealth(snapshot({ lastMergedAtIso: future }), undefined, NOW))
      .toEqual(R('invalid-clock'));
    expect(evaluateTrainHealth(snapshot({ lastMergedAtIso: nearFuture }), undefined, NOW).outcome)
      .toBe('evaluated');

    expect(evaluateTrainHealth(snapshot({ queue: [entry({ enqueuedAtIso: future })] }), undefined, NOW))
      .toEqual(R('invalid-clock'));
    expect(evaluateTrainHealth(snapshot({ queue: [entry({ enqueuedAtIso: nearFuture })] }), undefined, NOW).outcome)
      .toBe('evaluated');
  });

  it('refuses thresholds that are not a plain record of in-range integers', () => {
    const getterThresholds = {};
    Object.defineProperty(getterThresholds, 'tickStaleMinutes', {
      get() {
        return 5;
      },
      enumerable: true,
    });
    const undefinedThreshold: Record<string, unknown> = {};
    undefinedThreshold.tickStaleMinutes = undefined;
    const cases = [
      null,
      '5',
      7,
      [],
      { tickStaleMinutes: 0 },
      { tickStaleMinutes: 1441 },
      { stalledHeadMinutes: 1.5 },
      { repeatedParkAttempts: 101 },
      undefinedThreshold,
      getterThresholds,
    ];
    for (const thresholds of cases) {
      expect(evaluateTrainHealth(snapshot(), thresholds, NOW)).toEqual(R('invalid-thresholds'));
    }
  });

  it('undefined thresholds and an empty record use the defaults', () => {
    const oneMinuteOnePastThreshold = snapshot({ lastTickFinishedAtIso: '2026-11-16T11:54:59.999Z' });
    const expected = {
      outcome: 'evaluated',
      findings: [{
        rule: 'tick-stale',
        severity: 'page',
        key: 'train-health:tick-stale',
        pullRequest: null,
        evidence: { staleMinutes: 5 },
      }],
      truncated: false,
      unknownForgeStates: 0,
    };
    expect(evaluateTrainHealth(oneMinuteOnePastThreshold, undefined, NOW)).toEqual(expected);
    expect(evaluateTrainHealth(oneMinuteOnePastThreshold, {}, NOW)).toEqual(expected);
    expect(DEFAULT_TRAIN_HEALTH_THRESHOLDS.tickStaleMinutes).toBe(5);
  });

  it('refuses a snapshot that is null, undefined or a wrong primitive type', () => {
    const cases = [null, undefined, 0, 'queue', true, Symbol('s')];
    for (const snapshotValue of cases) {
      expect(evaluateTrainHealth(snapshotValue, undefined, NOW)).toEqual(R('invalid-snapshot'));
    }
  });

  it('refuses a snapshot whose prototype is not plain', () => {
    class HostileSnapshot {
      queue: TrainHealthQueueEntry[] = [entry()];
    }
    expect(evaluateTrainHealth(new HostileSnapshot(), undefined, NOW)).toEqual(R('invalid-snapshot'));
    expect(evaluateTrainHealth(Object.create({ queue: [entry()] }), undefined, NOW)).toEqual(R('invalid-snapshot'));
  });

  it('refuses a non-iterable or array-like queue without iterating it', () => {
    const arrayLike = { length: 2, 0: entry(), 1: entry() };
    const enormous = { length: 4294967295 };
    const cases: unknown[] = [{}, 7, 'ab', arrayLike, enormous];
    for (const queue of cases) {
      expect(evaluateTrainHealth(
        snapshot({ queue: queue as unknown as TrainHealthQueueEntry[] }),
        undefined,
        NOW,
      )).toEqual(R('invalid-snapshot'));
    }
  });

  it('refuses a queue longer than TRAIN_HEALTH_QUEUE_MAX before reading an element', () => {
    expect(TRAIN_HEALTH_QUEUE_MAX).toBe(500);
    const queue: TrainHealthQueueEntry[] = [];
    for (let pullRequest = 1; pullRequest <= 501; pullRequest += 1) {
      queue.push(entry({ pullRequest }));
    }
    expect(evaluateTrainHealth(snapshot({ queue }), undefined, NOW)).toEqual(R('invalid-snapshot'));
    expect(evaluateTrainHealth(snapshot({ queue: new Array(4294967295) as unknown as TrainHealthQueueEntry[] }), undefined, NOW))
      .toEqual(R('invalid-snapshot'));
  });

  it('evaluates a queue of exactly TRAIN_HEALTH_QUEUE_MAX entries', () => {
    const result = evaluateTrainHealth(snapshot({ queue: buildClosedQueue(500) }), undefined, NOW);
    expect(result.outcome).toBe('evaluated');
  });

  it('refuses an array hole', () => {
    const withHole = [entry(), entry()];
    delete (withHole as Record<number, unknown>)[0];
    expect(evaluateTrainHealth(snapshot({ queue: withHole }), undefined, NOW)).toEqual(R('invalid-snapshot'));
    expect(evaluateTrainHealth(snapshot({ queue: new Array(3) as unknown as TrainHealthQueueEntry[] }), undefined, NOW))
      .toEqual(R('invalid-snapshot'));
  });

  it('refuses a malformed entry or time field', () => {
    const missingAttempt: Record<string, unknown> = { ...entry() };
    delete missingAttempt.attempt;

    const cases = [
      { pullRequest: 0 },
      { pullRequest: 1.5 },
      { attempt: -1 },
      { state: 'flying' },
      { forgeState: 'OPEN' },
      { enqueuedAtIso: 'yesterday' },
      { enqueuedAtIso: 'x'.repeat(41) },
    ];
    for (const overrides of cases) {
      expect(evaluateTrainHealth(
        snapshot({ queue: [entry(overrides as unknown as Partial<TrainHealthQueueEntry>)] }),
        undefined,
        NOW,
      )).toEqual(R('invalid-snapshot'));
    }
    expect(evaluateTrainHealth(
      snapshot({ queue: [missingAttempt as unknown as TrainHealthQueueEntry] }),
      undefined,
      NOW,
    )).toEqual(R('invalid-snapshot'));
    expect(evaluateTrainHealth(
      snapshot({ queue: [null as unknown as TrainHealthQueueEntry] }),
      undefined,
      NOW,
    )).toEqual(R('invalid-snapshot'));

    const nullTick: Record<string, unknown> = { queue: [] };
    nullTick.lastTickFinishedAtIso = null;
    expect(evaluateTrainHealth(nullTick as unknown as TrainHealthSnapshot, undefined, NOW))
      .toEqual(R('invalid-snapshot'));

    const undefinedMerge: Record<string, unknown> = { ...snapshot() };
    undefinedMerge.lastMergedAtIso = undefined;
    expect(evaluateTrainHealth(undefinedMerge as unknown as TrainHealthSnapshot, undefined, NOW))
      .toEqual(R('invalid-snapshot'));

    expect(evaluateTrainHealth(snapshot({ lastMergedAtIso: 'soon' }), undefined, NOW))
      .toEqual(R('invalid-snapshot'));
  });

  it('refuses a getter on a schema key and never invokes it', () => {
    let getterCalls = 0;
    const hostileSnapshot: Record<string, unknown> = {};
    Object.defineProperty(hostileSnapshot, 'queue', {
      get() {
        getterCalls += 1;
        return [entry()];
      },
      enumerable: true,
    });
    expect(evaluateTrainHealth(hostileSnapshot, undefined, NOW)).toEqual(R('invalid-snapshot'));

    const hostileEntry: Record<string, unknown> = { ...entry({ pullRequest: 2 }) };
    delete hostileEntry.state;
    Object.defineProperty(hostileEntry, 'state', {
      get() {
        getterCalls += 1;
        return 'queued';
      },
      enumerable: true,
    });
    expect(evaluateTrainHealth(
      snapshot({ queue: [hostileEntry as unknown as TrainHealthQueueEntry] }),
      undefined,
      NOW,
    )).toEqual(R('invalid-snapshot'));
    expect(getterCalls).toBe(0);
  });

  it('refuses a Proxy whose trap throws and throws nothing', () => {
    const trap = { getPrototypeOf() { throw new Error('trap'); } };
    expect(evaluateTrainHealth(new Proxy({}, trap), undefined, NOW)).toEqual(R('invalid-snapshot'));
    expect(evaluateTrainHealth(
      snapshot({ queue: [new Proxy({}, trap) as unknown as TrainHealthQueueEntry] }),
      undefined,
      NOW,
    )).toEqual(R('invalid-snapshot'));
  });

  it('evaluates a transparent Proxy like the record it wraps', () => {
    const valid = snapshot({ lastTickFinishedAtIso: '2026-11-16T11:54:59.999Z' });
    const expected = {
      outcome: 'evaluated',
      findings: [{
        rule: 'tick-stale',
        severity: 'page',
        key: 'train-health:tick-stale',
        pullRequest: null,
        evidence: { staleMinutes: 5 },
      }],
      truncated: false,
      unknownForgeStates: 0,
    };
    expect(evaluateTrainHealth(new Proxy(valid, {}), undefined, NOW)).toEqual(expected);
    expect(evaluateTrainHealth(valid, undefined, NOW)).toEqual(expected);
  });

  it('ignores prototype-polluting own keys and pollutes nothing', () => {
    const pollutedSnapshot = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":1,"prototype":2,"queue":[]}',
    );
    const pollutedEntry = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":1,"prototype":2,"pullRequest":1,'
      + '"state":"queued","forgeState":"open","enqueuedAtIso":"2026-11-16T11:59:00.000Z","attempt":0}',
    );
    const cleanSnapshot = snapshot();
    const cleanEntry = entry();
    expect(evaluateTrainHealth(pollutedSnapshot, undefined, NOW)).toEqual(
      evaluateTrainHealth(cleanSnapshot, undefined, NOW),
    );
    expect(evaluateTrainHealth(snapshot({ queue: [pollutedEntry] }), undefined, NOW)).toEqual(
      evaluateTrainHealth(snapshot({ queue: [cleanEntry] }), undefined, NOW),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
