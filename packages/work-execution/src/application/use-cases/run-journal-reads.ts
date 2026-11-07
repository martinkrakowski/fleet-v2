/**
 * Shared helper for scans that read several runs' journals (EX-3a): one grouped
 * read when the port offers `listForRuns`, otherwise the per-run `listForRun`
 * calls the older fakes implement. The returned map has every requested run id
 * as a key, each with that run's entries in append order (`[]` when none).
 *
 * The same module also hosts `LaneRunBoardReads` (lane A-R): the read-only
 * board, detail and keyed run-journal reads behind `GET /v1/runs`,
 * `GET /v1/runs/:id`, `GET /v1/runs/:id/journal` and
 * `GET /v1/runs/journal?key=`. Pure application code: every value scans the
 * legacy and canonical secret shapes and drops path-bearing identifiers before
 * it reaches the wire, every store read pass is budget-guarded so a hung read
 * resolves `unknown`/`store-unreadable` without touching disk, and no port in
 * its dependencies writes.
 */

import type { LaneRunJournalEntryRecord } from '../../domain/lane-run-journal.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import { LANE_RUN_ID_PATTERN, LANE_RUN_PARK_REASONS } from '../../domain/lane-run-records.js';
import type { LaneRunKeyStep, LaneRunParkReason, LaneRunTier } from '../../domain/lane-run-records.js';
import {
  LANE_RUN_JOURNAL_ENTRY_KINDS,
  LANE_RUN_JOURNAL_OUTCOMES,
  LANE_RUN_JOURNAL_REASON_CODE_PATTERN,
} from '../../domain/lane-run-journal.js';
import type { LaneRunJournalEntryKind, LaneRunJournalOutcome } from '../../domain/lane-run-journal.js';
import { laneRunJournalPendingIntent, laneRunJournalState, laneRunJournalStopFacts } from '../../domain/lane-run-journal.js';
import { parseLaneRunKey } from '../../domain/lane-run-keys.js';
import { LANE_RUN_STOP_KEY_MODES } from '../../domain/lane-run-keys.js';
import type { LaneRunStopKeyMode, ParsedLaneRunKey } from '../../domain/lane-run-keys.js';
import { LANE_RUN_STATES } from '../../domain/value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from '../../domain/value-objects/LaneRunState.vo.js';
import { isLeaseLapsed } from '../../domain/lane-run-lease.js';
import { resolveLaneRunBaseBranch } from '../../domain/base-branch.js';
import type { BaseBranchValue } from '../../domain/base-branch.js';
import type { AttemptRecord } from '../../domain/execution-records.js';
import type { RunStopMode } from '../../domain/lane-run-transitions.js';
import { deriveConductorSchedule, deriveSessionStartMarks } from '../../domain/conductor-schedule.js';
import type { ConductorSchedule, ConductorSessionStartMark } from '../../domain/conductor-schedule.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import type { ConductorHaltState } from '../../domain/conductor-halt.js';
import { readPlainRecordWithOptionalKeys } from '../../domain/plain-record-reads.js';
import { SECRET_PATTERNS, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { ConductorHaltPort } from '../ports/out/ConductorHaltPort.out-port.js';
import type { ConductorDriverLeasePort } from '../ports/out/ConductorDriverLeasePort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { ConductorPassTracePort } from '../ports/out/ConductorPassTracePort.out-port.js';
import type { ConductorPassTraceRead } from '../../domain/conductor-pass-trace.js';
import { LIST_LANE_RUNS_SESSION_MARK_LIMIT } from '../ports/in/ListLaneRunsPort.in-port.js';

export type RunJournalRunReads = Pick<LaneRunJournalPort, 'listForRun' | 'listForRuns'>;

/** The entries of several runs' journals from as few store reads as the port offers. */
export async function journalsForRuns(
  runJournal: RunJournalRunReads,
  runIds: readonly string[],
): Promise<ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>> {
  const { listForRuns } = runJournal;
  if (listForRuns) {
    return listForRuns.call(runJournal, runIds);
  }
  const lists = await Promise.all(runIds.map((runId) => runJournal.listForRun(runId)));
  return new Map(runIds.map((runId, index) => [runId, lists[index] ?? []]));
}

/** Bound on the run cards one board read returns. */
export const MAX_LANE_RUN_CARDS = 200;
/** Bound on the journal entries one detail/journal read returns. */
export const MAX_RUN_JOURNAL_ENTRIES = 200;
/** Bound on the dry-run `wouldAct` summaries one card carries. */
export const MAX_WOULD_ACT_PER_RUN = 20;
/** Bound on a keyed journal `key` query value. */
export const MAX_RUN_KEY_LENGTH = 256;
/** Default read budget for every store read pass. */
export const DEFAULT_LANE_RUN_READ_TIMEOUT_MS = 5_000;

/** True when any legacy or canonical secret shape matches `value`. */
export function hasAnySecretShape(value: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(value)) {
      return true;
    }
  }
  for (const entry of LANE_DIFF_SECRET_PATTERNS) {
    if (entry.regex.test(value)) {
      return true;
    }
  }
  return false;
}

/** A wire-safe identifier: a non-empty string without path separators, whitespace, controls or secret shapes. */
export function isSafeWireId(value: unknown, maxLen = 128): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLen) {
    return false;
  }
  if (value.includes('/') || value.includes('\\') || /[\s\0]/.test(value)) {
    return false;
  }
  return !hasAnySecretShape(value);
}

/** `value` when it is a safe wire id, else null. */
export function safeOrNull(value: unknown, maxLen = 128): string | null {
  return isSafeWireId(value, maxLen) ? value : null;
}

/** The marker a stored id or label that fails screening is replaced by; the value is never echoed. */
export const INVALID_WIRE_VALUE = '<invalid>';

/** The repo's stored-id grammar (see COMMIT_ATTEMPT_ID_PATTERN): no slash, no whitespace, no `@`. */
const WIRE_ID_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WIRE_LABEL_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/;

/** A stored id that matches the id grammar and no secret shape, else the fixed marker. */
function idOrInvalid(value: string): string {
  return WIRE_ID_GRAMMAR.test(value) && !hasAnySecretShape(value) ? value : INVALID_WIRE_VALUE;
}

function idOrNull(value: string | null): string | null {
  return value === null ? null : idOrInvalid(value);
}

/** A stored seat variant label that is neither path-shaped nor secret-shaped, else the fixed marker. */
function labelOrInvalid(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return WIRE_LABEL_GRAMMAR.test(value) && !hasAnySecretShape(value) ? value : INVALID_WIRE_VALUE;
}

/** How an unreadable or unknown-version store read answers. */
export type LaneRunUnknownReason = 'store-unreadable' | 'unknown-schema-version';

/** The seat of the latest recorded attempt per role. */
export interface LaneRunRoleSeatSummary {
  readonly seatId: string;
  readonly model: string;
  readonly tool: 'opencode' | 'agy';
  readonly seatIndex: number;
  readonly variant: string | null;
}

/** The wire key kinds a journal key projects to. */
export type LaneRunWireKeyKind = 'step' | 'stop' | 'resume' | 'request' | 'reaper' | 'merge';

/** One bounded dry-run `wouldAct` summary. */
export interface LaneRunWouldActSummary {
  readonly entryId: string;
  readonly keyKind: LaneRunWireKeyKind;
  readonly step: LaneRunKeyStep | null;
  readonly round: number | null;
  readonly recordedAtIso: string;
  readonly reasonCode: string | null;
  readonly detail: string | null;
}

/** The read-only board view of one lane run. */
export interface LaneRunWireCard {
  readonly runId: string;
  readonly workOrderId: string;
  readonly baseBranch: BaseBranchValue;
  readonly tier: LaneRunTier;
  readonly state: LaneRunStateValue;
  readonly round: number;
  readonly revision: number;
  readonly seatPlanRef: string;
  readonly cursors: { readonly 'first-pass': number | null; readonly fix: number | null; readonly review: number | null };
  readonly seatsByRole: {
    readonly 'first-pass': LaneRunRoleSeatSummary | null;
    readonly fix: LaneRunRoleSeatSummary | null;
    readonly review: LaneRunRoleSeatSummary | null;
  };
  readonly prNumber: number | null;
  readonly parked: {
    readonly reason: LaneRunParkReason;
    readonly qualifier: string | null;
    readonly parkedFrom: LaneRunStateValue;
    readonly questionId: string | null;
    readonly findingCount: number | null;
  } | null;
  readonly parkDetail: string | null;
  readonly parkCount: number;
  readonly stopMode: RunStopMode | null;
  readonly stopRequestedAtIso: string | null;
  readonly pendingIntent: { readonly step: LaneRunKeyStep; readonly reconciliation: 'unread' | 'ambiguous' } | null;
  readonly latestAttemptId: string | null;
  readonly attemptCount: number;
  readonly lease: {
    readonly holderId: string | null;
    readonly fence: number;
    readonly leaseUntilIso: string;
    readonly lapsed: boolean;
  } | null;
  readonly wouldAct: readonly LaneRunWouldActSummary[];
  readonly wouldActTruncated: boolean;
}

/** The wire view of one keyed run-journal entry. */
export interface LaneRunJournalWireEntry {
  readonly entryId: string;
  readonly kind: LaneRunJournalEntryKind;
  readonly key: string | null;
  readonly keyKind: LaneRunWireKeyKind | null;
  readonly step: LaneRunKeyStep | null;
  readonly runId: string | null;
  readonly recordedAtIso: string;
  readonly isWouldAct: boolean;
  readonly mode: LaneRunStopKeyMode | null;
  readonly expectedRevision: number | null;
  readonly mintedId: string | null;
  readonly outcome: LaneRunJournalOutcome | null;
  readonly reasonCode: string | null;
  readonly detail: string | null;
  readonly grantId: string | null;
  readonly state: LaneRunStateValue | null;
}

export interface LaneRunBoardReadsDependencies {
  readonly runRepo: Pick<LaneRunRepositoryPort, 'get' | 'list'>;
  readonly runJournal: Pick<LaneRunJournalPort, 'listForRun' | 'listForRuns' | 'listForKey'>;
  readonly halt: Pick<ConductorHaltPort, 'read'>;
  readonly driverLease: Pick<ConductorDriverLeasePort, 'read'>;
  readonly attemptRepo: Pick<AttemptRepositoryPort, 'findAttemptById' | 'listAllAttempts'>;
  readonly executionJournal: Pick<ExecutionJournalPort, 'listActiveReservations'>;
  readonly workOrderRepo: Pick<WorkOrderRepositoryPort, 'listWorkOrdersByProject'>;
  readonly passTrace?: Pick<ConductorPassTracePort, 'list'>;
  /** Read budget per store read pass; defaults to DEFAULT_LANE_RUN_READ_TIMEOUT_MS. */
  readonly readTimeoutMs?: number;
}

export type LaneRunBoardReadsResult =
  | {
      readonly outcome: 'listed';
      readonly schedule: ConductorSchedule;
      readonly sessionStarts: readonly ConductorSessionStartMark[];
      readonly truncated: boolean;
      readonly runs: readonly LaneRunWireCard[];
      readonly runsTruncated: boolean;
    }
  | { readonly outcome: 'rejected'; readonly reason: 'invalid-request' }
  | { readonly outcome: 'unknown'; readonly reason: LaneRunUnknownReason };

export type LaneRunReadResult =
  | {
      readonly outcome: 'listed';
      readonly halt: ConductorHaltState['state'];
      readonly driverLeaseLapsed: boolean | null;
      readonly run: LaneRunWireCard;
      readonly journal: readonly LaneRunJournalWireEntry[];
      readonly journalTruncated: boolean;
    }
  | { readonly outcome: 'not-found'; readonly runId: string }
  | { readonly outcome: 'rejected'; readonly reason: 'invalid-request' }
  | { readonly outcome: 'unknown'; readonly reason: LaneRunUnknownReason };

export type LaneRunJournalReadResult =
  | {
      readonly outcome: 'listed';
      readonly runId: string;
      readonly entries: readonly LaneRunJournalWireEntry[];
      readonly truncated: boolean;
    }
  | { readonly outcome: 'not-found'; readonly runId: string }
  | { readonly outcome: 'rejected'; readonly reason: 'invalid-request' }
  | { readonly outcome: 'unknown'; readonly reason: LaneRunUnknownReason };

export type LaneRunJournalKeyReadResult =
  | {
      readonly outcome: 'listed';
      readonly key: string;
      readonly keyKind: ParsedLaneRunKey['kind'];
      readonly entries: readonly LaneRunJournalWireEntry[];
      readonly truncated: boolean;
    }
  | { readonly outcome: 'rejected'; readonly reason: 'invalid-request' }
  | { readonly outcome: 'unknown'; readonly reason: LaneRunUnknownReason };

/** The tagged internal error a budget timeout rejects with. */
class RunReadTimeoutError extends Error {
  constructor() {
    super('run read timed out');
    this.name = 'RunReadTimeoutError';
  }
}

/** Wrap one store read pass with a deadline; the timer is always cleared. */
async function withReadBudget<T>(timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RunReadTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** How a store read failure answers: unknown-version stays distinct, everything else is unreadable. */
function mapReadError(error: unknown): { outcome: 'unknown'; reason: LaneRunUnknownReason } {
  if (error instanceof Error && error.name === 'StateFileUnknownVersionError') {
    return { outcome: 'unknown', reason: 'unknown-schema-version' };
  }
  return { outcome: 'unknown', reason: 'store-unreadable' };
}

/** Fail closed on a sparse array from a port. */
function assertDense<T>(arr: readonly T[]): void {
  for (let i = 0; i < arr.length; i += 1) {
    if (!(i in arr)) {
      throw new Error('sparse-array');
    }
  }
}

/** Strict decimal integer parse: a digit string or a safe integer in 1..max; undefined is max. */
const DECIMAL_INT_PATTERN = /^(?:0|[1-9][0-9]{0,5})$/;

function parseBoundedLimit(value: unknown, max: number): number | null {
  if (value === undefined) {
    return max;
  }
  let n: number;
  if (typeof value === 'string') {
    if (!DECIMAL_INT_PATTERN.test(value)) {
      return null;
    }
    n = Number(value);
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      return null;
    }
    n = value;
  } else {
    return null;
  }
  if (n < 1 || n > max) {
    return null;
  }
  return n;
}

/** The newest pass trace the schedule reads: undefined without a passTrace dep, null when the ring is empty. */
function latestTraceOf(
  traceList: Awaited<ReturnType<ConductorPassTracePort['list']>> | undefined,
): ConductorPassTraceRead | null | undefined {
  if (traceList === undefined) {
    return undefined;
  }
  if (traceList.outcome === 'listed') {
    const traces = traceList.traces;
    return traces.length >= 1 ? { ok: true, record: traces[traces.length - 1]! } : null;
  }
  return traceList.reason === 'unknown-schema-version'
    ? { ok: false, reason: 'unknown-schema-version' }
    : { ok: false, reason: 'malformed' };
}

function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Map a parsed key kind to the wire key kind; premerge and merge-enqueue are step keys. */
function wireKeyKindOf(parsed: ParsedLaneRunKey): LaneRunWireKeyKind {
  switch (parsed.kind) {
    case 'step':
    case 'premerge':
    case 'merge-enqueue':
      return 'step';
    case 'stop':
      return 'stop';
    case 'resume':
      return 'resume';
    case 'request':
      return 'request';
    case 'reaper':
      return 'reaper';
    case 'merge':
      return 'merge';
  }
}

/**
 * Project one stored journal entry to its wire view. Fails closed (throws) on
 * sparse, wrong-typed or unknown-enum slots and on secret-shaped key, entryId,
 * runId, reasonCode or detail.
 */
function projectJournalEntry(entry: LaneRunJournalEntryRecord): LaneRunJournalWireEntry {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error('malformed-journal-entry');
  }
  if (!LANE_RUN_JOURNAL_ENTRY_KINDS.includes(entry.kind as LaneRunJournalEntryKind)) {
    throw new Error('unknown-journal-kind');
  }
  if (typeof entry.entryId !== 'string' || hasAnySecretShape(entry.entryId)) {
    throw new Error('bad-entry-id');
  }
  if (entry.key !== null && typeof entry.key !== 'string') {
    throw new Error('bad-key');
  }
  if (typeof entry.key === 'string' && hasAnySecretShape(entry.key)) {
    throw new Error('secret-key');
  }
  if (entry.runId !== null && typeof entry.runId !== 'string') {
    throw new Error('bad-run-id');
  }
  if (typeof entry.runId === 'string' && hasAnySecretShape(entry.runId)) {
    throw new Error('secret-run-id');
  }
  if (typeof entry.recordedAtIso !== 'string') {
    throw new Error('bad-timestamp');
  }
  if (entry.mode !== null && !LANE_RUN_STOP_KEY_MODES.includes(entry.mode as LaneRunStopKeyMode)) {
    throw new Error('bad-mode');
  }
  if (entry.expectedRevision !== null && !Number.isSafeInteger(entry.expectedRevision)) {
    throw new Error('bad-revision');
  }
  if (entry.outcome !== null && !LANE_RUN_JOURNAL_OUTCOMES.includes(entry.outcome as LaneRunJournalOutcome)) {
    throw new Error('unknown-outcome');
  }
  if (entry.reasonCode !== null && typeof entry.reasonCode !== 'string') {
    throw new Error('bad-reason');
  }
  if (typeof entry.reasonCode === 'string' && hasAnySecretShape(entry.reasonCode)) {
    throw new Error('secret-reason');
  }
  if (entry.detail !== null && typeof entry.detail !== 'string') {
    throw new Error('bad-detail');
  }
  if (typeof entry.detail === 'string' && hasAnySecretShape(entry.detail)) {
    throw new Error('secret-detail');
  }
  if (entry.grantId !== null && typeof entry.grantId !== 'string') {
    throw new Error('bad-grant');
  }
  if (entry.state !== null && !LANE_RUN_STATES.includes(entry.state as LaneRunStateValue)) {
    throw new Error('unknown-state');
  }
  let keyKind: LaneRunWireKeyKind | null = null;
  let step: LaneRunKeyStep | null = null;
  if (entry.key !== null) {
    const parsed = parseLaneRunKey(entry.key);
    if (parsed === null) {
      throw new Error('unparsable-key');
    }
    keyKind = wireKeyKindOf(parsed);
    if (parsed.kind === 'step') {
      step = parsed.step;
    }
  }
  return {
    entryId: entry.entryId,
    kind: entry.kind,
    key: entry.key,
    keyKind,
    step,
    runId: entry.runId,
    recordedAtIso: entry.recordedAtIso,
    isWouldAct: entry.kind === 'result' && entry.outcome === 'dry-run',
    mode: entry.mode,
    expectedRevision: entry.expectedRevision,
    mintedId: safeOrNull(entry.mintedId),
    outcome: entry.outcome,
    reasonCode: entry.reasonCode,
    detail: entry.detail,
    grantId: safeOrNull(entry.grantId),
    state: entry.state,
  };
}

/** The seat summary of one attempt's seat selection, or null when unsafe or a non-declared role. */
function seatSummaryOf(selection: AttemptRecord['seatSelection']): LaneRunRoleSeatSummary | null {
  if (selection === undefined || selection === null) {
    return null;
  }
  const seatId = safeOrNull(selection.seatId);
  const model = safeOrNull(selection.model);
  if (seatId === null || model === null) {
    return null;
  }
  if (selection.tool !== 'opencode' && selection.tool !== 'agy') {
    return null;
  }
  if (!Number.isSafeInteger(selection.seatIndex) || selection.seatIndex < 0) {
    return null;
  }
  return {
    seatId,
    model,
    tool: selection.tool,
    seatIndex: selection.seatIndex,
    variant: labelOrInvalid(selection.variant),
  };
}

/** The latest recorded attempt per role whose seat selection is wire-safe. */
function seatsByRoleOf(
  record: LaneRunRecord,
  attemptsById: ReadonlyMap<string, AttemptRecord> | undefined,
): LaneRunWireCard['seatsByRole'] {
  const out: {
    'first-pass': LaneRunRoleSeatSummary | null;
    fix: LaneRunRoleSeatSummary | null;
    review: LaneRunRoleSeatSummary | null;
  } = { 'first-pass': null, fix: null, review: null };
  if (attemptsById === undefined) {
    return out;
  }
  for (const attemptId of record.attemptIds) {
    const attempt = attemptsById.get(attemptId);
    if (attempt === undefined) {
      continue;
    }
    const summary = seatSummaryOf(attempt.seatSelection);
    if (summary === null) {
      continue;
    }
    const role = attempt.seatSelection?.role;
    if (role === 'first-pass' || role === 'fix' || role === 'review') {
      out[role] = summary;
    }
  }
  return out;
}

/** The last non-ambiguous result on the park's qualifier step, or null. */
function lastQualifierResult(
  record: LaneRunRecord,
  entries: readonly LaneRunJournalEntryRecord[],
  qualifier: string,
): LaneRunJournalEntryRecord | null {
  let last: LaneRunJournalEntryRecord | null = null;
  for (const entry of entries) {
    if (entry.kind !== 'result' || entry.outcome === 'ambiguous' || entry.key === null || entry.runId !== record.runId) {
      continue;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'step' || parsed.step !== qualifier) {
      continue;
    }
    last = entry;
  }
  return last;
}

/** The fixed refusal detail of a `step-refused` park (GB3a): its last qualifier result's token, if usable. */
function parkRefusalDetailOf(record: LaneRunRecord, entries: readonly LaneRunJournalEntryRecord[]): string | null {
  const parked = record.parked;
  if (parked === null || parked.reason !== 'step-refused' || parked.qualifier === null) {
    return null;
  }
  const last = lastQualifierResult(record, entries, parked.qualifier);
  if (last === null) {
    return null;
  }
  const value = last.detail ?? last.reasonCode;
  if (value === null || !LANE_RUN_JOURNAL_REASON_CODE_PATTERN.test(value) || hasAnySecretShape(value)) {
    return null;
  }
  return value;
}

/** One dry-run `wouldAct` summary from a stored entry. */
function wouldActSummaryOf(entry: LaneRunJournalEntryRecord): LaneRunWouldActSummary {
  const wire = projectJournalEntry(entry);
  let keyKind: LaneRunWireKeyKind = 'step';
  let step: LaneRunKeyStep | null = null;
  let round: number | null = null;
  if (entry.key !== null) {
    const parsed = parseLaneRunKey(entry.key);
    if (parsed !== null) {
      keyKind = wireKeyKindOf(parsed);
      if (parsed.kind === 'step') {
        step = parsed.step;
      }
      if (parsed.kind === 'step' || parsed.kind === 'premerge' || parsed.kind === 'merge-enqueue') {
        round = parsed.round;
      }
    }
  }
  return {
    entryId: wire.entryId,
    keyKind,
    step,
    round,
    recordedAtIso: wire.recordedAtIso,
    reasonCode: wire.reasonCode,
    detail: wire.detail,
  };
}

/** The board card of one run from its record and journal. Throws on a corrupt record or journal. */
function buildLaneRunWireCard(
  record: LaneRunRecord,
  entries: readonly LaneRunJournalEntryRecord[],
  attemptsById: ReadonlyMap<string, AttemptRecord> | undefined,
  nowIso: string,
): LaneRunWireCard {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new Error('malformed-run-record');
  }
  if (!/^[0-9a-f]{64}$/.test(record.seatPlanRef)) {
    throw new Error('corrupt-seat-plan-ref');
  }
  // Fail closed on a malformed entry anywhere in the run's journal.
  entries.forEach(projectJournalEntry);
  const state = laneRunJournalState(entries, record.runId);
  const stopFacts = laneRunJournalStopFacts(entries, record.runId);
  const pending = laneRunJournalPendingIntent(entries, record.runId);
  const lease = record.lease === null
    ? null
    : {
        holderId: safeOrNull(record.lease.holderId),
        fence: record.lease.fence,
        leaseUntilIso: record.lease.leaseUntilIso,
        lapsed: isLeaseLapsed(record.lease, nowIso),
      };
  let parked: LaneRunWireCard['parked'] = null;
  if (record.parked !== null) {
    const p = record.parked;
    if (!LANE_RUN_PARK_REASONS.includes(p.reason) || !LANE_RUN_STATES.includes(p.parkedFrom)) {
      throw new Error('malformed-park');
    }
    parked = {
      reason: p.reason,
      qualifier: p.qualifier,
      parkedFrom: p.parkedFrom,
      questionId: idOrNull(p.questionId),
      findingCount: p.reason === 'blocker-after-round-2' && Array.isArray(p.findings) ? p.findings.length : null,
    };
  }
  const dryRunEntries = entries.filter((entry) => entry.kind === 'result' && entry.outcome === 'dry-run');
  const wouldActTruncated = dryRunEntries.length > MAX_WOULD_ACT_PER_RUN;
  const wouldAct = dryRunEntries.slice(-MAX_WOULD_ACT_PER_RUN).map(wouldActSummaryOf);
  return {
    runId: record.runId,
    workOrderId: idOrInvalid(record.workOrderId),
    baseBranch: resolveLaneRunBaseBranch(record),
    tier: record.tier,
    state,
    round: record.round,
    revision: record.revision,
    seatPlanRef: record.seatPlanRef,
    cursors: { 'first-pass': record.cursors['first-pass'], fix: record.cursors.fix, review: record.cursors.review },
    seatsByRole: seatsByRoleOf(record, attemptsById),
    prNumber: record.prNumber,
    parked,
    parkDetail: parkRefusalDetailOf(record, entries),
    parkCount: record.parkCount,
    stopMode: stopFacts.stopMode,
    stopRequestedAtIso: stopFacts.stopRequestedAtIso,
    pendingIntent: pending === null ? null : { step: pending.step, reconciliation: pending.reconciliation },
    latestAttemptId: record.attemptIds.length === 0 ? null : idOrInvalid(record.attemptIds[record.attemptIds.length - 1]),
    attemptCount: record.attemptIds.length,
    lease,
    wouldAct,
    wouldActTruncated,
  };
}

interface BoardRequestParsed {
  readonly nowIso: string;
  readonly limit: number;
}

function parseBoardRequest(request: unknown): BoardRequestParsed {
  const snapshot = readPlainRecordWithOptionalKeys(request, ['nowIso'], ['query']);
  if (snapshot === null || typeof snapshot.nowIso !== 'string' || !isZonedIsoDateTime(snapshot.nowIso)) {
    throw new Error('invalid-request');
  }
  const queryInput = snapshot.query === undefined ? {} : snapshot.query;
  const querySnapshot = readPlainRecordWithOptionalKeys(queryInput, [], ['limit']);
  if (querySnapshot === null) {
    throw new Error('invalid-request');
  }
  const limit = parseBoundedLimit(querySnapshot.limit, MAX_LANE_RUN_CARDS);
  if (limit === null) {
    throw new Error('invalid-request');
  }
  return { nowIso: snapshot.nowIso, limit };
}

interface RunRequestParsed {
  readonly runId: string;
  readonly nowIso: string;
  readonly journalLimit: number;
}

function parseRunRequest(request: unknown): RunRequestParsed {
  const snapshot = readPlainRecordWithOptionalKeys(request, ['runId', 'nowIso'], ['query']);
  if (snapshot === null) {
    throw new Error('invalid-request');
  }
  const { runId, nowIso } = snapshot;
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId) || hasAnySecretShape(runId)) {
    throw new Error('invalid-request');
  }
  if (typeof nowIso !== 'string' || !isZonedIsoDateTime(nowIso)) {
    throw new Error('invalid-request');
  }
  const queryInput = snapshot.query === undefined ? {} : snapshot.query;
  const querySnapshot = readPlainRecordWithOptionalKeys(queryInput, [], ['journalLimit']);
  if (querySnapshot === null) {
    throw new Error('invalid-request');
  }
  const journalLimit = parseBoundedLimit(querySnapshot.journalLimit, MAX_RUN_JOURNAL_ENTRIES);
  if (journalLimit === null) {
    throw new Error('invalid-request');
  }
  return { runId, nowIso, journalLimit };
}

interface JournalForRunRequestParsed {
  readonly runId: string;
  readonly limit: number;
}

function parseJournalForRunRequest(request: unknown): JournalForRunRequestParsed {
  const snapshot = readPlainRecordWithOptionalKeys(request, ['runId'], ['query']);
  if (snapshot === null) {
    throw new Error('invalid-request');
  }
  const { runId } = snapshot;
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId) || hasAnySecretShape(runId)) {
    throw new Error('invalid-request');
  }
  const queryInput = snapshot.query === undefined ? {} : snapshot.query;
  const querySnapshot = readPlainRecordWithOptionalKeys(queryInput, [], ['limit']);
  if (querySnapshot === null) {
    throw new Error('invalid-request');
  }
  const limit = parseBoundedLimit(querySnapshot.limit, MAX_RUN_JOURNAL_ENTRIES);
  if (limit === null) {
    throw new Error('invalid-request');
  }
  return { runId, limit };
}

interface JournalByKeyRequestParsed {
  readonly key: string;
  readonly limit: number;
}

function parseJournalByKeyRequest(request: unknown): JournalByKeyRequestParsed {
  const snapshot = readPlainRecordWithOptionalKeys(request, ['query'], []);
  if (snapshot === null) {
    throw new Error('invalid-request');
  }
  const querySnapshot = readPlainRecordWithOptionalKeys(snapshot.query, ['key'], ['limit']);
  if (querySnapshot === null) {
    throw new Error('invalid-request');
  }
  const key = querySnapshot.key;
  if (typeof key !== 'string' || key.length < 1 || key.length > MAX_RUN_KEY_LENGTH || hasAnySecretShape(key)) {
    throw new Error('invalid-request');
  }
  const limit = parseBoundedLimit(querySnapshot.limit, MAX_RUN_JOURNAL_ENTRIES);
  if (limit === null || parseLaneRunKey(key) === null) {
    throw new Error('invalid-request');
  }
  return { key, limit };
}

/**
 * LaneRunBoardReads: the read-only board, detail and keyed run-journal reads
 * behind `GET /v1/runs`, `GET /v1/runs/:id`, `GET /v1/runs/:id/journal` and
 * `GET /v1/runs/journal?key=`. Every dependency is a `Pick` of read methods
 * only, every store read pass is budget-guarded, and no method writes,
 * quarantines or reaches a git/workspace/runner/forge port.
 */
export class LaneRunBoardReads {
  private readonly readTimeoutMs: number;

  constructor(private readonly deps?: LaneRunBoardReadsDependencies) {
    const provided = deps?.readTimeoutMs;
    this.readTimeoutMs =
      typeof provided === 'number' && Number.isSafeInteger(provided) && provided > 0
        ? provided
        : DEFAULT_LANE_RUN_READ_TIMEOUT_MS;
  }

  async readBoard(request: unknown): Promise<LaneRunBoardReadsResult> {
    if (!this.deps) {
      throw new Error('Not implemented: LaneRunBoardReads');
    }
    let parsed: BoardRequestParsed;
    try {
      parsed = parseBoardRequest(request);
    } catch {
      return { outcome: 'rejected', reason: 'invalid-request' };
    }
    try {
      const data = await withReadBudget(this.readTimeoutMs, () => this.readBoardStores());
      return this.assembleBoard(data, parsed);
    } catch (error) {
      return mapReadError(error);
    }
  }

  private async readBoardStores(): Promise<{
    halt: ConductorHaltState;
    driver: Awaited<ReturnType<ConductorDriverLeasePort['read']>>;
    runs: readonly LaneRunRecord[];
    reservations: Awaited<ReturnType<ExecutionJournalPort['listActiveReservations']>>;
    attempts: Awaited<ReturnType<AttemptRepositoryPort['listAllAttempts']>>;
    orders: Awaited<ReturnType<WorkOrderRepositoryPort['listWorkOrdersByProject']>>;
    traceList: Awaited<ReturnType<ConductorPassTracePort['list']>> | undefined;
    journals: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>;
  }> {
    const deps = this.deps!;
    const [halt, driver, runs, reservations, attempts, orders, traceList] = await Promise.all([
      deps.halt.read(),
      deps.driverLease.read(),
      deps.runRepo.list(),
      deps.executionJournal.listActiveReservations(),
      deps.attemptRepo.listAllAttempts(),
      deps.workOrderRepo.listWorkOrdersByProject(),
      deps.passTrace !== undefined ? deps.passTrace.list() : Promise.resolve(undefined),
    ]);
    assertDense(runs);
    assertDense(reservations);
    assertDense(attempts);
    assertDense(orders);
    if (traceList !== undefined && traceList.outcome === 'listed') {
      assertDense(traceList.traces);
    }
    const journals = await journalsForRuns(deps.runJournal, runs.map((run) => run.runId));
    for (const entries of journals.values()) {
      assertDense(entries);
    }
    return { halt, driver, runs, reservations, attempts, orders, traceList, journals };
  }

  private assembleBoard(
    data: Awaited<ReturnType<LaneRunBoardReads['readBoardStores']>>,
    parsed: BoardRequestParsed,
  ): LaneRunBoardReadsResult {
    const { halt, driver, runs, reservations, attempts, orders, traceList, journals } = data;
    const latestTrace = latestTraceOf(traceList);
    const attemptWorkOrderIds = new Map(attempts.map((attempt) => [attempt.id, attempt.workOrderId]));
    const workOrders = new Map(orders.map((order) => [order.id, { repository: order.repository, ownedPaths: order.ownedPaths }]));
    const derived = deriveConductorSchedule(
      {
        halt: halt.state,
        driverLease: driver,
        runs,
        journals,
        reservations,
        attemptWorkOrderIds,
        workOrders,
        ...(latestTrace === undefined ? {} : { latestTrace }),
      },
      parsed.nowIso,
    );
    // A stored work order id is screened here too: the schedule rows echo it.
    const schedule: ConductorSchedule = {
      ...derived,
      rows: derived.rows.map((row) => ({ ...row, workOrderId: idOrInvalid(row.workOrderId) })),
    };
    const { marks, truncated } = deriveSessionStartMarks(
      [...journals.values()].flat(),
      {
        dispatchStaggerMs: schedule.caps?.dispatchStaggerMs ?? null,
        limit: LIST_LANE_RUNS_SESSION_MARK_LIMIT,
      },
    );
    const attemptsById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
    const allCards = runs
      .map((record) => buildLaneRunWireCard(record, journals.get(record.runId) ?? [], attemptsById, parsed.nowIso))
      .sort((left, right) => byCodeUnit(left.runId, right.runId));
    const runsTruncated = allCards.length > parsed.limit;
    return {
      outcome: 'listed',
      schedule,
      sessionStarts: marks,
      truncated,
      runs: allCards.slice(0, parsed.limit),
      runsTruncated,
    };
  }

  async readRun(request: unknown): Promise<LaneRunReadResult> {
    if (!this.deps) {
      throw new Error('Not implemented: LaneRunBoardReads');
    }
    let parsed: RunRequestParsed;
    try {
      parsed = parseRunRequest(request);
    } catch {
      return { outcome: 'rejected', reason: 'invalid-request' };
    }
    try {
      const deps = this.deps!;
      const [halt, driver, record] = await withReadBudget(this.readTimeoutMs, () =>
        Promise.all([
          deps.halt.read(),
          deps.driverLease.read(),
          deps.runRepo.get(parsed.runId),
        ]),
      );
      if (record === null) {
        return { outcome: 'not-found', runId: parsed.runId };
      }
      const [entries, attempts] = await withReadBudget(this.readTimeoutMs, async () => {
        const entries = await deps.runJournal.listForRun(parsed.runId);
        const attempts = await Promise.all(record.attemptIds.map((id) => deps.attemptRepo.findAttemptById(id)));
        return [entries, attempts] as const;
      });
      assertDense(entries);
      assertDense(attempts);
      const attemptsById = new Map<string, AttemptRecord>();
      for (const attempt of attempts) {
        if (attempt !== null) {
          attemptsById.set(attempt.id, attempt);
        }
      }
      const journal = entries.map(projectJournalEntry);
      const run = buildLaneRunWireCard(record, entries, attemptsById, parsed.nowIso);
      return {
        outcome: 'listed',
        halt: halt.state,
        driverLeaseLapsed: driver === null ? null : isLeaseLapsed(driver, parsed.nowIso),
        run,
        journal: journal.slice(-parsed.journalLimit),
        journalTruncated: journal.length > parsed.journalLimit,
      };
    } catch (error) {
      return mapReadError(error);
    }
  }

  async readJournalForRun(request: unknown): Promise<LaneRunJournalReadResult> {
    if (!this.deps) {
      throw new Error('Not implemented: LaneRunBoardReads');
    }
    let parsed: JournalForRunRequestParsed;
    try {
      parsed = parseJournalForRunRequest(request);
    } catch {
      return { outcome: 'rejected', reason: 'invalid-request' };
    }
    try {
      const deps = this.deps!;
      const [record, entries] = await withReadBudget(this.readTimeoutMs, async () => {
        const record = await deps.runRepo.get(parsed.runId);
        const entries = record === null ? [] : await deps.runJournal.listForRun(parsed.runId);
        return [record, entries] as const;
      });
      if (record === null) {
        return { outcome: 'not-found', runId: parsed.runId };
      }
      assertDense(entries);
      const projected = entries.map(projectJournalEntry);
      return {
        outcome: 'listed',
        runId: parsed.runId,
        entries: projected.slice(-parsed.limit),
        truncated: projected.length > parsed.limit,
      };
    } catch (error) {
      return mapReadError(error);
    }
  }

  async readJournalByKey(request: unknown): Promise<LaneRunJournalKeyReadResult> {
    if (!this.deps) {
      throw new Error('Not implemented: LaneRunBoardReads');
    }
    let parsed: JournalByKeyRequestParsed;
    try {
      parsed = parseJournalByKeyRequest(request);
    } catch {
      return { outcome: 'rejected', reason: 'invalid-request' };
    }
    try {
      const deps = this.deps!;
      const entries = await withReadBudget(this.readTimeoutMs, () => deps.runJournal.listForKey(parsed.key));
      assertDense(entries);
      const projected = entries.map(projectJournalEntry);
      return {
        outcome: 'listed',
        key: parsed.key,
        keyKind: parseLaneRunKey(parsed.key)!.kind,
        entries: projected.slice(-parsed.limit),
        truncated: projected.length > parsed.limit,
      };
    } catch (error) {
      return mapReadError(error);
    }
  }
}
