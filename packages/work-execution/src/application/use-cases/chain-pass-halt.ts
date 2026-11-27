import { snapshotPlainData } from '@fleet/shared';
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
 * The fail-closed halt read shared by the chain passes (plan §3.7): an absent
 * or null dependency is not halted (and never throws on `null`); a provided
 * port without `read`, a throw, and any answer that is not a plain record
 * with exactly `state: 'clear'` and `record: null` — or whose record does not
 * agree with that tag — read as halted.
 */
export async function isChainPassHalted(
  halt?: Pick<ConductorHaltPort, 'read'> | null,
): Promise<boolean> {
  if (halt === undefined || halt === null) {
    // An absent dependency keeps today's behaviour: not halted, never thrown on.
    return false;
  }
  if (typeof halt.read !== 'function') {
    return true;
  }
  try {
    const state = await halt.read();
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
): Promise<boolean> {
  if (halt === undefined || halt === null) {
    return true;
  }
  try {
    return await isChainPassHalted(halt);
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
): Promise<boolean> {
  if (killallHalt === undefined) {
    return false;
  }
  if (killallHalt === null) {
    return true;
  }
  if (killallHalt.read === undefined) {
    return false;
  }
  if (typeof killallHalt.read !== 'function') {
    return true;
  }
  try {
    const answer = await killallHalt.read();
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
): Promise<boolean> {
  if (killallTrainPause === undefined) {
    return false;
  }
  if (killallTrainPause === null || typeof killallTrainPause.read !== 'function') {
    return true;
  }
  try {
    const answer = await killallTrainPause.read();
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
): Promise<boolean> {
  return (
    (requireConductorHalt
      ? await isRequiredPassHalted(deps.halt)
      : await isChainPassHalted(deps.halt)) ||
    (await isKillallHalted(deps.killallHalt)) ||
    (await isKillallTrainPaused(deps.killallTrainPause))
  );
}
