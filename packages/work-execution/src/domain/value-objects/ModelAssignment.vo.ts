// @generated value-object stub — refined for migration step 1.
/**
 * ModelAssignment is an immutable value object: model, variant and fallback
 * as bound in the brief manifest. Host seat names are installation and never
 * enter this value object.
 */

export interface ModelAssignmentProps {
  readonly model: string;
  readonly variant: string;
  readonly fallbackModel: string;
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class ModelAssignment {
  private constructor(private readonly props: ModelAssignmentProps) {
    // Value is immutable after construction.
  }

  static create(props: ModelAssignmentProps): {
    success: boolean;
    value?: ModelAssignment;
    error?: Error;
  } {
    if (
      !isNonEmptyTrimmedString(props.model) ||
      !isNonEmptyTrimmedString(props.variant) ||
      !isNonEmptyTrimmedString(props.fallbackModel)
    ) {
      return {
        success: false,
        error: new Error('ModelAssignment requires non-empty model, variant and fallbackModel'),
      };
    }
    return {
      success: true,
      value: new ModelAssignment({
        model: props.model.trim(),
        variant: props.variant.trim(),
        fallbackModel: props.fallbackModel.trim(),
      }),
    };
  }

  getModel(): string {
    return this.props.model;
  }

  getVariant(): string {
    return this.props.variant;
  }

  getFallbackModel(): string {
    return this.props.fallbackModel;
  }

  getProps(): ModelAssignmentProps {
    return this.props;
  }

  equals(other: ModelAssignment): boolean {
    return (
      this.props.model === other.props.model &&
      this.props.variant === other.props.variant &&
      this.props.fallbackModel === other.props.fallbackModel
    );
  }
}
