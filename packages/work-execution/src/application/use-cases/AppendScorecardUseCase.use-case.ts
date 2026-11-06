// @generated use-case scaffold — refined for lane CO19.
/**
 * AppendScorecardUseCase appends one lane-performance row for one terminal
 * conducted run to the scorecard (lane CO19). Every dependency is a `Pick` of
 * read methods, except the scorecard's own `append`: the row is derived only
 * from the run record, its attempts, the run journal and the acceptance
 * receipts, and nothing but the scorecard is written. The use case never
 * throws on runtime input; every failure is a typed refusal that carries a
 * reason code and never a path, a store message or a stored value. An
 * unreadable read is a refusal, never an empty row, a zero count or a pass.
 */

import type {
  AppendScorecardPort,
  AppendScorecardRequest,
  AppendScorecardResult,
} from '../ports/in/AppendScorecardPort.in-port.js';
import type { AcceptanceReceiptReadPort, ReadReceiptsForHeadResult } from '../ports/out/AcceptanceReceiptReadPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import {
  LANE_SCORECARD_ID_PATTERN,
  type LaneScorecardFindings,
  type LaneScorecardPort,
  type LaneScorecardRow,
  type LaneScorecardVerificationResult,
} from '../ports/out/LaneScorecardPort.out-port.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import type { AttemptRecord } from '../../domain/execution-records.js';
import type { LaneRunJournalEntryRecord } from '../../domain/lane-run-journal.js';
import { LANE_RUN_ID_PATTERN, type LaneRunRecord } from '../../domain/lane-run-records.js';
import { LANE_RUN_TERMINAL_STATES } from '../../domain/value-objects/LaneRunState.vo.js';

export interface AppendScorecardDependencies {
  readonly runRepo: Pick<LaneRunRepositoryPort, 'get'>;
  readonly attemptRepo: Pick<AttemptRepositoryPort, 'listAttemptsByWorkOrder'>;
  readonly runJournal: Pick<LaneRunJournalPort, 'listForRun'>;
  readonly receipts: Pick<AcceptanceReceiptReadPort, 'readReceiptsForHead'>;
  readonly scorecard: Pick<LaneScorecardPort, 'append' | 'read'>;
}

/** More attempts than this are refused, never read partially. */
export const APPEND_SCORECARD_MAX_ATTEMPTS = 64;

type TerminalState = (typeof LANE_RUN_TERMINAL_STATES)[number];

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** The terminal state a run's journal ends in: the last conduct entry's state; null when none or not terminal. */
export function terminalStateOfJournal(entries: readonly LaneRunJournalEntryRecord[]): TerminalState | null {
  let last: unknown = null;
  for (const entry of entries) {
    if (entry.kind === 'conduct') {
      last = entry.state;
    }
  }
  return typeof last === 'string' && (LANE_RUN_TERMINAL_STATES as readonly string[]).includes(last)
    ? (last as TerminalState)
    : null;
}

/** The run's attempts in `attemptIds` order; null when one of them is missing from the listing. */
export function keepRunAttempts(
  run: Pick<LaneRunRecord, 'attemptIds'>,
  listed: readonly AttemptRecord[],
): readonly AttemptRecord[] | null {
  const kept: AttemptRecord[] = [];
  const seen = new Set<string>();
  for (const attemptId of run.attemptIds) {
    if (seen.has(attemptId)) {
      return null;
    }
    seen.add(attemptId);
    const found = listed.find((attempt) => attempt.id === attemptId);
    if (found === undefined) {
      return null;
    }
    kept.push(found);
  }
  return kept;
}

/** Any fail, else any pass, else any pending, else unknown; only found receipts count. */
export function deriveVerificationResult(
  reads: readonly ReadReceiptsForHeadResult[],
): LaneScorecardVerificationResult {
  const results: string[] = [];
  for (const read of reads) {
    if (read.outcome === 'found') {
      for (const receipt of read.verification) {
        results.push(receipt.result);
      }
    }
  }
  for (const wanted of ['fail', 'pass', 'pending'] as const) {
    if (results.includes(wanted)) {
      return wanted;
    }
  }
  return 'unknown';
}

/** The summed severity counts of the found review receipts; null when a count is not a non-negative safe integer. */
export function sumReviewFindings(reads: readonly ReadReceiptsForHeadResult[]): LaneScorecardFindings | null {
  const sum = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const read of reads) {
    if (read.outcome !== 'found') {
      continue;
    }
    for (const receipt of read.review) {
      for (const severity of ['blocker', 'major', 'minor', 'nit'] as const) {
        const count = receipt.findings[severity];
        if (!isCount(count)) {
          return null;
        }
        sum[severity] += count;
        if (!Number.isSafeInteger(sum[severity])) {
          return null;
        }
      }
    }
  }
  return sum;
}

function instantMs(value: unknown): number | null {
  return isZonedIsoDateTime(value) ? Date.parse(value) : null;
}

/**
 * Milliseconds between the earliest creation and the latest end of the
 * attempts (an attempt ends at its completion receipt, else its last update);
 * null when there is no attempt, a bound is missing or unparseable, or the end
 * precedes the start.
 */
export function deriveDurationMs(attempts: readonly AttemptRecord[]): number | null {
  if (attempts.length === 0) {
    return null;
  }
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const attempt of attempts) {
    const created = instantMs(attempt.createdAtIso);
    const ended = instantMs(attempt.completionReceipt ? attempt.completionReceipt.endedAtIso : attempt.updatedAtIso);
    if (created === null || ended === null) {
      return null;
    }
    start = Math.min(start, created);
    end = Math.max(end, ended);
  }
  const duration = end - start;
  return Number.isSafeInteger(duration) && duration >= 0 ? duration : null;
}

/** True when the attempt with the lowest fixNumber ended with outcome `done`. */
export function deriveFirstPassCompleted(attempts: readonly AttemptRecord[]): boolean {
  let first: AttemptRecord | null = null;
  for (const attempt of attempts) {
    if (first === null || attempt.fixNumber < first.fixNumber) {
      first = attempt;
    }
  }
  return first !== null && first.outcome === 'done';
}

export interface ScorecardRowFacts {
  readonly run: LaneRunRecord;
  readonly finalState: TerminalState;
  readonly attempts: readonly AttemptRecord[];
  readonly receiptReads: readonly ReadReceiptsForHeadResult[];
}

/** The pure row derivation; null when a stored fact is not a value a row may carry. */
export function deriveScorecardRow(facts: ScorecardRowFacts): LaneScorecardRow | null {
  const { run, finalState, attempts, receiptReads } = facts;
  const reviewFindings = sumReviewFindings(receiptReads);
  if (
    reviewFindings === null ||
    typeof run.runId !== 'string' || !LANE_SCORECARD_ID_PATTERN.test(run.runId) ||
    typeof run.workOrderId !== 'string' || !LANE_SCORECARD_ID_PATTERN.test(run.workOrderId) ||
    (run.tier !== 1 && run.tier !== 2) ||
    !isCount(run.round) || !isCount(run.parkCount) ||
    (run.prNumber !== null && !isCount(run.prNumber))
  ) {
    return null;
  }
  return {
    runId: run.runId,
    workOrderId: run.workOrderId,
    tier: run.tier,
    finalState,
    fixRounds: run.round,
    attemptCount: attempts.length,
    parkCount: run.parkCount,
    prNumber: run.prNumber,
    firstPassCompleted: deriveFirstPassCompleted(attempts),
    reviewFindings,
    verificationResult: deriveVerificationResult(receiptReads),
    durationMs: deriveDurationMs(attempts),
  };
}

/** The request's run id when the request is valid; null otherwise. Never throws. */
function validRunIdOf(request: unknown): string | null {
  try {
    if (typeof request !== 'object' || request === null || Array.isArray(request)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(request);
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }
    const { runId, nowIso } = request as Partial<AppendScorecardRequest>;
    if (typeof runId !== 'string' || runId.length === 0 || !LANE_RUN_ID_PATTERN.test(runId)) {
      return null;
    }
    return isZonedIsoDateTime(nowIso) ? runId : null;
  } catch {
    return null;
  }
}

type Guarded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

async function guarded<T>(read: () => Promise<T>): Promise<Guarded<T>> {
  try {
    return { ok: true, value: await read() };
  } catch {
    return { ok: false };
  }
}

const STORES_UNREADABLE: AppendScorecardResult = { outcome: 'refused', reason: 'stores-unreadable' };
const SCORECARD_UNREADABLE: AppendScorecardResult = { outcome: 'refused', reason: 'scorecard-unreadable' };

function rowOfRunIn(rows: readonly LaneScorecardRow[], runId: string): LaneScorecardRow | null {
  return rows.find((row) => row.runId === runId) ?? null;
}

export class AppendScorecardUseCase implements AppendScorecardPort {
  constructor(private readonly deps?: AppendScorecardDependencies) {}

  async appendScorecard(request: AppendScorecardRequest): Promise<AppendScorecardResult> {
    if (!this.deps) {
      throw new Error('Not implemented: AppendScorecardUseCase');
    }
    const deps = this.deps;
    const runId = validRunIdOf(request);
    if (runId === null) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }

    const stored = await this.storedRow(deps, runId);
    if (stored.kind === 'unreadable') {
      return SCORECARD_UNREADABLE;
    }
    if (stored.kind === 'present') {
      return { outcome: 'already-present', row: stored.row };
    }

    const runRead = await guarded(() => deps.runRepo.get(runId));
    if (!runRead.ok) {
      return STORES_UNREADABLE;
    }
    const run = runRead.value;
    if (run === null) {
      return { outcome: 'refused', reason: 'run-not-found' };
    }

    const journalRead = await guarded(async () => terminalStateOfJournal(await deps.runJournal.listForRun(runId)));
    if (!journalRead.ok) {
      return STORES_UNREADABLE;
    }
    const finalState = journalRead.value;
    if (finalState === null) {
      return { outcome: 'refused', reason: 'run-not-terminal' };
    }

    const attemptsRead = await guarded(async () => {
      if (run.runId !== runId || !Array.isArray(run.attemptIds) || run.attemptIds.length > APPEND_SCORECARD_MAX_ATTEMPTS) {
        return null;
      }
      return keepRunAttempts(run, await deps.attemptRepo.listAttemptsByWorkOrder(run.workOrderId));
    });
    if (!attemptsRead.ok || attemptsRead.value === null) {
      return STORES_UNREADABLE;
    }
    const attempts = attemptsRead.value;

    const receiptsRead = await guarded(async () => {
      const reads: ReadReceiptsForHeadResult[] = [];
      for (const attempt of attempts) {
        const headCommit = attempt.artifacts?.headCommit;
        if (typeof headCommit === 'string' && headCommit.length > 0) {
          const read = await deps.receipts.readReceiptsForHead(attempt.id, headCommit);
          if (read.outcome !== 'found' && read.outcome !== 'none') {
            return null;
          }
          reads.push(read);
        }
      }
      return reads;
    });
    if (!receiptsRead.ok || receiptsRead.value === null) {
      return STORES_UNREADABLE;
    }
    const receiptReads = receiptsRead.value;

    const rowDerived = await guarded(async () => deriveScorecardRow({ run, finalState, attempts, receiptReads }));
    if (!rowDerived.ok || rowDerived.value === null) {
      return STORES_UNREADABLE;
    }
    const row = rowDerived.value;

    const appended = await guarded(() => deps.scorecard.append(row));
    if (!appended.ok) {
      return SCORECARD_UNREADABLE;
    }
    const result = appended.value;
    if (result.outcome === 'appended') {
      return { outcome: 'appended', row };
    }
    switch (result.reason) {
      case 'duplicate-run': {
        const recorded = await this.storedRow(deps, runId);
        return recorded.kind === 'present'
          ? { outcome: 'already-present', row: recorded.row }
          : { outcome: 'refused', reason: 'duplicate-run' };
      }
      case 'lock-busy':
        return { outcome: 'refused', reason: 'scorecard-locked' };
      default:
        return SCORECARD_UNREADABLE;
    }
  }

  /** The scorecard's row for the run: present, missing (absent file or no row), or unreadable. */
  private async storedRow(
    deps: AppendScorecardDependencies,
    runId: string,
  ): Promise<
    | { readonly kind: 'present'; readonly row: LaneScorecardRow }
    | { readonly kind: 'missing' }
    | { readonly kind: 'unreadable' }
  > {
    const read = await guarded(() => deps.scorecard.read());
    if (!read.ok || (read.value.outcome !== 'read' && read.value.outcome !== 'absent')) {
      return { kind: 'unreadable' };
    }
    if (read.value.outcome === 'absent') {
      return { kind: 'missing' };
    }
    const row = rowOfRunIn(read.value.rows, runId);
    return row === null ? { kind: 'missing' } : { kind: 'present', row };
  }
}
