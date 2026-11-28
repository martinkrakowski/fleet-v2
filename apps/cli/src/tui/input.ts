/**
 * The TUI input state machine for the Questions and Permissions screens.
 * Pure: no React, no Ink, no I/O. A key press moves the state; the only way a
 * write is requested is the `y` key in the `confirming` mode, which returns a
 * `submit` effect for the caller to perform. One-way questions never reach a
 * confirmation. Server text is stripped of control characters before it is
 * rendered, so a hostile question cannot drive the terminal.
 */
import {
  MAX_INPUT_TEXT_CHARS,
  type TuiAnswerInput,
  type TuiPermissionRequest,
  type TuiQuestion,
  type TuiVerdictDecision,
} from './api.js';

export const ONE_WAY_STATUS = 'one-way questions require a signed owner decision';

export type TuiInputScreen = 'questions' | 'permissions';
export type TuiInputMode = 'list' | 'detail' | 'options' | 'text' | 'confirming';

export interface TuiKey {
  readonly input: string;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
}

interface PendingAnswer {
  readonly kind: 'answer';
  readonly shape: 'accept' | 'reject' | 'answer';
  readonly optionId: string | null;
}

interface PendingVerdict {
  readonly kind: 'verdict';
  readonly decision: TuiVerdictDecision;
}

export interface TuiInputState {
  readonly screen: TuiInputScreen;
  readonly questions: readonly TuiQuestion[];
  readonly permissions: readonly TuiPermissionRequest[];
  readonly cursor: number;
  readonly optionCursor: number;
  readonly mode: TuiInputMode;
  readonly pending: PendingAnswer | PendingVerdict | null;
  readonly buffer: string;
  readonly status: string | null;
}

export type TuiInputEffect =
  | { readonly kind: 'answer'; readonly input: TuiAnswerInput }
  | { readonly kind: 'verdict'; readonly requestId: string; readonly decision: TuiVerdictDecision };

export interface TuiInputStep {
  readonly state: TuiInputState;
  readonly effect: TuiInputEffect | null;
}

export function initialInputState(
  screen: TuiInputScreen,
  items: { readonly questions?: readonly TuiQuestion[]; readonly permissions?: readonly TuiPermissionRequest[] },
  status: string | null = null,
): TuiInputState {
  return {
    screen,
    questions: items.questions ?? [],
    permissions: items.permissions ?? [],
    cursor: 0,
    optionCursor: 0,
    mode: 'list',
    pending: null,
    buffer: '',
    status,
  };
}

/** True while typing or confirming, so the shell's n/p/r/q must not fire; elsewhere they still work. */
export function capturesKeys(state: TuiInputState): boolean {
  return state.mode === 'text' || state.mode === 'confirming';
}

/** Replaces every control character (including escape sequences) with a space. */
export function printable(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : char;
  }
  return out;
}

const itemCount = (state: TuiInputState): number =>
  state.screen === 'questions' ? state.questions.length : state.permissions.length;

const step = (state: TuiInputState, effect: TuiInputEffect | null = null): TuiInputStep => ({ state, effect });

function selectedQuestion(state: TuiInputState): TuiQuestion | null {
  return state.screen === 'questions' ? (state.questions[state.cursor] ?? null) : null;
}

function isUp(key: TuiKey): boolean {
  return key.upArrow === true || key.input === 'k';
}

function isDown(key: TuiKey): boolean {
  return key.downArrow === true || key.input === 'j';
}

function isCancel(key: TuiKey): boolean {
  return key.escape === true || key.input === 'n';
}

function move(state: TuiInputState, key: TuiKey): TuiInputState {
  const count = itemCount(state);
  if (count === 0) {
    return state;
  }
  if (isUp(key)) {
    return { ...state, cursor: (state.cursor - 1 + count) % count };
  }
  return { ...state, cursor: (state.cursor + 1) % count };
}

function toConfirming(state: TuiInputState, pending: PendingAnswer | PendingVerdict): TuiInputState {
  return { ...state, mode: 'confirming', pending, status: null };
}

function reduceList(state: TuiInputState, key: TuiKey): TuiInputStep {
  if (isUp(key) || isDown(key)) {
    return step(move(state, key));
  }
  if (key.return === true) {
    if (itemCount(state) === 0) {
      return step({ ...state, status: 'nothing to open' });
    }
    return step({ ...state, mode: 'detail', status: null });
  }
  return step(state);
}

function reduceQuestionDetail(state: TuiInputState, key: TuiKey): TuiInputStep {
  const question = selectedQuestion(state);
  if (question === null || key.escape === true) {
    return step({ ...state, mode: 'list', pending: null, buffer: '', status: null });
  }
  const answering = key.input === 'a' || key.input === 'x' || key.input === 'o';
  if (answering && question.doorKind === 'one-way') {
    return step({ ...state, status: ONE_WAY_STATUS });
  }
  if (key.input === 'a') {
    return step(toConfirming(state, { kind: 'answer', shape: 'accept', optionId: null }));
  }
  if (key.input === 'x') {
    return step({ ...state, mode: 'text', buffer: '', pending: { kind: 'answer', shape: 'reject', optionId: null }, status: null });
  }
  if (key.input === 'o') {
    if (question.options.length === 0) {
      return step({ ...state, status: 'this question has no options' });
    }
    return step({ ...state, mode: 'options', optionCursor: 0, status: null });
  }
  return step(state);
}

function reduceOptions(state: TuiInputState, key: TuiKey): TuiInputStep {
  const question = selectedQuestion(state);
  if (question === null || key.escape === true) {
    return step({ ...state, mode: 'detail', status: null });
  }
  const count = question.options.length;
  if (isUp(key) && count > 0) {
    return step({ ...state, optionCursor: (state.optionCursor - 1 + count) % count });
  }
  if (isDown(key) && count > 0) {
    return step({ ...state, optionCursor: (state.optionCursor + 1) % count });
  }
  if (key.return === true) {
    const option = question.options[state.optionCursor];
    if (option === undefined) {
      return step(state);
    }
    return step({ ...state, mode: 'text', buffer: '', pending: { kind: 'answer', shape: 'answer', optionId: option.id }, status: null });
  }
  return step(state);
}

function reduceText(state: TuiInputState, key: TuiKey): TuiInputStep {
  if (state.pending === null || state.pending.kind !== 'answer' || key.escape === true) {
    return step({ ...state, mode: 'detail', pending: null, buffer: '', status: 'cancelled: nothing was sent' });
  }
  if (key.return === true) {
    return step(toConfirming(state, state.pending));
  }
  if (key.backspace === true || key.delete === true) {
    return step({ ...state, buffer: state.buffer.slice(0, -1) });
  }
  const typed = printable(key.input);
  if (typed.length === 0 || key.input.length === 0) {
    return step(state);
  }
  if (state.buffer.length + typed.length > MAX_INPUT_TEXT_CHARS) {
    return step({ ...state, status: `text is capped at ${MAX_INPUT_TEXT_CHARS} characters` });
  }
  return step({ ...state, buffer: state.buffer + typed, status: null });
}

function answerEffect(state: TuiInputState, pending: PendingAnswer): TuiInputEffect | null {
  const question = selectedQuestion(state);
  if (question === null || question.doorKind === 'one-way') {
    return null;
  }
  const text = state.buffer.length > 0 ? state.buffer : undefined;
  const input: TuiAnswerInput =
    pending.shape === 'accept'
      ? { questionId: question.questionId, questionRevision: question.revision, shape: 'accept' }
      : pending.shape === 'reject'
        ? { questionId: question.questionId, questionRevision: question.revision, shape: 'reject', ...(text === undefined ? {} : { reason: text }) }
        : {
            questionId: question.questionId,
            questionRevision: question.revision,
            shape: 'answer',
            ...(pending.optionId === null ? {} : { optionId: pending.optionId }),
            ...(text === undefined ? {} : { text }),
          };
  return { kind: 'answer', input };
}

function reduceConfirming(state: TuiInputState, key: TuiKey): TuiInputStep {
  if (isCancel(key)) {
    return step({ ...state, mode: 'detail', pending: null, buffer: '', status: 'cancelled: nothing was sent' });
  }
  if (key.input !== 'y') {
    return step(state);
  }
  const pending = state.pending;
  const cleared: TuiInputState = { ...state, mode: 'list', pending: null, buffer: '', status: 'sending...' };
  if (pending === null) {
    return step({ ...cleared, status: 'nothing to send' });
  }
  if (pending.kind === 'answer') {
    const effect = answerEffect(state, pending);
    return effect === null ? step({ ...cleared, status: ONE_WAY_STATUS }) : step(cleared, effect);
  }
  const request = state.permissions[state.cursor];
  return request === undefined
    ? step({ ...cleared, status: 'nothing to send' })
    : step(cleared, { kind: 'verdict', requestId: request.requestId, decision: pending.decision });
}

function reducePermissionDetail(state: TuiInputState, key: TuiKey): TuiInputStep {
  if (key.escape === true || state.permissions[state.cursor] === undefined) {
    return step({ ...state, mode: 'list', pending: null, status: null });
  }
  if (key.input === 'a') {
    return step(toConfirming(state, { kind: 'verdict', decision: 'allow' }));
  }
  if (key.input === 'd') {
    return step(toConfirming(state, { kind: 'verdict', decision: 'deny' }));
  }
  return step(state);
}

/** One key press: the next state and, only after an explicit `y`, the write to perform. */
export function reduceInput(state: TuiInputState, key: TuiKey): TuiInputStep {
  switch (state.mode) {
    case 'list':
      return reduceList(state, key);
    case 'detail':
      return state.screen === 'questions' ? reduceQuestionDetail(state, key) : reducePermissionDetail(state, key);
    case 'options':
      return reduceOptions(state, key);
    case 'text':
      return reduceText(state, key);
    case 'confirming':
      return reduceConfirming(state, key);
    default:
      return step(state);
  }
}

/** The screen's own lines for the shell frame. */
export function renderInputLines(state: TuiInputState): readonly string[] {
  const lines: string[] = [];
  if (state.screen === 'questions') {
    renderQuestions(state, lines);
  } else {
    renderPermissions(state, lines);
  }
  if (state.mode === 'confirming' && state.pending !== null) {
    lines.push('', ...confirmLines(state));
  }
  if (state.status !== null) {
    lines.push('', printable(state.status));
  }
  return lines;
}

function renderQuestions(state: TuiInputState, lines: string[]): void {
  if (state.questions.length === 0) {
    lines.push('no open questions');
    return;
  }
  state.questions.forEach((question, index) => {
    const marker = index === state.cursor ? '>' : ' ';
    const door = question.doorKind === 'one-way' ? ' [one-way, read-only]' : '';
    lines.push(`${marker} ${printable(question.questionId)}  ${printable(question.title)}${door}`);
  });
  const question = selectedQuestion(state);
  if (question === null || state.mode === 'list') {
    return;
  }
  lines.push('', printable(question.body));
  question.options.forEach((option, index) => {
    const marker = state.mode === 'options' && index === state.optionCursor ? '>' : ' ';
    const recommended = option.id === question.recommendationOptionId ? ' (recommended)' : '';
    lines.push(`${marker} ${printable(option.id)}: ${printable(option.label)}${recommended} - ${printable(option.consequence)}`);
  });
  lines.push(`recommendation: ${printable(question.recommendationOptionId)} because ${printable(question.recommendationBecause)}`);
  if (state.mode === 'text') {
    lines.push(`type your ${state.pending?.kind === 'answer' && state.pending.shape === 'reject' ? 'reason' : 'text'} (optional), Enter to continue, Esc to cancel: ${state.buffer}`);
  }
  if (state.mode === 'detail') {
    lines.push(
      question.doorKind === 'one-way'
        ? ONE_WAY_STATUS
        : 'a accept recommendation   x reject   o choose an option   Esc back',
    );
  }
}

function renderPermissions(state: TuiInputState, lines: string[]): void {
  if (state.permissions.length === 0) {
    lines.push('no pending permission requests');
    return;
  }
  state.permissions.forEach((request, index) => {
    const marker = index === state.cursor ? '>' : ' ';
    lines.push(`${marker} ${printable(request.requestId)}  ${printable(request.toolCode)}  until ${printable(request.deadlineAt)}`);
  });
  if (state.mode === 'detail') {
    lines.push('', 'a allow   d deny   Esc back');
  }
}

function confirmLines(state: TuiInputState): readonly string[] {
  const pending = state.pending;
  if (pending === null) {
    return [];
  }
  if (pending.kind === 'answer') {
    const question = selectedQuestion(state);
    const id = question === null ? '<id>' : printable(question.questionId);
    const what = pending.shape === 'accept' ? 'accept the recommendation' : pending.shape === 'reject' ? 'reject' : `answer with option ${pending.optionId ?? 'none'}`;
    return [
      `Confirm: ${what}. Does: POST /v1/questions/${id}/answers.`,
      'Does not: grant forge, merge or dispatch authority; one-way questions require a signed owner decision.',
      'y confirm   n or Esc cancel',
    ];
  }
  const request = state.permissions[state.cursor];
  const id = request === undefined ? '<requestId>' : printable(request.requestId);
  return [
    `Confirm: ${pending.decision} tool request ${id}. Does: POST /v1/threads/:id/permissions/${id}/verdict.`,
    'Does not: grant forge, merge or dispatch authority.',
    'y confirm   n or Esc cancel',
  ];
}
