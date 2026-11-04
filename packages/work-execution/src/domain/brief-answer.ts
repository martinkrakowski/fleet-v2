/**
 * Pure `parseBriefAnswer` and `lintBrief` (cutover plan CO15): the authoring
 * answer split (dispatch/notes) and the brief lint (six checklist items plus
 * the three D7 sections). Pure: no store, no clock, no randomness, no
 * network, no subprocess; neither throws; neither returns a partial result —
 * on a violation the result is a typed refusal and nothing else.
 */

import { LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';

const NOTES_MARKER = '===NOTES===';
const DISPATCH_MARKER = '===DISPATCH===';

export type BriefAnswerViolation =
  | 'not-a-string'
  | 'empty-answer'
  | 'missing-notes-marker'
  | 'duplicate-notes-marker'
  | 'missing-dispatch-marker'
  | 'duplicate-dispatch-marker'
  | 'text-before-notes-marker'
  | 'notes-after-dispatch'
  | 'empty-dispatch'
  | 'secret-shaped';

export type ParseBriefAnswerResult =
  | { readonly ok: true; readonly dispatch: string; readonly notes: string }
  | { readonly ok: false; readonly reason: BriefAnswerViolation };

/**
 * CO15: split one authoring answer into its dispatch text (the brief a lane
 * receives) and its notes text (candidate notes). Every way the old shell
 * script could exit 3 becomes a typed violation, never a throw and never a
 * partial answer. The notes text can never appear in the dispatch text: the
 * dispatch text is only what follows the `===DISPATCH===` marker.
 */
export function parseBriefAnswer(answer: unknown): ParseBriefAnswerResult {
  if (typeof answer !== 'string') {
    return { ok: false, reason: 'not-a-string' };
  }
  if (answer.trim().length === 0) {
    return { ok: false, reason: 'empty-answer' };
  }

  const lines = answer.split('\n');

  const notesMarkers: number[] = [];
  const dispatchMarkers: number[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === NOTES_MARKER) {
      notesMarkers.push(index);
    }
    if (trimmed === DISPATCH_MARKER) {
      dispatchMarkers.push(index);
    }
  });

  if (notesMarkers.length === 0) {
    return { ok: false, reason: 'missing-notes-marker' };
  }
  if (notesMarkers.length > 1) {
    return { ok: false, reason: 'duplicate-notes-marker' };
  }
  if (dispatchMarkers.length === 0) {
    return { ok: false, reason: 'missing-dispatch-marker' };
  }
  if (dispatchMarkers.length > 1) {
    return { ok: false, reason: 'duplicate-dispatch-marker' };
  }

  const notesIndex = notesMarkers[0];
  const dispatchIndex = dispatchMarkers[0];

  // Marker layout: the notes marker must come before the dispatch marker. An
  // answer whose dispatch marker precedes its notes marker is refused here,
  // before the leading-text check, so the marker order violation reports
  // `notes-after-dispatch` rather than `text-before-notes-marker`.
  if (notesIndex > dispatchIndex) {
    return { ok: false, reason: 'notes-after-dispatch' };
  }

  const firstNonBlank = lines.find((line) => line.trim().length > 0);
  if (firstNonBlank === undefined || firstNonBlank.trim() !== NOTES_MARKER) {
    return { ok: false, reason: 'text-before-notes-marker' };
  }

  const notes = stripOuterBlank(lines.slice(notesIndex + 1, dispatchIndex));
  const dispatch = stripOuterBlank(lines.slice(dispatchIndex + 1));

  if (dispatch.length === 0) {
    return { ok: false, reason: 'empty-dispatch' };
  }

  if (textContainsSecretShape(answer)) {
    return { ok: false, reason: 'secret-shaped' };
  }

  return { ok: true, dispatch, notes };
}

/** Join block lines after dropping leading and trailing blank lines. */
function stripOuterBlank(blockLines: readonly string[]): string {
  let start = 0;
  let end = blockLines.length;
  while (start < end) {
    const line = blockLines[start];
    if (line === undefined || line.trim().length !== 0) {
      break;
    }
    start += 1;
  }
  while (end > start) {
    const line = blockLines[end - 1];
    if (line === undefined || line.trim().length !== 0) {
      break;
    }
    end -= 1;
  }
  return blockLines.slice(start, end).join('\n');
}

/**
 * Scan against the full lane-diff registry (S2): the 17 named patterns the
 * lane diff check uses, not the narrower legacy `SECRET_PATTERNS` set. A
 * token shape only in the broader registry must still be refused.
 */
function textContainsSecretShape(text: string): boolean {
  return LANE_DIFF_SECRET_PATTERNS.some((entry) => entry.regex.test(text));
}

export interface BriefLintFinding {
  readonly rule: string; // the rule name below
  readonly label: string; // the required heading label; '' for 'not-a-brief' and 'secret-shaped'
}

export interface BriefLintResult {
  readonly ok: boolean;
  readonly findings: readonly BriefLintFinding[];
}

interface Heading {
  readonly line: number;
  readonly text: string;
}

interface RequiredSection {
  readonly rule: string;
  readonly label: string;
}

/** The six checklist items plus the three D7 sections, in findings order. */
const REQUIRED_SECTIONS: readonly RequiredSection[] = [
  { rule: 'missing-file-list', label: 'File list' },
  { rule: 'missing-commands', label: 'Commands' },
  { rule: 'missing-tier', label: 'Tier' },
  { rule: 'missing-size-line', label: 'Size' },
  { rule: 'missing-commit-line', label: 'Commit' },
  { rule: 'missing-validity-block', label: 'Validity' },
  { rule: 'missing-hard-to-undo', label: 'Hard to undo' },
  { rule: 'missing-assumptions', label: 'Assumptions' },
  { rule: 'missing-challenge-this', label: 'Challenge this' },
];

const HEADING_RE = /^\s{0,3}#{1,6}\s+(.+)$/;

/** The checklist items the plan names as lines, which an inline line may satisfy. */
const INLINE_LABELS: ReadonlySet<string> = new Set(['tier', 'size', 'commit']);

/**
 * Normalise a heading's captured text: trimmed, trailing `#` characters
 * removed, internal whitespace collapsed to single spaces, lower-cased.
 */
function normalizeHeadingText(raw: string): string {
  return raw.trim().replace(/#+$/, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** True when some heading with the label has a non-blank line before the next heading. */
function sectionHasBody(headings: readonly Heading[], lines: readonly string[], label: string): boolean {
  const target = label.toLowerCase();
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    if (heading === undefined || heading.text !== target) {
      continue;
    }
    const bodyStart = heading.line + 1;
    const bodyEnd = i + 1 < headings.length ? (headings[i + 1]?.line ?? lines.length) : lines.length;
    for (let j = bodyStart; j < bodyEnd; j += 1) {
      const line = lines[j];
      if (line !== undefined && line.trim().length > 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * True when a line satisfies the inline form of a checklist item: the item's
 * label (case-insensitive) followed by a colon or whitespace and a value, as
 * in `Tier: 1`, `Size: about 45 minutes`, or the compact authoring line
 * `Tier 1. Size: about 45 minutes, one commit.` — where the commit item
 * appears as a phrase ending in the label word. A bare label with no value
 * does not count.
 */
function lineIsInlineItem(rawLine: string, label: string): boolean {
  const content = rawLine.replace(/^#{0,6}\s*/, '').trim();
  const word = label.toLowerCase().replace(/[^a-z]/g, '');
  if (word.length === 0) {
    return false;
  }
  // `Tier: 1` / `Size: about 45 minutes` — label, colon, value.
  if (new RegExp(`(^|\\s)${word}\\s*:\\s*\\S`, 'i').test(content)) {
    return true;
  }
  // `Tier 1` — label, whitespace, value.
  if (new RegExp(`(^|\\s)${word}\\s+\\S`, 'i').test(content)) {
    return true;
  }
  // `one commit.` — a phrase ending in the label word.
  return new RegExp(`(^|\\s)\\S+\\s+${word}[.!?]*\\s*$`, 'i').test(content);
}

/**
 * CO15: refuse a brief that is missing a required section — the six checklist
 * items and the three D7 sections. It returns findings; it never throws. The
 * `secret-shaped` finding comes first when the brief carries a secret shape,
 * and the heading checks still run so it is never the only finding by itself.
 * Tier, Size, and Commit — the three items the plan names as lines — are also
 * satisfied by an inline line, so a brief carrying them without headings is
 * not rejected as missing those sections.
 */
export function lintBrief(brief: unknown): BriefLintResult {
  const findings: BriefLintFinding[] = [];

  if (typeof brief !== 'string') {
    return { ok: false, findings: [{ rule: 'not-a-brief', label: '' }] };
  }

  if (textContainsSecretShape(brief)) {
    findings.push({ rule: 'secret-shaped', label: '' });
  }

  const lines = brief.split('\n');
  const headings: Heading[] = [];
  lines.forEach((line, index) => {
    const match = HEADING_RE.exec(line);
    if (match) {
      headings.push({ line: index, text: normalizeHeadingText(match[1]) });
    }
  });

  for (const section of REQUIRED_SECTIONS) {
    if (sectionHasBody(headings, lines, section.label)) {
      continue;
    }
    if (INLINE_LABELS.has(section.label.toLowerCase()) && lines.some((line) => lineIsInlineItem(line, section.label))) {
      continue;
    }
    findings.push({ rule: section.rule, label: section.label });
  }

  return { ok: findings.length === 0, findings };
}
