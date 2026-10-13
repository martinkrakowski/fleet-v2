// @generated value-object stub — edit freely
/**
 * ExecutionLimits is an immutable value object.
 *
 * Value objects:
 * - Are immutable (no setters)
 * - Are compared by value, not identity
 * - Contain validation logic
 * - Can be shared safely
 *
 * @example
 * const vo = ExecutionLimits.create(rawValue);
 * if (vo.success) {
 *   // Use vo.value
 * }
 */
export class ExecutionLimits {
  /**
   * Private constructor enforces factory pattern.
   * Use ExecutionLimits.create() instead.
   */
  private constructor(private readonly value: unknown) {
    // Value is immutable after construction
  }

  /**
   * Factory method with validation.
   *
   * @param value - Raw value to wrap
   * @returns Result containing ExecutionLimits or validation error
   *
   * TODO: Implement validation logic
   * Example:
   * static create(value: string): Result<ExecutionLimits, Error> {
   *   if (!value || value.length === 0) {
   *     return { success: false, error: new Error('Value cannot be empty') };
   *   }
   *   return { success: true, value: new ExecutionLimits(value) };
   * }
   */
  static create(value: unknown): { success: boolean; value?: ExecutionLimits; error?: Error } {
    // TODO: Add validation
    return { success: true, value: new ExecutionLimits(value) };
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
  equals(other: ExecutionLimits): boolean {
    return this.value === other.value;
  }
}
