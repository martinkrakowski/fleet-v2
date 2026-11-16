import { readConductorHaltRecord } from '../../domain/conductor-halt.js';
import type { ConductorHaltPort } from '../ports/out/ConductorHaltPort.out-port.js';

/**
 * The fail-closed halt read shared by the chain passes (plan §3.7): an absent
 * dependency is not halted; a provided port without `read`, a throw, and any
 * answer that is not an object with `state: 'clear'` — or whose record does
 * not agree with that tag — read as halted.
 */
export async function isChainPassHalted(halt?: Pick<ConductorHaltPort, 'read'>): Promise<boolean> {
  if (halt === undefined) {
    // An absent dependency keeps today's behaviour: not halted.
    return false;
  }
  if (typeof halt.read !== 'function') {
    return true;
  }
  try {
    const state = await halt.read();
    if (typeof state !== 'object' || state === null || Array.isArray(state)) {
      return true;
    }
    const tag = (state as { readonly state?: unknown }).state;
    if (tag !== 'clear') {
      return true;
    }
    // `clear` is believed only when its record agrees: absent (null), or a
    // complete plain record the domain validator accepts with `halted: false`:
    // version, `halted` and a zoned `changedAtIso` must all be present and
    // valid. Anything else — a getter, a missing or invalid field, `halted:
    // true` — fails closed.
    const record = (state as { readonly record?: unknown }).record;
    if (record === null) {
      return false;
    }
    if (typeof record !== 'object' || Array.isArray(record)) {
      return true;
    }
    const read = readConductorHaltRecord(record);
    return !(read.ok && read.record.halted === false);
  } catch {
    return true;
  }
}
