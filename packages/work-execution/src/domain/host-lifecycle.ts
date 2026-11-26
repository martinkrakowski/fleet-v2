/**
 * Pure domain decider for the execution-host lifecycle (FC8E2). The host
 * record is untrusted input: it is read through its own property descriptors
 * (no getter ever runs) and every failure — hostile input, an unknown state,
 * an illegal transition — is a typed refusal, never a throw and never a
 * guessed action.
 *
 * Cost bound: the host validation is `O(1)` — `readExactPlainRecord` checks
 * the own-key count immediately (`ownKeys.length === 1`) before any descriptor
 * read, and the `desired` check is a fixed string-equality chain. Descriptor
 * reads and the prototype check are wrapped in `try/catch` so a revoked or
 * throwing `Proxy` answers `invalid-request` instead of throwing.
 */

import { isPlainRecordObject } from './record-schema-version.js';
import { readExactPlainRecord } from './plain-record-reads.js';

/** The states an execution host can be observed in. */
export type HostLifecycleState = 'provisioning' | 'ready' | 'draining' | 'terminated';

/** What the caller wants the host to become (or a schedule check). */
export type HostLifecycleDesired = 'ready' | 'draining' | 'terminated' | 'schedule';

/** The exact shape of the host record the decider accepts. */
export type HostLifecycleInput = { readonly state: HostLifecycleState };

/** Fixed failure reasons, never a throw. */
export type HostLifecycleFailureReason =
  | 'invalid-request'
  | 'not-schedulable'
  | 'terminated'
  | 'illegal-transition';

export type HostLifecycleDecision =
  | { readonly ok: true; readonly action: 'schedule' }
  | {
      readonly ok: true;
      readonly action: 'transition';
      readonly from: HostLifecycleState;
      readonly to: 'ready' | 'draining' | 'terminated';
    }
  | { readonly ok: false; readonly reason: HostLifecycleFailureReason };

/** True when `value` is one of the four host lifecycle states (fixed checks). */
function isHostLifecycleState(value: unknown): value is HostLifecycleState {
  return (
    value === 'provisioning' || value === 'ready' || value === 'draining' || value === 'terminated'
  );
}

/** True when `value` is one of the four desired actions (fixed checks). */
function isHostLifecycleDesired(value: unknown): value is HostLifecycleDesired {
  return value === 'ready' || value === 'draining' || value === 'terminated' || value === 'schedule';
}

/** The only legal forward transitions between lifecycle states. */
const LEGAL_TRANSITIONS: Readonly<Record<Exclude<HostLifecycleState, 'terminated'>, ReadonlySet<string>>> = {
  provisioning: new Set(['ready']),
  ready: new Set(['draining']),
  draining: new Set(['terminated']),
};

/**
 * Decide the action for one host. `host` must be a plain object with the
 * exact own enumerable data key `state` holding a `HostLifecycleState`
 * (no getter is ever invoked); `desired` must be a `HostLifecycleDesired`.
 * Every refusal is `{ ok: false, reason }`, never a throw.
 */
export function decideHostLifecycleAction(host: unknown, desired: unknown): HostLifecycleDecision {
  const invalid: HostLifecycleDecision = { ok: false, reason: 'invalid-request' };
  if (!isHostLifecycleDesired(desired)) {
    return invalid;
  }
  // `readExactPlainRecord` refuses non-plain objects, the wrong key count
  // (checked before any descriptor read), symbol keys, `__proto__`,
  // `constructor`, `prototype`, non-enumerable keys and accessors; the
  // wrapper turns a revoked or throwing `Proxy` into the same refusal.
  let record: Record<string, unknown> | null;
  try {
    record = isPlainRecordObject(host) ? readExactPlainRecord(host, ['state']) : null;
  } catch {
    record = null;
  }
  if (record === null) {
    return invalid;
  }
  const state = record['state'];
  if (!isHostLifecycleState(state)) {
    return invalid;
  }
  if (desired === 'schedule') {
    return state === 'ready'
      ? { ok: true, action: 'schedule' }
      : { ok: false, reason: 'not-schedulable' };
  }
  if (state === 'terminated') {
    return { ok: false, reason: 'terminated' };
  }
  const legal = LEGAL_TRANSITIONS[state];
  if (legal !== undefined && legal.has(desired)) {
    return { ok: true, action: 'transition', from: state, to: desired };
  }
  return { ok: false, reason: 'illegal-transition' };
}
