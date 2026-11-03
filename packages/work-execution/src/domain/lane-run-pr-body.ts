/**
 * The conductor's PR body, rendered purely from records (plan §3.5, §5, D7):
 * the title comes from the work order and the body from the run's journal
 * facts and the brief package's frozen D7 sections. Never lane output, never
 * reviewer text beyond reviewer model names, verdicts and finding counts and
 * severities. No attribution footer. Pure: nothing throws, nothing reads
 * stores, clocks or the forge.
 */

import { containsSecretShape } from '@fleet/shared';

import type { LaneRunTier } from './lane-run-records.js';
import type { LaneRunReviewKind } from './lane-run-review-facts.js';

/** The review rounds a PR body may name, one line each (counts and severities only). */
export interface LaneRunPrBodyReview {
  readonly kind: LaneRunReviewKind;
  readonly reviewerModel: string;
  readonly round: number;
  readonly verdict: 'passed' | 'failed' | 'no-receipt' | 'unknown';
  readonly findingCounts: {
    readonly blocker: number;
    readonly major: number;
    readonly minor: number;
    readonly nit: number;
  };
}

/** The frozen D7 sections carried by the brief package; all three are required. */
export interface LaneRunPrBodyFrozen {
  readonly hardToUndo: string;
  readonly assumptions: string;
  readonly challengeThis: string;
}

/**
 * GB1: one carried minor from a minors-only brief-check override receipt.
 * Severity, file path and line only — never a finding summary or reviewer
 * prose.
 */
export interface LaneRunCarriedMinor {
  readonly severity: 'minor' | 'nit';
  readonly filePath: string | null;
  readonly line: number | null;
}

export interface RenderPrBodyInput {
  readonly workOrderId: string;
  readonly title: string;
  readonly tier: LaneRunTier;
  readonly runId: string;
  readonly rounds: number;
  readonly gate: 'passed';
  readonly reviews: readonly LaneRunPrBodyReview[];
  readonly frozen: LaneRunPrBodyFrozen;
  /** GB1: the minors carried into the Challenge section; absent or empty renders the body unchanged. */
  readonly carriedMinors?: readonly LaneRunCarriedMinor[];
}

/** The PR body refusals: the D7 note refusal, the secret-shape refusal, the size refusal. */
export type RenderPrBodyRefusalReason = 'missing-pr-notes' | 'secret-shaped' | 'too-long' | 'invalid-review';

export type RenderPrBodyResult =
  | { readonly ok: true; readonly title: string; readonly body: string }
  | { readonly ok: false; readonly reason: RenderPrBodyRefusalReason };

/** The PR body's hard size cap: a longer body refuses with `too-long`. */
export const LANE_RUN_PR_BODY_MAX_CHARS = 60_000 as const;

const FINDING_COUNT_LABELS = ['blocker', 'major', 'minor', 'nit'] as const;
const REVIEW_KINDS: readonly string[] = ['brief-check', 'code-review', 'pre-merge'];
const REVIEW_VERDICTS: readonly string[] = ['passed', 'failed', 'no-receipt', 'unknown'];

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Every value interpolated into a proof line is allow-listed or a non-negative integer; nothing else reaches the body. */
function isRenderableReview(review: LaneRunPrBodyReview): boolean {
  return (
    REVIEW_KINDS.includes(review.kind) &&
    REVIEW_VERDICTS.includes(review.verdict) &&
    isCount(review.round) &&
    typeof review.findingCounts === 'object' &&
    review.findingCounts !== null &&
    FINDING_COUNT_LABELS.every((label) => isCount(review.findingCounts[label]))
  );
}

function findingCountsLine(counts: LaneRunPrBodyReview['findingCounts']): string {
  const parts: string[] = [];
  for (const label of FINDING_COUNT_LABELS) {
    const value = counts[label];
    if (value > 0) {
      parts.push(`${label} ${value}`);
    }
  }
  return parts.length === 0 ? 'no findings' : parts.join(', ');
}

/** GB1: a carried minor's `filePath` is null or a repository-relative path: 1–300 chars, no empty, `.` or `..` components. */
const CARRIED_PATH_PATTERN = /^[A-Za-z0-9._@+/-]+$/;

function isCarriedFilePath(filePath: unknown): filePath is string | null {
  if (filePath === null) {
    return true;
  }
  if (typeof filePath !== 'string' || filePath.length < 1 || filePath.length > 300) {
    return false;
  }
  if (!CARRIED_PATH_PATTERN.test(filePath)) {
    return false;
  }
  return filePath.split('/').every((component) => component.length > 0 && component !== '.' && component !== '..');
}

function isCarriedLine(line: unknown): line is number | null {
  return line === null || (typeof line === 'number' && Number.isSafeInteger(line) && line >= 1);
}

/** A carried minor renders only when its severity, path and line are all in shape; anything else refuses. */
function isCarriedMinor(entry: unknown): entry is LaneRunCarriedMinor {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }
  const record = entry as Record<string, unknown>;
  return (
    (record.severity === 'minor' || record.severity === 'nit') &&
    isCarriedFilePath(record.filePath) &&
    isCarriedLine(record.line)
  );
}

/**
 * GB1: one Challenge-section line per carried minor, in input order, using the
 * entry's actual severity. A null path renders `(no path)`; a null line omits
 * the `:<line>` suffix.
 */
function carriedMinorLines(minors: readonly LaneRunCarriedMinor[]): string[] {
  const lines: string[] = [];
  for (const minor of minors) {
    if (minor.filePath === null) {
      lines.push(`- [${minor.severity}] (no path)`);
      continue;
    }
    if (minor.line === null) {
      lines.push(`- [${minor.severity}] ${minor.filePath}`);
      continue;
    }
    lines.push(`- [${minor.severity}] ${minor.filePath}:${minor.line}`);
  }
  return lines;
}

export function renderPrBody(input: RenderPrBodyInput): RenderPrBodyResult {
  const hardToUndo = typeof input.frozen?.hardToUndo === 'string' ? input.frozen.hardToUndo : '';
  const assumptions = typeof input.frozen?.assumptions === 'string' ? input.frozen.assumptions : '';
  const challengeThis = typeof input.frozen?.challengeThis === 'string' ? input.frozen.challengeThis : '';

  // D7: the brief package's frozen sections are mandatory; an empty one refuses.
  if (hardToUndo.trim().length === 0 || assumptions.trim().length === 0 || challengeThis.trim().length === 0) {
    return { ok: false, reason: 'missing-pr-notes' };
  }

  if (!isCount(input.rounds) || !input.reviews.every(isRenderableReview)) {
    return { ok: false, reason: 'invalid-review' };
  }

  // GB1: every carried minor must be in shape; an invalid entry refuses.
  if (input.carriedMinors !== undefined && !input.carriedMinors.every(isCarriedMinor)) {
    return { ok: false, reason: 'invalid-review' };
  }

  // Every string the caller declares is checked for secret shape (§5: records only).
  const declared: string[] = [
    input.workOrderId, input.title, input.runId,
    hardToUndo, assumptions, challengeThis,
  ];
  for (const review of input.reviews) {
    declared.push(review.reviewerModel);
  }
  // GB1: a carried path is reviewer-shaped data and is secret-scanned too.
  for (const minor of input.carriedMinors ?? []) {
    if (typeof minor.filePath === 'string') {
      declared.push(minor.filePath);
    }
  }
  for (const value of declared) {
    if (typeof value === 'string' && containsSecretShape(value)) {
      return { ok: false, reason: 'secret-shaped' };
    }
  }

  const whatLines: string[] = [
    '## What',
    '',
    input.title,
    '',
    `Work order: ${input.workOrderId}`,
    `Run: ${input.runId}`,
  ];

  const proofLines: string[] = [
    '## Proof',
    '',
    `Tier ${input.tier}; gate passed; rounds ${input.rounds}.`,
  ];
  for (const review of input.reviews) {
    proofLines.push(
      `- ${review.kind} round ${review.round}: ${review.verdict} (${findingCountsLine(review.findingCounts)}) — ${review.reviewerModel}`,
    );
  }

  // GB1: the carried minors join the Challenge section after its paragraph;
  // without them the body is byte-identical to the pre-GB1 rendering.
  const challengeTail: string[] = carriedMinorLines(input.carriedMinors ?? []);

  const body = [
    ...whatLines,
    '',
    ...proofLines,
    '',
    '## Hard to undo',
    '',
    hardToUndo,
    '',
    '## Assumptions',
    '',
    assumptions,
    '',
    '## Challenge this',
    '',
    challengeThis,
    ...challengeTail,
    '',
  ].join('\n');

  if (body.length > LANE_RUN_PR_BODY_MAX_CHARS) {
    return { ok: false, reason: 'too-long' };
  }

  return { ok: true, title: input.title, body };
}
