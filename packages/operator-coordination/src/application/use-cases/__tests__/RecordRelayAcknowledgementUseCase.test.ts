import { describe, it, expect, beforeEach } from 'vitest';
import { RecordRelayAcknowledgementUseCase } from '../RecordRelayAcknowledgementUseCase.use-case.js';
import { CoordinationRequestRepositoryAdapter } from '../../../infrastructure/adapters/CoordinationRequestRepositoryAdapter.adapter.js';
import type { CoordinationRequestRecord } from '../../../domain/coordination-records.js';

describe('RecordRelayAcknowledgementUseCase', () => {
  let repo: CoordinationRequestRepositoryAdapter;
  let useCase: RecordRelayAcknowledgementUseCase;

  const sampleRelay: CoordinationRequestRecord = {
    id: 'req-relay-42',
    projectId: 'project-apollo',
    kind: 'relay',
    state: 'executing',
    actionScope: 'relay:alice',
    expectedHeadSha: null,
    proposalDigest: 'relay:alice',
    policyRevision: 'pol-1',
    decisionRevision: null,
    grantId: null,
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'delivered',
    deliveryGapReason: null,
    revision: 0,
    createdAtIso: '2026-10-15T12:00:00.000Z',
    updatedAtIso: '2026-10-15T12:00:00.000Z',
  };

  beforeEach(async () => {
    repo = new CoordinationRequestRepositoryAdapter();
    await repo.saveRequest(sampleRelay);
    useCase = new RecordRelayAcknowledgementUseCase({ requestRepo: repo });
  });

  it('refuses an acknowledgement whose recipientId differs from the relay actionScope recipient', async () => {
    const result = await useCase.execute({
      acknowledgementId: 'ack-001',
      requestId: 'req-relay-42',
      recipientId: 'bob',
      responseSummary: 'Task received by bob instead of alice',
      provenance: 'session-bob-99',
    });

    expect(result.outcome).toBe('rejected');
    expect((result as { reason: string }).reason).toBe(
      'recipient bob does not match relay recipient alice',
    );

    const stored = await repo.findRequestById('req-relay-42');
    expect(stored).not.toBeNull();
    expect(stored?.acknowledgements).toHaveLength(0);
    expect(stored?.state).toBe('executing');
  });

  it('accepts an acknowledgement whose recipientId matches the relay actionScope recipient', async () => {
    const result = await useCase.execute({
      acknowledgementId: 'ack-001',
      requestId: 'req-relay-42',
      recipientId: 'alice',
      responseSummary: 'Acknowledged by alice',
      provenance: 'session-alice-101',
    });

    expect(result.outcome).toBe('acknowledged');

    const stored = await repo.findRequestById('req-relay-42');
    expect(stored).not.toBeNull();
    expect(stored?.acknowledgements).toHaveLength(1);
    expect(stored?.acknowledgements[0].recipientId).toBe('alice');
    expect(stored?.state).toBe('completed');
  });
});
