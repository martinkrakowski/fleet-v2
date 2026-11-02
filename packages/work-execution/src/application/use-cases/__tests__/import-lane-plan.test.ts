/**
 * Unit tests for ImportLanePlanUseCase (WB4a). Every dependency is an
 * in-memory fake; the digest is the real sha256 of the canonical sidecar
 * JSON, and the injected clock is read once per call.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type {
  LanePlanRecord,
  LanePlanSidecar,
  PlannedLaneRecord,
} from '../../../domain/lane-plan-records.js';
import { canonicalLanePlanSidecarJson } from '../../../domain/lane-plan-sidecar.js';
import { findLanePlanCycle, type LanePlanGraphPlan } from '../../../domain/lane-plan-graph.js';
import type {
  LanePlanRepositoryPort,
  SaveLanePlanResult,
} from '../../ports/out/LanePlanRepositoryPort.out-port.js';
import {
  ImportLanePlanUseCase,
  type ImportLanePlanDependencies,
} from '../ImportLanePlanUseCase.use-case.js';

function lanePlanGraphPlanFromRecord(record: LanePlanRecord): LanePlanGraphPlan {
  return {
    projectId: record.projectId,
    planId: record.planId,
    lanes: record.lanes.map((l) => ({
      laneId: l.laneId,
      aliases: l.aliases,
      after: l.after,
    })),
    exclusiveOrder: record.exclusiveOrder,
  };
}

class FakeLanePlanRepo implements LanePlanRepositoryPort {
  readonly store = new Map<string, LanePlanRecord>();
  readonly saved: LanePlanRecord[] = [];

  constructor(seed: readonly LanePlanRecord[] = []) {
    for (const record of seed) {
      this.store.set(`${record.projectId}/${record.planId}`, record);
    }
  }

  async saveLanePlan(record: LanePlanRecord): Promise<void> {
    this.saved.push(record);
    this.store.set(`${record.projectId}/${record.planId}`, record);
  }

  async saveLanePlanIfAcyclic(record: LanePlanRecord): Promise<SaveLanePlanResult> {
    const plans: LanePlanGraphPlan[] = [];
    for (const storedPlan of this.store.values()) {
      if (storedPlan.projectId === record.projectId && storedPlan.planId === record.planId) {
        continue;
      }
      plans.push(lanePlanGraphPlanFromRecord(storedPlan));
    }
    plans.push(lanePlanGraphPlanFromRecord(record));
    const cycle = findLanePlanCycle(plans);
    if (cycle !== null) {
      return { outcome: 'cycle', cycle };
    }
    await this.saveLanePlan(record);
    return { outcome: 'saved' };
  }

  async findLanePlan(projectId: string, planId: string): Promise<LanePlanRecord | null> {
    return this.store.get(`${projectId}/${planId}`) ?? null;
  }

  async listLanePlans(): Promise<readonly LanePlanRecord[]> {
    return [...this.store.values()];
  }
}

const computeDigest = (sidecar: LanePlanSidecar): string =>
  createHash('sha256').update(canonicalLanePlanSidecarJson(sidecar)).digest('hex');

/** A raw sidecar lane: `after` entries are the sidecar's own string references. */
function lane(laneId: string, overrides: Record<string, unknown> = {}) {
  return {
    laneId,
    renamedFrom: null,
    scope: `scope ${laneId}`,
    packages: [`pkg-${laneId.toLowerCase()}`],
    sharedFiles: [],
    tier: 0,
    after: [] as readonly string[],
    decisions: [],
    status: 'planned',
    brief: null,
    mergedPr: null,
    ...overrides,
  };
}

/** A raw sidecar (the JSON.parse result shape), validated by the use case. */
function sidecar(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    projectId: 'proj-1',
    planId: 'plan-1',
    revision: 1,
    doc: 'docs/plan.md',
    lanes: [lane('L1')],
    decisions: [],
    exclusiveOrder: [],
    ...overrides,
  };
}

function storedLane(laneId: string, overrides: Partial<PlannedLaneRecord> = {}): PlannedLaneRecord {
  return {
    laneId,
    aliases: [],
    scope: `scope ${laneId}`,
    packages: [`pkg-${laneId.toLowerCase()}`],
    sharedFiles: [],
    tier: 0,
    after: [],
    decisions: [],
    status: 'planned',
    brief: null,
    mergedPr: null,
    ...overrides,
  };
}

function storedPlan(overrides: Partial<LanePlanRecord> = {}): LanePlanRecord {
  return {
    version: 1,
    projectId: 'proj-1',
    planId: 'plan-1',
    revision: 1,
    digest: 'a'.repeat(64),
    doc: 'docs/plan.md',
    lanes: [storedLane('L1')],
    decisions: [],
    exclusiveOrder: [],
    importedAtIso: '2026-10-25T00:00:00.000Z',
    ...overrides,
  };
}

function makeHarness(overrides: Partial<ImportLanePlanDependencies> = {}) {
  const repo = new FakeLanePlanRepo();
  const deps: ImportLanePlanDependencies = {
    lanePlanRepo: repo,
    computeDigest,
    nowIso: () => '2026-10-26T00:00:00.000Z',
    ...overrides,
  };
  return { repo, useCase: new ImportLanePlanUseCase(deps) };
}

describe('ImportLanePlanUseCase', () => {
  it('refuses a requested project that differs from the sidecar project, writing nothing', async () => {
    const { repo, useCase } = makeHarness();
    const result = await useCase.importLanePlan({
      sidecar: sidecar(),
      requestedProjectId: 'other-project',
    });
    expect(result.outcome).toBe('refused');
    expect(result.outcome === 'refused' ? result.code : '').toBe('project-mismatch');
    expect(repo.saved).toHaveLength(0);
  });

  it('refuses a non-empty requested project, writing nothing', async () => {
    const { repo, useCase } = makeHarness();
    const result = await useCase.importLanePlan({ sidecar: sidecar(), requestedProjectId: '   ' });
    expect(result.outcome).toBe('refused');
    expect(result.outcome === 'refused' ? result.code : '').toBe('request');
    expect(repo.saved).toHaveLength(0);
  });

  it('refuses an invalid sidecar with the parser error list, writing nothing', async () => {
    const { repo, useCase } = makeHarness();
    const result = await useCase.importLanePlan({
      sidecar: { doc: 'docs/plan.md' },
      requestedProjectId: 'proj-1',
    });
    expect(result.outcome).toBe('refused');
    expect(result.outcome === 'refused' ? result.code : '').toBe('sidecar-invalid');
    expect(result.outcome === 'refused' ? result.reason : '').toContain('sidecar');
    expect(repo.saved).toHaveLength(0);
  });

  it('refuses a lower revision as stale-revision, writing nothing', async () => {
    const { repo, useCase } = makeHarness();
    await useCase.importLanePlan({ sidecar: sidecar({ revision: 2 }), requestedProjectId: 'proj-1' });
    const result = await useCase.importLanePlan({
      sidecar: sidecar({ revision: 1 }),
      requestedProjectId: 'proj-1',
    });
    expect(result.outcome).toBe('refused');
    expect(result.outcome === 'refused' ? result.code : '').toBe('stale-revision');
    expect(repo.saved).toHaveLength(1);
  });

  it('treats the same revision with the same digest as unchanged, saving nothing', async () => {
    const { repo, useCase } = makeHarness();
    const first = await useCase.importLanePlan({
      sidecar: sidecar({ revision: 1 }),
      requestedProjectId: 'proj-1',
    });
    expect(first.outcome).toBe('imported');
    const second = await useCase.importLanePlan({
      sidecar: sidecar({ revision: 1 }),
      requestedProjectId: 'proj-1',
    });
    expect(second.outcome).toBe('unchanged');
    expect(repo.saved).toHaveLength(1);
  });

  it('refuses the same revision with a different digest as stale-revision', async () => {
    const { repo, useCase } = makeHarness();
    await useCase.importLanePlan({ sidecar: sidecar({ revision: 1 }), requestedProjectId: 'proj-1' });
    const result = await useCase.importLanePlan({
      sidecar: sidecar({ revision: 1, doc: 'docs/other.md' }),
      requestedProjectId: 'proj-1',
    });
    expect(result.outcome).toBe('refused');
    expect(result.outcome === 'refused' ? result.code : '').toBe('stale-revision');
    expect(repo.saved).toHaveLength(1);
  });

  it('imports a greater revision', async () => {
    const { useCase } = makeHarness();
    await useCase.importLanePlan({ sidecar: sidecar({ revision: 1 }), requestedProjectId: 'proj-1' });
    const result = await useCase.importLanePlan({
      sidecar: sidecar({ revision: 2 }),
      requestedProjectId: 'proj-1',
    });
    expect(result.outcome).toBe('imported');
    if (result.outcome === 'imported') {
      expect(result.plan.revision).toBe(2);
      expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('importing the identical sidecar twice yields imported then unchanged with the stored digest', async () => {
    const { useCase } = makeHarness();
    const first = await useCase.importLanePlan({
      sidecar: sidecar(),
      requestedProjectId: 'proj-1',
    });
    expect(first.outcome).toBe('imported');
    const second = await useCase.importLanePlan({
      sidecar: sidecar(),
      requestedProjectId: 'proj-1',
    });
    expect(second.outcome).toBe('unchanged');
    if (first.outcome === 'imported' && second.outcome === 'unchanged') {
      expect(second.plan.digest).toBe(first.plan.digest);
    }
  });

  it('refuses an import that closes a cross-plan cycle and names the two refs', async () => {
    const storedB = storedPlan({
      projectId: 'proj-1',
      planId: 'plan-B',
      lanes: [
        storedLane('L1', {
          after: [{ projectId: 'proj-1', planId: 'plan-1', laneId: 'L2' }],
        }),
      ],
    });
    const { repo, useCase } = makeHarness({ lanePlanRepo: new FakeLanePlanRepo([storedB]) });
    const incomingA = sidecar({
      planId: 'plan-1',
      revision: 2,
      lanes: [
        lane('L1'),
        lane('L2', { after: ['plan-B/L1'] }),
      ],
    });
    const result = await useCase.importLanePlan({
      sidecar: incomingA,
      requestedProjectId: 'proj-1',
    });
    expect(result.outcome).toBe('refused');
    expect(result.outcome === 'refused' ? result.code : '').toBe('plan-cycle');
    const reason = result.outcome === 'refused' ? result.reason : '';
    expect(reason).toContain('plan-1/L2');
    expect(reason).toContain('plan-B/L1');
    expect(repo.saved).toHaveLength(0);
  });

  it('imports the same sidecar when the back edge is absent', async () => {
    const storedB = storedPlan({
      projectId: 'proj-1',
      planId: 'plan-B',
      lanes: [
        storedLane('L1', {
          after: [{ projectId: 'proj-1', planId: 'plan-1', laneId: 'L2' }],
        }),
      ],
    });
    const { useCase } = makeHarness({ lanePlanRepo: new FakeLanePlanRepo([storedB]) });
    const incomingA = sidecar({
      planId: 'plan-1',
      revision: 2,
      lanes: [lane('L1'), lane('L2')],
    });
    const result = await useCase.importLanePlan({
      sidecar: incomingA,
      requestedProjectId: 'proj-1',
    });
    expect(result.outcome).toBe('imported');
  });

  it('refuses an import whose dropped lane closes a cross-plan cycle', async () => {
    // Plan A revision 1 has L1 and L2 (after plan-A/L1).
    const storedPlanA = storedPlan({
      projectId: 'proj-1',
      planId: 'plan-A',
      revision: 1,
      lanes: [
        storedLane('L1'),
        storedLane('L2', {
          after: [{ projectId: 'proj-1', planId: 'plan-A', laneId: 'L1' }],
        }),
      ],
    });
    // Plan C revision 1 has L1 (after plan-A/L2).
    const storedPlanC = storedPlan({
      projectId: 'proj-1',
      planId: 'plan-C',
      revision: 1,
      lanes: [
        storedLane('L1', {
          after: [{ projectId: 'proj-1', planId: 'plan-A', laneId: 'L2' }],
        }),
      ],
    });
    const { repo, useCase } = makeHarness({
      lanePlanRepo: new FakeLanePlanRepo([storedPlanA, storedPlanC]),
    });

    // Plan A revision 2 keeps only L1 with after plan-C/L1, omitting L2.
    // L2 is reattached as dropped with after plan-A/L1.
    // The resulting graph is plan-A/L1 -> plan-C/L1 -> plan-A/L2 -> plan-A/L1 (cycle!).
    const incomingA = sidecar({
      projectId: 'proj-1',
      planId: 'plan-A',
      revision: 2,
      lanes: [
        lane('L1', { after: ['plan-C/L1'] }),
      ],
    });

    const result = await useCase.importLanePlan({
      sidecar: incomingA,
      requestedProjectId: 'proj-1',
    });

    expect(result.outcome).toBe('refused');
    expect(result.outcome === 'refused' ? result.code : '').toBe('plan-cycle');
    const reason = result.outcome === 'refused' ? result.reason : '';
    expect(reason).toContain('plan-A/L1');
    expect(reason).toContain('plan-C/L1');
    expect(reason).toContain('plan-A/L2');
    expect(repo.saved).toHaveLength(0);
  });

  it('keeps a removed lane as dropped with its fields intact, sorted by laneId', async () => {
    const stored = storedPlan({
      lanes: [
        storedLane('L1', { scope: 'first', packages: ['pkg-a'] }),
        storedLane('L2', { scope: 'second', packages: ['pkg-b'], tier: 1 }),
      ],
    });
    const { useCase } = makeHarness({ lanePlanRepo: new FakeLanePlanRepo([stored]) });
    const result = await useCase.importLanePlan({
      sidecar: sidecar({ revision: 2, lanes: [lane('L1', { scope: 'first' })] }),
      requestedProjectId: 'proj-1',
    });
    expect(result.outcome).toBe('imported');
    if (result.outcome !== 'imported') {
      return;
    }
    expect(result.plan.lanes.map((lane) => lane.laneId)).toEqual(['L1', 'L2']);
    const l2 = result.plan.lanes.find((lane) => lane.laneId === 'L2');
    expect(l2?.status).toBe('dropped');
    expect(l2?.scope).toBe('second');
    expect(l2?.packages).toEqual(['pkg-b']);
    expect(l2?.tier).toBe(1);
    const l1 = result.plan.lanes.find((lane) => lane.laneId === 'L1');
    expect(l1?.status).toBe('planned');
  });

  it('keeps a sidecar lane marked dropped as dropped', async () => {
    const { useCase } = makeHarness();
    const result = await useCase.importLanePlan({
      sidecar: sidecar({
        lanes: [lane('L1'), lane('L2', { status: 'dropped' })],
      }),
      requestedProjectId: 'proj-1',
    });
    expect(result.outcome).toBe('imported');
    if (result.outcome !== 'imported') {
      return;
    }
    const l2 = result.plan.lanes.find((lane) => lane.laneId === 'L2');
    expect(l2?.status).toBe('dropped');
  });

  it('never echoes sidecar doc, scope or free-text values in a refusal reason', async () => {
    const { useCase } = makeHarness();
    const secretDoc = 'docs/secret-plan.md';
    const secretScope = 'top secret scope value';
    const secretFreeText = 'this-is-some-free-text';

    const mismatch = await useCase.importLanePlan({
      sidecar: sidecar({ doc: secretDoc, lanes: [lane('L1', { scope: secretScope })] }),
      requestedProjectId: 'other-project',
    });
    expect(mismatch.outcome).toBe('refused');
    if (mismatch.outcome === 'refused') {
      expect(mismatch.reason).not.toContain(secretDoc);
      expect(mismatch.reason).not.toContain(secretScope);
      expect(mismatch.reason).not.toContain(secretFreeText);
    }

    await useCase.importLanePlan({
      sidecar: sidecar({ doc: secretDoc, lanes: [lane('L1', { scope: secretScope })] }),
      requestedProjectId: 'proj-1',
    });
    const stale = await useCase.importLanePlan({
      sidecar: sidecar({ doc: secretDoc, lanes: [lane('L1', { scope: secretScope })] }),
      requestedProjectId: 'proj-1',
    });
    expect(stale.outcome).toBe('unchanged');

    const invalid = await useCase.importLanePlan({
      sidecar: { freeText: secretFreeText },
      requestedProjectId: 'proj-1',
    });
    expect(invalid.outcome).toBe('refused');
    if (invalid.outcome === 'refused') {
      expect(invalid.reason).not.toContain(secretFreeText);
      expect(invalid.reason).not.toContain(secretDoc);
      expect(invalid.reason).not.toContain(secretScope);
    }
  });

  it('reads the injected clock once per call for importedAtIso', async () => {
    const nowIso = vi.fn(() => '2026-10-26T00:00:00.000Z');
    const { useCase } = makeHarness({ nowIso });
    const result = await useCase.importLanePlan({
      sidecar: sidecar(),
      requestedProjectId: 'proj-1',
    });
    expect(result.outcome).toBe('imported');
    expect(nowIso).toHaveBeenCalledTimes(1);
    if (result.outcome === 'imported') {
      expect(result.plan.importedAtIso).toBe('2026-10-26T00:00:00.000Z');
    }
  });

  it('concurrently importing two mutually dependent plans results in exactly one succeeding', async () => {
    const { repo, useCase } = makeHarness();
    const incomingA = sidecar({
      planId: 'plan-A',
      lanes: [lane('L1', { after: ['plan-B/L1'] })],
    });
    const incomingB = sidecar({
      planId: 'plan-B',
      lanes: [lane('L1', { after: ['plan-A/L1'] })],
    });

    const [resA, resB] = await Promise.all([
      useCase.importLanePlan({ sidecar: incomingA, requestedProjectId: 'proj-1' }),
      useCase.importLanePlan({ sidecar: incomingB, requestedProjectId: 'proj-1' }),
    ]);

    const outcomes = [resA.outcome, resB.outcome];
    expect(outcomes).toContain('imported');
    expect(outcomes).toContain('refused');

    const refused = resA.outcome === 'refused' ? resA : resB;
    if (refused.outcome === 'refused') {
      expect(refused.code).toBe('plan-cycle');
      expect(refused.reason).toContain('plan-A/L1');
      expect(refused.reason).toContain('plan-B/L1');
    }

    expect(repo.saved).toHaveLength(1);
    expect(repo.store.size).toBe(1);
  });

  it('returns a store refusal when findLanePlan throws on store read failure', async () => {
    const repo = new FakeLanePlanRepo();
    repo.findLanePlan = async () => {
      throw new Error('unreadable store file');
    };
    const { useCase } = makeHarness({ lanePlanRepo: repo });
    const result = await useCase.importLanePlan({
      sidecar: sidecar(),
      requestedProjectId: 'proj-1',
    });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.code).toBe('store');
      expect(result.reason).toBe('the store could not be read');
    }
  });
});
