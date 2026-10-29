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

import { isCalendarDateTime, readExactPlainRecord } from '../plain-record-reads.js';
import { containsSecretShape } from '@fleet/shared';
import { LANE_RUN_MAX_PARK_ORDINAL, LANE_RUN_MAX_SEAT_INDEX } from '../lane-run-keys.js';
import {
  LANE_RUN_ID_PATTERN,
  LANE_RUN_KEY_STEPS,
  LANE_RUN_MAX_ATTEMPTS,
  LANE_RUN_MAX_ROUND,
  LANE_RUN_PARK_QUALIFIER,
  LANE_RUN_PARK_REASONS,
  LANE_RUN_RECORD_VERSION,
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

const RECORD_KEYS: readonly string[] = [
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
  'branchName',
];

/** Keys before KF-5a: records without `branchName` stay readable. */
const LEGACY_RECORD_KEYS: readonly string[] = RECORD_KEYS.filter((key) => key !== 'branchName');

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
   * result, never the exception's message. Only a plain object with exactly
   * the allowed own enumerable string keys is accepted, and every field is
   * read through its own property descriptor so no getter ever runs. Each
   * nested object is then snapshotted once the same way, and the stored
   * record is built only from those snapshots — the original nested objects
   * are never read again.
   */
  private static createUnchecked(input: unknown): LaneRunResult {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('LaneRun requires a record');
    }
    const inputPrototype = Object.getPrototypeOf(input);
    if (inputPrototype !== Object.prototype && inputPrototype !== null) {
      return invalid('LaneRun requires a record');
    }
    const recordInput = readExactPlainRecord(input, RECORD_KEYS) ?? readExactPlainRecord(input, LEGACY_RECORD_KEYS);
    if (recordInput === null) {
      return invalid('LaneRun has an unknown key');
    }

    if (recordInput.version !== LANE_RUN_RECORD_VERSION) {
      return invalid('LaneRun version must be 1');
    }
    if (typeof recordInput.runId !== 'string' || !LANE_RUN_ID_PATTERN.test(recordInput.runId)) {
      return invalid('LaneRun runId must be run- followed by a ULID');
    }
    const workOrderIdError = idError('workOrderId', recordInput.workOrderId);
    if (workOrderIdError !== null) {
      return invalid(workOrderIdError);
    }
    if (!LANE_RUN_TIERS.includes(recordInput.tier as LaneRunTier)) {
      return invalid('LaneRun tier must be 1 or 2');
    }
    if (typeof recordInput.seatPlanRef !== 'string' || !SEAT_PLAN_REF_PATTERN.test(recordInput.seatPlanRef)) {
      return invalid('LaneRun seatPlanRef must be a sha256 hex digest');
    }

    const cursorsSnapshot = readExactPlainRecord(recordInput.cursors, SEAT_PLAN_ROLES);
    const cursorsError = cursorsSnapshotError(cursorsSnapshot);
    if (cursorsError !== null) {
      return invalid(cursorsError);
    }

    if (!Number.isInteger(recordInput.round) || (recordInput.round as number) < 0 || (recordInput.round as number) > LANE_RUN_MAX_ROUND) {
      return invalid('LaneRun round must be 0, 1 or 2');
    }
    const round = recordInput.round as number;

    const attemptIds = plainArrayCopy(recordInput.attemptIds);
    const attemptListError = attemptIdsError(attemptIds);
    if (attemptListError !== null) {
      return invalid(attemptListError);
    }
    const attemptList = attemptIds as unknown[];
    if (round !== 0 && attemptList.length < round + 1) {
      return invalid('LaneRun round exceeds its attempts');
    }

    const prNumber = recordInput.prNumber;
    if (prNumber !== null && (!Number.isSafeInteger(prNumber) || (prNumber as number) < 1)) {
      return invalid('LaneRun prNumber must be null or a positive integer');
    }
    const parkCount = recordInput.parkCount;
    if (
      !Number.isSafeInteger(parkCount) ||
      (parkCount as number) < 0 ||
      (parkCount as number) > LANE_RUN_MAX_PARK_ORDINAL
    ) {
      return invalid('LaneRun parkCount must be a non-negative integer');
    }

    let parked: LaneRunParkRecord | null = null;
    if (recordInput.parked !== null) {
      const parkedSnapshot = readExactPlainRecord(recordInput.parked, PARKED_KEYS);
      const parkedError = parkedSnapshotError(parkedSnapshot);
      if (parkedError !== null) {
        return invalid(parkedError);
      }
      parked = buildParkedRecord(parkedSnapshot as Record<string, unknown>);
    }
    if (parked !== null && (parkCount as number) < 1) {
      return invalid('LaneRun parkCount must count the current park');
    }

    let lease: LaneRunLeaseRecord | null = null;
    if (recordInput.lease !== null) {
      const leaseSnapshot = readExactPlainRecord(recordInput.lease, LEASE_KEYS);
      const leaseError = leaseSnapshotError(leaseSnapshot);
      if (leaseError !== null) {
        return invalid(leaseError);
      }
      lease = buildLeaseRecord(leaseSnapshot as Record<string, unknown>);
    }

    if (!Number.isSafeInteger(recordInput.revision) || (recordInput.revision as number) < 1) {
      return invalid('LaneRun revision must be a positive integer');
    }
    const runPolicyRevisionError = idError('runPolicyRevision', recordInput.runPolicyRevision);
    if (runPolicyRevisionError !== null) {
      return invalid(runPolicyRevisionError);
    }

    // The same rule as ForgeActionAdapter's `isSafeBranchName`, with ForgeReadAdapter's
    // all-digit refusal; the domain copies it rather than importing an adapter (KF-5a).
    // Presence is decided with Object.hasOwn so a hostile key shape is refused like a
    // hostile workOrderId: `readExactPlainRecord` exposes an accessor's descriptor value,
    // which is undefined, so a getter or an explicit `{ branchName: undefined }` key
    // arrives here as present-but-not-a-string (fix round 1).
    let branchName: string | undefined;
    if (Object.hasOwn(recordInput, 'branchName')) {
      const branch = recordInput.branchName;
      const allDigits = /^\d+$/;
      const safe =
        typeof branch === 'string' &&
        branch.length <= 200 &&
        branch.length > 0 &&
        !branch.includes('..') &&
        !branch.endsWith('/') &&
        !branch.endsWith('.') &&
        !branch.endsWith('.lock') &&
        /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) &&
        !allDigits.test(branch) &&
        !containsSecretShape(branch);
      if (!safe) {
        return invalid('LaneRun branchName must be a safe branch name');
      }
      branchName = branch;
    }

    const record: LaneRunRecord = {
      version: LANE_RUN_RECORD_VERSION,
      runId: recordInput.runId as string,
      workOrderId: recordInput.workOrderId as string,
      tier: recordInput.tier as LaneRunTier,
      seatPlanRef: recordInput.seatPlanRef as string,
      cursors: Object.freeze({
        'first-pass': (cursorsSnapshot as Record<string, unknown>)['first-pass'] as number | null,
        fix: (cursorsSnapshot as Record<string, unknown>).fix as number | null,
        review: (cursorsSnapshot as Record<string, unknown>).review as number | null,
      }),
      round,
      attemptIds: Object.freeze([...attemptList]) as readonly string[],
      prNumber: prNumber as number | null,
      parked,
      parkCount: parkCount as number,
      lease,
      revision: recordInput.revision as number,
      runPolicyRevision: recordInput.runPolicyRevision as string,
      ...(branchName === undefined ? {} : { branchName }),
    };
    return { success: true, value: new LaneRun(Object.freeze(record)) };
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
