// Lane SH5c: the S8 intake evaluator — queue coverage and import fidelity
// over two samples. Pure: no filesystem, no subprocess, no clock. Never
// throws, never echoes an input value; every exported function takes
// `unknown` at its boundary and reports an unevaluable result with a named
// reason. Own data properties only: every value is read through its property
// descriptor, so a getter never runs and a `get` trap is never reached.

import { parseBaseBranch, type BaseBranchValue } from './base-branch.js';
import { isZonedIsoDateTime } from './conductor-halt.js';
import { isMergeHex40 } from './merge-queue-records.js';
import { readBoundedDenseArray, readExactPlainRecord } from './plain-record-reads.js';
import type { BoundedDenseArray } from './plain-record-reads.js';
import type { ShadowCriterionEvaluation } from './shadow-evidence-ledger.js';
import {
  compareShadowEnqueueSets,
  type ShadowComparisonResult,
  type ShadowDivergenceCode,
} from './shadow-comparators.js';

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

// Every verdict below is a single shared object reused across every call to
// `evaluateShadowIntake`, never freshly constructed per call: `Object.freeze`
// here, at the point of declaration (not at the point of return), is what
// guarantees a caller mutating a returned verdict — say, flipping `status`
// from 'fail' to 'pass' — can never corrupt a later, unrelated call's result
// through that same shared reference. This matches the frozen-constant
// pattern `shadow-comparators.ts` already uses for its own shared result
// objects (`Object.freeze({ ... })`).
const SAMPLES_INVALID: ShadowCriterionEvaluation = Object.freeze({ status: 'unknown', reason: 'samples-invalid' });
const SHELL_STATE_INCOMPLETE: ShadowCriterionEvaluation = Object.freeze({ status: 'unknown', reason: 'shell-state-incomplete' });
const IMPORT_UNAVAILABLE: ShadowCriterionEvaluation = Object.freeze({ status: 'unknown', reason: 'import-unavailable' });
const COVERAGE_DIVERGENCE: ShadowCriterionEvaluation = Object.freeze({ status: 'fail', reason: 'enqueue-coverage-divergence' });
const UNKNOWN_LINES: ShadowCriterionEvaluation = Object.freeze({ status: 'fail', reason: 'import-unknown-lines' });
const IMPORT_DIVERGENCE: ShadowCriterionEvaluation = Object.freeze({ status: 'fail', reason: 'import-divergence' });
const CHAIN_BASE: ShadowCriterionEvaluation = Object.freeze({ status: 'fail', reason: 'chain-base-not-importable' });
const INTAKE_EQUAL: ShadowCriterionEvaluation = Object.freeze({ status: 'pass', reason: 'intake-equal' });
const COMPARATOR_DROPPED_ITEMS: ShadowCriterionEvaluation = Object.freeze({ status: 'unknown', reason: 'comparator-dropped-items' });

/**
 * One comparison side's counts for S8's evidence digest: the comparator's
 * own `fleetCount`/`shellCount`/`compared`, and the length of its (capped)
 * `divergences` list — a count, never the full list, mirroring S1's own
 * choice (`ShadowDayMergeSetEvaluation` in `shadow-day-merge-set.ts`) to
 * record divergence COUNTS in the digest rather than every divergence's
 * identity.
 */
interface ShadowIntakeSideCounts {
  readonly fleetCount: number;
  readonly shellCount: number;
  readonly compared: number;
  readonly divergences: number;
}

const ZERO_SIDE_COUNTS: ShadowIntakeSideCounts = Object.freeze({ fleetCount: 0, shellCount: 0, compared: 0, divergences: 0 });

/**
 * The evaluation every caller of this unit receives, with S8's own
 * comparison counts attached — mirroring S1's `ShadowDayMergeSetEvaluation`
 * pattern exactly. S8 runs two comparisons per sample pair
 * (`sampleComparisons`'s `a`, the live-coverage comparison of the fleet
 * queue against the whole shell live set, and `b`, the import-fidelity
 * comparison of the import dry-run against the shell entries on `main`), so
 * this type carries both sides' counts, taken from the SECOND sample's
 * comparisons: the second sample is the one closest to the moment of
 * recording, and in every case this evaluator actually decides on
 * persistence (both samples sharing the same divergence), the two samples'
 * counts agree by construction — the second sample's counts are never a
 * cherry-picked, less-representative choice than the first's. Zero on every
 * case decided before a comparison is computed at all (`SAMPLES_INVALID`,
 * `SHELL_STATE_INCOMPLETE`, `IMPORT_UNAVAILABLE`), exactly as
 * `ShadowDayMergeSetEvaluation`'s own `INVALID()` reports every count as
 * zero when S1 never got far enough to compute one either.
 */
export type ShadowIntakeEvaluation = ShadowCriterionEvaluation & {
  readonly aFleetCount: number;
  readonly aShellCount: number;
  readonly aCompared: number;
  readonly aDivergences: number;
  readonly bFleetCount: number;
  readonly bShellCount: number;
  readonly bCompared: number;
  readonly bDivergences: number;
};

/** One comparison's counts, read off its own result. */
function sideCountsOf(result: ShadowComparisonResult): ShadowIntakeSideCounts {
  return { fleetCount: result.fleetCount, shellCount: result.shellCount, compared: result.compared, divergences: result.divergences.length };
}

/**
 * A fresh, frozen evaluation built from a named status/reason template plus
 * the two sides' counts — never a shared object: this guarantees a caller
 * mutating one returned evaluation can never corrupt another, unrelated
 * call's result, matching this file's own frozen-constant pattern for the
 * plain `{status, reason}` templates above.
 */
function withCounts(template: ShadowCriterionEvaluation, a: ShadowIntakeSideCounts, b: ShadowIntakeSideCounts): ShadowIntakeEvaluation {
  return Object.freeze({
    status: template.status,
    reason: template.reason,
    aFleetCount: a.fleetCount,
    aShellCount: a.shellCount,
    aCompared: a.compared,
    aDivergences: a.divergences,
    bFleetCount: b.fleetCount,
    bShellCount: b.shellCount,
    bCompared: b.compared,
    bDivergences: b.divergences,
  });
}

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
 * The capped element list of a real, dense array, or null for any stand-in.
 * Delegates to the shared `readBoundedDenseArray`: an `O(1)`
 * length/prototype pre-gate, the accepted `O(K)` engine bound of the single
 * `Reflect.ownKeys` call (K = the target's own-property count) that rejects
 * foreign named, symbol and non-enumerable keys, then an `O(cap)`
 * per-index descriptor traversal over `SHADOW_INTAKE_MAX_KEYS`. Symbol keys
 * and non-enumerable extra keys — which the previous `Object.keys` count
 * ignored — are now refused, and an accessor element refuses the whole list
 * before any item reader runs. The returned `array` is a fresh dense copy
 * this module created, so plain indexed reads on it can never run a getter
 * or a Proxy `get` trap.
 */
function boundedList(value: unknown, cap: number): BoundedDenseArray | null {
  return readBoundedDenseArray(value, cap);
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

/**
 * Every element of a bounded list as a key, or null when any is out of
 * shape. Iterates on the length `boundedList` already read from the
 * descriptor, over the fresh dense copy the helper returned — a plain
 * indexed read there can never run a getter or a Proxy `get` trap.
 */
function validateKeys(raw: unknown, arrayCap: number): readonly ValidatedKey[] | null {
  const bounded = boundedList(raw, arrayCap);
  if (bounded === null) {
    return null;
  }
  const keys: ValidatedKey[] = [];
  for (let index = 0; index < bounded.length; index += 1) {
    const key = validateKey(bounded.array[index]);
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

/** One enqueue-set comparison: the comparator's result plus the exact sides it compared. */
interface ComparisonSides {
  readonly result: ShadowComparisonResult;
  readonly fleet: readonly ValidatedKey[];
  readonly shell: readonly ValidatedKey[];
}

/**
 * One sample's two comparisons: `A` is the live-coverage comparison of the
 * fleet queue against the whole shell live set; `B` is the import-fidelity
 * comparison of the import dry-run against the shell entries on `main` only,
 * since a chain-base entry can never be imported.
 */
function sampleComparisons(sample: ValidatedSample): { readonly a: ComparisonSides; readonly b: ComparisonSides } {
  const shellMain = sample.shellLive.filter((key) => key.base === 'main');
  return {
    a: { result: compareShadowEnqueueSets({ fleet: sample.fleetLive, shell: sample.shellLive }), fleet: sample.fleetLive, shell: sample.shellLive },
    b: { result: compareShadowEnqueueSets({ fleet: sample.importPresent ?? [], shell: shellMain }), fleet: sample.importPresent ?? [], shell: shellMain },
  };
}

/** The comparator's identity of one validated key: ids only, never a value. */
function keyOf(key: ValidatedKey): string {
  return `${key.pullRequest}@${key.headOid}@${key.base}`;
}

/** The `(key, code)` identity of one listed divergence. */
function divergenceId(divergence: { readonly key: string; readonly code: ShadowDivergenceCode }): string {
  return `${divergence.key}\u0000${divergence.code}`;
}

/** The distinct key ids of one comparison's sides, as a set. */
function keyIds(sides: readonly (readonly ValidatedKey[])[]): Set<string> {
  const ids = new Set<string>();
  for (const side of sides) {
    for (const key of side) {
      ids.add(keyOf(key));
    }
  }
  return ids;
}

/** The key ids present on both samples' sides of one comparison. */
function sharedKeyIds(first: ComparisonSides, second: ComparisonSides): Set<string> {
  const firstIds = keyIds([first.fleet, first.shell]);
  const shared = new Set<string>();
  for (const id of keyIds([second.fleet, second.shell])) {
    if (firstIds.has(id)) {
      shared.add(id);
    }
  }
  return shared;
}

/** The keys whose id is a candidate, keeping every occurrence of each. */
function restrictedTo(keys: readonly ValidatedKey[], candidates: ReadonlySet<string>): readonly ValidatedKey[] {
  return keys.filter((key) => candidates.has(keyOf(key)));
}

/** One side's distinct keys: how often each occurs, and one representative. */
interface SideEntry {
  readonly count: number;
  readonly representative: ValidatedKey;
}

function sideIndex(keys: readonly ValidatedKey[]): Map<string, SideEntry> {
  const index = new Map<string, SideEntry>();
  for (const key of keys) {
    const id = keyOf(key);
    const known = index.get(id);
    index.set(id, known === undefined ? { count: 1, representative: key } : { count: known.count + 1, representative: known.representative });
  }
  return index;
}

/**
 * The divergence of one candidate key between two sides, or null when the
 * key is not a divergence. Set kinds compare membership only, so the
 * comparator judges a key in isolation: a singleton comparison reproduces
 * the code the full comparison gives that key. A key repeated within one
 * side takes the comparator's duplicate verdict `invalid-item` instead.
 */
function enqueueDivergenceCode(fleetEntry: SideEntry | null, shellEntry: SideEntry | null): ShadowDivergenceCode | null {
  if ((fleetEntry?.count ?? 0) > 1 || (shellEntry?.count ?? 0) > 1) {
    return 'invalid-item';
  }
  const result = compareShadowEnqueueSets({
    fleet: fleetEntry === null ? [] : [fleetEntry.representative],
    shell: shellEntry === null ? [] : [shellEntry.representative],
  });
  return result.divergences.length > 0 ? (result.divergences[0]?.code ?? null) : null;
}

/**
 * Every `(key, code)` divergence of one enqueue-set comparison restricted to
 * the candidate keys, including any the comparator's listing cap leaves
 * unlisted: the exact persistence test needs the complete divergence set,
 * not its first `SHADOW_DIVERGENCE_MAX` entries.
 */
function enqueueDivergenceCodes(fleet: readonly ValidatedKey[], shell: readonly ValidatedKey[]): Map<string, ShadowDivergenceCode> {
  const fleetSide = sideIndex(fleet);
  const shellSide = sideIndex(shell);
  const codes = new Map<string, ShadowDivergenceCode>();
  for (const [id, fleetEntry] of fleetSide) {
    const code = enqueueDivergenceCode(fleetEntry, shellSide.get(id) ?? null);
    if (code !== null) {
      codes.set(id, code);
    }
  }
  for (const [id, shellEntry] of shellSide) {
    if (!fleetSide.has(id)) {
      const code = enqueueDivergenceCode(null, shellEntry);
      if (code !== null) {
        codes.set(id, code);
      }
    }
  }
  return codes;
}

/**
 * True when the two comparisons share at least one (key, code) divergence —
 * and only then: a divergence in a single sample is a snapshot artifact, and
 * a shared pair hidden beyond the listing cap still counts. When neither
 * list is truncated the listed entries are complete and their intersection
 * decides. When either is truncated, the listed subset cannot decide either
 * way, so the exact divergence set of the candidate keys — the keys both
 * samples carry, the only keys a shared pair can name — is derived per key
 * from the comparator itself and intersected.
 */
function sharedDivergence(first: ComparisonSides, second: ComparisonSides): boolean {
  if (!first.result.truncated && !second.result.truncated) {
    const listed = new Set(first.result.divergences.map(divergenceId));
    return second.result.divergences.some((divergence) => listed.has(divergenceId(divergence)));
  }
  const candidates = sharedKeyIds(first, second);
  const firstCodes = enqueueDivergenceCodes(restrictedTo(first.fleet, candidates), restrictedTo(first.shell, candidates));
  const secondCodes = enqueueDivergenceCodes(restrictedTo(second.fleet, candidates), restrictedTo(second.shell, candidates));
  for (const [id, code] of firstCodes) {
    if (secondCodes.get(id) === code) {
      return true;
    }
  }
  return false;
}

/**
 * True when the comparator's own `fleetCount`/`shellCount` do not match the
 * number of keys handed to it on that side: the comparator silently rejected
 * at least one item as secret-shaped that this evaluator's own `validateKey`
 * had already accepted as a structurally well-formed key. `compareShadowEnqueueSets`'s
 * own secret-shape scan is unanchored (`sk-[A-Za-z0-9_-]{20,}` with no word
 * boundary, among others), so it flags far more than real secrets, including
 * an entirely ordinary `chain/<name>` base that merely happens to contain
 * that shape as a substring. A comparison in that state cannot be trusted for
 * persistence: the dropped item's own divergence — a `missing-in-fleet` or
 * `missing-in-shell` keyed by its real identity — is replaced by a positional
 * `invalid-item` entry keyed by the item's index, not its identity. Since the
 * two samples' arrays need not line up index-for-index, that substitution can
 * hide a real, persistent divergence (a false pass) or make two unrelated
 * drops at the same index look like one persistent divergence (a false
 * fail). Checked against the exact arrays given to the comparator for this
 * comparison, never against the sample's unfiltered list, so a prior filter
 * (comparison B's main-only shell side) is never mistaken for a drop.
 */
function comparatorDroppedItems(sides: ComparisonSides): boolean {
  return sides.result.fleetCount !== sides.fleet.length || sides.result.shellCount !== sides.shell.length;
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
 * (`import-unavailable`); then, before either comparison's divergences are
 * trusted, the comparator's own `fleetCount`/`shellCount` must account for
 * every key handed to it on that side (`comparator-dropped-items`, checked
 * right before comparison A is used and again right before comparison B is
 * used: a miscount means the comparator silently rejected a structurally
 * valid key as secret-shaped, which breaks the positional identity the
 * persistence check below relies on); then a persistent live-coverage
 * divergence fails (`enqueue-coverage-divergence`), any unparseable import
 * line fails (`import-unknown-lines`, checked before the B comparison), a
 * persistent import-fidelity divergence fails (`import-divergence`), a
 * chain-base shell key present in both samples fails
 * (`chain-base-not-importable`), and otherwise the intake is equal.
 * Persistence is decided exactly: when a comparison's divergence list is
 * truncated by the listing cap, a shared pair is looked for among the exact
 * per-key divergences of the keys both samples carry — never inferred from
 * truncation alone, which would fail without any shared (key, code) pair.
 *
 * Cost: linear in the capped input — at most two samples, each with four
 * lists capped at `SHADOW_INTAKE_MAX_KEYS` keys, each key and field read once
 * through its own descriptor; the comparisons are linear in the same bounds.
 * Each list read pays the accepted engine bound of `readBoundedDenseArray`:
 * an `O(1)` length/prototype pre-gate, `O(K)` in the target's own-property
 * count K for the single `Reflect.ownKeys` call, then `O(cap)` element
 * traversal — so an oversized, sparse, extra-keyed or accessor-backed list
 * is refused before any key is validated. Never throws, never echoes an
 * input value, never runs a getter or reaches a `get` trap.
 */
export function evaluateShadowIntake(input: unknown): ShadowIntakeEvaluation {
  try {
    const samplesRaw = readExactPlainRecord(input, ['samples']);
    if (samplesRaw === null) {
      return withCounts(SAMPLES_INVALID, ZERO_SIDE_COUNTS, ZERO_SIDE_COUNTS);
    }
    // `pair.array` is the fresh dense copy `boundedList` returned, so plain
    // indexed reads here can never run a getter or a Proxy `get` trap; see
    // `validateKeys` above.
    const pair = boundedList(samplesRaw.samples, 2);
    if (pair === null || pair.length !== 2) {
      return withCounts(SAMPLES_INVALID, ZERO_SIDE_COUNTS, ZERO_SIDE_COUNTS);
    }
    const first = validateSample(pair.array[0]);
    const second = validateSample(pair.array[1]);
    if (first === null || second === null) {
      return withCounts(SAMPLES_INVALID, ZERO_SIDE_COUNTS, ZERO_SIDE_COUNTS);
    }
    const firstMs = Date.parse(first.takenAtIso);
    const secondMs = Date.parse(second.takenAtIso);
    if (Math.abs(secondMs - firstMs) < SHADOW_INTAKE_MIN_GAP_MS) {
      return withCounts(SAMPLES_INVALID, ZERO_SIDE_COUNTS, ZERO_SIDE_COUNTS);
    }
    if (!first.complete || !second.complete) {
      return withCounts(SHELL_STATE_INCOMPLETE, ZERO_SIDE_COUNTS, ZERO_SIDE_COUNTS);
    }
    if (first.importPresent === null || second.importPresent === null) {
      return withCounts(IMPORT_UNAVAILABLE, ZERO_SIDE_COUNTS, ZERO_SIDE_COUNTS);
    }
    const firstComparison = sampleComparisons(first);
    const secondComparison = sampleComparisons(second);
    // Both sides' counts for the digest (see `ShadowIntakeEvaluation`'s doc
    // comment): taken once, from the second sample's two comparisons, and
    // reused for every return site below this point — every one of them is
    // reached only after both comparisons for both samples are already
    // computed.
    const aCounts = sideCountsOf(secondComparison.a.result);
    const bCounts = sideCountsOf(secondComparison.b.result);
    if (comparatorDroppedItems(firstComparison.a) || comparatorDroppedItems(secondComparison.a)) {
      return withCounts(COMPARATOR_DROPPED_ITEMS, aCounts, bCounts);
    }
    if (sharedDivergence(firstComparison.a, secondComparison.a)) {
      return withCounts(COVERAGE_DIVERGENCE, aCounts, bCounts);
    }
    if (first.importUnknownLines > 0 || second.importUnknownLines > 0) {
      return withCounts(UNKNOWN_LINES, aCounts, bCounts);
    }
    if (comparatorDroppedItems(firstComparison.b) || comparatorDroppedItems(secondComparison.b)) {
      return withCounts(COMPARATOR_DROPPED_ITEMS, aCounts, bCounts);
    }
    if (sharedDivergence(firstComparison.b, secondComparison.b)) {
      return withCounts(IMPORT_DIVERGENCE, aCounts, bCounts);
    }
    if (persistentChainBase(first.shellLive, second.shellLive)) {
      return withCounts(CHAIN_BASE, aCounts, bCounts);
    }
    return withCounts(INTAKE_EQUAL, aCounts, bCounts);
  } catch {
    return withCounts(SAMPLES_INVALID, ZERO_SIDE_COUNTS, ZERO_SIDE_COUNTS);
  }
}
