// @generated value-object stub — refined for step 4.
/**
 * AcceptanceReceipt is an immutable value object: the scoped, immutable proof
 * that a specific candidate head was accepted under a specific acceptance
 * policy revision. It carries no verdict logic; issuing it is a decision.
 */

export interface AcceptanceReceiptProps {
  readonly receiptId: string;
  readonly assessmentId: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly candidateHeadSha: string;
  readonly policyRevision: string;
  readonly issuedAtIso: string;
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class AcceptanceReceipt {
  private constructor(private readonly props: AcceptanceReceiptProps) {
    // Value is immutable after construction.
  }

  static create(props: AcceptanceReceiptProps): {
    success: boolean;
    value?: AcceptanceReceipt;
    error?: Error;
  } {
    if (
      !isNonEmptyTrimmedString(props.receiptId) ||
      !isNonEmptyTrimmedString(props.assessmentId) ||
      !isNonEmptyTrimmedString(props.projectId) ||
      !isNonEmptyTrimmedString(props.attemptId) ||
      !isNonEmptyTrimmedString(props.candidateHeadSha) ||
      !isNonEmptyTrimmedString(props.policyRevision) ||
      !isNonEmptyTrimmedString(props.issuedAtIso)
    ) {
      return {
        success: false,
        error: new Error(
          'AcceptanceReceipt requires non-empty receiptId, assessmentId, projectId, attemptId, candidateHeadSha, policyRevision and issuedAtIso',
        ),
      };
    }
    return {
      success: true,
      value: new AcceptanceReceipt({
        receiptId: props.receiptId.trim(),
        assessmentId: props.assessmentId.trim(),
        projectId: props.projectId.trim(),
        attemptId: props.attemptId.trim(),
        candidateHeadSha: props.candidateHeadSha.trim(),
        policyRevision: props.policyRevision.trim(),
        issuedAtIso: props.issuedAtIso.trim(),
      }),
    };
  }

  getReceiptId(): string {
    return this.props.receiptId;
  }

  getAssessmentId(): string {
    return this.props.assessmentId;
  }

  getProjectId(): string {
    return this.props.projectId;
  }

  getAttemptId(): string {
    return this.props.attemptId;
  }

  getCandidateHeadSha(): string {
    return this.props.candidateHeadSha;
  }

  getPolicyRevision(): string {
    return this.props.policyRevision;
  }

  getIssuedAtIso(): string {
    return this.props.issuedAtIso;
  }

  getProps(): AcceptanceReceiptProps {
    return this.props;
  }

  equals(other: AcceptanceReceipt): boolean {
    return (
      this.props.receiptId === other.props.receiptId &&
      this.props.assessmentId === other.props.assessmentId &&
      this.props.projectId === other.props.projectId &&
      this.props.attemptId === other.props.attemptId &&
      this.props.candidateHeadSha === other.props.candidateHeadSha &&
      this.props.policyRevision === other.props.policyRevision &&
      this.props.issuedAtIso === other.props.issuedAtIso
    );
  }
}
