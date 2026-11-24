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
import { PARK_FINDINGS_MAX_COUNT } from './park-findings-view.js';
import { readExactPlainRecord, readPlainRecordWithOptionalKeys, snapshotPlainDataRecord } from './plain-record-reads.js';
import { isPlainRecordObject } from './record-schema-version.js';

/** The escalation modes: a fix round of a pending commit, or a re-collect of an advanced head. */
export const PARK_ESCALATION_MODES = ['commit-pending', 'recollect'] as const;
export type ParkEscalationMode = (typeof PARK_ESCALATION_MODES)[number];

/** Cost bound on the history scan: a longer history is refused, never scanned. */
export const PARK_ESCALATION_HISTORY_MAX = 256;

/** The observed fact that justifies an escalation: tracked files changed since the attempt's head. */
export interface DirtyWorktreeFact {
  readonly trackedFilesChanged: number;
}

/** The observed fact that the worktree's HEAD has moved since the collect. */
export interface HeadFact {
  readonly headAdvanced: boolean;
}

/** Why the run stays parked instead of escalating. */
export const PARK_ESCALATION_STAY_REASONS = [
  'malformed-parked-record',
  'malformed-history',
  'history-too-long',
  'missing-dirty-worktree-fact',
  'malformed-dirty-worktree-fact',
  'malformed-head-fact',
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
const STAY_MALFORMED_HEAD: ParkEscalationDecision = { kind: 'stay-parked', reason: 'malformed-head-fact' };

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
 * Whether the history already carries the escalation marker of `mode`, either
 * as the `park-escalated` result's detail (the journal shape) or as a direct
 * `mode` key (the fact shape). Fixed-key reads on already-validated snapshots.
 */
function hasEscalatedMode(snapshots: readonly Record<string, unknown>[], mode: ParkEscalationMode): boolean {
  return snapshots.some((snapshot) => (snapshot.reasonCode === 'park-escalated' && snapshot.detail === mode) || snapshot.mode === mode);
}

/**
 * The pure park-escalation decision (CE1/CE3). Checks in this order: the parked
 * record's shape and `reason`, then the run's journal history (each escalation
 * mode is final — once per run per mode), then the observed facts: an advanced
 * head escalates with mode `recollect` regardless of the worktree state;
 * otherwise the dirty-worktree fact decides a `commit-pending` fix round.
 * `fix-no-progress` is the only escalatable park reason.
 * Total: any throw (a hostile Proxy trap) reads as `malformed-parked-record`.
 */
export function decideParkEscalation(parked: unknown, history: unknown, dirtyWorktree?: unknown, headFact?: unknown): ParkEscalationDecision {
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
    if (reason !== 'fix-no-progress') {
      return { kind: 'stay-parked', reason: 'park-reason-not-escalatable' };
    }
    if (!Array.isArray(history)) {
      return STAY_MALFORMED_HISTORY;
    }
    if (history.length > PARK_ESCALATION_HISTORY_MAX) {
      return { kind: 'stay-parked', reason: 'history-too-long' };
    }
    // Validate EVERY entry before looking for the marker, so a malformed later
    // entry is never skipped behind an earlier escalation marker.
    const snapshots: NonNullable<ReturnType<typeof snapshotPlainDataRecord>>[] = [];
    for (let i = 0; i < history.length; i += 1) {
      // Every element is read through its own descriptor: a hole or an
      // accessor element (getter/setter) is refused without running any getter.
      const descriptor = Object.getOwnPropertyDescriptor(history, i);
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
        return STAY_MALFORMED_HISTORY;
      }
      const snapshot = snapshotPlainDataRecord(descriptor.value);
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
    if (headFact !== undefined && headFact !== null) {
      const head = readExactPlainRecord(headFact, ['headAdvanced']);
      if (head === null || typeof head.headAdvanced !== 'boolean') {
        return STAY_MALFORMED_HEAD;
      }
      if (head.headAdvanced === true) {
        if (hasEscalatedMode(snapshots, 'recollect')) {
          return { kind: 'stay-parked', reason: 'already-escalated' };
        }
        return { kind: 'escalate', mode: 'recollect' };
      }
    }
    if (hasEscalatedMode(snapshots, 'commit-pending')) {
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
