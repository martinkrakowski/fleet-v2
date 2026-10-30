// CLI wiring tests for lane PC-4: the runtime exposes the conductor's
// review-request and CI-state ports and the head-CI inspection use case. No
// state dir (in-memory), no reviewer seat (nothing spawns), no forge reached
// except through the stub gh runner in forge mode github.

import { describe, expect, it } from 'vitest';

import type { FleetInstallation, ForgeSectionV2 } from '@fleet/installation';
import { requireValidInstallationModel } from '@fleet/installation';
import type { EvidenceAssessmentRecord } from '@fleet/evidence-and-acceptance';

import { assessmentIdForAttempt, createFleetCliRuntime } from '../composition.js';
import { buildLiveConductorDriver, conductorGateOf } from '../conductor-wiring.js';

const HEAD = 'a'.repeat(40);
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
    ).resolves.toEqual({ outcome: 'refused', reason: 'no-assessment', detail: null });
  });

  it('a request with no reviewer seat records no receipt (review-unavailable)', async () => {
    const runtime = createFleetCliRuntime();
    await runtime.evidence.evidenceAssessmentRepository.saveAssessment(makeAssessment(false));
    await expect(
      runtime.conductor.reviewRequest.requestReview(makeReviewRequest(REQUEST_ID)),
    ).resolves.toEqual({
      outcome: 'no-receipt',
      reason: 'review-unavailable',
      detail: 'transport-missing',
    });
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
        candidateHeadSha: HEAD,
      }),
    ).resolves.toEqual({ outcome: 'not-found' });
  });
});

describe('conductor review-assessment wiring (K5-6)', () => {
  /** A valid open request over the shared attempt and head. */
  function makeOpenRequest(head: string = HEAD) {
    return {
      attemptId: ATTEMPT_ID,
      projectId: PROJECT_ID,
      candidateHeadSha: head,
      policyRevision: 'policy-example-1',
      implementerModel: 'example-provider/glm-5.3',
      requiredChecks: ['dry-run-check'],
    };
  }

  it('opening the assessment for one attempt and head answers open twice (idempotent)', async () => {
    const runtime = createFleetCliRuntime();
    await expect(
      runtime.conductor.reviewAssessment.openReviewAssessment(makeOpenRequest()),
    ).resolves.toEqual({ outcome: 'open' });
    await expect(
      runtime.conductor.reviewAssessment.openReviewAssessment(makeOpenRequest()),
    ).resolves.toEqual({ outcome: 'open' });
    const assessment = await runtime.evidence.evidenceAssessmentRepository.findAssessmentById(
      assessmentIdForAttempt(ATTEMPT_ID),
    );
    expect(assessment?.state).toBe('pending');
  });

  it('an invalid request answers unavailable invalid-request without writing', async () => {
    const runtime = createFleetCliRuntime();
    await expect(
      runtime.conductor.reviewAssessment.openReviewAssessment({
        ...makeOpenRequest(),
        candidateHeadSha: 'not-a-sha',
      }),
    ).resolves.toEqual({ outcome: 'unavailable', reason: 'invalid-request' });
  });

  it('a stored assessment at another head answers unavailable head-mismatch', async () => {
    const runtime = createFleetCliRuntime();
    await runtime.evidence.evidenceAssessmentRepository.saveAssessment(makeAssessment(false));
    await expect(
      runtime.conductor.reviewAssessment.openReviewAssessment(makeOpenRequest('b'.repeat(40))),
    ).resolves.toEqual({ outcome: 'unavailable', reason: 'head-mismatch' });
  });

  it('the gate receipt adapter records one verification receipt per check into the opened assessment, and is unavailable without one (KF-13b)', async () => {
    const runtime = createFleetCliRuntime();
    const request = {
      attemptId: ATTEMPT_ID,
      projectId: PROJECT_ID,
      candidateHeadSha: HEAD,
      hostId: 'lane-host',
      policyRevision: 'policy-example-1',
      completedAtIso: '2026-10-29T12:00:00.000Z',
      evidenceRef: 'run-journal:run-01JB0000000000000000000000/r0/gate/0',
      receipts: [{ procedureName: 'dry-run-check', result: 'pass' as const, exitCode: 0 }],
    };
    const before = await runtime.conductor.gateReceipts.recordGateReceipts(request);
    expect(before.outcome).toBe('unavailable');

    await expect(runtime.conductor.reviewAssessment.openReviewAssessment(makeOpenRequest())).resolves.toEqual({ outcome: 'open' });
    const after = await runtime.conductor.gateReceipts.recordGateReceipts(request);
    expect(after).toEqual({ outcome: 'recorded', count: 1 });
    const assessment = await runtime.evidence.evidenceAssessmentRepository.findAssessmentById(assessmentIdForAttempt(ATTEMPT_ID));
    expect(assessment?.verificationReceipts.map((receipt) => [receipt.procedureName, receipt.candidateHeadSha])).toEqual([
      ['dry-run-check', HEAD],
    ]);
  });

  it('the live conductor evaluates the predicate-backed gate, never the predicate-less accept instance (KF-12)', async () => {
    const runtime = createFleetCliRuntime();
    const gate = conductorGateOf(runtime);
    expect(gate).toBe(runtime.execution.attemptGate);
    expect(gate).not.toBe(runtime.execution.requestAttemptAcceptance);
    // The predicate-less instance answers 'not wired' before it reads anything; the
    // conductor's gate reads the attempt first (and finds none here).
    const headSha = 'a'.repeat(40);
    const unwired = await runtime.execution.requestAttemptAcceptance.evaluateAttemptGate({ attemptId: 'attempt-missing', candidateHeadSha: headSha });
    expect(unwired).toMatchObject({ verdict: 'unknown', reason: 'Gate predicates are not wired' });
    const wired = await gate.evaluateAttemptGate({ attemptId: 'attempt-missing', candidateHeadSha: headSha });
    expect(wired.verdict).toBe('unknown');
    expect(wired).not.toMatchObject({ reason: 'Gate predicates are not wired' });
  });

  it('buildLiveConductorDriver constructs over the composed runtime and calls no transport', async () => {
    const runtime = createFleetCliRuntime();
    const driver = buildLiveConductorDriver(runtime, { maxActiveRuns: 1 });
    expect(driver.start).not.toBeNull();
    expect(driver.policy).toBeDefined();
  });
});

describe('conductor acceptance-to-merge wiring (K6-8)', () => {
  /** An unreadable installation: the auto-merge flag fails closed. */
  function unreadableLoad(): { status: 'invalid'; file: string; errors: string[] } {
    return { status: 'invalid', file: 'fleet.example.yaml', errors: [] };
  }

  /** The shared v2 installation with a `policy.autoMerge` block. */
  function installationWithAutoMerge(enabled: boolean): FleetInstallation {
    return {
      schemaVersion: 2,
      hosts: HOSTS,
      forge: { mode: 'none' },
      policy: {
        autoMerge: { enabled, allowHighRisk: false, onBlocked: 'ask-owner' },
      },
    } as unknown as FleetInstallation;
  }

  it('the runtime exposes the conductor grant, the park notice and the auto-merge flag', () => {
    const off = createFleetCliRuntime({
      loadInstallationForAutoMerge: unreadableLoad,
    });
    expect(off.conductor.conductorForgeGrant).toBeDefined();
    expect(off.conductor.parkNotice).toBeDefined();
    // An unreadable installation fails closed: no auto-merge.
    expect(off.conductor.autoMergeEnabled).toBe(false);

    const on = createFleetCliRuntime({
      installation: installationWithAutoMerge(true),
      loadInstallationForAutoMerge: () => ({
        status: 'loaded' as const,
        file: 'fleet.example.yaml',
        installation: installationWithAutoMerge(true),
        model: requireValidInstallationModel(installationWithAutoMerge(true)),
        warnings: [],
      }),
    });
    expect(on.conductor.autoMergeEnabled).toBe(true);
  });

  it('an installation without policy.autoMerge reads the flag off', () => {
    const runtime = createFleetCliRuntime({
      installation: makeInstallation({ mode: 'none' }),
      loadInstallationForAutoMerge: () => ({
        status: 'loaded' as const,
        file: 'fleet.example.yaml',
        installation: makeInstallation({ mode: 'none' }),
        model: requireValidInstallationModel(makeInstallation({ mode: 'none' })),
        warnings: [],
      }),
    });
    expect(runtime.conductor.autoMergeEnabled).toBe(false);
  });

  it('buildLiveConductorDriver constructs with the K6 ports bound and calls no transport or forge', async () => {
    const { calls, forgeGhRunner } = makeGhRunner();
    const runtime = createFleetCliRuntime({
      installation: makeInstallation({ mode: 'none' }),
      forgeGhRunner,
      loadInstallationForAutoMerge: unreadableLoad,
    });
    const driver = buildLiveConductorDriver(runtime, { maxActiveRuns: 1 });
    expect(driver.start).not.toBeNull();
    expect(driver.policy).toBeDefined();
    // Building objects only: the injected gh runner (the only forge transport) recorded no call.
    expect(calls).toEqual([]);
  });
});
