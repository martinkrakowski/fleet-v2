/**
 * CheckOwnerDecisionUseCase unit tests: the one-way-door station answers one
 * question about one recorded coordination request and never answers `approved`
 * on its own initiative. A request that authorizes its own scope at the exact
 * candidate head is approved; anything else is `not-approved`; anything this
 * context cannot read is `unknown`.
 */

import { describe, expect, it } from 'vitest';

import type { CoordinationRequestRecord } from '../../../domain/coordination-records.js';
import type { CoordinationRequestRepositoryPort } from '../../ports/out/CoordinationRequestRepositoryPort.out-port.js';
import {
  CheckOwnerDecisionUseCase,
  ownerDecisionActionScope,
} from '../CheckOwnerDecisionUseCase.use-case.js';

const HEAD = 'abc123';
const OTHER_HEAD = 'def456';
const NOW_ISO = '2026-10-15T09:00:00.000Z';

function requestRecord(overrides: Partial<CoordinationRequestRecord> = {}): CoordinationRequestRecord {
  return {
    id: 'door-1',
    projectId: 'project-atlas',
    kind: 'action-decision',
    state: 'approved',
    actionScope: ownerDecisionActionScope('door-1'),
    expectedHeadSha: HEAD,
    proposalDigest: 'digest-1',
    policyRevision: 'policy-7',
    decisionRevision: 'decision-3',
    grantId: 'grant-9',
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'delivered',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: NOW_ISO,
    updatedAtIso: NOW_ISO,
    ...overrides,
  };
}

class StubRequestRepository implements CoordinationRequestRepositoryPort {
  readonly saves: CoordinationRequestRecord[] = [];
  readonly requests = new Map<string, CoordinationRequestRecord>();

  constructor(seed: readonly CoordinationRequestRecord[] = []) {
    for (const record of seed) {
      this.requests.set(record.id, record);
    }
  }

  async saveRequest(record: CoordinationRequestRecord): Promise<void> {
    this.saves.push(record);
    this.requests.set(record.id, record);
  }

  async findRequestById(requestId: string): Promise<CoordinationRequestRecord | null> {
    return this.requests.get(requestId) ?? null;
  }

  async findRequestByGrantId(grantId: string): Promise<CoordinationRequestRecord | null> {
    for (const record of this.requests.values()) {
      if (record.grantId === grantId) {
        return record;
      }
    }
    return null;
  }

  async listRequests(projectId?: string): Promise<readonly CoordinationRequestRecord[]> {
    return [...this.requests.values()].filter(
      (record) => projectId === undefined || record.projectId === projectId,
    );
  }
}

describe('CheckOwnerDecisionUseCase', () => {
  const request = { requestId: 'door-1', candidateHeadSha: HEAD };

  it('throws while unconfigured', async () => {
    const useCase = new CheckOwnerDecisionUseCase();

    await expect(useCase.checkOwnerDecision(request)).rejects.toThrow(
      'Not implemented: CheckOwnerDecisionUseCase',
    );
    await expect(useCase.execute(request)).rejects.toThrow(
      'Not implemented: CheckOwnerDecisionUseCase',
    );
  });

  it('approves a request that authorizes its own scope at the candidate head', async () => {
    const repo = new StubRequestRepository([requestRecord()]);
    const useCase = new CheckOwnerDecisionUseCase({ requestRepo: repo });

    const result = await useCase.checkOwnerDecision(request);

    expect(result).toEqual({ outcome: 'approved', requestId: 'door-1', grantId: 'grant-9' });
    expect(repo.saves).toHaveLength(0);
  });

  it('reports a declined request as not-approved', async () => {
    const repo = new StubRequestRepository([
      requestRecord({ state: 'declined', grantId: null, decisionRevision: null }),
    ]);
    const useCase = new CheckOwnerDecisionUseCase({ requestRepo: repo });

    const result = await useCase.checkOwnerDecision(request);

    expect(result.outcome).toBe('not-approved');
    if (result.outcome === 'not-approved') {
      expect(result.reason).toContain("is 'declined'");
    }
  });

  it('reports an undecided request as not-approved', async () => {
    const repo = new StubRequestRepository([
      requestRecord({ state: 'awaiting-decision', grantId: null, decisionRevision: null }),
    ]);
    const useCase = new CheckOwnerDecisionUseCase({ requestRepo: repo });

    const result = await useCase.checkOwnerDecision(request);

    expect(result.outcome).toBe('not-approved');
    if (result.outcome === 'not-approved') {
      expect(result.reason).toContain("is 'awaiting-decision'");
    }
  });

  it('reports an approval recorded for another scope on the same head as not-approved', async () => {
    const repo = new StubRequestRepository([requestRecord({ actionScope: 'forge:merge-pr' })]);
    const useCase = new CheckOwnerDecisionUseCase({ requestRepo: repo });

    const result = await useCase.checkOwnerDecision(request);

    expect(result.outcome).toBe('not-approved');
    if (result.outcome === 'not-approved') {
      expect(result.reason).toContain(`does not authorize ${ownerDecisionActionScope('door-1')}`);
      expect(result.reason).toContain("'forge:merge-pr'");
    }
  });

  it('reports an approval for another head as not-approved', async () => {
    const repo = new StubRequestRepository([requestRecord({ expectedHeadSha: OTHER_HEAD })]);
    const useCase = new CheckOwnerDecisionUseCase({ requestRepo: repo });

    const result = await useCase.checkOwnerDecision(request);

    expect(result.outcome).toBe('not-approved');
    if (result.outcome === 'not-approved') {
      expect(result.reason).toContain(`at ${HEAD}`);
    }
  });

  it('reports an approved request with no recorded decision revision as not-approved', async () => {
    const repo = new StubRequestRepository([requestRecord({ decisionRevision: null })]);
    const useCase = new CheckOwnerDecisionUseCase({ requestRepo: repo });

    const result = await useCase.checkOwnerDecision(request);

    expect(result.outcome).toBe('not-approved');
  });

  it('reports an unrecorded request as unknown', async () => {
    const useCase = new CheckOwnerDecisionUseCase({ requestRepo: new StubRequestRepository() });

    const result = await useCase.checkOwnerDecision(request);

    expect(result.outcome).toBe('unknown');
    if (result.outcome === 'unknown') {
      expect(result.reason).toContain('No coordination request is recorded');
    }
  });

  it('reports an unreadable store as unknown instead of approving', async () => {
    const requestRepo: CoordinationRequestRepositoryPort = {
      async saveRequest() {},
      async findRequestById() {
        throw new Error('state store is locked');
      },
      async findRequestByGrantId() {
        throw new Error('state store is locked');
      },
      async listRequests() {
        throw new Error('state store is locked');
      },
    };
    const useCase = new CheckOwnerDecisionUseCase({ requestRepo });

    const result = await useCase.checkOwnerDecision(request);

    expect(result.outcome).toBe('unknown');
    if (result.outcome === 'unknown') {
      expect(result.reason).toContain('could not be read: state store is locked');
    }
  });

  it('refuses a request without coordinates instead of inventing one', async () => {
    const useCase = new CheckOwnerDecisionUseCase({ requestRepo: new StubRequestRepository() });

    await expect(
      useCase.checkOwnerDecision({ requestId: '  ', candidateHeadSha: HEAD }),
    ).rejects.toThrow('Not implemented: CheckOwnerDecisionUseCase');
    await expect(
      useCase.checkOwnerDecision({ requestId: 'door-1', candidateHeadSha: '' }),
    ).rejects.toThrow('Not implemented: CheckOwnerDecisionUseCase');
  });
});