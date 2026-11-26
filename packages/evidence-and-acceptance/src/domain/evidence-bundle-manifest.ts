/**
 * Pure evidence-bundle manifest: a canonical, order-independent record of the
 * `{ path, content }` entries of an evidence bundle, and a verifier that
 * compares a bundle against such a record.
 *
 * Pure: no clock, no randomness, no I/O, no console and no `node:` import. The
 * digest function is injected as `Sha256HexFn`. A manifest and every problem
 * report carry paths, lengths and digests only, never content bytes. Every
 * function reading untrusted input is total: it returns a typed refusal and
 * never throws, never runs an accessor and never mutates its arguments.
 *
 * Cost bounds (N = number of entries):
 * - At most `MAX_BUNDLE_ENTRIES` (2000) entries, at most
 *   `MAX_BUNDLE_CONTENT_BYTES` (1048576, 1 MiB) of UTF-8 per entry and at most
 *   `MAX_BUNDLE_PATH_LENGTH` (200) characters per path.
 * - An oversized `length` is rejected in O(1) before any element is read; an
 *   oversized content string is rejected by its UTF-16 length in O(1) before it
 *   is scanned, so each scan is bounded by 1 MiB.
 * - Validation is a single pass: N element reads plus O(path + content)
 *   scanning each.
 * - Path sorting is O(N log N) comparisons.
 * - At most N + 1 calls to `sha256Hex`: one per entry plus one for
 *   `bundleDigest`. Verification keeps the same bound: one call for the
 *   recomputed `bundleDigest` plus at most one per entry present in both lists.
 * - Sorting the reported problems is O(P log P) with P <= 2N + 1.
 *
 * Accepted residual: a `Proxy` that answers every trap consistently with a
 * well-formed value is indistinguishable from the value it
 * imitates.
 */

/** Sentinel returned by `ownData` when a data value is unreadable. */
const UNREADABLE = Symbol('unreadable');

const SHA256_HEX = /^[0-9a-f]{64}$/;

export const BUNDLE_MANIFEST_SCHEMA_VERSION = 1;
export const MAX_BUNDLE_ENTRIES = 2000;
export const MAX_BUNDLE_PATH_LENGTH = 200;
export const MAX_BUNDLE_CONTENT_BYTES = 1024 * 1024;

/** Injected SHA-256 digest of a string, as 64 lowercase hex characters. */
export type Sha256HexFn = (text: string) => string;

export interface BundleEntryInput {
  readonly path: string;
  readonly content: string;
}

export interface BundleManifestEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface BundleManifest {
  readonly schemaVersion: 1;
  readonly entries: readonly BundleManifestEntry[];
  readonly bundleDigest: string;
}

export type BuildManifestRefusalReason =
  | 'invalid-entries'
  | 'invalid-path'
  | 'duplicate-path'
  | 'too-many-entries'
  | 'content-invalid'
  | 'content-too-large'
  | 'hasher-failed';

export type BuildBundleManifestResult =
  | { readonly ok: true; readonly manifest: BundleManifest }
  | { readonly ok: false; readonly reason: BuildManifestRefusalReason };

export type BundleVerifyProblemKind =
  | 'missing'
  | 'extra'
  | 'changed'
  | 'digest-mismatch'
  | 'unknown-schema-version'
  | 'manifest-invalid'
  | 'hasher-failed';

/** A problem names a path (or none) and a kind, never content or a digest. */
export interface BundleVerifyProblem {
  readonly kind: BundleVerifyProblemKind;
  readonly path: string | null;
}

export type VerifyBundleManifestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly problems: readonly BundleVerifyProblem[] };

function safeIsArray(value: unknown): value is readonly unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

/** A value is a plain object (prototype `Object.prototype` or `null`, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || safeIsArray(value)) {
    return false;
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  return prototype === Object.prototype || prototype === null;
}

/**
 * The value of the receiver's own data property `key`, read without running any
 * accessor: an absent, accessor-shaped or trapped property reads as
 * `UNREADABLE`. Never throws. O(1).
 */
function ownData(source: unknown, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      return UNREADABLE;
    }
    return descriptor.value;
  } catch {
    return UNREADABLE;
  }
}

/** The own `length` of an array as a safe non-negative integer, or `null`. O(1). */
function readLength(list: readonly unknown[]): number | null {
  const length = ownData(list, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    return null;
  }
  return length;
}

type TextMeasure =
  | { readonly kind: 'ok'; readonly bytes: number }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'too-large' };

/**
 * UTF-8 byte length of a well-formed string, scanned by hand because the domain
 * takes no runtime dependency. A lone surrogate is `malformed`; a string longer
 * than `MAX_BUNDLE_CONTENT_BYTES` UTF-16 units is `too-large` without a scan (every
 * unit of a well-formed string is at least one byte). O(min(length, 1 MiB)).
 */
function measureUtf8(text: string): TextMeasure {
  if (text.length > MAX_BUNDLE_CONTENT_BYTES) {
    return { kind: 'too-large' };
  }
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return { kind: 'malformed' };
      }
      bytes += 4;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return { kind: 'malformed' };
    } else {
      bytes += 3;
    }
  }
  return bytes > MAX_BUNDLE_CONTENT_BYTES ? { kind: 'too-large' } : { kind: 'ok', bytes };
}

/**
 * A bundle path is 1..200 well-formed characters, relative, `/`-separated, with
 * no empty, `.` or `..` segment, no backslash and no control character. It is
 * case-sensitive and never normalised. O(path length).
 */
function isValidBundlePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length < 1 || path.length > MAX_BUNDLE_PATH_LENGTH) {
    return false;
  }
  if (path.startsWith('/') || path.endsWith('/') || path.includes('\\') || path.includes('//')) {
    return false;
  }
  for (let i = 0; i < path.length; i += 1) {
    const unit = path.charCodeAt(i);
    if (unit <= 0x1f || unit === 0x7f) {
      return false;
    }
  }
  if (measureUtf8(path).kind !== 'ok') {
    return false;
  }
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '..') {
      return false;
    }
  }
  return true;
}

/**
 * One call to the injected hasher. A non-function, a throw and any result that is
 * not 64 lowercase hex characters all read as `null` (hasher failed). O(1) calls.
 */
function runSha256Hex(sha256Hex: unknown, text: string): string | null {
  if (typeof sha256Hex !== 'function') {
    return null;
  }
  try {
    const digest: unknown = (sha256Hex as Sha256HexFn)(text);
    return typeof digest === 'string' && SHA256_HEX.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

/** Strict UTF-16 code-unit order, with no locale and no normalisation. */
function comparePaths(a: { readonly path: string }, b: { readonly path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** The canonical text the `bundleDigest` is taken over. O(total path length). */
function canonicalLines(entries: readonly BundleManifestEntry[]): string {
  let lines = '';
  for (const e of entries) {
    lines += `${e.path}\n${e.sha256}\n${e.bytes}\n`;
  }
  return lines;
}

interface ReadEntry {
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
}

type EntriesRefusal = Exclude<BuildManifestRefusalReason, 'hasher-failed'>;

type ReadEntriesResult =
  | { readonly ok: true; readonly entries: readonly ReadEntry[] }
  | { readonly ok: false; readonly reason: EntriesRefusal };

/**
 * Validate an untrusted entry list without hashing it: a real array, no more than
 * `MAX_BUNDLE_ENTRIES` (checked on `length` before any element is read), every
 * element a plain object with an own data `path` and `content`. Paths are held in a
 * `Set`, never a plain dictionary, so `__proto__` is an ordinary path.
 * O(N) reads, O(1 MiB) scan per entry, no hasher calls.
 */
function readEntries(entries: unknown): ReadEntriesResult {
  if (!safeIsArray(entries)) {
    return { ok: false, reason: 'invalid-entries' };
  }
  const length = readLength(entries);
  if (length === null) {
    return { ok: false, reason: 'invalid-entries' };
  }
  if (length > MAX_BUNDLE_ENTRIES) {
    return { ok: false, reason: 'too-many-entries' };
  }
  const seen = new Set<string>();
  const read: ReadEntry[] = [];
  for (let i = 0; i < length; i += 1) {
    const item = ownData(entries, i);
    if (item === UNREADABLE || !isPlainObject(item)) {
      return { ok: false, reason: 'invalid-entries' };
    }
    const path = ownData(item, 'path');
    if (!isValidBundlePath(path)) {
      return { ok: false, reason: 'invalid-path' };
    }
    if (seen.has(path)) {
      return { ok: false, reason: 'duplicate-path' };
    }
    seen.add(path);
    const content = ownData(item, 'content');
    if (typeof content !== 'string') {
      return { ok: false, reason: 'content-invalid' };
    }
    const measured = measureUtf8(content);
    if (measured.kind === 'too-large') {
      return { ok: false, reason: 'content-too-large' };
    }
    if (measured.kind === 'malformed') {
      return { ok: false, reason: 'content-invalid' };
    }
    read.push({ path, content, bytes: measured.bytes });
  }
  return { ok: true, entries: read };
}

/** Build the canonical manifest of `entries`, or a typed refusal. Never throws. */
export function buildBundleManifest(
  entries: unknown,
  sha256Hex: Sha256HexFn,
): BuildBundleManifestResult {
  const read = readEntries(entries);
  if (!read.ok) {
    return { ok: false, reason: read.reason };
  }
  const hashed: BundleManifestEntry[] = [];
  for (const entry of read.entries) {
    const sha256 = runSha256Hex(sha256Hex, entry.content);
    if (sha256 === null) {
      return { ok: false, reason: 'hasher-failed' };
    }
    hashed.push({ path: entry.path, sha256, bytes: entry.bytes });
  }
  hashed.sort(comparePaths);
  const bundleDigest = runSha256Hex(sha256Hex, canonicalLines(hashed));
  if (bundleDigest === null) {
    return { ok: false, reason: 'hasher-failed' };
  }
  return {
    ok: true,
    manifest: { schemaVersion: BUNDLE_MANIFEST_SCHEMA_VERSION, entries: hashed, bundleDigest },
  };
}

interface ParsedManifest {
  readonly entries: readonly BundleManifestEntry[];
  readonly bundleDigest: string;
}

/**
 * Validate an untrusted manifest body: at most `MAX_BUNDLE_ENTRIES` dense plain
 * entries with valid, strictly ascending (hence unique) paths, a 64-lowercase-hex
 * `sha256`, a safe-integer `bytes` in 0..1 MiB, and a 64-lowercase-hex
 * `bundleDigest`. O(N) reads and no hasher calls.
 */
function readManifest(manifest: Record<string, unknown>): ParsedManifest | null {
  const list = ownData(manifest, 'entries');
  if (!safeIsArray(list)) {
    return null;
  }
  const length = readLength(list);
  if (length === null || length > MAX_BUNDLE_ENTRIES) {
    return null;
  }
  const parsed: BundleManifestEntry[] = [];
  let previous: string | null = null;
  for (let i = 0; i < length; i += 1) {
    const item = ownData(list, i);
    if (item === UNREADABLE || !isPlainObject(item)) {
      return null;
    }
    const path = ownData(item, 'path');
    const sha256 = ownData(item, 'sha256');
    const bytes = ownData(item, 'bytes');
    if (!isValidBundlePath(path) || (previous !== null && !(previous < path))) {
      return null;
    }
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
      return null;
    }
    if (
      typeof bytes !== 'number' ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > MAX_BUNDLE_CONTENT_BYTES
    ) {
      return null;
    }
    parsed.push({ path, sha256, bytes });
    previous = path;
  }
  const bundleDigest = ownData(manifest, 'bundleDigest');
  if (typeof bundleDigest !== 'string' || !SHA256_HEX.test(bundleDigest)) {
    return null;
  }
  return { entries: parsed, bundleDigest };
}

function manifestInvalid(): VerifyBundleManifestResult {
  return { ok: false, problems: [{ kind: 'manifest-invalid', path: null }] };
}

function compareProblems(a: BundleVerifyProblem, b: BundleVerifyProblem): number {
  const pathA = a.path ?? '';
  const pathB = b.path ?? '';
  if (pathA !== pathB) {
    return pathA < pathB ? -1 : 1;
  }
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}

/**
 * Verify `entries` against `manifest`. Never throws. An unknown `schemaVersion`
 * (an own non-`1` value, or an accessor) is reported alone, before anything else
 * is judged; an absent one reads as `1`. A malformed manifest or bundle is
 * `manifest-invalid`. Otherwise the recomputed `bundleDigest` and each entry are
 * compared and every problem is reported, sorted by path then kind, naming paths
 * only. At most 1 + N hasher calls; O(N log N) in the sorts.
 */
export function verifyBundleManifest(
  manifest: unknown,
  entries: unknown,
  sha256Hex: Sha256HexFn,
): VerifyBundleManifestResult {
  if (!isPlainObject(manifest)) {
    return manifestInvalid();
  }
  let versionDescriptor: PropertyDescriptor | undefined;
  try {
    versionDescriptor = Object.getOwnPropertyDescriptor(manifest, 'schemaVersion');
  } catch {
    return manifestInvalid();
  }
  if (
    versionDescriptor !== undefined &&
    (!('value' in versionDescriptor) ||
      versionDescriptor.value !== BUNDLE_MANIFEST_SCHEMA_VERSION)
  ) {
    return { ok: false, problems: [{ kind: 'unknown-schema-version', path: null }] };
  }
  const parsed = readManifest(manifest);
  const read = readEntries(entries);
  if (parsed === null || !read.ok) {
    return manifestInvalid();
  }
  const recomputed = runSha256Hex(sha256Hex, canonicalLines(parsed.entries));
  if (recomputed === null) {
    return { ok: false, problems: [{ kind: 'hasher-failed', path: null }] };
  }
  const problems: BundleVerifyProblem[] = [];
  if (recomputed !== parsed.bundleDigest) {
    problems.push({ kind: 'digest-mismatch', path: null });
  }
  const listed = new Set<string>();
  for (const expected of parsed.entries) {
    listed.add(expected.path);
  }
  const present = new Map<string, ReadEntry>();
  for (const actual of read.entries) {
    present.set(actual.path, actual);
    if (!listed.has(actual.path)) {
      problems.push({ kind: 'extra', path: actual.path });
    }
  }
  for (const expected of parsed.entries) {
    const actual = present.get(expected.path);
    if (actual === undefined) {
      problems.push({ kind: 'missing', path: expected.path });
      continue;
    }
    const sha256 = runSha256Hex(sha256Hex, actual.content);
    if (sha256 === null) {
      problems.push({ kind: 'hasher-failed', path: expected.path });
    } else if (actual.bytes !== expected.bytes || sha256 !== expected.sha256) {
      problems.push({ kind: 'changed', path: expected.path });
    }
  }
  if (problems.length === 0) {
    return { ok: true };
  }
  return { ok: false, problems: problems.sort(compareProblems) };
}
