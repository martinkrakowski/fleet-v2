import { describe, expect, it } from 'vitest';

import * as barrel from '../index.js';
import { LanePlan } from '../entities/LanePlan.js';
import { PlannedLane } from '../entities/PlannedLane.js';
import type { LanePlanRecord, LanePlanSidecar } from '../lane-plan-records.js';
import { parseLanePlanSidecar } from '../lane-plan-sidecar.js';

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

const VALID = {
  schemaVersion: 1,
  projectId: 'example-project',
  planId: '2026-10-27_example',
  revision: 3,
  doc: 'docs/planning/2026-10-27_example-plan.md',
  lanes: [
    {
      laneId: 'A1',
      scope: 'Records',
      packages: ['work-execution'],
      sharedFiles: ['.architecture/manifest.yaml'],
      tier: 2,
      after: [],
      decisions: ['D1'],
    },
    {
      laneId: 'A2',
      renamedFrom: 'A-two',
      scope: 'Stores',
      packages: ['work-execution'],
      tier: 2,
      after: ['A1', 'other-plan/B1', 'other-project/third-plan/C1'],
      brief: '.lane/brief-a2.md',
    },
    {
      laneId: 'A3',
      scope: 'Docs',
      packages: ['docs'],
      tier: 0,
      after: [],
      status: 'dropped',
      mergedPr: { repository: 'example-org/example-repo', number: 251 },
    },
  ],
  decisions: [{ id: 'D1', question: 'Which store?', default: 'A file store', state: 'open' }],
  exclusiveOrder: [{ file: '.architecture/manifest.yaml', lanes: ['A1', 'A2'] }],
};

function storedRecord(): LanePlanRecord {
  const result = parseLanePlanSidecar(VALID);
  if (!result.ok) {
    throw new Error('fixture sidecar must parse');
  }
  const lanePlan = LanePlan.fromSidecar(result.sidecar, {
    digest: 'a'.repeat(64),
    importedAtIso: '2026-10-27T12:00:00.000Z',
  });
  if (!lanePlan.success) {
    throw new Error(`fixture sidecar must store: ${lanePlan.error.message}`);
  }
  return lanePlan.value.toRecord();
}

function createError(input: unknown): string {
  const result = LanePlan.create(input);
  if (result.success) {
    throw new Error('expected create failure');
  }
  return result.error.message;
}

function patched(patch: (record: Record<string, unknown>) => void): LanePlanRecord {
  const record = structuredClone(storedRecord()) as unknown as Record<string, unknown>;
  patch(record);
  return record as unknown as LanePlanRecord;
}

function lane0(record: Record<string, unknown>): Record<string, unknown> {
  return (record.lanes as Record<string, unknown>[])[0];
}

describe('LanePlan.fromSidecar', () => {
  it('builds a stored record from a validated sidecar', () => {
    const result = parseLanePlanSidecar(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = LanePlan.fromSidecar(result.sidecar, {
      digest: 'a'.repeat(64),
      importedAtIso: '2026-10-27T12:00:00.000Z',
    });
    expect(plan.success).toBe(true);
    if (!plan.success) return;
    const record = plan.value.toRecord();
    expect(record.version).toBe(1);
    expect(record.projectId).toBe('example-project');
    expect(record.planId).toBe('2026-10-27_example');
    expect(record.revision).toBe(3);
    expect(record.digest).toBe('a'.repeat(64));
    expect(record.importedAtIso).toBe('2026-10-27T12:00:00.000Z');
    const a1 = record.lanes.find((lane) => lane.laneId === 'A1');
    const a2 = record.lanes.find((lane) => lane.laneId === 'A2');
    expect(a1?.aliases).toEqual([]);
    expect(a2?.aliases).toEqual(['A-two']);
    for (const lane of record.lanes) {
      expect(Object.keys(lane)).not.toContain('renamedFrom');
    }
    // `LanePlan.create` round-trips the stored record.
    const roundTrip = LanePlan.create(record);
    expect(roundTrip.success).toBe(true);
    if (!roundTrip.success) return;
    expect(roundTrip.value.toRecord()).toEqual(record);
    // `toRecord` lists are fresh copies.
    const first = plan.value.toRecord();
    (first.lanes as unknown[]).push({ laneId: 'extra' });
    (first.decisions as unknown[]).push({ id: 'extra' });
    const second = plan.value.toRecord();
    expect(second.lanes).toHaveLength(3);
    expect(second.decisions).toHaveLength(1);
  });

  it('keeps a dropped lane in the record', () => {
    const plan = LanePlan.create(storedRecord());
    expect(plan.success).toBe(true);
    if (!plan.success) return;
    const a3 = plan.value.findLane('A3');
    expect(a3).not.toBeNull();
    expect(a3?.status).toBe('dropped');
  });

  it('resolves aliases to their current lane', () => {
    const plan = LanePlan.create(storedRecord());
    expect(plan.success).toBe(true);
    if (!plan.success) return;
    const byAlias = plan.value.findLane('A-two');
    expect(byAlias?.laneId).toBe('A2');
    expect(plan.value.resolveLaneId('A-two')).toBe('A2');
    expect(plan.value.resolveLaneId('A1')).toBe('A1');
    expect(plan.value.resolveLaneId('nope')).toBeNull();
  });

  it('refuses an alias equal to another lane id, a repeated alias, an alias naming its own lane, and 17 aliases', () => {
    expect(
      createError(patched((record) => { (lane0(record).aliases as string[]).push('A3'); })),
    ).toBe('LanePlan lanes[0].aliases[0]: is a duplicate');
    expect(
      createError(patched((record) => { (lane0(record).aliases as string[]).push('X', 'X'); })),
    ).toBe('PlannedLane lanes[0].aliases[1]: is a duplicate');
    expect(
      createError(patched((record) => { (lane0(record).aliases as string[]).push('A1'); })),
    ).toBe('PlannedLane lanes[0].aliases[0]: names its own lane');
    expect(
      createError(patched((record) => {
        (lane0(record).aliases as string[]) = [];
        for (let index = 0; index < 17; index += 1) {
          (lane0(record).aliases as string[]).push(`alias-${index}`);
        }
      })),
    ).toBe('PlannedLane lanes[0].aliases: has too many entries');
  });
});

describe('LanePlan.create exact keys and fixed fields', () => {
  it('refuses a stored record that still carries renamedFrom', () => {
    const record = structuredClone(storedRecord()) as unknown as Record<string, unknown>;
    lane0(record).renamedFrom = null;
    // `renamedFrom` is an unknown key of a stored lane record.
    const result = LanePlan.create(record);
    expect(result.success).toBe(false);
    expect(() => LanePlan.create(record)).not.toThrow();
  });

  it('refuses a missing importedAtIso, an extra root key, and keeps values unread', () => {
    const missing = structuredClone(storedRecord()) as unknown as Record<string, unknown>;
    delete missing.importedAtIso;
    const missingResult = LanePlan.create(missing);
    expect(missingResult.success).toBe(false);
    expect(() => LanePlan.create(missing)).not.toThrow();

    const extra = structuredClone(storedRecord()) as unknown as Record<string, unknown>;
    extra.unexpected = 1;
    const extraResult = LanePlan.create(extra);
    expect(extraResult.success).toBe(false);
    expect(() => LanePlan.create(extra)).not.toThrow();
  });

  it('refuses a wrong version, digest and non-canonical importedAtIso with their exact messages', () => {
    expect(createError(patched((record) => { record.version = 2; })))
      .toBe('LanePlan version must be 1');
    expect(createError(patched((record) => { record.digest = 'A'.repeat(64); })))
      .toBe('LanePlan digest must be a sha256 hex digest');
    expect(createError(patched((record) => { record.importedAtIso = '2026-02-31T00:00:00.000Z'; })))
      .toBe('LanePlan importedAtIso must be a canonical UTC timestamp');
    expect(createError(patched((record) => { record.importedAtIso = '2026-10-27T12:00:00Z'; })))
      .toBe('LanePlan importedAtIso must be a canonical UTC timestamp');
  });
});

describe('LanePlan.create cross references', () => {
  it('refuses a same-plan after naming an alias and accepts one naming a dropped lane', () => {
    expect(
      createError(patched((record) => {
        (lane0(record).after as unknown[]).push({
          projectId: 'example-project',
          planId: '2026-10-27_example',
          laneId: 'A-two',
        });
      })),
    ).toBe('LanePlan lanes[0].after[0]: names no lane in this plan');

    const namingDropped = patched((record) => {
      (lane0(record).after as unknown[]).push({
        projectId: 'example-project',
        planId: '2026-10-27_example',
        laneId: 'A3',
      });
    });
    expect(LanePlan.create(namingDropped).success).toBe(true);
  });

  it('refuses two lanes sharing one merged pull request', () => {
    expect(
      createError(patched((record) => {
        lane0(record).mergedPr = {
          repository: 'example-org/example-repo',
          number: 251,
        };
      })),
    ).toBe('LanePlan lanes[2].mergedPr: is a duplicate');
  });

  it('refuses a secret-shaped scope and never echoes an input value', () => {
    const secret = fakeSecretShape();
    const message = createError(patched((record) => { lane0(record).scope = secret; }));
    expect(message).toBe('PlannedLane lanes[0].scope: contains a secret-shaped value and was refused');
    expect(message).not.toContain(secret);
  });
});

describe('LanePlan.create hostile input', () => {
  it('returns a failure result without throwing for a throwing getter and a throwing ownKeys proxy', () => {
    const getterHostile = new Proxy({} as Record<string, unknown>, {
      get() {
        throw new Error('hostile get');
      },
      getOwnPropertyDescriptor() {
        throw new Error('hostile descriptor');
      },
    });
    const getterResult = LanePlan.create(getterHostile);
    expect(getterResult.success).toBe(false);

    const keysHostile = new Proxy({} as Record<string, unknown>, {
      ownKeys() {
        throw new Error('hostile ownKeys');
      },
    });
    const keysResult = LanePlan.create(keysHostile);
    expect(keysResult.success).toBe(false);
  });
});

describe('LanePlan.create mergedPr snapshot', () => {
  it('refuses a mergedPr whose number is read through an accessor', () => {
    const record = structuredClone(storedRecord()) as unknown as Record<string, unknown>;
    const lane = (record.lanes as unknown as Record<string, unknown>[])[0];
    let reads = 0;
    const pr = { repository: 'example-org/example-repo' };
    Object.defineProperty(pr, 'number', {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? 7 : 8;
      },
    });
    lane.mergedPr = pr;
    const result = LanePlan.create(record);
    expect(result.success).toBe(false);
    expect(reads).toBe(0);
  });
});

describe('LanePlan.fromSidecar hostile input', () => {
  it('returns a failure result without throwing for a throwing accessor', () => {
    const result = parseLanePlanSidecar(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sidecar = structuredClone(result.sidecar) as unknown as Record<string, unknown>;
    Object.defineProperty(sidecar, 'projectId', {
      enumerable: true,
      get: () => {
        throw new Error('hostile accessor');
      },
    });
    const plan = LanePlan.fromSidecar(sidecar as unknown as LanePlanSidecar, {
      digest: 'a'.repeat(64),
      importedAtIso: '2026-10-27T12:00:00.000Z',
    });
    expect(plan.success).toBe(false);
  });
});

describe('LanePlan deep freeze', () => {
  it('deep-freezes the lanes inside the aggregate record', () => {
    const plan = LanePlan.create(storedRecord());
    if (!plan.success) throw new Error('fixture must store');
    const record = (plan.value as unknown as { record: LanePlanRecord }).record;
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.lanes)).toBe(true);
    const lane = record.lanes[1];
    expect(Object.isFrozen(lane)).toBe(true);
    expect(Object.isFrozen(lane.after[0])).toBe(true);
    expect(Object.isFrozen(record.lanes[2].mergedPr)).toBe(true);
  });
});

describe('LanePlan featureSet and PlannedLane rollupOf (PV1)', () => {
  const FEATURE = { id: 'feature-1', title: 'Progress view' };

  function planFromSidecar(patch: (input: Record<string, unknown>) => void): LanePlan {
    const input = structuredClone(VALID) as Record<string, unknown>;
    patch(input);
    const parsed = parseLanePlanSidecar(input);
    if (!parsed.ok) throw new Error(`fixture sidecar must parse: ${parsed.errors.join(';')}`);
    const plan = LanePlan.fromSidecar(parsed.sidecar, {
      digest: 'a'.repeat(64),
      importedAtIso: '2026-10-27T12:00:00.000Z',
    });
    if (!plan.success) throw new Error(`fixture must store: ${plan.error.message}`);
    return plan.value;
  }

  function withFeature(featureSet: unknown): LanePlanRecord {
    return patched((record) => { record.featureSet = featureSet; });
  }

  it('fromSidecar carries featureSet and rollupOf into the stored record and create round-trips them', () => {
    const plan = planFromSidecar((input) => {
      input.featureSet = FEATURE;
      (input.lanes as Record<string, unknown>[])[1].rollupOf = true;
    });
    const record = plan.toRecord();
    expect(record.featureSet).toEqual(FEATURE);
    expect(record.lanes.map((lane) => lane.rollupOf)).toEqual([false, true, false]);
    expect(plan.getFeatureSet()).toEqual(FEATURE);
    const again = LanePlan.create(record);
    expect(again.success).toBe(true);
    if (!again.success) return;
    expect(again.value.toRecord()).toEqual(record);
  });

  it('toRecord always emits featureSet (null when absent) and rollupOf (false when absent)', () => {
    const record = planFromSidecar(() => undefined).toRecord();
    expect(record.featureSet).toBeNull();
    expect(record.lanes.every((lane) => lane.rollupOf === false)).toBe(true);
    expect(planFromSidecar(() => undefined).getFeatureSet()).toBeNull();
  });

  it('reads a pre-PV1 stored record with no featureSet or rollupOf key as null and false', () => {
    const legacy = structuredClone(storedRecord()) as unknown as Record<string, unknown>;
    delete legacy.featureSet;
    for (const lane of legacy.lanes as Record<string, unknown>[]) {
      delete lane.rollupOf;
    }
    const plan = LanePlan.create(legacy);
    expect(plan.success).toBe(true);
    if (!plan.success) return;
    const record = plan.value.toRecord();
    expect(record.featureSet).toBeNull();
    expect(record.lanes.map((lane) => lane.rollupOf)).toEqual([false, false, false]);
  });

  it('toRecord and getFeatureSet return fresh copies of the featureSet and the record is frozen', () => {
    const plan = planFromSidecar((input) => { input.featureSet = FEATURE; });
    const first = plan.toRecord();
    (first.featureSet as { title: string }).title = 'mutated';
    const second = plan.toRecord();
    expect(second.featureSet).toEqual(FEATURE);
    expect(second.featureSet).not.toBe(first.featureSet);
    const copy = plan.getFeatureSet() as { title: string };
    copy.title = 'mutated';
    expect(plan.getFeatureSet()).toEqual(FEATURE);
    const frozen = (plan as unknown as { record: LanePlanRecord }).record;
    expect(Object.isFrozen(frozen.featureSet)).toBe(true);
    expect(Object.isFrozen(frozen.lanes[1])).toBe(true);
  });

  it.each([
    ['a string', 'x'],
    ['a number', 123],
    ['an array', []],
    ['undefined', undefined],
    ['a non-plain prototype', Object.create({ id: 'f', title: 'T' })],
  ])('create refuses a featureSet that is %s', (_name, value) => {
    expect(createError(withFeature(value))).toBe('LanePlan featureSet: must be an object');
  });

  it('create refuses featureSet extra, missing and prototype-polluting keys', () => {
    const exact = 'LanePlan featureSet: must have exactly id and title';
    expect(createError(withFeature({ id: 'f', title: 'T', extra: 1 }))).toBe(exact);
    expect(createError(withFeature({ id: 'f' }))).toBe(exact);
    expect(createError(withFeature({ title: 'T' }))).toBe(exact);
    expect(createError(withFeature(JSON.parse('{"id":"f","title":"__x","__proto__":{"x":1}}')))).toBe(exact);
    const symbolKeyed: Record<string | symbol, unknown> = { id: 'f' };
    symbolKeyed[Symbol('s')] = 1;
    expect(createError(withFeature(symbolKeyed))).toBe(exact);
  });

  it('create refuses a getter-backed featureSet and featureSet field without running the accessor, and a throwing Proxy', () => {
    let calls = 0;
    const getterField = {
      get id() {
        calls += 1;
        return 'f';
      },
      title: 'T',
    };
    expect(createError(withFeature(getterField))).toBe('LanePlan featureSet.id: must be a string');
    const record = structuredClone(storedRecord()) as unknown as Record<string, unknown>;
    Object.defineProperty(record, 'featureSet', {
      enumerable: true,
      get() {
        calls += 1;
        return FEATURE;
      },
    });
    expect(createError(record)).toBe('LanePlan featureSet: must be an object');
    expect(calls).toBe(0);
    const proxy = new Proxy({}, { ownKeys() { throw new Error('boom'); } });
    expect(createError(withFeature(proxy))).toBe('LanePlan input could not be read');
  });

  it('create refuses a bad featureSet id or title with a fixed message that never echoes a secret', () => {
    const secret = fakeSecretShape();
    expect(createError(withFeature({ id: 1, title: 'T' }))).toBe('LanePlan featureSet.id: must be a string');
    expect(createError(withFeature({ id: 'has/slash', title: 'T' }))).toBe('LanePlan featureSet.id: must be a feature set id');
    const secretId = createError(withFeature({ id: secret, title: 'T' }));
    expect(secretId).toBe('LanePlan featureSet.id: contains a secret-shaped value and was refused');
    expect(secretId).not.toContain(secret);
    expect(createError(withFeature({ id: 'f', title: 2 }))).toBe('LanePlan featureSet.title: must be a string');
    for (const title of ['', '   ', 'x'.repeat(121), 'a\nb', 'a\u0007b', 'a‮b']) {
      expect(createError(withFeature({ id: 'f', title })))
        .toBe('LanePlan featureSet.title: must be plain text of at most 120 bytes');
    }
    const secretTitle = createError(withFeature({ id: 'f', title: secret }));
    expect(secretTitle).toBe('LanePlan featureSet.title: contains a secret-shaped value and was refused');
    expect(secretTitle).not.toContain(secret);
  });

  it.each([['true'], [1], [null], [{}], [undefined]])('create refuses rollupOf %j as not a boolean', (rollupOf) => {
    expect(createError(patched((record) => { lane0(record).rollupOf = rollupOf; })))
      .toBe('PlannedLane lanes[0].rollupOf: must be a boolean');
  });

  it('create refuses a getter-backed rollupOf without running the accessor', () => {
    let calls = 0;
    const record = structuredClone(storedRecord()) as unknown as Record<string, unknown>;
    Object.defineProperty(lane0(record), 'rollupOf', {
      enumerable: true,
      get() {
        calls += 1;
        return true;
      },
    });
    expect(createError(record)).toBe('PlannedLane lanes[0].rollupOf: must be a boolean');
    expect(calls).toBe(0);
  });

  it('PlannedLane.create defaults an absent rollupOf to false, reports isRollup and rejects extra keys', () => {
    const base = structuredClone(storedRecord().lanes[0]) as unknown as Record<string, unknown>;
    delete base.rollupOf;
    const absent = PlannedLane.create(base);
    expect(absent.success).toBe(true);
    if (!absent.success) return;
    expect(absent.value.isRollup()).toBe(false);
    expect(absent.value.toRecord().rollupOf).toBe(false);
    const rollup = PlannedLane.create({ ...base, rollupOf: true });
    expect(rollup.success).toBe(true);
    if (!rollup.success) return;
    expect(rollup.value.isRollup()).toBe(true);
    expect(rollup.value.toRecord().rollupOf).toBe(true);
    expect(PlannedLane.create({ ...base, extra: 1 }).success).toBe(false);
  });

  it('exposes the PV1 runtime exports from the package domain barrel', () => {
    expect(barrel.PLAN_FEATURE_SET_ID_PATTERN).toBeInstanceOf(RegExp);
    expect(barrel.LANE_PLAN_LIMITS.featureSetTitleBytes).toBe(120);
    expect(typeof barrel.parseLanePlanSidecar).toBe('function');
    expect(typeof barrel.LanePlan.create).toBe('function');
    expect(typeof barrel.PlannedLane.create).toBe('function');
  });
});
