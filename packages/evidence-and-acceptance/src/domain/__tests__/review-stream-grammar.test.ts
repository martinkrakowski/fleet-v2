/**
 * Unit tests for the RV5b review stream grammar (F166): the event classifier,
 * the step state machine and the raw JSONL validator. Pure domain — no I/O.
 */

import { describe, expect, it } from 'vitest';

import { ReviewReceipt } from '../entities/ReviewReceipt.js';
import { REVIEW_UNKNOWN_REASONS } from '../evidence-records.js';
import {
  MAX_REVIEW_STREAM_EVENTS,
  MAX_REVIEW_STREAM_LENGTH,
  classifyReviewStreamEvent,
  validateReviewStream,
  validateReviewStreamEvents,
} from '../review-stream-grammar.js';

const FAILURE = { ok: false, reason: 'stream-grammar' } as const;

const start = { type: 'step_start' };
const finish = { type: 'step_finish' };
const text = (value: string): unknown => ({ type: 'text', part: { type: 'text', text: value } });
const jsonl = (...events: readonly unknown[]): string => events.map((event) => JSON.stringify(event)).join('\n');

describe('classifyReviewStreamEvent', () => {
  it('classifies event-level step starts, finishes, tools and text', () => {
    expect(classifyReviewStreamEvent({ type: 'step_start' })).toEqual({ kind: 'start' });
    expect(classifyReviewStreamEvent({ type: 'step-start', part: { type: 'step-start' } })).toEqual({ kind: 'start' });
    expect(classifyReviewStreamEvent({ type: 'step_finish' })).toEqual({ kind: 'finish' });
    expect(classifyReviewStreamEvent({ type: 'step-finish', part: { type: 'step_finish' } })).toEqual({ kind: 'finish' });
    expect(classifyReviewStreamEvent({ type: 'tool' })).toEqual({ kind: 'tool' });
    expect(classifyReviewStreamEvent({ type: 'tool_use', part: { type: 'tool_call', tool: 'read' } })).toEqual({ kind: 'tool' });
    expect(classifyReviewStreamEvent({ type: 'tool_call', part: { tool: 'read' } })).toEqual({ kind: 'tool' });
    expect(classifyReviewStreamEvent({ type: 'text', text: 'a' })).toEqual({ kind: 'text', text: 'a' });
    expect(classifyReviewStreamEvent({ type: 'text', part: { text: 'b' } })).toEqual({ kind: 'text', text: 'b' });
    expect(classifyReviewStreamEvent({ type: 'text', part: { type: 'text' }, text: 'c' })).toEqual({ kind: 'text', text: 'c' });
    expect(classifyReviewStreamEvent(text('d'))).toEqual({ kind: 'text', text: 'd' });
  });

  it('never classifies a part-level step type alone as a start or a finish', () => {
    for (const type of ['step_finish', 'step-finish']) {
      expect(classifyReviewStreamEvent({ type: 'text', part: { type } })).toEqual({ kind: 'other' });
      expect(classifyReviewStreamEvent({ type: 'text', part: { type, text: 'PASS' } })).toEqual({ kind: 'other' });
      expect(classifyReviewStreamEvent({ type: 'tool', part: { type, tool: 'read' } })).toEqual({ kind: 'other' });
      expect(classifyReviewStreamEvent({ part: { type } })).toEqual({ kind: 'other' });
      expect(classifyReviewStreamEvent({ type: 'step_start', part: { type } })).toEqual({ kind: 'other' });
    }
    for (const type of ['step_start', 'step-start']) {
      expect(classifyReviewStreamEvent({ part: { type } })).toEqual({ kind: 'other' });
      expect(classifyReviewStreamEvent({ type: 'text', part: { type, text: 'x' } })).toEqual({ kind: 'other' });
      expect(classifyReviewStreamEvent({ type: 'step_finish', part: { type } })).toEqual({ kind: 'other' });
    }
  });

  it('reads a mismatched part type as other', () => {
    for (const type of ['patch', 'file', 'snapshot']) {
      expect(classifyReviewStreamEvent({ type: 'text', part: { type, text: 'x' } })).toEqual({ kind: 'other' });
      expect(classifyReviewStreamEvent({ type: 'step_finish', part: { type } })).toEqual({ kind: 'other' });
      expect(classifyReviewStreamEvent({ type: 'step_start', part: { type } })).toEqual({ kind: 'other' });
      expect(classifyReviewStreamEvent({ type: 'tool', part: { type } })).toEqual({ kind: 'other' });
    }
  });

  it('reads text without a string body, a non-record part or an unknown type as other', () => {
    expect(classifyReviewStreamEvent({ type: 'text' })).toEqual({ kind: 'other' });
    expect(classifyReviewStreamEvent({ type: 'text', text: 7 })).toEqual({ kind: 'other' });
    expect(classifyReviewStreamEvent({ type: 'text', part: { text: 7 } })).toEqual({ kind: 'other' });
    expect(classifyReviewStreamEvent({ type: 'text', part: [], text: 'x' })).toEqual({ kind: 'other' });
    expect(classifyReviewStreamEvent({ type: 'text', part: null, text: 'x' })).toEqual({ kind: 'other' });
    expect(classifyReviewStreamEvent({ type: 'custom_debug' })).toEqual({ kind: 'other' });
    expect(classifyReviewStreamEvent({ type: 7 })).toEqual({ kind: 'other' });
  });
});

describe('validateReviewStreamEvents', () => {
  it('accepts a single finished step and joins its text', () => {
    expect(validateReviewStreamEvents([start, text('a'), { type: 'tool', part: { tool: 'read' } }, text('b'), finish])).toEqual({
      ok: true,
      verdictText: 'a\nb',
    });
  });

  it('accepts a finished step with no text as an empty verdict text', () => {
    expect(validateReviewStreamEvents([start, finish])).toEqual({ ok: true, verdictText: '' });
    expect(validateReviewStreamEvents([start, text(''), finish])).toEqual({ ok: true, verdictText: '' });
  });

  it('joins the text of finished steps only, in order, with newlines', () => {
    expect(validateReviewStreamEvents([start, text('one'), finish, start, text('two'), finish])).toEqual({
      ok: true,
      verdictText: 'one\ntwo',
    });
  });

  it('accepts trailing whitespace-only text after the final finish and excludes it from the verdict text', () => {
    expect(validateReviewStreamEvents([start, text('PASS'), finish, text('  '), text('\n')])).toEqual({
      ok: true,
      verdictText: 'PASS',
    });
  });

  it('refuses an empty stream, an unfinished step and a step-less stream', () => {
    expect(validateReviewStreamEvents([])).toEqual(FAILURE);
    expect(validateReviewStreamEvents([start])).toEqual(FAILURE);
    expect(validateReviewStreamEvents([start, text('PASS')])).toEqual(FAILURE);
    expect(validateReviewStreamEvents([start, text('one'), finish, start, text('two')])).toEqual(FAILURE);
  });

  it('refuses text, tool, finish or unknown events before the first step', () => {
    expect(validateReviewStreamEvents([text('PASS'), start, finish])).toEqual(FAILURE);
    expect(validateReviewStreamEvents([text('  '), start, text('PASS'), finish])).toEqual(FAILURE);
    expect(validateReviewStreamEvents([{ type: 'tool' }, start, finish])).toEqual(FAILURE);
    expect(validateReviewStreamEvents([finish, start, finish])).toEqual(FAILURE);
    expect(validateReviewStreamEvents([{ type: 'custom_debug' }, start, finish])).toEqual(FAILURE);
  });

  it('refuses a nested start and an unknown event inside a step', () => {
    expect(validateReviewStreamEvents([start, text('a'), start, text('PASS'), finish])).toEqual(FAILURE);
    expect(validateReviewStreamEvents([start, { type: 'custom_debug' }, text('PASS'), finish])).toEqual(FAILURE);
  });

  it('refuses events after a finish other than a start or whitespace text', () => {
    expect(validateReviewStreamEvents([start, finish, text('PASS')])).toEqual(FAILURE);
    expect(validateReviewStreamEvents([start, finish, finish])).toEqual(FAILURE);
    expect(validateReviewStreamEvents([start, finish, { type: 'tool' }])).toEqual(FAILURE);
    expect(validateReviewStreamEvents([start, finish, { type: 'custom_debug' }])).toEqual(FAILURE);
  });

  it('refuses a step start after a trailing whitespace-only text event', () => {
    expect(validateReviewStreamEvents([start, finish, text(' '), start, text('PASS'), finish])).toEqual(FAILURE);
  });

  it('refuses anything but whitespace text once trailing whitespace began', () => {
    expect(validateReviewStreamEvents([start, finish, text(' '), text('PASS')])).toEqual(FAILURE);
    expect(validateReviewStreamEvents([start, finish, text(' '), { type: 'tool' }])).toEqual(FAILURE);
    expect(validateReviewStreamEvents([start, finish, text(' '), finish])).toEqual(FAILURE);
    expect(validateReviewStreamEvents([start, finish, text(' '), { type: 'custom_debug' }])).toEqual(FAILURE);
  });

  it('refuses part-level step finishes and starts as step boundaries', () => {
    expect(validateReviewStreamEvents([start, text('PASS'), { type: 'text', part: { type: 'step_finish' } }])).toEqual(FAILURE);
    expect(validateReviewStreamEvents([start, text('PASS'), { type: 'tool', part: { type: 'step-finish', tool: 'read' } }])).toEqual(
      FAILURE,
    );
    expect(validateReviewStreamEvents([{ part: { type: 'step_start' } }, text('PASS'), finish])).toEqual(FAILURE);
  });

  it('refuses a non-array and a sparse array', () => {
    expect(validateReviewStreamEvents('not an array')).toEqual(FAILURE);
    expect(validateReviewStreamEvents({ length: 0 })).toEqual(FAILURE);
    expect(validateReviewStreamEvents(new Array<unknown>(2))).toEqual(FAILURE);
    const holey: unknown[] = [start, text('PASS'), finish];
    delete holey[1];
    expect(validateReviewStreamEvents(holey)).toEqual(FAILURE);
  });
});

describe('validateReviewStream', () => {
  it('accepts a one-step stream and ignores blank JSONL lines', () => {
    const stdout = `\n${JSON.stringify(start)}\n\n  \r\n${JSON.stringify(text('PASS'))}\r\n${JSON.stringify(finish)}\n\n`;
    expect(validateReviewStream(stdout)).toEqual({ ok: true, verdictText: 'PASS' });
  });

  it('accepts a multi-step stream with trailing whitespace-only text events', () => {
    expect(validateReviewStream(jsonl(start, text('a'), finish, start, text('b'), finish, text('\n\n')))).toEqual({
      ok: true,
      verdictText: 'a\nb',
    });
  });

  it('refuses an unparseable line anywhere in the stream', () => {
    expect(validateReviewStream(`${JSON.stringify(start)}\nnot json\n${JSON.stringify(finish)}`)).toEqual(FAILURE);
    expect(validateReviewStream(`${jsonl(start, text('PASS'), finish)}\n{"type":`)).toEqual(FAILURE);
  });

  it('refuses a parsed non-record line as an out-of-grammar event', () => {
    expect(validateReviewStream(`${JSON.stringify(start)}\nnull\n${JSON.stringify(finish)}`)).toEqual(FAILURE);
    expect(validateReviewStream(`${JSON.stringify(start)}\n[]\n${JSON.stringify(finish)}`)).toEqual(FAILURE);
    expect(validateReviewStream(`${JSON.stringify(start)}\n7\n${JSON.stringify(finish)}`)).toEqual(FAILURE);
  });
});

describe('robustness', () => {
  const throwing = (): object => {
    const record: Record<string, unknown> = {};
    Object.defineProperty(record, 'type', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    return record;
  };
  const throwingPart = (): object => {
    const part: Record<string, unknown> = {};
    Object.defineProperty(part, 'type', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    return { type: 'text', part };
  };
  class Instance {
    public readonly type = 'step_start';
  }
  const hostileProxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('boom');
      },
      getPrototypeOf() {
        throw new Error('boom');
      },
    },
  );
  const hostileValues: readonly unknown[] = [
    null,
    undefined,
    7,
    'text',
    true,
    Symbol('s'),
    [],
    [start],
    new Array<unknown>(2),
    new Instance(),
    { type: 'unknown_type', part: { type: 'unknown_part' } },
    throwing(),
    throwingPart(),
    hostileProxy,
  ];

  it('robustness (1): classifyReviewStreamEvent, validateReviewStreamEvents, and validateReviewStream never throw on null, primitives, sparse arrays, unknown enums, or throwing getters', () => {
    for (const value of hostileValues) {
      expect(classifyReviewStreamEvent(value)).toEqual({ kind: 'other' });
      expect(validateReviewStreamEvents(value)).toEqual(FAILURE);
      expect(validateReviewStream(value)).toEqual(FAILURE);
      expect(validateReviewStreamEvents([start, value, finish])).toEqual(FAILURE);
      expect(validateReviewStreamEvents([start, text('PASS'), finish, value])).toEqual(FAILURE);
    }
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    expect(validateReviewStreamEvents(revoked.proxy)).toEqual(FAILURE);
  });

  it('robustness (3): validateReviewStream is stateless across repeated calls and ReviewReceipt accepts unknownReason stream-grammar', () => {
    const good = jsonl(start, text('PASS'), finish);
    const bad = jsonl(start, text('PASS'));
    for (let round = 0; round < 3; round += 1) {
      expect(validateReviewStream(good)).toEqual({ ok: true, verdictText: 'PASS' });
      expect(validateReviewStream(bad)).toEqual(FAILURE);
    }
    expect(REVIEW_UNKNOWN_REASONS).toContain('stream-grammar');
    const created = ReviewReceipt.create({
      id: 'rr-1',
      assessmentId: 'ea-1',
      projectId: 'proj-1',
      attemptId: 'att-1',
      candidateHeadSha: 'sha-1',
      reviewerModel: 'openrouter/poolside/laguna-s-2.1',
      implementerModel: 'openrouter/z-ai/glm-5.3-flash',
      readOnlyVerified: false,
      result: 'unknown',
      findings: [],
      evidenceRef: 'evidence://rr-1',
      policyRevision: 'policy-7',
      completedAtIso: '2026-10-15T00:01:00.000Z',
      unknownReason: 'stream-grammar',
    });
    expect(created.success).toBe(true);
    const record = created.value?.toRecord();
    expect(record?.unknownReason).toBe('stream-grammar');
    const replayed = ReviewReceipt.create(record!);
    expect(replayed.success).toBe(true);
    expect(replayed.value?.toRecord().unknownReason).toBe('stream-grammar');
  });

  it('robustness (4): unreadable, empty, and grammar-violating streams return unknown with stream-grammar, never empty or pass', () => {
    const violations: readonly unknown[] = [
      '',
      '   \n\n',
      'not json',
      '{"type":"step_start"}\n{',
      jsonl(start),
      jsonl(start, text('PASS')),
      jsonl(text('PASS')),
      jsonl(start, finish, text('PASS')),
      jsonl(start, { type: 'text', part: { type: 'step_finish' } }),
      jsonl({ part: { type: 'step_start' } }, text('PASS'), finish),
      jsonl(finish),
    ];
    for (const stdout of violations) {
      expect(validateReviewStream(stdout)).toEqual(FAILURE);
    }
  });

  it('robustness (7): validateReviewStream and validateReviewStreamEvents refuse oversized inputs and event counts with stream-grammar', () => {
    expect(validateReviewStream('x'.repeat(MAX_REVIEW_STREAM_LENGTH + 1))).toEqual(FAILURE);
    const padded = `${jsonl(start, text('PASS'), finish)}${' '.repeat(MAX_REVIEW_STREAM_LENGTH - 100)}`;
    expect(validateReviewStream(padded.slice(0, MAX_REVIEW_STREAM_LENGTH))).toEqual({ ok: true, verdictText: 'PASS' });

    const atCap: unknown[] = [start, ...new Array<unknown>(MAX_REVIEW_STREAM_EVENTS - 2).fill(text('')), finish];
    expect(atCap).toHaveLength(MAX_REVIEW_STREAM_EVENTS);
    expect(validateReviewStreamEvents(atCap)).toEqual({ ok: true, verdictText: '\n'.repeat(MAX_REVIEW_STREAM_EVENTS - 3) });
    expect(validateReviewStreamEvents([...atCap, text(' ')])).toEqual(FAILURE);

    const lines = [JSON.stringify(start), ...new Array<string>(MAX_REVIEW_STREAM_EVENTS - 2).fill('{"type":"tool"}'), JSON.stringify(finish)];
    expect(validateReviewStream(lines.join('\n'))).toEqual({ ok: true, verdictText: '' });
    expect(validateReviewStream([...lines, '{"type":"tool"}'].join('\n'))).toEqual(FAILURE);
    expect(validateReviewStream([...lines, '', '  ', ''].join('\n'))).toEqual({ ok: true, verdictText: '' });
  });
});
