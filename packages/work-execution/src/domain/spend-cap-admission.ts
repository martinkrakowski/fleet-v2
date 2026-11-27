/**
 * FC9F: pure spend-cap admission decider. Given a candidate run's spend-cap
 * verdict (mapped by value from `@fleet/billing`'s `SpendDecision` shape,
 * without importing `@fleet/billing`), either admit the candidate run,
 * park it fail-closed as `spend-cap`, or refuse malformed or hostile input.
 *
 * Domain-only: no port, no adapter, no persistence, no network, no clock
 * read, no randomness, no I/O, no `console.*`. Hostile inputs are read
 * through the shared plain-data snapshot, so no getter and no Proxy
 * reflection trap ever runs. In-flight runs are never killed or cancelled
 * here: the decision type carries no kill/stop action, and in-flight
 * attempts remain bounded only by the time cap.
 */

import {
  snapshotPlainData,
  type IsProxy,
} from '@fleet/shared';

export type { IsProxy };

/** Hard cap on how many in-flight run ids an admission input may carry. */
export const MAX_IN_FLIGHT_RUNS = 10_000;

/** Maximum length of any run id this decider will look at. */
export const MAX_RUN_ID_LENGTH = 128;

/** The verdict space the mapper recognises from `@fleet/billing`. */
export type SpendCapVerdict = 'within' | 'exceeded' | 'invalid';

/** Park reason, kept local to this module. */
export type SpendCapAdmissionParkReason = 'spend-cap';

/** Typed outcome: admit, park fail-closed, or refuse malformed input. */
export type SpendCapAdmissionDecision =
  | { readonly outcome: 'admit'; readonly runId: string }
  | {
      readonly outcome: 'park';
      readonly runId: string;
      readonly reason: SpendCapAdmissionParkReason;
    }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-input' | 'too-many-in-flight' };

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * A non-empty trimmed string within `MAX_RUN_ID_LENGTH`. Cost bound: O(1) —
 * three checks on a string the snapshot already bounded by length.
 */
function isValidRunId(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_RUN_ID_LENGTH
    && value.trim() === value
  );
}

/**
 * Whether the snapshotted root is a non-null, non-array plain object.
 * Cost bound: O(1) — two type checks.
 */
function isPlainRecordRoot(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether the snapshot output's own key set is exactly the allowed set,
 * refusing every prototype-polluting key (`__proto__`, `constructor`,
 * `prototype`) and any missing required key. The snapshot already refused
 * symbol and non-enumerable keys, and copied an own `__proto__` key as
 * data, so the polluting keys appear here and are refused by name.
 * Cost bound: O(own keys), capped at `maxKeys`.
 */
function hasExactKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): boolean {
  const optional: ReadonlySet<string> = new Set(optionalKeys);
  const seen: Set<string> = new Set();
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key) || (!requiredKeys.includes(key) && !optional.has(key))) {
      return false;
    }
    seen.add(key);
  }
  return requiredKeys.every((key) => seen.has(key));
}

/**
 * Map a `@fleet/billing` `SpendDecision`-shaped value (read by value, never
 * by importing `@fleet/billing`) to the spend-cap verdict space. Any
 * snapshot refusal, unexpected shape, or unknown outcome is `'invalid'`.
 *
 * Cost bound: O(own keys) for the snapshot's single enumeration (bounded by
 * `maxKeys: 3`), then O(1) exact-key and string-literal checks.
 */
export function mapSpendDecisionToCapVerdict(decision: unknown, isProxy: IsProxy): SpendCapVerdict {
  const snapshot = snapshotPlainData(decision, isProxy, {
    maxDepth: 1,
    maxKeys: 3,
    maxArrayLength: 0,
    maxNodes: 8,
    maxStringLength: 64,
  });
  if (!snapshot.ok || !isPlainRecordRoot(snapshot.value)) {
    return 'invalid';
  }
  const record = snapshot.value;
  const outcome = record['outcome'];
  if (hasExactKeys(record, ['outcome'], [])) {
    return outcome === 'allow' ? 'within' : 'invalid';
  }
  if (hasExactKeys(record, ['outcome', 'reason'], [])
    && outcome === 'park'
    && record['reason'] === 'no-cap-for-period') {
    return 'exceeded';
  }
  if (
    hasExactKeys(record, ['outcome', 'reason', 'scope'], [])
    && outcome === 'park'
    && record['reason'] === 'spend-cap'
  ) {
    const scope = record['scope'];
    return scope === 'organization' || scope === 'project' ? 'exceeded' : 'invalid';
  }
  return 'invalid';
}

/**
 * Decide spend-cap admission for a candidate run. `'within'` admits;
 * `'exceeded'`, `'invalid'`, or any unknown verdict parks the candidate run
 * fail-closed as `spend-cap`. In-flight runs are never killed or cancelled:
 * the decision carries no kill/stop action, and the in-flight list is only
 * read, never mutated.
 *
 * Cost bound: O(1) length check inside `snapArray` before `ownKeys` on
 * `inFlightRunIds`, O(own keys) for `snapshotPlainData` (capped at
 * `maxKeys: 3` on the root record), and O(1) per-element `runId`
 * validation. Never throws and never echoes a rejected value.
 */
export function decideSpendCapAdmission(input: unknown, isProxy: IsProxy): SpendCapAdmissionDecision {
  const snapshot = snapshotPlainData(input, isProxy, {
    maxDepth: 2,
    maxKeys: 3,
    maxArrayLength: MAX_IN_FLIGHT_RUNS,
    maxNodes: MAX_IN_FLIGHT_RUNS + 8,
    maxStringLength: MAX_RUN_ID_LENGTH,
  });
  if (!snapshot.ok) {
    if (snapshot.reason === 'too-many-items' && snapshot.path === 'inFlightRunIds') {
      return { outcome: 'refused', reason: 'too-many-in-flight' };
    }
    return { outcome: 'refused', reason: 'invalid-input' };
  }
  if (!isPlainRecordRoot(snapshot.value)) {
    return { outcome: 'refused', reason: 'invalid-input' };
  }
  const record = snapshot.value;
  if (!hasExactKeys(record, ['capVerdict', 'runId'], ['inFlightRunIds'])) {
    return { outcome: 'refused', reason: 'invalid-input' };
  }
  const runId = record['runId'];
  if (!isValidRunId(runId)) {
    return { outcome: 'refused', reason: 'invalid-input' };
  }
  if (Object.hasOwn(record, 'inFlightRunIds')) {
    const inFlight = record['inFlightRunIds'];
    if (!Array.isArray(inFlight)) {
      return { outcome: 'refused', reason: 'invalid-input' };
    }
    // The snapshot bounds each element's length at `MAX_RUN_ID_LENGTH`
    // (`too-long` is refused), so each check here is O(1) per element.
    for (const element of inFlight) {
      if (!isValidRunId(element)) {
        return { outcome: 'refused', reason: 'invalid-input' };
      }
    }
  }
  // Only `'within'` admits; every other verdict parks fail-closed. The
  // in-flight list is never killed, cancelled, or mutated by this decision.
  if (record['capVerdict'] === 'within') {
    return { outcome: 'admit', runId };
  }
  return { outcome: 'park', runId, reason: 'spend-cap' };
}
