// @generated outbound contract scaffold — refined for migration step 1.
/**
 * AttemptRepositoryPort: persist immutable dispatch identity and guarded
 * lifecycle updates. A fresh attempt identity is created per dispatch and
 * per fix round; identities are never reused or resumed.
 */

import type { AttemptRecord } from '../../../domain/execution-records.js';
import type { AttemptStateValue } from '../../../domain/value-objects/AttemptState.vo.js';

/**
 * Thrown when a save of an existing attempt is not built on the stored
 * revision. Writers must chain from the record they read, so their revision is
 * exactly one more than the stored one; anything else is a stale write.
 * `expectedRevision` is the revision the writer must have read (the stored
 * revision) and build on; `actualRevision` is the revision the writer sent.
 * The message names the stored revision, the required next write revision and
 * what the writer actually sent.
 */
export class AttemptRevisionConflictError extends Error {
  readonly attemptId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(attemptId: string, expectedRevision: number, actualRevision: number) {
    super(
      `Stale attempt revision for ${attemptId}: stored ${expectedRevision}, write must be ${expectedRevision + 1}, got ${actualRevision}`,
    );
    this.name = 'AttemptRevisionConflictError';
    this.attemptId = attemptId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

/** Next revision for an update built from `record`; a missing revision reads as 0. */
export function nextAttemptRevision(record: AttemptRecord): number {
  return (record.revision ?? 0) + 1;
}

/**
 * The gate for state-based overwrite decisions after a revision conflict: the
 * fresh record may be overwritten only when its state is one of the states
 * the original transition was allowed to start from. Terminal-state checks
 * elsewhere use `isTerminalAttempt`. Same state is not the same writer — a
 * `dispatching` record from another dispatch (different `dispatchRevision`)
 * is foreign and never overwritten. A missing fresh record is decided by the
 * caller, not here.
 */
export function canOverwriteAfterConflict(
  fresh: AttemptRecord | null,
  expectedFrom: readonly AttemptStateValue[],
  base?: AttemptRecord,
): boolean {
  if (fresh === null || !expectedFrom.includes(fresh.state)) {
    return false;
  }
  if (fresh.state === 'dispatching') {
    return (
      base !== undefined &&
      fresh.dispatchRevision !== undefined &&
      fresh.dispatchRevision === base.dispatchRevision
    );
  }
  return true;
}

export interface AttemptRepositoryPort {
  /**
   * Persist one attempt record:
   * - a new id is stored with the record's revision, `0` if absent;
   * - an existing id is stored only when `record.revision === stored.revision + 1`,
   *   otherwise `AttemptRevisionConflictError` is thrown;
   * - immutable identity fields are always guarded.
   */
  saveAttempt(record: AttemptRecord): Promise<void>;

  /** Known absence is null; unreadable state is an error. */
  findAttemptById(attemptId: string): Promise<AttemptRecord | null>;

  /** List attempts in creation order for one work order. */
  listAttemptsByWorkOrder(workOrderId: string): Promise<readonly AttemptRecord[]>;

  /** List every attempt, newest state first, for recovery and inspection. */
  listAllAttempts(): Promise<readonly AttemptRecord[]>;
}
