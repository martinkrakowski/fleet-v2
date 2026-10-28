/**
 * The dry-run's fakes simulate a lane that succeeds; they write only the scratch
 * copy and reach no host. A real lane can fail where these pass. They record
 * every acting port call so a test can prove what the dry-run would have done
 * and that the real ports were never reached.
 */

import type {
  AttemptArtifactPort,
  AttemptRecord,
  AttemptRepositoryPort,
  CollectedAttemptArtifacts,
  CollectAttemptArtifactsPort,
  CommandCompletionReceipt,
  CommitEditOnlyAttemptPort,
  DispatchAttemptPort,
  EvaluateAttemptGatePort,
  ExecutionJournalPort,
  LaneRunAdmissionPort,
  ReconcileAttemptPort,
  RunnerForAttemptPort,
  StopAttemptPort,
} from '@fleet/work-execution';

/** Every acting outbound port the dry-run fakes, with the attempt it acted on. */
export interface DryRunRecorder {
  readonly calls: readonly { readonly port: string; readonly attemptId: string | null }[];
}

/** Recording fakes for every acting outbound port of the dry-run driver. */
export interface DryRunFakes {
  readonly recorder: DryRunRecorder;
  readonly admission: LaneRunAdmissionPort;              // admitted; saves a held reservation in the scratch journal
  readonly dispatchAttempt: DispatchAttemptPort;         // saves the scratch attempt running, sessionId 'dry-run-session-' + n; 'started'
  readonly reconcileAttempt: ReconcileAttemptPort;       // a running attempt: saves it ended with an authoritative receipt (exitStatus 0); 'ended'
  readonly stopAttempt: StopAttemptPort;                 // saves it ended, stoppedByRequest true; 'terminated', capacityReleased true
  readonly collectAttemptArtifacts: CollectAttemptArtifactsPort; // saves it collected, headCommit 'd'.repeat(40), one commit, a manifest path; 'collected'
  readonly commitEditOnlyAttempt: CommitEditOnlyAttemptPort;     // 'not-applicable'
  readonly evaluateAttemptGate: EvaluateAttemptGatePort;          // 'passed'
  readonly runnerForAttempt: RunnerForAttemptPort;                // a runner whose inspectWorktreeRun is 'idle' and whose other methods throw 'dry-run: no runner'
  readonly artifactPort: Pick<AttemptArtifactPort, 'readBriefManifest' | 'verifyArtifactManifest'>; // { stepLimit: 100, timeLimitSeconds: 2700, expectedArtifacts: [] }; 'sealed'
}

/** The frozen manifest the dry-run fakes read: the limits the seeds carry. */
export const DRY_RUN_MANIFEST_JSON = JSON.stringify({
  stepLimit: 100,
  timeLimitSeconds: 2700,
  expectedArtifacts: [],
});

/** The head commit the collect fake records: one commit since base, 'd' × 40. */
const DRY_RUN_HEAD_COMMIT = 'd'.repeat(40);

/** A fresh attempt-shaped record the fakes can build on when the record is absent. */
function baseAttemptOf(request: { readonly attemptId: string; readonly workOrderId: string; readonly worktreePath: string; readonly baseCommit: string }, nowIso: () => string): AttemptRecord {
  return {
    id: request.attemptId,
    workOrderId: request.workOrderId,
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: request.worktreePath,
    baseCommit: request.baseCommit,
    state: 'intent-recorded',
    outcome: null,
    revision: 0,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    createdAtIso: nowIso(),
    updatedAtIso: nowIso(),
  };
}

/** A runner that reads an idle worktree and refuses every session operation. */
function dryRunRunner() {
  const noRunner = (): never => {
    throw new Error('dry-run: no runner');
  };
  return {
    describeCapabilities: noRunner,
    startSession: noRunner,
    inspectSession: noRunner,
    stopSession: noRunner,
    inspectWorktreeRun: async () => ({ state: 'idle' as const }),
  };
}

/**
 * Build the recording fakes over the scratch stores. Every fake writes only
 * through the stores it was given (revision + 1 saves, as the real use cases
 * do) and never imports an executor, runner, workspace or forge adapter.
 */
export function createDryRunFakes(
  stores: {
    readonly attemptRepo: AttemptRepositoryPort;
    readonly executionJournal: ExecutionJournalPort;
  },
  nowIso: () => string,
): DryRunFakes {
  const calls: { readonly port: string; readonly attemptId: string | null }[] = [];
  const recordCall = (port: string, request: { readonly attemptId?: string } = {}): void => {
    calls.push({ port, attemptId: request.attemptId ?? null });
  };
  let sessionSequence = 0;
  let reservationSequence = 0;

  const findOrCreateAttempt = async (request: {
    readonly attemptId: string;
    readonly workOrderId: string;
    readonly worktreePath: string;
    readonly baseCommit: string;
  }): Promise<AttemptRecord> => {
    const existing = await stores.attemptRepo.findAttemptById(request.attemptId);
    return existing ?? baseAttemptOf(request, nowIso);
  };

  const admission: LaneRunAdmissionPort = {
    admit: async (request) => {
      recordCall('admission', request);
      const held = await stores.executionJournal.listActiveReservations();
      if (!held.some((reservation) => reservation.attemptId === request.attemptId)) {
        reservationSequence += 1;
        await stores.executionJournal.saveCapacityReservation({
          id: 'res-dry-run-' + String(reservationSequence),
          attemptId: request.attemptId,
          hostId: 'lane-example',
          slotIndex: 0,
          held: true,
          seatTool: request.seatTool,
          hostName: 'lane-example',
          hostKind: request.seatTool,
          transport: 'local',
          sshAlias: null,
          port: null,
          worktreePath: request.worktreePath,
          reservedAtIso: nowIso(),
          releasedAtIso: null,
        });
      }
      return { outcome: 'admitted' };
    },
  };

  const dispatchAttempt: DispatchAttemptPort = {
    dispatchAttempt: async (request) => {
      recordCall('dispatch', request);
      sessionSequence += 1;
      const sessionId = 'dry-run-session-' + String(sessionSequence);
      const base = await findOrCreateAttempt(request);
      const running: AttemptRecord = {
        ...base,
        revision: (base.revision ?? 0) + 1,
        state: 'running',
        sessionId,
        updatedAtIso: nowIso(),
      };
      await stores.attemptRepo.saveAttempt(running);
      return { outcome: 'started', attempt: running, sessionId };
    },
  };

  const reconcileAttempt: ReconcileAttemptPort = {
    reconcileAttempt: async (request) => {
      recordCall('reconcile', request);
      const base = await stores.attemptRepo.findAttemptById(request.attemptId);
      const receipt: CommandCompletionReceipt = {
        attemptId: request.attemptId,
        sessionId: base?.sessionId ?? 'dry-run-session-1',
        endedAtIso: nowIso(),
        authoritative: true,
        exitStatus: 0,
        stoppedByRequest: false,
      };
      const ended: AttemptRecord = {
        ...(base ?? baseAttemptOf({ attemptId: request.attemptId, workOrderId: '', worktreePath: '', baseCommit: '' }, nowIso)),
        revision: (base?.revision ?? 0) + 1,
        state: 'ended',
        outcome: 'done',
        completionReceipt: receipt,
        updatedAtIso: nowIso(),
      };
      await stores.attemptRepo.saveAttempt(ended);
      return { outcome: 'ended', attempt: ended, receipt };
    },
  };

  const stopAttempt: StopAttemptPort = {
    stopAttempt: async (request) => {
      recordCall('stop', request);
      const base = await stores.attemptRepo.findAttemptById(request.attemptId);
      const receipt: CommandCompletionReceipt = {
        attemptId: request.attemptId,
        sessionId: base?.sessionId ?? 'dry-run-session-1',
        endedAtIso: nowIso(),
        authoritative: true,
        exitStatus: 0,
        stoppedByRequest: true,
      };
      const ended: AttemptRecord = {
        ...(base ?? baseAttemptOf({ attemptId: request.attemptId, workOrderId: '', worktreePath: '', baseCommit: '' }, nowIso)),
        revision: (base?.revision ?? 0) + 1,
        state: 'ended',
        outcome: 'stopped',
        completionReceipt: receipt,
        updatedAtIso: nowIso(),
      };
      await stores.attemptRepo.saveAttempt(ended);
      return { outcome: 'terminated', attempt: ended, receipt, capacityReleased: true };
    },
  };

  const collectAttemptArtifacts: CollectAttemptArtifactsPort = {
    collectAttemptArtifacts: async (request) => {
      recordCall('collect', request);
      const base = await stores.attemptRepo.findAttemptById(request.attemptId);
      const artifacts: CollectedAttemptArtifacts = {
        headCommit: DRY_RUN_HEAD_COMMIT,
        commitsSinceBase: [DRY_RUN_HEAD_COMMIT],
        collectedArtifactPaths: [],
        notes: 'present',
        manifestPath: '.lane/artifacts-manifest-dddddddddddddd.json',
        manifestSha256: 'e'.repeat(64),
      };
      const collected: AttemptRecord = {
        ...(base ?? baseAttemptOf({ attemptId: request.attemptId, workOrderId: request.workOrderId, worktreePath: '', baseCommit: '' }, nowIso)),
        revision: (base?.revision ?? 0) + 1,
        state: 'collected',
        artifacts,
        updatedAtIso: nowIso(),
      };
      await stores.attemptRepo.saveAttempt(collected);
      return { outcome: 'collected', artifacts };
    },
  };

  const commitEditOnlyAttempt: CommitEditOnlyAttemptPort = {
    commitEditOnlyAttempt: async (request) => {
      recordCall('commitEditOnly', request);
      return { outcome: 'not-applicable' };
    },
  };

  const evaluateAttemptGate: EvaluateAttemptGatePort = {
    evaluateAttemptGate: async (request) => {
      recordCall('gate', request);
      return { verdict: 'passed' };
    },
  };

  const runnerForAttempt: RunnerForAttemptPort = {
    runnerForAttempt: () => {
      recordCall('runnerForAttempt');
      return { ok: true, runner: dryRunRunner() };
    },
  };

  const artifactPort: Pick<AttemptArtifactPort, 'readBriefManifest' | 'verifyArtifactManifest'> = {
    readBriefManifest: async () => DRY_RUN_MANIFEST_JSON,
    verifyArtifactManifest: async (request) => ({
      outcome: 'sealed',
      manifest: {
        schemaVersion: 1,
        attemptId: request.attemptId,
        files: [],
        total: { files: 0, bytes: 0 },
      },
    }),
  };

  return {
    recorder: { calls },
    admission,
    dispatchAttempt,
    reconcileAttempt,
    stopAttempt,
    collectAttemptArtifacts,
    commitEditOnlyAttempt,
    evaluateAttemptGate,
    runnerForAttempt,
    artifactPort,
  };
}
