// @generated adapter stub — edit freely
/**
 * DaemonEventProjectionAdapter implements DaemonEventProjectionPort over
 * `<stateDir>/daemon/events.jsonl` (plan §3.4): `append` writes the header on
 * first use and appends the serialized non-null lines under the shared
 * exclusive lock (a record that serializes to null is skipped, never thrown);
 * `readAfterCursor` reads the whole file, collects the valid event records in
 * order and defers every cursor rule to `eventsAfterCursor` — the cursor rules
 * come from the domain, never the adapter.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import {
  eventsAfterCursor,
  readDaemonEventLine,
  serializeDaemonEventHeader,
  serializeDaemonEventLine,
  type DaemonEventRecord,
} from '../../domain/daemon-events.js';
import type {
  DaemonEventCursorRead,
  DaemonEventProjectionPort,
} from '../../application/ports/out/DaemonEventProjectionPort.out-port.js';
import { withFileLock } from './file-store.js';

export interface DaemonEventProjectionAdapterOptions {
  /** When set, the projection persists at `<stateDir>/daemon/events.jsonl`. */
  readonly stateDir?: string;
}

function isENOENT(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

function collectExistingEventIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    const read = readDaemonEventLine(line);
    if (read.ok && read.lineKind === 'event') {
      ids.add(read.record.eventId);
    }
  }
  return ids;
}

export class DaemonEventProjectionAdapter implements DaemonEventProjectionPort {
  private readonly inMemoryEvents: DaemonEventRecord[] = [];

  constructor(private readonly options: DaemonEventProjectionAdapterOptions = {}) {}

  async append(events: readonly DaemonEventRecord[]): Promise<{ readonly appended: number }> {
    const target = this.statePath;
    if (target === null) {
      const seenIds = new Set<string>(this.inMemoryEvents.map((e) => e.eventId));
      let appended = 0;
      for (const event of events) {
        if (seenIds.has(event.eventId)) {
          continue;
        }
        if (serializeDaemonEventLine(event) !== null) {
          seenIds.add(event.eventId);
          this.inMemoryEvents.push(event);
          appended += 1;
        }
      }
      return { appended };
    }
    return withFileLock(`${target}.lock`, async () => {
      let existing: string;
      try {
        existing = await fs.readFile(target, 'utf8');
      } catch (error: unknown) {
        if (isENOENT(error)) {
          existing = '';
        } else {
          throw error;
        }
      }
      const seenIds = collectExistingEventIds(existing);
      const newLines: string[] = [];
      if (existing.trim().length === 0) {
        newLines.push(serializeDaemonEventHeader());
      }
      let appended = 0;
      for (const event of events) {
        if (seenIds.has(event.eventId)) {
          continue;
        }
        const line = serializeDaemonEventLine(event);
        if (line !== null) {
          seenIds.add(event.eventId);
          newLines.push(line);
          appended += 1;
        }
      }
      if (newLines.length > 0) {
        const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
        const content = newLines.map((line) => `${line}\n`).join('');
        await fs.writeFile(target, `${separator}${content}`, { flag: 'a' });
      }
      return { appended };
    });
  }

  async readAfterCursor(cursorEventId: string | null): Promise<DaemonEventCursorRead> {
    const { events, eventPositions, droppedLines } = await this.readAllEvents();
    const cursorRead = eventsAfterCursor(events, cursorEventId);
    if (!cursorRead.ok) {
      return cursorRead;
    }
    // The returned suffix starts at `events.length - cursorRead.events.length`,
    // so slice `eventPositions` to the same window.
    const offset = events.length - cursorRead.events.length;
    return { ...cursorRead, eventPositions: eventPositions.slice(offset), droppedLines };
  }

  private async readAllEvents(): Promise<{
    readonly events: readonly DaemonEventRecord[];
    readonly eventPositions: readonly number[];
    readonly droppedLines: readonly number[];
  }> {
    const target = this.statePath;
    if (target === null) {
      return {
        events: [...this.inMemoryEvents],
        eventPositions: this.inMemoryEvents.map((_, index) => index),
        droppedLines: [],
      };
    }
    let text: string;
    try {
      text = await fs.readFile(target, 'utf8');
    } catch (error: unknown) {
      if (isENOENT(error)) {
        return { events: [], eventPositions: [], droppedLines: [] };
      }
      throw error;
    }
    const records: DaemonEventRecord[] = [];
    const eventPositions: number[] = [];
    const droppedLines: number[] = [];
    const lines = text.split('\n');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (line.trim().length === 0) {
        continue;
      }
      const read = readDaemonEventLine(line);
      if (read.ok && read.lineKind === 'event') {
        records.push(read.record);
        eventPositions.push(lineIndex);
      } else if (!read.ok) {
        droppedLines.push(lineIndex);
      }
      // A well-formed header line is neither an event nor a dropped line.
    }
    return { events: records, eventPositions, droppedLines };
  }

  private get statePath(): string | null {
    const { stateDir } = this.options;
    if (stateDir === undefined || stateDir.trim().length === 0) {
      return null;
    }
    return join(stateDir, 'daemon', 'events.jsonl');
  }
}
