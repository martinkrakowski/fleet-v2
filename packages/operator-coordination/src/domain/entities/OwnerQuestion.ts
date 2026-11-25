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
  OwnerQuestionAudience,
  OwnerQuestionBlockRecord,
  OwnerQuestionOptionRecord,
  OwnerQuestionRecord,
  OwnerQuestionRecordInput,
  OwnerQuestionState,
} from '../owner-question-records.js';
import { OWNER_QUESTION_RECORD_VERSION } from '../owner-question-records.js';
import { readPlainObjectWithOptional } from '../record-input.js';

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

/**
 * The smallest JSON a valid option can serialize to (one non-empty character
 * in each of id, label, consequence) and, with its separating comma, the
 * per-entry minimum of an options array. An array of `n` options therefore
 * needs at least `n * (MIN + 1) - 1` JSON characters, so any array longer than
 * the bound below can never fit the record's 32768-character budget: it is
 * refused BEFORE any element is traversed, so a very large array costs O(1),
 * not unbounded time and memory.
 */
const MIN_OPTION_JSON_CHARS = JSON.stringify({ id: 'a', label: 'b', consequence: 'c' }).length;
const MAX_OPTION_COUNT = Math.floor((RECORD_JSON_MAX_CHARS + 1) / (MIN_OPTION_JSON_CHARS + 1));

/** The same bound for `blocks`, from the smallest valid block (`kind: 'plan'`). */
const MIN_BLOCK_JSON_CHARS = JSON.stringify({ kind: 'plan', ref: 'a' }).length;
const MAX_BLOCK_COUNT = Math.floor((RECORD_JSON_MAX_CHARS + 1) / (MIN_BLOCK_JSON_CHARS + 1));

/**
 * Who answered: the literal 'owner' or `agent:<id>` with 1 to 128 id
 * characters from [A-Za-z0-9._-]. The explicit {1,128} bound keeps the
 * character-class regex linear-time with no backtracking.
 */
export const OWNER_QUESTION_ACTOR_PATTERN = /^agent:[A-Za-z0-9._-]{1,128}$/;

/**
 * Every own key a record may carry (18). `readPlainObjectWithOptional` refuses
 * anything else, so the reflective inspection is bounded by this fixed set.
 */
const ALLOWED_RECORD_KEYS: readonly string[] = [
  'questionId',
  'revision',
  'askedBy',
  'title',
  'body',
  'options',
  'recommendation',
  'doorKind',
  'linkedRequestId',
  'blocks',
  'state',
  'askedAt',
  'expiresAt',
  'answer',
  'acknowledgement',
  'schemaVersion',
  'audience',
  'idempotencyKey',
];

/** Every own key an answer may carry (9). */
const ALLOWED_ANSWER_KEYS: readonly string[] = [
  'shape',
  'optionId',
  'text',
  'reason',
  'questionRevision',
  'answeredVia',
  'answeredAt',
  'sessionId',
  'actor',
];

/** Every own key an option may carry (3). */
const ALLOWED_OPTION_KEYS: readonly string[] = ['id', 'label', 'consequence'];

/** Every own key a recommendation may carry (2). */
const ALLOWED_RECOMMENDATION_KEYS: readonly string[] = ['optionId', 'because'];

/** Every own key a block may carry (2). */
const ALLOWED_BLOCK_KEYS: readonly string[] = ['kind', 'ref'];

/** Every own key an acknowledgement may carry (2). */
const ALLOWED_ACKNOWLEDGEMENT_KEYS: readonly string[] = ['by', 'at'];

/**
 * Marks an absent index (an array hole) in a `readBoundedArray` copy; the
 * callers refuse it, never treat it as a value.
 */
const ARRAY_HOLE: unique symbol = Symbol('OwnerQuestion array hole');

/**
 * Read an untrusted array defensively. `Array.isArray` and the own `length`
 * descriptor are read inside try/catch (a revoked Proxy throws), and the count
 * bound is applied BEFORE any element is touched, so an enormous array is
 * refused in constant time. Elements are then copied from their own index
 * descriptors — no iterator, no `length`/index property read beyond the copy —
 * and an absent index is reported as `ARRAY_HOLE` so the caller refuses it.
 * A Proxy that lies consistently in every trap remains an accepted residual.
 * Returns null for a non-array; throws a named error when `maxCount` is
 * exceeded, before any element is read.
 */
function readBoundedArray(
  value: unknown,
  field: string,
  maxCount: number,
): { readonly values: readonly unknown[] } | null {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return null;
  }
  if (!isArray) {
    return null;
  }
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    return null;
  }
  if (
    lengthDescriptor === undefined ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return null;
  }
  const length = lengthDescriptor.value;
  if (length > maxCount) {
    throw new Error(`OwnerQuestion ${field} exceed the record budget of at most ${maxCount} entries`);
  }
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, index);
    } catch {
      return null;
    }
    values.push(descriptor === undefined ? ARRAY_HOLE : descriptor.value);
  }
  return { values };
}

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

// Residual: "owner" means a holder of the shared bearer or the CLI, or an owner-verified session. It is not a fresh human check.

/**
 * Validate who answered. A signed-decision answer is always the owner: an
 * absent actor reads as 'owner' and anything else is refused. Every other
 * answer accepts 'owner' or `agent:<id>`; a missing actor reads as 'owner' at
 * every schema version until FVM2b tightens the writers. The thrown error
 * never echoes the refused value.
 */
export function validateAnswerActor(
  actor: unknown,
  answeredVia: unknown,
  isLegacyRecord: boolean,
): string {
  if (answeredVia === 'signed-decision') {
    if (actor === undefined || actor === 'owner') {
      return 'owner';
    }
    throw new Error('OwnerQuestion signed-decision answer requires actor owner');
  }
  if (actor === undefined) {
    // FVM2a: a missing actor reads as 'owner' at every schema version;
    // `isLegacyRecord` stays in the signature for the FVM2b tightening.
    void isLegacyRecord;
    return 'owner';
  }
  if (
    typeof actor !== 'string' ||
    (actor !== 'owner' && !OWNER_QUESTION_ACTOR_PATTERN.test(actor)) ||
    containsSecretShape(actor)
  ) {
    throw new Error('OwnerQuestion answer actor must be owner or agent:<id>');
  }
  return actor;
}

/**
 * Read the stored schema version. Absent reads as 1 (a legacy record on
 * disk); 2 is the current version. Anything else — including 0, 3, 1.5, '2',
 * null, NaN and objects — is refused.
 */
function readSchemaVersion(rawVersion: unknown): {
  readonly storedVersion: number;
  readonly isLegacy: boolean;
} {
  if (rawVersion === undefined) {
    return { storedVersion: 1, isLegacy: true };
  }
  if (rawVersion === 1) {
    return { storedVersion: 1, isLegacy: true };
  }
  if (rawVersion === 2) {
    return { storedVersion: 2, isLegacy: false };
  }
  throw new Error('OwnerQuestion unsupported schemaVersion');
}

/**
 * Read the answer audience: 'any' is accepted on a current record; anything
 * missing or unknown — and every legacy (v1) record — reads fail-closed as
 * 'owner-only'.
 */
function readAudience(rawAudience: unknown, isLegacy: boolean): OwnerQuestionAudience {
  if (isLegacy) {
    return 'owner-only';
  }
  return rawAudience === 'any' ? 'any' : 'owner-only';
}

export class OwnerQuestion {
  private constructor(private readonly record: OwnerQuestionRecord) {
    // Invariants are validated in fromRecord.
  }

  static fromRecord(input: OwnerQuestionRecordInput): OwnerQuestion {
    // The whole record is read through its own property descriptors: getters
    // never run, and a non-object, non-plain prototype, revoked Proxy,
    // prototype-polluting or unrecognised extra key is refused before any
    // field is looked at. Required keys stay `[]` so the per-field errors
    // below keep their messages.
    const snap = readPlainObjectWithOptional(input, [], ALLOWED_RECORD_KEYS, {
      refuseOptionalAccessors: true,
    });
    if (snap === null) {
      throw new Error('OwnerQuestion requires a record');
    }
    const safeInput = snap as unknown as OwnerQuestionRecordInput;
    const { isLegacy } = readSchemaVersion(safeInput.schemaVersion);
    const audience = readAudience(safeInput.audience, isLegacy);
    for (const field of ['questionId', 'askedBy', 'title', 'body', 'askedAt'] as const) {
      const value = safeInput[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`OwnerQuestion requires a non-empty ${field}`);
      }
    }
    const questionId = readText('questionId', safeInput.questionId, ID_MAX_CHARS);
    const askedBy = readText('askedBy', safeInput.askedBy, ID_MAX_CHARS);
    const title = readText('title', safeInput.title, TITLE_MAX_CHARS);
    const body = readText('body', safeInput.body, BODY_MAX_CHARS);
    if (!Number.isInteger(safeInput.revision) || safeInput.revision < 1) {
      throw new Error('OwnerQuestion requires a positive integer revision of at least 1');
    }
    const askedAt = normaliseTimestamp('askedAt', safeInput.askedAt);
    const expiresAt = readExpiresAt(safeInput);
    const options = OwnerQuestion.readOptions(safeInput.options);
    const recommendation = OwnerQuestion.readRecommendation(safeInput.recommendation, options);
    const doorKind = readDoorKind(safeInput);
    const linkedRequestId = readLinkedRequestId(safeInput, doorKind);
    const blocks = OwnerQuestion.readBlocks(safeInput.blocks);
    const state = readState(safeInput);
    const answer = OwnerQuestion.readAnswer(
      safeInput.answer,
      state,
      recommendation,
      options,
      safeInput.revision,
      audience,
      isLegacy,
    );
    const acknowledgement = OwnerQuestion.readAcknowledgement(safeInput.acknowledgement, state, answer);
    const idempotencyKey = readIdempotencyKey(safeInput);
    const record: OwnerQuestionRecord = {
      questionId,
      revision: safeInput.revision,
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
      schemaVersion: OWNER_QUESTION_RECORD_VERSION,
      audience,
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
    // The array is read defensively and count-bounded BEFORE any element is
    // traversed (item 1 of the fix round), and every element is read through
    // its own property descriptors (item 2): a hostile getter on an option
    // field never runs, and a hole or a non-object is refused.
    const bounded = readBoundedArray(options, 'options', MAX_OPTION_COUNT);
    if (bounded === null) {
      throw new Error('OwnerQuestion requires an array of options');
    }
    if (bounded.values.length < 2) {
      throw new Error('OwnerQuestion requires at least 2 options');
    }
    const seenIds = new Set<string>();
    const read: OwnerQuestionOptionRecord[] = [];
    for (const raw of bounded.values) {
      const snap = readPlainObjectWithOptional(raw, ['id', 'label', 'consequence'], ALLOWED_OPTION_KEYS, {
        refuseOptionalAccessors: true,
      });
      if (snap === null) {
        throw new Error('OwnerQuestion options must be objects');
      }
      const option = snap as unknown as OwnerQuestionOptionRecord;
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
    // The recommendation is read through its own property descriptors too: a
    // hostile getter on optionId or because never runs, and a non-object,
    // extra or accessor key is refused.
    const snap = readPlainObjectWithOptional(
      recommendation,
      [],
      ALLOWED_RECOMMENDATION_KEYS,
      { refuseOptionalAccessors: true },
    );
    if (snap === null) {
      throw new Error('OwnerQuestion requires a recommendation');
    }
    const safe = snap as unknown as OwnerQuestionRecord['recommendation'];
    if (typeof safe.optionId !== 'string' || safe.optionId.trim().length === 0) {
      throw new Error('OwnerQuestion recommendation optionId must be a non-empty string');
    }
    const optionId = readText('recommendation optionId', safe.optionId, OPTION_ID_MAX_CHARS);
    if (!options.some((option) => option.id === optionId)) {
      throw new Error('OwnerQuestion recommendation names an option that is not one of the options');
    }
    if (typeof safe.because !== 'string' || safe.because.trim().length === 0) {
      throw new Error('OwnerQuestion recommendation because must be a non-empty string');
    }
    const because = readText('recommendation because', safe.because, OPTION_TEXT_MAX_CHARS);
    return { optionId, because };
  }

  private static readBlocks(
    blocks: readonly OwnerQuestionBlockRecord[] | undefined,
  ): readonly OwnerQuestionBlockRecord[] {
    const bounded = readBoundedArray(blocks ?? [], 'blocks', MAX_BLOCK_COUNT);
    if (bounded === null) {
      throw new Error('OwnerQuestion blocks must be an array');
    }
    const read: OwnerQuestionBlockRecord[] = [];
    for (const raw of bounded.values) {
      const snap = readPlainObjectWithOptional(raw, ['kind', 'ref'], ALLOWED_BLOCK_KEYS, {
        refuseOptionalAccessors: true,
      });
      if (snap === null) {
        throw new Error('OwnerQuestion blocks must be objects');
      }
      const block = snap as unknown as OwnerQuestionBlockRecord;
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
    audience: OwnerQuestionAudience,
    isLegacy: boolean,
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
    // The answer is read through its own property descriptors too: getters
    // never run and extra, accessor or prototype-polluting keys are refused.
    const snap = readPlainObjectWithOptional(answer, [], ALLOWED_ANSWER_KEYS, {
      refuseOptionalAccessors: true,
    });
    if (snap === null) {
      throw new Error('OwnerQuestion answer must be an object');
    }
    const safeAnswer = snap as unknown as OwnerQuestionAnswerRecord & { readonly actor?: string };
    if (!ANSWER_SHAPES.includes(safeAnswer.shape)) {
      throw new Error(`OwnerQuestion answer shape is not one of ${ANSWER_SHAPES.join(', ')}`);
    }
    if (state === 'rejected' && safeAnswer.shape !== 'reject') {
      throw new Error('OwnerQuestion in state rejected requires an answer of shape reject');
    }
    if (state === 'answered' && safeAnswer.shape !== 'accept' && safeAnswer.shape !== 'answer') {
      throw new Error('OwnerQuestion in state answered requires an answer of shape accept or answer');
    }
    if (!ANSWER_VIAS.includes(safeAnswer.answeredVia)) {
      throw new Error(`OwnerQuestion answer answeredVia is not one of ${ANSWER_VIAS.join(', ')}`);
    }
    if (
      !Number.isInteger(safeAnswer.questionRevision) ||
      safeAnswer.questionRevision < 1 ||
      safeAnswer.questionRevision > revision
    ) {
      throw new Error(
        `OwnerQuestion answer questionRevision must be an integer between 1 and the record revision ${revision}`,
      );
    }
    if (typeof safeAnswer.answeredAt !== 'string' || Number.isNaN(Date.parse(safeAnswer.answeredAt))) {
      throw new Error('OwnerQuestion answer requires a valid answeredAt timestamp');
    }
    const actor = validateAnswerActor(safeAnswer.actor, safeAnswer.answeredVia, isLegacy);
    // Domain backstop: an agent answers only where the asker opened the door
    // to any audience, and never through a signed owner decision.
    if (
      actor.startsWith('agent:') &&
      (audience !== 'any' || safeAnswer.answeredVia === 'signed-decision')
    ) {
      throw new Error(
        'OwnerQuestion refuses agent answer when audience is not any or answeredVia is signed-decision',
      );
    }
    // An accept always lands on the recommended option, whatever the caller named.
    const optionId =
      safeAnswer.shape === 'accept' ? recommendation.optionId : (safeAnswer.optionId ?? null);
    const text = safeAnswer.text ?? null;
    const reason = safeAnswer.reason ?? null;
    const sessionId = safeAnswer.sessionId ?? null;
    if (optionId !== null && !options.some((option) => option.id === optionId)) {
      throw new Error('OwnerQuestion answer names an option that is not one of the options');
    }
    if (safeAnswer.shape === 'reject' && optionId !== null) {
      throw new Error('OwnerQuestion answer shape reject must not name an option');
    }
    if (safeAnswer.shape === 'answer' && optionId === null && (text === null || text.length === 0)) {
      throw new Error('OwnerQuestion answer shape answer requires an optionId or text');
    }
    if (safeAnswer.shape === 'accept' && (reason !== null || (text !== null && text.length > 0))) {
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
      shape: safeAnswer.shape,
      optionId,
      text,
      reason,
      questionRevision: safeAnswer.questionRevision,
      answeredVia: safeAnswer.answeredVia as OwnerQuestionAnswerRecord['answeredVia'],
      answeredAt: normaliseTimestamp('answer answeredAt', safeAnswer.answeredAt),
      sessionId: sessionId === null ? null : readText('answer sessionId', sessionId, ID_MAX_CHARS),
      actor,
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
    // Read through its own property descriptors: a hostile getter on by or at
    // never runs, and a non-object, extra or accessor key is refused.
    const snap = readPlainObjectWithOptional(
      acknowledgement,
      [],
      ALLOWED_ACKNOWLEDGEMENT_KEYS,
      { refuseOptionalAccessors: true },
    );
    if (snap === null) {
      throw new Error('OwnerQuestion acknowledgement must be an object');
    }
    const safe = snap as unknown as { readonly by: string; readonly at: string };
    if (typeof safe.by !== 'string' || safe.by.trim().length === 0) {
      throw new Error('OwnerQuestion acknowledgement by must be a non-empty string');
    }
    if (typeof safe.at !== 'string' || Number.isNaN(Date.parse(safe.at))) {
      throw new Error('OwnerQuestion acknowledgement requires a valid at timestamp');
    }
    return {
      by: readText('acknowledgement by', safe.by, ID_MAX_CHARS),
      at: normaliseTimestamp('acknowledgement at', safe.at),
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
