/**
 * The `owner` section parser: the pinned Ed25519 public key of the
 * installation owner. Pure and bounded: every exported function takes
 * `unknown` at its boundary and never throws — each refusal is a typed
 * result carrying a named error code, and the input value is never echoed.
 *
 * Cost bounds: `parseOwnerPublicKey` applies the length cap
 * `MAX_OWNER_PUBLIC_KEY_LENGTH` before the secret screen, so every
 * subsequent check is linear in the capped input;
 * `readOwnerSection` is linear in the bounded `OWNER_KEYS` and the capped
 * key length. The secret screen cannot distinguish a raw 32-byte Ed25519
 * seed from a public key: both are 32 bytes, so a seed pasted as
 * `owner.publicKey` passes every check here. See
 * `docs/runbooks/cutover.md` ("Owner key pinning and rotation").
 */

import {
  LANE_DIFF_SECRET_PATTERNS,
  containsSecretShape,
} from '@fleet/shared';

import { isPlainRecord } from './policy-read.js';

import type { OwnerSection } from './types.js';

/** The longest `owner.publicKey` string the parser considers, well above the 44-character canonical encoding. */
export const MAX_OWNER_PUBLIC_KEY_LENGTH = 128;

/** Refusal codes `parseOwnerPublicKey` returns. */
export type OwnerPublicKeyErrorCode =
  | 'owner-key-invalid-type'
  | 'owner-key-too-long'
  | 'owner-key-secret-shape'
  | 'owner-key-invalid-format'
  | 'owner-key-accessor';

/** Refusal codes `readOwnerSection` returns. */
export type OwnerSectionErrorCode =
  | 'owner-section-invalid'
  | 'owner-section-prototype-pollution'
  | 'owner-section-unknown-key'
  | 'owner-key-required'
  | OwnerPublicKeyErrorCode;

export type OwnerPublicKeyResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: OwnerPublicKeyErrorCode };

export type OwnerSectionResult =
  | { readonly ok: true; readonly value: OwnerSection }
  | { readonly ok: false; readonly code: OwnerSectionErrorCode };

/** Keys whose own presence on a record marks it as prototype-polluted. */
const PROTOTYPE_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/**
 * Canonical base64 of exactly 32 raw bytes: standard alphabet, no
 * whitespace, `=` padding only at the end in the canonical amount, and a
 * round-trip that proves the decode is 32 bytes and re-encodes to the same
 * string. Linear in the string length; the validator itself caps the input
 * at `MAX_OWNER_PUBLIC_KEY_LENGTH`, so it is linear in that cap regardless
 * of the caller.
 */
export function isCanonicalBase64Of32Bytes(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_OWNER_PUBLIC_KEY_LENGTH ||
    value.length % 4 !== 0
  ) {
    return false;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
}

/**
 * True when the string carries any private-key or credential shape: the
 * shared legacy six, the canonical lane-diff registry, and the bare
 * `-----BEGIN` / `PRIVATE KEY` markers. Only whether, never where — and the
 * matched text is never echoed. Linear in the input length.
 */
function hasOwnerSecretShape(value: string): boolean {
  if (containsSecretShape(value)) {
    return true;
  }
  if (/-----BEGIN|PRIVATE KEY/.test(value)) {
    return true;
  }
  return LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(value));
}

/**
 * Validate one candidate `owner.publicKey` value. Refusals in order: not a
 * string (`owner-key-invalid-type`), over-long (`owner-key-too-long`,
 * refused before the secret screen and before any base64 decoding), a
 * private-key or credential shape (`owner-key-secret-shape`), not canonical
 * base64 of exactly 32 bytes (`owner-key-invalid-format`). The input value
 * is never echoed.
 */
export function parseOwnerPublicKey(value: unknown): OwnerPublicKeyResult {
  if (typeof value !== 'string') {
    return { ok: false, code: 'owner-key-invalid-type' };
  }
  if (value.length > MAX_OWNER_PUBLIC_KEY_LENGTH) {
    return { ok: false, code: 'owner-key-too-long' };
  }
  if (hasOwnerSecretShape(value)) {
    return { ok: false, code: 'owner-key-secret-shape' };
  }
  if (!isCanonicalBase64Of32Bytes(value)) {
    return { ok: false, code: 'owner-key-invalid-format' };
  }
  return { ok: true, value };
}

/**
 * The own data properties of a record, read through descriptors so a getter
 * never runs: an accessor property is reported instead of read. Returns
 * `undefined` for a non-plain record (callers have already refused those).
 */
function ownDataEntries(
  record: Record<string, unknown>,
): ReadonlyArray<{ key: string; value: unknown } | { key: string; accessor: true }> {
  const entries: Array<{ key: string; value: unknown } | { key: string; accessor: true }> = [];
  for (const key of Object.getOwnPropertyNames(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined) {
      continue;
    }
    if ('value' in descriptor) {
      entries.push({ key, value: descriptor.value });
    } else {
      entries.push({ key, accessor: true });
    }
  }
  return entries;
}

/**
 * Read the `owner` section of an installation file. Every check reads own
 * data properties through descriptors, so a getter never runs and a Proxy
 * `get` trap never fires. Refusals in order: not a plain record
 * (`owner-section-invalid`, including `null`, `undefined`, arrays and
 * array-likes), an own prototype-polluting key
 * (`owner-section-prototype-pollution`), a key outside `OWNER_KEYS`
 * (`owner-section-unknown-key`), a missing `publicKey`
 * (`owner-key-required`), an accessor `publicKey`
 * (`owner-key-accessor`), or a `publicKey` refused by
 * `parseOwnerPublicKey` (its code passes through). Linear in the bounded
 * `OWNER_KEYS` and the capped key length.
 *
 * Never throws: the reflective reads (prototype, own keys, descriptors) are
 * wrapped so a hostile Proxy whose traps throw yields the typed
 * `owner-section-invalid` refusal. Enumerating the own keys before any
 * length cap is the documented JavaScript limit for the whole record shape
 * (residual #4v): the key set is bounded by the file size the caller already
 * read, and no work is done per value before enumeration; this is stated,
 * not solved.
 */
export function readOwnerSection(value: unknown): OwnerSectionResult {
  // Every reflective read below is wrapped: a hostile Proxy whose
  // `getPrototypeOf`, `ownKeys` or `getOwnPropertyDescriptor` trap throws
  // yields the typed `owner-section-invalid` refusal instead of an
  // exception. The reads never invoke a `get` trap, so a `get` trap's
  // counter stays 0 for any input.
  try {
    return readOwnerSectionStrict(value);
  } catch {
    return { ok: false, code: 'owner-section-invalid' };
  }
}

function readOwnerSectionStrict(value: unknown): OwnerSectionResult {
  if (!isPlainRecord(value)) {
    return { ok: false, code: 'owner-section-invalid' };
  }
  const entries = ownDataEntries(value);
  for (const entry of entries) {
    if (PROTOTYPE_KEYS.includes(entry.key)) {
      return { ok: false, code: 'owner-section-prototype-pollution' };
    }
  }
  for (const entry of entries) {
    if (entry.key !== 'publicKey') {
      return { ok: false, code: 'owner-section-unknown-key' };
    }
  }
  const publicKeyEntry = entries.find((entry) => entry.key === 'publicKey');
  if (publicKeyEntry === undefined) {
    return { ok: false, code: 'owner-key-required' };
  }
  if ('accessor' in publicKeyEntry) {
    return { ok: false, code: 'owner-key-accessor' };
  }
  const publicKey = parseOwnerPublicKey(publicKeyEntry.value);
  if (!publicKey.ok) {
    return publicKey;
  }
  return { ok: true, value: { publicKey: publicKey.value } };
}
