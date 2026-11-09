import { describe, expect, it } from 'vitest';

import {
  CUTOVER_ROLLBACK_WINDOW_MS,
  CUTOVER_RECORD_SCHEMA_VERSION,
  canonicalCutoverRollbackPayload,
  cutoverJournalKey,
  isWithinCutoverRollbackWindow,
  readCutoverRecord,
} from '../cutover-records.js';

const DIGEST = 'a'.repeat(64);
const SWITCHED = '2026-11-01T10:00:00.000Z';
const LATER = '2026-11-02T10:00:00.000Z';

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
