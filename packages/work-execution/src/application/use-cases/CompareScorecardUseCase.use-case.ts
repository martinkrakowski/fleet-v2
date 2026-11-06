// @generated use-case scaffold — refined for lane CO20.
/**
 * CompareScorecardUseCase compares scorecard rows before and after a split
 * date within an optional from and to range (lane CO20). Every dependency is
 * a `Pick` of read methods: the comparison reads the scorecard, the run
 * store, the attempt store, the run journal and the work-order store, and
 * reads each merged pull request's CI cost through the forge read port. It
 * writes nothing. The use case never throws on runtime input; every failure
 * is a typed refusal, an unknown row or an unknown pull request that carries
 * ids and codes and never a path, a store message or a stored value. An
 * unreadable read is unknown, never an empty summary or a zero count.
 */

import type {
  CompareScorecardPort,
  CompareScorecardRequest,
  CompareScorecardResult,
  MergedPullRequestCiCostItem,
  ScorecardPeriodSummary,
  UnknownPullRequestCiCost,
  UnknownScorecardRow,
  UnknownScorecardRowReason,
} from '../ports/in/CompareScorecardPort.in-port.js';
import {
  COMPARE_SCORECARD_DEFAULT_BUDGET_MS,
  COMPARE_SCORECARD_MAX_BUDGET_MS,
  COMPARE_SCORECARD_MAX_ROWS,
} from '../ports/in/CompareScorecardPort.in-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ForgeReadPort, ReadPullRequestCiCostResult, WorkflowCiCost } from '../ports/out/ForgeReadPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import {
  LANE_SCORECARD_FINAL_STATES,
  LANE_SCORECARD_ID_PATTERN,
  LANE_SCORECARD_VERIFICATION_RESULTS,
  type LaneScorecardFindings,
  type LaneScorecardPort,
} from '../ports/out/LaneScorecardPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import type { LaneRunJournalEntryRecord } from '../../domain/lane-run-journal.js';
import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import { APPEND_SCORECARD_MAX_ATTEMPTS } from './AppendScorecardUseCase.use-case.js';

/** Journal entries above this per run make the store unreadable, never partial. */
export const MAX_JOURNAL_ENTRIES = 1_024;
/** Work orders above this per project are refused, never read partially. */
export const MAX_WORK_ORDERS_PER_PROJECT = 20_000;

const WORKFLOW_NAME_MAX_LENGTH = 128;
// eslint-disable-next-line no-control-regex
const WORKFLOW_CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
const WORKFLOW_PATH_SHAPED = /[/\\]/;
const OWNER_REPO_SEGMENTS = /^[A-Za-z0-9_.-]{1,100}$/;

export interface CompareScorecardDependencies {
  readonly scorecard: Pick<LaneScorecardPort, 'read'>;
  readonly runRepo: Pick<LaneRunRepositoryPort, 'get'>;
  readonly attemptRepo: Pick<AttemptRepositoryPort, 'listAttemptsByWorkOrder'>;
  readonly runJournal: Pick<LaneRunJournalPort, 'listForRun'>;
  readonly workOrderRepo: Pick<WorkOrderRepositoryPort, 'findWorkOrderById' | 'listWorkOrdersByProject'>;
  readonly forgeRead: Required<Pick<ForgeReadPort, 'readPullRequestCiCost'>>;
  readonly nowMs?: () => number;
}

type Guarded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

async function guarded<T>(read: () => Promise<T>): Promise<Guarded<T>> {
  try {
    return { ok: true, value: await read() };
  } catch {
    return { ok: false };
  }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** True when the value is a plain (non-sparse) array: every index is an own property. */
function isDenseArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      return false;
    }
  }
  return true;
}

/** True when the value is a non-null, non-array plain object (or a throwing getter is not reached). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** True when the string carries no secret shape from either registry. */
function isSecretShaped(value: string): boolean {
  return containsSecretShape(value) || LANE_DIFF_SECRET_PATTERNS.some((entry) => entry.regex.test(value));
}

/** A workflow name echoed back into a summary: bounded, plain, never secret-shaped. */
function isSafeWorkflowName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= WORKFLOW_NAME_MAX_LENGTH &&
    !WORKFLOW_CONTROL_CHARACTER.test(value) &&
    !WORKFLOW_PATH_SHAPED.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !isSecretShaped(value)
  );
}

/** `owner/repo` with one slash and two bounded plain segments; never `.` or `..`. */
export function parseOwnerRepository(value: unknown): { readonly owner: string; readonly repo: string } | null {
  if (typeof value !== 'string') {
    return null;
  }
  const slash = value.indexOf('/');
  if (slash < 1 || slash !== value.lastIndexOf('/')) {
    return null;
  }
  const owner = value.slice(0, slash);
  const repo = value.slice(slash + 1);
  if (!OWNER_REPO_SEGMENTS.test(owner) || !OWNER_REPO_SEGMENTS.test(repo) || owner === '.' || owner === '..' || repo === '.' || repo === '..') {
    return null;
  }
  return { owner, repo };
}

/**
 * One boundary: a zoned ISO-8601 datetime is its exact instant; a strict
 * `YYYY-MM-DD` is the start of that UTC day (for `to`, the end of it); the
 * date must round-trip, so `2026-02-30` is refused. Null when invalid.
 */
export function parseBoundaryDate(
  value: unknown,
  role: 'from' | 'split' | 'to',
): { readonly ms: number; readonly iso: string } | null {
  try {
    if (typeof value !== 'string') {
      return null;
    }
    if (isZonedIsoDateTime(value)) {
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? { ms, iso: new Date(ms).toISOString() } : null;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return null;
    }
    const ms = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
      return null;
    }
    return role === 'to'
      ? { ms: Date.parse(`${value}T23:59:59.999Z`), iso: `${value}T23:59:59.999Z` }
      : { ms, iso: `${value}T00:00:00.000Z` };
  } catch {
    return null;
  }
}

function createEmptyCiCostSummary(): MutableCiCostSummary {
  return {
    knownPullRequestCount: 0,
    unknownPullRequestCount: 0,
    totalCheckRuns: 0,
    totalBilledMinutes: 0,
    pullRequests: [],
    unknownPullRequests: [],
  };
}

/** A summary being accumulated; frozen into the read-only shape at the end. */
interface MutableCiCostSummary {
  knownPullRequestCount: number;
  unknownPullRequestCount: number;
  totalCheckRuns: number;
  totalBilledMinutes: number;
  pullRequests: MergedPullRequestCiCostItem[];
  unknownPullRequests: UnknownPullRequestCiCost[];
}

interface MutableSummary {
  runCount: number;
  mergedRunCount: number;
  stoppedRunCount: number;
  firstPassCompletions: number;
  fixRounds: number;
  reviewFindings: { blocker: number; major: number; minor: number; nit: number };
  escapedDefects: number;
  ciCost: MutableCiCostSummary;
}

function createEmptySummary(): MutableSummary {
  return {
    runCount: 0,
    mergedRunCount: 0,
    stoppedRunCount: 0,
    firstPassCompletions: 0,
    fixRounds: 0,
    reviewFindings: { blocker: 0, major: 0, minor: 0, nit: 0 },
    escapedDefects: 0,
    ciCost: createEmptyCiCostSummary(),
  };
}

function frozenSummary(summary: MutableSummary): ScorecardPeriodSummary {
  return {
    runCount: summary.runCount,
    mergedRunCount: summary.mergedRunCount,
    stoppedRunCount: summary.stoppedRunCount,
    firstPassCompletions: summary.firstPassCompletions,
    fixRounds: summary.fixRounds,
    reviewFindings: { ...summary.reviewFindings },
    escapedDefects: summary.escapedDefects,
    ciCost: { ...summary.ciCost },
  };
}

/** The structurally valid fields of one scorecard row, read defensively. */
interface ValidRowShape {
  readonly runId: string;
  readonly workOrderId: string;
  readonly tier: 1 | 2;
  readonly finalState: (typeof LANE_SCORECARD_FINAL_STATES)[number];
  readonly fixRounds: number;
  readonly attemptCount: number;
  readonly parkCount: number;
  readonly prNumber: number | null;
  readonly firstPassCompleted: boolean;
  readonly reviewFindings: LaneScorecardFindings;
  readonly verificationResult: (typeof LANE_SCORECARD_VERIFICATION_RESULTS)[number];
  readonly durationMs: number | null;
}

/** The row's fields when every one carries a value a row may hold; null otherwise (or when a getter throws). */
function validRowShapeOf(row: unknown): ValidRowShape | null {
  try {
    if (!isPlainObject(row)) {
      return null;
    }
    const record = row as Record<string, unknown>;
  const { runId, workOrderId, tier, finalState, fixRounds, attemptCount, parkCount, prNumber, firstPassCompleted, reviewFindings, verificationResult, durationMs } = record;
  if (
    typeof runId !== 'string' ||
    !LANE_SCORECARD_ID_PATTERN.test(runId) ||
    isSecretShaped(runId) ||
    typeof workOrderId !== 'string' ||
    !LANE_SCORECARD_ID_PATTERN.test(workOrderId) ||
    isSecretShaped(workOrderId) ||
    (tier !== 1 && tier !== 2) ||
    !LANE_SCORECARD_FINAL_STATES.includes(finalState as never) ||
    !isCount(fixRounds) ||
    !isCount(attemptCount) ||
    !isCount(parkCount) ||
    (prNumber !== null && !isCount(prNumber)) ||
    typeof firstPassCompleted !== 'boolean' ||
    !isPlainObject(reviewFindings) ||
    !isCount((reviewFindings as Record<string, unknown>).blocker) ||
    !isCount((reviewFindings as Record<string, unknown>).major) ||
    !isCount((reviewFindings as Record<string, unknown>).minor) ||
    !isCount((reviewFindings as Record<string, unknown>).nit) ||
    !LANE_SCORECARD_VERIFICATION_RESULTS.includes(verificationResult as never) ||
    (durationMs !== null && !isCount(durationMs))
  ) {
    return null;
  }
  const findings = reviewFindings as Record<string, unknown>;
  return {
    runId,
    workOrderId,
    tier,
    finalState: finalState as (typeof LANE_SCORECARD_FINAL_STATES)[number],
    fixRounds,
    attemptCount,
    parkCount,
    prNumber: prNumber as number | null,
    firstPassCompleted,
    reviewFindings: {
      blocker: findings.blocker as number,
      major: findings.major as number,
      minor: findings.minor as number,
      nit: findings.nit as number,
    },
    verificationResult: verificationResult as (typeof LANE_SCORECARD_VERIFICATION_RESULTS)[number],
    durationMs,
  };
  } catch {
    return null;
  }
}

/**
 * The row's completion timestamp: the last terminal conduct entry's
 * `recordedAtIso` when the journal carries one; otherwise the attempts'
 * latest end (a completion receipt's end, else the attempt's last update),
 * or the work order's last update when the run had no attempt. Null when no
 * source answers.
 */
export function resolveRowCompletionTimestampMs(facts: {
  readonly journal: readonly LaneRunJournalEntryRecord[];
  readonly attempts: readonly { readonly completionReceipt: { readonly endedAtIso: string } | null; readonly updatedAtIso: string }[];
  readonly hasAttempts: boolean;
  readonly workOrderUpdatedAtIso: string | null;
}): number | null {
  for (let index = facts.journal.length - 1; index >= 0; index -= 1) {
    const entry = facts.journal[index] as LaneRunJournalEntryRecord;
    if (entry.kind === 'conduct' && (entry.state === 'merged' || entry.state === 'stopped')) {
      return isZonedIsoDateTime(entry.recordedAtIso) ? Date.parse(entry.recordedAtIso) : null;
    }
  }
  if (!facts.hasAttempts) {
    return facts.workOrderUpdatedAtIso !== null && isZonedIsoDateTime(facts.workOrderUpdatedAtIso)
      ? Date.parse(facts.workOrderUpdatedAtIso)
      : null;
  }
  let latest: number | null = null;
  for (const attempt of facts.attempts) {
    const ended = attempt.completionReceipt ? attempt.completionReceipt.endedAtIso : attempt.updatedAtIso;
    if (!isZonedIsoDateTime(ended)) {
      return null;
    }
    const ms = Date.parse(ended);
    latest = latest === null ? ms : Math.max(latest, ms);
  }
  return latest;
}

/** A structurally valid, in-range row carried into the aggregation. */
interface PeriodRow {
  readonly runId: string;
  readonly workOrderId: string;
  readonly finalState: 'merged' | 'stopped';
  readonly firstPassCompleted: boolean;
  readonly fixRounds: number;
  readonly reviewFindings: LaneScorecardFindings;
  readonly prNumber: number | null;
  readonly projectId: string;
  readonly repository: unknown;
  readonly period: 'before' | 'after';
  readonly runAttemptIds: readonly unknown[];
}

function addCounts(summary: MutableSummary, row: PeriodRow): boolean {
  summary.runCount += 1;
  if (row.finalState === 'merged') {
    summary.mergedRunCount += 1;
  } else {
    summary.stoppedRunCount += 1;
  }
  if (row.firstPassCompleted) {
    summary.firstPassCompletions += 1;
  }
  summary.fixRounds += row.fixRounds;
  for (const severity of ['blocker', 'major', 'minor', 'nit'] as const) {
    summary.reviewFindings[severity] += row.reviewFindings[severity];
    if (!Number.isSafeInteger(summary.reviewFindings[severity])) {
      return false;
    }
  }
  return true;
}

export class CompareScorecardUseCase implements CompareScorecardPort {
  constructor(private readonly deps?: CompareScorecardDependencies) {}

  async compareScorecard(request: CompareScorecardRequest): Promise<CompareScorecardResult> {
    if (!this.deps) {
      return { outcome: 'refused', reason: 'scorecard-unreadable' };
    }
    const deps = this.deps;
    const now = deps.nowMs ?? Date.now;
    return this.compare(deps, now, request);
  }

  private async compare(
    deps: CompareScorecardDependencies,
    now: () => number,
    request: unknown,
  ): Promise<CompareScorecardResult> {
    if (!isPlainObject(request)) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const record = request as Record<string, unknown>;
    let split: ReturnType<typeof parseBoundaryDate>;
    let from: ReturnType<typeof parseBoundaryDate>;
    let to: ReturnType<typeof parseBoundaryDate>;
    let budgetMs: unknown;
    try {
      split = parseBoundaryDate(record.split, 'split');
      from = record.from === undefined ? null : parseBoundaryDate(record.from, 'from');
      to = record.to === undefined ? null : parseBoundaryDate(record.to, 'to');
      budgetMs = record.budgetMs;
    } catch {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    if (split === null) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    if (record.from !== undefined && from === null) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    if (record.to !== undefined && to === null) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    if ((from !== null && from.ms >= split.ms) || (to !== null && split.ms > to.ms)) {
      return { outcome: 'refused', reason: 'invalid-range' };
    }
    const budgetMsTyped = budgetMs;
    if (budgetMsTyped !== undefined && (!isCount(budgetMsTyped) || budgetMsTyped < 1 || budgetMsTyped > COMPARE_SCORECARD_MAX_BUDGET_MS)) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const deadlineMs = now() + (typeof budgetMs === 'number' ? budgetMs : COMPARE_SCORECARD_DEFAULT_BUDGET_MS);

    if (now() >= deadlineMs) {
      return { outcome: 'refused', reason: 'scorecard-unreadable' };
    }
    const scorecard = await guarded(() => deps.scorecard.read());
    if (!scorecard.ok) {
      return { outcome: 'refused', reason: 'scorecard-unreadable' };
    }
    const read = scorecard.value;
    if (read.outcome === 'absent') {
      return {
        outcome: 'compared',
        fromIso: from === null ? null : from.iso,
        splitIso: split.iso,
        toIso: to === null ? null : to.iso,
        scorecardAbsent: true,
        before: frozenSummary(createEmptySummary()),
        after: frozenSummary(createEmptySummary()),
        unknownRowCount: 0,
        unknownRows: [],
      };
    }
    if (read.outcome !== 'read' || !isDenseArray(read.rows) || !isDenseArray(read.problems)) {
      return { outcome: 'refused', reason: 'scorecard-unreadable' };
    }
    if (read.rows.length > COMPARE_SCORECARD_MAX_ROWS || read.problems.length > COMPARE_SCORECARD_MAX_ROWS) {
      return { outcome: 'refused', reason: 'scorecard-too-large' };
    }

    const unknownRows: UnknownScorecardRow[] = [];
    for (const problem of read.problems as readonly unknown[]) {
      try {
        if (!isPlainObject(problem) || !isCount((problem as Record<string, unknown>).lineNumber)) {
          return { outcome: 'refused', reason: 'scorecard-unreadable' };
        }
        unknownRows.push({
          kind: 'line',
          lineNumber: (problem as Record<string, unknown>).lineNumber as number,
          reason: 'malformed-line',
        });
      } catch {
        return { outcome: 'refused', reason: 'scorecard-unreadable' };
      }
    }

    const seenRunIds = new Set<string>();
    const periodRows: PeriodRow[] = [];
    for (let rowIndex = 0; rowIndex < read.rows.length; rowIndex += 1) {
      try {
      const row = read.rows[rowIndex];
      if (!isPlainObject(row)) {
        unknownRows.push({ kind: 'row-index', rowIndex, reason: 'invalid-row-id' });
        continue;
      }
      const runId = (row as Record<string, unknown>).runId;
      if (typeof runId !== 'string' || !LANE_SCORECARD_ID_PATTERN.test(runId) || isSecretShaped(runId)) {
        unknownRows.push({ kind: 'row-index', rowIndex, reason: 'invalid-row-id' });
        continue;
      }
      if (seenRunIds.has(runId)) {
        unknownRows.push({ kind: 'row', runId, reason: 'duplicate-run-id' });
        continue;
      }
      seenRunIds.add(runId);
      const shape = validRowShapeOf(row);
      if (shape === null) {
        unknownRows.push({ kind: 'row', runId, reason: 'malformed-row' });
        continue;
      }
      if (now() >= deadlineMs) {
        unknownRows.push({ kind: 'row', runId, reason: 'budget-exhausted' });
        continue;
      }
      const facts = await this.readRowFacts(deps, runId, shape.workOrderId);
      if (facts.reason !== null) {
        unknownRows.push({ kind: 'row', runId, reason: facts.reason });
        continue;
      }
      const rowMs = resolveRowCompletionTimestampMs(facts.timestamp);
      if (rowMs === null) {
        unknownRows.push({ kind: 'row', runId, reason: 'timestamp-unreadable' });
        continue;
      }
      if ((from !== null && rowMs < from.ms) || (to !== null && rowMs > to.ms)) {
        continue; // Out of range: ignored cleanly, never counted.
      }
      periodRows.push({
        runId: shape.runId,
        workOrderId: shape.workOrderId,
        finalState: shape.finalState,
        firstPassCompleted: shape.firstPassCompleted,
        fixRounds: shape.fixRounds,
        reviewFindings: shape.reviewFindings,
        prNumber: shape.prNumber,
        projectId: facts.projectId,
        repository: facts.repository,
        period: rowMs < split.ms ? 'before' : 'after',
        runAttemptIds: facts.runAttemptIds,
      });
      } catch {
        unknownRows.push({ kind: 'row-index', rowIndex, reason: 'invalid-row-id' });
      }
    }

    // Escaped defects: one listing per project of the in-range merged rows.
    const escaped = await this.collectEscapedDefects(deps, now, deadlineMs, periodRows, unknownRows);
    const knownRows = periodRows.filter((row) => !escaped.excluded.has(row.runId));

    const before = createEmptySummary();
    const after = createEmptySummary();
    for (const row of knownRows) {
      const summary = row.period === 'before' ? before : after;
      if (!addCounts(summary, row)) {
        unknownRows.push({ kind: 'row', runId: row.runId, reason: 'stores-unreadable' });
      }
    }
    for (const defect of escaped.defects) {
      const summary = defect.period === 'before' ? before : after;
      summary.escapedDefects += 1;
      if (!Number.isSafeInteger(summary.escapedDefects)) {
        unknownRows.push({ kind: 'row', runId: defect.runId, reason: 'stores-unreadable' });
      }
    }

    await this.collectCiCosts(deps, now, deadlineMs, knownRows, before, after);

    return {
      outcome: 'compared',
      fromIso: from === null ? null : from.iso,
      splitIso: split.iso,
      toIso: to === null ? null : to.iso,
      scorecardAbsent: false,
      before: frozenSummary(before),
      after: frozenSummary(after),
      unknownRowCount: unknownRows.length,
      unknownRows,
    };
  }

  /** One run's, work order's and journal's facts for one row; null reason when all read cleanly. */
  private async readRowFacts(
    deps: CompareScorecardDependencies,
    runId: string,
    workOrderId: string,
  ): Promise<
    | {
        readonly reason: null;
        readonly runAttemptIds: readonly unknown[];
        readonly projectId: string;
        readonly repository: unknown;
        readonly timestamp: {
          readonly journal: readonly LaneRunJournalEntryRecord[];
          readonly attempts: readonly { readonly completionReceipt: { readonly endedAtIso: string } | null; readonly updatedAtIso: string }[];
          readonly hasAttempts: boolean;
          readonly workOrderUpdatedAtIso: string | null;
        };
      }
    | { readonly reason: Extract<UnknownScorecardRowReason, 'run-not-found' | 'work-order-not-found' | 'stores-unreadable'> }
  > {
    const runRead = await guarded(() => deps.runRepo.get(runId));
    if (!runRead.ok) {
      return { reason: 'stores-unreadable' };
    }
    const run = runRead.value as LaneRunRecord | null;
    if (run === null) {
      return { reason: 'run-not-found' };
    }
    if (run.workOrderId !== workOrderId) {
      return { reason: 'stores-unreadable' };
    }
    const workOrderRead = await guarded(() => deps.workOrderRepo.findWorkOrderById(workOrderId));
    if (!workOrderRead.ok) {
      return { reason: 'stores-unreadable' };
    }
    const workOrder = workOrderRead.value;
    if (workOrder === null) {
      return { reason: 'work-order-not-found' };
    }
    const journalRead = await guarded(() => deps.runJournal.listForRun(runId));
    if (!journalRead.ok || !isDenseArray(journalRead.value) || journalRead.value.length > MAX_JOURNAL_ENTRIES) {
      return { reason: 'stores-unreadable' };
    }
    let attempts: readonly { readonly completionReceipt: { readonly endedAtIso: string } | null; readonly updatedAtIso: string }[] = [];
    let hasAttempts = false;
    if (Array.isArray(run.attemptIds) && run.attemptIds.length > 0) {
      if (run.attemptIds.length > APPEND_SCORECARD_MAX_ATTEMPTS) {
        return { reason: 'stores-unreadable' };
      }
      const attemptRead = await guarded(() => deps.attemptRepo.listAttemptsByWorkOrder(workOrderId));
      if (!attemptRead.ok || !isDenseArray(attemptRead.value) || attemptRead.value.length > APPEND_SCORECARD_MAX_ATTEMPTS) {
        return { reason: 'stores-unreadable' };
      }
      const byId = new Map<string, unknown>();
      for (const attempt of attemptRead.value) {
        const id = isPlainObject(attempt) ? (attempt as Record<string, unknown>).id : undefined;
        if (typeof id === 'string') {
          byId.set(id, attempt);
        }
      }
      const kept: unknown[] = [];
      for (const attemptId of run.attemptIds as readonly unknown[]) {
        if (typeof attemptId !== 'string' || !byId.has(attemptId)) {
          return { reason: 'stores-unreadable' };
        }
        kept.push(byId.get(attemptId));
      }
      attempts = kept as readonly { readonly completionReceipt: { readonly endedAtIso: string } | null; readonly updatedAtIso: string }[];
      hasAttempts = true;
    }
    const updatedAtIso = isPlainObject(workOrder) ? (workOrder as Record<string, unknown>).updatedAtIso : undefined;
    return {
      reason: null,
      runAttemptIds: Array.isArray(run.attemptIds) ? (run.attemptIds as readonly unknown[]) : [],
      projectId: isPlainObject(workOrder) && typeof (workOrder as Record<string, unknown>).projectId === 'string'
        ? (workOrder as Record<string, unknown>).projectId as string
        : '',
      repository: isPlainObject(workOrder) ? (workOrder as Record<string, unknown>).repository : undefined,
      timestamp: {
        journal: journalRead.value as readonly LaneRunJournalEntryRecord[],
        attempts,
        hasAttempts,
        workOrderUpdatedAtIso: typeof updatedAtIso === 'string' ? updatedAtIso : null,
      },
    };
  }

  /**
   * Escaped defects: for every distinct project among the in-range merged
   * rows, list the project's work orders once and count the orders that
   * supersede one of those rows' work orders. A listing that throws, is
   * sparse, exceeds the cap or crosses the budget excludes that project's
   * merged rows from the counts and marks them unknown, never zero.
   */
  private async collectEscapedDefects(
    deps: CompareScorecardDependencies,
    now: () => number,
    deadlineMs: number,
    rows: readonly PeriodRow[],
    unknownRows: UnknownScorecardRow[],
  ): Promise<{ readonly excluded: ReadonlySet<string>; readonly defects: readonly { readonly runId: string; readonly period: 'before' | 'after' }[] }> {
    const merged = rows.filter((row) => row.finalState === 'merged');
    const projects = new Map<string, PeriodRow[]>();
    for (const row of merged) {
      const known = projects.get(row.projectId);
      if (known === undefined) {
        projects.set(row.projectId, [row]);
      } else {
        known.push(row);
      }
    }
    const excluded = new Set<string>();
    const defects: { readonly runId: string; readonly period: 'before' | 'after' }[] = [];
    for (const [projectId, projectRows] of projects) {
      if (now() >= deadlineMs) {
        for (const row of projectRows) {
          excluded.add(row.runId);
          unknownRows.push({ kind: 'row', runId: row.runId, reason: 'budget-exhausted' });
        }
        continue;
      }
      const listed = await guarded(() => deps.workOrderRepo.listWorkOrdersByProject(projectId));
      if (!listed.ok || !isDenseArray(listed.value) || listed.value.length > MAX_WORK_ORDERS_PER_PROJECT) {
        for (const row of projectRows) {
          excluded.add(row.runId);
          unknownRows.push({ kind: 'row', runId: row.runId, reason: 'stores-unreadable' });
        }
        continue;
      }
      const seenWorkOrderIds = new Set<string>();
      for (const workOrder of listed.value) {
        if (!isPlainObject(workOrder)) {
          continue;
        }
        const id = (workOrder as Record<string, unknown>).id;
        if (typeof id !== 'string' || seenWorkOrderIds.has(id)) {
          continue;
        }
        seenWorkOrderIds.add(id);
        const supersedes = (workOrder as Record<string, unknown>).supersedesWorkOrderId;
        if (typeof supersedes !== 'string') {
          continue;
        }
        for (const row of projectRows) {
          if (row.workOrderId === supersedes) {
            defects.push({ runId: row.runId, period: row.period });
          }
        }
      }
    }
    return { excluded, defects };
  }

  /**
   * The CI cost of every in-range merged row's pull request, read at most
   * once per `owner/repo#prNumber`; an unknown cost is named, never zero.
   */
  private async collectCiCosts(
    deps: CompareScorecardDependencies,
    now: () => number,
    deadlineMs: number,
    rows: readonly PeriodRow[],
    before: MutableSummary,
    after: MutableSummary,
  ): Promise<void> {
    const cache = new Map<string, Promise<CachedCiCost>>();
    for (const row of rows) {
      if (row.finalState !== 'merged') {
        continue;
      }
      const summary = row.period === 'before' ? before : after;
      const repository = parseOwnerRepository(row.repository);
      if (row.prNumber === null) {
        summary.ciCost.unknownPullRequestCount += 1;
        summary.ciCost.unknownPullRequests.push({ runId: row.runId, prNumber: null, reason: 'missing-pr-number' });
        continue;
      }
      if (repository === null) {
        summary.ciCost.unknownPullRequestCount += 1;
        summary.ciCost.unknownPullRequests.push({ runId: row.runId, prNumber: row.prNumber, reason: 'invalid-repository' });
        continue;
      }
      const remainingMs = deadlineMs - now();
      if (remainingMs <= 0) {
        summary.ciCost.unknownPullRequestCount += 1;
        summary.ciCost.unknownPullRequests.push({ runId: row.runId, prNumber: row.prNumber, reason: 'budget-exhausted' });
        continue;
      }
      const key = `${repository.owner}/${repository.repo}#${row.prNumber}`;
      let cached = cache.get(key);
      if (cached === undefined) {
        cached = guarded(() =>
          deps.forgeRead.readPullRequestCiCost({
            pullRequestNumber: row.prNumber as number,
            repository: { owner: repository.owner, repo: repository.repo },
            timeoutMs: remainingMs,
          }),
        ).then(classifyCiCost);
        cache.set(key, cached);
      }
      const resolved = await cached;
      if (resolved.kind !== 'found') {
        summary.ciCost.unknownPullRequestCount += 1;
        summary.ciCost.unknownPullRequests.push({
          runId: row.runId,
          prNumber: row.prNumber,
          reason: resolved.kind === 'not-found' ? 'pr-not-found' : 'ci-cost-unavailable',
        });
        continue;
      }
      const totalCheckRuns = summary.ciCost.totalCheckRuns + resolved.totalCheckRuns;
      const totalBilledMinutes = summary.ciCost.totalBilledMinutes + resolved.totalBilledMinutes;
      if (!Number.isSafeInteger(totalCheckRuns) || !Number.isSafeInteger(totalBilledMinutes)) {
        summary.ciCost.unknownPullRequestCount += 1;
        summary.ciCost.unknownPullRequests.push({ runId: row.runId, prNumber: row.prNumber, reason: 'ci-cost-unavailable' });
        continue;
      }
      summary.ciCost.knownPullRequestCount += 1;
      summary.ciCost.totalCheckRuns = totalCheckRuns;
      summary.ciCost.totalBilledMinutes = totalBilledMinutes;
      summary.ciCost.pullRequests.push({
        runId: row.runId,
        prNumber: row.prNumber,
        checkRuns: resolved.totalCheckRuns,
        billedMinutes: resolved.totalBilledMinutes,
        workflows: resolved.workflows,
      });
    }
  }
}

/** One cached forge answer for a merged pull request's CI cost. */
type CachedCiCost =
  | { readonly kind: 'found'; readonly totalCheckRuns: number; readonly totalBilledMinutes: number; readonly workflows: readonly WorkflowCiCost[] }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unavailable' };

/** The forge answer classified: an unreadable `found` payload is unavailable, never trusted. */
function classifyCiCost(read: Guarded<ReadPullRequestCiCostResult>): CachedCiCost {
  if (!read.ok) {
    return { kind: 'unavailable' };
  }
  const value = read.value;
  if (value.outcome === 'not-found') {
    return { kind: 'not-found' };
  }
  if (value.outcome !== 'found') {
    return { kind: 'unavailable' };
  }
  const cost = value.cost;
  const { totalCheckRuns, totalBilledMinutes, workflows } = cost;
  if (!isCount(totalCheckRuns) || !isCount(totalBilledMinutes) || !isDenseArray(workflows)) {
    return { kind: 'unavailable' };
  }
  let checkRunsSum = 0;
  let billedMinutesSum = 0;
  const parsed: WorkflowCiCost[] = [];
  for (const workflow of workflows as readonly unknown[]) {
    if (!isPlainObject(workflow)) {
      return { kind: 'unavailable' };
    }
    const entry = workflow as Record<string, unknown>;
    const { workflowName, checkRuns, billedMinutes } = entry;
    if (!isSafeWorkflowName(workflowName) || !isCount(checkRuns) || !isCount(billedMinutes)) {
      return { kind: 'unavailable' };
    }
    checkRunsSum += checkRuns as number;
    billedMinutesSum += billedMinutes as number;
    if (!Number.isSafeInteger(checkRunsSum) || !Number.isSafeInteger(billedMinutesSum)) {
      return { kind: 'unavailable' };
    }
    parsed.push({ workflowName, checkRuns: checkRuns as number, billedMinutes: billedMinutes as number });
  }
  if (checkRunsSum !== totalCheckRuns || billedMinutesSum !== totalBilledMinutes) {
    return { kind: 'unavailable' };
  }
  return { kind: 'found', totalCheckRuns, totalBilledMinutes, workflows: parsed };
}
