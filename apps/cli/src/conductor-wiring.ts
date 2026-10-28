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
  RunConductorPassUseCase,
  StartLaneRunUseCase,
  sha256HexDigest,
  type ReserveExecutionCapacityCandidateHost,
  type RunConductorPassPort,
  type StartLaneRunPort,
} from '@fleet/work-execution';

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
  });
  const pass = new RunConductorPassUseCase({
    driverLease: conductor.driverLease,
    runRepo: conductor.laneRunRepository,
    runJournal: conductor.laneRunJournal,
    halt: conductor.halt,
    resume: conductor.resumeLaneRun,
    advance,
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
  return {
    pass,
    start,
    policy,
    runPolicyRevision: 'policy:conductor@' + conductorRevision(policy),
  };
}
