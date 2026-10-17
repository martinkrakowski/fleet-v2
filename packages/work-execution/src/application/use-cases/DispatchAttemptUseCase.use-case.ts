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
import { isSameModelFamily, underlyingModelFamily } from '@fleet/evidence-and-acceptance';
import type { DispatchAttemptPort, DispatchAttemptRequest, DispatchAttemptResult } from '../ports/in/DispatchAttemptPort.in-port.js';
import type { RunnerIsolationCapabilities } from '../ports/out/ExecutionRunnerPort.out-port.js';
import type { AttemptArtifactPort } from '../ports/out/AttemptArtifactPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { ExecutionObservationPort } from '../ports/out/ExecutionObservationPort.out-port.js';
import type { ExecutionRunnerPort } from '../ports/out/ExecutionRunnerPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { WorkspacePort } from '../ports/out/WorkspacePort.out-port.js';
import type { RunnerSelectorPort } from '../ports/out/RunnerSelectorPort.out-port.js';

export interface DispatchAttemptDependencies {
  readonly workOrderRepo: WorkOrderRepositoryPort;
  readonly attemptRepo: AttemptRepositoryPort;
  readonly journal: ExecutionJournalPort;
  readonly workspace: WorkspacePort;
  readonly runner: ExecutionRunnerPort;
  readonly observation?: ExecutionObservationPort;
  readonly artifactPort?: AttemptArtifactPort;
  /**
   * Optional runner-kind selection (O14c1). When wired, an attempt whose seat
   * tool has no implemented runner (e.g. `agy`) refuses before any spawn.
   */
  readonly runnerSelector?: RunnerSelectorPort;
}

/** Boolean capabilities a dispatch may require the runner to enforce. */
const REQUIRED_BOOLEAN_CAPABILITIES: readonly (keyof RunnerIsolationCapabilities)[] = [
  'networkEgressRestricted',
  'cpuAndMemoryLimited',
  'processTreeTermination',
  'authoritativeCompletion',
  'artifactPersistence',
];

/**
 * The lane brief's runner requirements (D4): a scoped worktree with every
 * enforced isolation boolean. Requirements come from the frozen brief's lane
 * profile only — the request carries none, and an operator override is a
 * usage error at the boundaries.
 */
const BRIEF_RUNNER_REQUIREMENTS: RunnerIsolationCapabilities = {
  filesystemScope: 'scoped-worktree',
  networkEgressRestricted: true,
  cpuAndMemoryLimited: true,
  processTreeTermination: true,
  authoritativeCompletion: true,
  artifactPersistence: true,
};

type JournalEntryDraft = Omit<ActionJournalEntryRecord, 'id'>;

/**
 * Owner decision references as frozen in the brief package. An absent field is
 * an empty list; anything present that is not an array of non-empty strings is
 * malformed and returns null so the dispatch refuses.
 */
function readOwnerDecisionReferences(
  manifest: Record<string, unknown>,
): readonly string[] | null {
  const recorded = manifest.ownerDecisionReferences;
  if (recorded === undefined || recorded === null) {
    return [];
  }
  if (!Array.isArray(recorded)) {
    return null;
  }
  const references: string[] = [];
  for (const entry of recorded) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      return null;
    }
    references.push(entry.trim());
  }
  return references;
}

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

    const rawReq = request as unknown as Record<string, unknown>;
    for (const field of [
      'model',
      'agent',
      'variant',
      'modelAssignment',
      'runnerPort',
      'remotePort',
      'runnerHost',
      'host',
    ]) {
      if (rawReq[field] !== undefined) {
        return {
          outcome: 'refused',
          reason: `'${field}' must not be specified; the seat is determined by the frozen brief manifest`,
        };
      }
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
    // Requirements come from the frozen brief's lane profile only; the
    // request carries no requirements field.
    const requiredCapabilities = BRIEF_RUNNER_REQUIREMENTS;
    const capabilitiesMissing =
      runnerCapabilities.filesystemScope !== 'scoped-worktree' ||
      REQUIRED_BOOLEAN_CAPABILITIES.some(
        (capability) => requiredCapabilities[capability] && !runnerCapabilities[capability],
      );
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

    const runnerInfo = this.deps.runner.describeRunner?.();
    if (!runnerInfo || runnerInfo.remotePort === null) {
      return { outcome: 'refused', reason: 'No runner port can be described for dispatch' };
    }
    const runnerPort = runnerInfo.remotePort;
    const runnerHost = runnerInfo.host ?? null;

    let manifestRaw: string | null = null;
    let parsedManifest: Record<string, unknown> | null = null;
    const manifestCandidates = [
      request.briefPackagePath,
      request.briefPackagePath.replace(/\.md$/, '-manifest.json'),
      '.lane/brief-manifest.json',
    ];
    try {
      for (const candidate of manifestCandidates) {
        let raw: string | null = null;
        if (this.deps.artifactPort?.readBriefManifest) {
          raw = await this.deps.artifactPort.readBriefManifest(
            request.worktreePath,
            candidate,
          );
        } else if (this.deps.workspace.readWorktreeFile) {
          raw = await this.deps.workspace.readWorktreeFile(
            request.worktreePath,
            candidate,
          );
        }
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
              manifestRaw = raw;
              parsedManifest = parsed as Record<string, unknown>;
              break;
            }
          } catch {
            // Candidate was not JSON, try next candidate
          }
        }
      }
    } catch (error) {
      return {
        outcome: 'refused',
        reason: `Failed to read brief manifest: ${String(error)}`,
      };
    }

    if (!manifestRaw || !parsedManifest) {
      return {
        outcome: 'refused',
        reason: `Unable to read frozen brief manifest for attempt ${request.attemptId}`,
      };
    }

    const manifestModelAssignment = parsedManifest.modelAssignment as
      | { readonly model?: string; readonly agent?: string; readonly variant?: string }
      | undefined;

    if (!manifestModelAssignment || !manifestModelAssignment.model || manifestModelAssignment.model.trim() === '') {
      return {
        outcome: 'refused',
        reason: 'Frozen brief manifest contains no model assignment',
      };
    }

    // The one-way doors this attempt must clear come from the frozen brief
    // package the product prepared. An absent field means there are none; a
    // malformed one refuses dispatch rather than dispatching a lane whose
    // doors cannot be read later.
    const ownerDecisionReferences = readOwnerDecisionReferences(parsedManifest);
    if (ownerDecisionReferences === null) {
      return {
        outcome: 'refused',
        reason:
          "Frozen brief manifest 'ownerDecisionReferences' must be an array of non-empty strings when present",
      };
    }

    const nowIso = request.nowIso ?? new Date().toISOString();

    // O14c1: the seat's tool decides which runner kind runs the lane. The
    // frozen brief records the seat tool; a brief from before it did carries
    // an opencode seat. A selection without an implemented runner refuses
    // before the dispatch intent is recorded and before anything spawns.
    if (this.deps.runnerSelector) {
      const manifestSeatTool = parsedManifest.seatTool;
      const seatTool =
        typeof manifestSeatTool === 'string' && manifestSeatTool.trim() !== ''
          ? manifestSeatTool.trim()
          : 'opencode';
      const selection = this.deps.runnerSelector.selectRunner({ seatTool });
      if (!selection.ok) {
        return { outcome: 'refused', reason: selection.reason };
      }
    }

    const existingAttempt = await this.deps.attemptRepo.findAttemptById(request.attemptId);

    const manifestReviewer = typeof parsedManifest.independentReviewer === 'string'
      ? parsedManifest.independentReviewer
      : (parsedManifest.reviewerSeat as string | undefined);
    const fallbackReviewer =
      typeof manifestReviewer === 'string' && manifestReviewer.trim().length > 0
        ? manifestReviewer.trim()
        : null;

    // Validate seat override if provided
    if (request.seatOverride) {
      if (!request.seatOverride.reason || request.seatOverride.reason.trim() === '') {
        return { outcome: 'refused', reason: 'Seat override requires an explicit reason' };
      }
      if (!request.seatOverride.setBy || request.seatOverride.setBy.trim() === '') {
        return { outcome: 'refused', reason: 'Seat override requires an explicit setBy operator' };
      }
      if (!request.seatOverride.expiresAtIso || request.seatOverride.expiresAtIso.trim() === '') {
        return { outcome: 'refused', reason: 'Seat override requires an explicit expiresAtIso timestamp' };
      }
      const expiresMs = Date.parse(request.seatOverride.expiresAtIso);
      const nowMs = Date.parse(nowIso);
      if (Number.isNaN(expiresMs) || expiresMs <= nowMs) {
        return {
          outcome: 'refused',
          reason: `Seat override expired at ${request.seatOverride.expiresAtIso}`,
        };
      }
      const candidateReviewers = [
        existingAttempt?.reviewerSeat,
        request.reviewerSeat,
        fallbackReviewer,
      ].filter((seat): seat is string => typeof seat === 'string' && seat.trim().length > 0);

      for (const recordedReviewer of candidateReviewers) {
        if (
          isSameModelFamily(
            underlyingModelFamily(request.seatOverride.model),
            underlyingModelFamily(recordedReviewer),
          )
        ) {
          return {
            outcome: 'refused',
            reason: `Seat override model '${request.seatOverride.model}' shares underlying model family with recorded reviewer seat '${recordedReviewer}'`,
          };
        }
      }
    }

    const effectiveModel = request.seatOverride?.model ?? manifestModelAssignment.model;
    const effectiveAgent = request.seatOverride?.agent ?? manifestModelAssignment.agent;
    const effectiveVariant = request.seatOverride?.variant ?? manifestModelAssignment.variant;

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
        detail: `Seat override recorded: ${request.seatOverride.model} (by ${request.seatOverride.setBy}, reason: ${request.seatOverride.reason}, expires: ${request.seatOverride.expiresAtIso})`,
      });
    }

    const initialRunner: AttemptRunnerRecord = {
      kind: 'opencode',
      remotePort: runnerPort,
      host: runnerHost,
      // The installation host name travels with the record so a host's running
      // work can be found later. Legacy mode records null, as do records
      // written before the field existed.
      hostName: runnerInfo.hostName ?? null,
      agent: effectiveAgent ?? null,
      model: effectiveModel,
      variant: effectiveVariant ?? null,
    };

    const dispatchingAttempt: AttemptRecord = existingAttempt
      ? {
          ...existingAttempt,
          worktreePath: request.worktreePath,
          baseCommit: request.baseCommit,
          state: 'dispatching',
          briefDigest: request.briefDigest,
          briefPackagePath: request.briefPackagePath,
          sessionId: null,
          runner: initialRunner,
          seatOverride: request.seatOverride ?? existingAttempt.seatOverride ?? null,
          reviewerSeat: request.reviewerSeat ?? existingAttempt.reviewerSeat ?? fallbackReviewer,
          ownerDecisionReferences,
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
          reviewerSeat: request.reviewerSeat ?? fallbackReviewer,
          ownerDecisionReferences,
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
      requiredCapabilities,
      model: effectiveModel,
      agent: effectiveAgent,
      variant: effectiveVariant,
      seatOverride: request.seatOverride,
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
