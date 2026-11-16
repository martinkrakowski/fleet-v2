import { describe, expect, it } from 'vitest';

import {
  classifyOrphanReservations,
  MAX_ORPHAN_RESERVATION_SCAN,
  MAX_RUN_SCAN,
  type ClassifiedOrphanReservation,
  type OrphanReservationClassificationResult,
} from '../orphan-reservations.js';
import { CAPACITY_RELEASE_STATES } from '../value-objects/AttemptState.vo.js';
import { LANE_RUN_TERMINAL_STATES, type LaneRunStateValue } from '../value-objects/LaneRunState.vo.js';

const NOW = '2026-11-16T12:00:00.000Z';
const GRACE_MS = 5 * 60_000;

interface ReservationOverrides {
  id?: string;
  attemptId?: string;
  held?: unknown;
  reservedAtIso?: string;
  workOrderId?: unknown;
  hostName?: unknown;
  slotIndex?: unknown;
}

function reservation(overrides: ReservationOverrides = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? 'res-1',
    attemptId: overrides.attemptId ?? 'att-1',
    hostId: 'local',
    slotIndex: overrides.slotIndex ?? 0,
    held: overrides.held ?? true,
    seatTool: null,
    workOrderId: overrides.workOrderId ?? 'wo-1',
    reservedAtIso: overrides.reservedAtIso ?? '2026-11-16T11:00:00.000Z',
    releasedAtIso: null,
  };
}

function run(runId: string, attemptIds: readonly string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { runId, attemptIds: [...attemptIds], ...overrides };
}

function classify(
  reservations: readonly Record<string, unknown>[],
  runs: readonly Record<string, unknown>[],
  options: {
    runStates?: Map<string, LaneRunStateValue | 'unreadable'>;
    attemptsById?: Map<string, { state: string } | null | 'unreadable'>;
    nowIso?: string;
    graceMs?: number;
  } = {},
): OrphanReservationClassificationResult {
  return classifyOrphanReservations({
    reservations,
    runs,
    runStates: options.runStates ?? new Map(),
    attemptsById: options.attemptsById ?? new Map(),
    nowIso: options.nowIso ?? NOW,
    graceMs: options.graceMs ?? GRACE_MS,
  });
}

function ids(list: readonly ClassifiedOrphanReservation[]): string[] {
  return list.map((entry) => entry.reservationId);
}

/** The id of the reservation a classification result put in `bucket`. */
function bucketId(result: OrphanReservationClassificationResult, bucket: 'orphans' | 'reportOnly' | 'skipped' | 'unknown'): string | undefined {
  return result[bucket][0]?.reservationId;
}

describe('classifyOrphanReservations', () => {
  it('classifies a held reservation of a finished attempt on terminal runs as an orphan terminal-run', () => {
    const result = classify(
      [reservation({ id: 'res-a' })],
      [run('run-1', ['att-1'])],
      {
        runStates: new Map([['run-1', LANE_RUN_TERMINAL_STATES[0]]]),
        attemptsById: new Map([['att-1', { state: CAPACITY_RELEASE_STATES[0] }]]),
      },
    );
    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0]).toMatchObject({ reservationId: 'res-a', attemptId: 'att-1', reason: 'terminal-run' });
    expect(result.reportOnly).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.unknown).toHaveLength(0);
  });

  it('classifies every capacity-release state (ended, collected, cancelled) on terminal runs as an orphan', () => {
    for (const state of CAPACITY_RELEASE_STATES) {
      const result = classify(
        [reservation({ id: `res-${state}`, attemptId: 'att-1' })],
        [run('run-1', ['att-1'])],
        {
          runStates: new Map([['run-1', 'merged']]),
          attemptsById: new Map([['att-1', { state }]]),
        },
      );
      expect(result.orphans.map((entry) => entry.reason)).toEqual(['terminal-run']);
      expect(bucketId(result, 'orphans')).toBe(`res-${state}`);
    }
  });

  it('reports a no-run reservation past the grace as reportOnly and never as an orphan when the attempt is absent', () => {
    const result = classify([reservation({ id: 'res-nr', reservedAtIso: '2026-11-16T10:00:00.000Z' })], []);
    expect(result.reportOnly).toHaveLength(1);
    expect(result.reportOnly[0]).toMatchObject({ reservationId: 'res-nr', attemptId: 'att-1', reason: 'no-run-unstarted' });
    expect(result.orphans).toHaveLength(0);
  });

  it('reports a no-run reservation past the grace with an intent-recorded attempt as reportOnly, never an orphan', () => {
    const result = classify([reservation({ id: 'res-ir', reservedAtIso: '2026-11-16T10:00:00.000Z' })], [], {
      attemptsById: new Map([['att-1', { state: 'intent-recorded' }]]),
    });
    expect(result.reportOnly).toHaveLength(1);
    expect(result.reportOnly[0]?.reason).toBe('no-run-unstarted');
    expect(result.orphans).toHaveLength(0);
  });

  it('classifies a no-run reservation inside the grace as skipped within-grace, neither reported nor released', () => {
    const result = classify([reservation({ id: 'res-young', reservedAtIso: '2026-11-16T11:58:00.000Z' })], []);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ reservationId: 'res-young', reason: 'within-grace' });
    expect(result.reportOnly).toHaveLength(0);
    expect(result.orphans).toHaveLength(0);
  });

  it('classifies a no-run reservation with an unparseable reservedAtIso as skipped within-grace', () => {
    const result = classify([reservation({ id: 'res-bad-time', reservedAtIso: 'not-a-time' })], []);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('within-grace');
  });

  it('skips a no-run reservation whose attempt is live as attempt-live', () => {
    const result = classify([reservation({ id: 'res-live', reservedAtIso: '2026-11-16T10:00:00.000Z' })], [], {
      attemptsById: new Map([['att-1', { state: 'running' }]]),
    });
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ reservationId: 'res-live', reason: 'attempt-live' });
    expect(result.reportOnly).toHaveLength(0);
    expect(result.orphans).toHaveLength(0);
  });

  it('skips reservations for live runs as live-run', () => {
    const result = classify([reservation({ id: 'res-live-run' })], [run('run-1', ['att-1'])], {
      runStates: new Map([['run-1', 'running']]),
      attemptsById: new Map([['att-1', { state: 'ended' }]]),
    });
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ reservationId: 'res-live-run', reason: 'live-run' });
    expect(result.orphans).toHaveLength(0);
  });

  it('skips reservations for parked runs as live-run', () => {
    const result = classify([reservation({ id: 'res-parked' })], [run('run-1', ['att-1'])], {
      runStates: new Map([['run-1', 'parked']]),
      attemptsById: new Map([['att-1', { state: 'ended' }]]),
    });
    expect(result.skipped[0]?.reason).toBe('live-run');
  });

  it('skips a terminal-run reservation whose attempt is not in a capacity-release state as attempt-live', () => {
    const result = classify([reservation({ id: 'res-blocked' })], [run('run-1', ['att-1'])], {
      runStates: new Map([['run-1', 'stopped']]),
      attemptsById: new Map([['att-1', { state: 'running' }]]),
    });
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ reservationId: 'res-blocked', reason: 'attempt-live' });
    expect(result.orphans).toHaveLength(0);
  });

  it('classifies unreadable run journal as unknown run-state-unknown, never an orphan', () => {
    const result = classify([reservation({ id: 'res-uj' })], [run('run-1', ['att-1'])], {
      runStates: new Map([['run-1', 'unreadable']]),
      attemptsById: new Map([['att-1', { state: 'ended' }]]),
    });
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0]).toMatchObject({ reservationId: 'res-uj', reason: 'run-state-unknown' });
    expect(result.orphans).toHaveLength(0);
  });

  it('classifies a run state missing from the caller map as unknown run-state-unknown', () => {
    const result = classify([reservation({ id: 'res-missing-state' })], [run('run-1', ['att-1'])], {
      runStates: new Map(),
      attemptsById: new Map([['att-1', { state: 'ended' }]]),
    });
    expect(result.unknown[0]?.reason).toBe('run-state-unknown');
  });

  it('classifies unreadable attempt as unknown attempt-unreadable, never an orphan', () => {
    const result = classify([reservation({ id: 'res-ua' })], [run('run-1', ['att-1'])], {
      runStates: new Map([['run-1', 'merged']]),
      attemptsById: new Map([['att-1', 'unreadable']]),
    });
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0]).toMatchObject({ reservationId: 'res-ua', reason: 'attempt-unreadable' });
    expect(result.orphans).toHaveLength(0);
  });

  it('classifies an absent attempt on terminal runs as unknown attempt-unreadable, never an orphan', () => {
    const result = classify([reservation({ id: 'res-absent' })], [run('run-1', ['att-1'])], {
      runStates: new Map([['run-1', 'merged']]),
      attemptsById: new Map(),
    });
    expect(result.unknown[0]).toMatchObject({ reservationId: 'res-absent', reason: 'attempt-unreadable' });
    expect(result.orphans).toHaveLength(0);
  });

  it('classifies a no-run reservation past the grace with an unreadable attempt as unknown attempt-unreadable', () => {
    const result = classify([reservation({ id: 'res-ua2', reservedAtIso: '2026-11-16T10:00:00.000Z' })], [], {
      attemptsById: new Map([['att-1', 'unreadable']]),
    });
    expect(result.unknown[0]?.reason).toBe('attempt-unreadable');
    expect(result.reportOnly).toHaveLength(0);
  });

  it('supports a plain record for attemptsById with the unreadable sentinel', () => {
    const result = classifyOrphanReservations({
      reservations: [reservation({ id: 'res-plain' })],
      runs: [run('run-1', ['att-1'])],
      runStates: new Map([['run-1', 'merged']]),
      attemptsById: { 'att-1': 'unreadable' },
      nowIso: NOW,
      graceMs: GRACE_MS,
    });
    expect(result.unknown[0]?.reason).toBe('attempt-unreadable');
  });

  it('ignores reservations where held is not true', () => {
    const result = classify([reservation({ id: 'res-unheld', held: false })], []);
    expect(result.orphans).toHaveLength(0);
    expect(result.reportOnly).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.unknown).toHaveLength(0);
  });

  it('sorts each bucket by reservation id in code-unit order', () => {
    const result = classify(
      [
        reservation({ id: 'res-b', attemptId: 'att-b' }),
        reservation({ id: 'res-a', attemptId: 'att-a' }),
        reservation({ id: 'res-A', attemptId: 'att-A' }),
      ],
      [],
    );
    expect(ids(result.reportOnly)).toEqual(['res-A', 'res-a', 'res-b']);
  });

  it('handles hostile inputs and malformed reservations without throwing: null and undefined arrays', () => {
    for (const reservations of [null, undefined]) {
      const result = classifyOrphanReservations({
        reservations,
        runs: [],
        runStates: new Map(),
        attemptsById: new Map(),
        nowIso: NOW,
        graceMs: GRACE_MS,
      });
      expect(result.orphans).toHaveLength(0);
    }
    for (const runs of [null, undefined]) {
      const result = classifyOrphanReservations({
        reservations: [reservation()],
        runs,
        runStates: new Map(),
        attemptsById: new Map(),
        nowIso: NOW,
        graceMs: GRACE_MS,
      });
      expect(result.reportOnly).toHaveLength(1);
    }
  });

  it('handles hostile inputs and malformed reservations without throwing: a non-array where an array is declared', () => {
    for (const reservations of ['nope', 42, {}]) {
      const result = classifyOrphanReservations({
        reservations: reservations as unknown as readonly unknown[],
        runs: [],
        runStates: new Map(),
        attemptsById: new Map(),
        nowIso: NOW,
        graceMs: GRACE_MS,
      });
      expect(result.unknown).toHaveLength(0);
      expect(result.orphans).toHaveLength(0);
    }
  });

  it('handles hostile inputs and malformed reservations without throwing: array holes', () => {
    const holes: unknown[] = new Array(3);
    holes[1] = reservation({ id: 'res-hole-ok' });
    const result = classifyOrphanReservations({
      reservations: holes,
      runs: [],
      runStates: new Map(),
      attemptsById: new Map(),
      nowIso: NOW,
      graceMs: GRACE_MS,
    });
    // The holes are classified malformed with deterministic fallback ids and never released.
    expect(ids(result.unknown)).toEqual(['malformed-0', 'malformed-2']);
    expect(result.reportOnly.map((entry) => entry.reservationId)).toEqual(['res-hole-ok']);
  });

  it('handles hostile inputs and malformed reservations without throwing: wrong primitive types', () => {
    const result = classifyOrphanReservations({
      reservations: ['a-string', 42, true, null] as unknown as readonly Record<string, unknown>[],
      runs: [],
      runStates: new Map(),
      attemptsById: new Map(),
      nowIso: NOW,
      graceMs: GRACE_MS,
    });
    expect(result.unknown.map((entry) => entry.reason)).toEqual([
      'malformed-reservation',
      'malformed-reservation',
      'malformed-reservation',
      'malformed-reservation',
    ]);
    expect(result.orphans).toHaveLength(0);
  });

  it('classifies a held reservation with a missing or invalid id, attemptId or reservedAtIso as unknown malformed-reservation', () => {
    const result = classify(
      [
        reservation({ id: 'res-no-attempt', attemptId: '' }),
        reservation({ id: 'res-no-time', reservedAtIso: '' }),
        { id: 'res-not-held-shaped', attemptId: 'att-1', held: 'yes', reservedAtIso: NOW },
      ],
      [],
    );
    expect(result.unknown.map((entry) => entry.reason)).toEqual([
      'malformed-reservation',
      'malformed-reservation',
      'malformed-reservation',
    ]);
    expect(result.orphans).toHaveLength(0);
  });

  it('handles hostile inputs and malformed reservations without throwing: throwing getters and a Proxy with throwing traps', () => {
    const throwingGetter = {
      get id(): string {
        throw new Error('boom');
      },
      attemptId: 'att-1',
      held: true,
      reservedAtIso: NOW,
    };
    const hostileProxy = new Proxy(
      { id: 'res-proxy', attemptId: 'att-1', held: true, reservedAtIso: NOW },
      {
        get(target, key) {
          if (key === 'id' || key === 'held') {
            throw new Error('trap');
          }
          return Reflect.get(target, key);
        },
        ownKeys() {
          throw new Error('trap');
        },
      },
    );
    const result = classifyOrphanReservations({
      reservations: [throwingGetter, hostileProxy, reservation({ id: 'res-after-hostile' })],
      runs: [],
      runStates: new Map(),
      attemptsById: new Map(),
      nowIso: NOW,
      graceMs: GRACE_MS,
    });
    // The hostile elements are malformed (never released) and the well-formed one after them still classifies.
    expect(result.unknown.map((entry) => entry.reason)).toEqual(['malformed-reservation', 'malformed-reservation']);
    expect(result.reportOnly.map((entry) => entry.reservationId)).toEqual(['res-after-hostile']);
  });

  it('handles hostile inputs and malformed reservations without throwing: prototype-polluting own keys', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const hostile: Record<string, unknown> = { id: 'res-evil', attemptId: 'att-1', held: true, reservedAtIso: NOW };
      Object.defineProperty(hostile, key, { value: {}, enumerable: true, configurable: true });
      const result = classify([hostile], []);
      expect(result.unknown.map((entry) => entry.reason)).toEqual(['malformed-reservation']);
      expect(result.orphans).toHaveLength(0);
    }
  });

  it('handles hostile inputs and malformed reservations without throwing: a lying or enormous length', () => {
    const lying: Record<string, unknown>[] = [reservation({ id: 'res-lying' })];
    Object.defineProperty(lying, 'length', { value: 2 ** 32 - 1 });
    const result = classifyOrphanReservations({
      reservations: lying,
      runs: [],
      runStates: new Map(),
      attemptsById: new Map(),
      nowIso: NOW,
      graceMs: GRACE_MS,
    });
    // Bounded: the single well-formed record classifies and nothing loops forever.
    expect(result.reportOnly.map((entry) => entry.reservationId)).toEqual(['res-lying']);

    const huge: unknown[] = new Array(MAX_ORPHAN_RESERVATION_SCAN + 5_000);
    for (let index = 0; index < huge.length; index += 1) {
      huge[index] = reservation({ id: `res-huge-${index}`, reservedAtIso: '2026-11-16T10:00:00.000Z' });
    }
    const bounded = classifyOrphanReservations({
      reservations: huge,
      runs: [],
      runStates: new Map(),
      attemptsById: new Map(),
      nowIso: NOW,
      graceMs: GRACE_MS,
    });
    // Past MAX_ORPHAN_RESERVATION_SCAN the rest is ignored, never classified or released.
    expect(bounded.reportOnly).toHaveLength(MAX_ORPHAN_RESERVATION_SCAN);
  });

  it('bounds a hostile runs array by MAX_RUN_SCAN', () => {
    const runs: unknown[] = [];
    for (let index = 0; index < MAX_RUN_SCAN + 5_000; index += 1) {
      runs.push(run(`run-${index}`, ['att-1']));
    }
    const result = classifyOrphanReservations({
      reservations: [reservation()],
      runs,
      runStates: new Map(),
      attemptsById: new Map(),
      nowIso: NOW,
      graceMs: GRACE_MS,
    });
    // Bounded loop: the attempt is listed by runs inside the bound, all without states, so unknown.
    expect(result.unknown[0]?.reason).toBe('run-state-unknown');
  });

  it('treats a non-finite or negative graceMs as within-grace for every no-run reservation', () => {
    for (const graceMs of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const result = classifyOrphanReservations({
        reservations: [reservation({ id: 'res-grace', reservedAtIso: '2020-01-01T00:00:00.000Z' })],
        runs: [],
        runStates: new Map(),
        attemptsById: new Map(),
        nowIso: NOW,
        graceMs,
      });
      expect(result.skipped[0]?.reason).toBe('within-grace');
      expect(result.reportOnly).toHaveLength(0);
    }
  });

  it('releases on a terminal run only through the whole rule: terminal runs, capacity-release attempt', () => {
    // A non-terminal attempt on a terminal run and a terminal attempt on a
    // non-terminal run are both skipped; only the full conjunction releases.
    const nonTerminalAttempt = classify([reservation({ id: 'res-1' })], [run('run-1', ['att-1'])], {
      runStates: new Map([['run-1', 'merged']]),
      attemptsById: new Map([['att-1', { state: 'blocked' }]]),
    });
    expect(nonTerminalAttempt.orphans).toHaveLength(0);
    expect(nonTerminalAttempt.skipped[0]?.reason).toBe('attempt-live');

    const nonTerminalRun = classify([reservation({ id: 'res-2' })], [run('run-1', ['att-1'])], {
      runStates: new Map([['run-1', 'gating']]),
      attemptsById: new Map([['att-1', { state: 'collected' }]]),
    });
    expect(nonTerminalRun.orphans).toHaveLength(0);
    expect(nonTerminalRun.skipped[0]?.reason).toBe('live-run');

    const both = classify([reservation({ id: 'res-3' })], [run('run-1', ['att-1'])], {
      runStates: new Map([['run-1', 'stopped']]),
      attemptsById: new Map([['att-1', { state: 'cancelled' }]]),
    });
    expect(both.orphans).toHaveLength(1);
    expect(both.orphans[0]?.reason).toBe('terminal-run');
  });
});
