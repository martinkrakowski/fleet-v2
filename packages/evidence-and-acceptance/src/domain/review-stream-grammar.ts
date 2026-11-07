/**
 * RV5b (F166): the grammar of one opencode `--format json` review stream. A
 * stream yields a verdict text only when it is a run of well-formed steps: every
 * `step_start` is closed by its own `step_finish`, only `text` and tool events
 * sit inside a step, and nothing but whitespace-only text follows the final
 * finish. Every other shape (malformed, truncated, out-of-step, unknown event)
 * refuses to `stream-grammar` without reading any verdict. Pure domain: no I/O,
 * no cross-context imports, never throws on runtime input.
 */

import { readPlainRecord } from './review-answer-schema.js';

/** At most this many UTF-16 code units one raw review stream may carry. */
export const MAX_REVIEW_STREAM_LENGTH = 4 * 1024 * 1024;
/** At most this many non-blank event lines (or array entries) one review stream may carry. */
export const MAX_REVIEW_STREAM_EVENTS = 50_000;

export type ReviewStreamEvent =
  | { readonly kind: 'start' }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool' }
  | { readonly kind: 'finish' }
  | { readonly kind: 'other' };

export type ReviewStreamGrammarResult =
  | { readonly ok: true; readonly verdictText: string }
  | { readonly ok: false; readonly reason: 'stream-grammar' };

const GRAMMAR_FAILURE: ReviewStreamGrammarResult = Object.freeze({ ok: false, reason: 'stream-grammar' } as const);
const OTHER_EVENT: ReviewStreamEvent = { kind: 'other' };

const START_TYPES: readonly string[] = ['step_start', 'step-start'];
const FINISH_TYPES: readonly string[] = ['step_finish', 'step-finish'];
const TOOL_TYPES: readonly string[] = ['tool', 'tool_use', 'tool_call'];

/** True when the event has no `part`, or a plain `part` whose type is absent or one of `allowed`. */
function partTypeAllowed(record: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  if (record.part === undefined) {
    return true;
  }
  const part = readPlainRecord(record.part);
  if (part === null) {
    return false;
  }
  return part.type === undefined || (typeof part.type === 'string' && allowed.includes(part.type));
}

function isEventOfTypes(
  record: Readonly<Record<string, unknown>>,
  eventTypes: readonly string[],
  partTypes: readonly string[],
): boolean {
  return typeof record.type === 'string' && eventTypes.includes(record.type) && partTypeAllowed(record, partTypes);
}

/** The text a `text` event carries, or null when its shape is not a text event's. */
function readTextEvent(record: Readonly<Record<string, unknown>>): string | null {
  if (record.type !== 'text') {
    return null;
  }
  if (record.part === undefined) {
    return typeof record.text === 'string' ? record.text : null;
  }
  const part = readPlainRecord(record.part);
  if (part === null || (part.type !== undefined && part.type !== 'text')) {
    return null;
  }
  if (typeof part.text === 'string') {
    return part.text;
  }
  return part.text === undefined && typeof record.text === 'string' ? record.text : null;
}

/**
 * Classifies one parsed stream event. Hostile getters, Proxies, arrays, nulls
 * and primitives read as `other`. Only an event-level `type` opens or closes a
 * step: a step type that appears only in `part.type` is `other`.
 */
export function classifyReviewStreamEvent(raw: unknown): ReviewStreamEvent {
  const record = readPlainRecord(raw);
  if (record === null) {
    return OTHER_EVENT;
  }
  if (isEventOfTypes(record, START_TYPES, START_TYPES)) {
    return { kind: 'start' };
  }
  if (isEventOfTypes(record, FINISH_TYPES, FINISH_TYPES)) {
    return { kind: 'finish' };
  }
  if (isEventOfTypes(record, TOOL_TYPES, TOOL_TYPES)) {
    return { kind: 'tool' };
  }
  const text = readTextEvent(record);
  return text === null ? OTHER_EVENT : { kind: 'text', text };
}

type StreamPhase = 'before_first_step' | 'in_step' | 'after_step' | 'trailing_whitespace';

interface StreamState {
  phase: StreamPhase;
  finishedSteps: number;
  readonly currentStepTexts: string[];
  readonly finishedTexts: string[];
}

function isWhitespaceText(event: ReviewStreamEvent): boolean {
  return event.kind === 'text' && event.text.trim() === '';
}

function openStep(state: StreamState): boolean {
  state.currentStepTexts.length = 0;
  state.phase = 'in_step';
  return true;
}

function finishStep(state: StreamState): boolean {
  state.finishedTexts.push(...state.currentStepTexts);
  state.currentStepTexts.length = 0;
  state.finishedSteps += 1;
  state.phase = 'after_step';
  return true;
}

function stepInStep(state: StreamState, event: ReviewStreamEvent): boolean {
  switch (event.kind) {
    case 'text':
      state.currentStepTexts.push(event.text);
      return true;
    case 'tool':
      return true;
    case 'finish':
      return finishStep(state);
    default:
      return false;
  }
}

function stepAfterStep(state: StreamState, event: ReviewStreamEvent): boolean {
  if (event.kind === 'start') {
    return openStep(state);
  }
  if (isWhitespaceText(event)) {
    state.phase = 'trailing_whitespace';
    return true;
  }
  return false;
}

/** Applies one event to the state; false when the event breaks the grammar. */
function applyEvent(state: StreamState, event: ReviewStreamEvent): boolean {
  switch (state.phase) {
    case 'before_first_step':
      return event.kind === 'start' && openStep(state);
    case 'in_step':
      return stepInStep(state, event);
    case 'after_step':
      return stepAfterStep(state, event);
    default:
      return isWhitespaceText(event);
  }
}

function hasEveryIndex(events: readonly unknown[]): boolean {
  for (let index = 0; index < events.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(events, index)) {
      return false;
    }
  }
  return true;
}

function runStateMachine(events: readonly unknown[]): ReviewStreamGrammarResult {
  const state: StreamState = {
    phase: 'before_first_step',
    finishedSteps: 0,
    currentStepTexts: [],
    finishedTexts: [],
  };
  for (let index = 0; index < events.length; index += 1) {
    if (!applyEvent(state, classifyReviewStreamEvent(events[index]))) {
      return GRAMMAR_FAILURE;
    }
  }
  const closed = state.phase === 'after_step' || state.phase === 'trailing_whitespace';
  if (!closed || state.finishedSteps < 1) {
    return GRAMMAR_FAILURE;
  }
  return { ok: true, verdictText: state.finishedTexts.join('\n') };
}

/**
 * Validates a list of parsed stream events against the step grammar. A
 * non-array, an oversized array and a sparse array refuse; the verdict text is
 * the text of finished steps only, joined with newlines.
 */
export function validateReviewStreamEvents(events: unknown): ReviewStreamGrammarResult {
  try {
    if (!Array.isArray(events) || events.length > MAX_REVIEW_STREAM_EVENTS || !hasEveryIndex(events)) {
      return GRAMMAR_FAILURE;
    }
    return runStateMachine(events);
  } catch {
    return GRAMMAR_FAILURE;
  }
}

/** Parses every non-blank JSONL line, or null when a line fails to parse or the event cap is exceeded. */
function parseStreamLines(rawStdout: string): unknown[] | null {
  const events: unknown[] = [];
  for (const rawLine of rawStdout.split(/\r?\n/)) {
    if (rawLine.trim() === '') {
      continue;
    }
    if (events.length >= MAX_REVIEW_STREAM_EVENTS) {
      return null;
    }
    try {
      events.push(JSON.parse(rawLine) as unknown);
    } catch {
      return null;
    }
  }
  return events;
}

/**
 * Validates the raw stdout of one `opencode run --format json` review. Blank
 * separator lines are skipped; an unparseable line, an oversized stream or an
 * out-of-grammar event sequence refuses to `stream-grammar`.
 */
export function validateReviewStream(rawStdout: unknown): ReviewStreamGrammarResult {
  try {
    if (typeof rawStdout !== 'string' || rawStdout.length > MAX_REVIEW_STREAM_LENGTH) {
      return GRAMMAR_FAILURE;
    }
    const events = parseStreamLines(rawStdout);
    return events === null ? GRAMMAR_FAILURE : validateReviewStreamEvents(events);
  } catch {
    return GRAMMAR_FAILURE;
  }
}
