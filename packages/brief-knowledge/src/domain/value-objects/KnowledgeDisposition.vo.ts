// @generated value-object stub — refined for migration step 2.
/**
 * KnowledgeDisposition is an immutable value object over the manifest's
 * disposition enum. Capture only proposes candidate claims; becoming a
 * retrievable keeper requires a deliberate disposition, and
 * `policy-proposal` flags coordination items that this context never
 * promotes on its own.
 */

export const KNOWLEDGE_DISPOSITIONS = [
  'candidate',
  'accepted',
  'deferred',
  'rejected',
  'superseded',
  'policy-proposal',
] as const;

export type KnowledgeDispositionValue = (typeof KNOWLEDGE_DISPOSITIONS)[number];

const KNOWLEDGE_DISPOSITION_VALUES: readonly string[] = KNOWLEDGE_DISPOSITIONS;

export class KnowledgeDisposition {
  private constructor(private readonly value: KnowledgeDispositionValue) {
    // Value is immutable after construction.
  }

  static create(value: unknown): { success: boolean; value?: KnowledgeDisposition; error?: Error } {
    if (typeof value !== 'string' || !KNOWLEDGE_DISPOSITION_VALUES.includes(value)) {
      return { success: false, error: new Error(`Invalid knowledge disposition: ${String(value)}`) };
    }
    return { success: true, value: new KnowledgeDisposition(value as KnowledgeDispositionValue) };
  }

  getValue(): KnowledgeDispositionValue {
    return this.value;
  }

  /** Only deliberately accepted entries are retrievable keepers. */
  isRetrievableKeeper(): boolean {
    return this.value === 'accepted';
  }

  equals(other: KnowledgeDisposition): boolean {
    return this.value === other.value;
  }
}
