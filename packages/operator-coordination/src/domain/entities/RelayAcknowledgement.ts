// @generated entity stub — refined for step 5.
/**
 * RelayAcknowledgement is the child record of an actual recipient response.
 * Transport delivery is not acknowledgement and silence is not a response, so
 * an acknowledgement always carries the recipient it came from and the
 * provenance of that response.
 */

import type { RelayAcknowledgementRecord } from '../coordination-records.js';

export class RelayAcknowledgement {
  private constructor(private readonly record: RelayAcknowledgementRecord) {
    // Invariants are validated in fromRecord.
  }

  static fromRecord(record: RelayAcknowledgementRecord): RelayAcknowledgement {
    if (typeof record !== 'object' || record === null) {
      throw new Error('RelayAcknowledgement requires a record');
    }
    for (const field of [
      'acknowledgementId',
      'requestId',
      'recipientId',
      'responseSummary',
      'provenance',
      'acknowledgedAtIso',
    ] as const) {
      const value = record[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`RelayAcknowledgement requires a non-empty ${field}`);
      }
    }
    return new RelayAcknowledgement({ ...record });
  }

  getId(): string {
    return this.record.acknowledgementId;
  }

  toRecord(): RelayAcknowledgementRecord {
    return { ...this.record };
  }

  getRecipientId(): string {
    return this.record.recipientId;
  }

  isFromRecipient(recipientId: string): boolean {
    return this.record.recipientId === recipientId;
  }

  equals(other: RelayAcknowledgement): boolean {
    return this.record.acknowledgementId === other.record.acknowledgementId;
  }
}
