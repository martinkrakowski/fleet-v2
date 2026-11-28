// Lane SR4: the pure shadow-day main reconcile evaluator — the hand-land
// break count for the certification streak (cut-over streak amendment).
// A hand-land is a first-parent commit on `fleet-v2` `main` inside the
// half-open day window `[dayStartIso, dayEndIso)` whose full 40-hex sha has
// no matching shell `result` `merged` event. Pure: no filesystem, no
// subprocess, no network, no clock. Never throws, never echoes an input
// value; every failure is a frozen typed refusal with a named reason code.

import { isZonedIsoDateTime } from './conductor-halt.js';
import { isMergeHex40 } from './merge-queue-records.js';
import { readBoundedDenseArray, snapshotPlainDataRecord } from './plain-record-reads.js';

/** A sanity cap on how many first-parent commits one evaluation walks before refusing as unevaluable. */
export const SHADOW_MAIN_RECONCILE_MAX_COMMITS = 10_000;

/** A sanity cap on how many shell merged shas one evaluation reads before refusing as unevaluable. */
export const SHADOW_MAIN_RECONCILE_MAX_SHELL_MERGED_SHAS = 100_000;

/** At most this many hand-land shas ride on an evaluation; the count still reports every one of them. */
export const SHADOW_MAIN_RECONCILE_MAX_REPORTED_SHAS = 50;

/** A day window may not exceed 25 hours: one UTC day plus a DST-hour of slack. */
export const SHADOW_MAIN_RECONCILE_MAX_WINDOW_MS = 25 * 60 * 60 * 1000;

/** Why an evaluation refused to count hand-lands at all. */
export type HandLandRefusalReason =
  | 'invalid-input'
  | 'invalid-timestamp'
  | 'invalid-window'
  | 'invalid-sha';

/** One first-parent commit of `fleet-v2` `main` as the reconciler receives it. */
export interface MainReconcileCommit {
  readonly sha: string;
  readonly committedAtIso: string;
}

/** The already-collected facts one evaluation reconciles. */
export interface MainReconcileInput {
  readonly dayStartIso: string;
  readonly dayEndIso: string;
  readonly firstParentCommits: readonly MainReconcileCommit[];
  readonly shellMergedShas: readonly string[];
}

/**
 * Either the hand-land count with up to `SHADOW_MAIN_RECONCILE_MAX_REPORTED_SHAS`
 * example shas, or a frozen refusal. Never a thrown error.
 */
export type HandLandEvaluation =
  | { readonly ok: true; readonly handLands: number; readonly handLandShas: readonly string[] }
  | { readonly ok: false; readonly reason: HandLandRefusalReason };

const REFUSED_KEYS = ['dayStartIso', 'dayEndIso', 'firstParentCommits', 'shellMergedShas'] as const;
const COMMIT_KEYS = ['sha', 'committedAtIso'] as const;

/** The frozen structural refusal: shape, stand-ins, keys and caps are all `invalid-input`. */
const INVALID_INPUT: HandLandEvaluation = Object.freeze({ ok: false, reason: 'invalid-input' as const });

function refused(reason: HandLandRefusalReason): HandLandEvaluation {
  return Object.freeze({ ok: false, reason });
}

/**
 * Snapshot `value` through `snapshotPlainDataRecord` and require exactly the
 * given own enumerable string data keys. The helper never runs a getter or a
 * Proxy `get` trap, refuses revoked and throwing-trap Proxies with a typed
 * null, refuses symbol keys and non-enumerable keys (the accepted `O(K)`
 * engine bound of the single `Reflect.ownKeys` call, K = the target's
 * own-property count, plus a descriptor copy per key), and refuses an own
 * `__proto__`. Because the snapshot is a fresh null-prototype object this
 * module created, the exact-key and polluting-key checks on it are plain
 * reads of our own copy: no untrusted reflection, no further trap exposure.
 * `constructor` and `prototype` are rejected explicitly here because the
 * snapshot helper only special-cases `__proto__`.
 */
function snapshotWithExactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  let snapshot: Record<string, unknown> | null;
  try {
    snapshot = snapshotPlainDataRecord(value);
  } catch {
    return null;
  }
  if (snapshot === null) {
    return null;
  }
  const own = Object.keys(snapshot);
  if (own.length !== keys.length) {
    return null;
  }
  for (const key of own) {
    if (key === 'constructor' || key === 'prototype' || !keys.includes(key)) {
      return null;
    }
  }
  return snapshot;
}

/**
 * Count the hand-lands: first-parent commits inside the half-open window
 * `[dayStartIso, dayEndIso)` whose sha has no matching shell `merged` event
 * in `shellMergedShas`.
 *
 * Untrusted reads and their cost bounds: the top-level record and each
 * commit item go through `snapshotPlainDataRecord` (the accepted `O(K)`
 * engine bound of one `Reflect.ownKeys` call plus one descriptor copy per
 * own key, no getter or Proxy `get` trap ever invoked); the two lists go
 * through `readBoundedDenseArray` (an `O(1)` length/prototype pre-gate, the
 * accepted `O(K)` engine bound of its single `Reflect.ownKeys` call, then an
 * `O(cap)` per-index descriptor copy). Every structural failure — a
 * non-plain top level, an own accessor, a revoked or throwing-trap Proxy, a
 * non-array or array-like or sparse or accessor-bearing list, a
 * prototype-polluting, symbol, non-enumerable, missing or extra key, or a
 * list past its cap — returns `invalid-input`. Timestamps, windows and shas
 * refuse with their own named reasons. An empty `firstParentCommits` array
 * that is a real dense array is a valid zero, not a refusal.
 */
export function evaluateHandLands(input: unknown): HandLandEvaluation {
  const top = snapshotWithExactKeys(input, REFUSED_KEYS);
  if (top === null) {
    return INVALID_INPUT;
  }

  const dayStartIso = top.dayStartIso;
  const dayEndIso = top.dayEndIso;
  if (!isZonedIsoDateTime(dayStartIso) || !isZonedIsoDateTime(dayEndIso)) {
    return refused('invalid-timestamp');
  }
  const startMs = Date.parse(dayStartIso);
  const endMs = Date.parse(dayEndIso);
  if (!(endMs > startMs) || endMs - startMs > SHADOW_MAIN_RECONCILE_MAX_WINDOW_MS) {
    return refused('invalid-window');
  }

  let commits: readonly unknown[];
  let mergedShas: readonly unknown[];
  try {
    const commitRead = readBoundedDenseArray(top.firstParentCommits, SHADOW_MAIN_RECONCILE_MAX_COMMITS);
    const shaRead = readBoundedDenseArray(top.shellMergedShas, SHADOW_MAIN_RECONCILE_MAX_SHELL_MERGED_SHAS);
    if (commitRead === null || shaRead === null) {
      return INVALID_INPUT;
    }
    commits = commitRead.array;
    mergedShas = shaRead.array;
  } catch {
    return INVALID_INPUT;
  }

  const shellMerged = new Set<string>();
  for (const sha of mergedShas) {
    if (!isMergeHex40(sha)) {
      return refused('invalid-sha');
    }
    shellMerged.add(sha);
  }

  let handLands = 0;
  const handLandShas: string[] = [];
  for (const item of commits) {
    const commit = snapshotWithExactKeys(item, COMMIT_KEYS);
    if (commit === null) {
      return INVALID_INPUT;
    }
    const { sha, committedAtIso } = commit;
    if (!isMergeHex40(sha)) {
      return refused('invalid-sha');
    }
    if (!isZonedIsoDateTime(committedAtIso)) {
      return refused('invalid-timestamp');
    }
    if (shellMerged.has(sha)) {
      continue;
    }
    const committedMs = Date.parse(committedAtIso);
    if (committedMs >= startMs && committedMs < endMs) {
      handLands += 1;
      if (handLandShas.length < SHADOW_MAIN_RECONCILE_MAX_REPORTED_SHAS) {
        handLandShas.push(sha);
      }
    }
  }
  return Object.freeze({ ok: true as const, handLands, handLandShas: Object.freeze(handLandShas) });
}
