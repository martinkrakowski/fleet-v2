import { describe, expect, it, vi } from 'vitest';

import {
  CUTOVER_ROLLBACK_WINDOW_MS,
  CUTOVER_RECORD_SCHEMA_VERSION,
  CUTOVER_SHADOW_CRITERIA,
  canonicalCutoverRetirePayload,
  canonicalCutoverRollbackPayload,
  canonicalCutoverSwitchPayload,
  cutoverJournalKey,
  isWithinCutoverRollbackWindow,
  readCutoverRecord,
  readCutoverShadowEvidence,
} from '../cutover-records.js';

const DIGEST = 'a'.repeat(64);
const SWITCHED = '2026-11-01T10:00:00.000Z';
const LATER = '2026-11-02T10:00:00.000Z';
const NOW = '2026-11-05T12:00:00.000Z';
const DAY_MS = 86_400_000;

function shadow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revision: 1,
    state: 'shadow',
    updatedAtIso: SWITCHED,
    switchedAtIso: null,
    rolledBackAtIso: null,
    retiredAtIso: null,
    relaunchPlanDigest: null,
    trainPauseSetByCutover: false,
    ...overrides,
  };
}

function switched(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return shadow({
    state: 'switched',
    switchedAtIso: SWITCHED,
    relaunchPlanDigest: DIGEST,
    trainPauseSetByCutover: true,
    ...overrides,
  });
}

describe('readCutoverRecord', () => {
  it('reads an absent schemaVersion as 1 and accepts an explicit 1', () => {
    const absent = readCutoverRecord(shadow());
    expect(absent).toEqual({ ok: true, record: { schemaVersion: CUTOVER_RECORD_SCHEMA_VERSION, ...shadow() } });
    expect(readCutoverRecord(shadow({ schemaVersion: 1 })).ok).toBe(true);
  });

  it('reports a newer schemaVersion as unknown-version and garbage versions as invalid', () => {
    expect(readCutoverRecord(shadow({ schemaVersion: 2 }))).toEqual({ ok: false, reason: 'unknown-version' });
    expect(readCutoverRecord(shadow({ schemaVersion: 99 }))).toEqual({ ok: false, reason: 'unknown-version' });
    for (const bad of [0, -1, 1.5, '1', null, true]) {
      expect(readCutoverRecord(shadow({ schemaVersion: bad }))).toEqual({ ok: false, reason: 'invalid-record' });
    }
  });

  it('refuses non-records, getters, extra keys, symbols and non-plain prototypes without throwing', () => {
    for (const bad of [null, undefined, 'str', 7, [], new Array(2), new Date(), Object.create({ revision: 1 })]) {
      expect(readCutoverRecord(bad)).toEqual({ ok: false, reason: 'invalid-record' });
    }
    const withGetter = shadow();
    Object.defineProperty(withGetter, 'revision', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(readCutoverRecord(withGetter).ok).toBe(false);
    expect(readCutoverRecord(shadow({ extra: 1 })).ok).toBe(false);
    expect(readCutoverRecord({ ...shadow(), [Symbol('x')]: 1 }).ok).toBe(false);
    const missing = shadow();
    delete missing.state;
    expect(readCutoverRecord(missing).ok).toBe(false);
  });

  it('refuses wrong-typed and out-of-range fields', () => {
    for (const overrides of [
      { revision: 0 },
      { revision: 1.5 },
      { revision: 1_000_000_001 },
      { revision: '1' },
      { state: 'unknown' },
      { updatedAtIso: 'yesterday' },
      { updatedAtIso: '2026-02-31T10:00:00.000Z' },
      { trainPauseSetByCutover: 'no' },
      { relaunchPlanDigest: 'A'.repeat(64) },
      { relaunchPlanDigest: 'a'.repeat(63) },
    ]) {
      expect(readCutoverRecord(shadow(overrides))).toEqual({ ok: false, reason: 'invalid-record' });
    }
  });

  it('enforces the state consistency rules', () => {
    expect(readCutoverRecord(shadow({ switchedAtIso: SWITCHED })).ok).toBe(false);
    expect(readCutoverRecord(shadow({ trainPauseSetByCutover: true })).ok).toBe(false);
    expect(readCutoverRecord(shadow({ relaunchPlanDigest: DIGEST })).ok).toBe(false);

    expect(readCutoverRecord(switched()).ok).toBe(true);
    expect(readCutoverRecord(switched({ relaunchPlanDigest: null })).ok).toBe(false);
    expect(readCutoverRecord(switched({ switchedAtIso: null })).ok).toBe(false);
    expect(readCutoverRecord(switched({ rolledBackAtIso: LATER })).ok).toBe(false);

    const rolledBack = switched({ state: 'rolled-back', rolledBackAtIso: LATER, trainPauseSetByCutover: false });
    expect(readCutoverRecord(rolledBack).ok).toBe(true);
    expect(readCutoverRecord({ ...rolledBack, trainPauseSetByCutover: true }).ok).toBe(false);
    expect(readCutoverRecord({ ...rolledBack, rolledBackAtIso: null }).ok).toBe(false);
    expect(readCutoverRecord({ ...rolledBack, retiredAtIso: LATER }).ok).toBe(false);
    expect(readCutoverRecord({ ...rolledBack, rolledBackAtIso: '2026-10-31T10:00:00.000Z' }).ok).toBe(false);

    const retired = switched({ state: 'retired', retiredAtIso: LATER, trainPauseSetByCutover: false });
    expect(readCutoverRecord(retired).ok).toBe(true);
    expect(readCutoverRecord({ ...retired, rolledBackAtIso: LATER }).ok).toBe(false);
    expect(readCutoverRecord({ ...retired, retiredAtIso: '2026-10-31T10:00:00.000Z' }).ok).toBe(false);
    expect(readCutoverRecord({ ...retired, trainPauseSetByCutover: true }).ok).toBe(false);
  });

  it('refuses secret-shaped and oversized strings from both registries', () => {
    const legacy = 'gh' + 'p_' + 'x'.repeat(28);
    const fineGrained = 'github' + '_pat_' + 'y'.repeat(28);
    for (const field of ['state', 'updatedAtIso', 'switchedAtIso', 'relaunchPlanDigest']) {
      for (const text of [legacy, fineGrained, 'z'.repeat(65)]) {
        expect(readCutoverRecord(switched({ [field]: text }))).toEqual({ ok: false, reason: 'invalid-record' });
      }
    }
  });

  it('never echoes input values in its result', () => {
    const text = JSON.stringify(readCutoverRecord(shadow({ state: 'sentinel-state' })));
    expect(text).not.toContain('sentinel-state');
  });
});

describe('cutoverJournalKey', () => {
  it('builds the keyed name for a valid move and revision', () => {
    expect(cutoverJournalKey('rollback', 1)).toBe('cutover/rollback@1');
    expect(cutoverJournalKey('switch', 0)).toBe('cutover/switch@0');
    expect(cutoverJournalKey('retire', 1_000_000_000)).toBe('cutover/retire@1000000000');
  });

  it('returns null for an unknown move or a revision outside the range', () => {
    expect(cutoverJournalKey('status' as 'rollback', 1)).toBeNull();
    expect(cutoverJournalKey('bogus' as 'rollback', 1)).toBeNull();
    for (const revision of [-1, 1.5, 1_000_000_001, Number.NaN, Infinity, '1' as unknown as number]) {
      expect(cutoverJournalKey('rollback', revision)).toBeNull();
    }
  });
});

describe('isWithinCutoverRollbackWindow', () => {
  const switchedMs = Date.parse(SWITCHED);

  it('is true inside the window and false at exactly 14 days', () => {
    expect(isWithinCutoverRollbackWindow(SWITCHED, SWITCHED)).toBe(true);
    expect(isWithinCutoverRollbackWindow(SWITCHED, new Date(switchedMs + CUTOVER_ROLLBACK_WINDOW_MS - 1).toISOString())).toBe(true);
    expect(isWithinCutoverRollbackWindow(SWITCHED, new Date(switchedMs + CUTOVER_ROLLBACK_WINDOW_MS).toISOString())).toBe(false);
    expect(isWithinCutoverRollbackWindow(SWITCHED, new Date(switchedMs + CUTOVER_ROLLBACK_WINDOW_MS + 1).toISOString())).toBe(false);
  });

  it('is null for an invalid time or a clock before the switch', () => {
    expect(isWithinCutoverRollbackWindow('nope', SWITCHED)).toBeNull();
    expect(isWithinCutoverRollbackWindow(SWITCHED, 'nope')).toBeNull();
    expect(isWithinCutoverRollbackWindow(SWITCHED, new Date(switchedMs - 1).toISOString())).toBeNull();
  });
});

describe('canonicalCutoverRollbackPayload', () => {
  it('is the deterministic F129 payload', () => {
    expect(canonicalCutoverRollbackPayload({ expectedRevision: 3, operationId: 'op-1' })).toBe(
      '{"move":"rollback","expectedRevision":3,"operationId":"op-1"}',
    );
  });
});

describe('canonicalCutoverSwitchPayload and canonicalCutoverRetirePayload', () => {
  it('are the deterministic F129 payloads in a fixed key order', () => {
    expect(canonicalCutoverSwitchPayload({ expectedRevision: 0, operationId: 'op-1', relaunchPlanDigest: DIGEST })).toBe(
      `{"move":"switch","expectedRevision":0,"operationId":"op-1","relaunchPlanDigest":"${DIGEST}"}`,
    );
    expect(canonicalCutoverRetirePayload({ expectedRevision: 2, operationId: 'op-1' })).toBe(
      '{"move":"retire","expectedRevision":2,"operationId":"op-1"}',
    );
  });
});

describe('readCutoverShadowEvidence', () => {
  const ALL_FAILED = { ok: false, reason: 'invalid-evidence', failed: [...CUTOVER_SHADOW_CRITERIA] };

  function passVerdicts(): Record<string, string> {
    const verdicts: Record<string, string> = {};
    for (const id of CUTOVER_SHADOW_CRITERIA) verdicts[id] = 'pass';
    return verdicts;
  }

  function evidence(nowIso: string, mutate?: (root: Record<string, unknown>) => void): unknown {
    const base = Date.parse(nowIso);
    const root: Record<string, unknown> = {
      days: [2, 1, 0].map((back) => ({
        day: new Date(base - back * DAY_MS).toISOString().slice(0, 10),
        verdicts: passVerdicts(),
      })),
    };
    mutate?.(root);
    return root;
  }

  it('accepts three consecutive pass days', () => {
    expect(readCutoverShadowEvidence(evidence(NOW), NOW)).toEqual({ ok: true });
    // The last day may equal the UTC date of nowIso but not follow it.
    expect(readCutoverShadowEvidence(evidence('2026-11-05T00:00:00.000Z'), NOW)).toEqual({ ok: true });
  });

  it('names only S4 when that verdict is unknown', () => {
    const document = evidence(NOW, (root) => {
      const days = root.days as Array<{ verdicts: Record<string, string> }>;
      days[2].verdicts['S4'] = 'unknown';
    });
    expect(readCutoverShadowEvidence(document, NOW)).toEqual({ ok: false, reason: 'invalid-evidence', failed: ['S4'] });
  });

  it('refuses a future, gapped, duplicate or non-calendar day with every criterion named', () => {
    const base = Date.parse(NOW);
    type DayRecord = { day: string; verdicts: Record<string, unknown> };
    const future = evidence(NOW, (root) => {
      const days = root.days as DayRecord[];
      days[2] = { day: new Date(base + DAY_MS).toISOString().slice(0, 10), verdicts: passVerdicts() };
    });
    expect(readCutoverShadowEvidence(future, NOW)).toEqual(ALL_FAILED);
    const gapped = evidence(NOW, (root) => {
      const days = root.days as DayRecord[];
      days[1] = { day: new Date(base - 5 * DAY_MS).toISOString().slice(0, 10), verdicts: passVerdicts() };
    });
    expect(readCutoverShadowEvidence(gapped, NOW)).toEqual(ALL_FAILED);
    const duplicate = evidence(NOW, (root) => {
      const days = root.days as DayRecord[];
      days[1] = { ...days[2] };
    });
    expect(readCutoverShadowEvidence(duplicate, NOW)).toEqual(ALL_FAILED);
    const nonCalendar = evidence(NOW, (root) => {
      const days = root.days as DayRecord[];
      days[0] = { day: '2026-02-31', verdicts: passVerdicts() };
    });
    expect(readCutoverShadowEvidence(nonCalendar, NOW)).toEqual(ALL_FAILED);
    expect(readCutoverShadowEvidence(evidence(NOW), 'not-a-time')).toEqual(ALL_FAILED);
  });

  it('refuses null, undefined, a non-iterable, an array hole, a wrong primitive, a getter, a Proxy, an array-like with enormous length, and a prototype-polluting key, without throwing', () => {
    const base = Date.parse(NOW);
    const day = (back: number): string => new Date(base - back * DAY_MS).toISOString().slice(0, 10);

    expect(readCutoverShadowEvidence(null, NOW)).toEqual(ALL_FAILED);
    expect(readCutoverShadowEvidence(undefined, NOW)).toEqual(ALL_FAILED);
    expect(readCutoverShadowEvidence('evidence', NOW)).toEqual(ALL_FAILED);
    expect(readCutoverShadowEvidence({ days: 'nope' }, NOW)).toEqual(ALL_FAILED);
    expect(readCutoverShadowEvidence({ days: 7 }, NOW)).toEqual(ALL_FAILED);

    const holed = [ { day: day(2), verdicts: passVerdicts() } ];
    holed.length = 3; // holes at indices 1 and 2
    expect(readCutoverShadowEvidence({ days: holed }, NOW)).toEqual(ALL_FAILED);

    const wrongPrimitive = evidence(NOW, (root) => {
      const days = root.days as Array<{ verdicts: Record<string, unknown> }>;
      days[1].verdicts['S7'] = 7;
    });
    expect(readCutoverShadowEvidence(wrongPrimitive, NOW)).toEqual({
      ok: false,
      reason: 'invalid-evidence',
      failed: ['S7'],
    });
    const booleanVerdict = evidence(NOW, (root) => {
      const days = root.days as Array<{ verdicts: Record<string, unknown> }>;
      days[0].verdicts['S2'] = true;
    });
    expect(readCutoverShadowEvidence(booleanVerdict, NOW)).toEqual({
      ok: false,
      reason: 'invalid-evidence',
      failed: ['S2'],
    });

    const throwingRoot: Record<string, unknown> = {};
    Object.defineProperty(throwingRoot, 'days', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(readCutoverShadowEvidence(throwingRoot, NOW)).toEqual(ALL_FAILED);
    const getterDays = evidence(NOW, (root) => {
      const days = root.days as Array<{ verdicts: Record<string, unknown> }>;
      Object.defineProperty(days[0].verdicts, 'S9', {
        enumerable: true,
        get() {
          throw new Error('boom');
        },
      });
    });
    expect(readCutoverShadowEvidence(getterDays, NOW)).toEqual({
      ok: false,
      reason: 'invalid-evidence',
      failed: ['S9'],
    });

    expect(readCutoverShadowEvidence({ days: new Proxy({}, {}) }, NOW)).toEqual(ALL_FAILED);
    expect(
      readCutoverShadowEvidence(
        evidence(NOW, (root) => {
          const days = root.days as Array<unknown>;
          days[0] = new Proxy({}, {});
        }),
        NOW,
      ),
    ).toEqual(ALL_FAILED);

    const enormous = { length: 1_000_000_000, '0': { day: day(2), verdicts: passVerdicts() } };
    expect(readCutoverShadowEvidence({ days: enormous }, NOW)).toEqual(ALL_FAILED);
    const longArray = [ { day: day(2), verdicts: passVerdicts() }, { day: day(1), verdicts: passVerdicts() }, { day: day(0), verdicts: passVerdicts() }, { day: day(0), verdicts: passVerdicts() } ];
    expect(readCutoverShadowEvidence({ days: longArray }, NOW)).toEqual(ALL_FAILED);

    const pollutingVerdicts = passVerdicts();
    (pollutingVerdicts as unknown as Record<string, string>)['constructor'] = 'pass';
    expect(readCutoverShadowEvidence({ days: [ { day: day(2), verdicts: pollutingVerdicts }, { day: day(1), verdicts: passVerdicts() }, { day: day(0), verdicts: passVerdicts() } ] }, NOW)).toEqual(ALL_FAILED);
    // A literal own `__proto__` key must be built with defineProperty: an assignment only retargets the prototype.
    const defined: Record<string, unknown> = { days: evidence(NOW) };
    Object.defineProperty(defined, '__proto__', { enumerable: true, value: {} });
    expect(readCutoverShadowEvidence(defined, NOW)).toEqual(ALL_FAILED);
  });

  it('refuses a transparent Proxy standing in for days, for a day record, or for the whole document, before any result is built', () => {
    // A transparent Proxy answers Array.isArray, getPrototypeOf and every
    // descriptor read exactly as its target would, so the validator must
    // refuse it before accepting the document.
    const validDays = (evidence(NOW) as { days: object[] }).days;
    expect(readCutoverShadowEvidence({ days: new Proxy(validDays, {}) }, NOW)).toEqual(ALL_FAILED);

    const dayRecord = validDays[0];
    expect(
      readCutoverShadowEvidence({ days: [new Proxy(dayRecord, {}), validDays[1], validDays[2]] }, NOW),
    ).toEqual(ALL_FAILED);

    expect(readCutoverShadowEvidence(new Proxy(evidence(NOW) as object, {}), NOW)).toEqual(ALL_FAILED);
  });

  it('refuses a document padded with thousands of extra keys after a constant number of descriptor reads', async () => {
    const padded: Record<string, unknown> = evidence(NOW) as Record<string, unknown>;
    for (let i = 0; i < 5000; i += 1) {
      padded[`padding${i}`] = i;
    }
    const descriptorReads = vi.spyOn(Object, 'getOwnPropertyDescriptor');
    try {
      expect(readCutoverShadowEvidence(padded, NOW)).toEqual(ALL_FAILED);
      expect(descriptorReads.mock.calls.length).toBeLessThan(20);
    } finally {
      descriptorReads.mockRestore();
    }
  });

  it('never echoes input values in its result', () => {
    const text = JSON.stringify(readCutoverShadowEvidence({ days: 'sentinel-days' }, NOW));
    expect(text).not.toContain('sentinel-days');
  });
});
