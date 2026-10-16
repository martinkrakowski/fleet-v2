// @generated outbound contract scaffold — refined for step 5.
/**
 * CoordinationRequestRepositoryPort: persist scoped proposals, revisions,
 * acknowledgements and authorization-consumption receipts. Lookups return known
 * absence as null; they never synthesize a request that was not recorded.
 */

import type { CoordinationRequestRecord } from '../../../domain/coordination-records.js';

/**
 * A save the store refused because the record's revision is stale or conflicts
 * with the revision it freshly read: another writer moved the record first.
 * It is a lost race, not a malformed record, so a use case maps it to its own
 * typed outcome instead of letting an adapter error cross the boundary.
 */
export class CoordinationRequestRevisionConflictError extends Error {
  /** Id of the record whose revision moved under the writer. */
  readonly requestId: string;
  /** Revision the caller attempted to write. */
  readonly attemptedRevision: number;

  constructor(requestId: string, attemptedRevision: number, reason: string) {
    super(reason);
    this.name = 'CoordinationRequestRevisionConflictError';
    this.requestId = requestId;
    this.attemptedRevision = attemptedRevision;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface CoordinationRequestRepositoryPort {
  /** Persist one request revision; consumptions and acknowledgements ride along. */
  saveRequest(record: CoordinationRequestRecord): Promise<void>;

  /** Known absence is null. */
  findRequestById(requestId: string): Promise<CoordinationRequestRecord | null>;

  /** Locate the request a grant belongs to; known absence is null. */
  findRequestByGrantId(grantId: string): Promise<CoordinationRequestRecord | null>;

  /** List requests, optionally narrowed to one project. */
  listRequests(projectId?: string): Promise<readonly CoordinationRequestRecord[]>;
}
