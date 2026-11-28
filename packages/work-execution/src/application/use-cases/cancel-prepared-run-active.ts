import { laneRunJournalState } from '../../domain/lane-run-journal.js';
import { findInheritedPropertyDescriptor } from '../../domain/plain-record-reads.js';
import { LANE_RUN_TERMINAL_STATES, type LaneRunStateValue } from '../../domain/value-objects/LaneRunState.vo.js';
import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import type { LaneRunJournalEntryRecord } from '../../domain/lane-run-journal.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';

/** Cost bound: `runRepo.list()` may not return more runs than this. */
export const MAX_LIVE_RUN_SCAN_RUNS = 10_000;

/** Cost bound: one run's `attemptIds` may not hold more ids than this. */
export const MAX_RUN_ATTEMPT_IDS = 1_000;

/** Cost bound: one run's journal may not hold more entries than this. */
export const MAX_LIVE_RUN_JOURNAL_ENTRIES = 100_000;

/** Cost bound: how many prototype links are walked looking for an accessor on a port. */
const MAX_PROTOTYPE_DEPTH = 16;

/** Keys that must never be accepted as an identifier or looked up dynamically. */
const POLLUTING_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isPollutingKey(value: string): boolean {
  // Set.has, never a dynamic property lookup.
  return POLLUTING_KEYS.has(value);
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (isPollutingKey(value)) {
    throw new TypeError(`${label} is a prototype-polluting key`);
  }
  return value;
}

/**
 * A real, dense, getter-free array within its cost bound. Array-likes,
 * sparse arrays, element getters (never invoked — read only through
 * `Object.getOwnPropertyDescriptor`) and oversized lengths are refused.
 */
function requirePlainArray(value: unknown, label: string, max: number): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  if (value.length > max) {
    throw new RangeError(`${label} length ${value.length} exceeds the bound ${max}`);
  }
  for (let index = 0; index < value.length; index++) {
    // Only an OWN data slot counts: a hole (even one an inherited `Array.prototype`
    // index would fill) or an accessor is refused, and nothing is ever invoked.
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined) {
      throw new TypeError(`${label} has a hole at index ${index}`);
    }
    if (!('value' in descriptor)) {
      throw new TypeError(`${label} has a getter at index ${index}`);
    }
  }
  return value;
}

/**
 * Reads a port's method without running a getter: walks the prototype chain
 * (bounded) through descriptors and refuses an accessor or a missing function.
 */
function requireMethod(port: unknown, name: string, label: string): (...args: never[]) => unknown {
  if (port === null || typeof port !== 'object') {
    throw new TypeError(`${label} must be an object with a ${name} function`);
  }
  const found = findInheritedPropertyDescriptor(port, name, MAX_PROTOTYPE_DEPTH);
  if (found !== undefined) {
    if (!('value' in found.descriptor) || typeof found.descriptor.value !== 'function') {
      throw new TypeError(`${label} must have a plain ${name} function, not an accessor`);
    }
    return found.descriptor.value as (...args: never[]) => unknown;
  }
  throw new TypeError(`${label} must be an object with a ${name} function`);
}

/**
 * A journal entry copied to a prototype-less record of its own data
 * properties: an own accessor is refused (never run), and an inherited getter
 * cannot exist on the copy, so `laneRunJournalState` only ever reads plain
 * data. Cost bound: O(own keys) per entry, entries bounded by the journal bound.
 */
function copyJournalEntry(value: unknown): LaneRunJournalEntryRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('a journal entry must be a non-array object');
  }
  const copy = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) {
      throw new TypeError('a journal entry must not carry accessor properties');
    }
    if (isPollutingKey(key)) {
      throw new TypeError('a journal entry must not carry a prototype-polluting key');
    }
    copy[key] = descriptor.value;
  }
  return copy as unknown as LaneRunJournalEntryRecord;
}

/** One run record: a plain object with own, getter-free, valid `runId` and `attemptIds`. */
function requireRunRecord(value: unknown): LaneRunRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('a run entry must be a non-array object');
  }
  const record = value as { readonly runId?: unknown; readonly attemptIds?: unknown };
  for (const field of ['runId', 'attemptIds'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(record, field);
    if (descriptor === undefined || descriptor.get !== undefined) {
      throw new TypeError(`a run entry must have an own, getter-free '${field}' property`);
    }
  }
  const runId = requireIdentifier(record.runId, 'a run entry runId');
  const attemptIdsRaw = requirePlainArray(record.attemptIds, 'a run entry attemptIds', MAX_RUN_ATTEMPT_IDS);
  const attemptIds: string[] = [];
  for (let index = 0; index < attemptIdsRaw.length; index++) {
    attemptIds.push(requireIdentifier(attemptIdsRaw[index], 'a run entry attemptIds element'));
  }
  return { runId, attemptIds } as unknown as LaneRunRecord;
}

/**
 * The run-active refusal shared by `attempt cancel-prepared` (CLI) and the
 * API's cancel-prepared guard (EX-1a): scan every run that lists the attempt
 * and report the FIRST one whose journal state is not terminal. `null` means
 * no live run owns the attempt. Every read rejection propagates (fail-closed),
 * and hostile shapes are refused with a typed error, never passed.
 */
export async function findLiveRunForAttempt(
  runRepo: Pick<LaneRunRepositoryPort, 'list'>,
  runJournal: Pick<LaneRunJournalPort, 'listForRun'>,
  attemptId: string,
): Promise<{ runId: string } | null> {
  const list = requireMethod(runRepo, 'list', 'runRepo') as () => Promise<unknown>;
  const listForRun = requireMethod(runJournal, 'listForRun', 'runJournal') as (runId: string) => Promise<unknown>;
  requireIdentifier(attemptId, 'attemptId');

  // A rejected read propagates its exact error: a failed scan is never a clean null.
  const runs = requirePlainArray(
    await list.call(runRepo),
    'runRepo.list() result',
    MAX_LIVE_RUN_SCAN_RUNS,
  );
  // Indexed, never `for...of`: an own `Symbol.iterator` on the array is not consulted.
  for (let runIndex = 0; runIndex < runs.length; runIndex++) {
    const run = requireRunRecord(runs[runIndex]);
    if (!run.attemptIds.includes(attemptId)) {
      continue;
    }
    const entries = requirePlainArray(
      await listForRun.call(runJournal, run.runId),
      'runJournal.listForRun() result',
      MAX_LIVE_RUN_JOURNAL_ENTRIES,
    );
    const copied: LaneRunJournalEntryRecord[] = [];
    for (let index = 0; index < entries.length; index++) {
      copied.push(copyJournalEntry(entries[index]));
    }
    const state: LaneRunStateValue = laneRunJournalState(copied, run.runId);
    if (!(LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state)) {
      // Any non-terminal (or unknown) state is live: report the first such run.
      return { runId: run.runId };
    }
  }
  return null;
}
