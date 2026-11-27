// Implemented for lane SR6 — `fleet-v2 seats observe`.
/**
 * RecordSeatObservationUseCase records one seat observation from outside
 * fleet's runner (plan §3.5.5). The subject must be an existing attempt or
 * review request whose committed seat matches the given seat id and which
 * has no result or receipt yet; the observed moment comes from the request
 * or from a fresh clock read, never a stored one. At most one cooling
 * observation per seat per observation window: a repeat observation id or a
 * window already open is a duplicate and writes nothing new (plan §3.5.3).
 * A dry run validates and writes nothing. Every failure path is a typed
 * refusal; unknown store state is never treated as success, input values
 * are never echoed, and the subject's attempts and installation health are
 * never mutated.
 */

import { snapshotPlainData, type IsProxy } from '@fleet/shared';
import {
  SEAT_OBSERVATION_OUTCOMES,
  type SeatObservationOutcome,
  type SeatObservationRecord,
} from '../../domain/execution-records.js';
import { coolingSeatIds } from '../../domain/seat-selection.js';
import { parseLaneRunKey, type ParsedLaneRunKey } from '../../domain/lane-run-keys.js';
import { SeatPlan } from '../../domain/value-objects/SeatPlan.vo.js';
import type {
  RecordSeatObservationPort,
  RecordSeatObservationRefusalCode,
  RecordSeatObservationResult,
} from '../ports/in/RecordSeatObservationPort.in-port.js';
import type { SeatObservationRepositoryPort } from '../ports/out/SeatObservationRepositoryPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { ReviewRequestPort } from '../ports/out/ReviewRequestPort.out-port.js';

export interface RecordSeatObservationDependencies {
  readonly observations: SeatObservationRepositoryPort;
  readonly attempts: Pick<AttemptRepositoryPort, 'findAttemptById'>;
  /** REQUIRED, with no default: the trusted Proxy detector for the input snapshot. */
  readonly isProxy: IsProxy;
  /** Fresh clock, read only when the request carries no observedAtIso. */
  readonly nowIso: () => string;
  readonly mintObservationId: () => string;
  /** The installation's `policy.seats.observationCooldownMinutes` (0 = off). */
  readonly observationCooldownMinutes: number;
  /** The review-subject reads; omitted keeps review subjects `not-wired`. */
  readonly runRepo?: Pick<LaneRunRepositoryPort, 'list'>;
  readonly runJournal?: Pick<LaneRunJournalPort, 'listForRun'>;
  readonly reviewRequest?: Pick<ReviewRequestPort, 'findReviewReceipt'>;
  /**
   * The installation `chains['high-risk-reviewer']` seat ids in order, for
   * `pre-merge` subjects: `pre-merge` has no `SeatPlan` v1 role (§3.5.1).
   */
  readonly highRiskReviewerSeatIds?: readonly string[];
}

/** The bounded snapshot limits (SR6): a hostile input never grows the work. */
const SNAPSHOT_LIMITS = Object.freeze({
  maxDepth: 4,
  maxKeys: 16,
  maxArrayLength: 16,
  maxNodes: 64,
  maxStringLength: 512,
});

const ID_MAX_LENGTH = 128;

/**
 * Per-seat serialization of the cooldown check-and-append. The window check
 * reads the store and the append writes it; two concurrent observations for the
 * same seat would otherwise both read "no active window" and both answer
 * `recorded`. The chain is keyed by seat, so different seats never wait on each
 * other, and it is shared by every use-case instance in the process.
 */
const seatTails = new Map<string, Promise<void>>();

async function serializedBySeat<T>(seatId: string, work: () => Promise<T>): Promise<T> {
  const previous = seatTails.get(seatId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  seatTails.set(seatId, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (seatTails.get(seatId) === tail) {
      seatTails.delete(seatId);
    }
  }
}

/** The input keys the use case reads, no more and no fewer. */
const INPUT_KEYS: readonly string[] = ['seatId', 'outcome', 'subject', 'observationId', 'observedAtIso'];

/** The only plan steps whose journal intent mints a review request id. */
const REVIEW_PLAN_STEPS: readonly string[] = ['brief-check', 'code-review', 'pre-merge'];

interface ParsedInput {
  readonly seatId: string;
  readonly outcome: SeatObservationOutcome;
  readonly subject: { readonly attemptId: string } | { readonly reviewRequestId: string };
  readonly observationId?: string;
  readonly observedAtIso?: string;
}

type ParsedInputResult =
  | { readonly ok: true; readonly parsed: ParsedInput }
  | { readonly ok: false; readonly reason: string };

function refusal(code: RecordSeatObservationRefusalCode, reason: string): RecordSeatObservationResult {
  return { outcome: 'refused', code, reason };
}

/** An identifier: non-empty after trim, never `.` or `..`, bounded length. */
function isUsableId(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== '.' && trimmed !== '..' && trimmed.length <= ID_MAX_LENGTH;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The subject block: a plain object carrying exactly one of `attemptId` or
 * `reviewRequestId` as a usable id. Anything else is refused, never guessed.
 */
function parseSubjectBlock(subject: unknown): ParsedInput['subject'] | null {
  if (!isPlainObject(subject)) {
    return null;
  }
  const keys = Object.keys(subject);
  if (keys.length !== 1) {
    return null;
  }
  if (keys[0] === 'attemptId' && isUsableId(subject.attemptId)) {
    return { attemptId: subject.attemptId.trim() };
  }
  if (keys[0] === 'reviewRequestId' && isUsableId(subject.reviewRequestId)) {
    return { reviewRequestId: subject.reviewRequestId.trim() };
  }
  return null;
}

/** Validate the snapshot once; every problem is one `invalid-input` refusal. */
function parseInput(snapshot: unknown): ParsedInputResult {
  if (!isPlainObject(snapshot)) {
    return { ok: false, reason: 'input must be a plain object' };
  }
  if (Object.keys(snapshot).some((key) => !INPUT_KEYS.includes(key))) {
    return { ok: false, reason: 'input carries an unexpected key' };
  }
  if (!isUsableId(snapshot.seatId)) {
    return { ok: false, reason: 'seatId must be a non-empty string of at most 128 characters' };
  }
  if (typeof snapshot.outcome !== 'string' || !SEAT_OBSERVATION_OUTCOMES.includes(snapshot.outcome as SeatObservationOutcome)) {
    return { ok: false, reason: 'outcome must be one of the declared seat observation outcomes' };
  }
  const subject = parseSubjectBlock(snapshot.subject);
  if (subject === null) {
    return { ok: false, reason: 'subject must carry exactly one of attemptId or reviewRequestId' };
  }
  let observationId: string | undefined;
  if (snapshot.observationId !== undefined) {
    if (!isUsableId(snapshot.observationId)) {
      return { ok: false, reason: 'observationId must be a non-empty string of at most 128 characters' };
    }
    observationId = snapshot.observationId.trim();
  }
  let observedAtIso: string | undefined;
  if (snapshot.observedAtIso !== undefined) {
    if (typeof snapshot.observedAtIso !== 'string' || Number.isNaN(Date.parse(snapshot.observedAtIso))) {
      return { ok: false, reason: 'observedAtIso must be a parseable ISO timestamp' };
    }
    observedAtIso = snapshot.observedAtIso;
  }
  return {
    ok: true,
    parsed: {
      seatId: snapshot.seatId.trim(),
      outcome: snapshot.outcome as SeatObservationOutcome,
      subject,
      ...(observationId !== undefined ? { observationId } : {}),
      ...(observedAtIso !== undefined ? { observedAtIso } : {}),
    },
  };
}

/** Snapshot the untrusted input once (no Proxy trap, no getter ever runs). */
function parseSnapshot(input: unknown, isProxy: IsProxy): ParsedInputResult {
  let snapshot: unknown;
  try {
    const snap = snapshotPlainData(input, isProxy, SNAPSHOT_LIMITS);
    if (!snap.ok) {
      return { ok: false, reason: 'input must be plain bounded data' };
    }
    snapshot = snap.value;
  } catch {
    return { ok: false, reason: 'input must be plain bounded data' };
  }
  return parseInput(snapshot);
}

/** The journal intent a review-request subject resolves to, with its step key. */
interface ReviewIntent {
  readonly runId: string;
  readonly key: string;
  readonly parsedStepKey: Extract<ParsedLaneRunKey, { readonly kind: 'step' }>;
}

export class RecordSeatObservationUseCase implements RecordSeatObservationPort {
  constructor(private readonly deps: RecordSeatObservationDependencies) {}

  async execute(
    input: unknown,
    via: 'cli' | 'mcp',
    options?: { readonly dryRun?: boolean },
  ): Promise<RecordSeatObservationResult> {
    const read = parseSnapshot(input, this.deps.isProxy);
    if (!read.ok) {
      return refusal('invalid-input', read.reason);
    }
    if (via !== 'cli' && via !== 'mcp') {
      return refusal('invalid-input', 'via must be cli or mcp');
    }
    const parsed = read.parsed;
    const observationId = parsed.observationId ?? this.deps.mintObservationId();
    if (!isUsableId(observationId)) {
      return refusal('invalid-input', 'the minted observation id is unusable');
    }
    let observedAtIso: string;
    if (parsed.observedAtIso !== undefined) {
      observedAtIso = parsed.observedAtIso;
    } else {
      try {
        observedAtIso = this.deps.nowIso();
      } catch {
        return refusal('clock-error', 'the clock failed');
      }
      if (typeof observedAtIso !== 'string' || Number.isNaN(Date.parse(observedAtIso))) {
        return refusal('clock-error', 'the clock returned a non-ISO time');
      }
    }
    const subjectCheck = await this.checkSubject(parsed);
    if (subjectCheck !== null) {
      return subjectCheck;
    }
    return this.put(
      {
        version: 1,
        observationId,
        seatId: parsed.seatId,
        outcome: parsed.outcome,
        observedAtIso,
        subject: parsed.subject,
        via,
      },
      options,
    );
  }

  /**
   * The subject checks of §3.5.5: null means the subject is usable. Every
   * store read is guarded — unknown state is a `store-error`, never a pass.
   */
  private checkSubject(parsed: ParsedInput): Promise<RecordSeatObservationResult | null> {
    if ('attemptId' in parsed.subject) {
      return this.checkAttemptSubject(parsed.subject.attemptId, parsed.seatId);
    }
    return this.checkReviewSubject(parsed.subject.reviewRequestId, parsed.seatId);
  }

  private async checkAttemptSubject(attemptId: string, seatId: string): Promise<RecordSeatObservationResult | null> {
    let attempt;
    try {
      attempt = await this.deps.attempts.findAttemptById(attemptId);
    } catch {
      return refusal('store-error', 'the attempt store could not be read');
    }
    if (attempt === null) {
      return refusal('subject-not-found', 'no attempt carries that id');
    }
    if (attempt.seatSelection?.seatId !== seatId) {
      return refusal('seat-mismatch', 'the attempt was committed to another seat');
    }
    if (
      attempt.state === 'ended' ||
      attempt.state === 'collected' ||
      attempt.state === 'cancelled' ||
      attempt.outcome !== null ||
      attempt.completionReceipt !== null
    ) {
      return refusal('subject-has-result', 'the attempt already carries a result');
    }
    return null;
  }

  private async checkReviewSubject(reviewRequestId: string, seatId: string): Promise<RecordSeatObservationResult | null> {
    if (this.deps.runRepo === undefined || this.deps.runJournal === undefined) {
      return refusal('not-wired', 'review subjects need the lane-run stores, which are not wired');
    }
    let runs;
    try {
      runs = await this.deps.runRepo.list();
    } catch {
      return refusal('store-error', 'the lane-run store could not be read');
    }
    // The one intent entry that minted the request id under a review step key,
    // with any final result already recorded for its key.
    let intent: ReviewIntent | null = null;
    let hasFinalResult = false;
    for (const run of runs) {
      let entries;
      try {
        entries = await this.deps.runJournal.listForRun(run.runId);
      } catch {
        return refusal('store-error', 'the lane-run journal could not be read');
      }
      for (const entry of entries) {
        if (intent === null && entry.kind === 'intent' && entry.mintedId === reviewRequestId) {
          const parsedKey = parseLaneRunKey(entry.key);
          if (parsedKey !== null && parsedKey.kind === 'step' && REVIEW_PLAN_STEPS.includes(parsedKey.step)) {
            intent = { runId: run.runId, key: entry.key as string, parsedStepKey: parsedKey };
          }
        }
        // A final result for the intent's key is the review's own outcome; an
        // `ambiguous` result or a `review-no-receipt` leaves the subject open.
        if (intent !== null && entry.kind === 'result' && entry.key === intent.key) {
          if (entry.outcome !== 'ambiguous' && entry.reasonCode !== 'review-no-receipt') {
            hasFinalResult = true;
          }
        }
      }
      if (intent !== null) {
        break;
      }
    }
    if (intent === null) {
      return refusal('subject-not-found', 'no review request intent carries that id');
    }
    if (hasFinalResult) {
      return refusal('subject-has-result', 'the review already carries a final result');
    }
    const run = runs.find((candidate) => candidate.runId === intent.runId);
    if (run === undefined || run.attemptIds.length === 0) {
      return refusal('subject-not-found', 'the review request belongs to a run without attempts');
    }
    const latestAttemptId = run.attemptIds[run.attemptIds.length - 1];
    let latestAttempt;
    try {
      latestAttempt = await this.deps.attempts.findAttemptById(latestAttemptId);
    } catch {
      return refusal('store-error', 'the attempt store could not be read');
    }
    if (latestAttempt === null) {
      return refusal('subject-not-found', 'the review request belongs to a run whose attempt is absent');
    }
    const step = intent.parsedStepKey.step;
    if (step === 'pre-merge') {
      // `pre-merge` has no `SeatPlan` v1 role (§3.5.1): the committed seat is
      // the installation's high-risk-reviewer chain entry at the key's index.
      if (this.deps.highRiskReviewerSeatIds === undefined) {
        return refusal('not-wired', 'pre-merge subjects need the high-risk-reviewer chain, which is not wired');
      }
      if (this.deps.highRiskReviewerSeatIds[intent.parsedStepKey.seatIndex] !== seatId) {
        return refusal('seat-mismatch', 'the pre-merge step was committed to another seat');
      }
    } else {
      const plan = SeatPlan.create(latestAttempt.seatPlan);
      if (!plan.success || plan.value === undefined) {
        return refusal('subject-not-found', 'the review request belongs to an attempt without a seat plan');
      }
      const seat = plan.value.getSeats('review')[intent.parsedStepKey.seatIndex];
      if (seat === undefined || seat.id !== seatId) {
        return refusal('seat-mismatch', 'the review step was committed to another seat');
      }
    }
    const headCommit = latestAttempt.artifacts?.headCommit;
    if (this.deps.reviewRequest !== undefined && typeof headCommit === 'string') {
      let receipt;
      try {
        receipt = await this.deps.reviewRequest.findReviewReceipt({
          attemptId: latestAttempt.id,
          requestId: reviewRequestId,
          candidateHeadSha: headCommit,
        });
      } catch {
        return refusal('store-error', 'the review receipt store could not be read');
      }
      if (receipt.outcome === 'found') {
        return refusal('subject-has-result', 'the review already carries a receipt');
      }
      if (receipt.outcome === 'unavailable') {
        return refusal('store-error', 'the review receipt store could not be read');
      }
    }
    return null;
  }

  /** The window and persistence half: a dry run writes nothing, a repeat is a duplicate. */
  private put(
    record: SeatObservationRecord,
    options?: { readonly dryRun?: boolean },
  ): Promise<RecordSeatObservationResult> {
    return serializedBySeat(record.seatId, () => this.putSerialized(record, options));
  }

  private async putSerialized(
    record: SeatObservationRecord,
    options?: { readonly dryRun?: boolean },
  ): Promise<RecordSeatObservationResult> {
    let existing;
    try {
      // The repository deduplicates observation IDs across every seat, so the
      // pre-read must consider the whole store, not just this seat's slice.
      existing = await this.deps.observations.listSeatObservations();
    } catch {
      return refusal('store-error', 'the observation store could not be read');
    }
    const duplicateRecord = existing.find((entry) => entry.observationId === record.observationId);
    const duplicateId = duplicateRecord !== undefined;
    let windowActive = false;
    if (this.deps.observationCooldownMinutes > 0) {
      windowActive = coolingSeatIds({
        attempts: [],
        observations: existing,
        nowIso: record.observedAtIso,
        cooldownMinutes: 0,
        observationCooldownMinutes: this.deps.observationCooldownMinutes,
      }).has(record.seatId);
    }
    if (options?.dryRun === true) {
      return {
        outcome: 'dry-run',
        observation: record,
        wouldCool: this.deps.observationCooldownMinutes > 0 && !duplicateId && !windowActive,
        duplicate: duplicateId || windowActive,
      };
    }
    let appended;
    try {
      appended = await this.deps.observations.appendSeatObservation(record);
    } catch {
      return refusal('store-error', 'the observation store refused the write');
    }
    if (appended === 'duplicate') {
      if (duplicateRecord === undefined) {
        // A concurrent append won between the pre-read and this append. The
        // store holds the winning record, so re-read rather than reporting the
        // losing local copy as the stored observation.
        let stored;
        try {
          stored = await this.deps.observations.listSeatObservations();
        } catch {
          return refusal('store-error', 'the observation store could not be read');
        }
        const winner = stored.find((entry) => entry.observationId === record.observationId);
        if (winner === undefined) {
          return refusal('store-error', 'the observation store reported a duplicate it no longer holds');
        }
        return {
          outcome: 'duplicate',
          observation: winner,
          cooling: false,
          reason: 'duplicate-observation-id',
        };
      }
      return {
        outcome: 'duplicate',
        observation: duplicateRecord,
        cooling: false,
        reason: 'duplicate-observation-id',
      };
    }
    if (windowActive) {
      return { outcome: 'duplicate', observation: record, cooling: false, reason: 'window-already-cooling' };
    }
    return { outcome: 'recorded', observation: record, cooling: this.deps.observationCooldownMinutes > 0 };
  }
}
