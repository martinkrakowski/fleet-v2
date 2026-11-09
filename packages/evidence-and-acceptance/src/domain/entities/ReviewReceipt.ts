// @generated entity stub — refined for step 4.
/**
 * ReviewReceipt is a child entity of the EvidenceAssessment aggregate. It
 * retains the reviewer identity, read-only capability, findings and source
 * evidence for an exact head. A purported independent review by the same
 * underlying model as the implementer is rejected: changing the provider
 * prefix alone is insufficient.
 */

import type {
  ReceiptSubject,
  ReviewFindingRecord,
  ReviewReceiptRecord,
  ReviewKind,
  ReviewUnknownReason,
} from '../evidence-records.js';
import {
  REVIEW_KINDS,
  REVIEW_REQUEST_ID_PATTERN,
  REVIEW_UNKNOWN_REASONS,
  receiptSubjectOf,
} from '../evidence-records.js';
import type { EvidenceResultValue } from '../value-objects/EvidenceResult.vo.js';
import { EVIDENCE_RESULTS } from '../value-objects/EvidenceResult.vo.js';
import { FINDING_STATES } from '../value-objects/FindingState.vo.js';

export interface ReviewReceiptProps {
  readonly id: string;
  readonly assessmentId: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly candidateHeadSha: string;
  readonly reviewerModel: string;
  readonly implementerModel: string;
  readonly readOnlyVerified: boolean;
  readonly result: EvidenceResultValue;
  readonly findings: readonly ReviewFindingRecord[];
  readonly evidenceRef: string;
  readonly policyRevision: string;
  readonly completedAtIso: string;
  /** The review kind (§3.3); absent on receipts recorded before the conductor, read as `code-review`. */
  readonly kind?: ReviewKind;
  /** The conductor's request id (§3.5); absent on manual reviews. */
  readonly requestId?: string;
  /** What the receipt is about; absent reads as the attempt. */
  readonly subject?: ReceiptSubject;
  /** Fixed cause code when `result === 'unknown'`; absent on pass/fail and pre-RV2 receipts. */
  readonly unknownReason?: ReviewUnknownReason;
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The underlying model family of a model id — one family per vendor line
 * (owner decision 2026-10-16): the id is lowercased and trimmed, cut at the
 * first `#` (any `#variant`), everything up to and including the last `/` is
 * dropped (every provider prefix), the remainder is cut at the first `:` or
 * `@` (`:nitro`, `:thinking`, `:free`/`:paid`, `@20250929`, ...), and the
 * family is then the leading run of ASCII letters only, stopping at the
 * first character that is not `a`-`z`. Every model of a vendor line is one
 * family, so tier words before the first digit never split a line:
 * `openrouter/z-ai/glm-5.3`, `nvidia/z-ai/glm-5.3-flash`, `glm-5.2` and
 * `glm-z1-32b` are all `glm`; `claude-sonnet-4-5` and
 * `claude-3-5-sonnet-20241022` are `claude`; `grok-4.7` and
 * `grok-code-fast-4.7` are `grok`; `gpt-5` and `gpt-oss-120b` are `gpt`;
 * `space-bunny-free` is `space`. A flash reviewer of a GLM implementer is
 * refused; so is any Claude reviewer of a Claude implementer.
 *
 * An empty family (from `''`, `'4o-mini'`, `'/'`, `'z-ai/'`, `'#low'`) is
 * invalid; callers comparing families must fail closed and treat an empty
 * family as equal to every other family. Known gap (follow-up, not handled):
 * Bedrock-style `vendor.model` ids such as `anthropic.claude-...` key on the
 * vendor, so they are not matched to `claude-...`.
 */
export function underlyingModelFamily(model: string): string {
  let value = model.trim().toLowerCase();
  const hashIndex = value.indexOf('#');
  if (hashIndex !== -1) {
    value = value.slice(0, hashIndex);
  }
  const separatorIndex = value.lastIndexOf('/');
  if (separatorIndex !== -1) {
    value = value.slice(separatorIndex + 1);
  }
  const specialIndex = value.search(/[:@]/);
  if (specialIndex !== -1) {
    value = value.slice(0, specialIndex);
  }
  const letters = /^[a-z]*/.exec(value);
  return letters === null ? '' : letters[0];
}

/**
 * Fail-closed family comparison: two families are the same when they are
 * equal, and also when either is empty (an empty family is invalid, so it can
 * never prove independence).
 */
export function isSameModelFamily(left: string, right: string): boolean {
  return left === right || left === '' || right === '';
}

function isValidFinding(finding: unknown): boolean {
  if (typeof finding !== 'object' || finding === null) {
    return false;
  }
  const candidate = finding as ReviewFindingRecord;
  return (
    isNonEmptyTrimmedString(candidate.findingId) &&
    (candidate.severity === 'blocker' ||
      candidate.severity === 'major' ||
      candidate.severity === 'minor' ||
      candidate.severity === 'nit') &&
    isNonEmptyTrimmedString(candidate.summary) &&
    (candidate.filePath === null || typeof candidate.filePath === 'string') &&
    (candidate.line === null || Number.isInteger(candidate.line)) &&
    typeof candidate.state === 'string' &&
    FINDING_STATES.includes(candidate.state) &&
    (candidate.dispositionReason === null || typeof candidate.dispositionReason === 'string') &&
    (candidate.dispositionEvidenceRef === null ||
      typeof candidate.dispositionEvidenceRef === 'string')
  );
}

/**
 * Every slot of `findings` is a valid finding: a sparse array (a hole, an
 * inherited index) is invalid before iteration, so a hole can never read as
 * `undefined` and slip past a check.
 */
function findingsAreValid(findings: unknown): boolean {
  if (!Array.isArray(findings)) {
    return false;
  }
  for (let index = 0; index < findings.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(findings, index)) {
      return false;
    }
    if (!isValidFinding(findings[index])) {
      return false;
    }
  }
  return true;
}

/**
 * The later checks of `create`, in their order: the in-receipt duplicate finding
 * ids, then the optional kind, requestId and subject. Returns the refusal
 * message, or null when all hold.
 */
function checkOptionalFields(props: ReviewReceiptProps): string | null {
  // Finding ids are numbered per receipt: one receipt may not raise two
  // findings under the same id, or dispositions could not name one finding.
  // The real transport never produces in-receipt duplicates (positional ids).
  const findingIds = new Set<string>();
  for (const finding of props.findings) {
    if (findingIds.has(finding.findingId)) {
      return `ReviewReceipt contains duplicate finding id '${finding.findingId}'`;
    }
    findingIds.add(finding.findingId);
  }
  if (props.kind !== undefined && !REVIEW_KINDS.includes(props.kind)) {
    return 'ReviewReceipt has an invalid kind: ' + String(props.kind);
  }
  if (
    props.requestId !== undefined &&
    (typeof props.requestId !== 'string' || !REVIEW_REQUEST_ID_PATTERN.test(props.requestId))
  ) {
    return 'ReviewReceipt has an invalid requestId';
  }
  if (props.requestId !== undefined && props.kind === undefined) {
    return 'ReviewReceipt with a requestId requires a kind';
  }
  if (props.subject !== undefined && receiptSubjectOf(props) === null) {
    return 'ReviewReceipt has an invalid subject';
  }
  return null;
}

export class ReviewReceipt {
  private constructor(private readonly props: ReviewReceiptProps) {
    // Invariants are validated in create.
  }

  static create(props: ReviewReceiptProps): {
    success: boolean;
    value?: ReviewReceipt;
    error?: Error;
  } {
    // Runtime input never throws: a null, a non-object or a throwing getter is
    // a refusal, not a crash.
    try {
      if (typeof props !== 'object' || props === null || Array.isArray(props)) {
        return {
          success: false,
          error: new Error('Invalid ReviewReceipt props'),
        };
      }
      if (
        !isNonEmptyTrimmedString(props.id) ||
        !isNonEmptyTrimmedString(props.assessmentId) ||
        !isNonEmptyTrimmedString(props.projectId) ||
        !isNonEmptyTrimmedString(props.attemptId) ||
        !isNonEmptyTrimmedString(props.candidateHeadSha) ||
        !isNonEmptyTrimmedString(props.reviewerModel) ||
        !isNonEmptyTrimmedString(props.implementerModel) ||
        !isNonEmptyTrimmedString(props.evidenceRef) ||
        !isNonEmptyTrimmedString(props.policyRevision) ||
        !isNonEmptyTrimmedString(props.completedAtIso)
      ) {
        return {
          success: false,
          error: new Error(
            'ReviewReceipt requires non-empty id, assessmentId, projectId, attemptId, candidateHeadSha, reviewerModel, implementerModel, evidenceRef, policyRevision and completedAtIso',
          ),
        };
      }
      if (typeof props.result !== 'string' || !EVIDENCE_RESULTS.includes(props.result)) {
        return {
          success: false,
          error: new Error(`ReviewReceipt has an invalid result: ${String(props.result)}`),
        };
      }
      if (typeof props.readOnlyVerified !== 'boolean') {
        return {
          success: false,
          error: new Error('ReviewReceipt requires a boolean readOnlyVerified'),
        };
      }
      // The reviewer's underlying model differs from the implementer's; a
      // provider change alone is insufficient.
      if (isSameModelFamily(
        underlyingModelFamily(props.reviewerModel),
        underlyingModelFamily(props.implementerModel),
      )) {
        return {
          success: false,
          error: new Error(
            `ReviewReceipt requires a reviewer distinct from the implementer: ${props.reviewerModel} and ${props.implementerModel} share the same underlying model`,
          ),
        };
      }
      if (!findingsAreValid(props.findings)) {
        return {
          success: false,
          error: new Error('ReviewReceipt contains an invalid finding'),
        };
      }
      if (
        props.unknownReason !== undefined &&
        (!(REVIEW_UNKNOWN_REASONS as readonly string[]).includes(props.unknownReason) ||
          props.result !== 'unknown')
      ) {
        return {
          success: false,
          error: new Error('ReviewReceipt has an invalid unknownReason'),
        };
      }
      const optionalFieldsError = checkOptionalFields(props);
      if (optionalFieldsError !== null) {
        return { success: false, error: new Error(optionalFieldsError) };
      }
      // The optional `unknownReason` key is omitted completely when absent, so
      // existing receipt assertions without it stay identical.
      const { unknownReason, ...rest } = props;
      const storedProps: ReviewReceiptProps =
        unknownReason === undefined
          ? rest
          : { ...rest, unknownReason };
      return {
        success: true,
        value: new ReviewReceipt({ ...storedProps, findings: [...storedProps.findings] }),
      };
    } catch {
      return {
        success: false,
        error: new Error('Invalid ReviewReceipt props'),
      };
    }
  }

  static fromRecord(record: ReviewReceiptRecord): ReviewReceipt {
    const created = ReviewReceipt.create(record);
    if (!created.success || created.value === undefined) {
      throw new Error(created.error?.message ?? 'Invalid ReviewReceipt record');
    }
    return created.value;
  }

  getId(): string {
    return this.props.id;
  }

  getAssessmentId(): string {
    return this.props.assessmentId;
  }

  getCandidateHeadSha(): string {
    return this.props.candidateHeadSha;
  }

  getReviewerModel(): string {
    return this.props.reviewerModel;
  }

  getImplementerModel(): string {
    return this.props.implementerModel;
  }

  getResult(): EvidenceResultValue {
    return this.props.result;
  }

  getFindings(): readonly ReviewFindingRecord[] {
    return this.props.findings;
  }

  getKind(): ReviewKind | undefined {
    return this.props.kind;
  }

  getRequestId(): string | undefined {
    return this.props.requestId;
  }

  getUnknownReason(): ReviewUnknownReason | undefined {
    return this.props.unknownReason;
  }

  /** A review only proves the head it was produced for. */
  matchesHead(candidateHeadSha: string): boolean {
    return this.props.candidateHeadSha === candidateHeadSha;
  }

  getProps(): ReviewReceiptProps {
    return this.props;
  }

  toRecord(): ReviewReceiptRecord {
    return { ...this.props, findings: [...this.props.findings] };
  }
}
