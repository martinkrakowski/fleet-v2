// @generated inbound contract scaffold — refined for lane O2a-2.
/**
 * HeartbeatOrchestratorSessionPort: renew an active session's lease from the
 * injected clock. A heartbeat writes only the lease and is never announced as
 * a data change.
 */

import type { OrchestratorSessionRecord } from '../../../domain/orchestrator-session-records.js';

export type HeartbeatOrchestratorSessionResult =
  | { readonly outcome: 'renewed'; readonly session: OrchestratorSessionRecord; readonly revision: number }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface HeartbeatOrchestratorSessionPort {
  heartbeatOrchestratorSession(request: { orchestratorId: string }): Promise<HeartbeatOrchestratorSessionResult>;
}
