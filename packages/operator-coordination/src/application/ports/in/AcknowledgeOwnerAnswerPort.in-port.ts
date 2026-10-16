// @generated inbound contract scaffold — refined for lane Q1b.
/**
 * AcknowledgeOwnerAnswerPort: record that the asker saw an answered or rejected
 * question's answer, transitioning it to acknowledged. The acknowledger comes
 * from the request; the moment comes from the injected clock. Nothing else may
 * be acknowledged, and an acknowledgement grants nothing.
 */

import type {
  OwnerQuestionAcknowledgementRecord,
  OwnerQuestionRecord,
} from '../../../domain/owner-question-records.js';

export interface AcknowledgeOwnerAnswerRequest {
  readonly questionId: string;
  /** The asker acknowledging the answer; taken from the request, not the clock. */
  readonly by: string;
}

export type AcknowledgeOwnerAnswerResult =
  | {
      readonly outcome: 'acknowledged';
      readonly question: OwnerQuestionRecord;
      readonly acknowledgement: OwnerQuestionAcknowledgementRecord;
    }
  | { readonly outcome: 'refused'; readonly reason: string };

export interface AcknowledgeOwnerAnswerPort {
  /** Acknowledge an answered or rejected question. */
  acknowledgeOwnerAnswer(
    request: AcknowledgeOwnerAnswerRequest,
  ): Promise<AcknowledgeOwnerAnswerResult>;
}
