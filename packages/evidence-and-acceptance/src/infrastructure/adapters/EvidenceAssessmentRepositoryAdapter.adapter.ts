// @generated adapter stub — signature-matched for step 4 (no behaviour).
/**
 * EvidenceAssessmentRepositoryAdapter implements EvidenceAssessmentRepositoryPort.
 * Behaviour lands with the station implementation; every method refuses.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  EvidenceAssessmentRecord,
} from '../../domain/evidence-records.js';
import type { EvidenceAssessmentRepositoryPort } from '../../application/ports/out/EvidenceAssessmentRepositoryPort.out-port.js';

export interface EvidenceAssessmentRepositoryOptions {
  /** When set, assessments are also persisted as `assessments.json`. */
  readonly stateDir?: string;
}

const STATE_FILE = 'assessments.json';

function copyRecord(record: EvidenceAssessmentRecord): EvidenceAssessmentRecord {
  return {
    ...record,
    requiredChecks: [...record.requiredChecks],
    verificationReceipts: record.verificationReceipts.map((receipt) => ({ ...receipt })),
    reviewReceipts: record.reviewReceipts.map((receipt) => ({
      ...receipt,
      findings: receipt.findings.map((finding) => ({ ...finding })),
    })),
    findingDispositions: record.findingDispositions.map((disposition) => ({ ...disposition })),
    blockers: [...record.blockers],
  };
}

function isAssessmentRecord(value: unknown): value is EvidenceAssessmentRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { revision?: unknown }).revision === 'number'
  );
}

export class EvidenceAssessmentRepositoryAdapter implements EvidenceAssessmentRepositoryPort {
  private readonly assessments = new Map<string, EvidenceAssessmentRecord>();

  constructor(private readonly options: EvidenceAssessmentRepositoryOptions = {}) {
    this.restore();
  }

  /**
   * Revision-aware update: a write only lands when it moves the stored
   * revision forward, so concurrent writers cannot silently overwrite
   * evidence that a later decision already superseded.
   */
  async saveAssessment(record: EvidenceAssessmentRecord): Promise<void> {
    const existing = this.assessments.get(record.id);
    if (existing !== undefined && record.revision <= existing.revision) {
      throw new Error(
        `Optimistic concurrency conflict for assessment ${record.id}: revision ${record.revision} does not advance stored revision ${existing.revision}`,
      );
    }
    this.assessments.set(record.id, copyRecord(record));
    this.persist();
  }

  async findAssessmentById(assessmentId: string): Promise<EvidenceAssessmentRecord | null> {
    const found = this.assessments.get(assessmentId);
    return found === undefined ? null : copyRecord(found);
  }

  async findAssessmentByHead(candidateHeadSha: string): Promise<EvidenceAssessmentRecord | null> {
    for (const record of this.assessments.values()) {
      if (record.candidateHeadSha === candidateHeadSha) {
        return copyRecord(record);
      }
    }
    return null;
  }

  private get stateFilePath(): string | null {
    const stateDir = this.options.stateDir;
    return stateDir === undefined ? null : join(stateDir, STATE_FILE);
  }

  private restore(): void {
    const stateFilePath = this.stateFilePath;
    if (stateFilePath === null) {
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(stateFilePath, 'utf8');
    } catch {
      // No persisted state yet; the in-memory store starts empty.
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Unreadable state is not silently reinterpreted as acceptance.
      return;
    }
    const records = Array.isArray(parsed) ? parsed : [];
    for (const record of records) {
      if (isAssessmentRecord(record)) {
        this.assessments.set(record.id, copyRecord(record));
      }
    }
  }

  private persist(): void {
    const stateFilePath = this.stateFilePath;
    if (stateFilePath === null) {
      return;
    }
    mkdirSync(dirname(stateFilePath), { recursive: true });
    writeFileSync(stateFilePath, `${JSON.stringify([...this.assessments.values()], null, 2)}\n`, 'utf8');
  }
}