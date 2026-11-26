/**
 * Pure provider-terms registry guard. Provider selection stays closed until a
 * reviewed pass is recorded; in production `RECORDED_PROVIDER_PASSES` is an
 * empty frozen array, so every valid provider id refuses with
 * `no-recorded-pass` until the registry is populated by a reviewed pass.
 *
 * The registry-taking core for fixture testing lives only under
 * `__tests__/provider-terms-fixture.ts`, outside the generated barrel: no
 * exported symbol of `@fleet/tenancy` accepts a registry or pass list at
 * runtime.
 *
 * Pure domain code: no Node, filesystem, subprocess, network, clock or
 * randomness imports; no console logging.
 *
 * Hostile-input rule (every public function): null, undefined, non-strings,
 * oversized strings and (through the optional injected `isProxy` detector) a
 * Proxy are each refused with a typed reason, never a throw and never a pass.
 * A rejected value is never echoed into a refusal, error or log.
 *
 * Cost bounds: the `providerId` length is checked before the regex — O(1);
 * the pass lookup scans at most `RECORDED_PROVIDER_PASSES.length` entries
 * (bounded by the registry's fixed size) — O(1).
 */

export type ProviderTermsPass = {
  readonly providerId: string;
  readonly reviewedAtIso: string;
  readonly reviewer: string;
};

export type ProviderTermsRegistry = {
  readonly passes: readonly ProviderTermsPass[];
};

export type ProviderSelectabilityRefusalReason =
  | "invalid-registry"
  | "invalid-provider-id"
  | "no-recorded-pass";

export type ProviderSelectabilityDecision =
  | { readonly selectable: true }
  | { readonly selectable: false; readonly reason: ProviderSelectabilityRefusalReason };

/** Every pass recorded so far. Empty until a reviewed pass is registered. */
export const RECORDED_PROVIDER_PASSES: readonly ProviderTermsPass[] = Object.freeze([]);

/**
 * The production registry: a frozen literal over the recorded passes. No
 * private factory exists in production code; the test-only factory lives in
 * `__tests__/provider-terms-fixture.ts`.
 */
export const DEFAULT_PROVIDER_TERMS_REGISTRY: ProviderTermsRegistry = Object.freeze({
  passes: RECORDED_PROVIDER_PASSES,
});

/** One provider id: lower-case alphanumerics and dashes, 1..63 characters. */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_PROVIDER_ID_LENGTH = 63;

import type { IsProxy } from "@fleet/shared";

/**
 * Validate a provider id. The length is checked before the regex. When
 * `isProxy` is supplied, a Proxy-shaped input is detected inside a try/catch
 * before any other read. Cost bound: O(1).
 */
function checkProviderId(providerId: unknown, isProxy?: IsProxy): boolean {
  if (isProxy !== undefined) {
    try {
      if (typeof providerId === "object" && providerId !== null && isProxy(providerId)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  if (typeof providerId !== "string") {
    return false;
  }
  if (providerId.length < 1 || providerId.length > MAX_PROVIDER_ID_LENGTH) {
    return false;
  }
  return PROVIDER_ID_PATTERN.test(providerId);
}

/**
 * Decide whether a provider may be selected against
 * `DEFAULT_PROVIDER_TERMS_REGISTRY`. Bound directly to the default registry:
 * no exported function accepts a registry or pass list at runtime.
 */
export function decideProviderSelectability(
  providerId: unknown,
  isProxy?: IsProxy,
): ProviderSelectabilityDecision {
  if (!checkProviderId(providerId, isProxy)) {
    return { selectable: false, reason: "invalid-provider-id" };
  }
  const passes = DEFAULT_PROVIDER_TERMS_REGISTRY.passes;
  for (const pass of passes) {
    if (pass.providerId === providerId) {
      return { selectable: true };
    }
  }
  return { selectable: false, reason: "no-recorded-pass" };
}

/** Boolean form of `decideProviderSelectability`; see there for the contract. */
export function isProviderSelectable(providerId: unknown, isProxy?: IsProxy): boolean {
  return decideProviderSelectability(providerId, isProxy).selectable;
}
