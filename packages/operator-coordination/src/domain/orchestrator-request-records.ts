/**
 * Orchestrator request records are the pure, serializable facts of the
 * `OrchestratorRequest` aggregate: a closed, ids-only mailbox entry for one
 * web request — its kind, project, target, requesting session, creation and
 * expiry, and its lifecycle state, fence, lost-claim count, claim, deferral,
 * typed reason and dispatch link. They carry no behaviour and never a
 * credential; the domain refuses such text instead of redacting it.
 *
 * They are kept beside — never inside — the coordination records: a request
 * is a mailbox entry, not a run record, and it grants nothing — no
 * authorization use case ever reads it.
 */

import type { OrchestratorRequestKind } from './orchestrator-session-records.js';

/** Lifecycle (plan §3.6). `cancel-requested` is a claimed request the owner asked to cancel. */
export const ORCHESTRATOR_REQUEST_STATES = [
  'queued', 'claimed', 'cancel-requested', 'deferred',
  'dispatched', 'refused', 'expired', 'cancelled', 'stalled',
] as const;
export type OrchestratorRequestState = (typeof ORCHESTRATOR_REQUEST_STATES)[number];

/** States no transition leaves. */
export const ORCHESTRATOR_REQUEST_TERMINAL_STATES = [
  'dispatched', 'refused', 'expired', 'cancelled', 'stalled',
] as const satisfies readonly OrchestratorRequestState[];

/** Typed reason an orchestrator refuses or defers (plan §3.6 F8). */
export const ORCHESTRATOR_REQUEST_REASON_KINDS = [
  'seat-unavailable', 'capacity', 'brief-stale', 'policy', 'owner-asked-first', 'other',
] as const;
export type OrchestratorRequestReasonKind = (typeof ORCHESTRATOR_REQUEST_REASON_KINDS)[number];

/** How a request reached the mailbox. Only the web, from its session. */
export const ORCHESTRATOR_REQUEST_VIAS = ['web'] as const;
export type OrchestratorRequestVia = (typeof ORCHESTRATOR_REQUEST_VIAS)[number];

/** The one target id each kind names (plan §3.6 "Kinds"). */
export const ORCHESTRATOR_REQUEST_TARGET_KEY = {
  'dispatch-attempt': 'attemptId',   // a prepared attempt
  'start-lane-run': 'workOrderId',   // a work order
  'prepare-fix': 'attemptId',        // only the prior attempt
  'request-review': 'attemptId',     // provisional: the review kind enum arrives with O2c (RW1)
  'resume-run': 'runId',             // a non-one-way park
} as const satisfies Record<OrchestratorRequestKind, 'attemptId' | 'workOrderId' | 'runId'>;

/** The record a dispatched request links to (plan §3.6 F4). */
export const ORCHESTRATOR_REQUEST_LINK_KEY = {
  'dispatch-attempt': 'attemptId',
  'start-lane-run': 'runId',
  'prepare-fix': 'attemptId',
  'request-review': 'attemptId',     // provisional, as above
  'resume-run': 'runId',
} as const satisfies Record<OrchestratorRequestKind, 'attemptId' | 'runId'>;

export type OrchestratorRequestTargetRecord =
  | { readonly attemptId: string }
  | { readonly workOrderId: string }
  | { readonly runId: string };

export interface OrchestratorRequestRequestedByRecord {
  readonly via: OrchestratorRequestVia;
  readonly sessionId: string;
}

/** The current (or, once ended, the deciding) claim. `fence` equals the record's `fence`. */
export interface OrchestratorRequestClaimRecord {
  readonly orchestratorId: string;
  readonly fence: number;
  readonly leaseUntilIso: string;
}

export interface OrchestratorRequestReasonRecord {
  readonly reasonKind: OrchestratorRequestReasonKind;
  /** At most 1 KiB of plain text, secret-scanned; rendered as text only. */
  readonly detail: string | null;
}

/** Set only on `dispatched`; `journalKey` is always `request/<requestId>`. */
export type OrchestratorRequestLinkRecord =
  | { readonly attemptId: string; readonly journalKey: string }
  | { readonly runId: string; readonly journalKey: string };

/** Serializable snapshot of the OrchestratorRequest aggregate. */
export interface OrchestratorRequestRecord {
  /** Client-minted ULID; the idempotency key. */
  readonly requestId: string;
  readonly revision: number;
  readonly kind: OrchestratorRequestKind;
  readonly projectId: string;
  readonly target: OrchestratorRequestTargetRecord;
  readonly requestedBy: OrchestratorRequestRequestedByRecord;
  readonly createdAtIso: string;
  readonly expiresAtIso: string;
  /** The last write (any transition or lease renewal). */
  readonly updatedAtIso: string;
  readonly state: OrchestratorRequestState;
  /** Highest fence ever issued; 0 before the first claim. Every claim is issued `fence + 1`. */
  readonly fence: number;
  /** Claims lost to an expired lease (0, 1 or 2); 2 means stalled. */
  readonly claimCount: number;
  readonly claim: OrchestratorRequestClaimRecord | null;
  readonly deferredUntilIso: string | null;
  readonly reason: OrchestratorRequestReasonRecord | null;
  readonly linked: OrchestratorRequestLinkRecord | null;
}
