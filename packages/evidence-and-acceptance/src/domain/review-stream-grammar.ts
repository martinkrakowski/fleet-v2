/**
 * RVG1: the pure domain grammar of one `opencode run --format json`
 * newline-delimited JSON event stream. A well-formed stream is a sequence of
 * complete `step_start … step_finish` blocks carrying `text` and `tool`
 * events, and its verdict text is every text event of the WHOLE stream joined
 * by a newline (so the answer schema's "exactly one json block, placed last"
 * rule downstream sees every step). Any other shape refuses
 * `stream-grammar`. Pure domain: no I/O, no cross-context imports; every
 * refusal is a typed result, never a thrown exception.
 */

import { readPlainRecord } from './review-answer-schema.js';

/** At most this many UTF-16 code units one raw stream may carry. */
export const MAX_REVIEW_STREAM_LENGTH = 4 * 1024 * 1024;
/** At most this many non-blank event lines one stream may carry. */
export const MAX_REVIEW_STREAM_EVENTS = 50_000;

/** The typed grammar outcome: the joined verdict text, or a refusal reason. */
export type ReviewStreamGrammarResult =
  | { ok: true; verdictText: string }
  | { ok: false; reason: 'stream-grammar' };

const refuse: ReviewStreamGrammarResult = Object.freeze({
  ok: false,
  reason: 'stream-grammar',
});

const isStepStartType = (type: unknown): boolean =>
  type === 'step_start' || type === 'step-start';
const isStepFinishType = (type: unknown): boolean =>
  type === 'step_finish' || type === 'step-finish';

type Part = Readonly<Record<string, unknown>> | null;

interface StreamState {
  inStep: boolean;
  completeSteps: number;
  eventCount: number;
  readonly texts: string[];
}

/** True when a part carries a type that the event kind does not accept. */
const partTypeMismatch = (part: Part, accepts: (type: unknown) => boolean): boolean =>
  part !== null && part.type !== undefined && !accepts(part.type);

/** The optional `part` record: `null` when absent, `undefined` when not plain. */
function readPart(record: Readonly<Record<string, unknown>>): Part | undefined {
  if (record.part === undefined) {
    return null;
  }
  return readPlainRecord(record.part) ?? undefined;
}

/** Parse one trimmed non-blank line into a plain record, or `null`. */
function parseEventLine(line: string): Readonly<Record<string, unknown>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return readPlainRecord(parsed);
}

/** Each handler returns true when the event is accepted, false to refuse. */
function acceptStepStart(state: StreamState, part: Part): boolean {
  if (partTypeMismatch(part, isStepStartType) || state.inStep) {
    return false;
  }
  state.inStep = true;
  // Never reset the collected texts at a step start: the verdict text
  // spans every step of the stream.
  return true;
}

function acceptStepFinish(state: StreamState, part: Part): boolean {
  if (partTypeMismatch(part, isStepFinishType) || !state.inStep) {
    return false;
  }
  state.inStep = false;
  state.completeSteps += 1;
  return true;
}

function readEventText(record: Readonly<Record<string, unknown>>, part: Part): string | null {
  const partText = part !== null && typeof part.text === 'string' ? part.text : null;
  const recordText = typeof record.text === 'string' ? record.text : null;
  return partText ?? recordText;
}

function acceptText(
  state: StreamState,
  record: Readonly<Record<string, unknown>>,
  part: Part,
): boolean {
  if (!state.inStep || partTypeMismatch(part, (type) => type === 'text')) {
    return false;
  }
  const text = readEventText(record, part);
  if (text === null) {
    return false;
  }
  state.texts.push(text);
  return true;
}

function acceptTool(state: StreamState, part: Part): boolean {
  // ALLOWED_PART_TYPES in the transport allows `tool` but not
  // `tool_use`/`tool_call` as a part type; match that.
  return state.inStep && !partTypeMismatch(part, (type) => type === 'tool');
}

const isToolEventType = (type: string): boolean =>
  type === 'tool' || type === 'tool_use' || type === 'tool_call';

/** Apply one parsed event to the state; true when accepted. */
function applyEvent(state: StreamState, record: Readonly<Record<string, unknown>>): boolean {
  const eventType = record.type;
  if (typeof eventType !== 'string') {
    return false;
  }
  const part = readPart(record);
  if (part === undefined) {
    return false;
  }
  if (isStepStartType(eventType)) {
    return acceptStepStart(state, part);
  }
  if (isStepFinishType(eventType)) {
    return acceptStepFinish(state, part);
  }
  if (eventType === 'text') {
    return acceptText(state, record, part);
  }
  if (isToolEventType(eventType)) {
    return acceptTool(state, part);
  }
  return false;
}

/** Apply one raw line; true when it is blank or an accepted event. */
function applyLine(state: StreamState, rawLine: string): boolean {
  const line = rawLine.trim();
  if (line === '') {
    return true;
  }
  state.eventCount += 1;
  if (state.eventCount > MAX_REVIEW_STREAM_EVENTS) {
    return false;
  }
  const record = parseEventLine(line);
  return record !== null && applyEvent(state, record);
}

/**
 * Parse one raw `opencode run --format json` stream. Cost bound: the length
 * cap is read once before any splitting, then one bounded loop over at most
 * MAX_REVIEW_STREAM_EVENTS lines, each `JSON.parse`d at most once.
 */
export function parseReviewStreamGrammar(raw: unknown): ReviewStreamGrammarResult {
  try {
    if (typeof raw !== 'string' || raw.length > MAX_REVIEW_STREAM_LENGTH) {
      return refuse;
    }
    const state: StreamState = { inStep: false, completeSteps: 0, eventCount: 0, texts: [] };
    for (const rawLine of raw.split(/\r?\n/)) {
      if (!applyLine(state, rawLine)) {
        return refuse;
      }
    }
    if (state.inStep || state.completeSteps === 0) {
      return refuse;
    }
    return { ok: true, verdictText: state.texts.join('\n') };
  } catch {
    return refuse;
  }
}
