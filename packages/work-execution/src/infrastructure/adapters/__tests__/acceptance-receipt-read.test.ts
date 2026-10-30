import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import type {
  EvidenceAssessmentRecord,
  InspectAcceptanceEvidenceRequest,
  InspectAcceptanceEvidenceResult,
  ReviewFindingRecord,
  ReviewReceiptRecord,
  VerificationReceiptRecord,
} from '@fleet/evidence-and-acceptance';
import {
  EvidenceAssessmentRepositoryAdapter,
  InspectAcceptanceEvidenceUseCase,
  StateFileUnreadableReadOnlyError,
} from '@fleet/evidence-and-acceptance';

import { AcceptanceReceiptReadAdapter } from '../AcceptanceReceiptReadAdapter.adapter.js';

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

function makeReviewFinding(overrides: Partial<ReviewFindingRecord> = {}): ReviewFindingRecord {
  return {
    findingId: 'example-finding-1',
    severity: 'major',
    summary: 'example-summary',
    filePath: 'example/file.ts',
    line: 7,
    state: 'unresolved',
    dispositionReason: null,
    dispositionEvidenceRef: null,
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

/** Records every request; answers come from a script (default: not-found). */
class RecordingInspector {
  readonly requests: InspectAcceptanceEvidenceRequest[] = [];

  constructor(private readonly script: Array<InspectAcceptanceEvidenceResult | Error> = []) {}

  async inspectAcceptanceEvidence(request: InspectAcceptanceEvidenceRequest): Promise<InspectAcceptanceEvidenceResult> {
    this.requests.push(request);
    const next = this.script.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next ?? { outcome: 'not-found', query: '' };
  }
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

describe('AcceptanceReceiptReadAdapter', () => {
  it('finds by assessmentIdForAttempt and projects both lists with exactly the projection keys', async () => {
    const assessment = makeAssessment({
      verificationReceipts: [makeVerificationReceipt({ id: 'example-receipt-v-2' })],
      reviewReceipts: [makeReviewReceipt({ id: 'example-receipt-r-2', findings: [makeReviewFinding()] })],
    });
    const inspector = new RecordingInspector([{ outcome: 'found', assessment }]);
    const adapter = new AcceptanceReceiptReadAdapter({ inspector });

    const result = await adapter.readReceiptsForHead(EXAMPLE_ATTEMPT, EXAMPLE_HEAD);

    expect(result).toMatchObject({ outcome: 'found' });
    if (result.outcome !== 'found') {
      throw new Error('expected found');
    }
    expect(result.verification).toHaveLength(1);
    expect(result.review).toHaveLength(1);

    const decoded = JSON.parse(JSON.stringify(result).replaceAll('{}', '"marker"')) as {
      verification: Array<Record<string, unknown>>;
      review: Array<Record<string, unknown>>;
    };
    expect(Object.keys(decoded.verification[0]).sort()).toEqual(['completedAtIso', 'exitCode', 'receiptId', 'result']);
    expect(Object.keys(decoded.review[0]).sort()).toEqual(['completedAtIso', 'findings', 'kind', 'receiptId', 'result']);
    expect(Object.keys(decoded.review[0].findings as object).sort()).toEqual(['blocker', 'major', 'minor', 'nit']);
  });

  it('tries the legacy attempt id second and the head alone third, in order', async () => {
    const assessment = makeAssessment();
    const inspector = new RecordingInspector([
      { outcome: 'not-found', query: '' },
      { outcome: 'not-found', query: '' },
      { outcome: 'found', assessment },
    ]);
    const adapter = new AcceptanceReceiptReadAdapter({ inspector });

    const result = await adapter.readReceiptsForHead(EXAMPLE_ATTEMPT, EXAMPLE_HEAD);

    expect(result).toMatchObject({ outcome: 'found' });
    expect(inspector.requests).toEqual([
      { assessmentId: EXAMPLE_ASSESSMENT_ID, candidateHeadSha: EXAMPLE_HEAD },
      { assessmentId: EXAMPLE_ATTEMPT, candidateHeadSha: EXAMPLE_HEAD },
      { candidateHeadSha: EXAMPLE_HEAD },
    ]);
  });

  it('returns none when the head is shared by another attempt or the attempt is at another head', async () => {
    const otherAttempt = makeAssessment({ attemptId: 'example-attempt-b' });
    const adapterOtherAttempt = new AcceptanceReceiptReadAdapter({
      inspector: new RecordingInspector([{ outcome: 'found', assessment: otherAttempt }]),
    });
    expect(await adapterOtherAttempt.readReceiptsForHead(EXAMPLE_ATTEMPT, EXAMPLE_HEAD)).toEqual({ outcome: 'none' });

    const otherHead = makeAssessment({ candidateHeadSha: 'example-head-sha-2' });
    const adapterOtherHead = new AcceptanceReceiptReadAdapter({
      inspector: new RecordingInspector([{ outcome: 'found', assessment: otherHead }]),
    });
    expect(await adapterOtherHead.readReceiptsForHead(EXAMPLE_ATTEMPT, EXAMPLE_HEAD)).toEqual({ outcome: 'none' });
  });

  it('never lets record fields cross the port (canaries)', async () => {
    const assessment = makeAssessment({
      projectId: 'CANARY-projectId',
      policyRevision: 'CANARY-policyRevision',
      implementerModel: 'CANARY-implementerModel',
      verificationReceipts: [
        makeVerificationReceipt({
          hostId: 'CANARY-hostId',
          procedureName: 'CANARY-procedureName',
          evidenceRef: 'CANARY-evidenceRef',
          policyRevision: 'CANARY-policyRevision',
        }),
      ],
      reviewReceipts: [
        makeReviewReceipt({
          reviewerModel: 'CANARY-reviewerModel',
          implementerModel: 'CANARY-implementerModel',
          evidenceRef: 'CANARY-evidenceRef',
          policyRevision: 'CANARY-policyRevision',
          findings: [
            makeReviewFinding({
              summary: 'CANARY-summary',
              filePath: 'CANARY-filePath',
              dispositionReason: 'CANARY-dispositionReason',
              dispositionEvidenceRef: 'CANARY-dispositionEvidenceRef',
            }),
          ],
        }),
      ],
    });
    const adapter = new AcceptanceReceiptReadAdapter({
      inspector: new RecordingInspector([{ outcome: 'found', assessment }]),
    });

    const result = await adapter.readReceiptsForHead(EXAMPLE_ATTEMPT, EXAMPLE_HEAD);

    expect(result.outcome).toBe('found');
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });

  it('skips receipts whose id is not a valid hash input and keeps the others', async () => {
    const assessment = makeAssessment({
      verificationReceipts: [
        makeVerificationReceipt({ id: '' }),
        makeVerificationReceipt({ id: 'example-receipt-v-keep', exitCode: 7, completedAtIso: '2026-10-16T00:00:00.000Z' }),
      ],
      reviewReceipts: [
        makeReviewReceipt({ id: '' }),
        makeReviewReceipt({ id: 'example-receipt-r-keep', completedAtIso: '2026-10-16T01:00:00.000Z' }),
      ],
    });
    const adapter = new AcceptanceReceiptReadAdapter({
      inspector: new RecordingInspector([{ outcome: 'found', assessment }]),
    });

    const result = await adapter.readReceiptsForHead(EXAMPLE_ATTEMPT, EXAMPLE_HEAD);

    if (result.outcome !== 'found') {
      throw new Error('expected found');
    }
    expect(result.verification).toEqual([
      {
        receiptId: expect.any(Object),
        result: 'pass',
        exitCode: 7,
        completedAtIso: '2026-10-16T00:00:00.000Z',
      },
    ]);
    expect(result.review).toEqual([
      {
        receiptId: expect.any(Object),
        kind: 'code-review',
        result: 'pass',
        findings: { blocker: 0, major: 0, minor: 0, nit: 0 },
        completedAtIso: '2026-10-16T01:00:00.000Z',
      },
    ]);
  });

  it('normalises out-of-range values: exitCode, result, kind and finding counts', async () => {
    const assessment = makeAssessment({
      verificationReceipts: [
        makeVerificationReceipt({
          id: 'example-receipt-v-range',
          result: 'not-a-result' as never,
          exitCode: 300,
        }),
      ],
      reviewReceipts: [
        makeReviewReceipt({
          id: 'example-receipt-r-range',
          result: 'still-not-a-result' as never,
          findings: [
            makeReviewFinding({ severity: 'blocker' }),
            makeReviewFinding({ severity: 'major' }),
            makeReviewFinding({ severity: 'major' }),
            makeReviewFinding({ severity: 'minor' }),
            makeReviewFinding({ severity: 'nit' }),
            makeReviewFinding({ severity: 'mystery' as never }),
          ],
        }),
      ],
    });
    const adapter = new AcceptanceReceiptReadAdapter({
      inspector: new RecordingInspector([{ outcome: 'found', assessment }]),
    });

    const result = await adapter.readReceiptsForHead(EXAMPLE_ATTEMPT, EXAMPLE_HEAD);

    if (result.outcome !== 'found') {
      throw new Error('expected found');
    }
    expect(result.verification[0]).toEqual({
      receiptId: expect.any(Object),
      result: 'unknown',
      exitCode: null,
      completedAtIso: '2026-10-15T10:01:00.000Z',
    });
    expect(result.review[0]).toEqual({
      receiptId: expect.any(Object),
      kind: 'code-review',
      result: 'unknown',
      findings: { blocker: 1, major: 2, minor: 1, nit: 1 },
      completedAtIso: '2026-10-15T10:02:00.000Z',
    });
  });

  it('returns unavailable when the inspector throws, including a read-only store error', async () => {
    const plainErrorAdapter = new AcceptanceReceiptReadAdapter({
      inspector: new RecordingInspector([new Error('boom')]),
    });
    expect(await plainErrorAdapter.readReceiptsForHead(EXAMPLE_ATTEMPT, EXAMPLE_HEAD)).toEqual({
      outcome: 'unavailable',
      reason: 'evidence-unreadable',
    });

    const readOnlyError = new StateFileUnreadableReadOnlyError('assessments.json', 'not valid JSON');
    const readOnlyErrorAdapter = new AcceptanceReceiptReadAdapter({
      inspector: new RecordingInspector([readOnlyError]),
    });
    expect(await readOnlyErrorAdapter.readReceiptsForHead(EXAMPLE_ATTEMPT, EXAMPLE_HEAD)).toEqual({
      outcome: 'unavailable',
      reason: 'evidence-unreadable',
    });
  });

  it('reads through a read-only store and never writes or quarantines', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-receipt-read-test-'));
    try {
      const writer = new EvidenceAssessmentRepositoryAdapter({ stateDir: tempDir });
      await writer.saveAssessment(makeAssessment());
      const before = await snapshot(tempDir);

      const readOnlyRepo = new EvidenceAssessmentRepositoryAdapter({ stateDir: tempDir, readOnly: true });
      const useCase = new InspectAcceptanceEvidenceUseCase({ repo: readOnlyRepo });
      const adapter = new AcceptanceReceiptReadAdapter({ inspector: useCase });

      const result = await adapter.readReceiptsForHead(EXAMPLE_ATTEMPT, EXAMPLE_HEAD);

      expect(result).toMatchObject({ outcome: 'found' });
      if (result.outcome !== 'found') {
        throw new Error('expected found');
      }
      expect(result.verification).toHaveLength(1);
      expect(result.review).toHaveLength(1);
      expect(await snapshot(tempDir)).toEqual(before);

      await fs.writeFile(path.join(tempDir, STATE_FILE), '{broken CANARY-bytes', 'utf8');
      const corruptBefore = await snapshot(tempDir);
      expect(await adapter.readReceiptsForHead(EXAMPLE_ATTEMPT, EXAMPLE_HEAD)).toEqual({
        outcome: 'unavailable',
        reason: 'evidence-unreadable',
      });
      expect(await snapshot(tempDir)).toEqual(corruptBefore);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('returns none for empty or non-string attemptId/headSha without calling the inspector', async () => {
    const inspector = new RecordingInspector();
    const adapter = new AcceptanceReceiptReadAdapter({ inspector });

    expect(await adapter.readReceiptsForHead('', EXAMPLE_HEAD)).toEqual({ outcome: 'none' });
    expect(await adapter.readReceiptsForHead(EXAMPLE_ATTEMPT, '')).toEqual({ outcome: 'none' });
    expect(await adapter.readReceiptsForHead(42 as never, EXAMPLE_HEAD)).toEqual({ outcome: 'none' });
    expect(await adapter.readReceiptsForHead(EXAMPLE_ATTEMPT, null as never)).toEqual({ outcome: 'none' });
    expect(inspector.requests).toEqual([]);
  });

  it('throws the unconfigured error without an inspector', async () => {
    const adapter = new AcceptanceReceiptReadAdapter();

    await expect(adapter.readReceiptsForHead(EXAMPLE_ATTEMPT, EXAMPLE_HEAD)).rejects.toThrow(
      'Not implemented: AcceptanceReceiptReadAdapter.readReceiptsForHead',
    );
  });
});
