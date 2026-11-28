// Local ESLint rule: keeps `@fleet/web` copy neutral by refusing any configured
// forbidden word in string literals, template literals, JSX text and comments.
//
// The forbidden words are operator-local data: `FLEET_WEB_FORBIDDEN_NAMES`
// (comma-separated) or, when that is unset, the ignored file
// `apps/web/.forbidden-names` (one name per line). Neither source is present in
// a clean checkout, in which case the rule is a no-op. Matched words are never
// echoed into a report.
import { Buffer } from 'node:buffer';
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { types } from 'node:util';
import { snapshotPlainData } from '@fleet/shared';

const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];
const OPTION_KEYS = ['env', 'filePath'];
const MAX_FILE_BYTES = 65_536;

function refuse(reason) {
  return { ok: false, reason };
}

/**
 * Validates the optional `{ env?: string, filePath?: string }` options of
 * `loadForbiddenNames`. The untrusted `options` value is handed to `snapshot`
 * (default `snapshotPlainData`) before any destructuring, property read or
 * `Array.isArray`, then the snapshot outcome itself is validated.
 *
 * Cost: O(1) for the undefined/snapshot/outcome checks, O(own keys) (bounded by
 * the snapshot limits, maxKeys = 128) for the one key enumeration.
 *
 * @param {unknown} options
 * @param {(value: unknown, isProxy: (value: unknown) => boolean) => unknown} [snapshot]
 * @returns {{ ok: true, value: { env?: string, filePath?: string } } | { ok: false, reason: string }}
 */
export function readForbiddenNameOptions(options, snapshot = snapshotPlainData) {
  if (options === undefined) {
    return { ok: true, value: {} };
  }
  if (typeof snapshot !== 'function') {
    return refuse('invalid-outcome');
  }
  let snapshotResult;
  try {
    snapshotResult = snapshot(options, types.isProxy);
  } catch {
    return refuse('invalid-outcome');
  }
  try {
    return validateSnapshotOutcome(snapshotResult);
  } catch {
    return refuse('invalid-outcome');
  }
}

// Reads one own data property of the outcome without ever invoking a getter.
function readOwnData(target, key) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined || !('value' in descriptor)) {
    return { present: false, value: undefined };
  }
  return { present: true, value: descriptor.value };
}

// May throw on hostile input; the caller turns any throw into a refusal.
function validateSnapshotOutcome(snapshotResult) {
  if (snapshotResult === null
    || typeof snapshotResult !== 'object'
    || types.isProxy(snapshotResult)) {
    return refuse('invalid-outcome');
  }
  const okRead = readOwnData(snapshotResult, 'ok');
  if (!okRead.present || typeof okRead.value !== 'boolean') {
    return refuse('invalid-outcome');
  }
  if (!okRead.value) {
    const reasonRead = readOwnData(snapshotResult, 'reason');
    return reasonRead.present && typeof reasonRead.value === 'string'
      ? refuse(reasonRead.value)
      : refuse('invalid-outcome');
  }
  const valueRead = readOwnData(snapshotResult, 'value');
  if (!valueRead.present) {
    return refuse('invalid-outcome');
  }
  const snapshotValue = valueRead.value;
  let isArray;
  try {
    if (types.isProxy(snapshotValue)) {
      return refuse('proxy');
    }
    isArray = Array.isArray(snapshotValue);
  } catch {
    return refuse('not-plain');
  }
  if (snapshotValue === null || typeof snapshotValue !== 'object' || isArray) {
    return refuse('not-plain');
  }
  for (const key of Reflect.ownKeys(snapshotValue)) {
    if (RESERVED_KEYS.includes(key)) {
      return refuse('reserved-key');
    }
    if (typeof key !== 'string' || !OPTION_KEYS.includes(key)) {
      return refuse('unknown-key');
    }
  }
  const read = {};
  for (const key of OPTION_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(snapshotValue, key);
    if (descriptor === undefined) {
      continue;
    }
    if (typeof descriptor.value !== 'string') {
      return refuse('invalid-option-type');
    }
    read[key] = descriptor.value;
  }
  return { ok: true, value: { env: read.env, filePath: read.filePath } };
}

function parseNames(text, separator) {
  const names = [];
  const seen = new Set();
  for (const raw of text.split(separator)) {
    const name = raw.trim().toLowerCase();
    if (name !== '' && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function readNamesFile(filePath) {
  let fd;
  try {
    // A FIFO or device is refused by path before it is opened (an open would block on
    // a FIFO), and again on the descriptor; O_NONBLOCK keeps the open itself from waiting.
    if (!statSync(filePath).isFile()) {
      return [];
    }
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) {
      return [];
    }
    // Read at most one byte past the bound from the opened descriptor, so a file
    // that grows between a size check and the read can never be read whole.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = readSync(fd, buffer, total, buffer.length - total, null);
      if (read === 0) {
        break;
      }
      total += read;
    }
    if (total > MAX_FILE_BYTES) {
      return [];
    }
    return parseNames(buffer.toString('utf8', 0, total), /\r?\n/);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // nothing to do: the descriptor is gone either way
      }
    }
  }
}

/**
 * Loads the configured forbidden words (lower-cased): `env` (default
 * `process.env.FLEET_WEB_FORBIDDEN_NAMES`, comma-separated) wins; when it is
 * unset the file at `filePath` (default `apps/web/.forbidden-names`, one name
 * per line) is read. Invalid options, a missing/unreadable file or blank
 * entries yield `[]` (the rule is then a no-op); nothing is ever thrown.
 *
 * The env string and the file are both bounded to 64 KiB (`MAX_FILE_BYTES`);
 * an oversized one yields `[]`.
 *
 * Cost: O(own keys) for the option read, O(1) env/stat check, O(n) bounded
 * (64 KiB) entry parsing.
 *
 * @param {unknown} [options]
 * @param {(value: unknown, isProxy: (value: unknown) => boolean) => unknown} [snapshot]
 * @returns {string[]}
 */
export function loadForbiddenNames(options, snapshot = snapshotPlainData) {
  try {
    const parsed = readForbiddenNameOptions(options, snapshot);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.ok !== 'boolean' || !parsed.ok) {
      return [];
    }
    // `env` is validated to be a string when present, so `??` only substitutes for an absent option.
    const env = parsed.value.env ?? process.env.FLEET_WEB_FORBIDDEN_NAMES;
    if (typeof env === 'string') {
      // The same bound as an oversized file: refuse rather than parse.
      return Buffer.byteLength(env, 'utf8') > MAX_FILE_BYTES ? [] : parseNames(env, ',');
    }
    const filePath = parsed.value.filePath === undefined
      ? new URL('../.forbidden-names', import.meta.url)
      : parsed.value.filePath;
    return readNamesFile(filePath);
  } catch {
    return [];
  }
}

export const noWorkingName = {
  meta: {
    type: 'problem',
    // No options: the forbidden names come only from the operator's environment or ignored file.
    schema: [],
    messages: {
      forbiddenWorkingName: 'Keep copy neutral: this text contains a configured forbidden name.',
    },
  },
  create(context) {
    const names = loadForbiddenNames();
    if (names.length === 0) {
      return {};
    }
    const containsForbidden = (text) => {
      if (typeof text !== 'string') {
        return false;
      }
      const lower = text.toLowerCase();
      return names.some((name) => lower.includes(name));
    };
    const reportNode = (node) => context.report({ node, messageId: 'forbiddenWorkingName' });
    return {
      Literal(node) {
        if (typeof node.value === 'string' && containsForbidden(node.value)) {
          reportNode(node);
        }
      },
      TemplateElement(node) {
        if (containsForbidden(node.value.raw) || containsForbidden(node.value.cooked)) {
          reportNode(node);
        }
      },
      JSXText(node) {
        if (containsForbidden(node.value)) {
          reportNode(node);
        }
      },
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (containsForbidden(comment.value)) {
            context.report({ loc: comment.loc, messageId: 'forbiddenWorkingName' });
          }
        }
      },
    };
  },
};

export default {
  rules: { 'no-working-name': noWorkingName },
};
