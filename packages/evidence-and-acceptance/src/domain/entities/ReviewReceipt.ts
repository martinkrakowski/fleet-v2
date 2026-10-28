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
  ReviewKind,
} from '../evidence-records.js';
import {
  REVIEW_KINDS,
  REVIEW_REQUEST_ID_PATTERN,
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
    if (props.kind !== undefined && !REVIEW_KINDS.includes(props.kind)) {
      return {
        success: false,
        error: new Error('ReviewReceipt has an invalid kind: ' + String(props.kind)),
      };
    }
    if (
      props.requestId !== undefined &&
      (typeof props.requestId !== 'string' || !REVIEW_REQUEST_ID_PATTERN.test(props.requestId))
    ) {
      return {
        success: false,
        error: new Error('ReviewReceipt has an invalid requestId'),
      };
    }
    if (props.requestId !== undefined && props.kind === undefined) {
      return {
        success: false,
        error: new Error('ReviewReceipt with a requestId requires a kind'),
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

  getKind(): ReviewKind | undefined {
    return this.props.kind;
  }

  getRequestId(): string | undefined {
    return this.props.requestId;
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
