import { describe, expect, it } from 'vitest';
import type { CoordinationRequestRecord } from '../src/domain/coordination-records.js';
import type { CoordinationRequestRepositoryPort } from '../src/application/ports/out/CoordinationRequestRepositoryPort.out-port.js';
import { RequestScopedDecisionUseCase } from '../src/application/use-cases/RequestScopedDecisionUseCase.use-case.js';
import { ResolveActionAuthorizationUseCase } from '../src/application/use-cases/ResolveActionAuthorizationUseCase.use-case.js';

class InMemoryCoordinationRequestRepo implements CoordinationRequestRepositoryPort {
  private requests = new Map<string, CoordinationRequestRecord>();

  async saveRequest(record: CoordinationRequestRecord): Promise<void> {
    this.requests.set(record.id, record);
  }

  async findRequestById(requestId: string): Promise<CoordinationRequestRecord | null> {
    return this.requests.get(requestId) ?? null;
  }

  async findRequestByGrantId(grantId: string): Promise<CoordinationRequestRecord | null> {
    for (const req of this.requests.values()) {
      if (req.grantId === grantId) return req;
    }
    return null;
  }

  async listRequests(projectId?: string): Promise<readonly CoordinationRequestRecord[]> {
    const all = Array.from(this.requests.values());
    return projectId ? all.filter((r) => r.projectId === projectId) : all;
  }
}

describe('RequestScopedDecisionUseCase (Appendix A)', () => {
  it('records a new request id successfully', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const useCase = new RequestScopedDecisionUseCase({ requestRepo: repo });

    const result = await useCase.requestScopedDecision({
      requestId: 'req-new-1',
      projectId: 'proj-1',
      kind: 'action-decision',
      actionScope: 'forge:push-and-open-pr',
      expectedHeadSha: '1111111111111111111111111111111111111111',
      proposalDigest: 'digest-1',
      policyRevision: 'pol-1',
      attemptId: 'att-new-1',
    });

    expect(result.outcome).toBe('requested');
    const stored = await repo.findRequestById('req-new-1');
    expect(stored).not.toBeNull();
    expect(stored?.id).toBe('req-new-1');
  });

  it('refuses re-recording an existing request id', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const useCase = new RequestScopedDecisionUseCase({ requestRepo: repo });

    // Seed existing request with an approved grant
    const existing: CoordinationRequestRecord = {
      id: 'req-dup-1',
      projectId: 'proj-1',
      kind: 'action-decision',
      state: 'approved',
      actionScope: 'forge:push-and-open-pr',
      expectedHeadSha: '1111111111111111111111111111111111111111',
      proposalDigest: 'digest-existing',
      policyRevision: 'pol-1',
      decisionRevision: 'dec-1',
      grantId: 'grant-existing',
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'delivered',
      deliveryGapReason: null,
      revision: 2,
      createdAtIso: '2026-10-15T10:00:00Z',
      updatedAtIso: '2026-10-15T10:00:00Z',
    };
    await repo.saveRequest(existing);

    // Try to re-record with the same requestId
    const result = await useCase.requestScopedDecision({
      requestId: 'req-dup-1',
      projectId: 'proj-1',
      kind: 'action-decision',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: '2222222222222222222222222222222222222222',
      proposalDigest: 'digest-new',
      policyRevision: 'pol-2',
      attemptId: 'att-dup-1',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('req-dup-1 is already recorded');
    }

    // Verify existing record was untouched
    const stored = await repo.findRequestById('req-dup-1');
    expect(stored).toEqual(existing);
  });

  it('records and persists the release root a release decision names, and resolves it only for that root', async () => {
    // The ordinary decision flow: the request records the proposal first, then
    // the verified answer approves it; the recorded grant carries the release
    // root the decision named.
    const repo = new InMemoryCoordinationRequestRepo();
    const useCase = new RequestScopedDecisionUseCase({
      requestRepo: repo,
      decisionTransport: {
        readDecisionAnswer: async () => ({
          state: 'approved',
          decisionRevision: 'dec-root-1',
          grantId: 'grant-root-1',
        }),
      },
    });
    const requested = await useCase.requestScopedDecision({
      requestId: 'req-root-1',
      projectId: 'proj-1',
      kind: 'action-decision',
      actionScope: 'release:install',
      expectedHeadSha: '3333333333333333333333333333333333333333',
      proposalDigest: 'digest-root',
      policyRevision: 'pol-1',
      releaseRoot: '/srv/fleet/releases',
    });
    expect(requested.outcome).toBe('requested');
    const recorded = await repo.findRequestById('req-root-1');
    expect(recorded?.releaseRoot).toBe('/srv/fleet/releases');
    expect(recorded?.state).toBe('approved');
    expect(recorded?.grantId).toBe('grant-root-1');
    // The recorded grant resolves for the root it names and for no other.
    const resolver = new ResolveActionAuthorizationUseCase({ requestRepo: repo });
    const resolve = await resolver.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'release:install',
      expectedHeadSha: '3333333333333333333333333333333333333333',
      releaseRoot: '/srv/fleet/releases',
    });
    expect(resolve.outcome).toBe('authorized');
    const otherRoot = await resolver.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'release:install',
      expectedHeadSha: '3333333333333333333333333333333333333333',
      releaseRoot: '/srv/fleet/other',
    });
    expect(otherRoot).toEqual({ outcome: 'blocked', reason: 'release-grant-root-mismatch' });
  });

  it('refuses a decision request whose releaseRoot is not a bounded absolute path', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const useCase = new RequestScopedDecisionUseCase({ requestRepo: repo });
    for (const hostileRoot of ['relative/path', '/srv/../etc', '/srv/x\0y', `/${'r'.repeat(4097)}`, 7]) {
      const result = await useCase.requestScopedDecision({
        requestId: `req-bad-${String(hostileRoot).length}`,
        projectId: 'proj-1',
        kind: 'action-decision',
        actionScope: 'release:install',
        expectedHeadSha: '3333333333333333333333333333333333333333',
        proposalDigest: 'digest-bad',
        policyRevision: 'pol-1',
        releaseRoot: hostileRoot as never,
      });
      expect(result.outcome).toBe('rejected');
    }
    // Nothing was recorded for any of the refused roots.
    expect(await repo.listRequests('proj-1')).toEqual([]);
  });
});
