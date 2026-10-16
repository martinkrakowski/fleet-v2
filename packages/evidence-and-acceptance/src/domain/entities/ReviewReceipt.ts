// @generated entity stub — refined for step 4.
/**
 * ReviewReceipt is a child entity of the EvidenceAssessment aggregate. It
 * retains the reviewer identity, read-only capability, findings and source
 * evidence for an exact head. A purported independent review by the same
 * underlying model as the implementer is rejected: changing the provider
 * prefix alone is insufficient.
 */

import type {
  ReviewFindingRecord,
  ReviewReceiptRecord,
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
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The underlying model family of a model id: the id is lowercased and
 * trimmed, cut at the first `#` (any `#variant`), everything up to and
 * including the last `/` is dropped (every provider prefix), the remainder is
 * cut at the first `:` or `@` (`:nitro`, `:thinking`, `:free`/`:paid`,
 * `@20250929`, ...), and then the leading run of letters and hyphens before
 * the first digit is kept with a trailing hyphen trimmed. An id with no digit
 * keeps the whole remaining name, so a name like `space-bunny-free` is a
 * family of its own. This is stricter than a provider-prefix strip alone:
 * `openrouter/z-ai/glm-5.3`, `nvidia/z-ai/glm-5.3-flash` and `glm-5.2` share
 * the family `glm`, so a flash reviewer of a GLM implementer is refused.
 *
 * An empty family (from `''`, `'/'`, `'z-ai/'`, `'#low'`) is invalid; callers
 * comparing families must fail closed and treat an empty family as equal to
 * every other family.
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
  const digitIndex = value.search(/[0-9]/);
  if (digitIndex !== -1) {
    value = value.slice(0, digitIndex);
  }
  if (value.endsWith('-')) {
    value = value.slice(0, -1);
  }
  return value;
}

/**
 * Fail-closed family comparison: two families are the same when they are
 * equal, and also when either is empty (an empty family is invalid, so it can
 * never prove independence).
 */
export function isSameModelFamily(left: string, right: string): boolean {
  return left === right || left === '' || right === '';
}

function isValidFinding(finding: ReviewFindingRecord): boolean {
  return (
    isNonEmptyTrimmedString(finding.findingId) &&
    (finding.severity === 'blocker' ||
      finding.severity === 'major' ||
      finding.severity === 'minor' ||
      finding.severity === 'nit') &&
    isNonEmptyTrimmedString(finding.summary) &&
    (finding.filePath === null || typeof finding.filePath === 'string') &&
    (finding.line === null || Number.isInteger(finding.line)) &&
    typeof finding.state === 'string' &&
    FINDING_STATES.includes(finding.state) &&
    (finding.dispositionReason === null || typeof finding.dispositionReason === 'string') &&
    (finding.dispositionEvidenceRef === null ||
      typeof finding.dispositionEvidenceRef === 'string')
  );
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
    if (!Array.isArray(props.findings) || !props.findings.every(isValidFinding)) {
      return {
        success: false,
        error: new Error('ReviewReceipt contains an invalid finding'),
      };
    }
    return {
      success: true,
      value: new ReviewReceipt({ ...props, findings: [...props.findings] }),
    };
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
