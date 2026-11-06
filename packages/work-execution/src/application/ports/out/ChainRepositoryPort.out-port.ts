/**
 * ChainRepositoryPort: store and read ChainRecord v1 records per project with
 * compare-and-set on the record revision. An unreadable or unknown-version
 * record is reported, never treated as absent. The port performs no forge or
 * git action. Every call carries a deadline.
 */

import type { ChainRecord, ChainRepositoryRef } from '../../../domain/chain-records.js';

export interface ChainIntentCommand {
  /** State `intent-recorded`, revision 1. */
  readonly record: ChainRecord;
  readonly deadlineIso: string;
}

export interface ChainOutcomeCommand {
  readonly repository: ChainRepositoryRef;
  readonly chainName: string;
  /** The intent the outcome belongs to; an outcome for another key is refused. */
  readonly actionKey: string;
  /** Compare-and-set: applies only to the record at this revision. */
  readonly expectedRevision: number;
  readonly state: 'started' | 'refused';
  readonly reason: string | null;
  readonly deadlineIso: string;
}

export type ChainRecordDecision =
  | { readonly outcome: 'recorded' }
  /** A second intent with the same key; the first record stands. */
  | { readonly outcome: 'already-recorded' }
  | { readonly outcome: 'refused'; readonly reason: string };

export type ChainRecordRead =
  | { readonly status: 'ok'; readonly record: ChainRecord }
  | { readonly status: 'not-found' }
  | { readonly status: 'unreadable'; readonly reason: string };

export interface ChainReadCommand {
  readonly repository: ChainRepositoryRef;
  readonly chainName: string;
  readonly deadlineIso: string;
}

export interface ChainReviewPinCommand {
  readonly repository: ChainRepositoryRef;
  readonly chainName: string;
  /** Compare-and-set: applies only to the record at this revision. */
  readonly expectedRevision: number;
  readonly pin: {
    readonly headSha: string;
    readonly requestId: string;
    readonly key: string;
    readonly pinnedAtIso: string;
  };
  readonly deadlineIso: string;
}

export type ChainReviewPinDecision =
  | { readonly outcome: 'recorded' }
  /** The record already carries this pin (same key and head). */
  | { readonly outcome: 'already-recorded' }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface ChainRepositoryPort {
  recordChainIntent(command: ChainIntentCommand): Promise<ChainRecordDecision>;
  recordChainOutcome(command: ChainOutcomeCommand): Promise<ChainRecordDecision>;
  readChain(command: ChainReadCommand): Promise<ChainRecordRead>;
  /**
   * Pin the chain tip a combined review covers; never overwrites a stored pin
   * with another.
   */
  recordChainReviewPin(command: ChainReviewPinCommand): Promise<ChainReviewPinDecision>;
}
