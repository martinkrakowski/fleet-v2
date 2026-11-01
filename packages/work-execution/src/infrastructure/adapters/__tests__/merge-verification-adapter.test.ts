// MergeVerificationAdapter: the evidence procedure at head (DT8). One test
// per rule: identity, not head-only; exact-head passing receipt verifies;
// other-head, stale-policy and failing receipts are unknown; absent procedure
// where required is unknown; budget exhaustion never starts a call; delegate
// failure is unknown, not a throw. Fake delegates only — no subprocess, no
// live host.

import { describe, expect, it } from 'vitest';

import type {
  EvidenceAssessmentRecord,
  InspectAcceptanceEvidenceRequest,
  InspectAcceptanceEvidenceResult,
  RequestVerificationRequest,
  RequestVerificationResult,
  VerificationReceiptRecord,
} from '@fleet/evidence-and-acceptance';
import { assessmentIdForAttempt } from '@fleet/evidence-and-acceptance';

import { MergeVerificationAdapter } from '../MergeVerificationAdapter.adapter.js';
import type {
  MergeVerificationReadRequest,
  MergeVerificationTriggerRequest,
} from '../../../application/ports/out/MergeVerificationPort.out-port.js';

const ATTEMPT = 'attempt-dt8';
const ASSESSMENT_ID = assessmentIdForAttempt(ATTEMPT);
const PROJECT = 'project-dt8';
const HEAD = '1111111111111111111111111111111111111111';
const OTHER_HEAD = '2222222222222222222222222222222222222222';
const POLICY = 'policy-rev-1';
const MACOS_PROCEDURE = 'macosProcedure';
const HOST = 'host-dt8';
const IMPLEMENTER_MODEL = 'openrouter/z-ai/glm-5.3-flash';

function futureDeadline(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

function exhaustedDeadline(): string {
  return new Date(Date.now() + 400).toISOString();
}

function makeVerificationReceipt(overrides: Partial<VerificationReceiptRecord> = {}): VerificationReceiptRecord {
  return {
    id: 'receipt-v-1',
    assessmentId: ASSESSMENT_ID,
    projectId: PROJECT,
    attemptId: ATTEMPT,
    candidateHeadSha: HEAD,
    hostId: HOST,
    procedureName: MACOS_PROCEDURE,
    result: 'pass',
    exitCode: 0,
    evidenceRef: 'evidence://verification-attempt-dt8-macosProcedure',
    policyRevision: POLICY,
    completedAtIso: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeAssessment(overrides: Partial<EvidenceAssessmentRecord> = {}): EvidenceAssessmentRecord {
  return {
    id: ASSESSMENT_ID,
    projectId: PROJECT,
    attemptId: ATTEMPT,
    candidateHeadSha: HEAD,
    policyRevision: POLICY,
    implementerModel: IMPLEMENTER_MODEL,
    requiredChecks: [MACOS_PROCEDURE],
    state: 'pending',
    verificationReceipts: [makeVerificationReceipt()],
    reviewReceipts: [],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 1,
    updatedAtIso: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function readRequest(overrides: Partial<MergeVerificationReadRequest> = {}): MergeVerificationReadRequest {
  return {
    repoDigest: 'aaaaaaaaaaaa',
    headOid: HEAD,
    macosProcedure: MACOS_PROCEDURE,
    policyRevision: POLICY,
    projectId: PROJECT,
    attemptId: ATTEMPT,
    deadlineIso: futureDeadline(),
    ...overrides,
  };
}

function triggerRequest(overrides: Partial<MergeVerificationTriggerRequest> = {}): MergeVerificationTriggerRequest {
  return {
    ...readRequest(),
    hostId: HOST,
    implementerModel: IMPLEMENTER_MODEL,
    requiredChecks: [MACOS_PROCEDURE],
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

/** Records every request; answers come from a script (default: rejected). */
class RecordingRequester {
  readonly calls: RequestVerificationRequest[] = [];

  constructor(private readonly script: Array<RequestVerificationResult | Error> = []) {}

  async requestVerification(request: RequestVerificationRequest): Promise<RequestVerificationResult> {
    this.calls.push(request);
    const next = this.script.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next ?? { outcome: 'rejected', reason: 'unconfigured stub' };
  }
}

describe('MergeVerificationAdapter', () => {
  it('verifies an exact-head passing receipt and inspects by the attempt-derived assessment id', async () => {
    const receipt = makeVerificationReceipt();
    const assessment = makeAssessment({ verificationReceipts: [receipt] });
    const inspector = new RecordingInspector([{ outcome: 'found', assessment }]);
    const adapter = new MergeVerificationAdapter({ inspector });

    const result = await adapter.readVerification(readRequest());

    expect(result).toEqual({
      outcome: 'verified',
      receiptHeadOid: HEAD,
      receiptId: receipt.id,
      verifiedBy: 'procedure',
    });
    expect(inspector.requests).toEqual([{ assessmentId: ASSESSMENT_ID, candidateHeadSha: HEAD }]);
  });

  it('returns other-head-receipt for a matching receipt at a different candidate head', async () => {
    const assessment = makeAssessment({
      verificationReceipts: [makeVerificationReceipt({ candidateHeadSha: OTHER_HEAD })],
    });
    const adapter = new MergeVerificationAdapter({
      inspector: new RecordingInspector([{ outcome: 'found', assessment }]),
    });

    expect(await adapter.readVerification(readRequest())).toEqual({
      outcome: 'unknown',
      reasonCode: 'other-head-receipt',
    });
  });

  it('returns no-receipt when inspection finds nothing and when no receipt matches the required procedure', async () => {
    const missingAdapter = new MergeVerificationAdapter({
      inspector: new RecordingInspector([{ outcome: 'not-found', query: ASSESSMENT_ID }]),
    });
    expect(await missingAdapter.readVerification(readRequest())).toEqual({
      outcome: 'unknown',
      reasonCode: 'no-receipt',
    });

    const otherProcedure = makeAssessment({
      verificationReceipts: [makeVerificationReceipt({ procedureName: 'other-procedure' })],
    });
    const otherProcedureAdapter = new MergeVerificationAdapter({
      inspector: new RecordingInspector([{ outcome: 'found', assessment: otherProcedure }]),
    });
    expect(await otherProcedureAdapter.readVerification(readRequest())).toEqual({
      outcome: 'unknown',
      reasonCode: 'no-receipt',
    });
  });

  it('returns receipt-failed for a stale-policy receipt, never a pass', async () => {
    const assessment = makeAssessment({
      verificationReceipts: [makeVerificationReceipt({ policyRevision: 'policy-rev-old' })],
    });
    const adapter = new MergeVerificationAdapter({
      inspector: new RecordingInspector([{ outcome: 'found', assessment }]),
    });

    expect(await adapter.readVerification(readRequest())).toEqual({
      outcome: 'unknown',
      reasonCode: 'receipt-failed',
    });
  });

  it('returns receipt-failed for a failing receipt at the exact head and matching policy', async () => {
    const assessment = makeAssessment({
      verificationReceipts: [makeVerificationReceipt({ result: 'fail', exitCode: 1 })],
    });
    const adapter = new MergeVerificationAdapter({
      inspector: new RecordingInspector([{ outcome: 'found', assessment }]),
    });

    expect(await adapter.readVerification(readRequest())).toEqual({
      outcome: 'unknown',
      reasonCode: 'receipt-failed',
    });
  });

  it('returns evidence-unreadable for a wrong assessment id, attempt or project on a same-head receipt', async () => {
    const wrongId = makeAssessment({ id: 'assessment-other-attempt' });
    const wrongAttemptIdAdapter = new MergeVerificationAdapter({
      inspector: new RecordingInspector([{ outcome: 'found', assessment: wrongId }]),
    });
    expect(await wrongAttemptIdAdapter.readVerification(readRequest())).toEqual({
      outcome: 'unknown',
      reasonCode: 'evidence-unreadable',
    });

    const wrongAttempt = makeAssessment({
      attemptId: 'attempt-other',
      verificationReceipts: [makeVerificationReceipt({ attemptId: 'attempt-other' })],
    });
    const wrongAttemptAdapter = new MergeVerificationAdapter({
      inspector: new RecordingInspector([{ outcome: 'found', assessment: wrongAttempt }]),
    });
    expect(await wrongAttemptAdapter.readVerification(readRequest())).toEqual({
      outcome: 'unknown',
      reasonCode: 'evidence-unreadable',
    });

    const wrongProject = makeAssessment({
      projectId: 'project-other',
      verificationReceipts: [makeVerificationReceipt({ projectId: 'project-other' })],
    });
    const wrongProjectAdapter = new MergeVerificationAdapter({
      inspector: new RecordingInspector([{ outcome: 'found', assessment: wrongProject }]),
    });
    expect(await wrongProjectAdapter.readVerification(readRequest())).toEqual({
      outcome: 'unknown',
      reasonCode: 'evidence-unreadable',
    });
  });

  it('returns budget-exhausted and records zero calls when under 2 seconds remain', async () => {
    const inspector = new RecordingInspector();
    const readAdapter = new MergeVerificationAdapter({ inspector });
    expect(await readAdapter.readVerification(readRequest({ deadlineIso: exhaustedDeadline() }))).toEqual({
      outcome: 'unknown',
      reasonCode: 'budget-exhausted',
    });
    expect(inspector.requests).toEqual([]);

    const requester = new RecordingRequester();
    const triggerAdapter = new MergeVerificationAdapter({ requester });
    expect(await triggerAdapter.runVerification(triggerRequest({ deadlineIso: exhaustedDeadline() }))).toEqual({
      outcome: 'unknown',
      reasonCode: 'budget-exhausted',
    });
    expect(requester.calls).toEqual([]);
  });

  it('maps an inspection or request throw to evidence-unreadable, and an unconfigured delegate still throws', async () => {
    const throwingReadAdapter = new MergeVerificationAdapter({
      inspector: new RecordingInspector([new Error('boom')]),
    });
    expect(await throwingReadAdapter.readVerification(readRequest())).toEqual({
      outcome: 'unknown',
      reasonCode: 'evidence-unreadable',
    });

    const throwingTriggerAdapter = new MergeVerificationAdapter({
      requester: new RecordingRequester([new Error('boom')]),
    });
    expect(await throwingTriggerAdapter.runVerification(triggerRequest())).toEqual({
      outcome: 'unknown',
      reasonCode: 'evidence-unreadable',
    });

    const unconfigured = new MergeVerificationAdapter();
    await expect(unconfigured.readVerification(readRequest())).rejects.toThrow(
      'Not implemented: MergeVerificationAdapter.readVerification',
    );
    await expect(unconfigured.runVerification(triggerRequest())).rejects.toThrow(
      'Not implemented: MergeVerificationAdapter.runVerification',
    );
  });

  it('trigger path forwards every required field and maps a rejection to evidence-unreadable, never the free-form reason', async () => {
    const requester = new RecordingRequester([{ outcome: 'rejected', reason: 'refused: host unreachable' }]);
    const adapter = new MergeVerificationAdapter({ requester });

    const result = await adapter.runVerification(triggerRequest());

    expect(result).toEqual({ outcome: 'unknown', reasonCode: 'evidence-unreadable' });
    expect(requester.calls).toEqual([
      {
        assessmentId: ASSESSMENT_ID,
        projectId: PROJECT,
        attemptId: ATTEMPT,
        candidateHeadSha: HEAD,
        policyRevision: POLICY,
        hostId: HOST,
        implementerModel: IMPLEMENTER_MODEL,
        requiredChecks: [MACOS_PROCEDURE],
        deadlineIso: expect.any(String),
      },
    ]);
  });

  it('trigger path verifies the completed request assessment like the read path', async () => {
    const assessment = makeAssessment();
    const requester = new RecordingRequester([
      { outcome: 'completed', assessment, receipts: assessment.verificationReceipts },
    ]);
    const adapter = new MergeVerificationAdapter({ requester });

    const result = await adapter.runVerification(triggerRequest());

    expect(result).toEqual({
      outcome: 'verified',
      receiptHeadOid: HEAD,
      receiptId: 'receipt-v-1',
      verifiedBy: 'procedure',
    });
  });

  it('returns no-attempt-identity for an empty attempt id without calling any delegate', async () => {
    const inspector = new RecordingInspector();
    const requester = new RecordingRequester();
    const adapter = new MergeVerificationAdapter({ inspector, requester });

    expect(await adapter.readVerification(readRequest({ attemptId: '' }))).toEqual({
      outcome: 'unknown',
      reasonCode: 'no-attempt-identity',
    });
    expect(await adapter.runVerification(triggerRequest({ attemptId: '' }))).toEqual({
      outcome: 'unknown',
      reasonCode: 'no-attempt-identity',
    });
    expect(inspector.requests).toEqual([]);
    expect(requester.calls).toEqual([]);
  });
});
