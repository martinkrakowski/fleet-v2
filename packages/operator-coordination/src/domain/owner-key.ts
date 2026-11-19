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

/** The standard base64 alphabet, in encoding order. */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Whether `value` decodes, with the pure bit-level base64 decoder below, to
 * exactly `RAW_ED25519_PUBLIC_KEY_BYTES` raw bytes and re-encodes to the
 * same string. The domain stays pure: no `Buffer`, no `node:*` — the decode
 * is plain arithmetic over the standard alphabet.
 */
function decodesToExactly32RawBytes(value: string): boolean {
  let bits = 0;
  let bitCount = 0;
  let byteIndex = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '=') {
      if (index !== value.length - 1) {
        return false;
      }
      break;
    }
    const digit = BASE64_ALPHABET.indexOf(char);
    if (digit < 0) {
      return false;
    }
    bits = (bits << 6) | digit;
    bitCount += 6;
    if (bitCount >= 8) {
      if (byteIndex >= RAW_ED25519_PUBLIC_KEY_BYTES) {
        return false;
      }
      bitCount -= 8;
      bits &= (1 << bitCount) - 1;
      byteIndex += 1;
    }
  }
  // Exactly 32 bytes must be produced, and the leftover bits (the two low
  // bits of the 43rd character) must be zero for the round trip to hold.
  return byteIndex === RAW_ED25519_PUBLIC_KEY_BYTES && (bits & ((1 << bitCount) - 1)) === 0;
}

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

/**
 * Whether `file` is `root` itself or lies inside it (both normalized POSIX
 * paths), decided from a pure relative-path step so a root of `/` cannot
 * build a `//` prefix and a sibling like `/srv/ab` cannot be swallowed by
 * `/srv/a`. Same segment-safe pattern as the KEY0a `isInside` helper,
 * without `node:path` (the domain stays pure). Linear in the input length.
 */
function isInside(root: string, file: string): boolean {
  const rel = relativePosix(root, file);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && rel[0] !== '/');
}

/**
 * Pure POSIX `path.relative(root, file)` for normalized paths: `''` when
 * equal, the remainder when `file` lies under `root` at a segment boundary,
 * and `'..'` otherwise (a `..`-leading or absolute remainder means "not
 * inside", which `isInside` refuses). Linear in the input length.
 */
function relativePosix(root: string, file: string): string {
  if (root === file) {
    return '';
  }
  if (root === '/') {
    return file.startsWith('/') ? file.slice(1) : '..';
  }
  if (file.startsWith(`${root}/`)) {
    return file.slice(root.length + 1);
  }
  return '..';
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
 * The declared `length` of a marker candidate, read from its own data
 * descriptor only (a Proxy would otherwise run its `get` trap for `length`,
 * and an accessor is never read), with the array/prototype/length shape
 * checks. Refusal before any traversal keeps a sparse array of length
 * `2**32 - 1` an O(1) rejection.
 */
function readMarkerLength(value: object): { ok: true; length: number } | { ok: false; code: OwnerKeyPathErrorCode } {
  let prototype: unknown;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    // As above (#4v): reading the prototype necessarily invokes a Proxy's
    // getPrototypeOf trap; a Proxy is refused or treated as its plain-data
    // snapshot, never guaranteed to run without traps.
    prototype = Object.getPrototypeOf(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    return { ok: false, code: 'hostile-input' };
  }
  if (prototype !== Array.prototype && prototype !== null) {
    return { ok: false, code: 'invalid-input' };
  }
  if (lengthDescriptor === undefined) {
    return { ok: false, code: 'hostile-input' };
  }
  if (lengthDescriptor.get !== undefined || lengthDescriptor.set !== undefined) {
    return { ok: false, code: 'hostile-input' };
  }
  const length = lengthDescriptor.value;
  if (typeof length !== 'number' || length > MAX_PATH_SEGMENTS) {
    return { ok: false, code: 'too-many-segments' };
  }
  return { ok: true, length };
}

/**
 * The marker entries `0 .. length - 1`, each read through its own data
 * descriptor only: a hole (a sparse array) is refused, never traversed with
 * `in`, and an accessor's value is never read.
 */
function readMarkerEntries(value: object, length: number): { ok: true; markers: readonly string[] } | { ok: false; code: OwnerKeyPathErrorCode } {
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
  return { ok: true, markers };
}

/**
 * The own keys of a marker candidate: every key must be a string that is
 * either a used index or exactly `length`; anything else (a symbol key, an
 * extra property) is refused.
 */
function checkMarkerOwnKeys(ownKeys: PropertyKey[], length: number): OwnerKeyPathErrorCode | null {
  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      return 'invalid-input';
    }
    // Only a CANONICAL array index counts: the decimal digits must be the
    // canonical rendering of their numeric value (`String(Number(k)) === k`)
    // and sit below the length, so `"00"`, `"01"`, `" 1"` and `"1.0"` are
    // unexpected keys, not indexes.
    const isIndex = /^\d+$/.test(key) && String(Number(key)) === key && Number(key) < length;
    if (!isIndex && key !== 'length') {
      return 'hostile-input';
    }
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
  let ownKeys: PropertyKey[];
  try {
    isArray = Array.isArray(value);
    if (!isArray) {
      return { ok: false, code: 'invalid-input' };
    }
    // Residual #4v: `Reflect.ownKeys` necessarily invokes Proxy traps
    // (ownKeys, and getOwnPropertyDescriptor for each reported key), just as
    // `Object.getPrototypeOf` necessarily invokes the getPrototypeOf trap.
    // No JS mechanism detects a Proxy without invoking some trap. The
    // contract is therefore that a Proxy is either refused or treated as its
    // plain-data snapshot — never that its traps do not run.
    ownKeys = Reflect.ownKeys(value as object);
  } catch {
    return { ok: false, code: 'hostile-input' };
  }
  const lengthRead = readMarkerLength(value as object);
  if (!lengthRead.ok) {
    return lengthRead;
  }
  const entriesRead = readMarkerEntries(value as object, lengthRead.length);
  if (!entriesRead.ok) {
    return entriesRead;
  }
  const ownKeyCode = checkMarkerOwnKeys(ownKeys, lengthRead.length);
  if (ownKeyCode !== null) {
    return { ok: false, code: ownKeyCode };
  }
  return { ok: true, markers: entriesRead.markers };
}

/**
 * Read the boundary input's own enumerable data properties into a map,
 * refusing everything that is not a plain record of known string/array
 * keys: a non-plain object, a symbol key, a prototype-polluting own key, an
 * unknown key, a non-enumerable property, or an accessor (a getter never
 * runs).
 */
function readPathInputRecord(raw: object): { ok: true; values: Map<string, unknown> } | { ok: false; code: OwnerKeyPathErrorCode } {
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
  return { ok: true, values };
}

/**
 * The git-marker verdict for one already-validated marker against the
 * normalized target path: only a `.git` entry that is the target itself or
 * an ancestor of it refuses.
 */
function markerRefusesTarget(normalizedTarget: string, marker: string): boolean {
  const normalizedMarker = normalizePath(marker);
  const segments = normalizedMarker.split('/').filter((segment) => segment !== '');
  const isGitMarker = segments[segments.length - 1] === '.git';
  return isGitMarker && (normalizedMarker === '' || isInside(normalizedMarker, normalizedTarget));
}

/**
 * The path verdicts once the record has been read and validated: the
 * `stateDir` exclusion, the ancestor git markers, and a `.git` segment in
 * the target path itself.
 */
function evaluatePathSafety(values: Map<string, unknown>): { ok: true; targetPath: string } | { ok: false; code: OwnerKeyPathErrorCode } {
  const targetPath = values.get('targetPath') as string;
  const normalizedTarget = normalizePath(targetPath);
  const markersRead = readMarkerArray(values.get('ancestorGitMarkers'));
  if (!markersRead.ok) {
    return markersRead;
  }
  if (values.has('stateDir')) {
    const normalizedStateDir = normalizePath(values.get('stateDir') as string);
    if (normalizedStateDir === '' || isInside(normalizedStateDir, normalizedTarget)) {
      return { ok: false, code: 'unsafe-path-state-dir' };
    }
  }
  for (const marker of markersRead.markers) {
    if (markerRefusesTarget(normalizedTarget, marker)) {
      return { ok: false, code: 'unsafe-path-git-repo' };
    }
  }
  if (normalizedTarget.split('/').includes('.git')) {
    return { ok: false, code: 'unsafe-path-git-repo' };
  }
  return { ok: true, targetPath };
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
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, code: 'invalid-input' };
  }
  // `Array.isArray` throws on a revoked Proxy: even this array probe is
  // untrusted input surface, so it runs inside the try and a revocation is
  // a typed refusal, never a thrown error.
  let isArray: boolean;
  try {
    isArray = Array.isArray(raw);
  } catch {
    return { ok: false, code: 'hostile-input' };
  }
  if (isArray) {
    return { ok: false, code: 'invalid-input' };
  }
  const recordRead = readPathInputRecord(raw);
  if (!recordRead.ok) {
    return recordRead;
  }
  for (const required of ['targetPath', 'ancestorGitMarkers'] as const) {
    if (!recordRead.values.has(required)) {
      return { ok: false, code: 'invalid-input' };
    }
  }
  const targetCheck = checkPathString(recordRead.values.get('targetPath'));
  if (targetCheck !== null) {
    return { ok: false, code: targetCheck };
  }
  if (recordRead.values.has('stateDir')) {
    const stateCheck = checkPathString(recordRead.values.get('stateDir'));
    if (stateCheck !== null) {
      return { ok: false, code: stateCheck };
    }
  }
  return evaluatePathSafety(recordRead.values);
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
  if (!decodesToExactly32RawBytes(rawPublicKeyBase64)) {
    return { ok: false, code: 'invalid-public-key' };
  }
  return {
    ok: true,
    publicKey: rawPublicKeyBase64,
    installationEdit: `{ "owner": { "publicKey": "${rawPublicKeyBase64}" } }`,
  };
}
