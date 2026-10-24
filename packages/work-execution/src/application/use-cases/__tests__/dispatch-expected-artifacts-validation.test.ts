import { describe, expect, it } from 'vitest';

import { DispatchAttemptUseCase } from '../DispatchAttemptUseCase.use-case.js';
import type { DispatchAttemptDependencies } from '../DispatchAttemptUseCase.use-case.js';
import type { DispatchAttemptRequest } from '../../ports/in/DispatchAttemptPort.in-port.js';

/**
 * Stub deps: the entry check refuses before any dep runs; for a contained
 * entry the dispatch proceeds to the work-order lookup, which a stub rejects.
 */
const stubDeps = {
  workOrderRepo: { findWorkOrderById: async () => null },
} as unknown as DispatchAttemptDependencies;

function requestWith(expectedArtifacts: readonly string[]): DispatchAttemptRequest {
  return {
    attemptId: 'attempt-1',
    workOrderId: 'wo-1',
    worktreePath: '/wt',
    briefPackagePath: '/wt/.lane/brief.md',
    briefDigest: 'digest',
    baseCommit: 'abc123',
    stepLimit: 10,
    timeLimitSeconds: 60,
    expectedArtifacts,
  };
}

describe('DispatchAttemptUseCase expectedArtifacts entry validation', () => {
  it('refuses an absolute expected artifact, naming it, before any dependency runs', async () => {
    const useCase = new DispatchAttemptUseCase(stubDeps);
    const result = await useCase.dispatchAttempt(requestWith(['/etc/passwd']));
    expect(result).toEqual({
      outcome: 'refused',
      reason: expect.stringContaining('/etc/passwd'),
    });
  });

  it('refuses an escaping expected artifact, naming it', async () => {
    const useCase = new DispatchAttemptUseCase(stubDeps);
    const result = await useCase.dispatchAttempt(requestWith(['../x']));
    expect(result).toEqual({
      outcome: 'refused',
      reason: expect.stringContaining('../x'),
    });
  });

  it('accepts contained expected artifacts past the entry check', async () => {
    const useCase = new DispatchAttemptUseCase(stubDeps);
    const result = await useCase.dispatchAttempt(requestWith(['.lane/notes.md']));
    // Past the entry check the dispatch proceeds to the work order lookup and
    // refuses there (stub deps hold no work order) — never the entry reason.
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).not.toContain('expectedArtifacts');
    }
  });
});
