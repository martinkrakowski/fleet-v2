// Lane SH5b: the S9 (conductor state integrity) and S12 (daemon tick
// health) shadow-criterion evaluators, pure over one UTC day's worth of
// already-collected facts. Pure: no filesystem, no subprocess, no clock.
// Never throws, never echoes an input value; every exported function takes
// `unknown` at its boundary and returns a typed `ShadowCriterionEvaluation`
// whose refusal carries a named reason code. S12 returns
// `ShadowTickHealthEvaluation`, adding `totalTicks`, `budgetOverruns` and
// `starvedJobs`.

import { isZonedIsoDateTime } from './conductor-halt.js';
import { readDaemonEventRecord } from './daemon-events.js';
import type { DaemonEventRecord } from './daemon-events.js';
import { DAEMON_STARVED_CONSECUTIVE_TICKS } from './daemon-tick.js';
import { LANE_RUN_JOURNAL_OUTCOMES } from './lane-run-journal.js';
import type { LaneRunJournalOutcome } from './lane-run-journal.js';
import { parseLaneRunKey } from './lane-run-keys.js';
import type { ShadowCriterionEvaluation } from './shadow-evidence-ledger.js';
import { readExactPlainRecord } from './plain-record-reads.js';

/** The plan's DT §3.1 tick floor: about half the ~1,440 ticks a 60-second day produces. */
export const SHADOW_MIN_TICKS_PER_DAY = 720;
/** How long an intent may stay without a non-`ambiguous` result before S9 fails it. */
export const SHADOW_OPEN_INTENT_GRACE_MS = 900_000;
/** A sanity cap on how many events or journal entries one evaluator walks before refusing as unevaluable. */
export const SHADOW_MAX_HEALTH_ITEMS = 500_000;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const UNKNOWN = (reason: string): ShadowCriterionEvaluation => ({ status: 'unknown', reason });
const FAIL = (reason: string): ShadowCriterionEvaluation => ({ status: 'fail', reason });
const PASS = (reason: string): ShadowCriterionEvaluation => ({ status: 'pass', reason });

/**
 * One array validated by `readBoundedArray`: the array itself, plus the
 * length already read from its own property descriptor. Every caller uses
 * THIS length for its iteration bound and never reads `.length` on `array`
 * again: a plain `.length` property read on a Proxy-wrapped array invokes
 * its `get` trap, which can lie (report a shorter length than the real one,
 * or zero), letting a caller silently skip entries it should have walked —
 * turning a real failure into a false pass, or hiding a starved tail.
 */
interface BoundedArray {
  readonly array: readonly unknown[];
  readonly length: number;
}

/**
 * The capped element count of a real, dense array, or null for any stand-in.
 * Reads only the `length` own descriptor and `Object.keys` (no values), so no
 * getter and no Proxy `get` trap ever runs; an oversized or sparse array is
 * refused from its length alone, before any element is touched. Returns the
 * length read from the descriptor alongside the array (see `BoundedArray`):
 * no caller may read `.length` on the returned array as a plain property
 * access again.
 */
function readBoundedArray(value: unknown, cap: number): BoundedArray | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value > cap
  ) {
    return null;
  }
  if (Object.keys(value).length !== lengthDescriptor.value) {
    return null;
  }
  return { array: value as readonly unknown[], length: lengthDescriptor.value };
}

/** The own data-property element at `index`; a hole or an accessor reads as undefined. */
function ownElement(array: readonly unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

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
 * Cost: linear in the capped input plus a sort of each job's events — at
 * most `SHADOW_MAX_HEALTH_ITEMS` records are walked or sorted, and an
 * oversized, sparse or non-dense `events` array is refused from its own
 * `length` before any element is traversed. Every value is read through
 * its own property descriptor, so no getter ever runs and a Proxy stand-in
 * either is refused or yields exactly the plain data's verdict. Never
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
  const events = readBoundedArray(snapshot.events, SHADOW_MAX_HEALTH_ITEMS);
  if (events === null) {
    return withTickHealthCounts(UNKNOWN('daemon-events-invalid'), ZERO_TICK_HEALTH_COUNTS);
  }
  const jobEvents: DaemonEventRecord[] = [];
  // `events.length` below is the length `readBoundedArray` already read
  // from the descriptor, never a plain `.length` read on `events.array`
  // (which may be a Proxy whose `get` trap can lie about it).
  for (let index = 0; index < events.length; index += 1) {
    const read = readDaemonEventRecord(ownElement(events.array, index));
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

/** The S12 rules, over already-validated job events. All three counts are computed before any verdict return. */
function judgeTickHealth(jobEvents: readonly DaemonEventRecord[], day: string): ShadowTickHealthEvaluation {
  const inDayTicks = new Set<string>();
  const overBudgetTicks = new Set<string>();
  const byJob = new Map<string, JobSequence[]>();
  for (const event of jobEvents) {
    if (fallsInDay(event, day)) {
      inDayTicks.add(event.tickId);
    }
    if (event.outcome === 'budget-exhausted') {
      overBudgetTicks.add(event.tickId);
    }
    pushJobEvent(byJob, event, day);
  }
  const totalTicks = inDayTicks.size;
  let budgetOverruns = 0;
  for (const tickId of overBudgetTicks) {
    if (inDayTicks.has(tickId)) {
      budgetOverruns += 1;
    }
  }
  let starvedJobs = 0;
  for (const sequence of byJob.values()) {
    sequence.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    if (hasStarvedRun(sequence)) {
      starvedJobs += 1;
    }
  }
  const counts: TickHealthCounts = { totalTicks, budgetOverruns, starvedJobs };
  if (totalTicks < SHADOW_MIN_TICKS_PER_DAY) {
    return withTickHealthCounts(FAIL('too-few-ticks'), counts);
  }
  if (budgetOverruns * 100 > totalTicks) {
    return withTickHealthCounts(FAIL('tick-budget-overrun'), counts);
  }
  if (starvedJobs > 0) {
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
 */
function tallyJournal(entries: readonly SampledJournalEntry[]): Map<string, KeyTally> {
  const tallies = new Map<string, KeyTally>();
  for (const entry of entries) {
    if (entry.key === null) {
      continue;
    }
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
      };
      tallies.set(entry.key, tally);
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
 * S9, conductor state integrity, over `{ stateCheck, journal, sampledAtIso }`.
 * `journal` must be supplied in true append order — the order
 * `listForRun`/`listForKey`/`listForKeyPrefix` return it, never re-sorted by
 * `recordedAtIso` — since an entry's position in that array, not its
 * timestamp, is the authority for any ordering check below (two entries can
 * share one timestamp). Cost: linear in the capped input — at most
 * `SHADOW_MAX_HEALTH_ITEMS` journal entries are walked, and an oversized,
 * sparse or non-dense `journal` array is refused from its own `length`
 * before any entry is traversed. Every value is read through its own
 * property descriptor, so no getter ever runs and a Proxy stand-in either is
 * refused or yields exactly the plain data's verdict. Never throws, never
 * echoes the input.
 */
export function evaluateShadowStateIntegrity(input: unknown): ShadowCriterionEvaluation {
  try {
    return judgeDayStateIntegrity(input);
  } catch {
    // Same revoked-Proxy / throwing-trap case as the tick evaluator above.
    return UNKNOWN('invalid-input');
  }
}

function judgeDayStateIntegrity(input: unknown): ShadowCriterionEvaluation {
  const snapshot = readExactPlainRecord(input, ['stateCheck', 'journal', 'sampledAtIso']);
  if (snapshot === null) {
    return UNKNOWN('invalid-input');
  }
  let stateCheck: { checked?: unknown; bad?: unknown } | null = null;
  if (snapshot.stateCheck !== null) {
    const stateCheckSnapshot = readExactPlainRecord(snapshot.stateCheck, ['checked', 'bad']);
    if (stateCheckSnapshot === null) {
      return UNKNOWN('invalid-input');
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
  if (stateCheck === null || stateCheck.checked === 0) {
    return UNKNOWN('state-check-unavailable');
  }
  if (!isCount(stateCheck.checked) || !isCount(stateCheck.bad)) {
    return UNKNOWN('invalid-input');
  }
  if (stateCheck.bad > 0) {
    return FAIL('state-check-failed');
  }
  const journal = readBoundedArray(snapshot.journal, SHADOW_MAX_HEALTH_ITEMS);
  if (journal === null) {
    return UNKNOWN('invalid-input');
  }
  const entries: SampledJournalEntry[] = [];
  // `journal.length` below is the length `readBoundedArray` already read
  // from the descriptor, never a plain `.length` read on `journal.array`
  // (which may be a Proxy whose `get` trap can lie about it).
  for (let index = 0; index < journal.length; index += 1) {
    const entry = readSampledEntry(ownElement(journal.array, index), index);
    if (entry === null) {
      return UNKNOWN('invalid-input');
    }
    entries.push(entry);
  }
  if (typeof snapshot.sampledAtIso !== 'string' || !isZonedIsoDateTime(snapshot.sampledAtIso)) {
    return UNKNOWN('invalid-input');
  }
  return judgeJournalIntegrity(entries, new Date(snapshot.sampledAtIso).toISOString());
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

/** The S9 journal rules, over already-validated entries. */
function judgeJournalIntegrity(entries: readonly SampledJournalEntry[], sampledAtIso: string): ShadowCriterionEvaluation {
  const tallies = tallyJournal(entries);
  for (const tally of tallies.values()) {
    if (tally.intents > 1) {
      return FAIL('journal-duplicate-intent');
    }
    if (tally.finalResults > 1) {
      return FAIL('journal-duplicate-result');
    }
    // Once a key has a closing ("final") result, the real journal store
    // refuses to append anything further for that key at write time
    // (lane-run-journal.ts's `resultRefusal`/`isClosedByFinalResult`, reason
    // `result-after-final`). That refusal is decided from APPEND ORDER, not
    // from `recordedAtIso` — two entries can share one timestamp — so this
    // compares `position`, not timestamps: a result of any outcome recorded
    // at a later position than the key's earliest closing result represents
    // that otherwise-impossible state, distinct from two closing results
    // (`journal-duplicate-result` above).
    if (
      tally.finalResultPosition !== null &&
      tally.latestResultPosition !== null &&
      tally.latestResultPosition > tally.finalResultPosition
    ) {
      return FAIL('journal-result-after-final');
    }
    // A result with no intent at all, or one appended before the key's
    // intent, breaks the journal contract's required order: the real store's
    // `resultRefusal` only ever finds an intent among entries already
    // appended (earlier position) than the result being appended. Both sides
    // of this comparison are aggregates over the whole key (a count and a
    // minimum position), so the verdict is the same no matter what order
    // this function itself happens to walk the entries in.
    const resultPredatesIntent = tally.intentPosition !== null && tally.earliestResultPosition !== null
      && tally.earliestResultPosition < tally.intentPosition;
    if (tally.hasResult && (tally.intents === 0 || resultPredatesIntent)) {
      return FAIL('journal-orphan-result');
    }
  }
  for (const [key, tally] of tallies.entries()) {
    if (tally.intents === 0 || tally.finalResults > 0 || tally.intentIso === null) {
      continue;
    }
    // Control-kind keys (stop, resume, request, reaper) are exempt: see
    // `isControlKeyKind` above. This also covers a request-channel key whose
    // only result is `not-started` — that result does not close the key
    // (`isFinalResultEntry` above, matching the real writer's
    // `isClosedByFinalResult`), so `finalResults` stays 0 there too, and
    // without this exemption it would otherwise still reach the grace check
    // below.
    if (isControlKeyKind(key)) {
      continue;
    }
    // The open-intent grace period is genuinely wall-clock, not append
    // order: how long the sample was taken after the intent's own timestamp.
    if (new Date(sampledAtIso).getTime() - new Date(tally.intentIso).getTime() > SHADOW_OPEN_INTENT_GRACE_MS) {
      return FAIL('unreconciled-intent');
    }
  }
  return PASS('state-consistent');
}
