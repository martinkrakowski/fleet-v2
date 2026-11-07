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

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';

import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { laneRunJournalPendingIntent, laneRunJournalState, laneRunJournalStopFacts } from '../../domain/lane-run-journal.js';
import type { LaneRunJournalEntryRecord, LaneRunJournalOutcome, LaneRunJournalPendingIntent } from '../../domain/lane-run-journal.js';
import { LANE_RUN_KEY_VIAS, head12Of, laneRunResumeKey, parseLaneRunKey } from '../../domain/lane-run-keys.js';
import type { LaneRunKeyVia } from '../../domain/lane-run-keys.js';
import { LANE_RUN_ID_PATTERN } from '../../domain/lane-run-records.js';
import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import { isCalendarDateTime, snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import {
  LANE_RUN_INTENT_ABANDONED_REASON_CODE,
  laneRunConductEntry,
  laneRunIntentEntry,
  laneRunResultEntry,
} from '../../domain/lane-run-step-facts.js';
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
import type { ForgeReadPort, PullRequestSnapshot } from '../ports/out/ForgeReadPort.out-port.js';

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

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const NOW_ISO_MAX_LENGTH = 64;
const HOLDER_ID_MAX_BYTES = 256;

function isBoundedNowIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= NOW_ISO_MAX_LENGTH && isZonedIsoDateTime(value) && isCalendarDateTime(value);
}

function isSecretShaped(text: string): boolean {
  return containsSecretShape(text) || LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(text));
}

/** Never throws and never echoes: a non-plain or throwing-getter request, or any invalid field, is null. */
function validateRequestResumeRequest(request: unknown): RequestResumeRequest | null {
  const snap = snapshotPlainDataRecord(request);
  if (snap === null) {
    return null;
  }
  const { runId, via, expectedRevision, entryId, nowIso } = snap;
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
    return null;
  }
  if (typeof via !== 'string' || !(LANE_RUN_KEY_VIAS as readonly string[]).includes(via)) {
    return null;
  }
  if (expectedRevision !== undefined && !(typeof expectedRevision === 'number' && isPositiveSafeInteger(expectedRevision))) {
    return null;
  }
  if (typeof entryId !== 'string' || !ULID_PATTERN.test(entryId)) {
    return null;
  }
  if (!isBoundedNowIso(nowIso)) {
    return null;
  }
  return {
    runId,
    via: via as LaneRunKeyVia,
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    entryId,
    nowIso,
  };
}

/** Never throws and never echoes: the lease holder, fence, run id and time of an apply request, or null. */
function validateApplyPendingResumeRequest(request: unknown): ApplyPendingResumeRequest | null {
  const snap = snapshotPlainDataRecord(request);
  if (snap === null) {
    return null;
  }
  const lease = snapshotPlainDataRecord(snap.lease);
  if (lease === null) {
    return null;
  }
  const { runId, nowIso } = snap;
  const { holderId, fence } = lease;
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
    return null;
  }
  if (
    typeof holderId !== 'string' ||
    holderId === '' ||
    Buffer.byteLength(holderId, 'utf8') > HOLDER_ID_MAX_BYTES ||
    isSecretShaped(holderId)
  ) {
    return null;
  }
  if (typeof fence !== 'number' || !isPositiveSafeInteger(fence)) {
    return null;
  }
  if (!isBoundedNowIso(nowIso)) {
    return null;
  }
  return {
    runId,
    lease: { holderId, fence },
    nowIso,
  };
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
    snapshot: RequestResumeRequest,
    key: string,
    expectedRevision: number,
  ): LaneRunJournalEntryRecord {
    return {
      ...laneRunIntentEntry(snapshot.entryId, snapshot.runId, key, null, snapshot.nowIso),
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
    detail: string | null = null,
  ): Promise<boolean> {
    const appended = await this.deps.runJournal.append(
      laneRunResultEntry(this.deps.newUlid(), runId, key, outcome, reasonCode, nowIso, detail),
    );
    return appended.outcome === 'appended';
  }

  /**
   * F171: close an ambiguous pending step intent as `overtaken`
   * `intent-abandoned-by-operator` before the resume applies, so the resumed run
   * never carries it. A reconcile intent is left to its own rule; a key that
   * already has a final result is never written twice. False only when the
   * journal refuses the closing result.
   */
  private async abandonAmbiguousPendingIntent(
    runId: string,
    pendingIntent: LaneRunJournalPendingIntent | null,
    nowIso: string,
  ): Promise<boolean> {
    if (pendingIntent === null || pendingIntent.reconciliation !== 'ambiguous' || pendingIntent.step === 'reconcile') {
      return true;
    }
    const keyEntries = await this.deps.runJournal.listForKey(pendingIntent.key);
    if (keyEntries.some((entry) => entry.kind === 'result' && entry.outcome !== 'ambiguous')) {
      return true;
    }
    return this.appendResult(runId, pendingIntent.key, 'overtaken', LANE_RUN_INTENT_ABANDONED_REASON_CODE, nowIso);
  }

  /**
   * RV4: settle every `brief-check`/`code-review` intent of this run that has
   * no final result as `reconciled` / `review-superseded`, so the next advance
   * sees verdict `none` and performReview opens the next free key. Never
   * throws; an append failure is ignored (the journal guard still protects).
   */
  private async supersedePendingReviewIntents(record: LaneRunRecord, nowIso: string): Promise<void> {
    const entries = await this.deps.runJournal.listForRun(record.runId);
    const seen = new Set<string>();
    for (const entry of entries) {
      if (entry.kind !== 'intent' || entry.runId !== record.runId || entry.key === null) {
        continue;
      }
      const parsed = parseLaneRunKey(entry.key);
      if (parsed === null || parsed.kind !== 'step') {
        continue;
      }
      if (parsed.step !== 'brief-check' && parsed.step !== 'code-review') {
        continue;
      }
      if (seen.has(entry.key)) {
        continue;
      }
      seen.add(entry.key);
      const keyEntries = await this.deps.runJournal.listForKey(entry.key);
      const hasFinal = keyEntries.some(
        (candidate) => candidate.kind === 'result' && candidate.outcome !== 'ambiguous',
      );
      if (!hasFinal) {
        await this.appendResult(record.runId, entry.key, 'reconciled', 'review-superseded', nowIso);
      }
    }
  }

  async requestResume(request: RequestResumeRequest): Promise<RequestResumeResult> {
    const snapshot = validateRequestResumeRequest(request);
    if (snapshot === null) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const { runId, via, expectedRevision } = snapshot;

    const record = await this.deps.runRepo.get(runId);
    if (record === null) {
      return { outcome: 'not-found', runId };
    }

    const facts = await this.resumeFacts(record);
    const expected = expectedRevision ?? record.revision;
    const check = checkLaneRunResume({
      record,
      state: facts.state,
      stopMode: facts.stopMode,
      expectedRevision: expected,
    });
    if (!check.ok) {
      return { outcome: 'refused', reason: check.reason };
    }

    const built = laneRunResumeKey(runId, record.parkCount, via);
    if (!built.ok) {
      return { outcome: 'refused', reason: 'invalid-request' };
    }
    const key = built.key;

    const appended = await this.deps.runJournal.append(this.resumeIntentEntry(snapshot, key, expected));
    if (appended.outcome === 'appended') {
      return { outcome: 'resume-recorded', runId, to: check.to, key };
    }
    if (appended.reason === 'duplicate-key') {
      return { outcome: 'already-requested', runId, key };
    }
    return { outcome: 'refused', reason: 'journal-refused' };
  }

  async applyPendingResume(request: ApplyPendingResumeRequest): Promise<ApplyPendingResumeResult> {
    const snapshot = validateApplyPendingResumeRequest(request);
    if (snapshot === null) {
      return { outcome: 'refused', key: null, reason: 'invalid-request' };
    }
    const { runId, lease, nowIso } = snapshot;
    const { holderId, fence } = lease;

    const record = await this.deps.runRepo.get(runId);
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
    // is already complete. An ambiguous step intent the interrupted resume
    // left open is still abandoned first, so the resumed run never carries it
    // (the next advance would otherwise park the run again).
    if (record.parked === null) {
      const crashKey = (pending[0]?.key ?? null) as string | null;
      if (!(await this.abandonAmbiguousPendingIntent(runId, facts.pendingIntent, nowIso))) {
        return { outcome: 'refused', key: crashKey, reason: 'journal-refused' };
      }
      for (const intent of pending) {
        await this.appendResult(runId, intent.key as string, 'reconciled', 'resumed', nowIso);
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
      return this.settleAmbiguousOpenPrPark(record, firstPendingKey, facts.pendingIntent, facts.state, facts.stopMode, snapshot);
    }

    // RV4: a resume from a review-seat-unavailable park, or from an ambiguous
    // review park, starts a NEW review generation: every pending brief-check and
    // code-review intent of this run is settled `review-superseded`, and the
    // resume result carries detail `review-retry`. The open-pr branch above was
    // already handled, so this never enters it.
    const reviewResume =
      record.parked.reason === 'review-seat-unavailable' ||
      (record.parked.reason === 'ambiguous' &&
        (record.parked.qualifier === 'brief-check' ||
          record.parked.qualifier === 'code-review' ||
          record.parked.parkedFrom === 'brief-check' ||
          record.parked.parkedFrom === 'code-review'));
    const resumeDetail = reviewResume ? 'review-retry' : null;
    if (reviewResume) {
      await this.supersedePendingReviewIntents(record, nowIso);
    }

    // The conduct landed but the save did not (a crash, or a refused save): the journal already left the
    // park for its parked-from state while the record is still parked. Finish that exit here, so the
    // intent is settled as resumed and never refused as not-parked ahead of the repair.
    if (facts.state === record.parked.parkedFrom) {
      // A stop recorded since still wins: the resume is refused, and AdvanceLaneRun's park-exit repair
      // and stop handling settle the run, exactly as for a refused save without a stop.
      if (facts.stopMode !== null) {
        await this.appendResult(runId, firstPendingKey, 'refused', 'stop-pending', nowIso);
        return { outcome: 'refused', key: firstPendingKey, reason: 'stop-pending' };
      }
      if (!(await this.abandonAmbiguousPendingIntent(runId, facts.pendingIntent, nowIso))) {
        return { outcome: 'refused', key: firstPendingKey, reason: 'journal-refused' };
      }
      const finished = await this.deps.runRepo.save(
        { ...record, parked: null, revision: record.revision + 1 },
        { holderId, fence, nowIso },
      );
      if (finished.outcome !== 'saved') {
        return { outcome: 'refused', key: firstPendingKey, reason: 'save-refused' };
      }
      if (!(await this.appendResult(runId, firstPendingKey, 'reconciled', 'resumed', nowIso, resumeDetail))) {
        return { outcome: 'refused', key: firstPendingKey, reason: 'journal-refused' };
      }
      for (const intent of pending.slice(1)) {
        await this.appendResult(runId, intent.key as string, 'refused', 'not-parked', nowIso);
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
      await this.appendResult(runId, first.key as string, 'refused', check.reason, nowIso);
      return { outcome: 'refused', key: first.key, reason: check.reason };
    }
    const firstKey = first.key as string;

    if (!(await this.abandonAmbiguousPendingIntent(runId, facts.pendingIntent, nowIso))) {
      return { outcome: 'refused', key: firstKey, reason: 'journal-refused' };
    }

    const conduct = await this.deps.runJournal.append(
      laneRunConductEntry(this.deps.newUlid(), runId, check.to, nowIso),
    );
    if (conduct.outcome !== 'appended') {
      return { outcome: 'refused', key: firstKey, reason: 'journal-refused' };
    }

    const saved = await this.deps.runRepo.save(
      { ...record, parked: null, revision: record.revision + 1 },
      {
        holderId,
        fence,
        nowIso,
      },
    );
    if (saved.outcome !== 'saved') {
      // The conduct stays; K4-4a's park-exit repair completes the exit.
      return { outcome: 'refused', key: firstKey, reason: 'save-refused' };
    }

    if (!(await this.appendResult(runId, firstKey, 'completed', 'resumed', nowIso, resumeDetail))) {
      return { outcome: 'refused', key: firstKey, reason: 'journal-refused' };
    }

    // Any other pending intent for the same park: the run has left it, so it
    // is refused as not-parked.
    for (const intent of pending.slice(1)) {
      await this.appendResult(runId, intent.key as string, 'refused', 'not-parked', nowIso);
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
    snapshot: ApplyPendingResumeRequest,
  ): Promise<ApplyPendingResumeResult> {
    // Stop-wins, matching the parkedFrom branch: nothing is read or written.
    if (stopMode !== null) {
      return this.refuseResumeStopPending(resumeKey, snapshot);
    }
    // The open case only applies to a run whose journal state is the parked
    // park; a stray conduct (from a pre-R4a crashed resume) fails closed.
    if (state !== 'parked') {
      return this.ambiguousOpenPrResume(resumeKey, snapshot);
    }
    const spentKey = await this.spentOpenPrKey(record.runId, pending);
    if (spentKey === null) {
      return this.ambiguousOpenPrResume(resumeKey, snapshot);
    }
    const read = await this.readOpenPrByBranch(record);
    if (read === null) {
      return this.ambiguousOpenPrResume(resumeKey, snapshot);
    }
    if (!this.openPrAdoptable(record, read.snapshot, read.headSha, pending === null)) {
      return this.ambiguousOpenPrResume(resumeKey, snapshot);
    }
    return this.adoptOpenPr(record, resumeKey, spentKey, read.snapshot, snapshot);
  }

  /** The stop-pending refusal of a parked resume: one refused result, then the refused answer. */
  private async refuseResumeStopPending(
    resumeKey: string,
    snapshot: ApplyPendingResumeRequest,
  ): Promise<ApplyPendingResumeResult> {
    const { runId, nowIso } = snapshot;
    if (!(await this.appendResult(runId, resumeKey, 'refused', 'stop-pending', nowIso))) {
      return { outcome: 'refused', key: resumeKey, reason: 'journal-refused' };
    }
    return { outcome: 'refused', key: resumeKey, reason: 'stop-pending' };
  }

  /**
   * The spent open-pr key of the open case (R4a): the pending step intent's
   * key; else, for the crash-repair pass, the journalled open-pr intent
   * whose key already holds a final result. Null when neither: a pending
   * intent of another step, or no final open-pr key at all.
   */
  private async spentOpenPrKey(
    runId: string,
    pending: LaneRunJournalPendingIntent | null,
  ): Promise<string | null> {
    if (pending !== null) {
      return pending.step === 'open-pr' ? pending.key : null;
    }
    // A crash after the spent open-pr key's result but before the resume
    // key's result leaves laneRunJournalPendingIntent null for the now-final
    // step key. Inspect the journal for the existing open-pr intent and
    // continue only when it already has a reconciled/pr-opened result (the
    // brief's correction 1: any other final result adopts nothing); the
    // record's prNumber was saved before that result, so no second save.
    return this.adoptableSettledOpenPrKey(runId);
  }

  /**
   * The open case's PR read (R4a): the re-read is immediate and by branch —
   * the facts read of an earlier pass is never trusted for a write. The
   * attempt read and the head canonicalization run inside the try, so a
   * repository error or a malformed head fails closed (null) instead of
   * rejecting; so does every wiring gap, an unreadable read and a throw.
   * Answers the found snapshot with the attempt's collected head it must
   * still equal.
   */
  private async readOpenPrByBranch(
    record: LaneRunRecord,
  ): Promise<{ readonly snapshot: PullRequestSnapshot; readonly headSha: string | null } | null> {
    try {
      const latestId = record.attemptIds.length === 0 ? null : record.attemptIds[record.attemptIds.length - 1];
      const latest =
        this.deps.attemptRepo === undefined || latestId === null
          ? null
          : await this.deps.attemptRepo.findAttemptById(latestId);
      const branch = latest === null ? null : branchNameOf(record, latest);
      const headSha = latest === null || latest.artifacts === null ? null : latest.artifacts.headCommit;
      const head12 = headSha === null ? null : head12Of(headSha);
      if (this.deps.forgeRead === undefined || branch === null || head12 === null) {
        throw new Error('the forge read is not wired');
      }
      const read = await this.deps.forgeRead.readPullRequest({ ref: { kind: 'branch', branchName: branch } });
      return read.outcome === 'found' ? { snapshot: read.pullRequest, headSha } : null;
    } catch {
      return null;
    }
  }

  /**
   * The match check (R4a): exactly one open PR whose full validated 40-hex
   * head and base still equal the run's, and whose number agrees with any
   * recorded one. `alreadyRecorded` is the crash-repair pass: the adoption
   * already landed, so the record's prNumber must equal the re-read PR and
   * is never saved again.
   */
  private openPrAdoptable(
    record: LaneRunRecord,
    snapshot: PullRequestSnapshot,
    headSha: string | null,
    alreadyRecorded: boolean,
  ): boolean {
    const matches =
      snapshot.state === 'open' &&
      sameLaneHeadSha(snapshot.headSha, headSha) &&
      snapshot.baseRef === resolveLaneRunBaseBranch(record) &&
      (record.prNumber === null || snapshot.number === record.prNumber);
    if (!matches) {
      return false;
    }
    return !alreadyRecorded || snapshot.number === record.prNumber;
  }

  /** The adoption writes (R4a): `prNumber` first (the park stays), then the spent key and the resume key settle reconciled. */
  private async adoptOpenPr(
    record: LaneRunRecord,
    resumeKey: string,
    spentKey: string,
    snapshot: PullRequestSnapshot,
    applySnapshot: ApplyPendingResumeRequest,
  ): Promise<ApplyPendingResumeResult> {
    const { runId, lease, nowIso } = applySnapshot;
    const { holderId, fence } = lease;
    if (snapshot.number !== record.prNumber) {
      const saved = await this.deps.runRepo.save(
        { ...record, prNumber: snapshot.number, revision: record.revision + 1 },
        { holderId, fence, nowIso },
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
      if (!(await this.appendResult(runId, spentKey, 'reconciled', 'pr-opened', nowIso))) {
        return { outcome: 'refused', key: resumeKey, reason: 'journal-refused' };
      }
    }
    if (!(await this.appendResult(runId, resumeKey, 'reconciled', 'resumed', nowIso))) {
      return { outcome: 'refused', key: resumeKey, reason: 'journal-refused' };
    }
    return { outcome: 'resumed', to: 'watching-ci', key: resumeKey };
  }

  /** The open case's fail-closed answer: nothing written, the resume stays retryable, no duplicate journal spam. */
  private async ambiguousOpenPrResume(resumeKey: string, snapshot: ApplyPendingResumeRequest): Promise<ApplyPendingResumeResult> {
    const { runId, nowIso } = snapshot;
    const existing = await this.deps.runJournal.listForKey(resumeKey);
    if (!existing.some((entry) => entry.kind === 'result')) {
      if (!(await this.appendResult(runId, resumeKey, 'ambiguous', 'forge-ambiguous', nowIso))) {
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

  /**
   * R4a crash-repair, the brief's correction 1: `settledOpenPrKey` accepts
   * any final non-`ambiguous` result, but the adoption continues only when
   * that result says `reconciled` `pr-opened` — a `refused` or `completed`
   * final result adopts nothing and fails closed.
   */
  private async adoptableSettledOpenPrKey(runId: string): Promise<string | null> {
    const key = await this.settledOpenPrKey(runId);
    if (key === null) {
      return null;
    }
    const entries = await this.deps.runJournal.listForKey(key);
    const prOpened = entries.some(
      (entry) => entry.kind === 'result' && entry.outcome === 'reconciled' && entry.reasonCode === 'pr-opened',
    );
    return prOpened ? key : null;
  }
}
