/**
 * SH18b: the application-layer reader of the conducted gate-head facts S4'
 * (SH11) evaluates. `readShadowGateHeads` assembles every conducted head that
 * reached the pull request (an `open-pr` or `push` step completed) in the
 * trailing three UTC days, with the conductor's gate verdict at that head and
 * the forge's `gate` context at the same commit, so the day-writer only has
 * to call it. Read-only and fail-closed: any unreadable source, missing
 * attempt, unresolved head or over-cap input makes the whole answer `unknown`
 * with a code — never a shorter list, never a partial `ok`. The request and
 * every nested object are read through their own property descriptors (no
 * getter runs, no Proxy `get` trap runs); no path, error message or free text
 * is echoed.
 */

import type {
  LaneRunRepositoryPort,
} from '../../ports/out/LaneRunRepositoryPort.out-port.js';
import type {
  LaneRunJournalPort,
} from '../../ports/out/LaneRunJournalPort.out-port.js';
import type {
  AttemptRepositoryPort,
} from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type {
  ForgeReadPort,
  ForgeRepositoryRef,
} from '../../ports/out/ForgeReadPort.out-port.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type {
  LaneRunJournalEntryKind,
  LaneRunJournalEntryRecord,
} from '../../../domain/lane-run-journal.js';
import {
  LANE_RUN_JOURNAL_ENTRY_KINDS,
} from '../../../domain/lane-run-journal.js';
import {
  SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN,
} from '../../../domain/shadow-day-conformance.js';
import type {
  ShadowGateCiState,
  ShadowGateHeadFact,
} from '../../../domain/shadow-day-gate-agreement.js';
import {
  SHADOW_GATE_CONTEXT,
  SHADOW_GATE_MAX_HEADS,
} from '../../../domain/shadow-day-gate-agreement.js';
import { isZonedIsoDateTime } from '../../../domain/conductor-halt.js';
import { readExactPlainRecord } from '../../../domain/plain-record-reads.js';
import { head12Of, parseLaneRunKey } from '../../../domain/lane-run-keys.js';
import { isValidRepositoryRef } from '../ImportTrainStateUseCase.use-case.js';
import {
  SHADOW_FACTS_MAX_ATTEMPTS_PER_RUN,
  SHADOW_FACTS_MAX_RUNS,
  FactsRefusal,
  isPastDeadline,
  readOrRefuse,
  type ShadowConductedFactsUnknown,
} from './conducted-facts.js';

/** The read-only dependencies the conducted gate heads need. */
export interface ShadowGateHeadsDependencies {
  readonly runs: Pick<LaneRunRepositoryPort, 'list'>;
  readonly journal: Pick<LaneRunJournalPort, 'listForRun' | 'listForRuns'>;
  readonly attempts: Pick<AttemptRepositoryPort, 'findAttemptById'>;
  readonly forge: Pick<ForgeReadPort, 'readCommitContext'>;
  readonly nowIso: () => string;
}

/** The day, the one forge repository every conducted run belongs to, and the read's deadline. */
export interface ShadowGateHeadsRequest {
  readonly day: string;
  readonly repository: ForgeRepositoryRef;
  readonly deadlineIso: string;
}

/** Every conducted gate head, or one named refusal for the whole answer. */
export type ShadowGateHeadsResult =
  | { readonly status: 'ok'; readonly heads: readonly ShadowGateHeadFact[] }
  | { readonly status: 'unknown'; readonly reason: ShadowConductedFactsUnknown };

const REQUEST_KEYS: readonly string[] = ['day', 'repository', 'deadlineIso'];
const REPOSITORY_KEYS: readonly string[] = ['owner', 'repo'];
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** The journal steps that record a head reaching the pull request. */
const PUSHED_STEPS: readonly string[] = ['open-pr', 'push'];
/** The six CI check states the forge read may report (SH11's declaration). */
const CI_STATES: readonly string[] = ['success', 'failure', 'pending', 'missing', 'other', 'ambiguous'];
const DAY_MS = 24 * 60 * 60 * 1000;
/** The journal's entry kinds, as unknowns for hostile-input membership checks. */
const JOURNAL_ENTRY_KINDS: readonly unknown[] = LANE_RUN_JOURNAL_ENTRY_KINDS;

/** Refuse with `reason`; always throws, so the caller's flow stops here. */
function refuse(reason: ShadowConductedFactsUnknown): never {
  throw new FactsRefusal(reason);
}

const refused = (reason: ShadowConductedFactsUnknown): ShadowGateHeadsResult => ({
  status: 'unknown',
  reason,
});

/**
 * One field of a store record (a run, a journal entry, an attempt, a forge
 * result, or one of their arrays) through its own property descriptor: only
 * an own data property is returned. An accessor-backed field, a missing own
 * key, or a record whose descriptors cannot be read (e.g. a revoked Proxy)
 * refuses with `reason` — the getter never runs. Cost: O(1).
 */
function readStoreField<R extends ShadowConductedFactsUnknown>(
  reason: R,
  record: unknown,
  key: string,
): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    // A primitive source has no own properties and null or undefined throws:
    // both refuse, so only a real record's data property is ever returned.
    descriptor = Reflect.getOwnPropertyDescriptor(record as object, key);
  } catch {
    refuse(reason);
  }
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
    refuse(reason);
  }
  return descriptor?.value;
}

/** Whether `kind` is one of the journal's entry kinds. Cost: O(1). */
function isJournalEntryKind(kind: unknown): kind is LaneRunJournalEntryKind {
  return JOURNAL_ENTRY_KINDS.includes(kind);
}

/**
 * The day's window start (D 00:00:00Z as epoch ms), or null when `day` is not
 * a `YYYY-MM-DD` UTC calendar date with a year in 2000-9999. Cost: O(1).
 */
function dayWindowStartUtcMs(day: unknown): number | null {
  if (typeof day !== 'string' || !DAY_PATTERN.test(day)) {
    return null;
  }
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  if (year < 2000 || month < 1 || month > 12 || date < 1 || date > 31) {
    return null;
  }
  const start = Date.UTC(year, month - 1, date);
  const roundTrip = new Date(start);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== date
  ) {
    return null;
  }
  return start;
}

/** One pushed head: its short id and the earliest push time inside the window. */
interface PushedHead {
  readonly head12: string;
  readonly pushedAtIso: string;
  readonly pushedAtMs: number;
}

/**
 * One journal entry as a pushed head, or null when the entry is not a
 * `result` record of a completed `open-pr` or `push` step recorded inside
 * `[start, end)`. An entry of another valid kind is not a pushed head; a
 * malformed record (an unknown kind, an unreadable field) is a refusal, not
 * a silent skip. Every field is read through its own data-property
 * descriptor, so no getter runs. Cost: O(1).
 */
function pushedHeadOf(
  entry: LaneRunJournalEntryRecord,
  windowStartMs: number,
  windowEndMs: number,
): PushedHead | null {
  const kind = readStoreField('journal-unreadable', entry, 'kind');
  if (!isJournalEntryKind(kind)) {
    refuse('journal-unreadable');
  }
  if (kind !== 'result') {
    return null;
  }
  const key = readStoreField('journal-unreadable', entry, 'key');
  const parsed = readOrRefuse('journal-unreadable', () => parseLaneRunKey(key));
  if (
    parsed === null ||
    parsed.kind !== 'step' ||
    !PUSHED_STEPS.includes(parsed.step) ||
    parsed.head12 === null
  ) {
    return null;
  }
  const outcome = readStoreField('journal-unreadable', entry, 'outcome');
  if (outcome !== 'completed') {
    return null;
  }
  const recordedAtIso = readStoreField('journal-unreadable', entry, 'recordedAtIso');
  const atMs = Date.parse(recordedAtIso as string);
  if (Number.isNaN(atMs) || atMs < windowStartMs || atMs >= windowEndMs) {
    return null;
  }
  return { head12: parsed.head12, pushedAtIso: recordedAtIso as string, pushedAtMs: atMs };
}

/**
 * The conductor's verdict at one `head12`: the last (append order) `result`
 * entry with parsed step `gate`, the same `head12`, outcome `completed` and
 * reason code `gate-passed` (pass) or `gate-failed` (fail); every other
 * record at that head — other kinds, `gate-congested` and non-final results
 * — is ignored. A malformed record is a refusal, not a silent skip. No
 * verdict is null. Cost: linear in the capped entries.
 */
function verdictOf(
  entries: readonly LaneRunJournalEntryRecord[],
  head12: string,
): 'pass' | 'fail' | null {
  let verdict: 'pass' | 'fail' | null = null;
  for (const entry of entries) {
    const kind = readStoreField('journal-unreadable', entry, 'kind');
    if (!isJournalEntryKind(kind)) {
      refuse('journal-unreadable');
    }
    if (kind !== 'result') {
      continue;
    }
    const key = readStoreField('journal-unreadable', entry, 'key');
    const parsed = readOrRefuse('journal-unreadable', () => parseLaneRunKey(key));
    if (parsed === null || parsed.kind !== 'step' || parsed.step !== 'gate' || parsed.head12 !== head12) {
      continue;
    }
    if (readStoreField('journal-unreadable', entry, 'outcome') !== 'completed') {
      continue;
    }
    const reasonCode = readStoreField('journal-unreadable', entry, 'reasonCode');
    if (reasonCode === 'gate-passed') {
      verdict = 'pass';
    } else if (reasonCode === 'gate-failed') {
      verdict = 'fail';
    }
  }
  return verdict;
}

/**
 * Every requested run's journal in one call through `listForRuns` when the
 * port carries it, else one `listForRun` per run. A throw, a non-`Map`, a
 * missing requested id, a non-array entry list or a past deadline refuses
 * the whole answer — never a defaulted empty list. Cost: linear in the
 * capped runs; the cap (`SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN`) is checked
 * by the caller per run.
 */
async function readRunJournals(
  journal: Pick<LaneRunJournalPort, 'listForRun' | 'listForRuns'>,
  runIds: readonly string[],
  isPast: () => boolean,
): Promise<ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>> {
  const listForRuns = readOrRefuse('journal-unreadable', () => journal.listForRuns);
  if (listForRuns !== undefined) {
    if (isPast()) {
      refuse('deadline-exceeded');
    }
    let grouped: unknown;
    try {
      grouped = await listForRuns.call(journal, runIds);
    } catch {
      refuse('journal-unreadable');
    }
    if (!(grouped instanceof Map)) {
      refuse('journal-unreadable');
    }
    const map = grouped as Map<unknown, unknown>;
    readOrRefuse('journal-unreadable', () => {
      for (const runId of runIds) {
        if (!map.has(runId)) {
          refuse('journal-unreadable');
        }
      }
      for (const entries of map.values()) {
        if (!Array.isArray(entries)) {
          refuse('journal-unreadable');
        }
      }
    });
    return map as ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>;
  }
  const byRunId = new Map<string, readonly LaneRunJournalEntryRecord[]>();
  for (const runId of runIds) {
    if (isPast()) {
      refuse('deadline-exceeded');
    }
    let entries: unknown;
    try {
      entries = await journal.listForRun(runId);
    } catch {
      refuse('journal-unreadable');
    }
    if (!Array.isArray(entries)) {
      refuse('journal-unreadable');
    }
    byRunId.set(runId, entries as readonly LaneRunJournalEntryRecord[]);
  }
  return byRunId;
}

/** One run and its already-read id, paired so no record field is read twice. */
interface RunWithId {
  readonly run: LaneRunRecord;
  readonly runId: string;
}

/** One run's verdicted heads: distinct `head12`s with a conductor verdict and their earliest push. */
interface RunHeads {
  readonly run: LaneRunRecord;
  readonly runId: string;
  readonly heads: ReadonlyMap<string, PushedHead>;
  readonly verdicts: ReadonlyMap<string, 'pass' | 'fail'>;
}

/**
 * Every run's id, each read through its own data-property descriptor; a
 * getter, a missing key or a non-string id refuses with `runs-unreadable`
 * and the getter never runs. Cost: linear in the capped runs.
 */
function runIdsOf(runRecords: readonly LaneRunRecord[]): readonly RunWithId[] {
  const pairs: RunWithId[] = [];
  for (const run of runRecords) {
    const runId = readStoreField('runs-unreadable', run, 'runId');
    if (typeof runId !== 'string') {
      refuse('runs-unreadable');
    }
    pairs.push({ run, runId });
  }
  return pairs;
}

/**
 * One run's journal entries as its verdicted heads. Cost: linear in the
 * capped entries.
 */
function runHeadsOf(
  run: LaneRunRecord,
  runId: string,
  entries: readonly LaneRunJournalEntryRecord[],
  windowStartMs: number,
  windowEndMs: number,
): RunHeads {
  const entryCount = readStoreField('journal-unreadable', entries, 'length');
  if (typeof entryCount !== 'number') {
    refuse('journal-unreadable');
  }
  if (entryCount > SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN) {
    refuse('too-many-journal-entries');
  }
  const heads = new Map<string, PushedHead>();
  // The journal-entry array is read once, each entry through its own
  // data-property descriptor, into a private array: a store-provided array is
  // never traversed with `for...of`, `.map` or spread, so no getter can run.
  // An accessor-backed or missing entry refuses — never a silent skip.
  const entryRecords: LaneRunJournalEntryRecord[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    const element = readStoreField('journal-unreadable', entries, String(index));
    if (element === undefined || element === null) {
      refuse('journal-unreadable');
    }
    entryRecords.push(element as LaneRunJournalEntryRecord);
  }
  for (const entry of entryRecords) {
    const pushed = pushedHeadOf(entry, windowStartMs, windowEndMs);
    if (pushed === null) {
      continue;
    }
    const earliest = heads.get(pushed.head12);
    if (earliest === undefined || pushed.pushedAtMs < earliest.pushedAtMs) {
      heads.set(pushed.head12, pushed);
    }
  }
  const verdicts = new Map<string, 'pass' | 'fail'>();
  for (const head12 of heads.keys()) {
    const verdict = verdictOf(entryRecords, head12);
    if (verdict !== null) {
      verdicts.set(head12, verdict);
    }
  }
  return { run, runId, heads, verdicts };
}

/**
 * The attempts of every run with at least one verdicted head, each id read
 * exactly once (a throw or `null` refuses — never skipped), collecting the
 * distinct full shas whose `head12` matches a verdicted head of that run.
 * Every field of the run and attempt records is read through its own
 * data-property descriptor. Cost: linear in the capped attempts; the cap
 * (`SHADOW_FACTS_MAX_ATTEMPTS_PER_RUN`) is a named constant.
 */
async function readHeadShas(
  attempts: Pick<AttemptRepositoryPort, 'findAttemptById'>,
  runsHeads: readonly RunHeads[],
  isPast: () => boolean,
): Promise<ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>> {
  const shasByRun = new Map<string, Map<string, string[]>>();
  for (const runHeads of runsHeads) {
    if (runHeads.verdicts.size === 0) {
      continue;
    }
    const attemptIds = readStoreField('runs-unreadable', runHeads.run, 'attemptIds');
    if (!Array.isArray(attemptIds)) {
      refuse('runs-unreadable');
    }
    const attemptCount = readStoreField('runs-unreadable', attemptIds, 'length');
    if (typeof attemptCount !== 'number') {
      refuse('runs-unreadable');
    }
    if (attemptCount > SHADOW_FACTS_MAX_ATTEMPTS_PER_RUN) {
      refuse('too-many-attempts');
    }
    const runShas = new Map<string, string[]>();
    for (const head12 of runHeads.verdicts.keys()) {
      runShas.set(head12, []);
    }
    for (let index = 0; index < attemptCount; index += 1) {
      const attemptId = readStoreField('runs-unreadable', attemptIds, String(index));
      if (typeof attemptId !== 'string') {
        refuse('runs-unreadable');
      }
      if (isPast()) {
        refuse('deadline-exceeded');
      }
      let read: Awaited<ReturnType<typeof attempts.findAttemptById>> | undefined;
      try {
        read = await attempts.findAttemptById(attemptId);
      } catch {
        refuse('attempt-unreadable');
      }
      if (read === undefined || read === null) {
        refuse('attempt-unreadable');
      }
      const attempt = read as NonNullable<typeof read>;
      const artifacts = readStoreField('attempt-unreadable', attempt, 'artifacts');
      if (artifacts === null) {
        continue;
      }
      const headCommit = readStoreField('attempt-unreadable', artifacts, 'headCommit');
      const matched = readOrRefuse('attempt-unreadable', () => head12Of(headCommit));
      if (matched === null) {
        continue;
      }
      const collected = runShas.get(matched);
      if (collected !== undefined && !collected.includes(headCommit as string)) {
        collected.push(headCommit as string);
      }
    }
    shasByRun.set(runHeads.runId, runShas);
  }
  return shasByRun;
}

/**
 * The forge's `gate` context state at one exact commit, read through
 * `readCommitContext` once per distinct full sha (the caller caches across
 * runs, so a state changing between two reads cannot create SH11's
 * `gate-facts-conflicting`). A non-object result, an unexpected outcome, a
 * mismatched `headSha`, an unknown state, `unavailable` or a throw is
 * `forge-unavailable`; `not-found` is the `missing` state. Every field of
 * the forge result is read through its own data-property descriptor. Cost:
 * O(1) per call.
 */
async function readCiGate(
  readCommitContext: NonNullable<Pick<ForgeReadPort, 'readCommitContext'>['readCommitContext']>,
  forge: Pick<ForgeReadPort, 'readCommitContext'>,
  headSha: string,
  repository: ForgeRepositoryRef,
  timeoutMs: number,
): Promise<ShadowGateCiState> {
  let result: unknown;
  try {
    result = await readCommitContext.call(forge, {
      headSha,
      contextName: SHADOW_GATE_CONTEXT,
      repository,
      timeoutMs,
    });
  } catch {
    refuse('forge-unavailable');
  }
  if (typeof result !== 'object' || result === null) {
    refuse('forge-unavailable');
  }
  const record = result as object;
  const outcome = readStoreField('forge-unavailable', record, 'outcome');
  if (outcome === 'not-found') {
    return 'missing';
  }
  if (outcome !== 'found') {
    refuse('forge-unavailable');
  }
  const returnedSha = readStoreField('forge-unavailable', record, 'headSha');
  const state = readStoreField('forge-unavailable', record, 'state');
  if (returnedSha !== headSha || !(CI_STATES as readonly unknown[]).includes(state)) {
    refuse('forge-unavailable');
  }
  return state as ShadowGateCiState;
}

/**
 * Read the conducted gate heads for the trailing three UTC days of `day`:
 * every head that reached the pull request in `[D-2 00:00Z, D+1 00:00Z)`,
 * the conductor's verdict at that head, and the forge's `gate` context at
 * the same commit. The whole read runs inside the outer refusal catch, so
 * any throw from the request, from a value copied out of it, or from a run
 * record becomes the typed `unknown` result — never a rejection. Cost:
 * linear in the capped input; the caps (`SHADOW_FACTS_MAX_RUNS`,
 * `SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN`,
 * `SHADOW_FACTS_MAX_ATTEMPTS_PER_RUN`, `SHADOW_GATE_MAX_HEADS`) are named
 * constants.
 */
export async function readShadowGateHeads(
  deps: ShadowGateHeadsDependencies,
  request: unknown,
): Promise<ShadowGateHeadsResult> {
  try {
    return await readGateHeadsOrRefuse(deps, request);
  } catch (error) {
    if (error instanceof FactsRefusal) {
      return refused(error.reason);
    }
    // Every unexpected error — e.g. a revoked Proxy from `runs.list()` whose
    // `Array.isArray` throws — becomes the documented typed `unknown` result,
    // never a rejection. The code names an unreadable source.
    return refused('runs-unreadable');
  }
}

/** The request's validated parts: repository, window and deadline. */
interface ParsedRequest {
  readonly repoRef: ForgeRepositoryRef;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly windowStartMsPast: number;
  readonly deadlineIso: string;
}

/**
 * Validate the request through its own data-property descriptors only (no
 * getter runs, no Proxy `get` trap runs): the repository is snapshotted
 * before any validation, never destructured, the day must be a real
 * `YYYY-MM-DD` UTC calendar date with a year in 2000-9999, and the deadline
 * a zoned ISO time. Cost: O(1).
 */
function readRequestOrRefuse(request: unknown): ParsedRequest {
  const snapshotRead = readOrRefuse('invalid-request', () => readExactPlainRecord(request, REQUEST_KEYS));
  if (snapshotRead === null) {
    refuse('invalid-request');
  }
  const snapshot: Record<string, unknown> = snapshotRead as Record<string, unknown>;
  const repositoryRead = readOrRefuse('invalid-request', () =>
    readExactPlainRecord(snapshot.repository, REPOSITORY_KEYS),
  );
  if (repositoryRead === null || !isValidRepositoryRef(repositoryRead)) {
    refuse('invalid-request');
  }
  const repoRef = repositoryRead as unknown as ForgeRepositoryRef;
  const windowStartMsRead = dayWindowStartUtcMs(snapshot.day);
  if (windowStartMsRead === null) {
    refuse('invalid-request');
  }
  const windowStartMs: number = windowStartMsRead;
  const deadlineRead = readOrRefuse('invalid-request', () => snapshot.deadlineIso);
  if (typeof deadlineRead !== 'string' || !isZonedIsoDateTime(deadlineRead)) {
    refuse('invalid-request');
  }
  const windowEndMs = windowStartMs + DAY_MS;
  return {
    repoRef,
    windowStartMs,
    windowEndMs,
    windowStartMsPast: windowStartMs - 2 * DAY_MS,
    deadlineIso: deadlineRead,
  };
}

/**
 * The stored runs, read through the runs port: a throw, a non-array or a
 * revoked Proxy refuses with `runs-unreadable`; more than
 * `SHADOW_FACTS_MAX_RUNS` refuses with `too-many-runs`; a past deadline
 * refuses before anything downstream. Cost: O(1) plus the port's own cost.
 */
async function readRunRecordsOrRefuse(
  runs: Pick<LaneRunRepositoryPort, 'list'>,
  isPast: () => boolean,
): Promise<readonly LaneRunRecord[]> {
  let listed: readonly LaneRunRecord[];
  try {
    listed = await runs.list();
  } catch {
    refuse('runs-unreadable');
  }
  if (!Array.isArray(listed)) {
    refuse('runs-unreadable');
  }
  const runRecords: readonly LaneRunRecord[] = listed;
  const runCount = readStoreField('runs-unreadable', runRecords, 'length');
  if (typeof runCount !== 'number') {
    refuse('runs-unreadable');
  }
  if (runCount > SHADOW_FACTS_MAX_RUNS) {
    refuse('too-many-runs');
  }
  if (isPast()) {
    refuse('deadline-exceeded');
  }
  // The stored runs are read once, each element through its own data-property
  // descriptor, into a private array: a store-provided array is never
  // traversed with `for...of`, `.map` or spread, so no getter can run. An
  // accessor-backed or missing element refuses — never a silent skip.
  const runList: LaneRunRecord[] = [];
  for (let index = 0; index < runCount; index += 1) {
    const element = readStoreField('runs-unreadable', runRecords, String(index));
    if (element === undefined || element === null) {
      refuse('runs-unreadable');
    }
    runList.push(element as LaneRunRecord);
  }
  return runList;
}

/**
 * The assembled, verdicted heads across all runs: per run the journal is
 * capped and read, its pushed heads deduped by `head12` with the earliest
 * push, its verdicts resolved, and each attempt read exactly once to resolve
 * every verdicted `head12` to exactly one full sha. More than
 * `SHADOW_GATE_MAX_HEADS` heads refuses. Cost: linear in the capped runs,
 * entries and attempts.
 */
async function assembleHeadsOrRefuse(
  deps: ShadowGateHeadsDependencies,
  parsed: ParsedRequest,
  isPast: () => boolean,
): Promise<readonly { readonly head12: string; readonly headOid: string; readonly verdict: 'pass' | 'fail'; readonly pushed: PushedHead }[]> {
  const runRecords = await readRunRecordsOrRefuse(deps.runs, isPast);
  const runsWithIds = runIdsOf(runRecords);
  const journals = await readRunJournals(
    readOrRefuse('journal-unreadable', () => deps.journal),
    runsWithIds.map((pair) => pair.runId),
    isPast,
  );
  const runsHeads: RunHeads[] = [];
  for (const pair of runsWithIds) {
    const entriesRead = readOrRefuse('journal-unreadable', () => journals.get(pair.runId));
    if (entriesRead === undefined) {
      refuse('journal-unreadable');
    }
    runsHeads.push(
      runHeadsOf(pair.run, pair.runId, entriesRead as readonly LaneRunJournalEntryRecord[], parsed.windowStartMsPast, parsed.windowEndMs),
    );
  }
  const shasByRun = await readHeadShas(readOrRefuse('attempt-unreadable', () => deps.attempts), runsHeads, isPast);
  const heads: { readonly head12: string; readonly headOid: string; readonly verdict: 'pass' | 'fail'; readonly pushed: PushedHead }[] = [];
  for (const runHeads of runsHeads) {
    for (const [head12, verdict] of runHeads.verdicts) {
      const runShasRead = readOrRefuse('attempt-unreadable', () => shasByRun.get(runHeads.runId));
      if (runShasRead === undefined) {
        refuse('attempt-unreadable');
      }
      const runShas = runShasRead as ReadonlyMap<string, readonly string[]>;
      const shasRead = readOrRefuse('attempt-unreadable', () => runShas.get(head12));
      if (shasRead === undefined || shasRead.length !== 1) {
        refuse('head-unresolved');
      }
      heads.push({ head12, headOid: shasRead[0]!, verdict, pushed: runHeads.heads.get(head12)! });
    }
  }
  if (heads.length > SHADOW_GATE_MAX_HEADS) {
    refuse('too-many-heads');
  }
  return heads;
}

/**
 * The forge `gate` context per distinct full sha (cached within the call),
 * and the sorted `ShadowGateHeadFact` list. Cost: linear in the capped
 * heads, one forge call per distinct sha.
 */
async function readForgeFactsOrRefuse(
  deps: ShadowGateHeadsDependencies,
  heads: readonly { readonly headOid: string; readonly verdict: 'pass' | 'fail'; readonly pushed: PushedHead }[],
  parsed: ParsedRequest,
  isPast: () => boolean,
): Promise<ShadowGateHeadsResult> {
  const readCommitContext = deps.forge.readCommitContext;
  if (readCommitContext === undefined) {
    refuse('forge-read-missing');
  }
  const ciBySha = new Map<string, ShadowGateCiState>();
  const facts: ShadowGateHeadFact[] = [];
  for (const head of heads) {
    let ciGate = ciBySha.get(head.headOid);
    if (ciGate === undefined) {
      if (isPast()) {
        refuse('deadline-exceeded');
      }
      const now = readOrRefuse('deadline-exceeded', () => deps.nowIso());
      if (!isZonedIsoDateTime(now)) {
        refuse('deadline-exceeded');
      }
      const timeoutMs = Date.parse(parsed.deadlineIso) - Date.parse(now);
      if (timeoutMs <= 0) {
        refuse('deadline-exceeded');
      }
      ciGate = await readCiGate(readCommitContext, deps.forge, head.headOid, parsed.repoRef, timeoutMs);
      ciBySha.set(head.headOid, ciGate);
    }
    facts.push({
      headOid: head.headOid,
      conductorVerdict: head.verdict,
      pushedAtIso: head.pushed.pushedAtIso,
      ciGate,
    });
  }
  facts.sort((a, b) => {
    if (a.pushedAtIso !== b.pushedAtIso) {
      return a.pushedAtIso < b.pushedAtIso ? -1 : 1;
    }
    return a.headOid < b.headOid ? -1 : a.headOid > b.headOid ? 1 : 0;
  });
  return { status: 'ok', heads: facts };
}

/** The interior read: every `unknown` outcome is a `FactsRefusal`. */
async function readGateHeadsOrRefuse(
  deps: ShadowGateHeadsDependencies,
  request: unknown,
): Promise<ShadowGateHeadsResult> {
  const parsed = readRequestOrRefuse(request);
  const isPast = (): boolean => isPastDeadline(readOrRefuse('deadline-exceeded', () => deps.nowIso), parsed.deadlineIso);
  if (isPast()) {
    refuse('deadline-exceeded');
  }
  const heads = await assembleHeadsOrRefuse(deps, parsed, isPast);
  return await readForgeFactsOrRefuse(deps, heads, parsed, isPast);
}
