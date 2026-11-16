/**
 * Pure merge-train health rules (CO-WD1). This module says what "unhealthy"
 * means for one typed snapshot of the merge train: no port, no use case, no
 * I/O, no clock read (`nowIso` is passed in), no randomness, never an
 * exception. An unknown or malformed input is never reported as healthy: it
 * is a typed refusal (`outcome: 'refused'`), which later units treat as "the
 * watchdog is blind".
 *
 * Cost bound: at most `TRAIN_HEALTH_QUEUE_MAX` (500) entries are read once,
 * each rule makes one pass over them, and one sort runs over at most 1002
 * findings before the cut to `TRAIN_HEALTH_FINDINGS_MAX` (200).
 */

import { readPlainRecord } from '@fleet/shared';
import { isZonedIsoDateTime } from './conductor-halt.js';
import {
  MERGE_QUEUE_ENTRY_STATES,
  MERGE_QUEUE_TERMINAL_STATES,
  type MergeQueueEntryState,
} from './merge-queue-records.js';

/** The fixed rule codes of the watchdog. */
export const TRAIN_HEALTH_RULES = [
  'tick-stale',
  'stale-queue-entry',
  'stalled-head',
  'repeated-park',
  'watchdog-blind',
] as const;
export type TrainHealthRule = (typeof TRAIN_HEALTH_RULES)[number];

/** What the forge last reported for a pull request. */
export type TrainHealthForgeState = 'open' | 'closed' | 'merged' | 'unknown';

/** One merge-queue entry as the health rules read it. */
export interface TrainHealthQueueEntry {
  readonly pullRequest: number;
  readonly state: MergeQueueEntryState;
  readonly forgeState: TrainHealthForgeState;
  readonly enqueuedAtIso: string;
  readonly attempt: number;
}

/**
 * An absent optional key means "never". A key holding null or undefined is
 * malformed.
 */
export interface TrainHealthSnapshot {
  readonly queue: readonly TrainHealthQueueEntry[];
  readonly lastTickFinishedAtIso?: string;
  readonly lastMergedAtIso?: string;
}

/** Optional overrides of the default thresholds. */
export interface TrainHealthThresholds {
  readonly tickStaleMinutes?: number;
  readonly stalledHeadMinutes?: number;
  readonly repeatedParkAttempts?: number;
}

export const DEFAULT_TRAIN_HEALTH_THRESHOLDS = Object.freeze({
  tickStaleMinutes: 5,
  stalledHeadMinutes: 30,
  repeatedParkAttempts: 3,
});

/** At most this many queue entries are read from one snapshot. */
export const TRAIN_HEALTH_QUEUE_MAX = 500;
/** At most this many findings survive the cut. */
export const TRAIN_HEALTH_FINDINGS_MAX = 200;
/** A time later than now by more than this is refused, not trusted. */
export const TRAIN_HEALTH_FUTURE_SKEW_MS = 60_000;

/** One finding: fixed rule code, page severity, stable key, bounded evidence. */
export interface TrainHealthFinding {
  readonly rule: TrainHealthRule;
  readonly severity: 'page';
  readonly key: string;
  readonly pullRequest: number | null;
  readonly evidence: Readonly<Record<string, string | number | null>>;
}

export type TrainHealthRefusalReason = 'invalid-clock' | 'invalid-thresholds' | 'invalid-snapshot';

export type TrainHealthEvaluation =
  | {
      readonly outcome: 'evaluated';
      readonly findings: readonly TrainHealthFinding[];
      readonly truncated: boolean;
      readonly unknownForgeStates: number;
    }
  | { readonly outcome: 'refused'; readonly reasonCode: TrainHealthRefusalReason };

/** The runtime schema of the thresholds. */
const THRESHOLDS_SCHEMA = {
  tickStaleMinutes: { kind: 'integer', min: 1, max: 1440, optional: true },
  stalledHeadMinutes: { kind: 'integer', min: 1, max: 1440, optional: true },
  repeatedParkAttempts: { kind: 'integer', min: 1, max: 100, optional: true },
} as const;

/** The runtime schema of one queue entry. */
const ENTRY_SCHEMA = {
  pullRequest: { kind: 'integer', min: 1 },
  state: { kind: 'literal', values: MERGE_QUEUE_ENTRY_STATES },
  forgeState: { kind: 'literal', values: ['open', 'closed', 'merged', 'unknown'] },
  enqueuedAtIso: { kind: 'string', maxLength: 40 },
  attempt: { kind: 'integer', min: 0 },
} as const;

/** The runtime schema of the whole snapshot (depth 2, within MAX_DEPTH). */
const SNAPSHOT_SCHEMA = {
  queue: {
    kind: 'array',
    items: { kind: 'record', schema: ENTRY_SCHEMA },
    maxLength: TRAIN_HEALTH_QUEUE_MAX,
  },
  lastTickFinishedAtIso: { kind: 'string', maxLength: 40, optional: true },
  lastMergedAtIso: { kind: 'string', maxLength: 40, optional: true },
} as const;

/** The terminal entry states, as strings so `includes` reads plainly. */
const TERMINAL_STATES: readonly string[] = MERGE_QUEUE_TERMINAL_STATES;

const MINUTE_MS = 60_000;

/** The thresholds one evaluation actually uses; every field required. */
interface ResolvedThresholds {
  readonly tickStaleMinutes: number;
  readonly stalledHeadMinutes: number;
  readonly repeatedParkAttempts: number;
}

/** The snapshot one evaluation reads, resolved against the clock. */
interface HealthContext {
  readonly nowMs: number;
  readonly thresholds: ResolvedThresholds;
  readonly snapshot: TrainHealthSnapshot;
}

/**
 * The stable key of a finding: a fixed rule code plus an optional validated
 * pull request. Total: never throws, never calls a method of its arguments.
 */
export function trainHealthFindingKey(rule: unknown, pullRequest: unknown): string {
  if (typeof rule !== 'string' || !(TRAIN_HEALTH_RULES as readonly string[]).includes(rule)) {
    return 'train-health:unknown';
  }
  if (Number.isSafeInteger(pullRequest) && (pullRequest as number) >= 1) {
    return `train-health:${rule}:${pullRequest as number}`;
  }
  return `train-health:${rule}`;
}

/** The frozen "watchdog is blind" finding, raised by the CO-WD2 use case. */
export function blindTrainHealthFinding(): TrainHealthFinding {
  return Object.freeze({
    rule: 'watchdog-blind' as const,
    severity: 'page' as const,
    key: 'train-health:watchdog-blind',
    pullRequest: null,
    evidence: Object.freeze({}),
  });
}

/** Builds one frozen finding through the single key helper. */
function buildFinding(
  rule: TrainHealthRule,
  pullRequest: number | null,
  evidence: Record<string, string | number | null>,
): TrainHealthFinding {
  return Object.freeze({
    rule,
    severity: 'page' as const,
    key: trainHealthFindingKey(rule, pullRequest),
    pullRequest,
    evidence: Object.freeze({ ...evidence }),
  });
}

/** Missing keys take their defaults; a failed read refuses the thresholds. */
function readThresholds(thresholds: unknown): ResolvedThresholds | null {
  if (thresholds === undefined) {
    return DEFAULT_TRAIN_HEALTH_THRESHOLDS;
  }
  const read = readPlainRecord(thresholds, THRESHOLDS_SCHEMA);
  if (!read.ok) {
    return null;
  }
  const value = read.value as TrainHealthThresholds;
  return {
    tickStaleMinutes: value.tickStaleMinutes ?? DEFAULT_TRAIN_HEALTH_THRESHOLDS.tickStaleMinutes,
    stalledHeadMinutes: value.stalledHeadMinutes ?? DEFAULT_TRAIN_HEALTH_THRESHOLDS.stalledHeadMinutes,
    repeatedParkAttempts: value.repeatedParkAttempts ?? DEFAULT_TRAIN_HEALTH_THRESHOLDS.repeatedParkAttempts,
  };
}

/** Whether an entry still occupies the train: not merged, dropped or superseded. */
function isLive(entry: TrainHealthQueueEntry): boolean {
  return !TERMINAL_STATES.includes(entry.state);
}

/** Whether an entry is being worked: live and not parked. */
function isActive(entry: TrainHealthQueueEntry): boolean {
  return isLive(entry) && entry.state !== 'parked';
}

/**
 * Every time present in the snapshot must be a zoned ISO time, and no time
 * may be more than the skew ahead of the clock (a future time would silence a
 * rule for ever). Returns the refusal reason, or null when all times hold.
 */
function timesRefusal(snapshot: TrainHealthSnapshot, nowMs: number): TrainHealthRefusalReason | null {
  const times: string[] = [];
  if (snapshot.lastTickFinishedAtIso !== undefined) {
    times.push(snapshot.lastTickFinishedAtIso);
  }
  if (snapshot.lastMergedAtIso !== undefined) {
    times.push(snapshot.lastMergedAtIso);
  }
  for (const entry of snapshot.queue) {
    times.push(entry.enqueuedAtIso);
  }
  for (const iso of times) {
    if (!isZonedIsoDateTime(iso)) {
      return 'invalid-snapshot';
    }
    if (Date.parse(iso) - nowMs > TRAIN_HEALTH_FUTURE_SKEW_MS) {
      return 'invalid-clock';
    }
  }
  return null;
}

/** Rule A: the tick is late, or there never was one while work is live. */
function tickStale(context: HealthContext, out: TrainHealthFinding[]): void {
  const iso = context.snapshot.lastTickFinishedAtIso;
  if (iso !== undefined) {
    const elapsedMs = context.nowMs - Date.parse(iso);
    if (elapsedMs > context.thresholds.tickStaleMinutes * MINUTE_MS) {
      out.push(buildFinding('tick-stale', null, { staleMinutes: Math.floor(elapsedMs / MINUTE_MS) }));
    }
    return;
  }
  const live = context.snapshot.queue.filter(isLive).length;
  if (live > 0) {
    out.push(buildFinding('tick-stale', null, { staleMinutes: null }));
  }
}

/**
 * Rule B: a live entry the forge reports closed or merged is stuck on the
 * train. Returns how many live entries carry an unknown forge state.
 */
function staleEntries(context: HealthContext, out: TrainHealthFinding[]): number {
  let unknownForgeStates = 0;
  for (const entry of context.snapshot.queue) {
    if (!isLive(entry)) {
      continue;
    }
    if (entry.forgeState === 'closed' || entry.forgeState === 'merged') {
      out.push(buildFinding('stale-queue-entry', entry.pullRequest, { forgeState: entry.forgeState }));
    } else if (entry.forgeState === 'unknown') {
      unknownForgeStates += 1;
    }
  }
  return unknownForgeStates;
}

/** Whether `candidate` beats `head` as the stalled-head: earlier, then smaller. */
function isEarlierHead(candidate: TrainHealthQueueEntry, head: TrainHealthQueueEntry): boolean {
  const candidateMs = Date.parse(candidate.enqueuedAtIso);
  const headMs = Date.parse(head.enqueuedAtIso);
  if (candidateMs !== headMs) {
    return candidateMs < headMs;
  }
  return candidate.pullRequest < head.pullRequest;
}

/**
 * Rule C: the head of the active entries has been there too long, measured
 * from the LATER of its enqueue time and the last merge (a pull request
 * enqueued after a quiet night must not page at once).
 */
function stalledHead(context: HealthContext, out: TrainHealthFinding[]): void {
  let head: TrainHealthQueueEntry | null = null;
  let activeEntries = 0;
  for (const entry of context.snapshot.queue) {
    if (!isActive(entry)) {
      continue;
    }
    activeEntries += 1;
    if (head === null || isEarlierHead(entry, head)) {
      head = entry;
    }
  }
  if (head === null) {
    return;
  }
  const headMs = Date.parse(head.enqueuedAtIso);
  const mergedIso = context.snapshot.lastMergedAtIso;
  const referenceMs = mergedIso === undefined ? headMs : Math.max(headMs, Date.parse(mergedIso));
  const elapsedMs = context.nowMs - referenceMs;
  if (elapsedMs > context.thresholds.stalledHeadMinutes * MINUTE_MS) {
    out.push(buildFinding('stalled-head', null, {
      stalledMinutes: Math.floor(elapsedMs / MINUTE_MS),
      headPullRequest: head.pullRequest,
      activeEntries,
    }));
  }
}

/** Rule D: an entry parked again and again at or past the attempt threshold. */
function repeatedPark(context: HealthContext, out: TrainHealthFinding[]): void {
  for (const entry of context.snapshot.queue) {
    if (isLive(entry) && entry.state === 'parked' && entry.attempt >= context.thresholds.repeatedParkAttempts) {
      out.push(buildFinding('repeated-park', entry.pullRequest, { attempt: entry.attempt }));
    }
  }
}

/** Keeps one finding per key, sorts by key, cuts to the maximum and freezes. */
function finalise(findings: TrainHealthFinding[], unknownForgeStates: number): TrainHealthEvaluation {
  const byKey = new Map<string, TrainHealthFinding>();
  for (const finding of findings) {
    if (!byKey.has(finding.key)) {
      byKey.set(finding.key, finding);
    }
  }
  const unique: TrainHealthFinding[] = Array.from(byKey.values());
  unique.sort((a, b) => {
    if (a.key < b.key) {
      return -1;
    }
    if (a.key > b.key) {
      return 1;
    }
    return 0;
  });
  const truncated = unique.length > TRAIN_HEALTH_FINDINGS_MAX;
  const kept = truncated ? unique.slice(0, TRAIN_HEALTH_FINDINGS_MAX) : unique;
  return Object.freeze({
    outcome: 'evaluated' as const,
    findings: Object.freeze(kept),
    truncated,
    unknownForgeStates,
  });
}

/** The inner body of `evaluateTrainHealth`; its caller owns the try/catch. */
function evaluateTrainHealthInner(
  snapshot: unknown,
  thresholds: unknown,
  nowIso: unknown,
): TrainHealthEvaluation {
  if (!isZonedIsoDateTime(nowIso)) {
    return { outcome: 'refused', reasonCode: 'invalid-clock' };
  }
  const nowMs = Date.parse(nowIso);
  const resolved = readThresholds(thresholds);
  if (resolved === null) {
    return { outcome: 'refused', reasonCode: 'invalid-thresholds' };
  }
  const read = readPlainRecord(snapshot, SNAPSHOT_SCHEMA);
  if (!read.ok) {
    return { outcome: 'refused', reasonCode: 'invalid-snapshot' };
  }
  const snapshotValue = read.value as unknown as TrainHealthSnapshot;
  const timeRefusal = timesRefusal(snapshotValue, nowMs);
  if (timeRefusal !== null) {
    return { outcome: 'refused', reasonCode: timeRefusal };
  }
  const context: HealthContext = { nowMs, thresholds: resolved, snapshot: snapshotValue };
  const findings: TrainHealthFinding[] = [];
  tickStale(context, findings);
  const unknownForgeStates = staleEntries(context, findings);
  stalledHead(context, findings);
  repeatedPark(context, findings);
  return finalise(findings, unknownForgeStates);
}

/**
 * The one entry point: the deterministic health evaluation of one snapshot.
 * Never throws. A malformed or hostile input of any shape answers a typed
 * refusal, never a healthy verdict and never an exception.
 */
export function evaluateTrainHealth(
  snapshot: unknown,
  thresholds: unknown,
  nowIso: unknown,
): TrainHealthEvaluation {
  try {
    return evaluateTrainHealthInner(snapshot, thresholds, nowIso);
  } catch {
    return { outcome: 'refused', reasonCode: 'invalid-snapshot' };
  }
}
