// @generated entity stub — refined for migration step 3.
/**
 * KnowledgeCheck is a child entity of the KnowledgeEntry aggregate. It
 * records one bounded, orchestrator-chosen verification of one claim
 * version. Evidence is attributable — a check names the checker, the
 * procedure that ran and where the evidence lives; model confidence is
 * never evidence.
 */

import type { KnowledgeCheckRecord } from '../knowledge-records.js';
import type { KnowledgeVerificationValue } from '../value-objects/KnowledgeVerification.vo.js';
import { KnowledgeVerification } from '../value-objects/KnowledgeVerification.vo.js';

export class KnowledgeCheck {
  private constructor(private record: KnowledgeCheckRecord) {
    // Invariants are validated in fromRecord.
  }

  static fromRecord(record: KnowledgeCheckRecord): KnowledgeCheck {
    if (typeof record.id !== 'string' || record.id.trim().length === 0) {
      throw new Error('KnowledgeCheck requires a non-empty id');
    }
    if (typeof record.entryId !== 'string' || record.entryId.trim().length === 0) {
      throw new Error('KnowledgeCheck requires a non-empty entryId');
    }
    if (typeof record.checkerId !== 'string' || record.checkerId.trim().length === 0) {
      throw new Error('KnowledgeCheck requires a non-empty checkerId');
    }
    if (typeof record.procedureName !== 'string' || record.procedureName.trim().length === 0) {
      throw new Error('KnowledgeCheck requires a non-empty procedureName');
    }
    if (!KnowledgeVerification.create(record.verification).success) {
      throw new Error(`KnowledgeCheck has an invalid verification: ${String(record.verification)}`);
    }
    if (typeof record.evidenceRef !== 'string' || record.evidenceRef.trim().length === 0) {
      throw new Error('KnowledgeCheck requires a non-empty evidenceRef');
    }
    if (typeof record.checkedAtIso !== 'string' || record.checkedAtIso.trim().length === 0) {
      throw new Error('KnowledgeCheck requires a non-empty checkedAtIso');
    }
    return new KnowledgeCheck({ ...record });
  }

  getId(): string {
    return this.record.id;
  }

  getEntryId(): string {
    return this.record.entryId;
  }

  getCheckerId(): string {
    return this.record.checkerId;
  }

  getVerification(): KnowledgeVerificationValue {
    return this.record.verification;
  }

  /** Every check carries an evidence reference; absence is not a check. */
  hasEvidence(): boolean {
    return this.record.evidenceRef.trim().length > 0;
  }

  contradictsClaim(): boolean {
    return this.record.verification === 'contradicted';
  }

  toRecord(): KnowledgeCheckRecord {
    return { ...this.record };
  }
}
