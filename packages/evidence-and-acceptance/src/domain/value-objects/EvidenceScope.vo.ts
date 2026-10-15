// @generated value-object stub — refined for step 4.
/**
 * EvidenceScope is an immutable value object binding evidence to a project,
 * attempt, exact candidate head and acceptance-policy revision. Changed heads
 * make old evidence stale, so the scope is compared against the current head.
 */

export interface EvidenceScopeProps {
  readonly projectId: string;
  readonly attemptId: string;
  readonly candidateHeadSha: string;
  readonly policyRevision: string;
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class EvidenceScope {
  private constructor(private readonly props: EvidenceScopeProps) {
    // Value is immutable after construction.
  }

  static create(props: EvidenceScopeProps): {
    success: boolean;
    value?: EvidenceScope;
    error?: Error;
  } {
    if (
      !isNonEmptyTrimmedString(props.projectId) ||
      !isNonEmptyTrimmedString(props.attemptId) ||
      !isNonEmptyTrimmedString(props.candidateHeadSha) ||
      !isNonEmptyTrimmedString(props.policyRevision)
    ) {
      return {
        success: false,
        error: new Error(
          'EvidenceScope requires non-empty projectId, attemptId, candidateHeadSha and policyRevision',
        ),
      };
    }
    return {
      success: true,
      value: new EvidenceScope({
        projectId: props.projectId.trim(),
        attemptId: props.attemptId.trim(),
        candidateHeadSha: props.candidateHeadSha.trim(),
        policyRevision: props.policyRevision.trim(),
      }),
    };
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

  getProps(): EvidenceScopeProps {
    return this.props;
  }

  /** Evidence only matches the exact head it was produced for. */
  matchesHead(sha: string): boolean {
    return this.props.candidateHeadSha === sha;
  }

  equals(other: EvidenceScope): boolean {
    return (
      this.props.projectId === other.props.projectId &&
      this.props.attemptId === other.props.attemptId &&
      this.props.candidateHeadSha === other.props.candidateHeadSha &&
      this.props.policyRevision === other.props.policyRevision
    );
  }
}
