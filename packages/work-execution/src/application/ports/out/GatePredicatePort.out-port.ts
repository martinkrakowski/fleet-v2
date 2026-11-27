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
 * Why a command verdict is `unknown` without being the command's own result,
 * or why a `fail` is a typed host-side classification rather than the
 * command's own verdict: `gate-slot-wait-limit` is host congestion (exit 75
 * with the fixed gate-slot stderr line); `resource-exhausted` is the OS or
 * cgroup killing the command (exit 137 SIGKILL or 143 SIGTERM);
 * `environment-not-installed` is the worktree's dependencies being missing
 * (no `node_modules/.yarn-state.yml` and a failed or ineffective `yarn
 * install --immutable`), or a command whose output names a missing module
 * while the state file is absent. `missing-generated-types` is a failing
 * `typecheck` whose worktree host probe confirms the generated Next.js
 * types (`apps/web/.next/types`) are absent — a generated-artifact gap, not
 * a source error. `lint-arch-timeout` is a `lint:arch` command whose
 * executor reports the typed `errorCode: 'timeout'` — the architecture
 * budget, not a finding.
 */
export type GatePredicateCause =
  | 'gate-slot-wait-limit'
  | 'resource-exhausted'
  | 'environment-not-installed'
  | 'missing-generated-types'
  | 'lint-arch-timeout';

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
   * Set only when a command verdict is not the command's own unclassified
   * result (KF-30c and TP5A1): `gate-slot-wait-limit` is host congestion (exit 75 with
   * the fixed gate-slot stderr line); `resource-exhausted` is the command
   * terminated by the OS or cgroup with exit 137 (SIGKILL) or 143 (SIGTERM);
   * `environment-not-installed` is the worktree's dependencies missing (no
   * `node_modules/.yarn-state.yml` after one bounded `yarn install
   * --immutable`, or a missing-module failure while the state file is
   * absent); `missing-generated-types` is a failing `typecheck` whose host
   * probe confirms `apps/web/.next/types` is absent (verdict `fail`);
   * `lint-arch-timeout` is a `lint:arch` command the executor classified as
   * `errorCode: 'timeout'` (verdict `fail`). Any other result omits it.
   */
  readonly cause?: GatePredicateCause;
  /** Commands with a coverage declaration that ran. */
  readonly coverage?: CheckCoverage;
  /**
   * PT1a: on a failing command, the screened repo-relative file its output names, or null when
   * none could be determined. Absent on every other result. Never command output.
   */
  readonly failingFile?: string | null;
  /**
   * GD2: the bounded, secret-redacted tail of combined stdout and stderr.
   * On a failing command this is the command's own tail (last 32 KiB / 200
   * lines). On `environment-not-installed` it is the failed install's tail
   * bounded to 4 KiB, or the command's own tail when a missing-module failure
   * was reclassified while the dependency state file was absent. Empty or
   * whitespace-only streams omit it. Absent on pass, skipped, and on unknown
   * results that are not this environment failure (including other congestion).
   * Never part of the journal detail: when the predicate's verdict is `fail`
   * — a failing command, or an `environment-not-installed` result the
   * acceptance use case has classified as a persistent install failure — the
   * tail is archived through the evidence archive and only its `evidence://`
   * reference is journalled.
   */
  readonly outputTail?: string;
  /**
   * GD2: reference to the archived failed output tail (`evidence://…`), set
   * by the acceptance use case on a journalled failing predicate when
   * archiving succeeded. Absent when no archive is wired, the archive fails
   * or the predicate is not a failing command.
   */
  readonly outputEvidenceRef?: string;
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
