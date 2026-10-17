// @generated entity stub — refined for migration step 1.
/**
 * Attempt is the aggregate root of one dispatch or one fresh fix session. It
 * wraps an AttemptRecord and enforces the kernel's recovery rules: unknown is
 * not ended, capacity is released only on ended, collected or cancelled, and
 * fix rounds never resume the prior conversation.
 */

import type {
  AttemptRecord,
  AttemptRunnerRecord,
  AttemptSeatOverrideRecord,
} from '../execution-records.js';
import type { AttemptStateValue } from '../value-objects/AttemptState.vo.js';
import { CAPACITY_RELEASE_STATES, AttemptState } from '../value-objects/AttemptState.vo.js';

export class Attempt {
  private constructor(private record: AttemptRecord) {
    // Invariants are validated in fromRecord.
  }

  static fromRecord(record: AttemptRecord): Attempt {
    if (typeof record.id !== 'string' || record.id.trim().length === 0) {
      throw new Error('Attempt requires a non-empty id');
    }
    if (typeof record.workOrderId !== 'string' || record.workOrderId.trim().length === 0) {
      throw new Error('Attempt requires a non-empty workOrderId');
    }
    if (typeof record.worktreePath !== 'string' || record.worktreePath.trim().length === 0) {
      throw new Error('Attempt requires a non-empty worktreePath');
    }
    if (typeof record.baseCommit !== 'string' || record.baseCommit.trim().length === 0) {
      throw new Error('Attempt requires a non-empty baseCommit');
    }
    if (record.kind !== 'initial' && record.kind !== 'fix') {
      throw new Error(`Attempt has an invalid kind: ${String(record.kind)}`);
    }
    if (Number.isInteger(record.fixNumber) === false || record.fixNumber < 0) {
      throw new Error('Attempt requires a non-negative integer fixNumber');
    }
    if (record.kind === 'fix' && record.priorAttemptId === null) {
      throw new Error('A fix attempt requires a priorAttemptId');
    }
    const state = AttemptState.create(record.state);
    if (!state.success || state.value === undefined) {
      throw new Error(`Attempt has an invalid state: ${String(record.state)}`);
    }
    return new Attempt({ ...record });
  }

  getId(): string {
    return this.record.id;
  }

  toRecord(): AttemptRecord {
    return { ...this.record };
  }

  getState(): AttemptStateValue {
    return this.record.state;
  }

  getSessionId(): string | null {
    return this.record.sessionId;
  }

  /** Fix rounds are fresh identities; they never resume a prior session. */
  isFix(): boolean {
    return this.record.kind === 'fix';
  }

  /**
   * Capacity is released only for ended, collected or cancelled attempts.
   * Unknown, running, dispatching, reconciling and blocked attempts retain
   * their reservation.
   */
  canReleaseCapacity(): boolean {
    return CAPACITY_RELEASE_STATES.includes(this.record.state);
  }

  /** Artifacts may be collected only after an authoritative end. */
  canCollect(): boolean {
    return (
      this.record.state === 'ended' &&
      this.record.completionReceipt !== null &&
      this.record.completionReceipt.authoritative
    );
  }

  /** A completion receipt belongs to this attempt and its session only. */
  matchesCompletionReceipt(attemptId: string, sessionId: string | null): boolean {
    if (this.record.completionReceipt === null || sessionId === null) {
      return false;
    }
    return (
      this.record.id === attemptId &&
      this.record.completionReceipt.attemptId === attemptId &&
      this.record.completionReceipt.sessionId === sessionId
    );
  }

  getRunner(): AttemptRunnerRecord | null | undefined {
    return this.record.runner;
  }

  getSeatOverride(): AttemptSeatOverrideRecord | null | undefined {
    return this.record.seatOverride;
  }

  getReviewerSeat(): string | null | undefined {
    return this.record.reviewerSeat;
  }
}
