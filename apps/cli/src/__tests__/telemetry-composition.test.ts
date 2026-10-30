// Telemetry composition wiring (OT2b): the CLI runtime exposes telemetry's own
// read-only receipt read, built on its own evidence store and inspect use case
// — never the evidence context's instances.
import { createHash, createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  EvidenceAssessmentRepositoryAdapter,
  type EvidenceAssessmentRecord,
  type ReviewReceiptRecord,
  type VerificationReceiptRecord,
} from '@fleet/evidence-and-acceptance';
import type { ResolvedTelemetryPolicy } from '@fleet/installation';
import { telemetrySaltFingerprint, type TelemetryHmac } from '@fleet/work-execution';

import { createFleetCliRuntime } from '../composition.js';
import { composeTelemetry } from '../composition/telemetry.js';

const EXAMPLE_ATTEMPT = 'example-attempt-a';
const EXAMPLE_HEAD = 'example-head-sha-1';
const EXAMPLE_ASSESSMENT_ID = 'assessment-example-attempt-a';
const STATE_FILE = 'assessments.json';

function makeVerificationReceipt(overrides: Partial<VerificationReceiptRecord> = {}): VerificationReceiptRecord {
  return {
    id: 'example-receipt-v-1',
    assessmentId: EXAMPLE_ASSESSMENT_ID,
    projectId: 'example-project',
    attemptId: EXAMPLE_ATTEMPT,
    candidateHeadSha: EXAMPLE_HEAD,
    hostId: 'example-host',
    procedureName: 'example-procedure',
    result: 'pass',
    exitCode: 0,
    evidenceRef: 'example-evidence-ref',
    policyRevision: 'example-policy-revision',
    completedAtIso: '2026-10-15T10:01:00.000Z',
    ...overrides,
  };
}

function makeReviewReceipt(overrides: Partial<ReviewReceiptRecord> = {}): ReviewReceiptRecord {
  return {
    id: 'example-receipt-r-1',
    assessmentId: EXAMPLE_ASSESSMENT_ID,
    projectId: 'example-project',
    attemptId: EXAMPLE_ATTEMPT,
    candidateHeadSha: EXAMPLE_HEAD,
    reviewerModel: 'example-reviewer-model',
    implementerModel: 'example-implementer-model',
    readOnlyVerified: true,
    result: 'pass',
    findings: [],
    evidenceRef: 'example-evidence-ref',
    policyRevision: 'example-policy-revision',
    completedAtIso: '2026-10-15T10:02:00.000Z',
    ...overrides,
  };
}

function makeAssessment(overrides: Partial<EvidenceAssessmentRecord> = {}): EvidenceAssessmentRecord {
  return {
    id: EXAMPLE_ASSESSMENT_ID,
    projectId: 'example-project',
    attemptId: EXAMPLE_ATTEMPT,
    candidateHeadSha: EXAMPLE_HEAD,
    policyRevision: 'example-policy-revision',
    implementerModel: 'example-implementer-model',
    requiredChecks: ['test'],
    state: 'pending',
    verificationReceipts: [makeVerificationReceipt()],
    reviewReceipts: [makeReviewReceipt()],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 1,
    updatedAtIso: '2026-10-15T10:00:00.000Z',
    ...overrides,
  };
}

async function entryOf(dir: string, name: string): Promise<[string, string]> {
  const full = path.join(dir, name);
  const stat = await fs.lstat(full);
  if (stat.isFile()) {
    const digest = createHash('sha256').update(await fs.readFile(full)).digest('hex');
    return [name, digest];
  }
  return [name + '/', 'dir'];
}

/** Every file under dir (recursive) with its sha256: the whole on-disk state. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const names = await fs.readdir(dir, { recursive: true });
  const entries = await Promise.all(names.map((name) => entryOf(dir, name)));
  return Object.fromEntries(entries.sort((a, b) => a[0].localeCompare(b[0])));
}

describe('telemetry receipt read composition', () => {
  it('exposes telemetry\u2019s own receipt read over the same state dir, leaving it untouched', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-telemetry-cli-'));
    try {
      const writer = new EvidenceAssessmentRepositoryAdapter({ stateDir: tempDir });
      await writer.saveAssessment(makeAssessment());

      const runtime = createFleetCliRuntime({ stateDir: tempDir });
      const before = await snapshot(tempDir);

      const result = await runtime.telemetry.acceptanceReceiptRead.readReceiptsForHead(
        EXAMPLE_ATTEMPT,
        EXAMPLE_HEAD,
      );

      expect(result.outcome).toBe('found');
      // Telemetry's read is its own object, never an evidence-context instance.
      expect(runtime.telemetry.acceptanceReceiptRead).not.toBe(runtime.evidence.inspectAcceptanceEvidence);
      for (const value of Object.values(runtime.evidence)) {
        expect(value).not.toBe(runtime.telemetry.acceptanceReceiptRead);
      }
      // The read never wrote a byte.
      expect(await snapshot(tempDir)).toEqual(before);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('reports unavailable on a corrupt assessments file and quarantines nothing', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-telemetry-cli-'));
    try {
      const runtime = createFleetCliRuntime({ stateDir: tempDir });
      await fs.writeFile(path.join(tempDir, STATE_FILE), '{broken CANARY-bytes', 'utf8');
      const corruptBefore = await snapshot(tempDir);

      const result = await runtime.telemetry.acceptanceReceiptRead.readReceiptsForHead(
        EXAMPLE_ATTEMPT,
        EXAMPLE_HEAD,
      );

      expect(result).toEqual({ outcome: 'unavailable', reason: 'evidence-unreadable' });
      expect(await snapshot(tempDir)).toEqual(corruptBefore);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('telemetry export composition (OT4b-1)', () => {
  const SALT = 'a'.repeat(64);
  const EXAMPLE_ENDPOINT = 'https://collector.example.test/v1/traces';

  function examplePolicy(overrides: Partial<ResolvedTelemetryPolicy> = {}): ResolvedTelemetryPolicy {
    return Object.freeze({
      enabled: false,
      projectName: 'fleet-lanes',
      route: 'collector',
      sampleRatio: 1,
      sendCost: true,
      includeDryRun: true,
      projectAliases: Object.freeze({}),
      salt: null,
      ...overrides,
    });
  }

  async function makeTokenFile(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-telemetry-token-'));
    const file = path.join(dir, 'token');
    await fs.writeFile(file, 'example-token', 'utf8');
    return file;
  }

  function hmacOf(salt: string): TelemetryHmac {
    return (message) =>
      new Uint8Array(
        createHmac('sha256', Buffer.from(salt, 'hex')).update(message, 'utf8').digest(),
      );
  }

  it('reports disabled, a no-op port and no export when the policy is off', () => {
    const composed = composeTelemetry({ policy: examplePolicy(), env: {} });
    expect(composed.telemetry.configured).toBe('disabled');
    expect(composed.telemetry.saltFingerprint).toBeNull();
    expect(composed.telemetry.exportTelemetry).toBeNull();
    expect(composed.telemetry.policy).toEqual(examplePolicy());
  });

  it('reports no-endpoint with a salt, a fingerprint and a usable dry-run export', async () => {
    const policy = examplePolicy({ enabled: true, salt: SALT });
    const composed = composeTelemetry({ policy, env: {} });
    expect(composed.telemetry.configured).toBe('no-endpoint');
    expect(composed.telemetry.exportTelemetry).not.toBeNull();
    expect(composed.telemetry.saltFingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(composed.telemetry.saltFingerprint).toBe(telemetrySaltFingerprint(hmacOf(SALT)));

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-telemetry-cli-'));
    try {
      const onDisk = composeTelemetry({ stateDir: tempDir, policy, env: {} });
      const before = await snapshot(tempDir);
      const result = await onDisk.telemetry.exportTelemetry!.execute({
        selection: {
          kind: 'window',
          sinceIso: '2026-01-01T00:00:00.000Z',
          untilIso: '2026-12-31T00:00:00.000Z',
        },
        policy: {
          route: policy.route,
          sampleRatio: policy.sampleRatio,
          sendCost: policy.sendCost,
          includeDryRun: policy.includeDryRun,
          projectAliases: policy.projectAliases,
        },
        mode: 'dry-run',
        deadline: null,
        retryRejected: false,
        nowIso: '2026-10-30T00:00:00.000Z',
      });
      expect(result.outcome).toBe('nothing-selected');
      expect(await snapshot(tempDir)).toEqual(before);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('requires https for a non-loopback endpoint', async () => {
    const tokenFile = await makeTokenFile();
    try {
      const policy = examplePolicy({ enabled: true, salt: SALT });
      const composed = composeTelemetry({
        policy,
        env: {
          FLEET_TELEMETRY_ENDPOINT: 'http://collector.example.test/v1/traces',
          FLEET_TELEMETRY_TOKEN_FILE: tokenFile,
        },
      });
      expect(composed.telemetry.configured).toBe('endpoint-needs-https');
    } finally {
      await fs.rm(path.dirname(tokenFile), { recursive: true, force: true }).catch(() => {});
    }
  });

  it('configures with the example https endpoint and a token file', async () => {
    const tokenFile = await makeTokenFile();
    try {
      const policy = examplePolicy({ enabled: true, salt: SALT });
      const composed = composeTelemetry({
        policy,
        env: {
          FLEET_TELEMETRY_ENDPOINT: EXAMPLE_ENDPOINT,
          FLEET_TELEMETRY_TOKEN_FILE: tokenFile,
        },
      });
      expect(composed.telemetry.configured).toBe('configured');
      expect(composed.telemetry.exportTelemetry).not.toBeNull();
      expect(composed.telemetry.saltFingerprint).toMatch(/^[0-9a-f]{8}$/);
    } finally {
      await fs.rm(path.dirname(tokenFile), { recursive: true, force: true }).catch(() => {});
    }
  });

  it('reports the factory reason for a missing token file', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-telemetry-cli-'));
    try {
      const policy = examplePolicy({ enabled: true, salt: SALT });
      const composed = composeTelemetry({
        policy,
        env: {
          FLEET_TELEMETRY_ENDPOINT: EXAMPLE_ENDPOINT,
          FLEET_TELEMETRY_TOKEN_FILE: path.join(tempDir, 'missing-token'),
        },
      });
      expect(composed.telemetry.configured).toBe('token-file-unreadable');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
