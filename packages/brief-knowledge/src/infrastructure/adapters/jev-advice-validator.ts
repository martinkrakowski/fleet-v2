// Implemented for lane D2 (decision port plan, 2026-10-16).
/**
 * Strict validator for Jev `score` answer bodies. Pure: no I/O, no network.
 * The same rules are applied to live provider responses and to the
 * owner-recorded answer file, so a served or recorded answer is only used
 * when it exactly matches the recorded shape.
 *
 * Every asked key must be present with `type: 'score'`; `probabilities` is an
 * OBJECT keyed exactly "0".."levels-1"; every probability is a finite number
 * in [0,1] summing to within 0.02 of 1; `confidence` is finite in [0,1] and at
 * least `minConfidence`. The decision score is the expectation
 * `Σ p_i × i / (levels − 1)` in [0,1]. Any shape violation is `shape`; any
 * confidence below `minConfidence` is `low-confidence`. No body content ever
 * appears in a failure reason.
 */

export const DEFAULT_DECISION_LEVELS = 4;

/** Criteria levels, fixed, ordered least → most relevant (index 0 → 3). */
export const JEV_CRITERIA_LEVELS: readonly string[] = [
  'not relevant',
  'slightly relevant',
  'relevant',
  'highly relevant',
];

/** Maximum allowed drift of the probability sum from 1. */
const PROBABILITY_SUM_TOLERANCE = 0.02;

/** `model` and `id` must be short, opaque identifier strings. */
const ID_OR_MODEL_PATTERN = /^[A-Za-z0-9._/:-]+$/;

function isValidIdOrModel(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 128 && ID_OR_MODEL_PATTERN.test(value)
  );
}

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

/** Expected probability object keys for the given level count: "0".."levels-1". */
function expectedProbabilityKeys(levels: number): string[] {
  return Array.from({ length: levels }, (_, i) => String(i));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a Jev response body against the asked question keys. `levels` is
 * the number of criteria levels (default 4); `minConfidence` is the lowest
 * acceptable per-answer confidence. Never throws; failures carry no content.
 */
export function validateScoreAnswers(
  body: unknown,
  askedKeys: readonly string[],
  levels: number = DEFAULT_DECISION_LEVELS,
  minConfidence: number = 0,
): ScoreAnswersValidation {
  if (!Array.isArray(askedKeys) || askedKeys.length === 0) {
    return { ok: false, reason: 'shape' };
  }
  if (!Number.isInteger(levels) || levels < 2) {
    return { ok: false, reason: 'shape' };
  }
  if (!Number.isFinite(minConfidence)) {
    return { ok: false, reason: 'shape' };
  }
  if (!isPlainObject(body)) {
    return { ok: false, reason: 'shape' };
  }
  if (!isValidIdOrModel(body.model)) {
    return { ok: false, reason: 'shape' };
  }
  if (body.id !== undefined && !isValidIdOrModel(body.id)) {
    return { ok: false, reason: 'shape' };
  }
  if (!isPlainObject(body.answers)) {
    return { ok: false, reason: 'shape' }
  }

  const answers = body.answers;
  const scores: Record<string, number> = {};
  let confidence = Number.POSITIVE_INFINITY;

  for (const key of askedKeys) {
    if (typeof key !== 'string' || key.length === 0) {
      return { ok: false, reason: 'shape' };
    }
    const answer = answers[key];
    if (!isPlainObject(answer)) {
      return { ok: false, reason: 'shape' };
    }
    if (answer.type !== 'score') {
      return { ok: false, reason: 'shape' };
    }
    // Probabilities are an object keyed by level index strings, exactly
    // "0".."levels-1" — an array or a different key set is a shape failure.
    const probabilities = answer.probabilities;
    if (!isPlainObject(probabilities)) {
      return { ok: false, reason: 'shape' };
    }
    const expectedKeys = expectedProbabilityKeys(levels);
    const actualKeys = Object.keys(probabilities);
    if (
      actualKeys.length !== expectedKeys.length ||
      !expectedKeys.every((expected) => actualKeys.includes(expected))
    ) {
      return { ok: false, reason: 'shape' };
    }

    let sum = 0;
    const values: number[] = [];
    for (const probabilityKey of expectedKeys) {
      const value = probabilities[probabilityKey];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        return { ok: false, reason: 'shape' };
      }
      values.push(value);
      sum += value;
    }
    if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
      return { ok: false, reason: 'shape' };
    }

    const answerConfidence = answer.confidence;
    if (
      typeof answerConfidence !== 'number' ||
      !Number.isFinite(answerConfidence) ||
      answerConfidence < 0 ||
      answerConfidence > 1
    ) {
      return { ok: false, reason: 'shape' };
    }

    // decisionScore = Σ p_i × i / (levels − 1), in [0,1].
    let expectation = 0;
    for (let i = 0; i < values.length; i++) {
      expectation += values[i] * i;
    }
    scores[key] = expectation / (levels - 1);
    confidence = Math.min(confidence, answerConfidence);
  }

  if (confidence < minConfidence) {
    return { ok: false, reason: 'low-confidence' };
  }

  return { ok: true, scores, confidence, model: body.model };
}
