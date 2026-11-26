/**
 * Pure per-attempt isolated-environment state machine (lane FC8D1). It decides
 * the next environment state from the current state and one event. Pure: it
 * never throws, never runs an accessor, never reads a clock, and never echoes
 * a supplied value — every refusal reason is a fixed constant.
 *
 * Cost bound: O(1) per step. Key counts are bounded by
 * `Reflect.ownKeys(value).length <= 8` before any descriptor read; ids are
 * length-checked (1..128) before the bounded regex runs; `worktreeRef` is
 * length-checked (1..512) before the single control-character scan and the
 * segment split over at most 512 characters.
 *
 * Hostile-input rule: state and event are read through their own property
 * descriptors only (no getter ever runs), a plain object profile is required
 * (`Object.prototype` or `null` prototype, never an array), prototype-polluting
 * keys and extra keys are refused, and every refusal is a typed
 * `{ ok: false, reason }` result. A `Proxy` that lies consistently in every
 * trap is an accepted residual; a `Proxy` detectable through its array target,
 * its reported descriptors, its prototype or a throwing
 * `getPrototypeOf`/`ownKeys`/`getOwnPropertyDescriptor` trap is refused.
 */

export type AttemptEnvironmentStatus = 'none' | 'created' | 'loaded' | 'sealed' | 'destroyed' | 'failed';

export type AttemptEnvironmentIsolation = 'microvm' | 'user-space-kernel';

export interface AttemptEnvironmentState {
  readonly status: AttemptEnvironmentStatus;
  readonly attemptId: string | null;
  readonly environmentId: string | null;
  readonly isolation: AttemptEnvironmentIsolation | null;
  readonly worktreeRef: string | null;
}

export const INITIAL_ATTEMPT_ENVIRONMENT_STATE: AttemptEnvironmentState = {
  status: 'none',
  attemptId: null,
  environmentId: null,
  isolation: null,
  worktreeRef: null,
};

export type AttemptEnvironmentEvent =
  | { readonly kind: 'create'; readonly attemptId: string; readonly environmentId: string; readonly isolation: AttemptEnvironmentIsolation }
  | { readonly kind: 'inject-worktree'; readonly attemptId: string; readonly environmentId: string; readonly worktreeRef: string }
  | { readonly kind: 'seal'; readonly attemptId: string; readonly environmentId: string }
  | { readonly kind: 'destroy'; readonly attemptId: string; readonly environmentId: string }
  | { readonly kind: 'fail'; readonly attemptId: string; readonly environmentId: string };

export type EnvironmentStepFailureReason =
  | 'invalid-input'
  | 'invalid-attempt-id'
  | 'invalid-environment-id'
  | 'invalid-worktree-ref'
  | 'unsupported-isolation'
  | 'duplicate-attempt'
  | 'handle-mismatch'
  | 'sealed'
  | 'invalid-transition';

export type AttemptEnvironmentStepResult =
  | { readonly ok: true; readonly state: AttemptEnvironmentState }
  | { readonly ok: false; readonly reason: EnvironmentStepFailureReason };

const STATE_KEYS = ['status', 'attemptId', 'environmentId', 'isolation', 'worktreeRef'] as const;
const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_OBJECT_KEYS = 8;
const MAX_ID_LENGTH = 128;
const MAX_WORKTREE_REF_LENGTH = 512;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
// eslint-disable-next-line no-control-regex -- the validator's job is refusing control characters, not matching text containing them
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f]/;
const STATUSES: ReadonlySet<string> = new Set(['none', 'created', 'loaded', 'sealed', 'destroyed', 'failed']);
const ISOLATIONS: ReadonlySet<string> = new Set(['microvm', 'user-space-kernel']);
const EVENT_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  ['create', ['kind', 'attemptId', 'environmentId', 'isolation']],
  ['inject-worktree', ['kind', 'attemptId', 'environmentId', 'worktreeRef']],
  ['seal', ['kind', 'attemptId', 'environmentId']],
  ['destroy', ['kind', 'attemptId', 'environmentId']],
  ['fail', ['kind', 'attemptId', 'environmentId']],
]);

/** Read a plain object with exactly `keys` as own enumerable string data
 * properties, values taken from their own descriptors so no getter ever runs;
 * null for anything else (wrong type, array, foreign prototype, key-count over
 * the bound, a polluting, extra, symbol or non-enumerable key, a getter or a
 * setter, or a missing required key).
 */
function readExactDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const record = readPlainDataRecord(value, keys);
  if (record === null || Reflect.ownKeys(record).length !== keys.length) {
    return null;
  }
  return record;
}

/** Read a plain object whose own enumerable string data keys are all in
 * `allowedKeys`, values taken from their own descriptors so no getter ever
 * runs; null for anything else (wrong type, array, foreign prototype, key
 * count over the bound, a polluting, extra, symbol or non-enumerable key, or
 * a getter or a setter). The caller checks which allowed keys are present.
 */
function readPlainDataRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> | null {
  // The reflective reads below can throw out of a revoked Proxy or a Proxy
  // with a throwing `getPrototypeOf`/`ownKeys`/`getOwnPropertyDescriptor`
  // trap. Even `Array.isArray` throws on a revoked Proxy. Any such failure
  // is a refusal (null -> invalid-input at the callers), never an exception
  // escaping this function. Cost stays O(1): the key-count bound still runs
  // before any descriptor read.
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > MAX_OBJECT_KEYS) {
      return null;
    }
    const out: Record<string, unknown> = {};
    for (const key of ownKeys) {
      if (typeof key !== 'string' || POLLUTING_KEYS.has(key) || !allowedKeys.includes(key)) {
        return null;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
        return null;
      }
      out[key] = descriptor.value;
    }
    return out;
  } catch {
    return null;
  }
}

/** A non-empty string of at most 128 characters matching the bounded id pattern. */
function isValidId(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const length = value.length;
  if (length < 1 || length > MAX_ID_LENGTH) {
    return false;
  }
  return ID_PATTERN.test(value);
}

/** A non-empty string of at most 512 characters with no control character and
 * no `..` path segment on either separator.
 */
function isValidWorktreeRef(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const length = value.length;
  if (length < 1 || length > MAX_WORKTREE_REF_LENGTH) {
    return false;
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    return false;
  }
  const segments = value.split(/[\\/]/);
  for (const segment of segments) {
    if (segment === '..') {
      return false;
    }
  }
  return true;
}

/** The event's ids and payload validated with fixed per-field reasons. */
function readValidatedEvent(record: Record<string, unknown>):
  | { readonly ok: true; readonly kind: string; readonly attemptId: string; readonly environmentId: string; readonly worktreeRef: string | null; readonly isolation: string | null }
  | { readonly ok: false; readonly reason: EnvironmentStepFailureReason } {
  const kind = record['kind'];
  if (typeof kind !== 'string') {
    return { ok: false, reason: 'invalid-input' };
  }
  const keys = EVENT_KEYS.get(kind);
  if (keys === undefined) {
    return { ok: false, reason: 'invalid-input' };
  }
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) {
      return { ok: false, reason: 'invalid-input' };
    }
  }
  const attemptId = record['attemptId'];
  if (!isValidId(attemptId)) {
    return { ok: false, reason: 'invalid-attempt-id' };
  }
  const environmentId = record['environmentId'];
  if (!isValidId(environmentId)) {
    return { ok: false, reason: 'invalid-environment-id' };
  }
  let worktreeRef: string | null = null;
  if (keys.includes('worktreeRef')) {
    const value = record['worktreeRef'];
    if (!isValidWorktreeRef(value)) {
      return { ok: false, reason: 'invalid-worktree-ref' };
    }
    worktreeRef = value;
  }
  let isolation: string | null = null;
  if (keys.includes('isolation')) {
    const value = record['isolation'];
    if (typeof value !== 'string' || !ISOLATIONS.has(value)) {
      return { ok: false, reason: 'unsupported-isolation' };
    }
    isolation = value;
  }
  return { ok: true, kind, attemptId, environmentId, worktreeRef, isolation };
}

/** Decide the next environment state. Never throws and never mutates either
 * input; a refusal returns a fixed reason and leaves `state` untouched.
 */
export function decideEnvironmentStep(state: unknown, event: unknown): AttemptEnvironmentStepResult {
  const stateRecord = readExactDataRecord(state, STATE_KEYS);
  if (stateRecord === null) {
    return { ok: false, reason: 'invalid-input' };
  }
  const statusValue = stateRecord['status'];
  if (typeof statusValue !== 'string' || !STATUSES.has(statusValue)) {
    return { ok: false, reason: 'invalid-transition' };
  }
  const status = statusValue as AttemptEnvironmentStatus;
  for (const key of ['attemptId', 'environmentId', 'isolation', 'worktreeRef'] as const) {
    const value = stateRecord[key];
    if (value !== null && !isValidOptionalStateField(key, value)) {
      return { ok: false, reason: 'invalid-input' };
    }
  }
  const eventRecord = readPlainDataRecord(event, ['kind', 'attemptId', 'environmentId', 'isolation', 'worktreeRef']);
  if (eventRecord === null) {
    return { ok: false, reason: 'invalid-input' };
  }
  const validated = readValidatedEvent(eventRecord);
  if (validated.ok === false) {
    return validated;
  }
  const eventKeys = EVENT_KEYS.get(validated.kind) as readonly string[];
  if (Reflect.ownKeys(eventRecord).length !== eventKeys.length) {
    return { ok: false, reason: 'invalid-input' };
  }
  const attemptId = validated.attemptId;
  const environmentId = validated.environmentId;

  const active = status === 'created' || status === 'loaded' || status === 'sealed' || status === 'failed';
  if (active && validated.kind !== 'create') {
    if (environmentId !== stateRecord['environmentId'] || attemptId !== stateRecord['attemptId']) {
      return { ok: false, reason: 'handle-mismatch' };
    }
  }

  if (validated.kind === 'create') {
    if (status === 'created' || status === 'loaded' || status === 'sealed') {
      return { ok: false, reason: 'duplicate-attempt' };
    }
    if (status === 'failed' || status === 'destroyed') {
      return { ok: false, reason: 'invalid-transition' };
    }
    return {
      ok: true,
      state: { status: 'created', attemptId, environmentId, isolation: validated.isolation as AttemptEnvironmentIsolation, worktreeRef: null },
    };
  }

  if (status === 'none' || status === 'destroyed') {
    return { ok: false, reason: 'invalid-transition' };
  }

  if (validated.kind === 'inject-worktree') {
    if (status === 'sealed') {
      return { ok: false, reason: 'sealed' };
    }
    if (status !== 'created') {
      return { ok: false, reason: 'invalid-transition' };
    }
    return {
      ok: true,
      state: { status: 'loaded', attemptId, environmentId, isolation: stateRecord['isolation'] as AttemptEnvironmentIsolation, worktreeRef: validated.worktreeRef },
    };
  }

  if (validated.kind === 'seal') {
    if (status !== 'loaded') {
      return { ok: false, reason: 'invalid-transition' };
    }
    return {
      ok: true,
      state: { status: 'sealed', attemptId, environmentId, isolation: stateRecord['isolation'] as AttemptEnvironmentIsolation, worktreeRef: stateRecord['worktreeRef'] as string },
    };
  }

  if (validated.kind === 'destroy') {
    return {
      ok: true,
      state: { status: 'destroyed', attemptId, environmentId, isolation: stateRecord['isolation'] as AttemptEnvironmentIsolation | null, worktreeRef: stateRecord['worktreeRef'] as string | null },
    };
  }

  // kind === 'fail'
  if (status !== 'created' && status !== 'loaded' && status !== 'sealed') {
    return { ok: false, reason: 'invalid-transition' };
  }
  return {
    ok: true,
    state: { status: 'failed', attemptId, environmentId, isolation: stateRecord['isolation'] as AttemptEnvironmentIsolation | null, worktreeRef: stateRecord['worktreeRef'] as string | null },
  };
}

/** A state field that is not null must be an id, an isolation or a worktree reference. */
function isValidOptionalStateField(key: string, value: unknown): boolean {
  if (key === 'isolation') {
    return typeof value === 'string' && ISOLATIONS.has(value);
  }
  if (key === 'worktreeRef') {
    return isValidWorktreeRef(value);
  }
  return isValidId(value);
}
