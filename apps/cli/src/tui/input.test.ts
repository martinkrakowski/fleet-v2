import { describe, expect, it } from 'vitest';

import { MAX_INPUT_TEXT_CHARS, type TuiPermissionRequest, type TuiQuestion } from './api.js';
import {
  ONE_WAY_STATUS,
  capturesKeys,
  initialInputState,
  printable,
  reduceInput,
  renderInputLines,
  type TuiInputState,
  type TuiKey,
} from './input.js';

const q = (over: Partial<TuiQuestion> = {}): TuiQuestion => ({
  questionId: 'q-1',
  revision: 4,
  title: 'Pick one',
  body: 'Body',
  options: [
    { id: 'o-1', label: 'One', consequence: 'c1' },
    { id: 'o-2', label: 'Two', consequence: 'c2' },
  ],
  recommendationOptionId: 'o-1',
  recommendationBecause: 'simplest',
  doorKind: 'two-way',
  ...over,
});
const perm: TuiPermissionRequest = { requestId: 'r-1', toolCode: 'edit', deadlineAt: '2026-11-03T10:30:00.000Z' };

function press(state: TuiInputState, ...keys: Array<string | TuiKey>) {
  let current = state;
  let effect = null as ReturnType<typeof reduceInput>['effect'];
  for (const key of keys) {
    const step = reduceInput(current, typeof key === 'string' ? { input: key } : key);
    current = step.state;
    effect = step.effect;
  }
  return { state: current, effect };
}
const ENTER: TuiKey = { input: '', return: true };
const ESC: TuiKey = { input: '', escape: true };

describe('questions screen', () => {
  const start = () => initialInputState('questions', { questions: [q(), q({ questionId: 'q-2' })] });

  it('moves with j/k and arrows and opens detail with Enter', () => {
    const moved = press(start(), 'j', { input: '', downArrow: true }, 'k');
    expect(moved.state.cursor).toBe(1);
    expect(press(start(), ENTER).state.mode).toBe('detail');
    expect(capturesKeys(press(start(), ENTER).state)).toBe(false);
    expect(capturesKeys(press(start(), ENTER, 'x').state)).toBe(true);
    expect(capturesKeys(press(start(), ENTER, 'a').state)).toBe(true);
    expect(capturesKeys(start())).toBe(false);
  });

  it('accept goes to confirming and sends nothing until y', () => {
    const confirming = press(start(), ENTER, 'a');
    expect(confirming.state.mode).toBe('confirming');
    expect(confirming.effect).toBeNull();
    expect(renderInputLines(confirming.state).join('\n')).toContain('POST /v1/questions/q-1/answers');
    expect(renderInputLines(confirming.state).join('\n')).toContain('Does not: grant forge, merge or dispatch authority');
    const sent = press(confirming.state, 'y');
    expect(sent.effect).toEqual({ kind: 'answer', input: { questionId: 'q-1', questionRevision: 4, shape: 'accept' } });
  });

  it('choosing an option collects optional text, then needs y', () => {
    const typed = press(start(), ENTER, 'o', 'j', ENTER, 'h', 'i', { input: '', backspace: true }, 'e', ENTER);
    expect(typed.state.mode).toBe('confirming');
    expect(typed.effect).toBeNull();
    expect(press(typed.state, 'y').effect).toEqual({
      kind: 'answer',
      input: { questionId: 'q-1', questionRevision: 4, shape: 'answer', optionId: 'o-2', text: 'he' },
    });
  });

  it('reject carries the typed reason', () => {
    const rejected = press(start(), ENTER, 'x', 'n', 'o', ENTER, 'y');
    expect(rejected.effect).toEqual({ kind: 'answer', input: { questionId: 'q-1', questionRevision: 4, shape: 'reject', reason: 'no' } });
  });

  it('typed n, q and r in text mode are text, never navigation or cancel', () => {
    const typed = press(start(), ENTER, 'x', 'n', 'q', 'r');
    expect(typed.state.mode).toBe('text');
    expect(typed.state.buffer).toBe('nqr');
  });

  it('cancels from confirming with n or Esc and sends nothing', () => {
    for (const key of ['n', ESC] as const) {
      const cancelled = press(start(), ENTER, 'a', key);
      expect(cancelled.effect).toBeNull();
      expect(cancelled.state.pending).toBeNull();
      expect(cancelled.state.status).toContain('nothing was sent');
    }
    expect(press(start(), ENTER, 'a', 'z').state.mode).toBe('confirming');
  });

  it('refuses answering a one-way question', () => {
    const oneWay = initialInputState('questions', { questions: [q({ doorKind: 'one-way' })] });
    for (const key of ['a', 'x', 'o']) {
      const refused = press(oneWay, ENTER, key);
      expect(refused.state.mode).toBe('detail');
      expect(refused.state.status).toBe(ONE_WAY_STATUS);
      expect(refused.effect).toBeNull();
    }
    expect(renderInputLines(press(oneWay, ENTER).state).join('\n')).toContain('[one-way, read-only]');
  });

  it('a one-way question can never produce a write even from a forced confirming state', () => {
    const forced: TuiInputState = {
      ...initialInputState('questions', { questions: [q({ doorKind: 'one-way' })] }),
      mode: 'confirming',
      pending: { kind: 'answer', shape: 'accept', optionId: null },
    };
    const sent = press(forced, 'y');
    expect(sent.effect).toBeNull();
    expect(sent.state.status).toBe(ONE_WAY_STATUS);
  });

  it('caps input buffer at MAX_INPUT_TEXT_CHARS', () => {
    let state = press(start(), ENTER, 'x').state;
    for (let i = 0; i < MAX_INPUT_TEXT_CHARS + 20; i += 1) {
      state = reduceInput(state, { input: 'a' }).state;
    }
    expect(state.buffer.length).toBe(MAX_INPUT_TEXT_CHARS);
    expect(state.status).toContain('capped');
  });

  it('strips control and escape characters from typed and rendered text', () => {
    expect(printable('a\u001b[31mb\u0007')).toBe('a [31mb ');
    const hostile = initialInputState('questions', { questions: [q({ title: 'x\u001b[2Jy' })] });
    expect(renderInputLines(hostile).join('\n')).not.toContain('\u001b');
    const typed = press(start(), ENTER, 'x', '\u001b[31m');
    expect(typed.state.buffer).not.toContain('\u001b');
  });

  it('shows empty lists and nothing to open without inventing rows', () => {
    const empty = initialInputState('questions', { questions: [] });
    expect(renderInputLines(empty)).toEqual(['no open questions']);
    expect(press(empty, ENTER).state.mode).toBe('list');
  });
});

describe('permissions screen', () => {
  const start = () => initialInputState('permissions', { permissions: [perm] });

  it('allow and deny each need y', () => {
    const allow = press(start(), ENTER, 'a');
    expect(allow.effect).toBeNull();
    expect(renderInputLines(allow.state).join('\n')).toContain('POST /v1/threads/:id/permissions/r-1/verdict');
    expect(press(allow.state, 'y').effect).toEqual({ kind: 'verdict', requestId: 'r-1', decision: 'allow' });
    expect(press(start(), ENTER, 'd', 'y').effect).toEqual({ kind: 'verdict', requestId: 'r-1', decision: 'deny' });
  });

  it('cancels with Esc and sends nothing', () => {
    const cancelled = press(start(), ENTER, 'd', ESC);
    expect(cancelled.effect).toBeNull();
    expect(cancelled.state.pending).toBeNull();
  });
});
