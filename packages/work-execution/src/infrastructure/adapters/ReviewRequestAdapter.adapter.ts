// Implemented adapter — conductor review & CI station (cross-context step).
/**
 * ReviewRequestAdapter implements ReviewRequestPort by in-process delegation to
 * evidence-and-acceptance request/review and inspection use cases. It owns
 * every mapping; the composition root only binds the delegates. Unlike the
 * acceptance adapters it never throws: every failure is a typed result with a
 * reason code, and no transport or forge text reaches the caller.
 */

import {
  type EvidenceAssessmentRecord,
  type EvidenceArchivePort,
  type EvidenceResultValue,
  type FindingDispositionRecord,
  type InspectAcceptanceEvidencePort,
  type InspectAcceptanceEvidenceResult,
  REVIEW_KINDS,
  REVIEW_REQUEST_ID_PATTERN,
  REVIEW_UNAVAILABLE_CODES,
  REVIEW_UNKNOWN_REASONS,
  type RecordFindingDispositionPort,
  type RequestIndependentReviewPort,
  type RequestIndependentReviewRequest,
  type ReviewKind,
  type ReviewReceiptRecord,
  type ReviewRejection,
  type ReviewTransportDiagnostic,
  type ReviewUnavailableCode,
  type ReviewUnknownReason,
  assessmentIdForAttempt,
  assessmentIdForChain,
  attemptIdForChain,
  receiptSubjectOf,
} from '@fleet/evidence-and-acceptance';
import type {
  FindLatestReceiptOfKindRequest,
  FindLatestReceiptOfKindResult,
  FindReviewReceiptRequest,
  FindReviewReceiptResult,
  RecordOutOfScopeRequest,
  RecordOutOfScopeResult,
  ReviewRequest,
  ReviewRequestPort,
  ReviewRequestResult,
  ReviewReceiptOfKind,
  ReviewReceiptSummary,
  ReviewVerdict,
} from '../../application/ports/out/ReviewRequestPort.out-port.js';
import { parseChainName } from '../../domain/chain-records.js';
import { LANE_RUN_JOURNAL_REASON_CODE_PATTERN } from '../../domain/lane-run-journal.js';
import { screenTransportText } from '../../domain/review-transport-screen.js';

/**
 * D1C: the API-transport unavailable codes of an `review-unavailable`
 * rejection that justify one bounded re-request against the configured
 * opencode fallback reviewer seat. Every other unavailable or refusal code
 * is surfaced unchanged.
 */
const API_TRANSPORT_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'transport',
  'transport-failed',
  'seat-busy',
  'timeout',
]);

/** The only codes that may reach a run-journal `detail`: the evidence context's unavailable codes plus the two post-run rejections. */
const REVIEW_DETAIL_CODES: ReadonlySet<string> = new Set([...REVIEW_UNAVAILABLE_CODES, 'not-read-only', 'invalid-receipt']);
/** The fixed cause codes of an unknown review answer; only these travel onto a summary. */
const REVIEW_UNKNOWN_REASON_CODES: ReadonlySet<string> = new Set(REVIEW_UNKNOWN_REASONS);

const HEAD_PATTERN = /^[0-9a-f]{40}$/;
const REVIEW_KIND_VALUES: readonly string[] = REVIEW_KINDS;
const BRIEF_TEXT_MAX_BYTES = 64 * 1024;
const DIFF_SUMMARY_MAX_BYTES = 2048;

/** A chain subject, validated: the only subject kind besides the attempt that this adapter serves. */
interface ChainSubject {
  readonly projectId: string;
  readonly chainName: string;
  readonly integrationHeadSha: string;
}

type SubjectRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'chain'; readonly chain: ChainSubject }
  | { readonly kind: 'brief' }
  | { readonly kind: 'invalid' };

/** A data property of `value`; a getter is never invoked. */
function ownValue(value: unknown, key: string): unknown {
  try {
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return undefined;
  }
}

/**
 * An own property of `value`: undefined when there is none, its data value when
 * it is a data property, `unreadable` for an accessor or a failing descriptor
 * read. A getter is never invoked.
 */
function ownProperty(value: unknown, key: string): { readonly value: unknown } | 'unreadable' | undefined {
  try {
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      return undefined;
    }
    return 'value' in descriptor ? { value: descriptor.value } : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/**
 * The request's subject, read through own properties. An explicit attempt
 * subject must restate the request's own attempt, project and head; it then
 * reads as `absent` (the attempt path). `invalid` is a malformed subject or one
 * that disagrees with the request.
 */
function readSubject(request: { readonly projectId?: unknown; readonly attemptId?: unknown; readonly candidateHeadSha?: unknown }): SubjectRead {
  const subjectProperty = ownProperty(request, 'subject');
  if (subjectProperty === 'unreadable') {
    // Present but not a plain data property (an accessor, a hostile object): never "absent".
    return { kind: 'invalid' };
  }
  const subject = subjectProperty === undefined ? undefined : subjectProperty.value;
  if (subject === undefined) {
    return { kind: 'absent' };
  }
  const kind = ownValue(subject, 'kind');
  const projectId = ownValue(subject, 'projectId');
  if (typeof projectId !== 'string' || !isNonEmptyTrimmed(projectId)) {
    return { kind: 'invalid' };
  }
  // A find request carries no project id; only a request that names one must agree with the subject.
  const requestProjectId = ownValue(request, 'projectId');
  const sameProject = requestProjectId === undefined || requestProjectId === projectId;
  if (kind === 'attempt') {
    return sameProject &&
      ownValue(subject, 'attemptId') === ownValue(request, 'attemptId') &&
      ownValue(subject, 'headSha') === ownValue(request, 'candidateHeadSha')
      ? { kind: 'absent' }
      : { kind: 'invalid' };
  }
  if (kind === 'brief') {
    return { kind: 'brief' };
  }
  if (kind !== 'chain') {
    return { kind: 'invalid' };
  }
  const chainName = parseChainName(ownValue(subject, 'chainName'));
  const integrationHeadSha = ownValue(subject, 'integrationHeadSha');
  if (chainName === undefined || typeof integrationHeadSha !== 'string' || !HEAD_PATTERN.test(integrationHeadSha)) {
    return { kind: 'invalid' };
  }
  if (!sameProject || integrationHeadSha !== ownValue(request, 'candidateHeadSha')) {
    return { kind: 'invalid' };
  }
  return { kind: 'chain', chain: { projectId, chainName, integrationHeadSha } };
}

/** The evidence context's stored subject of a chain receipt, as this adapter sends it. */
function evidenceChainSubject(chain: ChainSubject) {
  return {
    kind: 'chain' as const,
    projectId: chain.projectId,
    attemptId: null,
    chainName: chain.chainName,
    integrationHeadSha: chain.integrationHeadSha,
    briefPackageDigest: null,
    baseCommit: null,
  };
}

/** True when a stored receipt is the combined pre-merge review of exactly this chain at this head. */
function isChainReceiptOf(receipt: ReviewReceiptRecord, chain: ChainSubject): boolean {
  const stored = receiptSubjectOf(receipt);
  return (
    receipt.kind === 'pre-merge' &&
    receipt.candidateHeadSha === chain.integrationHeadSha &&
    stored !== null &&
    stored.kind === 'chain' &&
    stored.projectId === chain.projectId &&
    stored.chainName === chain.chainName &&
    stored.integrationHeadSha === chain.integrationHeadSha
  );
}

/** The fixed out-of-scope reason (KF-33b2): never reviewer text. */
const OUT_OF_SCOPE_REASON = 'not a file this lane changed (conductor scope rule)';

export interface ReviewRequestDelegates {
  readonly requestIndependentReview?: RequestIndependentReviewPort['requestIndependentReview'];
  readonly inspectAcceptanceEvidence?: InspectAcceptanceEvidencePort['inspectAcceptanceEvidence'];
  /** KF-33b2: the evidence context's disposition recorder, one id per call. */
  readonly recordFindingDisposition?: RecordFindingDispositionPort['recordFindingDisposition'];
  /**
   * RV4: archive a screened transport diagnostic under `review-transport-<requestId>`
   * when a rejected review carried one. Optional: absent skips the archive and the
   * typed outcome is returned unchanged; an archive failure is swallowed.
   */
  readonly archiveEvidence?: EvidenceArchivePort['archiveEvidence'];
  /**
   * D1C: the model of the optional opencode fallback reviewer seat. When set
   * (a non-blank string distinct from the request's primary reviewer model),
   * a review rejected as `review-unavailable` with an API-transport code is
   * re-requested once against this seat; absent or equal to the primary
   * model, no fallback runs.
   */
  readonly opencodeFallbackReviewerModel?: string;
  /**
   * D1C fix round 1: the model of the primary reviewer seat served by the
   * `api` transport. The unavailable codes that trigger the fallback
   * (`transport`, `transport-failed`, `seat-busy`, `timeout`) are generic —
   * the opencode transport emits the same ones — so the retry must verify
   * the rejected request actually went through the api route: it runs only
   * when the request's primary reviewer model matches this one. Absent or
   * mismatched, no fallback runs.
   */
  readonly primaryApiReviewerModel?: string;
}

function isNonEmptyTrimmed(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function isReviewKind(value: unknown): boolean {
  return typeof value === 'string' && REVIEW_KIND_VALUES.includes(value);
}

/**
 * Snapshot of the named optional own data fields, read once. An accessor (or a
 * failing descriptor read) makes the whole snapshot null: a hostile request is
 * an invalid request, and no getter ever runs.
 */
function snapshotOptionalFields(request: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const read = ownProperty(request, key);
    if (read === 'unreadable') {
      return null;
    }
    if (read !== undefined) {
      out[key] = read.value;
    }
  }
  return out;
}

/** True when `value` is a non-empty dense array whose every index holds a non-blank string (holes are checked by index; `every` skips them). */
function isDenseNonEmptyStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !isNonEmptyTrimmed(value[index])) {
      return false;
    }
  }
  return true;
}

/** True for a plain object (prototype Object.prototype or null). */
function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A brief longer than 64 KiB is a refusal, never a truncated forward. */
function briefTextByteLength(briefText: string): number {
  return Buffer.byteLength(briefText, 'utf8');
}

/**
 * True when `request` is a plain object whose named fields are the expected
 * strings: every check is guarded (a null, a non-object, a wrong-typed field,
 * a sparse array, a throwing getter), so validation never throws. The
 * patterns are tested only on verified strings — `.test` never coerces.
 */
function requestFieldsAreValid(
  request: unknown,
  fields: readonly { readonly key: string; readonly kind: 'requestId' | 'head' | 'nonEmpty' | 'reviewKind' }[],
): boolean {
  try {
    if (typeof request !== 'object' || request === null || Array.isArray(request)) {
      return false;
    }
    for (const field of fields) {
      const value = Object.getOwnPropertyDescriptor(request, field.key)?.value;
      if (field.kind === 'requestId') {
        if (typeof value !== 'string' || !REVIEW_REQUEST_ID_PATTERN.test(value)) {
          return false;
        }
      } else if (field.kind === 'head') {
        if (typeof value !== 'string' || !HEAD_PATTERN.test(value)) {
          return false;
        }
      } else if (field.kind === 'reviewKind') {
        if (!isReviewKind(value)) {
          return false;
        }
      } else if (!isNonEmptyTrimmed(value)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function isValidReviewRequest(request: ReviewRequest): boolean {
  return requestFieldsAreValid(request, [
    { key: 'requestId', kind: 'requestId' },
    { key: 'kind', kind: 'reviewKind' },
    { key: 'attemptId', kind: 'nonEmpty' },
    { key: 'projectId', kind: 'nonEmpty' },
    { key: 'policyRevision', kind: 'nonEmpty' },
    { key: 'implementerModel', kind: 'nonEmpty' },
    { key: 'reviewerModel', kind: 'nonEmpty' },
    { key: 'candidateHeadSha', kind: 'head' },
  ]);
}

function isValidFindReceiptRequest(request: FindReviewReceiptRequest): boolean {
  return requestFieldsAreValid(request, [
    { key: 'requestId', kind: 'requestId' },
    { key: 'attemptId', kind: 'nonEmpty' },
    { key: 'candidateHeadSha', kind: 'head' },
  ]);
}

function isValidFindLatestReceiptOfKindRequest(request: FindLatestReceiptOfKindRequest): boolean {
  return requestFieldsAreValid(request, [
    { key: 'attemptId', kind: 'nonEmpty' },
    { key: 'kind', kind: 'reviewKind' },
    { key: 'candidateHeadSha', kind: 'head' },
  ]);
}

function mapVerdict(result: EvidenceResultValue): ReviewVerdict {
  if (result === 'pass') {
    return 'passed';
  }
  if (result === 'fail') {
    return 'failed';
  }
  return 'unknown';
}

/**
 * True when `findings` is a dense array of plain objects whose every finding
 * carries one of the four declared severities: a sparse array, a non-array, a
 * hole or a corrupt severity is invalid transport output, never a summary
 * (RV3: a corrupt severity never maps to a verdict).
 */
function findingsAreDense(findings: unknown): boolean {
  try {
    if (!Array.isArray(findings)) {
      return false;
    }
    for (let index = 0; index < findings.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(findings, index)) {
        return false;
      }
      const finding = findings[index];
      if (!isPlainObject(finding)) {
        return false;
      }
      const severity = (finding as { severity?: unknown }).severity;
      if (
        severity !== 'blocker' &&
        severity !== 'major' &&
        severity !== 'minor' &&
        severity !== 'nit'
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * One shared summary builder used by requestReview and findReviewReceipt. The kind and request id are the
 * values the caller has already matched on the receipt; nothing is defaulted here. Null when the
 * receipt's findings are not a dense array of plain objects: the caller treats that as a mismatch.
 */
function receiptOfKindSummaryOf(
  receipt: ReviewReceiptRecord,
  kind: ReviewReceiptSummary['kind'],
  requestId: string | null,
): ReviewReceiptOfKind | null {
  if (!findingsAreDense(receipt.findings)) {
    return null;
  }
  return {
    receiptId: receipt.id,
    requestId,
    kind,
    reviewerModel: receipt.reviewerModel,
    candidateHeadSha: receipt.candidateHeadSha,
    // RV3: an unverified stored receipt never maps to a verdict; it reads
    // `unknown` so every downstream decider keeps it unknown (fail closed).
    verdict: receipt.readOnlyVerified === true ? mapVerdict(receipt.result) : 'unknown',
    findings: receipt.findings.map((finding) => ({
      findingId: finding.findingId,
      severity: finding.severity,
      summary: finding.summary,
      filePath: finding.filePath,
      line: finding.line,
    })),
    // The fixed cause code travels only on an unknown receipt whose code is
    // one of the declared tokens and a journal-legal lowercase code; the key
    // is omitted otherwise, so existing assertions without it stay identical.
    ...(receipt.result === 'unknown' &&
    typeof receipt.unknownReason === 'string' &&
    REVIEW_UNKNOWN_REASON_CODES.has(receipt.unknownReason) &&
    LANE_RUN_JOURNAL_REASON_CODE_PATTERN.test(receipt.unknownReason)
      ? { unknownReason: receipt.unknownReason as ReviewUnknownReason }
      : {}),
  };
}

function summaryOf(
  receipt: ReviewReceiptRecord,
  kind: ReviewReceiptSummary['kind'],
  requestId: string,
): ReviewReceiptSummary | null {
  const ofKind = receiptOfKindSummaryOf(receipt, kind, requestId);
  return ofKind === null ? null : { ...ofKind, requestId };
}

function mapRejection(
  rejection: ReviewRejection | undefined,
  code?: ReviewUnavailableCode | 'not-read-only' | 'invalid-receipt',
): ReviewRequestResult {
  // The fixed reason code journals as the result's `detail` only when it is a
  // member of the declared code unions AND matches the run-journal pattern;
  // anything else (an absent or unknown code) is null, so neither free text
  // nor an undeclared token ever reaches the journal.
  const detail =
    code !== undefined && REVIEW_DETAIL_CODES.has(code) && LANE_RUN_JOURNAL_REASON_CODE_PATTERN.test(code) ? code : null;
  switch (rejection) {
    case 'review-unavailable':
    case 'not-read-only':
    case 'invalid-receipt':
      return { outcome: 'no-receipt', reason: rejection, detail };
    case 'invalid-request':
    case 'not-independent':
    case 'seat-refused':
    case 'no-assessment':
    case 'assessment-mismatch':
    case 'assessment-terminal':
    case 'request-id-reused':
      return { outcome: 'refused', reason: rejection, detail };
    default:
      return { outcome: 'refused', reason: 'unclassified', detail: null };
  }
}

/** A receipt's completion instant; an unparseable timestamp sorts before every parseable one. */
function completedAtMs(receipt: ReviewReceiptRecord): number {
  const ms = Date.parse(receipt.completedAtIso);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

type AssessmentRead =
  | { readonly outcome: 'assessment'; readonly assessment: EvidenceAssessmentRecord }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'unavailable'; readonly reason: 'not-configured' | 'unreadable' };

export class ReviewRequestAdapter implements ReviewRequestPort {
  constructor(private readonly delegates: ReviewRequestDelegates = {}) {}

  /**
   * RV4: screen the transport diagnostic's stderr and archive it under
   * `review-transport-<requestId>`. The content is JSON of only `exitCode`,
   * `timedOut`, `stdoutEmpty` and the screened stderr (or `null`): no path
   * except the `[path]` token and no secret text. An archive failure is
   * swallowed; the review outcome is unchanged.
   */
  private async archiveTransportDiagnostic(
    requestId: string,
    candidateHeadSha: string,
    diagnostic: ReviewTransportDiagnostic,
  ): Promise<void> {
    const archive = this.delegates.archiveEvidence;
    if (archive === undefined) {
      return;
    }
    const screenedStderr = diagnostic.stderr === null ? null : screenTransportText(diagnostic.stderr);
    try {
      await archive({
        artifactId: 'review-transport-' + requestId,
        candidateHeadSha,
        content: JSON.stringify({
          exitCode: diagnostic.exitCode,
          timedOut: diagnostic.timedOut,
          stdoutEmpty: diagnostic.stdoutEmpty,
          stderr: screenedStderr,
        }),
      });
    } catch {
      // Swallowed: an archive miss never changes the review outcome.
    }
  }

  /**
   * D1C: the opencode fallback reviewer seat's model, read from the delegates
   * through own data properties (a getter never runs). Null when it is absent,
   * a non-string, blank, or equal after trimming to the primary reviewer
   * model: no fallback seat, no fallback.
   */
  private opencodeFallbackReviewerModel(primaryReviewerModel: string): string | null {
    const value = ownValue(this.delegates, 'opencodeFallbackReviewerModel');
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    return trimmed === '' || trimmed === primaryReviewerModel.trim() ? null : trimmed;
  }

  /**
   * D1C fix round 1: whether the rejected request's primary reviewer model is
   * the configured api seat's model — the only route the fallback may follow
   * up, because the triggering codes are shared with the opencode transport.
   * Read through own data properties (a getter never runs); false when absent,
   * a non-string, blank, or not equal after trimming to the request's model.
   */
  private primaryRouteIsApi(primaryReviewerModel: string): boolean {
    const value = ownValue(this.delegates, 'primaryApiReviewerModel');
    return typeof value === 'string' && value.trim() !== '' && value.trim() === primaryReviewerModel.trim();
  }

  /**
   * D1C: one bounded dispatch of an independent review, shared by the attempt
   * and the chain paths. A throwing delegate is `unknown`/`delegate-failed`.
   * The delegate's answer is validated through own properties: a null,
   * non-object, unknown-outcome, throwing-getter or reviewed-without-receipt
   * answer is an unavailable review, never an exception and never a retry. A
   * rejected diagnostic is archived as in RV4. Then — at most once, only when
   * the rejection is `review-unavailable` with an API-transport code and a
   * distinct opencode fallback seat is configured and the request's primary
   * reviewer model is the configured api seat's model (the triggering codes
   * are shared with the opencode transport) — the same review is re-requested
   * against the fallback reviewer model; its answer is mapped and returned
   * without any further retry.
   */
  private async dispatchReview(
    reviewInput: RequestIndependentReviewRequest,
    context: { readonly requestId: string; readonly candidateHeadSha: string },
    validateReceipt: (receipt: ReviewReceiptRecord) => boolean,
    kind: ReviewKind,
    retried: boolean,
  ): Promise<ReviewRequestResult> {
    let result: unknown;
    try {
      const requestIndependentReview = this.delegates.requestIndependentReview;
      if (requestIndependentReview === undefined) {
        return { outcome: 'refused', reason: 'not-configured', detail: null };
      }
      result = await requestIndependentReview(reviewInput);
    } catch {
      return { outcome: 'unknown', reason: 'delegate-failed' };
    }
    if (!isPlainObject(result)) {
      return { outcome: 'no-receipt', reason: 'review-unavailable', detail: null };
    }
    const outcome = ownValue(result, 'outcome');
    if (outcome === 'reviewed') {
      const read = ownProperty(result, 'receipt');
      const receipt = read !== undefined && typeof read === 'object' ? read.value : undefined;
      if (!isPlainObject(receipt)) {
        return { outcome: 'no-receipt', reason: 'review-unavailable', detail: null };
      }
      if (!validateReceipt(receipt as ReviewReceiptRecord)) {
        return { outcome: 'unknown', reason: 'receipt-mismatch' };
      }
      const summary = summaryOf(receipt as ReviewReceiptRecord, kind, context.requestId);
      return summary === null
        ? { outcome: 'unknown', reason: 'receipt-mismatch' }
        : { outcome: 'receipt', receipt: summary };
    }
    if (outcome !== 'rejected') {
      return { outcome: 'no-receipt', reason: 'review-unavailable', detail: null };
    }
    // Every field is a data-property read; a hostile answer never throws here.
    const rejection = ownValue(result, 'rejection');
    const code = ownValue(result, 'code');
    const diagnostic = ownValue(result, 'diagnostic');
    if (code !== undefined && diagnostic !== undefined) {
      await this.archiveTransportDiagnostic(
        context.requestId,
        context.candidateHeadSha,
        diagnostic as ReviewTransportDiagnostic,
      );
    }
    if (
      !retried &&
      rejection === 'review-unavailable' &&
      typeof code === 'string' &&
      API_TRANSPORT_UNAVAILABLE_CODES.has(code) &&
      this.primaryRouteIsApi(reviewInput.reviewerModel)
    ) {
      const fallbackModel = this.opencodeFallbackReviewerModel(reviewInput.reviewerModel);
      if (fallbackModel !== null) {
        return await this.dispatchReview(
          { ...reviewInput, reviewerModel: fallbackModel },
          context,
          validateReceipt,
          kind,
          true,
        );
      }
    }
    return mapRejection(rejection as ReviewRejection | undefined, code as ReviewUnavailableCode | undefined);
  }

  /** The attempt's assessment through the inspection delegate: the one read both receipt lookups share. */
  private async readAssessmentOf(attemptId: string): Promise<AssessmentRead> {
    if (!this.delegates.inspectAcceptanceEvidence) {
      return { outcome: 'unavailable', reason: 'not-configured' };
    }
    let inspected: InspectAcceptanceEvidenceResult;
    try {
      inspected = await this.delegates.inspectAcceptanceEvidence({
        assessmentId: assessmentIdForAttempt(attemptId),
      });
    } catch {
      return { outcome: 'unavailable', reason: 'unreadable' };
    }
    if (inspected.outcome === 'not-found' || inspected.assessment.attemptId !== attemptId) {
      return { outcome: 'not-found' };
    }
    return { outcome: 'assessment', assessment: inspected.assessment };
  }

  /**
   * The combined pre-merge review of a chain at its integration head: one
   * evidence request on the chain subject, mapped exactly as the attempt path
   * maps its outcome, with a receipt for any other subject treated as unknown.
   */
  private async requestChainReview(request: ReviewRequest, chain: ChainSubject): Promise<ReviewRequestResult> {
    // Every field is snapshotted once from own data properties: a throwing
    // getter is an invalid request, never an exception.
    const optional = snapshotOptionalFields(request, ['diffSummary', 'nowIso']);
    const requestId = ownValue(request, 'requestId');
    const policyRevision = ownValue(request, 'policyRevision');
    const implementerModel = ownValue(request, 'implementerModel');
    const reviewerModel = ownValue(request, 'reviewerModel');
    const diffSummary = optional?.diffSummary;
    const nowIso = optional?.nowIso;
    if (
      optional === null ||
      ownValue(request, 'kind') !== 'pre-merge' ||
      typeof requestId !== 'string' ||
      !REVIEW_REQUEST_ID_PATTERN.test(requestId) ||
      !isNonEmptyTrimmed(policyRevision) ||
      !isNonEmptyTrimmed(implementerModel) ||
      !isNonEmptyTrimmed(reviewerModel) ||
      (nowIso !== undefined && typeof nowIso !== 'string') ||
      (diffSummary !== undefined &&
        (typeof diffSummary !== 'string' || Buffer.byteLength(diffSummary, 'utf8') > DIFF_SUMMARY_MAX_BYTES))
    ) {
      return { outcome: 'refused', reason: 'invalid-request', detail: null };
    }
    if (!this.delegates.requestIndependentReview) {
      return { outcome: 'refused', reason: 'not-configured', detail: null };
    }
    return this.dispatchReview(
      {
        assessmentId: assessmentIdForChain(chain.projectId, chain.chainName),
        projectId: chain.projectId,
        attemptId: attemptIdForChain(chain.projectId, chain.chainName),
        candidateHeadSha: chain.integrationHeadSha,
        policyRevision: policyRevision as string,
        implementerModel: implementerModel as string,
        reviewerModel: reviewerModel as string,
        kind: 'pre-merge',
        requestId,
        subject: evidenceChainSubject(chain),
        ...(diffSummary !== undefined ? { diffSummary } : {}),
        ...(nowIso !== undefined ? { nowIso } : {}),
      },
      { requestId, candidateHeadSha: chain.integrationHeadSha },
      (receipt) => receipt.requestId === requestId && isChainReceiptOf(receipt, chain),
      'pre-merge',
      false,
    );
  }

  async requestReview(request: ReviewRequest): Promise<ReviewRequestResult> {
    const subject = readSubject(request);
    if (ownValue(request, 'kind') === 'brief-verify' || subject.kind === 'brief') {
      return { outcome: 'refused', reason: 'subject-not-implemented', detail: null };
    }
    if (subject.kind === 'invalid') {
      return { outcome: 'refused', reason: 'invalid-request', detail: null };
    }
    if (subject.kind === 'chain') {
      return this.requestChainReview(request, subject.chain);
    }
    const optional = snapshotOptionalFields(request, ['briefText', 'nowIso']);
    const briefText = optional?.briefText;
    const nowIso = optional?.nowIso;
    if (
      optional === null ||
      !isValidReviewRequest(request) ||
      (nowIso !== undefined && typeof nowIso !== 'string') ||
      (briefText !== undefined &&
        (typeof briefText !== 'string' || briefTextByteLength(briefText) > BRIEF_TEXT_MAX_BYTES))
    ) {
      return { outcome: 'refused', reason: 'invalid-request', detail: null };
    }
    if (!this.delegates.requestIndependentReview) {
      return { outcome: 'refused', reason: 'not-configured', detail: null };
    }
    // isValidReviewRequest accepted the kind, so it is one of the three stored review kinds here.
    const kind = request.kind as ReviewKind;
    return this.dispatchReview(
      {
        assessmentId: assessmentIdForAttempt(request.attemptId),
        projectId: request.projectId,
        attemptId: request.attemptId,
        candidateHeadSha: request.candidateHeadSha,
        policyRevision: request.policyRevision,
        implementerModel: request.implementerModel,
        reviewerModel: request.reviewerModel,
        kind,
        requestId: request.requestId,
        // The frozen brief flows through only for a brief-check, so any other
        // kind's transport call carries exactly the fields it carried before.
        ...(kind === 'brief-check' && briefText !== undefined ? { briefText: briefText as string } : {}),
        ...(nowIso !== undefined ? { nowIso } : {}),
      },
      { requestId: request.requestId, candidateHeadSha: request.candidateHeadSha },
      (receipt) =>
        receipt.requestId === request.requestId &&
        receipt.kind === kind &&
        receipt.attemptId === request.attemptId &&
        receipt.candidateHeadSha === request.candidateHeadSha,
      kind,
      false,
    );
  }

  async findReviewReceipt(request: FindReviewReceiptRequest): Promise<FindReviewReceiptResult> {
    const subject = readSubject(request);
    if (subject.kind === 'brief' || subject.kind === 'invalid') {
      return { outcome: 'unavailable', reason: 'invalid-request' };
    }
    if (subject.kind === 'chain') {
      return this.findChainReceipt(request, subject.chain);
    }
    if (!isValidFindReceiptRequest(request)) {
      return { outcome: 'unavailable', reason: 'invalid-request' };
    }
    const read = await this.readAssessmentOf(request.attemptId);
    if (read.outcome !== 'assessment') {
      return read;
    }
    const matches = read.assessment.reviewReceipts.filter(
      (receipt) => receipt.requestId === request.requestId,
    );
    if (matches.length === 0) {
      return { outcome: 'not-found' };
    }
    const [only] = matches;
    if (
      matches.length > 1 ||
      only.candidateHeadSha !== request.candidateHeadSha ||
      only.attemptId !== request.attemptId ||
      only.kind === undefined
    ) {
      return { outcome: 'unavailable', reason: 'receipt-mismatch' };
    }
    const summary = summaryOf(only, only.kind, request.requestId);
    return summary === null
      ? { outcome: 'unavailable', reason: 'receipt-mismatch' }
      : { outcome: 'found', receipt: summary };
  }
  /** The chain's receipt for one request id, from the chain's own assessment; another kind, head or subject is a mismatch. */
  private async findChainReceipt(request: FindReviewReceiptRequest, chain: ChainSubject): Promise<FindReviewReceiptResult> {
    if (!REVIEW_REQUEST_ID_PATTERN.test(request.requestId)) {
      return { outcome: 'unavailable', reason: 'invalid-request' };
    }
    const read = await this.readAssessmentOf(attemptIdForChain(chain.projectId, chain.chainName));
    if (read.outcome !== 'assessment') {
      return read;
    }
    const matches = read.assessment.reviewReceipts.filter((receipt) => receipt.requestId === request.requestId);
    if (matches.length === 0) {
      return { outcome: 'not-found' };
    }
    const [only] = matches;
    if (matches.length > 1 || !isChainReceiptOf(only, chain)) {
      return { outcome: 'unavailable', reason: 'receipt-mismatch' };
    }
    const summary = summaryOf(only, 'pre-merge', request.requestId);
    return summary === null
      ? { outcome: 'unavailable', reason: 'receipt-mismatch' }
      : { outcome: 'found', receipt: summary };
  }

  private async findLatestChainReceiptOfKind(
    request: FindLatestReceiptOfKindRequest,
    chain: ChainSubject,
  ): Promise<FindLatestReceiptOfKindResult> {
    const read = await this.readAssessmentOf(attemptIdForChain(chain.projectId, chain.chainName));
    if (read.outcome !== 'assessment') {
      return read;
    }
    const ofKind = read.assessment.reviewReceipts.filter((receipt) => receipt.kind === request.kind);
    if (ofKind.length === 0) {
      return { outcome: 'not-found' };
    }
    if (!ofKind.every((receipt) => isChainReceiptOf(receipt, chain))) {
      return { outcome: 'unavailable', reason: 'receipt-mismatch' };
    }
    let latest = ofKind[0];
    for (const candidate of ofKind.slice(1)) {
      if (completedAtMs(candidate) >= completedAtMs(latest)) {
        latest = candidate;
      }
    }
    const latestSummary = receiptOfKindSummaryOf(latest, 'pre-merge', latest.requestId ?? null);
    return latestSummary === null
      ? { outcome: 'unavailable', reason: 'receipt-mismatch' }
      : { outcome: 'found', receipt: latestSummary };
  }

  async findLatestReceiptOfKind(
    request: FindLatestReceiptOfKindRequest,
  ): Promise<FindLatestReceiptOfKindResult> {
    const subject = readSubject(request);
    if (subject.kind === 'brief' || subject.kind === 'invalid') {
      return { outcome: 'unavailable', reason: 'invalid-request' };
    }
    if (subject.kind === 'chain') {
      return isReviewKind(request.kind)
        ? this.findLatestChainReceiptOfKind(request, subject.chain)
        : { outcome: 'unavailable', reason: 'invalid-request' };
    }
    if (!isValidFindLatestReceiptOfKindRequest(request)) {
      return { outcome: 'unavailable', reason: 'invalid-request' };
    }
    const read = await this.readAssessmentOf(request.attemptId);
    if (read.outcome !== 'assessment') {
      return read;
    }
    const candidates = read.assessment.reviewReceipts.filter(
      (receipt): receipt is ReviewReceiptRecord & { kind: ReviewReceiptSummary['kind'] } =>
        receipt.kind === request.kind &&
        receipt.attemptId === request.attemptId &&
        receipt.candidateHeadSha === request.candidateHeadSha,
    );
    if (candidates.length === 0) {
      return { outcome: 'not-found' };
    }
    const [first, ...rest] = candidates;
    let latest = first;
    for (const candidate of rest) {
      // Instants, not strings: precision or offset differences must not reorder receipts.
      if (completedAtMs(candidate) >= completedAtMs(latest)) {
        latest = candidate;
      }
    }
    const finalSummary = receiptOfKindSummaryOf(latest, latest.kind, latest.requestId ?? null);
    return finalSummary === null
      ? { outcome: 'unavailable', reason: 'receipt-mismatch' }
      : {
      outcome: 'found',
      receipt: finalSummary,
    };
  }

  /**
   * KF-33b2: delegate each id to the evidence context's disposition recorder
   * with state `out-of-scope`, the fixed reason and the `scope:<head12>`
   * evidence reference. Any rejection, throw or missing delegate refuses the
   * whole call: fail closed, so no finding is half-dispositioned silently.
   */
  async recordOutOfScope(request: RecordOutOfScopeRequest): Promise<RecordOutOfScopeResult> {
    const delegate = this.delegates.recordFindingDisposition;
    // Runtime input never throws: a null, a non-object, a wrong-typed field,
    // a sparse array or a throwing getter is a refusal, never a crash.
    let valid = false;
    try {
      valid =
        delegate !== undefined &&
        typeof request === 'object' &&
        request !== null &&
        !Array.isArray(request) &&
        typeof request.attemptId === 'string' &&
        isNonEmptyTrimmed(request.attemptId) &&
        typeof request.candidateHeadSha === 'string' &&
        HEAD_PATTERN.test(request.candidateHeadSha) &&
        isDenseNonEmptyStringArray(request.findingIds);
    } catch {
      valid = false;
    }
    if (!valid) {
      return { outcome: 'refused' };
    }
    const evidenceRef = 'scope:' + request.candidateHeadSha.slice(0, 12);
    const recordedAtIso = request.nowIso ?? new Date().toISOString();
    for (const findingId of request.findingIds) {
      const disposition: FindingDispositionRecord = {
        id: 'disp-' + request.candidateHeadSha.slice(0, 12) + '-' + findingId,
        assessmentId: assessmentIdForAttempt(request.attemptId),
        findingId,
        candidateHeadSha: request.candidateHeadSha,
        state: 'out-of-scope',
        reason: OUT_OF_SCOPE_REASON,
        evidenceRef,
        recordedBy: 'conductor',
        recordedAtIso,
      };
      try {
        const answered = await delegate!({ assessmentId: disposition.assessmentId, disposition });
        if (answered.outcome !== 'recorded') {
          return { outcome: 'refused' };
        }
      } catch {
        return { outcome: 'refused' };
      }
    }
    return { outcome: 'recorded' };
  }
}
