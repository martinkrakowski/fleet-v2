import { describe, expect, it } from 'vitest';

import type { LaneRef } from '../work-board-facts.js';
import {
  LANE_DECLARATION_RECORD_VERSION,
  LANE_BRIEF_READ_RECORD_VERSION,
  isBriefReadRecord,
  parseBriefReadBody,
  parseLaneDeclarationBody,
} from '../lane-activity-records.js';

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

describe('parseLaneDeclarationBody', () => {
  it('builds the record from the clock, never the body', () => {
    const parsed = parseLaneDeclarationBody(declarationBody(), NOW, 90);
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
    });
  });

  it('refuses a wrong key set', () => {
    const extra = { ...declarationBody(), declaredAtIso: NOW };
    expect(parseLaneDeclarationBody(extra, NOW, 90)).toEqual({
      ok: false,
      error: 'body must have exactly the keys lane, step, seatRole and model',
    });
    expect(parseLaneDeclarationBody({}, NOW, 90).ok).toBe(false);
  });

  it('refuses a non-canonical clock time and a body-supplied time is ignored', () => {
    expect(parseLaneDeclarationBody(declarationBody(), '2026-10-27T10:00:00Z', 90)).toEqual({
      ok: false,
      error: 'invalid nowIso',
    });
    expect(parseLaneDeclarationBody(declarationBody(), 'not-a-time', 90)).toEqual({
      ok: false,
      error: 'invalid nowIso',
    });
  });

  it('refuses an unknown step', () => {
    expect(parseLaneDeclarationBody(declarationBody({ step: 'merge' }), NOW, 90)).toEqual({
      ok: false,
      error: 'invalid step',
    });
  });

  it('refuses a control character in seatRole', () => {
    expect(parseLaneDeclarationBody(declarationBody({ seatRole: 'build\u0000er' }), NOW, 90)).toEqual({
      ok: false,
      error: 'invalid seatRole',
    });
    expect(parseLaneDeclarationBody(declarationBody({ seatRole: 'two\nlines' }), NOW, 90)).toEqual({
      ok: false,
      error: 'invalid seatRole',
    });
  });

  it('refuses an over-long model', () => {
    expect(parseLaneDeclarationBody(declarationBody({ model: 'm'.repeat(121) }), NOW, 90)).toEqual({
      ok: false,
      error: 'invalid model',
    });
  });

  it('refuses C1 controls and line separators in seatRole', () => {
    for (const seatRole of ['build\u0080er', 'build\u0085er', 'build\u009fer', 'build\u2028er', 'build\u2029er', 'build\u007fer']) {
      expect(parseLaneDeclarationBody(declarationBody({ seatRole }), NOW, 90)).toEqual({
        ok: false,
        error: 'invalid seatRole',
      });
    }
  });

  it('refuses C1 controls and line separators in model', () => {
    for (const model of ['build\u0080er', 'build\u0085er', 'build\u009fer', 'build\u2028er', 'build\u2029er', 'build\u007fer']) {
      expect(parseLaneDeclarationBody(declarationBody({ model }), NOW, 90)).toEqual({
        ok: false,
        error: 'invalid model',
      });
    }
  });

  it('accepts non-control neighbours in seatRole', () => {
    expect(parseLaneDeclarationBody(declarationBody({ seatRole: 'build\u00a0er' }), NOW, 90).ok).toBe(true);
    expect(parseLaneDeclarationBody(declarationBody({ seatRole: 'builder-\u00e9' }), NOW, 90).ok).toBe(true);
  });

  it('bounds a work-order lane workOrderId by UTF-8 bytes', () => {
    const workOrderLane = (workOrderId: string): LaneRef => ({ kind: 'work-order', projectId: 'example-project', workOrderId });
    expect(parseLaneDeclarationBody(declarationBody({ lane: workOrderLane('\u00e9'.repeat(128)) }), NOW, 90).ok).toBe(true);
    for (const workOrderId of ['\u00e9'.repeat(129), 'a' + '\u00e9'.repeat(128), 'a\u0085b']) {
      expect(parseLaneDeclarationBody(declarationBody({ lane: workOrderLane(workOrderId) }), NOW, 90)).toEqual({
        ok: false,
        error: 'invalid lane',
      });
    }
  });

  it('refuses an invalid ttlMinutes', () => {
    expect(parseLaneDeclarationBody(declarationBody(), NOW, 0)).toEqual({
      ok: false,
      error: 'invalid ttlMinutes',
    });
    expect(parseLaneDeclarationBody(declarationBody(), NOW, Number.MAX_SAFE_INTEGER)).toEqual({
      ok: false,
      error: 'invalid ttlMinutes',
    });
  });

  it('refuses a TTL that puts the lapse past 9999-12-31', () => {
    expect(parseLaneDeclarationBody(declarationBody(), NOW, 5_000_000_000)).toEqual({
      ok: false,
      error: 'invalid ttlMinutes',
    });
  });

  it('refuses a lane ref with extra properties and stores a fresh ref', () => {
    const extraLane = { ...LANE, surprise: 'x' };
    const parsed = parseLaneDeclarationBody(declarationBody({ lane: extraLane }), NOW, 90);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe('invalid lane');
  });

  it('refuses a canonical-shaped clock time that is not a valid date', () => {
    expect(parseLaneDeclarationBody(declarationBody(), '9999-99-99T99:99:99.999Z', 90)).toEqual({
      ok: false,
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
    expect(parseLaneDeclarationBody(declarationBody(), '2026-02-30T00:00:00.000Z', 90)).toEqual({
      ok: false,
      error: 'invalid nowIso',
    });
    expect(parseBriefReadBody(briefReadBody(), '2026-02-30T00:00:00.000Z')).toEqual({
      ok: false,
      error: 'invalid nowIso',
    });
    expect(parseLaneDeclarationBody(declarationBody(), '2026-02-29T00:00:00.000Z', 90)).toEqual({
      ok: false,
      error: 'invalid nowIso',
    });
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
