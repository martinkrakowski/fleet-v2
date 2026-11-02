/**
 * The JSON state stores work-execution owns, described for `fleet-v2 state`
 * (E1b). Each parser is the one the store's reader uses.
 */
import { describeRecordListStore, describeVersionedRecordListStore, type StateFileDescriptor } from './file-store.js';
import { parseVersionedConductorPassTraceStateRecord } from '../../domain/conductor-pass-trace.js';
import { parseVersionedAttemptStateRecord } from './AttemptRepositoryAdapter.adapter.js';
import { parseConductorDriverLeaseStateRecord } from './ConductorDriverLeaseAdapter.adapter.js';
import { parseConductorHaltStateRecord } from './ConductorHaltAdapter.adapter.js';
import {
  parseVersionedJournalEntryStateRecord,
  parseVersionedReservationStateRecord,
} from './ExecutionJournalAdapter.adapter.js';
import { parseWorkOrderStateRecord } from './WorkOrderRepositoryAdapter.adapter.js';
import { parseVersionedLaneRunStateRecord } from './LaneRunRepositoryAdapter.adapter.js';
import { parseVersionedLaneRunJournalStateRecord } from './LaneRunJournalAdapter.adapter.js';
import { parseTelemetryDispositionStateRecord } from './TelemetryDispositionAdapter.adapter.js';
import { parseMergeQueueStateRecord } from './MergeQueueRepositoryAdapter.adapter.js';
import { isMergeQueueEntryLive } from '../../domain/merge-queue-records.js';
import type { MergeQueueEntryRecord } from '../../domain/merge-queue-records.js';

export const WORK_EXECUTION_STATE_FILES: readonly StateFileDescriptor[] = [
  describeRecordListStore('work-orders.json', parseWorkOrderStateRecord),
  describeVersionedRecordListStore('attempts.json', parseVersionedAttemptStateRecord),
  describeVersionedRecordListStore('journal.json', parseVersionedJournalEntryStateRecord),
  describeVersionedRecordListStore('reservations.json', parseVersionedReservationStateRecord),
  describeVersionedRecordListStore('lane-runs.json', parseVersionedLaneRunStateRecord),
  describeRecordListStore('conductor-driver-lease.json', parseConductorDriverLeaseStateRecord),
  describeRecordListStore('conductor-halt.json', parseConductorHaltStateRecord),
  describeVersionedRecordListStore('run-journal.json', parseVersionedLaneRunJournalStateRecord),
  describeRecordListStore('telemetry-dispositions.json', parseTelemetryDispositionStateRecord),
  describeVersionedRecordListStore('conductor-passes.json', parseVersionedConductorPassTraceStateRecord),
  describeRecordListStore('merge-queue.json', parseMergeQueueStateRecord, duplicateMergeQueueIdentityListError),
];

/** A fixed detail when two live merge-queue records share (repository, pull request, head). */
function duplicateMergeQueueIdentityListError(records: readonly MergeQueueEntryRecord[]): string | undefined {
  for (let leftIndex = 0; leftIndex < records.length; leftIndex += 1) {
    const left = records[leftIndex];
    if (!isMergeQueueEntryLive(left)) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < records.length; rightIndex += 1) {
      const right = records[rightIndex];
      if (!isMergeQueueEntryLive(right)) {
        continue;
      }
      if (
        left.repository.owner === right.repository.owner &&
        left.repository.repo === right.repository.repo &&
        left.pullRequest === right.pullRequest &&
        left.headOid === right.headOid
      ) {
        return 'duplicate live merge-queue identity';
      }
    }
  }
  return undefined;
}
