// Implemented for lane WB4c (JSON file store over file-store.ts, plus in-memory).
/**
 * DeclarationRepositoryAdapter implements DeclarationRepositoryPort. Records
 * live in an in-memory list by default; with `stateDir` each append rewrites
 * `<stateDir>/lane-declarations.json` atomically under an exclusive lock —
 * a compare-and-swap on the whole list, never a silent overwrite. Reads
 * validate every record and quarantine an unparsable file (fail closed:
 * reads return [] and writes are refused until the store is repaired).
 * The store keeps every declaration and deletes nothing; records arrive
 * already valid.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { LaneDeclarationRecord } from '../../domain/lane-activity-records.js';
import { isLaneDeclarationRecord } from '../../domain/lane-activity-records.js';
import type {
  AppendDeclarationResult,
  DeclarationRepositoryPort,
} from '../../application/ports/out/DeclarationRepositoryPort.out-port.js';
import {
  inspectRecordListBytes,
  rejectUnreadableStateFile,
  StateFileUnreadableError,
  withFileLock,
  writeJsonAtomically,
} from './file-store.js';

export const LANE_DECLARATIONS_FILE = 'lane-declarations.json';

/** The reader's record parser, shared with `fleet-v2 state check`. */
export function parseLaneDeclarationStateRecord(raw: unknown): LaneDeclarationRecord | undefined {
  return isLaneDeclarationRecord(raw) ? raw : undefined;
}

function refusal(reason: string): AppendDeclarationResult {
  return { outcome: 'refused', reason };
}

export class DeclarationRepositoryAdapter implements DeclarationRepositoryPort {
  private readonly inMemoryRecords: LaneDeclarationRecord[] = [];
  private quarantined = false;

  constructor(private readonly options?: { readonly stateDir?: string }) {}

  async list(): Promise<readonly LaneDeclarationRecord[]> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      return [...this.inMemoryRecords];
    }
    try {
      return await this.readRecords(path.join(stateDir, LANE_DECLARATIONS_FILE));
    } catch {
      return [];
    }
  }

  async append(record: LaneDeclarationRecord): Promise<AppendDeclarationResult> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      this.inMemoryRecords.push(record);
      return { outcome: 'saved', revision: this.inMemoryRecords.length };
    }
    return this.appendToFile(record, stateDir);
  }

  private async appendToFile(record: LaneDeclarationRecord, stateDir: string): Promise<AppendDeclarationResult> {
    if (this.quarantined) {
      return refusal('the declaration store is quarantined; no write until it is repaired');
    }
    const target = path.join(stateDir, LANE_DECLARATIONS_FILE);
    try {
      return await withFileLock(`${target}.lock`, async () => {
        const records = [...await this.readRecords(target), record];
        await writeJsonAtomically(target, records);
        return { outcome: 'saved' as const, revision: records.length };
      });
    } catch (error: unknown) {
      if (error instanceof StateFileUnreadableError) {
        this.quarantined = true;
        return refusal('the declaration store file is unreadable and was quarantined');
      }
      return refusal('the declaration store refused the write');
    }
  }

  /** Throws `StateFileUnreadableError` (after quarantining) on an unparsable file. */
  private async readRecords(target: string): Promise<readonly LaneDeclarationRecord[]> {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(target);
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        return [];
      }
      throw error;
    }
    const inspection = inspectRecordListBytes(buffer, parseLaneDeclarationStateRecord);
    if (inspection.status !== 'ok') {
      return rejectUnreadableStateFile(target, inspection.detail, buffer, false);
    }
    return [...inspection.records];
  }
}
