// CLI wiring tests for lane PC-4: the runtime exposes the conductor's
// review-request and CI-state ports and the head-CI inspection use case. No
// state dir (in-memory), no reviewer seat (nothing spawns), no forge reached
// except through the stub gh runner in forge mode github.

import { describe, expect, it } from 'vitest';

import type { FleetInstallation, ForgeSectionV2 } from '@fleet/installation';
import type { EvidenceAssessmentRecord } from '@fleet/evidence-and-acceptance';

import { assessmentIdForAttempt, createFleetCliRuntime } from '../composition.js';

const HEAD = 'a'.repeat(40);
const HEAD_2 = 'b'.repeat(40);
const ATTEMPT_ID = 'attempt-example-1';
const PROJECT_ID = 'project-example-1';
const REQUEST_ID = 'review-01JB0000000000000000000001';

const HOSTS = {
  local: {
    transport: 'local' as const,
    worktreeRoot: '/tmp/fleet-pc4-worktrees',
    roles: ['orchestrator', 'lane-runner'] as ('orchestrator' | 'lane-runner')[],
    runner: {
      kind: 'opencode' as const,
      port: 46000,
      capabilities: {
        networkEgressRestricted: true,
        cpuAndMemoryLimited: true,
        processTreeTermination: true,
        filesystemScope: 'scoped-worktree' as const,
      },
      maxLanes: 2,
    },
  },
};

/** Minimal v2 installation: one local host with a declared container runner. */
function makeInstallation(forge: ForgeSectionV2): FleetInstallation {
  return { schemaVersion: 2, hosts: HOSTS, forge };
}

/** The same installation with no forge section at all (the harness type wants one). */
function makeInstallationWithoutForge(): FleetInstallation {
  return { schemaVersion: 2, hosts: HOSTS } as unknown as FleetInstallation;
}

interface GhStub {
  readonly calls: string[][];
  readonly forgeGhRunner: (args: readonly string[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

/** A stub gh runner: every `gh api .../pulls` call answers one open PR at HEAD. */
function makeGhRunner(): GhStub {
  const calls: string[][] = [];
  const pullsFixture = JSON.stringify([
    { state: 'open', number: 3, head: { sha: HEAD } },
  ]);
  const threadsFixture = JSON.stringify({
    data: { repository: { pullRequest: { reviewThreads: { totalCount: 0, nodes: [] } } } },
  });
  const forgeGhRunner = async (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === 'pr' && args[1] === 'checks') {
      return { exitCode: 0, stdout: '[{"bucket":"pass"}]', stderr: '' };
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      return { exitCode: 0, stdout: threadsFixture, stderr: '' };
    }
    return { exitCode: 0, stdout: pullsFixture, stderr: '' };
  };
  return { calls, forgeGhRunner };
}

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

describe('conductor review and CI wiring (PC-4)', () => {
  it('mode github answers the CI read through the stub runner as passed', async () => {
    const { calls, forgeGhRunner } = makeGhRunner();
    const runtime = createFleetCliRuntime({
      installation: makeInstallation({
        mode: 'github',
        owner: 'example-owner',
        repo: 'example-repo',
      }),
      forgeGhRunner,
    });
    await expect(
      runtime.conductor.ciState.readHeadCiState({ headSha: HEAD }),
    ).resolves.toEqual({ headSha: HEAD, state: 'passed', reason: 'read' });
    // The forge-evidence read makes four gh calls (pulls lookup, checks, the
    // head re-read and the thread read); the pulls and checks calls the brief
    // names are among them.
    expect(calls.length).toBe(4);
    expect(calls.some((args) => args.includes(`repos/example-owner/example-repo/commits/${HEAD}/pulls`))).toBe(
      true,
    );
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'checks')).toBe(true);
  });

  it('mode none answers unknown / not-configured and never calls the runner', async () => {
    const { calls, forgeGhRunner } = makeGhRunner();
    const runtime = createFleetCliRuntime({
      installation: makeInstallation({ mode: 'none' }),
      forgeGhRunner,
    });
    await expect(
      runtime.conductor.ciState.readHeadCiState({ headSha: HEAD }),
    ).resolves.toEqual({ headSha: HEAD, state: 'unknown', reason: 'not-configured' });
    expect(calls).toEqual([]);
  });

  it('an installation without a forge section answers unknown / not-configured', async () => {
    const { calls, forgeGhRunner } = makeGhRunner();
    const runtime = createFleetCliRuntime({
      installation: makeInstallationWithoutForge(),
      forgeGhRunner,
    });
    await expect(
      runtime.conductor.ciState.readHeadCiState({ headSha: HEAD }),
    ).resolves.toEqual({ headSha: HEAD, state: 'unknown', reason: 'not-configured' });
    expect(calls).toEqual([]);
  });

  it('a review for an attempt with no stored assessment is refused no-assessment', async () => {
    const runtime = createFleetCliRuntime();
    await expect(
      runtime.conductor.reviewRequest.requestReview(makeReviewRequest(REQUEST_ID)),
    ).resolves.toEqual({ outcome: 'refused', reason: 'no-assessment' });
  });

  it('a request with no reviewer seat records no receipt (review-unavailable)', async () => {
    const runtime = createFleetCliRuntime();
    await runtime.evidence.evidenceAssessmentRepository.saveAssessment(makeAssessment(false));
    await expect(
      runtime.conductor.reviewRequest.requestReview(makeReviewRequest(REQUEST_ID)),
    ).resolves.toEqual({ outcome: 'no-receipt', reason: 'review-unavailable' });
    const assessment = await runtime.evidence.evidenceAssessmentRepository.findAssessmentById(
      assessmentIdForAttempt(ATTEMPT_ID),
    );
    expect(assessment?.reviewReceipts).toEqual([]);
  });

  it('findReviewReceipt reads a receipt by request id through the runtime', async () => {
    const runtime = createFleetCliRuntime();
    await runtime.evidence.evidenceAssessmentRepository.saveAssessment(makeAssessment(true));
    const found = await runtime.conductor.reviewRequest.findReviewReceipt({
      attemptId: ATTEMPT_ID,
      requestId: REQUEST_ID,
      candidateHeadSha: HEAD,
    });
    expect(found.outcome).toBe('found');
    if (found.outcome !== 'found') {
      return;
    }
    expect(found.receipt.requestId).toBe(REQUEST_ID);
    expect(found.receipt.kind).toBe('code-review');
    expect(found.receipt.verdict).toBe('passed');
    await expect(
      runtime.conductor.reviewRequest.findReviewReceipt({
        attemptId: ATTEMPT_ID,
        requestId: 'review-01JB0000000000000000000002',
        candidateHeadSha: HEAD_2,
      }),
    ).resolves.toEqual({ outcome: 'not-found' });
  });
});
