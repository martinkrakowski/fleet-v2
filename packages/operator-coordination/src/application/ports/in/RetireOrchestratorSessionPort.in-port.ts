// @generated inbound contract scaffold — refined for lane O2a-2 and O3-0.
/**
 * RetireOrchestratorSessionPort: mark a session retired, idempotently;
 * retirement ends its lease. Only the token that registered a session may
 * retire it; any other token gets `not-owner` and nothing is written.
 */

import type { OrchestratorSessionRecord } from '../../../domain/orchestrator-session-records.js';

export type RetireOrchestratorSessionResult =
  | { readonly outcome: 'retired'; readonly session: OrchestratorSessionRecord; readonly revision: number }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'not-owner' }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface RetireOrchestratorSessionPort {
  retireOrchestratorSession(
    request: { orchestratorId: string },
    presentedTokenId: string,
  ): Promise<RetireOrchestratorSessionResult>;
}
