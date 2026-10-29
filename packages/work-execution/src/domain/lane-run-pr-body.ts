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

export interface RenderPrBodyInput {
  readonly workOrderId: string;
  readonly title: string;
  readonly tier: LaneRunTier;
  readonly runId: string;
  readonly rounds: number;
  readonly gate: 'passed';
  readonly reviews: readonly LaneRunPrBodyReview[];
  readonly frozen: LaneRunPrBodyFrozen;
}

/** The PR body refusals: the D7 note refusal, the secret-shape refusal, the size refusal. */
export type RenderPrBodyRefusalReason = 'missing-pr-notes' | 'secret-shaped' | 'too-long';

export type RenderPrBodyResult =
  | { readonly ok: true; readonly title: string; readonly body: string }
  | { readonly ok: false; readonly reason: RenderPrBodyRefusalReason };

/** The PR body's hard size cap: a longer body refuses with `too-long`. */
export const LANE_RUN_PR_BODY_MAX_CHARS = 60_000 as const;

const FINDING_COUNT_LABELS = ['blocker', 'major', 'minor', 'nit'] as const;

function findingCountsLine(counts: LaneRunPrBodyReview['findingCounts']): string {
  const parts: string[] = [];
  for (const label of FINDING_COUNT_LABELS) {
    const value = counts[label];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      parts.push(`${label} ${value}`);
    }
  }
  return parts.length === 0 ? 'no findings' : parts.join(', ');
}

export function renderPrBody(input: RenderPrBodyInput): RenderPrBodyResult {
  const hardToUndo = typeof input.frozen?.hardToUndo === 'string' ? input.frozen.hardToUndo : '';
  const assumptions = typeof input.frozen?.assumptions === 'string' ? input.frozen.assumptions : '';
  const challengeThis = typeof input.frozen?.challengeThis === 'string' ? input.frozen.challengeThis : '';

  // D7: the brief package's frozen sections are mandatory; an empty one refuses.
  if (hardToUndo.trim().length === 0 || assumptions.trim().length === 0 || challengeThis.trim().length === 0) {
    return { ok: false, reason: 'missing-pr-notes' };
  }

  // Every string the caller declares is checked for secret shape (§5: records only).
  const declared: string[] = [
    input.workOrderId, input.title, input.runId,
    hardToUndo, assumptions, challengeThis,
  ];
  for (const review of input.reviews) {
    declared.push(review.reviewerModel);
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
    '',
  ].join('\n');

  if (body.length > LANE_RUN_PR_BODY_MAX_CHARS) {
    return { ok: false, reason: 'too-long' };
  }

  return { ok: true, title: input.title, body };
}
