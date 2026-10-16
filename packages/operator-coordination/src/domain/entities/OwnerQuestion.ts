// @generated entity stub — refined for lane Q1a.
/**
 * OwnerQuestion is the aggregate root for one question an operator must
 * answer: its bounded options, the asker's recommendation, the door kind, the
 * work it blocks and its recorded answer and acknowledgement.
 *
 * The invariants are deliberately conservative: an answer is validated against
 * the question's own options and revision; text that carries a secret shape is
 * refused, never redacted; and the lifecycle only moves along the allowed
 * transitions. An answer grants nothing by itself — authority stays in the
 * existing coordination and decision machinery.
 */

import { containsSecretShape } from '@fleet/shared';
import type {
  OwnerQuestionAnswerRecord,
  OwnerQuestionBlockRecord,
  OwnerQuestionOptionRecord,
  OwnerQuestionRecord,
  OwnerQuestionRecordInput,
  OwnerQuestionState,
} from '../owner-question-records.js';

const DOOR_KINDS: readonly string[] = ['one-way', 'two-way'];
const STATES: readonly string[] = ['open', 'answered', 'rejected', 'expired', 'acknowledged'];
const ANSWER_SHAPES: readonly string[] = ['accept', 'reject', 'answer'];
const ANSWER_VIAS: readonly string[] = ['web', 'cli', 'signed-decision'];
const BLOCK_KINDS: readonly string[] = ['plan', 'pr', 'lane', 'work-order'];

const TITLE_MAX_CHARS = 200;
const BODY_MAX_CHARS = 8192;
const OPTION_TEXT_MAX_CHARS = 1024;
const ANSWER_TEXT_MAX_CHARS = 4096;
const RECORD_JSON_MAX_CHARS = 32768;

/** States each state may move to; nothing else is allowed. */
const ALLOWED_TRANSITIONS: Readonly<Record<OwnerQuestionState, readonly OwnerQuestionState[]>> = {
  open: ['answered', 'rejected', 'expired'],
  answered: ['acknowledged'],
  rejected: ['acknowledged'],
  expired: [],
  acknowledged: [],
};

/** True when the lifecycle may move directly from `from` to `to`. */
export function canTransitionOwnerQuestion(from: OwnerQuestionState, to: OwnerQuestionState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class OwnerQuestion {
  private constructor(private readonly record: OwnerQuestionRecord) {
    // Invariants are validated in fromRecord.
  }

  static fromRecord(input: OwnerQuestionRecordInput): OwnerQuestion {
    if (typeof input !== 'object' || input === null) {
      throw new Error('OwnerQuestion requires a record');
    }
    for (const field of ['questionId', 'askedBy', 'title', 'body', 'askedAt'] as const) {
      const value = input[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`OwnerQuestion requires a non-empty ${field}`);
      }
    }
    if (input.title.length > TITLE_MAX_CHARS) {
      throw new Error(`OwnerQuestion title exceeds ${TITLE_MAX_CHARS} characters`);
    }
    if (input.body.length > BODY_MAX_CHARS) {
      throw new Error(`OwnerQuestion body exceeds ${BODY_MAX_CHARS} characters`);
    }
    if (containsSecretShape(input.title)) {
      throw new Error('OwnerQuestion title contains a secret-shaped value and was refused');
    }
    if (containsSecretShape(input.body)) {
      throw new Error('OwnerQuestion body contains a secret-shaped value and was refused');
    }
    if (!Number.isInteger(input.revision) || input.revision < 0) {
      throw new Error('OwnerQuestion requires a non-negative integer revision');
    }
    if (typeof input.askedAt !== 'string' || Number.isNaN(Date.parse(input.askedAt))) {
      throw new Error('OwnerQuestion requires a valid askedAt timestamp');
    }
    const expiresAt = readExpiresAt(input);
    const options = OwnerQuestion.readOptions(input.options);
    const recommendation = OwnerQuestion.readRecommendation(input.recommendation, options);
    const doorKind = readDoorKind(input);
    const linkedRequestId = readLinkedRequestId(input, doorKind);
    const blocks = OwnerQuestion.readBlocks(input.blocks);
    const state = readState(input);
    const answer = OwnerQuestion.readAnswer(input.answer, state, recommendation, options, input.revision);
    const acknowledgement = OwnerQuestion.readAcknowledgement(input.acknowledgement, state, answer);
    const record: OwnerQuestionRecord = {
      questionId: input.questionId,
      revision: input.revision,
      askedBy: input.askedBy,
      title: input.title,
      body: input.body,
      options,
      recommendation,
      doorKind,
      linkedRequestId,
      blocks,
      state,
      askedAt: input.askedAt,
      expiresAt,
      answer,
      acknowledgement,
    };
    const jsonChars = JSON.stringify(record).length;
    if (jsonChars > RECORD_JSON_MAX_CHARS) {
      throw new Error(
        `OwnerQuestion record exceeds ${RECORD_JSON_MAX_CHARS} JSON characters (${jsonChars})`,
      );
    }
    return new OwnerQuestion(record);
  }

  private static readOptions(
    options: readonly OwnerQuestionOptionRecord[],
  ): readonly OwnerQuestionOptionRecord[] {
    if (!Array.isArray(options)) {
      throw new Error('OwnerQuestion requires an array of options');
    }
    if (options.length < 2) {
      throw new Error('OwnerQuestion requires at least 2 options');
    }
    const seenIds = new Set<string>();
    for (const option of options) {
      if (typeof option !== 'object' || option === null) {
        throw new Error('OwnerQuestion options must be objects');
      }
      if (typeof option.id !== 'string' || option.id.trim().length === 0) {
        throw new Error('OwnerQuestion option id must be a non-empty string');
      }
      if (seenIds.has(option.id)) {
        throw new Error(`OwnerQuestion repeats option id ${option.id}`);
      }
      seenIds.add(option.id);
      for (const field of ['label', 'consequence'] as const) {
        const value = option[field];
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new Error(`OwnerQuestion option ${field} must be a non-empty string`);
        }
        if (value.length > OPTION_TEXT_MAX_CHARS) {
          throw new Error(
            `OwnerQuestion option ${field} exceeds ${OPTION_TEXT_MAX_CHARS} characters`,
          );
        }
        if (containsSecretShape(value)) {
          throw new Error(`OwnerQuestion option ${field} contains a secret-shaped value and was refused`);
        }
      }
    }
    return Object.freeze(options.map((option) => ({ ...option })));
  }

  private static readRecommendation(
    recommendation: OwnerQuestionRecord['recommendation'],
    options: readonly OwnerQuestionOptionRecord[],
  ): OwnerQuestionRecord['recommendation'] {
    if (typeof recommendation !== 'object' || recommendation === null) {
      throw new Error('OwnerQuestion requires a recommendation');
    }
    if (typeof recommendation.optionId !== 'string' || recommendation.optionId.length === 0) {
      throw new Error('OwnerQuestion recommendation optionId must be a non-empty string');
    }
    if (!options.some((option) => option.id === recommendation.optionId)) {
      throw new Error(
        `OwnerQuestion recommendation names option ${recommendation.optionId}, which is not one of the options`,
      );
    }
    if (typeof recommendation.because !== 'string' || recommendation.because.trim().length === 0) {
      throw new Error('OwnerQuestion recommendation because must be a non-empty string');
    }
    if (containsSecretShape(recommendation.because)) {
      throw new Error(
        'OwnerQuestion recommendation because contains a secret-shaped value and was refused',
      );
    }
    return { optionId: recommendation.optionId, because: recommendation.because };
  }

  private static readBlocks(
    blocks: readonly OwnerQuestionBlockRecord[] | undefined,
  ): readonly OwnerQuestionBlockRecord[] {
    const list = blocks ?? [];
    if (!Array.isArray(list)) {
      throw new Error('OwnerQuestion blocks must be an array');
    }
    for (const block of list) {
      if (typeof block !== 'object' || block === null) {
        throw new Error('OwnerQuestion blocks must be objects');
      }
      if (!BLOCK_KINDS.includes(block.kind)) {
        throw new Error(`OwnerQuestion block kind is not one of ${BLOCK_KINDS.join(', ')}`);
      }
      if (typeof block.ref !== 'string' || block.ref.trim().length === 0) {
        throw new Error('OwnerQuestion block ref must be a non-empty string');
      }
    }
    return Object.freeze(list.map((block) => ({ ...block })));
  }

  private static readAnswer(
    answer: OwnerQuestionAnswerRecord | null | undefined,
    state: OwnerQuestionState,
    recommendation: OwnerQuestionRecord['recommendation'],
    options: readonly OwnerQuestionOptionRecord[],
    revision: number,
  ): OwnerQuestionAnswerRecord | null {
    if (answer === undefined || answer === null) {
      if (state === 'answered' || state === 'rejected') {
        throw new Error(`OwnerQuestion in state ${state} requires an answer`);
      }
      return null;
    }
    if (state === 'open') {
      throw new Error('OwnerQuestion in state open must not carry an answer');
    }
    if (state === 'expired') {
      throw new Error('OwnerQuestion in state expired must not carry an answer');
    }
    if (typeof answer !== 'object' || answer === null) {
      throw new Error('OwnerQuestion answer must be an object');
    }
    if (!ANSWER_SHAPES.includes(answer.shape)) {
      throw new Error(`OwnerQuestion answer shape is not one of ${ANSWER_SHAPES.join(', ')}`);
    }
    if (!ANSWER_VIAS.includes(answer.answeredVia)) {
      throw new Error(`OwnerQuestion answer answeredVia is not one of ${ANSWER_VIAS.join(', ')}`);
    }
    if (
      !Number.isInteger(answer.questionRevision) ||
      answer.questionRevision < 1 ||
      answer.questionRevision > revision
    ) {
      throw new Error(
        `OwnerQuestion answer questionRevision must be an integer between 1 and the record revision ${revision}`,
      );
    }
    if (typeof answer.answeredAt !== 'string' || Number.isNaN(Date.parse(answer.answeredAt))) {
      throw new Error('OwnerQuestion answer requires a valid answeredAt timestamp');
    }
    const optionId = answer.optionId ?? null;
    const text = answer.text ?? null;
    const reason = answer.reason ?? null;
    const sessionId = answer.sessionId ?? null;
    if (optionId !== null && !options.some((option) => option.id === optionId)) {
      throw new Error(`OwnerQuestion answer names option ${optionId}, which is not one of the options`);
    }
    if (answer.shape === 'accept' && optionId !== null && optionId !== recommendation.optionId) {
      throw new Error(
        `OwnerQuestion answer shape accept must name the recommended option ${recommendation.optionId}`,
      );
    }
    if (answer.shape === 'reject' && optionId !== null) {
      throw new Error('OwnerQuestion answer shape reject must not name an option');
    }
    if (answer.shape === 'answer' && optionId === null && (text === null || text.length === 0)) {
      throw new Error('OwnerQuestion answer shape answer requires an optionId or text');
    }
    if (answer.shape === 'accept' && (reason !== null || (text !== null && text.length > 0))) {
      throw new Error('OwnerQuestion answer shape accept carries no free text or reason');
    }
    for (const field of ['text', 'reason'] as const) {
      const value = answer[field];
      if (value !== null && value !== undefined) {
        if (typeof value !== 'string') {
          throw new Error(`OwnerQuestion answer ${field} must be a string or null`);
        }
        if (value.length > ANSWER_TEXT_MAX_CHARS) {
          throw new Error(`OwnerQuestion answer ${field} exceeds ${ANSWER_TEXT_MAX_CHARS} characters`);
        }
        if (containsSecretShape(value)) {
          throw new Error(
            `OwnerQuestion answer ${field} contains a secret-shaped value and was refused`,
          );
        }
      }
    }
    return {
      shape: answer.shape,
      optionId,
      text,
      reason,
      questionRevision: answer.questionRevision,
      answeredVia: answer.answeredVia as OwnerQuestionAnswerRecord['answeredVia'],
      answeredAt: answer.answeredAt,
      sessionId,
    };
  }

  private static readAcknowledgement(
    acknowledgement: OwnerQuestionRecord['acknowledgement'] | undefined,
    state: OwnerQuestionState,
    answer: OwnerQuestionAnswerRecord | null,
  ): OwnerQuestionRecord['acknowledgement'] {
    if (acknowledgement === undefined || acknowledgement === null) {
      if (state === 'acknowledged') {
        throw new Error('OwnerQuestion in state acknowledged requires an acknowledgement');
      }
      return null;
    }
    if (state !== 'acknowledged') {
      throw new Error(`OwnerQuestion in state ${state} must not carry an acknowledgement`);
    }
    if (answer === null) {
      throw new Error('OwnerQuestion acknowledgement requires a recorded answer');
    }
    if (typeof acknowledgement !== 'object' || acknowledgement === null) {
      throw new Error('OwnerQuestion acknowledgement must be an object');
    }
    if (typeof acknowledgement.by !== 'string' || acknowledgement.by.trim().length === 0) {
      throw new Error('OwnerQuestion acknowledgement by must be a non-empty string');
    }
    if (typeof acknowledgement.at !== 'string' || Number.isNaN(Date.parse(acknowledgement.at))) {
      throw new Error('OwnerQuestion acknowledgement requires a valid at timestamp');
    }
    return { by: acknowledgement.by, at: acknowledgement.at };
  }

  getId(): string {
    return this.record.questionId;
  }

  toRecord(): OwnerQuestionRecord {
    return {
      ...this.record,
      options: Object.freeze(this.record.options.map((option) => ({ ...option }))),
      blocks: Object.freeze(this.record.blocks.map((block) => ({ ...block }))),
      recommendation: { ...this.record.recommendation },
      answer: this.record.answer === null ? null : { ...this.record.answer },
      acknowledgement:
        this.record.acknowledgement === null ? null : { ...this.record.acknowledgement },
    };
  }

  getState(): OwnerQuestionState {
    return this.record.state;
  }

  getDoorKind(): OwnerQuestionRecord['doorKind'] {
    return this.record.doorKind;
  }

  getLinkedRequestId(): string | null {
    return this.record.linkedRequestId;
  }

  getRevision(): number {
    return this.record.revision;
  }

  /** Optimistic concurrency: question revisions only move forward. */
  nextRevision(): number {
    return this.record.revision + 1;
  }

  getBlocks(): readonly OwnerQuestionBlockRecord[] {
    return this.record.blocks.map((block) => ({ ...block }));
  }

  isBlocking(): boolean {
    return this.record.state === 'open';
  }

  /** Move to `next` through an allowed transition, optionally recording the answer and/or acknowledgement. */
  transitionTo(
    next: OwnerQuestionState,
    patch?: { answer?: OwnerQuestionAnswerRecord | null; acknowledgement?: OwnerQuestionRecord['acknowledgement'] },
  ): OwnerQuestion {
    if (!canTransitionOwnerQuestion(this.record.state, next)) {
      throw new Error(
        `OwnerQuestion ${this.record.questionId} may not move from ${this.record.state} to ${next}`,
      );
    }
    const candidate = {
      ...this.toRecord(),
      state: next,
      answer: patch?.answer !== undefined ? patch.answer : this.record.answer,
      acknowledgement:
        patch?.acknowledgement !== undefined ? patch.acknowledgement : this.record.acknowledgement,
    };
    return OwnerQuestion.fromRecord(candidate);
  }
}

function readExpiresAt(input: OwnerQuestionRecordInput): string | null {
  const value = input.expiresAt;
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error('OwnerQuestion expiresAt must be a valid timestamp or null');
  }
  return value;
}

function readDoorKind(input: OwnerQuestionRecordInput): OwnerQuestionRecord['doorKind'] {
  const value = input.doorKind ?? 'one-way';
  if (!DOOR_KINDS.includes(value)) {
    throw new Error(`OwnerQuestion doorKind is not one of ${DOOR_KINDS.join(', ')}`);
  }
  return value;
}

function readLinkedRequestId(
  input: OwnerQuestionRecordInput,
  doorKind: OwnerQuestionRecord['doorKind'],
): string | null {
  const value = input.linkedRequestId;
  if (doorKind === 'one-way') {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('OwnerQuestion with doorKind one-way requires a linkedRequestId');
    }
    return value;
  }
  if (value !== undefined && value !== null) {
    throw new Error('OwnerQuestion with doorKind two-way must not carry a linkedRequestId');
  }
  return null;
}

function readState(input: OwnerQuestionRecordInput): OwnerQuestionState {
  const value = input.state;
  if (!STATES.includes(value)) {
    throw new Error(`OwnerQuestion state is not one of ${STATES.join(', ')}`);
  }
  return value;
}
