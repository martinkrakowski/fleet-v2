/**
 * The conductor's live wiring (lane K7-7): the shared lane-runner candidate
 * reader moved out of `index.ts` and the driver object `conductor run` and
 * `conductor start` act through. `buildLiveConductorDriver` builds objects
 * only — calling `pass.runPass` or `start.startLaneRun` is what acts on lane
 * hosts — so tests can build it freely and never see a dispatch.
 */

import {
  conductorRevision,
  resolveConductorPolicy,
  type FleetInstallation,
  type ResolvedConductorPolicy,
} from '@fleet/installation';
import {
  AdvanceLaneRunUseCase,
  CancelPreparedAttemptUseCase,
  LaneRunAdmissionAdapter,
  PrepareFixAttemptUseCase,
  ResumeLaneRunUseCase,
  RunConductorPassUseCase,
  StartLaneRunUseCase,
  sha256HexDigest,
  type AttemptRepositoryAdapter,
  type ConductorDriverLeaseAdapter,
  type ConductorHaltAdapter,
  type ExecutionJournalAdapter,
  type LaneRunJournalAdapter,
  type LaneRunRepositoryAdapter,
  type ReserveExecutionCapacityCandidateHost,
  type RunConductorPassPort,
  type StartLaneRunPort,
  type WorkOrderRepositoryAdapter,
} from '@fleet/work-execution';

import { isSameModelFamily, underlyingModelFamily } from '@fleet/evidence-and-acceptance';

import { createDryRunFakes } from './conductor-dry-run.js';
import { newUlid } from './ulid.js';
import type { FleetCliRuntime } from './composition.js';

/**
 * The lane-runner hosts of a v2 installation, as the reserve's candidates
 * (H9a2). Only hosts carrying the lane-runner role with a runner block are
 * offered; `maxLanes` defaults to 1 inside the use case when absent. A v1 or
 * absent installation yields `undefined` and keeps the legacy request path.
 */
export function laneRunnerCandidateHosts(
  installation?: FleetInstallation,
): ReserveExecutionCapacityCandidateHost[] | undefined {
  if (installation?.schemaVersion !== 2 || installation.hosts === undefined) {
    return undefined;
  }
  const candidates: ReserveExecutionCapacityCandidateHost[] = [];
  for (const name of Object.keys(installation.hosts)) {
    const host = installation.hosts[name];
    if (!host.roles?.includes('lane-runner') || host.runner === undefined) continue;
    candidates.push({
      name,
      kind: host.runner.kind,
      transport: host.transport === 'ssh' ? 'ssh' : 'local',
      sshAlias:
        host.transport === 'ssh' && host.sshAlias !== undefined && host.sshAlias.trim() !== ''
          ? host.sshAlias
          : null,
      port: typeof host.runner.port === 'number' ? host.runner.port : null,
      maxLanes: host.runner.maxLanes,
      worktreeRoot: host.worktreeRoot,
    });
  }
  return candidates;
}

/** The conductor driver the CLI loops over: one pass port, the start port, the resolved policy. */
export interface ConductorDriver {
  readonly pass: RunConductorPassPort;
  /** null in the dry-run driver (K7-8): a dry-run starts nothing. */
  readonly start: StartLaneRunPort | null;
  readonly policy: ResolvedConductorPolicy;
  readonly runPolicyRevision: string; // 'policy:conductor@' + conductorRevision(policy)
}

/**
 * The parts every conductor driver shares: the pass use case over the stores
 * and the advance, the start port (null in the dry-run), the resolved policy
 * and its revision. One builder so the live and dry-run drivers never
 * duplicate the pass wiring.
 */
function buildConductorDriver(parts: {
  readonly driverLease: ConductorDriverLeaseAdapter;
  readonly runRepo: LaneRunRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly halt: ConductorHaltAdapter;
  readonly resume: ResumeLaneRunUseCase;
  readonly advance: AdvanceLaneRunUseCase;
  readonly start: StartLaneRunPort | null;
  readonly policy: ResolvedConductorPolicy;
  readonly runPolicyRevision: string;
}): ConductorDriver {
  const pass = new RunConductorPassUseCase({
    driverLease: parts.driverLease,
    runRepo: parts.runRepo,
    runJournal: parts.runJournal,
    halt: parts.halt,
    resume: parts.resume,
    advance: parts.advance,
  });
  return {
    pass,
    start: parts.start,
    policy: parts.policy,
    runPolicyRevision: parts.runPolicyRevision,
  };
}

/**
 * The live driver over the runtime's real ports. Builds objects only; calling
 * `pass.runPass` acts on lane hosts.
 */
export function buildLiveConductorDriver(
  runtime: FleetCliRuntime,
  options: { readonly maxActiveRuns: number },
): ConductorDriver {
  const policy = resolveConductorPolicy(runtime.installation?.policy);
  const execution = runtime.execution;
  const conductor = runtime.conductor;
  // One admission object serves both directions (K7-5b): `admit` for a later
  // attempt of a run and `reserveFirst` for `conductor start`. A v1
  // installation has no candidate hosts, so `reserveFirst` refuses `no-host`:
  // the conductor needs a v2 installation's lane-runner hosts, because the
  // reserve is the single authority for worktree paths (owner decision K7-D7).
  const admission = new LaneRunAdmissionAdapter({
    reserve: execution.reserveExecutionCapacity,
    runRepo: conductor.laneRunRepository,
    runJournal: conductor.laneRunJournal,
    workOrderRepo: execution.workOrderRepository,
    attemptRepo: execution.attemptRepository,
    executionJournal: execution.executionJournal,
    maxActiveRuns: options.maxActiveRuns,
    candidateHosts: laneRunnerCandidateHosts(runtime.installation),
    newReservationId: () => 'res-' + conductor.newUlid(),
  });
  // One cancel use case serves the advance's G4e cancel and start's abandon.
  const cancelPreparedAttempt = new CancelPreparedAttemptUseCase({
    attemptRepo: execution.attemptRepository,
    journal: execution.executionJournal,
  });
  const advance = new AdvanceLaneRunUseCase({
    runRepo: conductor.laneRunRepository,
    runJournal: conductor.laneRunJournal,
    attemptRepo: execution.attemptRepository,
    executionJournal: execution.executionJournal,
    artifactPort: execution.attemptArtifact,
    reconcileAttempt: execution.reconcileAttempt,
    admission,
    newUlid: conductor.newUlid,
    stopGraceMinutes: policy.stopGraceMinutes,
    perLaneCostCeiling: runtime.installation?.policy?.perLaneCostCeiling,
    dispatchAttempt: execution.dispatchAttempt,
    cancelPreparedAttempt,
    installationSchemaVersion: runtime.installation?.schemaVersion,
    stopAttempt: execution.stopAttempt,
    collectAttemptArtifacts: execution.collectAttemptArtifacts,
    commitEditOnlyAttempt: execution.commitEditOnlyAttempt,
    evaluateAttemptGate: execution.requestAttemptAcceptance,
    runnerForAttempt: execution.runnerForAttempt,
    reviewRequest: conductor.reviewRequest,
    reviewAssessment: conductor.reviewAssessment,
    sameModelFamily: (left, right) =>
      isSameModelFamily(underlyingModelFamily(left), underlyingModelFamily(right)),
    workOrderRepo: execution.workOrderRepository,
    prepareFixAttempt: execution.prepareFixAttempt,
    prepareBrief: execution.prepareBriefPackage,
    // K6-8: the conductor's acceptance, PR, push, merge and park ports.
    acceptanceAssessment: execution.acceptanceAssessment,
    ciState: conductor.ciState,
    forgeRead: execution.forgeRead,
    conductorForgeGrant: conductor.conductorForgeGrant,
    executeForgeAction: execution.executeAuthorizedForgeAction,
    autoMergeAttempt: execution.autoMergeAttempt,
    parkNotice: conductor.parkNotice,
    autoMergeEnabled: conductor.autoMergeEnabled,
  });
  const start = new StartLaneRunUseCase({
    workOrderRepo: execution.workOrderRepository,
    profileRead: conductor.profileRead,
    capacity: admission,
    executionJournal: execution.executionJournal,
    workspace: execution.workspace,
    prepareBrief: execution.prepareBriefPackage,
    attemptRepo: execution.attemptRepository,
    runRepo: conductor.laneRunRepository,
    runJournal: conductor.laneRunJournal,
    cancelPreparedAttempt,
    computeDigest: sha256HexDigest,
  });
  return buildConductorDriver({
    driverLease: conductor.driverLease,
    runRepo: conductor.laneRunRepository,
    runJournal: conductor.laneRunJournal,
    halt: conductor.halt,
    resume: conductor.resumeLaneRun,
    advance,
    start,
    policy,
    runPolicyRevision: 'policy:conductor@' + conductorRevision(policy),
  });
}

/** The scratch stores the dry-run driver composes over (K7-8). */
export interface DryRunStores {
  readonly runRepo: LaneRunRepositoryAdapter;
  readonly runJournal: LaneRunJournalAdapter;
  readonly attemptRepo: AttemptRepositoryAdapter;
  readonly executionJournal: ExecutionJournalAdapter;
  readonly workOrderRepo: WorkOrderRepositoryAdapter;
  readonly driverLease: ConductorDriverLeaseAdapter;
  readonly halt: ConductorHaltAdapter;
}

/**
 * The dry-run driver over the scratch stores and recording fakes (K7-8): no
 * executor, no runner, no forge adapter, and no `start` port — a dry-run
 * starts nothing. `policy` resolves as an absent block (the dry-run itself
 * performs no `policy.conductor.enabled` check).
 */
export function buildDryRunConductorDriver(
  stores: DryRunStores,
  options: { readonly maxActiveRuns: number; readonly nowIso: () => string },
): ConductorDriver {
  const policy = resolveConductorPolicy(undefined);
  const fakes = createDryRunFakes(
    { attemptRepo: stores.attemptRepo, executionJournal: stores.executionJournal },
    options.nowIso,
  );
  const cancelPreparedAttempt = new CancelPreparedAttemptUseCase({
    attemptRepo: stores.attemptRepo,
    journal: stores.executionJournal,
  });
  const resume = new ResumeLaneRunUseCase({
    runRepo: stores.runRepo,
    runJournal: stores.runJournal,
    newUlid,
  });
  const advance = new AdvanceLaneRunUseCase({
    runRepo: stores.runRepo,
    runJournal: stores.runJournal,
    attemptRepo: stores.attemptRepo,
    executionJournal: stores.executionJournal,
    artifactPort: fakes.artifactPort,
    reconcileAttempt: fakes.reconcileAttempt,
    admission: fakes.admission,
    newUlid,
    stopGraceMinutes: policy.stopGraceMinutes,
    dispatchAttempt: fakes.dispatchAttempt,
    cancelPreparedAttempt,
    stopAttempt: fakes.stopAttempt,
    collectAttemptArtifacts: fakes.collectAttemptArtifacts,
    commitEditOnlyAttempt: fakes.commitEditOnlyAttempt,
    evaluateAttemptGate: fakes.evaluateAttemptGate,
    runnerForAttempt: fakes.runnerForAttempt,
    reviewRequest: fakes.reviewRequest,
    reviewAssessment: fakes.reviewAssessment,
    sameModelFamily: () => false,
    workOrderRepo: stores.workOrderRepo,
    prepareFixAttempt: new PrepareFixAttemptUseCase({ attemptRepo: stores.attemptRepo }),
    prepareBrief: fakes.prepareBrief,
    // K6-8: the dry-run's recording fakes for the conductor's acting ports.
    acceptanceAssessment: fakes.acceptanceAssessment,
    ciState: fakes.ciState,
    forgeRead: fakes.forgeRead,
    conductorForgeGrant: fakes.conductorForgeGrant,
    executeForgeAction: fakes.executeForgeAction,
    autoMergeAttempt: fakes.autoMergeAttempt,
    parkNotice: fakes.parkNotice,
    autoMergeEnabled: true,
  });
  return buildConductorDriver({
    driverLease: stores.driverLease,
    runRepo: stores.runRepo,
    runJournal: stores.runJournal,
    halt: stores.halt,
    resume,
    advance,
    start: null,
    policy,
    runPolicyRevision: 'policy:conductor@' + conductorRevision(policy),
  });
}
