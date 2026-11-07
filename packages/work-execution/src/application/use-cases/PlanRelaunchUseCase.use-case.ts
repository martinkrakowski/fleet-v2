// @generated use-case scaffold — refined for lane CO29a.
/**
 * PlanRelaunchUseCase: build and store the ordered relaunch plan (cutover plan
 * CO29a, §4 steps 2–7). It reads the relaunch inventory and the work-execution
 * records, joins every inventoried lane to its run, attempt, work order and
 * project, derives the dependency edges (prerequisite work orders, lane-plan
 * `after` and exclusive orders), orders the lanes topologically with conducted
 * lanes and chain heads first, admits the redispatching lanes in waves under
 * the cap and the package / owned-path non-overlap rule, staggers the
 * dispatches per runner endpoint, and stores the plan under its canonical
 * digest. It writes nothing but that one plan and never stops, aborts,
 * adopts or dispatches anything: a conducted run is never touched (D-CO10).
 *
 * `planRelaunch` takes `unknown` and never throws. Anything the inventory or a
 * record store cannot tell is `unknown`, never planned around. Results carry
 * ids, counts, digests and fixed codes only: never a worktree path, a clone
 * path, an exception message or a rejected input value.
 */

import { containsSecretShape, isValidHostName, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';

import { parseBaseBranch, resolveLaneRunBaseBranch, resolveWorkOrderBaseBranch } from '../../domain/base-branch.js';
import type { BaseBranchValue } from '../../domain/base-branch.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { DEFAULT_DISPATCH_STAGGER_MS, dispatchEndpointKey } from '../../domain/dispatch-stagger.js';
import type { AttemptRecord, AttemptRunnerRecord, WorkOrderRecord } from '../../domain/execution-records.js';
import { pathUnderPrefix } from '../../domain/lane-diff-check.js';
import type { LanePlanRecord } from '../../domain/lane-plan-records.js';
import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import { laneRunOwnedPathsOverlap, laneRunPackagesOverlap } from '../../domain/lane-run-packages.js';
import { DEFAULT_RELAUNCH_MAX_ACTIVE_RUNS } from '../ports/in/PlanRelaunchPort.in-port.js';
import type {
  PlanRelaunchPort,
  PlanRelaunchRefusalReason,
  PlanRelaunchResult,
  PlanRelaunchUnknownReason,
} from '../ports/in/PlanRelaunchPort.in-port.js';
import type {
  InventoryRelaunchPort,
  RelaunchCloneRef,
  RelaunchLaneRow,
  RelaunchPopulation,
} from '../ports/in/InventoryRelaunchPort.in-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { LanePlanRepositoryPort } from '../ports/out/LanePlanRepositoryPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import {
  canonicalRelaunchPlanBodyJson,
  RELAUNCH_PLAN_SCHEMA_VERSION,
  relaunchStepCodesFor,
  relaunchStepKey,
  type RelaunchPlanRecord,
  type RelaunchPlanRepositoryPort,
  type RelaunchPlannedLane,
  type RelaunchStepCode,
} from '../ports/out/RelaunchPlanRepositoryPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';

export interface PlanRelaunchDependencies {
  readonly inventory: Pick<InventoryRelaunchPort, 'inventoryRelaunch'>;
  readonly runRepo: Pick<LaneRunRepositoryPort, 'list'>;
  readonly attemptRepo: Pick<AttemptRepositoryPort, 'listAllAttempts'>;
  readonly workOrderRepo: Pick<WorkOrderRepositoryPort, 'listWorkOrdersByProject'>;
  readonly lanePlanRepo: Pick<LanePlanRepositoryPort, 'listLanePlans'>;
  readonly planRepo: Pick<RelaunchPlanRepositoryPort, 'save'>;
  readonly computeDigest: (text: string) => string;
  /** The live clock for `deadlineIso` checks; `request.nowIso` when omitted. */
  readonly clock?: () => string;
}

const MAX_CLONES = 128;
const MAX_HOSTS = 64;
const MAX_LANES = 512;
const MAX_TEXT_LENGTH = 4096;
const MAX_ISO_LENGTH = 64;

const LANE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const ID = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const ABSENT = Symbol('absent');
const BAD = Symbol('bad');

/** The unknown codes a risk flag with a positive count maps to. */
const UNKNOWN_FLAG_CODES: readonly PlanRelaunchUnknownReason[] = [
  'unknown-worktree-read',
  'unproven-lane-records',
  'unknown-runner-state',
  'driver-lease-unknown',
];

/** UTF-16 code-unit order, stated explicitly (Sonar S2871). */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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

/** A non-blank, bounded, secret-free string without a control character; otherwise null. */
function plainText(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value) || hasSecretShape(value)) return null;
  return value;
}

function idText(value: unknown): string | null {
  return typeof value === 'string' && ID.test(value) && !hasSecretShape(value) ? value : null;
}

function nullableText(value: unknown): string | null | undefined {
  if (value === null) return null;
  const text = plainText(value);
  return text === null ? undefined : text;
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** A dense array of at most `max` items; a hole, an accessor or an over-long list is null. */
function dense(value: unknown, max: number): unknown[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) return null;
    items.push(descriptor.value);
  }
  return items;
}

function readRecordedHost(raw: unknown): AttemptRunnerRecord | null | undefined {
  if (raw === null) return null;
  const kind = own(raw, 'kind');
  if (kind !== 'opencode' && kind !== 'agy') return undefined;
  const remotePort = own(raw, 'remotePort');
  const host = own(raw, 'host');
  const hostName = own(raw, 'hostName');
  const agent = own(raw, 'agent');
  const model = own(raw, 'model');
  const variant = own(raw, 'variant');
  if (remotePort === BAD || host === BAD || hostName === BAD || agent === BAD || model === BAD || variant === BAD) {
    return undefined;
  }
  const port = remotePort === ABSENT || remotePort === null ? null : inRange(remotePort, 0, 65_535) ? remotePort : undefined;
  const hostText = host === ABSENT ? null : nullableText(host);
  const nameText = hostName === ABSENT || hostName === null ? null : idText(hostName) ?? undefined;
  const agentText = agent === ABSENT ? null : nullableText(agent);
  const modelText = model === ABSENT ? null : nullableText(model);
  const variantText = variant === ABSENT ? null : nullableText(variant);
  if (
    port === undefined ||
    hostText === undefined ||
    nameText === undefined ||
    agentText === undefined ||
    modelText === undefined ||
    variantText === undefined
  ) {
    return undefined;
  }
  return {
    kind,
    remotePort: port,
    host: hostText,
    ...(nameText !== null ? { hostName: nameText } : {}),
    agent: agentText,
    model: modelText,
    variant: variantText,
  };
}

function readClone(raw: unknown): RelaunchCloneRef | null {
  const projectId = idText(own(raw, 'projectId'));
  const hostName = own(raw, 'hostName');
  const clonePath = plainText(own(raw, 'clonePath'));
  const worktreeRoot = plainText(own(raw, 'worktreeRoot'));
  const recordedRaw = own(raw, 'recordedHost');
  if (projectId === null || typeof hostName !== 'string' || !isValidHostName(hostName) || hasSecretShape(hostName)) return null;
  if (clonePath === null || worktreeRoot === null || recordedRaw === BAD) return null;
  const recordedHost = recordedRaw === ABSENT ? null : readRecordedHost(recordedRaw);
  if (recordedHost === undefined) return null;
  return { projectId, hostName, clonePath, worktreeRoot, recordedHost };
}

interface ValidatedRequest {
  readonly nowIso: string;
  readonly hostName: string | null;
  readonly clones: readonly RelaunchCloneRef[];
  readonly maxActiveRuns: number;
  readonly dispatchStaggerMs: number;
  readonly deadlineMs: number | null;
}

/** Never throws: any unreadable or out-of-range field makes the request invalid (null). */
function readRequest(raw: unknown): ValidatedRequest | null {
  try {
    const nowIso = own(raw, 'nowIso');
    if (typeof nowIso !== 'string' || nowIso.length > MAX_ISO_LENGTH || !isZonedIsoDateTime(nowIso)) return null;
    const hostNameRaw = own(raw, 'hostName');
    let hostName: string | null = null;
    if (hostNameRaw !== null) {
      if (typeof hostNameRaw !== 'string' || !isValidHostName(hostNameRaw) || hasSecretShape(hostNameRaw)) return null;
      hostName = hostNameRaw;
    }
    const clonesRaw = dense(own(raw, 'clones'), MAX_CLONES);
    if (clonesRaw === null) return null;
    const clones: RelaunchCloneRef[] = [];
    for (const item of clonesRaw) {
      const clone = readClone(item);
      if (clone === null) return null;
      clones.push(clone);
    }
    const maxRaw = own(raw, 'maxActiveRuns');
    if (maxRaw === BAD || (maxRaw !== ABSENT && maxRaw !== undefined && !inRange(maxRaw, 1, 64))) return null;
    const staggerRaw = own(raw, 'dispatchStaggerMs');
    if (staggerRaw === BAD || (staggerRaw !== ABSENT && staggerRaw !== undefined && !inRange(staggerRaw, 0, 600_000))) {
      return null;
    }
    const deadlineRaw = own(raw, 'deadlineIso');
    let deadlineMs: number | null = null;
    if (deadlineRaw === BAD) return null;
    if (deadlineRaw !== ABSENT && deadlineRaw !== undefined && deadlineRaw !== null) {
      if (typeof deadlineRaw !== 'string' || deadlineRaw.length > MAX_ISO_LENGTH || !isZonedIsoDateTime(deadlineRaw)) {
        return null;
      }
      deadlineMs = Date.parse(deadlineRaw);
    }
    return {
      nowIso,
      hostName,
      clones,
      maxActiveRuns: maxRaw === ABSENT || maxRaw === undefined ? DEFAULT_RELAUNCH_MAX_ACTIVE_RUNS : (maxRaw as number),
      dispatchStaggerMs:
        staggerRaw === ABSENT || staggerRaw === undefined ? DEFAULT_DISPATCH_STAGGER_MS : (staggerRaw as number),
      deadlineMs,
    };
  } catch {
    return null;
  }
}

/** A lane under construction. Holds the worktree path only to match a clone; it never reaches the plan. */
interface DraftLane {
  readonly row: RelaunchLaneRow;
  readonly laneId: string;
  readonly hostName: string;
  readonly population: RelaunchPopulation;
  readonly runnerState: 'idle' | 'running';
  readonly projectId: string | null;
  readonly workOrder: WorkOrderRecord | null;
  readonly workOrderId: string | null;
  readonly attempt: AttemptRecord | null;
  readonly cloneHost: AttemptRunnerRecord | null;
  readonly baseBranch: BaseBranchValue;
  dependsOn: string[];
  chainHead: boolean;
  wave: number;
}

type Ordering = { readonly ok: true; readonly lanes: readonly DraftLane[] } | { readonly ok: false };

/** Iterative Kahn: the ready lane minimizing (conducted first, chain head first, host, lane id) goes next. */
function topologicalOrder(lanes: readonly DraftLane[]): Ordering {
  const byId = new Map(lanes.map((lane) => [lane.laneId, lane]));
  const emitted = new Set<string>();
  const remaining = new Set(lanes);
  const ordered: DraftLane[] = [];
  const rank = (lane: DraftLane): readonly [number, number, string, string] => [
    lane.population === 'conducted' ? 0 : 1,
    lane.chainHead ? 0 : 1,
    lane.hostName,
    lane.laneId,
  ];
  const before = (a: DraftLane, b: DraftLane): boolean => {
    const left = rank(a);
    const right = rank(b);
    if (left[0] !== right[0]) return left[0] < right[0];
    if (left[1] !== right[1]) return left[1] < right[1];
    const host = byCodeUnit(left[2], right[2]);
    if (host !== 0) return host < 0;
    return byCodeUnit(left[3], right[3]) < 0;
  };
  while (remaining.size > 0) {
    let next: DraftLane | null = null;
    for (const lane of remaining) {
      if (!lane.dependsOn.every((dependency) => emitted.has(dependency) || !byId.has(dependency))) continue;
      if (next === null || before(lane, next)) next = lane;
    }
    if (next === null) return { ok: false };
    remaining.delete(next);
    emitted.add(next.laneId);
    ordered.push(next);
  }
  return { ok: true, lanes: ordered };
}

/** Whether `lane` may share an admission wave with `other` (package and owned-path non-overlap, failing closed). */
function compatible(lane: DraftLane, other: DraftLane): boolean {
  if (lane.workOrder !== null && other.workOrder !== null) {
    return (
      !laneRunOwnedPathsOverlap(lane.workOrder, other.workOrder) && !laneRunPackagesOverlap(lane.workOrder, other.workOrder)
    );
  }
  return !(lane.projectId === null || other.projectId === null || lane.projectId === other.projectId);
}

/** The plan's planned lane a work order maps to: its `planRef`, else the one plan of its project holding its lane id. */
function plannedLaneKey(workOrder: WorkOrderRecord, plans: readonly LanePlanRecord[]): string | null {
  const ref = workOrder.planRef;
  if (ref !== undefined) {
    const plan = plans.find((candidate) => candidate.projectId === ref.projectId && candidate.planId === ref.planId);
    return plan !== undefined && plan.lanes.some((lane) => lane.laneId === ref.laneId)
      ? `${ref.projectId}\u0000${ref.planId}\u0000${ref.laneId}`
      : null;
  }
  const holding = plans.filter(
    (plan) => plan.projectId === workOrder.projectId && plan.lanes.some((lane) => lane.laneId === workOrder.laneId),
  );
  return holding.length === 1 ? `${workOrder.projectId}\u0000${holding[0].planId}\u0000${workOrder.laneId}` : null;
}

export class PlanRelaunchUseCase implements PlanRelaunchPort {
  constructor(private readonly deps?: PlanRelaunchDependencies) {}

  async execute(input: unknown): Promise<PlanRelaunchResult> {
    return this.planRelaunch(input);
  }

  async planRelaunch(request: unknown): Promise<PlanRelaunchResult> {
    if (!this.deps) {
      throw new Error('Not implemented: PlanRelaunchUseCase');
    }
    const deps = this.deps;
    const validated = readRequest(request);
    if (validated === null) return { outcome: 'refused', reason: 'invalid-request' };

    const exhausted = (): boolean => {
      if (validated.deadlineMs === null) return false;
      let nowText = validated.nowIso;
      try {
        if (deps.clock !== undefined) nowText = deps.clock();
      } catch {
        nowText = validated.nowIso;
      }
      return Date.parse(nowText) >= validated.deadlineMs;
    };
    const budgetExhausted: PlanRelaunchResult = { outcome: 'refused', reason: 'budget-exhausted' };

    // 1–2. The inventory and the records the join needs.
    const gathered = await this.readInputs(validated, exhausted, budgetExhausted);
    if (!gathered.ok) return gathered.result;

    // 3. Join, order and admit.
    const drafted = joinLanes(gathered.inputs.read.rows, validated.clones, gathered.inputs.runs, gathered.inputs.attempts, gathered.inputs.workOrders);
    if (drafted === null) return { outcome: 'refused', reason: 'invalid-request' };
    deriveDependencies(drafted, gathered.inputs.lanePlans);
    const ordering = topologicalOrder(drafted);
    if (!ordering.ok) return { outcome: 'refused', reason: 'dependency-cycle' };
    const ordered = ordering.lanes;
    assignWaves(ordered, validated.maxActiveRuns);
    const staggers = assignStaggers(ordered, validated.dispatchStaggerMs);

    // 4. Digest the plan and store it by digest.
    const built = buildPlanRecord(deps, validated, gathered.inputs.read.conductor, ordered, staggers);
    if (built === null) return { outcome: 'refused', reason: 'digest-mismatch' };
    return this.storePlan(deps, built, exhausted, budgetExhausted);
  }

  /** Steps 1–2: the inventory (fail-closed on unknowns and limits) and the four record lists. */
  private async readInputs(
    validated: ValidatedRequest,
    exhausted: () => boolean,
    budgetExhausted: PlanRelaunchResult,
  ): Promise<{ readonly ok: true; readonly inputs: RelaunchInputs } | { readonly ok: false; readonly result: PlanRelaunchResult }> {
    const deps = this.deps as PlanRelaunchDependencies;

    // 1. The inventory: the population, the runner state and the conductor.
    if (exhausted()) return { ok: false, result: budgetExhausted };
    let inventoried: unknown;
    try {
      inventoried = await deps.inventory.inventoryRelaunch({
        nowIso: validated.nowIso,
        hostName: validated.hostName,
        clones: validated.clones,
      });
    } catch {
      return { ok: false, result: { outcome: 'unknown', reasons: ['inventory-records-unreadable'] } };
    }
    const outcome = own(inventoried, 'outcome');
    if (outcome === 'refused') {
      return own(inventoried, 'reason') === 'invalid-request'
        ? { ok: false, result: { outcome: 'refused', reason: 'invalid-request' } }
        : { ok: false, result: { outcome: 'unknown', reasons: ['inventory-records-unreadable'] } };
    }
    if (outcome !== 'inventoried') {
      return { ok: false, result: { outcome: 'unknown', reasons: ['inventory-records-unreadable'] } };
    }
    const read = readInventory(inventoried);
    if (read === null) return { ok: false, result: { outcome: 'unknown', reasons: ['inventory-records-unreadable'] } };
    if (read.unknown.length > 0) return { ok: false, result: { outcome: 'unknown', reasons: read.unknown } };
    if (read.hosts.length > MAX_HOSTS || read.rows.length > MAX_LANES) {
      return { ok: false, result: { outcome: 'refused', reason: 'limit-exceeded' } };
    }

    // 2. The records the join needs. A store that cannot be read is unknown.
    let runs: readonly LaneRunRecord[];
    let attempts: readonly AttemptRecord[];
    let workOrders: readonly WorkOrderRecord[];
    let lanePlans: readonly LanePlanRecord[];
    if (exhausted()) return { ok: false, result: budgetExhausted };
    try {
      runs = await deps.runRepo.list();
    } catch {
      return { ok: false, result: { outcome: 'unknown', reasons: ['store-read-failed'] } };
    }
    if (exhausted()) return { ok: false, result: budgetExhausted };
    try {
      attempts = await deps.attemptRepo.listAllAttempts();
    } catch {
      return { ok: false, result: { outcome: 'unknown', reasons: ['store-read-failed'] } };
    }
    if (exhausted()) return { ok: false, result: budgetExhausted };
    try {
      workOrders = await deps.workOrderRepo.listWorkOrdersByProject();
    } catch {
      return { ok: false, result: { outcome: 'unknown', reasons: ['store-read-failed'] } };
    }
    if (exhausted()) return { ok: false, result: budgetExhausted };
    try {
      lanePlans = await deps.lanePlanRepo.listLanePlans();
    } catch {
      return { ok: false, result: { outcome: 'unknown', reasons: ['store-read-failed'] } };
    }
    return { ok: true, inputs: { read, runs, attempts, workOrders, lanePlans } };
  }

  /** Step 4: store the built plan by digest; any save refusal maps onto the port's refusal reasons. */
  private async storePlan(
    deps: PlanRelaunchDependencies,
    plan: RelaunchPlanRecord,
    exhausted: () => boolean,
    budgetExhausted: PlanRelaunchResult,
  ): Promise<PlanRelaunchResult> {
    if (exhausted()) return budgetExhausted;
    try {
      const saved = await deps.planRepo.save(plan);
      if (saved.outcome === 'refused') return { outcome: 'refused', reason: mapSaveRefusal(saved.reason) };
      return { outcome: 'planned', planDigest: plan.planDigest, reused: saved.outcome === 'unchanged', plan: saved.plan };
    } catch {
      return { outcome: 'refused', reason: 'store-unreadable' };
    }
  }
}

/** Everything steps 1–2 gather before the join. */
interface RelaunchInputs {
  readonly read: InventoryRead;
  readonly runs: readonly LaneRunRecord[];
  readonly attempts: readonly AttemptRecord[];
  readonly workOrders: readonly WorkOrderRecord[];
  readonly lanePlans: readonly LanePlanRecord[];
}

/** Digests the drafted lanes into the stored plan record; null when a digest is not a SHA-256 hex digest. */
function buildPlanRecord(
  deps: PlanRelaunchDependencies,
  validated: ValidatedRequest,
  conductor: RelaunchPlanRecord['conductor'],
  ordered: readonly DraftLane[],
  staggers: Map<string, { readonly endpoint: string; readonly offsetMs: number }>,
): RelaunchPlanRecord | null {
  const draftBody = {
    schemaVersion: RELAUNCH_PLAN_SCHEMA_VERSION,
    hostFilter: validated.hostName,
    maxActiveRuns: validated.maxActiveRuns,
    dispatchStaggerMs: validated.dispatchStaggerMs,
    conductor,
    lanes: ordered.map((lane) => ({
      laneId: lane.laneId,
      hostName: lane.hostName,
      projectId: lane.projectId,
      population: lane.population,
      runnerState: lane.runnerState,
      runId: lane.row.runId,
      attemptId: lane.row.attemptId,
      workOrderId: lane.workOrderId,
      baseBranch: lane.baseBranch,
      chainHead: lane.chainHead,
      dependsOnLaneIds: lane.dependsOn,
      admissionWave: lane.wave,
      dispatchEndpointKey: staggers.get(lane.laneId)?.endpoint ?? null,
      staggerOffsetMs: staggers.get(lane.laneId)?.offsetMs ?? null,
      stepCodes: relaunchStepCodesFor(lane.population, lane.runnerState),
    })),
  };
  const planDigest = deps.computeDigest(canonicalRelaunchPlanBodyJson(draftBody));
  const requestDigest = deps.computeDigest(
    JSON.stringify({
      version: 1,
      hostName: validated.hostName,
      maxActiveRuns: validated.maxActiveRuns,
      dispatchStaggerMs: validated.dispatchStaggerMs,
      clones: validated.clones
        .map((clone) => ({ projectId: clone.projectId, hostName: clone.hostName }))
        .sort((a, b) => byCodeUnit(a.hostName, b.hostName) || byCodeUnit(a.projectId, b.projectId)),
    }),
  );
  if (!SHA256_HEX.test(planDigest) || !SHA256_HEX.test(requestDigest)) return null;
  const lanes: RelaunchPlannedLane[] = draftBody.lanes.map(({ stepCodes, ...lane }) => ({
    ...lane,
    steps: stepCodes.map((step: RelaunchStepCode) => ({ step, idempotencyKey: relaunchStepKey(planDigest, lane.laneId, step) })),
  }));
  return {
    schemaVersion: RELAUNCH_PLAN_SCHEMA_VERSION,
    planDigest,
    requestDigest,
    createdAtIso: validated.nowIso,
    hostFilter: validated.hostName,
    maxActiveRuns: validated.maxActiveRuns,
    dispatchStaggerMs: validated.dispatchStaggerMs,
    conductor,
    lanes,
  };
}

function mapSaveRefusal(reason: string): PlanRelaunchRefusalReason {
  switch (reason) {
    case 'digest-mismatch':
    case 'digest-conflict':
    case 'store-unreadable':
    case 'store-unknown-version':
    case 'store-read-only':
    case 'store-limit-exceeded':
      return reason;
    default:
      return 'invalid-request';
  }
}

interface InventoryRead {
  readonly conductor: RelaunchPlanRecord['conductor'];
  readonly hosts: readonly unknown[];
  readonly rows: readonly RelaunchLaneRow[];
  /** Sorted unique unknown codes; empty when the inventory is fully known. */
  readonly unknown: readonly PlanRelaunchUnknownReason[];
}

/** Reads the inventoried result into plain values; null when it is not shaped as the inventory port promises. */
function readInventory(inventoried: unknown): InventoryRead | null {
  try {
    const conductor = own(inventoried, 'conductor');
    const hosts = dense(own(inventoried, 'hosts'), Number.MAX_SAFE_INTEGER);
    const topFlags = dense(own(inventoried, 'riskFlags'), 64);
    if (conductor === BAD || conductor === ABSENT || hosts === null || topFlags === null) return null;
    const halted = own(conductor, 'halted');
    const driverLease = own(conductor, 'driverLease');
    const runCount = own(conductor, 'runCount');
    if (typeof halted !== 'boolean' || !inRange(runCount, 0, Number.MAX_SAFE_INTEGER)) return null;
    if (driverLease !== 'absent' && driverLease !== 'lapsed' && driverLease !== 'live' && driverLease !== 'unknown') {
      return null;
    }
    const unknown = new Set<PlanRelaunchUnknownReason>();
    if (driverLease === 'unknown') unknown.add('driver-lease-unknown');
    const noteFlags = (flags: readonly unknown[]): boolean => {
      for (const flag of flags) {
        const code = own(flag, 'code');
        const count = own(flag, 'count');
        if (typeof code !== 'string' || !inRange(count, 0, Number.MAX_SAFE_INTEGER)) return false;
        if (count > 0 && (UNKNOWN_FLAG_CODES as readonly string[]).includes(code)) {
          unknown.add(code as PlanRelaunchUnknownReason);
        }
      }
      return true;
    };
    if (!noteFlags(topFlags)) return null;
    const rows: RelaunchLaneRow[] = [];
    for (const host of hosts) {
      const hostFlags = dense(own(host, 'riskFlags'), 64);
      const hostLanes = dense(own(host, 'lanes'), Number.MAX_SAFE_INTEGER);
      if (hostFlags === null || hostLanes === null || !noteFlags(hostFlags)) return null;
      for (const lane of hostLanes) {
        const row = readLaneRow(lane);
        if (row === null) return null;
        if (row.runnerState === 'unknown') unknown.add('unknown-runner-state');
        if (row.ownership === 'unknown') unknown.add('unproven-lane-records');
        rows.push(row);
      }
    }
    return {
      conductor: {
        halted,
        driverLease: driverLease === 'unknown' ? 'absent' : driverLease,
        runCount: runCount as number,
      },
      hosts,
      rows,
      unknown: [...unknown].sort(byCodeUnit),
    };
  } catch {
    return null;
  }
}

function readLaneRow(raw: unknown): RelaunchLaneRow | null {
  const population = own(raw, 'population');
  const laneId = own(raw, 'laneId');
  const hostName = own(raw, 'hostName');
  const worktreePath = own(raw, 'worktreePath');
  const runId = own(raw, 'runId');
  const attemptId = own(raw, 'attemptId');
  const runnerState = own(raw, 'runnerState');
  const ownership = own(raw, 'ownership');
  if (population !== 'conducted' && population !== 'attempt-recorded' && population !== 'unrecorded') return null;
  if (runnerState !== 'idle' && runnerState !== 'running' && runnerState !== 'unknown') return null;
  if (ownership !== 'proven' && ownership !== 'unknown' && ownership !== 'none') return null;
  if (typeof worktreePath !== 'string') return null;
  if (typeof laneId !== 'string' || typeof hostName !== 'string') return null;
  if (!(runId === null || typeof runId === 'string') || !(attemptId === null || typeof attemptId === 'string')) return null;
  return { population, laneId, hostName, worktreePath, runId, attemptId, runnerState, ownership };
}

/**
 * Join each inventoried lane to its run, attempt, work order and project. A lane
 * whose ids are not plain, secret-free ids, or whose id repeats, is invalid (null).
 */
function joinLanes(
  rows: readonly RelaunchLaneRow[],
  clones: readonly RelaunchCloneRef[],
  runs: readonly LaneRunRecord[],
  attempts: readonly AttemptRecord[],
  workOrders: readonly WorkOrderRecord[],
): DraftLane[] | null {
  const runById = new Map(runs.map((run) => [run.runId, run]));
  const attemptById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const workOrderById = new Map(workOrders.map((workOrder) => [workOrder.id, workOrder]));
  const seen = new Set<string>();
  const lanes: DraftLane[] = [];
  for (const row of rows) {
    if (!LANE_ID.test(row.laneId) || hasSecretShape(row.laneId) || seen.has(row.laneId)) return null;
    seen.add(row.laneId);
    if (idText(row.hostName) === null) return null;
    if (row.runId !== null && idText(row.runId) === null) return null;
    if (row.attemptId !== null && idText(row.attemptId) === null) return null;
    if (row.runnerState === 'unknown') return null;
    const run = row.runId === null ? null : (runById.get(row.runId) ?? null);
    const attempt = row.attemptId === null ? null : (attemptById.get(row.attemptId) ?? null);
    const workOrderId = run?.workOrderId ?? attempt?.workOrderId ?? null;
    if (workOrderId !== null && idText(workOrderId) === null) return null;
    const workOrder = workOrderId === null ? null : (workOrderById.get(workOrderId) ?? null);
    const hostClones = clones.filter((clone) => clone.hostName === row.hostName);
    const under = hostClones.filter((clone) => pathUnderPrefix(row.worktreePath, clone.worktreeRoot));
    const matched = under.length === 1 ? under[0] : null;
    const projectId = workOrder?.projectId ?? matched?.projectId ?? null;
    if (projectId !== null && idText(projectId) === null) return null;
    const cloneHost = (matched ?? hostClones.find((clone) => clone.recordedHost !== null))?.recordedHost ?? null;
    let baseBranch: BaseBranchValue = 'main';
    if (run !== null) baseBranch = resolveLaneRunBaseBranch(run);
    else if (workOrder !== null) baseBranch = resolveWorkOrderBaseBranch(workOrder);
    if (parseBaseBranch(baseBranch) === undefined) return null;
    lanes.push({
      row,
      laneId: row.laneId,
      hostName: row.hostName,
      population: row.population,
      runnerState: row.runnerState,
      projectId,
      workOrder,
      workOrderId,
      attempt,
      cloneHost,
      baseBranch,
      dependsOn: [],
      chainHead: false,
      wave: 0,
    });
  }
  return lanes;
}

/** Sets `dependsOn` (sorted, unique, inventory lanes only) and `chainHead` on every lane. */
function deriveDependencies(lanes: readonly DraftLane[], plans: readonly LanePlanRecord[]): void {
  const lanesByWorkOrder = new Map<string, DraftLane[]>();
  const lanesByPlanned = new Map<string, DraftLane[]>();
  const plannedKeyOf = new Map<string, string>();
  for (const lane of lanes) {
    if (lane.workOrderId !== null) {
      const held = lanesByWorkOrder.get(lane.workOrderId);
      if (held === undefined) lanesByWorkOrder.set(lane.workOrderId, [lane]);
      else held.push(lane);
    }
    const key = lane.workOrder === null ? null : plannedLaneKey(lane.workOrder, plans);
    if (key !== null) {
      plannedKeyOf.set(lane.laneId, key);
      const held = lanesByPlanned.get(key);
      if (held === undefined) lanesByPlanned.set(key, [lane]);
      else held.push(lane);
    }
  }
  const dependents = new Set<string>();
  for (const lane of lanes) {
    const depends = new Set<string>();
    const add = (others: readonly DraftLane[] | undefined): void => {
      for (const other of others ?? []) if (other.laneId !== lane.laneId) depends.add(other.laneId);
    };
    for (const prerequisite of lane.workOrder?.prerequisiteWorkOrderIds ?? []) add(lanesByWorkOrder.get(prerequisite));
    const key = plannedKeyOf.get(lane.laneId);
    if (key !== undefined) {
      const [projectId, planId, plannedLaneId] = key.split('\u0000');
      const plan = plans.find((candidate) => candidate.projectId === projectId && candidate.planId === planId);
      const planned = plan?.lanes.find((candidate) => candidate.laneId === plannedLaneId);
      for (const after of planned?.after ?? []) {
        add(lanesByPlanned.get(`${after.projectId}\u0000${after.planId}\u0000${after.laneId}`));
      }
      for (const order of plan?.exclusiveOrder ?? []) {
        const index = order.lanes.indexOf(plannedLaneId);
        for (let before = 0; before < index; before += 1) {
          add(lanesByPlanned.get(`${projectId}\u0000${planId}\u0000${order.lanes[before]}`));
        }
      }
    }
    lane.dependsOn = [...depends].sort(byCodeUnit);
    for (const dependency of lane.dependsOn) dependents.add(dependency);
  }
  for (const lane of lanes) {
    lane.chainHead = lane.dependsOn.length === 0 && (lane.baseBranch.startsWith('chain/') || dependents.has(lane.laneId));
  }
}

/** Assigns `wave`: 0 for a conducted lane, else the smallest admissible wave at or after the dependency floor. */
function assignWaves(ordered: readonly DraftLane[], maxActiveRuns: number): void {
  const conducted = ordered.filter((lane) => lane.population === 'conducted');
  const firstRedispatchWave = conducted.length >= maxActiveRuns ? 2 : 1;
  const waves = new Map<number, DraftLane[]>();
  if (firstRedispatchWave === 1) waves.set(1, [...conducted]);
  const byId = new Map(ordered.map((lane) => [lane.laneId, lane]));
  for (const lane of ordered) {
    if (lane.population === 'conducted') {
      lane.wave = 0;
      continue;
    }
    let minWave = firstRedispatchWave;
    for (const dependency of lane.dependsOn) {
      const dependent = byId.get(dependency);
      if (dependent === undefined) continue;
      minWave = Math.max(minWave, dependent.population === 'conducted' ? firstRedispatchWave : dependent.wave + 1);
    }
    let wave = minWave;
    for (;;) {
      const members = waves.get(wave) ?? [];
      if (members.length < maxActiveRuns && members.every((member) => compatible(lane, member))) {
        waves.set(wave, [...members, lane]);
        lane.wave = wave;
        break;
      }
      wave += 1;
    }
  }
}

/** The endpoint key and stagger offset of every lane with a redispatch step, by lane id. */
function assignStaggers(
  ordered: readonly DraftLane[],
  dispatchStaggerMs: number,
): Map<string, { readonly endpoint: string; readonly offsetMs: number }> {
  const seenPerEndpoint = new Map<string, number>();
  const out = new Map<string, { readonly endpoint: string; readonly offsetMs: number }>();
  for (const lane of ordered) {
    if (!relaunchStepCodesFor(lane.population, lane.runnerState).includes('redispatch')) continue;
    const runner = lane.attempt?.runner ?? null;
    const endpoint = dispatchEndpointKey({
      hostName: lane.hostName,
      host: runner?.host ?? lane.cloneHost?.host ?? null,
      kind: runner?.kind ?? lane.cloneHost?.kind ?? 'opencode',
      remotePort: runner?.remotePort ?? lane.cloneHost?.remotePort ?? null,
    });
    const seen = seenPerEndpoint.get(endpoint) ?? 0;
    out.set(lane.laneId, { endpoint, offsetMs: seen * dispatchStaggerMs });
    seenPerEndpoint.set(endpoint, seen + 1);
  }
  return out;
}
