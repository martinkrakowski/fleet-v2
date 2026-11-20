// Lane CO31: pure shadow comparators for the cutover shadow period.
// Pure: no filesystem, no subprocess, no clock, no id minted here.
// Ids and codes only; an unknown or malformed item is reported, never guessed.

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import { parseBaseBranch } from './base-branch.js';
import { isMergeHex40 } from './merge-queue-records.js';

export const SHADOW_COMPARISON_KINDS = [
  'merge-set', 'gate-verdict', 'premerge-status', 'enqueue-set', 'chain-members', 'brief-verdict',
] as const;
export type ShadowComparisonKind = (typeof SHADOW_COMPARISON_KINDS)[number];

export const SHADOW_DIVERGENCE_CODES = [
  'missing-in-fleet', 'missing-in-shell', 'value-differs', 'false-pass', 'stricter-fail', 'invalid-item',
] as const;
export type ShadowDivergenceCode = (typeof SHADOW_DIVERGENCE_CODES)[number];

/** At most this many divergences are listed; the rest set `truncated`. */
export const SHADOW_DIVERGENCE_MAX = 50;

/**
 * At most this many items are accepted per side. An over-cap `fleet` or
 * `shell` list is refused before any element is read, so a hostile sparse
 * array of length `2**32 - 1` can never drive a traversal.
 */
export const SHADOW_SIDE_MAX_ITEMS = 10_000;

export interface ShadowDivergence {
  /** The compared key: ids only (pull request, head oid, base, chain name, predicate, brief id). */
  readonly key: string;
  readonly code: ShadowDivergenceCode;
  /** The fleet side's code, or null when the fleet side has no item. */
  readonly fleet: string | null;
  /** The shell side's code, or null when the shell side has no item. */
  readonly shell: string | null;
}

export interface ShadowComparisonResult {
  readonly kind: ShadowComparisonKind;
  readonly equal: boolean;
  /** Keys present on both sides. */
  readonly compared: number;
  /** Valid items on the fleet side. */
  readonly fleetCount: number;
  /** Valid items on the shell side. */
  readonly shellCount: number;
  /** Sorted by key, capped at SHADOW_DIVERGENCE_MAX. */
  readonly divergences: readonly ShadowDivergence[];
  /** True when more divergences exist than are listed. */
  readonly truncated: boolean;
}

export interface ShadowMergeSetItem { readonly pullRequest: unknown; readonly headOid: unknown; }
export interface ShadowGateVerdictItem { readonly headOid: unknown; readonly predicate: unknown; readonly verdict: unknown; }
export interface ShadowPremergeStatusItem { readonly headOid: unknown; readonly state: unknown; }
export interface ShadowEnqueueSetItem { readonly pullRequest: unknown; readonly headOid: unknown; readonly base: unknown; }
export interface ShadowChainMemberItem { readonly chain: unknown; readonly pullRequest: unknown; readonly headOid: unknown; }
export interface ShadowBriefVerdictItem { readonly briefId: unknown; readonly verdict: unknown; }

const GATE_VERDICTS: readonly string[] = ['pass', 'fail', 'unknown', 'skipped'];
const PREMERGE_STATES: readonly string[] = ['none', 'success', 'failure', 'refused'];
/** Set kinds compare membership only: a shared key is always equal. */
const SET_KINDS: ReadonlySet<ShadowComparisonKind> = new Set(['merge-set', 'enqueue-set', 'chain-members']);
const PREDICATE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .:_/-]*$/;
const CHAIN_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const BRIEF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const BRIEF_VERDICT_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

interface ValidatedEntry { readonly key: string; readonly value: string; }
type ItemValidator = (item: unknown, side: 'fleet' | 'shell') => ValidatedEntry | null;

/**
 * A plain object whose own properties are all data properties. An accessor
 * (getter) is refused before any field is read, so reading an item never runs
 * caller code and the comparators stay pure.
 */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => 'value' in descriptor);
}

/**
 * Read only the item's own data properties: an inherited field (for example a
 * getter planted on `Object.prototype`) reads as undefined, so it is reported
 * as an invalid item and never run.
 */
function ownFields(item: Record<string, unknown>, names: readonly string[]): unknown[] {
  // The value comes from the own data descriptor itself, never from a property
  // read, so neither a getter nor a Proxy get trap supplies it.
  return names.map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(item, name);
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  });
}

/**
 * Both secret registries, as the operator-coordination entities check them:
 * the short `SECRET_PATTERNS` misses shapes such as `github_pat_` that the
 * lane-diff registry names. A secret-shaped value is never echoed in a
 * divergence.
 */
function isSecretShaped(text: string): boolean {
  return containsSecretShape(text) || LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(text));
}

function isSafePullRequest(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isBoundedId(value: unknown, pattern: RegExp, maxLength: number): value is string {
  if (typeof value !== 'string' || value.length > maxLength) return false;
  return pattern.test(value) && !isSecretShaped(value);
}

function validateMergeSetItem(item: unknown, side: 'fleet' | 'shell'): ValidatedEntry | null {
  if (!isRecordObject(item)) return null;
  const [pullRequest, headOid] = ownFields(item, ['pullRequest', 'headOid']);
  if (!isSafePullRequest(pullRequest) || !isMergeHex40(headOid)) return null;
  return { key: `${pullRequest}@${headOid}`, value: side === 'fleet' ? 'would-merge' : 'merged' };
}

function validateGateVerdictItem(item: unknown): ValidatedEntry | null {
  if (!isRecordObject(item)) return null;
  const [headOid, predicate, verdict] = ownFields(item, ['headOid', 'predicate', 'verdict']);
  if (!isMergeHex40(headOid) || !isBoundedId(predicate, PREDICATE_PATTERN, 120)) return null;
  if (typeof verdict !== 'string' || !GATE_VERDICTS.includes(verdict)) return null;
  return { key: `${headOid}#${predicate}`, value: verdict };
}

function validatePremergeStatusItem(item: unknown): ValidatedEntry | null {
  if (!isRecordObject(item)) return null;
  const [headOid, state] = ownFields(item, ['headOid', 'state']);
  if (!isMergeHex40(headOid)) return null;
  if (typeof state !== 'string' || !PREMERGE_STATES.includes(state)) return null;
  return { key: headOid, value: state };
}

function validateEnqueueSetItem(item: unknown): ValidatedEntry | null {
  if (!isRecordObject(item)) return null;
  const [pullRequest, headOid, base] = ownFields(item, ['pullRequest', 'headOid', 'base']);
  if (!isSafePullRequest(pullRequest) || !isMergeHex40(headOid)) return null;
  const parsedBase = parseBaseBranch(base);
  if (parsedBase === undefined || isSecretShaped(parsedBase)) return null;
  return { key: `${pullRequest}@${headOid}@${parsedBase}`, value: 'queued' };
}

function validateChainMemberItem(item: unknown): ValidatedEntry | null {
  if (!isRecordObject(item)) return null;
  const [chain, pullRequest, headOid] = ownFields(item, ['chain', 'pullRequest', 'headOid']);
  if (!isBoundedId(chain, CHAIN_PATTERN, 200)) return null;
  if (!isSafePullRequest(pullRequest) || !isMergeHex40(headOid)) return null;
  return { key: `${chain}@${pullRequest}@${headOid}`, value: 'member' };
}

function validateBriefVerdictItem(item: unknown): ValidatedEntry | null {
  if (!isRecordObject(item)) return null;
  const [briefId, verdict] = ownFields(item, ['briefId', 'verdict']);
  if (!isBoundedId(briefId, BRIEF_ID_PATTERN, 128)) return null;
  if (typeof verdict !== 'string' || verdict.length > 64 || !BRIEF_VERDICT_PATTERN.test(verdict)) return null;
  if (isSecretShaped(verdict)) return null;
  return { key: briefId, value: verdict };
}

function makeDivergence(key: string, code: ShadowDivergenceCode, fleet: string | null, shell: string | null): ShadowDivergence {
  return Object.freeze({ key, code, fleet, shell });
}

function collectSide(side: 'fleet' | 'shell', input: unknown, validate: ItemValidator, divergences: ShadowDivergence[]): readonly ValidatedEntry[] {
  if (!Array.isArray(input)) {
    divergences.push(makeDivergence(`invalid-${side}-list`, 'invalid-item', null, null));
    return [];
  }
  // The length is read exactly once, through its own data descriptor, and
  // captured in a local: a Proxy `get` trap can lie differently on every
  // read (report `0` to pass the cap check, then a huge value in the loop
  // condition), so no property read ever supplies the loop bound.
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
  if (
    lengthDescriptor === undefined || !('value' in lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
  ) {
    divergences.push(makeDivergence(`invalid-${side}-list`, 'invalid-item', null, null));
    return [];
  }
  const length: number = lengthDescriptor.value;
  // Refused before any traversal: a sparse array of length 2**32 - 1 must
  // never walk its indices.
  if (length > SHADOW_SIDE_MAX_ITEMS) {
    divergences.push(makeDivergence(`invalid-${side}-list`, 'invalid-item', null, null));
    return [];
  }
  // The length itself was read through `getOwnPropertyDescriptor`, which on a
  // Proxy is the hostile `getOwnPropertyDescriptor` trap (a plain array's
  // `length` is non-configurable but writable, so the trap may report any
  // value without breaking the engine's invariants). A reported length is
  // therefore accepted only when the index descriptors the object itself
  // exposes agree with it: a plain array owns exactly the indices below its
  // length (holes included), so index `length - 1` must exist and index
  // `length` must not. A proxy that reports length 0 over a one-item array
  // still exposes index 0 here, and the list is refused instead of silently
  // compared as empty.
  const beyondEnd = Object.getOwnPropertyDescriptor(input, length);
  const last = length > 0 ? Object.getOwnPropertyDescriptor(input, length - 1) : undefined;
  if (beyondEnd !== undefined || (length > 0 && last === undefined)) {
    divergences.push(makeDivergence(`invalid-${side}-list`, 'invalid-item', null, null));
    return [];
  }
  const entries: ValidatedEntry[] = [];
  for (let index = 0; index < length; index += 1) {
    // Read through the own data descriptor only: an array hole, a prototype
    // index property, or a Proxy get trap yields no own data descriptor, so
    // the element is invalid and no getter or trap ever runs.
    const descriptor = Object.getOwnPropertyDescriptor(input, index);
    if (descriptor === undefined || !('value' in descriptor)) {
      divergences.push(makeDivergence(`invalid-${side}-${index}`, 'invalid-item', null, null));
      continue;
    }
    const entry = validate(descriptor.value, side);
    if (entry === null) {
      divergences.push(makeDivergence(`invalid-${side}-${index}`, 'invalid-item', null, null));
    } else {
      entries.push(entry);
    }
  }
  return entries;
}

function duplicatedKeys(sides: readonly (readonly ValidatedEntry[])[]): Set<string> {
  const duplicated = new Set<string>();
  for (const entries of sides) {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.key)) {
        duplicated.add(entry.key);
      } else {
        seen.add(entry.key);
      }
    }
  }
  return duplicated;
}

function buildMap(entries: readonly ValidatedEntry[], excluded: ReadonlySet<string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (excluded.has(entry.key)) continue;
    if (!map.has(entry.key)) map.set(entry.key, entry.value);
  }
  return map;
}

function divergenceCodeFor(kind: ShadowComparisonKind, fleetValue: string, shellValue: string): ShadowDivergenceCode {
  if (kind === 'gate-verdict') {
    if (fleetValue === 'pass' && shellValue !== 'pass') return 'false-pass';
    if (fleetValue === 'fail' && shellValue === 'pass') return 'stricter-fail';
  }
  return 'value-differs';
}

function fallbackResult(kind: ShadowComparisonKind): ShadowComparisonResult {
  return Object.freeze({
    kind,
    equal: false,
    compared: 0,
    fleetCount: 0,
    shellCount: 0,
    divergences: Object.freeze([makeDivergence('comparison', 'invalid-item', null, null)]),
    truncated: false,
  });
}

type CompareInput = unknown;

/**
 * True when `value` carries an own prototype-polluting key (`__proto__`,
 * `constructor` or `prototype`), as `JSON.parse` can produce. Such a key is
 * never treated as data.
 */
function hasPrototypePollutingKey(value: Record<string, unknown>): boolean {
  return Reflect.ownKeys(value).some(
    (key) => key === '__proto__' || key === 'constructor' || key === 'prototype',
  );
}

/**
 * Compare the two sides of one shadow record. Cost: linear in the capped
 * input — at most `SHADOW_SIDE_MAX_ITEMS` elements per side, each validated
 * once, plus a key map build; at most `SHADOW_DIVERGENCE_MAX` divergences are
 * listed. The root `input` is read through its own data-property descriptors
 * only: a null, primitive, array, non-plain object, object carrying any
 * accessor property, or object with an own prototype-polluting key returns
 * the fallback result before any property is read, so no getter and no Proxy
 * `get` trap ever runs.
 */
function compareShadowLists(kind: ShadowComparisonKind, input: CompareInput, validate: ItemValidator): ShadowComparisonResult {
  try {
    if (!isRecordObject(input) || hasPrototypePollutingKey(input)) return fallbackResult(kind);
    const [fleetValue, shellValue] = ownFields(input, ['fleet', 'shell']);
    const divergences: ShadowDivergence[] = [];
    const fleetEntries = collectSide('fleet', fleetValue, validate, divergences);
    const shellEntries = collectSide('shell', shellValue, validate, divergences);

    const duplicated = duplicatedKeys([fleetEntries, shellEntries]);
    for (const key of duplicated) {
      divergences.push(makeDivergence(key, 'invalid-item', null, null));
    }

    const fleetMap = buildMap(fleetEntries, duplicated);
    const shellMap = buildMap(shellEntries, duplicated);

    let compared = 0;
    for (const key of fleetMap.keys()) {
      if (shellMap.has(key)) compared += 1;
    }

    for (const [key, fleetValue] of fleetMap) {
      const shellValue = shellMap.get(key);
      if (shellValue === undefined) {
        divergences.push(makeDivergence(key, 'missing-in-shell', fleetValue, null));
      } else if (!SET_KINDS.has(kind) && fleetValue !== shellValue) {
        divergences.push(makeDivergence(key, divergenceCodeFor(kind, fleetValue, shellValue), fleetValue, shellValue));
      }
    }
    for (const [key, shellValue] of shellMap) {
      if (!fleetMap.has(key)) {
        divergences.push(makeDivergence(key, 'missing-in-fleet', null, shellValue));
      }
    }

    divergences.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const truncated = divergences.length > SHADOW_DIVERGENCE_MAX;
    const listed = truncated ? divergences.slice(0, SHADOW_DIVERGENCE_MAX) : divergences;

    return Object.freeze({
      kind,
      equal: divergences.length === 0,
      compared,
      fleetCount: fleetEntries.length,
      shellCount: shellEntries.length,
      divergences: Object.freeze(listed),
      truncated,
    });
  } catch {
    return fallbackResult(kind);
  }
}

/**
 * Compare the merge sets of both sides. Cost: linear in the capped input —
 * at most `SHADOW_SIDE_MAX_ITEMS` elements per side, with
 * `SHADOW_DIVERGENCE_MAX` divergences listed and `truncated` set beyond it.
 */
export function compareShadowMergeSets(input: CompareInput): ShadowComparisonResult {
  return compareShadowLists('merge-set', input, validateMergeSetItem);
}
/**
 * Compare the gate verdicts of both sides. Cost: linear in the capped input —
 * at most `SHADOW_SIDE_MAX_ITEMS` elements per side, with
 * `SHADOW_DIVERGENCE_MAX` divergences listed and `truncated` set beyond it.
 */
export function compareShadowGateVerdicts(input: CompareInput): ShadowComparisonResult {
  return compareShadowLists('gate-verdict', input, validateGateVerdictItem);
}
/**
 * Compare the premerge statuses of both sides. Cost: linear in the capped
 * input — at most `SHADOW_SIDE_MAX_ITEMS` elements per side, with
 * `SHADOW_DIVERGENCE_MAX` divergences listed and `truncated` set beyond it.
 */
export function compareShadowPremergeStatuses(input: CompareInput): ShadowComparisonResult {
  return compareShadowLists('premerge-status', input, validatePremergeStatusItem);
}
/**
 * Compare the enqueue sets of both sides. Cost: linear in the capped input —
 * at most `SHADOW_SIDE_MAX_ITEMS` elements per side, with
 * `SHADOW_DIVERGENCE_MAX` divergences listed and `truncated` set beyond it.
 */
export function compareShadowEnqueueSets(input: CompareInput): ShadowComparisonResult {
  return compareShadowLists('enqueue-set', input, validateEnqueueSetItem);
}
/**
 * Compare the chain members of both sides. Cost: linear in the capped input —
 * at most `SHADOW_SIDE_MAX_ITEMS` elements per side, with
 * `SHADOW_DIVERGENCE_MAX` divergences listed and `truncated` set beyond it.
 */
export function compareShadowChainMembers(input: CompareInput): ShadowComparisonResult {
  return compareShadowLists('chain-members', input, validateChainMemberItem);
}
/**
 * Compare the brief verdicts of both sides. Cost: linear in the capped input —
 * at most `SHADOW_SIDE_MAX_ITEMS` elements per side, with
 * `SHADOW_DIVERGENCE_MAX` divergences listed and `truncated` set beyond it.
 */
export function compareShadowBriefVerdicts(input: CompareInput): ShadowComparisonResult {
  return compareShadowLists('brief-verdict', input, validateBriefVerdictItem);
}
