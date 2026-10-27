// @generated inbound contract scaffold — refined for lane O2a-2.
/**
 * RegisterOrchestratorSessionPort: record a new active orchestrator session
 * from a closed registration body with the injected clock. A session's scopes
 * come only from the presenting token's own scopes, passed separately by the
 * composition root — never read from the request body — and a record grants
 * nothing.
 */

import type { OrchestratorSessionRecord } from '../../../domain/orchestrator-session-records.js';

/** The only source of "now" for the orchestrator session use cases; injected, never from a request. */
export interface OrchestratorSessionClock { readonly nowIso: () => string; }

/** The registration body: exactly these keys. It never carries scopes, status or times. */
export interface RegisterOrchestratorSessionBody {
  readonly orchestratorId: string;
  readonly cliKind: string;
  readonly model: string | null;
  readonly host: string;
  readonly projects: readonly string[];
  readonly claims: readonly string[];
}

export type RegisterOrchestratorSessionResult =
  | { readonly outcome: 'registered'; readonly session: OrchestratorSessionRecord; readonly revision: number }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface RegisterOrchestratorSessionPort {
  /**
   * `body` is the untrusted request body. `presentedScopes` are the presenting token's own scopes,
   * supplied by the composition root from authentication — never read from the body.
   */
  registerOrchestratorSession(body: unknown, presentedScopes: readonly string[]): Promise<RegisterOrchestratorSessionResult>;
}
