// @generated entity stub — refined for lane K1-1.
/**
 * LaneRun is the conductor's lane run as a pure domain aggregate: a
 * serializable snapshot holding only what cannot be derived (plan §3.2) —
 * run and work order ids, tier, seat plan reference and a cursor per role,
 * round, attempts, PR number, park, park count, lease, revision and the run
 * policy revision. The run's state is a projection and is never stored here.
 * Validation returns a result and never throws; hostile or secret-shaped input
 * is refused with a fixed message, never echoed.
 */

import { isCalendarDateTime, readPlainRecordWithOptionalKeys, readExactPlainRecord } from '../plain-record-reads.js';
import {
  isPlainRecordObject,
  readRecordSchemaVersion,
  type ReadRecordSchemaOptions,
  type VersionedRecordRead,
} from '../record-schema-version.js';
import { containsSecretShape } from '@fleet/shared';
import { BASE_BRANCH_INVALID_MESSAGE, parseBaseBranch } from '../base-branch.js';
import type { BaseBranchValue } from '../base-branch.js';
import { LANE_RUN_MAX_PARK_ORDINAL, LANE_RUN_MAX_SEAT_INDEX } from '../lane-run-keys.js';
import {
  LANE_RUN_ID_PATTERN,
  LANE_RUN_KEY_STEPS,
  LANE_RUN_MAX_ATTEMPTS,
  LANE_RUN_MAX_ROUND,
  LANE_RUN_PARK_QUALIFIER,
  LANE_RUN_PARK_REASONS,
  LANE_RUN_RECORD_VERSION,
  LANE_RUN_SCHEMA_VERSION,
  LANE_RUN_TIERS,
  RUN_STOP_REFUSAL_KINDS,
} from '../lane-run-records.js';
import type {
  LaneRunKeyStep,
  LaneRunLeaseRecord,
  LaneRunParkReason,
  LaneRunParkRecord,
  LaneRunRecord,
  LaneRunTier,
  RunStopRefusalKind,
} from '../lane-run-records.js';
import { LANE_RUN_RESUMABLE_STATES } from '../value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from '../value-objects/LaneRunState.vo.js';
import { SEAT_PLAN_ROLES } from '../value-objects/SeatPlan.vo.js';

export type LaneRunResult =
  | { readonly success: true; readonly value: LaneRun }
  | { readonly success: false; readonly error: Error; readonly code: 'invalid' };

const ID_MAX_BYTES = 256;
const SEAT_PLAN_REF_PATTERN = /^[0-9a-f]{64}$/;
const LEASE_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** The keys every stored record must carry. */
const REQUIRED_RECORD_KEYS: readonly string[] = [
  'version',
  'runId',
  'workOrderId',
  'tier',
  'seatPlanRef',
  'cursors',
  'round',
  'attemptIds',
  'prNumber',
  'parked',
  'parkCount',
  'lease',
  'revision',
  'runPolicyRevision',
];

/**
 * The keys a record may omit: `branchName` (KF-5a), `baseBranch` (CB1) and
 * `schemaVersion` (Q5a, D6). One optional-key read keeps every stored record
 * readable without a version bump; anything else is an unknown key.
 */
const OPTIONAL_RECORD_KEYS: readonly string[] = ['branchName', 'baseBranch', 'schemaVersion'];

const PARKED_KEYS: readonly string[] = ['reason', 'qualifier', 'parkedFrom', 'questionId'];
const LEASE_KEYS: readonly string[] = ['holderId', 'fence', 'leaseUntilIso'];

export class LaneRun {
  private constructor(private readonly record: LaneRunRecord) {
    // Invariants are validated in create; the record is frozen on the way in.
  }

  /** The only way in; also used to read a stored record. Never throws. */
  static create(input: unknown): LaneRunResult {
    try {
      return LaneRun.createUnchecked(input);
    } catch {
      return unreadableInputResult();
    }
  }

  /**
   * Body of create. Hostile input (a throwing getter or proxy trap) may throw
   * out of this body; the public wrapper turns that into the fixed failure
   * result, never the exception's message. Only a plain object with the
   * required own enumerable string keys (plus the optional ones) is accepted,
   * and every field is read through its own property descriptor so no getter
   * ever runs. Each nested object is then snapshotted once the same way, and
   * the stored record is built only from those snapshots — the original
   * nested objects are never read again.
   */
  private static createUnchecked(input: unknown, currentVersion: number = LANE_RUN_SCHEMA_VERSION): LaneRunResult {
    if (!isPlainRecordObject(input)) {
      return invalid('LaneRun requires a record');
    }
    const versionRead = readRecordSchemaVersion(input, currentVersion);
    if (!versionRead.ok) {
      return invalid('LaneRun schemaVersion is not supported');
    }
    const recordInput = readPlainRecordWithOptionalKeys(input, REQUIRED_RECORD_KEYS, OPTIONAL_RECORD_KEYS);
    if (recordInput === null) {
      return invalid('LaneRun has an unknown key');
    }
    const scalars = validateScalarFields(recordInput);
    if (!scalars.ok) {
      return invalid(scalars.error);
    }
    const countersError = validateCounterFields(recordInput);
    if (countersError !== null) {
      return invalid(countersError);
    }
    const attempts = readValidatedAttempts(recordInput);
    if (!attempts.ok) {
      return invalid(attempts.error);
    }
    const parkAndLease = readValidatedParkAndLease(recordInput);
    if (!parkAndLease.ok) {
      return invalid(parkAndLease.error);
    }
    const branchFields = readOptionalBranchFields(recordInput);
    if (!branchFields.ok) {
      return invalid(branchFields.error);
    }
    const record: LaneRunRecord = {
      version: LANE_RUN_RECORD_VERSION,
      runId: recordInput.runId as string,
      workOrderId: recordInput.workOrderId as string,
      tier: recordInput.tier as LaneRunTier,
      seatPlanRef: recordInput.seatPlanRef as string,
      // The stored cursors are the snapshot validateScalarFields already read and
      // validated, never a second read of the original input (fix round 1).
      cursors: Object.freeze({
        'first-pass': scalars.cursors['first-pass'] as number | null,
        fix: scalars.cursors.fix as number | null,
        review: scalars.cursors.review as number | null,
      }),
      round: recordInput.round as number,
      attemptIds: attempts.attemptIds,
      prNumber: recordInput.prNumber as number | null,
      parked: parkAndLease.parked,
      parkCount: recordInput.parkCount as number,
      lease: parkAndLease.lease,
      revision: recordInput.revision as number,
      runPolicyRevision: recordInput.runPolicyRevision as string,
      ...(branchFields.branchName === undefined ? {} : { branchName: branchFields.branchName }),
      ...(branchFields.baseBranch === undefined ? {} : { baseBranch: branchFields.baseBranch }),
      ...(versionRead.explicit ? { schemaVersion: versionRead.schemaVersion } : {}),
    };
    return { success: true, value: new LaneRun(Object.freeze(record)) };
  }

  /**
   * The versioned stored-record read (Q5a): the schema check runs first so a
   * newer schema is refused as `'unknown-schema-version'` and never
   * quarantined, then the full body validates. The success record always
   * stamps `schemaVersion` (absent reads as 1).
   */
  static readStoredRecord(input: unknown, options?: ReadRecordSchemaOptions): VersionedRecordRead<LaneRunRecord> {
    const currentVersion = options?.currentVersion ?? LANE_RUN_SCHEMA_VERSION;
    try {
      const versionRead = readRecordSchemaVersion(input, currentVersion);
      if (!versionRead.ok) {
        return { ok: false, reason: versionRead.reason };
      }
      const created = LaneRun.createUnchecked(input, currentVersion);
      if (!created.success) {
        return { ok: false, reason: 'malformed' };
      }
      return {
        ok: true,
        record: Object.freeze({ ...created.value.toRecord(), schemaVersion: versionRead.schemaVersion }),
      };
    } catch {
      return { ok: false, reason: 'malformed' };
    }
  }

  /** Fresh plain record; nested objects are fresh copies. */
  toRecord(): LaneRunRecord {
    return {
      version: this.record.version,
      runId: this.record.runId,
      workOrderId: this.record.workOrderId,
      tier: this.record.tier,
      seatPlanRef: this.record.seatPlanRef,
      cursors: { ...this.record.cursors },
      round: this.record.round,
      attemptIds: [...this.record.attemptIds],
      prNumber: this.record.prNumber,
      parked: this.record.parked === null ? null : { ...this.record.parked },
      parkCount: this.record.parkCount,
      lease: this.record.lease === null ? null : { ...this.record.lease },
      revision: this.record.revision,
      runPolicyRevision: this.record.runPolicyRevision,
      ...(this.record.branchName === undefined ? {} : { branchName: this.record.branchName }),
      ...(this.record.baseBranch === undefined ? {} : { baseBranch: this.record.baseBranch }),
      ...(this.record.schemaVersion === undefined ? {} : { schemaVersion: this.record.schemaVersion }),
    };
  }

  getId(): string {
    return this.record.runId;
  }

  getWorkOrderId(): string {
    return this.record.workOrderId;
  }

  getTier(): LaneRunTier {
    return this.record.tier;
  }

  getRound(): number {
    return this.record.round;
  }

  getRevision(): number {
    return this.record.revision;
  }

  getParked(): LaneRunParkRecord | null {
    return this.record.parked === null ? null : { ...this.record.parked };
  }

  isParked(): boolean {
    return this.record.parked !== null;
  }
}

/** Versioned stored-record read for lane-run records (Q5a, D6). */
export function readLaneRunRecord(input: unknown, options?: ReadRecordSchemaOptions): VersionedRecordRead<LaneRunRecord> {
  return LaneRun.readStoredRecord(input, options);
}

/**
 * Version, runId, workOrderId, tier, seatPlanRef, cursors and runPolicyRevision.
 * Returns the cursors snapshot it validated so the caller stores exactly that
 * snapshot and never reads the original nested object a second time.
 */
function validateScalarFields(recordInput: Record<string, unknown>): {
  ok: true;
  cursors: Record<string, unknown>;
} | { ok: false; error: string } {
  if (recordInput.version !== LANE_RUN_RECORD_VERSION) {
    return { ok: false, error: 'LaneRun version must be 1' };
  }
  if (typeof recordInput.runId !== 'string' || !LANE_RUN_ID_PATTERN.test(recordInput.runId)) {
    return { ok: false, error: 'LaneRun runId must be run- followed by a ULID' };
  }
  const workOrderIdError = idError('workOrderId', recordInput.workOrderId);
  if (workOrderIdError !== null) {
    return { ok: false, error: workOrderIdError };
  }
  if (!LANE_RUN_TIERS.includes(recordInput.tier as LaneRunTier)) {
    return { ok: false, error: 'LaneRun tier must be 1 or 2' };
  }
  if (typeof recordInput.seatPlanRef !== 'string' || !SEAT_PLAN_REF_PATTERN.test(recordInput.seatPlanRef)) {
    return { ok: false, error: 'LaneRun seatPlanRef must be a sha256 hex digest' };
  }
  const cursorsSnapshot = readExactPlainRecord(recordInput.cursors, SEAT_PLAN_ROLES);
  const cursorsError = cursorsSnapshotError(cursorsSnapshot);
  if (cursorsError !== null) {
    return { ok: false, error: cursorsError };
  }
  const runPolicyRevisionError = idError('runPolicyRevision', recordInput.runPolicyRevision);
  if (runPolicyRevisionError !== null) {
    return { ok: false, error: runPolicyRevisionError };
  }
  return { ok: true, cursors: cursorsSnapshot as Record<string, unknown> };
}

/** round, prNumber, parkCount and revision. */
function validateCounterFields(recordInput: Record<string, unknown>): string | null {
  if (!Number.isInteger(recordInput.round) || (recordInput.round as number) < 0 || (recordInput.round as number) > LANE_RUN_MAX_ROUND) {
    return 'LaneRun round must be 0, 1 or 2';
  }
  const prNumber = recordInput.prNumber;
  if (prNumber !== null && (!Number.isSafeInteger(prNumber) || (prNumber as number) < 1)) {
    return 'LaneRun prNumber must be null or a positive integer';
  }
  const parkCount = recordInput.parkCount;
  if (
    !Number.isSafeInteger(parkCount) ||
    (parkCount as number) < 0 ||
    (parkCount as number) > LANE_RUN_MAX_PARK_ORDINAL
  ) {
    return 'LaneRun parkCount must be a non-negative integer';
  }
  if (!Number.isSafeInteger(recordInput.revision) || (recordInput.revision as number) < 1) {
    return 'LaneRun revision must be a positive integer';
  }
  return null;
}

/** The run's attempt list, frozen; refused when it cannot carry the run's round. */
function readValidatedAttempts(recordInput: Record<string, unknown>): {
  ok: true;
  attemptIds: readonly string[];
} | { ok: false; error: string } {
  const attemptIds = plainArrayCopy(recordInput.attemptIds);
  const attemptListError = attemptIdsError(attemptIds);
  if (attemptListError !== null) {
    return { ok: false, error: attemptListError };
  }
  const attemptList = attemptIds as unknown[];
  const round = recordInput.round as number;
  if (round !== 0 && attemptList.length < round + 1) {
    return { ok: false, error: 'LaneRun round exceeds its attempts' };
  }
  return { ok: true, attemptIds: Object.freeze([...attemptList]) as readonly string[] };
}

/** The run's park and lease snapshot records, frozen; refused with the fixed field messages. */
function readValidatedParkAndLease(recordInput: Record<string, unknown>): {
  ok: true;
  parked: LaneRunParkRecord | null;
  lease: LaneRunLeaseRecord | null;
} | { ok: false; error: string } {
  const parkRead = readValidatedPark(recordInput);
  if (!parkRead.ok) {
    return parkRead;
  }
  const leaseRead = readValidatedLease(recordInput);
  if (!leaseRead.ok) {
    return leaseRead;
  }
  return { ok: true, parked: parkRead.parked, lease: leaseRead.lease };
}

function readValidatedPark(recordInput: Record<string, unknown>): {
  ok: true;
  parked: LaneRunParkRecord | null;
} | { ok: false; error: string } {
  let parked: LaneRunParkRecord | null = null;
  if (recordInput.parked !== null) {
    const parkedSnapshot = readExactPlainRecord(recordInput.parked, PARKED_KEYS);
    const parkedError = parkedSnapshotError(parkedSnapshot);
    if (parkedError !== null) {
      return { ok: false, error: parkedError };
    }
    parked = buildParkedRecord(parkedSnapshot as Record<string, unknown>);
  }
  if (parked !== null && (recordInput.parkCount as number) < 1) {
    return { ok: false, error: 'LaneRun parkCount must count the current park' };
  }
  return { ok: true, parked };
}

function readValidatedLease(recordInput: Record<string, unknown>): {
  ok: true;
  lease: LaneRunLeaseRecord | null;
} | { ok: false; error: string } {
  let lease: LaneRunLeaseRecord | null = null;
  if (recordInput.lease !== null) {
    const leaseSnapshot = readExactPlainRecord(recordInput.lease, LEASE_KEYS);
    const leaseError = leaseSnapshotError(leaseSnapshot);
    if (leaseError !== null) {
      return { ok: false, error: leaseError };
    }
    lease = buildLeaseRecord(leaseSnapshot as Record<string, unknown>);
  }
  return { ok: true, lease };
}

/**
 * The same rule as ForgeActionAdapter's `isSafeBranchName`, with ForgeReadAdapter's
 * all-digit refusal; the domain copies it rather than importing an adapter (KF-5a).
 */
function isSafeBranchName(branch: unknown): boolean {
  if (typeof branch !== 'string') {
    return false;
  }
  const allDigits = /^\d+$/;
  return (
    branch.length <= 200 &&
    branch.length > 0 &&
    !branch.includes('..') &&
    !branch.endsWith('/') &&
    !branch.endsWith('.') &&
    !branch.endsWith('.lock') &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) &&
    !allDigits.test(branch) &&
    !containsSecretShape(branch)
  );
}

/** `branchName` is optional; when the key is present the value must be a safe branch name. */
function readOptionalBranchName(recordInput: Record<string, unknown>): {
  ok: true;
  branchName: string | undefined;
} | { ok: false; error: string } {
  if (!Object.hasOwn(recordInput, 'branchName')) {
    return { ok: true, branchName: undefined };
  }
  // Presence is decided with Object.hasOwn so a hostile key shape is refused like a
  // hostile workOrderId: an enumerable getter is never run, and its descriptor value
  // (undefined) arrives here as present-but-not-a-string (fix round 1).
  const branch = recordInput.branchName;
  if (!isSafeBranchName(branch)) {
    return { ok: false, error: 'LaneRun branchName must be a safe branch name' };
  }
  return { ok: true, branchName: branch as string };
}

/** `baseBranch` is optional (CB1); when the key is present the value must parse as one. */
function readOptionalBaseBranch(recordInput: Record<string, unknown>): {
  ok: true;
  baseBranch: BaseBranchValue | undefined;
} | { ok: false; error: string } {
  if (!Object.hasOwn(recordInput, 'baseBranch')) {
    return { ok: true, baseBranch: undefined };
  }
  // The same own-property presence rule as branchName: an enumerable getter is never
  // run, so a getter or an explicit `{ baseBranch: undefined }` key arrives here as
  // present-but-not-parseable and is refused rather than skipped (CB1).
  const parsed = parseBaseBranch(recordInput.baseBranch);
  if (parsed === undefined) {
    return { ok: false, error: 'LaneRun ' + BASE_BRANCH_INVALID_MESSAGE };
  }
  return { ok: true, baseBranch: parsed };
}

/**
 * runPolicyRevision, branchName (KF-5a) and baseBranch (CB1): the last field
 * checks of the body, moved here (fix round 1) so createUnchecked stays under
 * the file's complexity cap of 12. Returns the first refusal, with the same
 * messages as the inline checks it replaced.
 */
function readOptionalBranchFields(recordInput: Record<string, unknown>): {
  ok: true;
  branchName: string | undefined;
  baseBranch: BaseBranchValue | undefined;
} | { ok: false; error: string } {
  const runPolicyRevisionError = idError('runPolicyRevision', recordInput.runPolicyRevision);
  if (runPolicyRevisionError !== null) {
    return { ok: false, error: runPolicyRevisionError };
  }
  const branchName = readOptionalBranchName(recordInput);
  if (!branchName.ok) {
    return { ok: false, error: branchName.error };
  }
  const baseBranch = readOptionalBaseBranch(recordInput);
  if (!baseBranch.ok) {
    return { ok: false, error: baseBranch.error };
  }
  return { ok: true, branchName: branchName.branchName, baseBranch: baseBranch.baseBranch };
}

function invalid(message: string): LaneRunResult {
  return { success: false, error: new Error(message), code: 'invalid' };
}

function unreadableInputResult(): LaneRunResult {
  return { success: false, error: new Error('LaneRun input could not be read'), code: 'invalid' };
}

/** A fresh plain array copied by index (no iterator, no species); a non-array is returned unchanged. */
function plainArrayCopy(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    copy.push(descriptor === undefined ? undefined : descriptor.value);
  }
  return copy;
}

function idError(field: string, value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    new TextEncoder().encode(value).byteLength > ID_MAX_BYTES
  ) {
    return 'LaneRun ' + field + ' must be a non-empty id of at most 256 bytes';
  }
  if (containsSecretShape(value)) {
    return 'LaneRun ' + field + ' contains a secret-shaped value and was refused';
  }
  return null;
}

function cursorsSnapshotError(snapshot: Record<string, unknown> | null): string | null {
  if (snapshot === null) {
    return 'LaneRun cursors must be { first-pass, fix, review }, each null or a seat index';
  }
  for (const role of SEAT_PLAN_ROLES) {
    const value = snapshot[role];
    if (
      value !== null &&
      (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > LANE_RUN_MAX_SEAT_INDEX)
    ) {
      return 'LaneRun cursors must be { first-pass, fix, review }, each null or a seat index';
    }
  }
  return null;
}

function attemptIdsError(ids: unknown): string | null {
  if (!Array.isArray(ids) || ids.length > LANE_RUN_MAX_ATTEMPTS) {
    return 'LaneRun attemptIds must be at most 32 distinct ids';
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (
      typeof id !== 'string' ||
      id.trim().length === 0 ||
      new TextEncoder().encode(id).byteLength > ID_MAX_BYTES
    ) {
      return 'LaneRun attemptIds must be at most 32 distinct ids';
    }
    if (containsSecretShape(id)) {
      return 'LaneRun attemptIds contains a secret-shaped value and was refused';
    }
    if (seen.has(id)) {
      return 'LaneRun attemptIds must be at most 32 distinct ids';
    }
    seen.add(id);
  }
  return null;
}

function parkedSnapshotError(snapshot: Record<string, unknown> | null): string | null {
  if (snapshot === null) {
    return 'LaneRun parked must be null or { reason, qualifier, parkedFrom, questionId }';
  }
  const reason = snapshot.reason;
  if (typeof reason !== 'string' || !LANE_RUN_PARK_REASONS.includes(reason as LaneRunParkReason)) {
    return 'LaneRun parked reason is not a known park reason';
  }
  const parkedFrom = snapshot.parkedFrom;
  if (typeof parkedFrom !== 'string' || !LANE_RUN_RESUMABLE_STATES.includes(parkedFrom as LaneRunStateValue)) {
    return 'LaneRun parked parkedFrom must be a non-terminal state other than parked';
  }
  const qualifierRule = LANE_RUN_PARK_QUALIFIER[reason as LaneRunParkReason];
  const qualifier = snapshot.qualifier;
  if (qualifierRule === 'none') {
    if (qualifier !== null) {
      return 'LaneRun parked qualifier does not match its reason';
    }
  } else if (qualifierRule === 'step') {
    if (typeof qualifier !== 'string' || !LANE_RUN_KEY_STEPS.includes(qualifier as LaneRunKeyStep)) {
      return 'LaneRun parked qualifier does not match its reason';
    }
  } else if (typeof qualifier !== 'string' || !RUN_STOP_REFUSAL_KINDS.includes(qualifier as RunStopRefusalKind)) {
    return 'LaneRun parked qualifier does not match its reason';
  }
  if (snapshot.questionId !== null) {
    const questionIdError = idError('parked questionId', snapshot.questionId);
    if (questionIdError !== null) {
      return questionIdError;
    }
  }
  return null;
}

function buildParkedRecord(snapshot: Record<string, unknown>): LaneRunParkRecord {
  return Object.freeze({
    reason: snapshot.reason as LaneRunParkReason,
    qualifier: snapshot.qualifier as string | null,
    parkedFrom: snapshot.parkedFrom as LaneRunStateValue,
    questionId: snapshot.questionId as string | null,
  });
}

function leaseSnapshotError(snapshot: Record<string, unknown> | null): string | null {
  if (snapshot === null) {
    return 'LaneRun lease must be null or { holderId, fence, leaseUntilIso }';
  }
  const holderId = snapshot.holderId;
  if (
    typeof holderId !== 'string' ||
    holderId.trim().length === 0 ||
    new TextEncoder().encode(holderId).byteLength > ID_MAX_BYTES
  ) {
    return 'LaneRun lease must be null or { holderId, fence, leaseUntilIso }';
  }
  if (containsSecretShape(holderId)) {
    return 'LaneRun lease holderId contains a secret-shaped value and was refused';
  }
  if (!Number.isSafeInteger(snapshot.fence) || (snapshot.fence as number) < 1) {
    return 'LaneRun lease must be null or { holderId, fence, leaseUntilIso }';
  }
  if (
    typeof snapshot.leaseUntilIso !== 'string' ||
    !LEASE_ISO_PATTERN.test(snapshot.leaseUntilIso) ||
    !isCalendarDateTime(snapshot.leaseUntilIso) ||
    Number.isNaN(Date.parse(snapshot.leaseUntilIso))
  ) {
    return 'LaneRun lease must be null or { holderId, fence, leaseUntilIso }';
  }
  return null;
}

function buildLeaseRecord(snapshot: Record<string, unknown>): LaneRunLeaseRecord {
  return Object.freeze({
    holderId: snapshot.holderId as string,
    fence: snapshot.fence as number,
    leaseUntilIso: new Date(snapshot.leaseUntilIso as string).toISOString(),
  });
}
