// Storage rule: if a later unit stores these records it must write `schemaVersion: 1`, read an absent `schemaVersion` as 1 forever, and refuse an unknown `schemaVersion` with `StateFileUnknownVersionError` (bytes untouched, nothing quarantined).

/**
 * Pure period spend-cap admission decision in abstract whole-number units
 * (callers pass runner minutes from `runnerMinutesOf`). It only decides the
 * admission of a new run; a run already admitted is never touched by it.
 * No period arithmetic, no clock, no persistence, no ports, no adapters.
 *
 * Complexity bound: O(1). The root has a fixed 3 keys and each scope a fixed
 * 2 keys; `Reflect.ownKeys` is read once per object and its length is checked
 * before any descriptor is read, so an object with many keys is refused at
 * the length check.
 *
 * Pinned boundaries (enforced and tested): cap 0, used 0, requested 0 admits
 * with remaining 0; cap 0, used 0, requested 1 parks; used === cap admits
 * when requested is 0 and parks when requested is 1.
 *
 * Never throws and never runs an accessor: values are read through their own
 * property descriptors inside a try/catch. A refusal reason is one of a closed
 * set of literals and never echoes an input value. Negative zero is refused.
 */

export type SpendCapScopeName = 'project' | 'organisation';

export type SpendCapScopeInput = {
  readonly cap: number | null;
  readonly used: number;
};

export type SpendCapInput = {
  readonly requested: number;
  readonly organisation: SpendCapScopeInput;
  readonly project: SpendCapScopeInput;
};

/** Closed set of refusal reasons; none echoes an input value. */
export type SpendCapRefusalReason =
  | 'not-a-plain-object'
  | 'wrong-keys'
  | 'accessor-property'
  | 'unreadable-input'
  | 'invalid-requested'
  | 'requested-above-bound'
  | 'invalid-used'
  | 'invalid-cap'
  | 'sum-overflow';

export type SpendCapDecision =
  | {
      readonly decision: 'admit';
      readonly remaining: { readonly organisation: number | null; readonly project: number | null };
    }
  | { readonly decision: 'park'; readonly reason: 'spend-cap'; readonly exhausted: readonly SpendCapScopeName[] }
  | { readonly decision: 'refused'; readonly reason: SpendCapRefusalReason };

/** Upper bound on one request, in the same abstract units. */
const MAX_REQUESTED_UNITS = 10_000_000;
const ROOT_KEYS: readonly string[] = ['requested', 'organisation', 'project'];
const SCOPE_KEYS: readonly string[] = ['cap', 'used'];

type KeyRead =
  | { readonly ok: true; readonly values: Record<string, unknown> }
  | { readonly ok: false; readonly reason: SpendCapRefusalReason };

type ScopeRead =
  | { readonly ok: true; readonly cap: number | null; readonly used: number }
  | { readonly ok: false; readonly reason: SpendCapRefusalReason };

function refuse(reason: SpendCapRefusalReason): SpendCapDecision {
  return { decision: 'refused', reason };
}

/** A non-negative safe integer that is not negative zero. */
function isUnitCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

/**
 * A plain object (`Object.prototype` or null prototype) with exactly the given
 * own enumerable string keys, values read from their own data descriptors; a
 * getter or setter is refused and never run.
 */
function readExactKeys(value: unknown, keys: readonly string[]): KeyRead {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, reason: 'not-a-plain-object' };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { ok: false, reason: 'not-a-plain-object' };
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length) {
      return { ok: false, reason: 'wrong-keys' };
    }
    const values: Record<string, unknown> = Object.create(null);
    for (const key of ownKeys) {
      if (typeof key !== 'string' || key === '__proto__' || !keys.includes(key)) {
        return { ok: false, reason: 'wrong-keys' };
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || descriptor.enumerable !== true) {
        return { ok: false, reason: 'wrong-keys' };
      }
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        return { ok: false, reason: 'accessor-property' };
      }
      values[key] = descriptor.value;
    }
    return { ok: true, values };
  } catch {
    return { ok: false, reason: 'unreadable-input' };
  }
}

function readScope(value: unknown, requested: number): ScopeRead {
  const read = readExactKeys(value, SCOPE_KEYS);
  if (!read.ok) {
    return read;
  }
  const { cap, used } = read.values;
  if (!isUnitCount(used)) {
    return { ok: false, reason: 'invalid-used' };
  }
  let capUnits: number | null = null;
  if (cap !== null) {
    if (!isUnitCount(cap)) {
      return { ok: false, reason: 'invalid-cap' };
    }
    capUnits = cap;
  }
  // Overflow guard: refuse rather than compute a wrapped or imprecise sum.
  if (used > Number.MAX_SAFE_INTEGER - requested) {
    return { ok: false, reason: 'sum-overflow' };
  }
  return { ok: true, cap: capUnits, used };
}

/** A capped scope is exhausted when the request would take it past its cap. */
function isExhausted(scope: SpendCapScopeInput, requested: number): boolean {
  return scope.cap !== null && scope.used + requested > scope.cap;
}

function remainingOf(scope: SpendCapScopeInput, requested: number): number | null {
  return scope.cap === null ? null : scope.cap - (scope.used + requested);
}

/**
 * Decide admission of a run of `requested` units against the optional caps of
 * the `organisation` and `project` scopes: `admit`, `park` or `refused`.
 */
export function evaluateSpendCaps(input: unknown): SpendCapDecision {
  const root = readExactKeys(input, ROOT_KEYS);
  if (!root.ok) {
    return refuse(root.reason);
  }
  const { requested } = root.values;
  if (!isUnitCount(requested)) {
    return refuse('invalid-requested');
  }
  if (requested > MAX_REQUESTED_UNITS) {
    return refuse('requested-above-bound');
  }
  const organisation = readScope(root.values.organisation, requested);
  if (!organisation.ok) {
    return refuse(organisation.reason);
  }
  const project = readScope(root.values.project, requested);
  if (!project.ok) {
    return refuse(project.reason);
  }
  const exhausted: SpendCapScopeName[] = [];
  if (isExhausted(project, requested)) {
    exhausted.push('project');
  }
  if (isExhausted(organisation, requested)) {
    exhausted.push('organisation');
  }
  if (exhausted.length > 0) {
    return { decision: 'park', reason: 'spend-cap', exhausted };
  }
  return {
    decision: 'admit',
    remaining: { organisation: remainingOf(organisation, requested), project: remainingOf(project, requested) },
  };
}
