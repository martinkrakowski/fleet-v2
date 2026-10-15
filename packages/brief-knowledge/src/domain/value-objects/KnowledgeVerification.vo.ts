// @generated value-object stub — refined for migration step 2.
/**
 * KnowledgeVerification is an immutable value object over the manifest's
 * verification enum. Verification records evidence gathered by a bounded,
 * orchestrator-chosen check — never model confidence.
 */

export const KNOWLEDGE_VERIFICATIONS = ['unverified', 'supported', 'contradicted', 'stale'] as const;

export type KnowledgeVerificationValue = (typeof KNOWLEDGE_VERIFICATIONS)[number];

const KNOWLEDGE_VERIFICATION_VALUES: readonly string[] = KNOWLEDGE_VERIFICATIONS;

export class KnowledgeVerification {
  private constructor(private readonly value: KnowledgeVerificationValue) {
    // Value is immutable after construction.
  }

  static create(value: unknown): { success: boolean; value?: KnowledgeVerification; error?: Error } {
    if (typeof value !== 'string' || !KNOWLEDGE_VERIFICATION_VALUES.includes(value)) {
      return { success: false, error: new Error(`Invalid knowledge verification: ${String(value)}`) };
    }
    return { success: true, value: new KnowledgeVerification(value as KnowledgeVerificationValue) };
  }

  getValue(): KnowledgeVerificationValue {
    return this.value;
  }

  /** Acceptance requires a supported check; unverified claims stay candidates. */
  isSupported(): boolean {
    return this.value === 'supported';
  }

  equals(other: KnowledgeVerification): boolean {
    return this.value === other.value;
  }
}
