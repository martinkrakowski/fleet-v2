// @generated outbound contract scaffold — refined for step 5.
/**
 * CoordinationRequestRepositoryPort: persist scoped proposals, revisions,
 * acknowledgements and authorization-consumption receipts. Lookups return known
 * absence as null; they never synthesize a request that was not recorded.
 */

import type { CoordinationRequestRecord } from '../../../domain/coordination-records.js';

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
