/**
 * `evidence request-review` never takes the implementer model from the
 * operator. Independence is a fact about the lane, so the CLI reads the seat
 * the attempt was actually dispatched on and refuses a request that names a
 * different one. These tests drive the real CLI against a real state
 * directory with a recorded attempt; no runner or review transport runs, so
 * every refusal here is the boundary's own.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AttemptRecord } from '@fleet/work-execution';
import { nextAttemptRevision } from '@fleet/work-execution';
import type { EvidenceAssessmentRecord } from '@fleet/evidence-and-acceptance';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';

const ATTEMPT_ID = 'attempt-seat-1';
const UNKNOWN_ATTEMPT_ID = 'attempt-never-dispatched';
const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const SEAT_MODEL = 'nvidia/z-ai/glm-5.3';
const PROJECT_ID = 'proj-seat-1';
const POLICY_REVISION = 'policy-1';

interface Invocation {
  readonly code: number;
  readonly text: string;
  readonly stderr: string;
}

describe('evidence request-review implementer seat binding', () => {
  let stateDir: string;
  let runtime: FleetCliRuntime;

  const cli = async (payload: unknown): Promise<Invocation> => {
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
    assessmentId: `assessment-${ATTEMPT_ID}`,
    projectId: PROJECT_ID,
    attemptId: ATTEMPT_ID,
    candidateHeadSha: HEAD_SHA,
    policyRevision: POLICY_REVISION,
    reviewerModel: 'openrouter/anthropic/claude-sonnet-4.5',
    ...overrides,
  });

  const seatlessAttempt = (): AttemptRecord => ({
    id: ATTEMPT_ID,
    workOrderId: 'wo-seat-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/nonexistent/lanes/attempt-seat-1',
    baseCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    state: 'collected',
    outcome: 'done',
    briefDigest: 'digest-1',
    briefPackagePath: null,
    sessionId: 'session-1',
    completionReceipt: null,
    artifacts: {
      headCommit: HEAD_SHA,
      commitsSinceBase: [],
      collectedArtifactPaths: [],
      notes: 'missing',
    },
    runner: { kind: 'opencode', remotePort: 4166, host: null, agent: null, model: SEAT_MODEL, variant: null },
    createdAtIso: '2026-10-16T08:00:00.000Z',
    updatedAtIso: '2026-10-16T08:30:00.000Z',
  });

  beforeEach(async () => {
    stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-seat-'));
    runtime = createFleetCliRuntime({ stateDir });
    await runtime.execution.attemptRepository.saveAttempt(seatlessAttempt());
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('binds the implementer model to the attempt seat without being told one', async () => {
    const invocation = await cli(reviewRequest());

    // No `implementerModel` was supplied: the request reached the evidence
    // use case, which refuses it for its own reasons (no assessment exists
    // yet), never for a missing implementer model.
    expect(invocation.code).toBe(1);
    const result = jsonOf<{ outcome: string; reason: string }>(invocation);
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toContain(`No assessment exists for assessmentId`);
  });

  it('accepts a supplied implementerModel that restates the recorded seat', async () => {
    const invocation = await cli(reviewRequest({ implementerModel: SEAT_MODEL }));

    expect(invocation.code).toBe(1);
    expect(jsonOf<{ reason: string }>(invocation).reason).toContain(
      `No assessment exists for assessmentId`,
    );
  });

  it('refuses a supplied implementerModel that differs from the recorded seat', async () => {
    const invocation = await cli(
      reviewRequest({ implementerModel: 'opencode/longcat-2.5-preview-free' }),
    );

    expect(invocation.code).toBe(2);
    expect(invocation.stderr).toContain('refuses implementerModel');
    expect(invocation.stderr).toContain(`was dispatched on seat '${SEAT_MODEL}'`);
    expect(invocation.text).toBe('');
  });

  it('refuses a reviewer on the recorded seat reached through another provider', async () => {
    // No implementerModel at all: the seat bound to the attempt decides, and
    // a different provider prefix on the same underlying model is refused.
    const invocation = await cli(reviewRequest({ reviewerModel: 'openrouter/z-ai/glm-5.3' }));

    expect(invocation.code).toBe(1);
    const result = jsonOf<{ outcome: string; reason: string }>(invocation);
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toContain('share the same underlying model');
    expect(result.reason).toContain(SEAT_MODEL);
  });

  it('refuses an attempt that records no implementer seat', async () => {
    const stored = await runtime.execution.attemptRepository.findAttemptById(ATTEMPT_ID);
    await runtime.execution.attemptRepository.saveAttempt({
      ...stored!,
      runner: null,
      revision: nextAttemptRevision(stored!),
    });

    const invocation = await cli(reviewRequest());

    expect(invocation.code).toBe(1);
    const result = jsonOf<{ outcome: string; reason: string }>(invocation);
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe(
      `Attempt ${ATTEMPT_ID} records no implementer seat: neither the dispatched runner model nor the frozen brief manifest's model assignment is known`,
    );
  });

  it('refuses an attempt that was never dispatched', async () => {
    const invocation = await cli(reviewRequest({ attemptId: UNKNOWN_ATTEMPT_ID }));

    expect(invocation.code).toBe(1);
    const result = jsonOf<{ outcome: string; reason: string }>(invocation);
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe(`Attempt not found: '${UNKNOWN_ATTEMPT_ID}'`);
  });

  it('forwards kind and requestId so a conductor review replays instead of reviewing twice', async () => {
    const requestId = 'review-01JB0000000000000000000001';
    const assessmentId = `assessment-${ATTEMPT_ID}`;
    const receipt = {
      id: `rr-${assessmentId}-${HEAD_SHA.slice(0, 8)}-${requestId}`,
      assessmentId,
      projectId: PROJECT_ID,
      attemptId: ATTEMPT_ID,
      candidateHeadSha: HEAD_SHA,
      reviewerModel: 'openrouter/anthropic/claude-sonnet-4.5',
      implementerModel: SEAT_MODEL,
      readOnlyVerified: true,
      result: 'pass' as const,
      findings: [],
      evidenceRef: 'ref-1',
      policyRevision: POLICY_REVISION,
      completedAtIso: '2026-10-28T12:00:00.000Z',
      kind: 'code-review' as const,
      requestId,
    };
    const assessment: EvidenceAssessmentRecord = {
      id: assessmentId,
      projectId: PROJECT_ID,
      attemptId: ATTEMPT_ID,
      candidateHeadSha: HEAD_SHA,
      policyRevision: POLICY_REVISION,
      implementerModel: SEAT_MODEL,
      requiredChecks: [],
      state: 'pending',
      verificationReceipts: [],
      reviewReceipts: [receipt],
      findingDispositions: [],
      acceptanceReceiptId: null,
      blockers: [],
      revision: 0,
      updatedAtIso: '2026-10-28T12:00:00.000Z',
    };
    await runtime.evidence.evidenceAssessmentRepository.saveAssessment(assessment);

    // The payload carries kind + requestId; the CLI must forward them so the
    // recorded receipt answers instead of a second review being attempted.
    const invocation = await cli(reviewRequest({ kind: 'code-review', requestId }));

    expect(invocation.code).toBe(0);
    const result = jsonOf<{ outcome: string; receipt: { id: string } }>(invocation);
    expect(result.outcome).toBe('reviewed');
    expect(result.receipt.id).toBe(receipt.id);
  });
});
