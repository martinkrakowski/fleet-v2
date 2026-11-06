// @generated use-case scaffold — refined for step 4.
/**
 * RequestIndependentReviewUseCase binds a read-only review of one exact head
 * to its evidence. The reviewer must be a different underlying model from the
 * implementer: changing the provider seat prefix is not independence.
 */

import type {
  EvidenceAssessmentRecord,
  ReceiptSubject,
  ReviewReceiptRecord,
} from '../../domain/evidence-records.js';
import {
  REVIEW_KINDS,
  REVIEW_REQUEST_ID_PATTERN,
  assessmentIdForChain,
  attemptIdForChain,
  isValidChainName,
  receiptSubjectOf,
} from '../../domain/evidence-records.js';
import { EvidenceAssessment } from '../../domain/entities/EvidenceAssessment.js';
import { AssessmentState } from '../../domain/value-objects/AssessmentState.vo.js';
import { ReviewReceipt, isSameModelFamily, underlyingModelFamily } from '../../domain/entities/ReviewReceipt.js';
import { scopeFindingIdsToReceipt } from './RecordReviewReceiptUseCase.use-case.js';
import { placeholderEvidenceRefusal, placeholderReviewReceiptField } from '../../domain/placeholder-evidence.js';
import {
  EvidenceAssessmentRevisionConflictError,
  type EvidenceAssessmentRepositoryPort,
} from '../ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import type { EvidenceArchivePort } from '../ports/out/EvidenceArchivePort.out-port.js';
import type { IndependentReviewPort, ReviewUnavailableCode } from '../ports/out/IndependentReviewPort.out-port.js';
import type { EvidenceSeatPolicyPort } from '../ports/out/EvidenceSeatPolicyPort.out-port.js';
import type {
  RequestIndependentReviewPort,
  RequestIndependentReviewRequest,
  RequestIndependentReviewResult,
  ReviewRejection,
} from '../ports/in/RequestIndependentReviewPort.in-port.js';

export interface RequestIndependentReviewDependencies {
  readonly repo: EvidenceAssessmentRepositoryPort;
  readonly reviewer: IndependentReviewPort;
  readonly archive: EvidenceArchivePort;
  readonly seatPolicy?: EvidenceSeatPolicyPort;
}

const NOT_IMPLEMENTED = 'Not implemented: RequestIndependentReviewUseCase';

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Reviewer independence is judged on the underlying model, not the seat. */
function sharesUnderlyingModel(implementerModel: string, reviewerModel: string): boolean {
  return (
    implementerModel === reviewerModel ||
    isSameModelFamily(
      underlyingModelFamily(implementerModel),
      underlyingModelFamily(reviewerModel),
    )
  );
}

/** A rejection that carries the typed code only for conductor requests (those with a requestId). */
function rejectedFor(
  request: RequestIndependentReviewRequest,
  rejection: ReviewRejection,
  reason: string,
  code?: ReviewUnavailableCode | 'not-read-only' | 'invalid-receipt',
): RequestIndependentReviewResult {
  return request.requestId !== undefined
    ? { outcome: 'rejected', reason, rejection, ...(code !== undefined ? { code } : {}) }
    : { outcome: 'rejected', reason };
}

/**
 * KF-33b2: the deterministic receipt id of a manual review (no requestId).
 * When an existing receipt already carries it — a second manual review on the
 * same head — the id is suffixed with the receipt count, before the finding
 * ids are scoped to it, so two receipts never share one id.
 */
function manualReceiptIdOf(
  assessmentId: string,
  candidateHeadSha: string,
  existing: { readonly reviewReceipts: readonly { readonly id: string }[] },
): string {
  const base = 'rr-' + assessmentId + '-' + candidateHeadSha.slice(0, 8);
  return existing.reviewReceipts.some((receipt) => receipt.id === base)
    ? base + '-' + existing.reviewReceipts.length
    : base;
}

const HEAD_PATTERN = /^[0-9a-f]{40}$/;

function ownValue(source: unknown, key: string): unknown {
  try {
    if (typeof source !== 'object' || source === null) {
      return undefined;
    }
    return Object.getOwnPropertyDescriptor(source, key)?.value;
  } catch {
    return undefined;
  }
}

function nowIsoOf(request: RequestIndependentReviewRequest): string {
  return isNonEmptyTrimmedString(request.nowIso) ? request.nowIso : new Date().toISOString();
}

/**
 * The chain subject of a request: `undefined` when the request carries no
 * subject or names its own attempt (the attempt path), `'invalid'` for a brief,
 * an unknown kind, or a chain subject that does not match the request's own
 * ids (project, pseudo attempt id, assessment id, head), is not a pre-merge
 * review, or has no well-formed request id. Read through own properties only.
 */
function chainSubjectOf(request: RequestIndependentReviewRequest): ReceiptSubject | 'invalid' | undefined {
  const raw = ownValue(request, 'subject');
  if (raw === undefined) {
    return undefined;
  }
  const subject = receiptSubjectOf({
    subject: raw,
    projectId: ownValue(request, 'projectId'),
    attemptId: ownValue(request, 'attemptId'),
  });
  if (subject === null) {
    return 'invalid';
  }
  if (subject.kind === 'attempt') {
    return subject.projectId === request.projectId && subject.attemptId === request.attemptId ? undefined : 'invalid';
  }
  if (
    subject.kind !== 'chain' ||
    subject.chainName === null ||
    subject.integrationHeadSha === null ||
    !isValidChainName(subject.chainName)
  ) {
    return 'invalid';
  }
  if (
    subject.attemptId !== null || subject.briefPackageDigest !== null || subject.baseCommit !== null ||
    !HEAD_PATTERN.test(subject.integrationHeadSha) ||
    subject.projectId !== request.projectId ||
    subject.integrationHeadSha !== request.candidateHeadSha ||
    request.attemptId !== attemptIdForChain(subject.projectId, subject.chainName) ||
    request.assessmentId !== assessmentIdForChain(subject.projectId, subject.chainName) ||
    request.kind !== 'pre-merge' ||
    typeof request.requestId !== 'string' ||
    !REVIEW_REQUEST_ID_PATTERN.test(request.requestId)
  ) {
    return 'invalid';
  }
  return subject;
}

/** True when a stored receipt is the combined review of exactly this chain at this head. */
function isChainReceiptOf(receipt: ReviewReceiptRecord, chain: ReceiptSubject): boolean {
  const stored = receiptSubjectOf(receipt);
  return (
    stored !== null &&
    stored.kind === 'chain' &&
    stored.projectId === chain.projectId &&
    stored.chainName === chain.chainName &&
    stored.integrationHeadSha === chain.integrationHeadSha
  );
}

/** Read or create the chain-scoped assessment: one pending record per (project, chain) at the integration head. */
async function openChainAssessment(
  deps: RequestIndependentReviewDependencies,
  request: RequestIndependentReviewRequest,
  nowIso: string,
): Promise<EvidenceAssessmentRecord | null> {
  const record: EvidenceAssessmentRecord = {
    id: request.assessmentId,
    projectId: request.projectId,
    attemptId: request.attemptId,
    candidateHeadSha: request.candidateHeadSha,
    policyRevision: request.policyRevision,
    implementerModel: request.implementerModel,
    requiredChecks: [],
    state: 'pending',
    verificationReceipts: [],
    reviewReceipts: [],
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 1,
    updatedAtIso: nowIso,
  };
  try {
    await deps.repo.saveAssessment(record);
  } catch (error) {
    if (!(error instanceof EvidenceAssessmentRevisionConflictError)) {
      throw error;
    }
    // A concurrent opener won: its record is the one to read.
    return deps.repo.findAssessmentById(request.assessmentId);
  }
  return record;
}

type Step<T> = { readonly result: RequestIndependentReviewResult } | { readonly value: T };

type CompletedReview = Extract<Awaited<ReturnType<IndependentReviewPort['runIndependentReview']>>, { outcome: 'completed' }>;

/**
 * The request-shape refusals, in their order: non-empty fields, a known kind with
 * a well-formed requestId, the brief text of a brief-check, and a distinct
 * underlying reviewer model. Null when the request is well-formed.
 */
function requestShapeRefusal(request: RequestIndependentReviewRequest): RequestIndependentReviewResult | null {
  if (
    !isNonEmptyTrimmedString(request.assessmentId) ||
    !isNonEmptyTrimmedString(request.projectId) ||
    !isNonEmptyTrimmedString(request.attemptId) ||
    !isNonEmptyTrimmedString(request.candidateHeadSha) ||
    !isNonEmptyTrimmedString(request.policyRevision) ||
    !isNonEmptyTrimmedString(request.implementerModel) ||
    !isNonEmptyTrimmedString(request.reviewerModel)
  ) {
    return rejectedFor(
      request,
      'invalid-request',
      'Independent review requires non-empty assessmentId, projectId, attemptId, candidateHeadSha, policyRevision, implementerModel and reviewerModel',
    );
  }
  if (
    (request.kind !== undefined && !REVIEW_KINDS.includes(request.kind)) ||
    (request.requestId !== undefined &&
      (typeof request.requestId !== 'string' || !REVIEW_REQUEST_ID_PATTERN.test(request.requestId))) ||
    (request.requestId !== undefined && request.kind === undefined)
  ) {
    return rejectedFor(
      request,
      'invalid-request',
      'Independent review requires a known kind and a well-formed requestId together',
    );
  }
  // A brief-check review answers against the frozen brief; without the brief
  // text it must never reach a reviewer or become evidence (SEC-4).
  if (request.kind === 'brief-check' && !isNonEmptyTrimmedString(request.briefText)) {
    return rejectedFor(request, 'invalid-request', 'A brief-check review requires the brief text');
  }
  if (sharesUnderlyingModel(request.implementerModel, request.reviewerModel)) {
    return rejectedFor(
      request,
      'not-independent',
      `Independent review requires a distinct underlying model: ${request.reviewerModel} and ${request.implementerModel} share the same underlying model`,
    );
  }
  return null;
}

/** The identity and seat checks of an existing assessment against the request, in their order. */
function assessmentIdentityRefusal(
  existing: EvidenceAssessmentRecord,
  request: RequestIndependentReviewRequest,
): RequestIndependentReviewResult | null {
  if (
    existing.projectId !== request.projectId ||
    existing.attemptId !== request.attemptId ||
    existing.policyRevision !== request.policyRevision
  ) {
    return rejectedFor(
      request,
      'assessment-mismatch',
      'Assessment identity mismatch (projectId, attemptId, or policyRevision does not match existing assessment)',
    );
  }
  if (existing.implementerModel !== request.implementerModel) {
    return rejectedFor(
      request,
      'assessment-mismatch',
      `Assessment '${existing.id}' was implemented on seat '${existing.implementerModel}', not '${request.implementerModel}'`,
    );
  }
  return null;
}

function noAssessmentRejection(request: RequestIndependentReviewRequest): RequestIndependentReviewResult {
  return rejectedFor(
    request,
    'no-assessment',
    `No assessment exists for assessmentId '${request.assessmentId}'`,
  );
}

/** True when a stored receipt with the request's id was recorded for a different review. */
function isRequestIdReused(
  found: ReviewReceiptRecord,
  request: RequestIndependentReviewRequest,
  chain: ReceiptSubject | undefined,
): boolean {
  return (
    found.reviewerModel.trim() !== request.reviewerModel.trim() ||
    found.kind !== request.kind ||
    found.candidateHeadSha !== request.candidateHeadSha ||
    (chain !== undefined && !isChainReceiptOf(found, chain))
  );
}

/**
 * A replayed request id never runs a second review (§3.5): the recorded receipt answers when reviewer,
 * kind and head match and the assessment still matches the request. Replay runs before the seat policy —
 * a stored receipt needs no new seat — and before the head and identity checks so a reused id always gets
 * its typed code. Any other reuse (a different head included) is request-id-reused. Only a request carrying
 * a requestId reads the assessment here; a new review checks the seat policy first (FS3b).
 */
async function replayStep(
  deps: RequestIndependentReviewDependencies,
  request: RequestIndependentReviewRequest,
  chain: ReceiptSubject | undefined,
): Promise<Step<EvidenceAssessmentRecord | null>> {
  if (request.requestId === undefined) {
    return { value: null };
  }
  let existing = await deps.repo.findAssessmentById(request.assessmentId);
  if (existing === null && chain !== undefined) {
    existing = await openChainAssessment(deps, request, nowIsoOf(request));
  }
  if (existing === null) {
    return { result: noAssessmentRejection(request) };
  }
  const found = existing.reviewReceipts.find((receipt) => receipt.requestId === request.requestId);
  if (found === undefined) {
    return { value: existing };
  }
  if (isRequestIdReused(found, request, chain)) {
    return {
      result: rejectedFor(
        request,
        'request-id-reused',
        'Review request id ' + request.requestId + ' was already used for another review',
      ),
    };
  }
  const mismatch = assessmentIdentityRefusal(existing, request);
  if (mismatch !== null) {
    return { result: mismatch };
  }
  return { result: { outcome: 'reviewed', receipt: found } };
}

/** The seat policy, the assessment read, and the head, identity and terminal-state checks, in their order. */
async function loadReviewableAssessment(
  deps: RequestIndependentReviewDependencies,
  request: RequestIndependentReviewRequest,
  replayed: EvidenceAssessmentRecord | null,
): Promise<Step<EvidenceAssessmentRecord>> {
  if (deps.seatPolicy) {
    const check = await deps.seatPolicy.checkReviewerSeat({ reviewerModel: request.reviewerModel });
    if (check.outcome === 'refused') {
      return { result: rejectedFor(request, 'seat-refused', check.reason) };
    }
  }
  const existing = replayed ?? (await deps.repo.findAssessmentById(request.assessmentId));
  if (existing === null) {
    return { result: noAssessmentRejection(request) };
  }
  if (existing.candidateHeadSha !== request.candidateHeadSha) {
    return {
      result: rejectedFor(
        request,
        'assessment-mismatch',
        `Assessment '${request.assessmentId}' exists for candidate head '${existing.candidateHeadSha}', not '${request.candidateHeadSha}'`,
      ),
    };
  }
  const mismatch = assessmentIdentityRefusal(existing, request);
  if (mismatch !== null) {
    return { result: mismatch };
  }
  if (AssessmentState.create(existing.state).value?.isTerminal()) {
    return {
      result: rejectedFor(
        request,
        'assessment-terminal',
        `Assessment '${existing.id}' is in terminal state '${existing.state}'`,
      ),
    };
  }
  return { value: existing };
}

/** An unavailable review: the requested reviewer is recorded on the assessment, a lost revision race is tolerated. */
async function unavailableRejection(
  deps: RequestIndependentReviewDependencies,
  request: RequestIndependentReviewRequest,
  existing: EvidenceAssessmentRecord,
  run: { readonly reason: string; readonly code: ReviewUnavailableCode },
  nowIso: string,
): Promise<RequestIndependentReviewResult> {
  try {
    await deps.repo.saveAssessment({
      ...existing,
      requestedReviewerModel: request.reviewerModel.trim(),
      revision: existing.revision + 1,
      updatedAtIso: nowIso,
    });
  } catch (error) {
    if (error instanceof EvidenceAssessmentRevisionConflictError) {
      return rejectedFor(request, 'review-unavailable', run.reason, run.code);
    }
    throw error;
  }
  return rejectedFor(request, 'review-unavailable', run.reason, run.code);
}

/** The receipt record a completed review would store; findings are stored unresolved. */
function receiptCandidateOf(
  request: RequestIndependentReviewRequest,
  run: CompletedReview,
  evidenceRef: string,
  chain: ReceiptSubject | undefined,
  existing: EvidenceAssessmentRecord,
): ReviewReceiptRecord {
  const kindFields: Partial<ReviewReceiptRecord> =
    request.kind !== undefined ? { kind: request.kind } : {};
  const requestIdFields: Partial<ReviewReceiptRecord> =
    request.requestId !== undefined ? { requestId: request.requestId } : {};
  const subjectFields: Partial<ReviewReceiptRecord> = chain !== undefined ? { subject: chain } : {};
  // RV2: the fixed cause code of an unknown answer travels onto the stored
  // receipt; the key is omitted on pass/fail so stored receipts stay identical.
  const unknownReasonFields: Partial<ReviewReceiptRecord> =
    run.result === 'unknown' && run.unknownReason !== undefined
      ? { unknownReason: run.unknownReason }
      : {};
  const receiptId =
    request.requestId !== undefined
      ? 'rr-' + request.assessmentId + '-' + request.candidateHeadSha.slice(0, 8) + '-' + request.requestId
      : manualReceiptIdOf(request.assessmentId, request.candidateHeadSha, existing);
  return {
    id: receiptId,
    assessmentId: request.assessmentId,
    projectId: request.projectId,
    attemptId: request.attemptId,
    candidateHeadSha: request.candidateHeadSha,
    reviewerModel: request.reviewerModel,
    implementerModel: request.implementerModel,
    readOnlyVerified: run.readOnlyVerified,
    result: run.result,
    // A reviewer-reported state is not a disposition: findings are stored
    // unresolved, and only RecordFindingDispositionUseCase resolves them.
    findings: scopeFindingIdsToReceipt(
      receiptId,
      run.findings.map((finding) => ({
        ...finding,
        state: 'unresolved' as const,
        dispositionReason: null,
        dispositionEvidenceRef: null,
      })),
    ),
    evidenceRef,
    policyRevision: request.policyRevision,
    completedAtIso: run.completedAtIso,
    ...kindFields,
    ...requestIdFields,
    ...subjectFields,
    ...unknownReasonFields,
  };
}

/** Validate a candidate receipt: the placeholder check, then the entity's own invariants. */
function validatedReceipt(
  request: RequestIndependentReviewRequest,
  candidate: ReviewReceiptRecord,
): Step<ReviewReceiptRecord> {
  // New writes only (plan §3.1, D1): stored receipts are not re-checked on load.
  const placeholderField = placeholderReviewReceiptField(candidate);
  if (placeholderField !== null) {
    return {
      result: rejectedFor(
        request,
        'invalid-receipt',
        placeholderEvidenceRefusal('Independent review receipt', placeholderField),
        'invalid-receipt',
      ),
    };
  }
  const validated = ReviewReceipt.create(candidate);
  if (!validated.success || validated.value === undefined) {
    return {
      result: rejectedFor(
        request,
        'invalid-receipt',
        validated.error?.message ?? 'Independent review produced an invalid receipt',
        'invalid-receipt',
      ),
    };
  }
  return { value: validated.value.toRecord() };
}

/** Append the receipt to the assessment, re-collect its blockers and save it. */
async function appendAndSaveReceipt(
  deps: RequestIndependentReviewDependencies,
  request: RequestIndependentReviewRequest,
  existing: EvidenceAssessmentRecord,
  receipt: ReviewReceiptRecord,
  nowIso: string,
): Promise<RequestIndependentReviewResult> {
  const assessment = EvidenceAssessment.fromRecord({
    ...existing,
    requestedReviewerModel: request.reviewerModel.trim(),
  });
  // KF-33b2: a duplicate receipt id is refused (never appended); the
  // message text is a fixed template over stored ids, never reviewer text.
  try {
    assessment.appendReviewReceipt(receipt, nowIso);
  } catch (error) {
    return rejectedFor(
      request,
      'invalid-receipt',
      error instanceof Error ? error.message : 'The review receipt could not be appended',
      'invalid-receipt',
    );
  }
  const merged = assessment.toRecord();
  const blockers = EvidenceAssessment.fromRecord(merged).collectBlockers();
  const updated: EvidenceAssessmentRecord = {
    ...merged,
    state: blockers.length > 0 ? 'blocked' : 'pending',
    blockers: [...blockers],
  };
  await deps.repo.saveAssessment(updated);
  return { outcome: 'reviewed', receipt };
}

export class RequestIndependentReviewUseCase implements RequestIndependentReviewPort {
  constructor(private readonly deps?: RequestIndependentReviewDependencies) {}

  /** Generic entry point kept for callers that hold an untyped use case. */
  async execute(input: unknown): Promise<RequestIndependentReviewResult> {
    return this.run(input as RequestIndependentReviewRequest | undefined);
  }

  async requestIndependentReview(
    request: RequestIndependentReviewRequest,
  ): Promise<RequestIndependentReviewResult> {
    return this.run(request);
  }

  private async run(request?: RequestIndependentReviewRequest): Promise<RequestIndependentReviewResult> {
    try {
      return await this.runChecked(request);
    } catch (error) {
      // Only a chain request turns an unexpected failure into the typed rejection; the attempt path
      // and the unconfigured/missing-request refusals keep throwing exactly as before.
      const isRefusal = error instanceof Error && error.message === NOT_IMPLEMENTED;
      if (!isRefusal && this.deps !== undefined && typeof request === 'object' && request !== null) {
        const chain = chainSubjectOf(request);
        if (chain !== undefined && chain !== 'invalid') {
          return rejectedFor(request, 'review-unavailable', 'The chain review could not be completed');
        }
      }
      throw error;
    }
  }

  private async runChecked(request?: RequestIndependentReviewRequest): Promise<RequestIndependentReviewResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error(NOT_IMPLEMENTED);
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a rejection.
    if (typeof request !== 'object' || request === null) {
      throw new Error(NOT_IMPLEMENTED);
    }
    const deps = this.deps;

    // A chain subject takes the combined pre-merge path; any other explicit
    // subject (a brief, or an attempt that is not the request's own) is refused.
    // An absent subject is the attempt path, unchanged.
    const chain = chainSubjectOf(request);
    if (chain === 'invalid') {
      return rejectedFor(request, 'invalid-request', 'The review subject is not valid for this request');
    }
    const shapeRefusal = requestShapeRefusal(request);
    if (shapeRefusal !== null) {
      return shapeRefusal;
    }

    const replay = await replayStep(deps, request, chain);
    if ('result' in replay) {
      return replay.result;
    }
    const loaded = await loadReviewableAssessment(deps, request, replay.value);
    if ('result' in loaded) {
      return loaded.result;
    }
    const existing = loaded.value;

    const nowIso = nowIsoOf(request);
    const run = await deps.reviewer.runIndependentReview({
      attemptId: request.attemptId,
      candidateHeadSha: request.candidateHeadSha,
      implementerModel: request.implementerModel,
      reviewerModel: request.reviewerModel,
      diffSummary: request.diffSummary,
      // Conductor fields flow through only when defined, so a manual request's
      // transport call carries exactly the five fields it carried before.
      ...(request.kind !== undefined ? { kind: request.kind } : {}),
      ...(request.briefText !== undefined ? { briefText: request.briefText } : {}),
    });
    if (run.outcome === 'unavailable') {
      return unavailableRejection(deps, request, existing, run, nowIso);
    }
    if (!run.readOnlyVerified) {
      return rejectedFor(
        request,
        'not-read-only',
        'Independent review was not verified read-only, so it is not evidence',
        'not-read-only',
      );
    }

    const archived = await deps.archive.archiveEvidence({
      artifactId: `review-${request.assessmentId}-${request.candidateHeadSha}`,
      candidateHeadSha: request.candidateHeadSha,
      content: run.rawOutput,
    });
    const candidate = receiptCandidateOf(request, run, archived.evidenceRef, chain, existing);
    const validated = validatedReceipt(request, candidate);
    if ('result' in validated) {
      return validated.result;
    }
    return appendAndSaveReceipt(deps, request, existing, validated.value, nowIso);
  }
}
