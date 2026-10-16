// @generated inbound contract scaffold — refined for lane Q1b.
/**
 * ExpireOwnerQuestionsPort: move open questions whose expiresAt has passed to
 * the expired state, judged by the injected clock. Expired questions stay
 * blocking; they are re-asked, never silently dropped. The clock comes from
 * the composition root's dependencies, never the request.
 */

import type { OwnerQuestionRecord } from '../../../domain/owner-question-records.js';

export type ExpireOwnerQuestionsResult = {
  readonly outcome: 'expired';
  /** The questions this run moved to the expired state, in listing order. */
  readonly expired: readonly OwnerQuestionRecord[];
  /** Open questions that still had time left, or no expiry at all. */
  readonly unchanged: readonly OwnerQuestionRecord[];
};

export interface ExpireOwnerQuestionsPort {
  /** Expire open questions past their expiry using the injected clock. */
  expireOwnerQuestions(): Promise<ExpireOwnerQuestionsResult>;
}
