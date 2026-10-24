import { describe, expect, it } from 'vitest';

import { CollectAttemptArtifactsUseCase } from '../CollectAttemptArtifactsUseCase.use-case.js';
import type { CollectAttemptArtifactsDependencies } from '../CollectAttemptArtifactsUseCase.use-case.js';
import type { CollectAttemptArtifactsRequest } from '../../ports/in/CollectAttemptArtifactsPort.in-port.js';
import type { CommandCompletionReceipt } from '../../../domain/execution-records.js';

/**
 * Stub deps: the entry check refuses before any dep runs; for a contained
 * entry the collection proceeds to the attempt lookup, which a stub rejects.
 */
const stubDeps = {
  attemptRepo: { findAttemptById: async () => null },
} as unknown as CollectAttemptArtifactsDependencies;

const receipt: CommandCompletionReceipt = {
  attemptId: 'attempt-1',
  sessionId: 'session-1',
  endedAtIso: '2026-10-24T10:00:00.000Z',
  authoritative: true,
  exitStatus: 0,
  stoppedByRequest: false,
};

function requestWith(expectedArtifacts: readonly string[]): CollectAttemptArtifactsRequest {
  return {
    attemptId: 'attempt-1',
    workOrderId: 'wo-1',
    expectedArtifacts,
    completionReceipt: receipt,
  };
}

describe('CollectAttemptArtifactsUseCase expectedArtifacts entry validation', () => {
  it('refuses an absolute expected artifact, naming it, before any dependency runs', async () => {
    const useCase = new CollectAttemptArtifactsUseCase(stubDeps);
    const result = await useCase.collectAttemptArtifacts(requestWith(['/etc/passwd']));
    expect(result).toEqual({
      outcome: 'refused',
      reason: expect.stringContaining('/etc/passwd'),
    });
  });

  it('refuses an escaping expected artifact, naming it', async () => {
    const useCase = new CollectAttemptArtifactsUseCase(stubDeps);
    const result = await useCase.collectAttemptArtifacts(requestWith(['../x']));
    expect(result).toEqual({
      outcome: 'refused',
      reason: expect.stringContaining('../x'),
    });
  });

  it('accepts contained expected artifacts past the entry check', async () => {
    const useCase = new CollectAttemptArtifactsUseCase(stubDeps);
    const result = await useCase.collectAttemptArtifacts(requestWith(['.lane/notes.md']));
    // Past the entry check the collection proceeds to the attempt lookup and
    // refuses there (stub deps hold no attempt) — never the entry reason.
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).not.toContain('expectedArtifacts');
    }
  });
});
