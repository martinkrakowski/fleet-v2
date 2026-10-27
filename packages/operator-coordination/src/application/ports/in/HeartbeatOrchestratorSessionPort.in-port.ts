// @generated inbound contract scaffold — refined for lane O2a-2 and O3-0.
/**
 * HeartbeatOrchestratorSessionPort: renew an active session's lease from the
 * injected clock. A heartbeat writes only the lease and is never announced as
 * a data change. Only the token that registered a session may renew it; any
 * other token gets `not-owner` and nothing is written.
 */

import type { OrchestratorSessionRecord } from '../../../domain/orchestrator-session-records.js';

export type HeartbeatOrchestratorSessionResult =
  | { readonly outcome: 'renewed'; readonly session: OrchestratorSessionRecord; readonly revision: number }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'not-owner' }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface HeartbeatOrchestratorSessionPort {
  heartbeatOrchestratorSession(
    request: { orchestratorId: string },
    presentedTokenId: string,
  ): Promise<HeartbeatOrchestratorSessionResult>;
}
