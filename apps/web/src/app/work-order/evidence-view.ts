/**
 * Pure view helpers for head evidence rendering. No React, no imports from
 * server loaders except types.
 */

import type {
  AssessmentState,
  CoverageView,
  EvidenceResult,
  ReviewTallyView,
} from "./map-evidence";

export function resultTone(
  result: EvidenceResult,
): "accepted" | "failed" | "queued" | "unknown" | "ended" {
  switch (result) {
    case "pass":
      return "accepted";
    case "fail":
      return "failed";
    case "pending":
      return "queued";
    case "unknown":
      return "unknown";
    case "not-applicable":
      return "ended";
  }
}

export function assessmentTone(
  state: AssessmentState,
): "accepted" | "blocked" | "failed" | "queued" | "unknown" {
  switch (state) {
    case "accepted":
      return "accepted";
    case "blocked":
      return "blocked";
    case "rejected":
      return "failed";
    case "pending":
      return "queued";
    case "stale":
      return "unknown";
  }
}

export function coverageText(coverage: CoverageView | null): string {
  if (coverage === null) {
    return "coverage not recorded";
  }
  if (coverage.ran) {
    return `covered ${coverage.units} ${coverage.unitKind}`;
  }
  return `did not run: ${coverage.reason}`;
}

export function tallyText(tally: ReviewTallyView | null): string {
  if (tally === null) {
    return "review tally not recorded";
  }
  const base = `review tally: ${tally.pass} pass · ${tally.fail} fail · ${tally.unknown} unknown`;
  return tally.disagreement ? `${base} · reviewers disagree` : base;
}

export function kindText(kind: string | null): string {
  return kind === null ? "kind not recorded" : kind;
}

export function listText(items: readonly string[], none: string): string {
  return items.length === 0 ? none : items.join(", ");
}
