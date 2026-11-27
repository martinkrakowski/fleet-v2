import { describe, expect, it } from 'vitest';
import { types } from 'node:util';

import {
  LANE_DECLARATION_SNAPSHOT_LIMITS,
  LANE_DECLARATION_RECORD_VERSION,
  LANE_BRIEF_READ_RECORD_VERSION,
  isBriefReadRecord,
  isLaneDeclarationRecord,
  parseBriefReadBody,
  parseLaneDeclarationBody,
} from '../lane-activity-records.js';
import { WORK_BOARD_SCHEMA_VERSION } from '../work-board-facts.js';
import type { LaneRef } from '../work-board-facts.js';

const NOW = '2026-10-27T10:00:00.000Z';
const LANE: LaneRef = { kind: 'plan', projectId: 'example-project', planId: 'plan-1', laneId: 'lane-1' };

function declarationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { lane: LANE, step: 'gate', seatRole: 'builder', model: 'example-model', ...overrides };
}

function briefReadBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lane: LANE,
    path: 'docs/plans/plan-1/lane-1.brief.md',
    outcome: 'read',
    sha256: 'a'.repeat(64),
    bytes: 42,
    ...overrides,
  };
}

/** A Proxy the detector must refuse and whose traps must never run. */
function proxyOver(value: unknown): unknown {
  return new Proxy(value as object, {
    get() {
      throw new Error('proxy trap ran');
    },
    getOwnPropertyDescriptor() {
      throw new Error('proxy trap ran');
    },
    ownKeys() {
      throw new Error('proxy trap ran');
    },
  });
}

function throwingGetterBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { ...declarationBody(), ...extra };
  Object.defineProperty(body, 'seatRole', {
    enumerable: true,
    get() {
      throw new Error('getter ran');
    },
  });
  return body;
}

describe('parseLaneDeclarationBody', () => {
  it('builds the record from the clock, never the body', () => {
    const parsed = parseLaneDeclarationBody(declarationBody(), NOW, 90, types.isProxy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record).toEqual({
      version: LANE_DECLARATION_RECORD_VERSION,
      lane: LANE,
      step: 'gate',
      seatRole: 'builder',
      model: 'example-model',
      declaredAtIso: NOW,
      lapsesAtIso: '2026-10-27T11:30:00.000Z',
      outcome: null,
    });
  });

  it('normalizes an omitted outcome and an explicit null outcome to null', () => {
    const omitted = parseLaneDeclarationBody(declarationBody({ step: 'brief' }), NOW, 90, types.isProxy);
    const explicitNull = parseLaneDeclarationBody(declarationBody({ step: 'brief', outcome: null }), NOW, 90, types.isProxy);
    expect(omitted.ok).toBe(true);
    expect(explicitNull.ok).toBe(true);
    if (!omitted.ok || !explicitNull.ok) return;
    expect(omitted.record.outcome).toBeNull();
    expect(explicitNull.record.outcome).toBeNull();
  });

  it('accepts every allowed outcome token of the brief, train and pr steps', () => {
    const briefOutcomes = ['writing', 'written', 'in-review', 'changes-requested', 'reviewed', 'failed'];
    for (const outcome of briefOutcomes) {
      const parsed = parseLaneDeclarationBody(declarationBody({ step: 'brief', outcome }), NOW, 90, types.isProxy);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.record.outcome).toBe(outcome);
    }
    for (const outcome of ['queued', 'at-head', 'retrying', 'parked', 'merged']) {
      const parsed = parseLaneDeclarationBody(declarationBody({ step: 'train', outcome }), NOW, 90, types.isProxy);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.record.outcome).toBe(outcome);
    }
    for (const outcome of ['opened', 'merged', 'closed']) {
      const parsed = parseLaneDeclarationBody(declarationBody({ step: 'pr', outcome }), NOW, 90, types.isProxy);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.record.outcome).toBe(outcome);
    }
  });

  it('refuses non-object declaration bodies', () => {
    for (const body of [null, undefined, 'gate', 42, true, [], ['gate']]) {
      expect(parseLaneDeclarationBody(body, NOW, 90, types.isProxy)).toEqual({
        ok: false,
        code: 'refused',
        error: 'body must be plain data',
      });
    }
    // An array-like plain object carries an unexpected `length` key, so the
    // key-set rule refuses it with the same typed `refused` code.
    const arrayLike = { length: 3, 0: 'a', 1: 'b', 2: 'c' };
    const arrayLikeResult = parseLaneDeclarationBody(arrayLike, NOW, 90, types.isProxy);
    expect(arrayLikeResult).toMatchObject({ ok: false, code: 'refused' });
  });

  it('refuses a Proxy declaration body and a nested Proxy lane without running any trap', () => {
    expect(parseLaneDeclarationBody(proxyOver(declarationBody()), NOW, 90, types.isProxy)).toEqual({
      ok: false,
      code: 'refused',
      error: 'body must be plain data',
    });
    const nestedProxyLane = declarationBody({ lane: proxyOver(LANE) });
    expect(parseLaneDeclarationBody(nestedProxyLane, NOW, 90, types.isProxy)).toEqual({
      ok: false,
      code: 'refused',
      error: 'body must be plain data',
    });
  });

  it('refuses getter properties without invoking them', () => {
    const seen: string[] = [];
    const body: Record<string, unknown> = { ...declarationBody() };
    Object.defineProperty(body, 'seatRole', {
      enumerable: true,
      get() {
        seen.push('seatRole');
        return 'builder';
      },
    });
    const parsed = parseLaneDeclarationBody(body, NOW, 90, types.isProxy);
    expect(parsed).toEqual({ ok: false, code: 'refused', error: 'body must be plain data' });
    expect(seen).toEqual([]);
    expect(parseLaneDeclarationBody(throwingGetterBody(), NOW, 90, types.isProxy).ok).toBe(false);
  });

  it('refuses prototype-polluting and extra keys', () => {
    for (const polluter of ['__proto__', 'constructor', 'prototype']) {
      const body = { ...declarationBody(), [polluter]: 'x' };
      // `__proto__` set in an object literal is not an own key, so define it.
      const defined = { ...declarationBody() };
      Object.defineProperty(defined, polluter, { value: 'x', enumerable: true, writable: true, configurable: true });
      expect(parseLaneDeclarationBody(polluter === '__proto__' ? defined : body, NOW, 90, types.isProxy)).toEqual({
        ok: false,
        code: 'refused',
        error: 'body must be plain data',
      });
    }
    expect(parseLaneDeclarationBody({ ...declarationBody(), extra: 1 }, NOW, 90, types.isProxy)).toEqual({
      ok: false,
      code: 'refused',
      error: 'body must have the keys lane, step, seatRole and model, with an optional outcome',
    });
    const symbolKey = { ...declarationBody() } as Record<string | symbol, unknown>;
    symbolKey[Symbol('extra')] = 1;
    expect(parseLaneDeclarationBody(symbolKey, NOW, 90, types.isProxy)).toEqual({
      ok: false,
      code: 'refused',
      error: 'body must be plain data',
    });
    const hidden: Record<string, unknown> = { ...declarationBody() };
    Object.defineProperty(hidden, 'hidden', { value: 1, enumerable: false });
    expect(parseLaneDeclarationBody(hidden, NOW, 90, types.isProxy)).toEqual({
      ok: false,
      code: 'refused',
      error: 'body must be plain data',
    });
  });

  it('refuses an unknown declaration step with unknown-step', () => {
    expect(parseLaneDeclarationBody(declarationBody({ step: 'merge' }), NOW, 90, types.isProxy)).toEqual({
      ok: false,
      code: 'unknown-step',
      error: 'unknown declaration step',
    });
    expect(parseLaneDeclarationBody(declarationBody({ step: 42 }), NOW, 90, types.isProxy)).toEqual({
      ok: false,
      code: 'unknown-step',
      error: 'unknown declaration step',
    });
  });

  it('refuses an unknown or disallowed outcome with unknown-outcome', () => {
    expect(parseLaneDeclarationBody(declarationBody({ step: 'brief', outcome: 'shipped' }), NOW, 90, types.isProxy)).toEqual({
      ok: false,
      code: 'unknown-outcome',
      error: 'unknown or disallowed declaration outcome',
    });
    expect(parseLaneDeclarationBody(declarationBody({ step: 'pr', outcome: 'at-head' }), NOW, 90, types.isProxy)).toEqual({
      ok: false,
      code: 'unknown-outcome',
      error: 'unknown or disallowed declaration outcome',
    });
    expect(parseLaneDeclarationBody(declarationBody({ step: 'gate', outcome: 'reviewed' }), NOW, 90, types.isProxy)).toEqual({
      ok: false,
      code: 'unknown-outcome',
      error: 'unknown or disallowed declaration outcome',
    });
    expect(parseLaneDeclarationBody(declarationBody({ step: 'brief', outcome: 7 }), NOW, 90, types.isProxy)).toEqual({
      ok: false,
      code: 'unknown-outcome',
      error: 'unknown or disallowed declaration outcome',
    });
  });

  it('refuses a wrong key set', () => {
    const extra = { ...declarationBody(), declaredAtIso: NOW };
    expect(parseLaneDeclarationBody(extra, NOW, 90, types.isProxy)).toEqual({
      ok: false,
      code: 'refused',
      error: 'body must have the keys lane, step, seatRole and model, with an optional outcome',
    });
    expect(parseLaneDeclarationBody({}, NOW, 90, types.isProxy).ok).toBe(false);
  });

  it('refuses a non-canonical clock time and a body-supplied time is ignored', () => {
    expect(parseLaneDeclarationBody(declarationBody(), '2026-10-27T10:00:00Z', 90, types.isProxy)).toEqual({
      ok: false,
      code: 'refused',
      error: 'invalid nowIso',
    });
    expect(parseLaneDeclarationBody(declarationBody(), 'not-a-time', 90, types.isProxy)).toEqual({
      ok: false,
      code: 'refused',
      error: 'invalid nowIso',
    });
  });

  it('refuses a control character in seatRole', () => {
    expect(parseLaneDeclarationBody(declarationBody({ seatRole: 'build\u0000er' }), NOW, 90, types.isProxy)).toEqual({
      ok: false,
      code: 'refused',
      error: 'invalid seatRole',
    });
    expect(parseLaneDeclarationBody(declarationBody({ seatRole: 'two\nlines' }), NOW, 90, types.isProxy)).toEqual({
      ok: false,
      code: 'refused',
      error: 'invalid seatRole',
    });
  });

  it('refuses an over-long model', () => {
    expect(parseLaneDeclarationBody(declarationBody({ model: 'm'.repeat(121) }), NOW, 90, types.isProxy)).toEqual({
      ok: false,
      code: 'refused',
      error: 'invalid model',
    });
  });

  it('refuses C1 controls and line separators in seatRole', () => {
    for (const seatRole of ['build\u0080er', 'build\u0085er', 'build\u009fer', 'build\u2028er', 'build\u2029er', 'build\u007fer']) {
      expect(parseLaneDeclarationBody(declarationBody({ seatRole }), NOW, 90, types.isProxy)).toEqual({
        ok: false,
        code: 'refused',
        error: 'invalid seatRole',
      });
    }
  });

  it('refuses C1 controls and line separators in model', () => {
    for (const model of ['build\u0080er', 'build\u0085er', 'build\u009fer', 'build\u2028er', 'build\u2029er', 'build\u007fer']) {
      expect(parseLaneDeclarationBody(declarationBody({ model }), NOW, 90, types.isProxy)).toEqual({
        ok: false,
        code: 'refused',
        error: 'invalid model',
      });
    }
  });

  it('accepts non-control neighbours in seatRole', () => {
    expect(parseLaneDeclarationBody(declarationBody({ seatRole: 'build\u00a0er' }), NOW, 90, types.isProxy).ok).toBe(true);
    expect(parseLaneDeclarationBody(declarationBody({ seatRole: 'builder-\u00e9' }), NOW, 90, types.isProxy).ok).toBe(true);
  });

  it('bounds a work-order lane workOrderId by UTF-8 bytes', () => {
    const workOrderLane = (workOrderId: string): LaneRef => ({ kind: 'work-order', projectId: 'example-project', workOrderId });
    expect(parseLaneDeclarationBody(declarationBody({ lane: workOrderLane('\u00e9'.repeat(128)) }), NOW, 90, types.isProxy).ok).toBe(true);
    for (const workOrderId of ['\u00e9'.repeat(129), 'a' + '\u00e9'.repeat(128), 'a\u0085b']) {
      expect(parseLaneDeclarationBody(declarationBody({ lane: workOrderLane(workOrderId) }), NOW, 90, types.isProxy)).toEqual({
        ok: false,
        code: 'refused',
        error: 'invalid lane',
      });
    }
  });

  it('refuses an invalid ttlMinutes', () => {
    expect(parseLaneDeclarationBody(declarationBody(), NOW, 0, types.isProxy)).toEqual({
      ok: false,
      code: 'refused',
      error: 'invalid ttlMinutes',
    });
    expect(parseLaneDeclarationBody(declarationBody(), NOW, Number.MAX_SAFE_INTEGER, types.isProxy)).toEqual({
      ok: false,
      code: 'refused',
      error: 'invalid ttlMinutes',
    });
  });

  it('refuses a TTL that puts the lapse past 9999-12-31', () => {
    expect(parseLaneDeclarationBody(declarationBody(), NOW, 5_000_000_000, types.isProxy)).toEqual({
      ok: false,
      code: 'refused',
      error: 'invalid ttlMinutes',
    });
  });

  it('refuses a lane ref with extra properties and stores a fresh ref', () => {
    const extraLane = { ...LANE, surprise: 'x' };
    const parsed = parseLaneDeclarationBody(declarationBody({ lane: extraLane }), NOW, 90, types.isProxy);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe('invalid lane');
  });

  it('refuses a canonical-shaped clock time that is not a valid date', () => {
    expect(parseLaneDeclarationBody(declarationBody(), '9999-99-99T99:99:99.999Z', 90, types.isProxy)).toEqual({
      ok: false,
      code: 'refused',
      error: 'invalid nowIso',
    });
    expect(parseBriefReadBody(briefReadBody(), '9999-99-99T99:99:99.999Z')).toEqual({
      ok: false,
      error: 'invalid nowIso',
    });
  });

  it('refuses an impossible calendar date that Date.parse would normalize', () => {
    // 2026-02-30 and 2026-02-29 (not a leap year) parse to a finite value but
    // normalize to a different instant, so they are not canonical.
    expect(parseLaneDeclarationBody(declarationBody(), '2026-02-30T00:00:00.000Z', 90, types.isProxy)).toEqual({
      ok: false,
      code: 'refused',
      error: 'invalid nowIso',
    });
    expect(parseBriefReadBody(briefReadBody(), '2026-02-30T00:00:00.000Z')).toEqual({
      ok: false,
      error: 'invalid nowIso',
    });
    expect(parseLaneDeclarationBody(declarationBody(), '2026-02-29T00:00:00.000Z', 90, types.isProxy)).toEqual({
      ok: false,
      code: 'refused',
      error: 'invalid nowIso',
    });
  });

  it('refuses an enormous body the snapshot bounds refuse', () => {
    const big = { ...declarationBody(), seatRole: 'b'.repeat(600) };
    // The string itself exceeds maxStringLength, so the snapshot refuses before
    // the field validator sees it.
    expect(parseLaneDeclarationBody(big, NOW, 90, types.isProxy)).toEqual({
      ok: false,
      code: 'refused',
      error: 'body must be plain data',
    });
    expect(LANE_DECLARATION_SNAPSHOT_LIMITS.maxStringLength).toBe(512);
    expect(Object.isFrozen(LANE_DECLARATION_SNAPSHOT_LIMITS)).toBe(true);
  });
});

describe('isLaneDeclarationRecord', () => {
  const base = {
    version: LANE_DECLARATION_RECORD_VERSION,
    lane: LANE,
    step: 'gate',
    seatRole: 'builder',
    model: 'example-model',
    declaredAtIso: NOW,
    lapsesAtIso: '2026-10-27T11:30:00.000Z',
  };

  it('accepts a valid record with and without an outcome (pre-LB4 records stay valid)', () => {
    expect(isLaneDeclarationRecord(base, types.isProxy)).toBe(true);
    expect(isLaneDeclarationRecord({ ...base, outcome: null }, types.isProxy)).toBe(true);
    expect(isLaneDeclarationRecord({ ...base, step: 'brief', outcome: 'reviewed' }, types.isProxy)).toBe(true);
    expect(isLaneDeclarationRecord({ ...base, step: 'train', outcome: 'at-head' }, types.isProxy)).toBe(true);
    expect(isLaneDeclarationRecord({ ...base, step: 'pr', outcome: 'merged' }, types.isProxy)).toBe(true);
  });

  it('refuses hostile inputs', () => {
    for (const value of [null, undefined, 'gate', 42, true, [], ['x'], { length: 2, 0: 'a' }]) {
      expect(isLaneDeclarationRecord(value, types.isProxy)).toBe(false);
    }
    expect(isLaneDeclarationRecord(proxyOver(base), types.isProxy)).toBe(false);
    const getter: Record<string, unknown> = { ...base };
    const seen: string[] = [];
    Object.defineProperty(getter, 'seatRole', {
      enumerable: true,
      get() {
        seen.push('seatRole');
        return 'builder';
      },
    });
    expect(isLaneDeclarationRecord(getter, types.isProxy)).toBe(false);
    expect(seen).toEqual([]);
    const holed: unknown[] = new Array(3);
    expect(isLaneDeclarationRecord(holed, types.isProxy)).toBe(false);
    const polluted: Record<string, unknown> = { ...base };
    Object.defineProperty(polluted, '__proto__', { value: 'x', enumerable: true, configurable: true });
    expect(isLaneDeclarationRecord(polluted, types.isProxy)).toBe(false);
    expect(isLaneDeclarationRecord({ ...base, extra: 1 }, types.isProxy)).toBe(false);
    expect(isLaneDeclarationRecord({ ...base, declaredAtIso: 'nope' }, types.isProxy)).toBe(false);
  });

  it('refuses an unknown step, an unknown outcome and a present undefined outcome', () => {
    expect(isLaneDeclarationRecord({ ...base, step: 'merge' }, types.isProxy)).toBe(false);
    expect(isLaneDeclarationRecord({ ...base, step: 'brief', outcome: 'shipped' }, types.isProxy)).toBe(false);
    expect(isLaneDeclarationRecord({ ...base, step: 'gate', outcome: 'reviewed' }, types.isProxy)).toBe(false);
    expect(isLaneDeclarationRecord({ ...base, step: 'brief', outcome: undefined }, types.isProxy)).toBe(false);
  });
});

describe('parseBriefReadBody', () => {
  it('builds the record from the clock with the digest and byte count', () => {
    const parsed = parseBriefReadBody(briefReadBody(), NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record).toEqual({
      version: LANE_BRIEF_READ_RECORD_VERSION,
      lane: LANE,
      path: 'docs/plans/plan-1/lane-1.brief.md',
      outcome: 'read',
      sha256: 'a'.repeat(64),
      bytes: 42,
      readAtIso: NOW,
    });
  });

  it('refuses a read without a valid sha256 or bytes', () => {
    expect(parseBriefReadBody(briefReadBody({ sha256: 'zz' }), NOW)).toEqual({
      ok: false,
      error: 'invalid sha256',
    });
    expect(parseBriefReadBody(briefReadBody({ bytes: -1 }), NOW)).toEqual({
      ok: false,
      error: 'invalid bytes',
    });
  });

  it('forces null digest and byte count on a failed read, ignoring the body values', () => {
    const parsed = parseBriefReadBody(
      briefReadBody({ outcome: 'failed', sha256: 'b'.repeat(64), bytes: 7 }),
      NOW,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.sha256).toBeNull();
    expect(parsed.record.bytes).toBeNull();
  });

  it('refuses a wrong key set, a bad path and a non-canonical clock', () => {
    expect(parseBriefReadBody({ ...briefReadBody(), extra: 1 }, NOW)).toEqual({
      ok: false,
      error: 'body must have exactly the keys lane, path, outcome, sha256 and bytes',
    });
    expect(parseBriefReadBody(briefReadBody({ path: 'x'.repeat(257) }), NOW)).toEqual({
      ok: false,
      error: 'invalid path',
    });
    expect(parseBriefReadBody(briefReadBody(), 'nope')).toEqual({
      ok: false,
      error: 'invalid nowIso',
    });
  });

  it('bounds path length by UTF-8 bytes', () => {
    const acceptedPaths = [
      'x'.repeat(256),
      '\u00e9'.repeat(128),
      'aa' + '\u00e9'.repeat(127),
      '\u20ac'.repeat(85) + 'a',
      '\ud83d\ude00'.repeat(64),
    ];
    for (const path of acceptedPaths) {
      expect(parseBriefReadBody(briefReadBody({ path }), NOW).ok).toBe(true);
    }
    const refusedPaths = [
      '\u00e9'.repeat(129),
      'a' + '\u00e9'.repeat(128),
      '\u20ac'.repeat(85) + 'aa',
      '\ud83d\ude00'.repeat(64) + 'a',
    ];
    for (const path of refusedPaths) {
      expect(parseBriefReadBody(briefReadBody({ path }), NOW)).toEqual({
        ok: false,
        error: 'invalid path',
      });
    }
  });

  it('refuses C1 controls and line separators in path', () => {
    const paths = ['docs/a\u0080b', 'docs/a\u0085b', 'docs/a\u009fb', 'docs/a\u2028b', 'docs/a\u2029b', 'docs/a\u007fb', 'docs/a\u0000b', 'docs/a\nb'];
    for (const path of paths) {
      expect(parseBriefReadBody(briefReadBody({ path }), NOW)).toEqual({
        ok: false,
        error: 'invalid path',
      });
    }
  });

  it('accepts NBSP and other non-control unicode in path', () => {
    expect(parseBriefReadBody(briefReadBody({ path: 'docs/a\u00a0b' }), NOW).ok).toBe(true);
  });

  it('refuses a failed read whose path has controls or exceeds the byte bound', () => {
    for (const path of ['docs/a\u0085b', '\u00e9'.repeat(129)]) {
      expect(parseBriefReadBody(briefReadBody({ path, outcome: 'failed', sha256: null, bytes: null }), NOW)).toEqual({
        ok: false,
        error: 'invalid path',
      });
    }
  });
});

describe('isBriefReadRecord', () => {
  const base = {
    version: LANE_BRIEF_READ_RECORD_VERSION,
    lane: LANE,
    path: 'docs/plans/plan-1/lane-1.brief.md',
    readAtIso: '2026-10-27T10:00:00.000Z',
  };

  it('accepts a read record with digest and byte count, and a failed record with both null', () => {
    expect(isBriefReadRecord({ ...base, outcome: 'read', sha256: 'a'.repeat(64), bytes: 42 })).toBe(true);
    expect(isBriefReadRecord({ ...base, outcome: 'failed', sha256: null, bytes: null })).toBe(true);
  });

  it('refuses a read without a digest or byte count, and a failed record carrying either', () => {
    expect(isBriefReadRecord({ ...base, outcome: 'read', sha256: null, bytes: 42 })).toBe(false);
    expect(isBriefReadRecord({ ...base, outcome: 'read', sha256: 'a'.repeat(64), bytes: null })).toBe(false);
    expect(isBriefReadRecord({ ...base, outcome: 'failed', sha256: 'a'.repeat(64), bytes: null })).toBe(false);
    expect(isBriefReadRecord({ ...base, outcome: 'failed', sha256: null, bytes: 42 })).toBe(false);
  });

  it('refuses a lane ref with extra properties', () => {
    expect(
      isBriefReadRecord({
        ...base,
        lane: { ...LANE, extra: 1 },
        outcome: 'read',
        sha256: 'a'.repeat(64),
        bytes: 42,
      }),
    ).toBe(false);
  });

  it('bounds path by UTF-8 bytes and refuses C1 controls', () => {
    expect(isBriefReadRecord({ ...base, path: '\u00e9'.repeat(128), outcome: 'read', sha256: 'a'.repeat(64), bytes: 42 })).toBe(true);
    expect(isBriefReadRecord({ ...base, path: '\u00e9'.repeat(129), outcome: 'read', sha256: 'a'.repeat(64), bytes: 42 })).toBe(false);
    expect(isBriefReadRecord({ ...base, path: 'a' + '\u00e9'.repeat(128), outcome: 'read', sha256: 'a'.repeat(64), bytes: 42 })).toBe(false);
    expect(isBriefReadRecord({ ...base, path: 'docs/a\u0085b', outcome: 'read', sha256: 'a'.repeat(64), bytes: 42 })).toBe(false);
    expect(isBriefReadRecord({ ...base, path: 'docs/a\u2028b', outcome: 'read', sha256: 'a'.repeat(64), bytes: 42 })).toBe(false);
  });
});

describe('work-board declaration schema (imported from the package barrel)', () => {
  it('exports the bumped schema version and the new declaration symbols from @fleet/work-execution', { timeout: 60_000 }, async () => {
    const barrel = await import('@fleet/work-execution');
    expect(WORK_BOARD_SCHEMA_VERSION).toBe(2);
    expect(barrel.WORK_BOARD_SCHEMA_VERSION).toBe(2);
    expect(barrel.LANE_DECLARATION_SNAPSHOT_LIMITS).toEqual(LANE_DECLARATION_SNAPSHOT_LIMITS);
    expect(barrel.isDeclarationStep('brief')).toBe(true);
    expect(barrel.isDeclarationStep('merge')).toBe(false);
    expect(barrel.isAllowedDeclarationOutcome('brief', 'reviewed')).toBe(true);
    expect(barrel.isAllowedDeclarationOutcome('gate', 'reviewed')).toBe(false);
    expect(barrel.isAllowedDeclarationOutcome('gate', null)).toBe(true);
  });
});
