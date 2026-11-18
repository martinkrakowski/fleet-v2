import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CoordinationRequestRecord } from '../src/domain/coordination-records.js';
import type { CoordinationRequestRepositoryPort } from '../src/application/ports/out/CoordinationRequestRepositoryPort.out-port.js';
import { RequestScopedDecisionUseCase } from '../src/application/use-cases/RequestScopedDecisionUseCase.use-case.js';
import { ResolveActionAuthorizationUseCase } from '../src/application/use-cases/ResolveActionAuthorizationUseCase.use-case.js';
import { RecordAuthorizationConsumptionUseCase } from '../src/application/use-cases/RecordAuthorizationConsumptionUseCase.use-case.js';

function digest(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

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
    // root the decision named. RR1: the request id is the digest of the
    // grant's exact coordinates, and the digest is supplied to every use case.
    const repo = new InMemoryCoordinationRequestRepo();
    const head = '3333333333333333333333333333333333333333';
    const root = '/srv/fleet/releases';
    const requestId = `release-grant-${createHash('sha256')
      .update(
        JSON.stringify({ scope: 'release:install', projectId: 'proj-1', expectedHeadSha: head, releaseRoot: root, nonce: '0123456789abcdef0123456789abcdef' }),
      )
      .digest('hex')}`;
    const useCase = new RequestScopedDecisionUseCase({
      requestRepo: repo,
      decisionTransport: {
        readDecisionAnswer: async () => ({
          state: 'approved',
          decisionRevision: 'dec-root-1',
          grantId: 'grant-root-1',
        }),
      },
      computeDigest: digest,
    });
    const requested = await useCase.requestScopedDecision({
      requestId,
      projectId: 'proj-1',
      kind: 'action-decision',
      actionScope: 'release:install',
      expectedHeadSha: head,
      proposalDigest: 'digest-root',
      policyRevision: 'pol-1',
      releaseRoot: root,
      releaseNonce: '0123456789abcdef0123456789abcdef',
    });
    expect(requested.outcome).toBe('requested');
    const recorded = await repo.findRequestById(requestId);
    expect(recorded?.releaseRoot).toBe(root);
    expect(recorded?.state).toBe('approved');
    expect(recorded?.grantId).toBe('grant-root-1');
    // The recorded grant resolves for the root it names and for no other.
    const resolver = new ResolveActionAuthorizationUseCase({ requestRepo: repo, computeDigest: digest });
    const resolve = await resolver.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'release:install',
      expectedHeadSha: head,
      releaseRoot: root,
    });
    expect(resolve.outcome).toBe('authorized');
    const otherRoot = await resolver.resolveActionAuthorization({
      projectId: 'proj-1',
      actionScope: 'release:install',
      expectedHeadSha: head,
      releaseRoot: '/srv/fleet/other',
    });
    expect(otherRoot).toEqual({ outcome: 'blocked', reason: 'release-grant-root-mismatch' });
  });

  it('refuses, never throws, when the request carries a throwing own releaseRoot getter', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const head = '4444444444444444444444444444444444444444';
    await repo.saveRequest({
      id: 'req-hostile-1',
      projectId: 'proj-1',
      kind: 'action-decision',
      state: 'approved',
      actionScope: 'release:install',
      expectedHeadSha: head,
      proposalDigest: 'digest-h',
      policyRevision: 'pol-1',
      decisionRevision: 'dec-1',
      grantId: 'grant-hostile-1',
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'delivered',
      deliveryGapReason: null,
      revision: 1,
      createdAtIso: '2026-11-10T10:00:00.000Z',
      updatedAtIso: '2026-11-10T10:00:00.000Z',
    } as CoordinationRequestRecord);
    const hostile = <T extends object>(base: T): T =>
      Object.defineProperty({ ...base }, 'releaseRoot', {
        enumerable: true,
        get() {
          throw new Error('hostile getter ran');
        },
      }) as T;
    const resolved = await new ResolveActionAuthorizationUseCase({ requestRepo: repo }).resolveActionAuthorization(
      hostile({ projectId: 'proj-1', actionScope: 'release:install', expectedHeadSha: head }),
    );
    expect(resolved).toEqual({ outcome: 'blocked', reason: 'release-grant-root-mismatch' });
    const consumed = await new RecordAuthorizationConsumptionUseCase({
      requestRepo: repo,
    }).recordAuthorizationConsumption(
      hostile({
        consumptionId: 'cons-1',
        grantId: 'grant-hostile-1',
        actionId: 'action-1',
        actionScope: 'release:install',
        attemptId: 'action-1',
        expectedHeadSha: head,
      }),
    );
    expect(consumed).toEqual({ outcome: 'refused', reason: 'release-grant-root-mismatch' });
    expect((await repo.findRequestByGrantId('grant-hostile-1'))?.consumptions).toEqual([]);
  });

  it('refuses both resolve and consume when the STORED releaseRoot is malformed, with the request root omitted or present', async () => {
    const head = '5555555555555555555555555555555555555555';
    const storedAccessor = {} as Record<string, unknown>;
    Object.defineProperty(storedAccessor, 'releaseRoot', { enumerable: true, get: () => '/srv/fleet/releases' });
    const storedThrowing = {} as Record<string, unknown>;
    Object.defineProperty(storedThrowing, 'releaseRoot', {
      enumerable: true,
      get: () => {
        throw new Error('stored getter ran');
      },
    });
    const corruptions: Array<[string, Record<string, unknown>]> = [
      ['wrong primitive', { releaseRoot: 7 }],
      ['object', { releaseRoot: { path: '/srv/fleet/releases' } }],
      ['empty string', { releaseRoot: '' }],
      ['null', { releaseRoot: null }],
      ['accessor', storedAccessor],
      ['throwing accessor', storedThrowing],
    ];
    for (const [label, corruption] of corruptions) {
      for (const requested of [undefined, '/srv/fleet/releases']) {
        const repo = new InMemoryCoordinationRequestRepo();
        const grantId = `grant-corrupt-${label.replaceAll(' ', '-')}`;
        const base = {
          id: `req-${grantId}`,
          projectId: 'proj-1',
          kind: 'action-decision',
          state: 'approved',
          actionScope: 'release:install',
          expectedHeadSha: head,
          proposalDigest: 'digest-c',
          policyRevision: 'pol-1',
          decisionRevision: 'dec-1',
          grantId,
          consumptions: [],
          acknowledgements: [],
          deliveryStatus: 'delivered',
          deliveryGapReason: null,
          revision: 1,
          createdAtIso: '2026-11-10T10:00:00.000Z',
          updatedAtIso: '2026-11-10T10:00:00.000Z',
        };
        const stored = Object.defineProperties(
          { ...base },
          Object.getOwnPropertyDescriptors(corruption),
        ) as unknown as CoordinationRequestRecord;
        await repo.saveRequest(stored);
        const root = requested === undefined ? {} : { releaseRoot: requested };
        const resolved = await new ResolveActionAuthorizationUseCase({ requestRepo: repo }).resolveActionAuthorization({
          projectId: 'proj-1',
          actionScope: 'release:install',
          expectedHeadSha: head,
          ...root,
        });
        expect(resolved, `resolve ${label} ${String(requested)}`).toEqual({
          outcome: 'blocked',
          reason: 'release-grant-root-mismatch',
        });
        const consumed = await new RecordAuthorizationConsumptionUseCase({
          requestRepo: repo,
        }).recordAuthorizationConsumption({
          consumptionId: 'cons-1',
          grantId,
          actionId: 'action-1',
          actionScope: 'release:install',
          attemptId: 'action-1',
          expectedHeadSha: head,
          ...root,
        });
        expect(consumed, `consume ${label} ${String(requested)}`).toEqual({
          outcome: 'refused',
          reason: 'release-grant-root-mismatch',
        });
        expect((await repo.findRequestByGrantId(grantId))?.consumptions).toEqual([]);
      }
    }
  });

  it('rejects, never throws, a decision request with a throwing own releaseRoot getter', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    const useCase = new RequestScopedDecisionUseCase({ requestRepo: repo });
    const request = Object.defineProperty(
      {
        requestId: 'req-getter-1',
        projectId: 'proj-1',
        kind: 'action-decision',
        actionScope: 'release:install',
        expectedHeadSha: '3333333333333333333333333333333333333333',
        proposalDigest: 'digest-g',
        policyRevision: 'pol-1',
      },
      'releaseRoot',
      {
        enumerable: true,
        get() {
          throw new Error('hostile getter ran');
        },
      },
    );
    const result = await useCase.requestScopedDecision(request as never);
    expect(result.outcome).toBe('rejected');
    expect(await repo.listRequests('proj-1')).toEqual([]);
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
