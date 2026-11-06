import { describe, expect, it } from 'vitest';

import {
  decideMergeRecord,
  MERGE_RECORD_LIMITS,
  MergeRecord,
} from '../entities/MergeRecord.js';
import type { MergeRecordRecord } from '../entities/MergeRecord.js';

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

const VALID: MergeRecordRecord = {
  schemaVersion: 1,
  repository: 'example-org/example-repo',
  number: 251,
  headSha: 'ab'.repeat(20),
  mergedAtIso: '2026-10-27T12:00:00.000Z',
  firstSeenAtIso: '2026-10-27T12:05:30.000Z',
  source: 'forge-observation',
  merger: 'unknown',
};

function createError(input: unknown): string {
  const result = MergeRecord.create(input);
  if (result.success) {
    throw new Error('expected create failure');
  }
  return result.error.message;
}

function patched(patch: (record: Record<string, unknown>) => void): Record<string, unknown> {
  const record = structuredClone(VALID) as unknown as Record<string, unknown>;
  patch(record);
  return record;
}

function decideError(stored: unknown, incoming: unknown): string {
  const result = decideMergeRecord(stored, incoming);
  if (result.success) {
    throw new Error('expected decide failure');
  }
  return result.error.message;
}

describe('MergeRecord.create', () => {
  it('round-trips a valid record and freezes it', () => {
    const result = MergeRecord.create(structuredClone(VALID));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.toRecord()).toEqual(VALID);

    // The entity holds a frozen snapshot: later mutation of the input never
    // leaks in, and mutating a returned record never leaks back.
    const input = structuredClone(VALID) as unknown as Record<string, unknown>;
    const created = MergeRecord.create(input);
    if (!created.success) return;
    input.headSha = 'ff'.repeat(20);
    expect(created.value.getHeadSha()).toBe(VALID.headSha);
    const out = created.value.toRecord() as { headSha: string };
    out.headSha = 'ee'.repeat(20);
    expect(created.value.getHeadSha()).toBe(VALID.headSha);
  });

  it('refuses a null or non-object record with a typed reason', () => {
    expect(createError(null)).toBe('MergeRecord requires a record');
    expect(createError('not a record')).toBe('MergeRecord requires a record');
    expect(createError(42)).toBe('MergeRecord requires a record');
    expect(createError(new Date())).toBe('MergeRecord requires a plain record');
  });

  it('refuses a sparse array record with a typed reason', () => {
    const result = MergeRecord.create(new Array(2));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('invalid');
    expect(result.error.message).toBe('MergeRecord requires a record');
  });

  it('refuses a record with a missing or wrong-typed field', () => {
    expect(createError(patched((record) => { delete record.number; })))
      .toBe('MergeRecord is missing a required field');
    expect(createError(patched((record) => { record.headSha = 123; })))
      .toBe('MergeRecord field has the wrong type');
  });

  it('refuses an unknown enum value with a typed reason', () => {
    expect(createError(patched((record) => { record.source = 'weird'; })))
      .toBe('MergeRecord field must be one of its allowed values');
    expect(createError(patched((record) => { record.merger = 'maybe'; })))
      .toBe('MergeRecord field must be one of its allowed values');
  });

  it('refuses a throwing getter without throwing', () => {
    const withGetter = Object.defineProperty(structuredClone(VALID), 'headSha', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(() => MergeRecord.create(withGetter)).not.toThrow();
    expect(createError(withGetter)).toBe('MergeRecord fields must be plain data properties');
  });

  it('refuses an unknown schema version', () => {
    expect(createError(patched((record) => { record.schemaVersion = 2; })))
      .toBe('MergeRecord field is out of range');
  });

  it('reads an absent schemaVersion as 1', () => {
    const result = MergeRecord.create(patched((record) => { delete record.schemaVersion; }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.toRecord().schemaVersion).toBe(1);
  });

  it('refuses a secret-shaped repository without echoing the value', () => {
    const secret = fakeSecretShape();
    const message = createError(patched((record) => { record.repository = secret; }));
    expect(message).toBe('MergeRecord merge.repository: contains a secret-shaped value and was refused');
    expect(message).not.toContain(secret);

    const actionSecretMessage = createError(patched((record) => { record.actionRef = secret; }));
    expect(actionSecretMessage).toBe('MergeRecord actionRef: must be plain text of at most 128 characters');
    expect(actionSecretMessage).not.toContain(secret);
  });

  it('handles a __proto__ key and a null-prototype record safely and refuses a class instance', () => {
    const withProto = JSON.parse(JSON.stringify(VALID).replace('{', '{"__proto__":{"x":1},')) as unknown;
    expect(() => MergeRecord.create(withProto)).not.toThrow();
    // Brief: extra keys are ignored, so an own `__proto__` data key is dropped:
    // the record is accepted and the key never reaches the record or the chain.
    const protoResult = MergeRecord.create(withProto);
    expect(protoResult.success).toBe(true);
    if (!protoResult.success) {
      throw new Error('expected create success');
    }
    const protoRecord = protoResult.value.toRecord();
    expect(Object.getPrototypeOf(protoRecord)).toBe(Object.prototype);
    expect(Object.getOwnPropertyNames(protoRecord)).not.toContain('__proto__');
    expect(Object.keys(protoRecord).sort()).toEqual(Object.keys(VALID).sort());
    expect(protoRecord).toEqual(VALID);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'x')).toBe(false);

    const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, VALID);
    expect(() => MergeRecord.create(nullProto)).not.toThrow();
    const nullResult = MergeRecord.create(nullProto);
    expect(nullResult.success).toBe(true);
    if (nullResult.success) {
      expect(nullResult.value.toRecord()).toEqual(VALID);
      expect(Object.getPrototypeOf(nullResult.value.toRecord())).toBe(Object.prototype);
    }

    class Holder {
      readonly schemaVersion = 1;
      readonly repository = VALID.repository;
      readonly number = VALID.number;
      readonly headSha = VALID.headSha;
      readonly mergedAtIso = VALID.mergedAtIso;
      readonly firstSeenAtIso = VALID.firstSeenAtIso;
      readonly source = VALID.source;
      readonly merger = VALID.merger;
    }
    expect(createError(new Holder())).toBe('MergeRecord requires a plain record');
  });

  it('does not copy extra fields into toRecord', () => {
    const result = MergeRecord.create({ ...VALID, extra: 'x', token: 'y' });
    // Brief: extra keys on the input are ignored, never refused and never copied.
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error('expected create success');
    }
    const record = result.value.toRecord();
    expect(Object.keys(record).sort()).toEqual(Object.keys(VALID).sort());
    expect(record).toEqual(VALID);
    expect(record).not.toHaveProperty('extra');
    expect(record).not.toHaveProperty('token');
  });

  it('refuses an oversized headSha and timestamps', () => {
    expect(createError(patched((record) => { record.headSha = 'a'.repeat(65); }))).toBe('MergeRecord field is too long');
    expect(createError(patched((record) => { record.mergedAtIso = '2026-10-27T12:00:00.000Z'.padEnd(33, '0'); })))
      .toBe('MergeRecord field is too long');
    expect(createError(patched((record) => { record.firstSeenAtIso = '2026-10-27T12:00:00.000Z'.padEnd(33, '0'); })))
      .toBe('MergeRecord field is too long');
  });

  it('refuses a control-character actionRef', () => {
    expect(createError(patched((record) => { record.actionRef = 'bad\u0007ref'; })))
      .toBe('MergeRecord actionRef: must be plain text of at most 128 characters');
    expect(createError(patched((record) => { record.actionRef = 'line\nbreak'; })))
      .toBe('MergeRecord actionRef: must be plain text of at most 128 characters');
  });

  it('refuses a field over the size bound', () => {
    expect(createError(patched((record) => { record.repository = 'x'.repeat(201); })))
      .toBe('MergeRecord field is too long');
    expect(createError(patched((record) => { record.actionRef = 'y'.repeat(129); })))
      .toBe('MergeRecord field is too long');
  });

  it('refuses an impossible calendar date as a non-canonical timestamp', () => {
    // The canonical ISO shape with an impossible date: `toISOString()` would
    // throw a RangeError, so create must refuse with the timestamp message,
    // never the generic read failure, and never throw.
    expect(() => MergeRecord.create(patched((record) => { record.mergedAtIso = '2026-02-30T12:00:00.000Z'; })))
      .not.toThrow();
    expect(createError(patched((record) => { record.mergedAtIso = '2026-02-30T12:00:00.000Z'; })))
      .toBe('MergeRecord mergedAtIso: must be a canonical UTC timestamp');
    expect(createError(patched((record) => { record.firstSeenAtIso = '2027-04-31T00:00:00.000Z'; })))
      .toBe('MergeRecord firstSeenAtIso: must be a canonical UTC timestamp');
  });

  it('refuses a fleet-forge-action source with an unknown merger', () => {
    expect(createError(patched((record) => { record.source = 'fleet-forge-action'; })))
      .toBe('MergeRecord source and merger disagree');
  });

  it('accepts an upgraded forge-observation record with a fleet merger', () => {
    // The merger upgrade persists a stored `forge-observation` record whose
    // merger moved `unknown` → `fleet`; loading it back through the entity
    // must succeed and round-trip.
    const result = MergeRecord.create(patched((record) => { record.merger = 'fleet'; }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.toRecord()).toEqual({ ...VALID, merger: 'fleet' });
    expect(result.value.getSource()).toBe('forge-observation');
    expect(result.value.getMerger()).toBe('fleet');
  });

  it('getKey joins repository and number with #', () => {
    const result = MergeRecord.create(VALID);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.getKey()).toBe('example-org/example-repo#251');
  });
});

describe('decideMergeRecord', () => {
  it('creates when nothing is stored', () => {
    for (const stored of [undefined, null]) {
      const result = decideMergeRecord(stored, VALID);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.outcome).toBe('create');
      expect(result.record).toEqual(VALID);
      expect(result.finding).toBeNull();
    }
  });

  it('keeps the first sighting when a later read differs and reports one integrity finding', () => {
    const different = {
      ...VALID,
      headSha: 'cd'.repeat(20),
      mergedAtIso: '2026-10-28T12:00:00.000Z',
    };
    const result = decideMergeRecord(VALID, different);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.outcome).toBe('integrity-conflict');
    expect(result.record.headSha).toBe(VALID.headSha);
    expect(result.record.mergedAtIso).toBe(VALID.mergedAtIso);
    expect(result.finding).not.toBeNull();
    expect(result.finding?.differingFields).toEqual(['head-sha', 'merged-at']);
    expect(result.finding?.expectedHeadSha).toBe(VALID.headSha);
    expect(result.finding?.observedHeadSha).toBe(different.headSha);
    expect(result.finding?.expectedMergedAtIso).toBe(VALID.mergedAtIso);
    expect(result.finding?.observedMergedAtIso).toBe(different.mergedAtIso);
  });

  it('upgrades merger from unknown to fleet exactly once', () => {
    const fleet = { ...VALID, source: 'fleet-forge-action', merger: 'fleet' };
    const first = decideMergeRecord(VALID, fleet);
    expect(first.success).toBe(true);
    if (!first.success) return;
    expect(first.outcome).toBe('upgrade-merger');
    expect(first.record.merger).toBe('fleet');
    expect(first.finding).toBeNull();

    const second = decideMergeRecord(first.record, fleet);
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.outcome).toBe('unchanged');
    expect(second.record.merger).toBe('fleet');
  });

  it('changes only merger on the upgrade', () => {
    const fleet = {
      ...VALID,
      source: 'fleet-forge-action',
      merger: 'fleet',
      firstSeenAtIso: '2026-10-29T12:00:00.000Z',
      actionRef: 'action-1',
    };
    const result = decideMergeRecord(VALID, fleet);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.outcome).toBe('upgrade-merger');
    expect(result.record).toEqual({ ...VALID, merger: 'fleet' });
    expect(result.record.source).toBe('forge-observation');
    expect(result.record.firstSeenAtIso).toBe(VALID.firstSeenAtIso);
    expect(result.record.actionRef).toBeUndefined();
  });

  it('reloads a persisted upgraded forge-observation record', () => {
    // The upgrade persists the stored `forge-observation` record with only
    // `merger` moved to `fleet`; that persisted record must reload through the
    // entity and round-trip.
    const fleetSighting = { ...VALID, source: 'fleet-forge-action', merger: 'fleet' };
    const decided = decideMergeRecord(VALID, fleetSighting);
    expect(decided.success).toBe(true);
    if (!decided.success) return;
    expect(decided.outcome).toBe('upgrade-merger');
    expect(decided.record).toEqual({ ...VALID, merger: 'fleet' });

    const reloaded = MergeRecord.create(decided.record);
    expect(reloaded.success).toBe(true);
    if (!reloaded.success) return;
    expect(reloaded.value.toRecord()).toEqual({ ...VALID, merger: 'fleet' });
  });

  it('never downgrades merger from fleet to unknown', () => {
    const fleetStored = { ...VALID, source: 'fleet-forge-action', merger: 'fleet' };
    const result = decideMergeRecord(fleetStored, VALID);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.outcome).toBe('unchanged');
    expect(result.record.merger).toBe('fleet');
  });

  it('is idempotent: deciding the same sighting twice changes nothing', () => {
    const first = decideMergeRecord(VALID, VALID);
    const second = decideMergeRecord(VALID, VALID);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(first.outcome).toBe('unchanged');
    expect(second.outcome).toBe('unchanged');
    expect(second.record).toEqual(first.record);
    expect(first.record).toEqual(VALID);
  });

  it('refuses an incoming record whose source and merger disagree', () => {
    // A fleet-forge-action claim with an unknown merger is impossible and is
    // refused both with nothing stored and against a stored record. (An
    // incoming forge-observation/fleet sighting is refused too, see the next
    // test; only a stored upgraded record loads, through `MergeRecord.create`.)
    const journal = { ...VALID, source: 'fleet-forge-action', merger: 'unknown' } as MergeRecordRecord;
    expect(decideError(null, journal)).toBe('MergeRecord source and merger disagree');
    expect(decideError(undefined, journal)).toBe('MergeRecord source and merger disagree');
    expect(decideError(VALID, journal)).toBe('MergeRecord source and merger disagree');
  });

  it('refuses an incoming forge-observation with a fleet merger, stored or not', () => {
    const forged = { ...VALID, source: 'forge-observation', merger: 'fleet' };
    expect(decideError(null, forged)).toBe('MergeRecord source and merger disagree');
    expect(decideError(undefined, forged)).toBe('MergeRecord source and merger disagree');
    expect(decideError(VALID, forged)).toBe('MergeRecord source and merger disagree');
  });

  it('still loads a stored upgraded forge-observation/fleet record and decides against it', () => {
    const upgraded = { ...VALID, merger: 'fleet' };
    expect(MergeRecord.create(upgraded).success).toBe(true);
    const result = decideMergeRecord(upgraded, VALID);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.outcome).toBe('unchanged');
    expect(result.record.merger).toBe('fleet');
  });

  it('freezes the upgraded record', () => {
    const result = decideMergeRecord(VALID, { ...VALID, source: 'fleet-forge-action', merger: 'fleet' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.outcome).toBe('upgrade-merger');
    expect(Object.isFrozen(result.record)).toBe(true);
  });

  it('refuses an unreadable stored record instead of treating it as empty', () => {
    expect(decideError({ repository: 'example-org/example-repo' }, VALID))
      .toBe('MergeRecord stored record could not be read');
  });

  it('refuses an unreadable incoming record with a typed reason', () => {
    expect(decideError(VALID, null)).toBe('MergeRecord incoming record could not be read');
    expect(decideError(VALID, {})).toBe('MergeRecord incoming record could not be read');
  });
});

describe('MERGE_RECORD_LIMITS', () => {
  it('exports MERGE_RECORD_LIMITS matching MergeRecord.create and decideMergeRecord field bounds', () => {
    expect(MERGE_RECORD_LIMITS).toEqual({
      maxRepositoryLength: 200,
      minPullRequestNumber: 1,
      maxPullRequestNumber: 999_999_999,
      maxHeadShaLength: 64,
      maxIsoTimestampLength: 32,
      maxActionRefLength: 128,
    });

    const make = (overrides: Partial<MergeRecordRecord> = {}): MergeRecordRecord => ({ ...VALID, ...overrides });

    // actionRef: 128 accepted, 129 refused (create and decide both).
    const actionRef128 = make({ actionRef: 'x'.repeat(MERGE_RECORD_LIMITS.maxActionRefLength) });
    expect(MergeRecord.create(actionRef128).success).toBe(true);
    expect(decideMergeRecord(VALID, actionRef128).success).toBe(true);

    const actionRef129 = { ...actionRef128, actionRef: 'x'.repeat(MERGE_RECORD_LIMITS.maxActionRefLength + 1) };
    expect(MergeRecord.create(actionRef129).success).toBe(false);
    expect(decideMergeRecord(VALID, actionRef129).success).toBe(false);

    // repository: 200 accepted, 201 refused.
    const repository200 = make({ repository: 'r'.repeat(MERGE_RECORD_LIMITS.maxRepositoryLength) });
    expect(MergeRecord.create(repository200).success).toBe(true);
    const repository201 = make({ repository: 'r'.repeat(MERGE_RECORD_LIMITS.maxRepositoryLength + 1) });
    expect(MergeRecord.create(repository201).success).toBe(false);

    // number: 1 and 999_999_999 accepted, 0 and 1_000_000_000 refused.
    for (const accepted of [MERGE_RECORD_LIMITS.minPullRequestNumber, MERGE_RECORD_LIMITS.maxPullRequestNumber]) {
      const record = make({ number: accepted });
      expect(MergeRecord.create(record).success).toBe(true);
      expect(decideMergeRecord(null, record).success).toBe(true);
    }
    for (const refused of [0, 1_000_000_000]) {
      const record = make({ number: refused });
      expect(MergeRecord.create(record).success).toBe(false);
      expect(decideMergeRecord(null, record).success).toBe(false);
    }
  });
});
