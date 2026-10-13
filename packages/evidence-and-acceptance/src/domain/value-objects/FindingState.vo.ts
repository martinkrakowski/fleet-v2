// @generated value-object stub — edit freely
/**
 * FindingState is an immutable value object.
 *
 * Value objects:
 * - Are immutable (no setters)
 * - Are compared by value, not identity
 * - Contain validation logic
 * - Can be shared safely
 *
 * @example
 * const vo = FindingState.create(rawValue);
 * if (vo.success) {
 *   // Use vo.value
 * }
 */
export class FindingState {
  /**
   * Private constructor enforces factory pattern.
   * Use FindingState.create() instead.
   */
  private constructor(private readonly value: unknown) {
    // Value is immutable after construction
  }

  /**
   * Factory method with validation.
   *
   * @param value - Raw value to wrap
   * @returns Result containing FindingState or validation error
   *
   * TODO: Implement validation logic
   * Example:
   * static create(value: string): Result<FindingState, Error> {
   *   if (!value || value.length === 0) {
   *     return { success: false, error: new Error('Value cannot be empty') };
   *   }
   *   return { success: true, value: new FindingState(value) };
   * }
   */
  static create(value: unknown): { success: boolean; value?: FindingState; error?: Error } {
    // TODO: Add validation
    return { success: true, value: new FindingState(value) };
  }

  /**
   * Get the wrapped value.
   */
  getValue(): unknown {
    return this.value;
  }

  /**
   * Value objects are compared by value.
   */
  equals(other: FindingState): boolean {
    return this.value === other.value;
  }
}
