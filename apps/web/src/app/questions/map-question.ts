/**
 * Pure mapping from the `GET /v1/questions` wire envelope to the Questions
 * view's `QuestionView` records. Question text is untrusted: every string is
 * carried verbatim and rendered as React text children. Unknown keys are
 * ignored and never carried (no sessionId). One malformed question refuses
 * the whole list, so the page reports the read as unexpected instead of
 * trusting a shape it cannot read.
 */

import { isRecord } from "../../lib/attempt-wire";

export type QuestionState =
  | "open"
  | "answered"
  | "rejected"
  | "expired"
  | "acknowledged";

export type DoorKind = "one-way" | "two-way";

export interface QuestionOption {
  readonly id: string;
  readonly label: string;
  readonly consequence: string;
}

export interface QuestionBlock {
  readonly kind: "plan" | "pr" | "lane" | "work-order";
  readonly ref: string;
}

export interface QuestionAnswer {
  readonly shape: "accept" | "reject" | "answer";
  readonly optionId: string | null;
  readonly text: string | null;
  readonly reason: string | null;
  readonly questionRevision: number;
  readonly answeredVia: "web" | "cli" | "signed-decision";
  readonly answeredAt: string;
}

export interface QuestionView {
  readonly questionId: string;
  readonly revision: number;
  readonly askedBy: string;
  readonly title: string;
  readonly body: string;
  readonly options: readonly QuestionOption[];
  readonly recommendation: {
    readonly optionId: string;
    readonly because: string;
  };
  readonly doorKind: DoorKind;
  readonly linkedRequestId: string | null;
  readonly blocks: readonly QuestionBlock[];
  readonly state: QuestionState;
  readonly askedAt: string;
  readonly expiresAt: string | null;
  readonly answer: QuestionAnswer | null;
  readonly acknowledgement: {
    readonly by: string;
    readonly at: string;
  } | null;
}

const QUESTION_STATES = new Set([
  "open",
  "answered",
  "rejected",
  "expired",
  "acknowledged",
]);
const DOOR_KINDS = new Set(["one-way", "two-way"]);
const BLOCK_KINDS = new Set(["plan", "pr", "lane", "work-order"]);
const ANSWER_SHAPES = new Set(["accept", "reject", "answer"]);
const ANSWER_VIA = new Set(["web", "cli", "signed-decision"]);

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return parseString(value);
}

function parseOption(value: unknown): QuestionOption | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = parseString(value.id);
  const label = parseString(value.label);
  const consequence = parseString(value.consequence);
  if (id === undefined || label === undefined || consequence === undefined) {
    return undefined;
  }
  return { id, label, consequence };
}

function parseBlock(value: unknown): QuestionBlock | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = parseString(value.kind);
  const ref = parseString(value.ref);
  if (kind === undefined || !BLOCK_KINDS.has(kind)) {
    return undefined;
  }
  if (ref === undefined) {
    return undefined;
  }
  return { kind: kind as QuestionBlock["kind"], ref };
}

function parseAnswer(value: unknown): QuestionAnswer | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const shape = parseString(value.shape);
  if (shape === undefined || !ANSWER_SHAPES.has(shape)) {
    return undefined;
  }
  const optionId = parseNullableString(value.optionId);
  const text = parseNullableString(value.text);
  const reason = parseNullableString(value.reason);
  if (optionId === undefined || text === undefined || reason === undefined) {
    return undefined;
  }
  if (!isNonNegativeInteger(value.questionRevision)) {
    return undefined;
  }
  const answeredVia = parseString(value.answeredVia);
  if (answeredVia === undefined || !ANSWER_VIA.has(answeredVia)) {
    return undefined;
  }
  const answeredAt = parseString(value.answeredAt);
  if (answeredAt === undefined) {
    return undefined;
  }
  return {
    shape: shape as QuestionAnswer["shape"],
    optionId,
    text,
    reason,
    questionRevision: value.questionRevision,
    answeredVia: answeredVia as QuestionAnswer["answeredVia"],
    answeredAt,
  };
}

function parseAcknowledgement(
  value: unknown,
): { by: string; at: string } | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const by = parseString(value.by);
  const at = parseString(value.at);
  if (by === undefined || at === undefined) {
    return undefined;
  }
  return { by, at };
}

function parseQuestion(value: unknown): QuestionView | null {
  if (!isRecord(value)) {
    return null;
  }
  const questionId = parseString(value.questionId);
  if (questionId === undefined || questionId.length === 0) {
    return null;
  }
  if (!isNonNegativeInteger(value.revision)) {
    return null;
  }
  const askedBy = parseString(value.askedBy);
  const title = parseString(value.title);
  const body = parseString(value.body);
  if (askedBy === undefined || title === undefined || body === undefined) {
    return null;
  }

  if (!Array.isArray(value.options)) {
    return null;
  }
  const options: QuestionOption[] = [];
  for (const item of value.options) {
    const parsed = parseOption(item);
    if (parsed === undefined) {
      return null;
    }
    options.push(parsed);
  }

  if (!isRecord(value.recommendation)) {
    return null;
  }
  const optionId = parseString(value.recommendation.optionId);
  const because = parseString(value.recommendation.because);
  if (optionId === undefined || because === undefined) {
    return null;
  }

  const doorKind = parseString(value.doorKind);
  if (doorKind === undefined || !DOOR_KINDS.has(doorKind)) {
    return null;
  }
  const linkedRequestId = parseNullableString(value.linkedRequestId);
  if (linkedRequestId === undefined) {
    return null;
  }
  if (doorKind === "one-way" && linkedRequestId === null) {
    return null;
  }

  if (!Array.isArray(value.blocks)) {
    return null;
  }
  const blocks: QuestionBlock[] = [];
  for (const item of value.blocks) {
    const parsed = parseBlock(item);
    if (parsed === undefined) {
      return null;
    }
    blocks.push(parsed);
  }

  const state = parseString(value.state);
  if (state === undefined || !QUESTION_STATES.has(state)) {
    return null;
  }

  const askedAt = parseString(value.askedAt);
  if (askedAt === undefined) {
    return null;
  }
  const expiresAt = parseNullableString(value.expiresAt);
  if (expiresAt === undefined) {
    return null;
  }

  const answer = parseAnswer(value.answer);
  if (answer === undefined) {
    return null;
  }
  const acknowledgement = parseAcknowledgement(value.acknowledgement);
  if (acknowledgement === undefined) {
    return null;
  }

  return {
    questionId,
    revision: value.revision,
    askedBy,
    title,
    body,
    options,
    recommendation: { optionId, because },
    doorKind: doorKind as DoorKind,
    linkedRequestId,
    blocks,
    state: state as QuestionState,
    askedAt,
    expiresAt,
    answer,
    acknowledgement,
  };
}

export function parseQuestionListEnvelope(
  value: unknown,
): readonly QuestionView[] | null {
  if (!isRecord(value) || value.code !== "OK") {
    return null;
  }
  const result = value.result;
  if (!isRecord(result) || !Array.isArray(result.questions)) {
    return null;
  }
  const questions: QuestionView[] = [];
  for (const item of result.questions) {
    const parsed = parseQuestion(item);
    if (parsed === null) {
      return null;
    }
    questions.push(parsed);
  }
  return questions;
}
