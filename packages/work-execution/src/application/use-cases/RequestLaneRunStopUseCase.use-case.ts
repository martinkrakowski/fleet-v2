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
  RequestLaneRunStopRequest,
  RequestLaneRunStopResult,
} from '../ports/in/RequestLaneRunStopPort.in-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type {
  LaneRunJournalPort,
  LaneRunJournalAppendResult,
} from '../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunJournalEntryRecord } from '../../domain/lane-run-journal.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import {
  laneRunStopForceKey,
  laneRunStopKey,
  REQUEST_ID_PATTERN,
} from '../../domain/lane-run-keys.js';
import { LANE_RUN_ID_PATTERN } from '../../domain/lane-run-records.js';
import { LANE_RUN_JOURNAL_ENTRY_VERSION } from '../../domain/lane-run-journal.js';
import { LANE_RUN_TERMINAL_STATES } from '../../domain/value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from '../../domain/value-objects/LaneRunState.vo.js';
import { laneRunJournalState } from '../../domain/lane-run-journal.js';

export interface RequestLaneRunStopDependencies {
  readonly runRepo: Pick<LaneRunRepositoryPort, 'get'>;
  readonly runJournal: LaneRunJournalPort;
}

/** The exact own keys a stop request may carry; anything else refuses. */
const REQUEST_KEYS: readonly string[] = ['runId', 'mode', 'via', 'expectedRevision', 'entryId', 'nowIso'];

/**
 * Snapshot the caller's input and validate every field before any store is
 * touched, so a malformed request never reaches `formatLaneRunStopKey` (which
 * could throw) and no refusal ever echoes an unvalidated string (F96). A
 * value present but `undefined` reads as omitted, exactly as the typed port
 * documents for `expectedRevision`.
 */
function validatedRequest(
  request: RequestLaneRunStopRequest,
): { readonly ok: true; readonly request: RequestLaneRunStopRequest } | { readonly ok: false } {
  let snapshot: Record<string, unknown> | null;
  try {
    snapshot = snapshotPlainDataRecord(request);
  } catch {
    return { ok: false };
  }
  if (snapshot === null) {
    return { ok: false };
  }
  const keys = Object.keys(snapshot);
  const required = REQUEST_KEYS.filter((key) => key !== 'expectedRevision');
  if (!keys.every((key) => REQUEST_KEYS.includes(key)) || !required.every((key) => Object.hasOwn(snapshot!, key))) {
    return { ok: false };
  }
  const runId = snapshot.runId;
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
    return { ok: false };
  }
  const mode = snapshot.mode;
  if (mode !== 'graceful' && mode !== 'force') {
    return { ok: false };
  }
  const via = snapshot.via;
  if (via !== 'cli' && via !== 'web') {
    return { ok: false };
  }
  const expectedRevision = snapshot.expectedRevision;
  if (
    expectedRevision !== undefined &&
    (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
  ) {
    return { ok: false };
  }
  const entryId = snapshot.entryId;
  if (typeof entryId !== 'string' || !REQUEST_ID_PATTERN.test(entryId)) {
    return { ok: false };
  }
  const nowIso = snapshot.nowIso;
  if (typeof nowIso !== 'string' || nowIso.length > 64 || !isZonedIsoDateTime(nowIso)) {
    return { ok: false };
  }
  return {
    ok: true,
    request: {
      runId,
      mode,
      via,
      ...(expectedRevision === undefined ? {} : { expectedRevision: expectedRevision as number }),
      entryId,
      nowIso,
    },
  };
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
    detail: null,
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
  constructor(private readonly deps?: RequestLaneRunStopDependencies) {}

  async requestLaneRunStop(request: RequestLaneRunStopRequest): Promise<RequestLaneRunStopResult> {
    if (!this.deps) {
      throw new Error('Not implemented: RequestLaneRunStopUseCase');
    }

    const validated = validatedRequest(request);
    if (!validated.ok) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const stopRequest = validated.request;

    const record = await this.deps.runRepo.get(stopRequest.runId);
    if (record === null) {
      return { outcome: 'not-found', runId: stopRequest.runId };
    }

    const entries = await this.deps.runJournal.listForRun(stopRequest.runId);
    const state: LaneRunStateValue = laneRunJournalState(entries, stopRequest.runId);
    if ((LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state)) {
      return { outcome: 'refused', reason: 'run-terminal' };
    }

    const expected = stopRequest.expectedRevision ?? record.revision;
    if (expected !== record.revision) {
      return { outcome: 'refused', reason: 'stale-revision' };
    }

    const built = stopRequest.mode === 'force'
      ? laneRunStopForceKey(stopRequest.runId, stopRequest.via)
      : laneRunStopKey(stopRequest.runId, stopRequest.via);
    if (!built.ok) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const key = built.key;

    const appended = await this.deps.runJournal.append(
      stopIntentEntry(stopRequest, key, expected),
    );
    return appendOutcome(stopRequest, appended, key);
  }
}
