// @generated outbound contract scaffold — refined for lane O2a-1.
/**
 * OrchestratorSessionRepositoryPort: persist orchestrator sessions as their own
 * aggregate in their own file; never shares another store, and no authorization
 * use case reads it. A stored session grants nothing.
 */

import type {
  OrchestratorRequestKind,
  OrchestratorSessionRecord,
  OrchestratorSessionScope,
  OrchestratorSessionStatus,
} from '../../../domain/orchestrator-session-records.js';

/**
 * A save that would leave a second ACTIVE session for one conductor identity
 * (host plus state directory). Typed so a caller can tell the invariant
 * refusal from a moved revision; the message never echoes a path or secret.
 */
export class OrchestratorSessionIdentityAlreadyActiveError extends Error {
  /** The stable refusal code of this typed error. */
  readonly code = 'identity-already-active';

  constructor() {
    super(
      'an active orchestrator session already exists for this conductor identity',
    );
    this.name = 'OrchestratorSessionIdentityAlreadyActiveError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}


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

/**
 * The conductor identity a session belongs to, and what a NEW session for
 * that identity is registered with. The identity's key is the host plus the
 * state directory of the identity's own store; both are screened before any
 * read, and neither is ever echoed. `stateDir: null` names this store's own
 * directory. The registration facts are used only when a new session is
 * registered; the registering token is named by id, never a token.
 */
export interface OrchestratorSessionIdentity {
  readonly host: string;
  readonly stateDir: string | null;
  readonly registration: {
    /** The id for a new session; an id that already exists is refused. */
    readonly orchestratorId: string;
    readonly model: string | null;
    readonly projects: readonly string[];
    readonly claims: readonly OrchestratorRequestKind[];
    readonly scopes: readonly OrchestratorSessionScope[];
    readonly registeredByTokenId: string;
  };
}

/**
 * One of exactly three outcomes, decided under the store's lock: the single
 * live session for the identity was adopted, a lapsed one was retired and a
 * new one registered, or a new one was registered over known absence.
 */
export type RegisterOrAdoptSessionResult =
  | {
      readonly outcome: 'adopted';
      readonly session: OrchestratorSessionRecord;
      readonly revision: number;
    }
  | {
      readonly outcome: 'registered';
      readonly session: OrchestratorSessionRecord;
      readonly revision: number;
    }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface OrchestratorSessionRepositoryPort {
  /**
   * ONE locked operation on this store, keyed by the conductor identity: under
   * the store's lock it adopts the single live session for the identity and
   * refreshes its heartbeat, or retires a lapsed one and registers a new one,
   * or registers when there is none. An unreadable store is refused and
   * registers nothing. A refused result never echoes the identity.
   */
  registerOrAdoptSession(
    identity: OrchestratorSessionIdentity,
    nowIso: string,
  ): Promise<RegisterOrAdoptSessionResult>;
  /** Store `session` at `expectedRevision + 1`; 0 means new. A moved revision raises the conflict error, and a second ACTIVE session for one conductor identity raises the typed `identity-already-active` error. */
  save(
    session: OrchestratorSessionRecord,
    expectedRevision: number,
  ): Promise<StoredOrchestratorSession>;
  /** Known absence is null. */
  get(orchestratorId: string): Promise<StoredOrchestratorSession | null>;
  /** Sorted by startedAtIso, then orchestratorId. */
  list(query?: OrchestratorSessionListQuery): Promise<readonly StoredOrchestratorSession[]>;
}
