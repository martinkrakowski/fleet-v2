// Implemented for lane D2 (decision port plan, 2026-10-16); adopted from the
// decision kernel in lane K2 (2026-10-16_decision-kernel-and-claim-triage, §1).
/**
 * Ranking consumer's binding to the decision kernel (`@fleet/shared`). The
 * rules live in the kernel's `validateScoreAnswer` and `isValidIdOrModel`;
 * this module is the thin wrapper that maps one multi-key Jev response body
 * onto the kernel's per-answer validator and keeps the ranking scale. The same
 * kernel validator is applied to live provider responses and to the
 * owner-recorded answer file, so a served or recorded answer is only used when
 * it exactly matches the recorded shape.
 *
 * Every asked key must be present with `type: 'score'`; `probabilities` is an
 * OBJECT keyed exactly "0".."levels-1"; every probability is a finite number
 * in [0,1] summing to within 0.02 of 1; `confidence` is finite in [0,1] and at
 * least `minConfidence`. The decision score is the expectation
 * `Σ p_i × i / (levels − 1)` in [0,1]. Any shape violation is `shape`; any
 * confidence below `minConfidence` is `low-confidence`. No body content ever
 * appears in a failure reason.
 */

import { isValidIdOrModel, validateScoreAnswer } from '@fleet/shared';
import type { ScoreQuestion } from '@fleet/shared';

export const DEFAULT_DECISION_LEVELS = 4;

/** Criteria levels, fixed, ordered least → most relevant (index 0 → 3). */
export const JEV_CRITERIA_LEVELS: readonly string[] = [
  'not relevant',
  'slightly relevant',
  'relevant',
  'highly relevant',
];

/** The kernel's id and model rule; re-exported so callers import one module. */
export { isValidIdOrModel };

export interface ScoreAnswersValid {
  readonly ok: true;
  /** Expectation score in [0,1] per asked key. */
  readonly scores: Record<string, number>;
  /** Minimum confidence over all asked keys. */
  readonly confidence: number;
  /** Served model id as reported by the body; recorded, never trusted. */
  readonly model: string;
}

export interface ScoreAnswersInvalid {
  readonly ok: false;
  readonly reason: 'shape' | 'low-confidence';
}

export type ScoreAnswersValidation = ScoreAnswersValid | ScoreAnswersInvalid;

/** A fresh shape failure; no body content ever travels with it. */
function shape(): ScoreAnswersInvalid {
  return { ok: false, reason: 'shape' };
}

/**
 * The kernel asks a `score` question against named level strings and reads
 * only its length ("0".."n-1"); the ranking scale is the declared one, padded
 * with generated names when a caller asks for more levels than it declares.
 */
function scoreQuestion(levels: number): ScoreQuestion {
  return {
    kind: 'score',
    instructions: 'How relevant is the candidate to the task?',
    levels: Array.from({ length: levels }, (_, index) => JEV_CRITERIA_LEVELS[index] ?? `level ${index}`),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a Jev response body against the asked question keys. `levels` is
 * the number of criteria levels (default 4); `minConfidence` is the lowest
 * acceptable per-answer confidence. Never throws; failures carry no content.
 *
 * Shape first, gate second: every asked key is validated with the kernel at
 * `minConfidence` 0, then the lowest observed confidence is gated once, so a
 * malformed key anywhere in the body is still a `shape` failure.
 */
export function validateScoreAnswers(
  body: unknown,
  askedKeys: readonly string[],
  levels: number = DEFAULT_DECISION_LEVELS,
  minConfidence: number = 0,
): ScoreAnswersValidation {
  if (!Array.isArray(askedKeys) || askedKeys.length === 0) {
    return shape();
  }
  if (!Number.isInteger(levels) || levels < 2) {
    return shape();
  }
  if (!Number.isFinite(minConfidence)) {
    return shape();
  }
  if (!isPlainObject(body)) {
    return shape();
  }
  if (!isValidIdOrModel(body.model)) {
    return shape();
  }
  if (body.id !== undefined && !isValidIdOrModel(body.id)) {
    return shape();
  }
  const answers = body.answers;
  if (!isPlainObject(answers)) {
    return shape();
  }

  const question = scoreQuestion(levels);
  const scores: Record<string, number> = {};
  let confidence = Number.POSITIVE_INFINITY;

  for (const key of askedKeys) {
    if (typeof key !== 'string' || key.length === 0) {
      return shape();
    }
    const answer = validateScoreAnswer(answers[key], question, 0);
    if (!answer.ok) {
      return shape();
    }
    // The kernel reports a value for a score answer; a missing one is a shape
    // failure rather than a silent zero.
    if (typeof answer.value !== 'number' || !Number.isFinite(answer.value)) {
      return shape();
    }
    scores[key] = answer.value;
    confidence = Math.min(confidence, answer.confidence);
  }

  if (confidence < minConfidence) {
    return { ok: false, reason: 'low-confidence' };
  }

  return { ok: true, scores, confidence, model: body.model };
}
