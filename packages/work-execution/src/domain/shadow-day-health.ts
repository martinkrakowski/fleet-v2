// Lane SH5b: the S9 (conductor state integrity) and S12 (daemon tick
// health) shadow-criterion evaluators, pure over one UTC day's worth of
// already-collected facts. Pure: no filesystem, no subprocess, no clock.
// Never throws, never echoes an input value; every exported function takes
// `unknown` at its boundary and returns a typed `ShadowCriterionEvaluation`
// whose refusal carries a named reason code.

import { isZonedIsoDateTime } from './conductor-halt.js';
import { readDaemonEventRecord } from './daemon-events.js';
import type { DaemonEventRecord } from './daemon-events.js';
import { DAEMON_STARVED_CONSECUTIVE_TICKS } from './daemon-tick.js';
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
 * The capped element count of a real, dense array, or null for any stand-in.
 * Reads only the `length` own descriptor and `Object.keys` (no values), so no
 * getter and no Proxy `get` trap ever runs; an oversized or sparse array is
 * refused from its length alone, before any element is touched.
 */
function readBoundedArray(value: unknown, cap: number): readonly unknown[] | null {
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
  return value as readonly unknown[];
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
 * midnight is still caught.
 */
function hasStarvedRun(sequence: readonly JobSequence[]): boolean {
  let run = 0;
  let runTouchesDay = false;
  for (const item of sequence) {
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
 * S12, daemon tick health, over `{ day, events }` where `events` spans
 * D-1 23:00Z to D+1 00:00Z (assembled by the caller; never re-derived here).
 * Cost: linear in the capped input plus one sort of the collected job
 * events — at most `SHADOW_MAX_HEALTH_ITEMS` records are walked or sorted,
 * and an oversized, sparse or non-dense `events` array is refused from its
 * own `length` before any element is traversed. Every value is read through
 * its own property descriptor, so no getter ever runs and a Proxy stand-in
 * either is refused or yields exactly the plain data's verdict. Never
 * throws, never echoes the input.
 */
export function evaluateShadowTickHealth(input: unknown): ShadowCriterionEvaluation {
  try {
    return judgeDayTickHealth(input);
  } catch {
    // A revoked Proxy, or one whose getPrototypeOf/ownKeys/descriptor trap
    // throws, can make even the descriptor readers throw; the never-throws
    // contract turns that into a typed refusal.
    return UNKNOWN('invalid-input');
  }
}

function judgeDayTickHealth(input: unknown): ShadowCriterionEvaluation {
  const snapshot = readExactPlainRecord(input, ['day', 'events']);
  if (snapshot === null) {
    return UNKNOWN('invalid-input');
  }
  const day = readUtcDay(snapshot.day);
  if (day === null) {
    return UNKNOWN('invalid-input');
  }
  const events = readBoundedArray(snapshot.events, SHADOW_MAX_HEALTH_ITEMS);
  if (events === null) {
    return UNKNOWN('daemon-events-invalid');
  }
  const jobEvents: DaemonEventRecord[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const read = readDaemonEventRecord(ownElement(events, index));
    if (!read.ok) {
      return UNKNOWN('daemon-events-invalid');
    }
    const job = asJobEvent(read.record);
    if (job !== null) {
      jobEvents.push(job);
    }
  }
  return judgeTickHealth(jobEvents, day);
}

/** The S12 rules, over already-validated job events. */
function judgeTickHealth(jobEvents: readonly DaemonEventRecord[], day: string): ShadowCriterionEvaluation {
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
  if (totalTicks < SHADOW_MIN_TICKS_PER_DAY) {
    return FAIL('too-few-ticks');
  }
  let overBudget = 0;
  for (const tickId of overBudgetTicks) {
    if (inDayTicks.has(tickId)) {
      overBudget += 1;
    }
  }
  if (overBudget * 100 > totalTicks) {
    return FAIL('tick-budget-overrun');
  }
  for (const sequence of byJob.values()) {
    sequence.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    if (hasStarvedRun(sequence)) {
      return FAIL('job-starved');
    }
  }
  return PASS('ticks-within-budget');
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

/** One sampled journal entry's S9-relevant fields, or null when out of shape. */
interface SampledJournalEntry {
  readonly key: string;
  readonly kind: string;
  readonly outcome: string;
  readonly recordedAtIso: string;
}

const SAMPLED_ENTRY_KEYS: readonly string[] = ['key', 'kind', 'outcome', 'recordedAtIso'];

/** One journal entry, or null when any field is out of shape. */
function readSampledEntry(raw: unknown): SampledJournalEntry | null {
  const snapshot = readExactPlainRecord(raw, SAMPLED_ENTRY_KEYS);
  if (snapshot === null) {
    return null;
  }
  const { key, kind, outcome, recordedAtIso } = snapshot;
  if (typeof key !== 'string' || key.length === 0 || typeof kind !== 'string' || kind.length === 0) {
    return null;
  }
  if (typeof outcome !== 'string' || outcome.length === 0) {
    return null;
  }
  if (typeof recordedAtIso !== 'string' || !isZonedIsoDateTime(recordedAtIso)) {
    return null;
  }
  return { key, kind, outcome, recordedAtIso: new Date(recordedAtIso).toISOString() };
}

/** One key's journal tallies. */
interface KeyTally {
  intents: number;
  intentIso: string | null;
  nonAmbiguousResults: number;
  hasResult: boolean;
}

/** The per-key tallies, in first-appearance order. */
function tallyJournal(entries: readonly SampledJournalEntry[]): Map<string, KeyTally> {
  const tallies = new Map<string, KeyTally>();
  for (const entry of entries) {
    let tally = tallies.get(entry.key);
    if (tally === undefined) {
      tally = { intents: 0, intentIso: null, nonAmbiguousResults: 0, hasResult: false };
      tallies.set(entry.key, tally);
    }
    if (entry.kind === 'intent') {
      tally.intents += 1;
      if (tally.intentIso === null || entry.recordedAtIso < tally.intentIso) {
        tally.intentIso = entry.recordedAtIso;
      }
    }
    if (entry.kind === 'result') {
      tally.hasResult = true;
      if (entry.outcome !== 'ambiguous') {
        tally.nonAmbiguousResults += 1;
      }
    }
  }
  return tallies;
}


/**
 * S9, conductor state integrity, over `{ stateCheck, journal, sampledAtIso }`.
 * Cost: linear in the capped input — at most `SHADOW_MAX_HEALTH_ITEMS`
 * journal entries are walked, and an oversized, sparse or non-dense `journal`
 * array is refused from its own `length` before any entry is traversed.
 * Every value is read through its own property descriptor, so no getter ever
 * runs and a Proxy stand-in either is refused or yields exactly the plain
 * data's verdict. Never throws, never echoes the input.
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
  if (snapshot.stateCheck !== null && readExactPlainRecord(snapshot.stateCheck, ['checked', 'bad']) === null) {
    return UNKNOWN('invalid-input');
  }
  const stateCheck = snapshot.stateCheck as { checked?: unknown; bad?: unknown } | null;
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
  for (let index = 0; index < journal.length; index += 1) {
    const entry = readSampledEntry(ownElement(journal, index));
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

/** The S9 journal rules, over already-validated entries. */
function judgeJournalIntegrity(entries: readonly SampledJournalEntry[], sampledAtIso: string): ShadowCriterionEvaluation {
  const tallies = tallyJournal(entries);
  for (const tally of tallies.values()) {
    if (tally.intents > 1) {
      return FAIL('journal-duplicate-intent');
    }
    if (tally.nonAmbiguousResults > 1) {
      return FAIL('journal-duplicate-result');
    }
    if (tally.hasResult && tally.intents === 0) {
      return FAIL('journal-orphan-result');
    }
  }
  for (const tally of tallies.values()) {
    if (tally.intents === 0 || tally.nonAmbiguousResults > 0 || tally.intentIso === null) {
      continue;
    }
    if (new Date(sampledAtIso).getTime() - new Date(tally.intentIso).getTime() > SHADOW_OPEN_INTENT_GRACE_MS) {
      return FAIL('unreconciled-intent');
    }
  }
  return PASS('state-consistent');
}
