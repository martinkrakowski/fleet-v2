// @generated value-object stub — refined for migration step 2.
/**
 * RetrievalBudget is an immutable value object over the explicit positive
 * retrieval bounds. Keeper proposals never exceed maxEntries or the
 * maxTotalChars character budget.
 */

export interface RetrievalBudgetProps {
  readonly maxEntries: number;
  readonly maxTotalChars: number;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export class RetrievalBudget {
  private constructor(private readonly props: RetrievalBudgetProps) {
    // Value is immutable after construction.
  }

  static create(props: RetrievalBudgetProps): {
    success: boolean;
    value?: RetrievalBudget;
    error?: Error;
  } {
    if (!isPositiveInteger(props.maxEntries)) {
      return { success: false, error: new Error('RetrievalBudget requires a positive integer maxEntries') };
    }
    if (!isPositiveInteger(props.maxTotalChars)) {
      return { success: false, error: new Error('RetrievalBudget requires a positive integer maxTotalChars') };
    }
    return { success: true, value: new RetrievalBudget({ ...props }) };
  }

  getMaxEntries(): number {
    return this.props.maxEntries;
  }

  getMaxTotalChars(): number {
    return this.props.maxTotalChars;
  }

  getProps(): RetrievalBudgetProps {
    return { ...this.props };
  }

  equals(other: RetrievalBudget): boolean {
    return this.props.maxEntries === other.props.maxEntries && this.props.maxTotalChars === other.props.maxTotalChars;
  }
}
