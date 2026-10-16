import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  ActionJournalEntryRecord,
  CapacityReservationRecord,
} from '../../domain/execution-records.js';
import { ExecutionJournalAdapter } from './ExecutionJournalAdapter.adapter.js';

describe('ExecutionJournalAdapter cross-process safe persistence', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-journal-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('keeps both entries when two instances append to the same stateDir and refuses duplicate ids', async () => {
    const adapterA = new ExecutionJournalAdapter({ stateDir: tempDir });
    const adapterB = new ExecutionJournalAdapter({ stateDir: tempDir });

    const entry1: ActionJournalEntryRecord = {
      id: 'entry-1',
      attemptId: 'att-1',
      workOrderId: 'wo-1',
      action: 'dispatch',
      baseCommit: 'commit-1',
      status: 'intent-recorded',
      recordedAtIso: '2026-10-15T10:00:00.000Z',
      sessionId: null,
      detail: 'first entry from A',
    };

    const entry2: ActionJournalEntryRecord = {
      id: 'entry-2',
      attemptId: 'att-1',
      workOrderId: 'wo-1',
      action: 'dispatch',
      baseCommit: 'commit-1',
      status: 'completed',
      recordedAtIso: '2026-10-15T10:01:00.000Z',
      sessionId: null,
      detail: 'second entry from B',
    };

    // Both instances append different entries
    await Promise.all([adapterA.appendJournalEntry(entry1), adapterB.appendJournalEntry(entry2)]);

    // Both entries must survive
    const entriesFromA = await adapterA.listJournalEntriesForAttempt('att-1');
    const entriesFromB = await adapterB.listJournalEntriesForAttempt('att-1');

    expect(entriesFromA.map((e) => e.id)).toEqual(['entry-1', 'entry-2']);
    expect(entriesFromB.map((e) => e.id)).toEqual(['entry-1', 'entry-2']);

    // Duplicate id must be refused even when attempted by a second adapter instance
    await expect(adapterB.appendJournalEntry(entry1)).rejects.toThrow(
      'Duplicate journal entry id: entry-1',
    );
  });

  it('keeps both reservations when two instances save capacity reservations to the same stateDir', async () => {
    const adapterA = new ExecutionJournalAdapter({ stateDir: tempDir });
    const adapterB = new ExecutionJournalAdapter({ stateDir: tempDir });

    const res1: CapacityReservationRecord = {
      id: 'res-1',
      attemptId: 'att-1',
      hostId: 'host-1',
      slotIndex: 0,
      held: true,
      reservedAtIso: '2026-10-15T10:00:00.000Z',
      releasedAtIso: null,
    };

    const res2: CapacityReservationRecord = {
      id: 'res-2',
      attemptId: 'att-2',
      hostId: 'host-1',
      slotIndex: 1,
      held: true,
      reservedAtIso: '2026-10-15T10:01:00.000Z',
      releasedAtIso: null,
    };

    await Promise.all([adapterA.saveCapacityReservation(res1), adapterB.saveCapacityReservation(res2)]);

    const activeA = await adapterA.listActiveReservations();
    const activeB = await adapterB.listActiveReservations();

    expect(activeA.map((r) => r.id).sort()).toEqual(['res-1', 'res-2']);
    expect(activeB.map((r) => r.id).sort()).toEqual(['res-1', 'res-2']);

    // Releasing one reservation in adapterA is immediately visible in adapterB
    const released = await adapterA.releaseCapacityReservation('att-1', '2026-10-15T10:05:00.000Z');
    expect(released).toBe(true);

    const activeAfterRelease = await adapterB.listActiveReservations();
    expect(activeAfterRelease.map((r) => r.id)).toEqual(['res-2']);
  });

  it('throws and preserves file content when appending to a corrupt journal file', async () => {
    const filePath = path.join(tempDir, 'journal.json');
    const corruptContent = '{ corrupt journal';
    await fs.writeFile(filePath, corruptContent, 'utf8');

    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir });
    const entry: ActionJournalEntryRecord = {
      id: 'entry-corrupt',
      attemptId: 'att-1',
      workOrderId: 'wo-1',
      action: 'dispatch',
      baseCommit: 'commit-1',
      status: 'intent-recorded',
      recordedAtIso: '2026-10-15T10:00:00.000Z',
      sessionId: null,
      detail: 'test entry',
    };

    await expect(adapter.appendJournalEntry(entry)).rejects.toThrow();

    const contentAfter = await fs.readFile(filePath, 'utf8');
    expect(contentAfter).toBe(corruptContent);
  });

  it('throws and preserves file content when saving to a corrupt reservations file', async () => {
    const filePath = path.join(tempDir, 'reservations.json');
    const corruptContent = '{ corrupt reservations';
    await fs.writeFile(filePath, corruptContent, 'utf8');

    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir });
    const res: CapacityReservationRecord = {
      id: 'res-corrupt',
      attemptId: 'att-1',
      hostId: 'host-1',
      slotIndex: 0,
      held: true,
      reservedAtIso: '2026-10-15T10:00:00.000Z',
      releasedAtIso: null,
    };

    await expect(adapter.saveCapacityReservation(res)).rejects.toThrow();

    const contentAfter = await fs.readFile(filePath, 'utf8');
    expect(contentAfter).toBe(corruptContent);
  });
});
