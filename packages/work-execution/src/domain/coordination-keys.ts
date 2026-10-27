/**
 * Pure coordination keys and event kinds shared across composition roots.
 */

export type ForgeActionKind = 'push-and-open-pr' | 'merge-pr';

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
