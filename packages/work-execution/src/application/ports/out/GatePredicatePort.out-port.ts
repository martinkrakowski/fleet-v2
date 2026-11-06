// The gate port of plan S2: predicates are data from the frozen manifest;
// model reports are never an input; results carry no command output.
/**
 * GatePredicatePort evaluates a frozen acceptance spec on an attempt's
 * worktree host. The spec is data frozen into the brief manifest, never
 * anything a model reported: the commit predicate checks the candidate head
 * and a clean tree, the diff-check predicate runs the lane diff check with
 * the frozen allowed path prefixes, and each command predicate runs a fixed
 * argv with its declared coverage. A command never runs after the commit or
 * diff-check predicate did not pass (it is reported skipped). With more than
 * one declared gate slot the commands
 * run concurrently under the host's slot budget (KS3); with one they run in
 * order and the first non-pass skips the rest. Results come back in
 * declared order, each as that predicate really ended, and the gate's verdict
 * is decided from the first non-pass in declared order. Results carry no
 * command output.
 */

import type { CheckCoverage } from '@fleet/evidence-and-acceptance';
import type { AttemptRunnerRecord } from '../../../domain/execution-records.js';
import type { AcceptanceSpecProps } from '../../../domain/value-objects/AcceptanceSpec.vo.js';

export type GatePredicateKind = 'commit' | 'diff-check' | 'command';
export type GatePredicateVerdict = 'pass' | 'fail' | 'unknown' | 'skipped';

export interface GatePredicateResult {
  /** 'commit', 'diff-check', or 'command <n>: <argv joined by spaces, cut to 120 characters>'. */
  readonly name: string;
  readonly kind: GatePredicateKind;
  readonly verdict: GatePredicateVerdict;
  /** Commands only; null for other kinds, for a skipped command and for a run with no exit code. */
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** One short line; never command output. */
  readonly detail: string;
  /**
   * Set only by the gate-slot congestion branch (KF-30c): an `unknown`
   * command verdict whose run exited 75 with the fixed gate-slot wait-limit
   * stderr line. Any other result omits it.
   */
  readonly cause?: 'gate-slot-wait-limit';
  /** Commands with a coverage declaration that ran. */
  readonly coverage?: CheckCoverage;
}

export interface EvaluateGatePredicatesRequest {
  readonly attemptId: string;
  readonly worktreePath: string;
  readonly runner: AttemptRunnerRecord | null;
  readonly baseCommit: string;
  readonly candidateHeadSha: string;
  readonly allowedPathPrefixes: readonly string[];
  readonly spec: AcceptanceSpecProps;
}

export type EvaluateGatePredicatesResult =
  | { readonly outcome: 'evaluated'; readonly results: readonly GatePredicateResult[] }
  | { readonly outcome: 'unavailable'; readonly reason: string };

export interface GatePredicatePort {
  evaluateGatePredicates(request: EvaluateGatePredicatesRequest): Promise<EvaluateGatePredicatesResult>;
}
