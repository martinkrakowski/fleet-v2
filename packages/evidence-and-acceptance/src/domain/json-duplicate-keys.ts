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

/** Decode one JSON string body (without the surrounding quotes) the way `JSON.parse` would. */
function decodeStringBody(body: string): string {
  let out = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== '\\') {
      out += char;
      continue;
    }
    index += 1;
    const escape = body[index];
    if (escape === undefined) {
      return out;
    }
    if (escape === 'u') {
      const hex = body.slice(index + 1, index + 5);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        index += 4;
      }
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
        out += escape;
        break;
    }
  }
  return out;
}

/**
 * Scan `text` and refuse duplicate object keys at any depth. Returns a typed
 * result and never throws: non-string or oversized input is `invalid-input`,
 * malformed JSON or trailing tokens is `invalid-json`, a repeated key in any
 * object is `duplicate-key`.
 */
export function checkJsonDuplicateKeys(text: unknown): JsonDuplicateKeyCheckResult {
  try {
    if (typeof text !== 'string' || text.length > MAX_REVIEW_REPLY_LENGTH) {
      return { ok: false, reason: 'invalid-input' };
    }
    const stack: Frame[] = [];
    let state: ScanState = 'expect-root-value';
    let index = 0;
    while (index < text.length) {
      const char = text[index];
      if (isWhitespace(char)) {
        index += 1;
        continue;
      }
      if (char === '"') {
        // Escape-aware string scan: `\"` stays inside the string, `\\"` closes it.
        index += 1;
        let body = '';
        let closed = false;
        while (index < text.length) {
          const stringChar = text[index];
          if (stringChar === '\\') {
            body += text.slice(index, index + 2);
            index += 2;
            continue;
          }
          if (stringChar === '"') {
            closed = true;
            index += 1;
            break;
          }
          body += stringChar;
          index += 1;
        }
        if (!closed) {
          return { ok: false, reason: 'invalid-json' };
        }
        if (state === 'expect-key' || state === 'expect-key-or-close') {
          const top = stack[stack.length - 1];
          if (top === undefined || !top.isObject) {
            return { ok: false, reason: 'invalid-json' };
          }
          const key = decodeStringBody(body);
          if (top.keys.has(key)) {
            return { ok: false, reason: 'duplicate-key' };
          }
          top.keys.add(key);
          state = 'expect-colon';
          continue;
        }
        if (state === 'expect-root-value' || state === 'expect-value') {
          const top = stack[stack.length - 1];
          if (top !== undefined && !top.isObject) {
            top.hadValue = true;
          }
          state = stack.length === 0 ? 'after-root-value' : 'expect-comma-or-close';
          continue;
        }
        return { ok: false, reason: 'invalid-json' };
      }
      if (char === '{') {
        if (state !== 'expect-root-value' && state !== 'expect-value') {
          return { ok: false, reason: 'invalid-json' };
        }
        if (stack.length >= MAX_JSON_SCAN_DEPTH) {
          return { ok: false, reason: 'invalid-input' };
        }
        stack.push({ isObject: true, keys: new Set<string>() });
        state = 'expect-key-or-close';
        index += 1;
        continue;
      }
      if (char === '[') {
        if (state !== 'expect-root-value' && state !== 'expect-value') {
          return { ok: false, reason: 'invalid-json' };
        }
        if (stack.length >= MAX_JSON_SCAN_DEPTH) {
          return { ok: false, reason: 'invalid-input' };
        }
        stack.push({ isObject: false, hadValue: false });
        state = 'expect-value';
        index += 1;
        continue;
      }
      if (char === '}' || char === ']') {
        const top = stack[stack.length - 1];
        if (top === undefined) {
          return { ok: false, reason: 'invalid-json' };
        }
        const closesOpen = (char === '}' && top.isObject) || (char === ']' && !top.isObject);
        if (!closesOpen) {
          return { ok: false, reason: 'invalid-json' };
        }
        const empty =
          (char === '}' && state === 'expect-key-or-close') ||
          (char === ']' && state === 'expect-value' && !(top.isObject) && top.hadValue === false);
        if (!empty && state !== 'expect-comma-or-close') {
          return { ok: false, reason: 'invalid-json' };
        }
        stack.pop();
        state = stack.length === 0 ? 'after-root-value' : 'expect-comma-or-close';
        const parent = stack[stack.length - 1];
        if (parent !== undefined && !parent.isObject) {
          parent.hadValue = true;
        }
        index += 1;
        continue;
      }
      if (char === ':') {
        if (state !== 'expect-colon') {
          return { ok: false, reason: 'invalid-json' };
        }
        state = 'expect-value';
        index += 1;
        continue;
      }
      if (char === ',') {
        if (state !== 'expect-comma-or-close') {
          return { ok: false, reason: 'invalid-json' };
        }
        const top = stack[stack.length - 1];
        if (top === undefined) {
          return { ok: false, reason: 'invalid-json' };
        }
        state = top.isObject ? 'expect-key' : 'expect-value';
        index += 1;
        continue;
      }
      if (isNumberStart(char) || char === 't' || char === 'f' || char === 'n') {
        if (state !== 'expect-root-value' && state !== 'expect-value') {
          return { ok: false, reason: 'invalid-json' };
        }
        const tokenStart = index;
        while (index < text.length) {
          const tokenChar = text[index];
          if (
            tokenChar === '"' || tokenChar === '{' || tokenChar === '[' ||
            tokenChar === '}' || tokenChar === ']' || tokenChar === ':' || tokenChar === ',' ||
            isWhitespace(tokenChar)
          ) {
            break;
          }
          index += 1;
        }
        const token = text.slice(tokenStart, index);
        if (!isValidPrimitiveToken(token)) {
          return { ok: false, reason: 'invalid-json' };
        }
        const tokenTop = stack[stack.length - 1];
        if (tokenTop !== undefined && !tokenTop.isObject) {
          tokenTop.hadValue = true;
        }
        state = stack.length === 0 ? 'after-root-value' : 'expect-comma-or-close';
        continue;
      }
      return { ok: false, reason: 'invalid-json' };
    }
    if (stack.length !== 0 || state !== 'after-root-value') {
      return { ok: false, reason: 'invalid-json' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'invalid-input' };
  }
}
