import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { ImportLanePlanUseCase } from '../src/application/use-cases/ImportLanePlanUseCase.use-case.js';
import { LanePlanRepositoryAdapter } from '../src/infrastructure/adapters/LanePlanRepositoryAdapter.adapter.js';
import { canonicalLanePlanSidecarJson } from '../src/domain/lane-plan-sidecar.js';
import type { LanePlanSidecar } from '../src/domain/lane-plan-records.js';

function computeDigest(sidecar: LanePlanSidecar): string {
  return createHash('sha256').update(canonicalLanePlanSidecarJson(sidecar)).digest('hex');
}

describe('ImportLanePlanUseCase', () => {
  const sidecarA = {
    schemaVersion: 1,
    projectId: 'proj-1',
    planId: 'plan-a',
    revision: 1,
    doc: 'doc/plan-a.md',
    lanes: [
      {
        laneId: 'lane-a',
        scope: 'scope for lane a',
        packages: ['work-execution'],
        tier: 0,
        after: ['proj-1/plan-b/lane-b'],
      },
    ],
  };

  const sidecarB = {
    schemaVersion: 1,
    projectId: 'proj-1',
    planId: 'plan-b',
    revision: 1,
    doc: 'doc/plan-b.md',
    lanes: [
      {
        laneId: 'lane-b',
        scope: 'scope for lane b',
        packages: ['work-execution'],
        tier: 0,
        after: ['proj-1/plan-a/lane-a'],
      },
    ],
  };

  it('concurrently importing two plans forming a cycle: exactly one succeeds in memory (finding 1)', async () => {
    const repo = new LanePlanRepositoryAdapter();
    const useCase = new ImportLanePlanUseCase({
      lanePlanRepo: repo,
      computeDigest,
      nowIso: () => '2026-11-02T00:00:00.000Z',
    });

    const [resA, resB] = await Promise.all([
      useCase.importLanePlan({ sidecar: sidecarA, requestedProjectId: 'proj-1' }),
      useCase.importLanePlan({ sidecar: sidecarB, requestedProjectId: 'proj-1' }),
    ]);

    const successes = [resA, resB].filter((r) => r.outcome === 'imported');
    const cycleRefusals = [resA, resB].filter(
      (r) => r.outcome === 'refused' && r.code === 'plan-cycle',
    );

    expect(successes).toHaveLength(1);
    expect(cycleRefusals).toHaveLength(1);
  });

  it('concurrently importing two plans forming a cycle: exactly one succeeds with file lock (finding 1)', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-plan-test-'));
    try {
      const repo = new LanePlanRepositoryAdapter({ stateDir: tempDir });
      const useCase = new ImportLanePlanUseCase({
        lanePlanRepo: repo,
        computeDigest,
        nowIso: () => '2026-11-02T00:00:00.000Z',
      });

      const [resA, resB] = await Promise.all([
        useCase.importLanePlan({ sidecar: sidecarA, requestedProjectId: 'proj-1' }),
        useCase.importLanePlan({ sidecar: sidecarB, requestedProjectId: 'proj-1' }),
      ]);

      const successes = [resA, resB].filter((r) => r.outcome === 'imported');
      const cycleRefusals = [resA, resB].filter(
        (r) => r.outcome === 'refused' && r.code === 'plan-cycle',
      );

      expect(successes).toHaveLength(1);
      expect(cycleRefusals).toHaveLength(1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('maps store read errors in findLanePlan to store refusal (finding 2)', async () => {
    const faultyRepo = {
      saveLanePlan: async () => {},
      saveLanePlanIfAcyclic: async () => ({ outcome: 'saved' as const }),
      findLanePlan: async () => {
        throw new Error('store read failure: lane-plans.json unreadable');
      },
      listLanePlans: async () => [],
    };
    const useCase = new ImportLanePlanUseCase({
      lanePlanRepo: faultyRepo,
      computeDigest,
      nowIso: () => '2026-11-02T00:00:00.000Z',
    });

    const result = await useCase.importLanePlan({
      sidecar: sidecarA,
      requestedProjectId: 'proj-1',
    });

    expect(result).toEqual({
      outcome: 'refused',
      code: 'store',
      reason: 'the store could not be read',
    });
  });

  it('maps corrupted disk file store read failure to store refusal (finding 2)', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-corrupt-test-'));
    try {
      await fs.writeFile(path.join(tempDir, 'lane-plans.json'), 'not valid json {{{');
      const repo = new LanePlanRepositoryAdapter({ stateDir: tempDir });
      const useCase = new ImportLanePlanUseCase({
        lanePlanRepo: repo,
        computeDigest,
        nowIso: () => '2026-11-02T00:00:00.000Z',
      });

      const result = await useCase.importLanePlan({
        sidecar: sidecarA,
        requestedProjectId: 'proj-1',
      });

      expect(result.outcome).toBe('refused');
      if (result.outcome === 'refused') {
        expect(result.code).toBe('store');
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
