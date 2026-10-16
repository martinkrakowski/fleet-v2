// Implemented for migration step 2 — durable dispatch intent before the runner.
/**
 * DispatchAttemptUseCase: start one prepared, capacity-reserved attempt after
 * the work order, the reservation, the runner's isolation capabilities and
 * the worktree state are verified. The dispatch intent is durable in the
 * journal before the runner subprocess is started. An unknown start outcome
 * keeps the reservation and enters reconciliation; it is never retried
 * blindly and never releases capacity.
 */

import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  AttemptRunnerRecord,
} from '../../domain/execution-records.js';
import { underlyingModelFamily } from '../../domain/execution-records.js';
import type { DispatchAttemptPort, DispatchAttemptRequest, DispatchAttemptResult } from '../ports/in/DispatchAttemptPort.in-port.js';
import type { RunnerIsolationCapabilities } from '../ports/out/ExecutionRunnerPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { ExecutionObservationPort } from '../ports/out/ExecutionObservationPort.out-port.js';
import type { ExecutionRunnerPort } from '../ports/out/ExecutionRunnerPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { WorkspacePort } from '../ports/out/WorkspacePort.out-port.js';

export interface DispatchAttemptDependencies {
  readonly workOrderRepo: WorkOrderRepositoryPort;
  readonly attemptRepo: AttemptRepositoryPort;
  readonly journal: ExecutionJournalPort;
  readonly workspace: WorkspacePort;
  readonly runner: ExecutionRunnerPort;
  readonly observation?: ExecutionObservationPort;
}

/** Boolean capabilities a dispatch may require the runner to enforce. */
const REQUIRED_BOOLEAN_CAPABILITIES: readonly (keyof RunnerIsolationCapabilities)[] = [
  'networkEgressRestricted',
  'cpuAndMemoryLimited',
  'processTreeTermination',
  'authoritativeCompletion',
  'artifactPersistence',
];

type JournalEntryDraft = Omit<ActionJournalEntryRecord, 'id'>;

/**
 * Append one journal entry with a deterministic identity derived from the
 * attempt's append-only history. Intent must be durable before the runner
 * subprocess runs, so every lifecycle use case appends through here.
 */
async function appendJournalEntry(
  journal: ExecutionJournalPort,
  draft: JournalEntryDraft,
): Promise<ActionJournalEntryRecord> {
  const priorEntries = await journal.listJournalEntriesForAttempt(draft.attemptId);
  const entry: ActionJournalEntryRecord = {
    ...draft,
    id: `${draft.attemptId}:${draft.action}:${priorEntries.length + 1}`,
  };
  await journal.appendJournalEntry(entry);
  return entry;
}

export class DispatchAttemptUseCase implements DispatchAttemptPort {
  constructor(private readonly deps?: DispatchAttemptDependencies) {}

  async dispatchAttempt(request: DispatchAttemptRequest): Promise<DispatchAttemptResult> {
    if (!this.deps) {
      throw new Error('Not implemented: DispatchAttemptUseCase');
    }

    const workOrder = await this.deps.workOrderRepo.findWorkOrderById(request.workOrderId);
    if (!workOrder) {
      return { outcome: 'refused', reason: `Work order not found: ${request.workOrderId}` };
    }
    if (workOrder.state === 'merged' || workOrder.state === 'stopped') {
      return {
        outcome: 'refused',
        reason: `Work order ${workOrder.id} is ${workOrder.state} and accepts no further dispatch`,
      };
    }

    const activeReservations = await this.deps.journal.listActiveReservations();
    if (!activeReservations.some((reservation) => reservation.attemptId === request.attemptId && reservation.held)) {
      return { outcome: 'refused', reason: 'No active capacity reservation for attempt' };
    }

    const runnerCapabilities = this.deps.runner.describeCapabilities();
    const requiredCapabilities = request.requiredCapabilities;
    const capabilitiesMissing =
      runnerCapabilities.filesystemScope !== 'scoped-worktree' ||
      (requiredCapabilities
        ? REQUIRED_BOOLEAN_CAPABILITIES.some(
            (capability) => requiredCapabilities[capability] && !runnerCapabilities[capability],
          )
        : false);
    if (capabilitiesMissing) {
      return { outcome: 'refused', reason: 'Runner capabilities do not satisfy required isolation' };
    }

    const inspection = await this.deps.workspace.inspectWorktree({
      worktreePath: request.worktreePath,
      baseCommit: request.baseCommit,
      expectedArtifactPaths: request.expectedArtifacts ?? [],
    });
    if (!inspection.matchesBaseCommit) {
      return {
        outcome: 'refused',
        reason: `Worktree ${request.worktreePath} does not match the base commit (checked out ${inspection.checkedOutCommit})`,
      };
    }
    if (inspection.uncommittedPaths.length > 0) {
      return {
        outcome: 'refused',
        reason: `Worktree ${request.worktreePath} has uncommitted changes: ${inspection.uncommittedPaths.join(', ')}`,
      };
    }
    if (inspection.untrackedPaths.length > 0) {
      return {
        outcome: 'refused',
        reason: `Worktree ${request.worktreePath} has untracked files: ${inspection.untrackedPaths.join(', ')}`,
      };
    }
    const preparedBriefInWorktree =
      request.briefPackagePath === '.lane/brief.md' ||
      request.briefPackagePath === `${request.worktreePath.replace(/\/+$/, '')}/.lane/brief.md`;
    const activeBriefFiles = preparedBriefInWorktree
      ? new Set(['.lane/brief.md', '.lane/brief-manifest.json'])
      : new Set<string>();
    const unexpectedResidue = inspection.residueFromEarlierAttempts.filter(
      (entry) => !activeBriefFiles.has(entry),
    );
    if (unexpectedResidue.length > 0) {
      return {
        outcome: 'refused',
        reason: `Worktree ${request.worktreePath} contains residue from earlier attempts: ${unexpectedResidue.join(', ')}`,
      };
    }

    const nowIso = request.nowIso ?? new Date().toISOString();

    const existingAttempt = await this.deps.attemptRepo.findAttemptById(request.attemptId);

    // Validate seat override if provided (ADDITION)
    if (request.seatOverride) {
      if (!request.seatOverride.reason || request.seatOverride.reason.trim() === '') {
        return { outcome: 'refused', reason: 'Seat override requires an explicit reason' };
      }
      if (request.seatOverride.expiresAtIso && request.seatOverride.expiresAtIso <= nowIso) {
        return {
          outcome: 'refused',
          reason: `Seat override expired at ${request.seatOverride.expiresAtIso}`,
        };
      }
      const recordedReviewer = request.reviewerSeat ?? existingAttempt?.reviewerSeat;
      if (
        recordedReviewer &&
        underlyingModelFamily(request.seatOverride.model) ===
          underlyingModelFamily(recordedReviewer)
      ) {
        return {
          outcome: 'refused',
          reason: `Seat override model '${request.seatOverride.model}' shares underlying model family with recorded reviewer seat '${recordedReviewer}'`,
        };
      }
    }

    const effectiveModel =
      request.seatOverride?.model ??
      request.modelAssignment?.model ??
      request.model;
    const effectiveAgent =
      request.seatOverride?.agent ??
      request.modelAssignment?.agent ??
      request.agent;
    const effectiveVariant =
      request.seatOverride?.variant ??
      request.modelAssignment?.variant ??
      request.variant;

    // Refuse to start when no model is known
    if (!effectiveModel || effectiveModel.trim() === '') {
      return { outcome: 'refused', reason: 'No model specified for dispatch' };
    }

    // Durable intent first: the journal records the dispatch before the
    // runner subprocess is contacted.
    await appendJournalEntry(this.deps.journal, {
      attemptId: request.attemptId,
      workOrderId: request.workOrderId,
      action: 'dispatch',
      baseCommit: request.baseCommit,
      recordedAtIso: nowIso,
      status: 'intent-recorded',
      sessionId: null,
      detail: 'Dispatch intent recorded before runner start',
    });

    if (request.seatOverride) {
      await appendJournalEntry(this.deps.journal, {
        attemptId: request.attemptId,
        workOrderId: request.workOrderId,
        action: 'dispatch',
        baseCommit: request.baseCommit,
        recordedAtIso: nowIso,
        status: 'intent-recorded',
        sessionId: null,
        detail: `Seat override recorded: ${request.seatOverride.model} (by ${request.seatOverride.setBy}, reason: ${request.seatOverride.reason}${request.seatOverride.expiresAtIso ? `, expires: ${request.seatOverride.expiresAtIso}` : ''})`,
      });
    }

    const runnerInfo = this.deps.runner.describeRunner?.();
    const runnerPort = runnerInfo?.remotePort ?? request.runnerPort;
    const runnerHost = runnerInfo?.host ?? request.runnerHost ?? null;
    const initialRunner: AttemptRunnerRecord | null =
      runnerPort !== undefined
        ? {
            remotePort: runnerPort,
            host: runnerHost,
            agent: effectiveAgent ?? runnerInfo?.agent ?? null,
            model: effectiveModel,
            variant: effectiveVariant ?? runnerInfo?.variant ?? null,
          }
        : null;

    const dispatchingAttempt: AttemptRecord = existingAttempt
      ? {
          ...existingAttempt,
          worktreePath: request.worktreePath,
          baseCommit: request.baseCommit,
          state: 'dispatching',
          briefDigest: request.briefDigest,
          briefPackagePath: request.briefPackagePath,
          sessionId: null,
          runner: initialRunner ?? existingAttempt.runner ?? null,
          seatOverride: request.seatOverride ?? existingAttempt.seatOverride ?? null,
          reviewerSeat: request.reviewerSeat ?? existingAttempt.reviewerSeat ?? null,
          updatedAtIso: nowIso,
        }
      : {
          id: request.attemptId,
          workOrderId: request.workOrderId,
          kind: 'initial',
          fixNumber: 0,
          priorAttemptId: null,
          worktreePath: request.worktreePath,
          baseCommit: request.baseCommit,
          state: 'dispatching',
          outcome: null,
          briefDigest: request.briefDigest,
          briefPackagePath: request.briefPackagePath,
          sessionId: null,
          completionReceipt: null,
          artifacts: null,
          runner: initialRunner,
          seatOverride: request.seatOverride ?? null,
          reviewerSeat: request.reviewerSeat ?? null,
          createdAtIso: nowIso,
          updatedAtIso: nowIso,
        };
    await this.deps.attemptRepo.saveAttempt(dispatchingAttempt);

    const startResult = await this.deps.runner.startSession({
      attemptId: request.attemptId,
      worktreePath: request.worktreePath,
      briefPackagePath: request.briefPackagePath,
      baseCommit: request.baseCommit,
      stepLimit: request.stepLimit,
      timeLimitSeconds: request.timeLimitSeconds,
      requiredCapabilities: request.requiredCapabilities,
      model: effectiveModel,
      agent: effectiveAgent,
      variant: effectiveVariant,
      seatOverride: request.seatOverride,
      modelAssignment: request.modelAssignment,
    });

    if (startResult.outcome === 'started') {
      const runningAttempt: AttemptRecord = {
        ...dispatchingAttempt,
        state: 'running',
        sessionId: startResult.sessionId,
        runner: startResult.runner ?? dispatchingAttempt.runner ?? null,
        updatedAtIso: nowIso,
      };
      await this.deps.attemptRepo.saveAttempt(runningAttempt);
      const completedEntry = await appendJournalEntry(this.deps.journal, {
        attemptId: request.attemptId,
        workOrderId: request.workOrderId,
        action: 'dispatch',
        baseCommit: request.baseCommit,
        recordedAtIso: nowIso,
        status: 'completed',
        sessionId: startResult.sessionId,
        detail: `Session started: ${startResult.sessionId}`,
      });
      if (this.deps.observation) {
        // A delivery gap is preserved and visible; it never fails the lane.
        await this.deps.observation.publishExecutionObservation({
          entry: completedEntry,
          projectId: workOrder.projectId,
        });
      }
      return { outcome: 'started', attempt: runningAttempt, sessionId: startResult.sessionId };
    }

    if (startResult.outcome === 'unknown') {
      // Unknown keeps the reservation; reconciliation decides before retry.
      const reconcilingAttempt: AttemptRecord = {
        ...dispatchingAttempt,
        state: 'reconciling',
        updatedAtIso: nowIso,
      };
      await this.deps.attemptRepo.saveAttempt(reconcilingAttempt);
      await appendJournalEntry(this.deps.journal, {
        attemptId: request.attemptId,
        workOrderId: request.workOrderId,
        action: 'dispatch',
        baseCommit: request.baseCommit,
        recordedAtIso: nowIso,
        status: 'ambiguous',
        sessionId: null,
        detail: startResult.reason,
      });
      return { outcome: 'unknown', attempt: reconcilingAttempt, reason: startResult.reason };
    }

    const cancelledAttempt: AttemptRecord = {
      ...dispatchingAttempt,
      state: 'cancelled',
      updatedAtIso: nowIso,
    };
    await this.deps.attemptRepo.saveAttempt(cancelledAttempt);
    await appendJournalEntry(this.deps.journal, {
      attemptId: request.attemptId,
      workOrderId: request.workOrderId,
      action: 'dispatch',
      baseCommit: request.baseCommit,
      recordedAtIso: nowIso,
      status: 'refused',
      sessionId: null,
      detail: startResult.reason,
    });
    await this.deps.journal.releaseCapacityReservation(request.attemptId, nowIso);
    return { outcome: 'refused', reason: startResult.reason };
  }

  async execute(input?: unknown): Promise<DispatchAttemptResult> {
    // Unconfigured is 501 and is checked before any request validation.
    if (!this.deps) {
      throw new Error('Not implemented: DispatchAttemptUseCase');
    }
    // A configured runtime still refuses a missing request object instead of
    // inventing one; the HTTP boundary always supplies an object body, and an
    // empty object body flows into the validation below as a refusal.
    if (!input || typeof input !== 'object') {
      throw new Error('Not implemented: DispatchAttemptUseCase');
    }
    return this.dispatchAttempt(input as DispatchAttemptRequest);
  }
}
