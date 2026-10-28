// @generated outbound contract scaffold — refined for lane Q1a.
/**
 * OwnerQuestionRepositoryPort: persist owner questions as their own aggregate.
 * Owner questions never share the coordination requests store, and no
 * authorization use case reads them. Lookups return known absence as null.
 */

import type { OwnerQuestionRecord } from '../../../domain/owner-question-records.js';

/**
 * A save refused because the record's revision is stale or conflicts with the
 * revision the store freshly read: another writer moved the question first.
 * Like CoordinationRequestRevisionConflictError, this is a lost race, not a
 * malformed record, so a use case maps it to its own typed outcome instead of
 * letting an adapter error cross the boundary.
 */
export class OwnerQuestionRevisionConflictError extends Error {
  /** Id of the question whose revision moved under the writer. */
  readonly questionId: string;
  /** Revision the caller attempted to write. */
  readonly attemptedRevision: number;

  constructor(questionId: string, attemptedRevision: number, reason: string) {
    super(reason);
    this.name = 'OwnerQuestionRevisionConflictError';
    this.questionId = questionId;
    this.attemptedRevision = attemptedRevision;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A save refused because another question already holds the caller's
 * idempotency key. One question per key, forever; nothing is written.
 */
export class OwnerQuestionIdempotencyKeyConflictError extends Error {
  /** Id of the question whose save was refused. */
  readonly questionId: string;
  /** Id of the question already holding the key. */
  readonly heldByQuestionId: string;

  constructor(questionId: string, heldByQuestionId: string, reason: string) {
    super(reason);
    this.name = 'OwnerQuestionIdempotencyKeyConflictError';
    this.questionId = questionId;
    this.heldByQuestionId = heldByQuestionId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface OwnerQuestionListQuery {
  /** Only questions in this state. */
  readonly state?: OwnerQuestionRecord['state'];
  /** Only questions asked at or after this ISO timestamp. */
  readonly since?: string;
}

export interface OwnerQuestionRepositoryPort {
  /**
   * Persist one question revision. `expectedRevision` is the revision the
   * caller last read (0 for a new question); a store whose freshly read
   * revision differs raises OwnerQuestionRevisionConflictError. A new
   * question whose idempotencyKey another question holds raises
   * OwnerQuestionIdempotencyKeyConflictError and writes nothing; a save
   * that changes or removes a stored key is refused.
   */
  save(record: OwnerQuestionRecord, expectedRevision: number): Promise<void>;

  /** Known absence is null. */
  get(questionId: string): Promise<OwnerQuestionRecord | null>;

  /** Find the question holding `key`, or null when none does. Known absence is null. */
  findByIdempotencyKey(key: string): Promise<OwnerQuestionRecord | null>;

  /** List questions, optionally narrowed by state and asked-at lower bound. */
  list(query?: OwnerQuestionListQuery): Promise<readonly OwnerQuestionRecord[]>;
}
