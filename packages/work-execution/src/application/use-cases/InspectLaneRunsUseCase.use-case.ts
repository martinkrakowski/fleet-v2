/**
 * InspectLaneRunsUseCase: a read-only status view of one lane run or every
 * run (plan §3.8), plus the state directory's halt marker and the driver
 * lease (plan §3.7). Every fact is projected from stored records and the
 * keyed journal; no port method that writes is in its dependencies, so the
 * inspection cannot change anything.
 */

import type {
  InspectLaneRunsPort,
  InspectLaneRunsRequest,
  InspectLaneRunsResult,
  LaneRunStatusView,
} from '../ports/in/InspectLaneRunsPort.in-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { ConductorHaltPort } from '../ports/out/ConductorHaltPort.out-port.js';
import type { ConductorDriverLeasePort } from '../ports/out/ConductorDriverLeasePort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ReviewRequestPort } from '../ports/out/ReviewRequestPort.out-port.js';
import type { LaneRunLeaseRecord, LaneRunRecord } from '../../domain/lane-run-records.js';
import type { LaneRunParkFindingView } from '../../domain/park-findings-view.js';
import { boundedFindingsView } from '../../domain/park-findings-view.js';
import type { LaneRunJournalEntryRecord } from '../../domain/lane-run-journal.js';
import { laneRunJournalPendingIntent, laneRunJournalState, laneRunJournalStopFacts } from '../../domain/lane-run-journal.js';
import { parseLaneRunKey } from '../../domain/lane-run-keys.js';
import { resolveLaneRunBaseBranch } from '../../domain/base-branch.js';
import { isLeaseLapsed } from '../../domain/lane-run-lease.js';

export interface InspectLaneRunsDependencies {
  readonly runRepo: Pick<LaneRunRepositoryPort, 'get' | 'list'>;
  readonly runJournal: Pick<LaneRunJournalPort, 'listForRun'>;
  readonly halt: Pick<ConductorHaltPort, 'read'>;
  readonly driverLease: Pick<ConductorDriverLeasePort, 'read'>;
  /** Read the parked head's latest code-review receipt (GB2); optional so unwired callers keep today's shape. */
  readonly attemptRepo?: Pick<AttemptRepositoryPort, 'findAttemptById'>;
  readonly reviewReceipts?: Pick<ReviewRequestPort, 'findLatestReceiptOfKind'>;
}

/** A run lease record with its lapsed flag; null stays null. */
function leaseView(lease: LaneRunLeaseRecord | null, nowIso: string): LaneRunStatusView['lease'] {
  if (lease === null) {
    return null;
  }
  return {
    holderId: lease.holderId,
    fence: lease.fence,
    leaseUntilIso: lease.leaseUntilIso,
    lapsed: isLeaseLapsed(lease, nowIso),
  };
}

/** Fallback receipt read when the parked record does not carry a saved snapshot. */
async function fallbackReviewFindings(
  deps: InspectLaneRunsDependencies,
  record: LaneRunRecord,
): Promise<readonly LaneRunParkFindingView[]> {
  const attemptRepo = deps.attemptRepo;
  const reviewReceipts = deps.reviewReceipts;
  if (attemptRepo === undefined || reviewReceipts === undefined) {
    return [];
  }
  const attemptId = record.attemptIds.length === 0 ? null : record.attemptIds[record.attemptIds.length - 1];
  if (attemptId === null) {
    return [];
  }
  try {
    const attempt = await attemptRepo.findAttemptById(attemptId);
    const head = attempt?.artifacts?.headCommit;
    if (attempt === null || head === undefined) {
      return [];
    }
    const found = await reviewReceipts.findLatestReceiptOfKind({
      attemptId,
      candidateHeadSha: head,
      kind: 'code-review',
    });
    if (found.outcome !== 'found' || found.receipt.verdict !== 'failed') {
      return [];
    }
    return boundedFindingsView(found.receipt.findings);
  } catch {
    return [];
  }
}

/** The bounded findings of the parked head's failed code review; `null` when not a blocker park. */
async function blockedReviewFindings(
  deps: InspectLaneRunsDependencies,
  record: LaneRunRecord,
): Promise<readonly LaneRunParkFindingView[] | null> {
  const parked = record.parked;
  if (parked === null || parked.reason !== 'blocker-after-round-2') {
    return null;
  }
  if (parked.findings === undefined) {
    return fallbackReviewFindings(deps, record);
  }
  if (parked.findings === null) {
    return [];
  }
  return boundedFindingsView(parked.findings);
}

/**
 * The fixed refusal detail of a `step-refused` park (GB3a): the detail of the
 * run's last final result on the park's qualifier step, or null when there is
 * none. The park's qualifier is never matched against a result of another step.
 */
function parkRefusalDetailOf(record: LaneRunRecord, entries: readonly LaneRunJournalEntryRecord[]): string | null {
  const parked = record.parked;
  if (parked === null || parked.reason !== 'step-refused' || parked.qualifier === null) {
    return null;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind !== 'result' || entry.runId !== record.runId || entry.outcome === 'ambiguous') {
      continue;
    }
    const parsed = entry.key === null ? null : parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'step' || parsed.step !== parked.qualifier) {
      continue;
    }
    // GB3c: a later result of the qualifier step whose detail is null or a
    // `next-seat-` seat-advance token does not express the refusal that
    // parked the run — keep scanning back for the refusal detail.
    if (entry.detail === null || entry.detail.startsWith('next-seat-')) {
      continue;
    }
    return entry.detail;
  }
  return null;
}

/**
 * F62: the detail of the run's last gate result for a run parked `ambiguous`
 * at the gate — the fixed token that says why the gate read was unknown. The
 * gate's result is `ambiguous`, so it is not a final result and the
 * step-refused scan never sees it.
 */
function parkGateDetailOf(record: LaneRunRecord, entries: readonly LaneRunJournalEntryRecord[]): string | null {
  const parked = record.parked;
  if (parked === null || parked.reason !== 'ambiguous' || parked.qualifier !== 'gate') {
    return null;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind !== 'result' || entry.runId !== record.runId || entry.key === null) {
      continue;
    }
    if (entry.reasonCode !== 'gate-unknown') {
      continue;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'step' || parsed.step !== 'gate') {
      continue;
    }
    return entry.detail;
  }
  return null;
}

/** The status view of one run from its record and journal. */
async function statusViewOf(
  deps: InspectLaneRunsDependencies,
  record: LaneRunRecord,
  entries: readonly LaneRunJournalEntryRecord[],
  nowIso: string,
): Promise<LaneRunStatusView> {
  const stopFacts = laneRunJournalStopFacts(entries, record.runId);
  const pendingIntent = laneRunJournalPendingIntent(entries, record.runId);
  const reviewFindings = await blockedReviewFindings(deps, record);
  const parkDetail = parkRefusalDetailOf(record, entries) ?? parkGateDetailOf(record, entries);
  return {
    runId: record.runId,
    workOrderId: record.workOrderId,
    /** The run's base branch, copied at start (lane CB1). */
    baseBranch: resolveLaneRunBaseBranch(record),
    tier: record.tier,
    state: laneRunJournalState(entries, record.runId),
    round: record.round,
    revision: record.revision,
    parked: record.parked,
    reviewFindings,
    ...(parkDetail !== null ? { parkDetail } : {}),
    parkCount: record.parkCount,
    stopMode: stopFacts.stopMode,
    stopRequestedAtIso: stopFacts.stopRequestedAtIso,
    pendingIntent,
    latestAttemptId: record.attemptIds.length === 0 ? null : record.attemptIds[record.attemptIds.length - 1],
    attemptCount: record.attemptIds.length,
    prNumber: record.prNumber,
    lease: leaseView(record.lease, nowIso),
  };
}

export class InspectLaneRunsUseCase implements InspectLaneRunsPort {
  constructor(private readonly deps: InspectLaneRunsDependencies) {}

  async inspectLaneRuns(request: InspectLaneRunsRequest): Promise<InspectLaneRunsResult> {
    const [halt, driver] = await Promise.all([
      this.deps.halt.read(),
      this.deps.driverLease.read(),
    ]);

    const records = request.runId === undefined
      ? await this.deps.runRepo.list()
      : [await this.deps.runRepo.get(request.runId)];

    if (request.runId !== undefined && records[0] === null) {
      return { outcome: 'not-found', runId: request.runId };
    }

    const known = records.filter((record): record is LaneRunRecord => record !== null);
    // The journals are independent reads, collected with Promise.all over a map.
    const journals = await Promise.all(
      known.map((record) => this.deps.runJournal.listForRun(record.runId)),
    );

    const driverLease = driver === null ? null : {
      holderId: driver.holderId,
      fence: driver.fence,
      leaseUntilIso: driver.leaseUntilIso,
      lapsed: isLeaseLapsed(driver, request.nowIso),
    };

    const runs = await Promise.all(
      known.map((record, index) => statusViewOf(this.deps, record, journals[index], request.nowIso)),
    );

    return {
      outcome: 'listed',
      halt: halt.state,
      driver: driverLease,
      runs,
    };
  }
}
