// Lane SH5b: the S9 (conductor state integrity) and S12 (daemon tick
// health) shadow-criterion evaluators, pure over one UTC day's worth of
// already-collected facts. Pure: no filesystem, no subprocess, no clock.
// Never throws, never echoes an input value; every exported function takes
// `unknown` at its boundary and returns a typed evaluation whose refusal
// carries a named reason code. S9 returns `ShadowStateIntegrityEvaluation`,
// adding the eight state-integrity counts. S12 returns
// `ShadowTickHealthEvaluation`, adding `totalTicks`, `budgetOverruns` and
// `starvedJobs`.

import { isZonedIsoDateTime } from './conductor-halt.js';
import { readDaemonEventRecord } from './daemon-events.js';
import type { DaemonEventRecord } from './daemon-events.js';
// `DAEMON_DEFAULT_INTERVAL_SECONDS = 60` matches the systemd timer cadence
// (`OnUnitActiveSec=60s` in `DAEMON_TIMER_TEMPLATE`, see
// `ManageDaemonSchedulerUseCase`), so the coverage limits below are exact
// multiples of one daemon tick.
import { DAEMON_DEFAULT_INTERVAL_SECONDS, DAEMON_STARVED_CONSECUTIVE_TICKS } from './daemon-tick.js';
import { LANE_RUN_JOURNAL_OUTCOMES } from './lane-run-journal.js';
import type { LaneRunJournalOutcome } from './lane-run-journal.js';
import { parseLaneRunKey } from './lane-run-keys.js';
import type { ShadowCriterionEvaluation } from './shadow-evidence-ledger.js';
import { readBoundedDenseArray, readExactPlainRecord, readPlainRecordWithOptionalKeys } from './plain-record-reads.js';

/** The plan's DT §3.1 tick floor: about half the ~1,440 ticks a 60-second day produces. */
export const SHADOW_MIN_TICKS_PER_DAY = 720;
/** How long an intent may stay without a non-`ambiguous` result before S9 fails it. */
export const SHADOW_OPEN_INTENT_GRACE_MS = 900_000;
/** A sanity cap on how many events or journal entries one evaluator walks before refusing as unevaluable. */
export const SHADOW_MAX_HEALTH_ITEMS = 500_000;

/**
 * OD7a3 (S12): how long before day end the last in-day tick may fall. A day
 * whose newest in-day tick is older than this is `late-last-tick` — the
 * daemon stopped well before the day's close. Matches the 15-minute
 * `EARLY_GRACE_MS` / `SHADOW_OPEN_INTENT_GRACE_MS` grace windows.
 */
export const SHADOW_LAST_TICK_GRACE_MS = 15 * DAEMON_DEFAULT_INTERVAL_SECONDS * 1_000;
/**
 * OD7a3 (S12): the largest hole allowed between consecutive in-day ticks
 * (and between day start and the first tick, and the last tick and day
 * end). Policy note: paused ticks emit `jobs: []` (which `asJobEvent`
 * filters out), so a pause longer than this gap limit makes the day fail
 * S12 with `coverage-gap` and therefore unrecordable in BOTH scheduled and
 * manual modes. This is intended because an evidence day must be
 * continuous — and the runbook must say: do not pause the daemon during an
 * evidence day.
 */
export const SHADOW_MAX_TICK_GAP_MS = 15 * DAEMON_DEFAULT_INTERVAL_SECONDS * 1_000;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const UNKNOWN = (reason: string): ShadowCriterionEvaluation => ({ status: 'unknown', reason });
const FAIL = (reason: string): ShadowCriterionEvaluation => ({ status: 'fail', reason });
const PASS = (reason: string): ShadowCriterionEvaluation => ({ status: 'pass', reason });

/** A real UTC calendar day `YYYY-MM-DD`, or null. */
function readUtcDay(value: unknown): string | null {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) {
    return null;
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) {
    return null;
  }
  return value;
}

/** A validated job event, or null when it is some other kind of valid record. */
function asJobEvent(record: DaemonEventRecord): DaemonEventRecord | null {
  return record.kind === 'job' ? record : null;
}

interface JobSequence {
  readonly outcome: string;
  readonly inDay: boolean;
  readonly sortKey: string;
}

/** Whether a normalized record's timestamp falls inside UTC day `day`. */
function fallsInDay(record: DaemonEventRecord, day: string): boolean {
  return record.recordedAtIso.slice(0, 10) === day;
}

/**
 * True when the per-job, time-ordered outcome sequence carries a run of at
 * least `DAEMON_STARVED_CONSECUTIVE_TICKS` consecutive `budget-exhausted`
 * outcomes with at least one member inside day `day` — so a streak spanning
 * midnight is still caught. A `skipped` outcome is transparent, matching the
 * daemon-tick starvation counter: a skip neither breaks nor extends the
 * exhausted run, so the count survives a skip.
 */
function hasStarvedRun(sequence: readonly JobSequence[]): boolean {
  let run = 0;
  let runTouchesDay = false;
  for (const item of sequence) {
    if (item.outcome === 'skipped') {
      continue;
    }
    if (item.outcome !== 'budget-exhausted') {
      run = 0;
      runTouchesDay = false;
      continue;
    }
    run += 1;
    runTouchesDay = runTouchesDay || item.inDay;
    if (run >= DAEMON_STARVED_CONSECUTIVE_TICKS && runTouchesDay) {
      return true;
    }
  }
  return false;
}

/**
 * S12's evaluation: the shared verdict plus the day's tick-health counts.
 * `totalTicks` is the number of distinct in-day tick ids, `budgetOverruns`
 * is how many of those ticks carried a `budget-exhausted` job, and
 * `starvedJobs` is how many jobs had a starved run touching the day. An
 * early refusal carries zeros; a reached verdict carries the counts computed
 * before that verdict, so `too-few-ticks` still reports overruns and starved
 * jobs.
 */
export type ShadowTickHealthEvaluation = ShadowCriterionEvaluation & {
  readonly totalTicks: number;
  readonly budgetOverruns: number;
  readonly starvedJobs: number;
};

/** The three S12 counts, computed together before any verdict is chosen. */
interface TickHealthCounts {
  readonly totalTicks: number;
  readonly budgetOverruns: number;
  readonly starvedJobs: number;
}

const ZERO_TICK_HEALTH_COUNTS: TickHealthCounts = Object.freeze({
  totalTicks: 0,
  budgetOverruns: 0,
  starvedJobs: 0,
});

/**
 * A fresh, frozen evaluation built from a status/reason template plus the
 * three tick-health counts — never a shared object, so a caller mutating one
 * returned evaluation cannot corrupt another call's result.
 */
function withTickHealthCounts(template: ShadowCriterionEvaluation, counts: TickHealthCounts): ShadowTickHealthEvaluation {
  return Object.freeze({
    status: template.status,
    reason: template.reason,
    totalTicks: counts.totalTicks,
    budgetOverruns: counts.budgetOverruns,
    starvedJobs: counts.starvedJobs,
  });
}

/**
 * S12, daemon tick health, over `{ day, events }` where `events` spans
 * D-1 23:00Z to D+1 00:00Z (assembled by the caller; never re-derived here).
 * Cost: linear in the capped input plus sorting each job's events and the
 * bounded in-day tick timestamps — at
 * most `SHADOW_MAX_HEALTH_ITEMS` records are walked or sorted. Array reads
 * go through `readBoundedDenseArray`, whose cost is the accepted engine
 * bound: an `O(1)` length/prototype pre-gate, the `O(K)` bound of the single
 * `Reflect.ownKeys` call (K = the target's own-property count), then an
 * `O(cap)` per-index descriptor traversal over `SHADOW_MAX_HEALTH_ITEMS` —
 * so an oversized, sparse, extra-keyed or accessor-backed `events` array is
 * refused before any element is validated. Every value is read through
 * its own property descriptor, so no getter ever runs and a Proxy stand-in
 * yields exactly the verdict of the data its own reflection reports. Never
 * throws, never echoes the input.
 */
export function evaluateShadowTickHealth(input: unknown): ShadowTickHealthEvaluation {
  try {
    return judgeDayTickHealth(input);
  } catch {
    // A revoked Proxy, or one whose getPrototypeOf/ownKeys/descriptor trap
    // throws, can make even the descriptor readers throw; the never-throws
    // contract turns that into a typed refusal.
    return withTickHealthCounts(UNKNOWN('invalid-input'), ZERO_TICK_HEALTH_COUNTS);
  }
}

function judgeDayTickHealth(input: unknown): ShadowTickHealthEvaluation {
  const snapshot = readExactPlainRecord(input, ['day', 'events']);
  if (snapshot === null) {
    return withTickHealthCounts(UNKNOWN('invalid-input'), ZERO_TICK_HEALTH_COUNTS);
  }
  const day = readUtcDay(snapshot.day);
  if (day === null) {
    return withTickHealthCounts(UNKNOWN('invalid-input'), ZERO_TICK_HEALTH_COUNTS);
  }
  const events = readBoundedDenseArray(snapshot.events, SHADOW_MAX_HEALTH_ITEMS);
  if (events === null) {
    return withTickHealthCounts(UNKNOWN('daemon-events-invalid'), ZERO_TICK_HEALTH_COUNTS);
  }
  const jobEvents: DaemonEventRecord[] = [];
  // `events.array` is a fresh dense copy this module created, so plain
  // indexed reads here can never run a getter or a Proxy `get` trap.
  for (let index = 0; index < events.length; index += 1) {
    const read = readDaemonEventRecord(events.array[index]);
    if (!read.ok) {
      return withTickHealthCounts(UNKNOWN('daemon-events-invalid'), ZERO_TICK_HEALTH_COUNTS);
    }
    const job = asJobEvent(read.record);
    if (job !== null) {
      jobEvents.push(job);
    }
  }
  return judgeTickHealth(jobEvents, day);
}

/** The per-day tallies `judgeTickHealth` needs before any verdict. */
interface TickHealthTallies {
  readonly inDayTicks: Set<string>;
  readonly overBudgetTicks: Set<string>;
  readonly byJob: Map<string, JobSequence[]>;
  /** Every in-day tick instant, ascending, for the coverage checks. */
  readonly inDayTimestamps: number[];
}

/** Collect the day's tick ids, over-budget tick ids, per-job sequences and ascending in-day instants. */
function collectDayJobTicks(jobEvents: readonly DaemonEventRecord[], day: string): TickHealthTallies {
  const inDayTicks = new Set<string>();
  const overBudgetTicks = new Set<string>();
  const byJob = new Map<string, JobSequence[]>();
  // OD7a3: every in-day tick instant, ascending, for the coverage checks.
  const inDayTimestamps: number[] = [];
  for (const event of jobEvents) {
    if (fallsInDay(event, day)) {
      inDayTicks.add(event.tickId);
      inDayTimestamps.push(Date.parse(event.recordedAtIso));
    }
    if (event.outcome === 'budget-exhausted') {
      overBudgetTicks.add(event.tickId);
    }
    pushJobEvent(byJob, event, day);
  }
  inDayTimestamps.sort((a, b) => a - b);
  return { inDayTicks, overBudgetTicks, byJob, inDayTimestamps };
}

/** In-day ticks that carried a `budget-exhausted` job. */
function countDayBudgetOverruns(inDayTicks: ReadonlySet<string>, overBudgetTicks: ReadonlySet<string>): number {
  let budgetOverruns = 0;
  for (const tickId of overBudgetTicks) {
    if (inDayTicks.has(tickId)) {
      budgetOverruns += 1;
    }
  }
  return budgetOverruns;
}

/** Jobs whose time-ordered sequence carries a starved run touching the day. */
function countStarvedJobs(byJob: ReadonlyMap<string, JobSequence[]>): number {
  let starvedJobs = 0;
  for (const sequence of byJob.values()) {
    sequence.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    if (hasStarvedRun(sequence)) {
      starvedJobs += 1;
    }
  }
  return starvedJobs;
}

/**
 * The three S12 counts, from the collected tallies. As in the original
 * single loop, all three are computed before any verdict is chosen.
 */
function tickHealthCounts(tallies: TickHealthTallies): TickHealthCounts {
  return {
    totalTicks: tallies.inDayTicks.size,
    budgetOverruns: countDayBudgetOverruns(tallies.inDayTicks, tallies.overBudgetTicks),
    starvedJobs: countStarvedJobs(tallies.byJob),
  };
}

/**
 * The day's last in-day tick must fall within the grace window of day end
 * (the exact boundary `dayEndMs - SHADOW_LAST_TICK_GRACE_MS` passes). A dead
 * daemon leaves the tail of the day unticked. Returns the failing reason, or
 * null when the coverage of the day's close is acceptable.
 */
function lastTickVerdict(inDayTimestamps: readonly number[], day: string): string | null {
  const dayStartMs = Date.parse(`${day}T00:00:00.000Z`);
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1_000;
  if (inDayTimestamps.length === 0 || inDayTimestamps[inDayTimestamps.length - 1] < dayEndMs - SHADOW_LAST_TICK_GRACE_MS) {
    return 'late-last-tick';
  }
  return null;
}

/**
 * The day must be continuously covered — the largest hole from day start to
 * the first tick, between consecutive ticks, and from the last tick to day
 * end must not exceed `SHADOW_MAX_TICK_GAP_MS` (the exact boundary
 * `=== SHADOW_MAX_TICK_GAP_MS` passes). Paused ticks emit `jobs: []`, so a
 * pause longer than this limit fails the day here (see the policy note on
 * the constant). Returns the failing reason, or null when the gaps hold.
 */
function maxGapVerdict(inDayTimestamps: readonly number[], day: string): string | null {
  const dayStartMs = Date.parse(`${day}T00:00:00.000Z`);
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1_000;
  let maxGapMs = inDayTimestamps[0] - dayStartMs;
  for (let index = 1; index < inDayTimestamps.length; index += 1) {
    const gap = inDayTimestamps[index] - inDayTimestamps[index - 1];
    if (gap > maxGapMs) {
      maxGapMs = gap;
    }
  }
  const tailGap = dayEndMs - inDayTimestamps[inDayTimestamps.length - 1];
  if (tailGap > maxGapMs) {
    maxGapMs = tailGap;
  }
  if (maxGapMs > SHADOW_MAX_TICK_GAP_MS) {
    return 'coverage-gap';
  }
  return null;
}

/** The S12 rules, over already-validated job events. All three counts are computed before any verdict return. */
function judgeTickHealth(jobEvents: readonly DaemonEventRecord[], day: string): ShadowTickHealthEvaluation {
  const tallies = collectDayJobTicks(jobEvents, day);
  const counts = tickHealthCounts(tallies);
  if (counts.totalTicks < SHADOW_MIN_TICKS_PER_DAY) {
    return withTickHealthCounts(FAIL('too-few-ticks'), counts);
  }
  // OD7a3: the day's last in-day tick must fall within the grace window of
  // day end (the exact boundary `dayEndMs - SHADOW_LAST_TICK_GRACE_MS`
  // passes). A dead daemon leaves the tail of the day unticked.
  const lastTick = lastTickVerdict(tallies.inDayTimestamps, day);
  if (lastTick !== null) {
    return withTickHealthCounts(FAIL(lastTick), counts);
  }
  // OD7a3: the day must be continuously covered — see `maxGapVerdict`.
  const maxGap = maxGapVerdict(tallies.inDayTimestamps, day);
  if (maxGap !== null) {
    return withTickHealthCounts(FAIL(maxGap), counts);
  }
  if (counts.budgetOverruns * 100 > counts.totalTicks) {
    return withTickHealthCounts(FAIL('tick-budget-overrun'), counts);
  }
  if (counts.starvedJobs > 0) {
    return withTickHealthCounts(FAIL('job-starved'), counts);
  }
  return withTickHealthCounts(PASS('ticks-within-budget'), counts);
}

/** Append one event to its job's sequence, ordered later by `(recordedAtIso, eventId)`. */
function pushJobEvent(byJob: Map<string, JobSequence[]>, event: DaemonEventRecord, day: string): void {
  let sequence = byJob.get(event.jobId);
  if (sequence === undefined) {
    sequence = [];
    byJob.set(event.jobId, sequence);
  }
  sequence.push({
    outcome: event.outcome ?? '',
    inDay: fallsInDay(event, day),
    sortKey: `${event.recordedAtIso}\u0000${event.eventId}`,
  });
}

/**
 * One sampled journal entry's S9-relevant fields, or null when out of shape.
 * `position` is this entry's index in the caller's `journal` array, which the
 * real journal store's read APIs (`listForRun`, `listForKey`,
 * `listForKeyPrefix`) always return in true append order. It is the
 * authoritative order for anything that depends on order — never
 * `recordedAtIso` alone, since two entries can legitimately share one
 * timestamp.
 */
interface SampledJournalEntry {
  /** intent and result: the entry's key; conduct: null, matching the journal contract exactly. */
  readonly key: string | null;
  readonly kind: 'intent' | 'result' | 'conduct';
  /** A known outcome string on a `result` entry; `null` on every other kind, matching the journal contract exactly. */
  readonly outcome: string | null;
  readonly recordedAtIso: string;
  /** This entry's index in the caller's `journal` array (true append order). */
  readonly position: number;
}

const SAMPLED_ENTRY_KEYS: readonly string[] = ['key', 'kind', 'outcome', 'recordedAtIso'];

/**
 * One journal entry, or null when any field is out of shape. `position` is
 * this entry's index in the caller's `journal` array; it is not read from
 * the raw entry itself, since the journal contract carries no sequence field
 * of its own — order lives only in the array position a true-append-order
 * read gives each entry.
 */
function readSampledEntry(raw: unknown, position: number): SampledJournalEntry | null {
  const snapshot = readExactPlainRecord(raw, SAMPLED_ENTRY_KEYS);
  if (snapshot === null) {
    return null;
  }
  const { key, kind, outcome, recordedAtIso } = snapshot;
  // A kind the journal contract does not name is refused, never silently
  // ignored: an unrecognized entry must turn the day `unknown` rather than
  // disappear from the tally. A `conduct` entry is a normal part of a real
  // journal (a conduct entry for an entered state) and is accepted here, but
  // it carries no key, so it is excluded from the keyed intent/result
  // tallying below rather than judged against any key.
  if (kind !== 'intent' && kind !== 'result' && kind !== 'conduct') {
    return null;
  }
  if (typeof recordedAtIso !== 'string' || !isZonedIsoDateTime(recordedAtIso)) {
    return null;
  }
  if (kind === 'conduct') {
    // The journal contract requires `key: null` and `outcome: null` on every
    // conduct entry (lane-run-journal.ts); anything else there is malformed,
    // exactly as for intent and result below.
    if (key !== null || outcome !== null) {
      return null;
    }
    return { key: null, kind, outcome: null, recordedAtIso: new Date(recordedAtIso).toISOString(), position };
  }
  if (typeof key !== 'string' || key.length === 0) {
    return null;
  }
  // The journal contract carries a real outcome string only on a `result`
  // entry; an `intent` entry's `outcome` is always `null` there (it has not
  // resolved yet). Anything else in either position is what makes the entry
  // malformed, never the reverse: a normal open intent must not be refused.
  if (kind === 'result') {
    if (typeof outcome !== 'string' || !LANE_RUN_JOURNAL_OUTCOMES.includes(outcome as LaneRunJournalOutcome)) {
      return null;
    }
    return { key, kind, outcome, recordedAtIso: new Date(recordedAtIso).toISOString(), position };
  }
  if (outcome !== null) {
    return null;
  }
  return { key, kind, outcome: null, recordedAtIso: new Date(recordedAtIso).toISOString(), position };
}

/**
 * Whether a sampled `result` entry closes its key, mirroring the real
 * journal writer's own rule exactly (`lane-run-journal.ts`'s
 * `isClosedByFinalResult`): every outcome except `ambiguous` closes it,
 * except `not-started` on a request-channel key — identified the same way
 * the writer identifies it, `parseLaneRunKey(key)?.kind === 'request'` —
 * which the writer treats as non-final, so a later final result is still
 * allowed there.
 */
function isFinalResultEntry(entry: SampledJournalEntry): boolean {
  if (entry.outcome === 'ambiguous') {
    return false;
  }
  if (entry.outcome === 'not-started') {
    return parseLaneRunKey(entry.key)?.kind !== 'request';
  }
  return true;
}

/** One key's journal tallies. */
interface KeyTally {
  intents: number;
  /** The `recordedAtIso` of this key's earliest-position intent; used only for the wall-clock grace check below. */
  intentIso: string | null;
  /** The position of this key's earliest intent, or null with none. */
  intentPosition: number | null;
  /** How many of this key's results close it (see `isFinalResultEntry`). */
  finalResults: number;
  hasResult: boolean;
  /** The earliest position among this key's `result` entries, any outcome, or null with none. */
  earliestResultPosition: number | null;
  /** The earliest position among this key's closing ("final") results, or null with none. */
  finalResultPosition: number | null;
  /** The latest position among this key's `result` entries, any outcome, or null with none. */
  latestResultPosition: number | null;
  /** True when any of this key's entries falls inside the scoping day's `[start, end)` bounds (always true when unscoped). */
  touchesDay: boolean;
}

/** The half-open UTC-millisecond bounds `[start, end)` of one recorded day. */
interface DayBounds {
  readonly start: number;
  readonly end: number;
}

/** The `[D, D+1)` bounds of UTC day `day` in epoch milliseconds, via `Date.parse` — never string prefixes. */
function dayBounds(day: string): DayBounds {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return { start, end: start + 86_400_000 };
}

/**
 * The per-key tallies. Every field is a count or a minimum/maximum over the
 * whole entry set for that key, so the verdict never depends on which order
 * this function itself walks `entries` in — but it DOES depend on each
 * entry's own `position`, the true-append-order index the caller's `journal`
 * array gave it: two entries can share one `recordedAtIso`, so timestamp
 * order is never the authority here, only `kind`, `outcome` and `position`
 * are. A `conduct` entry carries no key (`entry.key === null`) and is
 * excluded here: it has nothing to tally against any key's sequence.
 *
 * `bounds` scopes `touchesDay`, not the tallies themselves: when it is null
 * every key's `touchesDay` stays true (unscoped, so every key is reportable);
 * when it carries a day's `[start, end)` bounds, a key's `touchesDay` is true
 * exactly when one of that key's own entries parses into the half-open
 * interval. Sequence checks that must be day-scoped filter the entries and
 * then restrict the tallied map to keys with `touchesDay === true`.
 */
function tallyJournal(
  entries: readonly SampledJournalEntry[],
  bounds: DayBounds | null,
): Map<string, KeyTally> {
  const tallies = new Map<string, KeyTally>();
  for (const entry of entries) {
    if (entry.key === null) {
      continue;
    }
    const ms = bounds === null ? Number.NaN : Date.parse(entry.recordedAtIso);
    const inDay = bounds === null || (ms >= bounds.start && ms < bounds.end);
    let tally = tallies.get(entry.key);
    if (tally === undefined) {
      tally = {
        intents: 0,
        intentIso: null,
        intentPosition: null,
        finalResults: 0,
        hasResult: false,
        earliestResultPosition: null,
        finalResultPosition: null,
        latestResultPosition: null,
        touchesDay: false,
      };
      tallies.set(entry.key, tally);
    }
    if (inDay) {
      tally.touchesDay = true;
    }
    if (entry.kind === 'intent') {
      tally.intents += 1;
      if (tally.intentPosition === null || entry.position < tally.intentPosition) {
        tally.intentPosition = entry.position;
        tally.intentIso = entry.recordedAtIso;
      }
    }
    if (entry.kind === 'result') {
      tally.hasResult = true;
      if (tally.earliestResultPosition === null || entry.position < tally.earliestResultPosition) {
        tally.earliestResultPosition = entry.position;
      }
      if (tally.latestResultPosition === null || entry.position > tally.latestResultPosition) {
        tally.latestResultPosition = entry.position;
      }
      if (isFinalResultEntry(entry)) {
        tally.finalResults += 1;
        if (tally.finalResultPosition === null || entry.position < tally.finalResultPosition) {
          tally.finalResultPosition = entry.position;
        }
      }
    }
  }
  return tallies;
}


/**
 * S9's evaluation: the shared verdict plus the day's state-integrity counts.
 * `stateChecked` and `stateBad` come from the state-check sample. The other
 * six count distinct journal keys and how many of those keys show each
 * anomaly. An early `unknown` refusal carries zeros. `state-check-failed`
 * carries the state-check counts and zeros for the six journal counts. A
 * journal verdict carries all eight, including anomalies that were not the
 * first failure — `reason` stays the first failing tally in map order.
 */
export type ShadowStateIntegrityEvaluation = ShadowCriterionEvaluation & {
  readonly stateChecked: number;
  readonly stateBad: number;
  readonly journalKeys: number;
  readonly duplicateIntents: number;
  readonly duplicateResults: number;
  readonly resultsAfterFinal: number;
  readonly orphanResults: number;
  readonly unreconciledIntents: number;
};

/** The eight S9 counts. Early refusals share this frozen zero value. */
type StateIntegrityCounts = Omit<ShadowStateIntegrityEvaluation, 'status' | 'reason'>;

const ZERO_STATE_COUNTS: StateIntegrityCounts = Object.freeze({
  stateChecked: 0,
  stateBad: 0,
  journalKeys: 0,
  duplicateIntents: 0,
  duplicateResults: 0,
  resultsAfterFinal: 0,
  orphanResults: 0,
  unreconciledIntents: 0,
});

/**
 * A fresh, frozen evaluation built from a status, a reason and the eight
 * counts — never a shared object, so a caller mutating one returned
 * evaluation cannot corrupt another call's result.
 */
function stateIntegrityResult(
  status: ShadowCriterionEvaluation['status'],
  reason: string,
  counts: StateIntegrityCounts,
): ShadowStateIntegrityEvaluation {
  return Object.freeze({ status, reason, ...counts });
}

/**
 * S9, conductor state integrity, over `{ stateCheck, journal, sampledAtIso }`
 * plus the optional recorded UTC day `day`.
 *
 * `journal` must be supplied in true append order — the order
 * `listForRun`/`listForKey`/`listForKeyPrefix` return it, never re-sorted by
 * `recordedAtIso` — since an entry's position in that array, not its
 * timestamp, is the authority for any ordering check below (two entries can
 * share one timestamp).
 *
 * When the `day` key is present it must be a real UTC calendar day
 * `YYYY-MM-DD`; anything else (including `null`/`undefined` under a present
 * key, or an enumerable getter, whose copied value is `undefined`) is refused
 * with `unknown`/`invalid-input`. With `day` set, the sequence anomalies and
 * `journalKeys` are scoped to the half-open instant interval `[D, D+1)`
 * computed with `Date.parse` (never string prefixes): only keys with an entry
 * falling inside that interval are counted, entries at or after `D+1 00:00Z`
 * are excluded, while earlier entries are kept so a `D-1` intent closed by a
 * `D` result stays paired instead of becoming a false `orphan-result`. With
 * `day` absent the whole journal is counted, preserving the unscoped behaviour
 * for direct callers. `unreconciledIntents` is always computed over the FULL
 * journal, never scoped to `D`: scoping it would be fail-open (an intent at
 * `D` 23:55 recorded at `D+1` 00:05 would never be flagged again), and the
 * full scope keeps an intent at `D` 23:59 closed at `D+1` 00:01 from being a
 * false fail. Malformed entries anywhere in `journal` — even outside `D` —
 * still refuse as `invalid-input` before any scoping.
 *
 * Cost: the accepted engine bound of `Reflect.ownKeys` (the `O(1)`
 * length/prototype pre-gate, then `O(K)` in the target's own-property count
 * K, then `O(cap)` element traversal over `SHADOW_MAX_HEALTH_ITEMS`): at
 * most that
 * many journal entries are walked (once, plus one constant-time `Date.parse`
 * per entry for the bounds), and an oversized, sparse, extra-keyed or
 * accessor-backed `journal`
 * is refused from its own `length` descriptor before any entry is traversed.
 * Every value is read through its own property descriptor, so no getter ever
 * runs and a Proxy stand-in yields exactly the verdict of the data its own
 * reflection reports. Never throws, never echoes the input.
 */
export function evaluateShadowStateIntegrity(input: unknown): ShadowStateIntegrityEvaluation {
  try {
    return judgeDayStateIntegrity(input);
  } catch {
    // Same revoked-Proxy / throwing-trap case as the tick evaluator above.
    return stateIntegrityResult('unknown', 'invalid-input', ZERO_STATE_COUNTS);
  }
}

function judgeDayStateIntegrity(input: unknown): ShadowStateIntegrityEvaluation {
  const snapshot = readPlainRecordWithOptionalKeys(
    input,
    ['stateCheck', 'journal', 'sampledAtIso'],
    ['day'],
  );
  if (snapshot === null) {
    return stateIntegrityResult('unknown', 'invalid-input', ZERO_STATE_COUNTS);
  }
  // `day` is optional: present-and-invalid refuses, absent stays unscoped.
  // An enumerable getter on `day` is copied as `undefined` by
  // `readPlainRecordWithOptionalKeys`, so `readUtcDay` refuses it — the
  // getter itself never runs.
  let day: string | null = null;
  if (Object.hasOwn(snapshot, 'day')) {
    day = readUtcDay(snapshot.day);
    if (day === null) {
      return stateIntegrityResult('unknown', 'invalid-input', ZERO_STATE_COUNTS);
    }
  }
  let stateCheck: { checked?: unknown; bad?: unknown } | null = null;
  if (snapshot.stateCheck !== null) {
    const stateCheckSnapshot = readExactPlainRecord(snapshot.stateCheck, ['checked', 'bad']);
    if (stateCheckSnapshot === null) {
      return stateIntegrityResult('unknown', 'invalid-input', ZERO_STATE_COUNTS);
    }
    // Read the validated snapshot below, never the raw `snapshot.stateCheck`
    // input again: that input may carry an enumerable getter or be a Proxy
    // with a lying `get` trap, and a plain property access on it would run
    // that getter or trap, trusting a value `readExactPlainRecord` never
    // vouched for. The snapshot's own values were already copied through
    // `Object.getOwnPropertyDescriptor`, so reading them here triggers
    // nothing.
    stateCheck = stateCheckSnapshot as { checked?: unknown; bad?: unknown };
  }
  // #4ac: every structural input is validated BEFORE any state-check verdict,
  // so a malformed or oversized `journal`, a bad `sampledAtIso`, or invalid
  // `stateCheck` counts refuse as `invalid-input` even when the state check
  // would otherwise have been `state-check-unavailable` (null / zero checked)
  // or `state-check-failed` (bad > 0).
  if (stateCheck !== null && (!isCount(stateCheck.checked) || !isCount(stateCheck.bad))) {
    return stateIntegrityResult('unknown', 'invalid-input', ZERO_STATE_COUNTS);
  }
  // The counts were validated above; snapshot them as numbers so the verdicts
  // below never re-read an `unknown`-typed property.
  const stateChecked = stateCheck === null ? 0 : stateCheck.checked as number;
  const stateBad = stateCheck === null ? 0 : stateCheck.bad as number;
  const journal = readBoundedDenseArray(snapshot.journal, SHADOW_MAX_HEALTH_ITEMS);
  if (journal === null) {
    return stateIntegrityResult('unknown', 'invalid-input', ZERO_STATE_COUNTS);
  }
  const entries: SampledJournalEntry[] = [];
  // `journal.array` is a fresh dense copy this module created, so plain
  // indexed reads here can never run a getter or a Proxy `get` trap.
  for (let index = 0; index < journal.length; index += 1) {
    const entry = readSampledEntry(journal.array[index], index);
    if (entry === null) {
      return stateIntegrityResult('unknown', 'invalid-input', ZERO_STATE_COUNTS);
    }
    entries.push(entry);
  }
  if (typeof snapshot.sampledAtIso !== 'string' || !isZonedIsoDateTime(snapshot.sampledAtIso)) {
    return stateIntegrityResult('unknown', 'invalid-input', ZERO_STATE_COUNTS);
  }
  // The structural inputs are all valid here; only now may the state-check
  // verdicts take over (precedence per #4ac).
  if (stateCheck === null || stateChecked === 0) {
    return stateIntegrityResult('unknown', 'state-check-unavailable', ZERO_STATE_COUNTS);
  }
  if (stateBad > 0) {
    return stateIntegrityResult('fail', 'state-check-failed', {
      ...ZERO_STATE_COUNTS,
      stateChecked,
      stateBad,
    });
  }
  return judgeJournalIntegrity(
    entries,
    new Date(snapshot.sampledAtIso).toISOString(),
    stateChecked,
    stateBad,
    day,
  );
}

/** A non-negative safe integer count. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Whether `key` is one of the control kinds the real journal writer treats
 * as never pending (`lane-run-journal.ts`'s `pendingStepIntent` /
 * `laneRunJournalPendingIntent`, and its comment: "Control keys (stop,
 * resume, request, reaper) are never pending: they are not external
 * actions."). A key of one of these kinds may legitimately carry an intent
 * that never gets any result at all — most commonly an operator stop — so
 * the open-intent grace check below must never flag one as
 * `unreconciled-intent` regardless of its age. A key that is not even a
 * recognized lane-run key (for example a synthetic test key) is not a
 * control key by this rule and stays subject to the grace check as before.
 */
function isControlKeyKind(key: string): boolean {
  const kind = parseLaneRunKey(key)?.kind;
  return kind === 'stop' || kind === 'resume' || kind === 'request' || kind === 'reaper';
}

/** A key recorded more than one intent. */
function isDuplicateIntent(tally: KeyTally): boolean {
  return tally.intents > 1;
}

/** A key recorded more than one closing result. */
function isDuplicateResult(tally: KeyTally): boolean {
  return tally.finalResults > 1;
}

/**
 * Once a key has a closing ("final") result, the real journal store
 * refuses to append anything further for that key at write time
 * (lane-run-journal.ts's `resultRefusal`/`isClosedByFinalResult`, reason
 * `result-after-final`). That refusal is decided from APPEND ORDER, not
 * from `recordedAtIso` — two entries can share one timestamp — so this
 * compares `position`, not timestamps: a result of any outcome recorded
 * at a later position than the key's earliest closing result represents
 * that otherwise-impossible state, distinct from two closing results
 * (`isDuplicateResult`).
 */
function isResultAfterFinal(tally: KeyTally): boolean {
  const finalResultPosition = tally.finalResultPosition;
  const latestResultPosition = tally.latestResultPosition;
  return (
    finalResultPosition !== null &&
    latestResultPosition !== null &&
    latestResultPosition > finalResultPosition
  );
}

/**
 * A result's earliest position is before the key's intent. Both sides are
 * aggregates over the whole key, so the answer does not depend on the order
 * the entries are walked.
 */
function resultPredatesIntent(tally: KeyTally): boolean {
  const intentPosition = tally.intentPosition;
  const earliestResultPosition = tally.earliestResultPosition;
  return (
    intentPosition !== null &&
    earliestResultPosition !== null &&
    earliestResultPosition < intentPosition
  );
}

/**
 * A result with no intent at all, or one appended before the key's intent,
 * breaks the journal contract's required order: the real store's
 * `resultRefusal` only ever finds an intent among entries already appended
 * (earlier position) than the result being appended.
 */
function isOrphanResult(tally: KeyTally): boolean {
  if (!tally.hasResult) {
    return false;
  }
  if (tally.intents === 0) {
    return true;
  }
  return resultPredatesIntent(tally);
}

/**
 * This tally's first sequence anomaly, in the check order S9 has always
 * used: duplicate-intent, then duplicate-result, then result-after-final,
 * then orphan-result. Null when this tally has none of them.
 */
function tallySequenceReason(
  duplicateIntents: number,
  duplicateResults: number,
  resultsAfterFinal: number,
  orphanResults: number,
): string | null {
  if (duplicateIntents > 0) {
    return 'journal-duplicate-intent';
  }
  if (duplicateResults > 0) {
    return 'journal-duplicate-result';
  }
  if (resultsAfterFinal > 0) {
    return 'journal-result-after-final';
  }
  if (orphanResults > 0) {
    return 'journal-orphan-result';
  }
  return null;
}

/**
 * The first failing reason wins. A candidate is recorded only while none
 * has been; a null candidate never replaces a reason and never invents one.
 */
function adoptFirstReason(reason: string | null, candidate: string | null): string | null {
  if (reason === null) {
    return candidate;
  }
  return reason;
}

/** One key's four sequence anomalies, or those same fields summed across the map. */
interface SequenceAnomalyCounts {
  readonly duplicateIntents: number;
  readonly duplicateResults: number;
  readonly resultsAfterFinal: number;
  readonly orphanResults: number;
  readonly reason: string | null;
}

/** The 0/1 contribution of one tally, with that tally's own first sequence reason. */
function sequenceAnomalyStep(tally: KeyTally): SequenceAnomalyCounts {
  const duplicateIntents = isDuplicateIntent(tally) ? 1 : 0;
  const duplicateResults = isDuplicateResult(tally) ? 1 : 0;
  const resultsAfterFinal = isResultAfterFinal(tally) ? 1 : 0;
  const orphanResults = isOrphanResult(tally) ? 1 : 0;
  return {
    duplicateIntents,
    duplicateResults,
    resultsAfterFinal,
    orphanResults,
    reason: tallySequenceReason(duplicateIntents, duplicateResults, resultsAfterFinal, orphanResults),
  };
}

/**
 * Loop 1, over `tallies.values()` (map insertion order). Every sequence
 * predicate is counted on every key. `reason` is the first failing tally's
 * first anomaly in the check order above.
 */
function countJournalSequenceAnomalies(tallies: ReadonlyMap<string, KeyTally>): SequenceAnomalyCounts {
  let duplicateIntents = 0;
  let duplicateResults = 0;
  let resultsAfterFinal = 0;
  let orphanResults = 0;
  let reason: string | null = null;
  for (const tally of tallies.values()) {
    const step = sequenceAnomalyStep(tally);
    duplicateIntents += step.duplicateIntents;
    duplicateResults += step.duplicateResults;
    resultsAfterFinal += step.resultsAfterFinal;
    orphanResults += step.orphanResults;
    reason = adoptFirstReason(reason, step.reason);
  }
  return { duplicateIntents, duplicateResults, resultsAfterFinal, orphanResults, reason };
}

/** The sample was taken more than `SHADOW_OPEN_INTENT_GRACE_MS` after the intent. */
function isPastOpenIntentGrace(sampledAtIso: string, intentIso: string): boolean {
  return new Date(sampledAtIso).getTime() - new Date(intentIso).getTime() > SHADOW_OPEN_INTENT_GRACE_MS;
}

/**
 * Whether this key is an open intent older than the grace window.
 * Control-kind keys (stop, resume, request, reaper) are exempt: see
 * `isControlKeyKind`. This also covers a request-channel key whose only
 * result is `not-started` — that result does not close the key
 * (`isFinalResultEntry`, matching the real writer's `isClosedByFinalResult`),
 * so `finalResults` stays 0 there too, and without this exemption it would
 * otherwise still reach the grace check. The grace period is wall-clock,
 * not append order: how long the sample was taken after the intent's own
 * timestamp.
 */
function isUnreconciledOpenIntent(key: string, tally: KeyTally, sampledAtIso: string): boolean {
  const intentIso = tally.intentIso;
  if (tally.intents === 0 || tally.finalResults > 0 || intentIso === null) {
    return false;
  }
  if (isControlKeyKind(key)) {
    return false;
  }
  return isPastOpenIntentGrace(sampledAtIso, intentIso);
}

/** Loop 2's total. `unreconciled-intent` is recorded only while `reasonSoFar` is still null. */
interface UnreconciledIntentAnomalies {
  readonly unreconciledIntents: number;
  readonly reason: string | null;
}

/**
 * Loop 2, over `tallies.entries()` (the same map order as loop 1). It still
 * runs when loop 1 already chose the reason, so every over-grace open intent
 * is counted; the reason changes only while it is still null.
 */
function countUnreconciledIntents(
  tallies: ReadonlyMap<string, KeyTally>,
  sampledAtIso: string,
  reasonSoFar: string | null,
): UnreconciledIntentAnomalies {
  let unreconciledIntents = 0;
  let reason = reasonSoFar;
  for (const [key, tally] of tallies.entries()) {
    if (isUnreconciledOpenIntent(key, tally, sampledAtIso)) {
      unreconciledIntents += 1;
      reason = adoptFirstReason(reason, 'unreconciled-intent');
    }
  }
  return { unreconciledIntents, reason };
}

/**
 * The S9 journal rules, over already-validated entries. Every anomaly predicate
 * is counted on every key. `reason` stays the first failure in map order, with
 * the per-tally check order unchanged: loop 1 (over `tallies.values()`) is
 * duplicate-intent, then duplicate-result, then result-after-final, then
 * orphan-result; loop 2 (over `tallies.entries()`) supplies `unreconciled-intent`
 * only when loop 1 found nothing. Loop 2 still counts every over-grace open
 * intent when loop 1 already chose the reason. The loops are
 * `countJournalSequenceAnomalies` and `countUnreconciledIntents`, so each
 * function stays under Sonar's cognitive-complexity limit of 15.
 *
 * `day` scopes the sequence counts and `journalKeys` but never
 * `unreconciledIntents`. The full-journal tallies are always computed and
 * drive loop 2; when `day` is set, loop 1 runs over `scopedTallies`: the
 * entries are first filtered to instants before `D+1 00:00Z` (keeping earlier
 * entries, so a `D-1` intent closed by a `D` result stays paired and does not
 * become a false `orphan-result`), tallied, and then restricted to keys whose
 * `touchesDay` is true — keys with no entry inside `[D, D+1)` disappear from
 * the sequence counts and from `journalKeys`. When `day` is null the full
 * tallies drive both loops.
 */
function judgeJournalIntegrity(
  entries: readonly SampledJournalEntry[],
  sampledAtIso: string,
  stateChecked: number,
  stateBad: number,
  day: string | null,
): ShadowStateIntegrityEvaluation {
  const bounds = day === null ? null : dayBounds(day);
  const fullTallies = tallyJournal(entries, bounds);
  let sequence: SequenceAnomalyCounts;
  let journalKeys: number;
  if (bounds === null) {
    sequence = countJournalSequenceAnomalies(fullTallies);
    journalKeys = fullTallies.size;
  } else {
    const scopedEntries = entries.filter((entry) => Date.parse(entry.recordedAtIso) < bounds.end);
    const scopedAll = tallyJournal(scopedEntries, bounds);
    const scopedTallies = new Map<string, KeyTally>();
    for (const [key, tally] of scopedAll.entries()) {
      if (tally.touchesDay) {
        scopedTallies.set(key, tally);
      }
    }
    sequence = countJournalSequenceAnomalies(scopedTallies);
    journalKeys = scopedTallies.size;
  }
  // Loop 2 always runs over the full tallies: `unreconciledIntents` is never
  // day-scoped (scoping it would be fail-open), and a full-journal intent at
  // `D` 23:59 closed at `D+1` 00:01 has `finalResults > 0`, so it is not a
  // false fail.
  const unreconciled = countUnreconciledIntents(fullTallies, sampledAtIso, sequence.reason);
  const counts: StateIntegrityCounts = {
    stateChecked,
    stateBad,
    journalKeys,
    duplicateIntents: sequence.duplicateIntents,
    duplicateResults: sequence.duplicateResults,
    resultsAfterFinal: sequence.resultsAfterFinal,
    orphanResults: sequence.orphanResults,
    unreconciledIntents: unreconciled.unreconciledIntents,
  };
  if (unreconciled.reason !== null) {
    return stateIntegrityResult('fail', unreconciled.reason, counts);
  }
  return stateIntegrityResult('pass', 'state-consistent', counts);
}
