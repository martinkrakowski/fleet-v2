// Lane K1 tests: the decision kernel in @fleet/shared, pinned against the
// owner-recorded Jev fixtures in ./fixtures/jev/ (real responses taken
// before K1).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  budgetAllows,
  buildDecisionState,
  containsSecretShape,
  isValidIdOrModel,
  toJevQuestion,
  validateChoiceAnswer,
  validateScoreAnswer,
  validateYesNoAnswer,
  type ChoiceQuestion,
  type ScoreQuestion,
} from '../index.js';

const fixturesDir = new URL('./fixtures/jev/', import.meta.url);

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, fixturesDir), 'utf8'));
}

const scoreRequest = readFixture('jev-score-request.json') as {
  questions: Record<string, { type: string; instructions: string; criteria: string[] }>;
};
const scoreResponse = readFixture('jev-score-response.json') as {
  answers: Record<string, { type: string; probabilities: unknown; confidence: number }>;
};

const scoreQuestions: Record<string, ScoreQuestion> = Object.fromEntries(
  Object.entries(scoreRequest.questions).map(([key, question]) => [
    key,
    {
      kind: 'score',
      instructions: question.instructions,
      levels: question.criteria,
    },
  ]),
);

const choiceRequest = readFixture('jev-choice-request.json') as {
  questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }>;
};
const choiceResponse = readFixture('jev-choice-response.json') as {
  answers: Record<string, { type: string; choice: string; probabilities: unknown; confidence: number }>;
};

const choiceQuestions: Record<string, ChoiceQuestion> = Object.fromEntries(
  Object.entries(choiceRequest.questions).map(([key, question]) => [
    key,
    {
      kind: 'choice',
      instructions: question.instructions,
      options: question.criteria,
    },
  ]),
);

describe('score validator against the owner-recorded fixture', () => {
  it('accepts every asked answer', () => {
    for (const key of Object.keys(scoreQuestions)) {
      const result = validateScoreAnswer(
        scoreResponse.answers[key],
        scoreQuestions[key]!,
        0.5,
      );
      expect(result.ok).toBe(true);
    }
  });

  it('gives k0 a higher value than k1', () => {
    const k0 = validateScoreAnswer(scoreResponse.answers.k0, scoreQuestions.k0!, 0);
    const k1 = validateScoreAnswer(scoreResponse.answers.k1, scoreQuestions.k1!, 0);
    expect(k0.ok && k1.ok).toBe(true);
    if (k0.ok && k1.ok) {
      expect(k0.value! > k1.value!).toBe(true);
      expect(k0.value!).toBeCloseTo(0.97, 10);
    }
  });

  it('rejects a mutated answer set', () => {
    const question = scoreQuestions.k0!;
    const answer = scoreResponse.answers.k0 as unknown as Record<string, unknown> & {
      probabilities: Record<string, number>;
    };

    // missing key
    const missing = { ...answer, probabilities: { '0': 0.01, '1': 0.01, '2': 0.04 } };
    expect(validateScoreAnswer(missing, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });

    // extra key
    const extra = { ...answer, probabilities: { ...answer.probabilities, '4': 0 } };
    expect(validateScoreAnswer(extra, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });

    // non-finite
    const nonFinite = { ...answer, probabilities: { ...answer.probabilities, '3': Number.NaN } };
    expect(validateScoreAnswer(nonFinite, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });

    // out of range
    const outOfRange = { ...answer, probabilities: { ...answer.probabilities, '3': 1.5 } };
    expect(validateScoreAnswer(outOfRange, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });

    // bad sum
    const badSum = { ...answer, probabilities: { ...answer.probabilities, '3': 0.5 } };
    expect(validateScoreAnswer(badSum, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });

    // wrong kind
    const wrongKind = { ...answer, type: 'choice' };
    expect(validateScoreAnswer(wrongKind, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });

    // confidence field out of range
    const badConfidence = { ...answer, confidence: 1.5 };
    expect(validateScoreAnswer(badConfidence, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });

    // low confidence
    const low = { ...answer, confidence: 0.3 };
    expect(validateScoreAnswer(low, question, 0.5)).toEqual({
      ok: false,
      reason: 'low-confidence',
    });
  });
});

describe('choice validator against the owner-recorded fixture', () => {
  it('accepts every asked answer and classifies k2 as status_noise', () => {
    for (const key of Object.keys(choiceQuestions)) {
      const result = validateChoiceAnswer(
        choiceResponse.answers[key],
        choiceQuestions[key]!,
        0.4,
      );
      expect(result.ok).toBe(true);
    }
    const k2 = validateChoiceAnswer(choiceResponse.answers.k2, choiceQuestions.k2!, 0.4);
    expect(k2.ok).toBe(true);
    if (k2.ok) {
      expect(k2.choice).toBe('status_noise');
      expect(k2.confidence).toBe(0.99);
    }
  });

  it('rejects a mutated answer set', () => {
    const question = choiceQuestions.k2!;
    const answer = choiceResponse.answers.k2 as unknown as Record<string, unknown> & {
      probabilities: Record<string, number>;
    };

    // missing key
    const missing = {
      ...answer,
      probabilities: { lesson: 0, policy_proposal: 0, instruction: 0.01 },
    };
    expect(validateChoiceAnswer(missing, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });

    // extra key
    const extra = {
      ...answer,
      probabilities: { ...answer.probabilities, other: 0 },
    };
    expect(validateChoiceAnswer(extra, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });

    // non-finite
    const nonFinite = {
      ...answer,
      probabilities: { ...answer.probabilities, status_noise: Number.NaN },
    };
    expect(validateChoiceAnswer(nonFinite, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });

    // out of range
    const outOfRange = {
      ...answer,
      probabilities: { ...answer.probabilities, status_noise: -0.1 },
    };
    expect(validateChoiceAnswer(outOfRange, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });

    // bad sum
    const badSum = {
      ...answer,
      probabilities: { ...answer.probabilities, status_noise: 0.5 },
    };
    expect(validateChoiceAnswer(badSum, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });

    // tie: the chosen id is not the single highest-probability id
    const tie = {
      ...answer,
      probabilities: {
        lesson: 0.5,
        policy_proposal: 0,
        instruction: 0,
        status_noise: 0.5,
      },
    };
    expect(validateChoiceAnswer(tie, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });

    // choice is not the argmax
    const notArgmax = {
      ...answer,
      probabilities: { lesson: 0.9, policy_proposal: 0, instruction: 0.01, status_noise: 0.09 },
    };
    expect(validateChoiceAnswer(notArgmax, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });

    // choice is not one of the option ids
    const unknownChoice = { ...answer, choice: 'other' };
    expect(validateChoiceAnswer(unknownChoice, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });

    // wrong kind
    const wrongKind = { ...answer, type: 'score' };
    expect(validateChoiceAnswer(wrongKind, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });

    // low confidence
    const low = { ...answer, confidence: 0.3 };
    expect(validateChoiceAnswer(low, question, 0.4)).toEqual({
      ok: false,
      reason: 'low-confidence',
    });
  });
});

describe('yes-no validator', () => {
  it('derives confidence as max(p, 1-p)', () => {
    expect(validateYesNoAnswer({ type: 'noul', probability: 0.8 }, { kind: 'yes-no', instructions: 'i' }, 0)).toEqual({
      ok: true,
      probability: 0.8,
      confidence: 0.8,
    });
    expect(validateYesNoAnswer({ type: 'noul', probability: 0.3 }, { kind: 'yes-no', instructions: 'i' }, 0)).toEqual({
      ok: true,
      probability: 0.3,
      confidence: 0.7,
    });
  });

  it('gates on minConfidence', () => {
    expect(validateYesNoAnswer({ type: 'noul', probability: 0.5 }, { kind: 'yes-no', instructions: 'i' }, 0.6)).toEqual({
      ok: false,
      reason: 'low-confidence',
    });
  });

  it('rejects shape violations', () => {
    const question = { kind: 'yes-no', instructions: 'i' } as const;
    expect(validateYesNoAnswer({ type: 'noul', probability: 1.5 }, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });
    expect(validateYesNoAnswer({ type: 'noul', probability: Number.NaN }, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });
    expect(validateYesNoAnswer({ type: 'score', probability: 0.8 }, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });
    expect(validateYesNoAnswer({ type: 'noul' }, question, 0)).toEqual({
      ok: false,
      reason: 'shape',
    });
  });
});

describe('isValidIdOrModel', () => {
  it('accepts short identifier strings', () => {
    expect(isValidIdOrModel('typesafe/jev-1.14-20261014')).toBe(true);
    expect(isValidIdOrModel('gen-fixture')).toBe(true);
  });

  it('rejects wrong shapes', () => {
    expect(isValidIdOrModel('a b')).toBe(false);
    expect(isValidIdOrModel('x'.repeat(129))).toBe(false);
    expect(isValidIdOrModel('x'.repeat(128))).toBe(true);
    expect(isValidIdOrModel(42)).toBe(false);
  });
});

describe('toJevQuestion', () => {
  it('maps the three kinds to Jev wire shapes', () => {
    expect(toJevQuestion({ kind: 'yes-no', instructions: 'i' })).toEqual({
      type: 'noul',
      instructions: 'i',
    });
    expect(
      toJevQuestion({ kind: 'choice', instructions: 'i', options: { a: 'A', b: 'B' } }),
    ).toEqual({
      type: 'choice',
      instructions: 'i',
      criteria: { a: 'A', b: 'B' },
    });
    expect(
      toJevQuestion({ kind: 'score', instructions: 'i', levels: ['low', 'high'] }),
    ).toEqual({
      type: 'score',
      instructions: 'i',
      levels: ['low', 'high'],
    });
  });
});

describe('buildDecisionState', () => {
  const caps = { perFieldBytes: 64, totalBytes: 128 };
  const hash = (s: string) => `sha:${s.length}`;

  it('builds state and hashes the exact JSON', () => {
    const result = buildDecisionState(
      { taskSummary: 'Fix the failing test', pathPrefixes: ['src/utils'] },
      caps,
      hash,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stateJson).toBe(
        JSON.stringify({ taskSummary: 'Fix the failing test', pathPrefixes: ['src/utils'] }),
      );
      expect(result.stateSha256).toBe(hash(result.stateJson));
    }
  });

  it('refuses when a secret is assembled at runtime', () => {
    // Individually harmless pieces assembled into a key-shaped string.
    const prefix = ['sk', '-'].join('');
    const secret = [prefix, 'a'.repeat(30)].join('');
    expect(containsSecretShape(secret)).toBe(true);
    expect(
      buildDecisionState({ taskSummary: secret }, caps, hash),
    ).toEqual({ ok: false, reason: 'redaction-refused' });
    expect(
      buildDecisionState({ paths: ['src', 'a'.repeat(20)], notes: secret }, caps, hash),
    ).toEqual({ ok: false, reason: 'redaction-refused' });
  });

  it('refuses per-field overflow and total overflow', () => {
    const long = 'x'.repeat(65);
    expect(
      buildDecisionState({ taskSummary: long }, caps, hash),
    ).toEqual({ ok: false, reason: 'redaction-refused' });
    const okField = 'y'.repeat(40);
    expect(
      buildDecisionState(
        { taskSummary: 'x'.repeat(40), pathPrefixes: ['z'.repeat(40)], more: 'w'.repeat(40) },
        { perFieldBytes: 64, totalBytes: 100 },
        hash,
      ),
    ).toEqual({ ok: false, reason: 'redaction-refused' });
    expect(
      buildDecisionState(
        { taskSummary: okField, pathPrefixes: ['z'.repeat(40)], more: 'w'.repeat(60) },
        caps,
        hash,
      ),
    ).toEqual({ ok: false, reason: 'redaction-refused' });
  });

  it('counts UTF-8 multi-byte characters as bytes', () => {
    // 'é' is 2 UTF-8 bytes per character: 64 chars = 128 bytes, one over the cap.
    expect(buildDecisionState({ taskSummary: 'é'.repeat(65) }, caps, hash)).toEqual({
      ok: false,
      reason: 'redaction-refused',
    });
    expect(buildDecisionState({ taskSummary: 'é'.repeat(32) }, caps, hash).ok).toBe(true);
  });
});

describe('budgetAllows', () => {
  it('refuses at the consumer cap and below it', () => {
    expect(
      budgetAllows({
        consumerSpend: 9,
        consumerBudget: 10,
        totalSpend: 0,
        totalBudget: 100,
        assumedCost: 1,
      }),
    ).toEqual({ ok: false, reason: 'consumer-budget' });
    expect(
      budgetAllows({
        consumerSpend: 8.9,
        consumerBudget: 10,
        totalSpend: 0,
        totalBudget: 100,
        assumedCost: 1,
      }),
    ).toEqual({ ok: true });
  });

  it('refuses at the total cap', () => {
    expect(
      budgetAllows({
        consumerSpend: 0,
        consumerBudget: 10,
        totalSpend: 99,
        totalBudget: 100,
        assumedCost: 1,
      }),
    ).toEqual({ ok: false, reason: 'total-budget' });
  });

  it('ignores the consumer clause when no consumer budget is given', () => {
    expect(
      budgetAllows({
        consumerSpend: 1000,
        totalSpend: 0,
        totalBudget: 100,
        assumedCost: 1,
      }),
    ).toEqual({ ok: true });
  });

  it('refuses with the total reason even when the consumer budget allows', () => {
    expect(
      budgetAllows({
        consumerSpend: 1,
        consumerBudget: 10,
        totalSpend: 10,
        totalBudget: 10,
        assumedCost: 0.5,
      }),
    ).toEqual({ ok: false, reason: 'total-budget' });
  });
});
