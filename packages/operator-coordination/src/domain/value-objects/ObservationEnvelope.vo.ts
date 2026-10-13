// @generated value-object stub — edit freely
/**
 * ObservationEnvelope is an immutable value object.
 *
 * Value objects:
 * - Are immutable (no setters)
 * - Are compared by value, not identity
 * - Contain validation logic
 * - Can be shared safely
 *
 * @example
 * const vo = ObservationEnvelope.create(rawValue);
 * if (vo.success) {
 *   // Use vo.value
 * }
 */
export class ObservationEnvelope {
  /**
   * Private constructor enforces factory pattern.
   * Use ObservationEnvelope.create() instead.
   */
  private constructor(private readonly value: unknown) {
    // Value is immutable after construction
  }

  /**
   * Factory method with validation.
   *
   * @param value - Raw value to wrap
   * @returns Result containing ObservationEnvelope or validation error
   *
   * TODO: Implement validation logic
   * Example:
   * static create(value: string): Result<ObservationEnvelope, Error> {
   *   if (!value || value.length === 0) {
   *     return { success: false, error: new Error('Value cannot be empty') };
   *   }
   *   return { success: true, value: new ObservationEnvelope(value) };
   * }
   */
  static create(value: unknown): { success: boolean; value?: ObservationEnvelope; error?: Error } {
    // TODO: Add validation
    return { success: true, value: new ObservationEnvelope(value) };
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
  equals(other: ObservationEnvelope): boolean {
    return this.value === other.value;
  }
}
