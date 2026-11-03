// Implemented for lane WB4c (JSON file store over file-store.ts, plus in-memory).
/**
 * BriefReadRepositoryAdapter implements BriefReadRepositoryPort. Records
 * live in an in-memory list by default; with `stateDir` each put rewrites
 * `<stateDir>/brief-reads.json` atomically under an exclusive lock — one
 * latest read per lane, the older read of the same lane replaced. Reads
 * validate every record and quarantine an unparsable file (fail closed:
 * reads return null and writes are refused until the store is repaired).
 * Records arrive already valid.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { BriefReadRecord } from '../../domain/lane-activity-records.js';
import { isBriefReadRecord } from '../../domain/lane-activity-records.js';
import type { LaneRef } from '../../domain/work-board-facts.js';
import { formatLaneRef } from '../../domain/work-board-facts.js';
import type {
  BriefReadRepositoryPort,
  PutBriefReadResult,
} from '../../application/ports/out/BriefReadRepositoryPort.out-port.js';
import {
  inspectRecordListBytes,
  rejectUnreadableStateFile,
  StateFileUnreadableError,
  withFileLock,
  writeJsonAtomically,
} from './file-store.js';

export const BRIEF_READS_FILE = 'brief-reads.json';

/** The reader's record parser, shared with `fleet-v2 state check`. */
export function parseBriefReadStateRecord(raw: unknown): BriefReadRecord | undefined {
  return isBriefReadRecord(raw) ? raw : undefined;
}

function laneKeyOf(lane: LaneRef): string {
  return formatLaneRef(lane);
}

function refusal(reason: string): PutBriefReadResult {
  return { outcome: 'refused', reason };
}

function replaceLaneRead(
  records: readonly BriefReadRecord[],
  record: BriefReadRecord,
): BriefReadRecord[] {
  const key = laneKeyOf(record.lane);
  return [...records.filter((existing) => laneKeyOf(existing.lane) !== key), record];
}

function latestOf(records: readonly BriefReadRecord[], lane: LaneRef): BriefReadRecord | null {
  const key = laneKeyOf(lane);
  let latest: BriefReadRecord | null = null;
  for (const existing of records) {
    if (laneKeyOf(existing.lane) === key) {
      latest = existing;
    }
  }
  return latest;
}

export class BriefReadRepositoryAdapter implements BriefReadRepositoryPort {
  private readonly inMemoryRecords: BriefReadRecord[] = [];
  private quarantined = false;

  constructor(private readonly options?: { readonly stateDir?: string }) {}

  async latest(lane: LaneRef): Promise<BriefReadRecord | null> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      return latestOf(this.inMemoryRecords, lane);
    }
    try {
      return latestOf(await this.readRecords(path.join(stateDir, BRIEF_READS_FILE)), lane);
    } catch {
      return null;
    }
  }

  async put(record: BriefReadRecord): Promise<PutBriefReadResult> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      const updated = replaceLaneRead(this.inMemoryRecords, record);
      this.inMemoryRecords.length = 0;
      this.inMemoryRecords.push(...updated);
      return { outcome: 'saved', revision: updated.length };
    }
    return this.putToFile(record, stateDir);
  }

  private async putToFile(record: BriefReadRecord, stateDir: string): Promise<PutBriefReadResult> {
    if (this.quarantined) {
      return refusal('the brief-read store is quarantined; no write until it is repaired');
    }
    const target = path.join(stateDir, BRIEF_READS_FILE);
    try {
      return await withFileLock(`${target}.lock`, async () => {
        const records = replaceLaneRead(await this.readRecords(target), record);
        await writeJsonAtomically(target, records);
        return { outcome: 'saved' as const, revision: records.length };
      });
    } catch (error: unknown) {
      if (error instanceof StateFileUnreadableError) {
        this.quarantined = true;
        return refusal('the brief-read store file is unreadable and was quarantined');
      }
      return refusal('the brief-read store refused the write');
    }
  }

  /** Throws `StateFileUnreadableError` (after quarantining) on an unparsable file. */
  private async readRecords(target: string): Promise<readonly BriefReadRecord[]> {
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
    const inspection = inspectRecordListBytes(buffer, parseBriefReadStateRecord);
    if (inspection.status !== 'ok') {
      return rejectUnreadableStateFile(target, inspection.detail, buffer, false);
    }
    return [...inspection.records];
  }
}
