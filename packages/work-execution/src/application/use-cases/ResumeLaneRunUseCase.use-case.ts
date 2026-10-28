/**
 * ResumeLaneRunUseCase: resumes a parked lane run as a record the driver
 * obeys (plan §3.8). The requester never writes the run: `requestResume`
 * validates against the plan's resume refusals and journals one intent under
 * the park's resume key with the revision the requester read. The driver
 * applies a recorded resume under its run lease through `applyPendingResume`:
 * conduct entry to the parked-from state first, then the record saved with no
 * park, then the result, so a crash between them is repaired by
 * AdvanceLaneRun's park-exit repair (K4-4a). A stop recorded after the
 * request still wins, and the CLI never takes a run lease.
 */

import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { laneRunJournalState, laneRunJournalStopFacts } from '../../domain/lane-run-journal.js';
import type { LaneRunJournalEntryRecord, LaneRunJournalOutcome } from '../../domain/lane-run-journal.js';
import { LANE_RUN_KEY_VIAS, laneRunResumeKey } from '../../domain/lane-run-keys.js';
import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import { laneRunConductEntry, laneRunIntentEntry, laneRunResultEntry } from '../../domain/lane-run-step-facts.js';
import type { LaneRunResultReasonCode } from '../../domain/lane-run-step-facts.js';
import { checkLaneRunResume } from '../../domain/lane-run-transitions.js';
import type { RunStopMode } from '../../domain/lane-run-transitions.js';
import type { LaneRunStateValue } from '../../domain/value-objects/LaneRunState.vo.js';
import type {
  ApplyPendingResumeRequest,
  ApplyPendingResumeResult,
  RequestResumeRequest,
  RequestResumeResult,
  ResumeLaneRunPort,
} from '../ports/in/ResumeLaneRunPort.in-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';

export interface ResumeLaneRunDependencies {
  readonly runRepo: Pick<LaneRunRepositoryPort, 'get' | 'save'>;
  readonly runJournal: LaneRunJournalPort;
  /** A fresh ULID per call (conduct and result entry ids). */
  readonly newUlid: () => string;
}

interface ResumeFacts {
  readonly entries: readonly LaneRunJournalEntryRecord[];
  readonly state: LaneRunStateValue;
  readonly stopMode: RunStopMode | null;
}

function isPositiveSafeInteger(value: number | undefined): boolean {
  return value !== undefined && Number.isSafeInteger(value) && value >= 1;
}

function requestResumeError(request: RequestResumeRequest): 'invalid-request' | null {
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

export class ResumeLaneRunUseCase implements ResumeLaneRunPort {
  constructor(private readonly deps: ResumeLaneRunDependencies) {}

  /** The run's journal entries, projected state and strongest stop: the facts both methods check against. */
  private async resumeFacts(record: LaneRunRecord): Promise<ResumeFacts> {
    const entries = await this.deps.runJournal.listForRun(record.runId);
    return {
      entries,
      state: laneRunJournalState(entries, record.runId),
      stopMode: laneRunJournalStopFacts(entries, record.runId).stopMode,
    };
  }

  /** The resume intent entry: every field null except the resume's own. */
  private resumeIntentEntry(
    request: RequestResumeRequest,
    key: string,
    expectedRevision: number,
  ): LaneRunJournalEntryRecord {
    return {
      ...laneRunIntentEntry(request.entryId, request.runId, key, null, request.nowIso),
      expectedRevision,
    };
  }

  /** The pending resume intents of the run's current park, earliest first; [] when none. */
  private async pendingResumeIntents(
    record: LaneRunRecord,
  ): Promise<readonly LaneRunJournalEntryRecord[]> {
    const webKey = laneRunResumeKey(record.runId, record.parkCount, 'web');
    const cliKey = laneRunResumeKey(record.runId, record.parkCount, 'cli');
    if (!webKey.ok || !cliKey.ok) {
      return [];
    }
    const [webEntries, cliEntries] = await Promise.all([
      this.deps.runJournal.listForKey(webKey.key),
      this.deps.runJournal.listForKey(cliKey.key),
    ]);
    const all = [...webEntries, ...cliEntries];
    const finalKeys = new Set<string>();
    for (const entry of all) {
      if (entry.kind === 'result' && entry.outcome !== 'ambiguous' && entry.key !== null) {
        finalKeys.add(entry.key);
      }
    }
    return all
      .filter((entry) => entry.kind === 'intent' && entry.key !== null && !finalKeys.has(entry.key))
      .sort(
        (left, right) =>
          left.recordedAtIso.localeCompare(right.recordedAtIso) ||
          left.entryId.localeCompare(right.entryId),
      );
  }

  private async appendResult(
    runId: string,
    key: string,
    outcome: LaneRunJournalOutcome,
    reasonCode: LaneRunResultReasonCode,
    nowIso: string,
  ): Promise<boolean> {
    const appended = await this.deps.runJournal.append(
      laneRunResultEntry(this.deps.newUlid(), runId, key, outcome, reasonCode, nowIso),
    );
    return appended.outcome === 'appended';
  }

  async requestResume(request: RequestResumeRequest): Promise<RequestResumeResult> {
    if (requestResumeError(request) !== null) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }

    const record = await this.deps.runRepo.get(request.runId);
    if (record === null) {
      return { outcome: 'not-found', runId: request.runId };
    }

    const facts = await this.resumeFacts(record);
    const expected = request.expectedRevision ?? record.revision;
    const check = checkLaneRunResume({
      record,
      state: facts.state,
      stopMode: facts.stopMode,
      expectedRevision: expected,
    });
    if (!check.ok) {
      return { outcome: 'refused', reason: check.reason };
    }

    const built = laneRunResumeKey(request.runId, record.parkCount, request.via);
    if (!built.ok) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const key = built.key;

    const appended = await this.deps.runJournal.append(this.resumeIntentEntry(request, key, expected));
    if (appended.outcome === 'appended') {
      return { outcome: 'resume-recorded', runId: request.runId, to: check.to, key };
    }
    if (appended.reason === 'duplicate-key') {
      return { outcome: 'already-requested', runId: request.runId, key };
    }
    return { outcome: 'refused', reason: 'journal-refused' };
  }

  async applyPendingResume(request: ApplyPendingResumeRequest): Promise<ApplyPendingResumeResult> {
    const record = await this.deps.runRepo.get(request.runId);
    if (record === null) {
      return { outcome: 'refused', key: null, reason: 'run-not-found' };
    }

    const pending = await this.pendingResumeIntents(record);
    if (pending.length === 0) {
      return { outcome: 'none' };
    }

    const facts = await this.resumeFacts(record);

    // A resume whose save landed before a crash: the record is already
    // unparked, so every pending intent is settled as reconciled and the exit
    // is already complete.
    if (record.parked === null) {
      for (const intent of pending) {
        await this.appendResult(request.runId, intent.key as string, 'reconciled', 'resumed', request.nowIso);
      }
      return { outcome: 'none' };
    }

    const first = pending[0];
    const firstPendingKey = first.key as string;

    // The conduct landed but the save did not (a crash, or a refused save): the journal already left the
    // park for its parked-from state while the record is still parked. Finish that exit here, so the
    // intent is settled as resumed and never refused as not-parked ahead of the repair.
    if (facts.state === record.parked.parkedFrom) {
      const finished = await this.deps.runRepo.save(
        { ...record, parked: null, revision: record.revision + 1 },
        { holderId: request.lease.holderId, fence: request.lease.fence, nowIso: request.nowIso },
      );
      if (finished.outcome !== 'saved') {
        return { outcome: 'refused', key: firstPendingKey, reason: 'save-refused' };
      }
      if (!(await this.appendResult(request.runId, firstPendingKey, 'reconciled', 'resumed', request.nowIso))) {
        return { outcome: 'refused', key: firstPendingKey, reason: 'journal-refused' };
      }
      for (const intent of pending.slice(1)) {
        await this.appendResult(request.runId, intent.key as string, 'refused', 'not-parked', request.nowIso);
      }
      return { outcome: 'resumed', to: record.parked.parkedFrom, key: firstPendingKey };
    }

    const check = checkLaneRunResume({
      record,
      state: facts.state,
      stopMode: facts.stopMode,
      expectedRevision: first.expectedRevision ?? record.revision,
    });
    if (!check.ok) {
      await this.appendResult(request.runId, first.key as string, 'refused', check.reason, request.nowIso);
      return { outcome: 'refused', key: first.key, reason: check.reason };
    }
    const firstKey = first.key as string;

    const conduct = await this.deps.runJournal.append(
      laneRunConductEntry(this.deps.newUlid(), request.runId, check.to, request.nowIso),
    );
    if (conduct.outcome !== 'appended') {
      return { outcome: 'refused', key: firstKey, reason: 'journal-refused' };
    }

    const saved = await this.deps.runRepo.save(
      { ...record, parked: null, revision: record.revision + 1 },
      {
        holderId: request.lease.holderId,
        fence: request.lease.fence,
        nowIso: request.nowIso,
      },
    );
    if (saved.outcome !== 'saved') {
      // The conduct stays; K4-4a's park-exit repair completes the exit.
      return { outcome: 'refused', key: firstKey, reason: 'save-refused' };
    }

    if (!(await this.appendResult(request.runId, firstKey, 'completed', 'resumed', request.nowIso))) {
      return { outcome: 'refused', key: firstKey, reason: 'journal-refused' };
    }

    // Any other pending intent for the same park: the run has left it, so it
    // is refused as not-parked.
    for (const intent of pending.slice(1)) {
      await this.appendResult(request.runId, intent.key as string, 'refused', 'not-parked', request.nowIso);
    }
    return { outcome: 'resumed', to: check.to, key: firstKey };
  }
}
