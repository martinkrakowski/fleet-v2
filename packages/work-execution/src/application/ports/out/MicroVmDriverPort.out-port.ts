// @generated outbound contract scaffold — refined for lane FC8D1.
/**
 * MicroVmDriverPort: the per-attempt isolated-environment out-port. An adapter
 * owns a disposable isolated environment (a micro VM or a user-space kernel)
 * for one attempt: create it, inject the attempt's worktree reference into it,
 * seal it before work runs, and destroy it when the attempt ends. Nothing here
 * spawns, opens a socket or names a vendor; every outcome is a typed result
 * with a fixed failure reason, never a throw and never a guessed state.
 */

/** The isolation kinds a driver may declare. Any other value is refused,
 * never silently downgraded to a weaker isolation.
 */
export type MicroVmIsolation = 'microvm' | 'user-space-kernel';

/** Identity of one created environment, bound to its attempt. */
export interface MicroVmHandle {
  readonly environmentId: string;
  readonly attemptId: string;
  readonly isolation: MicroVmIsolation;
}

export type MicroVmDriverFailureReason = 'unavailable' | 'refused' | 'unsupported-isolation';

export type MicroVmCreateResult =
  | { readonly ok: true; readonly handle: MicroVmHandle }
  | { readonly ok: false; readonly reason: MicroVmDriverFailureReason };

export type MicroVmStepResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: MicroVmDriverFailureReason };

export interface MicroVmDriverPort {
  /** Create the isolated environment for one attempt with the declared
   * isolation. An unsupported isolation is refused with
   * `{ ok: false, reason: 'unsupported-isolation' }`.
   */
  create(request: { readonly attemptId: string; readonly isolation: MicroVmIsolation }): Promise<MicroVmCreateResult>;

  /** Inject one worktree reference into the created environment, before sealing. */
  injectWorktree(handle: MicroVmHandle, request: { readonly worktreeRef: string }): Promise<MicroVmStepResult>;

  /** Seal the loaded environment so work can run inside it. */
  seal(handle: MicroVmHandle): Promise<MicroVmStepResult>;

  /** Destroy the environment. Destroying an already destroyed handle is idempotent. */
  destroy(handle: MicroVmHandle): Promise<MicroVmStepResult>;
}
