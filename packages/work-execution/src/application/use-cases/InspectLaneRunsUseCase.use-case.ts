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
import type { LaneRunLeaseRecord, LaneRunRecord } from '../../domain/lane-run-records.js';
import type { LaneRunJournalEntryRecord } from '../../domain/lane-run-journal.js';
import { laneRunJournalPendingIntent, laneRunJournalState, laneRunJournalStopFacts } from '../../domain/lane-run-journal.js';
import { resolveLaneRunBaseBranch } from '../../domain/base-branch.js';
import { isLeaseLapsed } from '../../domain/lane-run-lease.js';

export interface InspectLaneRunsDependencies {
  readonly runRepo: Pick<LaneRunRepositoryPort, 'get' | 'list'>;
  readonly runJournal: Pick<LaneRunJournalPort, 'listForRun'>;
  readonly halt: Pick<ConductorHaltPort, 'read'>;
  readonly driverLease: Pick<ConductorDriverLeasePort, 'read'>;
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

/** The status view of one run from its record and journal. */
function statusViewOf(record: LaneRunRecord, entries: readonly LaneRunJournalEntryRecord[], nowIso: string): LaneRunStatusView {
  const stopFacts = laneRunJournalStopFacts(entries, record.runId);
  const pendingIntent = laneRunJournalPendingIntent(entries, record.runId);
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

    return {
      outcome: 'listed',
      halt: halt.state,
      driver: driverLease,
      runs: known.map((record, index) => statusViewOf(record, journals[index], request.nowIso)),
    };
  }
}
