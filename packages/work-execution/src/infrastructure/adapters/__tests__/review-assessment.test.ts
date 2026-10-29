// ReviewAssessmentAdapter: the consumer-side open-assessment port over the
// evidence context. Every mapping is owned here, never in the composition.
/**
 * Covers openReviewAssessment (validation, not-configured, opened, exists,
 * each refusal code, store-unreadable mapping, throw). All fakes are object
 * literals; nothing touches a host.
 */

import { describe, expect, it } from 'vitest';

import type {
  OpenEvidenceAssessmentRequest,
  OpenEvidenceAssessmentResult,
} from '@fleet/evidence-and-acceptance';
import type {
  OpenReviewAssessmentRequest,
} from '../../../application/ports/out/ReviewAssessmentPort.out-port.js';
import { ReviewAssessmentAdapter } from '../ReviewAssessmentAdapter.adapter.js';

const HEAD = '0000000000000000000000000000000000000000';

function makeAdapterRequest(overrides: Partial<OpenReviewAssessmentRequest> = {}): OpenReviewAssessmentRequest {
  return {
    attemptId: 'attempt-example-1',
    projectId: 'project-example-1',
    candidateHeadSha: HEAD,
    policyRevision: 'policy-example-1',
    implementerModel: 'example-provider/glm-5.3',
    ...overrides,
  };
}

function makeOpenFake(result: OpenEvidenceAssessmentResult) {
  const calls: OpenEvidenceAssessmentRequest[] = [];
  const openEvidenceAssessment = async (request: OpenEvidenceAssessmentRequest) => {
    calls.push(request);
    return result;
  };
  return { calls, openEvidenceAssessment };
}

describe('ReviewAssessmentAdapter.openReviewAssessment', () => {
  it('answers open for an opened assessment and sends the exact coordinates with empty requiredChecks', async () => {
    const { calls, openEvidenceAssessment } = makeOpenFake({
      outcome: 'opened',
      assessmentId: 'assessment-attempt-example-1',
    });
    const adapter = new ReviewAssessmentAdapter({ openEvidenceAssessment });

    const result = await adapter.openReviewAssessment(makeAdapterRequest());

    expect(result).toEqual({ outcome: 'open' });
    expect(calls).toEqual([
      { ...makeAdapterRequest(), requiredChecks: [] },
    ]);
  });

  it('answers open for an existing assessment (idempotent)', async () => {
    const { openEvidenceAssessment } = makeOpenFake({
      outcome: 'exists',
      assessmentId: 'assessment-attempt-example-1',
    });
    const adapter = new ReviewAssessmentAdapter({ openEvidenceAssessment });

    const result = await adapter.openReviewAssessment(makeAdapterRequest());

    expect(result).toEqual({ outcome: 'open' });
  });

  it.each([
    ['invalid-request', { outcome: 'refused', reason: 'invalid-request' }],
    ['head-mismatch', { outcome: 'refused', reason: 'head-mismatch' }],
    ['terminal', { outcome: 'refused', reason: 'terminal' }],
  ] as const)('maps refusal %s to unavailable %s', async (reason, delegateResult) => {
    const { openEvidenceAssessment } = makeOpenFake(delegateResult as OpenEvidenceAssessmentResult);
    const adapter = new ReviewAssessmentAdapter({ openEvidenceAssessment });

    const result = await adapter.openReviewAssessment(makeAdapterRequest());

    expect(result).toEqual({ outcome: 'unavailable', reason });
  });

  it('maps store-unreadable to unavailable unreadable', async () => {
    const { openEvidenceAssessment } = makeOpenFake({
      outcome: 'refused',
      reason: 'store-unreadable',
    });
    const adapter = new ReviewAssessmentAdapter({ openEvidenceAssessment });

    const result = await adapter.openReviewAssessment(makeAdapterRequest());

    expect(result).toEqual({ outcome: 'unavailable', reason: 'unreadable' });
  });

  it('answers unavailable unreadable when the delegate throws', async () => {
    const openEvidenceAssessment = async (): Promise<OpenEvidenceAssessmentResult> => {
      throw new Error('store exploded');
    };
    const adapter = new ReviewAssessmentAdapter({ openEvidenceAssessment });

    const result = await adapter.openReviewAssessment(makeAdapterRequest());

    expect(result).toEqual({ outcome: 'unavailable', reason: 'unreadable' });
  });

  it('answers unavailable not-configured when no delegate is bound', async () => {
    const adapter = new ReviewAssessmentAdapter();

    const result = await adapter.openReviewAssessment(makeAdapterRequest());

    expect(result).toEqual({ outcome: 'unavailable', reason: 'not-configured' });
  });

  it.each([
    ['bad head', { candidateHeadSha: 'not-a-sha' }],
    ['empty attempt', { attemptId: '   ' }],
    ['empty project', { projectId: '' }],
    ['empty policy revision', { policyRevision: '  ' }],
    ['empty implementer model', { implementerModel: '' }],
  ] as const)(
    'answers unavailable invalid-request for %s without calling the delegate',
    async (_name, overrides) => {
      const { calls, openEvidenceAssessment } = makeOpenFake({
        outcome: 'opened',
        assessmentId: 'assessment-attempt-example-1',
      });
      const adapter = new ReviewAssessmentAdapter({ openEvidenceAssessment });

      const result = await adapter.openReviewAssessment(
        makeAdapterRequest(overrides as Partial<OpenReviewAssessmentRequest>),
      );

      expect(result).toEqual({ outcome: 'unavailable', reason: 'invalid-request' });
      expect(calls).toHaveLength(0);
    },
  );
});
