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
  LaneRunJournalEntryRecord,
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

/** Refuse with `reason`; always throws, so the caller's flow stops here. */
function refuse(reason: ShadowConductedFactsUnknown): never {
  throw new FactsRefusal(reason);
}

const refused = (reason: ShadowConductedFactsUnknown): ShadowGateHeadsResult => ({
  status: 'unknown',
  reason,
});

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
 * completed `open-pr` or `push` step result recorded inside `[start, end)`.
 * An unparseable or unparseable-time entry is not a pushed head. Cost: O(1).
 */
function pushedHeadOf(
  entry: LaneRunJournalEntryRecord,
  windowStartMs: number,
  windowEndMs: number,
): PushedHead | null {
  const parsed = readOrRefuse('journal-unreadable', () => parseLaneRunKey(entry.key));
  if (
    parsed === null ||
    parsed.kind !== 'step' ||
    !PUSHED_STEPS.includes(parsed.step) ||
    parsed.head12 === null
  ) {
    return null;
  }
  const outcome = readOrRefuse('journal-unreadable', () => entry.outcome);
  if (outcome !== 'completed') {
    return null;
  }
  const recordedAtIso = readOrRefuse('journal-unreadable', () => entry.recordedAtIso);
  const atMs = Date.parse(recordedAtIso);
  if (Number.isNaN(atMs) || atMs < windowStartMs || atMs >= windowEndMs) {
    return null;
  }
  return { head12: parsed.head12, pushedAtIso: recordedAtIso, pushedAtMs: atMs };
}

/**
 * The conductor's verdict at one `head12`: the last (append order) result
 * entry with parsed step `gate`, the same `head12`, outcome `completed` and
 * reason code `gate-passed` (pass) or `gate-failed` (fail); every other
 * result at that head — `gate-congested` and non-final ones — is ignored.
 * No verdict is null. Cost: linear in the capped entries.
 */
function verdictOf(
  entries: readonly LaneRunJournalEntryRecord[],
  head12: string,
): 'pass' | 'fail' | null {
  let verdict: 'pass' | 'fail' | null = null;
  for (const entry of entries) {
    const parsed = readOrRefuse('journal-unreadable', () => parseLaneRunKey(entry.key));
    if (parsed === null || parsed.kind !== 'step' || parsed.step !== 'gate' || parsed.head12 !== head12) {
      continue;
    }
    if (readOrRefuse('journal-unreadable', () => entry.outcome) !== 'completed') {
      continue;
    }
    const reasonCode = readOrRefuse('journal-unreadable', () => entry.reasonCode);
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

/** One run's verdicted heads: distinct `head12`s with a conductor verdict and their earliest push. */
interface RunHeads {
  readonly run: LaneRunRecord;
  readonly runId: string;
  readonly heads: ReadonlyMap<string, PushedHead>;
  readonly verdicts: ReadonlyMap<string, 'pass' | 'fail'>;
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
  const entryCount = readOrRefuse('journal-unreadable', () => entries.length);
  if (entryCount > SHADOW_CONFORMANCE_MAX_ENTRIES_PER_RUN) {
    refuse('too-many-journal-entries');
  }
  const heads = new Map<string, PushedHead>();
  for (const entry of entries) {
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
    const verdict = verdictOf(entries, head12);
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
 * Cost: linear in the capped attempts; the cap
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
    const attemptIds = readOrRefuse('runs-unreadable', () => runHeads.run.attemptIds);
    const attemptCount = readOrRefuse('runs-unreadable', () => attemptIds.length);
    if (attemptCount > SHADOW_FACTS_MAX_ATTEMPTS_PER_RUN) {
      refuse('too-many-attempts');
    }
    const runShas = new Map<string, string[]>();
    for (const head12 of runHeads.verdicts.keys()) {
      runShas.set(head12, []);
    }
    for (const attemptId of attemptIds) {
      if (isPast()) {
        refuse('deadline-exceeded');
      }
      let attempt: Awaited<ReturnType<typeof attempts.findAttemptById>>;
      try {
        attempt = await attempts.findAttemptById(attemptId);
      } catch {
        refuse('attempt-unreadable');
      }
      const headCommit = readOrRefuse('attempt-unreadable', () =>
        attempt === null || attempt.artifacts === null ? null : attempt.artifacts.headCommit,
      );
      if (attempt === null) {
        refuse('attempt-unreadable');
      }
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
 * `forge-unavailable`; `not-found` is the `missing` state. Cost: O(1) per
 * call.
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
  const record = result as Record<string, unknown>;
  const outcome = readOrRefuse('forge-unavailable', () => record.outcome);
  if (outcome === 'not-found') {
    return 'missing';
  }
  if (outcome !== 'found') {
    refuse('forge-unavailable');
  }
  const returnedSha = readOrRefuse('forge-unavailable', () => record.headSha);
  const state = readOrRefuse('forge-unavailable', () => record.state);
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

/** The interior read: every `unknown` outcome is a `FactsRefusal`. */
async function readGateHeadsOrRefuse(
  deps: ShadowGateHeadsDependencies,
  request: unknown,
): Promise<ShadowGateHeadsResult> {
  const snapshotRead = readOrRefuse('invalid-request', () => readExactPlainRecord(request, REQUEST_KEYS));
  if (snapshotRead === null) {
    refuse('invalid-request');
  }
  const snapshot: Record<string, unknown> = snapshotRead as Record<string, unknown>;
  // The repository is snapshotted through its own data-property descriptors
  // before any validation, never destructured: destructuring runs getters.
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
  const deadlineIso: string = deadlineRead;
  const windowEndMs = windowStartMs + DAY_MS;
  const windowStartMsPast = windowStartMs - 2 * DAY_MS;
  const isPast = (): boolean => isPastDeadline(readOrRefuse('deadline-exceeded', () => deps.nowIso), deadlineIso);
  if (isPast()) {
    refuse('deadline-exceeded');
  }

  let listed: readonly LaneRunRecord[];
  try {
    listed = await deps.runs.list();
  } catch {
    refuse('runs-unreadable');
  }
  if (!Array.isArray(listed)) {
    refuse('runs-unreadable');
  }
  const runRecords: readonly LaneRunRecord[] = listed;
  const runCount = readOrRefuse('runs-unreadable', () => runRecords.length);
  if (runCount > SHADOW_FACTS_MAX_RUNS) {
    refuse('too-many-runs');
  }
  if (isPast()) {
    refuse('deadline-exceeded');
  }

  const runIds = readOrRefuse('runs-unreadable', () => runRecords.map((run) => run.runId));
  const journals = await readRunJournals(readOrRefuse('journal-unreadable', () => deps.journal), runIds, isPast);
  const runsHeads: RunHeads[] = [];
  for (const run of runRecords) {
    const runId = readOrRefuse('runs-unreadable', () => run.runId);
    const entriesRead = readOrRefuse('journal-unreadable', () => journals.get(runId));
    if (entriesRead === undefined) {
      refuse('journal-unreadable');
    }
    runsHeads.push(runHeadsOf(run, runId, entriesRead as readonly LaneRunJournalEntryRecord[], windowStartMsPast, windowEndMs));
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
      const timeoutMs = Date.parse(deadlineIso) - Date.parse(now);
      if (timeoutMs <= 0) {
        refuse('deadline-exceeded');
      }
      ciGate = await readCiGate(
        readCommitContext,
        deps.forge,
        head.headOid,
        repoRef,
        timeoutMs,
      );
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
