// Implemented for lane K5b (decision-kernel plan, 2026-10-16, §5).
/**
 * ClaimTriagePort: ask the decision kernel one bounded triage judgement per
 * candidate claim of one attempt, in as few requests as the state caps allow.
 * Advisory only — an answer may attach an escalation `triageFlag` to an
 * undecided candidate (through the repository's write-once `setTriageFlag`)
 * and may order the disposition queue, but it may never dispose, accept,
 * reject, defer, change the policy guard or drop a candidate. `unknown`
 * always means no flag and capture order.
 *
 * "Recorded or not made": every batch request reserves this month's budget in
 * the receipt journal before the provider is contacted and is settled before
 * any answer from it is used, so a paid call is never invisible to the
 * budget.
 */

import type { KnowledgeTriageFlag } from "../../../domain/knowledge-records.js";

/** One candidate claim as sent to the triage provider: declared fields only. */
export interface TriageCandidateClaim {
  readonly id: string;
  readonly claimText: string;
}

export interface TriageAttemptQuery {
  /** The attempt the candidates were captured from; names the `contextRef`. */
  readonly attemptId: string;
  /** The project the attempt belongs to; a disabled project is never triaged. */
  readonly projectId: string;
  /** The attempt's declared path prefixes, sent with the claim text. */
  readonly pathPrefixes: readonly string[];
  /** The attempt's captured candidate claims, in capture order. */
  readonly candidates: readonly TriageCandidateClaim[];
}

/**
 * Successful advice: one flag per advised candidate id and one reuse score
 * per scored candidate id (in [0,1], most reusable last in the queue first).
 * Both maps are advice only; the caller writes flags through the repository
 * and never changes a disposition because of them.
 */
export interface AdvisedClaimTriage {
  readonly status: "advised";
  /** The `contextRef` every request of this attempt settled under. */
  readonly contextRef: string;
  readonly flags: Readonly<Record<string, KnowledgeTriageFlag>>;
  readonly scores: Readonly<Record<string, number>>;
}

export type ClaimTriageUnknownReason =
  | "not-configured"
  | "timeout"
  | "transport"
  | "shape"
  | "redaction-refused"
  | "budget"
  | "low-confidence";

/** Unknown advice: no flag for any candidate of this attempt. */
export interface UnknownClaimTriage {
  readonly status: "unknown";
  readonly reason: ClaimTriageUnknownReason;
  /** The `contextRef` a settled (unknown) receipt carries; absent otherwise. */
  readonly contextRef?: string;
}

export type ClaimTriageAdvice = AdvisedClaimTriage | UnknownClaimTriage;

export interface ClaimTriagePort {
  /** Triage one attempt's candidates; unknown never throws. */
  triageAttempt(query: TriageAttemptQuery): Promise<ClaimTriageAdvice>;
}
