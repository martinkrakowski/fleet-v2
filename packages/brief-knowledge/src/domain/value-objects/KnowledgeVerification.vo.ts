// @generated value-object stub — edit freely
/**
 * KnowledgeVerification is an immutable value object.
 *
 * Value objects:
 * - Are immutable (no setters)
 * - Are compared by value, not identity
 * - Contain validation logic
 * - Can be shared safely
 *
 * @example
 * const vo = KnowledgeVerification.create(rawValue);
 * if (vo.success) {
 *   // Use vo.value
 * }
 */
export class KnowledgeVerification {
  /**
   * Private constructor enforces factory pattern.
   * Use KnowledgeVerification.create() instead.
   */
  private constructor(private readonly value: unknown) {
    // Value is immutable after construction
  }

  /**
   * Factory method with validation.
   *
   * @param value - Raw value to wrap
   * @returns Result containing KnowledgeVerification or validation error
   *
   * TODO: Implement validation logic
   * Example:
   * static create(value: string): Result<KnowledgeVerification, Error> {
   *   if (!value || value.length === 0) {
   *     return { success: false, error: new Error('Value cannot be empty') };
   *   }
   *   return { success: true, value: new KnowledgeVerification(value) };
   * }
   */
  static create(value: unknown): { success: boolean; value?: KnowledgeVerification; error?: Error } {
    // TODO: Add validation
    return { success: true, value: new KnowledgeVerification(value) };
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
  equals(other: KnowledgeVerification): boolean {
    return this.value === other.value;
  }
}
