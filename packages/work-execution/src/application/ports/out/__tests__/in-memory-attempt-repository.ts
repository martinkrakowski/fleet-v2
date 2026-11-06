/**
 * Shared in-memory fake of AttemptRepositoryPort for use-case and contract
 * tests. It mirrors the real adapter's guarded semantics: immutable identity
 * fields are checked before the revision compare-and-swap, missing revisions
 * read as 0, and every stored record carries the attempt schema version.
 * This file holds no `describe`/`it`: vitest only collects `*.test.ts`.
 */

import { ATTEMPT_RECORD_SCHEMA_VERSION, type AttemptRecord } from '../../../../domain/execution-records.js';
import { AttemptRevisionConflictError, type AttemptRepositoryPort } from '../AttemptRepositoryPort.out-port.js';

/** Identity established at dispatch time; lifecycle fields may change, these may not. */
const immutableAttemptIdentityFields = [
  'workOrderId',
  'kind',
  'fixNumber',
  'priorAttemptId',
  'worktreePath',
  'baseCommit',
] as const;

/** Snapshot of the record as the repository stores it. */
function normalizeRecord(record: AttemptRecord): AttemptRecord {
  return {
    ...record,
    revision: Number.isInteger(record.revision) ? record.revision! : 0,
    schemaVersion: ATTEMPT_RECORD_SCHEMA_VERSION,
  };
}

export class InMemoryAttemptRepository implements AttemptRepositoryPort {
  private readonly store = new Map<string, AttemptRecord>();

  async saveAttempt(record: AttemptRecord): Promise<void> {
    const stored = this.store.get(record.id);
    if (stored !== undefined) {
      // Immutable identity fields are guarded first: a stale revision must
      // never mask an identity mutation.
      const changed = immutableAttemptIdentityFields.filter(
        (field) => stored[field] !== record[field],
      );
      if (changed.length > 0) {
        throw new Error(
          `Immutable attempt identity changed for ${record.id}: ${changed.join(', ')}`,
        );
      }
      // Compare-and-swap: the writer must build on exactly the stored
      // revision, so its revision is stored + 1. Missing revisions on either
      // side count as 0.
      const expected = stored.revision ?? 0;
      const actual = record.revision ?? 0;
      if (actual !== expected + 1) {
        throw new AttemptRevisionConflictError(record.id, expected, actual);
      }
    }
    this.store.set(record.id, normalizeRecord(record));
  }

  async findAttemptById(attemptId: string): Promise<AttemptRecord | null> {
    return this.store.get(attemptId) ?? null;
  }

  async listAttemptsByWorkOrder(workOrderId: string): Promise<readonly AttemptRecord[]> {
    return [...this.store.values()]
      .filter((record) => record.workOrderId === workOrderId)
      .sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
  }

  async listAllAttempts(): Promise<readonly AttemptRecord[]> {
    return [...this.store.values()].sort((a, b) =>
      b.updatedAtIso.localeCompare(a.updatedAtIso),
    );
  }
}
