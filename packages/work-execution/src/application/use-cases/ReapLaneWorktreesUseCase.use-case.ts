// @generated use-case scaffold — refined for EX-2b, reworked for C2'.
/**
 * ReapLaneWorktreesUseCase: on the operator's explicit request, list or
 * remove the clean worktree of every finished lane run. A candidate is a run
 * whose journal state is `merged` or `stopped`, whose work order is `merged`
 * or `stopped`, whose every attempt is `cancelled` or `collected`, and none
 * of whose attempts holds a reservation. Anything else is skipped with a
 * reason and never touched.
 *
 * C2': removal goes through `WorkspacePort.inspectWorktreeForRemoval` and
 * `WorkspacePort.removeWorktree`, one run at a time — destructive writes,
 * never parallel. `removeWorktree` is gated on the attempt's sealed artifact
 * manifest: an uncollected or tampered worktree is refused unless the
 * operator passes `forceUnsealed`, and even then the removal consumes a
 * scoped, one-way owner approval (`ActionAuthorizationPort`) and still runs
 * every clean, unlocked, in-progress and bounded-activity check inside the
 * adapter. The branch `fleet/<runId>` is the record of the run and is kept:
 * no branch command is ever issued. A dry run calls no removal and reports
 * the candidates as `removed` with a null tip.
 *
 * Every outbound store, journal, profile, workspace, artifact and
 * authorization call is guarded by a deadline (`storeCallTimeoutMs`) and a
 * `try/catch`: an unreadable read is a typed refusal, never a throw, never a
 * silent skip, and never a guessed empty answer.
 */

import { LANE_DIFF_SECRET_PATTERNS, containsSecretShape } from '@fleet/shared';
import type { ActionJournalEntryRecord, AttemptRecord, AttemptRunnerRecord, WorkOrderRecord } from '../../domain/execution-records.js';
import { attemptManifestCoordinates } from '../../domain/artifact-manifest.js';
import { isCalendarDateTime, snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import { laneRunJournalState, type LaneRunJournalEntryRecord } from '../../domain/lane-run-journal.js';
import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import { LANE_RUN_TERMINAL_STATES } from '../../domain/value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from '../../domain/value-objects/LaneRunState.vo.js';
import type { ActionAuthorizationPort } from '../ports/out/ActionAuthorizationPort.out-port.js';
import type { AttemptArtifactPort, VerifyArtifactManifestRequest } from '../ports/out/AttemptArtifactPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { ProjectProfileReadPort } from '../ports/out/ProjectProfileReadPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { WorkspacePort } from '../ports/out/WorkspacePort.out-port.js';
import { conductedRunnerOf } from './advance-lane-run/conducted-host.js';
import { journalsForRuns, type RunJournalRunReads } from './run-journal-reads.js';
import type {
  ReapLaneWorktreesPort,
  ReapLaneWorktreesRequest,
  ReapLaneWorktreesResult,
  ReapWorktreeJournalFailureEntry,
} from '../ports/in/ReapLaneWorktreesPort.in-port.js';

/** The reads and writes the reap needs; narrowed so composition supplies only what it has. */
export interface ReapLaneWorktreesDependencies {
  readonly workOrderRepo: Pick<WorkOrderRepositoryPort, 'findWorkOrderById'>;
  readonly attemptRepo: Pick<AttemptRepositoryPort, 'listAttemptsByWorkOrder'>;
  readonly runRepo: Pick<LaneRunRepositoryPort, 'list'>;
  readonly runJournal: RunJournalRunReads;
  readonly executionJournal: Pick<
    ExecutionJournalPort,
    'listActiveReservations' | 'appendJournalEntry' | 'listJournalEntriesForAttempt'
  >;
  /** Absent: any candidate that needs a clone is refused `not-configured`. */
  readonly profileRead?: ProjectProfileReadPort;
  /**
   * C2'. Absent (or without `inspectWorktreeForRemoval` / `removeWorktree`):
   * a removal is refused `not-configured`.
   */
  readonly workspace?: Pick<WorkspacePort, 'inspectWorktreeForRemoval' | 'removeWorktree'>;
  /** C2': the fail-closed artifact-manifest check for `--force-unsealed`. */
  readonly attemptArtifact?: Pick<AttemptArtifactPort, 'checkArtifactManifestForRemoval'>;
  /** C2': the scoped owner approval for `--force-unsealed`. */
  readonly actionAuthorization?: Pick<ActionAuthorizationPort, 'authorizeUnsealedWorktreeRemoval'>;
  /** Clock override; production uses the system clock. */
  readonly now?: () => string;
  /** C2': the deadline of one outbound store/journal/workspace call. Default 15 s. */
  readonly storeCallTimeoutMs?: number;
}

/** The default deadline of one outbound call. */
const DEFAULT_STORE_CALL_TIMEOUT_MS = 15_000;

/** The largest number of runs one reap pass scans; more is a refusal. */
const MAX_RUNS_PER_REAP = 4_096;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The marker a completed removal journal entry carries (keyed idempotence). */
function removalCompletedMarker(runId: string): string {
  return `branch ${branchForRun(runId)} kept at `;
}

/** The id of the crash-recoverable unsealed-removal intent entry. */
function unsealedIntentEntryId(attemptId: string, runId: string): string {
  return `${attemptId}:collect:reap-unsealed-intent:${runId}`;
}

/** The deadline guard: the call's own answer, or a throw when it runs past `timeoutMs`. */
class StoreCallTimeoutError extends Error {}

async function withBudget<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StoreCallTimeoutError('store call exceeded its budget')), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function isTerminalRun(state: LaneRunStateValue): boolean {
  return (LANE_RUN_TERMINAL_STATES as readonly LaneRunStateValue[]).includes(state);
}

function isTerminalWorkOrder(state: WorkOrderRecord['state']): boolean {
  return state === 'merged' || state === 'stopped';
}

/** The branch of a run's worktree (K7-D7): `fleet/<runId>`. */
function branchForRun(runId: string): string {
  return 'fleet/' + runId;
}

export class ReapLaneWorktreesUseCase implements ReapLaneWorktreesPort {
  constructor(private readonly deps?: ReapLaneWorktreesDependencies) {}

  async execute(input: unknown): Promise<ReapLaneWorktreesResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ReapLaneWorktreesUseCase');
    }
    // Fail safe: a missing input is an empty request, so the pinned EX-2b
    // defaulting (`execute(null)` is a dry run) stays exact. A primitive or
    // an unreadable input is a typed refusal.
    const request = input ?? {};
    return this.reapLaneWorktrees(request as ReapLaneWorktreesRequest);
  }

  async reapLaneWorktrees(request: ReapLaneWorktreesRequest): Promise<ReapLaneWorktreesResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ReapLaneWorktreesUseCase');
    }
    const refusal = reapRequestRefusal(request);
    if (refusal !== null) {
      return { outcome: 'refused', reason: refusal };
    }
    return this.reap(this.deps, request);
  }

  private async reap(
    deps: ReapLaneWorktreesDependencies,
    request: ReapLaneWorktreesRequest,
  ): Promise<ReapLaneWorktreesResult> {
    // Fail safe: only an explicit `dryRun: false` removes anything; a missing
    // or malformed value (an unchecked `execute` input) is a dry run.
    const dryRun = request.dryRun !== false;
    const forceUnsealed = request.forceUnsealed === true;
    const nowIso = request.nowIso ?? deps.now?.() ?? new Date().toISOString();
    const budget = deps.storeCallTimeoutMs ?? DEFAULT_STORE_CALL_TIMEOUT_MS;

    // Top-level reads are deadline-guarded and fail closed: an unreadable
    // store is `unknown`, never an empty scan.
    let runs: LaneRunRecord[];
    try {
      const listed = await withBudget(deps.runRepo.list(), budget);
      if (!Array.isArray(listed)) {
        return { outcome: 'unknown', reason: 'store-unreadable' };
      }
      if (listed.length > MAX_RUNS_PER_REAP) {
        return { outcome: 'refused', reason: 'invalid-request' };
      }
      runs = listed.filter(
        (run, index) => Object.hasOwn(listed, index) && isRecordObject(run),
      ) as LaneRunRecord[];
    } catch {
      return { outcome: 'unknown', reason: 'store-unreadable' };
    }
    let entriesByRun: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>;
    try {
      entriesByRun = await withBudget(
        journalsForRuns(deps.runJournal, runs.map((run) => run.runId)),
        budget,
      );
      if (!(entriesByRun instanceof Map)) {
        return { outcome: 'unknown', reason: 'store-unreadable' };
      }
    } catch {
      return { outcome: 'unknown', reason: 'store-unreadable' };
    }
    let heldAttemptIds: ReadonlySet<string>;
    try {
      const reservations = await withBudget(deps.executionJournal.listActiveReservations(), budget);
      if (!Array.isArray(reservations)) {
        return { outcome: 'unknown', reason: 'store-unreadable' };
      }
      heldAttemptIds = new Set(
        reservations
          .filter((reservation, index) => Object.hasOwn(reservations, index) && isRecordObject(reservation))
          .filter((reservation) => (reservation as { held?: unknown }).held === true)
          .map((reservation) => (reservation as { attemptId?: unknown }).attemptId)
          .filter((attemptId): attemptId is string => typeof attemptId === 'string'),
      );
    } catch {
      return { outcome: 'unknown', reason: 'store-unreadable' };
    }

    const removed: { readonly runId: string; readonly branchTip: string | null }[] = [];
    const alreadyRemoved: { readonly runId: string }[] = [];
    const refused: { readonly runId: string; readonly reason: string }[] = [];
    const skipped: { readonly runId: string; readonly reason: string }[] = [];
    const journalFailed: ReapWorktreeJournalFailureEntry[] = [];

    const workOrderCache = new Map<string, WorkOrderRecord | null>();
    const attemptsCache = new Map<string, readonly AttemptRecord[]>();
    const findWorkOrder = async (workOrderId: string): Promise<WorkOrderRecord | null> => {
      const cached = workOrderCache.get(workOrderId);
      if (cached !== undefined) {
        return cached;
      }
      const record = await withBudget(deps.workOrderRepo.findWorkOrderById(workOrderId), budget);
      workOrderCache.set(workOrderId, record);
      return record;
    };
    const listAttempts = async (workOrderId: string): Promise<readonly AttemptRecord[]> => {
      const cached = attemptsCache.get(workOrderId);
      if (cached !== undefined) {
        return cached;
      }
      const records = await withBudget(deps.attemptRepo.listAttemptsByWorkOrder(workOrderId), budget);
      attemptsCache.set(workOrderId, records);
      return records;
    };

    for (const run of runs) {
      const evaluation = await evaluateRunCandidate({
        deps,
        run,
        heldAttemptIds,
        findWorkOrder,
        listAttempts,
        entriesByRun,
        budget,
        skipped,
        refused,
      });
      if (evaluation.outcome !== 'candidate') {
        continue;
      }
      await reapCandidateWorktree({
        deps,
        run,
        latestAttempt: evaluation.latestAttempt,
        workOrder: evaluation.workOrder,
        clone: evaluation.clone,
        recordedHost: evaluation.recordedHost,
        dryRun,
        forceUnsealed,
        nowIso,
        budget,
        removed,
        alreadyRemoved,
        refused,
        journalFailed,
      });
    }

    const byRunId = (a: { readonly runId: string }, b: { readonly runId: string }): number =>
      byCodeUnit(a.runId, b.runId);
    removed.sort(byRunId);
    alreadyRemoved.sort(byRunId);
    refused.sort(byRunId);
    skipped.sort(byRunId);
    journalFailed.sort(byRunId);

    return { outcome: 'reaped', dryRun, removed, alreadyRemoved, refused, skipped, journalFailed };
  }
}

/** True when `value` is a plain object (never an array, never null). */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * C2': the strict runtime-input guard. A null, a non-object, an unreadable
 * (throwing-getter) request, a non-boolean `forceUnsealed` or a malformed
 * `nowIso` is refused; a missing `nowIso` is fine (the clock answers).
 */
function reapRequestRefusal(input: unknown): 'invalid-request' | null {
  let snap: Record<string, unknown> | null;
  try {
    snap = snapshotPlainDataRecord(input);
  } catch {
    return 'invalid-request';
  }
  if (snap === null) {
    return 'invalid-request';
  }
  const forceUnsealed = snap['forceUnsealed'];
  if (forceUnsealed !== undefined && typeof forceUnsealed !== 'boolean') {
    return 'invalid-request';
  }
  const nowIso = snap['nowIso'];
  if (nowIso !== undefined && (typeof nowIso !== 'string' || !isCalendarDateTime(nowIso))) {
    return 'invalid-request';
  }
  return null;
}

/** A project-profile clone: the clone root and the worktree root it manages. */
type CloneRecord = { readonly path: string; readonly worktreeRoot: string };

/** One run's eligibility decision; a candidate carries what removal needs. */
type RunCandidateEvaluation =
  | {
      readonly outcome: 'candidate';
      readonly latestAttempt: AttemptRecord;
      readonly workOrder: WorkOrderRecord;
      readonly clone: CloneRecord;
      readonly recordedHost: AttemptRunnerRecord;
    }
  | { readonly outcome: 'skipped' }
  | { readonly outcome: 'refused' };

interface EvaluateRunCandidateParams {
  readonly deps: ReapLaneWorktreesDependencies;
  readonly run: LaneRunRecord;
  readonly heldAttemptIds: ReadonlySet<string>;
  readonly findWorkOrder: (workOrderId: string) => Promise<WorkOrderRecord | null>;
  readonly listAttempts: (workOrderId: string) => Promise<readonly AttemptRecord[]>;
  readonly entriesByRun: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>;
  readonly budget: number;
  readonly skipped: { readonly runId: string; readonly reason: string }[];
  readonly refused: { readonly runId: string; readonly reason: string }[];
}

/**
 * Decide one run's eligibility and, for a candidate, return its latest attempt,
 * work order, clone and recorded host. Non-candidates push their own skip or
 * refusal entry. Every outbound read is deadline-guarded: an unreadable read
 * is a per-run refusal (`unknown`) and the scan continues — never a skip,
 * never a guessed empty answer.
 */
async function evaluateRunCandidate(
  params: EvaluateRunCandidateParams,
): Promise<RunCandidateEvaluation> {
  const {
    deps,
    run,
    heldAttemptIds,
    findWorkOrder,
    listAttempts,
    entriesByRun,
    budget,
    skipped,
    refused,
  } = params;
  const state = laneRunJournalState(entriesByRun.get(run.runId) ?? [], run.runId);
  if (!isTerminalRun(state)) {
    skipped.push({ runId: run.runId, reason: 'run-not-terminal' });
    return { outcome: 'skipped' };
  }

  let workOrder: WorkOrderRecord | null;
  try {
    workOrder = await findWorkOrder(run.workOrderId);
  } catch {
    refused.push({ runId: run.runId, reason: 'unknown' });
    return { outcome: 'refused' };
  }
  if (workOrder === null || !isTerminalWorkOrder(workOrder.state)) {
    skipped.push({ runId: run.runId, reason: 'work-order-active' });
    return { outcome: 'skipped' };
  }

  // The run's attempts: every id the run records, in the run's own order.
  let attemptRecords: readonly AttemptRecord[];
  try {
    attemptRecords = await listAttempts(run.workOrderId);
    if (!Array.isArray(attemptRecords)) {
      refused.push({ runId: run.runId, reason: 'unknown' });
      return { outcome: 'refused' };
    }
  } catch {
    refused.push({ runId: run.runId, reason: 'unknown' });
    return { outcome: 'refused' };
  }
  const runAttempts: AttemptRecord[] = [];
  const attemptsById = new Map(attemptRecords.map((attempt) => [attempt.id, attempt]));
  let missingAttempt = false;
  for (const attemptId of run.attemptIds) {
    const attempt = attemptsById.get(attemptId);
    if (attempt === undefined) {
      missingAttempt = true;
      break;
    }
    runAttempts.push(attempt);
  }
  // A run records an attempt the store does not have: it cannot be proven
  // cancelled or collected, so it is never a candidate.
  if (missingAttempt) {
    skipped.push({ runId: run.runId, reason: 'attempt-live' });
    return { outcome: 'skipped' };
  }
  if (runAttempts.some((attempt) => attempt.state !== 'cancelled' && attempt.state !== 'collected')) {
    skipped.push({ runId: run.runId, reason: 'attempt-live' });
    return { outcome: 'skipped' };
  }
  if (runAttempts.some((attempt) => heldAttemptIds.has(attempt.id))) {
    skipped.push({ runId: run.runId, reason: 'slot-held' });
    return { outcome: 'skipped' };
  }

  const latestAttempt = runAttempts[runAttempts.length - 1];
  if (latestAttempt === undefined) {
    // No attempt, no worktree to remove.
    skipped.push({ runId: run.runId, reason: 'no-recorded-host' });
    return { outcome: 'skipped' };
  }
  const recordedHost = conductedRunnerOf(latestAttempt);
  if (recordedHost === null) {
    skipped.push({ runId: run.runId, reason: 'no-recorded-host' });
    return { outcome: 'skipped' };
  }

  if (deps.profileRead === undefined) {
    refused.push({ runId: run.runId, reason: 'not-configured' });
    return { outcome: 'refused' };
  }
  let profile: Awaited<ReturnType<ProjectProfileReadPort['readProjectProfile']>>;
  try {
    profile = await withBudget(deps.profileRead.readProjectProfile(workOrder.projectId), budget);
  } catch {
    refused.push({ runId: run.runId, reason: 'unknown' });
    return { outcome: 'refused' };
  }
  const clone = profile?.clones[recordedHost.hostName ?? ''];
  if (clone === undefined) {
    skipped.push({ runId: run.runId, reason: 'no-clone' });
    return { outcome: 'skipped' };
  }

  return { outcome: 'candidate', latestAttempt, workOrder, clone, recordedHost };
}

interface ReapCandidateWorktreeParams {
  readonly deps: ReapLaneWorktreesDependencies;
  readonly run: LaneRunRecord;
  readonly latestAttempt: AttemptRecord;
  readonly workOrder: WorkOrderRecord;
  readonly clone: CloneRecord;
  readonly recordedHost: AttemptRunnerRecord;
  readonly dryRun: boolean;
  readonly forceUnsealed: boolean;
  readonly nowIso: string;
  readonly budget: number;
  readonly removed: { readonly runId: string; readonly branchTip: string | null }[];
  readonly alreadyRemoved: { readonly runId: string }[];
  readonly refused: { readonly runId: string; readonly reason: string }[];
  readonly journalFailed: ReapWorktreeJournalFailureEntry[];
}

/**
 * Remove one candidate's sealed worktree and report the outcome (C2'). A
 * failed post-removal journal append never aborts the scan: the removal stays
 * in `removed` and the failure is reported in `journalFailed`. Keyed
 * idempotence: a completed removal journal entry reports `alreadyRemoved`
 * without re-acting, so a repeat reap never fails on an already-reaped
 * attempt. For `--force-unsealed` the clean/unlocked/idle pre-check runs
 * before any owner approval is consumed, so a dirty worktree never burns a
 * signed grant.
 */
async function reapCandidateWorktree(params: ReapCandidateWorktreeParams): Promise<void> {
  const {
    deps,
    run,
    latestAttempt,
    clone,
    recordedHost,
    dryRun,
    forceUnsealed,
    nowIso,
    budget,
    removed,
    alreadyRemoved,
    refused,
    journalFailed,
  } = params;
  if (dryRun) {
    removed.push({ runId: run.runId, branchTip: null });
    return;
  }

  // Keyed idempotence first: a repeat reap of an already-reaped attempt is
  // `alreadyRemoved`, never a second removal and never a manifest refusal.
  let priorEntries: readonly ActionJournalEntryRecord[];
  try {
    priorEntries = await withBudget(
      deps.executionJournal.listJournalEntriesForAttempt(latestAttempt.id),
      budget,
    );
    if (!Array.isArray(priorEntries)) {
      refused.push({ runId: run.runId, reason: 'unknown' });
      return;
    }
  } catch {
    refused.push({ runId: run.runId, reason: 'unknown' });
    return;
  }
  const completedMarker = removalCompletedMarker(run.runId);
  if (
    priorEntries.some(
      (entry) =>
        isRecordObject(entry) &&
        entry['action'] === 'collect' &&
        entry['status'] === 'completed' &&
        typeof entry['detail'] === 'string' &&
        (entry['detail'] as string).includes(completedMarker),
    )
  ) {
    alreadyRemoved.push({ runId: run.runId });
    return;
  }

  const workspace = deps.workspace;
  if (
    workspace?.inspectWorktreeForRemoval === undefined ||
    workspace.removeWorktree === undefined
  ) {
    refused.push({ runId: run.runId, reason: 'not-configured' });
    return;
  }

  // The facts, read under the caller's hold; an unreadable read is unknown.
  let inspect: InspectRemovalResult;
  try {
    inspect = await withBudget(
      workspace.inspectWorktreeForRemoval({
        repositoryRoot: clone.path,
        worktreePath: latestAttempt.worktreePath,
        defaultRef: 'origin/main',
        recordedHost,
      }),
      budget,
    );
  } catch {
    refused.push({ runId: run.runId, reason: 'unknown' });
    return;
  }
  if (inspect.outcome === 'unknown') {
    refused.push({ runId: run.runId, reason: 'unknown' });
    return;
  }
  if (inspect.outcome === 'refused') {
    if (inspect.reason === 'not-a-linked-worktree') {
      // Not listed at all: the worktree is already gone.
      alreadyRemoved.push({ runId: run.runId });
    } else {
      refused.push({ runId: run.runId, reason: 'unknown' });
    }
    return;
  }
  const facts = inspect.facts;
  if (facts.branch === null) {
    refused.push({ runId: run.runId, reason: 'detached' });
    return;
  }
  if (facts.branch !== branchForRun(run.runId)) {
    refused.push({ runId: run.runId, reason: 'branch-mismatch' });
    return;
  }
  if (facts.status.tracked + facts.status.untracked + facts.status.unmerged > 0) {
    refused.push({ runId: run.runId, reason: 'dirty' });
    return;
  }
  if (facts.locked !== false) {
    refused.push({ runId: run.runId, reason: 'locked' });
    return;
  }
  if (
    facts.head === null ||
    facts.inProgressOperations.length > 0 ||
    facts.lastActivity.unknown ||
    facts.lastActivity.iso === null
  ) {
    refused.push({ runId: run.runId, reason: 'busy' });
    return;
  }

  // C2': where the sealed manifest lives, read from the attempt's record.
  const coords = attemptManifestCoordinates(latestAttempt.artifacts);
  let manifest: RemoveWorktreeManifestInput;
  let approvalReference: string | undefined;
  if (forceUnsealed) {
    if (coords.kind === 'sealed') {
      // A genuinely sealed worktree needs no owner approval: verify it first.
      const check = deps.attemptArtifact?.checkArtifactManifestForRemoval;
      if (check === undefined) {
        refused.push({ runId: run.runId, reason: 'unknown' });
        return;
      }
      let verdict: Awaited<ReturnType<typeof check>>;
      const request: VerifyArtifactManifestRequest = {
        attemptId: latestAttempt.id,
        worktreePath: latestAttempt.worktreePath,
        manifestPath: coords.manifestPath,
        expectedManifestSha256: coords.expectedManifestSha256,
        recordedHost,
      };
      try {
        verdict = await withBudget(check.call(deps.attemptArtifact as object, request), budget);
      } catch {
        refused.push({ runId: run.runId, reason: 'unknown' });
        return;
      }
      if (verdict.outcome === 'sealed') {
        manifest = {
          kind: 'sealed',
          attemptId: latestAttempt.id,
          manifestPath: coords.manifestPath,
          expectedManifestSha256: coords.expectedManifestSha256,
        };
      } else if (verdict.outcome === 'unknown') {
        refused.push({ runId: run.runId, reason: 'unknown' });
        return;
      } else {
        // Missing or mismatched: fall through to the unsealed authorization.
        const unsealed = await authorizeUnsealedRemoval(params, priorEntries, facts.head);
        if (unsealed.outcome === 'refused') {
          refused.push({ runId: run.runId, reason: unsealed.reason });
          return;
        }
        manifest = unsealed.manifest;
        approvalReference = unsealed.approvalReference;
      }
    } else {
      const unsealed = await authorizeUnsealedRemoval(params, priorEntries, facts.head);
      if (unsealed.outcome === 'refused') {
        refused.push({ runId: run.runId, reason: unsealed.reason });
        return;
      }
      manifest = unsealed.manifest;
      approvalReference = unsealed.approvalReference;
    }
  } else if (coords.kind === 'sealed') {
    manifest = {
      kind: 'sealed',
      attemptId: latestAttempt.id,
      manifestPath: coords.manifestPath,
      expectedManifestSha256: coords.expectedManifestSha256,
    };
  } else {
    manifest = { kind: 'uncollected' };
  }

  // The call keeps the workspace as its receiver: extracting the method
  // would lose `this`, and the adapter reads `this.options`.
  let result: RemoveWorktreeResultCall;
  try {
    result = await withBudget(
      workspace.removeWorktree.call(workspace, {
        repositoryRoot: clone.path,
        worktreeRoot: clone.worktreeRoot,
        worktreePath: latestAttempt.worktreePath,
        expectedHead: facts.head,
        expectedBranch: branchForRun(run.runId),
        expectedLastActivityIso: facts.lastActivity.iso,
        recordedHost,
        manifest,
      }),
      budget,
    );
  } catch {
    // A call cut short before the removal (or after it, ambiguously) leaves
    // state the next reap pass completes: reported unknown, never a guess.
    refused.push({ runId: run.runId, reason: 'unknown' });
    return;
  }
  if (result.outcome === 'removed') {
    const failureReason = await recordRemovalJournalEntry(
      deps,
      latestAttempt,
      run.runId,
      nowIso,
      result.branchTip,
      budget,
      approvalReference,
    );
    if (failureReason !== null) {
      journalFailed.push({
        runId: run.runId,
        attemptId: latestAttempt.id,
        branchTip: result.branchTip,
        reason: failureReason,
      });
    }
    removed.push({ runId: run.runId, branchTip: result.branchTip });
  } else if (result.outcome === 'refused') {
    refused.push({ runId: run.runId, reason: result.reason });
  } else {
    // `partial` or `unknown`: the worktree may or may not be removed.
    // Reported as refused so the exit code says unresolved.
    refused.push({ runId: run.runId, reason: 'unknown' });
  }
}

/** The manifest coordinates handed to `removeWorktree` (mirrors the port type). */
type RemoveWorktreeManifestInput = Parameters<NonNullable<WorkspacePort['removeWorktree']>>[0]['manifest'];
type InspectRemovalResult = Awaited<
  ReturnType<NonNullable<WorkspacePort['inspectWorktreeForRemoval']>>
>;
type RemoveWorktreeResultCall = Awaited<ReturnType<NonNullable<WorkspacePort['removeWorktree']>>>;

type UnsealedAuthorizationOutcome =
  | {
      readonly outcome: 'authorized';
      readonly manifest: RemoveWorktreeManifestInput;
      readonly approvalReference: string;
    }
  | { readonly outcome: 'refused'; readonly reason: string };

/**
 * C2': the `--force-unsealed` authorization path. Records a
 * crash-recoverable intent journal entry before asking, then consumes a
 * scoped one-way owner approval; the recorded approval reference travels into
 * the removal request (which re-runs every git and activity guard) and into
 * the completed journal entry. A blocked or unknown authorization consumes
 * nothing and removes nothing.
 */
async function authorizeUnsealedRemoval(
  params: ReapCandidateWorktreeParams,
  priorEntries: readonly ActionJournalEntryRecord[],
  expectedHeadSha: string,
): Promise<UnsealedAuthorizationOutcome> {
  const { deps, run, latestAttempt, workOrder, nowIso, budget } = params;
  const authorize = deps.actionAuthorization?.authorizeUnsealedWorktreeRemoval;
  if (authorize === undefined) {
    return { outcome: 'refused', reason: 'not-configured' };
  }
  const intentId = unsealedIntentEntryId(latestAttempt.id, run.runId);
  if (!priorEntries.some((entry) => isRecordObject(entry) && entry['id'] === intentId)) {
    try {
      await withBudget(
        deps.executionJournal.appendJournalEntry({
          id: intentId,
          attemptId: latestAttempt.id,
          workOrderId: latestAttempt.workOrderId,
          action: 'collect',
          baseCommit: latestAttempt.baseCommit,
          recordedAtIso: nowIso,
          status: 'intent-recorded',
          sessionId: null,
          detail:
            `Authorizing unsealed worktree removal for attempt ${latestAttempt.id} ` +
            `on branch ${branchForRun(run.runId)}`,
        }),
        budget,
      );
    } catch {
      return { outcome: 'refused', reason: 'unknown' };
    }
  }
  let answer: Awaited<ReturnType<NonNullable<typeof authorize>>>;
  try {
    answer = await withBudget(
      authorize.call(deps.actionAuthorization as object, {
        projectId: workOrder.projectId,
        runId: run.runId,
        attemptId: latestAttempt.id,
        worktreePath: latestAttempt.worktreePath,
        expectedHeadSha,
        nowIso,
      }),
      budget,
    );
  } catch {
    return { outcome: 'refused', reason: 'unknown' };
  }
  if (answer.outcome === 'blocked') {
    return { outcome: 'refused', reason: 'unapproved-force-unsealed' };
  }
  if (answer.outcome === 'unknown') {
    return { outcome: 'refused', reason: 'unknown' };
  }
  return {
    outcome: 'authorized',
    manifest: {
      kind: 'force-unsealed',
      attemptId: latestAttempt.id,
      approvalReference: answer.approvalReference,
    },
    approvalReference: answer.approvalReference,
  };
}

/**
 * Append one `collect` journal entry on the latest attempt recording the
 * removal, the kept branch's tip and — when the removal was force-unsealed —
 * the consumed approval reference. The worktree path is never written into
 * `detail`. On any failure the primary append is retried as a best-effort
 * `ambiguous` entry carrying the sanitised failure reason, and the reason is
 * returned so the caller can report the removal in `journalFailed`; never
 * throws.
 */
async function recordRemovalJournalEntry(
  deps: ReapLaneWorktreesDependencies,
  attempt: AttemptRecord,
  runId: string,
  nowIso: string,
  branchTip: string,
  budget: number,
  approvalReference?: string,
): Promise<string | null> {
  const detail =
    `Removed the lane worktree for attempt ${attempt.id}; ` +
    `branch ${branchForRun(runId)} kept at ${branchTip}` +
    (approvalReference !== undefined ? `; approvalRef=${approvalReference}` : '');
  try {
    const priorEntries = await withBudget(
      deps.executionJournal.listJournalEntriesForAttempt(attempt.id),
      budget,
    );
    const listed = Array.isArray(priorEntries) ? priorEntries : [];
    const intentId = unsealedIntentEntryId(attempt.id, runId);
    // Intent entries never consume a sequence number, so the completed id
    // stays `${attempt.id}:collect:${nonIntentCount + 1}` — `1` for a plain
    // sealed removal. A retry that would collide falls back to a keyed id.
    const nonIntentCount = listed.filter(
      (entry) => !(isRecordObject(entry) && entry['id'] === intentId),
    ).length;
    let id = `${attempt.id}:collect:${nonIntentCount + 1}`;
    if (listed.some((entry) => isRecordObject(entry) && entry['id'] === id)) {
      id = `${attempt.id}:collect:completed:${runId}`;
    }
    await withBudget(
      deps.executionJournal.appendJournalEntry({
        id,
        attemptId: attempt.id,
        workOrderId: attempt.workOrderId,
        action: 'collect',
        baseCommit: attempt.baseCommit,
        recordedAtIso: nowIso,
        status: 'completed',
        sessionId: null,
        detail,
      }),
      budget,
    );
    return null;
  } catch (error) {
    const reason = sanitizeJournalFailureReason(error);
    // Best-effort fallback: record the failed append as ambiguous evidence.
    try {
      await withBudget(
        deps.executionJournal.appendJournalEntry({
          id: `${attempt.id}:collect:reap-journal-failed:${runId}:${nowIso}`,
          attemptId: attempt.id,
          workOrderId: attempt.workOrderId,
          action: 'collect',
          baseCommit: attempt.baseCommit,
          recordedAtIso: nowIso,
          status: 'ambiguous',
          sessionId: null,
          detail:
            `Removed the lane worktree for attempt ${attempt.id} ` +
            `(branch ${branchForRun(runId)} kept at ${branchTip}); ` +
            `journal append failed: ${reason}`,
        }),
        budget,
      );
    } catch {
      // Even the fallback append failed; the failure still surfaces via `journalFailed`.
    }
    return reason;
  }
}

/**
 * A safe, non-secret reason for a failed journal append: the trimmed error
 * message, or `journal-append-failed` when there is none, redacted when it
 * matches a secret shape, a lane-diff secret pattern or carries a filesystem
 * path, and capped at 500 characters.
 */
function sanitizeJournalFailureReason(error: unknown): string {
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim()
      : 'journal-append-failed';
  const carriesPath = message.includes('/') || message.includes('\\');
  if (
    containsSecretShape(message) ||
    LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(message)) ||
    carriesPath
  ) {
    return 'journal-append-failed (redacted)';
  }
  return message.slice(0, 500);
}
