// Local ESLint rule: keeps `@fleet/web` copy neutral by refusing any configured
// forbidden word in string literals, template literals, JSX text and comments.
//
// The forbidden words are operator-local data: `FLEET_WEB_FORBIDDEN_NAMES`
// (comma-separated) or, when that is unset, the ignored file
// `apps/web/.forbidden-names` (one name per line). Neither source is present in
// a clean checkout, in which case the rule is a no-op. Matched words are never
// echoed into a report.
import { readFileSync, statSync } from 'node:fs';
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
  if (snapshotResult === null
    || typeof snapshotResult !== 'object'
    || typeof snapshotResult.ok !== 'boolean') {
    return refuse('invalid-outcome');
  }
  if (!snapshotResult.ok) {
    return typeof snapshotResult.reason === 'string'
      ? refuse(snapshotResult.reason)
      : refuse('invalid-outcome');
  }
  if (!('value' in snapshotResult)) {
    return refuse('invalid-outcome');
  }
  const snapshotValue = snapshotResult.value;
  let isArray;
  try {
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
  for (const raw of text.split(separator)) {
    const name = raw.trim().toLowerCase();
    if (name !== '' && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

function readNamesFile(filePath) {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) {
      return [];
    }
    return parseNames(readFileSync(filePath, 'utf8'), /\r?\n/);
  } catch {
    return [];
  }
}

/**
 * Loads the configured forbidden words (lower-cased): `env` (default
 * `process.env.FLEET_WEB_FORBIDDEN_NAMES`, comma-separated) wins; when it is
 * unset the file at `filePath` (default `apps/web/.forbidden-names`, one name
 * per line) is read. Invalid options, a missing/unreadable file or blank
 * entries yield `[]` (the rule is then a no-op); nothing is ever thrown.
 *
 * Cost: O(own keys) for the option read, O(1) env/stat check, O(n) bounded
 * (64 KiB) entry parsing.
 *
 * @param {unknown} [options]
 * @param {(value: unknown, isProxy: (value: unknown) => boolean) => unknown} [snapshot]
 * @returns {string[]}
 */
export function loadForbiddenNames(options, snapshot = snapshotPlainData) {
  const parsed = readForbiddenNameOptions(options, snapshot);
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.ok !== 'boolean' || !parsed.ok) {
    return [];
  }
  const env = parsed.value.env === undefined
    ? process.env.FLEET_WEB_FORBIDDEN_NAMES
    : parsed.value.env;
  if (typeof env === 'string') {
    return parseNames(env, ',');
  }
  const filePath = parsed.value.filePath === undefined
    ? new URL('../.forbidden-names', import.meta.url)
    : parsed.value.filePath;
  return readNamesFile(filePath);
}

export const noWorkingName = {
  meta: {
    type: 'problem',
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
