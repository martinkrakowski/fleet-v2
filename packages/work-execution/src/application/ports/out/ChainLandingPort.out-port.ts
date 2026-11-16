// Outbound contract for lane CO10.
/**
 * ChainLandingPort: the writes and reads only a chain landing performs. The
 * keyed journal (`chain-land/...`) records the intent before any forge or
 * queue write and the final result after it; the landing mark is a
 * compare-and-set record per (repository, chain) that a re-check may withdraw.
 * `openOrAdopt` either opens one integration pull request onto `main` at the
 * expected head or adopts the one known open pull request; an outcome that
 * cannot be established is `ambiguous`, never a guess. `unfinishedBatch`
 * reports whether a merge batch still targets the chain. Every method takes a
 * deadline; an unreadable store is reported, never defaulted. Entries and
 * marks hold ids, shas, codes and digests only.
 */

import type { ChainRepositoryRef } from '../../../domain/chain-records.js';

export type ChainLandingJournalKind = 'intent' | 'result';

export interface ChainLandingJournalEntry {
  /** `chain-land/<name>@<head12>` or `chain-land/<name>/<step>@<head12>`. */
  readonly key: string;
  readonly kind: ChainLandingJournalKind;
  /** A ULID minted by the caller. */
  readonly entryId: string;
  readonly recordedAtIso: string;
  /** The canonical digest the intent (and its result) covers. */
  readonly digest: string;
  readonly deadlineIso: string;
}

export type ChainLandingAppendResult =
  | { readonly outcome: 'appended' }
  | { readonly outcome: 'refused'; readonly reason: 'duplicate-intent' | 'invalid-entry' };

export type ChainLandingListResult =
  | { readonly outcome: 'listed'; readonly entries: readonly ChainLandingJournalEntry[] }
  | { readonly outcome: 'unreadable' };

/** The stored landing mark: one per (repository, chain), compare-and-set on `revision`. */
export interface ChainLandingMark {
  readonly headSha: string;
  readonly pullRequestNumber: number;
  /** The journal key of the intent this mark belongs to. */
  readonly key: string;
  readonly state: 'landing' | 'withdrawn';
}

export type ChainLandingMarkFound = ChainLandingMark & { readonly revision: number };

export interface ChainLandingReadMarkCommand {
  readonly repository: ChainRepositoryRef;
  readonly chainName: string;
  readonly deadlineIso: string;
}

export type ChainLandingReadMarkResult =
  | { readonly outcome: 'missing'; readonly revision: 0 }
  | { readonly outcome: 'found'; readonly mark: ChainLandingMarkFound }
  | { readonly outcome: 'unreadable' };

export interface ChainLandingCompareAndSetMarkCommand {
  readonly repository: ChainRepositoryRef;
  readonly chainName: string;
  /** Compare-and-set: applies only to the mark at this revision. */
  readonly expectedRevision: number;
  readonly mark: ChainLandingMark;
  readonly deadlineIso: string;
}

export type ChainLandingCompareAndSetMarkResult =
  | { readonly outcome: 'recorded'; readonly revision: number }
  | { readonly outcome: 'already-recorded' }
  | { readonly outcome: 'refused'; readonly reason: 'stale-revision' | 'conflict' };

export interface ChainLandingOpenOrAdoptCommand {
  readonly repository: ChainRepositoryRef;
  /** `chain/<name>`: the integration branch the pull request merges. */
  readonly branchName: string;
  readonly baseBranch: 'main';
  /** 40 hex: the integration head the pull request must carry. */
  readonly expectedHeadSha: string;
  readonly title: string;
  readonly body: string;
  readonly tierLabel: 'tier:1' | 'tier:2';
  readonly mode: 'open' | 'adopt';
  /** The pull request to adopt; required for `adopt`, absent for `open`. */
  readonly pullRequestNumber?: number;
  /** The keyed intent id this forge action belongs to. */
  readonly actionId: string;
  readonly deadlineIso: string;
}

export type ChainLandingOpenOrAdoptResult =
  | { readonly outcome: 'opened' | 'adopted'; readonly pullRequestNumber: number; readonly headSha: string }
  | { readonly outcome: 'refused'; readonly reason: string }
  | { readonly outcome: 'ambiguous'; readonly reason: string };

export interface ChainLandingUnfinishedBatchCommand {
  readonly repository: ChainRepositoryRef;
  readonly chainName: string;
  readonly deadlineIso: string;
}

export type ChainLandingUnfinishedBatchResult =
  | { readonly outcome: 'none' }
  | { readonly outcome: 'targets'; readonly batchId: string }
  | { readonly outcome: 'unreadable' };

export interface ChainLandingPort {
  /** Append one journal entry under the store's guard; a refusal writes nothing. */
  append(entry: ChainLandingJournalEntry): Promise<ChainLandingAppendResult>;
  /** Every entry of exactly this key, in append order. */
  listByKey(key: string): Promise<ChainLandingListResult>;
  /** The stored landing mark, or `missing` (revision 0) when none is stored. */
  readMark(command: ChainLandingReadMarkCommand): Promise<ChainLandingReadMarkResult>;
  /** Record the landing mark by compare-and-set; `already-recorded` keeps the stored mark. */
  compareAndSetMark(command: ChainLandingCompareAndSetMarkCommand): Promise<ChainLandingCompareAndSetMarkResult>;
  /** Open or adopt the one integration pull request onto `main` at the expected head. */
  openOrAdopt(command: ChainLandingOpenOrAdoptCommand): Promise<ChainLandingOpenOrAdoptResult>;
  /** Whether a merge batch still targets the chain. */
  unfinishedBatch(command: ChainLandingUnfinishedBatchCommand): Promise<ChainLandingUnfinishedBatchResult>;
}
