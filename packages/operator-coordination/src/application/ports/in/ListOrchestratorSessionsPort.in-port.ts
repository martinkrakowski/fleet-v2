// @generated inbound contract scaffold — refined for lane O2a-2.
/**
 * ListOrchestratorSessionsPort: list sessions, optionally by status, with
 * `attached` and `attentive` derived from the injected clock, without mutating
 * state.
 */

import type {
  OrchestratorSessionRecord,
  OrchestratorSessionStatus,
} from '../../../domain/orchestrator-session-records.js';

export interface ListOrchestratorSessionsRequest {
  readonly status?: OrchestratorSessionStatus;
}

export interface ListOrchestratorSessionsEntry {
  readonly session: OrchestratorSessionRecord;
  readonly revision: number;
  readonly attached: boolean;
  readonly attentive: boolean;
}

export interface ListOrchestratorSessionsResult {
  readonly sessions: readonly ListOrchestratorSessionsEntry[];
}

export interface ListOrchestratorSessionsPort {
  listOrchestratorSessions(request?: ListOrchestratorSessionsRequest): Promise<ListOrchestratorSessionsResult>;
}
