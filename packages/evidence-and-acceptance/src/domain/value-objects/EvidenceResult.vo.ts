// @generated value-object stub — refined for step 4.
/**
 * EvidenceResult is an immutable value object over the manifest's evidence
 * enum. Unknown, stale or incomplete evidence does not pass: only `pass` and
 * `not-applicable` count as passing outcomes.
 */

export const EVIDENCE_RESULTS = [
  'pending',
  'pass',
  'fail',
  'unknown',
  'not-applicable',
] as const;

export type EvidenceResultValue = (typeof EVIDENCE_RESULTS)[number];

const EVIDENCE_RESULT_VALUES: readonly string[] = EVIDENCE_RESULTS;

const PASSING_RESULTS: readonly EvidenceResultValue[] = ['pass', 'not-applicable'];

export class EvidenceResult {
  private constructor(private readonly value: EvidenceResultValue) {
    // Value is immutable after construction.
  }

  static create(value: unknown): { success: boolean; value?: EvidenceResult; error?: Error } {
    if (typeof value !== 'string' || !EVIDENCE_RESULT_VALUES.includes(value)) {
      return { success: false, error: new Error(`Invalid evidence result: ${String(value)}`) };
    }
    return { success: true, value: new EvidenceResult(value as EvidenceResultValue) };
  }

  getValue(): EvidenceResultValue {
    return this.value;
  }

  /**
   * Pending, fail and unknown never become an implicit pass. Only a completed
   * pass, or a check that explicitly does not apply, satisfies a requirement.
   */
  isPassing(): boolean {
    return PASSING_RESULTS.includes(this.value);
  }

  equals(other: EvidenceResult): boolean {
    return this.value === other.value;
  }
}
