// Implemented for migration step 2 — durable dispatch intent before the runner.
/**
 * DispatchAttemptUseCase: start one prepared, capacity-reserved attempt after
 * the work order, the reservation, the runner's isolation capabilities and
 * the worktree state are verified. The dispatch intent is durable in the
 * journal before the runner subprocess is started. An unknown start outcome
 * keeps the reservation and enters reconciliation; it is never retried
 * blindly and never releases capacity.
 *
 * Dispatch recomputes the frozen brief digest from the worktree's prose and
 * manifest before any save or runner contact and refuses a mismatch (D3): an
 * edited brief never dispatches.
 */

import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  AttemptRunnerRecord,
} from '../../domain/execution-records.js';
import { parseSeatTool } from '../../domain/execution-records.js';
import { validateWorktreeRelativePath } from '../../domain/worktree-path.js';
import {
  classifyRunnerRefusal,
  seatMatchesAssignment,
  seatSelectionRecord,
} from '../../domain/seat-selection.js';
import { SeatPlan } from '../../domain/value-objects/SeatPlan.vo.js';
import { isSameModelFamily, underlyingModelFamily } from '@fleet/evidence-and-acceptance';
import { simpleDeterministicHexDigest } from './PrepareBriefPackageUseCase.use-case.js';
import { checkFixPriorSettled } from './PrepareFixAttemptUseCase.use-case.js';
import type { DispatchAttemptPort, DispatchAttemptRequest, DispatchAttemptResult } from '../ports/in/DispatchAttemptPort.in-port.js';
import type { RunnerIsolationCapabilities } from '../ports/out/ExecutionRunnerPort.out-port.js';
import type { AttemptArtifactPort } from '../ports/out/AttemptArtifactPort.out-port.js';
import {
  AttemptRevisionConflictError,
  canOverwriteAfterConflict,
  nextAttemptRevision,
  type AttemptRepositoryPort,
} from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { ExecutionObservationPort } from '../ports/out/ExecutionObservationPort.out-port.js';
import type { ExecutionRunnerPort } from '../ports/out/ExecutionRunnerPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../ports/out/WorkOrderRepositoryPort.out-port.js';
import type { WorkspacePort } from '../ports/out/WorkspacePort.out-port.js';
import type { RunnerSelectorPort } from '../ports/out/RunnerSelectorPort.out-port.js';
import type { AllowedSeatPort } from '../ports/out/AllowedSeatPort.out-port.js';

export interface DispatchAttemptDependencies {
  readonly workOrderRepo: WorkOrderRepositoryPort;
  readonly attemptRepo: AttemptRepositoryPort;
  readonly journal: ExecutionJournalPort;
  readonly workspace: WorkspacePort;
  readonly runner: ExecutionRunnerPort;
  readonly observation?: ExecutionObservationPort;
  readonly artifactPort?: AttemptArtifactPort;
  /**
   * Infrastructure digest for the frozen-brief recompute; when absent the
   * pure helper is used, so the application layer stays free of Node
   * built-ins.
   */
  readonly computeDigest?: (content: string) => string;
  /**
   * Optional runner-kind selection (O14c1). When wired, an attempt whose seat
   * tool has no implemented runner (e.g. `agy`) refuses before any spawn.
   */
  readonly runnerSelector?: RunnerSelectorPort;
  /** Free-seat check (plan F3): refuses a free or unknown seat when wired. */
  readonly allowedSeats?: AllowedSeatPort;
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

/** Outcome of the post-`startSession` `running` save. */
type RunningSaveOutcome =
  | { readonly kind: 'saved'; readonly stored: AttemptRecord }
  | { readonly kind: 'conflict'; readonly result: DispatchAttemptResult };

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

/** The manifest's seat plan: absent, invalid (refuse), or a validated plan. */
function readManifestSeatPlan(
  manifest: Record<string, unknown>,
): { readonly kind: 'absent' } | { readonly kind: 'invalid'; readonly reason: string } | { readonly kind: 'plan'; readonly plan: SeatPlan } {
  if (manifest.seatPlan === undefined) {
    return { kind: 'absent' };
  }
  const created = SeatPlan.create(manifest.seatPlan);
  if (!created.success || created.value === undefined) {
    return { kind: 'invalid', reason: created.error?.message ?? 'unknown error' };
  }
  return { kind: 'plan', plan: created.value };
}

/** The seat fields a dispatch writes on the attempt, or a refusal. */
type SeatBinding =
  | { readonly ok: true; readonly fields: Pick<AttemptRecord, 'seatPlan' | 'seatSelection'> }
  | { readonly ok: false; readonly reason: string };

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

    // D3: a dispatch must carry the digest the frozen brief package was
    // prepared with; without it nothing can prove the brief did not change
    // between preparation and dispatch (for example a fix attempt whose
    // record has no digest).
    if (typeof request.briefDigest !== 'string' || request.briefDigest.trim() === '') {
      return {
        outcome: 'refused',
        reason: "briefDigest is required: dispatch only a brief prepared by 'brief prepare'",
      };
    }

    if (typeof request.briefPackagePath !== 'string' || !request.briefPackagePath.endsWith('.md')) {
      return {
        outcome: 'refused',
        reason: `briefPackagePath must name the frozen prose (.md), got ${String(request.briefPackagePath)}`,
      };
    }

    // Request-validation entry check: every expected-artifact path must be a
    // contained worktree-relative path, refused here before any inspection.
    for (const artifact of request.expectedArtifacts ?? []) {
      const refusedReason = validateWorktreeRelativePath(artifact);
      if (refusedReason !== null) {
        return {
          outcome: 'refused',
          reason: `expectedArtifacts entry '${String(artifact)}' is refused: ${refusedReason}`,
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

    // C1b: a fix attempt shares the lane's worktree with its prior attempt. It
    // dispatches only after the prior attempt is collected (manifest sealed) or
    // cancelled and nothing else on the work order can still touch the worktree.
    // Refused before any reservation read, workspace inspection, journal entry,
    // save or runner call.
    const recordedAttempt = await this.deps.attemptRepo.findAttemptById(request.attemptId);
    if (recordedAttempt?.kind === 'fix') {
      const priorCheck = await checkFixPriorSettled(this.deps.attemptRepo, {
        fixAttemptId: recordedAttempt.id,
        workOrderId: recordedAttempt.workOrderId,
        priorAttemptId: recordedAttempt.priorAttemptId,
      });
      if (priorCheck.refusal !== null) {
        return { outcome: 'refused', reason: priorCheck.refusal };
      }
    }

    const activeReservations = await this.deps.journal.listActiveReservations();
    const heldReservation = activeReservations.find(
      (reservation) => reservation.attemptId === request.attemptId && reservation.held,
    );
    if (!heldReservation) {
      return { outcome: 'refused', reason: 'No active capacity reservation for attempt' };
    }

    // H9a fix (review): a reservation recorded for another host must never
    // dispatch here. The runner's own host name comes from the installation
    // (v2); it is null for v1 or absent installations, so legacy and pre-H9a
    // records with a null hostName pass through untouched. This refuses
    // before any start call and before any journal write.
    const runnerHostName = this.deps.runner.describeRunner?.()?.hostName ?? null;
    const reservationHostName = heldReservation.hostName ?? null;
    if (reservationHostName !== null && reservationHostName !== runnerHostName) {
      return {
        outcome: 'refused',
        reason: `Reservation host ${reservationHostName} is not the configured runner host ${runnerHostName}; several lane-runner hosts need H9b/H10`,
      };
    }
    // The reservation's allocated worktree is the only one this attempt may
    // dispatch into (review of #125): a v2 reserve allocates the path under
    // its lock, and the busy-worktree check only ever saw that path. A null
    // path is a legacy or pre-H9a2 record and passes as before. The reason
    // names neither path.
    const reservedWorktreePath = heldReservation.worktreePath ?? null;
    if (reservedWorktreePath !== null && reservedWorktreePath !== request.worktreePath) {
      return {
        outcome: 'refused',
        reason: 'Worktree path does not match the path allocated by the capacity reservation',
      };
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
      // H9b2: the inspection runs where the dispatching runner's host lives;
      // a legacy runner describes no host and keeps the configured executor.
      recordedHost: this.deps.runner.describeRunner?.() ?? null,
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
            this.deps.runner.describeRunner?.() ?? null,
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

    // D3: recompute the frozen brief digest from the exact bytes the worktree
    // still holds — the prose at the brief package path plus the chosen
    // manifest — and refuse when it differs from the request's digest. This
    // runs before any attempt save, journal write, capacity change or runner
    // contact, so an edited brief never dispatches.
    let proseRaw: string | null = null;
    try {
      if (this.deps.artifactPort?.readBriefFile) {
        proseRaw = await this.deps.artifactPort.readBriefFile(
          request.worktreePath,
          request.briefPackagePath,
          this.deps.runner.describeRunner?.() ?? null,
        );
      } else if (this.deps.workspace.readWorktreeFile) {
        proseRaw = await this.deps.workspace.readWorktreeFile(
          request.worktreePath,
          request.briefPackagePath,
        );
      }
    } catch (error) {
      return {
        outcome: 'refused',
        reason: `Failed to read the frozen brief: ${String(error)}`,
      };
    }
    if (proseRaw === null) {
      return {
        outcome: 'refused',
        reason: `Unable to read the frozen brief at ${request.briefPackagePath} to check its digest`,
      };
    }
    const computeDigest = this.deps.computeDigest ?? simpleDeterministicHexDigest;
    if (computeDigest(proseRaw + '\n' + manifestRaw) !== request.briefDigest) {
      return {
        outcome: 'refused',
        reason: `Frozen brief digest mismatch for attempt ${request.attemptId}: the brief or its manifest changed after it was prepared; run 'brief prepare' again`,
      };
    }

    const manifestModelAssignment = parsedManifest.modelAssignment as
      | { readonly model?: string; readonly agent?: string; readonly variant?: string; readonly seatTool?: unknown }
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

    const manifestSeatPlan = readManifestSeatPlan(parsedManifest);
    if (manifestSeatPlan.kind === 'invalid') {
      return {
        outcome: 'refused',
        reason: "Frozen brief manifest 'seatPlan' is invalid: " + manifestSeatPlan.reason,
      };
    }

    const nowIso = request.nowIso ?? new Date().toISOString();

    // O14c1: the seat's tool decides which runner kind runs the lane. The
    // frozen brief records the seat tool; a brief from before it did carries
    // an opencode seat. A selection without an implemented runner refuses
    // before the dispatch intent is recorded and before anything spawns.
    if (this.deps.runnerSelector) {
      // H8: the seat tool lives on the manifest's model assignment — the
      // shape PrepareBriefPackageUseCase writes. Only a model assignment
      // written before the field existed (legacy manifests) reads as the
      // opencode seat. A present but undeclared tool is a named refusal, not
      // a fallback.
      const rawSeatTool = manifestModelAssignment.seatTool;
      const manifestSeatTool = parseSeatTool(rawSeatTool);
      if (rawSeatTool !== undefined && manifestSeatTool === undefined) {
        return {
          outcome: 'refused',
          reason: `Frozen brief manifest model assignment declares an unknown seat tool: ${JSON.stringify(rawSeatTool)}`,
        };
      }
      // H9a2: a v2 installation never defaults the seat tool. A manifest
      // whose model assignment predates the field refuses with a named
      // reason; v1 and absent installations keep the legacy opencode seat.
      if (manifestSeatTool === undefined && request.installationSchemaVersion === 2) {
        return {
          outcome: 'refused',
          reason: 'Frozen brief manifest model assignment declares no seat tool; a v2 installation never defaults to opencode',
        };
      }
      const seatTool = manifestSeatTool ?? 'opencode';
      const selection = this.deps.runnerSelector.selectRunner({ seatTool });
      if (!selection.ok) {
        return { outcome: 'refused', reason: selection.reason };
      }
    }

    const existingAttempt = await this.deps.attemptRepo.findAttemptById(request.attemptId);

    // A claim-state attempt is live: dispatching it again would start a second
    // session in the same worktree. Refuse before any journal entry or save;
    // an `intent-recorded` prepared attempt still dispatches.
    if (
      existingAttempt &&
      (existingAttempt.state === 'dispatching' ||
        existingAttempt.state === 'running' ||
        existingAttempt.state === 'reconciling' ||
        existingAttempt.state === 'blocked')
    ) {
      return {
        outcome: 'refused',
        reason: `Attempt ${existingAttempt.id} is ${existingAttempt.state}; run 'attempt reconcile' (it resolves an attempt with no recorded session by inspecting its worktree) or 'attempt stop' before dispatching again`,
      };
    }

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

    const rawBindTool = manifestModelAssignment.seatTool;
    const seatBinding = this.bindSeat(
      existingAttempt,
      manifestSeatPlan,
      {
        model: manifestModelAssignment.model,
        tool: typeof rawBindTool === 'string' && rawBindTool.trim() !== '' ? rawBindTool.trim() : 'opencode',
        variant: manifestModelAssignment.variant,
        agent: manifestModelAssignment.agent,
      },
      request.seatOverride !== undefined,
    );
    if (!seatBinding.ok) {
      return { outcome: 'refused', reason: seatBinding.reason };
    }

    const effectiveModel = request.seatOverride?.model ?? manifestModelAssignment.model;
    const effectiveAgent = request.seatOverride?.agent ?? manifestModelAssignment.agent;
    const effectiveVariant = request.seatOverride?.variant ?? manifestModelAssignment.variant;

    if (!effectiveModel || effectiveModel.trim() === '') {
      return { outcome: 'refused', reason: 'No model specified for dispatch' };
    }

    // Free-seat policy (plan F3): with the flag off, only a catalogue seat
    // that is not free may run. A refusal is durable (F7): it appends a
    // `refused` journal entry before returning, keeps the reservation and
    // saves no attempt.
    let seatPolicyFlag: boolean | undefined;
    if (this.deps.allowedSeats) {
      const rawCheckTool = manifestModelAssignment.seatTool;
      const checkTool =
        typeof rawCheckTool === 'string' && rawCheckTool.trim() !== ''
          ? rawCheckTool.trim()
          : 'opencode';
      const verdict = this.deps.allowedSeats.checkDispatchSeat({
        tool: checkTool,
        model: effectiveModel.trim(),
        variant: effectiveVariant ?? null,
      });
      if (!verdict.allowed) {
        await appendJournalEntry(this.deps.journal, {
          attemptId: request.attemptId,
          workOrderId: request.workOrderId,
          action: 'dispatch',
          baseCommit: request.baseCommit,
          recordedAtIso: nowIso,
          status: 'refused',
          sessionId: null,
          detail: `Free-seat policy refused dispatch: tool ${checkTool}, model ${effectiveModel}, variant ${effectiveVariant ?? 'none'}, useFreeSeats false: ${verdict.reason}`,
        });
        return { outcome: 'refused', reason: verdict.reason };
      }
      seatPolicyFlag = verdict.useFreeSeats;
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
      ...(seatPolicyFlag !== undefined ? { useFreeSeats: seatPolicyFlag } : {}),
    };

    const dispatchingAttempt: AttemptRecord = existingAttempt
      ? {
          ...existingAttempt,
          revision: nextAttemptRevision(existingAttempt),
          dispatchRevision: nextAttemptRevision(existingAttempt),
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
          ...seatBinding.fields,
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
          revision: 0,
          dispatchRevision: 0,
          briefDigest: request.briefDigest,
          briefPackagePath: request.briefPackagePath,
          sessionId: null,
          completionReceipt: null,
          artifacts: null,
          runner: initialRunner,
          seatOverride: request.seatOverride ?? null,
          reviewerSeat: request.reviewerSeat ?? fallbackReviewer,
          ownerDecisionReferences,
          ...seatBinding.fields,
          createdAtIso: nowIso,
          updatedAtIso: nowIso,
        };
    const dispatchingConflict = await this.saveAttemptOrConflict(dispatchingAttempt, false);
    if (dispatchingConflict) {
      return dispatchingConflict;
    }

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
      const runnerValue = startResult.runner
        ? { ...startResult.runner, ...(seatPolicyFlag !== undefined ? { useFreeSeats: seatPolicyFlag } : {}) }
        : dispatchingAttempt.runner ?? null;
      const runningAttempt: AttemptRecord = {
        ...dispatchingAttempt,
        revision: nextAttemptRevision(dispatchingAttempt),
        state: 'running',
        sessionId: startResult.sessionId,
        runner: runnerValue,
        updatedAtIso: nowIso,
      };
      // The started session must never be lost: journal the completed start
      // BEFORE the running save so a conflict or crash still records the id.
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
      const runningSave = await this.saveRunningOrConflict(runningAttempt, startResult.sessionId, runnerValue, nowIso);
      if (runningSave.kind === 'conflict') {
        return runningSave.result;
      }
      if (this.deps.observation) {
        // A delivery gap is preserved and visible; it never fails the lane.
        await this.deps.observation.publishExecutionObservation({
          entry: completedEntry,
          projectId: workOrder.projectId,
        });
      }
      return { outcome: 'started', attempt: runningSave.stored, sessionId: startResult.sessionId };
    }

    if (startResult.outcome === 'unknown') {
      // Unknown keeps the reservation; reconciliation decides before retry.
      const reconcilingAttempt: AttemptRecord = {
        ...dispatchingAttempt,
        revision: nextAttemptRevision(dispatchingAttempt),
        state: 'reconciling',
        updatedAtIso: nowIso,
      };
      // Journal the ambiguous start first: a session may exist on the runner,
      // and the evidence must survive a conflicting save.
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
      const reconcilingConflict = await this.saveAttemptOrConflict(reconcilingAttempt, true);
      if (reconcilingConflict) {
        return reconcilingConflict;
      }
      return { outcome: 'unknown', attempt: reconcilingAttempt, reason: startResult.reason };
    }

    if (startResult.outcome === 'blocked') {
      // Blocked keeps the reservation; reconcile or stop resolves the worktree.
      const blockedAttempt: AttemptRecord = {
        ...dispatchingAttempt,
        revision: nextAttemptRevision(dispatchingAttempt),
        state: 'blocked',
        sessionId: null,
        runner: startResult.runner ?? dispatchingAttempt.runner ?? null,
        updatedAtIso: nowIso,
      };
      // Record what ran at block time (brief-fix2 item 2a): session ids seen
      // running in the worktree are evidence only, never proof of ownership.
      // An unknown answer or a runner without inspectWorktreeRun omits the
      // field; the ids stay out of the entry's detail.
      let observedSessionIds: readonly string[] | undefined;
      if (this.deps.runner.inspectWorktreeRun) {
        const observed = await this.deps.runner.inspectWorktreeRun({
          attemptId: request.attemptId,
          worktreePath: request.worktreePath,
          runner: blockedAttempt.runner,
        });
        if (observed.state === 'running') {
          observedSessionIds = [observed.sessionId];
        } else if (observed.state === 'idle') {
          observedSessionIds = [];
        }
      }
      // Journal the ambiguous start first: the worktree may hold a live lane,
      // and the evidence must survive a conflicting save. Capacity is never
      // released.
      await appendJournalEntry(this.deps.journal, {
        attemptId: request.attemptId,
        workOrderId: request.workOrderId,
        action: 'dispatch',
        baseCommit: request.baseCommit,
        recordedAtIso: nowIso,
        status: 'ambiguous',
        sessionId: null,
        detail: `Blocked: ${startResult.reason}; reservation kept until 'attempt reconcile' or 'attempt stop' resolves the worktree`,
        ...(observedSessionIds !== undefined ? { observedSessionIds } : {}),
      });
      const blockedConflict = await this.saveAttemptOrConflict(blockedAttempt, true);
      if (blockedConflict) {
        return blockedConflict;
      }
      return { outcome: 'blocked', attempt: blockedAttempt, reason: startResult.reason };
    }

    const stopReason = startResult.reasonClass ?? classifyRunnerRefusal(startResult.reason);
    const cancelledAttempt: AttemptRecord = {
      ...dispatchingAttempt,
      revision: nextAttemptRevision(dispatchingAttempt),
      state: 'cancelled',
      stopReason,
      updatedAtIso: nowIso,
    };
    const refusedSave = await this.saveRefusedCancelledOrSkip(cancelledAttempt, nowIso, dispatchingAttempt);
    if (refusedSave) {
      // Someone else moved the attempt on: no save happened, so the
      // reservation is never released and the fresh state is reported.
      return refusedSave;
    }
    await appendJournalEntry(this.deps.journal, {
      attemptId: request.attemptId,
      workOrderId: request.workOrderId,
      action: 'dispatch',
      baseCommit: request.baseCommit,
      recordedAtIso: nowIso,
      status: 'refused',
      sessionId: null,
      detail: startResult.reason,
      stopReason,
    });
    await this.deps.journal.releaseCapacityReservation(request.attemptId, nowIso);
    return { outcome: 'refused', reason: startResult.reason };
  }

  /**
   * S1: bind the attempt to its seat-plan entry. A fix attempt prepared with
   * a selection must dispatch exactly that seat (an operator seat override
   * is the one exception and is family-checked above). An initial attempt
   * with a manifest plan binds to the first-pass seat its assignment names.
   * No plan anywhere: no fields (D1).
   */
  private bindSeat(
    existingAttempt: AttemptRecord | null,
    manifestSeatPlan: ReturnType<typeof readManifestSeatPlan>,
    assignment: { readonly model: string; readonly tool: string; readonly variant?: string; readonly agent?: string },
    hasSeatOverride: boolean,
  ): SeatBinding {
    const selection = existingAttempt?.seatSelection ?? null;
    if (selection !== null) {
      if (
        !hasSeatOverride &&
        !seatMatchesAssignment(
          {
            model: selection.model,
            tool: selection.tool ?? undefined,
            variant: selection.variant ?? undefined,
            agent: selection.agent ?? undefined,
          },
          assignment,
        )
      ) {
        return {
          ok: false,
          reason:
            'Frozen brief model assignment ' + assignment.model + ' does not match seat ' +
            selection.seatId + ' (' + selection.model + ') selected for attempt ' + existingAttempt!.id,
        };
      }
      return { ok: true, fields: {} };
    }
    if (existingAttempt?.seatPlan) {
      return { ok: true, fields: {} };
    }
    if (manifestSeatPlan.kind !== 'plan') {
      return { ok: true, fields: {} };
    }
    const plan = manifestSeatPlan.plan;
    // A fix attempt with no recorded selection carries the frozen plan only: binding it as a first-pass
    // seat would mislead fix-seat rotation, which reads seatSelection.role and seatIndex (S1c).
    if (existingAttempt?.kind === 'fix') {
      return { ok: true, fields: { seatPlan: plan.toJSON() } };
    }
    const seatIndex = plan.getSeats('first-pass').findIndex((seat) => seatMatchesAssignment(seat, assignment));
    if (seatIndex === -1) {
      return { ok: false, reason: 'Frozen brief model assignment matches no first-pass seat of its seat plan' };
    }
    return {
      ok: true,
      fields: {
        seatPlan: plan.toJSON(),
        seatSelection: seatSelectionRecord('first-pass', seatIndex, plan.getSeats('first-pass')[seatIndex]),
      },
    };
  }

  /**
   * Save one attempt record, catching `AttemptRevisionConflictError`. A
   * conflict re-reads once and returns a refused or unknown result naming the
   * conflicting state instead of redoing any work: dispatch must never start a
   * second session.
   */
  private async saveAttemptOrConflict(
    record: AttemptRecord,
    unknownOnConflict: boolean,
  ): Promise<DispatchAttemptResult | null> {
    try {
      await this.deps!.attemptRepo.saveAttempt(record);
      return null;
    } catch (error) {
      if (!(error instanceof AttemptRevisionConflictError)) {
        throw error;
      }
      const fresh = await this.deps!.attemptRepo.findAttemptById(record.id);
      const state = fresh?.state ?? 'unknown';
      if (unknownOnConflict) {
        return {
          outcome: 'unknown',
          attempt: fresh ?? record,
          reason: `Attempt ${record.id} changed to ${state} while dispatching`,
        };
      }
      return {
        outcome: 'refused',
        reason: `Attempt ${record.id} changed to ${state} while dispatching`,
      };
    }
  }

  /**
   * Save the `running` transition after `startSession` succeeded. A conflict
   * never re-runs the start: the fresh record is re-read once. The `running`
   * transition is rebuilt only when the fresh record is still `dispatching`,
   * or `reconciling` with no session; a vanished record rebuilds from the
   * pre-conflict record. Anything else is someone else's move: the state is
   * never overwritten — with a null session id the session is recorded on
   * the fresh record so reconcile can find it, and with a session id already
   * present nothing is saved. Either foreign-state case returns an `unknown`
   * result naming the session id, with a journal entry carrying it so the
   * session is never lost; a non-authoritative `ended` is never written
   * back to `running`. A second conflict is never allowed to leave a live,
   * unrecorded session: the started session is stopped once, the stop
   * outcome and the id are journalled as `ambiguous`, and an `unknown`
   * result naming the reason is returned instead of rethrowing.
   */
  private async saveRunningOrConflict(
    runningAttempt: AttemptRecord,
    sessionId: string,
    runnerValue: AttemptRecord['runner'],
    nowIso: string,
  ): Promise<RunningSaveOutcome> {
    const deps = this.deps!;
    const alreadyRecorded = (record: AttemptRecord): RunningSaveOutcome => {
      // The record already carries the session this dispatch started: nothing
      // to stop and nothing to save. A non-terminal record is the started
      // attempt; a terminal one is reported as unknown, never as started.
      if (record.state === 'cancelled' || record.state === 'collected' || record.state === 'ended') {
        return {
          kind: 'conflict',
          result: {
            outcome: 'unknown',
            attempt: record,
            reason: `Attempt ${record.id} is in state ${record.state} with session ${sessionId} already recorded`,
          },
        };
      }
      return { kind: 'saved', stored: record };
    };
    const handleSecondConflict = async (): Promise<RunningSaveOutcome> => {
      // A second revision conflict while a started session is live must not
      // leave it running and unrecorded: stop it once and journal the id,
      // unless the winning write already recorded this very session.
      const winner = await deps.attemptRepo.findAttemptById(runningAttempt.id);
      if (winner !== null && winner.sessionId === sessionId) {
        return alreadyRecorded(winner);
      }
      const stopResult = await deps.runner.stopSession({
        attemptId: runningAttempt.id,
        sessionId,
        gracePeriodSeconds: 10,
        worktreePath: runningAttempt.worktreePath,
        runner: runnerValue,
      });
      const reason = `second revision conflict; started session ${sessionId} stopped (${stopResult.outcome})`;
      await appendJournalEntry(deps.journal, {
        attemptId: runningAttempt.id,
        workOrderId: runningAttempt.workOrderId,
        action: 'dispatch',
        baseCommit: runningAttempt.baseCommit,
        recordedAtIso: nowIso,
        status: 'ambiguous',
        sessionId,
        detail: reason,
      });
      const freshAgain = await deps.attemptRepo.findAttemptById(runningAttempt.id);
      return { kind: 'conflict', result: { outcome: 'unknown', attempt: freshAgain ?? runningAttempt, reason } };
    };
    const saveRebuiltOrHandleConflict = async (rebuilt: AttemptRecord): Promise<RunningSaveOutcome> => {
      try {
        await deps.attemptRepo.saveAttempt(rebuilt);
        return { kind: 'saved', stored: rebuilt };
      } catch (error) {
        if (!(error instanceof AttemptRevisionConflictError)) {
          throw error;
        }
        return handleSecondConflict();
      }
    };
    const savePreservedOrHandleConflict = async (
      preserved: AttemptRecord,
      reason: string,
    ): Promise<RunningSaveOutcome> => {
      try {
        await deps.attemptRepo.saveAttempt(preserved);
        // The session is recorded on someone else's state, so the dispatch
        // is reported as unknown (reconcile decides), never as started.
        return { kind: 'conflict', result: { outcome: 'unknown', attempt: preserved, reason } };
      } catch (error) {
        if (!(error instanceof AttemptRevisionConflictError)) {
          throw error;
        }
        return handleSecondConflict();
      }
    };
    try {
      await deps.attemptRepo.saveAttempt(runningAttempt);
      return { kind: 'saved', stored: runningAttempt };
    } catch (error) {
      if (!(error instanceof AttemptRevisionConflictError)) {
        throw error;
      }
      const fresh = await deps.attemptRepo.findAttemptById(runningAttempt.id);
      if (
        fresh === null ||
        canOverwriteAfterConflict(fresh, ['dispatching'], runningAttempt) ||
        (fresh.state === 'reconciling' && fresh.sessionId === null)
      ) {
        const base = fresh ?? runningAttempt;
        const rebuilt: AttemptRecord = {
          ...base,
          revision: nextAttemptRevision(base),
          state: 'running',
          sessionId,
          runner: runnerValue,
          updatedAtIso: nowIso,
        };
        return saveRebuiltOrHandleConflict(rebuilt);
      }
      if (fresh.sessionId === sessionId) {
        return alreadyRecorded(fresh);
      }
      const freshIsTerminal =
        fresh.state === 'cancelled' || fresh.state === 'collected' || fresh.state === 'ended';
      if (freshIsTerminal || fresh.sessionId !== null) {
        // Someone else ended the attempt or recorded another session while
        // this call started one. The new session is never attached to that
        // record (reconcile would demote a terminal state or release capacity
        // twice); it is stopped instead, once, and the outcome journalled.
        const stopResult = await deps.runner.stopSession({
          attemptId: runningAttempt.id,
          sessionId,
          gracePeriodSeconds: 10,
          worktreePath: runningAttempt.worktreePath,
          runner: runnerValue,
        });
        const reason =
          `Attempt ${runningAttempt.id} is in state ${fresh.state}` +
          (fresh.sessionId !== null ? ` with session ${fresh.sessionId}` : '') +
          `; started session ${sessionId} was not recorded and its stop was ${stopResult.outcome}`;
        await appendJournalEntry(deps.journal, {
          attemptId: runningAttempt.id,
          workOrderId: runningAttempt.workOrderId,
          action: 'dispatch',
          baseCommit: runningAttempt.baseCommit,
          recordedAtIso: nowIso,
          status: 'ambiguous',
          sessionId,
          detail: reason,
        });
        return { kind: 'conflict', result: { outcome: 'unknown', attempt: fresh, reason } };
      }
      {
        // A non-terminal record without a session: the state stays whatever
        // someone else set it to; only the session is recorded so reconcile
        // can find it.
        const preserved: AttemptRecord = {
          ...fresh,
          sessionId,
          runner: runnerValue,
          revision: nextAttemptRevision(fresh),
          updatedAtIso: nowIso,
        };
        const reason = `Attempt ${runningAttempt.id} is in state ${fresh.state} while dispatching; session ${sessionId} recorded on it`;
        await appendJournalEntry(deps.journal, {
          attemptId: runningAttempt.id,
          workOrderId: runningAttempt.workOrderId,
          action: 'dispatch',
          baseCommit: runningAttempt.baseCommit,
          recordedAtIso: nowIso,
          status: 'ambiguous',
          sessionId,
          detail: reason,
        });
        return savePreservedOrHandleConflict(preserved, reason);
      }
    }
  }

  /**
   * Save the `cancelled` transition after a refused start. On a conflict the
   * fresh record is re-read once: `cancelled` is rebuilt and the caller may
   * release capacity only when the fresh record is still `dispatching` with
   * no session (a vanished record rebuilds from the pre-conflict record).
   * A `dispatching` fresh record is overwritten only when it is the same
   * dispatch — same `dispatchRevision` as the `base` dispatching record; a
   * foreign re-dispatch is never overwritten. Anything else is someone
   * else's move: no save, no capacity release, and a refused result naming
   * the fresh state, with a journal entry recording that the refused start
   * found the attempt in that state. A second conflict propagates.
   */
  private async saveRefusedCancelledOrSkip(
    cancelledAttempt: AttemptRecord,
    nowIso: string,
    base: AttemptRecord,
  ): Promise<DispatchAttemptResult | null> {
    const deps = this.deps!;
    const build = (base: AttemptRecord): AttemptRecord => ({
      ...base,
      revision: nextAttemptRevision(base),
      state: 'cancelled',
      stopReason: cancelledAttempt.stopReason,
      updatedAtIso: nowIso,
    });
    try {
      await deps.attemptRepo.saveAttempt(cancelledAttempt);
      return null;
    } catch (error) {
      if (!(error instanceof AttemptRevisionConflictError)) {
        throw error;
      }
      const fresh = await deps.attemptRepo.findAttemptById(cancelledAttempt.id);
      if (
        fresh === null ||
        (canOverwriteAfterConflict(fresh, ['dispatching'], base) && fresh.sessionId === null)
      ) {
        await deps.attemptRepo.saveAttempt(build(fresh ?? cancelledAttempt));
        return null;
      }
      const reason =
        fresh.state === 'dispatching'
          ? `Attempt ${cancelledAttempt.id} was re-dispatched concurrently while refusing dispatch; capacity not released`
          : `Attempt ${cancelledAttempt.id} changed to ${fresh.state} while refusing dispatch; capacity not released`;
      await appendJournalEntry(deps.journal, {
        attemptId: cancelledAttempt.id,
        workOrderId: cancelledAttempt.workOrderId,
        action: 'dispatch',
        baseCommit: cancelledAttempt.baseCommit,
        recordedAtIso: nowIso,
        status: 'refused',
        sessionId: null,
        detail:
          fresh.state === 'dispatching'
            ? `Refused dispatch start found attempt ${cancelledAttempt.id} re-dispatched concurrently`
            : `Refused dispatch start found attempt ${cancelledAttempt.id} in state ${fresh.state}`,
      });
      return { outcome: 'refused', reason };
    }
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
