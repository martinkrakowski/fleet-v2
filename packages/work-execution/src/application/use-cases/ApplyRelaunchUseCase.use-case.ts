// AR2b — ApplyRelaunchUseCase: request validation, trusted-clock budget
// checks, stored-plan digest verification, journal replay derivation, the
// dry-run summary and the live apply. An `apply: true` request runs one
// admission wave of `save`, `abort` and `redispatch` (intent-only; the
// conductor starts the fix) under
// `ActionAuthorizationPort.authorizeRelaunchApply`: preflight liveness, input
// and port checks run first so a failed preflight never consumes the owner
// grant, every journaled step is intent-before-action (I3, I7), and adopt
// still refuses `adopt-not-implemented` (AR2c owns it). `prepareFixAttempt`
// is never called here.
//
// `applyRelaunch` takes `unknown` and never throws. Results carry ids, codes,
// digests and statuses only: never a worktree path, a clone path, an
// exception message or a secret value. Untrusted objects are read through
// their own property descriptors, so no getter ever runs.

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';

import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import {
  readBoundedDenseArray,
  readPlainRecordWithOptionalKeys,
  snapshotPlainDataRecord,
} from '../../domain/plain-record-reads.js';
import {
  MAX_RELAUNCH_APPLY_ENTRIES,
  MAX_RELAUNCH_APPLY_LANES,
  canonicalSaveInputJson,
  decideProcessTreeTermination,
  deriveAdoptStepStatus,
  relaunchApplyLaneProgress,
  snapshotSaveInput,
  verifySaveIntentDigest,
  type RelaunchApplyStepStatus,
} from '../../domain/relaunch-apply.js';
import { relaunchStepStatus } from '../../domain/relaunch-step-ledger.js';
import { parseValidatedStoredRelaunchPlan } from '../../domain/relaunch-plan-validation.js';
import type {
  ApplyRelaunchLaneSummary,
  ApplyRelaunchPort,
  ApplyRelaunchResult,
  ApplyRelaunchSaveInput,
} from '../ports/in/ApplyRelaunchPort.in-port.js';
import type { SaveLaneEditsPort } from '../ports/in/SaveLaneEditsPort.in-port.js';
import type { ActionAuthorizationPort } from '../ports/out/ActionAuthorizationPort.out-port.js';
import type { CutoverJournalPort } from '../ports/out/CutoverJournalPort.out-port.js';
import type { ExecutionRunnerPort } from '../ports/out/ExecutionRunnerPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { ProcessTreeTerminationPort } from '../ports/out/ProcessTreeTerminationPort.out-port.js';
import {
  canonicalRelaunchPlanBodyJson,
  type RelaunchPlanRecord,
  type RelaunchPlanRepositoryPort,
  type RelaunchStepCode,
} from '../ports/out/RelaunchPlanRepositoryPort.out-port.js';

export interface ApplyRelaunchDependencies {
  readonly planRepo: Pick<RelaunchPlanRepositoryPort, 'findByDigest'>;
  /**
   * `append` is optional only for dry-run callers: an `apply: true` request
   * without it refuses `stale-plan-state` rather than writing nothing.
   */
  readonly cutoverJournal: Pick<CutoverJournalPort, 'listByKeyPrefix'> &
    Partial<Pick<CutoverJournalPort, 'append'>>;
  readonly computeDigest: (text: string) => string;
  /** The live apply's owner grant; required for `apply: true`. */
  readonly authorization?: Pick<ActionAuthorizationPort, 'authorizeRelaunchApply'>;
  /** The trusted clock for the deadline check; never `request.nowIso`. */
  readonly clock?: () => string;
  /** Live-apply ports; each missing one refuses `stale-plan-state`. */
  readonly saveLaneEdits?: Pick<SaveLaneEditsPort, 'saveLaneEdits'>['saveLaneEdits'];
  readonly runner?: Pick<ExecutionRunnerPort, 'inspectWorktreeRun' | 'abortWorktreeRun'>;
  readonly processTreeTermination?: Pick<ProcessTreeTerminationPort, 'terminateWorktreeProcesses'>;
  readonly runRepo?: Pick<LaneRunRepositoryPort, 'get'>;
  readonly mintEntryId?: () => string;
}

/** Every string the request carries is bounded; a longer one is unreadable. */
const MAX_TEXT_LENGTH = 4096;

const PLAN_DIGEST = /^[0-9a-f]{64}$/;

const SAVE_INPUT_REQUIRED_KEYS = [
  'laneId',
  'attemptId',
  'worktreePath',
  'clonePath',
  'recordedHost',
  'baseCommit',
  'allowedPathPrefixes',
] as const;
const SAVE_INPUT_OPTIONAL_KEYS = ['policyProtectedPaths'] as const;

const ABSENT = Symbol('absent');
const BAD = Symbol('bad');

/** The lane-id grammar of a save input, as the plan validator enforces it. */
const LANE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** An own data property of a plain object: ABSENT when missing, BAD for a getter, a setter or a non-plain object. */
function own(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return BAD;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return BAD;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return ABSENT;
  if (descriptor.get !== undefined || descriptor.set !== undefined || !('value' in descriptor)) return BAD;
  return descriptor.value;
}

function hasSecretShape(value: string): boolean {
  return (
    containsSecretShape(value) ||
    LANE_DIFF_SECRET_PATTERNS.some((entry) => new RegExp(entry.regex.source, entry.regex.flags.replace('g', '')).test(value))
  );
}

/** The bounded secret scan: nodes and depth are capped, so the cost is O(nodes). */
const MAX_SCAN_DEPTH = 4;
const MAX_SCAN_NODES = 256;

/**
 * Whether any reachable string value matches a secret shape. Values are read
 * through their own descriptors only; an accessor, a throwing inspection or
 * an over-deep or over-wide graph returns `null` (unreadable), never `false`.
 */
function scanForSecret(value: unknown, depth: number, budget: { nodes: number }): boolean | null {
  if (value === null) return false;
  if (typeof value === 'string') {
    // Cost bound: the length cap refuses an enormous string in O(1) before
    // any pattern scan runs.
    if (value.length > MAX_TEXT_LENGTH) return null;
    return hasSecretShape(value);
  }
  if (typeof value !== 'object') return false;
  if (depth >= MAX_SCAN_DEPTH) return null;
  if (Array.isArray(value)) {
    const dense = readBoundedDenseArray(value, MAX_RELAUNCH_APPLY_ENTRIES);
    if (dense === null) return null;
    for (const element of dense.array) {
      budget.nodes -= 1;
      if (budget.nodes < 0) return null;
      const found = scanForSecret(element, depth + 1, budget);
      if (found !== false) return found;
    }
    return false;
  }
  const snapshot = snapshotPlainDataRecord(value);
  if (snapshot === null) return null;
  for (const key of Object.keys(snapshot)) {
    budget.nodes -= 1;
    if (budget.nodes < 0) return null;
    const found = scanForSecret(snapshot[key], depth + 1, budget);
    if (found !== false) return found;
  }
  return false;
}

/**
 * The request's save inputs, keyed by `laneId` in a `Map` (`'__proto__'`,
 * `'.'` and `'..'` are valid lane ids, so a plain object would pollute or
 * collide). Each element is read exactly once through its own descriptors;
 * any hole, accessor, extra key, bad field or duplicate lane id is `null`.
 */
/** A non-empty, length-capped string field. */
function isBoundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH;
}

/** A dense, in-bound array of bounded strings, read through own descriptors. */
function isBoundedTextArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_RELAUNCH_APPLY_LANES) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return false;
    if (!isBoundedText(value[index])) return false;
  }
  return true;
}

function readSaveInputs(value: unknown): Map<string, ApplyRelaunchSaveInput> | 'secret-detected' | null {
  const dense = readBoundedDenseArray(value, MAX_RELAUNCH_APPLY_LANES);
  if (dense === null) return null;
  const map = new Map<string, ApplyRelaunchSaveInput>();
  for (const element of dense.array) {
    const fields = readPlainRecordWithOptionalKeys(element, SAVE_INPUT_REQUIRED_KEYS, SAVE_INPUT_OPTIONAL_KEYS);
    if (fields === null) return null;
    // Secret screening runs over every reachable string before any other
    // field check: a secret is reported as such, never echoed or stored; an
    // unreadable graph (accessor, over-wide, over-deep) is invalid-request.
    const secret = scanForSecret(element, 0, { nodes: MAX_SCAN_NODES });
    if (secret === true) return 'secret-detected';
    if (secret === null) return null;
    const laneId: unknown = fields['laneId'];
    const attemptId: unknown = fields['attemptId'];
    if (typeof laneId !== 'string' || !LANE_ID.test(laneId)) return null;
    // `attemptId` is never `null` and never empty: a lane without an attempt
    // is planned with no save input at all.
    if (typeof attemptId !== 'string' || attemptId === '') return null;
    // Every field's type is validated up front (AR2a2 carry-over): a bad
    // field refuses here even when no `save` intent ever consumes it, so a
    // hostile input can never ride along to a later wave.
    if (!isBoundedText(fields['worktreePath'])) return null;
    if (!isBoundedText(fields['clonePath'])) return null;
    if (!isBoundedText(fields['baseCommit'])) return null;
    if (!isBoundedTextArray(fields['allowedPathPrefixes'])) return null;
    const protectedPaths: unknown = fields['policyProtectedPaths'];
    if (protectedPaths !== undefined && !isBoundedTextArray(protectedPaths)) return null;
    // Deep validation plus snapshot in one step (fix-round items 1 and 2):
    // the domain reader validates `recordedHost` field-by-field against the
    // runner-record contract (a bare `{}` or any malformed host refuses here,
    // during request parsing, rather than after authorization) and returns a
    // detached plain snapshot, so the map never retains a caller-owned object
    // that a concurrent mutation could change between this parse and the
    // awaited plan/journal reads. Cost: one bounded descriptor read per
    // element, on top of the checks above.
    const snapshot = snapshotSaveInput(element);
    if (snapshot === null) return null;
    if (map.has(snapshot.laneId)) return null;
    map.set(snapshot.laneId, snapshot);
  }
  return map;
}

/**
 * One journal entry read exactly once through its own data descriptors, so no
 * getter ever runs on `key`, `kind`, `outcome` or `digest`. `null` when the
 * entry is not a plain record with an own enumerable string `key` and `kind`,
 * an optional string-or-null `outcome` and `digest`, and no accessor on any
 * own key.
 */
interface SnapshotEntry {
  readonly key: string;
  readonly kind: string;
  readonly outcome: undefined | string | null;
  readonly digest: undefined | string | null;
}

function snapshotJournalEntry(item: unknown): SnapshotEntry | null {
  if (item === null || typeof item !== 'object') return null;
  try {
    const prototype: unknown = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = new Map<PropertyKey, PropertyDescriptor>();
    for (const ownKey of Reflect.ownKeys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, ownKey);
      if (descriptor === undefined) return null;
      if (descriptor.enumerable !== true) return null;
      if (descriptor.get !== undefined || descriptor.set !== undefined || !('value' in descriptor)) return null;
      descriptors.set(ownKey, descriptor);
    }
    const keyDescriptor = descriptors.get('key');
    if (keyDescriptor === undefined || typeof keyDescriptor.value !== 'string') return null;
    const kindDescriptor = descriptors.get('kind');
    if (kindDescriptor === undefined || typeof kindDescriptor.value !== 'string') return null;
    const outcomeDescriptor = descriptors.get('outcome');
    const digestDescriptor = descriptors.get('digest');
    const outcome = outcomeDescriptor === undefined ? undefined : outcomeDescriptor.value;
    const digest = digestDescriptor === undefined ? undefined : digestDescriptor.value;
    if (outcome !== undefined && outcome !== null && typeof outcome !== 'string') return null;
    if (digest !== undefined && digest !== null && typeof digest !== 'string') return null;
    return { key: keyDescriptor.value, kind: kindDescriptor.value, outcome, digest };
  } catch {
    return null;
  }
}

/** One lane's per-step statuses and next action, derived from the snapshot only. */
interface LaneDerivation {
  readonly stepStatuses: readonly { readonly step: RelaunchStepCode; readonly status: RelaunchApplyStepStatus }[];
  readonly nextAction: ReturnType<typeof relaunchApplyLaneProgress>;
}

function deriveLane(
  snapshot: readonly SnapshotEntry[],
  planDigest: string,
  lane: {
    readonly laneId: string;
    readonly steps: readonly { readonly step: RelaunchStepCode; readonly idempotencyKey: string }[];
  },
): LaneDerivation {
  const stepStatuses: { step: RelaunchStepCode; status: RelaunchApplyStepStatus }[] = [];
  for (const step of lane.steps) {
    const status =
      step.step === 'adopt'
        ? deriveAdoptStepStatus(snapshot, planDigest, lane.laneId)
        : relaunchStepStatus(snapshot, step.idempotencyKey);
    stepStatuses.push({ step: step.step, status });
  }
  return { stepStatuses, nextAction: relaunchApplyLaneProgress(stepStatuses) };
}

type Step<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly result: ApplyRelaunchResult };

const refusal = (reason: Extract<ApplyRelaunchResult, { outcome: 'refused' }>['reason']): ApplyRelaunchResult => ({
  outcome: 'refused',
  reason,
});
const fail = <T>(reason: Extract<ApplyRelaunchResult, { outcome: 'refused' }>['reason']): Step<T> => ({
  ok: false,
  result: refusal(reason),
});
const pass = <T>(value: T): Step<T> => ({ ok: true, value });

/**
 * An untrusted envelope's named own fields, read through their own data
 * descriptors inside a try/catch. `null` when the value is not an object, an
 * inspection throws (a Proxy trap) or any named field is an accessor: no
 * getter ever runs.
 */
function readEnvelope(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object') return null;
  try {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      if (descriptor.get !== undefined || descriptor.set !== undefined || !('value' in descriptor)) return null;
      out[key] = descriptor.value;
    }
    return out;
  } catch {
    return null;
  }
}

interface ParsedRequest {
  readonly planDigest: string;
  readonly apply: boolean;
  readonly grantId: string | null;
  readonly deadlineMs: number | null;
  readonly saveInputs: Map<string, ApplyRelaunchSaveInput>;
}

function readPlanDigest(request: unknown): Step<string> {
  const value = own(request, 'planDigest');
  if (value === BAD || value === ABSENT || typeof value !== 'string') return fail('invalid-request');
  if (!PLAN_DIGEST.test(value)) return fail('invalid-plan-digest');
  return pass(value);
}

function readApply(request: unknown): Step<boolean> {
  const value = own(request, 'apply');
  if (value === BAD) return fail('invalid-request');
  const apply = value === ABSENT ? false : value;
  return typeof apply === 'boolean' ? pass(apply) : fail('invalid-request');
}

function readGrantId(request: unknown): Step<string | null> {
  const value = own(request, 'grantId');
  if (value === BAD) return fail('invalid-request');
  const grantId = value === ABSENT || value === null ? null : value;
  if (grantId === null) return pass(null);
  if (typeof grantId !== 'string') return fail('invalid-request');
  // The length cap runs before the regex: an enormous string never reaches
  // `hasSecretShape`, so the cost is O(1) before any scan (AR2a2 carry-over).
  if (grantId.length > MAX_TEXT_LENGTH) return fail('invalid-request');
  return hasSecretShape(grantId) ? fail('secret-detected') : pass(grantId);
}

function readDeadlineMs(request: unknown): Step<number | null> {
  const nowValue = own(request, 'nowIso');
  if (nowValue === ABSENT || nowValue === BAD) return fail('invalid-request');
  if (!isZonedIsoDateTime(nowValue)) return fail('invalid-clock');
  const deadlineValue = own(request, 'deadlineIso');
  if (deadlineValue === BAD) return fail('invalid-request');
  if (deadlineValue === ABSENT || deadlineValue === null) return pass(null);
  if (!isZonedIsoDateTime(deadlineValue)) return fail('invalid-clock');
  return pass(Date.parse(deadlineValue));
}

function readSaveInputsField(request: unknown): Step<Map<string, ApplyRelaunchSaveInput>> {
  const value = own(request, 'saveInputs');
  if (value === BAD) return fail('invalid-request');
  if (value === ABSENT) return pass(new Map<string, ApplyRelaunchSaveInput>());
  const inputs = readSaveInputs(value);
  if (inputs === 'secret-detected') return fail('secret-detected');
  return inputs === null ? fail('invalid-request') : pass(inputs);
}

const KNOWN_REQUEST_KEYS: readonly string[] = ['planDigest', 'apply', 'grantId', 'nowIso', 'deadlineIso', 'saveInputs'];

/** Every other own value of the request gets the same secret scan and length cap. */
function scanUnknownRequestKeys(request: unknown): ApplyRelaunchResult | null {
  const snapshot = snapshotPlainDataRecord(request);
  if (snapshot === null) return refusal('invalid-request');
  const budget = { nodes: MAX_SCAN_NODES };
  for (const key of Object.keys(snapshot)) {
    if (KNOWN_REQUEST_KEYS.includes(key)) continue;
    const found = scanForSecret(snapshot[key], 1, budget);
    if (found === true) return refusal('secret-detected');
    if (found === null) return refusal('invalid-request');
  }
  return null;
}

function parseRequestFields(request: unknown): Step<ParsedRequest> {
  const planDigest = readPlanDigest(request);
  if (!planDigest.ok) return planDigest;
  const apply = readApply(request);
  if (!apply.ok) return apply;
  const grantId = readGrantId(request);
  if (!grantId.ok) return grantId;
  const deadlineMs = readDeadlineMs(request);
  if (!deadlineMs.ok) return deadlineMs;
  const saveInputs = readSaveInputsField(request);
  if (!saveInputs.ok) return saveInputs;
  const unknownKeys = scanUnknownRequestKeys(request);
  if (unknownKeys !== null) return { ok: false, result: unknownKeys };
  return pass({
    planDigest: planDigest.value,
    apply: apply.value,
    grantId: grantId.value,
    deadlineMs: deadlineMs.value,
    saveInputs: saveInputs.value,
  });
}

/** The whole parse is guarded: a throwing Proxy trap is an invalid request, never a rejection. */
function parseRequest(request: unknown): Step<ParsedRequest> {
  try {
    return parseRequestFields(request);
  } catch {
    return fail('invalid-request');
  }
}

/**
 * The trusted clock reading: a throwing or malformed reading returns `null`,
 * never `request.nowIso`.
 */
function trustedNowIso(deps: ApplyRelaunchDependencies): string | null {
  try {
    const nowText: unknown = deps.clock !== undefined ? deps.clock() : new Date().toISOString();
    if (typeof nowText !== 'string') return null;
    if (!isZonedIsoDateTime(nowText) || Number.isNaN(Date.parse(nowText))) return null;
    return nowText;
  } catch {
    return null;
  }
}

/** The trusted clock: a throwing or malformed reading, or a passed deadline, is an exhausted budget. */
function withinBudget(deps: ApplyRelaunchDependencies, deadlineMs: number | null): boolean {
  const nowText = trustedNowIso(deps);
  if (nowText === null) return false;
  return deadlineMs === null || Date.parse(nowText) < deadlineMs;
}

function planFromEnvelope(found: unknown): Step<unknown> {
  const record = readEnvelope(found, ['outcome', 'reason', 'plan']);
  if (record === null) return fail('plan-unreadable');
  if (record['outcome'] === 'found') return pass(record['plan']);
  if (record['outcome'] === 'absent') return fail('plan-not-found');
  if (record['outcome'] === 'unreadable' && record['reason'] === 'unknown-version') {
    return fail('plan-unknown-version');
  }
  if (record['outcome'] === 'refused' && record['reason'] === 'invalid-digest') return fail('invalid-plan-digest');
  return fail('plan-unreadable');
}

async function loadVerifiedPlan(
  deps: ApplyRelaunchDependencies,
  planDigest: string,
): Promise<Step<RelaunchPlanRecord>> {
  let found: unknown;
  try {
    found = await deps.planRepo.findByDigest(planDigest);
  } catch {
    return fail('plan-unreadable');
  }
  const planStep = planFromEnvelope(found);
  if (!planStep.ok) return planStep;
  // Only the validated `structuredClone` snapshot is used from here on
  // (AR2a2 carry-over): the original store object is never read again after
  // this `await`, so a later mutation of it cannot change what this apply
  // executes.
  const parsed = parseValidatedStoredRelaunchPlan(planStep.value);
  if (!parsed.ok) return fail('invalid-plan');
  const storedPlan = parsed.plan as unknown as RelaunchPlanRecord;
  let computedDigest: unknown;
  try {
    computedDigest = deps.computeDigest(canonicalRelaunchPlanBodyJson(storedPlan));
  } catch {
    return fail('plan-unreadable');
  }
  if (computedDigest !== storedPlan.planDigest || computedDigest !== planDigest) {
    return fail('plan-digest-mismatch');
  }
  return pass(storedPlan);
}

async function loadJournalSnapshot(
  deps: ApplyRelaunchDependencies,
  planDigest: string,
): Promise<Step<SnapshotEntry[]>> {
  let listing: unknown;
  try {
    listing = await deps.cutoverJournal.listByKeyPrefix(`relaunch/${planDigest}/`);
  } catch {
    return fail('journal-unreadable');
  }
  const envelope = readEnvelope(listing, ['outcome', 'entries']);
  if (envelope === null || envelope['outcome'] !== 'listed') return fail('journal-unreadable');
  const dense = readBoundedDenseArray(envelope['entries'], MAX_RELAUNCH_APPLY_ENTRIES);
  if (dense === null) return fail('journal-unreadable');
  const snapshot: SnapshotEntry[] = [];
  for (const item of dense.array) {
    const entry = snapshotJournalEntry(item);
    if (entry === null) return fail('journal-unreadable');
    snapshot.push(entry);
  }
  return pass(snapshot);
}

type PlanLane = RelaunchPlanRecord['lanes'][number];

/** A lane's save intent must still match the re-supplied save input; a refusal otherwise. */
function verifyLaneSaveInput(
  deps: ApplyRelaunchDependencies,
  planDigest: string,
  lane: PlanLane,
  snapshot: readonly SnapshotEntry[],
  saveInputs: ReadonlyMap<string, ApplyRelaunchSaveInput>,
): ApplyRelaunchResult | null {
  for (const step of lane.steps) {
    if (step.step !== 'save') continue;
    const intent = snapshot.find((entry) => entry.key === step.idempotencyKey && entry.kind === 'intent');
    const saveInput = saveInputs.get(lane.laneId);
    if (intent === undefined || saveInput === undefined) continue;
    const canonicalJson = canonicalSaveInputJson(planDigest, saveInput);
    if (canonicalJson === null) return refusal('invalid-request');
    let currentDigest: unknown;
    try {
      currentDigest = deps.computeDigest(canonicalJson);
    } catch {
      return refusal('journal-unreadable');
    }
    if (verifySaveIntentDigest(intent.digest, currentDigest) === 'mismatch') {
      return { outcome: 'refused', reason: 'save-input-digest-mismatch', laneId: lane.laneId };
    }
  }
  return null;
}

function stoppedRefusal(nextAction: LaneDerivation['nextAction'], laneId: string): ApplyRelaunchResult | null {
  if (nextAction.kind !== 'stopped') return null;
  if (nextAction.reason === 'out-of-order') return { outcome: 'refused', reason: 'out-of-order', laneId };
  if (nextAction.reason === 'inconsistent' || nextAction.reason === 'invalid-steps') {
    return { outcome: 'refused', reason: 'step-inconsistent', laneId };
  }
  return null;
}

interface DerivedLanes {
  readonly summaries: ApplyRelaunchLaneSummary[];
  /** Per-lane derivations keyed by lane id, for the live wave executor. */
  readonly derivations: Map<string, LaneDerivation>;
}

function deriveLaneSummaries(
  deps: ApplyRelaunchDependencies,
  planDigest: string,
  storedPlan: RelaunchPlanRecord,
  snapshot: readonly SnapshotEntry[],
  saveInputs: ReadonlyMap<string, ApplyRelaunchSaveInput>,
): Step<DerivedLanes> {
  const lanes: ApplyRelaunchLaneSummary[] = [];
  const derivations = new Map<string, LaneDerivation>();
  for (const lane of storedPlan.lanes) {
    const saveRefusal = verifyLaneSaveInput(deps, planDigest, lane, snapshot, saveInputs);
    if (saveRefusal !== null) return { ok: false, result: saveRefusal };
    const derivation = deriveLane(snapshot, planDigest, lane);
    const stopped = stoppedRefusal(derivation.nextAction, lane.laneId);
    if (stopped !== null) return { ok: false, result: stopped };
    derivations.set(lane.laneId, derivation);
    lanes.push({
      laneId: lane.laneId,
      population: lane.population,
      stepStatuses: derivation.stepStatuses,
      nextAction: derivation.nextAction,
    });
  }
  return pass({ summaries: lanes, derivations });
}

/** The grant refusal codes a `blocked` authorization result may report. */
const KNOWN_GRANT_REASONS: ReadonlySet<string> = new Set([
  'grant-missing',
  'grant-expired',
  'grant-revoked',
  'grant-wrong-scope',
  'grant-wrong-project',
  'grant-digest-mismatch',
  'grant-not-approved',
  'grant-id-mismatch',
]);

const refusedLane = (
  reason: Extract<ApplyRelaunchResult, { outcome: 'refused' }>['reason'],
  laneId: string,
): ApplyRelaunchResult => ({ outcome: 'refused', reason, laneId });

/** The `state` kind of a `WorktreeRunState`, read through its own descriptor. */
function readWorktreeStateKind(state: unknown): 'idle' | 'running' | 'unknown' | null {
  const kind = own(state, 'state');
  if (kind === BAD || kind === ABSENT) return null;
  return kind === 'idle' || kind === 'running' || kind === 'unknown' ? kind : null;
}

interface LiveApplyArgs {
  readonly deps: ApplyRelaunchDependencies;
  readonly planDigest: string;
  readonly grantId: string;
  readonly deadlineMs: number | null;
  readonly saveInputs: ReadonlyMap<string, ApplyRelaunchSaveInput>;
  readonly storedPlan: RelaunchPlanRecord;
}

/**
 * AR2b: the live apply. One wave per invocation, `save`, `abort` and
 * `redispatch` (intent-only), under the owner grant. All liveness, input and
 * port checks run before `authorizeRelaunchApply`, so a failed preflight
 * never consumes the grant and a replay with the same `grantId`
 * re-authorizes cleanly. Never calls `prepareFixAttempt`: the conductor
 * starts the fix from the journaled intent.
 */
async function applyLive(args: LiveApplyArgs): Promise<ApplyRelaunchResult> {
  const { deps, planDigest, grantId, deadlineMs, saveInputs, storedPlan } = args;

  // ---- Pre-authorization liveness, input and port checks ----
  if (!withinBudget(deps, deadlineMs)) return refusal('budget-exhausted');
  const snapshotStep = await loadJournalSnapshot(deps, planDigest);
  if (!snapshotStep.ok) return snapshotStep.result;
  const derived = deriveLaneSummaries(deps, planDigest, storedPlan, snapshotStep.value, saveInputs);
  if (!derived.ok) return derived.result;

  const statusOf = (laneId: string, step: RelaunchStepCode): RelaunchApplyStepStatus =>
    derived.value.derivations.get(laneId)?.stepStatuses.find((entry) => entry.step === step)?.status ?? 'absent';

  // Every live port the wave may need must exist before the grant is spent.
  if (
    typeof deps.runRepo?.get !== 'function' ||
    typeof deps.runner?.inspectWorktreeRun !== 'function' ||
    typeof deps.runner?.abortWorktreeRun !== 'function' ||
    typeof deps.processTreeTermination?.terminateWorktreeProcesses !== 'function' ||
    typeof deps.saveLaneEdits !== 'function' ||
    typeof deps.cutoverJournal?.append !== 'function' ||
    typeof deps.mintEntryId !== 'function'
  ) {
    return refusal('stale-plan-state');
  }

  const runner = deps.runner;
  let liveConductedRuns = 0;
  let handedOffNotIdle = 0;
  /**
   * Lanes whose worktree the preflight observed as `running`. For these,
   * `saveLaneEdits` runs after the abort (the save would refuse
   * `worktree-busy` while a runner session is live in the tree, which would
   * stop the lane at save-failed and never reach abort). Aborting the runner
   * session never touches worktree contents, so the post-abort save still
   * captures the edits before the lane is redispatched.
   */
  const runningLanes = new Set<string>();
  for (const lane of storedPlan.lanes) {
    if (lane.population === 'conducted') {
      if (lane.runId === null) return refusedLane('stale-plan-state', lane.laneId);
      let run: unknown;
      try {
        run = await deps.runRepo.get(lane.runId);
      } catch {
        return refusedLane('stale-plan-state', lane.laneId);
      }
      if (run !== null) liveConductedRuns += 1;
      continue;
    }
    const saveInput = saveInputs.get(lane.laneId);
    if (saveInput === undefined) return refusedLane('stale-plan-state', lane.laneId);
    let state: unknown;
    try {
      state = await runner.inspectWorktreeRun!({
        attemptId: saveInput.attemptId,
        worktreePath: saveInput.worktreePath,
        runner: saveInput.recordedHost,
      });
    } catch {
      return refusedLane('stale-plan-state', lane.laneId);
    }
    const stateKind = readWorktreeStateKind(state);
    if (stateKind === null || stateKind === 'unknown') {
      return refusedLane('stale-plan-state', lane.laneId);
    }
    if (stateKind === 'running') runningLanes.add(lane.laneId);
    const redispatchStatus = statusOf(lane.laneId, 'redispatch');
    if (
      lane.runnerState === 'idle' &&
      redispatchStatus === 'absent' &&
      statusOf(lane.laneId, 'save') !== 'completed' &&
      stateKind === 'running'
    ) {
      return refusedLane('unexpected-running-lane', lane.laneId);
    }
    if ((redispatchStatus === 'intent-only' || redispatchStatus === 'completed') && stateKind === 'running') {
      handedOffNotIdle += 1;
    }
  }

  // ---- Authorize ----
  if (!withinBudget(deps, deadlineMs)) return refusal('budget-exhausted');
  if (typeof deps.authorization?.authorizeRelaunchApply !== 'function') {
    return refusal('authorization-unavailable');
  }
  const nowIso = trustedNowIso(deps);
  if (nowIso === null) return refusal('authorization-unavailable');
  let grant: unknown;
  try {
    grant = await deps.authorization.authorizeRelaunchApply({ planDigest, grantId, nowIso });
  } catch {
    return refusal('authorization-unavailable');
  }
  const grantOutcome = own(grant, 'outcome');
  if (typeof grantOutcome !== 'string') return refusal('authorization-unavailable');
  if (grantOutcome === 'unknown') return refusal('authorization-unavailable');
  if (grantOutcome === 'blocked') {
    const reason = own(grant, 'reason');
    if (typeof reason === 'string' && KNOWN_GRANT_REASONS.has(reason)) {
      // Every code in `KNOWN_GRANT_REASONS` is a member of the refusal union.
      return refusal(reason as Parameters<typeof refusal>[0]);
    }
    return refusal('authorization-unavailable');
  }
  if (grantOutcome !== 'authorized') return refusal('authorization-unavailable');
  if (own(grant, 'grantId') !== grantId) return refusal('grant-id-mismatch');

  // ---- Select one wave ----
  let targetWave: number | null = null;
  for (const lane of storedPlan.lanes) {
    if (lane.population === 'conducted') continue;
    const redispatchStatus = statusOf(lane.laneId, 'redispatch');
    if (redispatchStatus === 'intent-only' || redispatchStatus === 'completed') continue;
    if (targetWave === null || lane.admissionWave < targetWave) targetWave = lane.admissionWave;
  }
  if (targetWave === null) {
    return { outcome: 'applied', planDigest, wave: null, lanes: derived.value.summaries };
  }

  /** Journal one entry; any non-`appended` result or throw is a write failure. */
  const appendEntry = async (request: {
    readonly key: string;
    readonly kind: 'intent' | 'result';
    readonly digest?: string;
    readonly outcome?: 'completed' | 'refused';
    readonly reasonCode?: string;
  }): Promise<boolean> => {
    try {
      const appended = await deps.cutoverJournal.append!({
        key: request.key,
        kind: request.kind,
        entryId: deps.mintEntryId!(),
        recordedAtIso: nowIso,
        ...(request.digest !== undefined ? { digest: request.digest } : {}),
        ...(request.outcome !== undefined
          ? { outcome: request.outcome, reasonCode: request.reasonCode ?? null }
          : {}),
      });
      return own(appended, 'outcome') === 'appended';
    } catch {
      return false;
    }
  };

  /** `saveLaneEdits`; only `saved` or `already-saved` counts as success. */
  const saveOk = async (laneId: string, saveInput: ApplyRelaunchSaveInput): Promise<boolean> => {
    try {
      const result = await deps.saveLaneEdits!({
        planDigest,
        laneId,
        attemptId: saveInput.attemptId,
        worktreePath: saveInput.worktreePath,
        clonePath: saveInput.clonePath,
        recordedHost: saveInput.recordedHost,
        baseCommit: saveInput.baseCommit,
        allowedPathPrefixes: saveInput.allowedPathPrefixes,
        ...(saveInput.policyProtectedPaths === undefined
          ? {}
          : { policyProtectedPaths: saveInput.policyProtectedPaths }),
        nowIso,
      });
      const outcome = own(result, 'outcome');
      return outcome === 'saved' || outcome === 'already-saved';
    } catch {
      return false;
    }
  };

  // ---- Execute the wave, lane by lane, step by step ----
  for (const lane of storedPlan.lanes) {
    if (lane.population === 'conducted' || lane.admissionWave !== targetWave) continue;
    // The preflight proved this exists for every non-conducted lane.
    const saveInput = saveInputs.get(lane.laneId) as ApplyRelaunchSaveInput;

    // save (I2: save before abort) and abort (I3: intent before action,
    // termination only without a confirmed result). A lane the preflight saw
    // running runs the abort first and the save after it: `saveLaneEdits`
    // refuses a busy worktree, so a save-first order would stop every running
    // lane at save-failed before its abort. Aborting the runner session never
    // touches worktree contents, so the post-abort save still captures the
    // edits before the lane is redispatched; a content-refused save still
    // stops the lane before redispatch.
    const saveWave = async (): Promise<ApplyRelaunchResult | null> => {
      if (!withinBudget(deps, deadlineMs)) return refusal('budget-exhausted');
      const saveStep = lane.steps.find((entry) => entry.step === 'save');
      const saveStatus = statusOf(lane.laneId, 'save');
      if (saveStep === undefined || saveStatus === 'completed') return null;
      if (saveStatus === 'inconsistent') return refusedLane('step-inconsistent', lane.laneId);
      if (saveStatus === 'refused' || saveStatus === 'ambiguous') {
        return refusedLane('save-failed', lane.laneId);
      }
      if (saveStatus === 'absent') {
        const canonicalJson = canonicalSaveInputJson(planDigest, saveInput);
        if (canonicalJson === null) return refusal('invalid-request');
        let saveInputDigest: string;
        try {
          saveInputDigest = deps.computeDigest(canonicalJson);
        } catch {
          return refusal('invalid-request');
        }
        if (!(await appendEntry({ key: saveStep.idempotencyKey, kind: 'intent', digest: saveInputDigest }))) {
          return refusedLane('journal-write-failed', lane.laneId);
        }
        if (!(await saveOk(lane.laneId, saveInput))) return refusedLane('save-failed', lane.laneId);
      } else {
        // 'intent-only': `verifyLaneSaveInput` already proved the digest
        // matches; `saveLaneEdits` recovers an intent-only save.
        if (!(await saveOk(lane.laneId, saveInput))) return refusedLane('save-failed', lane.laneId);
      }
      return null;
    };

    const abortWave = async (): Promise<ApplyRelaunchResult | null> => {
      const abortStep = lane.steps.find((entry) => entry.step === 'abort');
      if (abortStep === undefined) return null;
      if (!withinBudget(deps, deadlineMs)) return refusal('budget-exhausted');
      const abortStatus = statusOf(lane.laneId, 'abort');
      if (abortStatus === 'refused' || abortStatus === 'inconsistent') {
        return refusedLane('abort-failed', lane.laneId);
      }
      if (abortStatus === 'intent-only' || abortStatus === 'ambiguous') {
        // Reconcile read-only; never re-call `abortWorktreeRun` (I7).
        let state: unknown;
        try {
          state = await runner.inspectWorktreeRun!({
            attemptId: saveInput.attemptId,
            worktreePath: saveInput.worktreePath,
            runner: saveInput.recordedHost,
          });
        } catch {
          return refusedLane('abort-failed', lane.laneId);
        }
        const stateKind = readWorktreeStateKind(state);
        if (stateKind !== 'idle') return refusedLane('abort-failed', lane.laneId);
        if (
          !(await appendEntry({
            key: abortStep.idempotencyKey,
            kind: 'result',
            outcome: 'completed',
            reasonCode: 'reconciled-idle',
          }))
        ) {
          return refusedLane('journal-write-failed', lane.laneId);
        }
      } else if (abortStatus === 'absent') {
        if (!(await appendEntry({ key: abortStep.idempotencyKey, kind: 'intent' }))) {
          return refusedLane('journal-write-failed', lane.laneId);
        }
        let threw = false;
        let abortOutcome: unknown;
        try {
          abortOutcome = await runner.abortWorktreeRun!({
            attemptId: saveInput.attemptId,
            worktreePath: saveInput.worktreePath,
            runner: saveInput.recordedHost,
            gracePeriodSeconds: 30,
          });
        } catch {
          threw = true;
        }
        const decision = decideProcessTreeTermination(
          threw ? { kind: 'threw' } : { kind: 'result', outcome: own(abortOutcome, 'outcome') },
        );
        if (decision.action === 'refuse') return refusedLane('abort-failed', lane.laneId);
        if (decision.action === 'none') {
          if (
            !(await appendEntry({
              key: abortStep.idempotencyKey,
              kind: 'result',
              outcome: 'completed',
              reasonCode: 'aborted',
            }))
          ) {
            return refusedLane('journal-write-failed', lane.laneId);
          }
        } else {
          if (!withinBudget(deps, deadlineMs)) return refusal('budget-exhausted');
          let termination: unknown;
          try {
            termination = await deps.processTreeTermination!.terminateWorktreeProcesses({
              attemptId: saveInput.attemptId,
              worktreePath: saveInput.worktreePath,
              runner: saveInput.recordedHost,
              gracePeriodSeconds: 30,
            });
          } catch {
            termination = null;
          }
          const terminated = own(termination, 'outcome') === 'terminated';
          if (
            !(await appendEntry({
              key: abortStep.idempotencyKey,
              kind: 'result',
              outcome: terminated ? 'completed' : 'refused',
              reasonCode: terminated ? 'terminated' : 'terminate-failed',
            }))
          ) {
            return refusedLane('journal-write-failed', lane.laneId);
          }
          if (!terminated) return refusedLane('abort-failed', lane.laneId);
        }
      }
      return null;
    };

    // A running lane aborts before its save; an idle lane saves before its
    // abort (I2 for an idle tree, where `saveLaneEdits` can actually run).
    const laneOrder = runningLanes.has(lane.laneId) ? [abortWave, saveWave] : [saveWave, abortWave];
    for (const wave of laneOrder) {
      const refused = await wave();
      if (refused !== null) return refused;
    }

    // adopt: AR2c owns it; anything not already completed refuses here.
    if (lane.steps.some((entry) => entry.step === 'adopt')) {
      if (!withinBudget(deps, deadlineMs)) return refusal('budget-exhausted');
      if (statusOf(lane.laneId, 'adopt') !== 'completed') {
        return refusedLane('adopt-not-implemented', lane.laneId);
      }
    }

    // redispatch: the intent only; the conductor starts the fix from it.
    if (!withinBudget(deps, deadlineMs)) return refusal('budget-exhausted');
    const redispatchStatus = statusOf(lane.laneId, 'redispatch');
    if (redispatchStatus !== 'intent-only' && redispatchStatus !== 'completed') {
      if (liveConductedRuns + handedOffNotIdle >= storedPlan.maxActiveRuns) {
        return refusedLane('active-run-cap-reached', lane.laneId);
      }
      const redispatchStep = lane.steps.find((entry) => entry.step === 'redispatch');
      if (redispatchStep === undefined) return refusedLane('step-inconsistent', lane.laneId);
      if (!(await appendEntry({ key: redispatchStep.idempotencyKey, kind: 'intent' }))) {
        return refusedLane('journal-write-failed', lane.laneId);
      }
      handedOffNotIdle += 1;
    }
  }

  // Re-derive the summaries from the updated journal state.
  const fresh = await loadJournalSnapshot(deps, planDigest);
  if (!fresh.ok) return fresh.result;
  const updated = deriveLaneSummaries(deps, planDigest, storedPlan, fresh.value, saveInputs);
  if (!updated.ok) return updated.result;
  return { outcome: 'applied', planDigest, wave: targetWave, lanes: updated.value.summaries };
}

export class ApplyRelaunchUseCase implements ApplyRelaunchPort {
  constructor(private readonly deps?: ApplyRelaunchDependencies) {}

  async execute(input: unknown): Promise<ApplyRelaunchResult> {
    return this.applyRelaunch(input);
  }

  async applyRelaunch(request: unknown): Promise<ApplyRelaunchResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ApplyRelaunchUseCase');
    }
    const deps = this.deps;

    const parsed = parseRequest(request);
    if (!parsed.ok) return parsed.result;
    const { planDigest, apply, grantId, deadlineMs, saveInputs } = parsed.value;

    if (!withinBudget(deps, deadlineMs)) return refusal('budget-exhausted');

    const planStep = await loadVerifiedPlan(deps, planDigest);
    if (!planStep.ok) return planStep.result;

    // AR2b: the live apply runs one wave under the owner grant; adopt is
    // still AR2c's and refuses `adopt-not-implemented`.
    if (apply) {
      if (typeof grantId !== 'string' || grantId.trim() === '') return refusal('grant-missing');
      return applyLive({
        deps,
        planDigest,
        grantId,
        deadlineMs,
        saveInputs,
        storedPlan: planStep.value,
      });
    }

    if (!withinBudget(deps, deadlineMs)) return refusal('budget-exhausted');
    const snapshotStep = await loadJournalSnapshot(deps, planDigest);
    if (!snapshotStep.ok) return snapshotStep.result;

    const lanes = deriveLaneSummaries(deps, planDigest, planStep.value, snapshotStep.value, saveInputs);
    if (!lanes.ok) return lanes.result;
    return { outcome: 'dry-run', planDigest, lanes: lanes.value.summaries };
  }
}
