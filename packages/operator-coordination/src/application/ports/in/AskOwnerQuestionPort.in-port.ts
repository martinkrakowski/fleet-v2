// @generated inbound contract scaffold — refined for lane Q1b.
/**
 * AskOwnerQuestionPort: record a new open owner question at revision 1. The
 * moment the question is asked comes from the injected clock, never from the
 * request. A one-way question must reference an existing coordination request
 * of kind action-decision or policy-proposal; anything else is refused.
 *
 * With an idempotencyKey the ask is find-or-create: a stored question holding
 * the key and asking the same thing is returned unchanged as `exists`
 * (whatever its state), a different ask under that key is refused, and no key
 * is ever asked twice. Without a key the ask behaves exactly as before.
 */

import type {
  OwnerQuestionBlockRecord,
  OwnerQuestionDoorKind,
  OwnerQuestionOptionRecord,
  OwnerQuestionRecord,
  OwnerQuestionRecommendationRecord,
} from '../../../domain/owner-question-records.js';

/**
 * The only source of "now" for the owner-question use cases. It is injected
 * by the composition root so no request body ever supplies the clock.
 */
export interface OwnerQuestionClock {
  /** The current instant as a canonical ISO timestamp. */
  readonly nowIso: () => string;
}

export interface AskOwnerQuestionRequest {
  readonly questionId: string;
  readonly askedBy: string;
  readonly title: string;
  readonly body: string;
  readonly options: readonly OwnerQuestionOptionRecord[];
  readonly recommendation: OwnerQuestionRecommendationRecord;
  readonly doorKind: OwnerQuestionDoorKind;
  readonly linkedRequestId?: string | null;
  readonly blocks?: readonly OwnerQuestionBlockRecord[];
  readonly expiresAt?: string | null;
  /** The caller's idempotency key; a repeat with the same key and the same ask returns the stored question as `exists`. */
  readonly idempotencyKey?: string;
}

export type AskOwnerQuestionResult =
  | { readonly outcome: 'asked'; readonly question: OwnerQuestionRecord }
  | { readonly outcome: 'exists'; readonly question: OwnerQuestionRecord }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface AskOwnerQuestionPort {
  askOwnerQuestion(request: AskOwnerQuestionRequest): Promise<AskOwnerQuestionResult>;
}
