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
 * admits nor holds. A held record for the same work order whose request no
 * longer matches is superseded only once its recorded blocker is proven
 * released and the changed request reaches a recorded outcome; unknown is
 * never released. Nothing here ever echoes a path or a secret-shaped value.
 */

import {
  DEFAULT_WORK_ORDER_RISK,
  parseWorkOrderRisk,
} from '../../domain/execution-records.js';
import type { PlanRef, WorkOrderRecord } from '../../domain/execution-records.js';
import {
  DEFAULT_BASE_BRANCH,
  parseBaseBranch,
  resolveProfileDefaultBranch,
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
  SupersededHeldWorkOrder,
} from '../ports/in/RegisterWorkOrderPort.in-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { ForgeReadPort } from '../ports/out/ForgeReadPort.out-port.js';
import type {
  HeldWorkOrderRepositoryPort,
  RecordHoldIntentResult,
} from '../ports/out/HeldWorkOrderRepositoryPort.out-port.js';
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

/** The stale-held notice for a superseded record: ids and codes only. */
type HoldAttempt =
  | { readonly ok: true; readonly supersededHeld: SupersededHeldWorkOrder | undefined }
  | { readonly ok: false; readonly answer: RegisterWorkOrderResult };

interface HoldProgress {
  staleMayBeGone: boolean;
  replacementMayExist: boolean;
}

function recordRefusalAnswer(
  reason: Extract<RecordHoldIntentResult, { readonly outcome: 'refused' }>['reason'],
): RegisterWorkOrderResult {
  if (reason === 'invalid-record') {
    return INVALID_REQUEST;
  }
  if (reason === 'store-full') {
    return STORE_UNAVAILABLE;
  }
  return { outcome: 'refused', reason };
}

function supersededNotice(record: HeldWorkOrderRecord): SupersededHeldWorkOrder {
  return {
    requestDigest: record.requestDigest,
    blockerKind: record.blockerKind,
    blockerId: record.blockerId,
    heldAtIso: record.heldAtIso,
  };
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
  | { accepted: true; value: string; fromProfile: boolean }
  | { accepted: false };

function registeredBaseBranch(request: RegisterWorkOrderRequest): RegisteredBaseBranch {
  // An explicit `undefined` (a CLI flag omitted via `optStr`) is absent, the
  // same as a missing key. It is marked `fromProfile` so an active profile's
  // `defaultBranch` may decide it later (RP1); with no profile read it stays `main`.
  if (request.baseBranch === undefined) {
    return { accepted: true, value: DEFAULT_BASE_BRANCH, fromProfile: true };
  }
  const parsed = parseBaseBranch(request.baseBranch);
  if (parsed === undefined) {
    return { accepted: false };
  }
  return { accepted: true, value: parsed, fromProfile: false };
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
  /** The same-work-order held record whose request no longer matches; proven released. */
  readonly staleRecord: HeldWorkOrderRecord | null;
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
      let profile: Awaited<ReturnType<typeof deps.profileRead.readProjectProfile>>;
      try {
        profile = await deps.profileRead.readProjectProfile(projectId);
      } catch {
        return { outcome: 'refused', reason: 'malformed-profile' };
      }
      if (profile === undefined) {
        return { outcome: 'refused', reason: 'malformed-profile' };
      }
      if (profile === null) {
        return {
          outcome: 'rejected',
          reason: `project ${projectId} has no profile; register it with 'fleet-v2 projects add', or 'fleet-v2 projects adopt' when it already has work orders`,
        };
      }
      if (baseBranchDecision.accepted && baseBranchDecision.fromProfile) {
        // RP1: with no explicit `request.baseBranch`, the active profile's
        // `defaultBranch` decides. A malformed profile or an unsafe declared
        // branch refuses the registration with a typed reason; nothing is written.
        const resolved = resolveProfileDefaultBranch(profile);
        if (!resolved.ok) {
          return { outcome: 'refused', reason: resolved.reason };
        }
        baseBranchDecision.fromProfile = false;
        baseBranchDecision.value = resolved.baseBranch;
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
    const baseContext: Omit<OverlapContext, 'staleRecord'> = {
      workOrderId: request.workOrderId,
      requestDigest,
      intentId: request.intentId ?? `hold-${requestDigest.slice(0, 24)}`,
      briefRequestRef,
      snapshot,
      nowIso,
      ownedPaths: normalizedOwnedPaths,
    };

    // F129: a replayed intent or a held registration with a changed request is
    // refused here, before any forge call and before anything is written. A
    // changed request whose recorded blocker is proven released supersedes the
    // stale record instead of refusing.
    const heldCheck = await this.checkHeldStore(baseContext);
    if (heldCheck.refusal !== null) {
      return heldCheck.refusal;
    }
    const context: OverlapContext = { ...baseContext, staleRecord: heldCheck.staleRecord };

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
    if (heldCheck.heldRecord !== null || heldCheck.staleRecord !== null) {
      const clearing = heldCheck.heldRecord ?? heldCheck.staleRecord;
      let supersededHeld: SupersededHeldWorkOrder | undefined;
      if (clearing !== null && deps.heldWorkOrderRepo !== undefined) {
        try {
          const deleted = await deps.heldWorkOrderRepo.deleteHeldWorkOrder(
            request.workOrderId,
            clearing.requestDigest,
          );
          if (heldCheck.staleRecord !== null && deleted.outcome === 'deleted') {
            supersededHeld = supersededNotice(heldCheck.staleRecord);
          }
        } catch {
          // The work order is registered; a stale held entry is left for the next pass to clear.
        }
      }
      return {
        outcome: 'registered',
        workOrder: record,
        ...(supersededHeld !== undefined ? { supersededHeld } : {}),
      };
    }
    return { outcome: 'registered', workOrder: record };
  }

  /**
   * The upfront F129 read of the held store: an intent id or a work order id
   * already used with a different request digest is refused, and an unreadable
   * store is `store-unavailable`. A changed request for the same work order
   * whose recorded blocker is proven released supersedes the stale record
   * instead of refusing.
   */
  private async checkHeldStore(
    context: Omit<OverlapContext, 'staleRecord'>,
  ): Promise<{
    readonly refusal: RegisterWorkOrderResult | null;
    readonly heldRecord: HeldWorkOrderRecord | null;
    readonly staleRecord: HeldWorkOrderRecord | null;
  }> {
    const heldRepo = this.deps?.heldWorkOrderRepo;
    if (heldRepo === undefined) {
      return { refusal: null, heldRecord: null, staleRecord: null };
    }
    let byIntent;
    let byWorkOrder;
    try {
      byIntent = await heldRepo.findByIntentId(context.intentId);
      byWorkOrder = await heldRepo.findByWorkOrderId(context.workOrderId);
    } catch {
      return { refusal: STORE_UNAVAILABLE, heldRecord: null, staleRecord: null };
    }
    if (byIntent.outcome === 'unreadable' || byWorkOrder.outcome === 'unreadable') {
      return { refusal: STORE_UNAVAILABLE, heldRecord: null, staleRecord: null };
    }
    if (
      byIntent.outcome === 'found' &&
      (byIntent.record.workOrderId !== context.workOrderId || byIntent.record.requestDigest !== context.requestDigest)
    ) {
      return {
        refusal: { outcome: 'refused', reason: 'intent-digest-mismatch' },
        heldRecord: null,
        staleRecord: null,
      };
    }
    if (byWorkOrder.outcome === 'found') {
      return this.resolveSameWorkOrderHeldRecord(byWorkOrder.record, context);
    }
    return { refusal: null, heldRecord: null, staleRecord: null };
  }

  private async resolveSameWorkOrderHeldRecord(
    record: HeldWorkOrderRecord,
    context: Omit<OverlapContext, 'staleRecord'>,
  ): Promise<{
    readonly refusal: RegisterWorkOrderResult | null;
    readonly heldRecord: HeldWorkOrderRecord | null;
    readonly staleRecord: HeldWorkOrderRecord | null;
  }> {
    const mismatch =
      record.requestDigest !== context.requestDigest ||
      (record.stage === 'intent' && record.intentId !== context.intentId);
    if (!mismatch) {
      return { refusal: null, heldRecord: record, staleRecord: null };
    }
    if (await this.heldBlockerReleased(record, context.snapshot.repository)) {
      return { refusal: null, heldRecord: null, staleRecord: record };
    }
    if (record.stage === 'intent') {
      return {
        refusal: { outcome: 'refused', reason: 'intent-digest-mismatch' },
        heldRecord: null,
        staleRecord: null,
      };
    }
    return {
      refusal: { outcome: 'refused', reason: 'held-request-mismatch' },
      heldRecord: null,
      staleRecord: null,
    };
  }

  /**
   * Whether the stale record's blocker is proven released: a terminal blocker
   * work order, or a merged/closed pull request read from the forge. Unknown
   * is never released; any failure or doubt answers `false`.
   */
  private async heldBlockerReleased(record: HeldWorkOrderRecord, repositoryText: string): Promise<boolean> {
    try {
      const deps = this.deps;
      if (deps === undefined) {
        return false;
      }
      if (record.blockerKind === 'active-work-order') {
        const blocker = await deps.workOrderRepo.findWorkOrderById(record.blockerId);
        return blocker !== null && blocker !== undefined && !isActiveWorkOrder(blocker.state);
      }
      if (record.blockerKind === 'open-pr') {
        const forgeRead = deps.forgeRead;
        if (
          forgeRead === undefined ||
          typeof forgeRead.readPullRequest !== 'function' ||
          parseForgeRepositoryCoordinates(repositoryText) === null
        ) {
          return false;
        }
        const number = Number(record.blockerId);
        if (!Number.isSafeInteger(number) || number < 1) {
          return false;
        }
        if (deps.overlapCheckBudgetMs !== undefined && !(deps.overlapCheckBudgetMs > 0)) {
          return false;
        }
        const repository = parseForgeRepositoryCoordinates(repositoryText)!;
        const timeoutMs = Math.min(
          MAX_OVERLAP_CHECK_BUDGET_MS,
          Math.max(1, deps.overlapCheckBudgetMs ?? DEFAULT_OVERLAP_CHECK_BUDGET_MS),
        );
        const read = await forgeRead.readPullRequest({ ref: { kind: 'number', number }, repository, timeoutMs });
        return (
          read.outcome === 'found' &&
          read.pullRequest.number === number &&
          (read.pullRequest.state === 'merged' || read.pullRequest.state === 'closed')
        );
      }
      return false;
    } catch {
      return false;
    }
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
   * `held: false`. Never saves the work order. The held store keys one record
   * per work order id, so a superseded stale record must be deleted before the
   * replacement can be recorded; if the replacement hold then fails, the
   * replacement intent is removed and the stale record restored, so the store
   * ends holding the replacement or the stale record, never neither. A
   * rollback that cannot be completed is answered `store-unavailable`.
   */
  private async holdAndRefuse(
    context: OverlapContext,
    blocker: BlockerRef,
    pathCode: string,
  ): Promise<RegisterWorkOrderResult> {
    const blockerKind: OverlapBlockerKind = blocker.kind;
    const blockerId = blocker.kind === 'open-pr' ? String(blocker.pullRequestNumber) : blocker.workOrderId;
    const heldRepo = this.deps?.heldWorkOrderRepo;
    let held = false;
    let supersededHeld: SupersededHeldWorkOrder | undefined;
    if (blocker.kind === 'active-work-order' && !ID_TOKEN_PATTERN.test(blockerId)) {
      await this.noteSkippedHold(context);
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
      const attempt = await this.holdWithRollback(heldRepo, context, record);
      if (!attempt.ok) {
        return attempt.answer;
      }
      held = true;
      supersededHeld = attempt.supersededHeld;
    }
    const common = {
      outcome: 'refused' as const,
      blockerKind,
      blockerId,
      pathCode,
      held,
      requestDigest: context.requestDigest,
      ...(supersededHeld !== undefined ? { supersededHeld } : {}),
    };
    return blocker.kind === 'open-pr'
      ? { ...common, reason: 'open-pr-overlap', pullRequestNumber: blocker.pullRequestNumber, blockerKind: 'open-pr' }
      : { ...common, reason: 'active-work-order-overlap', blockerKind: 'active-work-order' };
  }

  /** A legacy blocker id is never held; the skip is noted and never blocks or throws. */
  private async noteSkippedHold(context: OverlapContext): Promise<void> {
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
  }

  /**
   * Runs the hold; when it fails after a superseded stale record may have been
   * deleted, rolls the store back to the stale record. A rollback that does not
   * complete turns the answer into `store-unavailable`.
   */
  private async holdWithRollback(
    heldRepo: HeldWorkOrderRepositoryPort,
    context: OverlapContext,
    record: HeldWorkOrderRecord,
  ): Promise<HoldAttempt> {
    const progress: HoldProgress = { staleMayBeGone: false, replacementMayExist: false };
    let attempt: HoldAttempt;
    try {
      attempt = await this.holdSteps(heldRepo, context, record, progress);
    } catch {
      attempt = { ok: false, answer: STORE_UNAVAILABLE };
    }
    if (attempt.ok || !progress.staleMayBeGone || context.staleRecord === null) {
      return attempt;
    }
    const removed = progress.replacementMayExist
      ? await this.removeReplacement(heldRepo, context)
      : true;
    const restored = await this.restoreStaleHeld(heldRepo, context.staleRecord);
    return removed && restored ? attempt : { ok: false, answer: STORE_UNAVAILABLE };
  }

  /** The repository calls of a hold, in order: stale delete, replacement intent, completion. */
  private async holdSteps(
    heldRepo: HeldWorkOrderRepositoryPort,
    context: OverlapContext,
    record: HeldWorkOrderRecord,
    progress: HoldProgress,
  ): Promise<HoldAttempt> {
    let supersededHeld: SupersededHeldWorkOrder | undefined;
    if (context.staleRecord !== null) {
      progress.staleMayBeGone = true;
      const replaced = await this.replaceStaleHeld(heldRepo, context);
      if (!replaced.ok) {
        // A refused or unrecognised delete may still have landed (an adapter can
        // fail after writing), so the rollback looks the stale record up.
        return { ok: false, answer: STORE_UNAVAILABLE };
      }
      supersededHeld = replaced.notice;
      progress.staleMayBeGone = replaced.notice !== undefined;
    }
    progress.replacementMayExist = true;
    const recorded = await heldRepo.recordHoldIntent(record);
    if (recorded.outcome === 'refused') {
      progress.replacementMayExist = false;
      return { ok: false, answer: recordRefusalAnswer(recorded.reason) };
    }
    if (recorded.outcome !== 'recorded' && recorded.outcome !== 'already-held') {
      // Unrecognised or malformed: nothing was confirmed, so never report held.
      return { ok: false, answer: STORE_UNAVAILABLE };
    }
    if (recorded.outcome === 'already-held') {
      progress.replacementMayExist = false;
      return { ok: true, supersededHeld };
    }
    const completed = await heldRepo.completeHoldIntent({
      intentId: context.intentId,
      workOrderId: context.workOrderId,
      requestDigest: context.requestDigest,
    });
    if (completed.outcome === 'held') {
      return { ok: true, supersededHeld };
    }
    return {
      ok: false,
      answer:
        completed.outcome === 'refused' && completed.reason === 'intent-digest-mismatch'
          ? { outcome: 'refused', reason: 'intent-digest-mismatch' }
          : STORE_UNAVAILABLE,
    };
  }

  /**
   * Replaces the stale held record with the new hold: the record is deleted
   * first, guarded by its own digest, and only a `deleted` answer reports a
   * supersession. `not-found` continues silently (a replay already removed
   * it); any other answer is `ok: false` and a throw propagates.
   */
  private async replaceStaleHeld(
    heldRepo: HeldWorkOrderRepositoryPort,
    context: OverlapContext,
  ): Promise<{ readonly ok: true; readonly notice: SupersededHeldWorkOrder | undefined } | { readonly ok: false }> {
    const stale = context.staleRecord;
    if (stale === null) {
      return { ok: true, notice: undefined };
    }
    const deleted = await heldRepo.deleteHeldWorkOrder(context.workOrderId, stale.requestDigest);
    if (deleted.outcome === 'deleted') {
      return { ok: true, notice: supersededNotice(stale) };
    }
    if (deleted.outcome === 'not-found') {
      return { ok: true, notice: undefined };
    }
    return { ok: false };
  }

  /** Removes the replacement hold intent this call recorded, guarded by its own digest. */
  private async removeReplacement(
    heldRepo: HeldWorkOrderRepositoryPort,
    context: OverlapContext,
  ): Promise<boolean> {
    try {
      const removed = await heldRepo.deleteHeldWorkOrder(context.workOrderId, context.requestDigest);
      return removed.outcome === 'deleted' || removed.outcome === 'not-found';
    } catch {
      return false;
    }
  }

  /**
   * Puts the stale held record back exactly as it was: an intent-stage record is
   * re-recorded as itself, a held-stage record as its own intent and settled to
   * `held`. A record already present and identical counts as restored (the
   * delete never took effect); a different record in its place, or any refused
   * or thrown call, is `false`.
   */
  private async restoreStaleHeld(
    heldRepo: HeldWorkOrderRepositoryPort,
    stale: HeldWorkOrderRecord,
  ): Promise<boolean> {
    try {
      const present = await heldRepo.findByWorkOrderId(stale.workOrderId);
      if (present.outcome !== 'not-found') {
        return present.outcome === 'found' && JSON.stringify(present.record) === JSON.stringify(stale);
      }
      const asIntent = stale.stage === 'held' ? { ...stale, stage: 'intent' as const } : stale;
      const recorded = await heldRepo.recordHoldIntent(asIntent);
      if (recorded.outcome !== 'recorded' && recorded.outcome !== 'already-held') {
        return false;
      }
      if (stale.stage === 'intent') {
        return true;
      }
      const settled = await heldRepo.completeHoldIntent({
        intentId: stale.intentId,
        workOrderId: stale.workOrderId,
        requestDigest: stale.requestDigest,
      });
      return settled.outcome === 'held';
    } catch {
      return false;
    }
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
