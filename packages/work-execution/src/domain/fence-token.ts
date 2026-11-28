/**
 * Pure fence-token rules (FT1): a monotonic `FenceToken` (`{ holderId, fence }`)
 * is prior art for fenced leases, so a stopped or expired holder cannot write
 * after another holder takes over. `decideFencedWrite` is a refinement, not a
 * second copy: it calls `checkLeaseHeld` for the shared holder, fence equality
 * and expiry check, and adds only the distinctions (`stale-fence` versus
 * `fence-ahead` versus `holder-mismatch`) in the fixed check order documented
 * on the function. FT1 writes nothing; the stores adopt the token in FT2.
 *
 * Like every lease decision this never throws, never echoes a value, and never
 * reads a clock (time arrives as `nowIso`).
 */

import { readExactPlainRecord } from './plain-record-reads.js';
import { checkLeaseHeld, isValidHolderId, isFence } from './lane-run-lease.js';
import type { LaneRunLeaseRecord } from './lane-run-records.js';

export const FENCE_REFUSALS = [
  'invalid-token', 'no-lease', 'stale-fence', 'fence-ahead', 'holder-mismatch',
  'lease-expired', 'no-lease-readable',
] as const;
export type FenceRefusal = (typeof FENCE_REFUSALS)[number];

/** The monotonic write token a lease holder presents before each write. */
export interface FenceToken {
  readonly holderId: string;
  readonly fence: number;
}

export type FencedWriteDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: FenceRefusal };

const TOKEN_KEYS: readonly string[] = ['holderId', 'fence'];

/**
 * Read a `FenceToken` from untrusted input. Exactly the two keys, read through
 * their own property descriptors (no getter ever runs); the holder and fence
 * follow the same K1-1 rules `checkLeaseHeld` enforces. Returns null on
 * anything else — including an input that throws (a hostile Proxy) — never a
 * pass.
 */
export function readFenceToken(input: unknown): FenceToken | null {
  try {
    const snapshot = readExactPlainRecord(input, TOKEN_KEYS);
    if (snapshot === null || !isValidHolderId(snapshot.holderId) || !isFence(snapshot.fence, 1)) {
      return null;
    }
    return Object.freeze({ holderId: snapshot.holderId as string, fence: snapshot.fence as number });
  } catch {
    return null;
  }
}

/** The token naming a lease; null for a null lease. The token is frozen. */
export function fenceTokenOf(lease: Pick<LaneRunLeaseRecord, 'holderId' | 'fence'> | null): FenceToken | null {
  if (lease === null) {
    return null;
  }
  return Object.freeze({ holderId: lease.holderId, fence: lease.fence });
}

/**
 * Decide one fenced write against the current lease, in this fixed order:
 * 1. `invalid-token` — the token is not a readable `FenceToken`;
 * 2. `no-lease` — there is no current lease to write under;
 * 3. `checkLeaseHeld` — the shared holder, fence equality and expiry check —
 *    refined into `stale-fence` (lower fence), `fence-ahead` (higher fence),
 *    `holder-mismatch` (same fence, other holder), in exactly that order;
 *    `lease-expired` passes through, and a malformed `nowIso` (the shared
 *    reader's `invalid-request`) fails closed as `lease-expired`.
 */
export function decideFencedWrite(input: {
  readonly current: LaneRunLeaseRecord | null;
  readonly token: unknown;
  readonly nowIso: string;
}): FencedWriteDecision {
  const parsed = readFenceToken(input.token);
  if (parsed === null) {
    return { ok: false, reason: 'invalid-token' };
  }
  if (input.current === null) {
    return { ok: false, reason: 'no-lease' };
  }
  const held = checkLeaseHeld(input.current, {
    holderId: parsed.holderId,
    fence: parsed.fence,
    nowIso: input.nowIso,
  });
  if (held === null) {
    return { ok: true };
  }
  if (held === 'lease-expired') {
    return { ok: false, reason: 'lease-expired' };
  }
  if (parsed.fence < input.current.fence) {
    return { ok: false, reason: 'stale-fence' };
  }
  if (parsed.fence > input.current.fence) {
    return { ok: false, reason: 'fence-ahead' };
  }
  if (parsed.holderId !== input.current.holderId) {
    return { ok: false, reason: 'holder-mismatch' };
  }
  return { ok: false, reason: 'lease-expired' };
}
