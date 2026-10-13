// @generated value-object stub — edit freely
/**
 * AttemptOutcome is an immutable value object.
 *
 * Value objects:
 * - Are immutable (no setters)
 * - Are compared by value, not identity
 * - Contain validation logic
 * - Can be shared safely
 *
 * @example
 * const vo = AttemptOutcome.create(rawValue);
 * if (vo.success) {
 *   // Use vo.value
 * }
 */
export class AttemptOutcome {
  /**
   * Private constructor enforces factory pattern.
   * Use AttemptOutcome.create() instead.
   */
  private constructor(private readonly value: unknown) {
    // Value is immutable after construction
  }

  /**
   * Factory method with validation.
   *
   * @param value - Raw value to wrap
   * @returns Result containing AttemptOutcome or validation error
   *
   * TODO: Implement validation logic
   * Example:
   * static create(value: string): Result<AttemptOutcome, Error> {
   *   if (!value || value.length === 0) {
   *     return { success: false, error: new Error('Value cannot be empty') };
   *   }
   *   return { success: true, value: new AttemptOutcome(value) };
   * }
   */
  static create(value: unknown): { success: boolean; value?: AttemptOutcome; error?: Error } {
    // TODO: Add validation
    return { success: true, value: new AttemptOutcome(value) };
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
  equals(other: AttemptOutcome): boolean {
    return this.value === other.value;
  }
}
