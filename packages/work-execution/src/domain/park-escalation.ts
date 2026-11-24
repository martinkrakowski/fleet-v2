/**
 * The first park-escalation slice (CE1): escalating a `fix-no-progress` park
 * to a fix round with mode `commit-pending`, at most once per run. The
 * decision is pure domain data; the transition guard reuses
 * `checkLaneRunResume`'s check order so an escalation can never bypass a stop,
 * a stale revision or a one-way door. Pure: no port, no I/O, no clock; every
 * input is untrusted and read through the shared plain-record readers, so no
 * getter ever runs and every refusal is a typed value.
 */

import { LANE_RUN_PARK_REASONS } from './lane-run-records.js';
import { parseParkClass } from './park-class.js';
import { PARK_FINDINGS_MAX_COUNT } from './park-findings-view.js';
import {
  readBoundedDenseArray,
  readExactPlainRecord,
  readPlainRecordWithOptionalKeys,
  snapshotPlainDataRecord,
} from './plain-record-reads.js';
import { isPlainRecordObject } from './record-schema-version.js';

/** The escalation modes of the first slice; later slices add more (CE3). */
export const PARK_ESCALATION_MODES = ['commit-pending'] as const;
export type ParkEscalationMode = (typeof PARK_ESCALATION_MODES)[number];

/** Cost bound on the history scan: a longer history is refused, never scanned. */
export const PARK_ESCALATION_HISTORY_MAX = 256;

/** The observed fact that justifies an escalation: tracked files changed since the attempt's head. */
export interface DirtyWorktreeFact {
  readonly trackedFilesChanged: number;
}

/** Why the run stays parked instead of escalating. */
export const PARK_ESCALATION_STAY_REASONS = [
  'malformed-parked-record',
  'malformed-history',
  'history-too-long',
  'missing-dirty-worktree-fact',
  'malformed-dirty-worktree-fact',
  'worktree-clean',
  'park-reason-not-escalatable',
  'already-escalated',
] as const;
export type ParkEscalationStayReason = (typeof PARK_ESCALATION_STAY_REASONS)[number];

export type ParkEscalationDecision =
  | { readonly kind: 'escalate'; readonly mode: ParkEscalationMode }
  | { readonly kind: 'stay-parked'; readonly reason: ParkEscalationStayReason };

const STAY_MALFORMED_PARKED: ParkEscalationDecision = { kind: 'stay-parked', reason: 'malformed-parked-record' };
const STAY_MALFORMED_HISTORY: ParkEscalationDecision = { kind: 'stay-parked', reason: 'malformed-history' };
const STAY_MALFORMED_DIRTY: ParkEscalationDecision = { kind: 'stay-parked', reason: 'malformed-dirty-worktree-fact' };

/**
 * Reads findings[i] only through its own property descriptor: a hole or an
 * accessor (getter/setter) is refused, so no array element getter ever runs.
 */
function readFindingsElement(findings: readonly unknown[], index: number): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const descriptor = Object.getOwnPropertyDescriptor(findings, index);
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
    return { ok: false };
  }
  return { ok: true, value: descriptor.value };
}

/**
 * Validates the optional `findings` key's shape: absent, null, or a bounded
 * array whose every element is read through its own descriptor and must be a
 * plain record. A hole or an accessor element refuses the whole record.
 */
function validateFindingsShape(findings: unknown): boolean {
  if (findings === undefined || findings === null) {
    return true;
  }
  if (!Array.isArray(findings) || findings.length > PARK_FINDINGS_MAX_COUNT) {
    return false;
  }
  for (let i = 0; i < findings.length; i += 1) {
    const element = readFindingsElement(findings, i);
    if (!element.ok || !isPlainRecordObject(element.value)) {
      return false;
    }
  }
  return true;
}

/**
 * The pure park-escalation decision (CE1). Checks in this order: the parked
 * record's shape, `class` and `reason`, then the run's journal history (an
 * earlier `commit-pending` escalation is final — once per run), then the
 * observed dirty-worktree fact. `fix-no-progress` is the only escalatable
 * park reason. The history walk is `readBoundedDenseArray` at
 * `PARK_ESCALATION_HISTORY_MAX`: an `O(1)` length check refuses a longer
 * history before any element is read, and the bounded reader then refuses a
 * subclass, a hole, an accessor, a symbol key or an extra own key in `O(K)`
 * own keys plus `O(cap)` descriptor checks. Total: any throw (a hostile
 * Proxy trap) reads as `malformed-parked-record`.
 */
export function decideParkEscalation(parked: unknown, history: unknown, dirtyWorktree?: unknown): ParkEscalationDecision {
  try {
    const parkedRecord = readPlainRecordWithOptionalKeys(
      parked,
      ['reason', 'qualifier', 'parkedFrom', 'questionId'],
      ['findings', 'class'],
    );
    if (parkedRecord === null) {
      return STAY_MALFORMED_PARKED;
    }
    const reason = parkedRecord.reason;
    if (typeof reason !== 'string' || !(LANE_RUN_PARK_REASONS as readonly string[]).includes(reason)) {
      return STAY_MALFORMED_PARKED;
    }
    if (!validateFindingsShape(parkedRecord.findings)) {
      return STAY_MALFORMED_PARKED;
    }
    // Optional `class`: absent is the pre-PT1a shape; a present value that is
    // not a declared park class is malformed. `parseParkClass` is a fixed-list
    // membership test, so this check is O(1) and never runs a getter (the
    // value was copied from the record's own data descriptor).
    if (parkedRecord.class !== undefined && parseParkClass(parkedRecord.class) === undefined) {
      return STAY_MALFORMED_PARKED;
    }
    if (reason !== 'fix-no-progress') {
      return { kind: 'stay-parked', reason: 'park-reason-not-escalatable' };
    }
    // O(1) shape and cap gates. They stay ahead of `readBoundedDenseArray` so
    // a history longer than the cap is `history-too-long` (one `.length` read,
    // no element scan) rather than the bounded reader's generic null.
    if (!Array.isArray(history)) {
      return STAY_MALFORMED_HISTORY;
    }
    if (history.length > PARK_ESCALATION_HISTORY_MAX) {
      return { kind: 'stay-parked', reason: 'history-too-long' };
    }
    // The bounded reader refuses a subclassed array, a hole, an accessor
    // element, a non-enumerable index, a symbol key and an extra own key
    // (`01`, `__proto__`) without running a getter. Cost: O(K) own keys, then
    // O(cap) descriptor checks, cap = PARK_ESCALATION_HISTORY_MAX.
    const bounded = readBoundedDenseArray(history, PARK_ESCALATION_HISTORY_MAX);
    if (bounded === null) {
      return STAY_MALFORMED_HISTORY;
    }
    // Validate EVERY entry before looking for the marker, so a malformed later
    // entry is never skipped behind an earlier escalation marker. Each
    // snapshot is O(keys of that entry); the entry count is at most the cap.
    const snapshots: NonNullable<ReturnType<typeof snapshotPlainDataRecord>>[] = [];
    for (const entry of bounded.array) {
      const snapshot = snapshotPlainDataRecord(entry);
      if (snapshot === null) {
        return STAY_MALFORMED_HISTORY;
      }
      // An entry with no own enumerable data (e.g. a null-prototype empty
      // record) carries no journal content and is malformed, so it can never
      // be skipped behind an earlier marker.
      if (Object.keys(snapshot).length === 0) {
        return STAY_MALFORMED_HISTORY;
      }
      snapshots.push(snapshot);
    }
    if (snapshots.some((snapshot) => (snapshot.reasonCode === 'park-escalated' && snapshot.detail === 'commit-pending') || snapshot.mode === 'commit-pending')) {
      return { kind: 'stay-parked', reason: 'already-escalated' };
    }
    if (dirtyWorktree === undefined || dirtyWorktree === null) {
      return { kind: 'stay-parked', reason: 'missing-dirty-worktree-fact' };
    }
    const fact = readExactPlainRecord(dirtyWorktree, ['trackedFilesChanged']);
    if (fact === null) {
      return STAY_MALFORMED_DIRTY;
    }
    const trackedFilesChanged = fact.trackedFilesChanged;
    if (typeof trackedFilesChanged !== 'number' || !Number.isSafeInteger(trackedFilesChanged) || trackedFilesChanged < 0) {
      return STAY_MALFORMED_DIRTY;
    }
    if (trackedFilesChanged === 0) {
      return { kind: 'stay-parked', reason: 'worktree-clean' };
    }
    return { kind: 'escalate', mode: 'commit-pending' };
  } catch {
    return STAY_MALFORMED_PARKED;
  }
}
