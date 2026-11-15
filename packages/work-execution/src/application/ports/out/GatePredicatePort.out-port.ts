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
/**
 * Why a command verdict is `unknown` without being the command's own result:
 * `gate-slot-wait-limit` is host congestion (exit 75 with the fixed gate-slot
 * stderr line); `resource-exhausted` is the OS or cgroup killing the command
 * (exit 137 SIGKILL or 143 SIGTERM).
 */
export type GatePredicateCause = 'gate-slot-wait-limit' | 'resource-exhausted';

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
   * Set only when an `unknown` command verdict is not the command's own
   * result (KF-30c): `gate-slot-wait-limit` is host congestion (exit 75 with
   * the fixed gate-slot stderr line); `resource-exhausted` is the command
   * terminated by the OS or cgroup with exit 137 (SIGKILL) or 143 (SIGTERM).
   * Any other result omits it.
   */
  readonly cause?: GatePredicateCause;
  /** Commands with a coverage declaration that ran. */
  readonly coverage?: CheckCoverage;
  /**
   * PT1a: on a failing command, the screened repo-relative file its output names, or null when
   * none could be determined. Absent on every other result. Never command output.
   */
  readonly failingFile?: string | null;
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
