/**
 * Pure helpers over the keyed run journal for the conductor (plan §3.5, §3.6,
 * §3.9): builders for conduct, intent and result entries, the closed list of the
 * conductor's result reason codes, and the per-attempt facts the decider reads.
 * Pure: no store, no clock, no id minting; ids and times come in as arguments.
 * Nothing throws; another run's entries never count.
 */

import { laneRunJournalDispatchResult } from './lane-run-journal.js';
import type { LaneRunJournalEntryRecord, LaneRunJournalOutcome } from './lane-run-journal.js';
import { LANE_RUN_JOURNAL_ENTRY_VERSION } from './lane-run-journal.js';
import { parseLaneRunKey } from './lane-run-keys.js';
import type { ParsedLaneRunKey } from './lane-run-keys.js';
import { LANE_RUN_ID_PATTERN } from './lane-run-records.js';
import type { LaneRunKeyStep } from './lane-run-records.js';
import type { LaneRunStateValue } from './value-objects/LaneRunState.vo.js';
import type { SeatFailureOutcome } from './seat-selection.js';

/** The fixed reason code of the result that closes an ambiguous pending intent an operator stop or resume abandoned (F171). */
export const LANE_RUN_INTENT_ABANDONED_REASON_CODE = 'intent-abandoned-by-operator' as const;

/** The conductor's result reason codes (K4); each matches LANE_RUN_JOURNAL_REASON_CODE_PATTERN. Stored data: version with the journal. */
export const LANE_RUN_RESULT_REASON_CODES = [
  'prepared', 'prepare-refused', 'prepare-fix-round-not-built', 'no-frozen-brief', 'seat-missing',
  'seat-tool-differs', 'attempt-exists', 'attempt-absent',
  'dispatch-started', 'dispatch-blocked', 'dispatch-unknown', 'dispatch-refused', 'runner-refused',
  'dispatch-inputs-unreadable', 'worktree-idle', 'worktree-running', 'worktree-unknown',
  'capacity-released', 'capacity-none-held', 'capacity-held', 'cancel-refused', 'cancel-changed',
  'stop-timeout', 'stop-force', 'stop-force-slot-held', 'stop-unconfirmed', 'stop-confirmed',
  'collected', 'collect-refused', 'edit-only-refused', 'edit-only-unknown', 'no-completion-receipt',
  'gate-passed', 'gate-failed', 'gate-unknown', 'reconciled',
  'review-passed', 'review-failed', 'review-no-receipt', 'review-refused', 'review-unknown',
  'assessment-unavailable', 'review-seat-unavailable',
  'seat-busy', 'review-superseded',
  'resumed', 'run-stopped', 'stale-revision', 'not-parked', 'stop-pending', 'one-way-door', 'fix-no-progress',
  'accepted', 'acceptance-rejected', 'acceptance-unknown', 'pr-opened',
  'pushed', 'forge-refused', 'forge-ambiguous', 'grant-refused', 'merged', 'merge-not-merged', 'merge-waiting',
  'merge-off', 'notice-recorded', 'notice-refused', 'no-in-scope-findings',
  'gate-congested', // KF-30c2: a gate run that exhausted the gate-slot wait limit; the conductor may retry it
  'premerge-success', 'premerge-failure', 'premerge-overtaken', // KS7a-2: the merge hold's `premerge` commit status
  // KS7b: the `merge-enqueue` step's final results. The detail of `merge-dropped` / `merge-held` names the
  // queue's reason token; a pending (queued) entry has no result at all.
  'merge-dropped', 'merge-held', 'merge-enqueue-refused', 'merge-overtaken',
  'ci-failed', // GB4: the keyed `ci` step's refusal of the exact head's CI read
  'ci-overtaken', // GB4 fix rounds 1-2: a pending `ci` intent whose head/round moved, or whose CI has since passed
  LANE_RUN_INTENT_ABANDONED_REASON_CODE, // F171: an operator stop or resume closed an ambiguous pending intent
] as const;
export type LaneRunResultReasonCode = (typeof LANE_RUN_RESULT_REASON_CODES)[number];

export function laneRunConductEntry(entryId: string, runId: string, state: LaneRunStateValue, nowIso: string): LaneRunJournalEntryRecord {
  return Object.freeze({
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId,
    kind: 'conduct',
    key: null,
    runId,
    recordedAtIso: nowIso,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state,
  });
}

export function laneRunIntentEntry(entryId: string, runId: string, key: string, mintedId: string | null, nowIso: string): LaneRunJournalEntryRecord {
  return Object.freeze({
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId,
    kind: 'intent',
    key,
    runId,
    recordedAtIso: nowIso,
    mode: null,
    expectedRevision: null,
    mintedId,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: null,
  });
}

export function laneRunResultEntry(
  entryId: string, runId: string, key: string, outcome: LaneRunJournalOutcome,
  reasonCode: LaneRunResultReasonCode | null, nowIso: string,
  detail: string | null = null,
): LaneRunJournalEntryRecord {
  return Object.freeze({
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId,
    kind: 'result',
    key,
    runId,
    recordedAtIso: nowIso,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome,
    reasonCode,
    detail,
    grantId: null,
    state: null,
  });
}

interface StepIntent {
  readonly entry: LaneRunJournalEntryRecord;
  readonly parsed: Extract<ParsedLaneRunKey, { readonly kind: 'step' }>;
}

/** The run's step intents, in journal order; empty for a malformed run id. */
function stepIntentsOf(entries: readonly LaneRunJournalEntryRecord[], runId: string): StepIntent[] {
  const out: StepIntent[] = [];
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
    return out;
  }
  for (const entry of entries) {
    if (entry.kind !== 'intent' || entry.runId !== runId || entry.key === null) {
      continue;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'step' || parsed.runId !== runId) {
      continue;
    }
    out.push({ entry, parsed });
  }
  return out;
}

/** The key's final result (any non-ambiguous outcome), or null when it has none. */
function finalResultOf(entries: readonly LaneRunJournalEntryRecord[], key: string): LaneRunJournalEntryRecord | null {
  for (const entry of entries) {
    if (entry.kind === 'result' && entry.key === key && entry.outcome !== 'ambiguous') {
      return entry;
    }
  }
  return null;
}

/** Round and seat of an attempt: its prepare or dispatch intent (mintedId === attemptId), else null. */
export function laneRunAttemptPlacement(
  entries: readonly LaneRunJournalEntryRecord[], runId: string, attemptId: string,
): { readonly round: number; readonly seatIndex: number } | null {
  for (const { entry, parsed } of stepIntentsOf(entries, runId)) {
    // Only the attempt's own prepare or dispatch intent places it; a stop,
    // collect or gate intent naming the same id never does.
    if (entry.mintedId === attemptId && (parsed.step === 'prepare' || parsed.step === 'dispatch')) {
      return { round: parsed.round, seatIndex: parsed.seatIndex };
    }
  }
  return null;
}

/** The dispatch result of an attempt: its dispatch intent's key read by laneRunJournalDispatchResult; 'none' without one. */
export function laneRunAttemptDispatchResult(
  entries: readonly LaneRunJournalEntryRecord[], runId: string, attemptId: string,
): 'none' | 'not-started' | 'started' {
  for (const { entry, parsed } of stepIntentsOf(entries, runId)) {
    if (entry.mintedId === attemptId && parsed.step === 'dispatch' && entry.key !== null) {
      return laneRunJournalDispatchResult(entries, entry.key);
    }
  }
  return 'none';
}

/** Stop step intents journalled for (round, seat): the next stop's retry ordinal. */
export function laneRunStopsIssued(entries: readonly LaneRunJournalEntryRecord[], runId: string, round: number, seatIndex: number): number {
  let count = 0;
  for (const { parsed } of stepIntentsOf(entries, runId)) {
    if (parsed.step === 'stop' && parsed.round === round && parsed.seatIndex === seatIndex) {
      count += 1;
    }
  }
  return count;
}

/** True when a stop of (round, seat) has a final result with reason code 'stop-timeout'. */
export function laneRunTimedOut(entries: readonly LaneRunJournalEntryRecord[], runId: string, round: number, seatIndex: number): boolean {
  for (const { entry, parsed } of stepIntentsOf(entries, runId)) {
    if (parsed.step === 'stop' && parsed.round === round && parsed.seatIndex === seatIndex && entry.key !== null) {
      const result = finalResultOf(entries, entry.key);
      if (result !== null && result.reasonCode === 'stop-timeout') {
        return true;
      }
    }
  }
  return false;
}

/** The gate intent at head12 with the highest retry (no retry = run 0), or null. */
function highestRetryGateIntent(
  entries: readonly LaneRunJournalEntryRecord[], runId: string, head12: string,
): { readonly key: string; readonly retry: number } | null {
  let latest: { readonly key: string; readonly retry: number } | null = null;
  for (const { entry, parsed } of stepIntentsOf(entries, runId)) {
    if (parsed.step !== 'gate' || parsed.head12 !== head12 || entry.key === null) {
      continue;
    }
    const retry = parsed.retry ?? 0;
    if (latest === null || retry > latest.retry) {
      latest = { key: entry.key, retry };
    }
  }
  return latest;
}

/**
 * Gate at head12: the gate intent with the HIGHEST retry (no retry = run 0)
 * decides — its final 'gate-passed' → passed, 'gate-failed' → failed,
 * 'gate-congested' → congested, any other final → unknown; that intent without
 * a final → pending; none → none. A later run's outcome overrides an earlier
 * one, so a congested run never hides a later run's pass or fail (KF-30c2).
 */
export function laneRunGateFact(
  entries: readonly LaneRunJournalEntryRecord[], runId: string, head12: string | null,
): 'none' | 'pending' | 'passed' | 'failed' | 'unknown' | 'congested' {
  if (head12 === null) {
    return 'none';
  }
  const decided = highestRetryGateIntent(entries, runId, head12);
  if (decided === null) {
    return 'none';
  }
  const result = finalResultOf(entries, decided.key);
  if (result === null) {
    return 'pending';
  }
  if (result.reasonCode === 'gate-passed') {
    return 'passed';
  }
  if (result.reasonCode === 'gate-failed') {
    return 'failed';
  }
  if (result.reasonCode === 'gate-congested') {
    return 'congested';
  }
  return 'unknown';
}

/**
 * The congested gate run at head12 (KF-30c2): the highest-retry gate intent
 * whose final result is `gate-congested`, with that run's retry and the
 * result's `recordedAtIso`; null when the latest gate result is not a
 * congestion (or there is no gate intent at the head).
 */
export function laneRunGateCongestion(
  entries: readonly LaneRunJournalEntryRecord[], runId: string, head12: string | null,
): { readonly retry: number; readonly atIso: string } | null {
  if (head12 === null) {
    return null;
  }
  const latest = highestRetryGateIntent(entries, runId, head12);
  if (latest === null) {
    return null;
  }
  const result = finalResultOf(entries, latest.key);
  if (result === null || result.reasonCode !== 'gate-congested') {
    return null;
  }
  return { retry: latest.retry, atIso: result.recordedAtIso };
}

const PREMERGE_HEAD12_PATTERN = /^[0-9a-f]{12}$/;

/**
 * KS7a-2: the latest final result of the run's `premerge` key at `head12`
 * (`<runId>/r<round>/premerge@<head12>`), as the merging hold reads it. A
 * final result (outcome not `ambiguous`) whose parsed key is kind `premerge`,
 * same `runId` and same `head12` maps `premerge-success` → `success`,
 * `premerge-failure` → `failure`, and `forge-refused` / `grant-refused` (or
 * any other reason code) → `refused`; the last such result wins. An
 * `overtaken` result sits on the old head's key, so filtering by `head12`
 * leaves a new head `'none'`. A null or non-12-hex head12 is `'none'`.
 */
export function laneRunPremergePost(
  entries: readonly LaneRunJournalEntryRecord[],
  runId: string,
  head12: string | null,
): 'none' | 'success' | 'failure' | 'refused' {
  if (typeof head12 !== 'string' || !PREMERGE_HEAD12_PATTERN.test(head12)) {
    return 'none';
  }
  let post: 'none' | 'success' | 'failure' | 'refused' = 'none';
  for (const entry of entries) {
    if (entry.kind !== 'result' || entry.outcome === 'ambiguous' || entry.key === null || entry.runId !== runId) {
      continue;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'premerge' || parsed.head12 !== head12) {
      continue;
    }
    if (entry.reasonCode === LANE_RUN_INTENT_ABANDONED_REASON_CODE) {
      continue;
    }
    if (entry.reasonCode === 'premerge-success') {
      post = 'success';
    } else if (entry.reasonCode === 'premerge-failure') {
      post = 'failure';
    } else {
      post = 'refused';
    }
  }
  return post;
}

/** What the merge queue made of the run's enqueued head, read from the journal (KS7b). */
export type LaneRunMergeEnqueueFact = 'none' | 'merged' | 'dropped-fixable' | 'held' | 'stuck';

/** The queue drop reasons that a fix round can answer: the head conflicts, fails its checks or the macOS verify. */
export const LANE_RUN_MERGE_DROP_FIXABLE = ['conflict', 'checks', 'macos'] as const;

/**
 * KS7b: the latest final result of the run's `merge-enqueue` key at (`round`, `head12`)
 * (`<runId>/r<round>/merge-enqueue@<head12>`), as the merging rules read it. `merged` →
 * `merged`; `merge-dropped` with detail conflict, checks or macos → `dropped-fixable`;
 * `merge-held` → `held`; any other final result (a refusal, another drop reason, an
 * unknown detail) → `stuck`; no final result, a moved head or another round → `none`.
 * The last such result wins. Pure; never throws.
 */
export function laneRunMergeEnqueueFact(
  entries: readonly LaneRunJournalEntryRecord[],
  runId: string,
  round: number,
  head12: string | null,
): LaneRunMergeEnqueueFact {
  if (typeof head12 !== 'string' || !PREMERGE_HEAD12_PATTERN.test(head12)) {
    return 'none';
  }
  let fact: LaneRunMergeEnqueueFact = 'none';
  for (const entry of entries) {
    if (entry.kind !== 'result' || entry.outcome === 'ambiguous' || entry.key === null || entry.runId !== runId) {
      continue;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'merge-enqueue' || parsed.head12 !== head12 || parsed.round !== round) {
      continue;
    }
    if (entry.outcome === 'overtaken') {
      continue;
    }
    if (entry.reasonCode === 'merged') {
      fact = 'merged';
    } else if (entry.reasonCode === 'merge-held') {
      fact = 'held';
    } else if (
      entry.reasonCode === 'merge-dropped' &&
      (LANE_RUN_MERGE_DROP_FIXABLE as readonly (string | null)[]).includes(entry.detail)
    ) {
      fact = 'dropped-fixable';
    } else {
      fact = 'stuck';
    }
  }
  return fact;
}

/**
 * A recorded seat advance (G11a): the `next-seat-<outcome>-<index>` or
 * `next-seat-<outcome>-none` detail token of a failed turn's final result,
 * or `none` when the journal holds no such token for the round. The outcome
 * is the failure outcome the result recorded (`rate-limited`, `timeout` or
 * `provider-error`).
 */
export type LaneRunRecordedSeatAdvance =
  | { readonly kind: 'none' }
  | { readonly kind: 'seat'; readonly seatIndex: number; readonly outcome: SeatFailureOutcome }
  | { readonly kind: 'exhausted'; readonly outcome: SeatFailureOutcome | null };

/** The failure outcomes a recorded advance may name. */
const SEAT_ADVANCE_OUTCOMES: readonly SeatFailureOutcome[] = ['rate-limited', 'timeout', 'provider-error'];

/** Parse a recorded advance's detail token; anything else reads `none`. */
function parseSeatAdvanceDetail(detail: string | null): LaneRunRecordedSeatAdvance {
  if (detail === null || !detail.startsWith('next-seat-')) {
    return { kind: 'none' };
  }
  const rest = detail.slice('next-seat-'.length);
  if (rest === 'none') {
    return { kind: 'exhausted', outcome: null };
  }
  for (const outcome of SEAT_ADVANCE_OUTCOMES) {
    if (!rest.startsWith(outcome + '-')) {
      continue;
    }
    const tail = rest.slice(outcome.length + 1);
    if (tail === 'none') {
      return { kind: 'exhausted', outcome };
    }
    if (/^[0-9]+$/.test(tail)) {
      return { kind: 'seat', seatIndex: Number(tail), outcome };
    }
  }
  return { kind: 'none' };
}

/**
 * The latest recorded seat advance for `round` (G11a): the LAST final
 * `refused` result of a step key at that round whose detail is a
 * `next-seat-` token. Journal order decides, so a later failure's advance
 * supersedes an earlier one and no other reader may re-derive the seat
 * independently. A run id that is not a run id, or no token, reads `none`.
 */
export function laneRunRecordedSeatAdvance(
  entries: readonly LaneRunJournalEntryRecord[],
  runId: string,
  round: number,
): LaneRunRecordedSeatAdvance {
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
    return { kind: 'none' };
  }
  let latest: LaneRunRecordedSeatAdvance = { kind: 'none' };
  for (const entry of entries) {
    if (entry.kind !== 'result' || entry.outcome !== 'refused' || entry.runId !== runId) {
      continue;
    }
    const parsed = entry.key === null ? null : parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'step' || parsed.runId !== runId || parsed.round !== round) {
      continue;
    }
    const advance = parseSeatAdvanceDetail(entry.detail);
    if (advance.kind !== 'none') {
      latest = advance;
    }
  }
  return latest;
}

/** The step of the run's latest final step-key result when its outcome is 'refused' and its round is `round`; else null. */export function laneRunRefusedStep(entries: readonly LaneRunJournalEntryRecord[], runId: string, round: number): LaneRunKeyStep | null {
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
    return null;
  }
  let latest: LaneRunJournalEntryRecord | null = null;
  for (const entry of entries) {
    if (entry.kind !== 'result' || entry.outcome === 'ambiguous' || entry.key === null || entry.runId !== runId) {
      continue;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'step' || parsed.runId !== runId) {
      continue;
    }
    latest = entry;
  }
  if (latest === null || latest.key === null || latest.outcome !== 'refused') {
    return null;
  }
  const parsed = parseLaneRunKey(latest.key);
  if (parsed === null || parsed.kind !== 'step' || parsed.round !== round) {
    return null;
  }
  return parsed.step;
}

/**
 * GB4: true when this run has a final `ci` result with reason `ci-failed`
 * at `head12` in `round` — the CI failure is already journalled and only the
 * transition to `fixing` is left. Pure; never throws.
 */
export function laneRunCiFailureRecorded(
  entries: readonly LaneRunJournalEntryRecord[],
  runId: string,
  round: number,
  head12: string | null,
): boolean {
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId) || head12 === null) {
    return false;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== 'result' || entry.outcome === 'ambiguous' || entry.key === null || entry.runId !== runId) {
      continue;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'step' || parsed.runId !== runId) {
      continue;
    }
    if (parsed.step === 'ci' && entry.reasonCode === 'ci-failed' && parsed.round === round && parsed.head12 === head12) {
      return true;
    }
  }
  return false;
}

/** The dispatch intent time of an attempt (its recordedAtIso), or null. */
export function laneRunDispatchedAtIso(entries: readonly LaneRunJournalEntryRecord[], runId: string, attemptId: string): string | null {
  for (const { entry, parsed } of stepIntentsOf(entries, runId)) {
    if (parsed.step === 'dispatch' && entry.mintedId === attemptId) {
      return entry.recordedAtIso;
    }
  }
  return null;
}

/** `parked` conduct entries of the run (the park repair compares it with record.parkCount). */
export function laneRunParkedConductCount(entries: readonly LaneRunJournalEntryRecord[], runId: string): number {
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.kind === 'conduct' && entry.runId === runId && entry.state === 'parked') {
      count += 1;
    }
  }
  return count;
}
