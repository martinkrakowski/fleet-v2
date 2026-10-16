// Decision kernel (lane K1): the caller-declared decision state builder.
// Pure: no I/O, no dependencies, no `node:` imports — the SHA-256 is
// computed by an injected hasher.
//
// Every string the caller declares is checked with `containsSecretShape`;
// byte lengths are taken with TextEncoder against the per-field and total
// caps. A secret hit or an overflow refuses the whole state — it never
// redacts.

import { containsSecretShape } from '../secret-patterns.js';

export interface DecisionStateCaps {
  /** Maximum UTF-8 byte length of a single field's value(s). */
  readonly perFieldBytes: number;
  /** Maximum UTF-8 byte length of all fields combined. */
  readonly totalBytes: number;
}

export interface DecisionStateOk {
  readonly ok: true;
  /** The serialized state JSON, exactly as hashed. */
  readonly stateJson: string;
  /** hash(stateJson) as computed by the injected hasher. */
  readonly stateSha256: string;
}

export interface DecisionStateRefused {
  readonly ok: false;
  readonly reason: 'redaction-refused';
}

export type DecisionState = DecisionStateOk | DecisionStateRefused;

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Build the decision state from caller-declared named fields only. Every
 * string is secret-scanned and byte-measured; a hit or an overflow refuses
 * with `{ok:false, reason:'redaction-refused'}` and never redacts.
 */
export function buildDecisionState(
  fields: Readonly<Record<string, string | readonly string[]>>,
  caps: DecisionStateCaps,
  hash: (state: string) => string,
): DecisionState {
  let total = 0;
  for (const value of Object.values(fields)) {
    let fieldBytes = 0;
    if (typeof value === 'string') {
      if (containsSecretShape(value)) {
        return { ok: false, reason: 'redaction-refused' };
      }
      fieldBytes += utf8Bytes(value);
    } else {
      for (const item of value) {
        if (containsSecretShape(item)) {
          return { ok: false, reason: 'redaction-refused' };
        }
        fieldBytes += utf8Bytes(item);
      }
    }
    if (fieldBytes > caps.perFieldBytes) {
      return { ok: false, reason: 'redaction-refused' };
    }
    total += fieldBytes;
  }
  if (total > caps.totalBytes) {
    return { ok: false, reason: 'redaction-refused' };
  }
  const stateJson = JSON.stringify(fields);
  return { ok: true, stateJson, stateSha256: hash(stateJson) };
}
