/**
 * Pure coordination keys and event kinds shared across composition roots.
 */

/** Forge actions fleet may run; `push-to-pr` updates an existing PR's branch and never opens one. */
export const FORGE_ACTION_KINDS = ['push-and-open-pr', 'push-to-pr', 'merge-pr', 'post-status'] as const;
export type ForgeActionKind = (typeof FORGE_ACTION_KINDS)[number];

/** True only for the kinds that push a branch: `push-and-open-pr` and `push-to-pr`. */
export function forgeActionPushesBranch(kind: ForgeActionKind): boolean {
  return kind === 'push-and-open-pr' || kind === 'push-to-pr';
}

/**
 * Why the forge refused an action it was asked to run (auto-merge plan A13, §4).
 * `conflict`: the merge cannot be created cleanly; `protection`: a branch rule,
 * required check or required review blocks it; `permission`: the credential may
 * not do it; `other`: anything unrecognised, which callers treat as a question
 * for the owner, never as a retry.
 */
export const FORGE_REFUSAL_KINDS = ['conflict', 'protection', 'permission', 'other'] as const;
export type ForgeRefusalKind = (typeof FORGE_REFUSAL_KINDS)[number];

/** Deterministic coordination action scope for one forge action kind. */
export function forgeActionScope(kind: ForgeActionKind | string): string {
  return `forge:${kind}`;
}

/** Deterministic consumption identifier for one action. */
export function consumptionId(actionId: string): string {
  return `consumption-${actionId}`;
}

/** Deterministic observation event kind for an execution action and status. */
export function observationEventKind(action: string, status: string): string {
  return `execution:${action}:${status}`;
}

/**
 * C2': the coordination action scope for removing one attempt's unsealed
 * worktree. It binds to the attempt and to the exact worktree path digest (a
 * SHA-256 of the absolute path, computed by the caller), so a different
 * worktree — or a moved path — is a different scope, and no filesystem path
 * is ever placed into coordination state or output.
 */
export function unsealedWorktreeRemovalScope(attemptId: string, worktreePathSha256: string): string {
  return `worktree:remove-unsealed:${attemptId}:${worktreePathSha256}`;
}

/** Deterministic consumption identifier for one unsealed worktree removal. */
export function unsealedWorktreeRemovalActionId(runId: string, attemptId: string): string {
  return `reap-unsealed:${runId}:${attemptId}`;
}
