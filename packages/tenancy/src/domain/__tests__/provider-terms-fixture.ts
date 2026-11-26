/**
 * Test-only registry-taking core for the provider-terms domain. NEVER
 * exported from any index: only this fixture file constructs registries and
 * takes a `registry` argument, so the production export surface of
 * `@fleet/tenancy` stays closed.
 *
 * Pure domain code; imports only sibling domain guards.
 *
 * Hostile-input rule: every function reads untrusted input once through
 * `snapshotPlainData` (which refuses null, undefined, wrong primitives,
 * accessors without running them, Proxies via the injected detector, array
 * holes, symbol keys, cycles, non-plain prototypes and oversized values with
 * named reasons), then through exact-key checks. Every failure is a typed
 * refusal; the rejected value is never echoed.
 */

import type {
  ProviderSelectabilityDecision,
  ProviderTermsPass,
  ProviderTermsRegistry,
} from "../provider-terms.js";
import type { IsProxy } from "@fleet/shared";
import { snapshotPlainData } from "@fleet/shared";
import { checkSnapshotKeys, hasControlCharacter, isZonedIsoDateTime } from "../entities/record-guards.js";

/** Sized limits for a pass list: up to 64 passes, 3 string fields each. */
const PASS_LIST_LIMITS = {
  maxDepth: 3,
  maxKeys: 3,
  maxArrayLength: 64,
  maxNodes: 512,
  maxStringLength: 4096,
} as const;

/** Sized limits for a whole registry (one extra level of depth). */
const REGISTRY_LIMITS = {
  maxDepth: 4,
  maxKeys: 3,
  maxArrayLength: 64,
  maxNodes: 512,
  maxStringLength: 4096,
} as const;

const PASS_ENTRY_KEYS = new Set(["providerId", "reviewedAtIso", "reviewer"]);
const REGISTRY_KEYS = new Set(["passes"]);

export type ProviderTermsRegistryFixtureResult =
  | { readonly ok: true; readonly registry: ProviderTermsRegistry }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid-passes"
        | "invalid-pass-entry"
        | "invalid-provider-id"
        | "invalid-reviewed-at"
        | "invalid-reviewer";
    };

export type PassEntryCheckResult =
  | { readonly ok: true; readonly pass: ProviderTermsPass }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid-passes"
        | "invalid-pass-entry"
        | "invalid-provider-id"
        | "invalid-reviewed-at"
        | "invalid-reviewer";
    };

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_PROVIDER_ID_LENGTH = 63;
const MAX_REVIEWER_LENGTH = 120;

/** Validate one snapshotted pass entry; returns the typed refusal or null. */
function checkPassEntry(entry: unknown): PassEntryCheckResult {
  if (typeof entry !== "object" || entry === null) {
    return { ok: false, reason: "invalid-pass-entry" };
  }
  const record = entry as Record<string, unknown>;
  const keyRefusal = checkSnapshotKeys(record, PASS_ENTRY_KEYS);
  if (keyRefusal !== null) {
    return { ok: false, reason: "invalid-pass-entry" };
  }
  for (const field of ["providerId", "reviewedAtIso", "reviewer"] as const) {
    if (!Object.hasOwn(record, field)) {
      return {
        ok: false,
        reason:
          field === "providerId"
            ? "invalid-provider-id"
            : field === "reviewedAtIso"
              ? "invalid-reviewed-at"
              : "invalid-reviewer",
      };
    }
  }
  const providerId = record.providerId;
  if (typeof providerId !== "string" || providerId.length < 1 || providerId.length > MAX_PROVIDER_ID_LENGTH || !PROVIDER_ID_PATTERN.test(providerId)) {
    return { ok: false, reason: "invalid-provider-id" };
  }
  const reviewedAtIso = record.reviewedAtIso;
  if (!isZonedIsoDateTime(reviewedAtIso)) {
    return { ok: false, reason: "invalid-reviewed-at" };
  }
  const reviewer = record.reviewer;
  if (
    typeof reviewer !== "string" ||
    reviewer.length < 1 ||
    reviewer.length > MAX_REVIEWER_LENGTH ||
    hasControlCharacter(reviewer)
  ) {
    return { ok: false, reason: "invalid-reviewer" };
  }
  const pass: ProviderTermsPass = {
    providerId,
    reviewedAtIso,
    reviewer,
  };
  return { ok: true, pass };
}

const INDEX_PATH = /^\[\d+\]$/;

/**
 * Map a snapshot refusal on the pass list to its typed reason, per the
 * path-to-reason table: `sparse-array` (path `[i]`) is `invalid-passes`
 * (checked first); an element path `[i]` is `invalid-pass-entry`; a field
 * path `[i].providerId` / `[i].reviewedAtIso` / `[i].reviewer` is that
 * field's typed reason; any other refusal (null or non-array root) is
 * `invalid-passes`.
 */
function mapPassListRefusal(reason: string, path: string | null): ProviderTermsRegistryFixtureResult {
  if (reason === "sparse-array") {
    return { ok: false, reason: "invalid-passes" };
  }
  if (path === null || !path.includes(".")) {
    if (path !== null && INDEX_PATH.test(path)) {
      return { ok: false, reason: "invalid-pass-entry" };
    }
    return { ok: false, reason: "invalid-passes" };
  }
  if (/^\[\d+\]\.providerId$/.test(path)) {
    return { ok: false, reason: "invalid-provider-id" };
  }
  if (/^\[\d+\]\.reviewedAtIso$/.test(path)) {
    return { ok: false, reason: "invalid-reviewed-at" };
  }
  if (/^\[\d+\]\.reviewer$/.test(path)) {
    return { ok: false, reason: "invalid-reviewer" };
  }
  return { ok: false, reason: "invalid-pass-entry" };
}

/**
 * Build a test registry from unknown input. The pass list is snapshotted
 * once; length bounds are refused in O(1) before enumeration, and each pass
 * entry is validated with exact-key checks. Cost bound: O(1) — bounded by
 * `maxArrayLength <= 64`, `maxNodes <= 512`, `maxStringLength <= 4096`.
 */
export function createTestProviderTermsRegistry(
  passes: unknown,
  isProxy?: IsProxy,
): ProviderTermsRegistryFixtureResult {
  const snapshot = snapshotPlainData(passes, isProxy ?? (() => false), PASS_LIST_LIMITS);
  if (!snapshot.ok) {
    return mapPassListRefusal(snapshot.reason, snapshot.path);
  }
  const value = snapshot.value;
  if (!Array.isArray(value)) {
    return { ok: false, reason: "invalid-passes" };
  }
  const out: ProviderTermsPass[] = [];
  for (const entry of value) {
    const checked = checkPassEntry(entry);
    if (!checked.ok) {
      return checked;
    }
    out.push(checked.pass);
  }
  return { ok: true, registry: Object.freeze({ passes: Object.freeze(out) }) };
}

/**
 * Validate a whole registry snapshot once and decide selectability against
 * it. Any snapshot refusal on `registry` (at any path), a missing
 * `passes` key, an invalid pass entry or an invalid `providerId` maps to a
 * typed refusal. Cost bound: O(1) — same sized limits as above, and the pass
 * lookup scans at most 64 validated passes.
 */
export function decideTestProviderSelectability(
  registry: unknown,
  providerId: unknown,
  isProxy?: IsProxy,
): ProviderSelectabilityDecision {
  const snapshot = snapshotPlainData(registry, isProxy ?? (() => false), REGISTRY_LIMITS);
  if (!snapshot.ok) {
    return { selectable: false, reason: "invalid-registry" };
  }
  const value = snapshot.value;
  if (typeof value !== "object" || value === null) {
    return { selectable: false, reason: "invalid-registry" };
  }
  const reg = value as Record<string, unknown>;
  if (!Object.hasOwn(reg, "passes") || checkSnapshotKeys(reg, REGISTRY_KEYS) !== null) {
    return { selectable: false, reason: "invalid-registry" };
  }
  if (!Array.isArray(reg.passes)) {
    return { selectable: false, reason: "invalid-registry" };
  }
  const passes: ProviderTermsPass[] = [];
  for (const entry of reg.passes) {
    const checked = checkPassEntry(entry);
    if (!checked.ok) {
      return { selectable: false, reason: "invalid-registry" };
    }
    passes.push(checked.pass);
  }
  if (typeof providerId !== "string" || providerId.length < 1 || providerId.length > MAX_PROVIDER_ID_LENGTH || !PROVIDER_ID_PATTERN.test(providerId)) {
    return { selectable: false, reason: "invalid-provider-id" };
  }
  for (const pass of passes) {
    if (pass.providerId === providerId) {
      return { selectable: true };
    }
  }
  return { selectable: false, reason: "no-recorded-pass" };
}

/** Boolean form of `decideTestProviderSelectability`; see there for the contract. */
export function isTestProviderSelectable(
  registry: unknown,
  providerId: unknown,
  isProxy?: IsProxy,
): boolean {
  return decideTestProviderSelectability(registry, providerId, isProxy).selectable;
}
