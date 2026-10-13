// @generated value-object stub — edit freely
/**
 * ActionAuthorization is an immutable value object.
 *
 * Value objects:
 * - Are immutable (no setters)
 * - Are compared by value, not identity
 * - Contain validation logic
 * - Can be shared safely
 *
 * @example
 * const vo = ActionAuthorization.create(rawValue);
 * if (vo.success) {
 *   // Use vo.value
 * }
 */
export class ActionAuthorization {
  /**
   * Private constructor enforces factory pattern.
   * Use ActionAuthorization.create() instead.
   */
  private constructor(private readonly value: unknown) {
    // Value is immutable after construction
  }

  /**
   * Factory method with validation.
   *
   * @param value - Raw value to wrap
   * @returns Result containing ActionAuthorization or validation error
   *
   * TODO: Implement validation logic
   * Example:
   * static create(value: string): Result<ActionAuthorization, Error> {
   *   if (!value || value.length === 0) {
   *     return { success: false, error: new Error('Value cannot be empty') };
   *   }
   *   return { success: true, value: new ActionAuthorization(value) };
   * }
   */
  static create(value: unknown): { success: boolean; value?: ActionAuthorization; error?: Error } {
    // TODO: Add validation
    return { success: true, value: new ActionAuthorization(value) };
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
  equals(other: ActionAuthorization): boolean {
    return this.value === other.value;
  }
}
