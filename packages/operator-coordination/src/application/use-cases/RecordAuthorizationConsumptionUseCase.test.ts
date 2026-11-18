import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import type { RecordAuthorizationConsumptionResult } from '../ports/in/RecordAuthorizationConsumptionPort.in-port.js';
import { RecordAuthorizationConsumptionUseCase } from './RecordAuthorizationConsumptionUseCase.use-case.js';

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

function makeApprovedGrantRecord(overrides?: Partial<CoordinationRequestRecord>): CoordinationRequestRecord {
  return {
    id: 'req-001',
    projectId: 'proj-alpha',
    kind: 'action-decision',
    state: 'approved',
    actionScope: 'forge:push-and-open-pr',
    expectedHeadSha: '1111111111111111111111111111111111111111',
    proposalDigest: 'sha256-proposal',
    policyRevision: 'pol-rev-1',
    decisionRevision: 'dec-rev-1',
    grantId: 'grant-001',
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'delivered',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: '2026-10-15T10:00:00Z',
    updatedAtIso: '2026-10-15T10:00:00Z',
    ...overrides,
  };
}

describe('RecordAuthorizationConsumptionUseCase (H7)', () => {
  it('refuses when recorded grant actionScope differs from supplied actionScope', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await repo.saveRequest(makeApprovedGrantRecord({
      grantId: 'grant-push',
      actionScope: 'forge:push-and-open-pr',
      expectedHeadSha: 'head-H',
    }));

    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-1',
      grantId: 'grant-push',
      actionId: 'action-merge',
      actionScope: 'forge:merge-pr',
      attemptId: 'att-1',
      expectedHeadSha: 'head-H',
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('scope forge:push-and-open-pr, not forge:merge-pr');
    }
  });

  it('refuses when expected head commit differs', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await repo.saveRequest(makeApprovedGrantRecord({
      grantId: 'grant-push',
      actionScope: 'forge:push-and-open-pr',
      expectedHeadSha: 'head-H',
    }));

    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-1',
      grantId: 'grant-push',
      actionId: 'action-push',
      actionScope: 'forge:push-and-open-pr',
      attemptId: 'att-1',
      expectedHeadSha: 'head-DIFFERENT',
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('head-H, not head-DIFFERENT');
    }
  });

  it('successfully consumes when actionScope and head commit match', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await repo.saveRequest(makeApprovedGrantRecord({
      grantId: 'grant-push',
      actionScope: 'forge:push-and-open-pr',
      expectedHeadSha: 'head-H',
    }));

    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-1',
      grantId: 'grant-push',
      actionId: 'action-push',
      actionScope: 'forge:push-and-open-pr',
      attemptId: 'att-1',
      expectedHeadSha: 'head-H',
    });

    expect(result.outcome).toBe('consumed');
    if (result.outcome === 'consumed') {
      expect(result.consumption.actionId).toBe('action-push');
      expect(result.consumption.grantId).toBe('grant-push');
    }
  });

  it('successfully consumes non-forge scope host:restart when supplied scope matches exactly', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await repo.saveRequest(makeApprovedGrantRecord({
      grantId: 'grant-restart',
      actionScope: 'host:restart',
      expectedHeadSha: 'head-H',
    }));

    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-restart',
      grantId: 'grant-restart',
      actionId: 'action-restart',
      actionScope: 'host:restart',
      attemptId: 'att-1',
      expectedHeadSha: 'head-H',
    });

    expect(result.outcome).toBe('consumed');
    if (result.outcome === 'consumed') {
      expect(result.consumption.actionId).toBe('action-restart');
      expect(result.consumption.grantId).toBe('grant-restart');
    }
  });

  it('successfully consumes non-forge scope relay:fleet-master when supplied scope matches exactly', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await repo.saveRequest(makeApprovedGrantRecord({
      grantId: 'grant-relay',
      actionScope: 'relay:fleet-master',
      expectedHeadSha: 'head-H',
    }));

    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-relay',
      grantId: 'grant-relay',
      actionId: 'action-relay',
      actionScope: 'relay:fleet-master',
      attemptId: 'att-1',
      expectedHeadSha: 'head-H',
    });

    expect(result.outcome).toBe('consumed');
    if (result.outcome === 'consumed') {
      expect(result.consumption.actionId).toBe('action-relay');
      expect(result.consumption.grantId).toBe('grant-relay');
    }
  });

  it('refuses non-forge scope when supplied scope differs from recorded scope', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await repo.saveRequest(makeApprovedGrantRecord({
      grantId: 'grant-restart',
      actionScope: 'host:restart',
      expectedHeadSha: 'head-H',
    }));

    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-restart',
      grantId: 'grant-restart',
      actionId: 'action-restart',
      actionScope: 'host:shutdown',
      attemptId: 'att-1',
      expectedHeadSha: 'head-H',
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('scope host:restart, not host:shutdown');
    }
  });
});

const POLICY_HEAD = 'a'.repeat(40);

describe('RecordAuthorizationConsumptionUseCase attempt binding (CO24d)', () => {
  function policyGrant(attemptId: string): CoordinationRequestRecord {
    return makeApprovedGrantRecord({
      grantId: 'grant-policy',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: POLICY_HEAD,
      decisionRevision: 'policy:autoMerge@309ab8c40bf2',
      policyGrant: { workOrderId: 'wo-1', attemptId, acceptanceReceiptId: 'receipt-1' },
    });
  }

  it('refuses a consumption whose attempt differs from the policy grant attempt and records nothing', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await repo.saveRequest(policyGrant('att-A'));
    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-1',
      grantId: 'grant-policy',
      actionId: 'action-push',
      actionScope: 'forge:merge-pr',
      attemptId: 'att-B',
      expectedHeadSha: POLICY_HEAD,
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'grant-attempt-mismatch' });
    const stored = await repo.findRequestByGrantId('grant-policy');
    expect(stored?.consumptions).toHaveLength(0);
    expect(stored?.state).toBe('approved');
  });

  it('consumes a policy grant for its own attempt', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await repo.saveRequest(policyGrant('att-A'));
    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-1',
      grantId: 'grant-policy',
      actionId: 'action-push',
      actionScope: 'forge:merge-pr',
      attemptId: 'att-A',
      expectedHeadSha: POLICY_HEAD,
    });

    expect(result.outcome).toBe('consumed');
  });
});

describe('RecordAuthorizationConsumptionUseCase standing shadow import grant (GR1a1)', () => {
  it('refuses shadow import scope without mutating the standing grant', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await repo.saveRequest(
      makeApprovedGrantRecord({
        grantId: 'grant-shadow',
        actionScope: 'merge:import-shadow',
        expectedHeadSha: null,
        shadowImportGrant: {
          repository: { owner: 'octo', repo: 'hello' },
          expiresAtIso: '2026-12-16T00:00:00Z',
        },
      }),
    );
    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-1',
      grantId: 'grant-shadow',
      actionId: 'action-import',
      actionScope: 'merge:import-shadow',
      attemptId: 'att-1',
      expectedHeadSha: 'head-H',
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'shadow-import-grant-not-consumable' });
    const stored = await repo.findRequestByGrantId('grant-shadow');
    expect(stored?.state).toBe('approved');
    expect(stored?.consumptions).toHaveLength(0);
    expect(stored?.revision).toBe(1);
  });

  it('refuses a consumption naming the shadow scope even when the recorded scope differs', async () => {
    const repo = new InMemoryCoordinationRequestRepo();
    await repo.saveRequest(
      makeApprovedGrantRecord({
        grantId: 'grant-push',
        actionScope: 'forge:push-and-open-pr',
        expectedHeadSha: 'head-H',
      }),
    );
    const useCase = new RecordAuthorizationConsumptionUseCase({ requestRepo: repo });

    const result = await useCase.recordAuthorizationConsumption({
      consumptionId: 'c-1',
      grantId: 'grant-push',
      actionId: 'action-import',
      actionScope: 'merge:import-shadow',
      attemptId: 'att-1',
      expectedHeadSha: 'head-H',
    });

    expect(result).toEqual({ outcome: 'refused', reason: 'shadow-import-grant-not-consumable' });
    const stored = await repo.findRequestByGrantId('grant-push');
    expect(stored?.state).toBe('approved');
    expect(stored?.consumptions).toHaveLength(0);
  });
});

describe('RecordAuthorizationConsumptionUseCase release grants (RR1)', () => {
  const HEAD = '1111111111111111111111111111111111111111';
  const ROOT = '/srv/fleet/releases';
  const GRANT_ID = 'grant-release';

  function digest(payload: string): string {
    return createHash('sha256').update(payload).digest('hex');
  }

  function releaseRequestId(grant: {
    actionScope: string;
    projectId: string;
    expectedHeadSha: string;
    releaseRoot: string;
  }): string {
    return `release-grant-${digest(
      JSON.stringify({
        scope: grant.actionScope,
        projectId: grant.projectId,
        expectedHeadSha: grant.expectedHeadSha,
        releaseRoot: grant.releaseRoot,
      }),
    )}`;
  }

  function createReleaseRecord(overrides?: Partial<CoordinationRequestRecord>): CoordinationRequestRecord {
    return {
      id: releaseRequestId({
        actionScope: 'release:install',
        projectId: 'proj-1',
        expectedHeadSha: HEAD,
        releaseRoot: ROOT,
      }),
      projectId: 'proj-1',
      kind: 'action-decision',
      state: 'approved',
      actionScope: 'release:install',
      expectedHeadSha: HEAD,
      proposalDigest: 'sha256-proposal',
      policyRevision: 'pol-rev-1',
      decisionRevision: 'dec-rev-1',
      grantId: GRANT_ID,
      consumptions: [],
      acknowledgements: [],
      deliveryStatus: 'delivered',
      deliveryGapReason: null,
      revision: 1,
      createdAtIso: '2026-11-02T00:00:00.000Z',
      updatedAtIso: '2026-11-02T00:00:00.000Z',
      releaseRoot: ROOT,
      ...overrides,
    };
  }

  function consumeRelease(
    useCase: RecordAuthorizationConsumptionUseCase,
    overrides: Record<string, unknown> = {},
  ): Promise<RecordAuthorizationConsumptionResult> {
    return useCase.recordAuthorizationConsumption({
      consumptionId: 'c-1',
      grantId: GRANT_ID,
      actionId: 'action-install-1',
      actionScope: 'release:install',
      attemptId: 'att-1',
      expectedHeadSha: HEAD,
      releaseRoot: ROOT,
      ...overrides,
    } as never);
  }

  it('consumes a digest-bound release record whose root matches', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepo();
    await requestRepo.saveRequest(createReleaseRecord());
    const result = await consumeRelease(
      new RecordAuthorizationConsumptionUseCase({ requestRepo, computeDigest: digest }),
    );
    expect(result.outcome).toBe('consumed');
    const stored = await requestRepo.findRequestById(
      releaseRequestId({
        actionScope: 'release:install',
        projectId: 'proj-1',
        expectedHeadSha: HEAD,
        releaseRoot: ROOT,
      }),
    );
    expect(stored?.consumptions).toHaveLength(1);
    expect(stored?.consumptions[0]?.actionId).toBe('action-install-1');
  });

  it('refuses a matching root whose stored coordinates no longer hash to the id (tampered)', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepo();
    // The stored root was moved after recording: the request names the same
    // (moved) root, so the root check passes, but the recomputed digest no
    // longer matches the request id the grant is bound by. The idempotent
    // replay return is never reached, so a moved root cannot be excused by an
    // already-recorded receipt.
    await requestRepo.saveRequest(createReleaseRecord({ releaseRoot: '/srv/fleet/moved' }));
    const result = await consumeRelease(
      new RecordAuthorizationConsumptionUseCase({ requestRepo, computeDigest: digest }),
      { releaseRoot: '/srv/fleet/moved' },
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'release-grant-digest-mismatch' });
  });

  it('refuses a pre-RR1 unprefixed release record (unsigned root) even when the root matches', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepo();
    await requestRepo.saveRequest(createReleaseRecord({ id: 'req-unprefixed-1' }));
    const result = await consumeRelease(
      new RecordAuthorizationConsumptionUseCase({ requestRepo, computeDigest: digest }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'release-grant-digest-mismatch' });
  });

  it('fails closed with digest-unavailable when the digest is unwired on a release record', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepo();
    await requestRepo.saveRequest(createReleaseRecord());
    const result = await consumeRelease(
      new RecordAuthorizationConsumptionUseCase({ requestRepo }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'digest-unavailable' });
  });

  it('still refuses a different root with release-grant-root-mismatch before the digest runs', async () => {
    const requestRepo = new InMemoryCoordinationRequestRepo();
    await requestRepo.saveRequest(createReleaseRecord());
    const result = await consumeRelease(
      new RecordAuthorizationConsumptionUseCase({ requestRepo, computeDigest: digest }),
      { releaseRoot: '/srv/fleet/other' },
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'release-grant-root-mismatch' });
  });
});
