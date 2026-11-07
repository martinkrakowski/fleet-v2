/**
 * ReceiptSubjectKind is an immutable value object over the manifest's receipt
 * subject enum: a receipt is about an attempt, a chain or a brief. An unknown
 * kind is a failure result, never an exception and never a default.
 */

import { RECEIPT_SUBJECT_KINDS } from '../evidence-records.js';
import type { ReceiptSubjectKindValue } from '../evidence-records.js';

const RECEIPT_SUBJECT_KIND_VALUES: readonly string[] = RECEIPT_SUBJECT_KINDS;

export class ReceiptSubjectKind {
  private constructor(private readonly value: ReceiptSubjectKindValue) {
    // Value is immutable after construction.
  }

  static create(value: unknown): { success: boolean; value?: ReceiptSubjectKind; error?: Error } {
    if (typeof value !== 'string' || !RECEIPT_SUBJECT_KIND_VALUES.includes(value)) {
      return { success: false, error: new Error('Invalid receipt subject kind') };
    }
    return { success: true, value: new ReceiptSubjectKind(value as ReceiptSubjectKindValue) };
  }

  getValue(): ReceiptSubjectKindValue {
    return this.value;
  }

  equals(other: ReceiptSubjectKind): boolean {
    return this.value === other.value;
  }
}
