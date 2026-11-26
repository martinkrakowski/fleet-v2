/**
 * KmsSignerPort: outbound port for signing one bounded payload with one
 * managed KMS key. The port is defined before any adapter exists: the shared
 * in-memory fake under `__tests__` is the only implementation, and the shared
 * contract suite pins its semantics so a later real adapter cannot drift from
 * the fake.
 *
 * Key material never appears in any request, result or exported type; the
 * port speaks only in key identifiers, algorithms and opaque branded
 * signatures, and fails closed on any KMS health other than `healthy`.
 *
 * Every input is untrusted: both arguments are read once through
 * `snapshotPlainData` from `@fleet/shared` (no getter ever runs, no Proxy
 * trap ever fires), then validated against the exact key set on the frozen
 * snapshot. Every failure is a typed result, never a throw and never a
 * guessed state.
 */

import {
  snapshotPlainData,
  type IsProxy,
  type PlainDataLimits,
} from '@fleet/shared';

/**
 * KMS availability as seen by the caller. Reused by value from the tenancy
 * domain's `KmsHealth` union without importing `@fleet/tenancy`.
 */
export type KmsHealth = 'healthy' | 'degraded' | 'down';

/**
 * The longest signing payload in UTF-8 bytes. This single bound is used both
 * as the snapshot's `maxStringLength` and as the byte-length validation, so
 * the two limits can never contradict each other.
 */
export const MAX_SIGN_PAYLOAD_BYTES = 65_536 as const;

/** The longest any KMS identifier or algorithm string field may be. */
export const KMS_MAX_STRING_LENGTH = 300 as const;

/** One managed key the signer may use. */
export interface KmsKeyHandle {
  readonly keyId: string;
  readonly algorithm: string;
  readonly health: KmsHealth;
}

/** An opaque signature over one payload. The brand keeps it from being confused with raw text. */
export type OpaqueSignature = string & { readonly __brand: 'OpaqueSignature' };

/** One bounded UTF-8 payload to sign. Every field is required. */
export interface SignPayload {
  readonly content: string;
}

/** A fixed failure reason, never a throw; never carries key or payload detail. */
export type SignRefusalReason = 'invalid-request' | 'unavailable' | 'unknown-key';

export type SignResult =
  | {
      readonly ok: true;
      readonly signature: OpaqueSignature;
      readonly keyId: string;
      readonly algorithm: string;
    }
  | { readonly ok: false; readonly reason: SignRefusalReason };

export interface KmsSignerPort {
  sign(keyHandle: KmsKeyHandle, payload: SignPayload): Promise<SignResult>;
}

/**
 * Domain-sized snapshot limits for one `KmsKeyHandle` or `SignPayload`:
 * flat objects, no arrays, every string at most `MAX_SIGN_PAYLOAD_BYTES`
 * characters. Fixed at the call site, so the snapshot cost is O(1): bounded
 * by `maxNodes`, `maxKeys`, `maxArrayLength`, `maxDepth` and
 * `maxStringLength` regardless of input.
 */
const KMS_INPUT_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 2,
  maxKeys: 8,
  maxArrayLength: 1,
  maxNodes: 16,
  maxStringLength: MAX_SIGN_PAYLOAD_BYTES,
});

/** The only own keys a `KmsKeyHandle` may carry. */
const KEY_HANDLE_KEYS: readonly string[] = ['keyId', 'algorithm', 'health'];

/** The only own keys a `SignPayload` may carry. */
const PAYLOAD_KEYS: readonly string[] = ['content'];

/** Keys that must never appear as own data keys on any untrusted object. */
const POLLUTING_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** A bounded non-empty string field. O(1): the length cap runs before any scan. */
function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= KMS_MAX_STRING_LENGTH;
}

export type ValidateSignInputsResult =
  | {
      readonly ok: true;
      readonly keyHandle: KmsKeyHandle;
      readonly payload: SignPayload;
    }
  | { readonly ok: false; readonly reason: SignRefusalReason };

/**
 * Validate untrusted signing inputs on `snapshotPlainData` copies.
 *
 * Every snapshot refusal (Proxy, accessor, sparse array, symbol key,
 * non-enumerable key, non-plain prototype, cycle, oversized string, hostile
 * value, …) maps to `invalid-request`; after each snapshot succeeds the root
 * must be a plain non-array object carrying exactly the expected keys (no
 * polluting, extra, missing, symbol or non-enumerable key).
 *
 * A missing, `null` or non-string `keyHandle.health` is `invalid-request`; a
 * string health other than `'healthy'` is `unavailable`. A payload whose
 * UTF-8 encoding exceeds `MAX_SIGN_PAYLOAD_BYTES` is `invalid-request`.
 *
 * Cost bound: O(1) — each snapshot is bounded by the fixed
 * `KMS_INPUT_LIMITS`, and the byte-length check is
 * `new TextEncoder().encode(content).byteLength <= MAX_SIGN_PAYLOAD_BYTES`
 * over a snapshot-capped string.
 */
export function validateSignInputs(
  keyHandle: unknown,
  payload: unknown,
  isProxy?: IsProxy,
): ValidateSignInputsResult {
  // Fail closed when the detector is omitted: pure JavaScript has no
  // side-effect-free Proxy detector, so a permissive default (e.g. an
  // `alwaysFalse` predicate) would let a missed Proxy's reflection traps run
  // during snapshotting. Callers must pass `types.isProxy` from `node:util`.
  if (isProxy === undefined) {
    return { ok: false, reason: 'invalid-request' };
  }
  const health = readKeyHandleHealth(keyHandle, isProxy);
  if (health === null) {
    return { ok: false, reason: 'invalid-request' };
  }
  if (health !== 'healthy') {
    return { ok: false, reason: 'unavailable' };
  }
  const handle = readKeyHandle(keyHandle, isProxy);
  if (handle === null) {
    return { ok: false, reason: 'invalid-request' };
  }
  const payloadSnapshot = snapshotPlainData(payload, isProxy, KMS_INPUT_LIMITS);
  if (!payloadSnapshot.ok) {
    return { ok: false, reason: 'invalid-request' };
  }
  const payloadRoot = payloadSnapshot.value;
  if (typeof payloadRoot !== 'object' || payloadRoot === null || Array.isArray(payloadRoot)) {
    return { ok: false, reason: 'invalid-request' };
  }
  const payloadRecord = payloadRoot as Record<string, unknown>;
  const payloadOwnKeys = Object.keys(payloadRecord);
  if (payloadOwnKeys.length !== PAYLOAD_KEYS.length) {
    return { ok: false, reason: 'invalid-request' };
  }
  for (const key of payloadOwnKeys) {
    if (!PAYLOAD_KEYS.includes(key) || POLLUTING_KEYS.has(key)) {
      return { ok: false, reason: 'invalid-request' };
    }
  }
  const content = payloadRecord['content'];
  // The payload's ceiling is MAX_SIGN_PAYLOAD_BYTES characters here (the
  // snapshot's maxStringLength is the same bound), not the KMS identifier
  // bound; the UTF-8 byte check below shares the single constant.
  if (typeof content !== 'string' || content.length === 0 || content.length > MAX_SIGN_PAYLOAD_BYTES) {
    return { ok: false, reason: 'invalid-request' };
  }
  if (new TextEncoder().encode(content).byteLength > MAX_SIGN_PAYLOAD_BYTES) {
    return { ok: false, reason: 'invalid-request' };
  }
  return {
    ok: true,
    keyHandle: handle,
    payload: { content },
  };
}

/**
 * Read `keyHandle.health` off a snapshot copy: `null` when the handle is not
 * a plain non-array object with exactly the three handle keys (missing,
 * extra, polluting, symbol or non-enumerable keys included), `null` when
 * `health` is missing or not a string, and the string value otherwise — the
 * caller decides `'healthy'` from anything else. Cost bound: O(1).
 */
function readKeyHandleHealth(keyHandle: unknown, isProxy: IsProxy): string | null {
  const record = snapshotRecordWithKeys(keyHandle, KEY_HANDLE_KEYS, isProxy);
  if (record === null) {
    return null;
  }
  const health = record['health'];
  return typeof health === 'string' ? health : null;
}

/** Read the full validated `KmsKeyHandle` off a snapshot copy, or `null`. Cost bound: O(1). */
function readKeyHandle(keyHandle: unknown, isProxy: IsProxy): KmsKeyHandle | null {
  const record = snapshotRecordWithKeys(keyHandle, KEY_HANDLE_KEYS, isProxy);
  if (record === null) {
    return null;
  }
  const keyId = record['keyId'];
  const algorithm = record['algorithm'];
  const health = record['health'];
  if (!isBoundedString(keyId) || !isBoundedString(algorithm) || typeof health !== 'string') {
    return null;
  }
  return { keyId, algorithm, health: health as KmsHealth };
}

/**
 * Snapshot one untrusted value and require a plain non-array object with
 * exactly the given own keys, none polluting. Returns the frozen record or
 * `null`. Cost bound: O(1) — the snapshot is bounded by `KMS_INPUT_LIMITS`
 * and the key set is fixed.
 */
function snapshotRecordWithKeys(
  value: unknown,
  keys: readonly string[],
  isProxy: IsProxy,
): Record<string, unknown> | null {
  const snapshot = snapshotPlainData(value, isProxy, KMS_INPUT_LIMITS);
  if (!snapshot.ok) {
    return null;
  }
  const root = snapshot.value;
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    return null;
  }
  const record = root as Record<string, unknown>;
  const ownKeys = Object.keys(record);
  if (ownKeys.length !== keys.length) {
    return null;
  }
  for (const key of ownKeys) {
    if (!keys.includes(key) || POLLUTING_KEYS.has(key)) {
      return null;
    }
  }
  return record;
}

// No `alwaysFalse` default: when `isProxy` is omitted the validator refuses
// outright, because pure JavaScript has no side-effect-free Proxy detector and
// a permissive fallback would let a missed Proxy's reflection traps run.
