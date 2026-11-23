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
import { LANE_RUN_MAX_RETRY, buildLaneRunStepKey, parseLaneRunKey } from './lane-run-keys.js';
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
  'gate-unknown-retried', // GU1: the final `overtaken` result written on an ambiguous gate key when a retry key starts
  'premerge-success', 'premerge-failure', 'premerge-overtaken', // KS7a-2: the merge hold's `premerge` commit status
  // KS7b: the `merge-enqueue` step's final results. The detail of `merge-dropped` / `merge-held` names the
  // queue's reason token; a pending (queued) entry has no result at all.
  'merge-dropped', 'merge-held', 'merge-enqueue-refused', 'merge-overtaken',
  'ci-failed', // GB4: the keyed `ci` step's refusal of the exact head's CI read
  'ci-overtaken', // GB4 fix rounds 1-2: a pending `ci` intent whose head/round moved, or whose CI has since passed
  'park-escalated', // CE1: the result recording a park escalation (its detail names the mode, e.g. `commit-pending`)
  LANE_RUN_INTENT_ABANDONED_REASON_CODE, // F171: an operator stop or resume closed an ambiguous pending intent
  'gate-retry-cap-reached', // GU2: a resume of a run parked from `gating` past the bounded gate-retry cap
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

/**
 * The unknown gate run at head12 (GU1): the highest-retry gate intent whose
 * final result is neither a pass, fail nor congestion, with that run's retry
 * and whether an operator abandoned it (`intent-abandoned-by-operator`). Null
 * when there is no such run; an ambiguous-only `gate-unknown` stays null here.
 */
export function laneRunGateUnknown(
  entries: readonly LaneRunJournalEntryRecord[], runId: string, head12: string | null,
): { readonly retry: number; readonly operatorAbandoned: boolean } | null {
  if (head12 === null) {
    return null;
  }
  const latest = highestRetryGateIntent(entries, runId, head12);
  if (latest === null) {
    return null;
  }
  const result = finalResultOf(entries, latest.key);
  if (result === null) {
    return null;
  }
  if (result.reasonCode === 'gate-passed' || result.reasonCode === 'gate-failed' || result.reasonCode === 'gate-congested') {
    return null;
  }
  return { retry: latest.retry, operatorAbandoned: result.reasonCode === LANE_RUN_INTENT_ABANDONED_REASON_CODE };
}

/** GU2: the bounded operator-driven gate retry a resume of a run parked from `gating` may mint. */
export type GateFailedRetryPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'mint'; readonly key: string; readonly retry: number; readonly head12: string; readonly seatIndex: number }
  | { readonly kind: 'cap-reached'; readonly failedRetries: number; readonly next: number };

/** The fixed count of prior `gate-failed` retries past which no further retry is minted. */
const GATE_RETRY_FAILED_CAP = 3;
/** The enormous-length guard: more entries than this is refused without iterating. */
const GATE_RETRY_MAX_ENTRIES = 100_000;

const GATE_RETRY_NONE: GateFailedRetryPlan = { kind: 'none' };

/** The entry fields the planner reads, snapshotted through own descriptors so no getter ever runs. */
interface GateRetryEntrySnapshot {
  readonly kind: unknown;
  readonly key: unknown;
  readonly runId: unknown;
  readonly outcome: unknown;
  readonly reasonCode: unknown;
}

/**
 * A plain-data snapshot of one journal entry's planner fields, or a refusal.
 * `refused` marks an entry that is not a plain object (skipped). `polluted`
 * marks an entry with a prototype-polluting own key or an accessor (get or set)
 * among the read fields — no getter is ever run — which refuses the whole
 * planner input. Cost: O(1) per entry, six descriptor reads. A proxy that
 * lies consistently in every trap is an accepted residual.
 */
function snapshotGateRetryEntry(source: unknown): { readonly status: 'ok'; readonly snapshot: GateRetryEntrySnapshot } | { readonly status: 'refused' } | { readonly status: 'polluted' } {
  if (typeof source !== 'object' || source === null) {
    return REFUSED_GATE_RETRY_ENTRY;
  }
  const proto = Object.getPrototypeOf(source);
  if (proto !== Object.prototype && proto !== null) {
    return REFUSED_GATE_RETRY_ENTRY;
  }
  // A prototype-polluting own key marks the entry hostile: the planner must refuse it.
  if (Object.getOwnPropertyDescriptor(source, '__proto__') !== undefined) {
    return { status: 'polluted' };
  }
  const values: unknown[] = [];
  for (const field of GATE_RETRY_ENTRY_FIELDS) {
    // Each descriptor is read once; an accessor (get or set) is hostile.
    const descriptor = Object.getOwnPropertyDescriptor(source, field);
    if (descriptor === undefined) {
      values.push(undefined);
    } else if (!('value' in descriptor)) {
      return { status: 'polluted' };
    } else {
      values.push(descriptor.value);
    }
  }
  const [kind, key, runId, outcome, reasonCode] = values;
  return {
    status: 'ok',
    snapshot: {
      kind, key, runId, outcome, reasonCode,
    },
  };
}

const GATE_RETRY_ENTRY_FIELDS = ['kind', 'key', 'runId', 'outcome', 'reasonCode'] as const;

const REFUSED_GATE_RETRY_ENTRY = { status: 'refused' } as const;

/** The snapshot's final result for the key in the given run (non-ambiguous outcome), or null. O(N) per call over the snapshots. */
function finalSnapshotResultOf(
  snapshots: readonly (GateRetryEntrySnapshot | null)[], runId: string, key: string,
): GateRetryEntrySnapshot | null {
  for (const snapshot of snapshots) {
    if (
      snapshot !== null && snapshot.kind === 'result' && snapshot.runId === runId &&
      snapshot.key === key && snapshot.outcome !== 'ambiguous'
    ) {
      return snapshot;
    }
  }
  return null;
}

interface GateRetryIntentInfo {
  readonly key: string;
  readonly head12: string | null;
  readonly seatIndex: number;
  readonly retry: number;
}

/**
 * GU2: plan the bounded operator-driven gate retry for a run parked from
 * `gating`. Pure and hostile-input safe: never throws, never runs a getter,
 * never mutates its input.
 *
 * `entries` must be a dense `Array` of at most {@link GATE_RETRY_MAX_ENTRIES}
 * plain entries (an array hole, a non-array, an enormous length or a
 * non-iterable is refused); non-plain entries are skipped, but an accessor slot or an entry with an accessor field refuses the whole input. `runId` must match
 * LANE_RUN_ID_PATTERN and `round` an integer 0..2. Cost: a single O(N) pass
 * over `entries` (plus O(R) map lookups, R <= LANE_RUN_MAX_RETRY).
 *
 * It finds the head12 and seat of the LAST gate intent of the round, takes the
 * highest-retry gate intent at that (head12, seat), and mints
 * `<runId>/r<round>/gate/<seat>@<head12>/retry<next>` only when that intent's
 * final result is `gate-failed`. `failedRetries` counts the round's retry keys
 * at that (head12, seat) whose predecessor key's final result is `gate-failed`;
 * past {@link GATE_RETRY_FAILED_CAP} of them, or when `next` exceeds
 * {@link LANE_RUN_MAX_RETRY}, the plan is `cap-reached` and the run stays
 * parked. Anything else (a pass, a congestion, an unknown, an abandonment, a
 * pending intent, no gate intent, a null head) plans `none`.
 */
export function planGateFailedRetry(entries: unknown, runId: unknown, round: unknown): GateFailedRetryPlan {
  try {
    // Enormous-length guard before any iteration; a non-array or array-like is refused.
    if (!Array.isArray(entries) || entries.length > GATE_RETRY_MAX_ENTRIES) {
      return GATE_RETRY_NONE;
    }
    if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
      return GATE_RETRY_NONE;
    }
    if (typeof round !== 'number' || !Number.isInteger(round) || round < 0 || round > 2) {
      return GATE_RETRY_NONE;
    }
    // Dense-array check: O(N), one hasOwn per index, no hole ever read.
    for (let index = 0; index < entries.length; index += 1) {
      if (!Object.hasOwn(entries, index)) {
        return GATE_RETRY_NONE;
      }
    }
    const snapshots: (GateRetryEntrySnapshot | null)[] = new Array(entries.length);
    for (let index = 0; index < entries.length; index += 1) {
      // Read each slot through its own property descriptor (once) so a getter
      // is never invoked; an accessor or missing slot refuses the whole input,
      // never a partial list. So does a hostile entry (pollution, accessor field).
      const slot = Object.getOwnPropertyDescriptor(entries, index);
      if (slot === undefined || !('value' in slot)) {
        return GATE_RETRY_NONE;
      }
      const snapshotted = snapshotGateRetryEntry(slot.value);
      if (snapshotted.status === 'polluted') {
        return GATE_RETRY_NONE;
      }
      snapshots[index] = snapshotted.status === 'ok' ? snapshotted.snapshot : null;
    }

    // The round's gate intents, in journal order, with their parsed key parts.
    const gateIntents: GateRetryIntentInfo[] = [];
    for (const snapshot of snapshots) {
      if (snapshot === null || snapshot.kind !== 'intent' || snapshot.runId !== runId || typeof snapshot.key !== 'string') {
        continue;
      }
      const parsed = parseLaneRunKey(snapshot.key);
      if (parsed === null || parsed.kind !== 'step' || parsed.step !== 'gate' || parsed.runId !== runId || parsed.round !== round) {
        continue;
      }
      gateIntents.push({ key: snapshot.key, head12: parsed.head12, seatIndex: parsed.seatIndex, retry: parsed.retry ?? 0 });
    }

    // The LAST gate intent of the round fixes the head and seat.
    const last = gateIntents.length === 0 ? null : gateIntents[gateIntents.length - 1] as GateRetryIntentInfo;
    if (last === null || last.head12 === null) {
      return GATE_RETRY_NONE;
    }

    // The highest-retry gate intent at that (head12, seat) decides.
    let highest: GateRetryIntentInfo | null = null;
    for (const info of gateIntents) {
      if (info.head12 === last.head12 && info.seatIndex === last.seatIndex && (highest === null || info.retry > highest.retry)) {
        highest = info;
      }
    }
    if (highest === null) {
      return GATE_RETRY_NONE;
    }

    // Only a settled `gate-failed` may be retried; a pending intent, a pass, a
    // congestion, an unknown or an abandonment never mints a retry.
    const final = finalSnapshotResultOf(snapshots, runId, highest.key);
    if (final === null || final.outcome === 'ambiguous' || final.reasonCode !== 'gate-failed') {
      return GATE_RETRY_NONE;
    }

    // Count the retries whose predecessor's final result is `gate-failed`.
    const keysByRetry = new Map<number, string>();
    for (const info of gateIntents) {
      if (info.head12 === last.head12 && info.seatIndex === last.seatIndex && !keysByRetry.has(info.retry)) {
        keysByRetry.set(info.retry, info.key);
      }
    }
    let failedRetries = 0;
    for (const retry of keysByRetry.keys()) {
      if (retry < 1) {
        continue;
      }
      const predecessorKey = keysByRetry.get(retry === 1 ? 0 : retry - 1);
      if (predecessorKey === undefined) {
        continue;
      }
      const predecessorFinal = finalSnapshotResultOf(snapshots, runId, predecessorKey);
      if (predecessorFinal !== null && predecessorFinal.outcome !== 'ambiguous' && predecessorFinal.reasonCode === 'gate-failed') {
        failedRetries += 1;
      }
    }

    const next = highest.retry + 1;
    if (failedRetries >= GATE_RETRY_FAILED_CAP || next > LANE_RUN_MAX_RETRY) {
      return { kind: 'cap-reached', failedRetries, next };
    }
    const built = buildLaneRunStepKey({
      runId,
      round,
      step: 'gate',
      seatIndex: last.seatIndex,
      attemptOrdinal: null,
      head12: last.head12,
      retry: next,
    });
    if (!built.ok) {
      return GATE_RETRY_NONE;
    }
    return { kind: 'mint', key: built.key, retry: next, head12: last.head12, seatIndex: last.seatIndex };
  } catch {
    // A lying proxy trap must never escape the planner.
    return GATE_RETRY_NONE;
  }
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
