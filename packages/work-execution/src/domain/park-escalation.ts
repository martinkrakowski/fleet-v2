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
 * The pure park-escalation decision (CE1). Checks in this order: the parked
 * record's shape and `reason`, then the run's journal history (an earlier
 * `commit-pending` escalation is final — once per run), then the observed
 * dirty-worktree fact. `fix-no-progress` is the only escalatable park reason.
 * Total: any throw (a hostile Proxy trap) reads as `malformed-parked-record`.
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
    const findings = parkedRecord.findings;
    if (findings !== undefined && findings !== null) {
      if (!Array.isArray(findings) || findings.length > PARK_FINDINGS_MAX_COUNT) {
        return STAY_MALFORMED_PARKED;
      }
      for (let i = 0; i < findings.length; i += 1) {
        if (!Object.prototype.hasOwnProperty.call(findings, i) || !isPlainRecordObject(findings[i])) {
          return STAY_MALFORMED_PARKED;
        }
      }
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
    for (let i = 0; i < history.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(history, i)) {
        return STAY_MALFORMED_HISTORY;
      }
      const snapshot = snapshotPlainDataRecord(history[i]);
      if (snapshot === null) {
        return STAY_MALFORMED_HISTORY;
      }
      if ((snapshot.reasonCode === 'park-escalated' && snapshot.detail === 'commit-pending') || snapshot.mode === 'commit-pending') {
        return { kind: 'stay-parked', reason: 'already-escalated' };
      }
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
