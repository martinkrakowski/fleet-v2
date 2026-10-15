// @generated value-object stub — refined for step 5.
/**
 * ActionAuthorization is an immutable value object binding one grant to the
 * proposal digest, project, exact action scope, expected commit, policy
 * revision and decision revision. A signed answer authorizes only that exact
 * action; it never becomes authority for an unrelated or privileged action.
 */

export interface ActionAuthorizationProps {
  readonly grantId: string;
  readonly projectId: string;
  readonly actionScope: string;
  readonly expectedHeadSha: string;
  readonly policyRevision: string;
  readonly decisionRevision: string;
  readonly consumed: boolean;
}

const REQUIRED_FIELDS = [
  'grantId',
  'projectId',
  'actionScope',
  'expectedHeadSha',
  'policyRevision',
  'decisionRevision',
] as const;

export class ActionAuthorization {
  private constructor(private readonly props: ActionAuthorizationProps) {
    // Value is immutable after construction.
  }

  static create(
    props: unknown,
  ): { success: boolean; value?: ActionAuthorization; error?: Error } {
    if (typeof props !== 'object' || props === null) {
      return { success: false, error: new Error('ActionAuthorization requires props') };
    }
    const candidate = props as Partial<ActionAuthorizationProps>;
    for (const field of REQUIRED_FIELDS) {
      const value = candidate[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        return {
          success: false,
          error: new Error(`ActionAuthorization requires a non-empty ${field}`),
        };
      }
    }
    if (typeof candidate.consumed !== 'boolean') {
      return { success: false, error: new Error('ActionAuthorization requires a boolean consumed') };
    }
    return {
      success: true,
      value: new ActionAuthorization({
        grantId: candidate.grantId as string,
        projectId: candidate.projectId as string,
        actionScope: candidate.actionScope as string,
        expectedHeadSha: candidate.expectedHeadSha as string,
        policyRevision: candidate.policyRevision as string,
        decisionRevision: candidate.decisionRevision as string,
        consumed: candidate.consumed as boolean,
      }),
    };
  }

  getProps(): ActionAuthorizationProps {
    return { ...this.props };
  }

  getGrantId(): string {
    return this.props.grantId;
  }

  /**
   * The grant applies only to the exact action scope and expected commit it
   * recorded. A different scope or a moved head is a different action.
   */
  matchesAction(actionScope: string, expectedHeadSha: string): boolean {
    return (
      this.props.actionScope === actionScope && this.props.expectedHeadSha === expectedHeadSha
    );
  }

  /** A consumed grant is durably bound to one action and never re-authorizes it. */
  isConsumed(): boolean {
    return this.props.consumed;
  }

  equals(other: ActionAuthorization): boolean {
    return (
      this.props.grantId === other.props.grantId &&
      this.props.projectId === other.props.projectId &&
      this.props.actionScope === other.props.actionScope &&
      this.props.expectedHeadSha === other.props.expectedHeadSha &&
      this.props.policyRevision === other.props.policyRevision &&
      this.props.decisionRevision === other.props.decisionRevision &&
      this.props.consumed === other.props.consumed
    );
  }
}
