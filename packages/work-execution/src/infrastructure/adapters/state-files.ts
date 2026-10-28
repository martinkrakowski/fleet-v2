/**
 * The JSON state stores work-execution owns, described for `fleet-v2 state`
 * (E1b). Each parser is the one the store's reader uses.
 */
import { describeRecordListStore, type StateFileDescriptor } from './file-store.js';
import { parseAttemptStateRecord } from './AttemptRepositoryAdapter.adapter.js';
import { parseConductorDriverLeaseStateRecord } from './ConductorDriverLeaseAdapter.adapter.js';
import { parseConductorHaltStateRecord } from './ConductorHaltAdapter.adapter.js';
import {
  parseJournalEntryStateRecord,
  parseReservationStateRecord,
} from './ExecutionJournalAdapter.adapter.js';
import { parseWorkOrderStateRecord } from './WorkOrderRepositoryAdapter.adapter.js';
import { parseLaneRunStateRecord } from './LaneRunRepositoryAdapter.adapter.js';
import { parseLaneRunJournalStateRecord } from './LaneRunJournalAdapter.adapter.js';

export const WORK_EXECUTION_STATE_FILES: readonly StateFileDescriptor[] = [
  describeRecordListStore('work-orders.json', parseWorkOrderStateRecord),
  describeRecordListStore('attempts.json', parseAttemptStateRecord),
  describeRecordListStore('journal.json', parseJournalEntryStateRecord),
  describeRecordListStore('reservations.json', parseReservationStateRecord),
  describeRecordListStore('lane-runs.json', parseLaneRunStateRecord),
  describeRecordListStore('conductor-driver-lease.json', parseConductorDriverLeaseStateRecord),
  describeRecordListStore('conductor-halt.json', parseConductorHaltStateRecord),
  describeRecordListStore('run-journal.json', parseLaneRunJournalStateRecord),
];
