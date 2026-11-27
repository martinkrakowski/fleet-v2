// Lane SR4: the pure shadow-day main reconcile evaluator for the
// certification streak's hand-land break count (cut-over streak amendment,
// 2026-11-27). Pure: no filesystem, no subprocess, no network, no clock.
// Never throws, never echoes an input value; the evaluator takes `unknown`
// at its boundary and returns a typed evaluation whose refusal carries a
// named reason code.

import { isZonedIsoDateTime } from './conductor-halt.js';
import { isMergeHex40 } from './merge-queue-records.js';
import { readBoundedDenseArray, snapshotPlainDataRecord } from './plain-record-reads.js';

/**
 * How many first-parent commits one evaluation walks before refusing as
 * unreadable: a certification day's main history is far smaller, and the
 * `O(cap)` per-index descriptor traversal of `readBoundedDenseArray` bounds
 * the work regardless of what the caller claims.
 */
export const SHADOW_MAIN_RECONCILE_MAX_COMMITS = 10_000;

/** How many shell `result` `merged` shas one evaluation accepts before refusing as unreadable. */
export const SHADOW_MAIN_RECONCILE_MAX_SHELL_MERGED_SHAS = 100_000;

/**
 * At most this many hand-land shas ride on a passing evaluation as the
 * reported witness list; the count keeps counting past the cap.
 */
export const SHADOW_MAIN_RECONCILE_MAX_REPORTED_SHAS = 50;

/**
 * A certification day is one calendar day; 25 hours accepts any single day
 * plus a timezone offset of up to one hour on either boundary, and nothing
 * longer.
 */
export const SHADOW_MAIN_RECONCILE_MAX_WINDOW_MS = 25 * 60 * 60 * 1000;

/** Why an evaluation refused; every refusal is a frozen, named, typed result. */
export type HandLandRefusalReason = 'invalid-input' | 'invalid-timestamp' | 'invalid-window' | 'invalid-sha';

/** One first-parent commit on `fleet-v2` `main`, as the collector journaled it. */
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
 * A hand-land break count, or a frozen refusal. A hand-land is any
 * first-parent commit in the half-open window `[dayStartIso, dayEndIso)`
 * whose full 40-hex lowercase `sha` has no matching shell `result` `merged`
 * event in `shellMergedShas`.
 */
export type HandLandEvaluation =
  | { readonly ok: true; readonly handLands: number; readonly handLandShas: readonly string[] }
  | { readonly ok: false; readonly reason: HandLandRefusalReason };

const INPUT_KEYS: readonly string[] = ['dayStartIso', 'dayEndIso', 'firstParentCommits', 'shellMergedShas'];
const COMMIT_KEYS: readonly string[] = ['sha', 'committedAtIso'];
// Prototype-polluting keys are refused explicitly even though a snapshot
// already refuses `__proto__`: `constructor` and `prototype` copy fine.
const POLLUTING_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

const INVALID_INPUT: HandLandEvaluation = Object.freeze({ ok: false as const, reason: 'invalid-input' as const });
const INVALID_TIMESTAMP: HandLandEvaluation = Object.freeze({ ok: false as const, reason: 'invalid-timestamp' as const });
const INVALID_WINDOW: HandLandEvaluation = Object.freeze({ ok: false as const, reason: 'invalid-window' as const });
const INVALID_SHA: HandLandEvaluation = Object.freeze({ ok: false as const, reason: 'invalid-sha' as const });

/** Exact-key check on a snapshot: no missing key, no extra key, no polluting key. */
function hasExactKeys(snapshot: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const polluting of POLLUTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(snapshot, polluting)) {
      return false;
    }
  }
  if (keys.length !== Reflect.ownKeys(snapshot).length) {
    return false;
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
      return false;
    }
  }
  return true;
}

/**
 * Evaluate the hand-land break count for one certification day.
 *
 * Cost bounds (decided, hostile-input rule): the top-level snapshot pays the
 * `O(K)` engine bound of `Reflect.ownKeys` (K = the target's own-property
 * count) plus one enumerable data-property copy per key; every array read
 * pays the `O(1)` length/prototype pre-gate, the accepted `O(K)` engine
 * bound of `Reflect.ownKeys`, and an `O(cap)` per-index descriptor copy
 * (`snapshotPlainDataRecord` / `readBoundedDenseArray`, whose contracts
 * state these bounds). Everything after the reads is linear in the accepted
 * list lengths. A revoked Proxy or a Proxy whose traps throw is refused with
 * `invalid-input` without ever consulting a `get` trap; a transparent Proxy
 * reporting plain data is indistinguishable from plain data and not required
 * to be refused. Every failure returns a frozen refusal and never throws,
 * never echoes a raw input value, and never reports hand-lands on error.
 */
export function evaluateHandLands(input: unknown): HandLandEvaluation {
  // The only paths a hostile trap can throw on are the snapshot and the two
  // array reads; each is caught and mapped to the same frozen refusal.
  let snapshot: Record<string, unknown> | null;
  try {
    snapshot = snapshotPlainDataRecord(input);
    if (snapshot === null) {
      return INVALID_INPUT;
    }
    if (!hasExactKeys(snapshot, INPUT_KEYS)) {
      return INVALID_INPUT;
    }
    snapshot.firstParentCommits = readFirstParentCommits(snapshot.firstParentCommits);
    snapshot.shellMergedShas = readShellMergedShas(snapshot.shellMergedShas);
  } catch {
    return INVALID_INPUT;
  }
  const commits = snapshot.firstParentCommits;
  const shellShas = snapshot.shellMergedShas;
  if (!isReadCommitList(commits) || !isReadShaList(shellShas)) {
    return INVALID_INPUT;
  }

  if (typeof snapshot.dayStartIso !== 'string' || typeof snapshot.dayEndIso !== 'string') {
    return INVALID_TIMESTAMP;
  }
  if (!isZonedIsoDateTime(snapshot.dayStartIso) || !isZonedIsoDateTime(snapshot.dayEndIso)) {
    return INVALID_TIMESTAMP;
  }
  const startMs = Date.parse(snapshot.dayStartIso);
  const endMs = Date.parse(snapshot.dayEndIso);
  if (endMs <= startMs || endMs - startMs > SHADOW_MAIN_RECONCILE_MAX_WINDOW_MS) {
    return INVALID_WINDOW;
  }

  const merged = new Set<string>();
  for (const sha of shellShas) {
    if (!isMergeHex40(sha)) {
      return INVALID_SHA;
    }
    merged.add(sha);
  }

  const handLandShas: string[] = [];
  let handLands = 0;
  for (const commit of commits) {
    if (!isMergeHex40(commit.sha)) {
      return INVALID_SHA;
    }
    if (!isZonedIsoDateTime(commit.committedAtIso)) {
      return INVALID_TIMESTAMP;
    }
    const committedMs = Date.parse(commit.committedAtIso);
    if (committedMs >= startMs && committedMs < endMs && !merged.has(commit.sha)) {
      handLands += 1;
      if (handLandShas.length < SHADOW_MAIN_RECONCILE_MAX_REPORTED_SHAS) {
        handLandShas.push(commit.sha);
      }
    }
  }
  return Object.freeze({ ok: true as const, handLands, handLandShas: Object.freeze(handLandShas) });
}

/**
 * A real, dense array within `SHADOW_MAIN_RECONCILE_MAX_COMMITS` as a fresh
 * dense copy, or null for any stand-in: not an array, an array-like, a
 * sparse hole, an accessor element, an enormous length, or an over-cap
 * length. Delegates to the shared `readBoundedDenseArray`; see its JSDoc for
 * the stated `O(1)` / `O(K)` / `O(cap)` cost bounds.
 */
function readFirstParentCommits(value: unknown): unknown {
  const read = readBoundedDenseArray(value, SHADOW_MAIN_RECONCILE_MAX_COMMITS);
  if (read === null) {
    return null;
  }
  const out: MainReconcileCommit[] = [];
  for (const item of read.array) {
    // Each element is read through its own snapshot inside the same throw
    // guard the caller established: a hostile trap throws, the evaluator
    // refuses, no getter is ever invoked.
    const record = snapshotPlainDataRecord(item);
    if (record === null || !hasExactKeys(record, COMMIT_KEYS)) {
      return null;
    }
    out.push({ sha: record.sha, committedAtIso: record.committedAtIso } as MainReconcileCommit);
  }
  return out;
}

/** A real, dense array of strings within the shell-sha cap, or null for any stand-in. */
function readShellMergedShas(value: unknown): unknown {
  const read = readBoundedDenseArray(value, SHADOW_MAIN_RECONCILE_MAX_SHELL_MERGED_SHAS);
  if (read === null) {
    return null;
  }
  const out: unknown[] = [];
  for (const item of read.array) {
    out.push(item);
  }
  return out;
}

/**
 * The per-index type narrow after the reads above: the commit list the
 * reader produced is a plain `Array` this module created.
 */
function isReadCommitList(value: unknown): value is readonly MainReconcileCommit[] {
  return Array.isArray(value);
}

/**
 * The per-index type narrow after the reads above: the sha list the reader
 * produced is a plain `Array` this module created; its items are still
 * untrusted and each is validated with `isMergeHex40`.
 */
function isReadShaList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
