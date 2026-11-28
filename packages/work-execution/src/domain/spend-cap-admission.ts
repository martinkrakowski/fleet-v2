/**
 * FC9F: pure spend-cap admission decider. Given a candidate run (`runId`), a
 * spend-cap verdict, and the run's in-flight peers, either admit the
 * candidate run, park it fail-closed as `spend-cap`, or refuse malformed or
 * hostile input. Domain-only: no port, no adapter, no persistence, no clock
 * read, no randomness, no I/O, no network. The decision type carries no
 * kill/stop action: in-flight attempts are never cancelled by this decider
 * and remain bounded only by the time cap.
 *
 * Hostile inputs are read through `snapshotPlainData` from `@fleet/shared`,
 * so no getter and no Proxy `get` trap ever runs, and no input value is ever
 * echoed into a refusal. `mapSpendDecisionToCapVerdict` maps `@fleet/
 * billing`'s `SpendDecision` shape BY VALUE — this module never imports
 * `@fleet/billing`.
 */

import { snapshotPlainData } from '@fleet/shared';
import type { IsProxy } from '@fleet/shared';

export type { IsProxy };

/** Hard cap on how many in-flight runs an admission request may report. */
export const MAX_IN_FLIGHT_RUNS = 10_000;

/** Longest `runId` this decider will look at. */
export const MAX_RUN_ID_LENGTH = 128;

/** The verdicts `mapSpendDecisionToCapVerdict` can produce. */
export type SpendCapVerdict = 'within' | 'exceeded' | 'invalid';

/** Park reason, kept local to this module (see also admission-order). */
export type SpendCapAdmissionParkReason = 'spend-cap';

/**
 * Typed outcome: admit the candidate run, park it fail-closed, or refuse
 * malformed or hostile input. There is deliberately no kill/stop/cancel
 * outcome: in-flight runs are never touched.
 */
export type SpendCapAdmissionDecision =
  | { readonly outcome: 'admit'; readonly runId: string }
  | {
      readonly outcome: 'park';
      readonly runId: string;
      readonly reason: SpendCapAdmissionParkReason;
    }
  | { readonly outcome: 'refused'; readonly reason: 'invalid-input' | 'too-many-in-flight' };

/** Keys that may never appear as own keys of an untrusted record. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** A non-empty trimmed string within the run-id bound. Cost bound: O(1). */
function isValidRunId(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_RUN_ID_LENGTH
    && value.trim() === value
  );
}

/** Whether a snapshotted record's keys are exactly `expected` (order-free). */
function hasExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(record);
  if (keys.length !== expected.length) {
    return false;
  }
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key) || !expected.includes(key)) {
      return false;
    }
  }
  return true;
}

/** Whether a snapshotted record's keys are the required plus allowed set. */
function hasAdmissibleKeys(
  record: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(record);
  if (keys.length < required.length || keys.length > required.length + optional.length) {
    return false;
  }
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key)) {
      return false;
    }
    if (!required.includes(key) && !optional.includes(key)) {
      return false;
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      return false;
    }
  }
  return true;
}

/** A snapshotted non-null, non-array plain record, or null. */
function asPlainRecord(snapshot: { readonly ok: true; readonly value: unknown }):
  | Readonly<Record<string, unknown>>
  | null {
  const value = snapshot.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Map `@fleet/billing`'s `SpendDecision` shape (by value, never by import)
 * to a spend-cap verdict. Any snapshot failure, wrong key set, or unknown
 * outcome maps to `'invalid'`; only the exact decision shapes map onward.
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
  if (!snapshot.ok) {
    return 'invalid';
  }
  const record = asPlainRecord(snapshot);
  if (record === null) {
    return 'invalid';
  }
  if (hasExactKeys(record, ['outcome'])) {
    return record.outcome === 'allow' ? 'within' : 'invalid';
  }
  if (hasExactKeys(record, ['outcome', 'reason', 'scope'])) {
    return record.outcome === 'park'
      && record.reason === 'spend-cap'
      && (record.scope === 'organization' || record.scope === 'project')
      ? 'exceeded'
      : 'invalid';
  }
  if (hasExactKeys(record, ['outcome', 'reason'])) {
    return record.outcome === 'park' && record.reason === 'no-cap-for-period'
      ? 'exceeded'
      : 'invalid';
  }
  return 'invalid';
}

/**
 * Decide whether a candidate run may start, given a spend-cap verdict and
 * the run's in-flight peers. Reads `input` once through `snapshotPlainData`
 * (whose `snapArray` already checks `length > maxArrayLength` BEFORE
 * `Reflect.ownKeys`, so an enormous `inFlightRunIds` is refused in O(1)
 * without any traversal); every other snapshot refusal, wrong key set, or
 * invalid run id is a typed refusal that never echoes a value. Unknown or
 * invalid verdicts fail closed to `park` with reason `spend-cap` — the
 * candidate run is never admitted on an unknown verdict.
 */
export function decideSpendCapAdmission(
  input: unknown,
  isProxy: IsProxy,
): SpendCapAdmissionDecision {
  const snapshot = snapshotPlainData(input, isProxy, {
    maxDepth: 2,
    maxKeys: 3,
    maxArrayLength: MAX_IN_FLIGHT_RUNS,
    maxNodes: MAX_IN_FLIGHT_RUNS + 8,
    maxStringLength: MAX_RUN_ID_LENGTH,
  });
  if (!snapshot.ok) {
    return snapshot.reason === 'too-many-items' && snapshot.path === 'inFlightRunIds'
      ? { outcome: 'refused', reason: 'too-many-in-flight' }
      : { outcome: 'refused', reason: 'invalid-input' };
  }
  const record = asPlainRecord(snapshot);
  if (record === null || !hasAdmissibleKeys(record, ['capVerdict', 'runId'], ['inFlightRunIds'])) {
    return { outcome: 'refused', reason: 'invalid-input' };
  }
  const runId = record.runId;
  if (!isValidRunId(runId)) {
    return { outcome: 'refused', reason: 'invalid-input' };
  }
  if (Object.hasOwn(record, 'inFlightRunIds')) {
    const inFlight = record.inFlightRunIds;
    if (!Array.isArray(inFlight)) {
      return { outcome: 'refused', reason: 'invalid-input' };
    }
    for (const candidate of inFlight) {
      if (!isValidRunId(candidate)) {
        return { outcome: 'refused', reason: 'invalid-input' };
      }
    }
  }
  // Fail closed: only an exact 'within' verdict admits; 'exceeded', 'invalid',
  // and every unknown value park the candidate run. Unknown values never
  // throw, never echo, and never admit.
  const verdict = record.capVerdict;
  if (verdict === 'within') {
    return { outcome: 'admit', runId };
  }
  return { outcome: 'park', runId, reason: 'spend-cap' };
}
