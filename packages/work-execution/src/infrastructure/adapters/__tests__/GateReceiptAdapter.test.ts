// GateReceiptAdapter: the consumer-side gate-receipt port over the evidence
// context. Every mapping is owned here, never in the composition.
/**
 * Covers recordGateReceipts: the default and custom receipt ids, the verdict →
 * evidence-result mapping for all four verdicts, in-order recording, stopping
 * at the first rejection (never a partial record), and failure tolerance
 * (never throws). All fakes are object literals; nothing touches a host.
 */

import { describe, expect, it } from 'vitest';

import type {
  VerificationReceiptRecord,
} from '@fleet/evidence-and-acceptance';
import type {
  RecordGateReceiptsRequest,
} from '../../../application/ports/out/GateReceiptPort.out-port.js';
import { GateReceiptAdapter } from '../GateReceiptAdapter.adapter.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';

function makeRequest(overrides: Partial<RecordGateReceiptsRequest> = {}): RecordGateReceiptsRequest {
  return {
    attemptId: 'attempt-example-1',
    projectId: 'project-example-1',
    candidateHeadSha: HEAD,
    hostId: 'lane-host-example',
    policyRevision: 'policy-example-1',
    completedAtIso: '2026-10-29T10:00:00.000Z',
    evidenceRef: 'run-journal:run-1/gate@0',
    receipts: [
      { procedureName: 'build', result: 'pass', exitCode: 0 },
      { procedureName: 'test', result: 'fail', exitCode: 2 },
      { procedureName: 'lint', result: 'skipped', exitCode: null },
      { procedureName: 'typecheck', result: 'unknown', exitCode: null },
    ],
    ...overrides,
  };
}

function makeDelegateFake(overrides: {
  assessmentId?: string;
  rejectAt?: number;
  rejectReason?: string;
  throwAt?: number;
} = {}) {
  const recorded: VerificationReceiptRecord[] = [];
  const calls: VerificationReceiptRecord[] = [];
  let callCount = 0;
  const recordVerificationReceipt = async (request: {
    readonly assessmentId: string;
    readonly receipt: VerificationReceiptRecord;
  }) => {
    calls.push(request.receipt);
    callCount += 1;
    if (overrides.throwAt !== undefined && callCount === overrides.throwAt) {
      throw new Error('boon');
    }
    if (overrides.rejectAt !== undefined && callCount === overrides.rejectAt) {
      return { outcome: 'rejected' as const, reason: overrides.rejectReason ?? 'Assessment not found' };
    }
    recorded.push(request.receipt);
    return { outcome: 'recorded' as const };
  };
  return {
    recorded,
    calls,
    delegates: {
      recordVerificationReceipt,
      assessmentIdOf: (attemptId: string) =>
        overrides.assessmentId ?? 'assessment-' + attemptId,
    },
  };
}

describe('GateReceiptAdapter.recordGateReceipts', () => {
  it('records every receipt in order with the default id, the mapped result and the exact coordinates', async () => {
    const { recorded, calls, delegates } = makeDelegateFake();
    const adapter = new GateReceiptAdapter(delegates);

    const result = await adapter.recordGateReceipts(makeRequest());

    expect(result).toEqual({ outcome: 'recorded', count: 4 });
    expect(recorded).toHaveLength(4);
    expect(recorded.map((receipt) => receipt.id)).toEqual([
      'verify-attempt-example-1-build-0123456789ab',
      'verify-attempt-example-1-test-0123456789ab',
      'verify-attempt-example-1-lint-0123456789ab',
      'verify-attempt-example-1-typecheck-0123456789ab',
    ]);
    expect(recorded.map((receipt) => receipt.result)).toEqual(['pass', 'fail', 'unknown', 'unknown']);
    expect(recorded[0]).toMatchObject({
      assessmentId: 'assessment-attempt-example-1',
      projectId: 'project-example-1',
      attemptId: 'attempt-example-1',
      candidateHeadSha: HEAD,
      hostId: 'lane-host-example',
      evidenceRef: 'run-journal:run-1/gate@0',
      policyRevision: 'policy-example-1',
      completedAtIso: '2026-10-29T10:00:00.000Z',
      exitCode: 0,
    });
    // Delegates receive the same records, in order.
    expect(calls).toEqual(recorded);
  });

  it('uses the custom receiptIdOf when provided', async () => {
    const { recorded, delegates } = makeDelegateFake();
    const adapter = new GateReceiptAdapter({
      ...delegates,
      receiptIdOf: (attemptId, procedureName, head) => `custom-${attemptId}-${procedureName}-${head.slice(0, 4)}`,
    });

    const result = await adapter.recordGateReceipts(makeRequest({ receipts: [{ procedureName: 'build', result: 'pass', exitCode: 0 }] }));

    expect(result).toEqual({ outcome: 'recorded', count: 1 });
    expect(recorded[0]?.id).toBe('custom-attempt-example-1-build-0123');
  });

  it('maps coverage through when present', async () => {
    const { recorded, delegates } = makeDelegateFake();
    const adapter = new GateReceiptAdapter(delegates);

    await adapter.recordGateReceipts(
      makeRequest({
        receipts: [
          {
            procedureName: 'build',
            result: 'pass',
            exitCode: 0,
            coverage: { ran: true, unitKind: 'tests', units: 3 },
          },
        ],
      }),
    );

    expect(recorded[0]?.coverage).toEqual({ ran: true, unitKind: 'tests', units: 3 });
  });

  it('stops at the first rejection and answers unavailable with that reason', async () => {
    const { recorded, delegates } = makeDelegateFake({ rejectAt: 2, rejectReason: 'Assessment not found' });
    const adapter = new GateReceiptAdapter(delegates);

    const result = await adapter.recordGateReceipts(makeRequest());

    expect(result).toEqual({ outcome: 'unavailable', reason: 'Assessment not found' });
    // The first receipt was recorded, the second was rejected, the rest never attempted.
    expect(recorded.map((receipt) => receipt.procedureName)).toEqual(['build']);
  });

  it('answers unavailable when no assessment exists for the attempt', async () => {
    const { delegates } = makeDelegateFake({ assessmentId: '' });
    const adapter = new GateReceiptAdapter(delegates);

    const result = await adapter.recordGateReceipts(makeRequest());

    expect(result).toEqual({ outcome: 'unavailable', reason: 'No assessment exists for the attempt' });
  });

  it('never throws when assessmentIdOf or receiptIdOf throws; it answers unavailable (KF-13a Luna)', async () => {
    const { delegates } = makeDelegateFake({});
    const badAssessment = new GateReceiptAdapter({ ...delegates, assessmentIdOf: () => { throw new Error('no id'); } });
    expect((await badAssessment.recordGateReceipts(makeRequest())).outcome).toBe('unavailable');
    const badReceipt = new GateReceiptAdapter({ ...delegates, receiptIdOf: () => { throw new Error('no id'); } });
    expect((await badReceipt.recordGateReceipts(makeRequest())).outcome).toBe('unavailable');
  });

  it('never throws when the delegate throws; it answers unavailable', async () => {
    const { delegates } = makeDelegateFake({ throwAt: 1 });
    const adapter = new GateReceiptAdapter(delegates);

    const result = await adapter.recordGateReceipts(makeRequest());

    expect(result.outcome).toBe('unavailable');
  });
});
