import { describe, expect, it } from 'vitest';
import type { CoordinationRequestRecord, ProjectProfileRecord } from '../../domain/coordination-records.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import type { ProjectProfileRepositoryPort } from '../ports/out/ProjectProfileRepositoryPort.out-port.js';
import { IssueMergeGrantUseCase } from './IssueMergeGrantUseCase.use-case.js';

class InMemoryCoordinationRequestRepository implements CoordinationRequestRepositoryPort {
  private readonly records = new Map<string, CoordinationRequestRecord>();

  async saveRequest(record: CoordinationRequestRecord): Promise<void> {
    this.records.set(record.id, { ...record });
  }

  async findRequestById(id: string): Promise<CoordinationRequestRecord | null> {
    const found = this.records.get(id);
    return found ? { ...found } : null;
  }

  async findRequestByGrantId(grantId: string): Promise<CoordinationRequestRecord | null> {
    for (const record of this.records.values()) {
      if (record.grantId === grantId) {
        return { ...record };
      }
    }
    return null;
  }

  async listRequests(projectId?: string): Promise<readonly CoordinationRequestRecord[]> {
    const all = Array.from(this.records.values());
    if (projectId === undefined) {
      return all;
    }
    return all.filter((r) => r.projectId === projectId);
  }
}

class StubProfileRepository implements ProjectProfileRepositoryPort {
  constructor(private profile: ProjectProfileRecord | null = null, private shouldThrow = false) {}

  async saveProfile(record: ProjectProfileRecord): Promise<void> {
    this.profile = record;
  }

  async findProfileById(_projectId: string): Promise<ProjectProfileRecord | null> {
    if (this.shouldThrow) {
      throw new Error('store failure');
    }
    return this.profile;
  }

  async listProfiles(): Promise<readonly ProjectProfileRecord[]> {
    return this.profile ? [this.profile] : [];
  }
}

function makeProfile(projectId: string, policyRevision: string): ProjectProfileRecord {
  return {
    projectId,
    displayName: 'Test Project',
    repository: 'owner/repo',
    designatedDispatcherHost: 'host1',
    policyRevision,
    maxConcurrentLanes: 1,
    runnerCapabilities: {},
    revision: 1,
    updatedAtIso: '2026-11-02T00:00:00.000Z',
    status: 'active',
    defaultBranch: 'main',
    clones: {},
    gateProcedures: [],
    defaultAllowedPathPrefixes: [],
    lastProbe: null,
  };
}

describe('IssueMergeGrantUseCase policy revision check', () => {
  const headSha = '1111111111111111111111111111111111111111';
  const settingRev = 'aaaaaaaaaaaa';
  const otherRev = 'bbbbbbbbbbbb';

  const defaultRequest = {
    projectId: 'proj-1',
    repository: { owner: 'test-owner', repo: 'test-repo' },
    pullRequestNumber: 42,
    expectedHeadSha: headSha,
    forgeKind: 'merge-pr' as const,
    settingRevision: settingRev,
    deadlineIso: '2026-11-02T01:00:00.000Z',
  };

  it('refuses when policy cannot be read (profile not found)', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    const profileRepo = new StubProfileRepository(null);
    let idCounter = 1;
    const useCase = new IssueMergeGrantUseCase({
      requestRepo,
      profileRepo,
      clock: { nowIso: () => '2026-11-02T00:00:00.000Z' },
      ids: {
        newRequestId: () => `req-${idCounter++}`,
        newGrantId: () => `grant-${idCounter++}`,
      },
    });

    const result = await useCase.issueMergeGrant(defaultRequest);
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('the current policy revision could not be read');
    }
  });

  it('refuses when policy repository throws an error (unreadable)', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    const profileRepo = new StubProfileRepository(null, true);
    let idCounter = 1;
    const useCase = new IssueMergeGrantUseCase({
      requestRepo,
      profileRepo,
      clock: { nowIso: () => '2026-11-02T00:00:00.000Z' },
      ids: {
        newRequestId: () => `req-${idCounter++}`,
        newGrantId: () => `grant-${idCounter++}`,
      },
    });

    const result = await useCase.issueMergeGrant(defaultRequest);
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('the current policy revision could not be read');
    }
  });

  it('refuses when the profile store is absent (profile not found covers it)', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    let idCounter = 1;
    const useCase = new IssueMergeGrantUseCase({
      requestRepo,
      profileRepo: new StubProfileRepository(null),
      clock: { nowIso: () => '2026-11-02T00:00:00.000Z' },
      ids: {
        newRequestId: () => `req-${idCounter++}`,
        newGrantId: () => `grant-${idCounter++}`,
      },
    });

    const result = await useCase.issueMergeGrant(defaultRequest);
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('the current policy revision could not be read');
    }
  });

  it('refuses when current policy revision differs from supplied revision', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    const profileRepo = new StubProfileRepository(makeProfile('proj-1', otherRev));
    let idCounter = 1;
    const useCase = new IssueMergeGrantUseCase({
      requestRepo,
      profileRepo,
      clock: { nowIso: () => '2026-11-02T00:00:00.000Z' },
      ids: {
        newRequestId: () => `req-${idCounter++}`,
        newGrantId: () => `grant-${idCounter++}`,
      },
    });

    const result = await useCase.issueMergeGrant(defaultRequest);
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('differs from the supplied revision');
    }
  });

  it('issues grant when current policy revision matches supplied revision', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    const profileRepo = new StubProfileRepository(makeProfile('proj-1', settingRev));
    let idCounter = 1;
    const useCase = new IssueMergeGrantUseCase({
      requestRepo,
      profileRepo,
      clock: { nowIso: () => '2026-11-02T00:00:00.000Z' },
      ids: {
        newRequestId: () => `req-${idCounter++}`,
        newGrantId: () => `grant-${idCounter++}`,
      },
    });

    const result = await useCase.issueMergeGrant(defaultRequest);
    expect(result.outcome).toBe('issued');
    if (result.outcome === 'issued') {
      expect(result.decisionRevision).toBe(`policy:merge@${settingRev}`);
    }
  });
});
