/**
 * AR2a1x: the pure relaunch-apply domain decisions (cutover plan CO29, §4
 * steps 4–7 & 9, invariants I1–I7). Given journal entries it derives an
 * adopt sub-step's status (including the half-adopted `'partial'` state),
 * given a lane's step statuses it says what may happen next, it validates the
 * canonical lane step order, it decides I3 process-tree termination, it
 * canonicalizes save inputs for digest verification and it marks the
 * intent-only step. Pure: no I/O, no clock, no `node:*` import, no import
 * from `application/`, never throws. Hostile objects are read through their
 * own property descriptors only, so no getter ever runs; any inspection that
 * throws, any accessor, and any shape the validator does not recognize
 * returns a typed refusal.
 */

import { containsSecretShape } from '@fleet/shared';
import { isPlainRecordObject } from './record-schema-version.js';
import {
  readBoundedDenseArray,
  readExactPlainRecord,
  snapshotPlainDataRecord,
} from './plain-record-reads.js';
import {
  RELAUNCH_STEP_STATUSES,
  relaunchStepStatus,
  type RelaunchLaneProgress,
  type RelaunchStepStatus,
} from './relaunch-step-ledger.js';

/** The cost bound of the journal scan: read once before the loop. */
export const MAX_RELAUNCH_APPLY_ENTRIES = 10_000;
/** The cost bound of the lane step scan: read once before the loop. */
export const MAX_RELAUNCH_APPLY_STEPS = 16;
/** The cost bound of a save-inputs list: read once before the loop. */
export const MAX_RELAUNCH_APPLY_LANES = 512;

/** The per-lane steps of a relaunch, in the order a lane runs them. */
export const RELAUNCH_APPLY_STEP_CODES = ['save', 'abort', 'adopt', 'redispatch'] as const;
export type RelaunchApplyStepCode = (typeof RELAUNCH_APPLY_STEP_CODES)[number];

/** The four keyed adopt sub-steps, in order (`adopt/<sub-step>`). */
export const RELAUNCH_ADOPT_SUB_STEPS = ['work-order', 'brief', 'attempt', 'run'] as const;
export type RelaunchApplyAdoptSubStep = (typeof RELAUNCH_ADOPT_SUB_STEPS)[number];

/** The ledger statuses plus the half-adopted state of one adopt sub-step set. */
export const RELAUNCH_APPLY_STEP_STATUSES = [...RELAUNCH_STEP_STATUSES, 'partial'] as const;
export type RelaunchApplyStepStatus = (typeof RELAUNCH_APPLY_STEP_STATUSES)[number];

/** The next lane action: the ledger's grammar plus the `'resume'` of a partial adopt. */
export type RelaunchApplyLaneProgress =
  | Exclude<RelaunchLaneProgress, { kind: 'reconcile' }>
  | { readonly kind: 'resume'; readonly step: string }
  | { readonly kind: 'reconcile'; readonly step: string; readonly status: 'intent-only' | 'ambiguous' };

/** The I3 decision for one lane's process tree after its abort call returned. */
export type TerminateDecision =
  | { readonly terminate: true; readonly action: 'terminate'; readonly reason: string }
  | { readonly terminate: false; readonly action: 'none' | 'refuse'; readonly reason: string };

const PLAN_DIGEST = /^[0-9a-f]{64}$/;
const LANE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** One entry of the adopt journal, read exactly once into plain values. */
interface SnapshotEntry {
  readonly key: string;
  readonly kind: unknown;
  readonly outcome: undefined | unknown;
}

/**
 * Read one journal entry through its own property descriptors, without
 * invoking any getter. Requires own data descriptors for `key` and `kind`;
 * an `outcome` key must also be an own data property (its value is snapshotted
 * as `undefined` when the key is absent). `null` when anything else holds.
 */
function readLedgerEntrySnapshot(item: unknown): SnapshotEntry | null {
  if (item === null || typeof item !== 'object') return null;
  const descriptorOf = (key: string): PropertyDescriptor | undefined | null => {
    try {
      return Object.getOwnPropertyDescriptor(item as object, key);
    } catch {
      return null;
    }
  };
  const keyDescriptor = descriptorOf('key');
  if (keyDescriptor === null || keyDescriptor === undefined || keyDescriptor.get !== undefined) return null;
  const key: unknown = keyDescriptor.value;
  if (typeof key !== 'string') return null;
  const kindDescriptor = descriptorOf('kind');
  if (kindDescriptor === null || kindDescriptor === undefined || kindDescriptor.get !== undefined) return null;
  const outcomeDescriptor = descriptorOf('outcome');
  if (outcomeDescriptor === null) return null;
  if (outcomeDescriptor === undefined) return { key, kind: kindDescriptor.value, outcome: undefined };
  if (outcomeDescriptor.get !== undefined) return null;
  return { key, kind: kindDescriptor.value, outcome: outcomeDescriptor.value };
}

/**
 * Validate `planDigest` and `laneId` shapes, then derive the adopt sub-step
 * set's combined status. Every sub-step key is
 * `relaunch/<planDigest>/<laneId>/adopt/<sub-step>`; a snapshot of the
 * entries — never the original — is passed to `relaunchStepStatus`. Any
 * invalid input, accessor, throwing inspection or out-of-order sub-step
 * sequence returns `'inconsistent'`.
 */
export function deriveAdoptStepStatus(
  entries: unknown,
  planDigest: unknown,
  laneId: unknown,
): RelaunchApplyStepStatus {
  try {
    if (typeof planDigest !== 'string' || !PLAN_DIGEST.test(planDigest)) return 'inconsistent';
    if (typeof laneId !== 'string' || !LANE_ID.test(laneId)) return 'inconsistent';
    const dense = readBoundedDenseArray(entries, MAX_RELAUNCH_APPLY_ENTRIES);
    if (dense === null) return 'inconsistent';
    const snapshot: SnapshotEntry[] = [];
    for (const item of dense.array) {
      const entry = readLedgerEntrySnapshot(item);
      if (entry === null) return 'inconsistent';
      snapshot.push(entry);
    }
    const statuses: RelaunchStepStatus[] = [];
    for (const subStep of RELAUNCH_ADOPT_SUB_STEPS) {
      const status = relaunchStepStatus(snapshot, `relaunch/${planDigest}/${laneId}/adopt/${subStep}`);
      if (status === 'inconsistent') return 'inconsistent';
      statuses.push(status);
    }
    return adoptStatusFrom(statuses);
  } catch {
    return 'inconsistent';
  }
}

/** The combined adopt status of the four sub-step statuses, in canonical order. */
function adoptStatusFrom(statuses: readonly RelaunchStepStatus[]): RelaunchApplyStepStatus {
  if (statuses.every((status) => status === 'absent')) return 'absent';
  if (statuses.every((status) => status === 'completed')) return 'completed';
  if (statuses.includes('refused')) return 'refused';
  // Out-of-order: an earlier non-completed sub-step followed by a later
  // sub-step that has begun (any later status other than `'absent'`).
  for (let index = 0; index < statuses.length - 1; index += 1) {
    if (statuses[index] !== 'completed' && statuses[index + 1] !== 'absent') return 'inconsistent';
  }
  // At least one sub-step is recorded, none out of order, not all completed.
  return 'partial';
}

const INVALID_STEPS: RelaunchApplyLaneProgress = { kind: 'stopped', step: null, reason: 'invalid-steps' };

/**
 * One element of the lane step list, read exactly once through its own data
 * descriptors (never a getter).
 */
interface SnapshotStep {
  readonly step: string;
  readonly status: RelaunchApplyStepStatus;
}

function readStepSnapshot(item: unknown): SnapshotStep | null {
  const fields = readExactPlainRecord(item, ['step', 'status']);
  if (fields === null) return null;
  const step: unknown = fields.step;
  const status: unknown = fields.status;
  if (typeof step !== 'string') return null;
  if (typeof status !== 'string') return null;
  if (!(RELAUNCH_APPLY_STEP_STATUSES as readonly string[]).includes(status)) return null;
  return { step, status: status as RelaunchApplyStepStatus };
}

/**
 * The next lane action from the per-step statuses. The first non-`completed`
 * step decides: absent runs, partial resumes (`'reconcile'` is never
 * returned for a partial adopt), intent-only and ambiguous reconcile, and
 * refused or inconsistent stop. Any later non-absent step after the first
 * non-completed one is out of order. Invalid input returns the
 * `'invalid-steps'` stop.
 */
export function relaunchApplyLaneProgress(steps: unknown): RelaunchApplyLaneProgress {
  try {
    const dense = readBoundedDenseArray(steps, MAX_RELAUNCH_APPLY_STEPS);
    if (dense === null) return INVALID_STEPS;
    const seen = new Set<string>();
    const read: SnapshotStep[] = [];
    for (const item of dense.array) {
      const laneStep = readStepSnapshot(item);
      if (laneStep === null) return INVALID_STEPS;
      if (seen.has(laneStep.step)) return INVALID_STEPS;
      seen.add(laneStep.step);
      read.push(laneStep);
    }
    const firstIndex = read.findIndex((step) => step.status !== 'completed');
    if (firstIndex === -1) return { kind: 'done' };
    const first = read[firstIndex] as SnapshotStep;
    for (let index = firstIndex + 1; index < read.length; index += 1) {
      if (read[index]?.status !== 'absent') {
        return { kind: 'stopped', step: first.step, reason: 'out-of-order' };
      }
    }
    switch (first.status) {
      case 'absent':
        return { kind: 'run', step: first.step };
      case 'partial':
        return { kind: 'resume', step: first.step };
      case 'intent-only':
      case 'ambiguous':
        return { kind: 'reconcile', step: first.step, status: first.status };
      case 'refused':
        return { kind: 'stopped', step: first.step, reason: 'refused' };
      default:
        return { kind: 'stopped', step: first.step, reason: 'inconsistent' };
    }
  } catch {
    return INVALID_STEPS;
  }
}

/**
 * Validate a planned lane's canonical step sequence (D-CO10): a conducted run
 * keeps running and names no step; a running lane is saved, aborted, adopted
 * and redispatched; an idle lane skips the abort. Elements are read through
 * their own data descriptors; holes, accessors and any inspection that
 * throws return `false`.
 */
export function validateLaneStepOrder(
  population: unknown,
  runnerState: unknown,
  stepCodes: unknown,
): boolean {
  try {
    if (population !== 'conducted' && population !== 'attempt-recorded' && population !== 'unrecorded') {
      return false;
    }
    if (runnerState !== 'idle' && runnerState !== 'running') return false;
    const dense = readBoundedDenseArray(stepCodes, MAX_RELAUNCH_APPLY_STEPS);
    if (dense === null) return false;
    const read: string[] = [];
    for (const item of dense.array) {
      // Accept a bare step-code string or a planned-step record whose own
      // `step` is a data property; other fields (an idempotency key) are
      // ignored, but a getter is never read.
      let step: unknown = item;
      if (typeof step !== 'string') {
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor =
            item !== null && typeof item === 'object'
              ? Object.getOwnPropertyDescriptor(item as object, 'step')
              : undefined;
        } catch {
          return false;
        }
        if (descriptor === undefined || descriptor.get !== undefined) return false;
        step = descriptor.value;
      }
      if (typeof step !== 'string') return false;
      read.push(step);
    }
    const expected =
      population === 'conducted'
        ? []
        : runnerState === 'running'
          ? ['save', 'abort', 'adopt', 'redispatch']
          : ['save', 'adopt', 'redispatch'];
    return (
      read.length === expected.length && read.every((step, index) => step === (expected[index] as string))
    );
  } catch {
    return false;
  }
}

/**
 * Whether a step records an intent only, never a final `completed` result:
 * `'redispatch'` hands the lane back to the conductor, so its ledger state
 * stays `'intent-only'` from the apply's side.
 */
export function isIntentOnlyStep(step: unknown): boolean {
  return step === 'redispatch';
}

/**
 * The abort call's outcome for one lane, read exactly once through its own
 * data descriptors (never a getter). `outcome` is required exactly when
 * `kind` is `'result'`.
 */
interface SnapshotAbortOutcome {
  readonly kind: string;
  readonly outcome: undefined | unknown;
}

function readAbortOutcomeSnapshot(value: unknown): SnapshotAbortOutcome | null {
  const fields = readStrictPlainRecord(value, ['kind'], ['outcome']);
  if (fields === null) return null;
  const kind: unknown = fields.kind;
  if (typeof kind !== 'string') return null;
  return { kind, outcome: fields.outcome };
}

/**
 * I3: decide whether the lane's process tree may be terminated after the
 * abort call returned. Termination applies ONLY when the abort has no
 * confirmed `'aborted'` result: a still-running, unknown or refused outcome,
 * or a thrown abort, terminates. A confirmed `'aborted'` result ends the
 * session on the runner's end report and terminates nothing. A missing abort
 * method means no abort ran, so the lane refuses rather than terminating.
 * Any unreadable input (null, non-object, accessor, throwing inspection,
 * unknown kind or outcome) refuses too, never terminates.
 */
export function decideProcessTreeTermination(abortOutcome: unknown): TerminateDecision {
  try {
    const snapshot = readAbortOutcomeSnapshot(abortOutcome);
    if (snapshot === null) {
      return { terminate: false, action: 'refuse', reason: 'invalid-abort-outcome' };
    }
    if (snapshot.kind === 'result') {
      switch (snapshot.outcome) {
        case 'aborted':
          return { terminate: false, action: 'none', reason: 'abort-confirmed' };
        case 'still-running':
          return { terminate: true, action: 'terminate', reason: 'abort-still-running' };
        case 'unknown':
          return { terminate: true, action: 'terminate', reason: 'abort-outcome-unknown' };
        case 'refused':
          return { terminate: true, action: 'terminate', reason: 'abort-refused' };
        default:
          return { terminate: false, action: 'refuse', reason: 'invalid-abort-outcome' };
      }
    }
    if (snapshot.kind === 'threw') {
      return { terminate: true, action: 'terminate', reason: 'abort-threw' };
    }
    if (snapshot.kind === 'missing-method') {
      return { terminate: false, action: 'refuse', reason: 'abort-method-missing' };
    }
    return { terminate: false, action: 'refuse', reason: 'invalid-abort-outcome' };
  } catch {
    return { terminate: false, action: 'refuse', reason: 'invalid-abort-outcome' };
  }
}

/**
 * A secret-shaped string is refused anywhere a save input carries text; the
 * caller reports `secret-detected` from the `null` result.
 */
function isSafeText(value: unknown): value is string {
  return typeof value === 'string' && !containsSecretShape(value);
}

/**
 * A strict optional-key reader (stricter than the shared
 * `readPlainRecordWithOptionalKeys`): an accessor on any key — required or
 * optional — is refused here rather than read as an absent `undefined`, so a
 * getter can never stand in for a missing field. Unknown keys, symbol keys
 * and non-plain prototypes are refused too.
 */
function readStrictPlainRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> | null {
  if (!isPlainRecordObject(value)) return null;
  const allowed = new Set<string>([...required, ...optional]);
  const out: Record<string, unknown> = {};
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  for (const key of ownKeys) {
    if (typeof key !== 'string' || key === '__proto__' || !allowed.has(key)) return null;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return null;
    }
    if (descriptor === undefined || !descriptor.enumerable) return null;
    if (descriptor.get !== undefined || descriptor.set !== undefined) return null;
    out[key] = descriptor.value;
  }
  for (const key of required) {
    if (!Object.hasOwn(out, key)) return null;
  }
  return out;
}

/**
 * Validate one field of a validated `recordedHost` snapshot and add it to the
 * output record. `null` when the field is absent-but-required or invalid.
 */
function snapshotHostField(
  host: Record<string, unknown>,
  key: string,
  out: Record<string, unknown>,
): boolean {
  const value = host[key];
  switch (key) {
    case 'kind':
      if (value === 'opencode' || value === 'agy') {
        out[key] = value;
        return true;
      }
      return false;
    case 'remotePort':
      if (value === null) {
        out[key] = null;
        return true;
      }
      if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
        out[key] = value;
        return true;
      }
      return false;
    case 'useFreeSeats':
      if (value === undefined) {
        return true; // optional, absent
      }
      if (typeof value === 'boolean') {
        out[key] = value;
        return true;
      }
      return false;
    case 'hostName':
      if (value === undefined) {
        return true; // optional, absent
      }
      if (value === null || isSafeText(value)) {
        out[key] = value;
        return true;
      }
      return false;
    default:
      if (value === null || isSafeText(value)) {
        out[key] = value;
        return true;
      }
      return false;
  }
}

const HOST_REQUIRED_KEYS = ['kind', 'remotePort', 'host', 'agent', 'model', 'variant'] as const;
const HOST_OPTIONAL_KEYS = ['hostName', 'useFreeSeats'] as const;
const HOST_ALL_KEYS = [...HOST_REQUIRED_KEYS, ...HOST_OPTIONAL_KEYS];

/**
 * Validate and snapshot `recordedHost` against `AttemptRunnerRecord`: every
 * required and optional field read through its own data descriptor, unknown
 * keys and secret-shaped strings refused, values snapshotted before any
 * stringify. `null` on any failure; `undefined` when `recordedHost` is `null`.
 */
function snapshotRecordedHost(recordedHost: unknown): Record<string, unknown> | null | undefined {
  if (recordedHost === null) return null;
  const fields = readStrictPlainRecord(recordedHost, HOST_REQUIRED_KEYS, HOST_OPTIONAL_KEYS);
  if (fields === null) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of HOST_ALL_KEYS) {
    if (!snapshotHostField(fields, key, out)) return undefined;
  }
  if (out.hostName === undefined) delete out.hostName;
  if (out.useFreeSeats === undefined) delete out.useFreeSeats;
  return out;
}

/**
 * Deeply preflight one JSON value without reading any property: plain objects
 * with own enumerable string data keys only, dense arrays of plain values,
 * and finite JSON primitives. Everything else (accessors, sparse arrays,
 * class instances, symbol keys, Proxies that throw on inspection) is refused.
 */
function preflightJsonValue(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value);
  if (type !== 'object') return false;
  if (Array.isArray(value)) {
    const dense = readBoundedDenseArray(value, MAX_RELAUNCH_APPLY_ENTRIES);
    if (dense === null) return false;
    return dense.array.every((element) => preflightJsonValue(element));
  }
  const snapshot = snapshotPlainDataRecord(value);
  if (snapshot === null) return false;
  for (const key of Object.keys(snapshot)) {
    if (!preflightJsonValue(snapshot[key])) return false;
  }
  return true;
}

/** One validated and snapshotted save input: every field a plain value. */
interface SnapshotSaveInput {
  readonly laneId: string;
  readonly attemptId: string;
  readonly worktreePath: string;
  readonly clonePath: string;
  readonly recordedHost: Record<string, unknown> | null;
  readonly baseCommit: string;
  readonly allowedPathPrefixes: readonly string[];
  readonly policyProtectedPaths: readonly string[];
}

/**
 * Snapshot one save input without running any getter: the top-level fields,
 * `recordedHost` and both path arrays are read through their own descriptors,
 * accessors and unknown keys refused, and every validated value copied into a
 * plain record. `null` on any failure.
 */
function snapshotSaveInput(input: unknown): SnapshotSaveInput | null {
  const fields = readStrictPlainRecord(
    input,
    ['laneId', 'attemptId', 'worktreePath', 'clonePath', 'recordedHost', 'baseCommit', 'allowedPathPrefixes'],
    ['policyProtectedPaths'],
  );
  if (fields === null) return null;
  const laneId = fields.laneId;
  const attemptId = fields.attemptId;
  const worktreePath = fields.worktreePath;
  const clonePath = fields.clonePath;
  const baseCommit = fields.baseCommit;
  if (typeof laneId !== 'string' || !LANE_ID.test(laneId)) return null;
  // `attemptId` is never `null` and never empty.
  if (typeof attemptId !== 'string' || attemptId === '') return null;
  if (!isSafeText(worktreePath) || worktreePath === '') return null;
  if (!isSafeText(clonePath) || clonePath === '') return null;
  if (typeof baseCommit !== 'string' || baseCommit === '') return null;
  const allowed = readBoundedDenseArray(fields.allowedPathPrefixes, MAX_RELAUNCH_APPLY_ENTRIES);
  if (allowed === null) return null;
  if (!allowed.array.every((prefix) => isSafeText(prefix))) return null;
  let policyProtected: readonly string[] = [];
  if (fields.policyProtectedPaths !== undefined) {
    const policy = readBoundedDenseArray(fields.policyProtectedPaths, MAX_RELAUNCH_APPLY_ENTRIES);
    if (policy === null) return null;
    if (!policy.array.every((prefix) => isSafeText(prefix))) return null;
    policyProtected = policy.array as readonly string[];
  }
  const host = snapshotRecordedHost(fields.recordedHost);
  if (host === undefined) return null;
  return {
    laneId,
    attemptId,
    worktreePath,
    clonePath,
    recordedHost: host,
    baseCommit,
    allowedPathPrefixes: allowed.array as readonly string[],
    policyProtectedPaths: policyProtected,
  };
}

/**
 * The canonical JSON of one lane's save input together with the plan digest
 * it belongs to: deterministic (`JSON.stringify` of the fixed key order
 * above), digest-sensitive, and validated before anything is read. The
 * snapshot is taken with `structuredClone` only after the descriptor
 * preflight has proved the reachable graph, so a Proxy stand-in the
 * preflight cannot distinguish from data is refused by the clone probe
 * rather than trusted. `null` on any invalid input, accessor, unknown key,
 * secret-shaped string, sparse array, unsupported prototype, throwing
 * inspection or failed clone.
 */
export function canonicalSaveInputJson(planDigest: unknown, input: unknown): string | null {
  try {
    if (typeof planDigest !== 'string' || !PLAN_DIGEST.test(planDigest)) return null;
    if (!preflightJsonValue(input)) return null;
    let clone: unknown;
    try {
      clone = structuredClone(input);
    } catch {
      return null;
    }
    const snapshot = snapshotSaveInput(clone);
    if (snapshot === null) return null;
    return JSON.stringify({
      planDigest,
      laneId: snapshot.laneId,
      attemptId: snapshot.attemptId,
      worktreePath: snapshot.worktreePath,
      clonePath: snapshot.clonePath,
      recordedHost: snapshot.recordedHost,
      baseCommit: snapshot.baseCommit,
      allowedPathPrefixes: snapshot.allowedPathPrefixes,
      policyProtectedPaths: snapshot.policyProtectedPaths,
    });
  } catch {
    return null;
  }
}

/**
 * Whether the current canonical save-input digest matches the digest recorded
 * with the `save` intent. `'match'` only when both are 64-hex lowercase
 * strings and equal: an un-digested or mismatched save intent is refused,
 * never silently accepted.
 */
export function verifySaveIntentDigest(
  recordedDigest: unknown,
  currentDigest: unknown,
): 'match' | 'mismatch' {
  if (typeof recordedDigest !== 'string' || !PLAN_DIGEST.test(recordedDigest)) return 'mismatch';
  if (typeof currentDigest !== 'string' || !PLAN_DIGEST.test(currentDigest)) return 'mismatch';
  return recordedDigest === currentDigest ? 'match' : 'mismatch';
}
