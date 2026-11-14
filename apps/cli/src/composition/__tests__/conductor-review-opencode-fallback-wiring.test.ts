// D1C fix round 2 production-path wiring: the composed conductor's review
// request falls back to the opencode reviewer seat only when the installation
// carries an api reviewer seat (the adapter's api-route guard), and an
// opencode-only installation never falls back. The review use case is
// replaced (a real api transport would need host configuration); the seat
// derivation, the delegate wiring and the outcome mapping are the composed
// ones, through createFleetCliRuntime as every production path runs.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RequestIndependentReviewResult } from '@fleet/evidence-and-acceptance';
import type { FleetInstallation } from '@fleet/installation';
import { createFleetCliRuntime } from '../../composition.js';

const HEAD = 'a'.repeat(40);
const ATTEMPT_ID = 'attempt-example-1';
const PROJECT_ID = 'project-example-1';
const REQUEST_ID = 'review-01JB0000000000000000000002';
const POLICY = 'policy-example-1';
const IMPL = 'example-provider/glm-5.3';
const API_REVIEWER = 'example-provider/grok-4.7';
const OPENCODE_REVIEWER = 'example-provider/gpt-6-luna';

function makeReviewRequest(reviewerModel: string) {
  return {
    requestId: REQUEST_ID,
    kind: 'code-review' as const,
    attemptId: ATTEMPT_ID,
    projectId: PROJECT_ID,
    candidateHeadSha: HEAD,
    policyRevision: POLICY,
    implementerModel: IMPL,
    reviewerModel,
  };
}

function makeReceipt(reviewerModel: string): RequestIndependentReviewResult {
  return {
    outcome: 'reviewed',
    receipt: {
      id: 'rr-example-1',
      assessmentId: 'assessment-attempt-example-1',
      projectId: PROJECT_ID,
      attemptId: ATTEMPT_ID,
      candidateHeadSha: HEAD,
      reviewerModel,
      implementerModel: IMPL,
      readOnlyVerified: true,
      result: 'pass',
      findings: [
        {
          findingId: 'finding-example-1',
          severity: 'nit',
          summary: 'an example finding',
          filePath: null,
          line: null,
          state: 'unresolved',
          dispositionReason: 'no action',
          dispositionEvidenceRef: 'evidence://example/finding-1',
        },
      ],
      evidenceRef: 'evidence://example/review',
      policyRevision: POLICY,
      completedAtIso: '2026-11-14T00:00:00.000Z',
      kind: 'code-review',
      requestId: REQUEST_ID,
    },
  } as RequestIndependentReviewResult;
}

function installationWithApiSeat(): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {
      'this-machine': {
        transport: 'local',
        worktreeRoot: mkdtempSync(path.join(tmpdir(), 'fleet-cli-fallback-wt-')),
        roles: ['orchestrator'],
      },
    },
    tools: ['opencode', 'api'],
    seats: [
      { id: 'api-reviewer', tool: 'api', model: API_REVIEWER, roles: ['reviewer'], costClass: 'paid' },
      {
        id: 'opencode-reviewer',
        tool: 'opencode',
        model: OPENCODE_REVIEWER,
        roles: ['reviewer'],
        costClass: 'paid',
      },
    ],
    chains: {
      reviewer: [{ seatId: 'api-reviewer' }, { seatId: 'opencode-reviewer' }],
    },
    forge: { mode: 'none' },
  } as FleetInstallation;
}

function installationWithoutApiSeat(): FleetInstallation {
  const installation = installationWithApiSeat();
  return {
    ...installation,
    tools: ['opencode'],
    seats: installation.seats!.filter((seat) => seat.id !== 'api-reviewer'),
    chains: { reviewer: [{ seatId: 'opencode-reviewer' }] },
  } as FleetInstallation;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function trackDirs(installation: FleetInstallation): void {
  for (const host of Object.values(installation.hosts ?? {})) {
    if (host.worktreeRoot.startsWith(tmpdir())) {
      dirs.push(host.worktreeRoot);
    }
  }
}

describe('conductor review opencode fallback composition (D1C fix round 2)', () => {
  function compose(installation: FleetInstallation) {
    trackDirs(installation);
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-cli-fallback-state-'));
    dirs.push(stateDir);
    return createFleetCliRuntime({ stateDir, installation });
  }

  it('a seat-busy api review is retried once against the composed opencode fallback seat', async () => {
    const runtime = compose(installationWithApiSeat());
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(runtime.evidence.requestIndependentReview, 'requestIndependentReview').mockImplementation(
      async (request) => {
        calls.push({ ...request } as Record<string, unknown>);
        return calls.length === 1
          ? {
              outcome: 'rejected',
              reason: 'review seat busy',
              rejection: 'review-unavailable',
              code: 'seat-busy',
            }
          : makeReceipt(OPENCODE_REVIEWER);
      },
    );

    const result = await runtime.conductor.reviewRequest.requestReview(makeReviewRequest(API_REVIEWER));

    // The primary review ran against the api seat's model; the retry against
    // the opencode seat's model returned the receipt, mapped through.
    expect(calls).toHaveLength(2);
    expect(calls[0].reviewerModel).toBe(API_REVIEWER);
    expect(calls[1].reviewerModel).toBe(OPENCODE_REVIEWER);
    expect(result).toMatchObject({ outcome: 'receipt', receipt: { verdict: 'passed' } });
    if (result.outcome === 'receipt') {
      expect(result.receipt.reviewerModel).toBe(OPENCODE_REVIEWER);
    }
  });

  it('an opencode-only installation never falls back: a seat-busy review stays unavailable', async () => {
    const runtime = compose(installationWithoutApiSeat());
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(runtime.evidence.requestIndependentReview, 'requestIndependentReview').mockImplementation(
      async (request) => {
        calls.push({ ...request } as Record<string, unknown>);
        return {
          outcome: 'rejected',
          reason: 'review seat busy',
          rejection: 'review-unavailable',
          code: 'seat-busy',
        };
      },
    );

    const result = await runtime.conductor.reviewRequest.requestReview(makeReviewRequest(OPENCODE_REVIEWER));

    expect(result).toEqual({ outcome: 'no-receipt', reason: 'review-unavailable', detail: 'seat-busy' });
    expect(calls).toHaveLength(1);
  });
});
