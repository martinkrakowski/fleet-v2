// Decision kernel (lane K1, plan 2026-10-16_decision-kernel-and-claim-triage
// §1): the question and answer types a context uses to ask a small structured
// question, and the mapping to Jev's wire shape. Pure: no I/O, no
// dependencies, no `node:` imports.

/** The three supported question kinds. */
export type QuestionKind = 'yes-no' | 'choice' | 'score';

/**
 * A yes-or-no question. Jev's wire kind for this is `noul`; the single
 * probability is the chance of `yes`.
 */
export interface YesNoQuestion {
  readonly kind: 'yes-no';
  readonly instructions: string;
}

/**
 * A classification question over a fixed, caller-declared set of options.
 * Option ids are the criteria ids Jev echoes back in `choice` and the keys of
 * `probabilities`.
 */
export interface ChoiceQuestion {
  readonly kind: 'choice';
  readonly instructions: string;
  readonly options: Readonly<Record<string, string>>;
}

/**
 * A rating question over an ordered level scale, least → most (index 0 →
 * n−1). Jev's wire kind for this is `score`.
 */
export interface ScoreQuestion {
  readonly kind: 'score';
  readonly instructions: string;
  readonly levels: readonly string[];
}

export type DecisionQuestion = YesNoQuestion | ChoiceQuestion | ScoreQuestion;

/** Answer to a `yes-no` question: the single probability of `yes`. */
export interface YesNoAnswer {
  readonly kind: 'yes-no';
  readonly probability: number;
}

/** Answer to a `choice` question: the chosen id and the option probabilities. */
export interface ChoiceAnswer {
  readonly kind: 'choice';
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
}

/** Answer to a `score` question: probabilities keyed by level index "0".."n-1". */
export interface ScoreAnswer {
  readonly kind: 'score';
  readonly probabilities: Readonly<Record<string, number>>;
}

export type DecisionAnswer = YesNoAnswer | ChoiceAnswer | ScoreAnswer;

/** Jev wire shape for a question, as sent in a request body's `questions`. */
export interface JevWireQuestion {
  readonly type: 'noul' | 'choice' | 'score';
  readonly instructions: string;
  /** `choice` only: the criteria object (option id → description). */
  readonly criteria?: Readonly<Record<string, string>>;
  /** `score` only: the criteria array of level strings. */
  readonly levels?: readonly string[];
}

/**
 * Map a kernel question to Jev's wire shape: `yes-no` → `noul`, `choice` →
 * `choice` with a criteria object, `score` → `score` with a criteria array.
 */
export function toJevQuestion(question: DecisionQuestion): JevWireQuestion {
  switch (question.kind) {
    case 'yes-no':
      return { type: 'noul', instructions: question.instructions };
    case 'choice':
      return {
        type: 'choice',
        instructions: question.instructions,
        criteria: { ...question.options },
      };
    case 'score':
      return {
        type: 'score',
        instructions: question.instructions,
        levels: [...question.levels],
      };
  }
}
