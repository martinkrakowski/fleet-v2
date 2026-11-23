/**
 * AR2a1y: pure validation of a stored relaunch plan record and of a recorded
 * runner host (cutover plan §4 step 2, D-CO10). The validator reads its input
 * through a guarded structural preflight (own property descriptors only, no
 * getter is ever invoked), snapshots the graph with `structuredClone`, then
 * validates the complete field sets of the plan, its conductor block, every
 * lane and every step, and finally — only after every field has been
 * validated — recomputes the plan digest over the canonical body. Pure: no
 * I/O, no clock, no `node:*` import, no import from `application/`, never
 * throws. Hostile objects, accessors, non-enumerable or symbol keys, sparse
 * or over-bound arrays, prototype-polluting keys and any inspection that
 * throws return a typed refusal. A transparent Proxy whose unused traps do
 * not throw and answer truthfully is indistinguishable from the data it
 * stands for and is not claimed to be detected.
 */

import { containsSecretShape } from '@fleet/shared';

import type { AttemptRunnerRecord, RunnerKind } from './execution-records.js';
import { parseSeatTool } from './execution-records.js';
import { parseBaseBranch } from './base-branch.js';
import { isZonedIsoDateTime } from './conductor-halt.js';
import {
  readBoundedDenseArray,
  readExactPlainRecord,
  readPlainRecordWithOptionalKeys,
} from './plain-record-reads.js';
import {
  MAX_RELAUNCH_APPLY_LANES,
  MAX_RELAUNCH_APPLY_STEPS,
  validateLaneStepOrder,
} from './relaunch-apply.js';
import { pureSha256Hex } from './held-work-order.js';

/**
 * The per-lane step codes and the plan populations, mirroring the relaunch
 * plan port (`RELAUNCH_STEP_CODES`, `RelaunchPlannedPopulation`) so this pure
 * domain module never imports from `application/`. The step order grammar
 * itself is delegated to `validateLaneStepOrder`, which owns D-CO10.
 */
const RELAUNCH_STEP_CODES = ['save', 'abort', 'adopt', 'redispatch'] as const;
type RelaunchStepCode = (typeof RELAUNCH_STEP_CODES)[number];
type RelaunchPlannedPopulation = 'conducted' | 'attempt-recorded' | 'unrecorded';

/**
 * The canonical plan body the stored `planDigest` hashes (the relaunch plan
 * port's `canonicalRelaunchPlanBodyJson`, rebuilt here so the domain stays
 * free of `application/` imports): fixed key order, `stepCodes` from the
 * steps, no digest, no creation time, no step keys. Any divergence from the
 * port's shape is caught by the pinned digest test.
 */
function canonicalPlanBodyJson(body: {
  readonly schemaVersion: 1;
  readonly hostFilter: string | null;
  readonly maxActiveRuns: number;
  readonly dispatchStaggerMs: number;
  readonly conductor: { readonly halted: boolean; readonly driverLease: string; readonly runCount: number };
  readonly lanes: readonly {
    readonly laneId: string;
    readonly hostName: string;
    readonly projectId: string | null;
    readonly population: string;
    readonly runnerState: string;
    readonly runId: string | null;
    readonly attemptId: string | null;
    readonly workOrderId: string | null;
    readonly baseBranch: string;
    readonly chainHead: boolean;
    readonly dependsOnLaneIds: readonly string[];
    readonly admissionWave: number;
    readonly dispatchEndpointKey: string | null;
    readonly staggerOffsetMs: number | null;
    readonly steps: readonly { readonly step: string }[];
  }[];
}): string {
  return JSON.stringify({
    schemaVersion: body.schemaVersion,
    hostFilter: body.hostFilter,
    maxActiveRuns: body.maxActiveRuns,
    dispatchStaggerMs: body.dispatchStaggerMs,
    conductor: {
      halted: body.conductor.halted,
      driverLease: body.conductor.driverLease,
      runCount: body.conductor.runCount,
    },
    lanes: body.lanes.map((lane) => ({
      laneId: lane.laneId,
      hostName: lane.hostName,
      projectId: lane.projectId,
      population: lane.population,
      runnerState: lane.runnerState,
      runId: lane.runId,
      attemptId: lane.attemptId,
      workOrderId: lane.workOrderId,
      baseBranch: lane.baseBranch,
      chainHead: lane.chainHead,
      dependsOnLaneIds: [...lane.dependsOnLaneIds],
      admissionWave: lane.admissionWave,
      dispatchEndpointKey: lane.dispatchEndpointKey,
      staggerOffsetMs: lane.staggerOffsetMs,
      stepCodes: lane.steps.map((step) => step.step),
    })),
  });
}

/** The cost bound of the preflight walk, in visited container nodes. */
const MAX_PREFLIGHT_NODES = 100_000;
/** The cost bound of the preflight walk, in nesting depth. */
const MAX_PREFLIGHT_DEPTH = 32;

/** Own keys that would pollute a plain record's prototype chain when copied. */
const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const HEX_64 = /^[0-9a-f]{64}$/;
const LANE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/; // eslint-disable-line no-control-regex -- the validator's job is refusing control characters, not matching text containing them

export type StoredRelaunchPlanValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'invalid-plan' };

export type RecordedHostValidation =
  | { readonly ok: true; readonly value: AttemptRunnerRecord | null }
  | { readonly ok: false; readonly reason: 'invalid-recorded-host' };

/** A non-blank string without control characters and with no secret shape. */
function isCleanString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim().length > 0 &&
    !CONTROL_CHARACTERS.test(value) &&
    !containsSecretShape(value)
  );
}

/** `null` or a clean string. */
function isNullableCleanString(value: unknown): boolean {
  return value === null || isCleanString(value);
}

/** A safe integer within an inclusive range. */
function isSafeIntegerWithin(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * The array caps the preflight applies by the key an array is reached
 * through: the plan's `lanes` and a lane's `dependsOnLaneIds` at the lane
 * bound, every other array at the step bound.
 */
const PLAN_ARRAY_CAPS: ReadonlyMap<string, number> = new Map([
  ['lanes', MAX_RELAUNCH_APPLY_LANES],
  ['dependsOnLaneIds', MAX_RELAUNCH_APPLY_LANES],
]);

/**
 * Guarded structural preflight of the source graph: every container is a
 * plain record or a dense, in-bound array; every own key is an enumerable
 * string data property outside the polluting names; every leaf is a JSON
 * primitive. Own property descriptors are the only read, so no getter is
 * invoked; any inspection that throws refuses. Arrays use the O(1) length
 * gate of `readBoundedDenseArray` under the cap their key demands, so an
 * over-bound length is refused before any per-index descriptor read.
 */
function preflightGraph(
  value: unknown,
  depth: number,
  budget: { nodes: number },
  arrayCap: number,
): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'undefined') {
    return true;
  }
  if (budget.nodes <= 0 || depth > MAX_PREFLIGHT_DEPTH) return false;
  budget.nodes -= 1;
  try {
    if (Array.isArray(value)) {
      const dense = readBoundedDenseArray(value, arrayCap);
      if (dense === null) return false;
      for (const element of dense.array) {
        if (!preflightGraph(element, depth + 1, budget, MAX_RELAUNCH_APPLY_STEPS)) return false;
      }
      return true;
    }
    if (type !== 'object') return false;
    const object = value as object;
    const prototype: unknown = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(object)) {
      if (typeof key !== 'string' || POLLUTING_KEYS.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !('value' in descriptor)
      ) {
        return false;
      }
      const childCap = PLAN_ARRAY_CAPS.get(key) ?? MAX_RELAUNCH_APPLY_STEPS;
      if (!preflightGraph(descriptor.value, depth + 1, budget, childCap)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** The typed refusal for a failed preflight or clone. */
const INVALID_PLAN: StoredRelaunchPlanValidation = { ok: false, reason: 'invalid-plan' };
const INVALID_RECORDED_HOST: RecordedHostValidation = { ok: false, reason: 'invalid-recorded-host' };

/**
 * Preflight, then `structuredClone`, then run `validate` over the snapshot.
 * The snapshot is a plain, getter-free deep copy, so the field validators
 * never touch the caller's graph again.
 */
function withSnapshot<T>(
  value: unknown,
  refusal: T,
  validate: (snapshot: unknown) => T,
): T {
  try {
    if (!preflightGraph(value, 0, { nodes: MAX_PREFLIGHT_NODES }, MAX_RELAUNCH_APPLY_LANES)) {
      return refusal;
    }
    return validate(structuredClone(value));
  } catch {
    return refusal;
  }
}

/** One validated planned step, as plain values. */
interface SnapshotStep {
  readonly step: RelaunchStepCode;
  readonly idempotencyKey: string;
}

/** One validated planned lane, as plain values. */
interface SnapshotLane {
  readonly laneId: string;
  readonly hostName: string;
  readonly projectId: string | null;
  readonly population: RelaunchPlannedPopulation;
  readonly runnerState: 'idle' | 'running';
  readonly runId: string | null;
  readonly attemptId: string | null;
  readonly workOrderId: string | null;
  readonly baseBranch: string;
  readonly chainHead: boolean;
  readonly dependsOnLaneIds: readonly string[];
  readonly admissionWave: number;
  readonly dispatchEndpointKey: string | null;
  readonly staggerOffsetMs: number | null;
  readonly steps: readonly SnapshotStep[];
}

/** Validate one planned step record's complete field set; null on any refusal. */
function readSnapshotStep(value: unknown, planDigest: string, laneId: string): SnapshotStep | null {
  const record = readExactPlainRecord(value, ['step', 'idempotencyKey']);
  if (record === null) return null;
  const step = record['step'];
  if (typeof step !== 'string' || !(RELAUNCH_STEP_CODES as readonly string[]).includes(step)) {
    return null;
  }
  const idempotencyKey = record['idempotencyKey'];
  if (idempotencyKey !== `relaunch/${planDigest}/${laneId}/${step}`) return null;
  return { step: step as RelaunchStepCode, idempotencyKey };
}

/** Validate one planned lane's complete field set; null on any refusal. */
function readSnapshotLane(value: unknown, planDigest: string): SnapshotLane | null {
  const record = readExactPlainRecord(value, [
    'laneId',
    'hostName',
    'projectId',
    'runId',
    'attemptId',
    'workOrderId',
    'population',
    'runnerState',
    'baseBranch',
    'chainHead',
    'dependsOnLaneIds',
    'admissionWave',
    'dispatchEndpointKey',
    'staggerOffsetMs',
    'steps',
  ]);
  if (record === null) return null;
  const laneId = record['laneId'];
  if (typeof laneId !== 'string' || !LANE_ID_PATTERN.test(laneId)) return null;
  if (!isCleanString(record['hostName'])) return null;
  if (!isNullableCleanString(record['projectId'])) return null;
  if (!isNullableCleanString(record['runId'])) return null;
  if (!isNullableCleanString(record['attemptId'])) return null;
  if (!isNullableCleanString(record['workOrderId'])) return null;
  const population = record['population'];
  if (
    population !== 'conducted' &&
    population !== 'attempt-recorded' &&
    population !== 'unrecorded'
  ) {
    return null;
  }
  const runnerState = record['runnerState'];
  if (runnerState !== 'idle' && runnerState !== 'running') return null;
  const baseBranch = record['baseBranch'];
  if (typeof baseBranch !== 'string' || parseBaseBranch(baseBranch) === undefined) return null;
  if (typeof record['chainHead'] !== 'boolean') return null;
  const dependencies = readBoundedDenseArray(record['dependsOnLaneIds'], MAX_RELAUNCH_APPLY_LANES);
  if (dependencies === null) return null;
  const dependsOnLaneIds: string[] = [];
  for (const dependency of dependencies.array) {
    if (typeof dependency !== 'string' || !LANE_ID_PATTERN.test(dependency)) return null;
    if (dependency === laneId || dependsOnLaneIds.includes(dependency)) return null;
    dependsOnLaneIds.push(dependency);
  }
  const admissionWave = record['admissionWave'] as number;
  if (!isSafeIntegerWithin(admissionWave, 0, Number.MAX_SAFE_INTEGER)) return null;
  const dispatchEndpointKey = record['dispatchEndpointKey'];
  if (!isNullableCleanString(dispatchEndpointKey)) return null;
  const staggerOffsetMs = record['staggerOffsetMs'];
  if (!isNullableSafeIntegerWithin(staggerOffsetMs)) return null;
  const steps = readBoundedDenseArray(record['steps'], MAX_RELAUNCH_APPLY_STEPS);
  if (steps === null) return null;
  const snapshotSteps: SnapshotStep[] = [];
  for (const stepValue of steps.array) {
    const step = readSnapshotStep(stepValue, planDigest, laneId);
    if (step === null) return null;
    snapshotSteps.push(step);
  }
  const hasRedispatch = snapshotSteps.some((step) => step.step === 'redispatch');
  if (population === 'conducted') {
    // A conducted run keeps running: no step, wave 0, no endpoint, no stagger.
    if (snapshotSteps.length !== 0) return null;
    if (admissionWave !== 0 || dispatchEndpointKey !== null || staggerOffsetMs !== null) return null;
  } else {
    if (!hasRedispatch) return null;
    if (admissionWave < 1) return null;
    if (dispatchEndpointKey === null || staggerOffsetMs === null) return null;
  }
  const stepCodes = snapshotSteps.map((step) => step.step);
  if (!validateLaneStepOrder(population, runnerState, stepCodes)) return null;
  return {
    laneId,
    hostName: record['hostName'] as string,
    projectId: record['projectId'] as string | null,
    population,
    runnerState,
    runId: record['runId'] as string | null,
    attemptId: record['attemptId'] as string | null,
    workOrderId: record['workOrderId'] as string | null,
    baseBranch,
    chainHead: record['chainHead'] as boolean,
    dependsOnLaneIds,
    admissionWave,
    dispatchEndpointKey: dispatchEndpointKey as string | null,
    staggerOffsetMs: staggerOffsetMs as number | null,
    steps: snapshotSteps,
  };
}

/** `null` or a safe integer `>= 0`. */
function isNullableSafeIntegerWithin(value: unknown): boolean {
  return value === null || isSafeIntegerWithin(value, 0, Number.MAX_SAFE_INTEGER);
}

/**
 * Validate a stored relaunch plan record: guarded preflight, `structuredClone`
 * snapshot, complete plan/conductor/lane/step field-set validation, then —
 * last — plan digest recomputation over the canonical body. `requestDigest`
 * is format-checked only; the canonical input for its own digest is not part
 * of the stored record.
 */
export function validateStoredRelaunchPlan(plan: unknown): StoredRelaunchPlanValidation {
  return withSnapshot(plan, INVALID_PLAN, (snapshot) => {
    const record = readExactPlainRecord(snapshot, [
      'schemaVersion',
      'planDigest',
      'requestDigest',
      'createdAtIso',
      'hostFilter',
      'maxActiveRuns',
      'dispatchStaggerMs',
      'conductor',
      'lanes',
    ]);
    if (record === null) return INVALID_PLAN;
    if (record['schemaVersion'] !== 1) return INVALID_PLAN;
    const planDigest = record['planDigest'];
    if (typeof planDigest !== 'string' || !HEX_64.test(planDigest)) return INVALID_PLAN;
    const requestDigest = record['requestDigest'];
    if (typeof requestDigest !== 'string' || !HEX_64.test(requestDigest)) return INVALID_PLAN;
    if (!isZonedIsoDateTime(record['createdAtIso'])) return INVALID_PLAN;
    const hostFilter = record['hostFilter'];
    if (hostFilter !== null) {
      if (!isCleanString(hostFilter) || (hostFilter as string).length > 4096) return INVALID_PLAN;
    }
    if (!isSafeIntegerWithin(record['maxActiveRuns'], 1, Number.MAX_SAFE_INTEGER)) return INVALID_PLAN;
    if (!isSafeIntegerWithin(record['dispatchStaggerMs'], 0, Number.MAX_SAFE_INTEGER)) return INVALID_PLAN;
    const conductorRecord = readExactPlainRecord(record['conductor'], [
      'halted',
      'driverLease',
      'runCount',
    ]);
    if (conductorRecord === null) return INVALID_PLAN;
    if (typeof conductorRecord['halted'] !== 'boolean') return INVALID_PLAN;
    const driverLease = conductorRecord['driverLease'];
    if (driverLease !== 'absent' && driverLease !== 'lapsed' && driverLease !== 'live') {
      return INVALID_PLAN;
    }
    if (!isSafeIntegerWithin(conductorRecord['runCount'], 0, Number.MAX_SAFE_INTEGER)) return INVALID_PLAN;
    const lanes = readBoundedDenseArray(record['lanes'], MAX_RELAUNCH_APPLY_LANES);
    if (lanes === null) return INVALID_PLAN;
    const snapshotLanes: SnapshotLane[] = [];
    const seenHostLane = new Set<string>();
    const laneIds = new Set<string>();
    for (const laneValue of lanes.array) {
      const lane = readSnapshotLane(laneValue, planDigest);
      if (lane === null) return INVALID_PLAN;
      if (seenHostLane.has(`${lane.hostName}\u0000${lane.laneId}`)) return INVALID_PLAN;
      seenHostLane.add(`${lane.hostName}\u0000${lane.laneId}`);
      if (laneIds.has(lane.laneId)) return INVALID_PLAN;
      laneIds.add(lane.laneId);
      snapshotLanes.push(lane);
    }
    for (const lane of snapshotLanes) {
      for (const dependency of lane.dependsOnLaneIds) {
        if (!laneIds.has(dependency)) return INVALID_PLAN;
      }
    }
    // Digest recomputation runs last, after every field set has validated.
    const digest = pureSha256Hex(
      canonicalPlanBodyJson({
        schemaVersion: 1,
        hostFilter: hostFilter as string | null,
        maxActiveRuns: record['maxActiveRuns'] as number,
        dispatchStaggerMs: record['dispatchStaggerMs'] as number,
        conductor: {
          halted: conductorRecord['halted'] as boolean,
          driverLease,
          runCount: conductorRecord['runCount'] as number,
        },
        lanes: snapshotLanes.map((lane) => ({
          laneId: lane.laneId,
          hostName: lane.hostName,
          projectId: lane.projectId,
          population: lane.population,
          runnerState: lane.runnerState,
          runId: lane.runId,
          attemptId: lane.attemptId,
          workOrderId: lane.workOrderId,
          baseBranch: lane.baseBranch,
          chainHead: lane.chainHead,
          dependsOnLaneIds: lane.dependsOnLaneIds,
          admissionWave: lane.admissionWave,
          dispatchEndpointKey: lane.dispatchEndpointKey,
          staggerOffsetMs: lane.staggerOffsetMs,
          steps: lane.steps.map((step) => ({ step: step.step })),
        })),
      }),
    );
    if (digest !== planDigest) return INVALID_PLAN;
    return { ok: true };
  });
}

/**
 * Validate a recorded runner host: `null` (no recorded host) or a plain data
 * object matching `AttemptRunnerRecord`, read through its own descriptors and
 * snapshotted before any use.
 */
export function validateRecordedHost(value: unknown): RecordedHostValidation {
  return withSnapshot(value, INVALID_RECORDED_HOST, (snapshot) => {
    if (snapshot === null) return { ok: true, value: null };
    const record = readPlainRecordWithOptionalKeys(
      snapshot,
      ['kind', 'remotePort', 'host', 'agent', 'model', 'variant'],
      ['hostName', 'useFreeSeats'],
    );
    if (record === null) return INVALID_RECORDED_HOST;
    const kind = parseSeatTool(record['kind']);
    if (kind === undefined) return INVALID_RECORDED_HOST;
    const remotePort = record['remotePort'];
    if (remotePort !== null && !isSafeIntegerWithin(remotePort, 1, 65535)) return INVALID_RECORDED_HOST;
    if (!isNullableCleanString(record['host'])) return INVALID_RECORDED_HOST;
    if (!isNullableCleanString(record['agent'])) return INVALID_RECORDED_HOST;
    if (!isNullableCleanString(record['model'])) return INVALID_RECORDED_HOST;
    if (!isNullableCleanString(record['variant'])) return INVALID_RECORDED_HOST;
    const hostName = record['hostName'];
    if (hostName !== undefined && !isNullableCleanString(hostName)) return INVALID_RECORDED_HOST;
    const useFreeSeats = record['useFreeSeats'];
    if (useFreeSeats !== undefined && typeof useFreeSeats !== 'boolean') return INVALID_RECORDED_HOST;
    const validated: AttemptRunnerRecord = {
      kind: kind as RunnerKind,
      remotePort: remotePort as number | null,
      host: record['host'] as string | null,
      agent: record['agent'] as string | null,
      model: record['model'] as string | null,
      variant: record['variant'] as string | null,
      ...(hostName === undefined ? {} : { hostName: hostName as string | null }),
      ...(useFreeSeats === undefined ? {} : { useFreeSeats: useFreeSeats as boolean }),
    };
    return { ok: true, value: validated };
  });
}
