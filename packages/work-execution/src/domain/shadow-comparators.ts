// Lane CO31: pure shadow comparators for the cutover shadow period.
// Pure: no filesystem, no subprocess, no clock, no id minted here.
// Ids and codes only; an unknown or malformed item is reported, never guessed.

import { containsSecretShape } from '@fleet/shared';
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
type ComparePair<T> = { readonly fleet: readonly T[]; readonly shell: readonly T[] };

function isRecordObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafePullRequest(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isBoundedId(value: unknown, pattern: RegExp, maxLength: number): value is string {
  if (typeof value !== 'string' || value.length > maxLength) return false;
  return pattern.test(value) && !containsSecretShape(value);
}

function validateMergeSetItem(item: unknown, side: 'fleet' | 'shell'): ValidatedEntry | null {
  if (!isRecordObject(item)) return null;
  const { pullRequest, headOid } = item;
  if (!isSafePullRequest(pullRequest) || !isMergeHex40(headOid)) return null;
  return { key: `${pullRequest}@${headOid}`, value: side === 'fleet' ? 'would-merge' : 'merged' };
}

function validateGateVerdictItem(item: unknown): ValidatedEntry | null {
  if (!isRecordObject(item)) return null;
  const { headOid, predicate, verdict } = item;
  if (!isMergeHex40(headOid) || !isBoundedId(predicate, PREDICATE_PATTERN, 120)) return null;
  if (typeof verdict !== 'string' || !GATE_VERDICTS.includes(verdict)) return null;
  return { key: `${headOid}#${predicate}`, value: verdict };
}

function validatePremergeStatusItem(item: unknown): ValidatedEntry | null {
  if (!isRecordObject(item)) return null;
  const { headOid, state } = item;
  if (!isMergeHex40(headOid)) return null;
  if (typeof state !== 'string' || !PREMERGE_STATES.includes(state)) return null;
  return { key: headOid, value: state };
}

function validateEnqueueSetItem(item: unknown): ValidatedEntry | null {
  if (!isRecordObject(item)) return null;
  const { pullRequest, headOid, base } = item;
  if (!isSafePullRequest(pullRequest) || !isMergeHex40(headOid)) return null;
  const parsedBase = parseBaseBranch(base);
  if (parsedBase === undefined) return null;
  return { key: `${pullRequest}@${headOid}@${parsedBase}`, value: 'queued' };
}

function validateChainMemberItem(item: unknown): ValidatedEntry | null {
  if (!isRecordObject(item)) return null;
  const { chain, pullRequest, headOid } = item;
  if (!isBoundedId(chain, CHAIN_PATTERN, 200)) return null;
  if (!isSafePullRequest(pullRequest) || !isMergeHex40(headOid)) return null;
  return { key: `${chain}@${pullRequest}@${headOid}`, value: 'member' };
}

function validateBriefVerdictItem(item: unknown): ValidatedEntry | null {
  if (!isRecordObject(item)) return null;
  const { briefId, verdict } = item;
  if (!isBoundedId(briefId, BRIEF_ID_PATTERN, 128)) return null;
  if (typeof verdict !== 'string' || verdict.length > 64 || !BRIEF_VERDICT_PATTERN.test(verdict)) return null;
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
  const entries: ValidatedEntry[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const entry = validate(input[index], side);
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

type CompareInput = Readonly<Record<string, unknown>>;

function compareShadowLists(kind: ShadowComparisonKind, input: CompareInput, validate: ItemValidator): ShadowComparisonResult {
  try {
    const divergences: ShadowDivergence[] = [];
    const fleetEntries = collectSide('fleet', input.fleet, validate, divergences);
    const shellEntries = collectSide('shell', input.shell, validate, divergences);

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

export function compareShadowMergeSets(input: ComparePair<ShadowMergeSetItem>): ShadowComparisonResult {
  return compareShadowLists('merge-set', input, validateMergeSetItem);
}
export function compareShadowGateVerdicts(input: ComparePair<ShadowGateVerdictItem>): ShadowComparisonResult {
  return compareShadowLists('gate-verdict', input, validateGateVerdictItem);
}
export function compareShadowPremergeStatuses(input: ComparePair<ShadowPremergeStatusItem>): ShadowComparisonResult {
  return compareShadowLists('premerge-status', input, validatePremergeStatusItem);
}
export function compareShadowEnqueueSets(input: ComparePair<ShadowEnqueueSetItem>): ShadowComparisonResult {
  return compareShadowLists('enqueue-set', input, validateEnqueueSetItem);
}
export function compareShadowChainMembers(input: ComparePair<ShadowChainMemberItem>): ShadowComparisonResult {
  return compareShadowLists('chain-members', input, validateChainMemberItem);
}
export function compareShadowBriefVerdicts(input: ComparePair<ShadowBriefVerdictItem>): ShadowComparisonResult {
  return compareShadowLists('brief-verdict', input, validateBriefVerdictItem);
}
