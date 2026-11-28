// @generated entity stub — refined for migration step 1.
/**
 * ActionJournalEntry is a child entity of Attempt: one durable journal fact.
 * Intent is recorded before the subprocess runs, so a killed watcher never
 * becomes a second dispatch. Entries are append-only facts about status.
 */

import { readJournalPullRequestRef } from '../execution-records.js';
import type { ActionJournalEntryRecord } from '../execution-records.js';
import { describeRejectedValue } from '../value-objects/AttemptState.vo.js';

const ACTIONS: readonly unknown[] = ['dispatch', 'reconcile', 'stop', 'collect', 'forge', 'accept'];
const STATUSES: readonly unknown[] = ['intent-recorded', 'completed', 'ambiguous', 'uncertain', 'refused'];

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
      throw new Error('ActionJournalEntry has an invalid action: ' + describeRejectedValue(record.action));
    }
    if (!STATUSES.includes(record.status)) {
      throw new Error('ActionJournalEntry has an invalid status: ' + describeRejectedValue(record.status));
    }
    // UN1: `uncertain` records an interrupted side effect, so it is only a
    // status of the one-way dispatch/forge actions; an uncertain stop or
    // collect would leave the attempt state unreadable.
    if (record.status === 'uncertain' && record.action !== 'dispatch' && record.action !== 'forge') {
      throw new Error('ActionJournalEntry accepts uncertain only for dispatch and forge');
    }
    // The typed pull-request reference (WB5b) is permitted only on `forge`
    // entries and must carry a valid (repository, number) pair.
    if (readJournalPullRequestRef(record.action, record.pullRequest).kind === 'invalid') {
      throw new Error('ActionJournalEntry has an invalid pullRequest reference');
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

  /** Only an intent-recorded, ambiguous or uncertain entry marks an unfinished action. */
  isUnresolved(): boolean {
    return this.record.status === 'intent-recorded' || this.record.status === 'ambiguous' || this.record.status === 'uncertain';
  }
}
