/**
 * Classification of a review finding's citation against an index of the
 * candidate diff. A finding that cites nothing, or cites a file (or line) the
 * diff never touched, cannot be acted on or refuted — but the reviewer seat has
 * no way to tell it apart from a real one until a finding's citation is checked
 * here. Pure: no clock, no I/O, no mutation of the inputs.
 */

/** Sentinel returned by `ownData` when a data value is unreadable. */
const UNREADABLE = Symbol('unreadable');

/** Caps mirror sibling constants in `review-answer-schema.ts` and `failing-file.ts`. */
export const MAX_CITATION_FINDINGS = 100; // MAX_STRUCTURED_FINDINGS
export const MAX_CITATION_PATH_LENGTH = 500; // MAX_FINDING_FILE_LENGTH
export const MAX_CITATION_FINDING_ID_LENGTH = 200; // FAILING_FILE_MAX_LENGTH
export const MAX_CITATION_DIFF_FILES = 2000;
export const MAX_CITATION_DIFF_LINES = 20000;

/** One changed file in the candidate diff and the lines the diff touches in it. */
export interface DiffCitationFile {
  readonly path: string;
  readonly lineCount: number;
  readonly lines: readonly number[];
}

export interface DiffCitationIndex {
  readonly files: readonly DiffCitationFile[];
}

export type FindingCitationClass =
  | 'cited'
  | 'no-file'
  | 'file-not-in-diff'
  | 'line-not-in-diff'
  | 'line-past-end';

export type CitationRefusalReason =
  | 'malformed-finding'
  | 'malformed-diff'
  | 'budget-exhausted';

export type ClassifyFindingCitationResult =
  | { readonly ok: true; readonly value: FindingCitationClass }
  | { readonly ok: false; readonly reason: CitationRefusalReason };

export type UncitedFindingIdsResult =
  | { readonly ok: true; readonly value: readonly string[] }
  | { readonly ok: false; readonly reason: CitationRefusalReason };

/** A value is a plain object (prototype `Object.prototype` or `null`, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
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
 * accessor: a throwing or accessor-shaped getter reads as `UNREADABLE`. Never
 * throws.
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

/**
 * Path comparison is exact string equality after stripping one leading `'./'`.
 * Nothing else is resolved or normalised. `'a/b.ts'` and `'./a/b.ts'` name the
 * same file; `'a/b.ts'` and `'/a/b.ts'` do not.
 */
function normalizedPath(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path;
}

/** A `line` counts only when it is a positive safe integer. */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

interface CitationIndexEntry {
  readonly lineCount: number;
  readonly lines: ReadonlySet<number>;
}

type BuildCitationIndexResult =
  | { readonly ok: true; readonly paths: ReadonlyMap<string, CitationIndexEntry> }
  | { readonly ok: false; readonly reason: CitationRefusalReason };

/** One walk over the diff builds the path index, or returns a refusal. */
function buildCitationIndex(diff: unknown): BuildCitationIndexResult {
  if (!isPlainObject(diff)) {
    return { ok: false, reason: 'malformed-diff' };
  }
  const files = ownData(diff, 'files');
  if (files === UNREADABLE || !Array.isArray(files)) {
    return { ok: false, reason: 'malformed-diff' };
  }
  if (files.length > MAX_CITATION_DIFF_FILES) {
    return { ok: false, reason: 'budget-exhausted' };
  }

  const paths = new Map<string, { lineCount: number; lines: Set<number> }>();
  let totalLines = 0;

  for (let i = 0; i < files.length; i += 1) {
    const file = ownData(files, i);
    if (file === UNREADABLE || !isPlainObject(file)) {
      return { ok: false, reason: 'malformed-diff' };
    }
    const path = ownData(file, 'path');
    if (typeof path !== 'string' || path.length > MAX_CITATION_PATH_LENGTH) {
      return { ok: false, reason: 'malformed-diff' };
    }
    const lineCount = ownData(file, 'lineCount');
    if (!isPositiveSafeInteger(lineCount)) {
      return { ok: false, reason: 'malformed-diff' };
    }
    const lines = ownData(file, 'lines');
    if (lines === UNREADABLE || !Array.isArray(lines)) {
      return { ok: false, reason: 'malformed-diff' };
    }
    if (totalLines + lines.length > MAX_CITATION_DIFF_LINES) {
      return { ok: false, reason: 'budget-exhausted' };
    }
    totalLines += lines.length;

    const lineSet = new Set<number>();
    for (let j = 0; j < lines.length; j += 1) {
      const line = ownData(lines, j);
      if (line === UNREADABLE || !isPositiveSafeInteger(line)) {
        return { ok: false, reason: 'malformed-diff' };
      }
      lineSet.add(line);
    }

    const key = normalizedPath(path);
    const existing = paths.get(key);
    if (existing === undefined) {
      paths.set(key, { lineCount, lines: lineSet });
    } else {
      if (existing.lineCount !== lineCount) {
        return { ok: false, reason: 'malformed-diff' };
      }
      for (const line of lineSet) {
        existing.lines.add(line);
      }
    }
  }

  return { ok: true, paths };
}

type FilePathResolution =
  | { readonly kind: 'refusal'; readonly reason: CitationRefusalReason }
  | { readonly kind: 'no-file' }
  | { readonly kind: 'path'; readonly path: string };

/** Validate a finding's shape and resolve its `filePath`, or refuse it. */
function resolveFilePath(finding: unknown): FilePathResolution {
  if (!isPlainObject(finding)) {
    return { kind: 'refusal', reason: 'malformed-finding' };
  }
  const filePath = ownData(finding, 'filePath');
  if (filePath === UNREADABLE) {
    return { kind: 'refusal', reason: 'malformed-finding' };
  }
  if (filePath === null) {
    return { kind: 'no-file' };
  }
  if (typeof filePath !== 'string') {
    return { kind: 'refusal', reason: 'malformed-finding' };
  }
  if (filePath.length > MAX_CITATION_PATH_LENGTH) {
    return { kind: 'refusal', reason: 'malformed-finding' };
  }
  if (filePath.trim() === '') {
    return { kind: 'no-file' };
  }
  return { kind: 'path', path: filePath };
}

/** Classify one already-validated finding against an already-built index. */
function classifyAgainstIndex(
  finding: unknown,
  paths: ReadonlyMap<string, CitationIndexEntry>,
): ClassifyFindingCitationResult {
  const resolved = resolveFilePath(finding);
  if (resolved.kind === 'refusal') {
    return { ok: false, reason: resolved.reason };
  }
  if (resolved.kind === 'no-file') {
    return { ok: true, value: 'no-file' };
  }

  const entry = paths.get(normalizedPath(resolved.path));
  if (entry === undefined) {
    return { ok: true, value: 'file-not-in-diff' };
  }

  const line = ownData(finding, 'line');
  if (line === UNREADABLE) {
    return { ok: false, reason: 'malformed-finding' };
  }
  if (!isPositiveSafeInteger(line)) {
    return { ok: true, value: 'line-not-in-diff' };
  }
  if (line > entry.lineCount) {
    return { ok: true, value: 'line-past-end' };
  }
  if (entry.lines.has(line)) {
    return { ok: true, value: 'cited' };
  }
  return { ok: true, value: 'line-not-in-diff' };
}

export function classifyFindingCitation(
  finding: unknown,
  diff: unknown,
): ClassifyFindingCitationResult {
  const resolved = resolveFilePath(finding);
  if (resolved.kind === 'refusal') {
    return { ok: false, reason: resolved.reason };
  }
  if (resolved.kind === 'no-file') {
    return { ok: true, value: 'no-file' };
  }

  const indexResult = buildCitationIndex(diff);
  if (!indexResult.ok) {
    return { ok: false, reason: indexResult.reason };
  }
  return classifyAgainstIndex(finding, indexResult.paths);
}

/** The ids of every finding whose class is not 'cited', in input order. */
export function uncitedFindingIds(
  findings: unknown,
  diff: unknown,
): UncitedFindingIdsResult {
  if (!Array.isArray(findings)) {
    return { ok: false, reason: 'malformed-finding' };
  }
  if (findings.length > MAX_CITATION_FINDINGS) {
    return { ok: false, reason: 'budget-exhausted' };
  }
  for (let i = 0; i < findings.length; i += 1) {
    if (ownData(findings, i) === UNREADABLE) {
      return { ok: false, reason: 'malformed-finding' };
    }
  }

  const indexResult = buildCitationIndex(diff);
  if (!indexResult.ok) {
    return { ok: false, reason: indexResult.reason };
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < findings.length; i += 1) {
    const entry = ownData(findings, i);
    const findingId = ownData(entry, 'findingId');
    if (
      typeof findingId !== 'string' ||
      findingId.length < 1 ||
      findingId.length > MAX_CITATION_FINDING_ID_LENGTH
    ) {
      return { ok: false, reason: 'malformed-finding' };
    }
    const classified = classifyAgainstIndex(entry, indexResult.paths);
    if (!classified.ok) {
      return { ok: false, reason: classified.reason };
    }
    if (classified.value !== 'cited' && !seen.has(findingId)) {
      seen.add(findingId);
      ids.push(findingId);
    }
  }
  return { ok: true, value: ids };
}
