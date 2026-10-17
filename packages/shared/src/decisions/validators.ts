// Decision kernel (lane K1): strict validators, one per question kind,
// applied to every provider response and to recorded answer files. Pure: no
// I/O, no dependencies, no `node:` imports.
//
// The same rules as brief-knowledge's jev-advice-validator, generalized per
// kind. Every validator takes the question it validates against and a
// `minConfidence`; a shape violation is `{ok:false, reason:'shape'}`, a
// confidence below the threshold is `{ok:false, reason:'low-confidence'}`. No
// answer content ever appears in a failure reason.

import type {
  ChoiceQuestion,
  ScoreQuestion,
  YesNoQuestion,
} from './types.js';

/** Maximum allowed drift of the probability sum from 1. */
const PROBABILITY_SUM_TOLERANCE = 0.02;

/** `model` and request `id` must be short, opaque identifier strings. */
const ID_OR_MODEL_PATTERN = /^[A-Za-z0-9._/:-]+$/;

/** True for ≤128 chars of `[A-Za-z0-9._/:-]`. */
export function isValidIdOrModel(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 128 && ID_OR_MODEL_PATTERN.test(value)
  );
}

export interface DecisionValidationOk {
  readonly ok: true;
  /** `score` only: the expectation Σ p_i·i/(n−1) in [0,1]. */
  readonly value?: number;
  /** `choice` only: the single highest-probability option id. */
  readonly choice?: string;
  /** `yes-no` only: the probability of `yes` in [0,1]. */
  readonly probability?: number;
  /** Per-answer confidence in [0,1]. */
  readonly confidence: number;
}

export interface DecisionValidationInvalid {
  readonly ok: false;
  readonly reason: 'shape' | 'low-confidence';
}

export type DecisionValidation = DecisionValidationOk | DecisionValidationInvalid;

/** Jev wire answer `type` per kernel kind: `yes-no` is `noul`. */
function expectedWireType(kind: 'yes-no' | 'choice' | 'score'): string {
  return kind === 'yes-no' ? 'noul' : kind;
}

interface WireAnswer {
  readonly probabilities: Readonly<Record<string, unknown>>;
  readonly confidence: unknown;
  readonly choice?: unknown;
  readonly probability?: unknown;
}

function readWireAnswer(
  answer: unknown,
  kind: 'yes-no' | 'choice' | 'score',
): WireAnswer | null {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    return null;
  }
  const record = answer as Record<string, unknown>;
  if (record.type !== expectedWireType(kind)) {
    return null;
  }
  if (kind !== 'yes-no') {
    const probabilities = record.probabilities;
    if (
      typeof probabilities !== 'object' ||
      probabilities === null ||
      Array.isArray(probabilities)
    ) {
      return null;
    }
    return {
      probabilities: probabilities as Record<string, unknown>,
      confidence: record.confidence,
      choice: record.choice,
      probability: record.probability,
    };
  }
  return {
    probabilities: {},
    confidence: record.confidence,
    choice: record.choice,
    probability: record.probability,
  };
}

/** Reject when the probability key set is not exactly the expected set. */
function keysExactly(
  probabilities: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(probabilities);
  if (actual.length !== expected.length) {
    return false;
  }
  return expected.every((key) => Object.hasOwn(probabilities, key));
}

/**
 * Read probabilities keyed exactly by `expectedIds`, finite and in [0,1].
 * Returns the values in `expectedIds` order, or null on any shape violation
 * (missing key, extra key, non-finite, out of range) or a sum outside 1±0.02.
 */
function readProbabilities(
  probabilities: Readonly<Record<string, unknown>>,
  expectedIds: readonly string[],
): readonly number[] | null {
  if (!keysExactly(probabilities, expectedIds)) {
    return null;
  }
  const values: number[] = [];
  let sum = 0;
  for (const id of expectedIds) {
    const value = probabilities[id];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      return null;
    }
    values.push(value);
    sum += value;
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
    return null;
  }
  return values;
}

function checkConfidenceField(confidence: unknown): number | null {
  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return null;
  }
  return confidence;
}

function gate(confidence: number, minConfidence: number): DecisionValidation {
  if (confidence < minConfidence) {
    return { ok: false, reason: 'low-confidence' };
  }
  return { ok: true, confidence };
}

/**
 * Validate a `score` answer against its question. `probabilities` is keyed
 * exactly `"0".."n−1"`; the value is the expectation `Σ p_i·i/(n−1)` in
 * [0,1]. `answerConfidence` may be passed when the caller already validated
 * the wire's confidence field; otherwise the answer's own `confidence`
 * field is read.
 */
export function validateScoreAnswer(
  answer: unknown,
  question: ScoreQuestion,
  minConfidence: number,
): DecisionValidation {
  if (question.levels.length < 2) {
    return { ok: false, reason: 'shape' };
  }
  const wire = readWireAnswer(answer, 'score');
  if (wire === null) {
    return { ok: false, reason: 'shape' };
  }
  const expectedKeys = Array.from(
    { length: question.levels.length },
    (_, index) => String(index),
  );
  const values = readProbabilities(wire.probabilities, expectedKeys);
  if (values === null) {
    return { ok: false, reason: 'shape' };
  }
  const confidence = checkConfidenceField(wire.confidence);
  if (confidence === null) {
    return { ok: false, reason: 'shape' };
  }
  let expectation = 0;
  for (let index = 0; index < values.length; index += 1) {
    expectation += values[index] * index;
  }
  const value = expectation / (question.levels.length - 1);
  const gated = gate(confidence, minConfidence);
  return gated.ok ? { ok: true, value, confidence } : gated;
}

/**
 * Validate a `choice` answer against its question. `choice` must be one of
 * the option ids; `probabilities` is keyed exactly by those ids; and
 * `choice` must be the single highest-probability id — a tie is a `shape`
 * failure.
 */
export function validateChoiceAnswer(
  answer: unknown,
  question: ChoiceQuestion,
  minConfidence: number,
): DecisionValidation {
  const optionIds = Object.keys(question.options);
  if (optionIds.length < 2) {
    return { ok: false, reason: 'shape' };
  }
  const wire = readWireAnswer(answer, 'choice');
  if (wire === null) {
    return { ok: false, reason: 'shape' };
  }
  if (
    typeof wire.choice !== 'string' ||
    !optionIds.includes(wire.choice)
  ) {
    return { ok: false, reason: 'shape' };
  }
  const values = readProbabilities(wire.probabilities, optionIds);
  if (values === null) {
    return { ok: false, reason: 'shape' };
  }
  const confidence = checkConfidenceField(wire.confidence);
  if (confidence === null) {
    return { ok: false, reason: 'shape' };
  }
  let bestIndex = 0;
  let tied = false;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] > values[bestIndex]) {
      bestIndex = index;
      tied = false;
    } else if (values[index] === values[bestIndex]) {
      tied = true;
    }
  }
  if (tied || optionIds[bestIndex] !== wire.choice) {
    return { ok: false, reason: 'shape' };
  }
  const gated = gate(confidence, minConfidence);
  return gated.ok ? { ok: true, choice: wire.choice, confidence } : gated;
}

/**
 * Validate a `yes-no` answer (Jev `noul`): the single `probability` is
 * finite in [0,1]; the confidence is `max(p, 1 − p)`.
 */
export function validateYesNoAnswer(
  answer: unknown,
  _question: YesNoQuestion,
  minConfidence: number,
): DecisionValidation {
  const record = readWireAnswer(answer, 'yes-no');
  if (record === null) {
    return { ok: false, reason: 'shape' };
  }
  const probability = record.probability;
  if (
    typeof probability !== 'number' ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  ) {
    return { ok: false, reason: 'shape' };
  }
  const confidence = Math.max(probability, 1 - probability);
  const gated = gate(confidence, minConfidence);
  return gated.ok ? { ok: true, probability, confidence } : gated;
}
