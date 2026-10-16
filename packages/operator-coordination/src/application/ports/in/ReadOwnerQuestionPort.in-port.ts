// @generated inbound contract scaffold — refined for lane Q1b.
/**
 * ReadOwnerQuestionPort: read one owner question by id. Known absence is
 * reported, never invented. This is a thin read; it never mutates state.
 */

import type { OwnerQuestionRecord } from '../../../domain/owner-question-records.js';

export interface ReadOwnerQuestionRequest {
  readonly questionId: string;
}

export type ReadOwnerQuestionResult =
  | { readonly outcome: 'found'; readonly question: OwnerQuestionRecord }
  | { readonly outcome: 'not-found'; readonly questionId: string };

export interface ReadOwnerQuestionPort {
  /** Read one owner question by id; known absence is reported, never invented. */
  readOwnerQuestion(request: ReadOwnerQuestionRequest): Promise<ReadOwnerQuestionResult>;
}
