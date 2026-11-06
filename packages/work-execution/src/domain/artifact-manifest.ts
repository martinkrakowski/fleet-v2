// Domain (pure): the sealed artifact manifest written into `.lane/` after
// artifact collection. A manifest is a fact about the collected files: their
// paths, sizes and SHA-256 digests, with totals, serialised in a fixed key
// order. No filesystem, no subprocess, no Node builtins: the module only
// shapes and validates JSON text (ADR-0054 forbids Node builtins in the
// domain, so hashing and file reads live in the infrastructure adapter).

import { snapshotPlainDataRecord } from './plain-record-reads.js';
import { validateWorktreeRelativePath } from './worktree-path.js';

export const ARTIFACT_MANIFEST_SCHEMA_VERSION = 1;

/** C2': the reap refusal reason when no artifact manifest was ever sealed. */
export const ARTIFACTS_NOT_COLLECTED_REASON = 'artifacts not collected' as const;

/** C2': the reap refusal reason when collected artifacts changed after sealing. */
export const ARTIFACTS_CHANGED_REASON = 'artifacts changed since collection' as const;

/** C2': the largest manifest text (characters) any read or parse will accept. */
export const MAX_ARTIFACT_MANIFEST_CHARS = 524_288 as const;

/** C2': the largest number of file entries a manifest may list. */
export const MAX_ARTIFACT_MANIFEST_FILES = 2_048 as const;

/**
 * C2': the content-addressed sealed-manifest worktree-relative path, the exact
 * form `artifactManifestRelativePath` writes: the embedded 16-hex slice is the
 * first 16 characters of the manifest's SHA-256 digest, so the path is bound
 * to the recorded digest without any free-text path in coordination state.
 */
export const SEALED_MANIFEST_PATH_PATTERN = /^\.lane\/artifacts-manifest-([0-9a-f]{16})\.json$/;

export const ARTIFACT_MANIFEST_RELATIVE_PATH = '.lane/artifacts-manifest.json';

export const ARTIFACT_MANIFEST_TEMP_RELATIVE_PATH = '.lane/artifacts-manifest.json.tmp';

/**
 * Build the content-addressed worktree-relative path for a sealed artifact
 * manifest from its SHA-256 hex digest:
 * `.lane/artifacts-manifest-<first 16 hex>.json`. Falls back to
 * `ARTIFACT_MANIFEST_RELATIVE_PATH` when no digest is supplied.
 *
 * Older collected-artifact records that lack `manifestPath` are read as
 * "artifacts not collected" for C2.
 */
export function artifactManifestRelativePath(manifestSha256?: string): string {
  if (typeof manifestSha256 === 'string' && manifestSha256.length >= 16) {
    return `.lane/artifacts-manifest-${manifestSha256.slice(0, 16)}.json`;
  }
  return ARTIFACT_MANIFEST_RELATIVE_PATH;
}

/**
 * Build the unique temporary worktree-relative path for atomically sealing an
 * artifact manifest: `<manifestPath>.tmp-<random 8 hex>`.
 */
export function artifactManifestTempRelativePath(
  manifestRelativePath: string,
  randomHex8: string,
): string {
  return `${manifestRelativePath}.tmp-${randomHex8}`;
}

export interface ArtifactManifestEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ArtifactManifest {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly files: readonly ArtifactManifestEntry[];
  readonly total: { readonly files: number; readonly bytes: number };
}

export type ObservedArtifact =
  | { readonly path: string; readonly state: 'file'; readonly size: number; readonly sha256: string }
  | { readonly path: string; readonly state: 'absent' }
  | { readonly path: string; readonly state: 'not-a-file' };

export type ArtifactManifestMismatchKind =
  | 'absent'
  | 'not-a-file'
  | 'size'
  | 'sha256'
  | 'manifest-invalid'
  | 'manifest-changed'
  | 'attempt-id';

export interface ArtifactManifestMismatch {
  readonly path: string;
  readonly kind: ArtifactManifestMismatchKind;
}

export type ArtifactManifestVerdict =
  | { readonly outcome: 'sealed'; readonly manifest: ArtifactManifest }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'mismatch'; readonly mismatches: readonly ArtifactManifestMismatch[] };

/** Plain string comparison (not locale) for sorting manifest entries by path. */
function comparePaths(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Build a manifest from collected entries: copies each entry, sorts by path
 * and computes the totals. The result is a fresh object, never the caller's
 * input references.
 */
export function buildArtifactManifest(
  attemptId: string,
  entries: readonly ArtifactManifestEntry[],
): ArtifactManifest {
  const files = entries
    .map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256 }))
    .sort((x, y) => comparePaths(x.path, y.path));
  const bytes = files.reduce((sum, entry) => sum + entry.size, 0);
  return {
    schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
    attemptId,
    files,
    total: { files: files.length, bytes },
  };
}

/** Serialise the manifest as pretty JSON with a trailing newline, in key order. */
export function serializeArtifactManifest(manifest: ArtifactManifest): string {
  const text = JSON.stringify(
    {
      schemaVersion: manifest.schemaVersion,
      attemptId: manifest.attemptId,
      files: manifest.files.map((entry) => ({
        path: entry.path,
        size: entry.size,
        sha256: entry.sha256,
      })),
      total: { files: manifest.total.files, bytes: manifest.total.bytes },
    },
    null,
    2,
  );
  return text + '\n';
}

/**
 * Parse and validate manifest text. Returns null unless the text is a valid
 * manifest: a plain object with schema version 1, a non-empty attempt id,
 * an array of file entries whose paths are contained worktree-relative
 * paths with non-negative safe integer sizes and 64-lowercase-hex digests,
 * no duplicate paths, and totals matching the entries. The returned manifest
 * is always rebuilt via `buildArtifactManifest`, never the raw parsed object.
 */
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function parseArtifactManifest(text: string): ArtifactManifest | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_ARTIFACT_MANIFEST_CHARS) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== ARTIFACT_MANIFEST_SCHEMA_VERSION) {
    return null;
  }
  if (
    typeof obj.attemptId !== 'string' ||
    obj.attemptId.length === 0 ||
    obj.attemptId.length > 128 ||
    obj.attemptId.includes('/') ||
    obj.attemptId.includes('\0')
  ) {
    return null;
  }
  if (!Array.isArray(obj.files) || obj.files.length > MAX_ARTIFACT_MANIFEST_FILES) {
    return null;
  }
  // A sparse array (holes) is not a manifest: an indexed loop proves every
  // index is an own property, so a hole can never masquerade as an entry.
  for (let index = 0; index < obj.files.length; index += 1) {
    if (!Object.hasOwn(obj.files, index)) {
      return null;
    }
  }
  const entries: ArtifactManifestEntry[] = [];
  const seenPaths = new Set<string>();
  for (const item of obj.files) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return null;
    }
    const file = item as Record<string, unknown>;
    if (validateWorktreeRelativePath(file.path) !== null) {
      return null;
    }
    const pathValue = file.path as string;
    if (seenPaths.has(pathValue)) {
      return null;
    }
    seenPaths.add(pathValue);
    if (typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0) {
      return null;
    }
    if (typeof file.sha256 !== 'string' || !SHA256_HEX.test(file.sha256)) {
      return null;
    }
    entries.push({ path: pathValue, size: file.size, sha256: file.sha256 });
  }
  if (typeof obj.total !== 'object' || obj.total === null || Array.isArray(obj.total)) {
    return null;
  }
  const total = obj.total as Record<string, unknown>;
  if (total.files !== entries.length || total.bytes !== entries.reduce((sum, entry) => sum + entry.size, 0)) {
    return null;
  }
  return buildArtifactManifest(obj.attemptId, entries);
}

/**
 * Compare a manifest against observed artifacts. Returns `sealed` when every
 * listed file is present as a regular file with the recorded size and digest;
 * otherwise `mismatch` with one entry per failing file, in manifest order.
 */
export function compareArtifactManifest(
  manifest: ArtifactManifest,
  observed: readonly ObservedArtifact[],
): ArtifactManifestVerdict {
  const observedByPath = new Map<string, ObservedArtifact>();
  for (const entry of observed) {
    observedByPath.set(entry.path, entry);
  }
  const mismatches: ArtifactManifestMismatch[] = [];
  for (const entry of manifest.files) {
    const current = observedByPath.get(entry.path);
    if (current === undefined || current.state === 'absent') {
      mismatches.push({ path: entry.path, kind: 'absent' });
      continue;
    }
    if (current.state === 'not-a-file') {
      mismatches.push({ path: entry.path, kind: 'not-a-file' });
      continue;
    }
    if (current.size !== entry.size) {
      mismatches.push({ path: entry.path, kind: 'size' });
      continue;
    }
    if (current.sha256 !== entry.sha256) {
      mismatches.push({ path: entry.path, kind: 'sha256' });
      continue;
    }
  }
  if (mismatches.length === 0) {
    return { outcome: 'sealed', manifest };
  }
  return { outcome: 'mismatch', mismatches };
}

/**
 * C2': where the sealed manifest of an attempt lives and which digest it must
 * still carry, read from the attempt's collected-artifact record. Pure: every
 * property is snapshotted through `snapshotPlainDataRecord`, so throwing
 * getters or hostile Proxy traps answer `uncollected` instead of throwing.
 * `sealed` requires a content-addressed `manifestPath` whose embedded digest
 * slice matches `manifestSha256` (a 64-lowercase-hex digest); anything else
 * — including a missing field — is `uncollected`.
 */
export type AttemptManifestCoordinates =
  | {
      readonly kind: 'sealed';
      readonly manifestPath: string;
      readonly expectedManifestSha256: string;
    }
  | { readonly kind: 'uncollected' };

export function attemptManifestCoordinates(artifacts: unknown): AttemptManifestCoordinates {
  let snapshot: Record<string, unknown> | null;
  try {
    snapshot = snapshotPlainDataRecord(artifacts);
  } catch {
    return { kind: 'uncollected' };
  }
  if (snapshot === null) {
    return { kind: 'uncollected' };
  }
  const manifestPath = snapshot['manifestPath'];
  const manifestSha256 = snapshot['manifestSha256'];
  if (typeof manifestPath !== 'string' || typeof manifestSha256 !== 'string') {
    return { kind: 'uncollected' };
  }
  if (!/^[0-9a-f]{64}$/.test(manifestSha256)) {
    return { kind: 'uncollected' };
  }
  const match = SEALED_MANIFEST_PATH_PATTERN.exec(manifestPath);
  if (match === null || match[1] !== manifestSha256.slice(0, 16)) {
    return { kind: 'uncollected' };
  }
  return { kind: 'sealed', manifestPath, expectedManifestSha256: manifestSha256 };
}
