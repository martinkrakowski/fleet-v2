import { describe, expect, it } from 'vitest';
import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import { ResolveActionAuthorizationUseCase } from './ResolveActionAuthorizationUseCase.use-case.js';

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

describe('ResolveActionAuthorizationUseCase', () => {
  const headSha = '1111111111111111111111111111111111111111';

  function createMergeGrantRecord(overrides?: Partial<CoordinationRequestRecord>): CoordinationRequestRecord {
    return {
      id: 'req-1',
      projectId: 'proj-1',
      kind: 'action-decision',
      state: 'approved',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: headSha,
      proposalDigest: 'digest-1',
      policyRevision: 'aaaaaaaaaaaa',
      decisionRevision: 'policy:merge@aaaaaaaaaaaa',
      grantId: 'grant-1',
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'delivered',
      deliveryGapReason: null,
      revision: 1,
      createdAtIso: '2026-11-02T00:00:00.000Z',
      updatedAtIso: '2026-11-02T00:00:00.000Z',
      mergeGrant: {
        repository: { owner: 'repo-a-owner', repo: 'repo-a' },
        pullRequestNumber: 1,
      },
      ...overrides,
    };
  }

  function createStandardGrantRecord(overrides?: Partial<CoordinationRequestRecord>): CoordinationRequestRecord {
    return {
      id: 'req-2',
      projectId: 'proj-1',
      kind: 'action-decision',
      state: 'approved',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: headSha,
      proposalDigest: 'digest-2',
      policyRevision: 'p1',
      decisionRevision: 'dec-1',
      grantId: 'grant-2',
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'delivered',
      deliveryGapReason: null,
      revision: 1,
      createdAtIso: '2026-11-02T00:00:00.000Z',
      updatedAtIso: '2026-11-02T00:00:00.000Z',
      ...overrides,
    };
  }

  it('authorizes a merge grant when repository and pull request match', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    const grant = createMergeGrantRecord();
    await requestRepo.saveRequest(grant);

    const useCase = new ResolveActionAuthorizationUseCase({ requestRepo });
    const result = await useCase.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: headSha,
      authorizationGrantId: 'grant-1',
      repository: { owner: 'repo-a-owner', repo: 'repo-a' },
      pullRequestNumber: 1,
    });

    expect(result.outcome).toBe('authorized');
    if (result.outcome === 'authorized') {
      expect(result.grantId).toBe('grant-1');
      expect(result.requestId).toBe('req-1');
    }
  });

  it('refuses to authorize repo B PR 2 with a grant issued for repo A PR 1', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    const grant = createMergeGrantRecord();
    await requestRepo.saveRequest(grant);

    const useCase = new ResolveActionAuthorizationUseCase({ requestRepo });
    const result = await useCase.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: headSha,
      authorizationGrantId: 'grant-1',
      repository: { owner: 'repo-b-owner', repo: 'repo-b' },
      pullRequestNumber: 2,
    });

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.reason).toContain('grant grant-1 authorizes repo-a-owner/repo-a pull request 1');
    }
  });

  it('refuses a merge grant when repository or pull request is missing from request', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    const grant = createMergeGrantRecord();
    await requestRepo.saveRequest(grant);

    const useCase = new ResolveActionAuthorizationUseCase({ requestRepo });
    const result = await useCase.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: headSha,
      authorizationGrantId: 'grant-1',
    });

    expect(result.outcome).toBe('blocked');
  });

  it('keeps today behaviour for grants without merge coordinates', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    const grant = createStandardGrantRecord();
    await requestRepo.saveRequest(grant);

    const useCase = new ResolveActionAuthorizationUseCase({ requestRepo });
    const result = await useCase.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: headSha,
      authorizationGrantId: 'grant-2',
    });

    expect(result.outcome).toBe('authorized');
    if (result.outcome === 'authorized') {
      expect(result.grantId).toBe('grant-2');
    }
  });

  it('matches merge coordinates when resolving recorded request by grant id', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    const grant = createMergeGrantRecord();
    await requestRepo.saveRequest(grant);

    const useCase = new ResolveActionAuthorizationUseCase({ requestRepo });
    // A merge grant is skipped by the no-id resolve rule (its decision
    // revision is policy-prefixed), so it resolves only by its grant id.
    const resultMatch = await useCase.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: headSha,
      authorizationGrantId: 'grant-1',
      repository: { owner: 'repo-a-owner', repo: 'repo-a' },
      pullRequestNumber: 1,
    });
    expect(resultMatch.outcome).toBe('authorized');

    const resultMismatch = await useCase.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: headSha,
      authorizationGrantId: 'grant-1',
      repository: { owner: 'repo-b-owner', repo: 'repo-b' },
      pullRequestNumber: 2,
    });
    expect(resultMismatch.outcome).toBe('blocked');
  });

  it('blocks, without throwing, when the repository coordinates are not strings', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepository();
    await requestRepo.saveRequest(createMergeGrantRecord());
    const useCase = new ResolveActionAuthorizationUseCase({ requestRepo });
    const result = await useCase.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: headSha,
      authorizationGrantId: 'grant-1',
      repository: { owner: 123, repo: 'repo-a' } as unknown as { owner: string; repo: string },
      pullRequestNumber: 1,
    });
    expect(result.outcome).toBe('blocked');
  });
});
