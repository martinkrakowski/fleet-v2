/**
 * Pure provider-terms registry with an empty recorded pass list (FC15A).
 *
 * Provider selection stays closed until a reviewed pass is recorded. In
 * production the pass list is the frozen, empty `RECORDED_PROVIDER_PASSES`,
 * so `isProviderSelectable` and `decideProviderSelectability` refuse every
 * valid provider id with `{ selectable: false, reason: "no-recorded-pass" }`.
 *
 * No exported symbol of `@fleet/tenancy` accepts a registry or pass list at
 * runtime: both exported functions are bound directly to
 * `DEFAULT_PROVIDER_TERMS_REGISTRY`. The registry-taking core used by fixture
 * tests lives only under `__tests__/provider-terms-fixture.ts`, outside the
 * generated barrel.
 *
 * Pure domain code: no Node, filesystem, subprocess, network, clock or
 * randomness imports; no console logging. Hostile-input rule: null,
 * undefined, non-strings, Proxies (via the injected detector), empty,
 * oversized and malformed provider ids are each refused with a typed result,
 * never a throw, never a pass, and a rejected value is never echoed.
 *
 * Cost bounds: the proxy check runs only for object inputs inside try/catch;
 * the string length check precedes the regex test — O(1). The pass lookup
 * scans `RECORDED_PROVIDER_PASSES`, bounded by the fixture's 64-pass limit —
 * O(1) here (an empty array).
 */

import type { IsProxy } from "@fleet/shared";

/** One reviewed pass: a provider id plus its review record. */
export type ProviderTermsPass = {
  readonly providerId: string;
  readonly reviewedAtIso: string;
  readonly reviewer: string;
};

/** The reviewed pass registry: the only source of selectable providers. */
export type ProviderTermsRegistry = {
  readonly passes: readonly ProviderTermsPass[];
};

export type ProviderSelectabilityRefusalReason =
  | "invalid-registry"
  | "invalid-provider-id"
  | "no-recorded-pass";

export type ProviderSelectabilityDecision =
  | { readonly selectable: true }
  | {
      readonly selectable: false;
      readonly reason: ProviderSelectabilityRefusalReason;
    };

/** Every provider pass recorded so far. Production starts closed. */
export const RECORDED_PROVIDER_PASSES: readonly ProviderTermsPass[] = Object.freeze([]);

/** The frozen production registry, bound into the exported deciders. */
export const DEFAULT_PROVIDER_TERMS_REGISTRY: ProviderTermsRegistry = Object.freeze({
  passes: RECORDED_PROVIDER_PASSES,
});

/** A provider id is the same shape as an organization/project id. */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_PROVIDER_ID_LENGTH = 63;

/**
 * Validate an untrusted provider id. Returns null when it is valid,
 * otherwise the typed refusal reason. Never echoes the rejected value.
 * Cost bound: O(1) — one optional detector call in try/catch, one length
 * check before the regex test.
 */
function validateProviderId(providerId: unknown, isProxy?: IsProxy): "invalid-provider-id" | null {
  if (isProxy !== undefined && typeof providerId === "object" && providerId !== null) {
    try {
      if (isProxy(providerId)) {
        return "invalid-provider-id";
      }
    } catch {
      return "invalid-provider-id";
    }
  }
  if (typeof providerId !== "string") {
    return "invalid-provider-id";
  }
  if (providerId.length < 1 || providerId.length > MAX_PROVIDER_ID_LENGTH) {
    return "invalid-provider-id";
  }
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    return "invalid-provider-id";
  }
  return null;
}

/**
 * Decide whether a provider may be selected, against
 * `DEFAULT_PROVIDER_TERMS_REGISTRY`. A valid id with no recorded pass is
 * refused with `"no-recorded-pass"`; a malformed one with
 * `"invalid-provider-id"`.
 */
export function decideProviderSelectability(
  providerId: unknown,
  isProxy?: IsProxy,
): ProviderSelectabilityDecision {
  const idRefusal = validateProviderId(providerId, isProxy);
  if (idRefusal !== null) {
    return { selectable: false, reason: idRefusal };
  }
  for (const pass of DEFAULT_PROVIDER_TERMS_REGISTRY.passes) {
    if (pass.providerId === providerId) {
      return { selectable: true };
    }
  }
  return { selectable: false, reason: "no-recorded-pass" };
}

/** Boolean convenience wrapper over `decideProviderSelectability`. */
export function isProviderSelectable(providerId: unknown, isProxy?: IsProxy): boolean {
  return decideProviderSelectability(providerId, isProxy).selectable;
}
