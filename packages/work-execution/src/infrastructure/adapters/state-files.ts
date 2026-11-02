/**
 * The JSON state stores work-execution owns, described for `fleet-v2 state`
 * (E1b). Each parser is the one the store's reader uses.
 */
import { describeRecordListStore, describeVersionedRecordListStore, type StateFileDescriptor } from './file-store.js';
import { parseVersionedConductorPassTraceStateRecord } from '../../domain/conductor-pass-trace.js';
import { parseVersionedAttemptStateRecord } from './AttemptRepositoryAdapter.adapter.js';
import { parseConductorDriverLeaseStateRecord } from './ConductorDriverLeaseAdapter.adapter.js';
import { parseConductorHaltStateRecord } from './ConductorHaltAdapter.adapter.js';
import { parseKillallHaltMarkerStateRecord } from './KillallHaltMarkerAdapter.adapter.js';
import { parseKillallTrainPauseStateRecord } from './KillallTrainPauseAdapter.adapter.js';
import {
  parseVersionedJournalEntryStateRecord,
  parseVersionedReservationStateRecord,
} from './ExecutionJournalAdapter.adapter.js';
import { parseWorkOrderStateRecord } from './WorkOrderRepositoryAdapter.adapter.js';
import { parseVersionedLaneRunStateRecord } from './LaneRunRepositoryAdapter.adapter.js';
import { parseVersionedLaneRunJournalStateRecord } from './LaneRunJournalAdapter.adapter.js';
import { parseVersionedLanePlanStateRecord } from './LanePlanRepositoryAdapter.adapter.js';
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
  describeVersionedRecordListStore('lane-plans.json', parseVersionedLanePlanStateRecord),
  describeRecordListStore('telemetry-dispositions.json', parseTelemetryDispositionStateRecord),
  describeVersionedRecordListStore('conductor-passes.json', parseVersionedConductorPassTraceStateRecord),
  describeRecordListStore('killall-halt.json', parseKillallHaltMarkerStateRecord),
  describeRecordListStore('killall-train-pause.json', parseKillallTrainPauseStateRecord),
];
