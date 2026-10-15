// @generated value-object stub — refined for migration step 2.
/**
 * ContextSelection is an immutable value object recording the orchestrator's
 * decision about one proposed knowledge entry before context is frozen. The
 * reason is mandatory provenance: selection is an observation with an
 * accountable decision, never automatic authority.
 */

export interface ContextSelectionProps {
  readonly attemptId: string;
  readonly knowledgeEntryId: string;
  readonly version: string;
  readonly accepted: boolean;
  readonly decisionBecause: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class ContextSelection {
  private constructor(private readonly props: ContextSelectionProps) {
    // Value is immutable after construction.
  }

  static create(props: ContextSelectionProps): {
    success: boolean;
    value?: ContextSelection;
    error?: Error;
  } {
    if (!isNonEmptyString(props.attemptId)) {
      return { success: false, error: new Error('ContextSelection requires a non-empty attemptId') };
    }
    if (!isNonEmptyString(props.knowledgeEntryId)) {
      return { success: false, error: new Error('ContextSelection requires a non-empty knowledgeEntryId') };
    }
    if (!isNonEmptyString(props.version)) {
      return { success: false, error: new Error('ContextSelection requires a non-empty version') };
    }
    if (typeof props.accepted !== 'boolean') {
      return { success: false, error: new Error('ContextSelection requires a boolean accepted') };
    }
    if (!isNonEmptyString(props.decisionBecause)) {
      return { success: false, error: new Error('ContextSelection requires a non-empty decisionBecause') };
    }
    return { success: true, value: new ContextSelection({ ...props }) };
  }

  getAttemptId(): string {
    return this.props.attemptId;
  }

  getKnowledgeEntryId(): string {
    return this.props.knowledgeEntryId;
  }

  getVersion(): string {
    return this.props.version;
  }

  isAccepted(): boolean {
    return this.props.accepted;
  }

  getDecisionBecause(): string {
    return this.props.decisionBecause;
  }

  getProps(): ContextSelectionProps {
    return { ...this.props };
  }

  equals(other: ContextSelection): boolean {
    return (
      this.props.attemptId === other.props.attemptId &&
      this.props.knowledgeEntryId === other.props.knowledgeEntryId &&
      this.props.version === other.props.version &&
      this.props.accepted === other.props.accepted &&
      this.props.decisionBecause === other.props.decisionBecause
    );
  }
}
