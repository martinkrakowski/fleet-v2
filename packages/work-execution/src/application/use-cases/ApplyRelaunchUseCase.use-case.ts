// AR2a2 — ApplyRelaunchUseCase: request validation, trusted-clock budget
// checks, stored-plan digest verification, journal replay derivation and the
// dry-run summary. The live apply (authorization, save, abort, adopt,
// redispatch) belongs to AR2b: an `apply: true` request is refused with
// `grant-missing` or `live-apply-not-implemented`, and
// `ActionAuthorizationPort.authorizeRelaunchApply` is never called here.
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
  deriveAdoptStepStatus,
  relaunchApplyLaneProgress,
  verifySaveIntentDigest,
  type RelaunchApplyStepStatus,
} from '../../domain/relaunch-apply.js';
import { relaunchStepStatus } from '../../domain/relaunch-step-ledger.js';
import { validateStoredRelaunchPlan } from '../../domain/relaunch-plan-validation.js';
import type {
  ApplyRelaunchLaneSummary,
  ApplyRelaunchPort,
  ApplyRelaunchResult,
  ApplyRelaunchSaveInput,
} from '../ports/in/ApplyRelaunchPort.in-port.js';
import type { ActionAuthorizationPort } from '../ports/out/ActionAuthorizationPort.out-port.js';
import type { CutoverJournalPort } from '../ports/out/CutoverJournalPort.out-port.js';
import {
  canonicalRelaunchPlanBodyJson,
  type RelaunchPlanRecord,
  type RelaunchPlanRepositoryPort,
  type RelaunchStepCode,
} from '../ports/out/RelaunchPlanRepositoryPort.out-port.js';

export interface ApplyRelaunchDependencies {
  readonly planRepo: Pick<RelaunchPlanRepositoryPort, 'findByDigest'>;
  readonly cutoverJournal: Pick<CutoverJournalPort, 'listByKeyPrefix'>;
  readonly computeDigest: (text: string) => string;
  /** Kept for AR2b's live apply; AR2a2 never calls it. */
  readonly authorization?: Pick<ActionAuthorizationPort, 'authorizeRelaunchApply'>;
  /** The trusted clock for the deadline check; never `request.nowIso`. */
  readonly clock?: () => string;
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
    if (typeof laneId !== 'string' || laneId === '') return null;
    // `attemptId` is never `null` and never empty: a lane without an attempt
    // is planned with no save input at all.
    if (typeof attemptId !== 'string' || attemptId === '') return null;
    if (map.has(laneId)) return null;
    map.set(laneId, element as ApplyRelaunchSaveInput);
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
): LaneDerivation | null {
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

/** The trusted clock: a throwing or malformed reading, or a passed deadline, is an exhausted budget. */
function withinBudget(deps: ApplyRelaunchDependencies, deadlineMs: number | null): boolean {
  try {
    const nowText: unknown = deps.clock !== undefined ? deps.clock() : new Date().toISOString();
    if (typeof nowText !== 'string') return false;
    if (!isZonedIsoDateTime(nowText) || Number.isNaN(Date.parse(nowText))) return false;
    return deadlineMs === null || Date.parse(nowText) < deadlineMs;
  } catch {
    return false;
  }
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
  if (!validateStoredRelaunchPlan(planStep.value).ok) return fail('invalid-plan');
  const storedPlan = planStep.value as RelaunchPlanRecord;
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

function deriveLaneSummaries(
  deps: ApplyRelaunchDependencies,
  planDigest: string,
  storedPlan: RelaunchPlanRecord,
  snapshot: readonly SnapshotEntry[],
  saveInputs: ReadonlyMap<string, ApplyRelaunchSaveInput>,
): Step<ApplyRelaunchLaneSummary[]> {
  const lanes: ApplyRelaunchLaneSummary[] = [];
  for (const lane of storedPlan.lanes) {
    const saveRefusal = verifyLaneSaveInput(deps, planDigest, lane, snapshot, saveInputs);
    if (saveRefusal !== null) return { ok: false, result: saveRefusal };
    const derivation = deriveLane(snapshot, planDigest, lane);
    if (derivation === null) return { ok: false, result: { outcome: 'refused', reason: 'step-inconsistent', laneId: lane.laneId } };
    const stopped = stoppedRefusal(derivation.nextAction, lane.laneId);
    if (stopped !== null) return { ok: false, result: stopped };
    lanes.push({
      laneId: lane.laneId,
      population: lane.population,
      stepStatuses: derivation.stepStatuses,
      nextAction: derivation.nextAction,
    });
  }
  return pass(lanes);
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

    // Authorization is never called here: AR2b owns the live apply.
    if (apply) {
      return refusal(typeof grantId !== 'string' || grantId.trim() === '' ? 'grant-missing' : 'live-apply-not-implemented');
    }

    if (!withinBudget(deps, deadlineMs)) return refusal('budget-exhausted');
    const snapshotStep = await loadJournalSnapshot(deps, planDigest);
    if (!snapshotStep.ok) return snapshotStep.result;

    const lanes = deriveLaneSummaries(deps, planDigest, planStep.value, snapshotStep.value, saveInputs);
    if (!lanes.ok) return lanes.result;
    return { outcome: 'dry-run', planDigest, lanes: lanes.value };
  }
}
