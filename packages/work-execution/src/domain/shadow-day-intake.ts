// Lane SH5c: the S8 intake evaluator — queue coverage and import fidelity
// over two samples. Pure: no filesystem, no subprocess, no clock. Never
// throws, never echoes an input value; every exported function takes
// `unknown` at its boundary and reports an unevaluable result with a named
// reason. Own data properties only: every value is read through its property
// descriptor, so a getter never runs and a `get` trap is never reached.

import { parseBaseBranch, type BaseBranchValue } from './base-branch.js';
import { isZonedIsoDateTime } from './conductor-halt.js';
import { isMergeHex40 } from './merge-queue-records.js';
import { readExactPlainRecord } from './plain-record-reads.js';
import type { ShadowCriterionEvaluation } from './shadow-evidence-ledger.js';
import { compareShadowEnqueueSets, type ShadowComparisonResult } from './shadow-comparators.js';

/**
 * The minimum time two samples must be apart for their agreement to count as
 * persistent rather than a snapshot artifact: two independently-moving systems
 * sampled seconds apart can manufacture a divergence that resolves itself
 * immediately after.
 */
export const SHADOW_INTAKE_MIN_GAP_MS = 120_000;

/**
 * The most keys one sample may carry on any of its four lists. An oversized
 * list is refused from its own `length` before any element is traversed.
 */
export const SHADOW_INTAKE_MAX_KEYS = 10_000;

const SAMPLE_KEYS = ['takenAtIso', 'complete', 'shellLive', 'fleetLive', 'importPresent', 'importUnknownLines'] as const;
const KEY_FIELD_NAMES = ['pullRequest', 'headOid', 'base'] as const;

const SAMPLES_INVALID: ShadowCriterionEvaluation = { status: 'unknown', reason: 'samples-invalid' };
const SHELL_STATE_INCOMPLETE: ShadowCriterionEvaluation = { status: 'unknown', reason: 'shell-state-incomplete' };
const IMPORT_UNAVAILABLE: ShadowCriterionEvaluation = { status: 'unknown', reason: 'import-unavailable' };
const COVERAGE_DIVERGENCE: ShadowCriterionEvaluation = { status: 'fail', reason: 'enqueue-coverage-divergence' };
const UNKNOWN_LINES: ShadowCriterionEvaluation = { status: 'fail', reason: 'import-unknown-lines' };
const IMPORT_DIVERGENCE: ShadowCriterionEvaluation = { status: 'fail', reason: 'import-divergence' };
const CHAIN_BASE: ShadowCriterionEvaluation = { status: 'fail', reason: 'chain-base-not-importable' };
const INTAKE_EQUAL: ShadowCriterionEvaluation = { status: 'pass', reason: 'intake-equal' };

/** One observed enqueue key: the pull request, its head and its base branch. */
interface ValidatedKey {
  readonly pullRequest: number;
  readonly headOid: string;
  readonly base: BaseBranchValue;
}

/** One intake sample, every list freshly read as own data properties. */
interface ValidatedSample {
  readonly takenAtIso: string;
  readonly complete: boolean;
  readonly shellLive: readonly ValidatedKey[];
  readonly fleetLive: readonly ValidatedKey[];
  readonly importPresent: readonly ValidatedKey[] | null;
  readonly importUnknownLines: number;
}

/**
 * The capped element list of a real, dense array, or null for any stand-in,
 * sparse, oversized, accessor-polluted or extra-keyed array. `Object.keys`
 * lists own enumerable string keys without reading any value, so it runs no
 * getter; comparing its count to `length` catches both a hole (fewer keys
 * than `length`) and an extra own enumerable property such as a getter
 * planted beside the indices — either way the array is refused from its
 * `length`/keys before a single element is read.
 */
function boundedList(value: unknown, cap: number): readonly unknown[] | null {
  // `Array.isArray` follows a Proxy without running a trap; the length is
  // read from its own descriptor, so no `get` trap ever runs.
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    typeof lengthDescriptor.value !== 'number' ||
    lengthDescriptor.value > cap
  ) {
    return null;
  }
  if (Object.keys(value).length !== lengthDescriptor.value) {
    return null;
  }
  return value as readonly unknown[];
}

/** The own enumerable data-property element at `index`, or undefined for a hole or an accessor. */
function ownElement(array: readonly unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
  return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor ? descriptor.value : undefined;
}

/**
 * One enqueue key from its own data properties, or null: a safe positive
 * integer pull request, a 40-hex head, a declared base branch. A getter is
 * never run — its descriptor value is read directly.
 */
function validateKey(raw: unknown): ValidatedKey | null {
  const snapshot = readExactPlainRecord(raw, KEY_FIELD_NAMES);
  if (snapshot === null) {
    return null;
  }
  const { pullRequest, headOid, base } = snapshot;
  if (typeof pullRequest !== 'number' || !Number.isSafeInteger(pullRequest) || pullRequest < 1) {
    return null;
  }
  if (typeof headOid !== 'string' || !isMergeHex40(headOid)) {
    return null;
  }
  if (typeof base !== 'string') {
    return null;
  }
  const parsedBase = parseBaseBranch(base);
  if (parsedBase === undefined) {
    return null;
  }
  return { pullRequest, headOid, base: parsedBase };
}

/** Every element of a bounded list as a key, or null when any is out of shape. */
function validateKeys(raw: unknown, arrayCap: number): readonly ValidatedKey[] | null {
  const list = boundedList(raw, arrayCap);
  if (list === null) {
    return null;
  }
  const keys: ValidatedKey[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const key = validateKey(ownElement(list, index));
    if (key === null) {
      return null;
    }
    keys.push(key);
  }
  return keys;
}

/**
 * One sample from its own data properties, or null when any field is out of
 * shape. An accessor standing in for any field yields an undefined snapshot
 * value, which every check below refuses before it is used.
 */
function validateSample(raw: unknown): ValidatedSample | null {
  const snapshot = readExactPlainRecord(raw, SAMPLE_KEYS);
  if (snapshot === null) {
    return null;
  }
  const { takenAtIso, complete, shellLive, fleetLive, importPresent, importUnknownLines } = snapshot;
  if (!isZonedIsoDateTime(takenAtIso)) {
    return null;
  }
  if (typeof complete !== 'boolean') {
    return null;
  }
  const shellKeys = validateKeys(shellLive, SHADOW_INTAKE_MAX_KEYS);
  const fleetKeys = validateKeys(fleetLive, SHADOW_INTAKE_MAX_KEYS);
  if (shellKeys === null || fleetKeys === null) {
    return null;
  }
  let importKeys: readonly ValidatedKey[] | null = null;
  if (importPresent !== null) {
    const read = validateKeys(importPresent, SHADOW_INTAKE_MAX_KEYS);
    if (read === null) {
      return null;
    }
    importKeys = read;
  }
  if (
    typeof importUnknownLines !== 'number' ||
    !Number.isSafeInteger(importUnknownLines) ||
    importUnknownLines < 0
  ) {
    return null;
  }
  return {
    takenAtIso,
    complete,
    shellLive: shellKeys,
    fleetLive: fleetKeys,
    importPresent: importKeys,
    importUnknownLines,
  };
}

/**
 * One sample's two comparisons: `A` is the live-coverage comparison of the
 * fleet queue against the whole shell live set; `B` is the import-fidelity
 * comparison of the import dry-run against the shell entries on `main` only,
 * since a chain-base entry can never be imported.
 */
function sampleComparisons(sample: ValidatedSample): { readonly a: ShadowComparisonResult; readonly b: ShadowComparisonResult } {
  const shellMain = sample.shellLive.filter((key) => key.base === 'main');
  return {
    a: compareShadowEnqueueSets({ fleet: sample.fleetLive, shell: sample.shellLive }),
    b: compareShadowEnqueueSets({ fleet: sample.importPresent ?? [], shell: shellMain }),
  };
}

/** True when the two comparisons share at least one (key, code) divergence. */
function sharedDivergence(first: ShadowComparisonResult, second: ShadowComparisonResult): boolean {
  const codes = new Set(first.divergences.map((divergence) => `${divergence.key}\u0000${divergence.code}`));
  return second.divergences.some((divergence) => codes.has(`${divergence.key}\u0000${divergence.code}`));
}

/** True when a chain-base shell key appears in both samples' live sets. */
function persistentChainBase(first: readonly ValidatedKey[], second: readonly ValidatedKey[]): boolean {
  const chainKeys = (keys: readonly ValidatedKey[]) =>
    new Set(keys.filter((key) => key.base !== 'main').map((key) => `${key.pullRequest}@${key.headOid}@${key.base}`));
  const firstChain = chainKeys(first);
  for (const key of chainKeys(second)) {
    if (firstChain.has(key)) {
      return true;
    }
  }
  return false;
}

/**
 * The S8 intake evaluation over two samples taken at least
 * `SHADOW_INTAKE_MIN_GAP_MS` apart: a divergence counted only when it is
 * present in both samples' comparison is persistent and real; one present in
 * a single sample is a snapshot artifact of two independently-moving systems.
 *
 * Checks, in order: the input must be exactly two well-shaped samples with a
 * sufficient gap (`samples-invalid`); both shell reads must be complete
 * (`shell-state-incomplete`); both import dry-runs must have been available
 * (`import-unavailable`); then a persistent live-coverage divergence fails
 * (`enqueue-coverage-divergence`), any unparseable import line fails
 * (`import-unknown-lines`, checked before the B comparison), a persistent
 * import-fidelity divergence fails (`import-divergence`), a chain-base shell
 * key present in both samples fails (`chain-base-not-importable`), and
 * otherwise the intake is equal.
 *
 * Cost: linear in the capped input — at most two samples, each with four
 * lists capped at `SHADOW_INTAKE_MAX_KEYS` keys, each key and field read once
 * through its own descriptor; the comparisons are linear in the same bounds.
 * Never throws, never echoes an input value, never runs a getter or reaches a
 * `get` trap.
 */
export function evaluateShadowIntake(input: unknown): ShadowCriterionEvaluation {
  try {
    const samplesRaw = readExactPlainRecord(input, ['samples']);
    if (samplesRaw === null) {
      return SAMPLES_INVALID;
    }
    const pair = boundedList(samplesRaw.samples, 2);
    if (pair === null || pair.length !== 2) {
      return SAMPLES_INVALID;
    }
    const first = validateSample(ownElement(pair, 0));
    const second = validateSample(ownElement(pair, 1));
    if (first === null || second === null) {
      return SAMPLES_INVALID;
    }
    const firstMs = Date.parse(first.takenAtIso);
    const secondMs = Date.parse(second.takenAtIso);
    if (Math.abs(secondMs - firstMs) < SHADOW_INTAKE_MIN_GAP_MS) {
      return SAMPLES_INVALID;
    }
    if (!first.complete || !second.complete) {
      return SHELL_STATE_INCOMPLETE;
    }
    if (first.importPresent === null || second.importPresent === null) {
      return IMPORT_UNAVAILABLE;
    }
    const firstComparison = sampleComparisons(first);
    const secondComparison = sampleComparisons(second);
    if (sharedDivergence(firstComparison.a, secondComparison.a)) {
      return COVERAGE_DIVERGENCE;
    }
    if (first.importUnknownLines > 0 || second.importUnknownLines > 0) {
      return UNKNOWN_LINES;
    }
    if (sharedDivergence(firstComparison.b, secondComparison.b)) {
      return IMPORT_DIVERGENCE;
    }
    if (persistentChainBase(first.shellLive, second.shellLive)) {
      return CHAIN_BASE;
    }
    return INTAKE_EQUAL;
  } catch {
    return SAMPLES_INVALID;
  }
}
