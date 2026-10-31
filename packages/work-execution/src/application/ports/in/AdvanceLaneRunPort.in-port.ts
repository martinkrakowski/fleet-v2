// @generated inbound contract scaffold — refined for lane K4-4a.
/**
 * AdvanceLaneRunPort: one driver step of the conductor (plan §3.1). The
 * advance loads the run, checks the caller's run lease, gathers the facts
 * (the lane's end from the runner, seats, gate, stops and parks from the
 * keyed journal), asks the pure decider, and performs at most one external
 * action with its keyed intent before it and its result after it; an intent
 * without a result is reconciled and a one-way action is never repeated
 * (§3.5). Time enters only through `nowIso`; ids come from the injected
 * ULID supplier.
 */

import type { LaneRunWaitReason } from '../../../domain/lane-run-decider.js';
import type { LaneRunJournalOutcome } from '../../../domain/lane-run-journal.js';
import type { LaneRunKeyStep, LaneRunParkReason } from '../../../domain/lane-run-records.js';
import type { LaneRunResultReasonCode } from '../../../domain/lane-run-step-facts.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';

/**
 * The session-start gate (KF-34a1): one ask before any one-way intent that
 * starts a lane session. A denial answers the ms until the run's reserved
 * turn; when absent, nothing is gated.
 */
export interface SessionStartGate {
  tryStart(runId: string, nowIso: string): { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number };
}

export interface AdvanceLaneRunRequest {
  readonly runId: string;
  /** The run lease the driver holds (K3); every write checks it first. */
  readonly lease: { readonly holderId: string; readonly fence: number };
  /** The halt marker (§3.7), read by the driver. */
  readonly halted: boolean;
  readonly nowIso: string;
  /** The session-start gate to consult before a dispatch or review intent; when absent nothing is gated. */
  readonly startGate?: SessionStartGate;
}

export type AdvanceLaneRunRefusal =
  | 'invalid-request' | 'run-not-found' | 'lease-not-held' | 'lease-expired'
  | 'journal-refused' | 'save-refused' | 'illegal-transition';

export type AdvanceLaneRunResult =
  | { readonly outcome: 'entered'; readonly state: LaneRunStateValue }
  | { readonly outcome: 'parked'; readonly reason: LaneRunParkReason; readonly qualifier: string | null }
  | { readonly outcome: 'repaired'; readonly state: LaneRunStateValue }
  | { readonly outcome: 'waiting'; readonly reason: LaneRunWaitReason }
  | { readonly outcome: 'done' }
  | { readonly outcome: 'acted'; readonly step: LaneRunKeyStep; readonly key: string;
      readonly result: LaneRunJournalOutcome; readonly reasonCode: LaneRunResultReasonCode | null }
  | { readonly outcome: 'not-built'; readonly decision: 'act' | 'reconcile' | 'cancel'; readonly step: LaneRunKeyStep }
  | { readonly outcome: 'not-wired'; readonly step: LaneRunKeyStep }
  | { readonly outcome: 'refused'; readonly reason: AdvanceLaneRunRefusal };

export interface AdvanceLaneRunPort {
  /** One driver step: at most one external action, keyed intent before it, result after it. */
  advanceLaneRun(request: AdvanceLaneRunRequest): Promise<AdvanceLaneRunResult>;
}
