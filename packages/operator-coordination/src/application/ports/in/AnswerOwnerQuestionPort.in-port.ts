// @generated inbound contract scaffold — refined for lane Q1b.
/**
 * AnswerOwnerQuestionPort: record the owner's answer on a two-way question at
 * its current revision, idempotently. A one-way question is answered only by a
 * signed owner decision, never through this port. An answer grants nothing: it
 * touches no coordination request.
 */

import type { OwnerQuestionRecord } from '../../../domain/owner-question-records.js';

export interface AnswerOwnerQuestionRequest {
  readonly questionId: string;
  /** The revision of the question the owner saw; must be the current one. */
  readonly questionRevision: number;
  readonly shape: 'accept' | 'reject' | 'answer';
  readonly optionId?: string | null;
  readonly text?: string | null;
  readonly reason?: string | null;
  readonly answeredVia: 'web' | 'cli';
  readonly sessionId?: string | null;
}

export type AnswerOwnerQuestionResult =
  | {
      readonly outcome: 'answered';
      readonly question: OwnerQuestionRecord;
      /** True when this exact answer was already recorded and is replayed. */
      readonly replayed: boolean;
    }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface AnswerOwnerQuestionPort {
  answerOwnerQuestion(request: AnswerOwnerQuestionRequest): Promise<AnswerOwnerQuestionResult>;
}
