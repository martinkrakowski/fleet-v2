// RV4 production-path busy case (F149): the composed conductor's review
// request goes through createFleetCliRuntime -> the real review transport
// router -> createOcmReviewTransport. Only the process spawn (`reviewSpawn`)
// is replaced. A second `ocm-run` in a busy worktree exits 75; the composed
// outcome is `seat-busy`, never `transport`, and the review is not spawned.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { EvidenceAssessmentRecord, OcmReviewTransportSpawn } from '@fleet/evidence-and-acceptance';
import type { FleetInstallation } from '@fleet/installation';
import type { AttemptRecord } from '@fleet/work-execution';
import { assessmentIdForAttempt, createFleetCliRuntime } from '../../composition.js';

const ATTEMPT_ID = 'att-rv4';
const PROJECT_ID = 'proj-rv4';
const POLICY = 'policy-1';
const IMPL = 'example-provider/glm-5.3';
const REVIEWER = 'example-provider/grok-4.7';
const REQUEST_ID = 'review-01JB0000000000000000000009';

function git(cwd: string, args: readonly string[]): string {
  return String(execFileSync('git', [...args], { cwd, encoding: 'utf8' })).trim();
}

function makeRepo(): { repoDir: string; base: string; head: string } {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-rv4-repo-'));
  git(repoDir, ['init', '-q']);
  git(repoDir, ['config', 'user.email', 'lane@example.invalid']);
  git(repoDir, ['config', 'user.name', 'lane']);
  writeFileSync(path.join(repoDir, 'a.txt'), 'one\n');
  git(repoDir, ['add', 'a.txt']);
  git(repoDir, ['commit', '-q', '-m', 'base']);
  const base = git(repoDir, ['rev-parse', 'HEAD']);
  writeFileSync(path.join(repoDir, 'a.txt'), 'two\n');
  git(repoDir, ['commit', '-q', '-am', 'change']);
  return { repoDir, base, head: git(repoDir, ['rev-parse', 'HEAD']) };
}

function installation(repoDir: string): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {
      'this-machine': {
        transport: 'local',
        worktreeRoot: repoDir,
        tmpDir: path.join(repoDir, '.tmp'),
        roles: ['orchestrator', 'lane-runner', 'verifier'],
        runner: {
          kind: 'opencode',
          port: 46000,
          capabilities: {
            networkEgressRestricted: false,
            cpuAndMemoryLimited: false,
            processTreeTermination: false,
            filesystemScope: 'inherited-directory',
          },
        },
      },
    },
    tools: ['opencode'],
    seats: [
      { id: 'implementer', tool: 'opencode', model: IMPL, agent: 'example-agent', roles: ['implementer'], costClass: 'plan-quota' },
      { id: 'reviewer', tool: 'opencode', model: REVIEWER, agent: 'example-agent', roles: ['reviewer'], costClass: 'paid' },
    ],
    chains: { implementer: [{ seatId: 'implementer' }], reviewer: [{ seatId: 'reviewer' }] },
    forge: { mode: 'none' },
  } as FleetInstallation;
}

function attempt(repoDir: string, base: string, head: string): AttemptRecord {
  return {
    id: ATTEMPT_ID,
    workOrderId: 'wo-rv4-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: repoDir,
    baseCommit: base,
    state: 'collected',
    outcome: 'done',
    briefDigest: 'digest-rv4',
    briefPackagePath: null,
    sessionId: 'session-rv4',
    completionReceipt: null,
    artifacts: { headCommit: head, commitsSinceBase: [], collectedArtifactPaths: [], notes: 'missing' },
    runner: {
      kind: 'opencode',
      remotePort: 46000,
      host: null,
      hostName: 'this-machine',
      agent: 'example-agent',
      model: IMPL,
      variant: null,
    },
    createdAtIso: '2026-10-27T08:00:00.000Z',
    updatedAtIso: '2026-10-27T08:30:00.000Z',
  } as AttemptRecord;
}

function assessment(head: string): EvidenceAssessmentRecord {
  return {
    id: assessmentIdForAttempt(ATTEMPT_ID),
    projectId: PROJECT_ID,
    attemptId: ATTEMPT_ID,
    candidateHeadSha: head,
    policyRevision: POLICY,
    implementerModel: IMPL,
    requiredChecks: [],
    state: 'pending',
    verificationReceipts: [],
    reviewReceipts: [],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 0,
    updatedAtIso: '2026-10-27T08:30:00.000Z',
  };
}

describe('conductor review busy-worktree composition (RV4, F149)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function compose(reviewSpawn: OcmReviewTransportSpawn) {
    const repo = makeRepo();
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-rv4-state-'));
    dirs.push(repo.repoDir, stateDir);
    const runtime = createFleetCliRuntime({ stateDir, installation: installation(repo.repoDir), reviewSpawn });
    await runtime.execution.attemptRepository.saveAttempt(attempt(repo.repoDir, repo.base, repo.head));
    await runtime.evidence.evidenceAssessmentRepository.saveAssessment(assessment(repo.head));
    const request = {
      requestId: REQUEST_ID,
      kind: 'code-review' as const,
      attemptId: ATTEMPT_ID,
      projectId: PROJECT_ID,
      candidateHeadSha: repo.head,
      policyRevision: POLICY,
      implementerModel: IMPL,
      reviewerModel: REVIEWER,
    };
    return { runtime, request };
  }

  it('a second ocm-run in the same worktree exits 75 and the request is seat-busy, not transport', async () => {
    const calls: string[][] = [];
    const { runtime, request } = await compose(async (_file, args) => {
      calls.push([...args]);
      return { exitCode: 75, stdout: '', stderr: 'session running in /secret/place' };
    });
    const outcome = await runtime.conductor.reviewRequest.requestReview(request);
    expect(outcome).toEqual({ outcome: 'no-receipt', reason: 'review-unavailable', detail: 'seat-busy' });
    expect(outcome).not.toMatchObject({ detail: 'transport' });
    // Only the --wait probe ran; the review itself was never spawned.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--wait');
  });

  it('a review spawn that exits 75 after an idle wait is also seat-busy', async () => {
    const calls: string[][] = [];
    const { runtime, request } = await compose(async (_file, args) => {
      calls.push([...args]);
      return args.includes('--wait')
        ? { exitCode: 0, stdout: '', stderr: '' }
        : { exitCode: 75, stdout: '', stderr: 'already running' };
    });
    const outcome = await runtime.conductor.reviewRequest.requestReview(request);
    expect(outcome).toEqual({ outcome: 'no-receipt', reason: 'review-unavailable', detail: 'seat-busy' });
    expect(calls).toHaveLength(2);
  });
});
