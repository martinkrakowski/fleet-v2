/**
 * Classification of a review finding's citation against an index of the
 * candidate diff. A finding that cites nothing, or cites a file (or line) the
 * diff never touched, cannot be acted on or refuted — but the reviewer seat has
 * no way to tell it apart from a real one until a finding's citation is checked
 * here. Pure: no clock, no I/O, no mutation of the inputs.
 */

import type { ReviewFindingRecord } from './evidence-records.js';

/** One changed file in the candidate diff and the lines the diff touches in it. */
export interface DiffCitationFile {
  readonly path: string;
  readonly lines: readonly number[];
}

export interface DiffCitationIndex {
  readonly files: readonly DiffCitationFile[];
}

export type FindingCitationClass =
  | 'cited'
  | 'no-file'
  | 'file-not-in-diff'
  | 'line-not-in-diff';

/**
 * Path comparison is exact string equality after stripping one leading `'./'`.
 * Nothing else is resolved or normalised. `'a/b.ts'` and `'./a/b.ts'` name the
 * same file; `'a/b.ts'` and `'/a/b.ts'` do not.
 */
function normalizedPath(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path;
}

/** A `line` counts only when it is a positive safe integer. */
function isPositiveSafeInteger(value: number | null): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function classifyFindingCitation(
  finding: ReviewFindingRecord,
  diff: DiffCitationIndex,
): FindingCitationClass {
  const { filePath, line } = finding;

  // `'no-file'` when the citation is absent or blank, whatever the line is.
  if (filePath === null || filePath.trim() === '') {
    return 'no-file';
  }

  const targetPath = normalizedPath(filePath);
  const matchingFiles = diff.files.filter((file) => normalizedPath(file.path) === targetPath);

  // The file is not among the diff's changed files.
  if (matchingFiles.length === 0) {
    return 'file-not-in-diff';
  }

  // A null, zero, negative, fractional, NaN or infinite line is no line, and a
  // file alone does not locate a finding.
  if (!isPositiveSafeInteger(line)) {
    return 'line-not-in-diff';
  }

  // When the diff names the same path twice, a line in either entry counts.
  const lineInDiff = matchingFiles.some((file) => file.lines.includes(line));
  return lineInDiff ? 'cited' : 'line-not-in-diff';
}

/** The ids of every finding whose class is not 'cited', in input order. */
export function uncitedFindingIds(
  findings: readonly ReviewFindingRecord[],
  diff: DiffCitationIndex,
): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    if (classifyFindingCitation(finding, diff) !== 'cited' && !seen.has(finding.findingId)) {
      seen.add(finding.findingId);
      ids.push(finding.findingId);
    }
  }
  return ids;
}
