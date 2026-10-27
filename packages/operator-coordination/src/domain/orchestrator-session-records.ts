/**
 * Orchestrator session records are the pure, serializable facts of the
 * `OrchestratorSession` aggregate: which agent CLI is registered as an
 * orchestrator, what it may claim, its token scopes, its heartbeat lease and
 * the last time it polled the request mailbox. They carry no behaviour and
 * never a credential, token or client secret; the domain refuses such text
 * instead of redacting it.
 *
 * They are kept beside — never inside — the coordination records: an
 * orchestrator session is its own aggregate, and no authorization use case
 * reads it.
 */

/** The agent CLI the orchestrator runs in. */
export const ORCHESTRATOR_CLI_KINDS = ['claude-code', 'agy', 'opencode', 'codex', 'conductor', 'other'] as const;
export type OrchestratorCliKind = (typeof ORCHESTRATOR_CLI_KINDS)[number];

/** Web request kinds a session may claim (plan §3.6). Nothing else ever goes through the channel. */
export const ORCHESTRATOR_REQUEST_KINDS = [
  'dispatch-attempt', 'start-lane-run', 'prepare-fix', 'request-review', 'resume-run',
] as const;
export type OrchestratorRequestKind = (typeof ORCHESTRATOR_REQUEST_KINDS)[number];

/** API scopes a session's token may hold. Never `dispatch` (D1) and never `verdict` (owner-only). */
export const ORCHESTRATOR_SESSION_SCOPES = ['read', 'message', 'hook', 'operate', 'orchestrate', 'tail'] as const;
export type OrchestratorSessionScope = (typeof ORCHESTRATOR_SESSION_SCOPES)[number];

/** `retired` is explicit (SIGTERM, stdin closed); a lapsed lease is derived, never a status. */
export const ORCHESTRATOR_SESSION_STATUSES = ['active', 'retired'] as const;
export type OrchestratorSessionStatus = (typeof ORCHESTRATOR_SESSION_STATUSES)[number];

/** Serializable snapshot of the OrchestratorSession aggregate. */
export interface OrchestratorSessionRecord {
  readonly orchestratorId: string;
  readonly cliKind: OrchestratorCliKind;
  /** The model the agent reports, or null when it did not say. */
  readonly model: string | null;
  readonly host: string;
  /** Project ids this session coordinates; empty means none. */
  readonly projects: readonly string[];
  readonly claims: readonly OrchestratorRequestKind[];
  readonly scopes: readonly OrchestratorSessionScope[];
  readonly startedAtIso: string;
  readonly lastHeartbeatIso: string;
  readonly leaseUntilIso: string;
  /** Null until the session first polls the request mailbox. */
  readonly lastPolledRequestsAtIso: string | null;
  readonly status: OrchestratorSessionStatus;
}
