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
 * R4a: for a run parked `ambiguous open-pr`, `applyPendingResume` re-reads
 * the PR by branch, adopts exactly one open PR whose head and base still match
 * (saving `prNumber` and journalling the spent key `reconciled` together), and
 * the decider's settled-open-pr rule then enters `watching-ci`; the park is
 * never cleared here and `open-pr` is never re-issued.
 */

import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { laneRunJournalPendingIntent, laneRunJournalState, laneRunJournalStopFacts } from '../../domain/lane-run-journal.js';
import type { LaneRunJournalEntryRecord, LaneRunJournalOutcome, LaneRunJournalPendingIntent } from '../../domain/lane-run-journal.js';
import { LANE_RUN_KEY_VIAS, head12Of, laneRunResumeKey, parseLaneRunKey } from '../../domain/lane-run-keys.js';
import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import { laneRunConductEntry, laneRunIntentEntry, laneRunResultEntry } from '../../domain/lane-run-step-facts.js';
import type { LaneRunResultReasonCode } from '../../domain/lane-run-step-facts.js';
import { checkLaneRunResume } from '../../domain/lane-run-transitions.js';
import type { RunStopMode } from '../../domain/lane-run-transitions.js';
import { resolveLaneRunBaseBranch } from '../../domain/base-branch.js';
import type { AttemptRecord } from '../../domain/execution-records.js';
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
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ForgeReadPort, ReadPullRequestResult } from '../ports/out/ForgeReadPort.out-port.js';

export interface ResumeLaneRunDependencies {
  readonly runRepo: Pick<LaneRunRepositoryPort, 'get' | 'save'>;
  readonly runJournal: LaneRunJournalPort;
  /** A fresh ULID per call (conduct and result entry ids). */
  readonly newUlid: () => string;
  /** R4a: the read-only forge read the settled open-pr park's resume re-checks. */
  readonly forgeRead?: ForgeReadPort;
  /** R4a: the attempt records the branch fallback and the lane head read from. */
  readonly attemptRepo?: Pick<AttemptRepositoryPort, 'findAttemptById'>;
}

interface ResumeFacts {
  readonly entries: readonly LaneRunJournalEntryRecord[];
  readonly state: LaneRunStateValue;
  readonly stopMode: RunStopMode | null;
  readonly pendingIntent: LaneRunJournalPendingIntent | null;
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

/** The run's PR head branch (R4a): the recorded branchName, else the latest attempt's worktreePath last segment; null when neither yields a usable name. */
function branchNameOf(record: LaneRunRecord, latest: AttemptRecord): string | null {
  if (record.branchName !== undefined && record.branchName !== '') {
    return record.branchName;
  }
  const segments = latest.worktreePath.split('/');
  const last = segments[segments.length - 1];
  return last === undefined || last === '' ? null : last;
}

const LANE_HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * R4a: whether the PR's full validated 40-hex head SHA equals the attempt's
 * collected head commit. Both sides are canonicalized (a non-40-hex value on
 * either side fails); the 12-hex prefix is only for keyed and decider facts.
 */
function sameLaneHeadSha(left: string | null | undefined, right: string | null | undefined): boolean {
  return (
    typeof left === 'string' &&
    typeof right === 'string' &&
    LANE_HEAD_SHA_PATTERN.test(left) &&
    LANE_HEAD_SHA_PATTERN.test(right) &&
    left === right
  );
}

export class ResumeLaneRunUseCase implements ResumeLaneRunPort {
  constructor(private readonly deps: ResumeLaneRunDependencies) {}

  /** The run's journal entries, projected state, strongest stop and last pending step intent: the facts both methods check against. */
  private async resumeFacts(record: LaneRunRecord): Promise<ResumeFacts> {
    const entries = await this.deps.runJournal.listForRun(record.runId);
    return {
      entries,
      state: laneRunJournalState(entries, record.runId),
      stopMode: laneRunJournalStopFacts(entries, record.runId).stopMode,
      pendingIntent: laneRunJournalPendingIntent(entries, record.runId),
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

    // R4a: the open case of an `ambiguous open-pr` park intercepts the
    // crash-finish and the resume check below (both would leave the park
    // without adopting and force a second `open-pr` on the spent key). The
    // stop-pending check the parkedFrom branch performs is re-done inside the
    // open case, so nothing is lost.
    if (
      record.parked.reason === 'ambiguous' &&
      record.parked.qualifier === 'open-pr'
    ) {
      return this.settleAmbiguousOpenPrPark(record, firstPendingKey, facts.pendingIntent, facts.state, facts.stopMode, request);
    }

    // The conduct landed but the save did not (a crash, or a refused save): the journal already left the
    // park for its parked-from state while the record is still parked. Finish that exit here, so the
    // intent is settled as resumed and never refused as not-parked ahead of the repair.
    if (facts.state === record.parked.parkedFrom) {
      // A stop recorded since still wins: the resume is refused, and AdvanceLaneRun's park-exit repair
      // and stop handling settle the run, exactly as for a refused save without a stop.
      if (facts.stopMode !== null) {
        await this.appendResult(request.runId, firstPendingKey, 'refused', 'stop-pending', request.nowIso);
        return { outcome: 'refused', key: firstPendingKey, reason: 'stop-pending' };
      }
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

  /**
   * R4a: the open case of a run parked `ambiguous open-pr` (see
   * applyPendingResume). The open-pr intent spent its one-way key with an
   * ambiguous result, so the resume never re-issues it and never conducts
   * here. It re-reads the PR by branch immediately before its one write;
   * exactly one open PR whose head and base still equal the run's is
   * adopted: the record's `prNumber` is saved first (the park stays), then
   * the spent key is settled `reconciled` `pr-opened` and the resume key
   * `reconciled` `resumed` — the journal and `prNumber` land together, and
   * the decider's G3b0 then enters `watching-ci`. Anything else writes
   * nothing and stays parked; every failure journals `ambiguous`
   * `forge-ambiguous` on the resume key, so the next pass re-checks (a
   * final refusal would burn the single-use resume key on a possibly
   * transient mismatch). A stop recorded since the resume request still wins
   * before any PR read or record update.
   */
  private async settleAmbiguousOpenPrPark(
    record: LaneRunRecord,
    resumeKey: string,
    pending: LaneRunJournalPendingIntent | null,
    state: LaneRunStateValue,
    stopMode: RunStopMode | null,
    request: ApplyPendingResumeRequest,
  ): Promise<ApplyPendingResumeResult> {
    // Stop-wins, matching the parkedFrom branch: nothing is read or written.
    if (stopMode !== null) {
      if (!(await this.appendResult(request.runId, resumeKey, 'refused', 'stop-pending', request.nowIso))) {
        return { outcome: 'refused', key: resumeKey, reason: 'journal-refused' };
      }
      return { outcome: 'refused', key: resumeKey, reason: 'stop-pending' };
    }
    // The open case only applies to a run whose journal state is the parked
    // park; a stray conduct (from a pre-R4a crashed resume) fails closed.
    if (state !== 'parked') {
      return this.ambiguousOpenPrResume(resumeKey, request);
    }
    let spentKey: string;
    if (pending !== null) {
      if (pending.step !== 'open-pr') {
        return this.ambiguousOpenPrResume(resumeKey, request);
      }
      spentKey = pending.key;
    } else {
      // A crash after the spent open-pr key's result but before the resume
      // key's result leaves laneRunJournalPendingIntent null for the now-final
      // step key. Inspect the journal for the existing open-pr intent and
      // continue only when it already has a reconciled/pr-opened result; the
      // record's prNumber was saved before that result, so no second save.
      const settled = await this.settledOpenPrKey(record.runId);
      if (settled === null) {
        return this.ambiguousOpenPrResume(resumeKey, request);
      }
      spentKey = settled;
    }
    const latestId = record.attemptIds.length === 0 ? null : record.attemptIds[record.attemptIds.length - 1];
    const latest =
      this.deps.attemptRepo === undefined || latestId === null
        ? null
        : await this.deps.attemptRepo.findAttemptById(latestId);
    const branch = latest === null ? null : branchNameOf(record, latest);
    const headSha = latest === null || latest.artifacts === null ? null : latest.artifacts.headCommit;
    const head12 = headSha === null ? null : head12Of(headSha);
    let read: ReadPullRequestResult;
    try {
      if (this.deps.forgeRead === undefined || branch === null || head12 === null) {
        throw new Error('the forge read is not wired');
      }
      // The re-read is immediate and by branch: the facts read of an earlier
      // pass is never trusted for a write.
      read = await this.deps.forgeRead.readPullRequest({ ref: { kind: 'branch', branchName: branch } });
    } catch {
      return this.ambiguousOpenPrResume(resumeKey, request);
    }
    if (read.outcome !== 'found') {
      return this.ambiguousOpenPrResume(resumeKey, request);
    }
    const snapshot = read.pullRequest;
    const matches =
      snapshot.state === 'open' &&
      sameLaneHeadSha(snapshot.headSha, headSha) &&
      snapshot.baseRef === resolveLaneRunBaseBranch(record) &&
      (record.prNumber === null || snapshot.number === record.prNumber);
    if (!matches) {
      return this.ambiguousOpenPrResume(resumeKey, request);
    }
    // Crash-repair after the spent-key result: the adoption already landed, so
    // the record's prNumber must equal the re-read PR; never save again.
    if (pending === null && snapshot.number !== record.prNumber) {
      return this.ambiguousOpenPrResume(resumeKey, request);
    }
    if (snapshot.number !== record.prNumber) {
      const saved = await this.deps.runRepo.save(
        { ...record, prNumber: snapshot.number, revision: record.revision + 1 },
        { holderId: request.lease.holderId, fence: request.lease.fence, nowIso: request.nowIso },
      );
      if (saved.outcome !== 'saved') {
        return { outcome: 'refused', key: resumeKey, reason: 'save-refused' };
      }
    }
    // The retry after a crash between the save and this result: the key may
    // already be settled (the journal refuses only after a FINAL result).
    const openPrEntries = await this.deps.runJournal.listForKey(spentKey);
    const alreadySettled = openPrEntries.some((entry) => entry.kind === 'result' && entry.outcome !== 'ambiguous');
    if (!alreadySettled) {
      if (!(await this.appendResult(request.runId, spentKey, 'reconciled', 'pr-opened', request.nowIso))) {
        return { outcome: 'refused', key: resumeKey, reason: 'journal-refused' };
      }
    }
    if (!(await this.appendResult(request.runId, resumeKey, 'reconciled', 'resumed', request.nowIso))) {
      return { outcome: 'refused', key: resumeKey, reason: 'journal-refused' };
    }
    return { outcome: 'resumed', to: 'watching-ci', key: resumeKey };
  }

  /** The open case's fail-closed answer: nothing written, the resume stays retryable, no duplicate journal spam. */
  private async ambiguousOpenPrResume(resumeKey: string, request: ApplyPendingResumeRequest): Promise<ApplyPendingResumeResult> {
    const existing = await this.deps.runJournal.listForKey(resumeKey);
    if (!existing.some((entry) => entry.kind === 'result')) {
      if (!(await this.appendResult(request.runId, resumeKey, 'ambiguous', 'forge-ambiguous', request.nowIso))) {
        return { outcome: 'refused', key: resumeKey, reason: 'journal-refused' };
      }
    }
    return { outcome: 'refused', key: resumeKey, reason: 'forge-ambiguous' };
  }

  /** R4a crash-repair: the last journalled open-pr step intent whose key already has a final result, or null. */
  private async settledOpenPrKey(runId: string): Promise<string | null> {
    const entries = await this.deps.runJournal.listForRun(runId);
    let key: string | null = null;
    for (const entry of entries) {
      if (entry.kind !== 'intent' || entry.key === null) {
        continue;
      }
      const parsed = parseLaneRunKey(entry.key);
      if (parsed === null || parsed.kind !== 'step' || parsed.step !== 'open-pr') {
        continue;
      }
      key = entry.key;
    }
    if (key === null) {
      return null;
    }
    const spent = await this.deps.runJournal.listForKey(key);
    return spent.some((entry) => entry.kind === 'result' && entry.outcome !== 'ambiguous') ? key : null;
  }
}
