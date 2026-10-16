/**
 * CLI-boundary tests for lane O8: the removed `--requiredCapabilities`
 * override (D4) and the forge mode wired into acceptance in this root (D6).
 */

import { describe, expect, it } from 'vitest';

import { assessmentIdForAttempt, createFleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { AttemptRecord } from '@fleet/work-execution';
import type { EvidenceAssessmentRecord } from '@fleet/evidence-and-acceptance';
import type { FleetInstallation, ForgeSectionV2 } from '@fleet/installation';

const HEAD = '1111111111111111111111111111111111111111';
const ATTEMPT_ID = 'att-forge-1';

/** Minimal v2 installation: one local host with a declared container runner. */
function makeInstallation(forge: ForgeSectionV2): FleetInstallation {
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
    forge,
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
  /** Gh results as the argument-array runner resolves them. */
  type GhResult = { exitCode: number; stdout: string; stderr: string };

  /**
   * A stub of the reviewed gh subprocess: `failing` returns a failing pull
   * request lookup, `passing` answers every forge read for HEAD with passing
   * checks and no unresolved threads.
   */
  function makeGhRunner(outcome: 'failing' | 'passing') {
    return async (args: readonly string[]): Promise<GhResult> => {
      if (outcome === 'failing') {
        return { exitCode: 1, stdout: '', stderr: 'gh: API error' };
      }
      if (args[0] === 'api' && typeof args[1] === 'string' && args[1].startsWith('repos/')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ state: 'open', head: { sha: HEAD }, number: 7 }]),
          stderr: '',
        };
      }
      if (args[0] === 'pr') {
        return { exitCode: 0, stdout: JSON.stringify([{ bucket: 'pass' }]), stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            repository: { pullRequest: { reviewThreads: { totalCount: 0, nodes: [] } } },
          },
        }),
        stderr: '',
      };
    };
  }

  /** The runtime wired for one forge mode with the optional stub transport. */
  function makeRuntime(forge: ForgeSectionV2, ghRunner?: ReturnType<typeof makeGhRunner>) {
    return createFleetCliRuntime({
      installation: makeInstallation(forge),
      ...(ghRunner !== undefined ? { forgeGhRunner: ghRunner } : {}),
    });
  }

  /** Persist the attempt and its pending assessment, then assess via the CLI. */
  async function runAssessment(
    runtime: ReturnType<typeof createFleetCliRuntime>,
    requiredChecks: readonly string[] = [],
  ): Promise<{ code: number; out: string[] }> {
    await runtime.execution.attemptRepository.saveAttempt(makeAttempt());
    await runtime.evidence.evidenceAssessmentRepository.saveAssessment(makeAssessment(requiredChecks));
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
    return { code, out };
  }

  it('mode github blocks when the gh runner returns failure', async () => {
    const runtime = makeRuntime(
      { mode: 'github', owner: 'example-owner', repo: 'example-repo' },
      makeGhRunner('failing'),
    );
    const { code, out } = await runAssessment(runtime);

    expect(code).toBe(1);
    const result = JSON.parse(out.join('')) as { outcome: string; blockers: string[] };
    expect(result.outcome).toBe('blocked');
    expect(result.blockers.some((b) => b.includes("forge reports CI state 'unknown'"))).toBe(true);
  });

  it('mode github counts passing checks and no unresolved threads as a pass', async () => {
    const runtime = makeRuntime(
      { mode: 'github', owner: 'example-owner', repo: 'example-repo' },
      makeGhRunner('passing'),
    );
    const { code, out } = await runAssessment(runtime);

    expect(code).toBe(0);
    const result = JSON.parse(out.join('')) as { outcome: string };
    expect(result.outcome).toBe('accepted');
    // The forge read is real evidence in mode github: no not-configured
    // marker is stored on the assessment.
    const stored = await runtime.evidence.evidenceAssessmentRepository.findAssessmentById(
      assessmentIdForAttempt(ATTEMPT_ID),
    );
    expect(stored?.forgeEvidence).toBeUndefined();
  });

  it('mode none accepts receipt-only and records forgeEvidence not-configured', async () => {
    const runtime = makeRuntime({ mode: 'none' });
    const { code, out } = await runAssessment(runtime);

    expect(code).toBe(0);
    const result = JSON.parse(out.join('')) as { outcome: string };
    expect(result.outcome).toBe('accepted');
    const stored = await runtime.evidence.evidenceAssessmentRepository.findAssessmentById(
      assessmentIdForAttempt(ATTEMPT_ID),
    );
    expect(stored?.forgeEvidence).toBe('not-configured');
  });

  it('mode none blocks an assessment whose brief names a CI requirement', async () => {
    const runtime = makeRuntime({ mode: 'none' });
    const { code, out } = await runAssessment(runtime, ['ci']);

    expect(code).toBe(1);
    const result = JSON.parse(out.join('')) as { outcome: string; blockers: string[] };
    expect(result.outcome).toBe('blocked');
    expect(
      result.blockers.some((b) => b.includes("forge mode is 'none'") && b.includes('not-configured')),
    ).toBe(true);
  });
});
