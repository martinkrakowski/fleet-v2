/**
 * Pure domain scanner that refuses JSON text carrying duplicate object keys
 * (RV2). `JSON.parse` silently keeps the last value of a duplicate key, so a
 * reviewer reply like `{"verdict":"FAIL",...,"verdict":"PASS"}` could flip the
 * outcome. This module scans the exact text before `JSON.parse` sees it and
 * refuses any object — top-level or nested — that repeats a key.
 *
 * Pure domain: no I/O, no dependencies. It never throws; every refusal is a
 * typed result. Scanning is iterative (an explicit stack of container frames),
 * linear in the input length, and bounded by `MAX_JSON_SCAN_DEPTH`, so a
 * hostile input cannot recurse or hang.
 */

import { MAX_REVIEW_REPLY_LENGTH } from './review-answer-schema.js';

/** Deepest container nesting the scanner will walk before refusing. */
export const MAX_JSON_SCAN_DEPTH = 256;

/** Why `checkJsonDuplicateKeys` refused an input. */
export type JsonDuplicateKeyRefusal = 'duplicate-key' | 'invalid-json' | 'invalid-input';

/** Typed scan result: never a thrown error, always a reason. */
export type JsonDuplicateKeyCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: JsonDuplicateKeyRefusal };

interface ObjectFrame {
  readonly isObject: true;
  readonly keys: Set<string>;
}
interface ArrayFrame {
  readonly isObject: false;
  /** True once a complete element has been stored in this array. */
  hadValue: boolean;
}
type Frame = ObjectFrame | ArrayFrame;

type ScanState =
  | 'expect-root-value'
  | 'expect-key-or-close'
  | 'expect-key'
  | 'expect-colon'
  | 'expect-value'
  | 'expect-comma-or-close'
  | 'after-root-value';

const isWhitespace = (char: string): boolean => char === ' ' || char === '\t' || char === '\r' || char === '\n';

const isNumberStart = (char: string): boolean => char === '-' || (char >= '0' && char <= '9');

/** JSON number grammar: -?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)? — no leading zeros, no stray digits. */
const numberPattern = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/** Accept only exact JSON literals or a well-formed JSON number; reject truncated or malformed tokens. */
function isValidPrimitiveToken(token: string): boolean {
  if (token === 'true' || token === 'false' || token === 'null') {
    return true;
  }
  return numberPattern.test(token);
}

/**
 * Decode one JSON string body (without the surrounding quotes) the way
 * `JSON.parse` would, refusing what it refuses: a raw character below U+0020,
 * a truncated `\u` escape, an unknown escape (`\x`, `\a`, `\'`, `\0`, …) and a
 * trailing backslash all return `null`. Cost bound: one linear pass over
 * `body`.
 */
function decodeStringBody(body: string): string | null {
  let out = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== '\\') {
      // JSON.parse rejects raw characters below U+0020 inside strings.
      if (char.charCodeAt(0) < 0x20) {
        return null;
      }
      out += char;
      continue;
    }
    index += 1;
    const escape = body[index];
    if (escape === undefined) {
      return null;
    }
    if (escape === 'u') {
      const hex = body.slice(index + 1, index + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        return null;
      }
      out += String.fromCharCode(parseInt(hex, 16));
      index += 4;
      continue;
    }
    switch (escape) {
      case '"':
      case '\\':
      case '/':
        out += escape;
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      default:
        // `\x`, `\a`, `\'`, `\0`, … are not JSON escapes.
        return null;
    }
  }
  return out;
}

type Refusal = { readonly ok: false; readonly reason: JsonDuplicateKeyRefusal };

const INVALID_JSON: Refusal = { ok: false, reason: 'invalid-json' };
const INVALID_INPUT: Refusal = { ok: false, reason: 'invalid-input' };
const DUPLICATE_KEY: Refusal = { ok: false, reason: 'duplicate-key' };

/** Mutable scanner position shared by the step helpers. */
interface ScanContext {
  readonly text: string;
  readonly stack: Frame[];
  state: ScanState;
  index: number;
}

/** A step returns a refusal to stop the scan, or `null` to keep scanning. */
type StepResult = Refusal | null;

const isValueState = (state: ScanState): boolean => state === 'expect-root-value' || state === 'expect-value';

const isKeyState = (state: ScanState): boolean => state === 'expect-key' || state === 'expect-key-or-close';

const topOf = (stack: readonly Frame[]): Frame | undefined => stack[stack.length - 1];

/** Mark the innermost array (if any) as holding a complete element. */
function markArrayValue(stack: readonly Frame[]): void {
  const top = topOf(stack);
  if (top !== undefined && !top.isObject) {
    top.hadValue = true;
  }
}

/** State after a complete value or container close. */
const stateAfterValue = (stack: readonly Frame[]): ScanState =>
  stack.length === 0 ? 'after-root-value' : 'expect-comma-or-close';

const isTokenTerminator = (char: string): boolean =>
  char === '"' || char === '{' || char === '[' ||
  char === '}' || char === ']' || char === ':' || char === ',' ||
  isWhitespace(char);

/**
 * Escape-aware raw string scan, starting just after the opening quote:
 * `\"` stays inside the string, `\\"` closes it. Returns the raw body, or
 * `null` when the string never closes. Leaves `ctx.index` after the closing
 * quote (or at the end of input).
 */
function scanStringBody(ctx: ScanContext): string | null {
  const { text } = ctx;
  let body = '';
  while (ctx.index < text.length) {
    const stringChar = text[ctx.index];
    if (stringChar === '\\') {
      body += text.slice(ctx.index, ctx.index + 2);
      ctx.index += 2;
      continue;
    }
    if (stringChar === '"') {
      ctx.index += 1;
      return body;
    }
    body += stringChar;
    ctx.index += 1;
  }
  return null;
}

function acceptKey(ctx: ScanContext, body: string): StepResult {
  const top = topOf(ctx.stack);
  if (top === undefined || !top.isObject) {
    return INVALID_JSON;
  }
  const key = decodeStringBody(body);
  if (key === null) {
    return INVALID_JSON;
  }
  if (top.keys.has(key)) {
    return DUPLICATE_KEY;
  }
  top.keys.add(key);
  ctx.state = 'expect-colon';
  return null;
}

function acceptStringValue(ctx: ScanContext, body: string): StepResult {
  // String values are decoded too, so an invalid escape or a raw
  // control character inside a value is refused like JSON.parse would.
  if (decodeStringBody(body) === null) {
    return INVALID_JSON;
  }
  markArrayValue(ctx.stack);
  ctx.state = stateAfterValue(ctx.stack);
  return null;
}

function stepString(ctx: ScanContext): StepResult {
  ctx.index += 1;
  const body = scanStringBody(ctx);
  if (body === null) {
    return INVALID_JSON;
  }
  if (isKeyState(ctx.state)) {
    return acceptKey(ctx, body);
  }
  if (isValueState(ctx.state)) {
    return acceptStringValue(ctx, body);
  }
  return INVALID_JSON;
}

function stepOpen(ctx: ScanContext, char: string): StepResult {
  if (!isValueState(ctx.state)) {
    return INVALID_JSON;
  }
  if (ctx.stack.length >= MAX_JSON_SCAN_DEPTH) {
    return INVALID_INPUT;
  }
  if (char === '{') {
    ctx.stack.push({ isObject: true, keys: new Set<string>() });
    ctx.state = 'expect-key-or-close';
  } else {
    ctx.stack.push({ isObject: false, hadValue: false });
    ctx.state = 'expect-value';
  }
  ctx.index += 1;
  return null;
}

/** True when the close at `char` closes a container with no element or member. */
function closesEmptyContainer(char: string, state: ScanState, top: Frame): boolean {
  if (char === '}') {
    return state === 'expect-key-or-close';
  }
  return state === 'expect-value' && !top.isObject && top.hadValue === false;
}

function stepClose(ctx: ScanContext, char: string): StepResult {
  const top = topOf(ctx.stack);
  if (top === undefined) {
    return INVALID_JSON;
  }
  if (top.isObject !== (char === '}')) {
    return INVALID_JSON;
  }
  if (!closesEmptyContainer(char, ctx.state, top) && ctx.state !== 'expect-comma-or-close') {
    return INVALID_JSON;
  }
  ctx.stack.pop();
  ctx.state = stateAfterValue(ctx.stack);
  markArrayValue(ctx.stack);
  ctx.index += 1;
  return null;
}

function stepColon(ctx: ScanContext): StepResult {
  if (ctx.state !== 'expect-colon') {
    return INVALID_JSON;
  }
  ctx.state = 'expect-value';
  ctx.index += 1;
  return null;
}

function stepComma(ctx: ScanContext): StepResult {
  if (ctx.state !== 'expect-comma-or-close') {
    return INVALID_JSON;
  }
  const top = topOf(ctx.stack);
  if (top === undefined) {
    return INVALID_JSON;
  }
  ctx.state = top.isObject ? 'expect-key' : 'expect-value';
  ctx.index += 1;
  return null;
}

function stepPrimitive(ctx: ScanContext): StepResult {
  if (!isValueState(ctx.state)) {
    return INVALID_JSON;
  }
  const { text } = ctx;
  const tokenStart = ctx.index;
  while (ctx.index < text.length && !isTokenTerminator(text[ctx.index])) {
    ctx.index += 1;
  }
  if (!isValidPrimitiveToken(text.slice(tokenStart, ctx.index))) {
    return INVALID_JSON;
  }
  markArrayValue(ctx.stack);
  ctx.state = stateAfterValue(ctx.stack);
  return null;
}

/** Dispatch one non-whitespace character to its step. */
function stepChar(ctx: ScanContext, char: string): StepResult {
  switch (char) {
    case '"':
      return stepString(ctx);
    case '{':
    case '[':
      return stepOpen(ctx, char);
    case '}':
    case ']':
      return stepClose(ctx, char);
    case ':':
      return stepColon(ctx);
    case ',':
      return stepComma(ctx);
    default:
      if (isNumberStart(char) || char === 't' || char === 'f' || char === 'n') {
        return stepPrimitive(ctx);
      }
      return INVALID_JSON;
  }
}

function isValidMaxLength(maxLength: unknown): boolean {
  return typeof maxLength === 'number' && Number.isFinite(maxLength) && maxLength >= 0;
}

function scanText(text: string): JsonDuplicateKeyCheckResult {
  const ctx: ScanContext = { text, stack: [], state: 'expect-root-value', index: 0 };
  while (ctx.index < text.length) {
    const char = text[ctx.index];
    if (isWhitespace(char)) {
      ctx.index += 1;
      continue;
    }
    const refusal = stepChar(ctx, char);
    if (refusal !== null) {
      return refusal;
    }
  }
  if (ctx.stack.length !== 0 || ctx.state !== 'after-root-value') {
    return INVALID_JSON;
  }
  return { ok: true };
}

/**
 * Scan `text` and refuse duplicate object keys at any depth. Returns a typed
 * result and never throws: non-string input, an invalid `maxLength`, or input
 * over the length cap is `invalid-input`, malformed JSON (including invalid
 * escapes and raw control characters), or trailing tokens is `invalid-json`,
 * and a repeated key in any object is `duplicate-key`.
 */
export function checkJsonDuplicateKeys(
  text: unknown,
  maxLength: number = MAX_REVIEW_REPLY_LENGTH,
): JsonDuplicateKeyCheckResult {
  try {
    if (typeof text !== 'string' || !isValidMaxLength(maxLength) || text.length > maxLength) {
      return INVALID_INPUT;
    }
    return scanText(text);
  } catch {
    return INVALID_INPUT;
  }
}
