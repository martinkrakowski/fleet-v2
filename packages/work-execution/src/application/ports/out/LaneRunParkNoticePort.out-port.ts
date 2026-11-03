// @generated outbound contract scaffold — refined for K6-3.
/**
 * LaneRunParkNoticePort: raise one attention item per parked run and reason,
 * and ask one keyed owner question where the owner must choose; ids and
 * reason codes, plus, for the blocker park, the bounded findings view; a
 * repeat returns the existing notice.
 */

import type { LaneRunParkFindingView } from '../../../domain/park-findings-view.js';

/** One parked run's coordinates. `reason` and `qualifier` are codes, never free text. */
export interface LaneRunParkRequest {
  /** Stable idempotency key of the notice, per (project, work order, reason). */
  readonly key: string;
  readonly projectId: string;
  readonly workOrderId: string;
  readonly runId: string;
  readonly reason: string;
  /** The run's park ordinal; names the park occurrence in the item summary. */
  readonly parkCount?: number;
  readonly qualifier?: string;
  /** Bounded, sanitized by the caller; the adapter re-checks the caps. */
  readonly findings?: readonly LaneRunParkFindingView[];
}

export type LaneRunParkNoticeResult =
  | { readonly outcome: 'recorded'; readonly questionId?: string }
  | { readonly outcome: 'exists'; readonly questionId?: string }
  | { readonly outcome: 'refused'; readonly reason: string };

/** Lifecycle state of the asked park question, as the conductor may read it. */
export type LaneRunParkQuestionState = 'open' | 'answered' | 'expired';

export type LaneRunParkFindResult =
  | { readonly outcome: 'found'; readonly questionId: string; readonly state: LaneRunParkQuestionState }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'unavailable' };

export interface LaneRunParkNoticePort {
  /** Raise the run's attention item; a repeat of the same park occurrence writes nothing; a new park of the run refreshes or reopens it. */
  recordParkAttention(request: LaneRunParkRequest): Promise<LaneRunParkNoticeResult>;
  /** Ask the keyed owner question for reasons the owner must decide; a repeat returns the stored question. */
  askParkQuestion(request: LaneRunParkRequest): Promise<LaneRunParkNoticeResult>;
  /** Read the question previously asked under the key; reads write nothing. */
  findParkQuestion(request: { readonly key: string }): Promise<LaneRunParkFindResult>;
}
