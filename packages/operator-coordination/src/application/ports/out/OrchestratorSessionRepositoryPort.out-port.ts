// @generated outbound contract scaffold — refined for lane O2a-1.
/**
 * OrchestratorSessionRepositoryPort: persist orchestrator sessions as their own
 * aggregate in their own file; never shares another store, and no authorization
 * use case reads it. A stored session grants nothing.
 */

import type {
  OrchestratorSessionRecord,
  OrchestratorSessionStatus,
} from '../../../domain/orchestrator-session-records.js';

/** A save that lost a race: the stored revision is not the one the caller read. */
export class OrchestratorSessionRevisionConflictError extends Error {
  /** Id of the session whose revision moved under the writer. */
  readonly orchestratorId: string;
  /** Revision the caller attempted to write. */
  readonly attemptedRevision: number;

  constructor(orchestratorId: string, attemptedRevision: number, reason: string) {
    super(reason);
    this.name = 'OrchestratorSessionRevisionConflictError';
    this.orchestratorId = orchestratorId;
    this.attemptedRevision = attemptedRevision;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** One stored session and the store's revision of it. The revision lives beside, never inside, the record. */
export interface StoredOrchestratorSession {
  readonly revision: number;
  readonly session: OrchestratorSessionRecord;
}

export interface OrchestratorSessionListQuery {
  readonly status?: OrchestratorSessionStatus;
}

export interface OrchestratorSessionRepositoryPort {
  /** Store `session` at `expectedRevision + 1`; 0 means new. A moved revision raises the conflict error. */
  save(session: OrchestratorSessionRecord, expectedRevision: number): Promise<StoredOrchestratorSession>;
  /** Known absence is null. */
  get(orchestratorId: string): Promise<StoredOrchestratorSession | null>;
  /** Sorted by startedAtIso, then orchestratorId. */
  list(query?: OrchestratorSessionListQuery): Promise<readonly StoredOrchestratorSession[]>;
}
