// @generated entity stub — refined for step 4.
/**
 * EvidenceAssessment is the aggregate root of exact-head acceptance: it owns
 * verification receipts, review receipts and finding dispositions for one
 * candidate head under one acceptance-policy revision, and derives the
 * explicit blocker list from that evidence. Unknown, stale or incomplete
 * evidence does not pass; pending, unknown and unresolved blockers never
 * become an implicit pass. Re-exports the shared evidence records so they
 * leave through domain/index.ts without modifying the generated barrel.
 */

export * from '../evidence-records.js';

import type {
  EvidenceAssessmentRecord,
  FindingDispositionRecord,
  ReviewReceiptRecord,
  VerificationReceiptRecord,
} from '../evidence-records.js';
import type { AssessmentStateValue } from '../value-objects/AssessmentState.vo.js';
import { AssessmentState } from '../value-objects/AssessmentState.vo.js';
import { EvidenceResult } from '../value-objects/EvidenceResult.vo.js';
import { FindingState } from '../value-objects/FindingState.vo.js';
import { FindingDisposition } from './FindingDisposition.js';
import { ReviewReceipt } from './ReviewReceipt.js';
import { VerificationReceipt } from './VerificationReceipt.js';

export interface EvidenceAssessmentProps {
  readonly id: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly candidateHeadSha: string;
  readonly policyRevision: string;
  /** The implementer seat recorded at creation; absent means refused. */
  readonly implementerModel: string;
  readonly requiredChecks: readonly string[];
  readonly state: AssessmentStateValue;
  readonly verificationReceipts: readonly VerificationReceiptRecord[];
  readonly reviewReceipts: readonly ReviewReceiptRecord[];
  readonly findingDispositions: readonly FindingDispositionRecord[];
  readonly acceptanceReceiptId: string | null;
  readonly blockers: readonly string[];
  readonly revision: number;
  readonly updatedAtIso: string;
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class EvidenceAssessment {
  private record: EvidenceAssessmentRecord;

  private constructor(record: EvidenceAssessmentRecord) {
    this.record = record;
  }

  static create(props: EvidenceAssessmentProps): {
    success: boolean;
    value?: EvidenceAssessment;
    error?: Error;
  } {
    if (
      !isNonEmptyTrimmedString(props.id) ||
      !isNonEmptyTrimmedString(props.projectId) ||
      !isNonEmptyTrimmedString(props.attemptId) ||
      !isNonEmptyTrimmedString(props.candidateHeadSha) ||
      !isNonEmptyTrimmedString(props.policyRevision) ||
      !isNonEmptyTrimmedString(props.implementerModel) ||
      !isNonEmptyTrimmedString(props.updatedAtIso)
    ) {
      return {
        success: false,
        error: new Error(
          'EvidenceAssessment requires non-empty id, projectId, attemptId, candidateHeadSha, policyRevision, implementerModel and updatedAtIso',
        ),
      };
    }
    if (!Array.isArray(props.requiredChecks) || !props.requiredChecks.every(isNonEmptyTrimmedString)) {
      return {
        success: false,
        error: new Error('EvidenceAssessment requiredChecks must be non-empty strings'),
      };
    }
    const state = AssessmentState.create(props.state);
    if (!state.success || state.value === undefined) {
      return {
        success: false,
        error: state.error ?? new Error(`Invalid assessment state: ${String(props.state)}`),
      };
    }
    for (const receipt of props.verificationReceipts) {
      if (!VerificationReceipt.create(receipt).success) {
        return { success: false, error: new Error('EvidenceAssessment contains an invalid verification receipt') };
      }
    }
    for (const receipt of props.reviewReceipts) {
      if (!ReviewReceipt.create(receipt).success) {
        return { success: false, error: new Error('EvidenceAssessment contains an invalid review receipt') };
      }
    }
    for (const disposition of props.findingDispositions) {
      if (!FindingDisposition.create(disposition).success) {
        return { success: false, error: new Error('EvidenceAssessment contains an invalid finding disposition') };
      }
    }
    if (
      props.acceptanceReceiptId !== null &&
      !isNonEmptyTrimmedString(props.acceptanceReceiptId)
    ) {
      return {
        success: false,
        error: new Error('EvidenceAssessment acceptanceReceiptId must be a non-empty string or null'),
      };
    }
    if (!Array.isArray(props.blockers) || !props.blockers.every(isNonEmptyTrimmedString)) {
      return {
        success: false,
        error: new Error('EvidenceAssessment blockers must be non-empty strings'),
      };
    }
    if (!Number.isInteger(props.revision) || props.revision < 0) {
      return {
        success: false,
        error: new Error('EvidenceAssessment requires a non-negative integer revision'),
      };
    }
    return {
      success: true,
      value: new EvidenceAssessment({
        ...props,
        requiredChecks: [...props.requiredChecks],
        verificationReceipts: [...props.verificationReceipts],
        reviewReceipts: [...props.reviewReceipts],
        findingDispositions: [...props.findingDispositions],
        blockers: [...props.blockers],
      }),
    };
  }

  static fromRecord(record: EvidenceAssessmentRecord): EvidenceAssessment {
    const created = EvidenceAssessment.create(record);
    if (!created.success || created.value === undefined) {
      throw new Error(created.error?.message ?? 'Invalid EvidenceAssessment record');
    }
    return created.value;
  }

  getId(): string {
    return this.record.id;
  }

  getState(): AssessmentStateValue {
    return this.record.state;
  }

  getRevision(): number {
    return this.record.revision;
  }

  getBlockers(): readonly string[] {
    return this.record.blockers;
  }

  getAcceptanceReceiptId(): string | null {
    return this.record.acceptanceReceiptId;
  }

  isTerminal(): boolean {
    return AssessmentState.create(this.record.state).value?.isTerminal() ?? false;
  }

  /** Evidence binds to one exact head; a different head makes it stale. */
  isStaleForHead(candidateHeadSha: string): boolean {
    return this.record.candidateHeadSha !== candidateHeadSha;
  }

  /**
   * Required checks without a passing verification receipt. Pending, unknown
   * and missing receipts never become an implicit pass; `not-applicable`
   * counts as passing because the check explicitly does not apply.
   */
  pendingRequiredChecks(): readonly string[] {
    return this.record.requiredChecks.filter((check) => {
      const receipt = this.record.verificationReceipts.find(
        (candidate) =>
          candidate.procedureName === check &&
          candidate.candidateHeadSha === this.record.candidateHeadSha,
      );
      if (receipt === undefined) {
        return true;
      }
      return !EvidenceResult.create(receipt.result).value?.isPassing();
    });
  }

  /** Unresolved findings still block acceptance; fixed and refuted do not. */
  unresolvedFindingIds(): readonly string[] {
    const resolved = new Set(
      this.record.findingDispositions
        .filter((disposition) => !FindingState.create(disposition.state).value?.isBlocking())
        .map((disposition) => disposition.findingId),
    );
    const findingIds = new Set<string>();
    for (const receipt of this.record.reviewReceipts) {
      for (const finding of receipt.findings) {
        findingIds.add(finding.findingId);
      }
    }
    return [...findingIds].filter((findingId) => !resolved.has(findingId));
  }

  /**
   * Derived explicit blockers: required checks lacking a passing receipt and
   * findings still unresolved. Explicit host exclusions do not waive
   * unrelated failures, so every required check is considered.
   */
  collectBlockers(): readonly string[] {
    const blockers: string[] = [];
    for (const check of this.pendingRequiredChecks()) {
      blockers.push(`required check '${check}' has no passing verification receipt`);
    }
    for (const findingId of this.unresolvedFindingIds()) {
      blockers.push(`finding '${findingId}' is unresolved`);
    }
    return blockers;
  }

  appendVerificationReceipt(receipt: VerificationReceiptRecord, updatedAtIso: string): void {
    if (this.isTerminal()) {
      throw new Error(`Cannot append verification receipt to an assessment in terminal state '${this.record.state}'`);
    }
    const validated = VerificationReceipt.create(receipt);
    if (!validated.success || validated.value === undefined) {
      throw new Error(validated.error?.message ?? 'Invalid verification receipt');
    }
    if (!validated.value.matchesHead(this.record.candidateHeadSha)) {
      throw new Error('Verification receipt belongs to a different head');
    }
    if (validated.value.getAssessmentId() !== this.record.id) {
      throw new Error('Verification receipt belongs to a different assessment');
    }
    this.record = {
      ...this.record,
      verificationReceipts: [...this.record.verificationReceipts, { ...receipt }],
      revision: this.record.revision + 1,
      updatedAtIso,
    };
  }

  appendReviewReceipt(receipt: ReviewReceiptRecord, updatedAtIso: string): void {
    if (this.isTerminal()) {
      throw new Error(`Cannot append review receipt to an assessment in terminal state '${this.record.state}'`);
    }
    const validated = ReviewReceipt.create(receipt);
    if (!validated.success || validated.value === undefined) {
      throw new Error(validated.error?.message ?? 'Invalid review receipt');
    }
    if (!validated.value.matchesHead(this.record.candidateHeadSha)) {
      throw new Error('Review receipt belongs to a different head');
    }
    if (validated.value.getAssessmentId() !== this.record.id) {
      throw new Error('Review receipt belongs to a different assessment');
    }
    this.record = {
      ...this.record,
      reviewReceipts: [...this.record.reviewReceipts, validated.value.toRecord()],
      revision: this.record.revision + 1,
      updatedAtIso,
    };
  }

  appendFindingDisposition(disposition: FindingDispositionRecord, updatedAtIso: string): void {
    if (this.isTerminal()) {
      throw new Error(`Cannot append finding disposition to an assessment in terminal state '${this.record.state}'`);
    }
    const validated = FindingDisposition.create(disposition);
    if (!validated.success || validated.value === undefined) {
      throw new Error(validated.error?.message ?? 'Invalid finding disposition');
    }
    if (!validated.value.matchesHead(this.record.candidateHeadSha)) {
      throw new Error('Finding disposition belongs to a different head');
    }
    if (validated.value.getAssessmentId() !== this.record.id) {
      throw new Error('Finding disposition belongs to a different assessment');
    }
    this.record = {
      ...this.record,
      findingDispositions: [...this.record.findingDispositions, { ...disposition }],
      revision: this.record.revision + 1,
      updatedAtIso,
    };
  }

  /** Issue the scoped acceptance receipt id and close the assessment. */
  accept(acceptanceReceiptId: string, updatedAtIso: string): void {
    if (!isNonEmptyTrimmedString(acceptanceReceiptId)) {
      throw new Error('Acceptance requires a non-empty receipt id');
    }
    if (this.isTerminal()) {
      throw new Error(`Cannot accept an assessment in terminal state '${this.record.state}'`);
    }
    this.record = {
      ...this.record,
      state: 'accepted',
      acceptanceReceiptId,
      blockers: [],
      revision: this.record.revision + 1,
      updatedAtIso,
    };
  }

  /** Record the explicit blocker list and hold the assessment open. */
  block(blockers: readonly string[], updatedAtIso: string): void {
    if (!Array.isArray(blockers) || !blockers.every(isNonEmptyTrimmedString)) {
      throw new Error('Blocking requires non-empty blocker strings');
    }
    this.record = {
      ...this.record,
      state: 'blocked',
      acceptanceReceiptId: null,
      blockers: [...blockers],
      revision: this.record.revision + 1,
      updatedAtIso,
    };
  }

  /** A changed head invalidates prior evidence. */
  markStale(updatedAtIso: string): void {
    this.record = {
      ...this.record,
      state: 'stale',
      acceptanceReceiptId: null,
      revision: this.record.revision + 1,
      updatedAtIso,
    };
  }

  reject(updatedAtIso: string): void {
    this.record = {
      ...this.record,
      state: 'rejected',
      acceptanceReceiptId: null,
      revision: this.record.revision + 1,
      updatedAtIso,
    };
  }

  toRecord(): EvidenceAssessmentRecord {
    return {
      ...this.record,
      requiredChecks: [...this.record.requiredChecks],
      verificationReceipts: [...this.record.verificationReceipts],
      reviewReceipts: [...this.record.reviewReceipts],
      findingDispositions: [...this.record.findingDispositions],
      blockers: [...this.record.blockers],
    };
  }
}
