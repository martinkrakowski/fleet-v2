/**
 * CLI-boundary tests for lane O8: the removed `--requiredCapabilities`
 * override (D4) and the forge mode wired into acceptance in this root (D6).
 */

import { describe, expect, it } from 'vitest';

import { assessmentIdForAttempt, createFleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { AttemptRecord } from '@fleet/work-execution';
import type { EvidenceAssessmentRecord } from '@fleet/evidence-and-acceptance';
import type { FleetInstallation } from '@fleet/installation';

const HEAD = '1111111111111111111111111111111111111111';
const ATTEMPT_ID = 'att-forge-1';

/** Minimal v2 installation: one local host with a declared container runner. */
function makeInstallation(forge: FleetInstallation['forge']): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {
      local: {
        transport: 'local',
        worktreeRoot: '/tmp/fleet-o8-worktrees',
        roles: ['orchestrator', 'lane-runner'],
        runner: {
          kind: 'opencode',
          port: 46000,
          capabilities: {
            networkEgressRestricted: true,
            cpuAndMemoryLimited: true,
            processTreeTermination: true,
            filesystemScope: 'scoped-worktree',
          },
          maxLanes: 2,
        },
      },
    },
    ...(forge !== undefined ? { forge } : {}),
  };
}

function collectIo(): { out: string[]; err: string[]; io: { stdout: (t: string) => void; stderr: (t: string) => void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) } };
}

function makeAttempt(): AttemptRecord {
  return {
    id: ATTEMPT_ID,
    workOrderId: 'wo-forge-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    state: 'collected',
    outcome: 'done',
    baseCommit: '0000000000000000000000000000000000000000',
    worktreePath: '/tmp/fleet-o8-worktrees/att-forge-1',
    briefDigest: 'digest-1',
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: {
      headCommit: HEAD,
      commitsSinceBase: [HEAD],
      collectedArtifactPaths: ['/tmp/patch.diff'],
      notes: 'present',
    },
    ownerDecisionReferences: [],
    createdAtIso: '2026-10-16T08:00:00.000Z',
    updatedAtIso: '2026-10-16T08:00:00.000Z',
  };
}

/** A pending assessment with one passing independent review for the head. */
function makeAssessment(requiredChecks: readonly string[]): EvidenceAssessmentRecord {
  return {
    id: assessmentIdForAttempt(ATTEMPT_ID),
    projectId: 'proj-forge-1',
    attemptId: ATTEMPT_ID,
    candidateHeadSha: HEAD,
    policyRevision: 'pol-1',
    implementerModel: 'nvidia/z-ai/glm-5.3',
    requiredChecks: [...requiredChecks],
    state: 'pending',
    verificationReceipts: [],
    reviewReceipts: [
      {
        id: 'rr-forge-1',
        assessmentId: assessmentIdForAttempt(ATTEMPT_ID),
        projectId: 'proj-forge-1',
        attemptId: ATTEMPT_ID,
        candidateHeadSha: HEAD,
        reviewerModel: 'openai/example-reviewer',
        implementerModel: 'nvidia/z-ai/glm-5.3',
        readOnlyVerified: true,
        result: 'pass',
        findings: [],
        evidenceRef: 'evidence://review-forge-1',
        policyRevision: 'pol-1',
        completedAtIso: '2026-10-16T08:00:00.000Z',
      },
    ],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 1,
    updatedAtIso: '2026-10-16T08:00:00.000Z',
  };
}

describe('attempt dispatch refuses the requiredCapabilities override (D4)', () => {
  it('a supplied --requiredCapabilities is a usage error (exit 2)', async () => {
    const runtime = createFleetCliRuntime();
    const { err, io } = collectIo();
    const code = await runCli(
      [
        'attempt',
        'dispatch',
        '--json',
        JSON.stringify({
          attemptId: ATTEMPT_ID,
          workOrderId: 'wo-forge-1',
          worktreePath: '/tmp/wt',
          requiredCapabilities: {
            filesystemScope: 'scoped-worktree',
            networkEgressRestricted: true,
            cpuAndMemoryLimited: true,
            processTreeTermination: true,
            authoritativeCompletion: true,
            artifactPersistence: true,
          },
        }),
      ],
      io,
      runtime,
    );
    expect(code).toBe(2);
    expect(err.join('')).toContain("'--requiredCapabilities' is forbidden");
  });
});

describe('forge mode wired into CLI acceptance (D6)', () => {
  it('a failing forge read blocks acceptance through the CLI in mode github', async () => {
    const installation = makeInstallation({ mode: 'github', owner: 'example-owner', repo: 'example-repo' });
    const runtime = createFleetCliRuntime({ installation });
    await runtime.execution.attemptRepository.saveAttempt(makeAttempt());
    await runtime.evidence.evidenceAssessmentRepository.saveAssessment(makeAssessment([]));

    const { out, io } = collectIo();
    const code = await runCli(
      ['evidence', 'assess', '--json', JSON.stringify({
        attemptId: ATTEMPT_ID,
        candidateHeadSha: HEAD,
        policyRevision: 'pol-1',
      })],
      io,
      runtime,
    );

    expect(code).toBe(1);
    const result = JSON.parse(out.join('')) as { outcome: string; blockers: string[] };
    expect(result.outcome).toBe('blocked');
    expect(result.blockers.some((b) => b.includes("forge reports CI state 'unknown'"))).toBe(true);
  });

  it('mode none accepts receipt-only and records forgeEvidence not-configured', async () => {
    const installation = makeInstallation({ mode: 'none' });
    const runtime = createFleetCliRuntime({ installation });
    await runtime.execution.attemptRepository.saveAttempt(makeAttempt());
    await runtime.evidence.evidenceAssessmentRepository.saveAssessment(makeAssessment([]));

    const { out, io } = collectIo();
    const code = await runCli(
      ['evidence', 'assess', '--json', JSON.stringify({
        attemptId: ATTEMPT_ID,
        candidateHeadSha: HEAD,
        policyRevision: 'pol-1',
      })],
      io,
      runtime,
    );

    expect(code).toBe(0);
    const result = JSON.parse(out.join('')) as { outcome: string };
    expect(result.outcome).toBe('accepted');
    const stored = await runtime.evidence.evidenceAssessmentRepository.findAssessmentById(
      assessmentIdForAttempt(ATTEMPT_ID),
    );
    expect(stored?.forgeEvidence).toBe('not-configured');
  });

  it('mode none blocks an assessment whose brief names a CI requirement', async () => {
    const installation = makeInstallation({ mode: 'none' });
    const runtime = createFleetCliRuntime({ installation });
    await runtime.execution.attemptRepository.saveAttempt(makeAttempt());
    await runtime.evidence.evidenceAssessmentRepository.saveAssessment(makeAssessment(['ci']));

    const { out, io } = collectIo();
    const code = await runCli(
      ['evidence', 'assess', '--json', JSON.stringify({
        attemptId: ATTEMPT_ID,
        candidateHeadSha: HEAD,
        policyRevision: 'pol-1',
      })],
      io,
      runtime,
    );

    expect(code).toBe(1);
    const result = JSON.parse(out.join('')) as { outcome: string; blockers: string[] };
    expect(result.outcome).toBe('blocked');
    expect(
      result.blockers.some((b) => b.includes("forge mode is 'none'") && b.includes('not-configured')),
    ).toBe(true);
  });
});
