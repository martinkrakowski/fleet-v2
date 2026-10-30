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
  'resumed', 'run-stopped', 'stale-revision', 'not-parked', 'stop-pending', 'one-way-door',
  'accepted', 'acceptance-rejected', 'acceptance-unknown', 'pr-opened',
  'pushed', 'forge-refused', 'forge-ambiguous', 'grant-refused', 'merged', 'merge-not-merged', 'merge-waiting',
  'merge-off', 'notice-recorded', 'notice-refused',
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

/** Gate at head12: final 'gate-passed' → passed, 'gate-failed' → failed, any other final → unknown; an intent with no final → pending; none → none. */
export function laneRunGateFact(
  entries: readonly LaneRunJournalEntryRecord[], runId: string, head12: string | null,
): 'none' | 'pending' | 'passed' | 'failed' | 'unknown' {
  if (head12 === null) {
    return 'none';
  }
  let sawPending = false;
  for (const { entry, parsed } of stepIntentsOf(entries, runId)) {
    if (parsed.step !== 'gate' || parsed.head12 !== head12 || entry.key === null) {
      continue;
    }
    const result = finalResultOf(entries, entry.key);
    if (result === null) {
      sawPending = true;
      continue;
    }
    if (result.reasonCode === 'gate-passed') {
      return 'passed';
    }
    if (result.reasonCode === 'gate-failed') {
      return 'failed';
    }
    return 'unknown';
  }
  return sawPending ? 'pending' : 'none';
}

/** The step of the run's latest final step-key result when its outcome is 'refused' and its round is `round`; else null. */
export function laneRunRefusedStep(entries: readonly LaneRunJournalEntryRecord[], runId: string, round: number): LaneRunKeyStep | null {
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
