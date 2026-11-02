/**
 * The file adapter for one merge train's event journal: `journal.jsonl`
 * under the train's directory, appended only under the current, unexpired
 * lease holder's fence and the `train.lock` guard. A repeated key with the
 * same event is a duplicate that writes nothing; the same key with another
 * event is refused. One bad line makes the journal unreadable — it is
 * reported, never repaired, and no bytes are ever echoed.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  TrainEventPort,
  TrainJournalAppendRequest,
  TrainJournalAppendResult,
  TrainJournalEntry,
  TrainJournalRead,
} from '../../application/ports/out/TrainEventPort.out-port.js';
import { checkTrainLeaseHeld } from '../../application/use-cases/train-lease.js';
import { containsSecretShape } from '@fleet/shared';
import { TRAIN_EVENTS } from '../../domain/value-objects/TrainEvent.vo.js';
import {
  readLeaseFile,
  trainDirectory,
  withTrainLock,
} from './TrainStoreFiles.helper.js';

const KEY_MAX_BYTES = 256;
const JOURNAL_FILE = 'journal.jsonl';

const TRAIN_EVENT_VALUES: readonly string[] = TRAIN_EVENTS;

export class TrainEventJournalFileAdapter implements TrainEventPort {
  private readonly stateDir: string;

  constructor(options: { stateDir: string }) {
    this.stateDir = options.stateDir;
  }

  async append(request: TrainJournalAppendRequest): Promise<TrainJournalAppendResult> {
    let dir: string;
    try {
      dir = trainDirectory(this.stateDir, request.trainId);
    } catch {
      return { outcome: 'refused', reason: 'invalid-entry' };
    }
    return withTrainLock(dir, async () => {
      const leaseRead = await readLeaseFile(dir);
      if (leaseRead.kind === 'unreadable') {
        return { outcome: 'refused', reason: 'lease-unreadable' };
      }
      const hold = checkTrainLeaseHeld(leaseRead.lease, {
        holderId: request.holderId,
        fence: request.fence,
        nowIso: request.nowIso,
      });
      if (hold !== null) {
        return { outcome: 'refused', reason: hold };
      }
      const entry = request.entry;
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as { key?: unknown }).key !== 'string' ||
        (entry as { key: string }).key.trim().length === 0 ||
        new TextEncoder().encode((entry as { key: string }).key).byteLength > KEY_MAX_BYTES ||
        containsSecretShape((entry as { key: string }).key) ||
        typeof (entry as { event?: unknown }).event !== 'string' ||
        !TRAIN_EVENT_VALUES.includes((entry as { event: string }).event) ||
        typeof (entry as { atIso?: unknown }).atIso !== 'string' ||
        Number.isNaN(Date.parse((entry as { atIso: string }).atIso))
      ) {
        return { outcome: 'refused', reason: 'invalid-entry' };
      }

      const read = await this.readEntries(dir);
      if (read.kind === 'unreadable') {
        return { outcome: 'refused', reason: 'journal-unreadable' };
      }
      for (const stored of read.entries) {
        if (stored.key !== entry.key) {
          continue;
        }
        if (stored.event === entry.event) {
          return { outcome: 'duplicate', entry: stored };
        }
        return { outcome: 'refused', reason: 'key-conflict' };
      }

      const appended: TrainJournalEntry = {
        schemaVersion: 1,
        sequence: read.entries.length + 1,
        key: entry.key,
        event: entry.event,
        atIso: entry.atIso,
        fence: request.fence,
      };
      await fs.appendFile(path.join(dir, JOURNAL_FILE), `${JSON.stringify(appended)}\n`, 'utf8');
      return { outcome: 'appended', entry: appended };
    });
  }

  async list(trainId: string): Promise<TrainJournalRead> {
    let dir: string;
    try {
      dir = trainDirectory(this.stateDir, trainId);
    } catch {
      return { outcome: 'unreadable' };
    }
    const read = await this.readEntries(dir);
    if (read.kind === 'unreadable') {
      return { outcome: 'unreadable' };
    }
    return { outcome: 'ok', entries: read.entries };
  }

  /** Read the journal in file order; one bad line makes it unreadable. */
  private async readEntries(dir: string): Promise<
    { kind: 'ok'; entries: TrainJournalEntry[] } | { kind: 'unreadable' }
  > {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(path.join(dir, JOURNAL_FILE));
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        return { kind: 'ok', entries: [] };
      }
      return { kind: 'unreadable' };
    }
    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    const entries: TrainJournalEntry[] = [];
    for (const line of lines) {
      const entry = readJournalLine(line, entries.length + 1);
      if (entry === null) {
        return { kind: 'unreadable' };
      }
      entries.push(entry);
    }
    return { kind: 'ok', entries };
  }
}

/** Read one journal line as a `TrainJournalEntry`; null when it does not match. */
function readJournalLine(line: string, expectedSequence?: number): TrainJournalEntry | null {
  if (line.trim().length === 0) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (
      record.schemaVersion !== 1 ||
      typeof record.sequence !== 'number' ||
      !Number.isSafeInteger(record.sequence) ||
      record.sequence < 1 ||
      (expectedSequence !== undefined && record.sequence !== expectedSequence) ||
      typeof record.fence !== 'number' ||
      !Number.isSafeInteger(record.fence) ||
      record.fence < 1 ||
      typeof record.key !== 'string' ||
      record.key.length === 0 ||
      typeof record.event !== 'string' ||
      !TRAIN_EVENT_VALUES.includes(record.event) ||
      typeof record.atIso !== 'string' ||
      Number.isNaN(Date.parse(record.atIso))
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      sequence: record.sequence,
      key: record.key,
      event: record.event as TrainJournalEntry['event'],
      atIso: record.atIso,
      fence: record.fence,
    };
  } catch {
    return null;
  }
}
