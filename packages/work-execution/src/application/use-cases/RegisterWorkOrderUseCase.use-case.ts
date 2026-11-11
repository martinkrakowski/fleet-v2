// Implemented for migration step 2 — registration only, no dispatch authority.
/**
 * RegisterWorkOrderUseCase: record one approved bounded work unit with its
 * base commit, owned paths, policy revision and prerequisites. Recording is
 * registration, not dispatch: invalid input, duplicate identities, missing
 * prerequisites are rejected explicitly and authorize nothing. The risk label
 * is recorded at registration (absent = high) and is never changed afterwards.
 *
 * Overlap admission (PT1ca): owned paths that overlap an active work order or
 * an open pull request on the base branch (not bound to this work order) are
 * refused, naming only the blocker id and the code of the first overlapping
 * path. With a held store the refused registration is kept as `held`; a forge
 * read that fails or cannot be trusted refuses `overlap-unknown` and neither
 * admits nor holds. Nothing here ever echoes a path or a secret-shaped value.
 */

import {
  DEFAULT_WORK_ORDER_RISK,
  parseWorkOrderRisk,
} from '../../domain/execution-records.js';
import type { PlanRef, WorkOrderRecord } from '../../domain/execution-records.js';
import type { BaseBranchValue } from '../../domain/base-branch.js';
import {
  DEFAULT_BASE_BRANCH,
  parseBaseBranch,
} from '../../domain/base-branch.js';
import {
  HOLD_INTENT_ID_PATTERN,
  ID_TOKEN_PATTERN,
  MAX_OPEN_PRS_FOR_OVERLAP_CHECK,
  MAX_OWNED_PATHS,
  MAX_PREREQUISITE_WORK_ORDER_IDS,
  computeRegisterWorkOrderRequestDigest,
  containsAnySecretPattern,
  findFirstOverlappingOwnedPathCode,
  parseForgeRepositoryCoordinates,
  parsePullRequestTitle,
  pureSha256Hex,
  readDenseUnknownArray,
  screenBriefRequestRef,
  screenRepoRelativePath,
} from '../../domain/held-work-order.js';
import type {
  HeldWorkOrderRecord,
  HeldWorkOrderRequestSnapshot,
  OverlapBlockerKind,
} from '../../domain/held-work-order.js';
import { snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import type {
  RegisterWorkOrderPort,
  RegisterWorkOrderRequest,
  RegisterWorkOrderResult,
} from '../ports/in/RegisterWorkOrderPort.in-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { ForgeReadPort } from '../ports/out/ForgeReadPort.out-port.js';
import type { HeldWorkOrderRepositoryPort } from '../ports/out/HeldWorkOrderRepositoryPort.out-port.js';
import type { LanePlanRepositoryPort } from '../ports/out/LanePlanRepositoryPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { ProjectProfileReadPort } from '../ports/out/ProjectProfileReadPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';

export interface RegisterWorkOrderDependencies {
  readonly workOrderRepo: WorkOrderRepositoryPort;
  /**
   * When present, a new work order requires an active profile for its
   * projectId (decision D4). Both composition roots pass it; it stays
   * optional only for unit tests that exercise the work-order rules alone.
   */
  readonly profileRead?: ProjectProfileReadPort;
  /**
   * When present, an optional plan link is verified against the lane-plan
   * store: the plan must exist and name the lane (current id or alias).
   * It stays optional for unit tests that exercise the work-order rules
   * alone.
   */
  readonly lanePlanRepo?: LanePlanRepositoryPort;
  /**
   * When present, owned paths are also checked against the changed files of
   * every open pull request on the base branch that is not bound to this work
   * order. Absent, only active work orders are checked.
   */
  readonly forgeRead?: ForgeReadPort;
  /** When present, an overlap-refused registration is kept as held instead of dropped. */
  readonly heldWorkOrderRepo?: HeldWorkOrderRepositoryPort;
  /** Runs, attempts and journal entries bind a pull request to a work order. */
  readonly runRepo?: Pick<LaneRunRepositoryPort, 'list'>;
  readonly attemptRepo?: Pick<AttemptRepositoryPort, 'listAttemptsByWorkOrder'>;
  readonly executionJournal?: Pick<ExecutionJournalPort, 'listJournalEntriesForAttempt'>;
  /** The request digest function; defaults to the pure SHA-256 of the domain. */
  readonly computeDigest?: (text: string) => string;
  /** Milliseconds clock for the overlap-check budget; defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Budget of the whole open-pull-request check (default 30000, clamped to 1..120000). */
  readonly overlapCheckBudgetMs?: number;
  readonly maxOpenPullRequestsChecked?: number;
  /** Optional sink for attention codes recorded during registration (ids and codes only). */
  readonly recordAttentionCode?: (code: string) => Promise<void> | void;
  readonly recordAttention?: (code: string) => Promise<void> | void;
  readonly recordAttentionItem?: (body: unknown, actor: string) => Promise<unknown>;
}

const DEFAULT_OVERLAP_CHECK_BUDGET_MS = 30_000;
const MAX_OVERLAP_CHECK_BUDGET_MS = 120_000;
const MAX_ID_LENGTH = 128;
const MAX_REPOSITORY_LENGTH = 256;
const MAX_TIMESTAMP_LENGTH = 64;

const REQUEST_KEYS: readonly string[] = [
  'workOrderId',
  'projectId',
  'taskId',
  'laneId',
  'repository',
  'baseCommit',
  'ownedPaths',
  'policyRevision',
  'prerequisiteWorkOrderIds',
  'risk',
  'nowIso',
  'baseBranch',
  'planId',
  'planLaneId',
  'planProjectId',
  'supersedesWorkOrderId',
  'briefRequestRef',
  'intentId',
  'pullRequestTitle',
];

const REQUIRED_STRING_FIELDS = [
  'workOrderId',
  'projectId',
  'taskId',
  'laneId',
  'repository',
  'baseCommit',
  'policyRevision',
] as const;

const INVALID_REQUEST: RegisterWorkOrderResult = { outcome: 'refused', reason: 'invalid-request' };
const OVERLAP_UNKNOWN: RegisterWorkOrderResult = { outcome: 'refused', reason: 'overlap-unknown' };
const STORE_UNAVAILABLE: RegisterWorkOrderResult = { outcome: 'refused', reason: 'store-unavailable' };

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Terminal work orders no longer claim their paths against new lanes. */
function isActiveWorkOrder(state: WorkOrderRecord['state']): boolean {
  return state !== 'merged' && state !== 'stopped';
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A stored path read leniently for the overlap check: trimmed, no trailing slash, never empty. */
function normalizeStoredPath(path: unknown): string | null {
  if (typeof path !== 'string') {
    return null;
  }
  let normalized = path.trim();
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized === '' ? null : normalized;
}

/**
 * The payload's base branch: `main` when the key is absent, the parsed string
 * when it parses, and a rejection otherwise (CB1). The value is stored on the
 * record every time, including the default.
 */
type RegisteredBaseBranch =
  | { readonly accepted: true; readonly value: BaseBranchValue }
  | { readonly accepted: false };

function registeredBaseBranch(request: RegisterWorkOrderRequest): RegisteredBaseBranch {
  // An explicit `undefined` (a CLI flag omitted via `optStr`) is absent, the
  // same as a missing key.
  if (request.baseBranch === undefined) {
    return { accepted: true, value: DEFAULT_BASE_BRANCH };
  }
  const parsed = parseBaseBranch(request.baseBranch);
  if (parsed === undefined) {
    return { accepted: false };
  }
  return { accepted: true, value: parsed };
}

/** A string field that is absent or a bounded string free of secret shapes; anything else is untrustworthy. */
function isCleanOptionalString(value: unknown, maxLength: number): boolean {
  if (value === undefined) {
    return true;
  }
  return typeof value === 'string' && value.length <= maxLength && !containsAnySecretPattern(value);
}

/** An id that is echoed into a message: a plain token, or empty (left to the required-field check). */
function isCleanIdToken(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return trimmed === '' || (trimmed.length <= MAX_ID_LENGTH && ID_TOKEN_PATTERN.test(trimmed) && !containsAnySecretPattern(trimmed));
}

/**
 * The request as a plain copy, or `null` when it cannot be trusted: not a
 * plain object, an unknown key, a getter, a wrong-typed, over-long or
 * secret-shaped field, a sparse or over-long array, or an unscreened brief
 * reference or intent id. Empty strings and absent fields pass through: the
 * required-field rejections below keep deciding those. Never throws.
 */
function readRegisterRequest(request: unknown): RegisterWorkOrderRequest | null {
  const snapshot = snapshotPlainDataRecord(request);
  if (snapshot === null || Object.keys(snapshot).some((key) => !REQUEST_KEYS.includes(key))) {
    return null;
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    const maxLength = field === 'repository' ? MAX_REPOSITORY_LENGTH : MAX_ID_LENGTH;
    if (!isCleanOptionalString(snapshot[field], maxLength)) {
      return null;
    }
  }
  if (!isCleanIdToken(snapshot.workOrderId) || !isCleanIdToken(snapshot.projectId)) {
    return null;
  }
  if (!isCleanIdToken(snapshot.supersedesWorkOrderId) && typeof snapshot.supersedesWorkOrderId === 'string') {
    return null;
  }
  if (!isCleanOptionalString(snapshot.nowIso, MAX_TIMESTAMP_LENGTH)) {
    return null;
  }
  // The plan link is decided by `resolvePlanLink`, which is total over any value; only a string is screened here.
  for (const field of ['planId', 'planLaneId', 'planProjectId'] as const) {
    const value = snapshot[field];
    if (typeof value === 'string' && (value.length > MAX_ID_LENGTH || containsAnySecretPattern(value))) {
      return null;
    }
  }
  if (typeof snapshot.supersedesWorkOrderId === 'string' && snapshot.supersedesWorkOrderId.length > MAX_ID_LENGTH) {
    return null;
  }
  if (snapshot.briefRequestRef !== undefined && screenBriefRequestRef(snapshot.briefRequestRef) === null) {
    return null;
  }
  if (
    snapshot.intentId !== undefined &&
    (typeof snapshot.intentId !== 'string' ||
      !HOLD_INTENT_ID_PATTERN.test(snapshot.intentId) ||
      containsAnySecretPattern(snapshot.intentId))
  ) {
    return null;
  }
  let ownedPaths: readonly unknown[] | undefined;
  if (snapshot.ownedPaths !== undefined) {
    const read = readDenseUnknownArray(snapshot.ownedPaths, MAX_OWNED_PATHS);
    if (read === null || read.some((entry) => typeof entry !== 'string')) {
      return null;
    }
    ownedPaths = read;
  }
  let prerequisites: readonly unknown[] | undefined;
  if (snapshot.prerequisiteWorkOrderIds !== undefined) {
    const read = readDenseUnknownArray(snapshot.prerequisiteWorkOrderIds, MAX_PREREQUISITE_WORK_ORDER_IDS);
    if (read === null || !read.every((entry) => isCleanIdToken(entry) && typeof entry === 'string')) {
      return null;
    }
    prerequisites = read;
  }
  return {
    ...snapshot,
    ...(ownedPaths !== undefined ? { ownedPaths } : {}),
    ...(prerequisites !== undefined ? { prerequisiteWorkOrderIds: prerequisites } : {}),
  } as unknown as RegisterWorkOrderRequest;
}

type BlockerRef =
  | { readonly kind: 'active-work-order'; readonly workOrderId: string }
  | { readonly kind: 'open-pr'; readonly pullRequestNumber: number };

/** What the overlap checks and the hold share for one registration. */
interface OverlapContext {
  readonly workOrderId: string;
  readonly requestDigest: string;
  readonly intentId: string;
  readonly briefRequestRef: string | null;
  readonly snapshot: HeldWorkOrderRequestSnapshot;
  readonly nowIso: string;
  readonly ownedPaths: readonly string[];
}

export class RegisterWorkOrderUseCase implements RegisterWorkOrderPort {
  constructor(private readonly deps?: RegisterWorkOrderDependencies) {}

  async registerWorkOrder(rawRequest: RegisterWorkOrderRequest): Promise<RegisterWorkOrderResult> {
    if (!this.deps) {
      throw new Error('Not implemented: RegisterWorkOrderUseCase');
    }
    const deps = this.deps;

    const request = readRegisterRequest(rawRequest);
    if (request === null) {
      return INVALID_REQUEST;
    }

    // An optional pull-request title is decided before the missing-field check
    // and before any repository, profile, forge or held-store call: a present
    // value must parse, or the whole request is refused and nothing is written.
    let pullRequestTitle: string | undefined;
    if (Object.hasOwn(request, 'pullRequestTitle') && request.pullRequestTitle !== undefined) {
      const parsedTitle = parsePullRequestTitle(request.pullRequestTitle);
      if (!parsedTitle.ok) {
        return { outcome: 'refused', reason: 'invalid-pull-request-title' };
      }
      pullRequestTitle = parsedTitle.title;
    }

    const requiredFields: readonly (keyof RegisterWorkOrderRequest)[] = [
      'workOrderId',
      'projectId',
      'taskId',
      'laneId',
      'repository',
      'baseCommit',
      'policyRevision',
    ];
    const missingFields = requiredFields.filter((field) => !isNonEmpty(request[field]));
    if (missingFields.length > 0) {
      return { outcome: 'rejected', reason: `Missing required work order fields: ${missingFields.join(', ')}` };
    }
    if (!Array.isArray(request.ownedPaths) || request.ownedPaths.length === 0) {
      return { outcome: 'rejected', reason: 'Work order must own at least one path' };
    }
    if (request.ownedPaths.some((path) => !isNonEmpty(path))) {
      return { outcome: 'rejected', reason: 'Work order owned paths must be non-empty strings' };
    }
    const normalizedOwnedPaths: string[] = [];
    for (const path of request.ownedPaths) {
      const screened = screenRepoRelativePath(path);
      if (screened === null) {
        return INVALID_REQUEST;
      }
      normalizedOwnedPaths.push(screened);
    }

    // Plan A5: an absent label is high risk; any other value is refused, never guessed.
    const risk =
      request.risk === undefined ? DEFAULT_WORK_ORDER_RISK : parseWorkOrderRisk(request.risk);
    if (risk === undefined) {
      return INVALID_REQUEST;
    }

    // CB1: the base branch is decided before any store access; an unparsable
    // value is rejected with its reason code and nothing is written.
    const baseBranchDecision = registeredBaseBranch(request);
    if (!baseBranchDecision.accepted) {
      return { outcome: 'rejected', reason: 'invalid-base-branch' };
    }

    // One trimmed id for the profile check, the conflict listing and the save.
    const projectId = request.projectId.trim();

    // The optional plan link (WB4a) is decided before any later store access:
    // both fields or neither, the caller's planProjectId — when present — must
    // equal the work order's own project, and a configured lane-plan repo
    // verifies the plan and lane exist. A refusal writes nothing.
    const planLink = await this.resolvePlanLink(request, projectId);
    if (!planLink.ok) {
      return { outcome: 'rejected', reason: planLink.reason };
    }

    if (deps.profileRead) {
      const profile = await deps.profileRead.readProjectProfile(projectId);
      if (profile === null) {
        return {
          outcome: 'rejected',
          reason: `project ${projectId} has no profile; register it with 'fleet-v2 projects add', or 'fleet-v2 projects adopt' when it already has work orders`,
        };
      }
      if (profile.status !== 'active') {
        return {
          outcome: 'rejected',
          reason: `project ${projectId} is retired; it accepts no new work orders — register the work under a new project id`,
        };
      }
    }

    const existingById = await deps.workOrderRepo.findWorkOrderById(request.workOrderId);
    if (existingById !== null) {
      return { outcome: 'rejected', reason: `Work order already registered: ${request.workOrderId}` };
    }

    const existing = await deps.workOrderRepo.listWorkOrdersByProject(projectId);

    // Lineage (WO-1): a new work order may name the terminal work order it supersedes. Validated
    // after the duplicate-id check and the project listing, before the path-overlap loop; the
    // listing above is the full candidate set for the "already superseded" scan because a
    // successor is always in its parent's project.
    if (request.supersedesWorkOrderId !== undefined) {
      const supersededId =
        typeof request.supersedesWorkOrderId === 'string'
          ? request.supersedesWorkOrderId.trim()
          : '';
      if (supersededId === '') {
        return {
          outcome: 'rejected',
          reason: 'supersedesWorkOrderId must be a non-empty string',
        };
      }
      if (supersededId === request.workOrderId.trim()) {
        return { outcome: 'rejected', reason: 'A work order cannot supersede itself' };
      }
      const superseded = await deps.workOrderRepo.findWorkOrderById(supersededId);
      if (superseded === null) {
        return {
          outcome: 'rejected',
          reason: `Superseded work order not found: ${supersededId}`,
        };
      }
      if (superseded.projectId !== projectId) {
        return {
          outcome: 'rejected',
          reason: `Superseded work order is in another project: ${supersededId}`,
        };
      }
      if (superseded.state !== 'stopped' && superseded.state !== 'merged') {
        return {
          outcome: 'rejected',
          reason: `Superseded work order is not terminal: ${supersededId} (${superseded.state})`,
        };
      }
      const priorSuccessor = existing.find(
        (order) => order.supersedesWorkOrderId === supersededId,
      );
      if (priorSuccessor !== undefined) {
        return {
          outcome: 'rejected',
          reason: `Work order ${supersededId} is already superseded by ${priorSuccessor.id}`,
        };
      }
    }

    const prerequisites = request.prerequisiteWorkOrderIds ?? [];
    const digestFn = deps.computeDigest ?? pureSha256Hex;
    const briefRequestRef = request.briefRequestRef ?? null;
    const snapshot: HeldWorkOrderRequestSnapshot = {
      projectId,
      taskId: request.taskId,
      laneId: request.laneId,
      repository: request.repository,
      baseCommit: request.baseCommit,
      ownedPaths: normalizedOwnedPaths,
      policyRevision: request.policyRevision,
      risk,
      baseBranch: baseBranchDecision.value,
      prerequisiteWorkOrderIds: [...prerequisites],
      ...(planLink.planRef !== undefined ? { planRef: planLink.planRef } : {}),
      ...(request.supersedesWorkOrderId !== undefined
        ? { supersedesWorkOrderId: request.supersedesWorkOrderId.trim() }
        : {}),
      ...(pullRequestTitle !== undefined ? { pullRequestTitle } : {}),
    };
    const requestDigest = computeRegisterWorkOrderRequestDigest(
      request.workOrderId,
      snapshot,
      briefRequestRef,
      digestFn,
    );
    const nowIso = request.nowIso ?? new Date().toISOString();
    const context: OverlapContext = {
      workOrderId: request.workOrderId,
      requestDigest,
      intentId: request.intentId ?? `hold-${requestDigest.slice(0, 24)}`,
      briefRequestRef,
      snapshot,
      nowIso,
      ownedPaths: normalizedOwnedPaths,
    };

    // F129: a replayed intent or a held registration with a changed request is
    // refused here, before any forge call and before anything is written.
    const heldCheck = await this.checkHeldStore(context);
    if (heldCheck.refusal !== null) {
      return heldCheck.refusal;
    }

    const activeOrders = existing
      .filter((order) => isActiveWorkOrder(order.state))
      .sort((left, right) => compareCodeUnits(left.id, right.id));
    for (const order of activeOrders) {
      const orderPaths: string[] = [];
      for (const owned of order.ownedPaths) {
        const normalized = normalizeStoredPath(owned);
        if (normalized !== null) {
          orderPaths.push(normalized);
        }
      }
      const pathCode = findFirstOverlappingOwnedPathCode(normalizedOwnedPaths, orderPaths, digestFn);
      if (pathCode !== null) {
        return this.holdAndRefuse(context, { kind: 'active-work-order', workOrderId: order.id }, pathCode);
      }
    }

    for (const prerequisiteId of prerequisites) {
      const prerequisite = await deps.workOrderRepo.findWorkOrderById(prerequisiteId);
      if (!prerequisite) {
        return { outcome: 'rejected', reason: `Missing prerequisite work order: ${prerequisiteId}` };
      }
    }

    if (deps.forgeRead !== undefined) {
      const refusal = await this.checkOpenPullRequests(context, deps.forgeRead, digestFn);
      if (refusal !== null) {
        return refusal;
      }
    }

    const record: WorkOrderRecord = {
      id: request.workOrderId,
      projectId,
      taskId: request.taskId,
      laneId: request.laneId,
      repository: request.repository,
      baseCommit: request.baseCommit,
      ownedPaths: [...request.ownedPaths],
      policyRevision: request.policyRevision,
      risk,
      baseBranch: baseBranchDecision.value,
      prerequisiteWorkOrderIds: [...prerequisites],
      ...(planLink.planRef !== undefined ? { planRef: planLink.planRef } : {}),
      ...(request.supersedesWorkOrderId !== undefined
        ? { supersedesWorkOrderId: request.supersedesWorkOrderId.trim() }
        : {}),
      ...(pullRequestTitle !== undefined ? { pullRequestTitle } : {}),
      state: 'approved',
      revision: 1,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    };
    try {
      await deps.workOrderRepo.saveWorkOrder(record);
    } catch {
      return STORE_UNAVAILABLE;
    }
    if (heldCheck.heldRecord !== null && deps.heldWorkOrderRepo !== undefined) {
      try {
        await deps.heldWorkOrderRepo.deleteHeldWorkOrder(request.workOrderId, requestDigest);
      } catch {
        // The work order is registered; a stale held entry is left for the next pass to clear.
      }
    }
    return { outcome: 'registered', workOrder: record };
  }

  /**
   * The upfront F129 read of the held store: an intent id or a work order id
   * already used with a different request digest is refused, and an unreadable
   * store is `store-unavailable`.
   */
  private async checkHeldStore(
    context: OverlapContext,
  ): Promise<{ readonly refusal: RegisterWorkOrderResult | null; readonly heldRecord: HeldWorkOrderRecord | null }> {
    const heldRepo = this.deps?.heldWorkOrderRepo;
    if (heldRepo === undefined) {
      return { refusal: null, heldRecord: null };
    }
    let byIntent;
    let byWorkOrder;
    try {
      byIntent = await heldRepo.findByIntentId(context.intentId);
      byWorkOrder = await heldRepo.findByWorkOrderId(context.workOrderId);
    } catch {
      return { refusal: STORE_UNAVAILABLE, heldRecord: null };
    }
    if (byIntent.outcome === 'unreadable' || byWorkOrder.outcome === 'unreadable') {
      return { refusal: STORE_UNAVAILABLE, heldRecord: null };
    }
    if (
      byIntent.outcome === 'found' &&
      (byIntent.record.workOrderId !== context.workOrderId || byIntent.record.requestDigest !== context.requestDigest)
    ) {
      return { refusal: { outcome: 'refused', reason: 'intent-digest-mismatch' }, heldRecord: null };
    }
    if (byWorkOrder.outcome === 'found') {
      const record = byWorkOrder.record;
      if (record.stage === 'intent' && (record.requestDigest !== context.requestDigest || record.intentId !== context.intentId)) {
        return { refusal: { outcome: 'refused', reason: 'intent-digest-mismatch' }, heldRecord: null };
      }
      if (record.stage === 'held' && record.requestDigest !== context.requestDigest) {
        return { refusal: { outcome: 'refused', reason: 'held-request-mismatch' }, heldRecord: null };
      }
      return { refusal: null, heldRecord: record };
    }
    return { refusal: null, heldRecord: null };
  }

  /**
   * The open-pull-request half of the overlap check: `null` when no open pull
   * request on the base branch (other than one bound to this work order)
   * touches an owned path. Every unknown — a read that fails, times out, is
   * oversized or unscreened, a budget that runs out — refuses `overlap-unknown`
   * and neither admits nor holds.
   */
  private async checkOpenPullRequests(
    context: OverlapContext,
    forgeRead: ForgeReadPort,
    digestFn: (text: string) => string,
  ): Promise<RegisterWorkOrderResult | null> {
    const deps = this.deps;
    const repository = parseForgeRepositoryCoordinates(context.snapshot.repository);
    if (repository === null || typeof forgeRead.readPullRequestChangedFiles !== 'function') {
      return OVERLAP_UNKNOWN;
    }
    const configuredBudget = deps?.overlapCheckBudgetMs;
    if (configuredBudget !== undefined && !(configuredBudget > 0)) {
      return OVERLAP_UNKNOWN;
    }
    const budgetMs = Math.min(
      MAX_OVERLAP_CHECK_BUDGET_MS,
      Math.max(1, configuredBudget ?? DEFAULT_OVERLAP_CHECK_BUDGET_MS),
    );
    const clock = deps?.clock ?? Date.now;
    const deadlineMs = clock() + budgetMs;

    const bound = await this.boundPullRequestNumbers(context.workOrderId, repository);
    if (bound === null) {
      return OVERLAP_UNKNOWN;
    }

    const remainingForList = deadlineMs - clock();
    if (!(remainingForList > 0)) {
      return OVERLAP_UNKNOWN;
    }
    let listed;
    try {
      listed = await forgeRead.listOpenPullRequestsByBase({
        base: context.snapshot.baseBranch,
        repository,
        timeoutMs: remainingForList,
      });
    } catch {
      return OVERLAP_UNKNOWN;
    }
    const maxChecked = deps?.maxOpenPullRequestsChecked ?? MAX_OPEN_PRS_FOR_OVERLAP_CHECK;
    if (listed.outcome !== 'listed' || listed.pullRequests.length > maxChecked) {
      return OVERLAP_UNKNOWN;
    }
    const candidates = listed.pullRequests
      .filter((pullRequest) => !bound.has(pullRequest.number))
      .sort((left, right) => left.number - right.number);
    for (const pullRequest of candidates) {
      const remainingMs = deadlineMs - clock();
      if (!(remainingMs > 0)) {
        return OVERLAP_UNKNOWN;
      }
      let files;
      try {
        files = await forgeRead.readPullRequestChangedFiles({
          pullRequestNumber: pullRequest.number,
          repository,
          timeoutMs: remainingMs,
        });
      } catch {
        return OVERLAP_UNKNOWN;
      }
      if (files.outcome !== 'found') {
        return OVERLAP_UNKNOWN;
      }
      const pathCode = findFirstOverlappingOwnedPathCode(context.ownedPaths, files.files, digestFn);
      if (pathCode !== null) {
        return this.holdAndRefuse(
          context,
          { kind: 'open-pr', pullRequestNumber: pullRequest.number },
          pathCode,
        );
      }
    }
    return null;
  }

  /**
   * The pull request numbers already bound to this work order by a lane run or
   * a forge journal entry of one of its attempts; `null` when a read fails.
   */
  private async boundPullRequestNumbers(
    workOrderId: string,
    repository: { readonly owner: string; readonly repo: string },
  ): Promise<Set<number> | null> {
    const deps = this.deps;
    const bound = new Set<number>();
    try {
      if (deps?.runRepo !== undefined) {
        for (const run of await deps.runRepo.list()) {
          if (run.workOrderId === workOrderId && typeof run.prNumber === 'number') {
            bound.add(run.prNumber);
          }
        }
      }
      if (deps?.attemptRepo !== undefined && deps.executionJournal !== undefined) {
        for (const attempt of await deps.attemptRepo.listAttemptsByWorkOrder(workOrderId)) {
          for (const entry of await deps.executionJournal.listJournalEntriesForAttempt(attempt.id)) {
            if (entry.workOrderId !== workOrderId || entry.pullRequest === undefined) {
              continue;
            }
            const named = parseForgeRepositoryCoordinates(entry.pullRequest.repository);
            const sameRepository =
              named !== null &&
              named.owner.toLowerCase() === repository.owner.toLowerCase() &&
              named.repo.toLowerCase() === repository.repo.toLowerCase();
            if (sameRepository) {
              bound.add(entry.pullRequest.number);
            }
          }
        }
      }
    } catch {
      return null;
    }
    return bound;
  }

  /**
   * Keep the overlap-refused registration as held (intent first, then settled)
   * and answer the typed refusal; without a held store it is answered
   * `held: false`. Never saves the work order.
   */
  private async holdAndRefuse(
    context: OverlapContext,
    blocker: BlockerRef,
    pathCode: string,
  ): Promise<RegisterWorkOrderResult> {
    const blockerKind: OverlapBlockerKind = blocker.kind;
    const blockerId = blocker.kind === 'open-pr' ? String(blocker.pullRequestNumber) : blocker.workOrderId;
    let held = false;
    const heldRepo = this.deps?.heldWorkOrderRepo;
    const isLegacyActiveId =
      blocker.kind === 'active-work-order' && !ID_TOKEN_PATTERN.test(blockerId);

    if (isLegacyActiveId) {
      try {
        if (this.deps?.recordAttentionCode !== undefined) {
          await this.deps.recordAttentionCode('hold-skipped-invalid-blocker-id');
        } else if (this.deps?.recordAttention !== undefined) {
          await this.deps.recordAttention('hold-skipped-invalid-blocker-id');
        } else if (this.deps?.recordAttentionItem !== undefined) {
          await this.deps.recordAttentionItem(
            {
              projectId: context.snapshot.projectId,
              kind: 'hold-skipped-invalid-blocker-id',
              subject: { kind: 'work-order', ref: context.workOrderId },
              workOrderId: context.workOrderId,
              summary: 'hold-skipped-invalid-blocker-id',
            },
            'work-execution',
          );
        }
      } catch {
        // Attention recording failure does not block or throw
      }
    } else if (heldRepo !== undefined) {
      const record: HeldWorkOrderRecord = {
        version: 1,
        stage: 'intent',
        intentId: context.intentId,
        workOrderId: context.workOrderId,
        requestDigest: context.requestDigest,
        briefRequestRef: context.briefRequestRef,
        blockerKind,
        blockerId,
        pathCode,
        heldAtIso: context.nowIso,
      };
      try {
        const recorded = await heldRepo.recordHoldIntent(record);
        if (recorded.outcome === 'refused') {
          return recorded.reason === 'invalid-record'
            ? INVALID_REQUEST
            : recorded.reason === 'store-full'
              ? STORE_UNAVAILABLE
              : { outcome: 'refused', reason: recorded.reason };
        }
        if (recorded.outcome === 'already-held') {
          held = true;
        } else {
          const completed = await heldRepo.completeHoldIntent({
            intentId: context.intentId,
            workOrderId: context.workOrderId,
            requestDigest: context.requestDigest,
          });
          if (completed.outcome === 'refused') {
            return completed.reason === 'intent-digest-mismatch'
              ? { outcome: 'refused', reason: 'intent-digest-mismatch' }
              : STORE_UNAVAILABLE;
          }
          held = true;
        }
      } catch {
        return STORE_UNAVAILABLE;
      }
    }
    if (blocker.kind === 'open-pr') {
      return {
        outcome: 'refused',
        reason: 'open-pr-overlap',
        pullRequestNumber: blocker.pullRequestNumber,
        blockerKind: 'open-pr',
        blockerId,
        pathCode,
        held,
        requestDigest: context.requestDigest,
      };
    }
    return {
      outcome: 'refused',
      reason: 'active-work-order-overlap',
      blockerKind: 'active-work-order',
      blockerId,
      pathCode,
      held,
      requestDigest: context.requestDigest,
    };
  }

  /**
   * The optional plan link (WB4a): absent fields keep the record planRef-less
   * exactly as today; both fields must be present and non-empty; `planProjectId`
   * must equal the work order's own project; a configured lane-plan repo
   * verifies the plan exists and names the lane (current id or alias).
   */
  private async resolvePlanLink(
    request: RegisterWorkOrderRequest,
    projectId: string,
  ): Promise<
    | { readonly ok: true; readonly planRef?: PlanRef }
    | { readonly ok: false; readonly reason: string }
  > {
    if (
      request.planId === undefined &&
      request.planLaneId === undefined &&
      request.planProjectId === undefined
    ) {
      return { ok: true };
    }
    if (
      request.planProjectId !== undefined &&
      (typeof request.planProjectId !== 'string' || request.planProjectId !== projectId)
    ) {
      return { ok: false, reason: 'plan-project-mismatch' };
    }
    const planId = typeof request.planId === 'string' ? request.planId.trim() : '';
    const laneId = typeof request.planLaneId === 'string' ? request.planLaneId.trim() : '';
    if (planId === '' || laneId === '') {
      return { ok: false, reason: 'plan-ref-incomplete' };
    }
    const lanePlanRepo = this.deps?.lanePlanRepo;
    if (lanePlanRepo !== undefined) {
      const plan = await lanePlanRepo.findLanePlan(projectId, planId);
      if (plan === null) {
        return { ok: false, reason: 'plan-not-found' };
      }
      const lane = plan.lanes.find(
        (candidate) => candidate.laneId === laneId || candidate.aliases.includes(laneId),
      );
      if (lane === undefined) {
        return { ok: false, reason: 'lane-not-found' };
      }
    }
    return { ok: true, planRef: { projectId, planId, laneId } };
  }

  async execute(input?: unknown): Promise<RegisterWorkOrderResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: RegisterWorkOrderUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a rejection.
    if (!input || typeof input !== 'object') {
      throw new Error('Not implemented: RegisterWorkOrderUseCase');
    }
    return this.registerWorkOrder(input as RegisterWorkOrderRequest);
  }
}
