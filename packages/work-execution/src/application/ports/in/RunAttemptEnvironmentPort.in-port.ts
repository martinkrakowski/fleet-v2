/**
 * RunAttemptEnvironmentPort: the inbound contract that drives one attempt
 * through its per-attempt environment lifecycle against a micro-VM driver:
 * an implementation environment (create, inject the worktree, seal, optional
 * work, destroy) and then a FRESH gate environment with a distinct
 * environment id (create, inject the worktree, seal, gate, destroy). Every
 * failure is a typed refusal with a fixed reason; no rejected value is ever
 * echoed. The result declares its isolation label as `declared` and carries
 * the disclaimer below: this lane runs against the fake driver only.
 */

import type { MicroVmIsolation } from '../out/MicroVmDriverPort.out-port.js';

export const DISCLAIMER =
  'A green run against the fake micro-VM driver is NOT evidence of isolation: the fake driver provides no real virtual machine, kernel or network boundary, so nothing here verifies containment of any kind.';

/** What the result says about isolation: a declaration, never a verification. */
export type DeclaredIsolationLabel = { readonly source: 'declared'; readonly label: 'fake-driver' };

export interface RunAttemptEnvironmentRequest {
  readonly attemptId: string;
  readonly worktreeRef: string;
  readonly isolation: MicroVmIsolation;
  readonly nowIso: string;
}

export type RunAttemptEnvironmentFailureReason =
  | 'invalid-input'
  | 'invalid-attempt-id'
  | 'invalid-worktree-ref'
  | 'unsupported-isolation'
  | 'invalid-now-iso'
  | 'unavailable'
  | 'create-failed'
  | 'inject-failed'
  | 'seal-failed'
  | 'work-failed'
  | 'gate-failed'
  | 'environment-id-reused';

export type RunAttemptEnvironmentResult =
  | {
      readonly ok: true;
      readonly attemptId: string;
      readonly implementationEnvironmentId: string;
      readonly gateEnvironmentId: string;
      readonly isolation: DeclaredIsolationLabel;
      readonly disclaimer: typeof DISCLAIMER;
    }
  | {
      readonly ok: false;
      readonly reason: RunAttemptEnvironmentFailureReason;
      readonly isolation: DeclaredIsolationLabel;
      readonly disclaimer: typeof DISCLAIMER;
    };

export interface RunAttemptEnvironmentPort {
  /** Takes `unknown` because the request crosses a trust boundary; it is snapshotted before any field is read. */
  execute(request: unknown): Promise<RunAttemptEnvironmentResult>;
}
