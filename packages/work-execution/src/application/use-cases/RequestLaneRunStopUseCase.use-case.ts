/**
 * RequestLaneRunStopUseCase: records a graceful or forced stop for one lane
 * run as a keyed run-journal intent (plan §3.8, §3.9.1), with the typed
 * outcomes the CLI maps to exit codes (K1b: `already-requested` exits 0). The
 * record is the stop; the driver obeys it on its next advance (K4-6), so this
 * use case never calls StopAttempt and never takes a run lease.
 *
 * The revision check and the append are not one atomic step: a save between
 * them is harmless, because the driver reads the stop on its next advance
 * whatever the revision.
 */

import type {
  RequestLaneRunStopPort,
  RequestLaneRunStopRefusal,
  RequestLaneRunStopRequest,
  RequestLaneRunStopResult,
} from '../ports/in/RequestLaneRunStopPort.in-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type {
  LaneRunJournalPort,
  LaneRunJournalAppendResult,
} from '../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunJournalEntryRecord } from '../../domain/lane-run-journal.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';import {
  LANE_RUN_KEY_VIAS,
  laneRunStopForceKey,
  laneRunStopKey,
} from '../../domain/lane-run-keys.js';
import { LANE_RUN_JOURNAL_ENTRY_VERSION } from '../../domain/lane-run-journal.js';
import { RUN_STOP_MODES } from '../../domain/lane-run-transitions.js';
import { LANE_RUN_TERMINAL_STATES } from '../../domain/value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from '../../domain/value-objects/LaneRunState.vo.js';
import { laneRunJournalState } from '../../domain/lane-run-journal.js';

export interface RequestLaneRunStopDependencies {
  readonly runRepo: Pick<LaneRunRepositoryPort, 'get'>;
  readonly runJournal: LaneRunJournalPort;
}

function isPositiveSafeInteger(value: number | undefined): boolean {
  return value !== undefined && Number.isSafeInteger(value) && value >= 1;
}

function stopRequestError(request: RequestLaneRunStopRequest): RequestLaneRunStopRefusal | null {
  if (!RUN_STOP_MODES.includes(request.mode)) {
    return 'invalid-request';
  }
  if (!LANE_RUN_KEY_VIAS.includes(request.via)) {
    return 'invalid-request';
  }
  if (request.expectedRevision !== undefined && !isPositiveSafeInteger(request.expectedRevision)) {
    return 'invalid-request';
  }
  if (!isZonedIsoDateTime(request.nowIso)) {
    return 'invalid-request';
  }
  return null;
}

/** The journal entry of a stop intent: every field null except the stop's own. */
function stopIntentEntry(
  request: RequestLaneRunStopRequest,
  key: string,
  expectedRevision: number,
): LaneRunJournalEntryRecord {
  return {
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: request.entryId,
    kind: 'intent',
    key,
    runId: request.runId,
    recordedAtIso: request.nowIso,
    mode: request.mode,
    expectedRevision,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    grantId: null,
    state: null,
  };
}

function appendOutcome(
  request: RequestLaneRunStopRequest,
  result: LaneRunJournalAppendResult,
  key: string,
): RequestLaneRunStopResult {
  if (result.outcome === 'appended') {
    return { outcome: 'stop-recorded', runId: request.runId, mode: request.mode, key };
  }
  if (result.reason === 'stop-already-requested' || result.reason === 'duplicate-key') {
    return { outcome: 'already-requested', runId: request.runId, mode: request.mode };
  }
  if (result.reason === 'stop-already-forced') {
    return { outcome: 'refused', reason: 'stop-already-forced' };
  }
  return { outcome: 'refused', reason: 'journal-refused' };
}

export class RequestLaneRunStopUseCase implements RequestLaneRunStopPort {
  constructor(private readonly deps: RequestLaneRunStopDependencies) {}

  async requestLaneRunStop(request: RequestLaneRunStopRequest): Promise<RequestLaneRunStopResult> {
    const invalid = stopRequestError(request);
    if (invalid !== null) {
      return { outcome: 'refused', reason: invalid };
    }

    const record = await this.deps.runRepo.get(request.runId);
    if (record === null) {
      return { outcome: 'not-found', runId: request.runId };
    }

    const entries = await this.deps.runJournal.listForRun(request.runId);
    const state: LaneRunStateValue = laneRunJournalState(entries, request.runId);
    if ((LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state)) {
      return { outcome: 'refused', reason: 'run-terminal' };
    }

    const expected = request.expectedRevision ?? record.revision;
    if (expected !== record.revision) {
      return { outcome: 'refused', reason: 'stale-revision' };
    }

    const built = request.mode === 'force'
      ? laneRunStopForceKey(request.runId, request.via)
      : laneRunStopKey(request.runId, request.via);
    if (!built.ok) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const key = built.key;

    const appended = await this.deps.runJournal.append(
      stopIntentEntry(request, key, expected),
    );
    return appendOutcome(request, appended, key);
  }
}
