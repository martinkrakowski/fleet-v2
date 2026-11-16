/**
 * RecordShadowDayPort evaluates one completed UTC day of the cutover shadow
 * period for one repository and records, in the shadow-evidence ledger by
 * compare-and-set, each criterion that reached a definite pass or fail
 * verdict. A criterion whose sources are unreadable, incomplete or not yet
 * built is reported as `unevaluated` and recorded nowhere. The day rules
 * refuse the current day, a future day, a day whose grace period has not
 * ended and a day older than seven days. It reads the shell train state and
 * the fleet stores read-only and writes only the ledger. Ids, digests and
 * codes only.
 */

import type { CutoverShadowCriterion } from '../../../domain/cutover-records.js';

/** One shadow-day recording request; `nowIso` overrides the dependency clock. */
export interface RecordShadowDayRequest {
  /** The UTC calendar date to evaluate (`YYYY-MM-DD`), strictly in the past and past its grace. */
  readonly day: string;
  /** The release the day's merges were compared against (40-hex oid). */
  readonly releaseSha: string;
  /** How many merges the day compared. */
  readonly mergesCompared: number;
  readonly nowIso?: string;
  readonly deadlineIso?: string;
}

export type RecordShadowDayRefusalReason =
  | 'invalid-request'
  | 'secret-shaped'
  | 'invalid-day'
  | 'future-day'
  | 'current-day'
  | 'grace-period'
  | 'day-too-old'
  | 'day-criterion-conflict';

export type RecordShadowDayUnknownReason =
  | 'deadline-exceeded'
  | 'clock-invalid'
  | 'ledger-unreadable'
  | 'ledger-unknown-version'
  | 'ledger-write-failed';

/** What one criterion's sources answered for the requested day. */
export type ShadowCriterionEvaluation =
  | {
      readonly status: 'evaluated';
      readonly verdict: 'pass' | 'fail';
      readonly reasonCode: string;
      readonly inputDigest: string;
    }
  | { readonly status: 'unevaluated'; readonly reason: string };

export interface RecordedShadowDayVerdict {
  readonly criterion: CutoverShadowCriterion;
  readonly verdict: 'pass' | 'fail';
  readonly reasonCode: string;
  readonly inputDigest: string;
}

export interface UnevaluatedShadowCriterion {
  readonly criterion: CutoverShadowCriterion;
  readonly reason: string;
}

export type RecordShadowDayResult =
  | {
      readonly outcome: 'completed';
      readonly day: string;
      readonly revision: number;
      /** True when every verdict this pass reached was already recorded identically. */
      readonly identicalRepeat: boolean;
      readonly recorded: readonly RecordedShadowDayVerdict[];
      readonly unevaluated: readonly UnevaluatedShadowCriterion[];
    }
  | { readonly outcome: 'refused'; readonly reason: RecordShadowDayRefusalReason }
  | { readonly outcome: 'unknown'; readonly reason: RecordShadowDayUnknownReason };

export interface RecordShadowDayPort {
  execute(request: unknown): Promise<RecordShadowDayResult>;
}
