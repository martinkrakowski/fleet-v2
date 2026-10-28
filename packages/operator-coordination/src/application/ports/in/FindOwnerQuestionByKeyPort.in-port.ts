// @generated inbound contract scaffold — refined for lane Q1-2.
/**
 * FindOwnerQuestionByKeyPort: read one owner question by its idempotency
 * key. Known absence is reported as `not-found`, never invented, and reading
 * writes nothing.
 */

import type { OwnerQuestionRecord } from '../../../domain/owner-question-records.js';

export interface FindOwnerQuestionByKeyRequest {
  /** The idempotency key to look up. */
  readonly idempotencyKey: string;
}

export type FindOwnerQuestionByKeyResult =
  | { readonly outcome: 'found'; readonly question: OwnerQuestionRecord }
  | { readonly outcome: 'not-found' };

export interface FindOwnerQuestionByKeyPort {
  findOwnerQuestionByKey(request: FindOwnerQuestionByKeyRequest): Promise<FindOwnerQuestionByKeyResult>;
}
