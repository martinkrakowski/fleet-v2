// @generated value-object stub — edit freely
/**
 * KnowledgeDisposition is an immutable value object.
 *
 * Value objects:
 * - Are immutable (no setters)
 * - Are compared by value, not identity
 * - Contain validation logic
 * - Can be shared safely
 *
 * @example
 * const vo = KnowledgeDisposition.create(rawValue);
 * if (vo.success) {
 *   // Use vo.value
 * }
 */
export class KnowledgeDisposition {
  /**
   * Private constructor enforces factory pattern.
   * Use KnowledgeDisposition.create() instead.
   */
  private constructor(private readonly value: unknown) {
    // Value is immutable after construction
  }

  /**
   * Factory method with validation.
   *
   * @param value - Raw value to wrap
   * @returns Result containing KnowledgeDisposition or validation error
   *
   * TODO: Implement validation logic
   * Example:
   * static create(value: string): Result<KnowledgeDisposition, Error> {
   *   if (!value || value.length === 0) {
   *     return { success: false, error: new Error('Value cannot be empty') };
   *   }
   *   return { success: true, value: new KnowledgeDisposition(value) };
   * }
   */
  static create(value: unknown): { success: boolean; value?: KnowledgeDisposition; error?: Error } {
    // TODO: Add validation
    return { success: true, value: new KnowledgeDisposition(value) };
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
  equals(other: KnowledgeDisposition): boolean {
    return this.value === other.value;
  }
}
