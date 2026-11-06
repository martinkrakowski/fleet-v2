/**
 * The JSON state stores work-execution owns, described for `fleet-v2 state`
 * (E1b). Each parser is the one the store's reader uses.
 */
import {
  describeJsonlProjection,
  describeRecordGlob,
  describeRecordListStore,
  describeSingleRecordStore,
  describeVersionedRecordListStore,
  type SingleRecordInspection,
  type StateFileDescriptor,
} from './file-store.js';
import {
  readDaemonLeaseRecord,
  readDaemonPauseRecord,
  readDaemonStatusRecord,
  type DaemonLeaseRecord,
  type DaemonPauseRecord,
  type DaemonStatusRecord,
} from '../../domain/daemon-tick.js';
import { readDaemonEventLine } from '../../domain/daemon-events.js';
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
import { parseVersionedSeatTicketStateRecord } from './SeatTicketRepositoryAdapter.adapter.js';
import type { SeatTicketRecord } from '../../domain/execution-records.js';
import { parseVersionedSeatObservationStateRecord } from './SeatObservationRepositoryAdapter.adapter.js';
import { parseTelemetryDispositionStateRecord } from './TelemetryDispositionAdapter.adapter.js';
import {
  duplicateMergeQueueIdentityListError,
  parseMergeQueueStateRecord,
} from './MergeQueueRepositoryAdapter.adapter.js';

/** A single-record inspection that preserves the daemon readers' unknown-version refusal. */
function inspectSingleDaemonStatusRecord(raw: unknown): SingleRecordInspection<DaemonStatusRecord> {
  const read = readDaemonStatusRecord(raw);
  if (read.ok) {
    return { status: 'ok', record: read.record };
  }
  return read.reason === 'unknown-version'
    ? { status: 'unknown-version', detail: read.error }
    : { status: 'unreadable', detail: read.error };
}

/** A single-record inspection for the pause marker, preserving unknown-version. */
function inspectSingleDaemonPauseRecord(raw: unknown): SingleRecordInspection<DaemonPauseRecord> {
  const read = readDaemonPauseRecord(raw);
  if (read.ok) {
    return { status: 'ok', record: read.record };
  }
  return read.reason === 'unknown-version'
    ? { status: 'unknown-version', detail: read.error }
    : { status: 'unreadable', detail: read.error };
}

/** A single-record inspection for one lease file, preserving unknown-version. */
function inspectSingleDaemonLeaseRecord(raw: unknown): SingleRecordInspection<DaemonLeaseRecord> {
  const read = readDaemonLeaseRecord(raw);
  if (read.ok) {
    return { status: 'ok', record: read.record };
  }
  return read.reason === 'unknown-version'
    ? { status: 'unknown-version', detail: read.error }
    : { status: 'unreadable', detail: read.error };
}

/** The seat ticket reader refuses two records for one (project, role); `state check` must agree. */
function duplicateSeatTicketKeyListError(records: readonly SeatTicketRecord[]): string | undefined {
  const seen = new Set<string>();
  for (const record of records) {
    const key = `${record.projectId}\u0000${record.role}`;
    if (seen.has(key)) {
      return 'duplicate seat ticket key';
    }
    seen.add(key);
  }
  return undefined;
}

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
  describeSingleRecordStore('daemon/status.json', inspectSingleDaemonStatusRecord),
  describeSingleRecordStore('daemon/paused.json', inspectSingleDaemonPauseRecord),
  describeRecordGlob('daemon/leases', inspectSingleDaemonLeaseRecord),
  describeJsonlProjection('daemon/events.jsonl', readDaemonEventLine),
  describeRecordListStore('merge-queue.json', parseMergeQueueStateRecord, duplicateMergeQueueIdentityListError),
  describeRecordListStore('killall-halt.json', parseKillallHaltMarkerStateRecord),
  describeRecordListStore('killall-train-pause.json', parseKillallTrainPauseStateRecord),
  describeVersionedRecordListStore(
    'seat-tickets.json',
    parseVersionedSeatTicketStateRecord,
    duplicateSeatTicketKeyListError,
  ),
  describeVersionedRecordListStore('seat-observations.json', parseVersionedSeatObservationStateRecord),
];
