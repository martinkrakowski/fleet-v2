// @generated adapter stub — signature-matched for step 4 (no behaviour).
/**
 * EvidenceAssessmentRepositoryAdapter implements EvidenceAssessmentRepositoryPort.
 * Records live in memory by default and persist as JSON via atomic
 * temp-file-then-rename writes under an exclusive lock when `stateDir` is configured.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type {
  EvidenceAssessmentRecord,
} from '../../domain/evidence-records.js';
import {
  EvidenceAssessmentRevisionConflictError,
  type EvidenceAssessmentRepositoryPort,
} from '../../application/ports/out/EvidenceAssessmentRepositoryPort.out-port.js';
import { inspectRecordListBytes, quarantineUnreadable, withFileLock, writeJsonAtomically } from './file-store.js';

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

/** The reader's record parser, shared with `fleet-v2 state check`. */
export function parseAssessmentStateRecord(raw: unknown): EvidenceAssessmentRecord | undefined {
  return isAssessmentRecord(raw) ? copyRecord(raw) : undefined;
}

export class EvidenceAssessmentRepositoryAdapter implements EvidenceAssessmentRepositoryPort {
  private readonly inMemoryAssessments = new Map<string, EvidenceAssessmentRecord>();

  constructor(private readonly options: EvidenceAssessmentRepositoryOptions = {}) {}

  /**
   * Revision-aware update: a write only lands when it moves the stored
   * revision forward, so concurrent writers cannot silently overwrite
   * evidence that a later decision already superseded. Evaluated against
   * the freshly read record inside an exclusive lock.
   */
  async saveAssessment(record: EvidenceAssessmentRecord): Promise<void> {
    const stateFilePath = this.stateFilePath;
    if (stateFilePath === null) {
      const existing = this.inMemoryAssessments.get(record.id);
      if (existing !== undefined && record.revision <= existing.revision) {
        throw new EvidenceAssessmentRevisionConflictError(
          record.id,
          record.revision,
          `Optimistic concurrency conflict for assessment ${record.id}: revision ${record.revision} does not advance stored revision ${existing.revision}`,
        );
      }
      this.inMemoryAssessments.set(record.id, copyRecord(record));
      return;
    }

    const lockPath = `${stateFilePath}.lock`;

    await withFileLock(lockPath, async () => {
      const assessments = await this.readAssessmentsFromDisk(stateFilePath);
      const existing = assessments.get(record.id);
      if (existing !== undefined && record.revision <= existing.revision) {
        throw new EvidenceAssessmentRevisionConflictError(
          record.id,
          record.revision,
          `Optimistic concurrency conflict for assessment ${record.id}: revision ${record.revision} does not advance stored revision ${existing.revision}`,
        );
      }
      assessments.set(record.id, copyRecord(record));
      await writeJsonAtomically(stateFilePath, [...assessments.values()]);
    });
  }

  async findAssessmentById(assessmentId: string): Promise<EvidenceAssessmentRecord | null> {
    const stateFilePath = this.stateFilePath;
    if (stateFilePath === null) {
      const found = this.inMemoryAssessments.get(assessmentId);
      return found === undefined ? null : copyRecord(found);
    }
    const assessments = await this.readAssessmentsFromDisk(stateFilePath);
    const found = assessments.get(assessmentId);
    return found === undefined ? null : copyRecord(found);
  }

  async findAssessmentByHead(candidateHeadSha: string): Promise<EvidenceAssessmentRecord | null> {
    const stateFilePath = this.stateFilePath;
    if (stateFilePath === null) {
      for (const record of this.inMemoryAssessments.values()) {
        if (record.candidateHeadSha === candidateHeadSha) {
          return copyRecord(record);
        }
      }
      return null;
    }
    const assessments = await this.readAssessmentsFromDisk(stateFilePath);
    for (const record of assessments.values()) {
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

  private async readAssessmentsFromDisk(
    stateFilePath: string,
  ): Promise<Map<string, EvidenceAssessmentRecord>> {
    const map = new Map<string, EvidenceAssessmentRecord>();
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(stateFilePath);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        return map;
      }
      throw error;
    }
    const inspection = inspectRecordListBytes(buffer, parseAssessmentStateRecord);
    if (inspection.status === 'unreadable') {
      return quarantineUnreadable(stateFilePath, inspection.detail, buffer);
    }
    for (const item of inspection.records) {
      map.set(item.id, item);
    }
    return map;
  }
}