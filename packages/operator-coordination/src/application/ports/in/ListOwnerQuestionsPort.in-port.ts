// @generated inbound contract scaffold — refined for lane Q1b.
/**
 * ListOwnerQuestionsPort: list owner questions, optionally narrowed by state and
 * asked-at lower bound. This is a thin read; it never mutates state.
 */

import type { OwnerQuestionRecord } from '../../../domain/owner-question-records.js';

export interface ListOwnerQuestionsRequest {
  /** Only questions in this state. */
  readonly state?: OwnerQuestionRecord['state'];
  /** Only questions asked at or after this ISO timestamp. */
  readonly since?: string;
}

export interface ListOwnerQuestionsResult {
  readonly questions: readonly OwnerQuestionRecord[];
}

export interface ListOwnerQuestionsPort {
  /** List owner questions, optionally narrowed by state and asked-at lower bound. */
  listOwnerQuestions(request: ListOwnerQuestionsRequest): Promise<ListOwnerQuestionsResult>;
}
