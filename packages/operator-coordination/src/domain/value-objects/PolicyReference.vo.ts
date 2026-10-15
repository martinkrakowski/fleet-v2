// @generated value-object stub — refined for step 5.
/**
 * PolicyReference is an immutable value object pointing at one owner-approved
 * policy revision. Policy prose never becomes machine authority: only the
 * revision an owner approved is referenced, never a secret or a token.
 */

export interface PolicyReferenceProps {
  readonly policyId: string;
  readonly revision: string;
  readonly approvedBy: string;
}

export class PolicyReference {
  private constructor(private readonly props: PolicyReferenceProps) {
    // Value is immutable after construction.
  }

  static create(props: unknown): { success: boolean; value?: PolicyReference; error?: Error } {
    if (typeof props !== 'object' || props === null) {
      return { success: false, error: new Error('PolicyReference requires props') };
    }
    const candidate = props as Partial<PolicyReferenceProps>;
    for (const field of ['policyId', 'revision', 'approvedBy'] as const) {
      const value = candidate[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        return {
          success: false,
          error: new Error(`PolicyReference requires a non-empty ${field}`),
        };
      }
    }
    return {
      success: true,
      value: new PolicyReference({
        policyId: candidate.policyId as string,
        revision: candidate.revision as string,
        approvedBy: candidate.approvedBy as string,
      }),
    };
  }

  getProps(): PolicyReferenceProps {
    return { ...this.props };
  }

  getPolicyId(): string {
    return this.props.policyId;
  }

  getRevision(): string {
    return this.props.revision;
  }

  getApprovedBy(): string {
    return this.props.approvedBy;
  }

  /** A later policy revision is a different authority, never an equivalent one. */
  matches(other: PolicyReference): boolean {
    return (
      this.props.policyId === other.props.policyId && this.props.revision === other.props.revision
    );
  }

  equals(other: PolicyReference): boolean {
    return (
      this.props.policyId === other.props.policyId &&
      this.props.revision === other.props.revision &&
      this.props.approvedBy === other.props.approvedBy
    );
  }
}
