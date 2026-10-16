import { describe, expect, it } from 'vitest';
import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import type { CoordinationRequestRepositoryPort } from '../ports/out/CoordinationRequestRepositoryPort.out-port.js';
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
