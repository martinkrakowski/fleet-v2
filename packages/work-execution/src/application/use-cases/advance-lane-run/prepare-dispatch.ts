/** The `act prepare` and `act dispatch` steps of AdvanceLaneRunUseCase (AL-1). */
import type { AdvanceLaneRunRefusal, AdvanceLaneRunRequest, AdvanceLaneRunResult } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import type {
  PreserveWorktreeEditsResult,
  VerifySavedPatchRequest,
} from '../../ports/out/WorkspacePort.out-port.js';
import { AttemptRevisionConflictError } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import { parseSeatTool, type AttemptRecord, type AttemptRunnerRecord, type AttemptSeatOverrideRecord, type AttemptSeatSelectionRecord } from '../../../domain/execution-records.js';
import type { LaneRunDecision } from '../../../domain/lane-run-decider.js';
import type { LaneRunResultReasonCode } from '../../../domain/lane-run-step-facts.js';
import type { LaneRunCursorsRecord, LaneRunRecord } from '../../../domain/lane-run-records.js';
import { implementerRoleFor } from '../../../domain/lane-run-transitions.js';
import { seatMatchesAssignment, seatSelectionRecord, pickNextSeat, seatOutcomeOfStopReason } from '../../../domain/seat-selection.js';
import type { SeatFailureOutcome, NextSeatResult } from '../../../domain/seat-selection.js';
import type { SeatPlanRole } from '../../../domain/value-objects/SeatPlan.vo.js';
import { SeatPlan } from '../../../domain/value-objects/SeatPlan.vo.js';
import type { LaneRunStateValue } from '../../../domain/value-objects/LaneRunState.vo.js';
import { parseStopReason, MODEL_REFUSAL_CLASSES } from '../../../domain/value-objects/StopReason.vo.js';
import { conductedRunnerOf } from './conducted-host.js';
import type { AdvanceStepContext, GatheredLaneRunFacts } from './step-context.js';
import { appendConduct, appendRunIntent, appendRunResult, ceilingPark, performPark, saveOrRefuse } from './step-context.js';
import { manifestExpectedArtifacts, manifestPositiveInteger, manifestTimeLimitSeconds, readVerifiedFrozenManifest } from './frozen-manifest.js';
import { performFixPrepare } from './review-fix.js';
import { parkSpentOneWayKey } from './merge.js';

function latestAttemptRecordOf(gathered: GatheredLaneRunFacts): AttemptRecord | null {
  for (let index = gathered.attemptRecords.length - 1; index >= 0; index -= 1) {
    const candidate = gathered.attemptRecords[index];
    if (candidate !== null) {
      return candidate;
    }
  }
  return null;
}

async function reconcilePendingRecoveryOrPark(
  ctx: AdvanceStepContext,
  record: LaneRunRecord,
  source: AttemptRecord,
  request: AdvanceLaneRunRequest,
  state: LaneRunStateValue,
): Promise<AdvanceLaneRunResult | null> {
  if (await hasIncompleteWorktreeRecovery(ctx, source.id)) {
    const reconciled = await reconcileCancelledWorktreeRecovery(ctx, record, source, request);
    if (!reconciled) {
      return performPark(ctx, record, 'step-refused', 'prepare', state, request);
    }
  }
  return null;
}

/**
 * The `act prepare` decision (K4-5): a fresh round-0 attempt on the selected
 * first-pass seat, copying the frozen-brief fields from the run's latest
 * attempt (the seat pivot). Order: intent, attempt record, run record,
 * result — so a result never exists for an attempt the run record does not
 * list. A fix-round prepare stays with K5 and routes to `performFixPrepare`
 * under its key.
 */
export async function performPrepare(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'act' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const ceiling = await ceilingPark(ctx, record, gathered, request);
  if (ceiling !== null) {
    return ceiling;
  }
  const nowIso = request.nowIso;
  const refuse = async (reasonCode: LaneRunResultReasonCode): Promise<AdvanceLaneRunResult> => {
    const intentRefusal = await appendRunIntent(ctx, request, decision.key, null);
    if (intentRefusal !== null) {
      return { outcome: 'refused', reason: intentRefusal };
    }
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'refused', reasonCode);
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode };
  };

  const source = latestAttemptRecordOf(gathered);
  if (source === null) {
    return refuse('no-frozen-brief');
  }
  // GB3: the source attempt may carry an incomplete worktree recovery — a
  // crash after the recovery's cancel but before its completing journal entry
  // leaves the attempt `cancelled` with the intent still open. Reconcile the
  // recovery before another seat is prepared; an unreconcilable recovery
  // parks instead of advancing over unfinished side effects.
  const recoveryPark = await reconcilePendingRecoveryOrPark(ctx, record, source, request, gathered.facts.state);
  if (recoveryPark !== null) {
    return recoveryPark;
  }
  if (decision.round !== 0) {
    return performFixPrepare(ctx, record, gathered, decision, request, refuse);
  }
  const planResult = SeatPlan.create(source.seatPlan);
  const seat =
    planResult.success && planResult.value !== undefined
      ? planResult.value.getSeats('first-pass')[decision.seatIndex]
      : undefined;
  if (seat === undefined) {
    return refuse('seat-missing');
  }
  const sourceTool = parseSeatTool(source.seatSelection?.tool) ?? 'opencode';
  if ((parseSeatTool(seat.tool) ?? 'opencode') !== sourceTool) {
    return refuse('seat-tool-differs');
  }
  const attemptId = 'attempt-' + ctx.deps.newUlid();
  const intentRefusal = await appendRunIntent(ctx, request, decision.key, attemptId);
  if (intentRefusal !== null) {
    return { outcome: 'refused', reason: intentRefusal };
  }
  // The next attempt keeps the run's host identity (seam register: a conducted
  // attempt always carries its runner host); the session fields stay null and
  // dispatch overwrites the block with describeRunner().
  const sourceRunner = conductedRunnerOf(source);
  const attempt: AttemptRecord = {
    ...(sourceRunner !== null
      ? {
          runner: {
            kind: sourceRunner.kind,
            remotePort: sourceRunner.remotePort,
            host: sourceRunner.host,
            hostName: sourceRunner.hostName,
            agent: null,
            model: null,
            variant: null,
          },
        }
      : {}),
    id: attemptId,
    workOrderId: source.workOrderId,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: source.id,
    worktreePath: source.worktreePath,
    baseCommit: source.baseCommit,
    state: 'intent-recorded',
    outcome: null,
    revision: 0,
    briefDigest: source.briefDigest,
    briefPackagePath: source.briefPackagePath,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    seatPlan: source.seatPlan ?? null,
    seatSelection: seatSelectionRecord('first-pass', decision.seatIndex, seat),
    reviewerSeat: source.reviewerSeat ?? null,
    createdAtIso: nowIso,
    updatedAtIso: nowIso,
  };
  try {
    await ctx.deps.attemptRepo.saveAttempt(attempt);
  } catch (error) {
    if (error instanceof AttemptRevisionConflictError) {
      const resultRefusal = await appendRunResult(ctx, request, decision.key, 'refused', 'attempt-exists');
      if (resultRefusal !== null) {
        return { outcome: 'refused', reason: resultRefusal };
      }
      return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode: 'attempt-exists' };
    }
    throw error;
  }
  try {
    const saved = await saveOrRefuse(ctx,
      { ...record, attemptIds: [...record.attemptIds, attemptId], revision: record.revision + 1 },
      request,
    );
    if (!saved.ok) {
      // The intent stays pending; K4-7's prepare reconcile finds the attempt
      // and appends the id to the run record.
      return { outcome: 'refused', reason: saved.reason };
    }
  } catch {
    return { outcome: 'refused', reason: 'save-refused' };
  }
  const resultRefusal = await appendRunResult(ctx, request, decision.key, 'completed', 'prepared');
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode: 'prepared' };
}

/**
 * KF-16: the fixed detail code a refused dispatch journals with its result
 * entry, derived from the refusal's stable prefix or phrase. Reason details
 * are fixed codes, never free text; unknown refusals map to `other` and the
 * function never returns the input text.
 */
export function dispatchRefusalDetail(reason: string): string {
  // Worktree refusals name the path and then a fixed phrase. The path may hold
  // spaces, so the first fixed phrase after it decides; a listed file name
  // after the phrase can never change the code.
  const worktree = /^Worktree .+? (does not match the base commit|does not match the prior attempt's head|has uncommitted changes|has untracked files|contains residue from earlier attempts)/.exec(reason);
  if (worktree !== null) {
    return WORKTREE_REFUSAL_DETAILS[worktree[1]!] ?? 'other';
  }
  if (reason.startsWith('No active capacity reservation')) {
    return 'no-reservation';
  }
  if (reason.includes('is not the configured runner host')) {
    return 'reservation-host-mismatch';
  }
  if (reason.includes('does not match the path allocated by the capacity reservation')) {
    return 'reservation-worktree-mismatch';
  }
  if (reason.startsWith('Runner capabilities do not satisfy')) {
    return 'capabilities-missing';
  }
  if (reason.endsWith('a fix attempt starts only after it is collected or cancelled')) {
    return 'prior-not-settled';
  }
  if (reason.startsWith('Prior attempt not found')) {
    return 'prior-not-found';
  }
  if (reason.startsWith('Prior attempt ') && reason.endsWith('is collected but has no sealed head commit')) {
    return 'prior-head-missing';
  }
  if (reason.startsWith('Work order not found')) {
    return 'work-order-missing';
  }
  if (reason === 'runner-not-available' || reason.startsWith('No runner port can be described')) {
    return 'runner-unavailable';
  }
  // KF-18: the seat-binding refusal of a fix attempt whose fix seat differs
  // from the frozen brief's model assignment, and the reviewer-seat family
  // refusal of a seat override.
  if (reason.includes('does not match seat')) {
    return 'seat-mismatch';
  }
  if (reason.includes('shares underlying model family with recorded reviewer seat')) {
    return 'seat-family-conflict';
  }
  return 'other';
}

const WORKTREE_REFUSAL_DETAILS: Readonly<Record<string, string>> = {
  'does not match the base commit': 'worktree-head-mismatch',
  "does not match the prior attempt's head": 'worktree-head-mismatch',
  'has uncommitted changes': 'worktree-uncommitted',
  'has untracked files': 'worktree-untracked',
  'contains residue from earlier attempts': 'worktree-residue',
};

/** KF-18: a fix attempt's own seat, checked against its frozen plan and what an override can express. */
type FixSeatForDispatch =
  | { readonly kind: 'none' }
  | { readonly kind: 'seat'; readonly seat: AttemptSeatSelectionRecord; readonly overrideVariant?: 'default' }
  | { readonly kind: 'refused'; readonly detail: 'seat-not-in-plan' | 'seat-not-expressible' };

function isUnsetVariant(value: string | null | undefined): boolean {
  const trimmed = (value ?? '').trim();
  return trimmed === '' || trimmed === 'default';
}

export function fixSeatForDispatch(
  latest: AttemptRecord,
  manifest: Record<string, unknown> | null,
): FixSeatForDispatch {
  const selection = latest.seatSelection ?? null;
  if (latest.kind !== 'fix' || selection === null) {
    return { kind: 'none' };
  }
  // A fix attempt's selection must be a fix seat: any other role would let it
  // dispatch on that seat's assignment without the fix-seat checks below.
  if (selection.role !== 'fix') {
    return { kind: 'refused', detail: 'seat-not-in-plan' };
  }
  const planResult = SeatPlan.create(latest.seatPlan);
  const planSeat =
    planResult.success && planResult.value !== undefined
      ? planResult.value.getSeats('fix')[selection.seatIndex]
      : undefined;
  if (
    planSeat === undefined ||
    planSeat.id !== selection.seatId ||
    !seatMatchesAssignment(planSeat, {
      model: selection.model,
      tool: selection.tool,
      variant: selection.variant,
      agent: selection.agent,
    })
  ) {
    return { kind: 'refused', detail: 'seat-not-in-plan' };
  }
  // The override carries model, agent and variant only: the frozen
  // assignment's tool is the one dispatched, and an unset override field
  // inherits the assignment's value. A seat whose variant is unset while the
  // assignment sets one is still nameable: the override carries
  // `variant: 'default'` explicitly (KF-26).
  const raw = manifest?.['modelAssignment'];
  const assignment = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const assignmentTool = typeof assignment['seatTool'] === 'string' && assignment['seatTool'].trim() !== ''
    ? assignment['seatTool'].trim()
    : 'opencode';
  const assignmentAgent = typeof assignment['agent'] === 'string' ? assignment['agent'].trim() : '';
  const assignmentVariant = typeof assignment['variant'] === 'string' ? assignment['variant'] : null;
  const seatTool = (selection.tool ?? '').trim() === '' ? 'opencode' : (selection.tool as string).trim();
  if (
    seatTool !== assignmentTool ||
    ((selection.agent ?? '').trim() === '' && assignmentAgent !== '')
  ) {
    return { kind: 'refused', detail: 'seat-not-expressible' };
  }
  // KF-26: a fix seat whose variant is unset while the assignment sets one is
  // still expressible — the override carries `variant: 'default'` explicitly,
  // so the seat runs with no variant instead of inheriting the assignment's.
  const overrideVariant: 'default' | undefined =
    isUnsetVariant(selection.variant) && !isUnsetVariant(assignmentVariant) ? 'default' : undefined;
  return { kind: 'seat', seat: selection, ...(overrideVariant !== undefined ? { overrideVariant } : {}) };
}

function isWorktreePathValid(worktreePath: unknown): worktreePath is string {
  if (typeof worktreePath !== 'string' || !worktreePath.startsWith('/') || worktreePath === '/' || worktreePath.includes('\0')) {
    return false;
  }
  if (worktreePath.includes('//') || worktreePath.endsWith('/')) {
    return false;
  }
  const segments = worktreePath.split('/');
  return !segments.includes('.') && !segments.includes('..') && segments.slice(1).every((s) => s !== '');
}

function isAttemptIdValid(attemptId: unknown): attemptId is string {
  if (typeof attemptId !== 'string' || attemptId.includes('/') || attemptId.includes('\\') || attemptId.includes('\0') || attemptId.includes('..')) {
    return false;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(attemptId);
}

/**
 * GB3: the recorded worktree path and attempt id are untrusted data
 * (`AttemptRecord` stores both as plain strings), so both are validated before
 * the deterministic patch path is constructed from them: an absolute, already
 * normalized worktree path (no `.` or `..` segments, no empty segments beyond
 * the leading slash, no NUL) and an attempt id that is safe as a file-name
 * fragment. A refused pair means no patch path is ever built.
 */
export function worktreeRecoveryPatchInputsValid(worktreePath: unknown, attemptId: unknown): boolean {
  return isWorktreePathValid(worktreePath) && isAttemptIdValid(attemptId);
}

/**
 * GB3: true when the execution journal holds a durable recovery intent for the
 * attempt that its completing entry does not close. An incomplete recovery must
 * never cancel-and-advance: the side effects (preserve, reset, cancel) may be
 * unfinished, so the run parks instead.
 */
async function hasIncompleteWorktreeRecovery(ctx: AdvanceStepContext, attemptId: string): Promise<boolean> {
  if (ctx.deps.executionJournal.appendJournalEntry === undefined) {
    return false;
  }
  const entries = await ctx.deps.executionJournal.listJournalEntriesForAttempt(attemptId);
  let sawIntent = false;
  let sawCompleted = false;
  for (const entry of entries) {
    if (entry.action !== 'dispatch' || entry.detail === null || !entry.detail.startsWith('preserved uncommitted edits:')) {
      continue;
    }
    if (entry.status === 'completed') {
      sawCompleted = true;
    } else {
      sawIntent = true;
    }
  }
  return sawIntent && !sawCompleted;
}

function canAttemptWorktreeRecovery(
  recovery: AdvanceStepContext['deps']['worktreeRecovery'],
  cancel: unknown,
  append: unknown,
  latest: AttemptRecord,
): boolean {
  if (recovery?.preserveWorktreeEdits === undefined || recovery.resetWorktreeToHead === undefined || cancel === undefined || append === undefined) {
    return false;
  }
  if (latest.state !== 'intent-recorded' || latest.worktreePath === null) {
    return false;
  }
  return worktreeRecoveryPatchInputsValid(latest.worktreePath, latest.id);
}

/**
 * GB3: preserve the refused attempt's uncommitted edits as a patch outside the
 * worktree, reset the worktree to its head, cancel the never-dispatched
 * attempt, and journal the patch path. The durable recovery intent — including
 * the deterministic patch path — is journaled BEFORE any side effect, so the
 * patch path stays discoverable even when the process crashes mid-recovery; an
 * earlier intent without its completing entry means a crash left recovery
 * unfinished, and that run parks instead of re-running destructive steps. True
 * only when every step succeeded; any failure keeps today's park.
 */
async function recoverUncommittedWorktree(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  latest: AttemptRecord,
  request: AdvanceLaneRunRequest,
): Promise<boolean> {
  const recovery = ctx.deps.worktreeRecovery;
  const preserveWorktreeEdits = recovery?.preserveWorktreeEdits?.bind(recovery);
  const resetWorktreeToHead = recovery?.resetWorktreeToHead?.bind(recovery);
  const cancel = ctx.deps.cancelPreparedAttempt;
  const append = ctx.deps.executionJournal.appendJournalEntry?.bind(ctx.deps.executionJournal);
  if (!canAttemptWorktreeRecovery(recovery, cancel, append, latest)) {
    return false;
  }
  const recordedHost = conductedRunnerOf(latest);
  if (
    recordedHost === null ||
    latest.worktreePath === null ||
    preserveWorktreeEdits === undefined ||
    resetWorktreeToHead === undefined ||
    cancel === undefined ||
    append === undefined
  ) {
    return false;
  }
  try {
    const priorEntries = await ctx.deps.executionJournal.listJournalEntriesForAttempt(latest.id);
    const priorIntent = priorEntries.find(
      (entry) =>
        entry.action === 'dispatch' &&
        entry.detail !== null &&
        entry.detail.startsWith('preserved uncommitted edits:'),
    );
    if (priorIntent !== undefined) {
      return priorIntent.status === 'completed';
    }
    const patchPath = latest.worktreePath + '.' + latest.id + '.patch';
    await append({
      id: latest.id + ':dispatch:' + String(priorEntries.length + 1),
      attemptId: latest.id,
      workOrderId: record.workOrderId,
      action: 'dispatch',
      baseCommit: latest.baseCommit,
      recordedAtIso: request.nowIso,
      status: 'intent-recorded',
      sessionId: null,
      detail: 'preserved uncommitted edits: ' + patchPath,
    });
    const preserved = await preserveWorktreeEdits({ worktreePath: latest.worktreePath, patchPath, recordedHost });
    if (preserved.outcome !== 'preserved') {
      return false;
    }
    const reset = await resetWorktreeToHead({ worktreePath: latest.worktreePath, recordedHost });
    if (reset.outcome !== 'reset') {
      return false;
    }
    const cancelled = await cancel.cancelPreparedAttempt({ attemptId: latest.id, nowIso: request.nowIso });
    if (cancelled.outcome !== 'cancelled') {
      return false;
    }
    await append({
      id: latest.id + ':dispatch:' + String(priorEntries.length + 2),
      attemptId: latest.id,
      workOrderId: record.workOrderId,
      action: 'dispatch',
      baseCommit: latest.baseCommit,
      recordedAtIso: request.nowIso,
      status: 'completed',
      sessionId: null,
      detail: 'preserved uncommitted edits: ' + patchPath,
    });
    return true;
  } catch {
    return false;
  }
}

function recoveryInputsValid(
  recovery: AdvanceStepContext['deps']['worktreeRecovery'],
  latest: AttemptRecord,
  append: unknown,
): boolean {
  if (recovery?.preserveWorktreeEdits === undefined || recovery.resetWorktreeToHead === undefined || append === undefined) {
    return false;
  }
  if (latest.state !== 'cancelled' || latest.worktreePath === null) {
    return false;
  }
  return worktreeRecoveryPatchInputsValid(latest.worktreePath, latest.id);
}

function hasSavedPatchVerifier(
  candidate: object,
): candidate is { verifySavedPatch(request: VerifySavedPatchRequest): Promise<boolean> } {
  return 'verifySavedPatch' in candidate && typeof candidate.verifySavedPatch === 'function';
}

async function canProceedWithReconcileReset(
  recovery: NonNullable<AdvanceStepContext['deps']['worktreeRecovery']>,
  preserved: PreserveWorktreeEditsResult,
  worktreePath: string,
  patchPath: string,
  recordedHost: AttemptRunnerRecord,
): Promise<boolean> {
  if (preserved.outcome === 'preserved') {
    return true;
  }
  if (preserved.outcome === 'refused' && preserved.reason === 'destination-exists') {
    if (!hasSavedPatchVerifier(recovery)) {
      return false;
    }
    return recovery.verifySavedPatch({ worktreePath, patchPath, recordedHost });
  }
  return false;
}

/**
 * GB3: reconcile a crashed recovery whose attempt is already `cancelled` —
 * the crash landed after the cancel but before the recovery's completing
 * journal entry, so the intent is open while the next advance would otherwise
 * prepare the next seat over an unreconciled recovery. The preserve and reset
 * side effects may already have run, so the reconcile does not re-run them
 * blindly: a `destination-exists` preserve proves the patch survived the
 * crash, but reset is only repeated if the saved patch passes verification
 * against the current worktree; otherwise keep the park.
 */
async function reconcileCancelledWorktreeRecovery(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  latest: AttemptRecord,
  request: AdvanceLaneRunRequest,
): Promise<boolean> {
  const recovery = ctx.deps.worktreeRecovery;
  const preserveWorktreeEdits = recovery?.preserveWorktreeEdits?.bind(recovery);
  const resetWorktreeToHead = recovery?.resetWorktreeToHead?.bind(recovery);
  const append = ctx.deps.executionJournal.appendJournalEntry?.bind(ctx.deps.executionJournal);
  if (!recoveryInputsValid(recovery, latest, append)) {
    return false;
  }
  const recordedHost = conductedRunnerOf(latest);
  if (
    recordedHost === null ||
    latest.worktreePath === null ||
    recovery === undefined ||
    preserveWorktreeEdits === undefined ||
    resetWorktreeToHead === undefined ||
    append === undefined
  ) {
    return false;
  }
  const patchPath = latest.worktreePath + '.' + latest.id + '.patch';
  try {
    const preserved = await preserveWorktreeEdits(
      { worktreePath: latest.worktreePath, patchPath, recordedHost },
    );
    const canReset = await canProceedWithReconcileReset(
      recovery,
      preserved,
      latest.worktreePath,
      patchPath,
      recordedHost,
    );
    if (!canReset) {
      return false;
    }
    const reset = await resetWorktreeToHead({ worktreePath: latest.worktreePath, recordedHost });
    if (reset.outcome !== 'reset') {
      return false;
    }
    const priorEntries = await ctx.deps.executionJournal.listJournalEntriesForAttempt(latest.id);
    await append({
      id: latest.id + ':dispatch:' + String(priorEntries.length + 1),
      attemptId: latest.id,
      workOrderId: record.workOrderId,
      action: 'dispatch',
      baseCommit: latest.baseCommit,
      recordedAtIso: request.nowIso,
      status: 'completed',
      sessionId: null,
      detail: 'preserved uncommitted edits: ' + patchPath,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * G11a: the seat-advance detail token of a failed dispatch, or null when no
 * advance may be recorded (fail closed). The failed turn's own plan, role and
 * seat index and its stored stop reason decide; the reviewer-family block
 * uses the installation-configured `sameModelFamily` comparator. A plan the
 * attempt does not carry, a non-implementer
 * role, an out-of-plan seat index or a stop reason that maps to no failure
 * outcome each record nothing — the run keeps its pre-G11a behaviour. An
 * unbound comparator fails closed: the failure records its outcome with no
 * next seat, so the facts never re-derive one from the history.
 * The token is a fixed `next-seat-<outcome>-<index>` code naming the failure
 * outcome, or `next-seat-<outcome>-none` when no seat is allowed — both the
 * failure outcome and the selected next seat in one fixed code (validated by
 * the journal's token pattern), never free text, so replay of the spent key
 * can never record a second move.
 */
function seatAdvanceDetail(
  ctx: AdvanceStepContext,
  failed: AttemptRecord,
  storedStopReason: unknown,
): string | null {
  const selection = failed.seatSelection ?? null;
  const role: SeatPlanRole | null = selection?.role ?? null;
  if (role !== 'first-pass' && role !== 'fix') {
    return null;
  }
  const planResult = SeatPlan.create(failed.seatPlan);
  const plan = planResult.success && planResult.value !== undefined ? planResult.value : null;
  if (plan === null || selection === null || typeof selection.seatIndex !== 'number') {
    return null;
  }
  const outcome: SeatFailureOutcome | null = seatOutcomeOfStopReason(parseStopReason(storedStopReason));
  const sameFamily = ctx.deps.sameModelFamily;
  if (outcome === null) {
    return 'next-seat-none';
  }
  if (sameFamily === undefined) {
    // Fail closed: without the configured family comparator no seat may be
    // picked, and leaving the advance unrecorded would let the facts re-derive
    // one from the history. The failure records its outcome with no next
    // seat, so the run parks for the owner instead of moving.
    return 'next-seat-' + outcome + '-none';
  }
  // A model-refusal stop keeps the failed model out of the rest of the lane
  // (the same rule selectSeat applies over history), so the failed seat and
  // any seat on its model are blocked. Reviewer independence (rule 9) is
  // composed on top: a seat sharing a model family with any review seat of
  // the frozen plan is blocked, exactly what `seatPlanFamilyConflicts`
  // refuses a plan for.
  const refusedModel = MODEL_REFUSAL_CLASSES.includes(parseStopReason(storedStopReason))
    ? (selection.model ?? '').trim()
    : null;
  const reviewerModels = plan.getSeats('review').map((seat) => seat.model);
  const chosen = pickNextSeat(plan, role, selection.seatIndex, outcome, (seat) =>
    (refusedModel !== null && seat.model.trim() === refusedModel) ||
    reviewerModels.some((model) => sameFamily(seat.model, model)),
  );
  return seatAdvanceTokenOf(chosen, outcome);
}

/** The fixed detail token of a pick: `next-seat-<outcome>-<index>`, or `next-seat-<outcome>-none` when no seat is allowed. */
function seatAdvanceTokenOf(chosen: NextSeatResult, outcome: SeatFailureOutcome): string {
  return chosen.ok
    ? 'next-seat-' + outcome + '-' + String(chosen.seatIndex)
    : 'next-seat-' + outcome + '-none';
}

/**
 * The `act dispatch` decision (K4-5): start the prepared attempt through
 * `DispatchAttemptPort` with the frozen brief's limits, raising the round and
 * the seat cursor on the record before the call (§3.2, D8). The dispatch key
 * is one-way: when a reconcile already recorded the dispatch as never
 * started but its cancel did not land, the attempt is cancelled instead of
 * re-sending the key. A pivot dispatches with a conductor seat override.
 */
export async function performDispatch(ctx: AdvanceStepContext,
  record: LaneRunRecord,
  gathered: GatheredLaneRunFacts,
  decision: Extract<LaneRunDecision, { kind: 'act' }>,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunResult> {
  const facts = gathered.facts;
  const ceiling = await ceilingPark(ctx, record, gathered, request);
  if (ceiling !== null) {
    return ceiling;
  }
  const dispatch = ctx.deps.dispatchAttempt;
  if (dispatch === undefined) {
    return { outcome: 'not-wired', step: decision.step };
  }
  const nowIso = request.nowIso;
  const latest = gathered.latestAttempt;
  if (latest === null || latest.state !== 'intent-recorded') {
    return { outcome: 'waiting', reason: 'facts-inconsistent' };
  }
  if (facts.attempt !== null && facts.attempt.dispatchResult === 'not-started') {
    const cancel = ctx.deps.cancelPreparedAttempt;
    if (cancel === undefined) {
      return { outcome: 'not-wired', step: decision.step };
    }
    // GB3: an attempt with an incomplete worktree recovery (a durable recovery
    // intent without its completing journal entry) must not cancel-and-advance
    // here: the preserve/reset/cancel side effects may be unfinished. Park, and
    // the run stays parked until recovery is durably complete or an owner acts.
    if (await hasIncompleteWorktreeRecovery(ctx, latest.id)) {
      return performPark(ctx, record, 'step-refused', 'dispatch', facts.state, request);
    }
    await cancel.cancelPreparedAttempt({ attemptId: latest.id, nowIso });
    return { outcome: 'waiting', reason: 'dispatch-pending' };
  }
  // The dispatch key is one-way (KF-10): an intent already recorded for this
  // key is never re-sent. A spent key parks step-refused dispatch without
  // writing (the parkSpentOneWayKey shape from merge.ts) instead of hitting
  // the journal's duplicate-key refusal on every resume. The `not-started`
  // cancel above owns the refused-dispatch pivot, so it runs first.
  const spent = await parkSpentOneWayKey(ctx, record, gathered, decision, request);
  if (spent !== null) {
    return spent;
  }
  const manifest = await readVerifiedFrozenManifest(latest, ctx.deps.artifactPort, ctx.deps.computeDigest);
  const stepLimit = manifestPositiveInteger(manifest, 'stepLimit');
  const timeLimitSeconds = manifestTimeLimitSeconds(manifest);
  const expectedArtifacts = manifestExpectedArtifacts(manifest);
  const briefPackagePath = latest.briefPackagePath;
  const briefDigest = latest.briefDigest;
  const inputsReadable =
    stepLimit !== null &&
    timeLimitSeconds !== null &&
    expectedArtifacts !== null &&
    briefPackagePath !== null &&
    briefDigest !== null;
  // KF-18: a fix attempt dispatches on its own fix seat through a seat
  // override; the seat-plan pivot keeps its override; a first attempt and a
  // fix attempt with no selection carry none. A fix seat the override cannot
  // name exactly (not the frozen plan's fix seat at its index, another tool
  // than the frozen assignment's, or an agent left unset where the assignment
  // sets one) never dispatches: it refuses and parks with a fixed detail,
  // never a guessed or inherited seat field.
  const fixSeat = fixSeatForDispatch(latest, manifest);
  if (fixSeat.kind !== 'refused' && inputsReadable && request.startGate !== undefined) {
    // The wait sits before the one-way intent, so a crash during the wait spends no key.
    if (!request.startGate.tryStart(request.runId, request.nowIso).ok) {
      return { outcome: 'waiting', reason: 'session-stagger' };
    }
  }
  const intentRefusal = await appendRunIntent(ctx, request, decision.key, latest.id);
  if (intentRefusal !== null) {
    return { outcome: 'refused', reason: intentRefusal };
  }
  if (fixSeat.kind === 'refused') {
    const resultRefusal = await appendRunResult(
      ctx, request, decision.key, 'refused', 'dispatch-refused', fixSeat.detail,
    );
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return performPark(ctx, record, 'step-refused', 'dispatch', facts.state, request);
  }
  if (!inputsReadable) {
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'refused', 'dispatch-inputs-unreadable');
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    return performPark(ctx, record, 'step-refused', 'dispatch', facts.state, request);
  }
  const role = implementerRoleFor(decision.round, facts.state);
  const roundRaised = decision.round > record.round;
  if (roundRaised || record.cursors[role] !== decision.seatIndex) {
    const cursors: LaneRunCursorsRecord =
      role === 'first-pass'
        ? { ...record.cursors, 'first-pass': decision.seatIndex }
        : { ...record.cursors, fix: decision.seatIndex };
    const saved = await saveOrRefuse(ctx,
      {
        ...record,
        round: roundRaised ? decision.round : record.round,
        cursors,
        revision: record.revision + 1,
      },
      request,
    );
    if (!saved.ok) {
      // The pending intent is reconciled by K4-7 as never started; the
      // dispatch is never called on a refused save.
      return { outcome: 'refused', reason: saved.reason };
    }
    // Later writes in this advance (a park) must chain on the saved revision.
    record = saved.record ?? record;
  }
  const seatForOverride: AttemptSeatSelectionRecord | null =
    latest.kind === 'initial' && latest.priorAttemptId !== null
      ? (latest.seatSelection ?? null)
      : fixSeat.kind === 'seat'
        ? fixSeat.seat
        : null;
  const seatOverride: AttemptSeatOverrideRecord | null =
    seatForOverride === null
      ? null
      : {
          model: seatForOverride.model,
          ...(seatForOverride.agent !== null ? { agent: seatForOverride.agent } : {}),
          ...(seatForOverride.variant !== null ? { variant: seatForOverride.variant } : {}),
          ...(fixSeat.kind === 'seat' && fixSeat.overrideVariant !== undefined ? { variant: fixSeat.overrideVariant } : {}),
          reason:
            latest.kind === 'fix'
              ? 'fix seat ' + seatForOverride.seatId
              : 'seat-plan pivot to ' + seatForOverride.seatId,
          setBy: 'conductor',
          expiresAtIso: new Date(Date.parse(nowIso) + timeLimitSeconds * 1000).toISOString(),
        };
  const dispatched = await dispatch.dispatchAttempt({
    attemptId: latest.id,
    workOrderId: record.workOrderId,
    worktreePath: latest.worktreePath,
    briefPackagePath,
    briefDigest,
    baseCommit: latest.baseCommit,
    stepLimit,
    timeLimitSeconds,
    expectedArtifacts,
    nowIso,
    ...(seatOverride !== null ? { seatOverride } : {}),
    ...(ctx.deps.installationSchemaVersion !== undefined
      ? { installationSchemaVersion: ctx.deps.installationSchemaVersion }
      : {}),
  });
  if (dispatched.outcome === 'started' || dispatched.outcome === 'blocked' || dispatched.outcome === 'unknown') {
    let reasonCode: LaneRunResultReasonCode;
    if (dispatched.outcome === 'started') {
      reasonCode = 'dispatch-started';
    } else if (dispatched.outcome === 'blocked') {
      reasonCode = 'dispatch-blocked';
    } else {
      reasonCode = 'dispatch-unknown';
    }
    const resultRefusal = await appendRunResult(ctx, request, decision.key, 'completed', reasonCode);
    if (resultRefusal !== null) {
      return { outcome: 'refused', reason: resultRefusal };
    }
    const conductRefusal = await conductDispatching(ctx, facts.state, request);
    if (conductRefusal !== null) {
      return { outcome: 'refused', reason: conductRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'completed', reasonCode };
  }
  // Refused: a runner refusal saved with its stop reason (S1) pivots through
  // seat-failed; anything else parks for the owner (the key is spent). A
  // refused FIX dispatch recovers in the same round after resume: the round
  // is already raised here, so the decider re-reads the parked attempt as
  // still this round's and the next advance cancels it and prepares again
  // at that round (KF-17).
  const stored = await ctx.deps.attemptRepo.findAttemptById(latest.id);
  let reasonCode: LaneRunResultReasonCode;
  if (stored !== null && stored.state === 'cancelled') {
    reasonCode = 'runner-refused';
  } else {
    reasonCode = 'dispatch-refused';
  }
  // KF-16: the refused result journals a fixed detail code derived from the
  // refusal text, for the dispatch-refused park and the runner-refused pivot
  // alike. G11a: a runner refusal is the provider-outcome boundary — the
  // failure's one move (the next seat, or that no seat is allowed) is
  // recorded on THIS key's final result, so replay of the spent key cannot
  // select or record a second move.
  const advanceDetail =
    reasonCode === 'runner-refused' ? seatAdvanceDetail(ctx, latest, stored?.stopReason) : null;
  const resultRefusal = await appendRunResult(
    ctx, request, decision.key, 'refused', reasonCode,
    advanceDetail ?? dispatchRefusalDetail(dispatched.reason),
  );
  if (resultRefusal !== null) {
    return { outcome: 'refused', reason: resultRefusal };
  }
  // GB3: for a refused dispatch whose detail is `worktree-uncommitted`, preserve
  // the never-dispatched attempt's uncommitted edits as a patch outside the
  // worktree, reset the worktree to its head, cancel the attempt, and journal
  // the patch path. The spent refusal key is already recorded above. Success
  // returns acted without parking so the next advance prepares the next seat;
  // any failure (or unwired recovery) keeps today's park exactly.
  if (reasonCode === 'dispatch-refused' && dispatchRefusalDetail(dispatched.reason) === 'worktree-uncommitted') {
    const recovered = await recoverUncommittedWorktree(ctx, record, latest, request);
    if (recovered) {
      return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode };
    }
  }
  if (reasonCode === 'runner-refused') {
    const conductRefusal = await conductDispatching(ctx, facts.state, request);
    if (conductRefusal !== null) {
      return { outcome: 'refused', reason: conductRefusal };
    }
    return { outcome: 'acted', step: decision.step, key: decision.key, result: 'refused', reasonCode };
  }
  return performPark(ctx, record, 'step-refused', 'dispatch', facts.state, request);
}

/** The `dispatching` conduct entry after a dispatch, unless the run is already in it. */
export async function conductDispatching(ctx: AdvanceStepContext,
  state: LaneRunStateValue,
  request: AdvanceLaneRunRequest,
): Promise<AdvanceLaneRunRefusal | null> {
  if (state === 'dispatching') {
    return null;
  }
  const appended = await appendConduct(ctx, request, 'dispatching');
  return appended.ok ? null : appended.reason;
}
