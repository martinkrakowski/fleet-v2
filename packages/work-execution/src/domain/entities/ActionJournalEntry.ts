// @generated entity stub — refined for migration step 1.
/**
 * ActionJournalEntry is a child entity of Attempt: one durable journal fact.
 * Intent is recorded before the subprocess runs, so a killed watcher never
 * becomes a second dispatch. Entries are append-only facts about status.
 */

import type { ActionJournalEntryRecord } from '../execution-records.js';

const ACTIONS: readonly unknown[] = ['dispatch', 'reconcile', 'stop', 'collect', 'forge'];
const STATUSES: readonly unknown[] = ['intent-recorded', 'completed', 'ambiguous', 'refused'];

export class ActionJournalEntry {
  private constructor(private readonly record: ActionJournalEntryRecord) {
    // Invariants are validated in fromRecord.
  }

  static fromRecord(record: ActionJournalEntryRecord): ActionJournalEntry {
    if (typeof record.id !== 'string' || record.id.trim().length === 0) {
      throw new Error('ActionJournalEntry requires a non-empty id');
    }
    if (typeof record.attemptId !== 'string' || record.attemptId.trim().length === 0) {
      throw new Error('ActionJournalEntry requires a non-empty attemptId');
    }
    if (typeof record.workOrderId !== 'string' || record.workOrderId.trim().length === 0) {
      throw new Error('ActionJournalEntry requires a non-empty workOrderId');
    }
    if (typeof record.baseCommit !== 'string' || record.baseCommit.trim().length === 0) {
      throw new Error('ActionJournalEntry requires a non-empty baseCommit');
    }
    if (typeof record.recordedAtIso !== 'string' || record.recordedAtIso.trim().length === 0) {
      throw new Error('ActionJournalEntry requires a non-empty recordedAtIso');
    }
    if (!ACTIONS.includes(record.action)) {
      throw new Error(`ActionJournalEntry has an invalid action: ${String(record.action)}`);
    }
    if (!STATUSES.includes(record.status)) {
      throw new Error(`ActionJournalEntry has an invalid status: ${String(record.status)}`);
    }
    return new ActionJournalEntry({ ...record });
  }

  getId(): string {
    return this.record.id;
  }

  toRecord(): ActionJournalEntryRecord {
    return { ...this.record };
  }

  getAttemptId(): string {
    return this.record.attemptId;
  }

  isIntentRecorded(): boolean {
    return this.record.status === 'intent-recorded';
  }

  isAmbiguous(): boolean {
    return this.record.status === 'ambiguous';
  }

  /** Only an intent-recorded or ambiguous entry marks an unfinished action. */
  isUnresolved(): boolean {
    return this.record.status === 'intent-recorded' || this.record.status === 'ambiguous';
  }
}
