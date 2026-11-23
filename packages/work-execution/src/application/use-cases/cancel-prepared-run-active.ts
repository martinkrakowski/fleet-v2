import { laneRunJournalState } from '../../domain/lane-run-journal.js';
import { LANE_RUN_TERMINAL_STATES, type LaneRunStateValue } from '../../domain/value-objects/LaneRunState.vo.js';
import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import type { LaneRunJournalEntryRecord } from '../../domain/lane-run-journal.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';

/** Cost bound: `runRepo.list()` may not return more runs than this. */
export const MAX_LIVE_RUN_SCAN_RUNS = 10_000;

/** Cost bound: one run's `attemptIds` may not hold more ids than this. */
export const MAX_RUN_ATTEMPT_IDS = 1_000;

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
    if (!(index in value)) {
      throw new TypeError(`${label} has a hole at index ${index}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor !== undefined && descriptor.get !== undefined) {
      throw new TypeError(`${label} has a getter at index ${index}`);
    }
  }
  return value;
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
  for (const attemptId of attemptIdsRaw) {
    attemptIds.push(requireIdentifier(attemptId, 'a run entry attemptIds element'));
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
  if (runRepo === null || typeof runRepo !== 'object' || typeof (runRepo as { list?: unknown }).list !== 'function') {
    throw new TypeError('runRepo must be an object with a list function');
  }
  if (runJournal === null || typeof runJournal !== 'object' || typeof (runJournal as { listForRun?: unknown }).listForRun !== 'function') {
    throw new TypeError('runJournal must be an object with a listForRun function');
  }
  requireIdentifier(attemptId, 'attemptId');

  // A rejected read propagates its exact error: a failed scan is never a clean null.
  const runs = requirePlainArray(
    await runRepo.list(),
    'runRepo.list() result',
    MAX_LIVE_RUN_SCAN_RUNS,
  );
  for (const entry of runs) {
    const run = requireRunRecord(entry);
    if (!run.attemptIds.includes(attemptId)) {
      continue;
    }
    const entries = requirePlainArray(
      await runJournal.listForRun(run.runId),
      'runJournal.listForRun() result',
      Number.MAX_SAFE_INTEGER,
    );
    const state: LaneRunStateValue = laneRunJournalState(entries as readonly LaneRunJournalEntryRecord[], run.runId);
    if (!(LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state)) {
      // Any non-terminal (or unknown) state is live: report the first such run.
      return { runId: run.runId };
    }
  }
  return null;
}
