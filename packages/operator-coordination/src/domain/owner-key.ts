/**
 * Owner key setup boundary checks (KEY1b): the pure, hostile-input-safe
 * validation behind `coordination owner-key init` and `coordination
 * owner-key public`. Nothing here imports `node:*`, nothing throws, and no
 * getter or Proxy trap ever runs: every exported function takes `unknown`
 * at its boundary and returns a typed discriminated result carrying a named
 * error code. The input value is never echoed into a result.
 *
 * Cost bounds: `checkOwnerKeyPathSafety` is linear in the capped path
 * lengths (`MAX_KEY_PATH_LENGTH` per string) and in the capped marker
 * array (`MAX_PATH_SEGMENTS` entries, refused before any traversal when
 * longer), and O(1) otherwise; `formatOwnerInstallationEdit` is O(1) in the
 * fixed `MAX_PUBLIC_KEY_BASE64_LENGTH` cap. All caps are the named
 * constants below.
 */

/** The longest path string either function even considers. */
export const MAX_KEY_PATH_LENGTH = 4096;

/** The most ancestor-marker entries the marker check will traverse. */
export const MAX_PATH_SEGMENTS = 128;

/** The exact length of canonical base64 of 32 raw bytes (`44`). */
export const MAX_PUBLIC_KEY_BASE64_LENGTH = 44;

/** The raw byte length of an Ed25519 public key (`32`). */
export const RAW_ED25519_PUBLIC_KEY_BYTES = 32;

/** Refusal codes `checkOwnerKeyPathSafety` returns. */
export type OwnerKeyPathErrorCode =
  | 'invalid-input'
  | 'hostile-input'
  | 'path-too-long'
  | 'too-many-segments'
  | 'unsafe-path-state-dir'
  | 'unsafe-path-git-repo';

/** The outcome of one owner-key path safety check. */
export type OwnerKeyPathSafetyResult =
  | { readonly ok: true; readonly targetPath: string }
  | { readonly ok: false; readonly code: OwnerKeyPathErrorCode };

/** Refusal codes `formatOwnerInstallationEdit` returns. */
export type OwnerInstallationEditErrorCode = 'invalid-input' | 'invalid-public-key';

/** The outcome of one installation-edit formatting request. */
export type OwnerInstallationEditResult =
  | { readonly ok: true; readonly publicKey: string; readonly installationEdit: string }
  | { readonly ok: false; readonly code: OwnerInstallationEditErrorCode };

/** Own keys whose presence marks a record as prototype-polluted. */
const PROTOTYPE_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/** The input keys `checkOwnerKeyPathSafety` accepts, required ones first. */
const PATH_INPUT_KEYS: readonly string[] = ['targetPath', 'ancestorGitMarkers', 'stateDir'];

/** Canonical base64 of exactly `RAW_ED25519_PUBLIC_KEY_BYTES` raw bytes. */
const CANONICAL_RAW_KEY = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Lexical path normalization with plain string operations (the domain stays
 * pure: no `node:path`). Splits on both separators, drops empty and `.`
 * segments, and resolves `..` lexically. Linear in the input length.
 */
function normalizePath(input: string): string {
  const isAbsolute = input.startsWith('/');
  const stack: string[] = [];
  for (const part of input.split(/[/\\]+/)) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!isAbsolute) {
        stack.push('..');
      }
      continue;
    }
    stack.push(part);
  }
  return (isAbsolute ? '/' : '') + stack.join('/');
}

/** Whether `child` is `parent` itself or lies inside it. Both normalized. */
function liesInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * A checked plain-data path string: a string within the length cap with no
 * NUL byte. The value is read from the caller-supplied descriptor value, so
 * no getter ever runs.
 */
function checkPathString(value: unknown): 'invalid-input' | 'path-too-long' | 'hostile-input' | null {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    return 'invalid-input';
  }
  if (value.length > MAX_KEY_PATH_LENGTH) {
    return 'path-too-long';
  }
  return null;
}

/**
 * The marker array read through own property descriptors only: a real array
 * (never an array-like object), with an own dense set of string entries, no
 * accessor, no extra own keys, and a length at or below
 * `MAX_PATH_SEGMENTS` — the length is refused before any traversal, so a
 * sparse array of length 2**32 - 1 costs O(1) to refuse.
 */
function readMarkerArray(value: unknown): { ok: true; markers: readonly string[] } | { ok: false; code: OwnerKeyPathErrorCode } {
  let isArray: boolean;
  let prototype: unknown;
  let ownKeys: PropertyKey[];
  let length: unknown;
  try {
    isArray = Array.isArray(value);
    if (!isArray) {
      return { ok: false, code: 'invalid-input' };
    }
    prototype = Object.getPrototypeOf(value as object);
    ownKeys = Reflect.ownKeys(value as object);
    length = (value as unknown[]).length;
  } catch {
    return { ok: false, code: 'hostile-input' };
  }
  if (prototype !== Array.prototype && prototype !== null) {
    return { ok: false, code: 'invalid-input' };
  }
  if (typeof length !== 'number' || length > MAX_PATH_SEGMENTS) {
    return { ok: false, code: 'too-many-segments' };
  }
  const markers: string[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, index);
    } catch {
      return { ok: false, code: 'hostile-input' };
    }
    if (descriptor === undefined) {
      // A hole: sparse arrays are refused, never traversed with `in`.
      return { ok: false, code: 'hostile-input' };
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return { ok: false, code: 'hostile-input' };
    }
    const entry = descriptor.value;
    if (typeof entry !== 'string' || entry.length > MAX_KEY_PATH_LENGTH || entry.includes('\0')) {
      return { ok: false, code: 'invalid-input' };
    }
    markers.push(entry);
  }
  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      return { ok: false, code: 'invalid-input' };
    }
    const isIndex = /^\d+$/.test(key) && Number(key) < length;
    if (!isIndex && key !== 'length') {
      return { ok: false, code: 'hostile-input' };
    }
  }
  return { ok: true, markers };
}

/**
 * Validate the boundary input for one owner-key file write: an optional
 * `stateDir` exclusion and the ancestor git-marker list, against the
 * `targetPath`. Only own enumerable data properties are read (a getter
 * never runs); a non-plain object, a symbol key, a prototype-polluting own
 * key, a Proxy whose traps throw, a sparse or over-long marker array, or an
 * over-long or NUL-carrying path is refused. `targetPath` inside
 * `stateDir`, or any normalized ancestor marker that is a `.git` entry on
 * the target's path, is refused. Never throws; linear in the capped input.
 */
export function checkOwnerKeyPathSafety(raw: unknown): OwnerKeyPathSafetyResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, code: 'invalid-input' };
  }
  let prototype: unknown;
  let ownKeys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(raw);
    ownKeys = Reflect.ownKeys(raw);
  } catch {
    return { ok: false, code: 'hostile-input' };
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, code: 'invalid-input' };
  }
  const values = new Map<string, unknown>();
  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      return { ok: false, code: 'invalid-input' };
    }
    if (PROTOTYPE_KEYS.includes(key)) {
      return { ok: false, code: 'hostile-input' };
    }
    if (!PATH_INPUT_KEYS.includes(key)) {
      return { ok: false, code: 'invalid-input' };
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(raw, key);
    } catch {
      return { ok: false, code: 'hostile-input' };
    }
    if (descriptor === undefined || !descriptor.enumerable) {
      return { ok: false, code: 'hostile-input' };
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      // An accessor's value is never read: the getter must never run.
      return { ok: false, code: 'hostile-input' };
    }
    values.set(key, descriptor.value);
  }
  for (const required of ['targetPath', 'ancestorGitMarkers'] as const) {
    if (!values.has(required)) {
      return { ok: false, code: 'invalid-input' };
    }
  }
  const targetCheck = checkPathString(values.get('targetPath'));
  if (targetCheck !== null) {
    return { ok: false, code: targetCheck };
  }
  const targetPath = values.get('targetPath') as string;
  let stateDir: string | undefined;
  if (values.has('stateDir')) {
    const stateCheck = checkPathString(values.get('stateDir'));
    if (stateCheck !== null) {
      return { ok: false, code: stateCheck };
    }
    stateDir = values.get('stateDir') as string;
  }
  const markersRead = readMarkerArray(values.get('ancestorGitMarkers'));
  if (!markersRead.ok) {
    return { ok: false, code: markersRead.code };
  }
  const normalizedTarget = normalizePath(targetPath);
  if (stateDir !== undefined) {
    const normalizedStateDir = normalizePath(stateDir);
    if (normalizedStateDir === '' || liesInside(normalizedTarget, normalizedStateDir)) {
      return { ok: false, code: 'unsafe-path-state-dir' };
    }
  }
  for (const marker of markersRead.markers) {
    const normalizedMarker = normalizePath(marker);
    const segments = normalizedMarker.split('/').filter((segment) => segment !== '');
    const isGitMarker = segments[segments.length - 1] === '.git';
    if (isGitMarker && (normalizedMarker === '' || liesInside(normalizedTarget, normalizedMarker))) {
      return { ok: false, code: 'unsafe-path-git-repo' };
    }
  }
  const targetSegments = normalizedTarget.split('/');
  if (targetSegments.includes('.git')) {
    return { ok: false, code: 'unsafe-path-git-repo' };
  }
  return { ok: true, targetPath };
}

/**
 * Validate one candidate public key string and format the exact
 * installation-file edit that pins it. Only canonical base64 of exactly
 * `RAW_ED25519_PUBLIC_KEY_BYTES` raw bytes is accepted (no whitespace, no
 * URL-safe alphabet, exactly the canonical `=` padding), and the base64
 * round trip must reproduce the input. Never throws; O(1) in the fixed
 * `MAX_PUBLIC_KEY_BASE64_LENGTH` cap.
 */
export function formatOwnerInstallationEdit(rawPublicKeyBase64: unknown): OwnerInstallationEditResult {
  if (typeof rawPublicKeyBase64 !== 'string') {
    return { ok: false, code: 'invalid-input' };
  }
  if (
    rawPublicKeyBase64.length !== MAX_PUBLIC_KEY_BASE64_LENGTH ||
    !CANONICAL_RAW_KEY.test(rawPublicKeyBase64)
  ) {
    return { ok: false, code: 'invalid-public-key' };
  }
  const decoded = Buffer.from(rawPublicKeyBase64, 'base64');
  if (
    decoded.length !== RAW_ED25519_PUBLIC_KEY_BYTES ||
    decoded.toString('base64') !== rawPublicKeyBase64
  ) {
    return { ok: false, code: 'invalid-public-key' };
  }
  return {
    ok: true,
    publicKey: rawPublicKeyBase64,
    installationEdit: `{ "owner": { "publicKey": "${rawPublicKeyBase64}" } }`,
  };
}
