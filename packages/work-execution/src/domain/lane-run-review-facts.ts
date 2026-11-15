/**
 * The review fact the conductor's decider reads for one review kind at one head
 * (plan §3.4, §3.5): pure over the keyed run journal, mirroring
 * `laneRunGateFact`. The review act's result entry carries one of the
 * `review-*` reason codes; the receipt itself stays in evidence. Pure: no
 * store, no clock; nothing throws; another run's entries never count.
 */

import type { LaneRunJournalEntryRecord } from './lane-run-journal.js';
import { parseLaneRunKey } from './lane-run-keys.js';
import { LANE_RUN_ID_PATTERN } from './lane-run-records.js';
import type { LaneRunReviewFact } from './lane-run-decider.js';

/** The review steps whose journal intents a review fact reads. */
export type LaneRunReviewKind = 'brief-check' | 'code-review' | 'pre-merge';

const NONE_FACT: LaneRunReviewFact = Object.freeze({ verdict: 'none', seatIndex: null, retries: 0 });

/** The final reason codes that are not a second verdict (RV4). */
const SKIPPED_REVIEW_FINAL_REASONS: ReadonlySet<string> = new Set(['seat-busy', 'review-superseded']);

/**
 * The `no-receipt` detail tokens that prove the reviewer seat was never
 * reached (U3/F189): the worktree was occupied before dispatch
 * (`seat-busy`) or the SSH/HTTP/runner transport failed before reaching a
 * review reply (`transport`). Both are exempt from spending the review-retry
 * budget; `timeout`, `route-no-auth-file` and null are not.
 */
export const LANE_RUN_REVIEW_UNREACHABLE_DETAILS: ReadonlySet<string> = new Set(['seat-busy', 'transport']);

/** Type guard for `LANE_RUN_REVIEW_UNREACHABLE_DETAILS`. */
export function isLaneRunReviewUnreachableDetail(detail: string | null | undefined): detail is 'seat-busy' | 'transport' {
  return detail !== null && detail !== undefined && LANE_RUN_REVIEW_UNREACHABLE_DETAILS.has(detail);
}

/** Consecutive unreachable step intents allowed per generation before the seat is judged unreachable (U3/F189). */
export const LANE_RUN_REVIEW_UNREACHABLE_MAX_ATTEMPTS = 4;

/** The key's final result (any non-ambiguous outcome) reason code; `undefined` when it has none. */
function finalReasonCodeOf(
  entries: readonly LaneRunJournalEntryRecord[],
  key: string,
): string | null | undefined {
  let reason: string | null | undefined = undefined;
  for (const entry of entries) {
    if (entry.kind === 'result' && entry.key === key && entry.outcome !== 'ambiguous') {
      reason = entry.reasonCode;
    }
  }
  return reason;
}

/**
 * The latest `resumed` / `review-retry` generation boundary of `runId` —
 * the `recordedAtIso` of the newest `resumed` result with detail
 * `review-retry` — or null when there is none. Shared by the intent-ignored
 * predicate and the review fact so both agree on which generation an intent
 * belongs to. Pure; never throws.
 */
function latestReviewRetryBoundaryIsoOf(
  entries: readonly LaneRunJournalEntryRecord[],
  runId: string,
): string | null {
  let latestBoundaryIso: string | null = null;
  for (const entry of entries) {
    if (
      entry.kind === 'result' &&
      entry.runId === runId &&
      entry.reasonCode === 'resumed' &&
      entry.detail === 'review-retry'
    ) {
      if (latestBoundaryIso === null || entry.recordedAtIso > latestBoundaryIso) {
        latestBoundaryIso = entry.recordedAtIso;
      }
    }
  }
  return latestBoundaryIso;
}

/**
 * True when a review intent is ignored by the review fact (RV4): its final
 * reason is `seat-busy` or `review-superseded` (not a second verdict), or it
 * predates the latest `resumed` result with detail `review-retry` (an older
 * generation superseded by a resume). Read-only over the journal; never throws.
 */
export function laneRunReviewIntentIgnored(
  entries: readonly LaneRunJournalEntryRecord[],
  runId: string,
  key: string,
  recordedAtIso: string,
): boolean {
  const finalReason = finalReasonCodeOf(entries, key);
  if (finalReason !== undefined && finalReason !== null && SKIPPED_REVIEW_FINAL_REASONS.has(finalReason)) {
    return true;
  }
  const latestBoundaryIso = latestReviewRetryBoundaryIsoOf(entries, runId);
  return latestBoundaryIso !== null && recordedAtIso < latestBoundaryIso;
}

/**
 * RV5: whether an earlier review intent at `head12` reached `review-passed`
 * and how many confirming re-reviews ran after a contradictory `failed`.
 * Pure: no store, no clock; nothing throws; malformed input fails closed.
 */
export interface LaneRunReviewConfirmationFact {
  readonly priorPassedAtHead: boolean;
  readonly confirmingRetries: number;
}

const NO_CONFIRMATION_FACT: LaneRunReviewConfirmationFact = Object.freeze({
  priorPassedAtHead: false,
  confirmingRetries: 0,
});

/** Defensive plain-object check (see `lane-run-decider.ts`). */
function isPlainRecordObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Own-property descriptor read without invoking getters (see `lane-run-decider.ts`). */
function ownProp(source: unknown, key: string): unknown {
  try {
    if (typeof source !== 'object' || source === null) {
      return undefined;
    }
    return Object.getOwnPropertyDescriptor(source, key)?.value;
  } catch {
    return undefined;
  }
}

/**
 * The latest non-`ambiguous` result entry for `key`'s reason code, read
 * defensively over untrusted records: `undefined` when absent, malformed, or
 * when the entry's reason code is neither `null` nor a string. Never throws.
 */
function safeFinalReasonCodeOf(entries: readonly unknown[], key: string): string | null | undefined {
  let reason: string | null | undefined = undefined;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (ownProp(entry, 'kind') !== 'result' || ownProp(entry, 'key') !== key) {
      continue;
    }
    if (ownProp(entry, 'outcome') === 'ambiguous') {
      continue;
    }
    const reasonCode = ownProp(entry, 'reasonCode');
    if (reasonCode === null || typeof reasonCode === 'string') {
      reason = reasonCode;
    } else {
      reason = undefined;
    }
  }
  return reason;
}

/**
 * RV5: the confirmation fact of `kind` at `head12` — `priorPassedAtHead` when
 * an earlier step intent of exactly `kind` at `head12` finally reached
 * `review-passed`, and `confirmingRetries` counting the step intents issued
 * after a contradictory `review-failed` on that same head (the bounded
 * confirming re-reviews). Intents whose final reason is `seat-busy` or
 * `review-superseded` are not verdicts and are skipped. Malformed or hostile
 * input fails closed to `NO_CONFIRMATION_FACT`; nothing throws.
 */
export function laneRunReviewConfirmationFact(
  entries: readonly LaneRunJournalEntryRecord[],
  runId: string,
  kind: LaneRunReviewKind,
  head12: string | null,
): LaneRunReviewConfirmationFact {
  try {
    if (!Array.isArray(entries)) {
      return NO_CONFIRMATION_FACT;
    }
    if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
      return NO_CONFIRMATION_FACT;
    }
    if (typeof head12 !== 'string' || head12.length !== 12) {
      return NO_CONFIRMATION_FACT;
    }
    if (kind !== 'brief-check' && kind !== 'code-review' && kind !== 'pre-merge') {
      return NO_CONFIRMATION_FACT;
    }
    for (let index = 0; index < entries.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(entries, index) || !isPlainRecordObject(entries[index])) {
        return NO_CONFIRMATION_FACT;
      }
    }
    let sawPassed = false;
    let sawFailedAfterPass = false;
    let confirmingRetries = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (ownProp(entry, 'kind') !== 'intent' || ownProp(entry, 'runId') !== runId) {
        continue;
      }
      const entryKey = ownProp(entry, 'key');
      if (typeof entryKey !== 'string') {
        continue;
      }
      const parsed = parseLaneRunKey(entryKey);
      if (parsed === null || parsed.kind !== 'step' || parsed.runId !== runId) {
        continue;
      }
      if (parsed.step !== kind || parsed.head12 !== head12) {
        continue;
      }
      const finalReason = safeFinalReasonCodeOf(entries, entryKey);
      if (finalReason === 'seat-busy' || finalReason === 'review-superseded') {
        continue;
      }
      if (sawFailedAfterPass) {
        confirmingRetries += 1;
      } else if (sawPassed && finalReason === 'review-failed') {
        sawFailedAfterPass = true;
      } else if (finalReason === 'review-passed') {
        sawPassed = true;
      }
    }
    return Object.freeze({ priorPassedAtHead: sawPassed, confirmingRetries });
  } catch {
    return NO_CONFIRMATION_FACT;
  }
}

/**
 * The review fact for `kind` at `head12` (plan §3.4): `head12 === null` → `none`.
 * Considers the run's step intents of exactly `kind` at `head12`, ignoring an
 * intent whose final reason is `seat-busy`/`review-superseded` or that predates
 * the latest `resumed`/`review-retry` generation boundary; the LATEST remaining
 * intent (journal order) decides — no final result → `pending`; a final
 * `review-passed` → `passed`; `review-failed` → `failed`; `review-no-receipt` →
 * `no-receipt`; any other final (`review-refused`, `review-unknown`,
 * `assessment-unavailable`, anything else) → `unknown`; no remaining intent →
 * `none`. `seatIndex` is that intent's seat; `retries` is how many remaining
 * intents are not the earliest one, so the first real review of a generation
 * counts as 0 even when its key had to use `/retryN`.
 *
 * U3/F189: `seat-busy` intents are tracked as consecutive unreachable attempts
 * instead of being dropped. While fewer than
 * `LANE_RUN_REVIEW_UNREACHABLE_MAX_ATTEMPTS`, they stay free (they never reach
 * `matching`); at the bound the latest unreachable seat is reported as
 * `no-receipt` with `retries >= 1`, so the decider stops retrying it. A
 * `review-superseded` intent is ignored without counting; any other intent
 * resets the unreachable streak.
 */
export function laneRunReviewFact(
  entries: readonly LaneRunJournalEntryRecord[],
  runId: string,
  kind: LaneRunReviewKind,
  head12: string | null,
): LaneRunReviewFact {
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId) || head12 === null) {
    return NONE_FACT;
  }

  const latestBoundaryIso = latestReviewRetryBoundaryIsoOf(entries, runId);

  const matching: Array<{ readonly key: string; readonly seatIndex: number }> = [];
  let trailingUnreachable = 0;
  let latestUnreachableSeatIndex: number | null = null;

  for (const entry of entries) {
    if (entry.kind !== 'intent' || entry.runId !== runId || entry.key === null) {
      continue;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'step' || parsed.runId !== runId) {
      continue;
    }
    if (parsed.step !== kind || parsed.head12 !== head12) {
      continue;
    }
    if (latestBoundaryIso !== null && entry.recordedAtIso < latestBoundaryIso) {
      continue;
    }
    const finalReason = finalReasonCodeOf(entries, entry.key);
    if (finalReason === 'review-superseded') {
      continue;
    }
    if (finalReason === 'seat-busy') {
      trailingUnreachable += 1;
      latestUnreachableSeatIndex = parsed.seatIndex;
      continue;
    }
    trailingUnreachable = 0;
    latestUnreachableSeatIndex = null;
    matching.push({ key: entry.key, seatIndex: parsed.seatIndex });
  }

  if (matching.length === 0) {
    if (
      trailingUnreachable >= LANE_RUN_REVIEW_UNREACHABLE_MAX_ATTEMPTS &&
      latestUnreachableSeatIndex !== null
    ) {
      return Object.freeze({
        verdict: 'no-receipt',
        seatIndex: latestUnreachableSeatIndex,
        retries: 1,
      });
    }
    return NONE_FACT;
  }

  const latest = matching[matching.length - 1]!;

  const finalReasonCode = finalReasonCodeOf(entries, latest.key);

  let verdict: LaneRunReviewFact['verdict'];
  // No final result is pending; a final result with no reason code is still final, and unknown.
  if (finalReasonCode === undefined) {
    verdict = 'pending';
  } else if (finalReasonCode === 'review-passed') {
    verdict = 'passed';
  } else if (finalReasonCode === 'review-failed') {
    verdict = 'failed';
  } else if (finalReasonCode === 'review-no-receipt') {
    verdict = 'no-receipt';
  } else {
    verdict = 'unknown';
  }

  const retries = matching.length - 1;

  if (
    (finalReasonCode === 'review-no-receipt' || finalReasonCode === 'review-unknown') &&
    trailingUnreachable >= LANE_RUN_REVIEW_UNREACHABLE_MAX_ATTEMPTS &&
    latestUnreachableSeatIndex !== null
  ) {
    return Object.freeze({
      verdict: 'no-receipt',
      seatIndex: latestUnreachableSeatIndex,
      retries: Math.max(1, matching.length),
    });
  }

  return Object.freeze({ verdict, seatIndex: latest.seatIndex, retries });
}
