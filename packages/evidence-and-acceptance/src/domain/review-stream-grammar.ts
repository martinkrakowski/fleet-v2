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

const refuse: ReviewStreamGrammarResult = { ok: false, reason: 'stream-grammar' };

const isStepStartType = (type: unknown): boolean =>
  type === 'step_start' || type === 'step-start';
const isStepFinishType = (type: unknown): boolean =>
  type === 'step_finish' || type === 'step-finish';

/**
 * Parse one raw `opencode run --format json` stream. Cost bound: the length
 * cap is read once before any splitting, then one bounded loop over at most
 * MAX_REVIEW_STREAM_EVENTS lines, each `JSON.parse`d at most once.
 */
export function parseReviewStreamGrammar(raw: unknown): ReviewStreamGrammarResult {
  try {
    if (typeof raw !== 'string') {
      return refuse;
    }
    if (raw.length > MAX_REVIEW_STREAM_LENGTH) {
      return refuse;
    }

    let inStep = false;
    let completeSteps = 0;
    let eventCount = 0;
    const texts: string[] = [];

    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '') continue;
      eventCount += 1;
      if (eventCount > MAX_REVIEW_STREAM_EVENTS) {
        return refuse;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return refuse;
      }
      const record = readPlainRecord(parsed);
      if (record === null) {
        return refuse;
      }

      const eventType = record.type;
      if (typeof eventType !== 'string') {
        return refuse;
      }

      let part: Readonly<Record<string, unknown>> | null = null;
      if (record.part !== undefined) {
        part = readPlainRecord(record.part);
        if (part === null) {
          return refuse;
        }
      }

      if (isStepStartType(eventType)) {
        if (part !== null && part.type !== undefined && !isStepStartType(part.type)) {
          return refuse;
        }
        if (inStep) {
          return refuse;
        }
        inStep = true;
        // Never reset the collected texts at a step start: the verdict text
        // spans every step of the stream.
      } else if (isStepFinishType(eventType)) {
        if (part !== null && part.type !== undefined && !isStepFinishType(part.type)) {
          return refuse;
        }
        if (!inStep) {
          return refuse;
        }
        inStep = false;
        completeSteps += 1;
      } else if (eventType === 'text') {
        if (!inStep) {
          return refuse;
        }
        if (part !== null && part.type !== undefined && part.type !== 'text') {
          return refuse;
        }
        const partText = part !== null && typeof part.text === 'string' ? part.text : null;
        const recordText = typeof record.text === 'string' ? record.text : null;
        const text = partText ?? recordText;
        if (text === null) {
          return refuse;
        }
        texts.push(text);
      } else if (eventType === 'tool' || eventType === 'tool_use' || eventType === 'tool_call') {
        if (!inStep) {
          return refuse;
        }
        // ALLOWED_PART_TYPES in the transport allows `tool` but not
        // `tool_use`/`tool_call` as a part type; match that.
        if (part !== null && part.type !== undefined && part.type !== 'tool') {
          return refuse;
        }
      } else {
        return refuse;
      }
    }

    if (inStep || completeSteps === 0) {
      return refuse;
    }
    return { ok: true, verdictText: texts.join('\n') };
  } catch {
    return refuse;
  }
}
