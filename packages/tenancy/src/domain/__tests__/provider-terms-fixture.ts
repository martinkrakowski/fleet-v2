/**
 * Test-only registry-taking core for the provider-terms domain unit
 * (FC15A). Never exported from any index: the generated barrel must not
 * carry a registry- or pass-list-taking symbol. Fixture tests import it
 * directly from this file.
 *
 * Every untrusted input is read once through `snapshotPlainData` from
 * `@fleet/shared` (with `isProxy` injected by the caller, exactly as
 * infrastructure callers must do), then key-checked via `checkSnapshotKeys`
 * and `Object.hasOwn`. No getter, Proxy trap, sparse hole, symbol key,
 * prototype-polluting key, non-plain prototype, enormous array or oversized
 * string passes; each is refused with a typed reason, never a throw, and no
 * rejected value is ever echoed.
 *
 * Cost bounds: array length and string length are checked before
 * `Reflect.ownKeys` or traversal, so enormous arrays (> 64) and oversized
 * strings (> 4096) are refused in O(1); total traversal is bounded by
 * maxDepth <= 4, maxArrayLength <= 64, maxKeys <= 3, maxNodes <= 512,
 * maxStringLength <= 4096 — O(1) bounded. Field checks are length-capped
 * before regex or character scans — O(1).
 */

import { snapshotPlainData, type IsProxy } from "@fleet/shared";

import {
  checkSnapshotKeys,
  hasControlCharacter,
  isZonedIsoDateTime,
} from "../entities/record-guards.js";
import type {
  ProviderSelectabilityDecision,
  ProviderTermsPass,
  ProviderTermsRegistry,
} from "../provider-terms.js";

const MAX_PASSES = 64;
const MAX_PASS_FIELDS = 3;
const MAX_REGISTRY_DEPTH = 4;
const MAX_PASSES_DEPTH = 3;
const MAX_NODES = 512;
const MAX_STRING_LENGTH = 4096;
const MAX_REVIEWER_LENGTH = 120;

const PASS_KEYS = new Set(["providerId", "reviewedAtIso", "reviewer"]);
const REGISTRY_KEYS = new Set(["passes"]);

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_PROVIDER_ID_LENGTH = 63;

const INDEX_PATH = /^\[\d+\]$/;

export type TestRegistryRefusalReason =
  | "invalid-passes"
  | "invalid-pass-entry"
  | "invalid-provider-id"
  | "invalid-reviewed-at"
  | "invalid-reviewer";

export type TestRegistryResult =
  | { readonly ok: true; readonly registry: ProviderTermsRegistry }
  | { readonly ok: false; readonly reason: TestRegistryRefusalReason };

/**
 * Validate an already-snapshotted pass element. Returns the typed refusal
 * reason, or null when every field is valid. Cost bound: O(1) — one
 * bounded key pass over at most 3 own keys plus length-capped field checks.
 */
function validatePassEntry(entry: Record<string, unknown>): TestRegistryRefusalReason | null {
  const keyRefusal = checkSnapshotKeys(entry, PASS_KEYS);
  if (keyRefusal !== null) {
    return "invalid-pass-entry";
  }
  if (!Object.hasOwn(entry, "providerId")) {
    return "invalid-provider-id";
  }
  if (!Object.hasOwn(entry, "reviewedAtIso")) {
    return "invalid-reviewed-at";
  }
  if (!Object.hasOwn(entry, "reviewer")) {
    return "invalid-reviewer";
  }
  const providerId = entry.providerId;
  if (
    typeof providerId !== "string" ||
    providerId.length < 1 ||
    providerId.length > MAX_PROVIDER_ID_LENGTH ||
    !PROVIDER_ID_PATTERN.test(providerId)
  ) {
    return "invalid-provider-id";
  }
  if (!isZonedIsoDateTime(entry.reviewedAtIso)) {
    return "invalid-reviewed-at";
  }
  const reviewer = entry.reviewer;
  if (
    typeof reviewer !== "string" ||
    reviewer.length < 1 ||
    reviewer.length > MAX_REVIEWER_LENGTH ||
    hasControlCharacter(reviewer)
  ) {
    return "invalid-reviewer";
  }
  return null;
}

/**
 * Map a snapshot refusal on the `passes` root (or its elements) to the
 * typed refusal reason per the path-to-reason table. `sparse-array` is
 * checked first so an array hole maps to `invalid-passes`, not
 * `invalid-pass-entry`.
 */
function mapPassesSnapshotRefusal(
  reason: string,
  path: string | null,
): TestRegistryRefusalReason {
  if (reason === "sparse-array") {
    return "invalid-passes";
  }
  if (path === null) {
    return "invalid-passes";
  }
  if (INDEX_PATH.test(path)) {
    return "invalid-pass-entry";
  }
  if (path.endsWith(".providerId")) {
    return "invalid-provider-id";
  }
  if (path.endsWith(".reviewedAtIso")) {
    return "invalid-reviewed-at";
  }
  if (path.endsWith(".reviewer")) {
    return "invalid-reviewer";
  }
  return "invalid-passes";
}

/**
 * Build a frozen test registry from untrusted `passes`, reading it once
 * through `snapshotPlainData` with the sized limits for this unit. Every
 * hostile shape maps to a typed refusal reason, never a throw.
 */
export function createTestProviderTermsRegistry(
  passes: unknown,
  isProxy?: IsProxy,
): TestRegistryResult {
  const snapshot = snapshotPlainData(passes, isProxy ?? (() => false), {
    maxDepth: MAX_PASSES_DEPTH,
    maxKeys: MAX_PASS_FIELDS,
    maxArrayLength: MAX_PASSES,
    maxNodes: MAX_NODES,
    maxStringLength: MAX_STRING_LENGTH,
  });
  if (!snapshot.ok) {
    return { ok: false, reason: mapPassesSnapshotRefusal(snapshot.reason, snapshot.path) };
  }
  const value = snapshot.value;
  if (value === null || !Array.isArray(value)) {
    return { ok: false, reason: "invalid-passes" };
  }
  const validated: ProviderTermsPass[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: "invalid-pass-entry" };
    }
    const record = entry as Record<string, unknown>;
    const refusal = validatePassEntry(record);
    if (refusal !== null) {
      return { ok: false, reason: refusal };
    }
    validated.push({
      providerId: record.providerId as string,
      reviewedAtIso: record.reviewedAtIso as string,
      reviewer: record.reviewer as string,
    });
  }
  return {
    ok: true,
    registry: Object.freeze({ passes: Object.freeze(validated) }),
  };
}

/**
 * Validate an untrusted provider id; the same shape rules as the
 * production decider. Cost bound: O(1) — one optional detector call in
 * try/catch, one length check before the regex test.
 */
function validateProviderId(providerId: unknown, isProxy?: IsProxy): boolean {
  if (isProxy !== undefined && typeof providerId === "object" && providerId !== null) {
    try {
      if (isProxy(providerId)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return (
    typeof providerId === "string" &&
    providerId.length >= 1 &&
    providerId.length <= MAX_PROVIDER_ID_LENGTH &&
    PROVIDER_ID_PATTERN.test(providerId)
  );
}

/**
 * Decide selectability against an untrusted fixture registry. The registry
 * is snapshotted once; any refusal (including a sparse hole at
 * `"passes[i]"`), a missing `passes` key, a non-array `passes` or an
 * invalid pass entry maps to `{ selectable: false, reason:
 * "invalid-registry" }`. A valid registry selects only an id with a
 * recorded pass.
 */
export function decideTestProviderSelectability(
  registry: unknown,
  providerId: unknown,
  isProxy?: IsProxy,
): ProviderSelectabilityDecision {
  const snapshot = snapshotPlainData(registry, isProxy ?? (() => false), {
    maxDepth: MAX_REGISTRY_DEPTH,
    maxKeys: MAX_PASS_FIELDS,
    maxArrayLength: MAX_PASSES,
    maxNodes: MAX_NODES,
    maxStringLength: MAX_STRING_LENGTH,
  });
  if (!snapshot.ok) {
    return { selectable: false, reason: "invalid-registry" };
  }
  const value = snapshot.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { selectable: false, reason: "invalid-registry" };
  }
  const record = value as Record<string, unknown>;
  const keyRefusal = checkSnapshotKeys(record, REGISTRY_KEYS);
  if (keyRefusal !== null || !Object.hasOwn(record, "passes")) {
    return { selectable: false, reason: "invalid-registry" };
  }
  const passes = record.passes;
  if (!Array.isArray(passes)) {
    return { selectable: false, reason: "invalid-registry" };
  }
  for (const entry of passes) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { selectable: false, reason: "invalid-registry" };
    }
    if (validatePassEntry(entry as Record<string, unknown>) !== null) {
      return { selectable: false, reason: "invalid-registry" };
    }
  }
  if (!validateProviderId(providerId, isProxy)) {
    return { selectable: false, reason: "invalid-provider-id" };
  }
  for (const pass of passes as readonly ProviderTermsPass[]) {
    if (pass.providerId === providerId) {
      return { selectable: true };
    }
  }
  return { selectable: false, reason: "no-recorded-pass" };
}

/** Boolean convenience wrapper over `decideTestProviderSelectability`. */
export function isTestProviderSelectable(
  registry: unknown,
  providerId: unknown,
  isProxy?: IsProxy,
): boolean {
  return decideTestProviderSelectability(registry, providerId, isProxy).selectable;
}
