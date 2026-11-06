/**
 * `evidence request-review` transport wiring: with a v2 installation that
 * declares a reviewer seat, the CLI binds the review transport router to the
 * independent-review adapter and locates the attempt through its recorded
 * host. These tests drive the real CLI against a real temporary git repository
 * as the attempt's worktree; the review subprocess is a spy, so no ocm-run
 * ever runs.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import type { AttemptRecord } from '@fleet/work-execution';
import type { FleetInstallation } from '@fleet/installation';
import type {
  EvidenceAssessmentRecord,
  OcmReviewTransportSpawn,
} from '@fleet/evidence-and-acceptance';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';

const ATTEMPT_ID = 'att-rw2';
const PROJECT_ID = 'proj-rw2';
const ASSESSMENT_ID = 'assessment-att-rw2';
const POLICY_REVISION = 'policy-1';
const IMPLEMENTER_MODEL = 'example-provider/glm-5.3';
const REVIEWER_MODEL = 'example-provider/grok-4.7';

const PASS_FIXTURE =
  '{"type":"step_start","part":{"type":"step-start"}}\n' +
  '{"type":"text","part":{"type":"text","text":"VERDICT: PASS\\n"}}';

interface Invocation {
  readonly code: number;
  readonly text: string;
  readonly stderr: string;
}

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

function git(cwd: string, args: readonly string[]): string {
  return String(execFileSync('git', [...args], { cwd, encoding: 'utf8' })).trim();
}

async function makeRepo(): Promise<{ repoDir: string; base: string; head: string }> {
  const repoDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-review-rw2-'));
  git(repoDir, ['init', '-q']);
  git(repoDir, ['config', 'user.email', 'lane@example.invalid']);
  git(repoDir, ['config', 'user.name', 'lane']);
  writeFileSync(path.join(repoDir, 'a.txt'), 'one\n');
  git(repoDir, ['add', 'a.txt']);
  git(repoDir, ['commit', '-q', '-m', 'base']);
  const base = git(repoDir, ['rev-parse', 'HEAD']);
  writeFileSync(path.join(repoDir, 'a.txt'), 'two\n');
  git(repoDir, ['commit', '-q', '-am', 'change']);
  const head = git(repoDir, ['rev-parse', 'HEAD']);
  return { repoDir, base, head };
}

function makeInstallation(repoDir: string, withReviewer: boolean): FleetInstallation {
  const seats: NonNullable<FleetInstallation['seats']>[number][] = [
    {
      id: 'implementer',
      tool: 'opencode',
      model: IMPLEMENTER_MODEL,
      agent: 'example-agent',
      roles: ['implementer'],
      costClass: 'plan-quota',
    },
  ];
  const chains: { implementer: { seatId: string }[]; reviewer?: { seatId: string }[] } = {
    implementer: [{ seatId: 'implementer' }],
  };
  if (withReviewer) {
    seats.push({
      id: 'reviewer',
      tool: 'opencode',
      model: REVIEWER_MODEL,
      agent: 'example-agent',
      roles: ['reviewer'],
      costClass: 'paid',
    });
    chains.reviewer = [{ seatId: 'reviewer' }];
  }
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
    seats,
    chains,
    forge: { mode: 'none' },
  };
}

function makeAttempt(
  repoDir: string,
  base: string,
  head: string,
  overrides: Partial<AttemptRecord> = {},
): AttemptRecord {
  return {
    id: ATTEMPT_ID,
    workOrderId: 'wo-rw2-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: repoDir,
    baseCommit: base,
    state: 'collected',
    outcome: 'done',
    briefDigest: 'digest-rw2',
    briefPackagePath: null,
    sessionId: 'session-rw2',
    completionReceipt: null,
    artifacts: {
      headCommit: head,
      commitsSinceBase: [],
      collectedArtifactPaths: [],
      notes: 'missing',
    },
    runner: {
      kind: 'opencode',
      remotePort: 46000,
      host: null,
      hostName: 'this-machine',
      agent: 'example-agent',
      model: IMPLEMENTER_MODEL,
      variant: null,
    },
    createdAtIso: '2026-10-27T08:00:00.000Z',
    updatedAtIso: '2026-10-27T08:30:00.000Z',
    ...overrides,
  };
}

function makeAssessment(candidateHeadSha: string): EvidenceAssessmentRecord {
  return {
    id: ASSESSMENT_ID,
    projectId: PROJECT_ID,
    attemptId: ATTEMPT_ID,
    candidateHeadSha,
    policyRevision: POLICY_REVISION,
    implementerModel: IMPLEMENTER_MODEL,
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

describe('independent review transport wiring (RW2)', () => {
  let stateDir: string;

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  const cli = async (runtime: FleetCliRuntime, payload: unknown): Promise<Invocation> => {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = {
      stdout: (text) => {
        out.push(text);
      },
      stderr: (text) => {
        err.push(text);
      },
    };
    const code = await runCli(
      ['evidence', 'request-review', '--json', JSON.stringify(payload)],
      io,
      runtime,
    );
    return { code, text: out.join(''), stderr: err.join('') };
  };

  const jsonOf = <T>(invocation: Invocation): T => JSON.parse(invocation.text) as T;

  const reviewRequest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    assessmentId: ASSESSMENT_ID,
    projectId: PROJECT_ID,
    attemptId: ATTEMPT_ID,
    candidateHeadSha: '',
    policyRevision: POLICY_REVISION,
    reviewerModel: REVIEWER_MODEL,
    ...overrides,
  });

  async function setup(options: {
    repo?: { repoDir: string; base: string; head: string };
    withReviewer?: boolean;
    noInstallation?: boolean;
    candidateHeadSha?: string;
    attemptOverrides?: Partial<AttemptRecord>;
    reviewSpawn?: OcmReviewTransportSpawn;
  } = {}): Promise<{
    runtime: FleetCliRuntime;
    spawnCalls: SpawnCall[];
    repo: { repoDir: string; base: string; head: string };
  }> {
    const repo = options.repo ?? (await makeRepo());
    stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-review-state-'));
    const installation =
      options.noInstallation === true
        ? undefined
        : makeInstallation(repo.repoDir, options.withReviewer ?? true);
    const spawnCalls: SpawnCall[] = [];
    const reviewSpawn =
      options.reviewSpawn ??
      (async (file: string, args: readonly string[], env: Record<string, string>) => {
        spawnCalls.push({ file, args, env });
        return { exitCode: 0, stdout: PASS_FIXTURE, stderr: '' };
      });
    const runtime = createFleetCliRuntime({
      stateDir,
      ...(installation !== undefined ? { installation } : {}),
      reviewSpawn,
    });
    await runtime.execution.attemptRepository.saveAttempt(
      makeAttempt(repo.repoDir, repo.base, repo.head, options.attemptOverrides),
    );
    await runtime.evidence.evidenceAssessmentRepository.saveAssessment(
      makeAssessment(options.candidateHeadSha ?? repo.head),
    );
    return { runtime, spawnCalls, repo };
  }

  it('binds the reviewer transport and reviews through the recorded host', async () => {
    const { runtime, spawnCalls, repo } = await setup();
    const invocation = await cli(runtime, reviewRequest({ candidateHeadSha: repo.head }));

    expect(invocation.code).toBe(0);
    const result = jsonOf<{
      outcome: string;
      receipt: { readOnlyVerified: boolean; result: string };
    }>(invocation);
    expect(result.outcome).toBe('reviewed');
    expect(result.receipt.readOnlyVerified).toBe(true);
    expect(result.receipt.result).toBe('pass');

    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0];
    expect(call.args[call.args.indexOf('--dir') + 1]).toBe(repo.repoDir);
    expect(call.args[call.args.indexOf('--agent') + 1]).toBe('example-agent');
    expect(call.args[call.args.indexOf('-m') + 1]).toBe(REVIEWER_MODEL);
    expect(call.env.OCM_REMOTE_PORT).toBe('46000');
    expect(call.env.OCM_HOST).toBe('');
  });

  it('ignores the routing environment for a v2 recorded host', async () => {
    const savedHost = process.env.OCM_HOST;
    const savedPort = process.env.OCM_REMOTE_PORT;
    process.env.OCM_HOST = 'leak.example';
    process.env.OCM_REMOTE_PORT = '1';
    try {
      const { runtime, spawnCalls, repo } = await setup();
      const invocation = await cli(runtime, reviewRequest({ candidateHeadSha: repo.head }));

      expect(invocation.code).toBe(0);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].env.OCM_HOST).toBe('');
      expect(spawnCalls[0].env.OCM_REMOTE_PORT).toBe('46000');
    } finally {
      if (savedHost !== undefined) {
        process.env.OCM_HOST = savedHost;
      } else {
        delete process.env.OCM_HOST;
      }
      if (savedPort !== undefined) {
        process.env.OCM_REMOTE_PORT = savedPort;
      } else {
        delete process.env.OCM_REMOTE_PORT;
      }
    }
  });

  it('reports no independent review transport when the installation has no reviewer seat', async () => {
    const { runtime, spawnCalls, repo } = await setup({ withReviewer: false });
    const invocation = await cli(runtime, reviewRequest({ candidateHeadSha: repo.head }));

    expect(invocation.code).toBe(1);
    const result = jsonOf<{ outcome: string; reason: string }>(invocation);
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('No independent review transport is configured');
    expect(spawnCalls).toHaveLength(0);
  });

  it('refuses a reviewer model no seat serves before any transport runs', async () => {
    const { runtime, spawnCalls, repo } = await setup();
    const invocation = await cli(
      runtime,
      reviewRequest({ candidateHeadSha: repo.head, reviewerModel: 'example-provider/gpt-6-luna' }),
    );

    expect(invocation.code).toBe(1);
    const result = jsonOf<{ outcome: string; reason: string }>(invocation);
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toContain('No reviewer seat in the installation serves model');
    expect(spawnCalls).toHaveLength(0);
  });

  it('refuses a reviewer that shares the implementer model family', async () => {
    const { runtime, spawnCalls, repo } = await setup();
    const invocation = await cli(
      runtime,
      reviewRequest({
        candidateHeadSha: repo.head,
        reviewerModel: 'other-provider/glm-5.3-flash',
      }),
    );

    expect(invocation.code).toBe(1);
    const result = jsonOf<{ outcome: string; reason: string }>(invocation);
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toContain('share the same underlying model');
    expect(spawnCalls).toHaveLength(0);
  });

  it('refuses when the requested head moved from the worktree HEAD', async () => {
    const repo = await makeRepo();
    const { runtime, spawnCalls } = await setup({
      repo,
      candidateHeadSha: repo.base,
      attemptOverrides: {
        artifacts: {
          headCommit: repo.base,
          commitsSinceBase: [],
          collectedArtifactPaths: [],
          notes: 'missing',
        },
      },
    });
    const invocation = await cli(runtime, reviewRequest({ candidateHeadSha: repo.base }));

    expect(invocation.code).toBe(1);
    const result = jsonOf<{ outcome: string; reason: string }>(invocation);
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toContain('head mismatch before review');
    expect(spawnCalls).toHaveLength(0);
  });

  it('with no installation reports no independent review transport', async () => {
    const { runtime, spawnCalls, repo } = await setup({ noInstallation: true });
    const invocation = await cli(runtime, reviewRequest({ candidateHeadSha: repo.head }));

    expect(invocation.code).toBe(1);
    const result = jsonOf<{ outcome: string; reason: string }>(invocation);
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('No independent review transport is configured');
    expect(spawnCalls).toHaveLength(0);
  });
});
