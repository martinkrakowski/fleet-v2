/**
 * The JSON state stores work-execution owns, described for `fleet-v2 state`
 * (E1b). Each parser is the one the store's reader uses.
 */
import { describeRecordListStore, describeVersionedRecordListStore, type StateFileDescriptor } from './file-store.js';
import { parseConductorPassTraceStateRecord } from '../../domain/conductor-pass-trace.js';
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
  describeRecordListStore('conductor-passes.json', parseConductorPassTraceStateRecord),
];
