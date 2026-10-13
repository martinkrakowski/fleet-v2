// @generated value-object stub — edit freely
/**
 * ContextSelection is an immutable value object.
 *
 * Value objects:
 * - Are immutable (no setters)
 * - Are compared by value, not identity
 * - Contain validation logic
 * - Can be shared safely
 *
 * @example
 * const vo = ContextSelection.create(rawValue);
 * if (vo.success) {
 *   // Use vo.value
 * }
 */
export class ContextSelection {
  /**
   * Private constructor enforces factory pattern.
   * Use ContextSelection.create() instead.
   */
  private constructor(private readonly value: unknown) {
    // Value is immutable after construction
  }

  /**
   * Factory method with validation.
   *
   * @param value - Raw value to wrap
   * @returns Result containing ContextSelection or validation error
   *
   * TODO: Implement validation logic
   * Example:
   * static create(value: string): Result<ContextSelection, Error> {
   *   if (!value || value.length === 0) {
   *     return { success: false, error: new Error('Value cannot be empty') };
   *   }
   *   return { success: true, value: new ContextSelection(value) };
   * }
   */
  static create(value: unknown): { success: boolean; value?: ContextSelection; error?: Error } {
    // TODO: Add validation
    return { success: true, value: new ContextSelection(value) };
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
  equals(other: ContextSelection): boolean {
    return this.value === other.value;
  }
}
