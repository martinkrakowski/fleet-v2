import { describe, expect, it, vi } from 'vitest';

import type {
  OwnerDecisionDelegate,
} from '../OwnerDecisionAdapter.adapter.js';
import { OwnerDecisionAdapter } from '../OwnerDecisionAdapter.adapter.js';
import type {
  AttemptOwnerDecisionDelegate,
} from '../AttemptOwnerDecisionAdapter.adapter.js';
import { AttemptOwnerDecisionAdapter } from '../AttemptOwnerDecisionAdapter.adapter.js';
import type {
  OwnerDecisionResult,
  ResolveOwnerDecisionRequest,
} from '../../../application/ports/out/OwnerDecisionPort.out-port.js';
import type {
  AttemptOwnerDecisionResult,
  ReadAttemptOwnerDecisionRequest,
} from '../../../application/ports/out/AttemptOwnerDecisionPort.out-port.js';

describe('OwnerDecisionAdapter', () => {
  it('throws Not implemented when constructed without a delegate', async () => {
    const adapter = new OwnerDecisionAdapter();

    await expect(
      adapter.resolveOwnerDecision({ decisionReference: 'req-1', candidateHeadSha: 'abc123' }),
    ).rejects.toThrow(/^Not implemented: OwnerDecisionAdapter\.resolveOwnerDecision/);
  });

  it('throws Not implemented when delegate lacks checkOwnerDecision', async () => {
    const adapter = new OwnerDecisionAdapter({});

    await expect(
      adapter.resolveOwnerDecision({ decisionReference: 'req-1', candidateHeadSha: 'abc123' }),
    ).rejects.toThrow(/^Not implemented: OwnerDecisionAdapter\.resolveOwnerDecision/);
  });

  it('maps decisionReference to requestId and calls checkOwnerDecision exactly once', async () => {
    const checkOwnerDecision = vi
      .fn<NonNullable<OwnerDecisionDelegate['checkOwnerDecision']>>()
      .mockResolvedValue({ outcome: 'unknown', reason: 'unused in this test' });
    const adapter = new OwnerDecisionAdapter({ checkOwnerDecision });
    const request: ResolveOwnerDecisionRequest = {
      decisionReference: 'req-1',
      candidateHeadSha: 'abc123',
    };

    await adapter.resolveOwnerDecision(request);

    expect(checkOwnerDecision).toHaveBeenCalledTimes(1);
    expect(checkOwnerDecision).toHaveBeenCalledWith({
      requestId: 'req-1',
      candidateHeadSha: 'abc123',
    });
  });

  it('returns only outcome and decisionId for an approved outcome, dropping extra fields', async () => {
    const approvedWithExtra = {
      outcome: 'approved',
      decisionId: 'dec-1',
      extraField: 'drop-me',
    } as unknown as OwnerDecisionResult;
    const checkOwnerDecision = vi
      .fn<NonNullable<OwnerDecisionDelegate['checkOwnerDecision']>>()
      .mockResolvedValue(approvedWithExtra);
    const adapter = new OwnerDecisionAdapter({ checkOwnerDecision });

    const result = await adapter.resolveOwnerDecision({
      decisionReference: 'req-1',
      candidateHeadSha: 'abc123',
    });

    expect(result).toEqual({ outcome: 'approved', decisionId: 'dec-1' });
    expect('extraField' in result).toBe(false);
  });

  it('returns not-approved and unknown outcomes as the same object', async () => {
    const notApproved: OwnerDecisionResult = {
      outcome: 'not-approved',
      reason: 'reference revoked',
    };
    const unknown: OwnerDecisionResult = {
      outcome: 'unknown',
      reason: 'reference unreadable',
    };
    const checkOwnerDecision = vi
      .fn<NonNullable<OwnerDecisionDelegate['checkOwnerDecision']>>()
      .mockResolvedValueOnce(notApproved)
      .mockResolvedValueOnce(unknown);
    const adapter = new OwnerDecisionAdapter({ checkOwnerDecision });

    await expect(
      adapter.resolveOwnerDecision({ decisionReference: 'req-1', candidateHeadSha: 'abc123' }),
    ).resolves.toBe(notApproved);
    await expect(
      adapter.resolveOwnerDecision({ decisionReference: 'req-2', candidateHeadSha: 'def456' }),
    ).resolves.toBe(unknown);
  });

  it('propagates the exact error object when the delegate rejects', async () => {
    const err = new Error('boom');
    const checkOwnerDecision = vi
      .fn<NonNullable<OwnerDecisionDelegate['checkOwnerDecision']>>()
      .mockRejectedValue(err);
    const adapter = new OwnerDecisionAdapter({ checkOwnerDecision });

    await expect(
      adapter.resolveOwnerDecision({ decisionReference: 'req-1', candidateHeadSha: 'abc123' }),
    ).rejects.toBe(err);
  });
});

describe('AttemptOwnerDecisionAdapter', () => {
  it('throws Not implemented when constructed without a delegate or method', async () => {
    const withoutDelegate = new AttemptOwnerDecisionAdapter();

    await expect(
      withoutDelegate.readAttemptOwnerDecisionReferences({ attemptId: 'att-1' }),
    ).rejects.toThrow(
      /^Not implemented: AttemptOwnerDecisionAdapter\.readAttemptOwnerDecisionReferences/,
    );

    const withoutMethod = new AttemptOwnerDecisionAdapter({});

    await expect(
      withoutMethod.readAttemptOwnerDecisionReferences({ attemptId: 'att-1' }),
    ).rejects.toThrow(
      /^Not implemented: AttemptOwnerDecisionAdapter\.readAttemptOwnerDecisionReferences/,
    );
  });

  it('forwards request unchanged and returns recorded and unknown outcomes as is', async () => {
    const recorded: AttemptOwnerDecisionResult = {
      outcome: 'recorded',
      ownerDecisionReferences: ['ref-1'],
    };
    const unknown: AttemptOwnerDecisionResult = {
      outcome: 'unknown',
      reason: 'field absent',
    };
    const readAttemptOwnerDecisionReferences = vi
      .fn<NonNullable<AttemptOwnerDecisionDelegate['readAttemptOwnerDecisionReferences']>>()
      .mockResolvedValueOnce(recorded)
      .mockResolvedValue(unknown);
    const adapter = new AttemptOwnerDecisionAdapter({ readAttemptOwnerDecisionReferences });
    const request: ReadAttemptOwnerDecisionRequest = { attemptId: 'att-1' };

    await expect(adapter.readAttemptOwnerDecisionReferences(request)).resolves.toBe(recorded);

    expect(readAttemptOwnerDecisionReferences).toHaveBeenCalledTimes(1);
    expect(readAttemptOwnerDecisionReferences).toHaveBeenCalledWith(request);
    expect(readAttemptOwnerDecisionReferences.mock.calls[0]?.[0]).toBe(request);

    await expect(adapter.readAttemptOwnerDecisionReferences(request)).resolves.toBe(unknown);
  });

  it('propagates the exact error object when the delegate rejects', async () => {
    const err = new Error('read failed');
    const readAttemptOwnerDecisionReferences = vi
      .fn<NonNullable<AttemptOwnerDecisionDelegate['readAttemptOwnerDecisionReferences']>>()
      .mockRejectedValue(err);
    const adapter = new AttemptOwnerDecisionAdapter({ readAttemptOwnerDecisionReferences });

    await expect(
      adapter.readAttemptOwnerDecisionReferences({ attemptId: 'att-1' }),
    ).rejects.toBe(err);
  });
});
