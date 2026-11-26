/**
 * FC8C: pure host placement decider. Given known execution hosts and a start
 * request, either choose an eligible host with a free slot (`placed`), park
 * the run as `no-capacity` (`parked`, holding no slot or reservation), or
 * refuse malformed or hostile input (`refused` with a field-naming reason
 * that never echoes a value). Domain-only: no port, no adapter, no
 * persistence, no clock read, no randomness, no I/O. Hostile inputs are read
 * through the shared descriptor-based readers, so no getter and no Proxy
 * `get` trap ever runs.
 */

import {
  readBoundedDenseArray,
  readExactPlainRecord,
  readPlainRecordWithOptionalKeys,
  snapshotPlainDataRecord,
} from './plain-record-reads.js';

/** Hard cap on how many hosts a single placement request may carry. */
export const MAX_PLACEMENT_HOSTS = 1000;

/** One known execution host and its slot accounting. */
export interface HostPlacementCandidate {
  readonly hostId: string;
  readonly maxSlots: number;
  readonly usedSlots: number;
  readonly schedulable: boolean;
}

/** The start request naming the run and an optional preferred host. */
export interface HostPlacementRequest {
  readonly runId: string;
  readonly preferredHostId?: string;
}

/** Typed outcome: placed on a host, parked for no capacity, or refused. */
export type HostPlacementDecision =
  | { readonly outcome: 'placed'; readonly hostId: string }
  | { readonly outcome: 'parked'; readonly reason: 'no-capacity' }
  | { readonly outcome: 'refused'; readonly reason: string };

/** Code-unit string comparison; deterministic across engines. */
function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A non-empty trimmed string. */
function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

/**
 * O(1) pre-gate: the raw array's `length` when it is a genuine array whose
 * own plain data `length` is a finite number `> cap` (including
 * `>= 2**32 - 1`), else null when the array is invalid for the gate's own
 * reasons. Reads only the `length` descriptor — no key enumeration, no
 * per-element copy — so the too-many-entries refusal can be issued before
 * `readBoundedDenseArray` copies anything.
 */
function peekOverlongArrayLength(value: unknown, cap: number): boolean {
  let isArray: boolean;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    isArray = Array.isArray(value);
    lengthDescriptor = isArray ? Object.getOwnPropertyDescriptor(value, 'length') : undefined;
  } catch {
    return false;
  }
  if (
    !isArray ||
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    typeof lengthDescriptor.value !== 'number'
  ) {
    return false;
  }
  const length = lengthDescriptor.value;
  return Number.isFinite(length) && length > cap;
}

/** Refusal outcome. */
function refused(reason: string): HostPlacementDecision {
  return { outcome: 'refused', reason };
}

/** Internal validated shape of one host candidate. */
interface ValidatedHost {
  readonly hostId: string;
  readonly maxSlots: number;
  readonly usedSlots: number;
  readonly schedulable: boolean;
}

/** Everything validation proved about the input. */
interface ValidatedInput {
  readonly runId: string;
  readonly preferredHostId: string | null;
  readonly hosts: readonly ValidatedHost[];
}

/**
 * Validate the whole hostile input through descriptor-based readers. Returns
 * the refusal reason on failure, or the validated internal shape. Never
 * invokes a getter or a Proxy `get` trap; any trap throw is caught by the
 * caller and mapped to the typed refusal of the outermost path.
 */
function validateHostPlacement(
  hosts: unknown,
  request: unknown,
): { readonly ok: true; readonly value: ValidatedInput } | { readonly ok: false; readonly reason: string } {
  // O(1) length pre-gate before any key enumeration: a genuine array whose
  // own plain data `length` exceeds the cap (including `>= 2**32 - 1`) is
  // refused as too-many-entries without copying anything. A Proxy throwing
  // on the `length` descriptor read is refused as invalid hosts.
  let overlong: boolean;
  try {
    overlong = peekOverlongArrayLength(hosts, MAX_PLACEMENT_HOSTS);
  } catch {
    return { ok: false, reason: 'hosts:invalid' };
  }
  if (overlong) {
    return { ok: false, reason: 'hosts:too-many-entries' };
  }
  let bounded: ReturnType<typeof readBoundedDenseArray>;
  try {
    bounded = readBoundedDenseArray(hosts, MAX_PLACEMENT_HOSTS);
  } catch {
    return { ok: false, reason: 'hosts:invalid' };
  }
  if (bounded === null) {
    return { ok: false, reason: 'hosts:invalid' };
  }

  let requestSnapshot: ReturnType<typeof snapshotPlainDataRecord>;
  try {
    requestSnapshot = snapshotPlainDataRecord(request);
  } catch {
    return { ok: false, reason: 'request:invalid' };
  }
  if (requestSnapshot === null) {
    // A non-plain request, an enumerable getter, or a prototype-polluting
    // key: refused without ever invoking the getter.
    return { ok: false, reason: 'request:invalid' };
  }
  if (!Object.hasOwn(requestSnapshot, 'runId')) {
    return { ok: false, reason: 'request.runId:invalid' };
  }
  let requestRecord: ReturnType<typeof readPlainRecordWithOptionalKeys>;
  try {
    requestRecord = readPlainRecordWithOptionalKeys(request, ['runId'], ['preferredHostId']);
  } catch {
    return { ok: false, reason: 'request:invalid' };
  }
  if (requestRecord === null) {
    // A symbol key or an unknown extra key.
    return { ok: false, reason: 'request:invalid' };
  }
  const runId = requestSnapshot.runId;
  if (!isNonEmptyTrimmedString(runId)) {
    return { ok: false, reason: 'request.runId:invalid' };
  }
  const preferredRaw = requestSnapshot.preferredHostId;
  if (preferredRaw !== undefined && !isNonEmptyTrimmedString(preferredRaw)) {
    return { ok: false, reason: 'request.preferredHostId:invalid' };
  }

  const hostIds = new Set<string>();
  const validatedHosts: ValidatedHost[] = [];
  for (let index = 0; index < bounded.length; index += 1) {
    const rawHost = bounded.array[index];
    let hostSnapshot: ReturnType<typeof snapshotPlainDataRecord>;
    let hostRecord: ReturnType<typeof readExactPlainRecord>;
    try {
      hostRecord = readExactPlainRecord(rawHost, ['hostId', 'maxSlots', 'usedSlots', 'schedulable']);
      hostSnapshot = snapshotPlainDataRecord(rawHost);
    } catch {
      // A revoked or lying Proxy throwing on any reflection read of this
      // entry is mapped to the per-index refusal.
      return { ok: false, reason: `hosts[${index}]:invalid-record` };
    }
    if (hostRecord === null || hostSnapshot === null) {
      // A malformed shape or an enumerable getter (never invoked).
      return { ok: false, reason: `hosts[${index}]:invalid-record` };
    }
    const hostId = hostSnapshot.hostId;
    if (!isNonEmptyTrimmedString(hostId)) {
      return { ok: false, reason: `hosts[${index}].hostId:invalid` };
    }
    if (hostIds.has(hostId)) {
      return { ok: false, reason: 'hosts.hostId:duplicate' };
    }
    hostIds.add(hostId);
    const rawMaxSlots = hostSnapshot.maxSlots;
    if (typeof rawMaxSlots !== 'number' || !Number.isSafeInteger(rawMaxSlots) || rawMaxSlots < 0) {
      return { ok: false, reason: `hosts[${index}].maxSlots:invalid` };
    }
    const maxSlots: number = rawMaxSlots;
    const rawUsedSlots = hostSnapshot.usedSlots;
    if (typeof rawUsedSlots !== 'number' || !Number.isSafeInteger(rawUsedSlots) || rawUsedSlots < 0) {
      return { ok: false, reason: `hosts[${index}].usedSlots:invalid` };
    }
    const usedSlots: number = rawUsedSlots;
    if (usedSlots > maxSlots) {
      return { ok: false, reason: `hosts[${index}].usedSlots:exceeds-maxSlots` };
    }
    const schedulable = hostSnapshot.schedulable;
    if (typeof schedulable !== 'boolean') {
      return { ok: false, reason: `hosts[${index}].schedulable:invalid` };
    }
    validatedHosts.push({
      hostId,
      maxSlots,
      usedSlots,
      schedulable,
    });
  }

  return {
    ok: true,
    value: {
      runId,
      preferredHostId: preferredRaw === undefined ? null : preferredRaw,
      hosts: validatedHosts,
    },
  };
}

/**
 * Decide the host placement for one start request. Hostile inputs are
 * refused with a typed reason naming the field and failure kind (never
 * echoing a value); no getter or Proxy `get` trap ever runs; neither input
 * is ever mutated. The decision is O(n) over the hosts n <=
 * MAX_PLACEMENT_HOSTS, plus the accepted O(K) engine bound for the
 * `Reflect.ownKeys` calls inside the shared readers.
 */
export function decideHostPlacement(hosts: unknown, request: unknown): HostPlacementDecision {
  try {
    const validated = validateHostPlacement(hosts, request);
    if (!validated.ok) {
      return refused(validated.reason);
    }
    const { hosts: validatedHosts, preferredHostId } = validated.value;

    const eligible = validatedHosts.filter(
      (host) => host.schedulable && host.usedSlots < host.maxSlots,
    );
    if (eligible.length === 0) {
      return { outcome: 'parked', reason: 'no-capacity' };
    }

    if (preferredHostId !== null) {
      const preferred = eligible.find((host) => host.hostId === preferredHostId);
      if (preferred !== undefined) {
        return { outcome: 'placed', hostId: preferred.hostId };
      }
    }

    // The eligible host with the most free slots; ties broken deterministically
    // by hostId ascending in code-unit order.
    let best = eligible[0];
    for (const host of eligible) {
      const bestFree = best.maxSlots - best.usedSlots;
      const hostFree = host.maxSlots - host.usedSlots;
      if (hostFree > bestFree || (hostFree === bestFree && compareCodeUnit(host.hostId, best.hostId) < 0)) {
        best = host;
      }
    }
    return { outcome: 'placed', hostId: best.hostId };
  } catch {
    // A revoked or lying Proxy that throws anywhere along the read path is
    // mapped to the typed refusal; a Proxy that lies consistently in every
    // trap is the accepted residual.
    return refused('hosts:invalid');
  }
}
