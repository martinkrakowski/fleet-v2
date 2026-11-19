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
import type {
  DecisionAnswer,
  DecisionTransportPort,
} from '../../ports/out/DecisionTransportPort.out-port.js';
import { DecisionTransportAdapter } from '../../../infrastructure/adapters/DecisionTransportAdapter.adapter.js';
import {
  CheckOwnerDecisionUseCase,
  ownerDecisionActionScope,
} from '../CheckOwnerDecisionUseCase.use-case.js';
import { createSignedDecisionFixture } from './signed-decision-fixture.js';

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
    // KEY0c1a: the seeded approved owner grant is paired with a signed answer
    // under the ephemeral test signer, and the answer self-check verifies the
    // record's own grant id and decision revision read back as `approved`.
    const signer = createSignedDecisionFixture();
    await signer.writeApprovedAnswer(requestRecord());
    await signer.assertApprovedAnswerReadsBackApproved(requestRecord());
    // KEY0c3: the transport is mandatory, so the approving check is wired
    // with the signer's transport.
    const useCase = new CheckOwnerDecisionUseCase({ requestRepo: repo, ...signer.deps });

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
describe('CheckOwnerDecisionUseCase signed re-verification (KEY0c2)', () => {
  const REQUEST = { requestId: 'door-1', candidateHeadSha: HEAD };

  function repositoryWith(...records: CoordinationRequestRecord[]): StubRequestRepository {
    return new StubRequestRepository(records);
  }

  function transportWith(
    ownerPublicKey: string,
    answers: Record<string, DecisionAnswer>,
    ownerKeyRefusal?: 'owner-key-unpinned' | 'owner-key-env-mismatch',
  ): DecisionTransportPort {
    return new DecisionTransportAdapter({
      ownerPublicKey,
      answers,
      ...(ownerKeyRefusal === undefined ? {} : { ownerKeyRefusal }),
    });
  }

  it('approves owner decision with valid signed answer', async () => {
    const signer = createSignedDecisionFixture();
    const record = requestRecord();
    await signer.writeApprovedAnswer(record);
    const result = await new CheckOwnerDecisionUseCase({
      requestRepo: repositoryWith(record),
      decisionTransport: signer.deps.decisionTransport,
    }).checkOwnerDecision(REQUEST);
    expect(result).toEqual({ outcome: 'approved', requestId: 'door-1', grantId: 'grant-9' });
  });

  it('refuses hand-written approved record with no answer file', async () => {
    const signer = createSignedDecisionFixture();
    const result = await new CheckOwnerDecisionUseCase({
      requestRepo: repositoryWith(requestRecord()),
      decisionTransport: transportWith(signer.ownerPublicKey, {}),
    }).checkOwnerDecision(REQUEST);
    expect(result).toEqual({
      outcome: 'not-approved',
      requestId: 'door-1',
      reason: 'decision-signature-invalid',
    });
  });

  it('refuses approved owner record when decisionTransport is absent', async () => {
    const result = await new CheckOwnerDecisionUseCase({
      requestRepo: repositoryWith(requestRecord()),
    }).checkOwnerDecision(REQUEST);
    expect(result).toEqual({
      outcome: 'not-approved',
      requestId: 'door-1',
      reason: 'decision-signature-invalid',
    });
  });

  it('surfaces owner-key-unpinned and owner-key-env-mismatch', async () => {
    const signer = createSignedDecisionFixture();
    const answer = signer.signApprovedAnswer(requestRecord());
    for (const refusal of ['owner-key-unpinned', 'owner-key-env-mismatch'] as const) {
      const result = await new CheckOwnerDecisionUseCase({
        requestRepo: repositoryWith(requestRecord()),
        decisionTransport: transportWith(signer.ownerPublicKey, { 'door-1': answer }, refusal),
      }).checkOwnerDecision(REQUEST);
      expect(result).toEqual({ outcome: 'not-approved', requestId: 'door-1', reason: refusal });
    }
  });

  it('refuses approved record when answer is signed by a different key', async () => {
    const signer = createSignedDecisionFixture();
    const other = createSignedDecisionFixture();
    const result = await new CheckOwnerDecisionUseCase({
      requestRepo: repositoryWith(requestRecord()),
      decisionTransport: transportWith(signer.ownerPublicKey, {
        'door-1': other.signApprovedAnswer(requestRecord()),
      }),
    }).checkOwnerDecision(REQUEST);
    expect(result).toEqual({
      outcome: 'not-approved',
      requestId: 'door-1',
      reason: 'decision-signature-invalid',
    });
  });

  it('refuses approved record when answer is for a different request', async () => {
    const signer = createSignedDecisionFixture();
    const result = await new CheckOwnerDecisionUseCase({
      requestRepo: repositoryWith(requestRecord()),
      decisionTransport: transportWith(signer.ownerPublicKey, {
        'door-1': signer.signApprovedAnswer(requestRecord({ id: 'door-2' })),
      }),
    }).checkOwnerDecision(REQUEST);
    expect(result).toEqual({
      outcome: 'not-approved',
      requestId: 'door-1',
      reason: 'decision-signature-invalid',
    });
  });

  it('refuses when answer grantId or decisionRevision mismatches stored record', async () => {
    const signer = createSignedDecisionFixture();
    for (const mismatched of [
      requestRecord({ grantId: 'grant-8' }),
      requestRecord({ decisionRevision: 'decision-4' }),
    ]) {
      const result = await new CheckOwnerDecisionUseCase({
        requestRepo: repositoryWith(requestRecord()),
        decisionTransport: transportWith(signer.ownerPublicKey, {
          'door-1': signer.signApprovedAnswer(mismatched),
        }),
      }).checkOwnerDecision(REQUEST);
      expect(result).toEqual({
        outcome: 'not-approved',
        requestId: 'door-1',
        reason: 'decision-signature-invalid',
      });
    }
  });

  it('refuses when decisionTransport reports awaiting-decision or declined', async () => {
    for (const answer of [
      { state: 'awaiting-decision' as const, decisionRevision: null, grantId: null },
      { state: 'declined' as const, decisionRevision: 'decision-3', grantId: 'grant-9' },
    ]) {
      const result = await new CheckOwnerDecisionUseCase({
        requestRepo: repositoryWith(requestRecord()),
        decisionTransport: {
          async readDecisionAnswer() {
            return answer;
          },
        },
      }).checkOwnerDecision(REQUEST);
      expect(result).toEqual({
        outcome: 'not-approved',
        requestId: 'door-1',
        reason: 'decision-signature-invalid',
      });
    }
  });

  it('refuses an approved answer carrying owner-key-unpinned despite matching binding', async () => {
    const result = await new CheckOwnerDecisionUseCase({
      requestRepo: repositoryWith(requestRecord()),
      decisionTransport: {
        async readDecisionAnswer() {
          return {
            state: 'approved' as const,
            decisionRevision: 'decision-3',
            grantId: 'grant-9',
            requestId: 'door-1',
            actionScope: ownerDecisionActionScope('door-1'),
            refusalReason: 'owner-key-unpinned' as const,
          };
        },
      },
    }).checkOwnerDecision(REQUEST);
    expect(result).toEqual({
      outcome: 'not-approved',
      requestId: 'door-1',
      reason: 'owner-key-unpinned',
    });
  });
});
