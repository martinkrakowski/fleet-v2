/**
 * Owner question records are the pure, serializable facts of the
 * `OwnerQuestion` aggregate: the question an operator must answer, its
 * options, its answer and its acknowledgement. They carry no behaviour and
 * never a credential, token or client secret; the domain refuses such text
 * instead of redacting it.
 *
 * They are kept beside — never inside — the coordination request records: an
 * owner question is its own aggregate, and no authorization use case reads it.
 */

/** How the question's answer may be delivered. */
export type OwnerQuestionDoorKind = 'one-way' | 'two-way';

/** Lifecycle state of one owner question. */
export type OwnerQuestionState = 'open' | 'answered' | 'rejected' | 'expired' | 'acknowledged';

/** How an answer reached the record. */
export type OwnerQuestionAnswerVia = 'web' | 'cli' | 'signed-decision';

/** One selectable option with the consequence of choosing it. */
export interface OwnerQuestionOptionRecord {
  readonly id: string;
  readonly label: string;
  readonly consequence: string;
}

/** The asker's recommended option and the reason for recommending it. */
export interface OwnerQuestionRecommendationRecord {
  readonly optionId: string;
  readonly because: string;
}

/** One work item the question blocks until it is decided. */
export interface OwnerQuestionBlockRecord {
  readonly kind: 'plan' | 'pr' | 'lane' | 'work-order';
  readonly ref: string;
}

/** The recorded answer. It grants nothing by itself; authority stays where it is. */
export interface OwnerQuestionAnswerRecord {
  readonly shape: 'accept' | 'reject' | 'answer';
  readonly optionId: string | null;
  readonly text: string | null;
  readonly reason: string | null;
  readonly questionRevision: number;
  readonly answeredVia: OwnerQuestionAnswerVia;
  readonly answeredAt: string;
  readonly sessionId: string | null;
}

/** The acknowledgement that the asker saw the answer. */
export interface OwnerQuestionAcknowledgementRecord {
  readonly by: string;
  readonly at: string;
}

/** Serializable snapshot of the OwnerQuestion aggregate. */
export interface OwnerQuestionRecord {
  readonly questionId: string;
  readonly revision: number;
  readonly askedBy: string;
  readonly title: string;
  readonly body: string;
  readonly options: readonly OwnerQuestionOptionRecord[];
  readonly recommendation: OwnerQuestionRecommendationRecord;
  readonly doorKind: OwnerQuestionDoorKind;
  readonly linkedRequestId: string | null;
  readonly blocks: readonly OwnerQuestionBlockRecord[];
  readonly state: OwnerQuestionState;
  readonly askedAt: string;
  readonly expiresAt: string | null;
  readonly answer: OwnerQuestionAnswerRecord | null;
  readonly acknowledgement: OwnerQuestionAcknowledgementRecord | null;
}

/**
 * What a caller may hand to `OwnerQuestion.fromRecord`: `doorKind` may be
 * omitted and defaults to 'one-way'; `linkedRequestId`, `blocks`, `expiresAt`,
 * `answer` and `acknowledgement` may be omitted and default to empty.
 */
export type OwnerQuestionRecordInput = Omit<
  OwnerQuestionRecord,
  'doorKind' | 'linkedRequestId' | 'blocks' | 'expiresAt' | 'answer' | 'acknowledgement'
> & {
  readonly doorKind?: OwnerQuestionDoorKind;
  readonly linkedRequestId?: string | null;
  readonly blocks?: readonly OwnerQuestionBlockRecord[];
  readonly expiresAt?: string | null;
  readonly answer?: OwnerQuestionAnswerRecord | null;
  readonly acknowledgement?: OwnerQuestionAcknowledgementRecord | null;
};
