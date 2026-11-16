/**
 * Unit tests for the RVG1 review-stream grammar: the pure parser of one
 * `opencode run --format json` newline-delimited JSON stream. Every refusal
 * path returns `{ ok: false, reason: 'stream-grammar' }` and never throws.
 * Pure domain — no I/O, no subprocesses.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_REVIEW_STREAM_EVENTS,
  MAX_REVIEW_STREAM_LENGTH,
  parseReviewStreamGrammar,
} from '../review-stream-grammar.js';

const stepStart = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'step_start', ...extra });
const stepFinish = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'step_finish', ...extra });
const textEvent = (text: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'text', text, ...extra });
const toolEvent = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'tool', tool: 'grep', ...extra });

/** One well-formed single-step stream carrying the given text. */
const oneStep = (text = 'hello'): string =>
  [stepStart(), toolEvent(), textEvent(text), stepFinish()].join('\n');

const refused = { ok: false, reason: 'stream-grammar' } as const;

describe('parseReviewStreamGrammar', () => {
  it('accepts a well-formed single-step stream and joins its text', () => {
    expect(parseReviewStreamGrammar(oneStep('the verdict'))).toEqual({
      ok: true,
      verdictText: 'the verdict',
    });
  });

  it('refuses non-string input without throwing', () => {
    const holey: unknown[] = [];
    holey.length = 1;
    for (const bad of [null, undefined, 42, {}, holey]) {
      expect(parseReviewStreamGrammar(bad)).toEqual(refused);
    }
  });

  it('accepts stream at MAX_REVIEW_STREAM_LENGTH and refuses one character over', () => {
    // Pad the single text event so the raw length lands exactly on the cap.
    const base = oneStep('x');
    const pad = MAX_REVIEW_STREAM_LENGTH - base.length;
    expect(pad).toBeGreaterThanOrEqual(0);
    const exact = base.replace('"text":"x"', `"text":"${'x'.repeat(pad + 1)}"`);
    expect(exact.length).toBe(MAX_REVIEW_STREAM_LENGTH);
    expect(parseReviewStreamGrammar(exact)).toEqual({
      ok: true,
      verdictText: 'x'.repeat(pad + 1),
    });
    expect(parseReviewStreamGrammar(exact + ' ')).toEqual(refused);
  });

  it('accepts stream at MAX_REVIEW_STREAM_EVENTS and refuses one event over', () => {
    const blankLines = Array.from({ length: 5 }, () => '').join('\n');
    const atCap = [
      blankLines,
      stepStart(),
      ...Array.from({ length: MAX_REVIEW_STREAM_EVENTS - 2 }, () => toolEvent()),
      stepFinish(),
      blankLines,
    ].join('\n');
    expect(parseReviewStreamGrammar(atCap)).toEqual({ ok: true, verdictText: '' });

    // One valid tool event over the cap: only the count can refuse it.
    const over = [
      stepStart(),
      ...Array.from({ length: MAX_REVIEW_STREAM_EVENTS - 1 }, () => toolEvent()),
      stepFinish(),
    ].join('\n');
    expect(over.split('\n')).toHaveLength(MAX_REVIEW_STREAM_EVENTS + 1);
    expect(parseReviewStreamGrammar(over)).toEqual(refused);
  });

  it('returns a frozen refusal that a caller cannot mutate', () => {
    const first = parseReviewStreamGrammar('') as Record<string, unknown>;
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      first.reason = 'tampered';
    }).toThrow(TypeError);
    expect(() => {
      first.ok = true;
    }).toThrow(TypeError);
    expect(parseReviewStreamGrammar('')).toEqual(refused);
    expect(parseReviewStreamGrammar(null)).toEqual(refused);
  });

  it('refuses empty or whitespace-only stream with zero complete steps', () => {
    expect(parseReviewStreamGrammar('')).toEqual(refused);
    expect(parseReviewStreamGrammar('   \n\t\n  ')).toEqual(refused);
  });

  it('refuses a line that is not valid JSON', () => {
    expect(parseReviewStreamGrammar(`${stepStart()}\n{not json\n${stepFinish()}`)).toEqual(refused);
  });

  it('refuses a JSON line that is not a plain object', () => {
    for (const bad of ['[]', '"str"', '123', 'null', 'true']) {
      expect(parseReviewStreamGrammar(`${stepStart()}\n${bad}\n${stepFinish()}`)).toEqual(refused);
      expect(parseReviewStreamGrammar(bad)).toEqual(refused);
    }
  });

  it('refuses events outside a step and non-whitespace text after final finish', () => {
    expect(parseReviewStreamGrammar(textEvent('early'))).toEqual(refused);
    expect(parseReviewStreamGrammar(toolEvent())).toEqual(refused);
    expect(parseReviewStreamGrammar(`${oneStep()}\n${toolEvent()}`)).toEqual(refused);
    expect(parseReviewStreamGrammar(`${oneStep()}\n${textEvent('late')}`)).toEqual(refused);
    // A non-whitespace trailing line after the final finish also refuses.
    expect(parseReviewStreamGrammar(`${oneStep()}\ntrailing`)).toEqual(refused);
  });

  it('refuses step_start before prior step is closed', () => {
    expect(parseReviewStreamGrammar([stepStart(), stepStart(), stepFinish()].join('\n'))).toEqual(
      refused,
    );
    // Nested via a part carrying a step_start type.
    expect(
      parseReviewStreamGrammar([stepStart(), stepStart({ part: { type: 'step_start' } }), stepFinish()].join('\n')),
    ).toEqual(refused);
  });

  it('refuses step_finish with no open step', () => {
    expect(parseReviewStreamGrammar(stepFinish())).toEqual(refused);
    expect(parseReviewStreamGrammar([oneStep(), stepFinish()].join('\n'))).toEqual(refused);
  });

  it('refuses step_start left open at end of stream', () => {
    expect(parseReviewStreamGrammar(stepStart())).toEqual(refused);
    expect(parseReviewStreamGrammar([stepStart(), textEvent('x')].join('\n'))).toEqual(refused);
  });

  it('refuses unknown or missing event type inside a step', () => {
    for (const bad of [
      JSON.stringify({ type: 'error' }),
      JSON.stringify({ type: 'unknown' }),
      JSON.stringify({ text: 'no type' }),
    ]) {
      expect(parseReviewStreamGrammar([stepStart(), bad, stepFinish()].join('\n'))).toEqual(refused);
      // Outside a step too.
      expect(parseReviewStreamGrammar(bad)).toEqual(refused);
    }
  });

  it('refuses text event without string payload or with mismatched part.type', () => {
    for (const bad of [
      JSON.stringify({ type: 'text' }),
      JSON.stringify({ type: 'text', text: 42 }),
      JSON.stringify({ type: 'text', part: { type: 'text' } }),
      JSON.stringify({ type: 'text', part: { type: 'tool' }, text: 'x' }),
    ]) {
      expect(parseReviewStreamGrammar([stepStart(), bad, stepFinish()].join('\n'))).toEqual(refused);
    }
  });

  it('reads text from part.text when present and from record.text otherwise', () => {
    const withPart = [stepStart(), JSON.stringify({ type: 'text', part: { type: 'text', text: 'from part' } }), stepFinish()].join('\n');
    expect(parseReviewStreamGrammar(withPart)).toEqual({ ok: true, verdictText: 'from part' });
    // part.type may be undefined.
    const partWithoutType = [stepStart(), JSON.stringify({ type: 'text', part: { text: 'bare' } }), stepFinish()].join('\n');
    expect(parseReviewStreamGrammar(partWithoutType)).toEqual({ ok: true, verdictText: 'bare' });
  });

  it('accepts step and tool events carrying a matching part, and refuses a non-plain part', () => {
    const withParts = [
      stepStart({ part: { type: 'step_start' } }),
      toolEvent({ part: { type: 'tool', tool: 'grep' } }),
      stepFinish({ part: { type: 'step_finish' } }),
    ].join('\n');
    expect(parseReviewStreamGrammar(withParts)).toEqual({ ok: true, verdictText: '' });

    for (const badPart of ['[]', '"x"', 'null']) {
      const bad = [stepStart(), JSON.stringify({ type: 'text', part: JSON.parse(badPart), text: 'x' }), stepFinish()].join('\n');
      expect(parseReviewStreamGrammar(bad)).toEqual(refused);
    }
  });

  it('refuses step_start and step_finish whose part.type names another kind', () => {
    for (const badType of ['tool', 'text', 'step_finish']) {
      expect(
        parseReviewStreamGrammar(
          [stepStart({ part: { type: badType } }), stepFinish()].join('\n'),
        ),
      ).toEqual(refused);
    }
    for (const badType of ['tool', 'text', 'step_start']) {
      expect(
        parseReviewStreamGrammar(
          [stepStart(), stepFinish({ part: { type: badType } })].join('\n'),
        ),
      ).toEqual(refused);
    }
  });

  it('refuses a tool event carrying part.type text', () => {
    const bad = [stepStart(), toolEvent({ part: { type: 'text' } }), stepFinish()].join('\n');
    expect(parseReviewStreamGrammar(bad)).toEqual(refused);
    for (const kind of ['tool_use', 'tool_call']) {
      const other = [stepStart(), JSON.stringify({ type: kind, part: { type: 'text' } }), stepFinish()];
      expect(parseReviewStreamGrammar(other.join('\n'))).toEqual(refused);
    }
  });

  it('refuses a text event whose part.type is step_start or step_finish', () => {
    for (const badType of ['step_start', 'step_finish', 'tool']) {
      const bad = [stepStart(), textEvent('x', { part: { type: badType } }), stepFinish()];
      expect(parseReviewStreamGrammar(bad.join('\n'))).toEqual(refused);
    }
  });

  it('refuses tool event whose part.type is not tool', () => {
    const bad = [stepStart(), JSON.stringify({ type: 'tool_use', part: { type: 'tool_use' } }), stepFinish()].join('\n');
    expect(parseReviewStreamGrammar(bad)).toEqual(refused);
  });

  it('returns the text of all steps joined by newline', () => {
    const stream = [
      stepStart(),
      toolEvent({ type: 'tool_use' }),
      textEvent('step one verdict'),
      stepFinish(),
      stepStart({ type: 'step-start' }),
      textEvent('step two a'),
      textEvent('step two b'),
      stepFinish({ type: 'step-finish' }),
      '   ',
    ].join('\n');
    expect(parseReviewStreamGrammar(stream)).toEqual({
      ok: true,
      verdictText: 'step one verdict\nstep two a\nstep two b',
    });
  });

  it('keeps text of two steps that differ, in order, joined by newline', () => {
    const stream = [
      stepStart(),
      textEvent('FAIL block in step 1'),
      stepFinish(),
      stepStart(),
      textEvent('PASS block in step 2'),
      stepFinish(),
    ].join('\n');
    expect(parseReviewStreamGrammar(stream)).toEqual({
      ok: true,
      verdictText: 'FAIL block in step 1\nPASS block in step 2',
    });
  });

  describe('hostile inputs', () => {
    it('handles a __proto__ key safely via readPlainRecord without prototype pollution', () => {
      const stream = [
        '{"__proto__":{"polluted":true},"type":"step_start"}',
        textEvent('clean'),
        stepFinish(),
      ].join('\n');
      expect(parseReviewStreamGrammar(stream)).toEqual({ ok: true, verdictText: 'clean' });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('accepts a constructor key on a step_start line without throwing or polluting', () => {
      const stream = [
        '{"constructor":{"polluted":true},"type":"step_start"}',
        textEvent('clean'),
        stepFinish(),
      ].join('\n');
      expect(parseReviewStreamGrammar(stream)).toEqual({ ok: true, verdictText: 'clean' });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('accepts a prototype key on a step_start line without polluting', () => {
      const stream = [
        '{"prototype":{"polluted":true},"type":"step_start"}',
        textEvent('clean'),
        stepFinish(),
      ].join('\n');
      expect(parseReviewStreamGrammar(stream)).toEqual({ ok: true, verdictText: 'clean' });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('refuses a line whose only type is nested under __proto__', () => {
      const nested = '{"__proto__":{"type":"step_start"}}';
      expect(parseReviewStreamGrammar(nested)).toEqual(refused);
      expect(parseReviewStreamGrammar([nested, textEvent('x'), stepFinish()].join('\n'))).toEqual(
        refused,
      );
      expect(
        parseReviewStreamGrammar([stepStart(), nested, stepFinish()].join('\n')),
      ).toEqual(refused);
    });

    it('refuses a non-plain part', () => {
      for (const badPart of ['[]', '"x"', 'null']) {
        const bad = [stepStart(), `{"type":"text","part":${badPart},"text":"x"}`, stepFinish()].join('\n');
        expect(parseReviewStreamGrammar(bad)).toEqual(refused);
      }
    });

    it('refuses a non-string object without invoking any member on it', () => {
      const calls: string[] = [];
      const trap = (name: string) => () => {
        calls.push(name);
        throw new Error('boom');
      };
      const hostile = {
        toString: trap('toString'),
        valueOf: trap('valueOf'),
        toJSON: trap('toJSON'),
        [Symbol.toPrimitive]: trap('toPrimitive'),
      };
      Object.defineProperty(hostile, 'length', {
        get: trap('length'),
        enumerable: true,
      });
      expect(parseReviewStreamGrammar(hostile)).toEqual(refused);
      expect(calls).toEqual([]);
    });

    it('refuses a Proxy wrapping a string without throwing', () => {
      const proxy = new Proxy(new String('step'), {
        get(target: object, prop: string | symbol) {
          if (prop === 'length' || prop === Symbol.iterator) {
            throw new Error('boom');
          }
          return Reflect.get(target, prop);
        },
      });
      expect(parseReviewStreamGrammar(proxy)).toEqual(refused);
    });

    it('refuses an array-like with a lying length as non-string', () => {
      expect(parseReviewStreamGrammar({ length: 2 ** 31 - 1, 0: 's' })).toEqual(refused);
    });

    it('refuses a sparse array with holes without throwing', () => {
      const holey: unknown[] = [];
      holey.length = 2;
      expect(1 in holey).toBe(false);
      expect(parseReviewStreamGrammar(holey)).toEqual(refused);
    });
  });
});
