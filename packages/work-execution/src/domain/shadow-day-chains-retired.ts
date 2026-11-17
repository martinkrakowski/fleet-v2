// Lane SH14: the S7 retire-fact check. Chains are not kept through the
// cutover, so a recorded policy fact plus the two sides' chain lists is
// enough. Pure: no filesystem, no subprocess, no clock, no chain comparison.
// Never throws, never echoes an input value; the only exported function takes
// `unknown` and returns a typed refusal with a named reason code.

import { CHAIN_RECORD_STATES, type ChainRecordState } from './chain-records.js';
import type { ShadowCriterionEvaluation } from './shadow-evidence-ledger.js';
import { readExactPlainRecord } from './plain-record-reads.js';

/**
 * OD-5, owner 2026-11-16: chains are retired before the cutover; S7 passes
 * only as 'not kept'. Changing this to true is an owner decision and leaves
 * S7 unevaluated until a chain-shadow comparison is built.
 */
export const SHADOW_CHAINS_POLICY = Object.freeze({ chainsKept: false } as const);

/**
 * Cap on each side's list. A longer list is `invalid-input`, refused from
 * its own `length` before any element is read.
 */
export const SHADOW_CHAINS_MAX_ITEMS = 1_000;

/** Per shell-chain name. Anything outside 1..this many characters is invalid. */
const SHELL_CHAIN_NAME_MAX_CHARS = 128;

type FleetActiveChainState = Exclude<ChainRecordState, 'refused' | 'landed'>;

/** `true` for the two terminal states subtracted from `CHAIN_RECORD_STATES`. */
function isRetiredChainState(state: ChainRecordState): state is 'refused' | 'landed' {
  return state === 'refused' || state === 'landed';
}

/**
 * Fleet states that still count as active: `CHAIN_RECORD_STATES` minus
 * `refused` and `landed`. A state added to `CHAIN_RECORD_STATES` later is
 * active too, so the check fails closed.
 */
export const SHADOW_FLEET_ACTIVE_CHAIN_STATES: readonly FleetActiveChainState[] = Object.freeze(
  CHAIN_RECORD_STATES.filter(
    (state): state is FleetActiveChainState => !isRetiredChainState(state),
  ),
);

const CHAIN_RECORD_STATE_SET: ReadonlySet<string> = new Set(CHAIN_RECORD_STATES);
const FLEET_ACTIVE_CHAIN_STATE_SET: ReadonlySet<string> = new Set(SHADOW_FLEET_ACTIVE_CHAIN_STATES);
const INPUT_KEYS: readonly string[] = ['policy', 'fleetChainStates', 'shellChainNames'];

/** S7's evaluation: the shared criterion shape plus the two active counts. */
export type ShadowChainsRetiredEvaluation = ShadowCriterionEvaluation & {
  readonly fleetActive: number;
  readonly shellActive: number;
};

type ShadowChainsStatus = ShadowChainsRetiredEvaluation['status'];

function evaluation(
  status: ShadowChainsStatus,
  reason: string,
  fleetActive: number,
  shellActive: number,
): ShadowChainsRetiredEvaluation {
  return Object.freeze({ status, reason, fleetActive, shellActive });
}

const INVALID_INPUT = evaluation('unknown', 'invalid-input', 0, 0);
const CHAINS_KEPT = evaluation('unknown', 'chains-kept-not-evaluable', 0, 0);
const UNREADABLE = evaluation('unknown', 'chain-state-unreadable', 0, 0);

interface BoundedArray {
  readonly array: readonly unknown[];
  readonly length: number;
}

interface ChainSide {
  readonly kind: 'unreadable' | 'read';
  readonly active: number;
}

const UNREADABLE_SIDE: ChainSide = Object.freeze({ kind: 'unreadable', active: 0 });

type ElementKind = 'invalid' | 'inactive' | 'active';

/** A real array (`Array.prototype`), not a subclass or array-like stand-in. */
function isRealArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
}

/** The descriptor's data `length`, or null when it is missing or an accessor. */
function dataLength(descriptor: PropertyDescriptor | undefined): number | null {
  if (descriptor === undefined) {
    return null;
  }
  if (descriptor.get !== undefined) {
    return null;
  }
  const value: unknown = descriptor.value;
  if (typeof value !== 'number') {
    return null;
  }
  if (!Number.isSafeInteger(value)) {
    return null;
  }
  return value;
}

/**
 * The array's own `length` when it is inside the cap. Reads the descriptor
 * only, so a Proxy `get` trap never runs, and an over-cap length returns
 * before any key is enumerated.
 */
function lengthWithinCap(value: readonly unknown[], cap: number): number | null {
  const length = dataLength(Object.getOwnPropertyDescriptor(value, 'length'));
  if (length === null || length < 0 || length > cap) {
    return null;
  }
  return length;
}

/** True when the own enumerable keys are exactly the indices `0 .. length`. */
function isDense(value: readonly unknown[], length: number): boolean {
  return Object.keys(value).length === length;
}

/**
 * A dense array within the cap, plus the length already read from its
 * descriptor. Callers iterate with that length and never read `.length`
 * again: a property read on a Proxy would run its `get` trap.
 */
function readBoundedArray(value: unknown, cap: number): BoundedArray | null {
  if (!isRealArray(value)) {
    return null;
  }
  const length = lengthWithinCap(value, cap);
  if (length === null || !isDense(value, length)) {
    return null;
  }
  return { array: value, length };
}

/** The own data element at `index`. A hole or an accessor is `undefined`, and no getter runs. */
function ownElement(array: readonly unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
  if (descriptor === undefined) {
    return undefined;
  }
  if (!('value' in descriptor)) {
    return undefined;
  }
  return descriptor.value;
}

function fleetElementKind(element: unknown): ElementKind {
  if (typeof element !== 'string' || !CHAIN_RECORD_STATE_SET.has(element)) {
    return 'invalid';
  }
  if (FLEET_ACTIVE_CHAIN_STATE_SET.has(element)) {
    return 'active';
  }
  return 'inactive';
}

function shellElementKind(element: unknown): ElementKind {
  if (typeof element !== 'string') {
    return 'invalid';
  }
  if (element.length < 1 || element.length > SHELL_CHAIN_NAME_MAX_CHARS) {
    return 'invalid';
  }
  return 'active';
}

/** How many elements are active, or null when one is not a legal element. */
function countActive(list: BoundedArray, kindOf: (element: unknown) => ElementKind): number | null {
  let active = 0;
  for (let index = 0; index < list.length; index += 1) {
    const kind = kindOf(ownElement(list.array, index));
    if (kind === 'invalid') {
      return null;
    }
    if (kind === 'active') {
      active += 1;
    }
  }
  return active;
}

/**
 * `null` means that side could not be read. Any other stand-in, an over-cap
 * list, or an illegal element is `null` (invalid). Otherwise the active count.
 */
function readSide(value: unknown, kindOf: (element: unknown) => ElementKind): ChainSide | null {
  if (value === null) {
    return UNREADABLE_SIDE;
  }
  const list = readBoundedArray(value, SHADOW_CHAINS_MAX_ITEMS);
  if (list === null) {
    return null;
  }
  const active = countActive(list, kindOf);
  if (active === null) {
    return null;
  }
  return { kind: 'read', active };
}

/** `policy` is exactly `{ chainsKept: boolean }`, read through its own descriptors. */
function readChainsKept(value: unknown): boolean | null {
  const policy = readExactPlainRecord(value, ['chainsKept']);
  if (policy === null || typeof policy.chainsKept !== 'boolean') {
    return null;
  }
  return policy.chainsKept;
}

function judgeCounts(fleetActive: number, shellActive: number): ShadowChainsRetiredEvaluation {
  if (fleetActive > 0 || shellActive > 0) {
    return evaluation('fail', 'chain-active-while-retired', fleetActive, shellActive);
  }
  return evaluation('pass', 'chains-not-kept', fleetActive, shellActive);
}

/**
 * Shape, then `chainsKept`, then an unreadable side, then the counts.
 * Invalid input wins over every later rule, and `chainsKept: true` wins
 * over an unreadable or active list.
 */
function judgeShadowChainsRetired(input: unknown): ShadowChainsRetiredEvaluation {
  const snapshot = readExactPlainRecord(input, INPUT_KEYS);
  if (snapshot === null) {
    return INVALID_INPUT;
  }
  const kept = readChainsKept(snapshot.policy);
  const fleet = readSide(snapshot.fleetChainStates, fleetElementKind);
  const shell = readSide(snapshot.shellChainNames, shellElementKind);
  if (kept === null || fleet === null || shell === null) {
    return INVALID_INPUT;
  }
  if (kept === true) {
    return CHAINS_KEPT;
  }
  if (fleet.kind === 'unreadable' || shell.kind === 'unreadable') {
    return UNREADABLE;
  }
  return judgeCounts(fleet.active, shell.active);
}

/**
 * S7, chains are not kept. `fleetChainStates` is the `state` of every fleet
 * chain record of the repository; `shellChainNames` is the names of the
 * shell train's active chain files; `null` on a side means that side could
 * not be read. `policy.chainsKept: true` is not evaluable: no chain-shadow
 * comparison exists.
 *
 * Cost: linear in the capped input. Each side walks at most
 * `SHADOW_CHAINS_MAX_ITEMS` elements, and each shell name is bounded by
 * `SHELL_CHAIN_NAME_MAX_CHARS`. An oversized, sparse, or non-dense list is
 * refused from its own `length` before any element is read. Every value is
 * read through its own property descriptor, so no getter ever runs, and a
 * Proxy stand-in either is refused or yields exactly the plain data's
 * verdict. Never throws, never echoes an input value.
 */
export function evaluateShadowChainsRetired(input: unknown): ShadowChainsRetiredEvaluation {
  try {
    return judgeShadowChainsRetired(input);
  } catch {
    // A revoked Proxy, or a trap that throws, is still a typed refusal.
    return INVALID_INPUT;
  }
}
