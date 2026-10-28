// InspectHeadCiState tests — every answer is one of pending, passed, failed or
// unknown with a reason code, and unknown is never a pass. Fakes only: no gh,
// no network, no hosts, no ports.

import { describe, expect, it } from 'vitest';

import type {
  ForgeCheckStatus,
  ForgeEvidencePort,
  ReadForgeCheckStatusRequest,
} from '../../ports/out/ForgeEvidencePort.out-port.js';
import { InspectHeadCiStateUseCase } from '../InspectHeadCiStateUseCase.use-case.js';

const HEAD = '1'.repeat(40);
const OTHER_HEAD = '2'.repeat(40);

class FakeForgeEvidencePort implements ForgeEvidencePort {
  readonly calls: ReadForgeCheckStatusRequest[] = [];

  constructor(private readonly answer: ForgeCheckStatus | Error) {}

  async readForgeCheckStatus(request: ReadForgeCheckStatusRequest): Promise<ForgeCheckStatus> {
    this.calls.push(request);
    if (this.answer instanceof Error) {
      throw this.answer;
    }
    return this.answer;
  }
}

function statusFor(ciState: ForgeCheckStatus['ciState'], head = HEAD): ForgeCheckStatus {
  return { candidateHeadSha: head, ciState, unresolvedThreadCount: 0 };
}

describe('InspectHeadCiStateUseCase', () => {
  it('maps pass, fail and pending to passed, failed and pending, each read', async () => {
    const fixtures: readonly [ForgeCheckStatus['ciState'], string][] = [
      ['pass', 'passed'],
      ['fail', 'failed'],
      ['pending', 'pending'],
    ];
    for (const [ciState, expected] of fixtures) {
      const fake = new FakeForgeEvidencePort(statusFor(ciState));
      const useCase = new InspectHeadCiStateUseCase({ forgeEvidence: fake });
      expect(await useCase.inspectHeadCiState({ candidateHeadSha: HEAD })).toEqual({
        candidateHeadSha: HEAD,
        state: expected,
        reason: 'read',
      });
      expect(fake.calls).toEqual([{ candidateHeadSha: HEAD }]);
    }
  });

  it('answers unknown / unreadable for unknown and not-applicable CI states', async () => {
    const fake = new FakeForgeEvidencePort(statusFor('unknown'));
    const notApplicable = new FakeForgeEvidencePort(statusFor('not-applicable'));
    const useCase = new InspectHeadCiStateUseCase({ forgeEvidence: fake });
    expect(await useCase.inspectHeadCiState({ candidateHeadSha: HEAD })).toEqual({
      candidateHeadSha: HEAD,
      state: 'unknown',
      reason: 'unreadable',
    });
    const other = new InspectHeadCiStateUseCase({ forgeEvidence: notApplicable });
    expect(await other.inspectHeadCiState({ candidateHeadSha: HEAD })).toEqual({
      candidateHeadSha: HEAD,
      state: 'unknown',
      reason: 'unreadable',
    });
  });

  it('refuses a short or upper-case head as invalid-head and never calls the forge', async () => {
    const fake = new FakeForgeEvidencePort(statusFor('pass'));
    const useCase = new InspectHeadCiStateUseCase({ forgeEvidence: fake });
    expect(await useCase.inspectHeadCiState({ candidateHeadSha: 'abc123' })).toEqual({
      candidateHeadSha: 'abc123',
      state: 'unknown',
      reason: 'invalid-head',
    });
    expect(await useCase.inspectHeadCiState({ candidateHeadSha: 'A'.repeat(40) })).toEqual({
      candidateHeadSha: 'A'.repeat(40),
      state: 'unknown',
      reason: 'invalid-head',
    });
    expect(fake.calls).toEqual([]);
  });

  it('answers unknown / not-configured when no forge evidence port is bound', async () => {
    const useCase = new InspectHeadCiStateUseCase();
    expect(await useCase.inspectHeadCiState({ candidateHeadSha: HEAD })).toEqual({
      candidateHeadSha: HEAD,
      state: 'unknown',
      reason: 'not-configured',
    });
  });

  it('answers unknown / unreadable when the forge port throws instead of escaping', async () => {
    const fake = new FakeForgeEvidencePort(new Error('forge exploded'));
    const useCase = new InspectHeadCiStateUseCase({ forgeEvidence: fake });
    expect(await useCase.inspectHeadCiState({ candidateHeadSha: HEAD })).toEqual({
      candidateHeadSha: HEAD,
      state: 'unknown',
      reason: 'unreadable',
    });
  });

  it('answers unknown / unreadable when the answer is for another head', async () => {
    const fake = new FakeForgeEvidencePort(statusFor('pass', OTHER_HEAD));
    const useCase = new InspectHeadCiStateUseCase({ forgeEvidence: fake });
    expect(await useCase.inspectHeadCiState({ candidateHeadSha: HEAD })).toEqual({
      candidateHeadSha: HEAD,
      state: 'unknown',
      reason: 'unreadable',
    });
  });
});
