/**
 * Unit tests for the mergedPr backfill on import (WB4b). The plan import
 * itself always succeeds; each backfilled link is reported in result.links.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type {
  LanePlanRecord,
  LanePlanSidecar,
  PullRequestLinkRecord,
} from '../../../domain/lane-plan-records.js';
import { canonicalLanePlanSidecarJson } from '../../../domain/lane-plan-sidecar.js';
import {
  decidePullRequestLink,
  pullRequestLinkKey,
} from '../../../domain/entities/PullRequestLink.js';
import type {
  LanePlanRepositoryPort,
  SaveLanePlanResult,
  SavePullRequestLinkResult,
} from '../../ports/out/LanePlanRepositoryPort.out-port.js';
import {
  ImportLanePlanUseCase,
  type ImportLanePlanDependencies,
} from '../ImportLanePlanUseCase.use-case.js';

class FakeLanePlanRepo implements LanePlanRepositoryPort {
  readonly store = new Map<string, LanePlanRecord>();
  readonly saved: LanePlanRecord[] = [];
  readonly links = new Map<string, PullRequestLinkRecord>();

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
    await this.saveLanePlan(record);
    return { outcome: 'saved' };
  }

  async findLanePlan(projectId: string, planId: string): Promise<LanePlanRecord | null> {
    return this.store.get(`${projectId}/${planId}`) ?? null;
  }

  async listLanePlans(): Promise<readonly LanePlanRecord[]> {
    return [...this.store.values()];
  }

  async savePullRequestLink(record: PullRequestLinkRecord): Promise<SavePullRequestLinkResult> {
    const key = pullRequestLinkKey({ repository: record.repository, number: record.number });
    const existing = this.links.get(key) ?? null;
    const decision = decidePullRequestLink(existing, record);
    if (decision === 'create') {
      this.links.set(key, record);
      return { outcome: 'saved', link: record };
    }
    if (decision === 'no-op') {
      return { outcome: 'unchanged', link: existing as PullRequestLinkRecord };
    }
    return { outcome: 'refused', code: 'pr-already-linked', linkedLaneId: existing!.laneId };
  }

  async findPullRequestLink(repository: string, number: number): Promise<PullRequestLinkRecord | null> {
    return this.links.get(pullRequestLinkKey({ repository, number })) ?? null;
  }

  async listPullRequestLinks(projectId?: string): Promise<readonly PullRequestLinkRecord[]> {
    const records = [...this.links.values()];
    return projectId === undefined ? records : records.filter((link) => link.projectId === projectId);
  }
}

/** A raw sidecar lane: `mergedPr` pairs the lane with a PR that merged before the board existed. */
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

const computeDigest = (sidecar: LanePlanSidecar): string =>
  createHash('sha256').update(canonicalLanePlanSidecarJson(sidecar)).digest('hex');

function makeHarness(overrides: Partial<ImportLanePlanDependencies> = {}) {
  const repo = (overrides.lanePlanRepo ?? new FakeLanePlanRepo()) as FakeLanePlanRepo;
  const deps: ImportLanePlanDependencies = {
    lanePlanRepo: repo,
    computeDigest,
    nowIso: () => '2026-10-26T00:00:00.000Z',
    ...overrides,
  };
  return { repo, useCase: new ImportLanePlanUseCase(deps) };
}

const MERGED_PR_SIDECAR = sidecar({
  lanes: [lane('L1', { mergedPr: { repository: 'acme/app', number: 251 } })],
});

describe('ImportLanePlanUseCase mergedPr backfill', () => {
  it('backfills a lane mergedPr as a sidecar link and reports it in links', async () => {
    const { repo, useCase } = makeHarness();
    const result = await useCase.importLanePlan({
      sidecar: MERGED_PR_SIDECAR,
      requestedProjectId: 'proj-1',
    });
    expect(result.outcome).toBe('imported');
    if (result.outcome !== 'imported') {
      return;
    }
    expect(result.links).toEqual([
      { repository: 'acme/app', number: 251, laneId: 'L1', outcome: 'linked', code: null },
    ]);
    expect(repo.links.size).toBe(1);
    const stored = [...repo.links.values()][0];
    expect(stored).toMatchObject({
      repository: 'acme/app',
      number: 251,
      projectId: 'proj-1',
      planId: 'plan-1',
      laneId: 'L1',
      source: 'sidecar',
      linkedAtIso: '2026-10-26T00:00:00.000Z',
    });
  });

  it('importing the identical sidecar again is unchanged and writes no second link', async () => {
    const { repo, useCase } = makeHarness();
    const first = await useCase.importLanePlan({
      sidecar: MERGED_PR_SIDECAR,
      requestedProjectId: 'proj-1',
    });
    expect(first.outcome).toBe('imported');
    const second = await useCase.importLanePlan({
      sidecar: MERGED_PR_SIDECAR,
      requestedProjectId: 'proj-1',
    });
    expect(second.outcome).toBe('unchanged');
    expect(repo.links.size).toBe(1);
  });

  it('reports a mergedPr already linked to another lane as refused while the import still succeeds', async () => {
    const repo = new FakeLanePlanRepo();
    await repo.savePullRequestLink({
      version: 1,
      repository: 'acme/app',
      number: 251,
      projectId: 'proj-1',
      planId: 'plan-1',
      laneId: 'L2',
      source: 'sidecar',
      linkedAtIso: '2026-10-25T00:00:00.000Z',
    });
    const { useCase } = makeHarness({ lanePlanRepo: repo });
    const result = await useCase.importLanePlan({
      sidecar: MERGED_PR_SIDECAR,
      requestedProjectId: 'proj-1',
    });
    expect(result.outcome).toBe('imported');
    if (result.outcome !== 'imported') {
      return;
    }
    expect(result.links).toEqual([
      {
        repository: 'acme/app',
        number: 251,
        laneId: 'L1',
        outcome: 'refused',
        code: 'pr-already-linked',
      },
    ]);
    expect(repo.links.get('acme/app#251')?.laneId).toBe('L2');
  });

  it('a sidecar with no mergedPr yields an empty links array', async () => {
    const { repo, useCase } = makeHarness();
    const result = await useCase.importLanePlan({
      sidecar: sidecar(),
      requestedProjectId: 'proj-1',
    });
    expect(result.outcome).toBe('imported');
    if (result.outcome !== 'imported') {
      return;
    }
    expect(result.links).toEqual([]);
    expect(repo.links.size).toBe(0);
  });
});
