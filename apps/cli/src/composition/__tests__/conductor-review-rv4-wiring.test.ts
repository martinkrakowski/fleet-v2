// RV4 production-path wiring: the composed conductor's review-request port
// archives a screened seat-busy diagnostic under the request id. This lives
// under `apps/cli/src/composition` (the lane's allowed scope) so the
// diff-check gate sees it; the tests must go through the real composition
// (createFleetCliRuntime), never a test-only wiring.
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { EvidenceAssessmentRecord } from '@fleet/evidence-and-acceptance';
import { assessmentIdForAttempt, createFleetCliRuntime } from '../../composition.js';

const HEAD = 'a'.repeat(40);
const ATTEMPT_ID = 'attempt-example-1';
const PROJECT_ID = 'project-example-1';
const REQUEST_ID = 'review-01JB0000000000000000000001';

function makeReviewRequest(requestId: string) {
  return {
    requestId,
    kind: 'code-review' as const,
    attemptId: ATTEMPT_ID,
    projectId: PROJECT_ID,
    candidateHeadSha: HEAD,
    policyRevision: 'policy-example-1',
    implementerModel: 'example-provider/glm-5.3',
    reviewerModel: 'example-provider/grok-4.7',
  };
}

/** A pending assessment at HEAD; the receipt carries kind and request id. */
function makeAssessment(withReceipt: boolean): EvidenceAssessmentRecord {
  return {
    id: assessmentIdForAttempt(ATTEMPT_ID),
    projectId: PROJECT_ID,
    attemptId: ATTEMPT_ID,
    candidateHeadSha: HEAD,
    policyRevision: 'policy-example-1',
    implementerModel: 'example-provider/glm-5.3',
    requiredChecks: [],
    state: 'pending',
    verificationReceipts: [],
    reviewReceipts: withReceipt
      ? [
          {
            id: 'rr-example-1',
            assessmentId: assessmentIdForAttempt(ATTEMPT_ID),
            projectId: PROJECT_ID,
            attemptId: ATTEMPT_ID,
            candidateHeadSha: HEAD,
            reviewerModel: 'example-provider/grok-4.7',
            implementerModel: 'example-provider/glm-5.3',
            readOnlyVerified: true,
            result: 'pass',
            findings: [],
            evidenceRef: 'evidence://review-example-1',
            policyRevision: 'policy-example-1',
            completedAtIso: '2026-10-28T08:00:00.000Z',
            kind: 'code-review' as const,
            requestId: REQUEST_ID,
          },
        ]
      : [],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 1,
    updatedAtIso: '2026-10-28T08:00:00.000Z',
  };
}

describe('conductor review transport diagnostic archive wiring (RV4)', () => {
  it('transport error archive redacts secrets and paths: the composed review-request adapter archives a screened seat-busy diagnostic under the request id', async () => {
    // The production path: composeConductor builds ReviewRequestAdapter over
    // the runtime's evidence context, with archiveEvidence bound to the real
    // EvidenceArchiveAdapter. Only the review transport use case is replaced
    // (it would otherwise need a reviewer seat that spawns); the screen, the
    // archive wiring and the outcome mapping are the composed ones.
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-cli-rv4-archive-'));
    try {
      const runtime = createFleetCliRuntime({ stateDir: tempDir });
      const SECRET = 'ghp_' + 'a'.repeat(36);
      vi.spyOn(runtime.evidence.requestIndependentReview, 'requestIndependentReview').mockResolvedValue(
        {
          outcome: 'rejected',
          reason: 'review seat busy',
          rejection: 'review-unavailable',
          code: 'seat-busy',
          diagnostic: {
            exitCode: 75,
            timedOut: false,
            stderr: `${SECRET} /tmp/secret-dir/review-log.txt`,
            stdoutEmpty: false,
          },
        } as never,
      );
      // Wrap (never replace) the composed archive so the real archive runs and
      // the produced reference is captured.
      const archive = runtime.evidence.evidenceArchive;
      const realArchive = archive.archiveEvidence.bind(archive);
      let archivedRef: string | null = null;
      vi.spyOn(archive, 'archiveEvidence').mockImplementation(async (request) => {
        const result = await realArchive(request);
        archivedRef = result.evidenceRef;
        return result;
      });

      await runtime.evidence.evidenceAssessmentRepository.saveAssessment(makeAssessment(false));
      await expect(
        runtime.conductor.reviewRequest.requestReview(makeReviewRequest(REQUEST_ID)),
      ).resolves.toEqual({ outcome: 'no-receipt', reason: 'review-unavailable', detail: 'seat-busy' });

      expect(archivedRef).not.toBeNull();
      expect(archivedRef!.startsWith(`evidence://review-transport-${REQUEST_ID}@`)).toBe(true);
      const content = await archive.readArchivedEvidence(archivedRef!);
      expect(JSON.parse(content ?? '{}')).toEqual({
        exitCode: 75,
        timedOut: false,
        stdoutEmpty: false,
        stderr: '[redacted] [path]',
      });
      expect(content).not.toContain('ghp_');
      expect(content).not.toContain('/tmp/secret-dir');
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
