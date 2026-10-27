// @generated inbound contract scaffold — refined for lane O2a-2.
/**
 * RetireOrchestratorSessionPort: mark a session retired, idempotently;
 * retirement ends its lease.
 */

import type { OrchestratorSessionRecord } from '../../../domain/orchestrator-session-records.js';

export type RetireOrchestratorSessionResult =
  | { readonly outcome: 'retired'; readonly session: OrchestratorSessionRecord; readonly revision: number }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface RetireOrchestratorSessionPort {
  retireOrchestratorSession(request: { orchestratorId: string }): Promise<RetireOrchestratorSessionResult>;
}
