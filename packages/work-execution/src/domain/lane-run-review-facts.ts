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

/** The longest journal the seat-usage reader accepts; a longer one reads as no usage (O(1) refusal). */
export const LANE_RUN_REVIEW_SEAT_USAGE_MAX_ENTRIES = 100_000;

/** Unparseable (`review-unknown`) verdicts one seat may give at one head before the next seat is tried (RM2). */
export const LANE_RUN_REVIEW_UNPARSEABLE_SEAT_LIMIT = 2;

/** What the journal says about review-seat use at one head for one kind (RM2). */
export interface LaneRunReviewSeatUsage {
  /** Counted intents (`matching`) on the latest counted intent's seat; 0 when none. */
  readonly latestSeatIntents: number;
  /** Seats with at least two counted intents whose final reason is `review-unknown`, ascending. */
  readonly exhaustedSeatIndexes: readonly number[];
}

const NO_SEAT_USAGE: LaneRunReviewSeatUsage = Object.freeze({
  latestSeatIntents: 0,
  exhaustedSeatIndexes: Object.freeze([]) as readonly number[],
});

const SEAT_USAGE_ENTRY_FIELDS = ['kind', 'runId', 'key', 'outcome', 'reasonCode', 'detail', 'recordedAtIso'] as const;

/**
 * Copies the fields the seat-usage reader needs out of an untrusted journal
 * array through own data descriptors only: a getter is never run, a hole, a
 * non-array, an array-like, a non-object entry or an own `__proto__` key
 * refuses the whole read (null). Cost O(entries x fields), entries bounded by
 * `LANE_RUN_REVIEW_SEAT_USAGE_MAX_ENTRIES`; a non-array or oversized input
 * is refused in O(1).
 */
function snapshotJournalForSeatUsage(entries: unknown): readonly LaneRunJournalEntryRecord[] | null {
  if (!Array.isArray(entries)) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(entries, 'length');
  const length: unknown = lengthDescriptor === undefined ? undefined : lengthDescriptor.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > LANE_RUN_REVIEW_SEAT_USAGE_MAX_ENTRIES) {
    return null;
  }
  const snapshot: LaneRunJournalEntryRecord[] = [];
  for (let index = 0; index < length; index += 1) {
    const slot = Object.getOwnPropertyDescriptor(entries, String(index));
    if (slot === undefined || !('value' in slot)) {
      return null;
    }
    const entry: unknown = slot.value;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return null;
    }
    if (Object.getOwnPropertyDescriptor(entry, '__proto__') !== undefined) {
      return null;
    }
    const copy: Record<string, unknown> = {};
    for (const field of SEAT_USAGE_ENTRY_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(entry, field);
      if (descriptor === undefined) {
        copy[field] = null;
      } else if ('value' in descriptor) {
        copy[field] = descriptor.value;
      } else {
        return null;
      }
    }
    const isText = (value: unknown): boolean => value === null || typeof value === 'string';
    if (
      !isText(copy.key) ||
      !isText(copy.runId) ||
      !isText(copy.reasonCode) ||
      !isText(copy.outcome) ||
      typeof copy.kind !== 'string' ||
      typeof copy.recordedAtIso !== 'string'
    ) {
      return null;
    }
    snapshot.push(copy as unknown as LaneRunJournalEntryRecord);
  }
  return snapshot;
}

/**
 * RM2: how many of the review's counted intents each seat has used at `head12`.
 * Counts exactly the intents `laneRunReviewFact` counts (`matching`): this
 * run's step intents of `kind` at `head12`, after the latest `review-retry`
 * boundary, excluding `seat-busy` and `review-superseded` ones, so a resume
 * starts a clean count. Read-only over a snapshot of the journal; never
 * throws; a hostile or malformed input, a bad run id, a null head or a kind
 * other than `brief-check` / `code-review` reads as no usage.
 */
export function laneRunReviewSeatUsage(
  entries: unknown,
  runId: string,
  kind: LaneRunReviewKind,
  head12: string | null,
): LaneRunReviewSeatUsage {
  if (
    typeof runId !== 'string' ||
    !LANE_RUN_ID_PATTERN.test(runId) ||
    head12 === null ||
    (kind !== 'brief-check' && kind !== 'code-review')
  ) {
    return NO_SEAT_USAGE;
  }
  const journal = snapshotJournalForSeatUsage(entries);
  if (journal === null) {
    return NO_SEAT_USAGE;
  }
  const latestBoundaryIso = latestReviewRetryBoundaryIsoOf(journal, runId);
  const matching: Array<{ readonly key: string; readonly seatIndex: number }> = [];
  for (const entry of journal) {
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
    const finalReason = finalReasonCodeOf(journal, entry.key);
    if (finalReason !== undefined && finalReason !== null && SKIPPED_REVIEW_FINAL_REASONS.has(finalReason)) {
      continue;
    }
    if (finalReason === 'seat-busy') {
      continue;
    }
    matching.push({ key: entry.key, seatIndex: parsed.seatIndex });
  }
  if (matching.length === 0) {
    return NO_SEAT_USAGE;
  }
  const latestSeatIndex = matching[matching.length - 1]!.seatIndex;
  let latestSeatIntents = 0;
  const unknownBySeat = new Map<number, number>();
  for (const intent of matching) {
    if (intent.seatIndex === latestSeatIndex) {
      latestSeatIntents += 1;
    }
    if (finalReasonCodeOf(journal, intent.key) === 'review-unknown') {
      unknownBySeat.set(intent.seatIndex, (unknownBySeat.get(intent.seatIndex) ?? 0) + 1);
    }
  }
  const exhausted: number[] = [];
  for (const [seatIndex, count] of unknownBySeat) {
    if (count >= LANE_RUN_REVIEW_UNPARSEABLE_SEAT_LIMIT) {
      exhausted.push(seatIndex);
    }
  }
  exhausted.sort((a, b) => a - b);
  return Object.freeze({ latestSeatIntents, exhaustedSeatIndexes: Object.freeze(exhausted) });
}
