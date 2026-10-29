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
const ID_MAX_CHARS = 256;
const OPTION_ID_MAX_CHARS = 64;
const OPTION_TEXT_MAX_CHARS = 1024;
const ANSWER_TEXT_MAX_CHARS = 4096;
const RECORD_JSON_MAX_CHARS = 32768;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,256}$/;

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

/**
 * Validate one string field: it must be a string, fit `maxChars` counted in
 * UTF-8 bytes (not string length), and never carry a secret shape. Errors name
 * the field and never echo the value, ids included.
 */
function readText(field: string, value: unknown, maxChars: number): string {
  if (typeof value !== 'string') {
    throw new Error(`OwnerQuestion ${field} must be a string`);
  }
  if (new TextEncoder().encode(value).byteLength > maxChars) {
    throw new Error(`OwnerQuestion ${field} exceeds ${maxChars} bytes`);
  }
  if (containsSecretShape(value)) {
    throw new Error(`OwnerQuestion ${field} contains a secret-shaped value and was refused`);
  }
  return value;
}

/** Normalise a validated timestamp to a canonical ISO string for stable ordering. */
function normaliseTimestamp(field: string, value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`OwnerQuestion ${field} must be a valid timestamp`);
  }
  return parsed.toISOString();
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
    const questionId = readText('questionId', input.questionId, ID_MAX_CHARS);
    const askedBy = readText('askedBy', input.askedBy, ID_MAX_CHARS);
    const title = readText('title', input.title, TITLE_MAX_CHARS);
    const body = readText('body', input.body, BODY_MAX_CHARS);
    if (!Number.isInteger(input.revision) || input.revision < 1) {
      throw new Error('OwnerQuestion requires a positive integer revision of at least 1');
    }
    const askedAt = normaliseTimestamp('askedAt', input.askedAt);
    const expiresAt = readExpiresAt(input);
    const options = OwnerQuestion.readOptions(input.options);
    const recommendation = OwnerQuestion.readRecommendation(input.recommendation, options);
    const doorKind = readDoorKind(input);
    const linkedRequestId = readLinkedRequestId(input, doorKind);
    const blocks = OwnerQuestion.readBlocks(input.blocks);
    const state = readState(input);
    const answer = OwnerQuestion.readAnswer(input.answer, state, recommendation, options, input.revision);
    const acknowledgement = OwnerQuestion.readAcknowledgement(input.acknowledgement, state, answer);
    const idempotencyKey = readIdempotencyKey(input);
    const record: OwnerQuestionRecord = {
      questionId,
      revision: input.revision,
      askedBy,
      title,
      body,
      options,
      recommendation,
      doorKind,
      linkedRequestId,
      blocks,
      state,
      askedAt,
      expiresAt,
      answer,
      acknowledgement,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
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
    const read: OwnerQuestionOptionRecord[] = [];
    for (const option of options) {
      if (typeof option !== 'object' || option === null) {
        throw new Error('OwnerQuestion options must be objects');
      }
      if (typeof option.id !== 'string' || option.id.trim().length === 0) {
        throw new Error('OwnerQuestion option id must be a non-empty string');
      }
      const id = readText('option id', option.id, OPTION_ID_MAX_CHARS);
      if (seenIds.has(id)) {
        throw new Error('OwnerQuestion repeats an option id');
      }
      seenIds.add(id);
      const fields: { field: 'option label' | 'option consequence'; value: unknown }[] = [
        { field: 'option label', value: option.label },
        { field: 'option consequence', value: option.consequence },
      ];
      for (const { field, value } of fields) {
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new Error(`OwnerQuestion ${field} must be a non-empty string`);
        }
        readText(field, value, OPTION_TEXT_MAX_CHARS);
      }
      read.push({ id, label: option.label, consequence: option.consequence });
    }
    return Object.freeze(read);
  }

  private static readRecommendation(
    recommendation: OwnerQuestionRecord['recommendation'],
    options: readonly OwnerQuestionOptionRecord[],
  ): OwnerQuestionRecord['recommendation'] {
    if (typeof recommendation !== 'object' || recommendation === null) {
      throw new Error('OwnerQuestion requires a recommendation');
    }
    const optionId = readText('recommendation optionId', recommendation.optionId, OPTION_ID_MAX_CHARS);
    if (optionId.trim().length === 0) {
      throw new Error('OwnerQuestion recommendation optionId must be a non-empty string');
    }
    if (!options.some((option) => option.id === optionId)) {
      throw new Error('OwnerQuestion recommendation names an option that is not one of the options');
    }
    if (typeof recommendation.because !== 'string' || recommendation.because.trim().length === 0) {
      throw new Error('OwnerQuestion recommendation because must be a non-empty string');
    }
    const because = readText('recommendation because', recommendation.because, OPTION_TEXT_MAX_CHARS);
    return { optionId, because };
  }

  private static readBlocks(
    blocks: readonly OwnerQuestionBlockRecord[] | undefined,
  ): readonly OwnerQuestionBlockRecord[] {
    const list = blocks ?? [];
    if (!Array.isArray(list)) {
      throw new Error('OwnerQuestion blocks must be an array');
    }
    const read: OwnerQuestionBlockRecord[] = [];
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
      read.push({ kind: block.kind, ref: readText('block ref', block.ref, ID_MAX_CHARS) });
    }
    return Object.freeze(read);
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
    if (state === 'rejected' && answer.shape !== 'reject') {
      throw new Error('OwnerQuestion in state rejected requires an answer of shape reject');
    }
    if (state === 'answered' && answer.shape !== 'accept' && answer.shape !== 'answer') {
      throw new Error('OwnerQuestion in state answered requires an answer of shape accept or answer');
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
    // An accept always lands on the recommended option, whatever the caller named.
    const optionId =
      answer.shape === 'accept' ? recommendation.optionId : (answer.optionId ?? null);
    const text = answer.text ?? null;
    const reason = answer.reason ?? null;
    const sessionId = answer.sessionId ?? null;
    if (optionId !== null && !options.some((option) => option.id === optionId)) {
      throw new Error('OwnerQuestion answer names an option that is not one of the options');
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
    const readTexts: { field: 'answer text' | 'answer reason'; value: string | null }[] = [
      { field: 'answer text', value: text },
      { field: 'answer reason', value: reason },
    ];
    for (const { field, value } of readTexts) {
      if (value !== null) {
        readText(field, value, ANSWER_TEXT_MAX_CHARS);
      }
    }
    return {
      shape: answer.shape,
      optionId,
      text,
      reason,
      questionRevision: answer.questionRevision,
      answeredVia: answer.answeredVia as OwnerQuestionAnswerRecord['answeredVia'],
      answeredAt: normaliseTimestamp('answer answeredAt', answer.answeredAt),
      sessionId: sessionId === null ? null : readText('answer sessionId', sessionId, ID_MAX_CHARS),
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
    return {
      by: readText('acknowledgement by', acknowledgement.by, ID_MAX_CHARS),
      at: normaliseTimestamp('acknowledgement at', acknowledgement.at),
    };
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

  /** Open and expired questions both block their work; expired ones are re-asked. */
  isBlocking(): boolean {
    return this.record.state === 'open' || this.record.state === 'expired';
  }

  /** Move to `next` through an allowed transition, optionally recording the answer and/or acknowledgement. */
  transitionTo(
    next: OwnerQuestionState,
    patch?: { answer?: OwnerQuestionAnswerRecord | null; acknowledgement?: OwnerQuestionRecord['acknowledgement'] },
  ): OwnerQuestion {
    if (!STATES.includes(next) || !canTransitionOwnerQuestion(this.record.state, next)) {
      // The requested state is caller input: never echo it.
      throw new Error(`OwnerQuestion may not move from ${this.record.state} to the requested state`);
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
  if (typeof value !== 'string') {
    throw new Error('OwnerQuestion expiresAt must be a valid timestamp or null');
  }
  return normaliseTimestamp('expiresAt', value);
}

/**
 * Validate the caller's idempotency key: absent when the ask named none;
 * otherwise a printable-ASCII slug of 1 to 256 characters that carries no
 * secret shape. The error never echoes the value.
 */
function readIdempotencyKey(input: OwnerQuestionRecordInput): string | undefined {
  const value = input.idempotencyKey;
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'string' ||
    !IDEMPOTENCY_KEY_PATTERN.test(value) ||
    containsSecretShape(value)
  ) {
    throw new Error('OwnerQuestion idempotencyKey must be 1 to 256 printable ASCII characters without spaces');
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
    return readText('linkedRequestId', value, ID_MAX_CHARS);
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

type AskProjection = Pick<
  OwnerQuestionRecord,
  | 'askedBy'
  | 'title'
  | 'body'
  | 'options'
  | 'recommendation'
  | 'doorKind'
  | 'linkedRequestId'
  | 'blocks'
  | 'expiresAt'
>;

/** A fixed-order projection so a JSON comparison is order-stable. */
function askProjection(record: OwnerQuestionRecord): AskProjection {
  return {
    askedBy: record.askedBy,
    title: record.title,
    body: record.body,
    options: record.options,
    recommendation: record.recommendation,
    doorKind: record.doorKind,
    linkedRequestId: record.linkedRequestId,
    blocks: record.blocks,
    expiresAt: record.expiresAt,
  };
}

/**
 * True when two records ask the same thing: askedBy, title, body, options, recommendation, doorKind, linkedRequestId, blocks and expiresAt all equal. Ids, revision, times, state, answer, acknowledgement and the key itself are not compared.
 */
export function sameOwnerQuestionAsk(left: OwnerQuestionRecord, right: OwnerQuestionRecord): boolean {
  return JSON.stringify(askProjection(left)) === JSON.stringify(askProjection(right));
}
