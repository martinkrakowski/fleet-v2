/**
 * RecordShadowDayUseCase (lane SE0): evaluates one completed UTC day of the
 * cutover shadow period for one repository and records, in the
 * shadow-evidence ledger by compare-and-set, each criterion that reached a
 * definite pass or fail verdict. A criterion whose evaluator is missing,
 * throws or answers an unusable shape is reported as `unevaluated` and
 * recorded nowhere. The day rules refuse the current day, a future day, a
 * day whose grace period has not ended and a day older than seven days. A
 * recorded day-and-criterion verdict is never changed: an identical repeat
 * is a no-op and any other is a `day-criterion-conflict` refusal. Every
 * outbound call is deadline-guarded, a compare-and-set conflict is retried
 * against a fresh read (three passes), and nothing here echoes a path or a
 * raw input value.
 */

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import { CUTOVER_SHADOW_CRITERIA, type CutoverShadowCriterion } from '../../domain/cutover-records.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import {
  classifyShadowDayWindow,
  emptyShadowEvidenceLedger,
  isRecordedShadowDay,
  mergeShadowDay,
  type ShadowDayVerdict,
} from '../../domain/shadow-evidence-ledger.js';
import type {
  RecordedShadowDayVerdict,
  RecordShadowDayPort,
  RecordShadowDayRefusalReason,
  RecordShadowDayRequest,
  RecordShadowDayResult,
  RecordShadowDayUnknownReason,
  ShadowCriterionEvaluation,
  UnevaluatedShadowCriterion,
} from '../ports/in/RecordShadowDayPort.in-port.js';
import type { ShadowEvidencePort } from '../ports/out/ShadowEvidencePort.out-port.js';

export interface RecordShadowDayDependencies {
  readonly shadowEvidence: ShadowEvidencePort;
  /**
   * One evaluation per shadow criterion. A missing evaluator, a throw or an
   * unusable answer is `unevaluated` for that criterion, never a failure of
   * the whole day.
   */
  readonly evaluate: (criterion: CutoverShadowCriterion) => Promise<ShadowCriterionEvaluation>;
  readonly nowIso: () => string;
}

const MAX_REQUEST_KEYS = 8;
const MAX_STRING_LENGTH = 256;
const MAX_ISO_LENGTH = 64;
const MAX_REVISION = 1_000_000_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REQUEST_KEYS: readonly string[] = ['day', 'releaseSha', 'mergesCompared', 'nowIso', 'deadlineIso'];
/** How many compare-and-set passes a concurrent writer may force before this pass gives up. */
const CAS_PASSES = 3;

type ParsedRequest =
  | { readonly ok: true; readonly request: RecordShadowDayRequest }
  | { readonly ok: false; readonly reason: RecordShadowDayRefusalReason };

/** The outcome of one guarded outbound call. */
type Guarded<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'deadline' }
  | { readonly kind: 'threw' };

function refuse(reason: RecordShadowDayRefusalReason): RecordShadowDayResult {
  return { outcome: 'refused', reason };
}

function unknown(reason: RecordShadowDayUnknownReason): RecordShadowDayResult {
  return { outcome: 'unknown', reason };
}

function isSecretShaped(text: string): boolean {
  return containsSecretShape(text) || LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(text));
}

function isBoundedIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ISO_LENGTH && isZonedIsoDateTime(value);
}

function hasOnlyKeys(snapshot: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(snapshot).every((key) => allowed.includes(key));
}

function parseRequest(input: unknown): ParsedRequest {
  const snapshot = snapshotPlainDataRecord(input);
  if (snapshot === null || Object.keys(snapshot).length > MAX_REQUEST_KEYS) {
    return { ok: false, reason: 'invalid-request' };
  }
  const values = Object.values(snapshot);
  if (values.some((value) => typeof value === 'string' && value.length > MAX_STRING_LENGTH)) {
    return { ok: false, reason: 'invalid-request' };
  }
  if (values.some((value) => typeof value === 'string' && isSecretShaped(value))) {
    return { ok: false, reason: 'secret-shaped' };
  }
  const { day, releaseSha, mergesCompared, nowIso, deadlineIso } = snapshot;
  if (
    !hasOnlyKeys(snapshot, REQUEST_KEYS) ||
    typeof day !== 'string' ||
    !isRecordedShadowDay(day) ||
    typeof releaseSha !== 'string' ||
    !SHA_PATTERN.test(releaseSha) ||
    typeof mergesCompared !== 'number' ||
    !Number.isSafeInteger(mergesCompared) ||
    mergesCompared < 0 ||
    mergesCompared > MAX_REVISION ||
    (nowIso !== undefined && !isBoundedIso(nowIso)) ||
    (deadlineIso !== undefined && !isBoundedIso(deadlineIso))
  ) {
    return { ok: false, reason: 'invalid-request' };
  }
  return {
    ok: true,
    request: {
      day,
      releaseSha,
      mergesCompared,
      ...(nowIso === undefined ? {} : { nowIso }),
      ...(deadlineIso === undefined ? {} : { deadlineIso }),
    },
  };
}

export class RecordShadowDayUseCase implements RecordShadowDayPort {
  constructor(private readonly deps: RecordShadowDayDependencies) {}

  async execute(request: unknown): Promise<RecordShadowDayResult> {
    try {
      const parsed = parseRequest(request);
      if (!parsed.ok) {
        return refuse(parsed.reason);
      }
      return await this.record(parsed.request);
    } catch {
      return refuse('invalid-request');
    }
  }

  /** The guarded pass: window rules, ledger read, evaluation, compare-and-set. */
  private async record(request: RecordShadowDayRequest): Promise<RecordShadowDayResult> {
    const { day, deadlineIso } = request;
    if (this.deadlineReached(request.deadlineIso)) {
      return unknown('deadline-exceeded');
    }
    const nowMs = this.nowMs(request.nowIso);
    if (nowMs === null) {
      return unknown('clock-invalid');
    }
    const window = classifyShadowDayWindow(day, nowMs);
    if (!window.ok) {
      return refuse(window.reason);
    }

    const read = await this.guarded(deadlineIso, () => this.deps.shadowEvidence.read());
    if (read.kind === 'deadline') return unknown('deadline-exceeded');
    if (read.kind === 'threw') return unknown('ledger-unreadable');
    if (read.value.status === 'unreadable') return unknown('ledger-unreadable');
    if (read.value.status === 'unknown-version') return unknown('ledger-unknown-version');
    let ledger =
      read.value.status === 'ok' ? read.value.ledger : emptyShadowEvidenceLedger();

    const evaluation = await this.evaluateCriteria(deadlineIso);
    if ('stop' in evaluation) {
      return evaluation.stop;
    }
    if (evaluation.recorded.length === 0) {
      // Nothing reached a definite verdict, so nothing is recorded anywhere.
      return {
        outcome: 'completed',
        day,
        revision: ledger.revision,
        identicalRepeat: false,
        recorded: [],
        unevaluated: evaluation.unevaluated,
      };
    }

    const merged: RecordShadowDayResult = {
      outcome: 'completed',
      day,
      revision: 0,
      identicalRepeat: false,
      recorded: evaluation.recorded,
      unevaluated: evaluation.unevaluated,
    };
    for (let pass = 0; pass < CAS_PASSES; pass += 1) {
      const merge = mergeShadowDay(ledger, {
        day,
        releaseSha: request.releaseSha,
        mergesCompared: request.mergesCompared,
        verdicts: evaluation.verdicts,
      });
      if (!merge.ok) {
        return refuse('day-criterion-conflict');
      }
      if (merge.identicalRepeat) {
        return { ...merged, revision: ledger.revision, identicalRepeat: true };
      }
      const swap = await this.guarded(deadlineIso, () =>
        this.deps.shadowEvidence.compareAndSet({ expectedRevision: ledger.revision, next: merge.ledger }),
      );
      if (swap.kind === 'deadline') return unknown('deadline-exceeded');
      if (swap.kind === 'threw' || swap.value.outcome === 'refused') return unknown('ledger-write-failed');
      if (swap.value.outcome === 'recorded') {
        return { ...merged, revision: swap.value.ledger.revision, identicalRepeat: false };
      }
      // A concurrent writer moved the revision: re-read and try once more.
      const reread = await this.guarded(deadlineIso, () => this.deps.shadowEvidence.read());
      if (reread.kind === 'deadline') return unknown('deadline-exceeded');
      if (reread.kind === 'threw' || reread.value.status === 'unreadable') return unknown('ledger-unreadable');
      if (reread.value.status === 'unknown-version') return unknown('ledger-unknown-version');
      if (reread.value.status === 'absent') {
        return unknown('ledger-write-failed');
      }
      ledger = reread.value.ledger;
    }
    return unknown('ledger-write-failed');
  }

  /**
   * Runs every criterion's evaluator, deadline-guarded, and splits the
   * answers into definite verdicts and unevaluated criteria. An evaluator
   * that is missing, throws or answers an unusable shape is unevaluated.
   */
  private async evaluateCriteria(
    deadlineIso: string | undefined,
  ): Promise<
    | { readonly recorded: readonly RecordedShadowDayVerdict[]; readonly unevaluated: readonly UnevaluatedShadowCriterion[]; readonly verdicts: Readonly<Record<CutoverShadowCriterion, ShadowDayVerdict>> }
    | { readonly stop: RecordShadowDayResult }
  > {
    const recorded: RecordedShadowDayVerdict[] = [];
    const unevaluated: UnevaluatedShadowCriterion[] = [];
    const verdicts: Record<CutoverShadowCriterion, ShadowDayVerdict> = {} as Record<
      CutoverShadowCriterion,
      ShadowDayVerdict
    >;
    for (const criterion of CUTOVER_SHADOW_CRITERIA) {
      const answer = await this.guarded(deadlineIso, () => this.deps.evaluate(criterion));
      if (answer.kind === 'deadline') return { stop: unknown('deadline-exceeded') };
      if (answer.kind === 'threw') {
        unevaluated.push({ criterion, reason: 'evaluator-unavailable' });
        continue;
      }
      const evaluation = answer.value;
      if (evaluation.status === 'unevaluated') {
        unevaluated.push({ criterion, reason: isBoundedReasonCode(evaluation.reason) ? evaluation.reason : 'invalid-reason' });
        continue;
      }
      const { verdict, reasonCode, inputDigest } = evaluation;
      if (
        (verdict !== 'pass' && verdict !== 'fail') ||
        !isBoundedReasonCode(reasonCode) ||
        typeof inputDigest !== 'string' ||
        !DIGEST_PATTERN.test(inputDigest)
      ) {
        unevaluated.push({ criterion, reason: 'invalid-evaluation' });
        continue;
      }
      recorded.push({ criterion, verdict, reasonCode, inputDigest });
      verdicts[criterion] = { verdict, reasonCode, inputDigest };
    }
    return { recorded, unevaluated, verdicts };
  }

  /** True once `deadlineIso` is reached; an unusable clock counts as reached (fail closed). */
  private deadlineReached(deadlineIso: string | undefined): boolean {
    if (deadlineIso === undefined) {
      return false;
    }
    try {
      return !(Date.parse(this.deps.nowIso()) < Date.parse(deadlineIso));
    } catch {
      return true;
    }
  }

  /** The clock reading in milliseconds, or null when it is unusable. */
  private nowMs(requestNowIso: string | undefined): number | null {
    try {
      const ms = Date.parse(requestNowIso ?? this.deps.nowIso());
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  }

  /** Every outbound call goes through here: deadline first, then the call, never a throw. */
  private async guarded<T>(deadlineIso: string | undefined, call: () => Promise<T>): Promise<Guarded<T>> {
    if (this.deadlineReached(deadlineIso)) {
      return { kind: 'deadline' };
    }
    try {
      return { kind: 'value', value: await call() };
    } catch {
      return { kind: 'threw' };
    }
  }
}

function isBoundedReasonCode(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && REASON_CODE_PATTERN.test(value);
}
