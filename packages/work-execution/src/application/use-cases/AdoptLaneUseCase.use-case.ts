// @generated use-case scaffold — refined for lane CO28.
/**
 * AdoptLaneUseCase: adopt one relaunched lane (cutover plan CO28, §4 step 6). Order: validate the
 * request (size bounds, secret shapes, brief digest, brief package), read the keyed journal (all four
 * steps recorded: return the recorded outcome with no write), verify the source (a journal-recorded save
 * or the caller's clean-commit facts), refuse a lane that already has a run, then run the four keyed steps
 * `work-order`, `brief`, `attempt`, `run`, each with its intent durable before its action. It only talks
 * to repositories and journals: no git, no network, no subprocess, no dispatch, no fix round.
 * `execute` takes `unknown` and never throws; results carry ids, digests, step tokens and fixed codes.
 */

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';

import { parseBaseBranch } from '../../domain/base-branch.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { isSharedAppendPath } from '../../domain/lane-run-packages.js';
import { parseWorkOrderRisk, resolveWorkOrderRisk } from '../../domain/execution-records.js';
import type { AttemptRecord, AttemptRunnerRecord, WorkOrderRecord } from '../../domain/execution-records.js';
import { LANE_RUN_JOURNAL_ENTRY_VERSION, laneRunJournalState } from '../../domain/lane-run-journal.js';
import { LANE_RUN_ID_PATTERN } from '../../domain/lane-run-records.js';
import type { LaneRunRecord, LaneRunTier } from '../../domain/lane-run-records.js';
import { canEnterInitialLaneRunState } from '../../domain/lane-run-transitions.js';
import { AcceptanceSpec } from '../../domain/value-objects/AcceptanceSpec.vo.js';
import { BriefPackage } from '../../domain/value-objects/BriefPackage.vo.js';
import { ADOPT_LANE_STEPS, adoptLaneSaveKey, adoptLaneStepKey } from '../ports/in/AdoptLanePort.in-port.js';
import type {
  AdoptLanePort,
  AdoptLaneRefusalReason,
  AdoptLaneRequest,
  AdoptLaneResult,
  AdoptLaneSource,
  AdoptLaneStep,
  AdoptLaneUnknownReason,
} from '../ports/in/AdoptLanePort.in-port.js';
import type {
  CutoverJournalEntry,
  CutoverJournalPort,
} from '../ports/out/CutoverJournalPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { LaneRunJournalPort } from '../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';

const MAX_BRIEF_TEXT_LENGTH = 262_144;
const MAX_ID_LENGTH = 128;
const MAX_REF_LENGTH = 256;
const MAX_OWNED_PATHS = 256;
const MAX_PREREQUISITE_IDS = 64;
const MAX_COMMITS_SINCE_BASE = 512;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ATTEMPT_ID = /^attempt-[0-9A-Za-z][0-9A-Za-z-]{0,63}$/;
const PLAN_DIGEST = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const NONE = Symbol('none');

/** An own, enumerable data property of a plain object; anything else is NONE. */
function own(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return NONE;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) return NONE;
  return descriptor.value;
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max ? value : null;
}

function id(value: unknown): string | null {
  return typeof value === 'string' && ID.test(value) ? value : null;
}

/** A dense array of at most `max` items; a hole or an over-long list is null. */
function dense(value: unknown, max: number): unknown[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || descriptor.get !== undefined) return null;
    items.push(descriptor.value);
  }
  return items;
}

function textList(value: unknown, max: number, itemMax: number): string[] | null {
  const items = dense(value, max);
  if (items === null) return null;
  const out: string[] = [];
  for (const item of items) {
    const t = text(item, itemMax);
    if (t === null) return null;
    out.push(t);
  }
  return out;
}

function readSource(raw: unknown): AdoptLaneSource | null {
  const kind = own(raw, 'kind');
  const commitOid = own(raw, 'commitOid');
  if (typeof commitOid !== 'string' || !COMMIT.test(commitOid)) return null;
  if (kind === 'save-ref') {
    const saveRef = text(own(raw, 'saveRef'), MAX_REF_LENGTH);
    const treeDigest = own(raw, 'treeDigest');
    if (saveRef === null || typeof treeDigest !== 'string' || !COMMIT.test(treeDigest)) return null;
    return { kind, saveRef, commitOid, treeDigest };
  }
  if (kind === 'clean-commit') {
    const branchName = text(own(raw, 'branchName'), MAX_REF_LENGTH);
    const onBranch = own(raw, 'commitOnBranch');
    const dirty = own(raw, 'dirtyCount');
    const since = own(raw, 'commitsSinceBase');
    if (branchName === null) return null;
    if (!(typeof onBranch === 'boolean' || onBranch === 'unknown')) return null;
    if (!(dirty === 'unknown' || (typeof dirty === 'number' && Number.isSafeInteger(dirty) && dirty >= 0))) return null;
    if (since === NONE || since === undefined) {
      return { kind, commitOid, branchName, commitOnBranch: onBranch, dirtyCount: dirty };
    }
    const list = dense(since, MAX_COMMITS_SINCE_BASE);
    if (list === null || !list.every((item) => typeof item === 'string' && COMMIT.test(item))) return null;
    return {
      kind, commitOid, branchName, commitOnBranch: onBranch, dirtyCount: dirty,
      commitsSinceBase: list as string[],
    };
  }
  return null;
}

function readRunner(value: unknown): AttemptRunnerRecord | undefined | null {
  if (value === NONE || value === undefined) return undefined;
  const kind = own(value, 'kind');
  const port = own(value, 'remotePort');
  if ((kind !== 'opencode' && kind !== 'agy') || !(port === null || (typeof port === 'number' && Number.isSafeInteger(port)))) {
    return null;
  }
  const field = (key: string): string | null | undefined => {
    const v = own(value, key);
    return v === null || (typeof v === 'string' && v.length <= MAX_ID_LENGTH) ? v : undefined;
  };
  const host = field('host');
  const agent = field('agent');
  const model = field('model');
  const variant = field('variant');
  if (host === undefined || agent === undefined || model === undefined || variant === undefined) return null;
  return { kind, remotePort: port, host, agent, model, variant };
}

function readWorkOrder(raw: unknown): AdoptLaneRequest['workOrder'] | null {
  const workOrderId = id(own(raw, 'workOrderId'));
  const taskId = id(own(raw, 'taskId'));
  const repository = text(own(raw, 'repository'), MAX_REF_LENGTH);
  const baseCommit = own(raw, 'baseCommit');
  const ownedPaths = textList(own(raw, 'ownedPaths'), MAX_OWNED_PATHS, MAX_REF_LENGTH);
  const policyRevision = text(own(raw, 'policyRevision'), MAX_ID_LENGTH);
  const riskRaw = own(raw, 'risk');
  const prereqRaw = own(raw, 'prerequisiteWorkOrderIds');
  const risk = riskRaw === NONE || riskRaw === undefined ? undefined : parseWorkOrderRisk(riskRaw);
  const prerequisites =
    prereqRaw === NONE || prereqRaw === undefined ? undefined : textList(prereqRaw, MAX_PREREQUISITE_IDS, MAX_ID_LENGTH);
  if (
    workOrderId === null || taskId === null || repository === null || policyRevision === null ||
    typeof baseCommit !== 'string' || !COMMIT.test(baseCommit) ||
    ownedPaths === null || ownedPaths.length === 0 ||
    (riskRaw !== NONE && riskRaw !== undefined && risk === undefined) ||
    prerequisites === null
  ) {
    return null;
  }
  return {
    workOrderId, taskId, repository, baseCommit, ownedPaths, policyRevision,
    ...(risk === undefined ? {} : { risk }),
    ...(prerequisites === undefined ? {} : { prerequisiteWorkOrderIds: prerequisites }),
  };
}

function readBrief(raw: unknown): AdoptLaneRequest['brief'] | null {
  const briefId = id(own(raw, 'briefId'));
  const briefText = text(own(raw, 'briefText'), MAX_BRIEF_TEXT_LENGTH);
  const digest = own(raw, 'expectedBriefDigest');
  const prosePath = text(own(raw, 'prosePath'), MAX_REF_LENGTH);
  const manifestPath = text(own(raw, 'manifestPath'), MAX_REF_LENGTH);
  const reviewerModel = text(own(raw, 'reviewerModel'), MAX_ID_LENGTH);
  const acceptanceSpec = own(raw, 'acceptanceSpec');
  if (
    briefId === null || briefText === null || typeof digest !== 'string' || !SHA256.test(digest) ||
    prosePath === null || manifestPath === null || reviewerModel === null || acceptanceSpec === NONE
  ) {
    return null;
  }
  return { briefId, briefText, expectedBriefDigest: digest, prosePath, manifestPath, reviewerModel, acceptanceSpec };
}

function readAttempt(raw: unknown): AdoptLaneRequest['attempt'] | null {
  const attemptId = own(raw, 'attemptId');
  const endedAtIso = own(raw, 'endedAtIso');
  const sessionId = own(raw, 'sessionId');
  const runner = readRunner(own(raw, 'runner'));
  if (
    typeof attemptId !== 'string' || !ATTEMPT_ID.test(attemptId) || !isZonedIsoDateTime(endedAtIso) ||
    runner === null ||
    !(sessionId === NONE || sessionId === undefined || sessionId === null || text(sessionId, MAX_ID_LENGTH) !== null)
  ) {
    return null;
  }
  return {
    attemptId, endedAtIso,
    ...(typeof sessionId === 'string' || sessionId === null ? { sessionId } : {}),
    ...(runner === undefined ? {} : { runner }),
  };
}

function readRun(raw: unknown): AdoptLaneRequest['run'] | null {
  const runId = own(raw, 'runId');
  const tier = own(raw, 'tier');
  const seatPlanRef = own(raw, 'seatPlanRef');
  const policy = text(own(raw, 'runPolicyRevision'), MAX_ID_LENGTH);
  const branch = own(raw, 'branchName');
  if (
    typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId) || (tier !== 1 && tier !== 2) ||
    typeof seatPlanRef !== 'string' || !SHA256.test(seatPlanRef) || policy === null ||
    !(branch === NONE || branch === undefined || text(branch, MAX_REF_LENGTH) !== null)
  ) {
    return null;
  }
  return {
    runId, tier: tier as LaneRunTier, seatPlanRef, runPolicyRevision: policy,
    ...(typeof branch === 'string' ? { branchName: branch } : {}),
  };
}

function readPlanRef(raw: unknown, projectId: string, laneId: string): AdoptLaneRequest['planRef'] | null {
  const planId = id(own(raw, 'planId'));
  if (planId === null || own(raw, 'projectId') !== projectId || own(raw, 'laneId') !== laneId) return null;
  return { projectId, planId, laneId };
}

/** The typed request, or `invalid-request`. Secret and digest checks come after (`checkAdoptLaneText`). */
function readAdoptLaneRequest(input: unknown): AdoptLaneRequest | null {
  try {
    const planDigest = own(input, 'planDigest');
    const laneId = id(own(input, 'laneId'));
    const projectId = id(own(input, 'projectId'));
    const baseBranch = parseBaseBranch(own(input, 'baseBranch'));
    const nowIso = own(input, 'nowIso');
    const deadline = own(input, 'deadlineIso');
    if (
      typeof planDigest !== 'string' || !PLAN_DIGEST.test(planDigest) || laneId === null || projectId === null ||
      baseBranch === undefined || !isZonedIsoDateTime(nowIso) ||
      !(deadline === NONE || deadline === undefined || isZonedIsoDateTime(deadline))
    ) {
      return null;
    }
    const planRef = readPlanRef(own(input, 'planRef'), projectId, laneId);
    const workOrder = readWorkOrder(own(input, 'workOrder'));
    const brief = readBrief(own(input, 'brief'));
    const attempt = readAttempt(own(input, 'attempt'));
    const run = readRun(own(input, 'run'));
    const source = readSource(own(input, 'source'));
    if (planRef === null || workOrder === null || brief === null || attempt === null || run === null || source === null) {
      return null;
    }
    return {
      planDigest, laneId, projectId, planRef, baseBranch, workOrder, brief, attempt, run, source, nowIso,
      ...(typeof deadline === 'string' ? { deadlineIso: deadline } : {}),
    };
  } catch {
    return null;
  }
}

function secretShaped(value: string): boolean {
  return containsSecretShape(value) || LANE_DIFF_SECRET_PATTERNS.some((pattern) => new RegExp(pattern.regex.source, pattern.regex.flags.replace('g', '')).test(value));
}

/** `secret-detected` when any string input that reaches a store or the journal is secret-shaped. */
function checkAdoptLaneText(request: AdoptLaneRequest): AdoptLaneRefusalReason | null {
  const strings: string[] = [
    request.brief.briefText, request.workOrder.taskId, request.workOrder.repository,
    request.brief.prosePath, request.brief.manifestPath, request.brief.reviewerModel,
    request.brief.briefId, request.workOrder.workOrderId, request.workOrder.policyRevision,
    request.run.runPolicyRevision, ...(request.workOrder.prerequisiteWorkOrderIds ?? []),
    ...request.workOrder.ownedPaths,
    // Ids and refs that key the journal and every record: lane, project, plan, attempt, run, base branch.
    // Hex-only fields (plan digest, commits, tree digest, seat plan ref, brief digest) cannot hold a secret shape.
    request.laneId, request.projectId, request.planRef.planId, request.planRef.projectId, request.planRef.laneId,
    request.attempt.attemptId, request.run.runId, request.baseBranch,
  ];
  // Every string `attemptRecord` persists: the session id and the runner's text fields.
  const { sessionId, runner } = request.attempt;
  if (typeof sessionId === 'string') strings.push(sessionId);
  if (runner !== undefined) {
    for (const field of [runner.host, runner.agent, runner.model, runner.variant]) {
      if (typeof field === 'string') strings.push(field);
    }
  }
  if (request.run.branchName !== undefined) strings.push(request.run.branchName);
  if (request.source.kind === 'save-ref') strings.push(request.source.saveRef);
  else strings.push(request.source.branchName);
  return strings.some(secretShaped) ? 'secret-detected' : null;
}

export interface AdoptLaneDependencies {
  readonly workOrderRepo: WorkOrderRepositoryPort;
  readonly attemptRepo: AttemptRepositoryPort;
  readonly runRepo: LaneRunRepositoryPort;
  readonly runJournal: LaneRunJournalPort;
  readonly cutoverJournal: CutoverJournalPort;
  readonly computeDigest: (content: string) => string;
  /** A ULID for each journal entry. */
  readonly mintEntryId: () => string;
  /** Live clock for the deadline check; falls back to `request.nowIso`. */
  readonly now?: () => string;
}

/** A stop that is not an error: the use case returns it as its result. */
class Halt extends Error {
  constructor(readonly result: AdoptLaneResult) {
    super('halt');
  }
}

const refuse = (reason: AdoptLaneRefusalReason): Halt => new Halt({ outcome: 'refused', reason });
const unknown = (reason: AdoptLaneUnknownReason): Halt => new Halt({ outcome: 'unknown', reason });

interface StepState {
  readonly hasIntent: boolean;
  readonly final: CutoverJournalEntry | null;
}

type Journal = ReadonlyMap<string, readonly CutoverJournalEntry[]>;

function isFinal(entry: CutoverJournalEntry): boolean {
  return entry.kind === 'result' && entry.outcome !== undefined && entry.outcome !== 'ambiguous';
}

function pathsOverlap(left: string, right: string): boolean {
  if (left === right) return !isSharedAppendPath(left);
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export class AdoptLaneUseCase implements AdoptLanePort {
  constructor(private readonly deps: AdoptLaneDependencies) {}

  async adoptLane(request: AdoptLaneRequest): Promise<AdoptLaneResult> {
    return this.execute(request);
  }

  /** The call being served (a per-call instance, so overlapping calls never share it). */
  private context: { request: AdoptLaneRequest; completed: AdoptLaneStep[]; current: AdoptLaneStep } | null = null;

  async execute(input: unknown): Promise<AdoptLaneResult> {
    try {
      const request = readAdoptLaneRequest(input);
      if (request === null) return { outcome: 'refused', reason: 'invalid-request' };
      const secret = checkAdoptLaneText(request);
      if (secret !== null) return { outcome: 'refused', reason: secret };
      this.verifyBrief(request);
      const call = new AdoptLaneUseCase(this.deps);
      call.context = { request, completed: [], current: 'work-order' };
      return await call.adopt(request);
    } catch (error) {
      return error instanceof Halt ? error.result : { outcome: 'unknown', reason: 'adoption-unknown' };
    }
  }

  /** The digest is only verified, never recomputed into a replacement; the package must be valid. */
  private verifyBrief(request: AdoptLaneRequest): void {
    const { brief } = request;
    let digest: string;
    try {
      digest = this.deps.computeDigest(brief.briefText);
    } catch {
      throw refuse('brief-digest-mismatch');
    }
    if (digest !== brief.expectedBriefDigest) throw refuse('brief-digest-mismatch');
    const spec = AcceptanceSpec.create(brief.acceptanceSpec);
    if (!spec.success || spec.value === undefined) throw refuse('invalid-brief');
    const pkg = BriefPackage.create({
      attemptId: request.attempt.attemptId,
      briefDigest: brief.expectedBriefDigest,
      prosePath: brief.prosePath,
      manifestPath: brief.manifestPath,
      baseCommit: request.workOrder.baseCommit,
      policyRevision: request.workOrder.policyRevision,
      independentReviewer: brief.reviewerModel,
      ownedPaths: request.workOrder.ownedPaths,
      acceptanceSpec: spec.value,
    });
    if (!pkg.success) throw refuse('invalid-brief');
  }

  /** Before every outbound operation: past the deadline, stop with the steps done so far. */
  private checkDeadline(): void {
    const context = this.context;
    if (context !== null && this.exhausted(context.request)) {
      throw new Halt({ outcome: 'budget-exhausted', completedSteps: [...context.completed], nextStep: context.current });
    }
  }

  private async adopt(request: AdoptLaneRequest): Promise<AdoptLaneResult> {
    const journal = await this.readJournal(request);
    const states = new Map<AdoptLaneStep, StepState>();
    for (const step of ADOPT_LANE_STEPS) states.set(step, stepState(journal, adoptLaneStepKey(request.planDigest, request.laneId, step)));
    const identity = this.identityDigest(request);
    this.checkRecordedResults(request, states, identity);
    const allDone = ADOPT_LANE_STEPS.every((step) => states.get(step)?.final?.outcome === 'completed');
    if (allDone) {
      await this.verifyReused(request);
      return this.adopted(request, true);
    }
    this.checkSource(request, journal);
    await this.checkNoRun(request, states.get('run')?.hasIntent === true);
    const completed = this.context?.completed ?? [];
    for (const step of ADOPT_LANE_STEPS) {
      const state = states.get(step) as StepState;
      if (state.final?.outcome === 'completed') {
        completed.push(step);
        continue;
      }
      if (this.context !== null) this.context.current = step;
      await this.runStep(request, step, state, identity);
      completed.push(step);
    }
    return this.adopted(request, false);
  }

  private adopted(request: AdoptLaneRequest, reused: boolean): AdoptLaneResult {
    return {
      outcome: 'adopted',
      reused,
      workOrderId: request.workOrder.workOrderId,
      briefDigest: request.brief.expectedBriefDigest,
      attemptId: request.attempt.attemptId,
      runId: request.run.runId,
      commitOid: request.source.commitOid,
      enteredState: 'collecting',
      provenance: 'adopted',
    };
  }

  private exhausted(request: AdoptLaneRequest): boolean {
    if (request.deadlineIso === undefined) return false;
    let current: string;
    try {
      current = this.deps.now?.() ?? request.nowIso;
    } catch {
      return true;
    }
    const currentMs = Date.parse(current);
    const deadlineMs = Date.parse(request.deadlineIso);
    return Number.isNaN(currentMs) || Number.isNaN(deadlineMs) || currentMs >= deadlineMs;
  }

  private async readJournal(request: AdoptLaneRequest): Promise<Journal> {
    this.checkDeadline();
    let listed;
    try {
      listed = await this.deps.cutoverJournal.listByKeyPrefix(`relaunch/${request.planDigest}/${request.laneId}/`);
    } catch {
      throw unknown('cutover-journal-unreadable');
    }
    if (listed.outcome !== 'listed') throw unknown('cutover-journal-unreadable');
    const byKey = new Map<string, CutoverJournalEntry[]>();
    for (const entry of listed.entries) {
      const list = byKey.get(entry.key) ?? [];
      list.push(entry);
      byKey.set(entry.key, list);
    }
    return byKey;
  }

  /** A recorded result for another brief digest or commit means this call is not a repeat of that adoption. */
  private checkRecordedResults(request: AdoptLaneRequest, states: Map<AdoptLaneStep, StepState>, identity: string): void {
    const brief = states.get('brief')?.final;
    if (brief?.outcome === 'completed' && brief.digest !== request.brief.expectedBriefDigest) {
      throw refuse('idempotency-conflict');
    }
    const attempt = states.get('attempt')?.final;
    if (attempt?.outcome === 'completed' && attempt.commitId !== request.source.commitOid) {
      throw refuse('idempotency-conflict');
    }
    // The work-order, attempt and run results carry the digest of the ids this adoption wrote (work order,
    // brief, attempt, run, plan, lane, project); a repeat with other ids is not a repeat.
    for (const step of ['work-order', 'attempt', 'run'] as const) {
      const final = states.get(step)?.final;
      if (final?.outcome === 'completed' && final.digest !== identity) throw refuse('idempotency-conflict');
    }
    for (const state of states.values()) {
      if (state.final?.outcome === 'refused') throw refuse('idempotency-conflict');
    }
  }

  /** One digest over every id a step of this adoption writes; journals hold digests, never the ids. */
  private identityDigest(request: AdoptLaneRequest): string {
    return this.deps.computeDigest(JSON.stringify([
      'adopt-lane-ids/1', request.projectId, request.planRef.planId, request.laneId, request.workOrder.workOrderId,
      request.brief.briefId, request.attempt.attemptId, request.run.runId,
    ]));
  }

  /** A full repeat: every recorded id must still be in its store; the collecting entry is re-ensured. */
  private async verifyReused(request: AdoptLaneRequest): Promise<void> {
    const order = await this.guard('work-order-store-unavailable', () =>
      this.deps.workOrderRepo.findWorkOrderById(request.workOrder.workOrderId));
    const attempt = await this.guard('attempt-store-unavailable', () =>
      this.deps.attemptRepo.findAttemptById(request.attempt.attemptId));
    const run = await this.guard('lane-run-store-unavailable', () => this.deps.runRepo.get(request.run.runId));
    if (order === null || attempt === null || run === null) throw refuse('idempotency-conflict');
    if (attempt.workOrderId !== order.id || run.workOrderId !== order.id || run.attemptIds[0] !== attempt.id) {
      throw refuse('idempotency-conflict');
    }
    await this.ensureCollecting(request);
  }

  /** The journaled save, or the caller's clean-commit facts; unknown stays unknown. */
  private checkSource(request: AdoptLaneRequest, journal: Journal): void {
    const { source } = request;
    if (source.kind === 'clean-commit') {
      if (source.dirtyCount === 'unknown') throw unknown('dirty-state-unknown');
      if (source.commitOnBranch === 'unknown') throw unknown('branch-fact-unknown');
      if (source.dirtyCount !== 0) throw refuse('worktree-dirty');
      const since = source.commitsSinceBase;
      // The commit must be on THIS run's branch, not on some other branch of the repository.
      const laneBranch = request.run.branchName ?? `fleet/${request.run.runId}`;
      if (
        source.branchName !== laneBranch ||
        source.commitOnBranch !== true || source.commitOid === request.workOrder.baseCommit ||
        (since !== undefined && (since.length === 0 || !since.includes(source.commitOid)))
      ) {
        throw refuse('commit-not-on-branch');
      }
      return;
    }
    const entries = journal.get(adoptLaneSaveKey(request.planDigest, request.laneId)) ?? [];
    if (entries.length === 0) throw refuse('save-missing');
    const final = entries.find(isFinal);
    const refOk = /^refs\/fleet\/saved\/[A-Za-z0-9._/-]{1,120}$/.test(source.saveRef) && !source.saveRef.includes('..') &&
      !source.saveRef.includes('//') && !source.saveRef.endsWith('/') && !source.saveRef.endsWith('.lock');
    if (
      !refOk || final === undefined || final.outcome !== 'completed' || final.saveRef !== source.saveRef ||
      final.commitId !== source.commitOid || final.digest !== source.treeDigest
    ) {
      throw refuse('save-unverified');
    }
  }

  /** A lane that already has a run is refused, unless the run is this adoption's own (an interrupted pass). */
  private async checkNoRun(request: AdoptLaneRequest, runStepStarted: boolean): Promise<void> {
    const runs = await this.guard('lane-run-store-unavailable', () => this.deps.runRepo.list());
    const orders = await this.guard('work-order-store-unavailable', () =>
      this.deps.workOrderRepo.listWorkOrdersByProject(request.projectId));
    const laneOrderIds = new Set<string>([request.workOrder.workOrderId]);
    for (const order of orders) {
      if (order.planRef?.planId === request.planRef.planId && order.planRef.laneId === request.laneId) laneOrderIds.add(order.id);
    }
    const existing = runs.filter((run) => run.runId === request.run.runId || laneOrderIds.has(run.workOrderId));
    const own = (run: LaneRunRecord): boolean =>
      runStepStarted && run.runId === request.run.runId && run.workOrderId === request.workOrder.workOrderId &&
      run.attemptIds[0] === request.attempt.attemptId && run.provenance === 'adopted';
    if (existing.some((run) => !own(run))) throw refuse('lane-already-has-run');
  }

  private async runStep(request: AdoptLaneRequest, step: AdoptLaneStep, state: StepState, identity: string): Promise<void> {
    const key = adoptLaneStepKey(request.planDigest, request.laneId, step);
    if (step === 'work-order') await this.workOrderStep(request, key, state, identity);
    else if (step === 'brief') await this.briefStep(request, key, state);
    else if (step === 'attempt') await this.attemptStep(request, key, state, identity);
    else await this.runStepRun(request, key, state, identity);
  }

  private async workOrderStep(request: AdoptLaneRequest, key: string, state: StepState, identity: string): Promise<void> {
    const wo = request.workOrder;
    const existing = await this.guard('work-order-store-unavailable', () => this.deps.workOrderRepo.findWorkOrderById(wo.workOrderId));
    if (existing !== null) {
      if (!this.sameWorkOrder(existing, request)) throw refuse('work-order-conflict');
    } else {
      await this.checkWorkOrderFree(request);
    }
    await this.intent(key, state, request.nowIso);
    if (existing === null) {
      await this.guard('work-order-store-unavailable', () => this.deps.workOrderRepo.saveWorkOrder(this.workOrderRecord(request)));
    }
    await this.result(key, request.nowIso, { reasonCode: 'registered', digest: identity });
  }

  private async checkWorkOrderFree(request: AdoptLaneRequest): Promise<void> {
    const wo = request.workOrder;
    const orders = await this.guard('work-order-store-unavailable', () =>
      this.deps.workOrderRepo.listWorkOrdersByProject(request.projectId));
    for (const order of orders) {
      if (order.id === wo.workOrderId || order.state === 'merged' || order.state === 'stopped') continue;
      if (order.ownedPaths.some((owned) => wo.ownedPaths.some((path) => pathsOverlap(path, owned)))) {
        throw refuse('owned-path-conflict');
      }
    }
    for (const prerequisiteId of wo.prerequisiteWorkOrderIds ?? []) {
      const found = await this.guard('work-order-store-unavailable', () => this.deps.workOrderRepo.findWorkOrderById(prerequisiteId));
      if (found === null) throw refuse('work-order-conflict');
    }
  }

  private workOrderRecord(request: AdoptLaneRequest): WorkOrderRecord {
    const wo = request.workOrder;
    return {
      id: wo.workOrderId,
      projectId: request.projectId,
      taskId: wo.taskId,
      laneId: request.laneId,
      repository: wo.repository,
      baseCommit: wo.baseCommit,
      ownedPaths: [...wo.ownedPaths],
      policyRevision: wo.policyRevision,
      risk: wo.risk ?? resolveWorkOrderRisk({}),
      prerequisiteWorkOrderIds: [...(wo.prerequisiteWorkOrderIds ?? [])],
      state: 'implementing',
      revision: 1,
      createdAtIso: request.nowIso,
      updatedAtIso: request.nowIso,
      planRef: { ...request.planRef },
      baseBranch: request.baseBranch,
    };
  }

  /** Every immutable field of a work order written by an interrupted pass must match this request. */
  private sameWorkOrder(existing: WorkOrderRecord, request: AdoptLaneRequest): boolean {
    const wanted = this.workOrderRecord(request);
    return (
      existing.projectId === wanted.projectId && existing.taskId === wanted.taskId && existing.laneId === wanted.laneId &&
      existing.repository === wanted.repository && existing.baseCommit === wanted.baseCommit &&
      existing.policyRevision === wanted.policyRevision && sameList(existing.ownedPaths, wanted.ownedPaths) &&
      sameList(existing.prerequisiteWorkOrderIds, wanted.prerequisiteWorkOrderIds) &&
      resolveWorkOrderRisk(existing) === resolveWorkOrderRisk(wanted) &&
      existing.planRef?.projectId === request.planRef.projectId && existing.planRef.planId === request.planRef.planId &&
      existing.planRef.laneId === request.planRef.laneId && existing.baseBranch === wanted.baseBranch
    );
  }

  /** The brief was verified and frozen unchanged before any write; this step records that fact. */
  private async briefStep(request: AdoptLaneRequest, key: string, state: StepState): Promise<void> {
    await this.intent(key, state, request.nowIso);
    await this.result(key, request.nowIso, { reasonCode: 'frozen', digest: request.brief.expectedBriefDigest });
  }

  private async attemptStep(request: AdoptLaneRequest, key: string, state: StepState, identity: string): Promise<void> {
    const { attempt, workOrder } = request;
    const existing = await this.guard('attempt-store-unavailable', () => this.deps.attemptRepo.findAttemptById(attempt.attemptId));
    const others = await this.guard('attempt-store-unavailable', () => this.deps.attemptRepo.listAttemptsByWorkOrder(workOrder.workOrderId));
    if (others.some((other) => other.id !== attempt.attemptId)) throw refuse('attempt-conflict');
    if (existing !== null && !this.sameAttempt(existing, request)) throw refuse('attempt-conflict');
    await this.intent(key, state, request.nowIso);
    if (existing === null) {
      await this.guard('attempt-store-unavailable', () => this.deps.attemptRepo.saveAttempt(this.attemptRecord(request)));
    }
    await this.result(key, request.nowIso, { reasonCode: 'recorded', digest: identity, commitId: request.source.commitOid });
  }

  private attemptRecord(request: AdoptLaneRequest): AttemptRecord {
    const { attempt, source, workOrder, brief } = request;
    const since = source.kind === 'clean-commit' && source.commitsSinceBase !== undefined ? [...source.commitsSinceBase] : [source.commitOid];
    return {
      id: attempt.attemptId,
      workOrderId: workOrder.workOrderId,
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      // No worktree exists yet: a fixed relative token, never a host path.
      worktreePath: `adopted/${attempt.attemptId}`,
      baseCommit: workOrder.baseCommit,
      state: 'ended',
      revision: 0,
      outcome: 'partial',
      briefDigest: brief.expectedBriefDigest,
      briefPackagePath: brief.manifestPath,
      sessionId: attempt.sessionId ?? null,
      completionReceipt: null,
      // The commit the attempt ended at, without a sealed manifest: reads as "artifacts not collected".
      artifacts: { headCommit: source.commitOid, commitsSinceBase: since, collectedArtifactPaths: [], notes: 'missing' },
      ...(attempt.runner === undefined ? {} : { runner: attempt.runner }),
      reviewerSeat: null,
      createdAtIso: request.nowIso,
      updatedAtIso: attempt.endedAtIso,
    };
  }

  private sameAttempt(existing: AttemptRecord, request: AdoptLaneRequest): boolean {
    return (
      existing.workOrderId === request.workOrder.workOrderId && existing.kind === 'initial' && existing.fixNumber === 0 &&
      existing.state === 'ended' && existing.outcome === 'partial' &&
      existing.briefDigest === request.brief.expectedBriefDigest && existing.baseCommit === request.workOrder.baseCommit &&
      existing.artifacts?.headCommit === request.source.commitOid
    );
  }

  private async runStepRun(request: AdoptLaneRequest, key: string, state: StepState, identity: string): Promise<void> {
    const { run } = request;
    await this.intent(key, state, request.nowIso);
    const existing = await this.guard('lane-run-store-unavailable', () => this.deps.runRepo.get(run.runId));
    if (existing === null) {
      const created = await this.guard('lane-run-store-unavailable', () => this.deps.runRepo.create(this.runRecord(request)));
      if (created.outcome !== 'saved') {
        const reread = await this.guard('lane-run-store-unavailable', () => this.deps.runRepo.get(run.runId));
        if (reread === null || reread.attemptIds[0] !== request.attempt.attemptId) throw refuse('lane-already-has-run');
      }
    } else if (existing.attemptIds[0] !== request.attempt.attemptId || existing.workOrderId !== request.workOrder.workOrderId) {
      throw refuse('lane-already-has-run');
    }
    await this.ensureCollecting(request);
    await this.result(key, request.nowIso, { reasonCode: 'entered-collecting', digest: identity });
  }

  private runRecord(request: AdoptLaneRequest): LaneRunRecord {
    const { run } = request;
    return {
      version: 1,
      runId: run.runId,
      workOrderId: request.workOrder.workOrderId,
      tier: run.tier,
      seatPlanRef: run.seatPlanRef,
      cursors: { 'first-pass': null, fix: null, review: null },
      round: 0,
      attemptIds: [request.attempt.attemptId],
      prNumber: null,
      parked: null,
      parkCount: 0,
      lease: null,
      revision: 1,
      runPolicyRevision: run.runPolicyRevision,
      branchName: run.branchName ?? `fleet/${run.runId}`,
      baseBranch: request.baseBranch,
      provenance: 'adopted',
      schemaVersion: 1,
    };
  }

  /** Appends the conduct entry into `collecting` once; a journal that already left `ready` is left alone. */
  private async ensureCollecting(request: AdoptLaneRequest): Promise<void> {
    const runId = request.run.runId;
    const entries = await this.guard('run-journal-unavailable', () => this.deps.runJournal.listForRun(runId));
    if (entries.some((entry) => entry.kind === 'conduct' && entry.state === 'collecting')) return;
    if (laneRunJournalState(entries, runId) !== 'ready' || !canEnterInitialLaneRunState('adopted', 'collecting')) {
      throw refuse('lane-already-has-run');
    }
    const appended = await this.guard('run-journal-unavailable', () =>
      this.deps.runJournal.append({
        version: LANE_RUN_JOURNAL_ENTRY_VERSION,
        entryId: this.deps.mintEntryId(),
        kind: 'conduct',
        key: null,
        runId,
        recordedAtIso: request.nowIso,
        mode: null,
        expectedRevision: null,
        mintedId: null,
        outcome: null,
        reasonCode: null,
        detail: null,
        grantId: null,
        state: 'collecting',
      }));
    if (appended.outcome !== 'appended') throw unknown('run-journal-unavailable');
  }

  /** Records the intent unless an interrupted pass already did; a refused duplicate counts as recorded. */
  private async intent(key: string, state: StepState, nowIso: string): Promise<void> {
    if (state.hasIntent) return;
    const outcome = await this.append({ key, kind: 'intent', entryId: '', recordedAtIso: nowIso });
    if (outcome !== 'appended' && outcome !== 'duplicate-intent') throw unknown('journal-append-failed');
  }

  private async result(key: string, nowIso: string, fields: Pick<CutoverJournalEntry, 'reasonCode' | 'digest' | 'commitId'>): Promise<void> {
    const outcome = await this.append({ key, kind: 'result', entryId: '', recordedAtIso: nowIso, outcome: 'completed', ...fields });
    if (outcome !== 'appended') throw unknown('journal-append-failed');
  }

  private async append(entry: CutoverJournalEntry): Promise<string> {
    this.checkDeadline();
    try {
      const appended = await this.deps.cutoverJournal.append({ ...entry, entryId: this.deps.mintEntryId() });
      return appended.outcome === 'appended' ? 'appended' : appended.reason;
    } catch {
      return 'unavailable';
    }
  }

  /** A store call whose throw is `unknown`, never a pass. */
  private async guard<T>(reason: AdoptLaneUnknownReason, call: () => Promise<T>): Promise<T> {
    this.checkDeadline();
    try {
      return await call();
    } catch {
      throw unknown(reason);
    }
  }
}

function stepState(journal: Journal, key: string): StepState {
  const entries = journal.get(key) ?? [];
  return {
    hasIntent: entries.some((entry) => entry.kind === 'intent'),
    final: entries.find(isFinal) ?? null,
  };
}
