// @generated entity stub — refined for migration step 3.
/**
 * KnowledgeReuse is a child entity of the KnowledgeEntry aggregate. It
 * records one reuse of one entry version in one attempt. Context inclusion
 * alone does not prove saved work; only demonstrated benefit counts as
 * `helped`, and wrong turns keep harmful lessons out of future briefs.
 */

import type { KnowledgeReuseRecord } from '../knowledge-records.js';
import type { KnowledgeReuseOutcomeValue } from '../value-objects/KnowledgeReuseOutcome.vo.js';
import { KnowledgeReuseOutcome } from '../value-objects/KnowledgeReuseOutcome.vo.js';

export class KnowledgeReuse {
  private constructor(private record: KnowledgeReuseRecord) {
    // Invariants are validated in fromRecord.
  }

  static fromRecord(record: KnowledgeReuseRecord): KnowledgeReuse {
    if (typeof record.id !== 'string' || record.id.trim().length === 0) {
      throw new Error('KnowledgeReuse requires a non-empty id');
    }
    if (typeof record.entryId !== 'string' || record.entryId.trim().length === 0) {
      throw new Error('KnowledgeReuse requires a non-empty entryId');
    }
    if (typeof record.version !== 'string' || record.version.trim().length === 0) {
      throw new Error('KnowledgeReuse requires a non-empty version');
    }
    if (typeof record.attemptId !== 'string' || record.attemptId.trim().length === 0) {
      throw new Error('KnowledgeReuse requires a non-empty attemptId');
    }
    if (!KnowledgeReuseOutcome.create(record.outcome).success) {
      throw new Error(`KnowledgeReuse has an invalid outcome: ${String(record.outcome)}`);
    }
    if (record.evidenceRef !== null && (typeof record.evidenceRef !== 'string' || record.evidenceRef.trim().length === 0)) {
      throw new Error('KnowledgeReuse evidenceRef must be null or a non-empty string');
    }
    if (typeof record.recordedAtIso !== 'string' || record.recordedAtIso.trim().length === 0) {
      throw new Error('KnowledgeReuse requires a non-empty recordedAtIso');
    }
    return new KnowledgeReuse({ ...record });
  }

  getId(): string {
    return this.record.id;
  }

  getEntryId(): string {
    return this.record.entryId;
  }

  getVersion(): string {
    return this.record.version;
  }

  getAttemptId(): string {
    return this.record.attemptId;
  }

  getOutcome(): KnowledgeReuseOutcomeValue {
    return this.record.outcome;
  }

  hasEvidence(): boolean {
    return this.record.evidenceRef !== null && this.record.evidenceRef.trim().length > 0;
  }

  /** Demonstrated benefit; inclusion alone is not saved work. */
  demonstratesBenefit(): boolean {
    return this.record.outcome === 'helped';
  }

  /** A wrong turn keeps this lesson out of future briefs. */
  wasWrongTurn(): boolean {
    return this.record.outcome === 'wrong-turn';
  }

  toRecord(): KnowledgeReuseRecord {
    return { ...this.record };
  }
}
