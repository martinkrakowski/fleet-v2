import { describe, expect, it } from 'vitest';

import { LanePlan } from '../entities/LanePlan.js';
import type { LanePlanRecord } from '../lane-plan-records.js';
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
