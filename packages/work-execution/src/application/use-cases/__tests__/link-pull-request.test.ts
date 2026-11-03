/**
 * Unit tests for LinkPullRequestUseCase (WB4b). Every dependency is an
 * in-memory fake; the injected clock is read once per call, mirroring the
 * harness in import-lane-plan.test.ts.
 */

import { describe, expect, it } from 'vitest';

import type {
  LanePlanRecord,
  PlannedLaneRecord,
  PullRequestLinkRecord,
} from '../../../domain/lane-plan-records.js';
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
  LinkPullRequestUseCase,
  type LinkPullRequestDependencies,
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

function validRequest(overrides: Partial<Parameters<LinkPullRequestUseCase['linkPullRequest']>[0]> = {}) {
  return {
    repository: 'acme/app',
    number: 251,
    projectId: 'proj-1',
    planId: 'plan-1',
    laneId: 'L1',
    source: 'cli' as const,
    ...overrides,
  };
}

function makeHarness(overrides: Partial<LinkPullRequestDependencies> = {}) {
  const repo = (overrides.lanePlanRepo ?? new FakeLanePlanRepo()) as FakeLanePlanRepo;
  const deps: LinkPullRequestDependencies = {
    lanePlanRepo: repo,
    nowIso: () => '2026-10-26T00:00:00.000Z',
    ...overrides,
  };
  return { repo, useCase: new LinkPullRequestUseCase(deps) };
}

describe('LinkPullRequestUseCase', () => {
  it('links a PR to a lane, storing the record with the injected clock', async () => {
    const { repo, useCase } = makeHarness({
      lanePlanRepo: new FakeLanePlanRepo([storedPlan()]),
    });
    const result = await useCase.linkPullRequest(validRequest());
    expect(result.outcome).toBe('linked');
    if (result.outcome !== 'linked') {
      return;
    }
    expect(result.link).toMatchObject({
      repository: 'acme/app',
      number: 251,
      projectId: 'proj-1',
      planId: 'plan-1',
      laneId: 'L1',
      source: 'cli',
      linkedAtIso: '2026-10-26T00:00:00.000Z',
    });
    expect(repo.links.size).toBe(1);
    expect(repo.links.get('acme/app#251')?.laneId).toBe('L1');
  });

  it('links a PR to a lane with no plan under the given lane id', async () => {
    const { repo, useCase } = makeHarness();
    const result = await useCase.linkPullRequest(
      validRequest({ planId: null, laneId: 'work-order-lane' }),
    );
    expect(result.outcome).toBe('linked');
    if (result.outcome !== 'linked') {
      return;
    }
    expect(result.link).toMatchObject({ planId: null, laneId: 'work-order-lane' });
    expect(repo.links.size).toBe(1);
  });

  it('returns unchanged for the same PR and lane, storing one record', async () => {
    const { repo, useCase } = makeHarness({
      lanePlanRepo: new FakeLanePlanRepo([storedPlan()]),
    });
    const request = validRequest();
    const first = await useCase.linkPullRequest(request);
    expect(first.outcome).toBe('linked');
    const second = await useCase.linkPullRequest(request);
    expect(second.outcome).toBe('unchanged');
    expect(repo.links.size).toBe(1);
  });

  it('refuses a PR already linked to another lane, naming the linked lane id only', async () => {
    const repo = new FakeLanePlanRepo([storedPlan()]);
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
    const result = await useCase.linkPullRequest(validRequest());
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') {
      return;
    }
    expect(result.code).toBe('pr-already-linked');
    expect(result.reason).toBe('the pull request is already linked to lane L2');
    expect(repo.links.get('acme/app#251')?.laneId).toBe('L2');
  });

  it('stores a lane named by its alias under its current id', async () => {
    const plan = storedPlan({ lanes: [storedLane('L1', { aliases: ['legacy-L1'] })] });
    const { repo, useCase } = makeHarness({ lanePlanRepo: new FakeLanePlanRepo([plan]) });
    const result = await useCase.linkPullRequest(validRequest({ laneId: 'legacy-L1' }));
    expect(result.outcome).toBe('linked');
    if (result.outcome !== 'linked') {
      return;
    }
    expect(result.link.laneId).toBe('L1');
    expect(repo.links.get('acme/app#251')?.laneId).toBe('L1');
  });

  it('treats a stored link whose lane id is an alias of the same lane as unchanged', async () => {
    const plan = storedPlan({ lanes: [storedLane('L1', { aliases: ['legacy-L1'] })] });
    const repo = new FakeLanePlanRepo([plan]);
    await repo.savePullRequestLink({
      version: 1,
      repository: 'acme/app',
      number: 251,
      projectId: 'proj-1',
      planId: 'plan-1',
      laneId: 'legacy-L1',
      source: 'sidecar',
      linkedAtIso: '2026-10-25T00:00:00.000Z',
    });
    const { useCase } = makeHarness({ lanePlanRepo: repo });
    const result = await useCase.linkPullRequest(validRequest());
    expect(result.outcome).toBe('unchanged');
    expect(repo.links.size).toBe(1);
    expect(repo.links.get('acme/app#251')?.laneId).toBe('legacy-L1');
  });

  it('refuses an unknown plan or an unknown lane as unknown-lane, writing nothing', async () => {
    const { repo, useCase } = makeHarness({
      lanePlanRepo: new FakeLanePlanRepo([storedPlan()]),
    });
    const unknownPlan = await useCase.linkPullRequest(validRequest({ planId: 'plan-missing' }));
    expect(unknownPlan.outcome).toBe('refused');
    if (unknownPlan.outcome === 'refused') {
      expect(unknownPlan.code).toBe('unknown-lane');
      expect(unknownPlan.reason).toBe('the plan is not imported');
    }
    const unknownLane = await useCase.linkPullRequest(validRequest({ laneId: 'nope' }));
    expect(unknownLane.outcome).toBe('refused');
    if (unknownLane.outcome === 'refused') {
      expect(unknownLane.code).toBe('unknown-lane');
      expect(unknownLane.reason).toBe('the plan names no lane with that id');
    }
    expect(repo.links.size).toBe(0);
  });

  it('refuses an invalid request as invalid, echoing no supplied value', async () => {
    const { repo, useCase } = makeHarness({
      lanePlanRepo: new FakeLanePlanRepo([storedPlan()]),
    });
    const result = await useCase.linkPullRequest(validRequest({ number: 0 }));
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.code).toBe('invalid');
      expect(result.reason).toBe('number must be a positive integer');
    }
    expect(repo.links.size).toBe(0);
  });

  it('refuses a throwing store as store, and never throws', async () => {
    const repo = new FakeLanePlanRepo([storedPlan()]);
    repo.savePullRequestLink = async () => {
      throw new Error('store unreadable on purpose');
    };
    const { useCase } = makeHarness({ lanePlanRepo: repo });
    const result = await useCase.linkPullRequest(validRequest());
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.code).toBe('store');
      expect(result.reason).toBe('the store refused the save');
    }
  });
});
