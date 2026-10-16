// @generated inbound contract scaffold — refined for lane Q1b.
/**
 * AskOwnerQuestionPort: record a new open owner question at revision 1. The
 * moment the question is asked comes from the injected clock, never from the
 * request. A one-way question must reference an existing coordination request
 * of kind action-decision or policy-proposal; anything else is refused.
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
}

export type AskOwnerQuestionResult =
  | { readonly outcome: 'asked'; readonly question: OwnerQuestionRecord }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface AskOwnerQuestionPort {
  askOwnerQuestion(request: AskOwnerQuestionRequest): Promise<AskOwnerQuestionResult>;
}
