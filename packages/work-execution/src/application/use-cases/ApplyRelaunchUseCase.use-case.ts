// AR2b — ApplyRelaunchUseCase: request validation, trusted-clock budget
// checks, stored-plan digest verification, journal replay derivation, the
// dry-run summary and the live apply. An `apply: true` request runs one
// admission wave of `save`, `abort`, `adopt` and `redispatch` (intent-only;
// the conductor starts the fix) under
// `ActionAuthorizationPort.authorizeRelaunchApply`: preflight liveness, input
// and port checks run first so a failed preflight never consumes the owner
// grant, every journaled step is intent-before-action (I3, I7), and the
// AR2c adopt step adopts the lane's existing worktree through
// `AdoptLanePort` — idempotent on replay, inside the redispatch capacity
// rule, and fail-closed on any missing port, missing input, stale plan state
// or exhausted budget. `prepareFixAttempt` is never called here.
//
// `applyRelaunch` takes `unknown` and never throws. Results carry ids, codes,
// digests and statuses only: never a worktree path, a clone path, an
// exception message or a secret value. Untrusted objects are read through
// their own property descriptors, so no getter ever runs.

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';

import { parseBaseBranch } from '../../domain/base-branch.js';
import { readLaneRunRecord } from '../../domain/entities/LaneRun.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { parseWorkOrderRisk } from '../../domain/execution-records.js';
import { SHA256_HEX_PATTERN } from '../../domain/lane-plan-records.js';
import { LANE_RUN_ID_PATTERN } from '../../domain/lane-run-records.js';
import { AcceptanceSpec } from '../../domain/value-objects/AcceptanceSpec.vo.js';
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
import { adoptLaneInputFault, COMMIT as ADOPT_COMMIT, isAdoptLaneId } from './AdoptLaneUseCase.use-case.js';
import { relaunchStepStatus } from '../../domain/relaunch-step-ledger.js';
import { parseValidatedStoredRelaunchPlan } from '../../domain/relaunch-plan-validation.js';
import { journalsForRuns, type RunJournalRunReads } from './run-journal-reads.js';
import {
  laneRunJournalState,
  readLaneRunJournalEntryRecord,
  type LaneRunJournalEntryRecord,
} from '../../domain/lane-run-journal.js';
import { LANE_RUN_TERMINAL_STATES } from '../../domain/value-objects/LaneRunState.vo.js';
import type {
  AdoptLanePort,
  AdoptLaneSource,
} from '../ports/in/AdoptLanePort.in-port.js';
import type {
  ApplyRelaunchAdoptInput,
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
  readonly runRepo?: Pick<LaneRunRepositoryPort, 'get' | 'list'>;
  /** The run journals of the runs the preflight reconciles; `listForRun` required, `listForRuns` optional. */
  readonly runJournal?: RunJournalRunReads;
  readonly adoptLane?: Pick<AdoptLanePort, 'adoptLane'>['adoptLane'];
  readonly mintEntryId?: () => string;
}

/** Every string the request carries is bounded; a longer one is unreadable. */
const MAX_TEXT_LENGTH = 4096;

/**
 * The brief-text bound of an adopt input (AR2c): the lane's frozen brief is
 * never rewritten, so its whole text may travel through the request.
 */
const MAX_BRIEF_TEXT_LENGTH = 262_144;

/** The adopt secret-scan bounds: a brief nests deeper and is far longer than a save input. */
const MAX_ADOPT_SCAN_DEPTH = 8;
const MAX_ADOPT_SCAN_NODES = 2048;
/** Aggregate string length across one adopt input: the brief plus slack, not nodes times the per-string cap. */
const MAX_ADOPT_SCAN_CHARS = 3 * MAX_BRIEF_TEXT_LENGTH;

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

/** The top-level keys of one adopt input (AR2c); `source` may be derived from the journal. */
const ADOPT_INPUT_REQUIRED_KEYS = [
  'laneId',
  'projectId',
  'planRef',
  'baseBranch',
  'workOrder',
  'brief',
  'attempt',
  'run',
] as const;
const ADOPT_INPUT_OPTIONAL_KEYS = ['source'] as const;

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
 * The depth and text-length bounds are parameters so the adopt inputs (AR2c)
 * may nest one brief deeper and carry the whole frozen brief text.
 */
function scanForSecret(
  value: unknown,
  depth: number,
  budget: { nodes: number; chars?: number },
  maxDepth: number = MAX_SCAN_DEPTH,
  maxTextLength: number = MAX_TEXT_LENGTH,
): boolean | null {
  if (value === null) return false;
  if (typeof value === 'string') {
    // Cost bound: the length cap refuses an enormous string in O(1) before
    // any pattern scan runs.
    if (value.length > maxTextLength) return null;
    if (budget.chars !== undefined) {
      budget.chars -= value.length;
      if (budget.chars < 0) return null;
    }
    return hasSecretShape(value);
  }
  if (typeof value !== 'object') return false;
  if (depth >= maxDepth) return null;
  if (Array.isArray(value)) {
    const dense = readBoundedDenseArray(value, MAX_RELAUNCH_APPLY_ENTRIES);
    if (dense === null) return null;
    for (const element of dense.array) {
      budget.nodes -= 1;
      if (budget.nodes < 0) return null;
      const found = scanForSecret(element, depth + 1, budget, maxDepth, maxTextLength);
      if (found !== false) return found;
    }
    return false;
  }
  const snapshot = snapshotPlainDataRecord(value);
  if (snapshot === null) return null;
  for (const key of Object.keys(snapshot)) {
    budget.nodes -= 1;
    if (budget.nodes < 0) return null;
    const found = scanForSecret(snapshot[key], depth + 1, budget, maxDepth, maxTextLength);
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
  // Descriptor-only read (no get trap, no Proxy): the domain reader refuses
  // anything but a genuine dense data array.
  const dense = readBoundedDenseArray(value, MAX_RELAUNCH_APPLY_LANES);
  return dense !== null && dense.array.every(isBoundedText);
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
 * The request's adopt inputs (AR2c), keyed by `laneId` in a `Map`. Each
 * element is read exactly once through its own descriptors: any hole,
 * accessor, extra key, over-deep or over-wide graph, bad lane id, duplicate
 * lane id, empty or over-long `brief.briefText`, or a failed
 * `structuredClone` is `null`, and a secret shape anywhere inside is
 * `'secret-detected'`. The validated element is cloned before it is stored,
 * so no caller-owned object or `Proxy` is retained across `await`.
 *
 * Cost: one O(1) length gate, one O(K) `Reflect.ownKeys` and one O(cap)
 * descriptor copy per element (`readBoundedDenseArray`), plus a bounded
 * secret scan of at most `MAX_ADOPT_SCAN_NODES` nodes at most
 * `MAX_ADOPT_SCAN_DEPTH` deep with strings capped at `MAX_BRIEF_TEXT_LENGTH`.
 */
/**
 * Whether any nested plain record in the graph carries an own `__proto__`,
 * `constructor` or `prototype` key. Fix-round item 1: the snapshot helper
 * rejects `__proto__` but permits the other two, and `structuredClone`
 * retains them, so a hostile adopt input must be refused explicitly instead
 * of riding through to the port. Traversal mirrors `scanForSecret` and
 * shares the adopt bounds, so the cost is at most `MAX_ADOPT_SCAN_NODES`
 * nodes at most `maxDepth` deep; an unreadable graph (an accessor, over-deep
 * or over-wide) is a refusal, never a pass.
 */
function containsPollutingKey(value: unknown, depth: number, budget: { nodes: number }, maxDepth: number): boolean | null {
  if (value === null || typeof value !== 'object') return false;
  if (depth >= maxDepth) return null;
  if (Array.isArray(value)) {
    const dense = readBoundedDenseArray(value, MAX_RELAUNCH_APPLY_ENTRIES);
    if (dense === null) return null;
    for (const element of dense.array) {
      budget.nodes -= 1;
      if (budget.nodes < 0) return null;
      const found = containsPollutingKey(element, depth + 1, budget, maxDepth);
      if (found !== false) return found;
    }
    return false;
  }
  const snapshot = snapshotPlainDataRecord(value);
  if (snapshot === null) return null;
  for (const key of Object.keys(snapshot)) {
    budget.nodes -= 1;
    if (budget.nodes < 0) return null;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return true;
    const found = containsPollutingKey(snapshot[key], depth + 1, budget, maxDepth);
    if (found !== false) return found;
  }
  return false;
}

/**
 * Fix-round item 1: the nested grammars of one adopt input, checked on the
 * cloned plain snapshot before the input is stored or handed to preflight.
 * They mirror the exact checks `AdoptLaneUseCase.readAdoptLaneRequest`
 * enforces, so an input the port would refuse — a `run.tier` outside
 * `{1, 2}`, an unknown `acceptanceSpec`, a malformed work order, attempt,
 * brief or source — can no longer pass preflight, consume the owner grant
 * and save/abort the lane before `adoptLane` rejects it.
 *
 * Every read below is a plain property read of a `structuredClone` result:
 * the clone carries data properties only (accessors and symbol keys are
 * dropped), and the `__proto__`/`constructor`/`prototype` sweep already
 * refused any polluting key, so no getter ever runs and no key can be
 * confused with the prototype chain. Cost: O(size of the clone), which the
 * preceding secret and polluting-key sweeps already bound to at most
 * `MAX_ADOPT_SCAN_NODES` nodes at most `MAX_ADOPT_SCAN_DEPTH` deep, with
 * strings capped at `MAX_BRIEF_TEXT_LENGTH`.
 */
const ADOPT_NESTED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ADOPT_ATTEMPT_ID = /^attempt-[0-9A-Za-z][0-9A-Za-z-]{0,63}$/;
const MAX_ADOPT_NESTED_ID = 128;
const MAX_ADOPT_REF = 256;
const MAX_ADOPT_OWNED_PATHS = 256;
const MAX_ADOPT_PREREQUISITE_IDS = 64;
const MAX_ADOPT_COMMITS_SINCE_BASE = 512;

/** A non-empty bounded string; the trim refuses whitespace-only values as `AdoptLaneUseCase` does. */
function adoptNestedText(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

function adoptNestedId(value: unknown): boolean {
  return typeof value === 'string' && ADOPT_NESTED_ID.test(value);
}

/** A dense, bounded list of non-empty bounded strings. */
function adoptNestedStringList(value: unknown, max: number, itemMax: number): boolean {
  if (!Array.isArray(value) || value.length > max) return false;
  return value.every((item) => adoptNestedText(item, itemMax));
}

function adoptNestedRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** The optional `attempt.runner` record, exactly as `AdoptLaneUseCase.readRunner` reads it. */
function isAdoptNestedRunner(value: unknown): boolean {
  const record = adoptNestedRecord(value);
  if (record === null) return false;
  const kind = record['kind'];
  const port = record['remotePort'];
  if ((kind !== 'opencode' && kind !== 'agy') || !(port === null || (typeof port === 'number' && Number.isSafeInteger(port)))) {
    return false;
  }
  for (const key of ['host', 'agent', 'model', 'variant'] as const) {
    const field = record[key];
    if (!(field === null || adoptNestedText(field, MAX_ADOPT_NESTED_ID))) return false;
  }
  return true;
}

/** The optional `source`, exactly as `AdoptLaneUseCase.readSource` reads it. */
function isAdoptNestedSource(value: unknown): boolean {
  const record = adoptNestedRecord(value);
  if (record === null) return false;
  if (typeof record['commitOid'] !== 'string' || !ADOPT_COMMIT.test(record['commitOid'])) return false;
  if (record['kind'] === 'save-ref') {
    return (
      adoptNestedText(record['saveRef'], MAX_ADOPT_REF) &&
      typeof record['treeDigest'] === 'string' &&
      ADOPT_COMMIT.test(record['treeDigest'])
    );
  }
  if (record['kind'] === 'clean-commit') {
    if (!adoptNestedText(record['branchName'], MAX_ADOPT_REF)) return false;
    const onBranch = record['commitOnBranch'];
    if (!(typeof onBranch === 'boolean' || onBranch === 'unknown')) return false;
    const dirty = record['dirtyCount'];
    if (!(dirty === 'unknown' || (typeof dirty === 'number' && Number.isSafeInteger(dirty) && dirty >= 0))) return false;
    const since = record['commitsSinceBase'];
    return (
      since === undefined ||
      (adoptNestedStringList(since, MAX_ADOPT_COMMITS_SINCE_BASE, 64) &&
        (since as string[]).length > 0 &&
        (since as string[]).every((item) => ADOPT_COMMIT.test(item)))
    );
  }
  return false;
}

/** One nested field group of the cloned adopt input, or `null` when malformed. */
function isAdoptInputShape(snapshot: unknown, laneId: string): boolean {
  const record = adoptNestedRecord(snapshot);
  if (record === null) return false;
  if (!adoptNestedId(record['projectId'])) return false;
  const planRef = adoptNestedRecord(record['planRef']);
  if (planRef === null || !adoptNestedId(planRef['planId']) || planRef['projectId'] !== record['projectId'] || planRef['laneId'] !== laneId) {
    return false;
  }
  if (parseBaseBranch(record['baseBranch']) === undefined) return false;
  const workOrder = adoptNestedRecord(record['workOrder']);
  if (
    workOrder === null || !adoptNestedId(workOrder['workOrderId']) || !adoptNestedId(workOrder['taskId']) ||
    !adoptNestedText(workOrder['repository'], MAX_ADOPT_REF) ||
    typeof workOrder['baseCommit'] !== 'string' || !ADOPT_COMMIT.test(workOrder['baseCommit']) ||
    !adoptNestedStringList(workOrder['ownedPaths'], MAX_ADOPT_OWNED_PATHS, MAX_ADOPT_REF) ||
    (workOrder['ownedPaths'] as string[]).length === 0 ||
    !adoptNestedText(workOrder['policyRevision'], MAX_ADOPT_NESTED_ID)
  ) {
    return false;
  }
  if (workOrder['risk'] !== undefined && parseWorkOrderRisk(workOrder['risk']) === undefined) return false;
  if (
    workOrder['prerequisiteWorkOrderIds'] !== undefined &&
    !adoptNestedStringList(workOrder['prerequisiteWorkOrderIds'], MAX_ADOPT_PREREQUISITE_IDS, MAX_ADOPT_NESTED_ID)
  ) {
    return false;
  }
  const brief = adoptNestedRecord(record['brief']);
  if (
    brief === null || !adoptNestedId(brief['briefId']) || !adoptNestedText(brief['briefText'], MAX_BRIEF_TEXT_LENGTH) ||
    typeof brief['expectedBriefDigest'] !== 'string' || !SHA256_HEX_PATTERN.test(brief['expectedBriefDigest']) ||
    !adoptNestedText(brief['prosePath'], MAX_ADOPT_REF) || !adoptNestedText(brief['manifestPath'], MAX_ADOPT_REF) ||
    !adoptNestedText(brief['reviewerModel'], MAX_ADOPT_NESTED_ID)
  ) {
    return false;
  }
  // The acceptance spec is validated in full by the domain value object, the
  // same check `AdoptLaneUseCase` runs before it journals any adopt step:
  // bounded to MAX_GATE_COMMANDS commands of bounded argv, so the cost is O(1).
  if (AcceptanceSpec.create(brief['acceptanceSpec']).success !== true) return false;
  const attempt = adoptNestedRecord(record['attempt']);
  if (
    attempt === null || typeof attempt['attemptId'] !== 'string' || !ADOPT_ATTEMPT_ID.test(attempt['attemptId']) ||
    !isZonedIsoDateTime(attempt['endedAtIso']) ||
    !(attempt['sessionId'] === undefined || attempt['sessionId'] === null || adoptNestedText(attempt['sessionId'], MAX_ADOPT_NESTED_ID))
  ) {
    return false;
  }
  if (attempt['runner'] !== undefined && !isAdoptNestedRunner(attempt['runner'])) return false;
  const run = adoptNestedRecord(record['run']);
  if (
    run === null || typeof run['runId'] !== 'string' || !LANE_RUN_ID_PATTERN.test(run['runId']) ||
    (run['tier'] !== 1 && run['tier'] !== 2) ||
    typeof run['seatPlanRef'] !== 'string' || !SHA256_HEX_PATTERN.test(run['seatPlanRef']) ||
    !adoptNestedText(run['runPolicyRevision'], MAX_ADOPT_NESTED_ID) ||
    !(run['branchName'] === undefined || adoptNestedText(run['branchName'], MAX_ADOPT_REF))
  ) {
    return false;
  }
  if (record['source'] !== undefined && !isAdoptNestedSource(record['source'])) return false;
  return true;
}

/** The required result fields of an `adopted` port answer, read through `own`; `null` when any is malformed. */
function readAdoptedResult(result: unknown): Record<string, unknown> | null {
  const reused = own(result, 'reused');
  if (typeof reused !== 'boolean') return null;
  const fields: Record<string, unknown> = { reused };
  for (const key of ['workOrderId', 'briefDigest', 'attemptId', 'runId', 'commitOid'] as const) {
    const value = own(result, key);
    if (typeof value !== 'string') return null;
    fields[key] = value;
  }
  if (own(result, 'enteredState') !== 'collecting' || own(result, 'provenance') !== 'adopted') return null;
  return fields;
}

function readAdoptInputs(value: unknown): Map<string, ApplyRelaunchAdoptInput> | 'secret-detected' | null {
  const dense = readBoundedDenseArray(value, MAX_RELAUNCH_APPLY_LANES);
  if (dense === null) return null;
  const map = new Map<string, ApplyRelaunchAdoptInput>();
  for (const element of dense.array) {
    const fields = readPlainRecordWithOptionalKeys(element, ADOPT_INPUT_REQUIRED_KEYS, ADOPT_INPUT_OPTIONAL_KEYS);
    if (fields === null) return null;
    // Secret screening runs over every reachable string before any other
    // field check, with the adopt bounds: `brief.acceptanceSpec.commands[]
    // .argv[]` nests to depth 6 and `brief.briefText` may be 262,144 chars.
    const secret = scanForSecret(element, 0, { nodes: MAX_ADOPT_SCAN_NODES, chars: MAX_ADOPT_SCAN_CHARS }, MAX_ADOPT_SCAN_DEPTH, MAX_BRIEF_TEXT_LENGTH);
    if (secret === true) return 'secret-detected';
    if (secret === null) return null;
    // Fix-round item 1: a nested own `constructor` or `prototype` key would
    // survive the snapshot helper and the clone, so it is refused here.
    const polluting = containsPollutingKey(element, 0, { nodes: MAX_ADOPT_SCAN_NODES }, MAX_ADOPT_SCAN_DEPTH);
    if (polluting !== false) return null;
    const laneId: unknown = fields['laneId'];
    // AdoptLaneUseCase's own lane-id grammar (a leading `.`, `_` or `-` is refused there), never a looser copy.
    if (typeof laneId !== 'string' || !isAdoptLaneId(laneId)) return null;
    if (map.has(laneId)) return null;
    const brief: unknown = fields['brief'];
    const briefText: unknown = own(brief, 'briefText');
    // The brief text is never empty and never over the frozen-brief bound.
    if (typeof briefText !== 'string' || briefText === '' || briefText.length > MAX_BRIEF_TEXT_LENGTH) return null;
    // Clone inside try/catch: a Proxy stand-in the descriptor reads cannot
    // distinguish from data is refused here rather than trusted.
    let snapshot: unknown;
    try {
      snapshot = structuredClone(element);
    } catch {
      return null;
    }
    // Fix-round item 1: the nested fields are validated on the cloned plain
    // snapshot, so a `run.tier` outside `{1, 2}` or a malformed work order,
    // brief, attempt or source is refused at parse, before preflight can
    // consume the grant or the wave can save/abort the lane.
    if (!isAdoptInputShape(snapshot, laneId)) return null;
    map.set(laneId, snapshot as ApplyRelaunchAdoptInput);
  }
  return map;
}

/**
 * One journal entry read exactly once through its own data descriptors, so no
 * getter ever runs on `key`, `kind`, `outcome`, `digest`, `saveRef` or
 * `commitId`. `null` when the entry is not a plain record with an own
 * enumerable string `key` and `kind`, optional string-or-null `outcome`,
 * `digest`, `saveRef` and `commitId`, and no accessor on any own key.
 */
interface SnapshotEntry {
  readonly key: string;
  readonly kind: string;
  readonly outcome: undefined | string | null;
  readonly digest: undefined | string | null;
  /** AR2c: the save result's saved ref and commit id, when the entry carries them. */
  readonly saveRef: undefined | string | null;
  readonly commitId: undefined | string | null;
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
    const saveRefDescriptor = descriptors.get('saveRef');
    const commitIdDescriptor = descriptors.get('commitId');
    const outcome = outcomeDescriptor === undefined ? undefined : outcomeDescriptor.value;
    const digest = digestDescriptor === undefined ? undefined : digestDescriptor.value;
    const saveRef = saveRefDescriptor === undefined ? undefined : saveRefDescriptor.value;
    const commitId = commitIdDescriptor === undefined ? undefined : commitIdDescriptor.value;
    if (outcome !== undefined && outcome !== null && typeof outcome !== 'string') return null;
    if (digest !== undefined && digest !== null && typeof digest !== 'string') return null;
    if (saveRef !== undefined && saveRef !== null && typeof saveRef !== 'string') return null;
    if (commitId !== undefined && commitId !== null && typeof commitId !== 'string') return null;
    return { key: keyDescriptor.value, kind: kindDescriptor.value, outcome, digest, saveRef, commitId };
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
  /** The raw `deadlineIso` of the request, forwarded to `adoptLane`. */
  readonly deadlineIso: string | null;
  readonly saveInputs: Map<string, ApplyRelaunchSaveInput>;
  readonly adoptInputs: Map<string, ApplyRelaunchAdoptInput>;
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

function readDeadlineMs(request: unknown): Step<{ deadlineMs: number | null; deadlineIso: string | null }> {
  const nowValue = own(request, 'nowIso');
  if (nowValue === ABSENT || nowValue === BAD) return fail('invalid-request');
  if (!isZonedIsoDateTime(nowValue)) return fail('invalid-clock');
  const deadlineValue = own(request, 'deadlineIso');
  if (deadlineValue === BAD) return fail('invalid-request');
  if (deadlineValue === ABSENT || deadlineValue === null) return pass({ deadlineMs: null, deadlineIso: null });
  if (!isZonedIsoDateTime(deadlineValue)) return fail('invalid-clock');
  return pass({ deadlineMs: Date.parse(deadlineValue), deadlineIso: deadlineValue });
}

function readSaveInputsField(request: unknown): Step<Map<string, ApplyRelaunchSaveInput>> {
  const value = own(request, 'saveInputs');
  if (value === BAD) return fail('invalid-request');
  if (value === ABSENT) return pass(new Map<string, ApplyRelaunchSaveInput>());
  const inputs = readSaveInputs(value);
  if (inputs === 'secret-detected') return fail('secret-detected');
  return inputs === null ? fail('invalid-request') : pass(inputs);
}

function readAdoptInputsField(request: unknown): Step<Map<string, ApplyRelaunchAdoptInput>> {
  const value = own(request, 'adoptInputs');
  if (value === BAD) return fail('invalid-request');
  if (value === ABSENT) return pass(new Map<string, ApplyRelaunchAdoptInput>());
  const inputs = readAdoptInputs(value);
  if (inputs === 'secret-detected') return fail('secret-detected');
  return inputs === null ? fail('invalid-request') : pass(inputs);
}

const KNOWN_REQUEST_KEYS: readonly string[] = [
  'planDigest',
  'apply',
  'grantId',
  'nowIso',
  'deadlineIso',
  'saveInputs',
  'adoptInputs',
];

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
  const deadline = readDeadlineMs(request);
  if (!deadline.ok) return deadline;
  const saveInputs = readSaveInputsField(request);
  if (!saveInputs.ok) return saveInputs;
  const adoptInputs = readAdoptInputsField(request);
  if (!adoptInputs.ok) return adoptInputs;
  const unknownKeys = scanUnknownRequestKeys(request);
  if (unknownKeys !== null) return { ok: false, result: unknownKeys };
  return pass({
    planDigest: planDigest.value,
    apply: apply.value,
    grantId: grantId.value,
    deadlineMs: deadline.value.deadlineMs,
    deadlineIso: deadline.value.deadlineIso,
    saveInputs: saveInputs.value,
    adoptInputs: adoptInputs.value,
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
  /** The raw request `deadlineIso`, forwarded to `adoptLane` (AR2c). */
  readonly deadlineIso: string | null;
  readonly saveInputs: ReadonlyMap<string, ApplyRelaunchSaveInput>;
  readonly adoptInputs: ReadonlyMap<string, ApplyRelaunchAdoptInput>;
  readonly storedPlan: RelaunchPlanRecord;
}

type StatusOf = (laneId: string, step: RelaunchStepCode) => RelaunchApplyStepStatus;
type DerivedOk = Extract<Step<DerivedLanes>, { ok: true }>['value'];

/** Counters the preflight establishes and the redispatch step keeps current. */
interface RunCounts {
  liveConductedRuns: number;
  handedOffNotIdle: number;
}

/** Every live port the wave may need must exist before the grant is spent. */
function hasLivePorts(deps: ApplyRelaunchDependencies): boolean {
  return (
    typeof deps.runRepo?.get === 'function' &&
    typeof deps.runRepo?.list === 'function' &&
    typeof deps.runJournal?.listForRun === 'function' &&
    typeof deps.runner?.inspectWorktreeRun === 'function' &&
    typeof deps.runner?.abortWorktreeRun === 'function' &&
    typeof deps.processTreeTermination?.terminateWorktreeProcesses === 'function' &&
    typeof deps.saveLaneEdits === 'function' &&
    typeof deps.adoptLane === 'function' &&
    typeof deps.cutoverJournal?.append === 'function' &&
    typeof deps.mintEntryId === 'function'
  );
}

async function probeConductedLane(
  deps: ApplyRelaunchDependencies,
  lane: PlanLane,
  counts: RunCounts,
): Promise<ApplyRelaunchResult | null> {
  if (lane.runId === null) return refusedLane('stale-plan-state', lane.laneId);
  let run: unknown;
  try {
    run = await deps.runRepo!.get(lane.runId);
  } catch {
    return refusedLane('stale-plan-state', lane.laneId);
  }
  if (run !== null) counts.liveConductedRuns += 1;
  return null;
}

/** Bound on the run records one preflight reconciliation reads (cost: O(runs)). */
const MAX_RECONCILED_RUNS = MAX_RELAUNCH_APPLY_LANES;
/** Bound on the journal entries one run's reconciliation reads (cost: O(entries)). */
const MAX_RECONCILED_ENTRIES = 200;

/** The fields of a `LaneRunRecord` the hand-off reconciliation reads. */
interface ReconciledRun {
  readonly runId: string;
  readonly workOrderId: string;
  readonly attemptIds: readonly string[];
}

/**
 * One run record validated in full by the domain's stored-record reader:
 * `readLaneRunRecord` refuses a missing or unsupported schema version, an
 * unknown, extra or polluting own key (`__proto__`, `constructor`,
 * `prototype`), an accessor field, a string `attemptIds`, and every field
 * outside the `LaneRunRecord` grammar, reading each value through its own
 * property descriptor (no getter ever runs) and catching every throwing
 * Proxy trap as a malformed record. `null` unless the value is a
 * well-formed version-1 record. Cost: one bounded full-record validation
 * per element, O(runs) across the whole list, with the reader's own stated
 * bounds — no unbounded cost is added here.
 */
function readReconciledRun(value: unknown): ReconciledRun | null {
  const read = readLaneRunRecord(value);
  if (!read.ok) return null;
  return {
    runId: read.record.runId,
    workOrderId: read.record.workOrderId,
    attemptIds: read.record.attemptIds,
  };
}

/**
 * The work order id an adopt input carries, read through its own descriptor;
 * `null` when the input or the field is absent or not a non-empty string.
 * An unrecorded lane's plan `workOrderId` is `null`, so the adopt input is
 * the only source the wave-1 reconciliation has.
 */
function readAdoptWorkOrderId(adoptInput: ApplyRelaunchAdoptInput | undefined): string | null {
  const id = own(adoptInput === undefined ? null : own(adoptInput, 'workOrder'), 'workOrderId');
  return typeof id === 'string' && id !== '' ? id : null;
}

/** The attempt id an adopt input carries, read the same way; `null` when absent. */
function readAdoptAttemptId(adoptInput: ApplyRelaunchAdoptInput | undefined): string | null {
  const id = own(adoptInput === undefined ? null : own(adoptInput, 'attempt'), 'attemptId');
  return typeof id === 'string' && id !== '' ? id : null;
}

type MapMethod = (this: Map<unknown, unknown>, key: unknown) => unknown;

/**
 * `has` or `get` of a journal answer, validated through the value's own
 * property descriptors (fix round 2): the prototype must be exactly
 * `Map.prototype`, and any own `has`/`get` must be a data property whose
 * value is the genuine `Map.prototype` method — an accessor is refused
 * without ever running it, and an override is refused. The method is
 * returned as `Map.prototype`'s own, so the caller invokes it with the
 * answer as receiver: a genuine `Map` reads its real `[[MapData]]`, while
 * a map-like fake or a `Proxy` (no `[[MapData]]`, whatever its traps
 * return) throws an incompatible-receiver error and can never supply
 * forged journal entries. Cost: O(1) per method, two descriptor reads.
 */
function journalMapMethod(
  value: object,
  name: 'has' | 'get',
): MapMethod {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor !== undefined) {
    if (descriptor.get !== undefined || descriptor.set !== undefined || !('value' in descriptor)) {
      throw new Error('journal map method is an accessor');
    }
    if (descriptor.value !== Map.prototype[name]) {
      throw new Error('journal map method is overridden');
    }
  }
  return Map.prototype[name] as MapMethod;
}

/**
 * The run journals of `runIds`, from `journalsForRuns` (one store read when
 * `listForRuns` exists), validated without running any getter: the answer
 * must be a genuine `Map` holding a bounded dense array of well-formed
 * stored entries for every requested id. `has` and `get` are validated
 * through own descriptors and invoked only as the genuine `Map.prototype`
 * methods (fix round 2), so an own getter is never executed and an
 * overridden method can never supply forged entries. Cost: O(runs ×
 * entries) validated reads, each bounded. `null` on any throw, missing id
 * or malformed entry.
 */
async function readReconciledJournals(
  runJournal: RunJournalRunReads,
  runIds: readonly string[],
): Promise<ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]> | null> {
  let journalMap: unknown;
  try {
    journalMap = await journalsForRuns(runJournal, runIds);
    // The prototype read, the descriptor reads and the method invocations
    // each consult a trap a Proxy may make throw (and a Proxy receiver
    // fails the genuine method's internal-slot requirement), so the whole
    // inspection is inside the same refusal guard: any throw is a
    // malformed answer, never a propagated error.
    if (typeof journalMap !== 'object' || journalMap === null) return null;
    if (Object.getPrototypeOf(journalMap) !== Map.prototype) return null;
    const has = journalMapMethod(journalMap, 'has');
    const get = journalMapMethod(journalMap, 'get');
    const receiver = journalMap as Map<unknown, unknown>;
    const out = new Map<string, readonly LaneRunJournalEntryRecord[]>();
    for (const runId of runIds) {
      if (has.call(receiver, runId) !== true) return null;
      const dense = readBoundedDenseArray(get.call(receiver, runId), MAX_RECONCILED_ENTRIES);
      if (dense === null) return null;
      const entries: LaneRunJournalEntryRecord[] = [];
      for (const item of dense.array) {
        const read = readLaneRunJournalEntryRecord(item);
        if (!read.ok) return null;
        entries.push(read.record);
      }
      out.set(runId, entries);
    }
    return out;
  } catch {
    return null;
  }
}

/** Per-lane reconciliation outcome the preflight counts and `applyLive` journals. */
interface LaneHandoff {
  readonly matchedRun: ReconciledRun | null;
  readonly terminal: boolean;
}

interface RunReconciliation {
  /** The intent-only lanes whose hand-off result `applyLive` journals. */
  readonly handedOff: ReadonlyMap<string, LaneHandoff>;
  /** Every participating lane's matched run (or none), for capacity accounting. */
  readonly matchedByLane: ReadonlyMap<string, LaneHandoff>;
}

async function listReconciledRuns(
  runRepo: NonNullable<ApplyRelaunchDependencies['runRepo']>,
): Promise<ReconciledRun[] | null> {
  let listed: unknown;
  try {
    listed = await runRepo.list();
  } catch {
    return null;
  }
  const dense = readBoundedDenseArray(listed, MAX_RECONCILED_RUNS);
  if (dense === null) return null;
  const runs: ReconciledRun[] = [];
  for (const item of dense.array) {
    const run = readReconciledRun(item);
    if (run === null) return null;
    runs.push(run);
  }
  return runs;
}

function redispatchParticipants(storedPlan: RelaunchPlanRecord, statusOf: StatusOf): PlanLane[] {
  return storedPlan.lanes.filter((lane) => {
    if (lane.population === 'conducted') return false;
    const redispatchStatus = statusOf(lane.laneId, 'redispatch');
    return redispatchStatus === 'intent-only' || redispatchStatus === 'completed';
  });
}

/** Match each participant to at most one run by work order id; two matches is a stale plan. */
function matchParticipantRuns(
  participants: readonly PlanLane[],
  runs: readonly ReconciledRun[],
  adoptInputs: LiveApplyArgs['adoptInputs'],
): Map<string, LaneHandoff> | ApplyRelaunchResult {
  const matchedByLane = new Map<string, LaneHandoff>();
  for (const lane of participants) {
    const workOrderId = lane.workOrderId ?? readAdoptWorkOrderId(adoptInputs.get(lane.laneId));
    const matched = workOrderId === null ? [] : runs.filter((run) => run.workOrderId === workOrderId);
    if (matched.length > 1) return refusedLane('stale-plan-state', lane.laneId);
    matchedByLane.set(lane.laneId, { matchedRun: matched[0] ?? null, terminal: false });
  }
  return matchedByLane;
}

function reconcileHandoffs(
  args: LiveApplyArgs,
  statusOf: StatusOf,
  participants: readonly PlanLane[],
  matchedByLane: Map<string, LaneHandoff>,
  journals: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>,
): Map<string, LaneHandoff> {
  const { saveInputs, adoptInputs } = args;
  const handedOff = new Map<string, LaneHandoff>();
  for (const lane of participants) {
    const matchedRun = matchedByLane.get(lane.laneId)?.matchedRun ?? null;
    if (matchedRun === null) continue;
    const adoptedAttemptId =
      saveInputs.get(lane.laneId)?.attemptId ?? readAdoptAttemptId(adoptInputs.get(lane.laneId));
    const state = laneRunJournalState(journals.get(matchedRun.runId) ?? [], matchedRun.runId);
    const terminal = (LANE_RUN_TERMINAL_STATES as readonly string[]).includes(state);
    matchedByLane.set(lane.laneId, { matchedRun, terminal });
    if (statusOf(lane.laneId, 'redispatch') !== 'intent-only') continue;
    if (matchedRun.attemptIds.some((id) => id !== adoptedAttemptId) || terminal) {
      handedOff.set(lane.laneId, { matchedRun, terminal });
    }
  }
  return handedOff;
}

/**
 * The digest `AdoptLaneUseCase` journals over every id an adoption writes
 * (`identityDigest`), recomputed from the adopt input; `null` when a field is
 * unreadable or `computeDigest` throws. The journal holds this digest, never
 * the ids, so it is the only trusted record a resent input can be checked
 * against.
 */
function adoptInputIdentity(deps: ApplyRelaunchDependencies, laneId: string, adoptInput: ApplyRelaunchAdoptInput): string | null {
  try {
    const parts = [
      own(adoptInput, 'projectId'),
      own(own(adoptInput, 'planRef'), 'planId'),
      laneId,
      own(own(adoptInput, 'workOrder'), 'workOrderId'),
      own(own(adoptInput, 'brief'), 'briefId'),
      own(own(adoptInput, 'attempt'), 'attemptId'),
      own(own(adoptInput, 'run'), 'runId'),
    ];
    return deps.computeDigest(JSON.stringify(['adopt-lane-ids/1', ...parts]));
  } catch {
    return null;
  }
}

/** `true` when the lane's journaled adopt work-order result carries a digest the resent input does not reproduce. */
function adoptInputContradictsJournal(
  args: LiveApplyArgs,
  snapshot: readonly SnapshotEntry[],
  lane: PlanLane,
  adoptInput: ApplyRelaunchAdoptInput,
): boolean {
  const key = `relaunch/${args.planDigest}/${lane.laneId}/adopt/work-order`;
  const recorded = snapshot.find((entry) => entry.key === key && entry.kind === 'result' && entry.outcome === 'completed');
  if (recorded === undefined || typeof recorded.digest !== 'string') return false;
  return adoptInputIdentity(args.deps, lane.laneId, adoptInput) !== recorded.digest;
}

/**
 * The recorded adopt work-order digest for a lane's `completed` adopt, or
 * `null` when it is missing, unreadable, or not a usable non-empty string.
 * Scans the pre-validated snapshot once (bounded by MAX_RELAUNCH_APPLY_ENTRIES
 * entries) and never invokes object members it does not own, so a getter or
 * `Proxy`-shaped entry cannot execute here.
 */
function adoptWorkOrderResult(args: LiveApplyArgs, snapshot: readonly SnapshotEntry[], laneId: string): string | null {
  const key = `relaunch/${args.planDigest}/${laneId}/adopt/work-order`;
  const recorded = snapshot.find((entry) => entry.key === key && entry.kind === 'result' && entry.outcome === 'completed');
  if (recorded === undefined) return null;
  if (typeof recorded.digest !== 'string' || recorded.digest === '') return null;
  return recorded.digest;
}

/**
 * AR3b (fix round): a participant whose adopt is `partial` or `completed`
 * must have a resolvable work order id that agrees with its journaled adopt
 * result, else its capacity cannot be counted: `stale-plan-state` in
 * preflight, before the grant. An unrecorded plan id with no usable adopt
 * input, or an input whose ids the journaled adopt digest does not reproduce,
 * is never treated as an idle lane.
 */
function participantAdoptRefusal(
  args: LiveApplyArgs,
  snapshot: readonly SnapshotEntry[],
  participants: readonly PlanLane[],
  statusOf: StatusOf,
): ApplyRelaunchResult | null {
  for (const lane of participants) {
    const adoptStatus = statusOf(lane.laneId, 'adopt');
    if (adoptStatus !== 'partial' && adoptStatus !== 'completed') continue;
    const adoptInput = args.adoptInputs.get(lane.laneId);
    if (lane.workOrderId === null && readAdoptWorkOrderId(adoptInput) === null) {
      return refusedLane('stale-plan-state', lane.laneId);
    }
    if (adoptStatus === 'completed') {
      // AR3c1: a completed adopt must have a journaled work-order result
      // digest; its absence (or an unreadable/empty digest) fails closed
      // instead of counting the lane as idle. Lookup is one pass over the
      // already-validated snapshot, bounded by MAX_RELAUNCH_APPLY_ENTRIES.
      const recorded = adoptWorkOrderResult(args, snapshot, lane.laneId);
      if (recorded === null) return refusedLane('stale-plan-state', lane.laneId);
      if (adoptInput !== undefined && adoptInputIdentity(args.deps, lane.laneId, adoptInput) !== recorded) {
        return refusedLane('stale-plan-state', lane.laneId);
      }
    } else if (adoptInput !== undefined && adoptInputContradictsJournal(args, snapshot, lane, adoptInput)) {
      // `partial` keeps the softer rule: a not-yet-completed work order may
      // legitimately lack a journaled digest; only a present one must agree.
      return refusedLane('stale-plan-state', lane.laneId);
    }
  }
  return null;
}

/**
 * AR3b: reconcile redispatch hand-offs against the run repository before the
 * grant is spent. A lane whose redispatch is `intent-only` or `completed` may
 * have a live run the plan's own record no longer names: the run repository
 * is the authority. `list()` is read once and validated; for each
 * participating lane the runs matching the lane's work order id are found,
 * more than one is a stale plan, and one match's journal decides whether the
 * run is terminal (the hand-off is over and the capacity is free) or still
 * live (the slot stays spent). Every untrusted read fails closed as
 * `stale-plan-state` before `authorizeRelaunchApply`.
 */
async function reconcileRedispatchRuns(
  args: LiveApplyArgs,
  statusOf: StatusOf,
  snapshot: readonly SnapshotEntry[],
): Promise<RunReconciliation | ApplyRelaunchResult> {
  const { deps, storedPlan, adoptInputs } = args;
  if (deps.runRepo === undefined || deps.runJournal === undefined) return refusal('stale-plan-state');
  const runs = await listReconciledRuns(deps.runRepo);
  if (runs === null) return refusal('stale-plan-state');
  const participants = redispatchParticipants(storedPlan, statusOf);
  const unresolvable = participantAdoptRefusal(args, snapshot, participants, statusOf);
  if (unresolvable !== null) return unresolvable;
  const matchedByLane = matchParticipantRuns(participants, runs, adoptInputs);
  if (isRefusalResult(matchedByLane)) return matchedByLane;
  const runIds: string[] = [];
  for (const handoff of matchedByLane.values()) {
    if (handoff.matchedRun !== null) runIds.push(handoff.matchedRun.runId);
  }
  const journals =
    runIds.length === 0
      ? new Map<string, readonly LaneRunJournalEntryRecord[]>()
      : await readReconciledJournals(deps.runJournal, runIds);
  if (journals === null) return refusal('stale-plan-state');
  const handedOff = reconcileHandoffs(args, statusOf, participants, matchedByLane, journals);
  return { handedOff, matchedByLane };
}

function countsAsHandedOffNotIdle(
  redispatchStatus: string,
  adoptStatus: string,
  stateKind: string,
  handoff: LaneHandoff | undefined,
): boolean {
  const matched = handoff !== undefined && handoff.matchedRun !== null;
  if (redispatchStatus === 'intent-only') return !(matched && handoff.terminal);
  if (redispatchStatus === 'completed') return matched ? !handoff.terminal : stateKind === 'running';
  return (adoptStatus === 'partial' || adoptStatus === 'completed') && redispatchStatus === 'absent';
}

async function probeWorktreeLane(
  deps: ApplyRelaunchDependencies,
  lane: PlanLane,
  saveInput: ApplyRelaunchSaveInput | undefined,
  statusOf: StatusOf,
  counts: RunCounts,
  handoff: LaneHandoff | undefined,
): Promise<ApplyRelaunchResult | null> {
  if (saveInput === undefined) return refusedLane('stale-plan-state', lane.laneId);
  let state: unknown;
  try {
    state = await deps.runner!.inspectWorktreeRun!({
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
  const redispatchStatus = statusOf(lane.laneId, 'redispatch');
  const adoptStatus = statusOf(lane.laneId, 'adopt');
  if (
    lane.runnerState === 'idle' &&
    redispatchStatus === 'absent' &&
    statusOf(lane.laneId, 'save') !== 'completed' &&
    stateKind === 'running'
  ) {
    return refusedLane('unexpected-running-lane', lane.laneId);
  }
  // A pending hand-off counts toward the cap even while its worktree still
  // reports idle: the conductor has not started the handed-off lane yet, so
  // the idle report is not evidence that the run is over. Counting it keeps a
  // later wave from appending another intent past maxActiveRuns. A lane whose
  // adopt has begun (partial) or completed while its redispatch is still
  // absent occupies a run too (AR2c): it was adopted into a conducted run.
  //
  // AR3b: the run-repository reconciliation decides when a hand-off's run is
  // actually over. Only a matched TERMINAL run frees the slot; a matched
  // non-terminal run is still live whatever the worktree reports, so the
  // slot stays spent.
  if (countsAsHandedOffNotIdle(redispatchStatus, adoptStatus, stateKind, handoff)) counts.handedOffNotIdle += 1;
  return null;
}

interface LivePreflight {
  readonly derived: DerivedOk;
  readonly statusOf: StatusOf;
  readonly counts: RunCounts;
  /** Per-lane `save-ref` sources derived from the journaled save results (AR2c). */
  readonly savedSources: ReadonlyMap<string, AdoptLaneSource>;
  /** Per-lane run reconciliation for redispatch hand-offs (AR3b). */
  readonly handedOff: ReadonlyMap<string, LaneHandoff>;
}

/**
 * The `save-ref` source of a lane whose `save` result is already journaled
 * (AR2c): `{ kind: 'save-ref', saveRef, commitOid: commitId, treeDigest:
 * digest }`. `undefined` when the journal holds no completed save result for
 * the lane carrying a ref, a commit id and a tree digest.
 */
function savedSourceForLane(
  planDigest: string,
  laneId: string,
  snapshot: readonly SnapshotEntry[],
): AdoptLaneSource | undefined {
  const saveKey = `relaunch/${planDigest}/${laneId}/save`;
  for (const entry of snapshot) {
    if (entry.key !== saveKey || entry.kind !== 'result' || entry.outcome !== 'completed') continue;
    if (typeof entry.saveRef !== 'string' || typeof entry.commitId !== 'string' || typeof entry.digest !== 'string') {
      continue;
    }
    return { kind: 'save-ref', saveRef: entry.saveRef, commitOid: entry.commitId, treeDigest: entry.digest };
  }
  return undefined;
}

/**
 * The adopt cross-checks of `preflightLive` (AR2c): `true` when the adopt
 * input disagrees with the plan lane or the save input, so the lane refuses
 * `stale-plan-state` before the grant is spent. Every field is read through
 * its own descriptor of the already-cloned plain snapshot, so no getter runs.
 */
function adoptInputMismatch(
  adoptInput: ApplyRelaunchAdoptInput,
  lane: PlanLane,
  saveInput: ApplyRelaunchSaveInput,
): boolean {
  if (adoptInput.baseBranch !== lane.baseBranch) return true;
  if (lane.projectId !== null && adoptInput.projectId !== lane.projectId) return true;
  const workOrderId = own(adoptInput.workOrder, 'workOrderId');
  if (lane.workOrderId !== null && workOrderId !== lane.workOrderId) return true;
  const attemptId = own(adoptInput.attempt, 'attemptId');
  if (attemptId !== saveInput.attemptId) return true;
  const baseCommit = own(adoptInput.workOrder, 'baseCommit');
  if (baseCommit !== saveInput.baseCommit) return true;
  const owned = own(adoptInput.workOrder, 'ownedPaths');
  if (!Array.isArray(owned)) return true;
  for (const path of owned) {
    if (typeof path !== 'string') return true;
    const covered = saveInput.allowedPathPrefixes.some(
      (prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`),
    );
    if (!covered) return true;
  }
  return false;
}

/** Pre-authorization liveness, input and port checks; spends nothing. */
async function preflightLive(args: LiveApplyArgs): Promise<ApplyRelaunchResult | LivePreflight> {
  const { deps, planDigest, deadlineMs, saveInputs, adoptInputs, storedPlan } = args;
  if (!withinBudget(deps, deadlineMs)) return refusal('budget-exhausted');
  const snapshotStep = await loadJournalSnapshot(deps, planDigest);
  if (!snapshotStep.ok) return snapshotStep.result;
  const derived = deriveLaneSummaries(deps, planDigest, storedPlan, snapshotStep.value, saveInputs);
  if (!derived.ok) return derived.result;
  const statusOf: StatusOf = (laneId, step) =>
    derived.value.derivations.get(laneId)?.stepStatuses.find((entry) => entry.step === step)?.status ?? 'absent';
  if (!hasLivePorts(deps)) return refusal('stale-plan-state');
  const reconciliation = await reconcileRedispatchRuns(args, statusOf, snapshotStep.value);
  if (isRefusalResult(reconciliation)) return reconciliation;
  const savedSources = new Map<string, AdoptLaneSource>();
  const counts: RunCounts = { liveConductedRuns: 0, handedOffNotIdle: 0 };
  for (const lane of storedPlan.lanes) {
    if (lane.population !== 'conducted') {
      // AR2c (fix-round item 2): the adopt-input requirement and its
      // cross-checks apply only to a lane whose plan actually has an `adopt`
      // step — a valid lane without one carries no adopt input — and every
      // adopt input must agree with the plan lane and the save input, all
      // before the grant is spent.
      if (lane.steps.some((entry) => entry.step === 'adopt')) {
        const adoptStatus = statusOf(lane.laneId, 'adopt');
        const adoptInput = adoptInputs.get(lane.laneId);
        if (adoptStatus !== 'completed' && adoptInput === undefined) {
          return refusedLane('stale-plan-state', lane.laneId);
        }
        if (adoptInput !== undefined) {
          const saveInput = saveInputs.get(lane.laneId);
          if (saveInput !== undefined && adoptInputMismatch(adoptInput, lane, saveInput)) {
            return refusedLane('stale-plan-state', lane.laneId);
          }
          // The SAME pure input validation `adoptLane` runs (brief digest, path
          // rules, clean-commit facts), before the grant is spent or anything is
          // saved or aborted. The one refusal class left after the first side
          // effect is a `save-ref` source's check against the journal
          // (save-missing / save-unverified), which needs the save's own result.
          if (adoptStatus !== 'completed' && adoptLaneInputFault(adoptInput, deps.computeDigest) !== null) {
            return refusedLane('adopt-failed', lane.laneId);
          }
        }
      }
      const saved = savedSourceForLane(planDigest, lane.laneId, snapshotStep.value);
      if (saved !== undefined) savedSources.set(lane.laneId, saved);
    }
    const refused =
      lane.population === 'conducted'
        ? await probeConductedLane(deps, lane, counts)
        : await probeWorktreeLane(deps, lane, saveInputs.get(lane.laneId), statusOf, counts, reconciliation.matchedByLane.get(lane.laneId));
    if (refused !== null) return refused;
  }
  return { derived: derived.value, statusOf, counts, savedSources, handedOff: reconciliation.handedOff };
}

/** Authorize the grant; the trusted `nowIso` it was authorized at, or a refusal. */
async function authorizeLive(
  args: LiveApplyArgs,
): Promise<{ readonly nowIso: string } | ApplyRelaunchResult> {
  const { deps, planDigest, grantId, deadlineMs } = args;
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
  if (typeof grantOutcome !== 'string' || grantOutcome === 'unknown') {
    return refusal('authorization-unavailable');
  }
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
  return { nowIso };
}

/** The lowest admission wave with a lane not yet handed off; `null` when none. */
function selectWave(storedPlan: RelaunchPlanRecord, statusOf: StatusOf): number | null {
  let targetWave: number | null = null;
  for (const lane of storedPlan.lanes) {
    if (lane.population === 'conducted') continue;
    const redispatchStatus = statusOf(lane.laneId, 'redispatch');
    if (redispatchStatus === 'intent-only' || redispatchStatus === 'completed') continue;
    if (targetWave === null || lane.admissionWave < targetWave) targetWave = lane.admissionWave;
  }
  return targetWave;
}

interface WaveContext {
  readonly deps: ApplyRelaunchDependencies;
  readonly planDigest: string;
  readonly deadlineMs: number | null;
  /** The raw request `deadlineIso`, forwarded to `adoptLane` (AR2c). */
  readonly deadlineIso: string | null;
  readonly nowIso: string;
  readonly statusOf: StatusOf;
  readonly maxActiveRuns: number;
  readonly counts: RunCounts;
  readonly adoptInputs: ReadonlyMap<string, ApplyRelaunchAdoptInput>;
  /** Per-lane `save-ref` sources: derived from the journal, updated by the wave's saves. */
  readonly savedSources: Map<string, AdoptLaneSource>;
}

/** Journal one entry; any non-`appended` result or throw is a write failure. */
async function appendEntry(
  ctx: WaveContext,
  request: {
    readonly key: string;
    readonly kind: 'intent' | 'result';
    readonly digest?: string;
    readonly outcome?: 'completed' | 'refused';
    readonly reasonCode?: string;
  },
): Promise<boolean> {
  const { deps } = ctx;
  try {
    const appended = await deps.cutoverJournal.append!({
      key: request.key,
      kind: request.kind,
      entryId: deps.mintEntryId!(),
      recordedAtIso: ctx.nowIso,
      ...(request.digest !== undefined ? { digest: request.digest } : {}),
      ...(request.outcome !== undefined ? { outcome: request.outcome, reasonCode: request.reasonCode ?? null } : {}),
    });
    return own(appended, 'outcome') === 'appended';
  } catch {
    return false;
  }
}

/**
 * `saveLaneEdits`; only `saved` or `already-saved` counts as success. The
 * `busy` flag separates the one refusal an abort may clear — a runner
 * session still live in the worktree — from every content or state refusal,
 * which must stop the lane before any abort (I2: a refused save never
 * causes an abort).
 */
async function saveOk(
  ctx: WaveContext,
  laneId: string,
  saveInput: ApplyRelaunchSaveInput,
): Promise<{ readonly ok: boolean; readonly busy: boolean }> {
  try {
    const result = await ctx.deps.saveLaneEdits!({
      planDigest: ctx.planDigest,
      laneId,
      attemptId: saveInput.attemptId,
      worktreePath: saveInput.worktreePath,
      clonePath: saveInput.clonePath,
      recordedHost: saveInput.recordedHost,
      baseCommit: saveInput.baseCommit,
      allowedPathPrefixes: saveInput.allowedPathPrefixes,
      ...(saveInput.policyProtectedPaths === undefined ? {} : { policyProtectedPaths: saveInput.policyProtectedPaths }),
      nowIso: ctx.nowIso,
    });
    const outcome = own(result, 'outcome');
    if (outcome === 'saved' || outcome === 'already-saved') {
      // AR2c: remember the save's ref, commit id and tree digest so a later
      // adopt of this lane in the same wave can derive its `save-ref` source.
      const saveRef = own(result, 'saveRef');
      const commitId = own(result, 'commitId');
      const treeDigest = own(result, 'treeDigest');
      if (typeof saveRef === 'string' && typeof commitId === 'string' && typeof treeDigest === 'string') {
        ctx.savedSources.set(laneId, { kind: 'save-ref', saveRef, commitOid: commitId, treeDigest });
      }
      return { ok: true, busy: false };
    }
    return { ok: false, busy: own(result, 'reason') === 'worktree-busy' };
  } catch {
    return { ok: false, busy: false };
  }
}

/** Journal the save intent (digest of the canonical save input) before the first save attempt. */
async function journalSaveIntent(
  ctx: WaveContext,
  lane: PlanLane,
  idempotencyKey: string,
  saveInput: ApplyRelaunchSaveInput,
): Promise<ApplyRelaunchResult | null> {
  const canonicalJson = canonicalSaveInputJson(ctx.planDigest, saveInput);
  if (canonicalJson === null) return refusal('invalid-request');
  let saveInputDigest: string;
  try {
    saveInputDigest = ctx.deps.computeDigest(canonicalJson);
  } catch {
    return refusal('invalid-request');
  }
  if (!(await appendEntry(ctx, { key: idempotencyKey, kind: 'intent', digest: saveInputDigest }))) {
    return refusedLane('journal-write-failed', lane.laneId);
  }
  return null;
}

/**
 * Save (I2: save before abort — a save refusal other than `worktree-busy`
 * stops the lane before any abort, so a diff finding never costs a live
 * process). `saveLaneEdits` refuses a busy worktree while a runner session is
 * live there; that one refusal is cleared by the abort, after which the save
 * is retried against the intent already journaled.
 */
async function saveStepOfLane(
  ctx: WaveContext,
  lane: PlanLane,
  saveInput: ApplyRelaunchSaveInput,
): Promise<ApplyRelaunchResult | 'save-busy' | null> {
  if (!withinBudget(ctx.deps, ctx.deadlineMs)) return refusal('budget-exhausted');
  const saveStep = lane.steps.find((entry) => entry.step === 'save');
  const saveStatus = ctx.statusOf(lane.laneId, 'save');
  if (saveStep === undefined || saveStatus === 'completed') return null;
  if (saveStatus === 'inconsistent') return refusedLane('step-inconsistent', lane.laneId);
  if (saveStatus === 'refused' || saveStatus === 'ambiguous') {
    return refusedLane('save-failed', lane.laneId);
  }
  if (saveStatus === 'absent') {
    const journalRefusal = await journalSaveIntent(ctx, lane, saveStep.idempotencyKey, saveInput);
    if (journalRefusal !== null) return journalRefusal;
    // AR3b: the intent append may have consumed the whole budget; the save
    // never starts on an expired deadline.
    if (!withinBudget(ctx.deps, ctx.deadlineMs)) return refusal('budget-exhausted');
  }
  // 'intent-only': `verifyLaneSaveInput` already proved the digest matches;
  // `saveLaneEdits` recovers an intent-only save.
  const saveOutcome = await saveOk(ctx, lane.laneId, saveInput);
  if (saveOutcome.ok) return null;
  return saveOutcome.busy ? 'save-busy' : refusedLane('save-failed', lane.laneId);
}

/** Reconcile an abort whose intent is journaled: read-only, never re-calls `abortWorktreeRun` (I7). */
async function reconcileAbort(
  ctx: WaveContext,
  lane: PlanLane,
  idempotencyKey: string,
  saveInput: ApplyRelaunchSaveInput,
): Promise<ApplyRelaunchResult | null> {
  let state: unknown;
  try {
    state = await ctx.deps.runner!.inspectWorktreeRun!({
      attemptId: saveInput.attemptId,
      worktreePath: saveInput.worktreePath,
      runner: saveInput.recordedHost,
    });
  } catch {
    return refusedLane('abort-failed', lane.laneId);
  }
  if (readWorktreeStateKind(state) !== 'idle') return refusedLane('abort-failed', lane.laneId);
  if (!(await appendEntry(ctx, { key: idempotencyKey, kind: 'result', outcome: 'completed', reasonCode: 'reconciled-idle' }))) {
    return refusedLane('journal-write-failed', lane.laneId);
  }
  return null;
}

/** Terminate the worktree's process tree after an abort that asked for it. */
async function terminateAfterAbort(
  ctx: WaveContext,
  lane: PlanLane,
  idempotencyKey: string,
  saveInput: ApplyRelaunchSaveInput,
): Promise<ApplyRelaunchResult | null> {
  if (!withinBudget(ctx.deps, ctx.deadlineMs)) return refusal('budget-exhausted');
  let termination: unknown;
  try {
    termination = await ctx.deps.processTreeTermination!.terminateWorktreeProcesses({
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
    !(await appendEntry(ctx, {
      key: idempotencyKey,
      kind: 'result',
      outcome: terminated ? 'completed' : 'refused',
      reasonCode: terminated ? 'terminated' : 'terminate-failed',
    }))
  ) {
    return refusedLane('journal-write-failed', lane.laneId);
  }
  return terminated ? null : refusedLane('abort-failed', lane.laneId);
}

/** I3: intent before action; termination only without a confirmed result. */
async function performAbort(
  ctx: WaveContext,
  lane: PlanLane,
  idempotencyKey: string,
  saveInput: ApplyRelaunchSaveInput,
): Promise<ApplyRelaunchResult | null> {
  if (!(await appendEntry(ctx, { key: idempotencyKey, kind: 'intent' }))) {
    return refusedLane('journal-write-failed', lane.laneId);
  }
  let threw = false;
  let abortOutcome: unknown;
  try {
    abortOutcome = await ctx.deps.runner!.abortWorktreeRun!({
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
  if (decision.action !== 'none') return terminateAfterAbort(ctx, lane, idempotencyKey, saveInput);
  if (!(await appendEntry(ctx, { key: idempotencyKey, kind: 'result', outcome: 'completed', reasonCode: 'aborted' }))) {
    return refusedLane('journal-write-failed', lane.laneId);
  }
  return null;
}

async function abortStepOfLane(
  ctx: WaveContext,
  lane: PlanLane,
  saveInput: ApplyRelaunchSaveInput,
): Promise<ApplyRelaunchResult | null> {
  const abortStep = lane.steps.find((entry) => entry.step === 'abort');
  if (abortStep === undefined) return null;
  if (!withinBudget(ctx.deps, ctx.deadlineMs)) return refusal('budget-exhausted');
  const abortStatus = ctx.statusOf(lane.laneId, 'abort');
  if (abortStatus === 'refused' || abortStatus === 'inconsistent') {
    return refusedLane('abort-failed', lane.laneId);
  }
  if (abortStatus === 'intent-only' || abortStatus === 'ambiguous') {
    return reconcileAbort(ctx, lane, abortStep.idempotencyKey, saveInput);
  }
  if (abortStatus === 'absent') return performAbort(ctx, lane, abortStep.idempotencyKey, saveInput);
  return null;
}

/**
 * Save first, always: the save attempt itself decides whether an abort is
 * allowed. A busy worktree is the only save refusal an abort clears — the
 * intent is already journaled, so the retry calls `saveLaneEdits` directly,
 * after re-checking the deadline (the abort may have run past it). Every
 * other save refusal returns before `abortWorktreeRun`, honouring I2.
 */
async function saveAndAbortLane(
  ctx: WaveContext,
  lane: PlanLane,
  saveInput: ApplyRelaunchSaveInput,
): Promise<ApplyRelaunchResult | null> {
  const firstSave = await saveStepOfLane(ctx, lane, saveInput);
  if (firstSave !== null && firstSave !== 'save-busy') return firstSave;
  const abortRefusal = await abortStepOfLane(ctx, lane, saveInput);
  if (abortRefusal !== null) return abortRefusal;
  if (firstSave === 'save-busy') {
    if (!withinBudget(ctx.deps, ctx.deadlineMs)) return refusal('budget-exhausted');
    if (!(await saveOk(ctx, lane.laneId, saveInput)).ok) return refusedLane('save-failed', lane.laneId);
  }
  return null;
}

/**
 * AR2c: adopt the lane's existing worktree into a conducted run through
 * `AdoptLanePort` (idempotent on replay — a completed adopt is never
 * re-called), then append the redispatch intent only. A lane with no adopt
 * step keeps the old capacity rule: its redispatch checks the cap and counts
 * its own hand-off. A lane with an adopt step checks the cap for its own
 * `absent` adopt (a `partial` one was already counted by the preflight), and
 * its own redispatch neither re-checks nor increments, so the lane's own
 * hand-off is never counted twice.
 */
async function adoptAndRedispatchLane(
  ctx: WaveContext,
  lane: PlanLane,
  adoptInput: ApplyRelaunchAdoptInput | undefined,
): Promise<ApplyRelaunchResult | null> {
  const hasAdoptStep = lane.steps.some((entry) => entry.step === 'adopt');
  if (hasAdoptStep) {
    const adoptStatus = ctx.statusOf(lane.laneId, 'adopt');
    if (adoptStatus === 'refused') return refusedLane('adopt-failed', lane.laneId);
    if (adoptStatus === 'absent' || adoptStatus === 'partial') {
      if (!withinBudget(ctx.deps, ctx.deadlineMs)) return refusal('budget-exhausted');
      if (adoptStatus === 'absent' && ctx.counts.liveConductedRuns + ctx.counts.handedOffNotIdle >= ctx.maxActiveRuns) {
        return refusedLane('active-run-cap-reached', lane.laneId);
      }
      // Resolve the source: the caller's, or the one derived from the lane's
      // completed save (journaled in an earlier pass or saved this wave).
      const source = adoptInput?.source ?? ctx.savedSources.get(lane.laneId);
      if (adoptInput === undefined || source === undefined) {
        return refusedLane('stale-plan-state', lane.laneId);
      }
      // The parse proved the clone is a plain snapshot (the descriptor-only
      // scan refused every accessor before the `structuredClone`), so its
      // validated fields go to `adoptLane` exactly as they were cloned.
      let adoptResult: unknown;
      try {
        adoptResult = await ctx.deps.adoptLane!({
          planDigest: ctx.planDigest,
          laneId: lane.laneId,
          projectId: adoptInput.projectId,
          planRef: adoptInput.planRef,
          baseBranch: adoptInput.baseBranch,
          workOrder: adoptInput.workOrder,
          brief: adoptInput.brief,
          attempt: adoptInput.attempt,
          run: adoptInput.run,
          source,
          nowIso: ctx.nowIso,
          ...(ctx.deadlineIso === null ? {} : { deadlineIso: ctx.deadlineIso }),
        });
      } catch {
        return refusedLane('adopt-failed', lane.laneId);
      }
      // Fix-round item 3: `own` consults `getPrototypeOf` and
      // `getOwnPropertyDescriptor`, and a lying Proxy may throw in either
      // trap; the exception must not escape, so a throwing read fails closed
      // as `adopt-failed`.
      let outcome: unknown;
      let adoptedFields: Record<string, unknown> | null = null;
      try {
        outcome = own(adoptResult, 'outcome');
        // Fix-round item 2: an `adopted` outcome is trusted only once every
        // required result field is present as an own data property; the ids
        // are then matched against the input below, outside the try.
        if (outcome === 'adopted') adoptedFields = readAdoptedResult(adoptResult);
      } catch {
        return refusedLane('adopt-failed', lane.laneId);
      }
      if (outcome === 'budget-exhausted') return refusal('budget-exhausted');
      if (outcome === 'adopted') {
        if (
          adoptedFields === null ||
          adoptedFields['workOrderId'] !== adoptInput.workOrder.workOrderId ||
          adoptedFields['attemptId'] !== adoptInput.attempt.attemptId ||
          adoptedFields['runId'] !== adoptInput.run.runId ||
          adoptedFields['briefDigest'] !== adoptInput.brief.expectedBriefDigest ||
          adoptedFields['commitOid'] !== source.commitOid
        ) {
          // A port answer claiming `adopted` without the full result or with
          // ids that do not match the input must not journal redispatch or
          // hand the lane to the conductor.
          return refusedLane('adopt-failed', lane.laneId);
        }
        // An `absent` adopt occupies a run from this wave on; a `partial`
        // resume was already counted by the preflight.
        if (adoptStatus === 'absent') ctx.counts.handedOffNotIdle += 1;
      } else {
        // `'refused'`, `'unknown'`, `null`, a non-object, a getter or any
        // malformed result fails closed as `adopt-failed`.
        return refusedLane('adopt-failed', lane.laneId);
      }
    }
  }
  // redispatch: the intent only; the conductor starts the fix from it.
  if (!withinBudget(ctx.deps, ctx.deadlineMs)) return refusal('budget-exhausted');
  const redispatchStatus = ctx.statusOf(lane.laneId, 'redispatch');
  if (redispatchStatus === 'intent-only' || redispatchStatus === 'completed') return null;
  // AR3b: a redispatch the journal already refused or left ambiguous is a
  // stale plan, and an inconsistent one a broken ledger; both refuse before
  // any capacity check or append.
  if (redispatchStatus === 'refused' || redispatchStatus === 'ambiguous') {
    return refusedLane('stale-plan-state', lane.laneId);
  }
  if (redispatchStatus === 'inconsistent') return refusedLane('step-inconsistent', lane.laneId);
  // The capacity rule: only a lane without an adopt step re-checks and
  // counts here — an adopt lane's hand-off was counted by its own adopt.
  if (!hasAdoptStep && ctx.counts.liveConductedRuns + ctx.counts.handedOffNotIdle >= ctx.maxActiveRuns) {
    return refusedLane('active-run-cap-reached', lane.laneId);
  }
  const redispatchStep = lane.steps.find((entry) => entry.step === 'redispatch');
  if (redispatchStep === undefined) return refusedLane('step-inconsistent', lane.laneId);
  if (!(await appendEntry(ctx, { key: redispatchStep.idempotencyKey, kind: 'intent' }))) {
    return refusedLane('journal-write-failed', lane.laneId);
  }
  if (!hasAdoptStep) ctx.counts.handedOffNotIdle += 1;
  return null;
}

/** Execute the wave, lane by lane, step by step. */
async function executeWave(
  ctx: WaveContext,
  storedPlan: RelaunchPlanRecord,
  saveInputs: ReadonlyMap<string, ApplyRelaunchSaveInput>,
  targetWave: number,
): Promise<ApplyRelaunchResult | null> {
  for (const lane of storedPlan.lanes) {
    if (lane.population === 'conducted' || lane.admissionWave !== targetWave) continue;
    // The preflight proved this exists for every non-conducted lane.
    const saveInput = saveInputs.get(lane.laneId) as ApplyRelaunchSaveInput;
    const refused =
      (await saveAndAbortLane(ctx, lane, saveInput)) ??
      (await adoptAndRedispatchLane(ctx, lane, ctx.adoptInputs.get(lane.laneId)));
    if (refused !== null) return refused;
  }
  return null;
}

function isRefusalResult(value: object): value is ApplyRelaunchResult {
  return 'outcome' in value;
}

/**
 * AR3b: a reconciled hand-off gets its journaled result before the wave
 * runs, so `selectWave` and `executeWave` see the redispatch as completed.
 */
async function journalHandoffs(
  ctx: WaveContext,
  storedPlan: RelaunchPlanRecord,
  handedOff: ReadonlyMap<string, LaneHandoff>,
): Promise<ApplyRelaunchResult | null> {
  const { deps, planDigest, deadlineMs } = ctx;
  for (const [laneId] of handedOff) {
    if (!withinBudget(deps, deadlineMs)) return refusal('budget-exhausted');
    const lane = storedPlan.lanes.find((entry) => entry.laneId === laneId);
    const redispatchStep = lane?.steps.find((entry) => entry.step === 'redispatch');
    if (lane === undefined || redispatchStep === undefined) return refusedLane('step-inconsistent', laneId);
    if (await appendEntry(ctx, { key: redispatchStep.idempotencyKey, kind: 'result', outcome: 'completed', reasonCode: 'handed-off' })) {
      continue;
    }
    // The append lost a race: re-read the journal and trust only a recorded
    // completed result for the same key.
    const fresh = await loadJournalSnapshot(deps, planDigest);
    if (!fresh.ok) return fresh.result;
    if (relaunchStepStatus(fresh.value, redispatchStep.idempotencyKey) === 'completed') continue;
    return refusedLane('journal-write-failed', laneId);
  }
  return null;
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
  const { deps, planDigest, deadlineMs, saveInputs, adoptInputs, storedPlan } = args;
  const preflight = await preflightLive(args);
  if (isRefusalResult(preflight)) return preflight;
  const authorized = await authorizeLive(args);
  if (isRefusalResult(authorized)) return authorized;
  const { statusOf, counts, derived, savedSources } = preflight;
  let ctx: WaveContext = {
    deps,
    planDigest,
    deadlineMs,
    deadlineIso: args.deadlineIso,
    nowIso: authorized.nowIso,
    statusOf,
    maxActiveRuns: storedPlan.maxActiveRuns,
    counts,
    adoptInputs,
    savedSources: new Map(savedSources),
  };
  const handoffRefusal = await journalHandoffs(ctx, storedPlan, preflight.handedOff);
  if (handoffRefusal !== null) return handoffRefusal;
  let effectiveStatusOf = statusOf;
  let laneSummaries = derived.summaries;
  if (preflight.handedOff.size > 0) {
    const fresh = await loadJournalSnapshot(deps, planDigest);
    if (!fresh.ok) return fresh.result;
    const updated = deriveLaneSummaries(deps, planDigest, storedPlan, fresh.value, saveInputs);
    if (!updated.ok) return updated.result;
    effectiveStatusOf = (laneId, step) =>
      updated.value.derivations.get(laneId)?.stepStatuses.find((entry) => entry.step === step)?.status ?? 'absent';
    laneSummaries = updated.value.summaries;
    ctx = { ...ctx, statusOf: effectiveStatusOf };
  }
  const targetWave = selectWave(storedPlan, effectiveStatusOf);
  if (targetWave === null) {
    return { outcome: 'applied', planDigest, wave: null, lanes: laneSummaries };
  }
  const refused = await executeWave(ctx, storedPlan, saveInputs, targetWave);
  if (refused !== null) return refused;
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
    const { planDigest, apply, grantId, deadlineMs, deadlineIso, saveInputs, adoptInputs } = parsed.value;

    if (!withinBudget(deps, deadlineMs)) return refusal('budget-exhausted');

    const planStep = await loadVerifiedPlan(deps, planDigest);
    if (!planStep.ok) return planStep.result;

    // AR2b: the live apply runs one wave under the owner grant; AR2c: the
    // adopt step adopts the lane's existing worktree through `adoptLane`.
    if (apply) {
      if (typeof grantId !== 'string' || grantId.trim() === '') return refusal('grant-missing');
      return applyLive({
        deps,
        planDigest,
        grantId,
        deadlineMs,
        deadlineIso,
        saveInputs,
        adoptInputs,
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
