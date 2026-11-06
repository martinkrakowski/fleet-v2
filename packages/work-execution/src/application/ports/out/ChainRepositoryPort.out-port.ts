/**
 * ChainRepositoryPort: store and read ChainRecord v1 records per project with
 * compare-and-set on the record revision. An unreadable or unknown-version
 * record is reported, never treated as absent. The port performs no forge or
 * git action. Every call carries a deadline.
 */

import type { ChainRecord, ChainRefreshTerminalOutcome, ChainRepositoryRef } from '../../../domain/chain-records.js';

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
  /**
   * List the chain records of one repository. A known absence is an empty list
   * inside `ok`; an unreadable store or an over-long list is `unreadable`, never
   * truncated.
   */
  listChains(command: ChainListCommand): Promise<ChainListResult>;
  /**
   * Record the keyed chain-refresh intent by compare-and-set on `revision`. The
   * intent is written once per key (`already-recorded` on a repeat); a stale
   * revision refuses as `stale-revision`.
   */
  recordChainRefreshIntent(command: ChainRefreshIntentCommand): Promise<ChainRecordDecision>;
  /**
   * Record the chain-refresh outcome by compare-and-set on `revision`: `conflict`
   * sets the conflict mark, `merged` and `up-to-date` clear it, and `branch-gone`
   * leaves it unchanged.
   */
  recordChainRefreshOutcome(command: ChainRefreshOutcomeCommand): Promise<ChainRecordDecision>;
}

export interface ChainListCommand {
  readonly repository: ChainRepositoryRef;
  readonly deadlineIso: string;
}

export type ChainListResult =
  | { readonly status: 'ok'; readonly records: readonly ChainRecord[] }
  | { readonly status: 'unreadable'; readonly reason: string };

export interface ChainRefreshIntentCommand {
  readonly repository: ChainRepositoryRef;
  readonly chainName: string;
  /** `chain-refresh/<name>@<main12>`. */
  readonly key: string;
  /** 40 lowercase hex: the `main` head the refresh merges. */
  readonly mainSha: string;
  /** Compare-and-set: applies only to the record at this revision. */
  readonly expectedRevision: number;
  readonly atIso: string;
  readonly deadlineIso: string;
}

export interface ChainRefreshOutcomeCommand {
  readonly repository: ChainRepositoryRef;
  readonly chainName: string;
  /** The intent the outcome belongs to; an outcome for another key is refused. */
  readonly key: string;
  /** Compare-and-set: applies only to the record at this revision. */
  readonly expectedRevision: number;
  readonly outcome: ChainRefreshTerminalOutcome;
  readonly atIso: string;
  readonly deadlineIso: string;
}
