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
  return latestBoundaryIso !== null && recordedAtIso < latestBoundaryIso;
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

  const matching: Array<{ readonly key: string; readonly seatIndex: number }> = [];
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
    if (laneRunReviewIntentIgnored(entries, runId, entry.key, entry.recordedAtIso)) {
      continue;
    }
    matching.push({ key: entry.key, seatIndex: parsed.seatIndex });
  }
  if (matching.length === 0) {
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

  return Object.freeze({ verdict, seatIndex: latest.seatIndex, retries });
}
