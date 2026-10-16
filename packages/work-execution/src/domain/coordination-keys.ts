/**
 * Pure coordination keys and event kinds shared across composition roots.
 */

export type ForgeActionKind = 'push-and-open-pr' | 'merge-pr';

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
