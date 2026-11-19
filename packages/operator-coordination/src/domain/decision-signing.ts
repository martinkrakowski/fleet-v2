/**
 * Owner decision signing inputs (KEY1a).
 *
 * Pure domain validation for the `coordination sign-decision` boundary: the
 * raw CLI input and the stored `CoordinationRequestRecord` are both read as
 * hostile `unknown` data through their own data-property descriptors only —
 * a getter never runs, a Proxy `get` trap is never invoked, arrays (including
 * sparse, array-like and enormous ones) are refused before any indexing, and
 * a `__proto__`/`constructor`/`prototype` own key is refused before any field
 * comparison. Neither function ever throws: every refusal is a typed result
 * carrying a named error code.
 *
 * Cost bound: every exported function is linear in the capped input — at most
 * `MAX_SIGN_DECISION_KEYS` (or `MAX_SIGN_DECISION_RECORD_KEYS`) own
 * descriptors plus at most the named length cap characters per inspected
 * field; nothing else is read.
 */

import { readPlainObjectWithOptional } from './record-input.js';

/** The most own keys one sign-decision raw input may carry. */
export const MAX_SIGN_DECISION_KEYS = 8 as const;

/** The most own keys one stored `CoordinationRequestRecord` may carry (matches MAX_DECISION_OBJECT_KEYS). */
export const MAX_SIGN_DECISION_RECORD_KEYS = 32 as const;

/** The longest request id accepted for signing. */
export const MAX_SIGN_DECISION_ID_LENGTH = 128 as const;

/** The longest answer word (`approve` / `decline`). */
export const MAX_DECISION_ANSWER_LENGTH = 16 as const;

/** The longest decision revision accepted for signing. */
export const MAX_DECISION_REVISION_LENGTH = 128 as const;

/** The longest grant id accepted for signing (matches the decision answer's grant cap). */
export const MAX_DECISION_GRANT_ID_LENGTH = 128 as const;

const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Whether the string carries any control character, including tab and newline. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** The exact keys one sign-decision input may carry; the first two are required. */
const SIGN_DECISION_KEYS = ['requestId', 'answer', 'grantId', 'decisionRevision'] as const;

/** Every typed way a sign-decision input read can fail closed. */
export type SignDecisionInputErrorCode =
  | 'invalid-sign-decision-input'
  | 'request-not-awaiting-decision'
  | 'grant-id-too-long'
  | 'invalid-coordination-record';

/** The validated input of one `sign-decision` invocation. */
export interface SignDecisionInput {
  readonly requestId: string;
  readonly answer: 'approve' | 'decline';
  readonly grantId?: string;
  readonly decisionRevision?: string;
}

export type ParsedSignDecisionInput =
  | { readonly ok: true; readonly input: SignDecisionInput }
  | { readonly ok: false; readonly code: SignDecisionInputErrorCode };

/**
 * Whether one optional bounded string field is acceptable: a non-empty string
 * of at most `maxLength` characters, without control characters and without
 * surrounding whitespace (the decision transport trims these fields before
 * verifying, so a value that would change under trimming is refused here).
 */
function isAcceptableOptionalField(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !hasControlCharacter(value) &&
    value === value.trim()
  );
}

/**
 * Parse and validate the raw `sign-decision` CLI input. Cost is linear in the
 * capped input: at most `MAX_SIGN_DECISION_KEYS` own descriptors (the allowed
 * key set itself caps the count at `SIGN_DECISION_KEYS.length`) plus at most
 * `MAX_SIGN_DECISION_ID_LENGTH` / `MAX_DECISION_ANSWER_LENGTH` /
 * `MAX_DECISION_GRANT_ID_LENGTH` / `MAX_DECISION_REVISION_LENGTH` characters
 * per inspected field.
 */
export function parseSignDecisionInput(raw: unknown): ParsedSignDecisionInput {
  const fields = readPlainObjectWithOptional(raw, ['requestId', 'answer'], [
    ...SIGN_DECISION_KEYS,
  ]);
  if (fields === null) {
    return { ok: false, code: 'invalid-sign-decision-input' };
  }
  for (const key of Object.keys(fields)) {
    if ((FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      return { ok: false, code: 'invalid-sign-decision-input' };
    }
  }
  const requestId = fields['requestId'];
  if (
    typeof requestId !== 'string' ||
    requestId.length === 0 ||
    requestId.length > MAX_SIGN_DECISION_ID_LENGTH ||
    !SAFE_REQUEST_ID.test(requestId) ||
    /^[.]+$/.test(requestId)
  ) {
    return { ok: false, code: 'invalid-sign-decision-input' };
  }
  const answer = fields['answer'];
  if (
    typeof answer !== 'string' ||
    answer.length > MAX_DECISION_ANSWER_LENGTH ||
    (answer !== 'approve' && answer !== 'decline')
  ) {
    return { ok: false, code: 'invalid-sign-decision-input' };
  }
  const grantId = fields['grantId'];
  if (
    grantId !== undefined &&
    !isAcceptableOptionalField(grantId, MAX_DECISION_GRANT_ID_LENGTH)
  ) {
    return { ok: false, code: 'invalid-sign-decision-input' };
  }
  const decisionRevision = fields['decisionRevision'];
  if (
    decisionRevision !== undefined &&
    !isAcceptableOptionalField(decisionRevision, MAX_DECISION_REVISION_LENGTH)
  ) {
    return { ok: false, code: 'invalid-sign-decision-input' };
  }
  return {
    ok: true,
    input: {
      requestId,
      answer,
      ...(grantId !== undefined ? { grantId } : {}),
      ...(decisionRevision !== undefined ? { decisionRevision } : {}),
    },
  };
}

/** The exact fields one signed decision binds, in canonical JSON key order. */
export interface SignableDecisionFields {
  readonly requestId: string;
  readonly projectId: string;
  readonly actionScope: string;
  readonly expectedHeadSha: string | null;
  readonly decisionRevision: string;
  readonly grantId: string | null;
  readonly state: 'approved' | 'declined';
}

export type BuiltSignableDecisionFields =
  | { readonly ok: true; readonly fields: SignableDecisionFields; readonly canonicalJson: string }
  | { readonly ok: false; readonly code: SignDecisionInputErrorCode };

/**
 * Snapshot one stored record hostile-style: a plain object with at most
 * `MAX_SIGN_DECISION_RECORD_KEYS` own keys, values read through their own
 * data-property descriptors (no getter ever runs), and a forbidden
 * prototype-polluting key refused before any field is read. Cost is linear in
 * the capped input.
 */
function snapshotRecord(raw: unknown): Record<string, unknown> | null {
  // Every reflective read is wrapped: a revoked Proxy or a hostile trap can
  // make even `Array.isArray`, `Object.getPrototypeOf` or
  // `Object.getOwnPropertyDescriptor` throw, and every such throw is a typed
  // refusal, never an exception escaping the exported function.
  let isArray: boolean;
  try {
    isArray = Array.isArray(raw);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || isArray) {
    return null;
  }
  let prototype: unknown;
  try {
    prototype = Object.getPrototypeOf(raw);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(raw);
  } catch {
    return null;
  }
  if (ownKeys.length > MAX_SIGN_DECISION_RECORD_KEYS) {
    return null;
  }
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      return null;
    }
    if ((FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      return null;
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(raw, key);
    } catch {
      return null;
    }
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      return null;
    }
    out[key] = descriptor.value;
  }
  return out;
}

/** A bounded non-empty string of at most `maxLength` characters. */
function isBoundedField(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/**
 * Build the exact canonical decision fields one signature will bind, from the
 * stored `CoordinationRequestRecord` and the validated sign input, both read
 * as hostile `unknown` data. Cost is linear in the capped input: at most
 * `MAX_SIGN_DECISION_RECORD_KEYS` record descriptors plus the
 * `parseSignDecisionInput` bound on the decision side.
 */
export function buildSignableDecisionFields(
  recordRaw: unknown,
  decisionRaw: unknown,
): BuiltSignableDecisionFields {
  const parsed = parseSignDecisionInput(decisionRaw);
  if (!parsed.ok) {
    return parsed;
  }
  const record = snapshotRecord(recordRaw);
  if (record === null) {
    return { ok: false, code: 'invalid-coordination-record' };
  }
  const id = record['id'];
  const projectId = record['projectId'];
  const actionScope = record['actionScope'];
  const expectedHeadSha = record['expectedHeadSha'];
  const state = record['state'];
  if (
    !isBoundedField(id, MAX_SIGN_DECISION_ID_LENGTH) ||
    !isBoundedField(projectId, MAX_SIGN_DECISION_ID_LENGTH) ||
    !isBoundedField(actionScope, MAX_SIGN_DECISION_ID_LENGTH) ||
    (expectedHeadSha !== null && !isBoundedField(expectedHeadSha, 512)) ||
    (state !== 'awaiting-decision')
  ) {
    return state !== 'awaiting-decision'
      ? { ok: false, code: 'request-not-awaiting-decision' }
      : { ok: false, code: 'invalid-coordination-record' };
  }
  if (parsed.input.requestId !== id) {
    return { ok: false, code: 'invalid-coordination-record' };
  }
  const approve = parsed.input.answer === 'approve';
  let grantId: string | null;
  if (!approve) {
    // A decline never names a grant: the answer's grant stays unclaimed.
    grantId = null;
  } else {
    grantId = parsed.input.grantId ?? `grant-${id}`;
    if (grantId.length > MAX_DECISION_GRANT_ID_LENGTH) {
      return { ok: false, code: 'grant-id-too-long' };
    }
  }
  const decisionRevision = parsed.input.decisionRevision ?? '1';
  const fields: SignableDecisionFields = {
    requestId: id,
    projectId,
    actionScope,
    expectedHeadSha: typeof expectedHeadSha === 'string' ? expectedHeadSha : null,
    decisionRevision,
    grantId,
    state: approve ? 'approved' : 'declined',
  };
  // The key order matches `canonicalDecisionBytes` byte for byte; `null`
  // stays `null`.
  const canonicalJson = JSON.stringify({
    requestId: fields.requestId,
    projectId: fields.projectId,
    actionScope: fields.actionScope,
    expectedHeadSha: fields.expectedHeadSha,
    decisionRevision: fields.decisionRevision,
    grantId: fields.grantId,
    state: fields.state,
  });
  return { ok: true, fields, canonicalJson };
}
