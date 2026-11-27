import { snapshotPlainData } from '@fleet/shared';
import type { IsProxy } from '@fleet/shared';
import { readConductorHaltRecord } from '../../domain/conductor-halt.js';
import { readExactPlainRecord } from '../../domain/plain-record-reads.js';
import type { ConductorHaltPort } from '../ports/out/ConductorHaltPort.out-port.js';
import type { KillallHaltMarkerPort } from '../ports/out/KillallHaltMarkerPort.out-port.js';
import type { KillallTrainPausePort } from '../ports/out/KillallTrainPausePort.out-port.js';

interface SnapshotLimits {
  readonly maxDepth: number;
  readonly maxKeys: number;
  readonly maxArrayLength: number;
  readonly maxNodes: number;
  readonly maxStringLength: number;
}

/** The snapshot bounds of one killall/conductor port answer (KA3-1): a small
 * plain record, never an array, never a long string. */
export const KILLALL_READ_SNAPSHOT_LIMITS: SnapshotLimits = Object.freeze({
  maxDepth: 4,
  maxKeys: 8,
  maxArrayLength: 0,
  maxNodes: 32,
  maxStringLength: 128,
});

/**
 * One bounded, getter-free snapshot of a port answer, read through its own
 * property descriptors: `snapshotPlainData` refuses every accessor, symbol
 * key, array, non-plain prototype and over-bound node without running a
 * getter or a Proxy trap (the `isProxy` detector is the neutral `() => false`
 * per KA3-1, so `structuredClone` below is the Proxy refusal), then
 * `readExactPlainRecord` demands exactly the expected keys, then
 * `structuredClone` refuses every remaining `Proxy` (its traps run only after
 * the snapshot proved there are no own accessors to fire). Cost: bounded by
 * `KILLALL_READ_SNAPSHOT_LIMITS`, one exact-key pass over at most the keys
 * named here, and one clone of that bounded snapshot. Any throw — a revoked
 * Proxy, a lying trap — is a `null` refusal, never a propagated error.
 */
function readExactPortSnapshot(raw: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const snap = snapshotPlainData(raw, () => false, KILLALL_READ_SNAPSHOT_LIMITS);
  if (!snap.ok) {
    return null;
  }
  const exact = readExactPlainRecord(snap.value, keys);
  if (exact === null) {
    return null;
  }
  try {
    structuredClone(raw);
  } catch {
    return null;
  }
  return exact;
}

/**
 * The result of reading a port's `read` method: `ok: true` carries the method
 * (possibly `undefined` when the port has none); `ok: false` is a refused,
 * hostile port (a throwing reflection, an accessor, or a prototype chain too
 * deep to trust), which every caller maps to its fail-closed verdict.
 */
type PortMethodRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

/** The `read` key every halt/pause port exposes. */
const PORT_METHOD_KEY = 'read';

/** The prototype hops one method lookup may traverse. A real adapter reaches
 * its method within one or two hops; more is a lying reflection, refused. */
const PORT_METHOD_MAX_HOPS = 8;

/** The neutral detector used when a caller passes none: it refuses nothing, so
 * the Proxy refusal below falls back to the walk's own throw/refusal bounds.
 * Production callers bind `types.isProxy` once in infrastructure and thread it
 * through the use cases (fix round 2, item 1). */
const NEUTRAL_IS_PROXY: IsProxy = () => false;

/**
 * One bounded, getter-free read of a port's `read` method. The port object is
 * untrusted, so the FIRST operation on it is the injected `isProxy` detector
 * (`node:util` `types.isProxy` in production, threaded from the composition):
 * a Proxy — including one whose descriptor and prototype traps hide `read` and
 * report a null prototype, which the descriptor walk alone would misread as a
 * genuinely absent method — is refused fail-closed before any trap can run.
 * The walk then touches only `getOwnPropertyDescriptor` and `getPrototypeOf`
 * along the prototype chain — reflection that never fires a getter or a `get`
 * trap — and returns the data-descriptor value. An accessor descriptor
 * (`get`/`set`) is refused without being invoked; a throwing reflection (a
 * revoked or hostile Proxy) and a chain deeper than `PORT_METHOD_MAX_HOPS` (a
 * lying or cyclic trap) are refused fail-closed. Cost: one detector call plus
 * at most `PORT_METHOD_MAX_HOPS` descriptor reads and as many prototype
 * reads, all O(1) per hop, no unbounded work.
 */
function readPortMethod(port: object, isProxy: IsProxy): PortMethodRead {
  try {
    if (isProxy(port) === true) {
      return { ok: false };
    }
  } catch {
    return { ok: false };
  }
  let cursor: object | null = port;
  for (let hops = 0; hops < PORT_METHOD_MAX_HOPS; hops += 1) {
    if (cursor === null) {
      // The chain ended without a descriptor: the method is genuinely absent.
      return { ok: true, value: undefined };
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(cursor, PORT_METHOD_KEY);
    } catch {
      return { ok: false };
    }
    if (descriptor !== undefined) {
      // An accessor (`get`/`set`) is refused, never invoked: running it would
      // be exactly the side effect the hostile-input rule forbids.
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        return { ok: false };
      }
      return { ok: true, value: descriptor.value };
    }
    try {
      cursor = Reflect.getPrototypeOf(cursor);
    } catch {
      return { ok: false };
    }
  }
  // Still no end in sight after the hop bound: a lying or cyclic prototype
  // chain.
  return { ok: false };
}

/**
 * The fail-closed halt read shared by the chain passes (plan §3.7): an absent
 * or null dependency is not halted (and never throws on `null`); a provided
 * port without `read`, a throw, and any answer that is not a plain record
 * with exactly `state: 'clear'` and `record: null` — or whose record does not
 * agree with that tag — read as halted.
 */
export async function isChainPassHalted(
  halt?: Pick<ConductorHaltPort, 'read'> | null,
  isProxy: IsProxy = NEUTRAL_IS_PROXY,
): Promise<boolean> {
  if (halt === undefined || halt === null) {
    // An absent dependency keeps today's behaviour: not halted, never thrown on.
    return false;
  }
  // The port object itself is untrusted: a Proxy is refused by the detector
  // before any reflection; the `read` method is then read through property
  // descriptors (never a getter or a Proxy get trap) and a refused read
  // fails closed.
  const method = readPortMethod(halt, isProxy);
  if (!method.ok || typeof method.value !== 'function') {
    return true;
  }
  try {
    // `read` is a prototype method: call it against the port so `this` is the
    // adapter, never an undefined receiver.
    const state = await (method.value as (this: object) => unknown).call(halt);
    const exact = readExactPortSnapshot(state, ['state', 'record']);
    if (exact === null || exact.state !== 'clear') {
      return true;
    }
    // `clear` is believed only when its record agrees: absent (null), or a
    // complete plain record the domain validator accepts with `halted: false`:
    // version, `halted` and a zoned `changedAtIso` must all be present and
    // valid. Anything else — a getter, a missing or invalid field, `halted:
    // true` — fails closed.
    if (exact.record === null) {
      return false;
    }
    const read = readConductorHaltRecord(exact.record);
    return !(read.ok && read.record.halted === false);
  } catch {
    return true;
  }
}

/**
 * The fail-closed halt read required for every one-way action (plan §3.7): an
 * absent or null dependency is halted, and any throw or off-contract answer is
 * halted. Only a provided port whose `read` answers `clear` with an agreeing
 * record reads as not halted.
 */
export async function isRequiredPassHalted(
  halt: Pick<ConductorHaltPort, 'read'> | null | undefined,
  isProxy: IsProxy = NEUTRAL_IS_PROXY,
): Promise<boolean> {
  if (halt === undefined || halt === null) {
    return true;
  }
  try {
    return await isChainPassHalted(halt, isProxy);
  } catch {
    return true;
  }
}

/**
 * The killall halt marker read (KA3-1, fail closed): an absent dependency and
 * an absent `read` method are the NOT-halted cases (they keep today's
 * behaviour); an explicit `null` port, a non-callable `read`, a throw, and
 * every answer that is not exactly `{ state: 'clear' }` read as halted.
 * Cost: O(1) shape checks plus one bounded `readExactPortSnapshot` per call.
 */
export async function isKillallHalted(
  killallHalt?: Pick<KillallHaltMarkerPort, 'read'> | null,
  isProxy: IsProxy = NEUTRAL_IS_PROXY,
): Promise<boolean> {
  if (killallHalt === undefined) {
    return false;
  }
  if (killallHalt === null) {
    return true;
  }
  // The port object itself is untrusted: a Proxy is refused by the detector
  // before any reflection (a lying trap that hides `read` and reports a null
  // prototype must never read as an absent method); an absent `read` (none
  // anywhere on the prototype chain) keeps the not-halted behaviour; a
  // refused walk, a non-callable value and a throw fail closed.
  const method = readPortMethod(killallHalt, isProxy);
  if (!method.ok) {
    return true;
  }
  if (method.value === undefined) {
    return false;
  }
  if (typeof method.value !== 'function') {
    return true;
  }
  try {
    const answer = await (method.value as (this: object) => unknown).call(killallHalt);
    const exact = readExactPortSnapshot(answer, ['state']);
    return !(exact !== null && exact.state === 'clear');
  } catch {
    return true;
  }
}

/**
 * The killall train-pause read (KA3-1, fail closed): an absent dependency is
 * not paused; a `null` port, a non-callable `read`, a throw, and every answer
 * that is not exactly `{ status: 'clear' }` read as paused.
 * Cost: O(1) shape checks plus one bounded `readExactPortSnapshot` per call.
 */
export async function isKillallTrainPaused(
  killallTrainPause?: Pick<KillallTrainPausePort, 'read'> | null,
  isProxy: IsProxy = NEUTRAL_IS_PROXY,
): Promise<boolean> {
  if (killallTrainPause === undefined) {
    return false;
  }
  if (killallTrainPause === null) {
    return true;
  }
  // The port object itself is untrusted: mirror the halt read's detector and
  // descriptor walk; a refused walk, an absent or non-callable `read` all
  // fail closed.
  const method = readPortMethod(killallTrainPause, isProxy);
  if (!method.ok || typeof method.value !== 'function') {
    return true;
  }
  try {
    const answer = await (method.value as (this: object) => unknown).call(killallTrainPause);
    const exact = readExactPortSnapshot(answer, ['status']);
    return !(exact !== null && exact.status === 'clear');
  } catch {
    return true;
  }
}

/**
 * The combined fail-closed train-step guard (KA3-1): the conductor halt (as
 * the required pass reads it when `requireConductorHalt` is true, as the
 * optional chain pass reads it when false), the killall halt marker and the
 * killall train pause. Any halted or paused read blocks the step.
 */
export async function isTrainStepBlocked(
  deps: {
    readonly halt?: Pick<ConductorHaltPort, 'read'> | null;
    readonly killallHalt?: Pick<KillallHaltMarkerPort, 'read'> | null;
    readonly killallTrainPause?: Pick<KillallTrainPausePort, 'read'> | null;
  },
  requireConductorHalt: boolean,
  isProxy: IsProxy = NEUTRAL_IS_PROXY,
): Promise<boolean> {
  return (
    (requireConductorHalt
      ? await isRequiredPassHalted(deps.halt, isProxy)
      : await isChainPassHalted(deps.halt, isProxy)) ||
    (await isKillallHalted(deps.killallHalt, isProxy)) ||
    (await isKillallTrainPaused(deps.killallTrainPause, isProxy))
  );
}
