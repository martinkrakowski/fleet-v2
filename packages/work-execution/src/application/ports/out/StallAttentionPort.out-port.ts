/**
 * StallAttentionPort (PT1a): raise, clear and list the conductor's stall
 * attention items, one per stalled run, keyed `stall:<runId>`, through
 * operator coordination's attention store. A repeat refreshes the open item
 * and never adds a second; clearing resolves it. The item grants and blocks
 * nothing. Ids, a park class and an age only; a failed call is reported as a
 * value, never thrown and never retried blindly.
 */

import type { LaneRunParkClass } from '../../../domain/park-class.js';

export interface RaiseStallAttentionCommand {
  readonly projectId: string;
  readonly workOrderId: string;
  readonly runId: string;
  readonly parkClass: LaneRunParkClass;
  /** Whole minutes the run has been parked. */
  readonly ageMinutes: number;
}

export interface ClearStallAttentionCommand {
  readonly projectId: string;
  readonly runId: string;
}

export type RaiseStallAttentionResult =
  | { readonly outcome: 'raised' | 'refreshed' | 'reopened'; readonly reasonCode: null }
  | { readonly outcome: 'refused'; readonly reasonCode: string };

export type ClearStallAttentionResult =
  | { readonly outcome: 'cleared' | 'unchanged' | 'not-found'; readonly reasonCode: null }
  | { readonly outcome: 'refused'; readonly reasonCode: string };

export type ListOpenStallAttentionResult =
  | { readonly outcome: 'found'; readonly items: readonly ClearStallAttentionCommand[] }
  | { readonly outcome: 'unavailable' };

export interface StallAttentionPort {
  raiseStallAttention(command: RaiseStallAttentionCommand): Promise<RaiseStallAttentionResult>;
  clearStallAttention(command: ClearStallAttentionCommand): Promise<ClearStallAttentionResult>;
  /** The runs whose stall item is open now (read-only). */
  listOpenStallAttention(): Promise<ListOpenStallAttentionResult>;
}
