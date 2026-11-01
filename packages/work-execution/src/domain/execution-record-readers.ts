/**
 * Pure versioned readers for the execution records (Q5a, D6: checked at
 * load). Each reader reads the `schemaVersion` contract first, then takes a
 * descriptor-safe snapshot of the input, then validates and builds a fresh
 * record of only the declared fields and runs the entity `fromRecord`.
 * Pure: never throws to the caller, never runs an accessor, never echoes an
 * input value.
 */

import { containsSecretShape } from '@fleet/shared';
import { snapshotPlainDataRecord } from './plain-record-reads.js';
import {
  readRecordSchemaVersion,
  isPlainRecordObject,
  type ReadRecordSchemaOptions,
  type VersionedRecordRead,
} from './record-schema-version.js';
import {
  ACTION_JOURNAL_ENTRY_SCHEMA_VERSION,
  ATTEMPT_RECORD_SCHEMA_VERSION,
  CAPACITY_RESERVATION_SCHEMA_VERSION,
  parseSeatTool,
  type ActionJournalEntryRecord,
  type AttemptKind,
  type AttemptRecord,
  type AttemptRunnerRecord,
  type AttemptSeatOverrideRecord,
  type AttemptSeatSelectionRecord,
  type AttemptUsageRecord,
  type CapacityReservationRecord,
  type CollectedAttemptArtifacts,
  type CommandCompletionReceipt,
} from './execution-records.js';
import { Attempt } from './entities/Attempt.js';
import { CapacityReservation } from './entities/CapacityReservation.js';
import { ActionJournalEntry } from './entities/ActionJournalEntry.js';
import { AttemptOutcome } from './value-objects/AttemptOutcome.vo.js';
import { AttemptState, type AttemptStateValue } from './value-objects/AttemptState.vo.js';
import { parseStopReason, type StopReasonValue } from './value-objects/StopReason.vo.js';
import { SeatPlan, type SeatPlanProps } from './value-objects/SeatPlan.vo.js';

const MALFORMED = new Error('malformed');

function malformed(): never {
  throw MALFORMED;
}

/** A required non-empty trimmed string; a missing, blank or non-string value is malformed. */
function requiredString(snap: Record<string, unknown>, key: string): string {
  const value = snap[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    malformed();
  }
  return value;
}

/** The record's `id`: a required non-empty trimmed string that carries no secret shape. */
function readRecordId(snap: Record<string, unknown>): string {
  const id = requiredString(snap, 'id');
  if (containsSecretShape(id)) {
    malformed();
  }
  return id;
}

/** A required `string | null` field: null is kept, anything non-string is malformed. */
function requireNullableString(snap: Record<string, unknown>, key: string): string | null {
  const value = snap[key];
  if (value !== null && typeof value !== 'string') {
    malformed();
  }
  return value as string | null;
}

/** A `string | null` field where `undefined` and `null` both normalize to null. */
function nullableString(snap: Record<string, unknown>, key: string): string | null {
  const value = snap[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    malformed();
  }
  return value;
}

/** An optional non-empty trimmed string; absent and undefined both read as absent. */
function optionalNonEmptyString(snap: Record<string, unknown>, key: string): string | undefined {
  const value = snap[key];
  if (value === undefined) {
    return undefined;
  }
  return requiredString(snap, key);
}

/** A `number | null` field that must be a non-negative safe integer when not null. */
function nullableNonNegativeSafeInt(snap: Record<string, unknown>, key: string): number | null {
  const value = snap[key];
  if (value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    malformed();
  }
  return value as number;
}

/** A `number | null` field that must be a finite non-negative number when not null. */
function nullableNonNegativeFinite(snap: Record<string, unknown>, key: string): number | null {
  const value = snap[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    malformed();
  }
  return value;
}

function isPlainDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  if (descriptor === undefined || !descriptor.enumerable) {
    return false;
  }
  return descriptor.get === undefined && descriptor.set === undefined;
}

/** Refuse any array whose own keys are not exactly the index keys and 'length'. */
function requirePlainArrayKeys(value: unknown[]): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys[value.length] !== 'length') {
    malformed();
  }
  for (let index = 0; index < value.length; index += 1) {
    if (keys[index] !== String(index)) {
      malformed();
    }
  }
}

/** An array of strings copied by index through own-property descriptors; getters never run. */
function copyStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    malformed();
  }
  requirePlainArrayKeys(value);
  const copy: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!isPlainDataDescriptor(descriptor) || typeof descriptor.value !== 'string') {
      malformed();
    }
    copy.push(descriptor.value);
  }
  return copy;
}

/** An array of non-empty strings copied by index; getters never run. */
function copyNonEmptyStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    malformed();
  }
  requirePlainArrayKeys(value);
  const copy: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (
      !isPlainDataDescriptor(descriptor) ||
      typeof descriptor.value !== 'string' ||
      descriptor.value.trim().length === 0
    ) {
      malformed();
    }
    copy.push(descriptor.value);
  }
  return copy;
}

/** Refuse any key outside `keys`; symbol keys and `__proto__` never reach here. */
function requireOnlyKeys(snap: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Reflect.ownKeys(snap)) {
    if (typeof key !== 'string' || !keys.includes(key)) {
      malformed();
    }
  }
}

/** A plain data record with exactly the given own enumerable data keys. */
function readExactDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const snap = snapshotPlainDataRecord(value);
  if (snap === null) {
    malformed();
  }
  requireOnlyKeys(snap, keys);
  for (const key of keys) {
    if (!Object.hasOwn(snap, key)) {
      malformed();
    }
  }
  return snap;
}

function copyPlainArray(value: unknown[]): unknown[] {
  requirePlainArrayKeys(value);
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!isPlainDataDescriptor(descriptor)) {
      malformed();
    }
    copy.push(deepCopyPlainData(descriptor.value));
  }
  return copy;
}

function copyPlainRecord(value: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key === '__proto__') {
      malformed();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!isPlainDataDescriptor(descriptor)) {
      malformed();
    }
    copy[key] = deepCopyPlainData(descriptor.value);
  }
  return copy;
}

/** A descriptor-safe deep copy of a plain data value; accessors and holes are malformed. */
function deepCopyPlainData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return copyPlainArray(value);
  }
  if (isPlainRecordObject(value)) {
    return copyPlainRecord(value);
  }
  if (typeof value === 'object' && value !== null) {
    malformed();
  }
  if (typeof value === 'function') {
    malformed();
  }
  return value;
}

const COMPLETION_RECEIPT_KEYS: readonly string[] = [
  'attemptId',
  'sessionId',
  'endedAtIso',
  'authoritative',
  'exitStatus',
  'stoppedByRequest',
];

const ARTIFACT_KEYS: readonly string[] = [
  'headCommit',
  'commitsSinceBase',
  'collectedArtifactPaths',
  'notes',
  'manifestPath',
  'manifestSha256',
];

function validateAttemptPriorAttempt(kind: unknown, priorAttemptId: unknown): void {
  if (priorAttemptId === null) {
    if (kind === 'fix') {
      malformed();
    }
    return;
  }
  if (typeof priorAttemptId !== 'string' || priorAttemptId.trim().length === 0) {
    malformed();
  }
}

/** Validate the attempt's identity and scalar fields; any failure throws. */
function readAttemptIdentity(snap: Record<string, unknown>): void {
  readRecordId(snap);
  requiredString(snap, 'workOrderId');
  requiredString(snap, 'worktreePath');
  requiredString(snap, 'baseCommit');
  requiredString(snap, 'createdAtIso');
  requiredString(snap, 'updatedAtIso');
  const kind = snap.kind;
  if (kind !== 'initial' && kind !== 'fix') {
    malformed();
  }
  if (!Number.isSafeInteger(snap.fixNumber) || (snap.fixNumber as number) < 0) {
    malformed();
  }
  validateAttemptPriorAttempt(kind, snap.priorAttemptId);
  if (!AttemptState.create(snap.state).success) {
    malformed();
  }
  if (snap.outcome !== null && !AttemptOutcome.create(snap.outcome).success) {
    malformed();
  }
  requireNullableString(snap, 'briefDigest');
  requireNullableString(snap, 'briefPackagePath');
  requireNullableString(snap, 'sessionId');
}

/** The attempt's revision: absent reads as 0; otherwise a non-negative safe integer. */
function readRevision(snap: Record<string, unknown>): number {
  if (snap.revision === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(snap.revision) || (snap.revision as number) < 0) {
    malformed();
  }
  return snap.revision as number;
}

function readRemotePort(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value)) {
    malformed();
  }
  return value as number;
}

function readHostName(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    malformed();
  }
  return value.trim() !== '' ? value : null;
}

function readRunnerKind(kind: unknown): AttemptRunnerRecord['kind'] {
  if (kind === 'agy') {
    return 'agy';
  }
  if (kind === undefined || kind === 'opencode') {
    return 'opencode';
  }
  malformed();
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    malformed();
  }
  return value;
}

/** The runner block: a plain data record with the declared runner fields. */
function readAttemptRunner(value: unknown): AttemptRunnerRecord {
  const snap = snapshotPlainDataRecord(value);
  if (snap === null) {
    malformed();
  }
  const useFreeSeats = readOptionalBoolean(snap.useFreeSeats);
  return {
    kind: readRunnerKind(snap.kind),
    remotePort: readRemotePort(snap.remotePort),
    host: nullableString(snap, 'host'),
    hostName: readHostName(snap.hostName),
    agent: nullableString(snap, 'agent'),
    model: nullableString(snap, 'model'),
    variant: nullableString(snap, 'variant'),
    ...(useFreeSeats === undefined ? {} : { useFreeSeats }),
  };
}

/** The optional runner block: omitted when absent, null when null. */
function readAttemptRunnerField(snap: Record<string, unknown>): AttemptRunnerRecord | null | undefined {
  if (snap.runner === undefined) {
    return undefined;
  }
  if (snap.runner === null) {
    return null;
  }
  return readAttemptRunner(snap.runner);
}

/** The completion receipt: null, or an exact plain data record. */
function readAttemptCompletionReceipt(value: unknown): CommandCompletionReceipt | null {
  if (value === null) {
    return null;
  }
  const snap = readExactDataRecord(value, COMPLETION_RECEIPT_KEYS);
  const exitStatus = snap.exitStatus;
  if (exitStatus !== null && !Number.isSafeInteger(exitStatus)) {
    malformed();
  }
  if (typeof snap.authoritative !== 'boolean' || typeof snap.stoppedByRequest !== 'boolean') {
    malformed();
  }
  return {
    attemptId: requiredString(snap, 'attemptId'),
    sessionId: requiredString(snap, 'sessionId'),
    endedAtIso: requiredString(snap, 'endedAtIso'),
    authoritative: snap.authoritative as boolean,
    exitStatus: exitStatus as number | null,
    stoppedByRequest: snap.stoppedByRequest as boolean,
  };
}

function readOptionalString(snap: Record<string, unknown>, key: string): string | undefined {
  const value = snap[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    malformed();
  }
  return value;
}

/** The artifacts block: null, or an exact plain data record with fresh string arrays. */
function readAttemptArtifacts(value: unknown): CollectedAttemptArtifacts | null {
  if (value === null) {
    return null;
  }
  const snap = snapshotPlainDataRecord(value);
  if (snap === null) {
    malformed();
  }
  requireOnlyKeys(snap, ARTIFACT_KEYS);
  const notes = snap.notes;
  if (notes !== 'present' && notes !== 'missing') {
    malformed();
  }
  const manifestPath = readOptionalString(snap, 'manifestPath');
  const manifestSha256 = readOptionalString(snap, 'manifestSha256');
  return {
    headCommit: requiredString(snap, 'headCommit'),
    commitsSinceBase: copyStringArray(snap.commitsSinceBase),
    collectedArtifactPaths: copyStringArray(snap.collectedArtifactPaths),
    notes,
    ...(manifestPath === undefined ? {} : { manifestPath }),
    ...(manifestSha256 === undefined ? {} : { manifestSha256 }),
  };
}

/** The usage block: null, or a plain data record matching `AttemptUsageRecord`. */
function readAttemptUsage(value: unknown): AttemptUsageRecord | null {
  if (value === null) {
    return null;
  }
  const snap = snapshotPlainDataRecord(value);
  if (snap === null) {
    malformed();
  }
  const source = snap.source;
  if (source !== 'opencode-db' && source !== 'opencode-api' && source !== 'unavailable') {
    malformed();
  }
  return {
    source: source as AttemptUsageRecord['source'],
    readAtIso: requiredString(snap, 'readAtIso'),
    sessionId: requireNullableString(snap, 'sessionId'),
    steps: nullableNonNegativeSafeInt(snap, 'steps'),
    wallSeconds: nullableNonNegativeFinite(snap, 'wallSeconds'),
    tokensInput: nullableNonNegativeSafeInt(snap, 'tokensInput'),
    tokensOutput: nullableNonNegativeSafeInt(snap, 'tokensOutput'),
    tokensReasoning: nullableNonNegativeSafeInt(snap, 'tokensReasoning'),
    tokensCacheRead: nullableNonNegativeSafeInt(snap, 'tokensCacheRead'),
    tokensCacheWrite: nullableNonNegativeSafeInt(snap, 'tokensCacheWrite'),
    costUsd: nullableNonNegativeFinite(snap, 'costUsd'),
    model: requireNullableString(snap, 'model'),
    agent: requireNullableString(snap, 'agent'),
    reason: requireNullableString(snap, 'reason'),
  };
}

function validateSeatRole(role: unknown): AttemptSeatSelectionRecord['role'] {
  if (role !== 'first-pass' && role !== 'fix' && role !== 'review') {
    malformed();
  }
  return role as AttemptSeatSelectionRecord['role'];
}

function readSeatTicket(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    malformed();
  }
  return value as number;
}

function readSeatAvailableCount(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    malformed();
  }
  return value as number;
}

/** The seat selection block: null, or a plain data record with declared seat fields. */
function readAttemptSeatSelection(value: unknown): AttemptSeatSelectionRecord | null {
  if (value === null) {
    return null;
  }
  const snap = snapshotPlainDataRecord(value);
  if (snap === null) {
    malformed();
  }
  const role = validateSeatRole(snap.role);
  if (!Number.isSafeInteger(snap.seatIndex) || (snap.seatIndex as number) < 0) {
    malformed();
  }
  const ticket = readSeatTicket(snap.ticket);
  const availableCount = readSeatAvailableCount(snap.availableCount);
  return {
    role,
    seatIndex: snap.seatIndex as number,
    seatId: requiredString(snap, 'seatId'),
    model: requiredString(snap, 'model'),
    tool: requireNullableString(snap, 'tool'),
    variant: requireNullableString(snap, 'variant'),
    agent: requireNullableString(snap, 'agent'),
    ...(ticket === undefined ? {} : { ticket }),
    ...(availableCount === undefined ? {} : { availableCount }),
  };
}

/** The seat override block: null, or a plain data record with declared override fields. */
function readAttemptSeatOverride(value: unknown): AttemptSeatOverrideRecord | null {
  if (value === null) {
    return null;
  }
  const snap = snapshotPlainDataRecord(value);
  if (snap === null) {
    malformed();
  }
  const agent = optionalNonEmptyString(snap, 'agent');
  const variant = optionalNonEmptyString(snap, 'variant');
  return {
    model: requiredString(snap, 'model'),
    reason: requiredString(snap, 'reason'),
    setBy: requiredString(snap, 'setBy'),
    expiresAtIso: requiredString(snap, 'expiresAtIso'),
    ...(agent === undefined ? {} : { agent }),
    ...(variant === undefined ? {} : { variant }),
  };
}

/** The seat plan block: null, or a descriptor-safe copy parsed and cleaned by `SeatPlan`. */
function readAttemptSeatPlan(value: unknown): SeatPlanProps | null {
  if (value === null) {
    return null;
  }
  const parsed = SeatPlan.create(deepCopyPlainData(value));
  if (!parsed.success || parsed.value === undefined) {
    malformed();
  }
  return parsed.value.toJSON();
}

/** The optional attempt fields that are only included when present on the input. */
interface AttemptOptionalFields {
  dispatchRevision?: number;
  seatOverride?: AttemptSeatOverrideRecord | null;
  usage?: AttemptUsageRecord | null;
  seatPlan?: SeatPlanProps | null;
  seatSelection?: AttemptSeatSelectionRecord | null;
  stopReason?: StopReasonValue;
  reviewerSeat?: string | null;
  dispatchedTimeLimitSeconds?: number;
  ownerDecisionReferences?: readonly string[];
}

function readOptionalNonNegativeSafeInt(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    malformed();
  }
  return value as number;
}

function readOptionalPositiveSafeInt(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    malformed();
  }
  return value as number;
}

function assignAttemptNumberFields(snap: Record<string, unknown>): AttemptOptionalFields {
  const out: AttemptOptionalFields = {};
  const dispatchRevision = readOptionalNonNegativeSafeInt(snap.dispatchRevision);
  if (dispatchRevision !== undefined) {
    out.dispatchRevision = dispatchRevision;
  }
  const dispatchedTimeLimitSeconds = readOptionalPositiveSafeInt(snap.dispatchedTimeLimitSeconds);
  if (dispatchedTimeLimitSeconds !== undefined) {
    out.dispatchedTimeLimitSeconds = dispatchedTimeLimitSeconds;
  }
  return out;
}

function assignAttemptRecordFields(snap: Record<string, unknown>): AttemptOptionalFields {
  const out: AttemptOptionalFields = {};
  if (snap.seatOverride !== undefined) {
    out.seatOverride = readAttemptSeatOverride(snap.seatOverride);
  }
  if (snap.usage !== undefined) {
    out.usage = readAttemptUsage(snap.usage);
  }
  if (snap.seatSelection !== undefined) {
    out.seatSelection = readAttemptSeatSelection(snap.seatSelection);
  }
  if (snap.seatPlan !== undefined) {
    out.seatPlan = readAttemptSeatPlan(snap.seatPlan);
  }
  return out;
}

function readOptionalStopReason(value: unknown): StopReasonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    malformed();
  }
  return parseStopReason(value);
}

function readOptionalReviewerSeat(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== null && typeof value !== 'string') {
    malformed();
  }
  return value as string | null;
}

function assignAttemptScalarFields(snap: Record<string, unknown>): AttemptOptionalFields {
  const out: AttemptOptionalFields = {};
  const stopReason = readOptionalStopReason(snap.stopReason);
  if (stopReason !== undefined) {
    out.stopReason = stopReason;
  }
  const reviewerSeat = readOptionalReviewerSeat(snap.reviewerSeat);
  if (reviewerSeat !== undefined) {
    out.reviewerSeat = reviewerSeat;
  }
  if (snap.ownerDecisionReferences !== undefined) {
    out.ownerDecisionReferences = copyNonEmptyStringArray(snap.ownerDecisionReferences);
  }
  return out;
}

function assignOptionalAttemptFields(snap: Record<string, unknown>): AttemptOptionalFields {
  return {
    ...assignAttemptNumberFields(snap),
    ...assignAttemptRecordFields(snap),
    ...assignAttemptScalarFields(snap),
  };
}

/**
 * Read and validate an attempt record. The `schemaVersion` contract runs
 * first; a version failure is returned before any body-key check. All
 * nested objects and arrays on the result are fresh copies.
 */
export function readAttemptRecord(input: unknown, options?: ReadRecordSchemaOptions): VersionedRecordRead<AttemptRecord> {
  try {
    const versionRead = readRecordSchemaVersion(input, options?.currentVersion ?? ATTEMPT_RECORD_SCHEMA_VERSION);
    if (!versionRead.ok) {
      return { ok: false, reason: versionRead.reason };
    }
    const snap = snapshotPlainDataRecord(input);
    if (snap === null) {
      return { ok: false, reason: 'malformed' };
    }
    readAttemptIdentity(snap);
    const runner = readAttemptRunnerField(snap);
    const record: AttemptRecord = {
      id: snap.id as string,
      workOrderId: snap.workOrderId as string,
      kind: snap.kind as AttemptKind,
      fixNumber: snap.fixNumber as number,
      priorAttemptId: snap.priorAttemptId as string | null,
      worktreePath: snap.worktreePath as string,
      baseCommit: snap.baseCommit as string,
      state: snap.state as AttemptStateValue,
      revision: readRevision(snap),
      outcome: snap.outcome as AttemptRecord['outcome'],
      briefDigest: snap.briefDigest as string | null,
      briefPackagePath: snap.briefPackagePath as string | null,
      sessionId: snap.sessionId as string | null,
      completionReceipt: readAttemptCompletionReceipt(snap.completionReceipt),
      artifacts: readAttemptArtifacts(snap.artifacts),
      createdAtIso: snap.createdAtIso as string,
      updatedAtIso: snap.updatedAtIso as string,
      schemaVersion: versionRead.schemaVersion,
      ...(runner === undefined ? {} : { runner }),
      ...assignOptionalAttemptFields(snap),
    };
    Attempt.fromRecord(record);
    return { ok: true, record: Object.freeze(record) };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

function readReleasedAtIso(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    malformed();
  }
  return value;
}

function readNullableTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readReservationTransport(value: unknown): 'local' | 'ssh' | null {
  if (value === 'local' || value === 'ssh') {
    return value;
  }
  return null;
}

function readReservationPort(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Read and validate a capacity-reservation record. Host fields are
 * null-normalizations (never `'malformed'`); the record's own invariants
 * are enforced through `CapacityReservation.fromRecord`.
 */
export function readCapacityReservationRecord(
  input: unknown,
  options?: ReadRecordSchemaOptions,
): VersionedRecordRead<CapacityReservationRecord> {
  try {
    const versionRead = readRecordSchemaVersion(input, options?.currentVersion ?? CAPACITY_RESERVATION_SCHEMA_VERSION);
    if (!versionRead.ok) {
      return { ok: false, reason: versionRead.reason };
    }
    const snap = snapshotPlainDataRecord(input);
    if (snap === null) {
      return { ok: false, reason: 'malformed' };
    }
    const id = readRecordId(snap);
    const attemptId = requiredString(snap, 'attemptId');
    const hostId = requiredString(snap, 'hostId');
    const reservedAtIso = requiredString(snap, 'reservedAtIso');
    const slotIndex = snap.slotIndex;
    if (!Number.isSafeInteger(slotIndex) || (slotIndex as number) < 0) {
      return { ok: false, reason: 'malformed' };
    }
    if (typeof snap.held !== 'boolean') {
      return { ok: false, reason: 'malformed' };
    }
    const releasedAtIso = readReleasedAtIso(snap.releasedAtIso);
    if (snap.held === true && releasedAtIso !== null) {
      return { ok: false, reason: 'malformed' };
    }
    const record: CapacityReservationRecord = {
      id,
      attemptId,
      hostId,
      slotIndex: slotIndex as number,
      held: snap.held as boolean,
      seatTool: parseSeatTool(snap.seatTool) ?? null,
      hostName: readNullableTrimmedString(snap.hostName),
      hostKind: parseSeatTool(snap.hostKind) ?? null,
      transport: readReservationTransport(snap.transport),
      sshAlias: readNullableTrimmedString(snap.sshAlias),
      port: readReservationPort(snap.port),
      worktreePath: readNullableTrimmedString(snap.worktreePath),
      reservedAtIso,
      releasedAtIso,
      schemaVersion: versionRead.schemaVersion,
    };
    CapacityReservation.fromRecord(record);
    return { ok: true, record: Object.freeze(record) };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

function nullableNormalizedToNull(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    malformed();
  }
  return value;
}

/** The optional action-journal fields that are only included when present. */
interface JournalOptionalFields {
  stopReason?: StopReasonValue;
  observedSessionIds?: readonly string[];
  authorizedBy?: string;
}

function applyJournalOptionalFields(snap: Record<string, unknown>): JournalOptionalFields {
  const out: JournalOptionalFields = {};
  const stopReason = readOptionalStopReason(snap.stopReason);
  if (stopReason !== undefined) {
    out.stopReason = stopReason;
  }
  if (snap.observedSessionIds !== undefined) {
    out.observedSessionIds = copyStringArray(snap.observedSessionIds);
  }
  if (snap.authorizedBy !== undefined) {
    out.authorizedBy = requiredString(snap, 'authorizedBy');
  }
  return out;
}

function isDeclaredJournalAction(action: unknown): action is ActionJournalEntryRecord['action'] {
  return (
    action === 'dispatch' ||
    action === 'reconcile' ||
    action === 'stop' ||
    action === 'collect' ||
    action === 'forge' ||
    action === 'accept'
  );
}

function isDeclaredJournalStatus(status: unknown): status is ActionJournalEntryRecord['status'] {
  return status === 'intent-recorded' || status === 'completed' || status === 'ambiguous' || status === 'refused';
}

/**
 * Read and validate an action-journal entry. Required identity fields must be
 * present; optional body fields are kept only when present on the input.
 */
export function readActionJournalEntryRecord(
  input: unknown,
  options?: ReadRecordSchemaOptions,
): VersionedRecordRead<ActionJournalEntryRecord> {
  try {
    const versionRead = readRecordSchemaVersion(input, options?.currentVersion ?? ACTION_JOURNAL_ENTRY_SCHEMA_VERSION);
    if (!versionRead.ok) {
      return { ok: false, reason: versionRead.reason };
    }
    const snap = snapshotPlainDataRecord(input);
    if (snap === null) {
      return { ok: false, reason: 'malformed' };
    }
    const id = readRecordId(snap);
    const attemptId = requiredString(snap, 'attemptId');
    const workOrderId = requiredString(snap, 'workOrderId');
    const baseCommit = requiredString(snap, 'baseCommit');
    const recordedAtIso = requiredString(snap, 'recordedAtIso');
    if (!isDeclaredJournalAction(snap.action)) {
      return { ok: false, reason: 'malformed' };
    }
    if (!isDeclaredJournalStatus(snap.status)) {
      return { ok: false, reason: 'malformed' };
    }
    const record: ActionJournalEntryRecord = {
      id,
      attemptId,
      workOrderId,
      action: snap.action,
      baseCommit,
      recordedAtIso,
      status: snap.status,
      sessionId: nullableNormalizedToNull(snap.sessionId),
      detail: nullableNormalizedToNull(snap.detail),
      schemaVersion: versionRead.schemaVersion,
      ...applyJournalOptionalFields(snap),
    };
    ActionJournalEntry.fromRecord(record);
    return { ok: true, record: Object.freeze(record) };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}
