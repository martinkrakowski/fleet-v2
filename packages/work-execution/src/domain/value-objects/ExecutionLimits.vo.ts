// @generated value-object stub — refined for migration step 1.
/**
 * ExecutionLimits is an immutable value object over the brief's step, time and
 * resource bounds. Limits are positive; the kernel receives them as inputs
 * and infrastructure enforces them.
 */

export interface ExecutionLimitsProps {
  readonly stepLimit: number;
  readonly timeLimitSeconds: number;
  readonly resourceBounds: Readonly<Record<string, string>>;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export class ExecutionLimits {
  private constructor(private readonly props: ExecutionLimitsProps) {
    // Value is immutable after construction.
  }

  static create(props: ExecutionLimitsProps): {
    success: boolean;
    value?: ExecutionLimits;
    error?: Error;
  } {
    if (!isPositiveFinite(props.stepLimit) || !isPositiveFinite(props.timeLimitSeconds)) {
      return {
        success: false,
        error: new Error('ExecutionLimits requires stepLimit > 0 and timeLimitSeconds > 0'),
      };
    }
    if (props.resourceBounds === null || typeof props.resourceBounds !== 'object') {
      return { success: false, error: new Error('ExecutionLimits requires resourceBounds') };
    }
    return { success: true, value: new ExecutionLimits({ ...props, resourceBounds: { ...props.resourceBounds } }) };
  }

  getStepLimit(): number {
    return this.props.stepLimit;
  }

  getTimeLimitSeconds(): number {
    return this.props.timeLimitSeconds;
  }

  getResourceBounds(): Readonly<Record<string, string>> {
    return this.props.resourceBounds;
  }

  getProps(): ExecutionLimitsProps {
    return this.props;
  }

  equals(other: ExecutionLimits): boolean {
    return (
      this.props.stepLimit === other.props.stepLimit &&
      this.props.timeLimitSeconds === other.props.timeLimitSeconds &&
      shallowEqualRecords(this.props.resourceBounds, other.props.resourceBounds)
    );
  }
}

function shallowEqualRecords(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => left[key] === right[key]);
}
