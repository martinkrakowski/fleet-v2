// @generated adapter scaffold — refined for lane CO29a.
/**
 * RelaunchPlanRepositoryAdapter implements RelaunchPlanRepositoryPort: an
 * immutable, digest-keyed store of relaunch plans, in memory or persisted to
 * `<stateDir>/relaunch-plans.json` under an exclusive lock with an atomic
 * rename. A plan is create-if-absent by `planDigest`: an identical replay is
 * `unchanged` and writes nothing, and a replay that changes the request digest
 * or any plan field is `digest-conflict`, decided before any write. Every
 * incoming plan is read once through own data properties into a plain copy,
 * so a throwing or stateful getter cannot throw out of `save` or answer twice.
 * An unreadable file or an unknown schema version is reported, never read as
 * an empty store, and nothing is quarantined or rewritten on a refusal.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';

import { parseBaseBranch } from '../../domain/base-branch.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import {
  canonicalRelaunchPlanBodyJson,
  RELAUNCH_PLAN_SCHEMA_VERSION,
  relaunchStepCodesFor,
  relaunchStepKey,
  type FindRelaunchPlanResult,
  type RelaunchPlanRecord,
  type RelaunchPlanRepositoryPort,
  type RelaunchPlanSaveRefusalReason,
  type RelaunchPlannedLane,
  type RelaunchPlannedPopulation,
  type RelaunchPlannedStep,
  type SaveRelaunchPlanResult,
} from '../../application/ports/out/RelaunchPlanRepositoryPort.out-port.js';
import {
  assertValidSchemaVersionPolicy,
  inspectVersionedRecordListBytes,
  readStoreRecordSchemaVersion,
  StateFileUnknownVersionError,
  withFileLock,
  writeJsonAtomically,
  type VersionedRecordParseResult,
} from './file-store.js';

export const RELAUNCH_PLAN_STORE_VERSION_POLICY = assertValidSchemaVersionPolicy('relaunch-plans.json', {
  writerVersion: 1,
  acceptedVersions: [1],
});

export interface RelaunchPlanRepositoryAdapterOptions {
  /** Directory for file-backed JSON persistence; in-memory only when omitted. */
  readonly stateDir?: string;
  /** File name inside the state directory; defaults to `relaunch-plans.json`. */
  readonly fileName?: string;
  /** Read-only: every save is refused as `store-read-only`; reads never write. */
  readonly readOnly?: boolean;
}

const DEFAULT_FILE_NAME = 'relaunch-plans.json';
const OTHER_STORE_FILE_NAMES = [
  'work-orders.json',
  'attempts.json',
  'journal.json',
  'reservations.json',
  'lane-runs.json',
  'run-journal.json',
  'lane-plans.json',
  'cutover-journal.json',
];
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

const MAX_STORED_PLANS = 256;
const MAX_PLAN_STORE_BYTES = 8 * 1024 * 1024;
const MAX_LANES_PER_PLAN = 512;
const MAX_ID_LENGTH = 128;
const MAX_ENDPOINT_LENGTH = 256;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const LANE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const ID = /^[A-Za-z0-9._-]{1,128}$/;
const ENDPOINT = /^[A-Za-z0-9._:-]{1,256}$/;
const POPULATIONS: readonly RelaunchPlannedPopulation[] = ['conducted', 'attempt-recorded', 'unrecorded'];

const PLAN_KEYS = [
  'schemaVersion',
  'planDigest',
  'requestDigest',
  'createdAtIso',
  'hostFilter',
  'maxActiveRuns',
  'dispatchStaggerMs',
  'conductor',
  'lanes',
];
const CONDUCTOR_KEYS = ['halted', 'driverLease', 'runCount'];
const LANE_KEYS = [
  'laneId',
  'hostName',
  'projectId',
  'population',
  'runnerState',
  'runId',
  'attemptId',
  'workOrderId',
  'baseBranch',
  'chainHead',
  'dependsOnLaneIds',
  'admissionWave',
  'dispatchEndpointKey',
  'staggerOffsetMs',
  'steps',
];
const STEP_KEYS = ['step', 'idempotencyKey'];

const ABSENT = Symbol('absent');
const BAD = Symbol('bad');

/** Thrown inside the reader only; `readRelaunchPlanRecord` turns it into null. */
class InvalidPlanInput extends Error {}

function invalid(): never {
  throw new InvalidPlanInput('invalid relaunch plan');
}

/** An own, enumerable-or-not data property of a plain object; ABSENT when missing, BAD when a getter, setter or non-plain object. */
function own(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return BAD;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return BAD;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return ABSENT;
  if (descriptor.get !== undefined || descriptor.set !== undefined || !('value' in descriptor)) return BAD;
  return descriptor.value;
}

function required(value: unknown, key: string): unknown {
  const read = own(value, key);
  if (read === ABSENT || read === BAD) return invalid();
  return read;
}

function onlyKeys(value: unknown, allowed: readonly string[]): void {
  if (typeof value !== 'object' || value === null) return invalid();
  if (Object.getOwnPropertySymbols(value).length > 0) return invalid();
  for (const name of Object.getOwnPropertyNames(value)) {
    if (!allowed.includes(name)) return invalid();
  }
}

function hasSecretShape(text: string): boolean {
  return (
    containsSecretShape(text) ||
    LANE_DIFF_SECRET_PATTERNS.some((entry) => new RegExp(entry.regex.source, entry.regex.flags.replace('g', '')).test(text))
  );
}

function text(value: unknown, pattern: RegExp, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength || !pattern.test(value) || hasSecretShape(value)) {
    return invalid();
  }
  return value;
}

function nullableText(value: unknown, pattern: RegExp, maxLength: number): string | null {
  return value === null ? null : text(value, pattern, maxLength);
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid();
  return value;
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid();
  return value;
}

/** A dense array of at most `max` items, each read once through its own data property. */
function dense(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) return invalid();
    items.push(descriptor.value);
  }
  return items;
}

function readStep(raw: unknown, planDigest: string, laneId: string): RelaunchPlannedStep {
  onlyKeys(raw, STEP_KEYS);
  const step = required(raw, 'step');
  if (step !== 'save' && step !== 'abort' && step !== 'adopt' && step !== 'redispatch') return invalid();
  const idempotencyKey = required(raw, 'idempotencyKey');
  if (idempotencyKey !== relaunchStepKey(planDigest, laneId, step)) return invalid();
  return { step, idempotencyKey };
}

function readLane(raw: unknown, planDigest: string): RelaunchPlannedLane {
  onlyKeys(raw, LANE_KEYS);
  const laneId = text(required(raw, 'laneId'), LANE_ID, 64);
  const hostName = text(required(raw, 'hostName'), ID, MAX_ID_LENGTH);
  const projectId = nullableText(required(raw, 'projectId'), ID, MAX_ID_LENGTH);
  const population = required(raw, 'population');
  if (!POPULATIONS.includes(population as RelaunchPlannedPopulation)) return invalid();
  const runnerState = required(raw, 'runnerState');
  if (runnerState !== 'idle' && runnerState !== 'running') return invalid();
  const runId = nullableText(required(raw, 'runId'), ID, MAX_ID_LENGTH);
  const attemptId = nullableText(required(raw, 'attemptId'), ID, MAX_ID_LENGTH);
  const workOrderId = nullableText(required(raw, 'workOrderId'), ID, MAX_ID_LENGTH);
  const baseBranch = parseBaseBranch(required(raw, 'baseBranch'));
  if (baseBranch === undefined) return invalid();
  const chainHead = bool(required(raw, 'chainHead'));
  const dependsOnLaneIds = dense(required(raw, 'dependsOnLaneIds'), MAX_LANES_PER_PLAN).map((item) =>
    text(item, LANE_ID, 64),
  );
  if (new Set(dependsOnLaneIds).size !== dependsOnLaneIds.length || dependsOnLaneIds.includes(laneId)) return invalid();
  const admissionWave = integer(required(raw, 'admissionWave'), 0, MAX_LANES_PER_PLAN + 2);
  const endpointRaw = required(raw, 'dispatchEndpointKey');
  const dispatchEndpointKey = nullableText(endpointRaw, ENDPOINT, MAX_ENDPOINT_LENGTH);
  const staggerRaw = required(raw, 'staggerOffsetMs');
  const staggerOffsetMs = staggerRaw === null ? null : integer(staggerRaw, 0, Number.MAX_SAFE_INTEGER);
  const steps = dense(required(raw, 'steps'), 4).map((item) => readStep(item, planDigest, laneId));

  // The shape of a lane follows from its population and runner state (D-CO10).
  const expected = relaunchStepCodesFor(population as RelaunchPlannedPopulation, runnerState);
  if (steps.length !== expected.length || steps.some((step, index) => step.step !== expected[index])) return invalid();
  if (population === 'conducted') {
    if (admissionWave !== 0 || dispatchEndpointKey !== null || staggerOffsetMs !== null) return invalid();
  } else if (admissionWave < 1 || dispatchEndpointKey === null || staggerOffsetMs === null) {
    return invalid();
  }
  return {
    laneId,
    hostName,
    projectId,
    population: population as RelaunchPlannedPopulation,
    runnerState,
    runId,
    attemptId,
    workOrderId,
    baseBranch,
    chainHead,
    dependsOnLaneIds,
    admissionWave,
    dispatchEndpointKey,
    staggerOffsetMs,
    steps,
  };
}

/**
 * Pure; never throws and never echoes the input. Reads every property once
 * through its own data descriptor and returns a plain copy, or null when the
 * input is not a well-formed plan: unknown keys, getters, sparse arrays,
 * secret-shaped or path-shaped text, inconsistent steps, duplicate lanes or a
 * dependency on a lane the plan does not hold.
 */
export function readRelaunchPlanRecord(input: unknown, stored = false): RelaunchPlanRecord | null {
  try {
    onlyKeys(input, PLAN_KEYS);
    const versionRaw = own(input, 'schemaVersion');
    if (versionRaw === BAD) return invalid();
    if (versionRaw === ABSENT ? !stored : versionRaw !== RELAUNCH_PLAN_SCHEMA_VERSION) return invalid();
    const planDigest = text(required(input, 'planDigest'), SHA256_HEX, 64);
    const requestDigest = text(required(input, 'requestDigest'), SHA256_HEX, 64);
    const createdAtIso = required(input, 'createdAtIso');
    if (typeof createdAtIso !== 'string' || createdAtIso.length > 64 || !isZonedIsoDateTime(createdAtIso)) {
      return invalid();
    }
    const hostFilter = nullableText(required(input, 'hostFilter'), ID, MAX_ID_LENGTH);
    const maxActiveRuns = integer(required(input, 'maxActiveRuns'), 1, 64);
    const dispatchStaggerMs = integer(required(input, 'dispatchStaggerMs'), 0, 600_000);
    const conductorRaw = required(input, 'conductor');
    onlyKeys(conductorRaw, CONDUCTOR_KEYS);
    const halted = bool(required(conductorRaw, 'halted'));
    const driverLease = required(conductorRaw, 'driverLease');
    if (driverLease !== 'absent' && driverLease !== 'lapsed' && driverLease !== 'live') return invalid();
    const runCount = integer(required(conductorRaw, 'runCount'), 0, Number.MAX_SAFE_INTEGER);
    const lanes = dense(required(input, 'lanes'), MAX_LANES_PER_PLAN).map((item) => readLane(item, planDigest));

    const seen = new Set<string>();
    for (const lane of lanes) {
      const key = `${lane.hostName}\u0000${lane.laneId}`;
      if (seen.has(key)) return invalid();
      seen.add(key);
    }
    const laneIds = new Set(lanes.map((lane) => lane.laneId));
    for (const lane of lanes) {
      if (lane.dependsOnLaneIds.some((dependency) => !laneIds.has(dependency))) return invalid();
    }
    return {
      schemaVersion: RELAUNCH_PLAN_SCHEMA_VERSION,
      planDigest,
      requestDigest,
      createdAtIso,
      hostFilter,
      maxActiveRuns,
      dispatchStaggerMs,
      conductor: { halted, driverLease, runCount },
      lanes,
    };
  } catch {
    return null;
  }
}

function parseStoredPlan(raw: unknown): VersionedRecordParseResult<RelaunchPlanRecord> {
  const versionCheck = readStoreRecordSchemaVersion(raw, RELAUNCH_PLAN_STORE_VERSION_POLICY);
  if (versionCheck.status !== 'ok') return versionCheck;
  const plan = readRelaunchPlanRecord(raw, true);
  if (plan === null) return { status: 'invalid' };
  // A stored record whose body no longer hashes to its digest is corrupt: never readable.
  if (!digestMatches(plan)) return { status: 'invalid' };
  return { status: 'ok', record: plan, schemaVersion: versionCheck.schemaVersion };
}

function sha256Hex(textToHash: string): string {
  return createHash('sha256').update(textToHash).digest('hex');
}

/** Whether a record's body still hashes to the digest it claims (and is keyed by). */
function digestMatches(record: RelaunchPlanRecord): boolean {
  return sha256Hex(canonicalRelaunchPlanBodyJson(record)) === record.planDigest;
}

/** A fresh plain copy: mutating a returned record must never change the stored one. */
function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type StoreRead =
  | { readonly status: 'ok'; readonly records: RelaunchPlanRecord[] }
  | { readonly status: 'unknown-version' }
  | { readonly status: 'unreadable' };

type SaveDecision =
  | { readonly kind: 'refused'; readonly reason: RelaunchPlanSaveRefusalReason }
  | { readonly kind: 'unchanged'; readonly stored: RelaunchPlanRecord }
  | { readonly kind: 'append' };

/** Pure: whether `plan` may join `records`, decided before any write. */
function decideSave(records: readonly RelaunchPlanRecord[], plan: RelaunchPlanRecord): SaveDecision {
  const digests = new Set(records.map((record) => record.planDigest));
  if (digests.size !== records.length) return { kind: 'refused', reason: 'store-unreadable' };
  const expectedDigest = sha256Hex(canonicalRelaunchPlanBodyJson(plan));
  const stored = records.find((record) => record.planDigest === plan.planDigest);
  if (stored !== undefined) {
    if (
      stored.requestDigest !== plan.requestDigest ||
      canonicalRelaunchPlanBodyJson(stored) !== canonicalRelaunchPlanBodyJson(plan) ||
      expectedDigest !== plan.planDigest
    ) {
      return { kind: 'refused', reason: 'digest-conflict' };
    }
    return { kind: 'unchanged', stored };
  }
  if (expectedDigest !== plan.planDigest) return { kind: 'refused', reason: 'digest-mismatch' };
  if (records.length + 1 > MAX_STORED_PLANS) return { kind: 'refused', reason: 'store-limit-exceeded' };
  return { kind: 'append' };
}

export class RelaunchPlanRepositoryAdapter implements RelaunchPlanRepositoryPort {
  private readonly inMemoryPlans = new Map<string, RelaunchPlanRecord>();
  private readonly target: string | null;

  constructor(private readonly options?: RelaunchPlanRepositoryAdapterOptions) {
    const { stateDir, fileName } = options ?? {};
    if (fileName !== undefined) {
      if (OTHER_STORE_FILE_NAMES.includes(fileName)) {
        throw new Error('RelaunchPlanRepositoryAdapter refuses a fileName that collides with another store');
      }
      if (!SAFE_FILE_NAME.test(fileName) || fileName === '.' || fileName === '..') {
        throw new Error('RelaunchPlanRepositoryAdapter refuses unsafe state file name');
      }
    }
    this.target =
      stateDir === undefined || stateDir.trim().length === 0 ? null : path.join(stateDir, fileName ?? DEFAULT_FILE_NAME);
  }

  async save(plan: RelaunchPlanRecord): Promise<SaveRelaunchPlanResult> {
    try {
      if (this.options?.readOnly === true) return { outcome: 'refused', reason: 'store-read-only' };
      const read = readRelaunchPlanRecord(plan);
      if (read === null) return { outcome: 'refused', reason: 'invalid-plan' };
      const target = this.target;
      if (target === null) {
        // No await between the decision and the set: two racing saves cannot both pass.
        const decision = decideSave([...this.inMemoryPlans.values()], read);
        if (decision.kind === 'refused') return { outcome: 'refused', reason: decision.reason };
        if (decision.kind === 'unchanged') {
          return { outcome: 'unchanged', planDigest: decision.stored.planDigest, plan: deepCopy(decision.stored) };
        }
        this.inMemoryPlans.set(read.planDigest, deepCopy(read));
        return { outcome: 'saved', planDigest: read.planDigest, plan: read };
      }
      return await withFileLock(`${target}.lock`, async (): Promise<SaveRelaunchPlanResult> => {
        const current = await this.readFromDisk(target);
        if (current.status === 'unknown-version') return { outcome: 'refused', reason: 'store-unknown-version' };
        if (current.status === 'unreadable') return { outcome: 'refused', reason: 'store-unreadable' };
        const decision = decideSave(current.records, read);
        if (decision.kind === 'refused') return { outcome: 'refused', reason: decision.reason };
        if (decision.kind === 'unchanged') {
          return { outcome: 'unchanged', planDigest: decision.stored.planDigest, plan: decision.stored };
        }
        const next = [...current.records, read];
        if (Buffer.byteLength(`${JSON.stringify(next, null, 2)}\n`, 'utf8') > MAX_PLAN_STORE_BYTES) {
          return { outcome: 'refused', reason: 'store-limit-exceeded' };
        }
        await writeJsonAtomically(target, next);
        return { outcome: 'saved', planDigest: read.planDigest, plan: read };
      });
    } catch (error: unknown) {
      return { outcome: 'refused', reason: error instanceof StateFileUnknownVersionError ? 'store-unknown-version' : 'store-unreadable' };
    }
  }

  async findByDigest(planDigest: string): Promise<FindRelaunchPlanResult> {
    if (typeof planDigest !== 'string' || !SHA256_HEX.test(planDigest)) {
      return { outcome: 'refused', reason: 'invalid-digest' };
    }
    try {
      if (this.target === null) {
        const held = this.inMemoryPlans.get(planDigest);
        // A record whose body no longer hashes to its digest is corrupt: never handed out as found.
        return held === undefined || !digestMatches(held) ? { outcome: 'absent' } : { outcome: 'found', plan: deepCopy(held) };
      }
      const current = await this.readFromDisk(this.target);
      if (current.status === 'unknown-version') return { outcome: 'unreadable', reason: 'unknown-version' };
      if (current.status === 'unreadable') return { outcome: 'unreadable', reason: 'unreadable' };
      const found = current.records.find((record) => record.planDigest === planDigest);
      return found === undefined ? { outcome: 'absent' } : { outcome: 'found', plan: found };
    } catch {
      return { outcome: 'unreadable', reason: 'unreadable' };
    }
  }

  /** Bounded, read-only: a missing file is an empty store; anything else unreadable is reported, never quarantined or emptied. */
  private async readFromDisk(target: string): Promise<StoreRead> {
    let buffer: Buffer;
    try {
      const info = await fs.stat(target);
      if (!info.isFile() || info.size > MAX_PLAN_STORE_BYTES) return { status: 'unreadable' };
      buffer = await fs.readFile(target);
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') return { status: 'unreadable' };
      try {
        // A dangling link reads as missing through `stat`: it is not an empty store.
        await fs.lstat(target);
        return { status: 'unreadable' };
      } catch (lstatError: unknown) {
        return errorCode(lstatError) === 'ENOENT' ? { status: 'ok', records: [] } : { status: 'unreadable' };
      }
    }
    if (buffer.length > MAX_PLAN_STORE_BYTES) return { status: 'unreadable' };
    const inspection = inspectVersionedRecordListBytes(buffer, parseStoredPlan);
    if (inspection.status === 'unknown-version') return { status: 'unknown-version' };
    if (inspection.status === 'unreadable') return { status: 'unreadable' };
    if (inspection.records.length > MAX_STORED_PLANS) return { status: 'unreadable' };
    return { status: 'ok', records: [...inspection.records] };
  }
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'unknown';
}
