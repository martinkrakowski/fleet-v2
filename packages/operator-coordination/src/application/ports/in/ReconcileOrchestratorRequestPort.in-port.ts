// @generated inbound contract scaffold — refined for lane O2c-1.
/**
 * ReconcileOrchestratorRequestPort: journal-key reconciliation of orchestrator
 * requests (plan §3.6, O2c). One use case with three closed actions over one
 * stored request — `claim`, `record-intent`, `record-result` — writing the K1b
 * journal key `request/<requestId>`: an intent carrying the full request digest
 * before any caller acts, its result after. The use case never starts a run,
 * prepares a fix, requests a review or resumes a run itself; it only claims and
 * journals. Results carry fixed codes only, never paths, hosts or request text.
 */

export type ReconcileOrchestratorRequestAction = 'claim' | 'record-intent' | 'record-result';

export type ReconcileOrchestratorRequestResult =
  | { readonly outcome: 'claimed'; readonly requestId: string; readonly revision: number; readonly fence: number }
  | { readonly outcome: 'reconcile'; readonly requestId: string; readonly revision: number; readonly fence: number }
  | { readonly outcome: 'already-dispatched'; readonly requestId: string }
  | { readonly outcome: 'already-refused'; readonly requestId: string }
  | { readonly outcome: 'intent-recorded'; readonly requestId: string }
  | { readonly outcome: 'result-recorded'; readonly requestId: string }
  | { readonly outcome: 'unchanged'; readonly requestId: string }
  | { readonly outcome: 'refused'; readonly requestId: string | null; readonly code: string }
  | { readonly outcome: 'unknown'; readonly requestId: string | null; readonly code: string };

export interface ReconcileOrchestratorRequestPort {
  execute(action: unknown, body: unknown): Promise<ReconcileOrchestratorRequestResult>;
}
