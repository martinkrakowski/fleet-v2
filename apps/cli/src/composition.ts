/**
 * Fleet CLI composition root: instantiates the adapters of all four bounded
 * contexts, binds work-execution's consumer-side outbound contracts to the
 * supplier contexts' application ports, and wires every use case with its
 * dependencies.
 *
 * Cross-context delegation happens only here:
 * - AcceptanceAssessmentAdapter -> evidence-and-acceptance assessment
 * - BriefKnowledgeAdapter        -> brief-knowledge proposals/selections/notes
 * - ActionAuthorizationAdapter   -> operator-coordination authorization
 * - ExecutionObservationAdapter  -> operator-coordination observation publication
 *
 * File-backed state (repositories, decision answers, outboxes, archive) lives
 * under the optional `stateDir`; without it every store is in-memory and the
 * decision/relay/observation transports stay unconfigured, which their ports
 * report honestly rather than inventing answers.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  AcceptanceAssessmentAdapter,
  ActionAuthorizationAdapter,
  AttemptArtifactAdapter,
  AttemptRepositoryAdapter,
  BriefAuthoringAdapter,
  BriefKnowledgeAdapter,
  CollectAttemptArtifactsUseCase,
  DispatchAttemptUseCase,
  ExecuteAuthorizedForgeActionUseCase,
  ExecutionJournalAdapter,
  ExecutionObservationAdapter,
  ExecutionRunnerAdapter,
  ForgeActionAdapter,
  InspectWorkOrderUseCase,
  PrepareBriefPackageUseCase,
  PrepareFixAttemptUseCase,
  ReconcileAttemptUseCase,
  RegisterWorkOrderUseCase,
  RequestAttemptAcceptanceUseCase,
  ReserveExecutionCapacityUseCase,
  StopAttemptUseCase,
  WorkOrderRepositoryAdapter,
  WorkspaceAdapter,
  type GhInvocationResult,
} from '@fleet/work-execution';

import {
  AssessHeadAcceptanceUseCase,
  EvidenceArchiveAdapter,
  EvidenceAssessmentRepositoryAdapter,
  ForgeEvidenceAdapter,
  IndependentReviewAdapter,
  InspectAcceptanceEvidenceUseCase,
  RecordFindingDispositionUseCase,
  RecordReviewReceiptUseCase,
  RecordVerificationReceiptUseCase,
  RequestIndependentReviewUseCase,
  RequestVerificationUseCase,
  VerificationExecutorAdapter,
} from '@fleet/evidence-and-acceptance';

import {
  CaptureCompletedAttemptNotesUseCase,
  CheckKnowledgeClaimUseCase,
  ClaimVerificationAdapter,
  DecideKnowledgeDispositionUseCase,
  KeeperPublicationAdapter,
  KnowledgeEntryRepositoryAdapter,
  KnowledgeRetrievalAdapter,
  ProposeBriefContextUseCase,
  PublishAcceptedKeeperUseCase,
  RecordContextSelectionUseCase,
  RecordKnowledgeReuseUseCase,
  SupersedeKnowledgeEntryUseCase,
} from '@fleet/brief-knowledge';

import {
  AttentionReadAdapter,
  CoordinationRequestRepositoryAdapter,
  DecisionTransportAdapter,
  InspectConfiguredCapabilitiesUseCase,
  InspectOutstandingCoordinationUseCase,
  ObservationPublicationAdapter,
  ProjectProfileRepositoryAdapter,
  PublishProjectObservationUseCase,
  ReadProjectAttentionUseCase,
  RecordAuthorizationConsumptionUseCase,
  RecordRelayAcknowledgementUseCase,
  RegisterProjectProfileUseCase,
  RelayTransportAdapter,
  RequestScopedDecisionUseCase,
  ResolveActionAuthorizationUseCase,
  SendFleetRelayUseCase,
} from '@fleet/operator-coordination';

export interface FleetCliRuntimeOptions {
  /** Directory for file-backed state; every store is in-memory when omitted. */
  readonly stateDir?: string;
  /** Agent, model and variant handed to the live runner subprocess. */
  readonly runnerAgent?: string;
  readonly runnerModel?: string;
  readonly runnerVariant?: string;
  /** Port the runner subprocess reaches its remote session server on. */
  readonly runnerRemotePort?: number;
  /** Override of the bundled ocm-run binary path (FLEET_OCM_RUN_BIN). */
  readonly ocmRunBin?: string;
  /** SSH host passed as OCM_HOST when the runner needs a loopback tunnel. */
  readonly runnerRemoteHost?: string;
  /** SSH host alias holding the worktree when it is not on this host. */
  readonly worktreeSshHost?: string;
  /** Owner Ed25519 public key in base64 format for verifying approved decisions. */
  readonly ownerPublicKey?: string;
}

/** Deterministic identity of the acceptance assessment bound to one attempt. */
export function assessmentIdForAttempt(attemptId: string): string {
  return `assessment-${attemptId}`;
}

/**
 * Read one flat JSON record file as a plain object. An absent, unreadable or
 * malformed file degrades to an empty record; the consuming delegate then
 * reports the missing receipt or coordinates honestly instead of crashing.
 */
function readJsonRecord<T>(filePath: string): Record<string, T> {
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, T>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Write one flat JSON record file atomically: the payload lands in a
 * process-unique temp file first and is renamed over the target, so a
 * concurrent reader never observes a half-written document.
 */
function writeJsonRecordAtomic<T>(filePath: string, data: Record<string, T>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tempPath, filePath);
}

/** Grant-to-attempt binding persisted for cross-process forge execution. */
interface AuthorizationCoordinates {
  readonly attemptId: string;
  readonly expectedHeadSha: string;
}

/** Deterministic coordination action scope for one forge action kind. */
export function forgeActionScope(kind: 'push-and-open-pr' | 'merge-pr'): string {
  return `forge:${kind}`;
}

/** Single-quote one argument for the remote POSIX shell. */
function posixQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Replace the argument following one flag when the operator supplied an
 * override. A blank or absent override leaves the reviewed argument alone, so
 * the default invocation is unchanged.
 */
function replaceArgumentAfter(
  args: readonly string[],
  flag: string,
  override: string | undefined,
): readonly string[] {
  if (override === undefined || override === '') return args;
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return args;
  const replaced = [...args];
  replaced[index + 1] = override;
  return replaced;
}

/**
 * Operator overrides for the reviewed GitHub CLI argument array. The fleet
 * still chooses which command runs; only the human-readable title, body and
 * merge cleanup come from the operator's own environment, never from a lane.
 */
function applyGhEnvironmentOverrides(args: readonly string[]): readonly string[] {
  if (args[0] === 'pr' && args[1] === 'create') {
    const withTitle = replaceArgumentAfter(args, '--title', process.env.FLEET_PR_TITLE?.trim());
    return replaceArgumentAfter(withTitle, '--body', process.env.FLEET_PR_BODY?.trim());
  }
  if (args[0] === 'pr' && args[1] === 'merge' && process.env.FLEET_PR_DELETE_BRANCH === '1') {
    return [...args, '--delete-branch'];
  }
  return args;
}

/**
 * Run the reviewed GitHub CLI subprocess for the forge adapter. A completed
 * invocation resolves with its exit code and captured output; a spawn failure
 * (for example a missing binary) rejects so the adapter reports the outcome as
 * ambiguous for reconciliation instead of guessing.
 */
function runGhSubprocess(args: readonly string[]): Promise<GhInvocationResult> {
  return new Promise((resolve, reject) => {
    execFile('gh', [...applyGhEnvironmentOverrides(args)], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      const code = (error as { code?: number | string }).code;
      if (typeof code === 'number') {
        resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      reject(error);
    });
  });
}

/**
 * Read the live HEAD commit of a directory with `git rev-parse`. A spawn
 * failure (missing binary, unreadable worktree) rejects so the forge adapter
 * reports the outcome as ambiguous for reconciliation instead of guessing.
 * When the worktree lives on another host, the same read-only rev-parse runs
 * over the reviewed ssh alias instead.
 */
function readGitHead(worktreePath: string, sshHost?: string): Promise<string> {
  const invocation =
    sshHost !== undefined && !existsSync(worktreePath)
      ? {
          command: 'ssh',
          args: [
            sshHost,
            ['git', '-C', worktreePath, 'rev-parse', 'HEAD'].map(posixQuote).join(' '),
          ],
        }
      : { command: 'git', args: ['-C', worktreePath, 'rev-parse', 'HEAD'] };
  return new Promise((resolve, reject) => {
    execFile(invocation.command, invocation.args, { encoding: 'utf8' }, (error, stdout) => {
      if (error === null) {
        resolve(String(stdout).trim());
        return;
      }
      reject(error);
    });
  });
}

/** Run one local git command, resolving with stdout or rejecting on failure. */
function runGitCommand(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { encoding: 'utf8' }, (error, stdout) => {
      if (error === null) {
        resolve(String(stdout).trim());
        return;
      }
      reject(error);
    });
  });
}

/**
 * The wired runtime handed to the CLI driver. Use cases are grouped per
 * bounded context and named after their inbound port method; the stateful
 * adapters the driver derives input from are exposed alongside them.
 */
export interface FleetCliRuntime {
  readonly coordination: {
    readonly projectProfileRepository: ProjectProfileRepositoryAdapter;
    readonly coordinationRequestRepository: CoordinationRequestRepositoryAdapter;
    readonly decisionTransport: DecisionTransportAdapter;
    readonly observationPublication: ObservationPublicationAdapter;
    readonly relayTransport: RelayTransportAdapter;
    readonly attentionRead: AttentionReadAdapter;
    readonly registerProjectProfile: RegisterProjectProfileUseCase;
    readonly inspectConfiguredCapabilities: InspectConfiguredCapabilitiesUseCase;
    readonly requestScopedDecision: RequestScopedDecisionUseCase;
    readonly resolveActionAuthorization: ResolveActionAuthorizationUseCase;
    readonly recordAuthorizationConsumption: RecordAuthorizationConsumptionUseCase;
    readonly publishProjectObservation: PublishProjectObservationUseCase;
    readonly readProjectAttention: ReadProjectAttentionUseCase;
    readonly sendFleetRelay: SendFleetRelayUseCase;
    readonly recordRelayAcknowledgement: RecordRelayAcknowledgementUseCase;
    readonly inspectOutstandingCoordination: InspectOutstandingCoordinationUseCase;
  };
  readonly knowledge: {
    readonly knowledgeEntryRepository: KnowledgeEntryRepositoryAdapter;
    readonly claimVerification: ClaimVerificationAdapter;
    readonly keeperPublication: KeeperPublicationAdapter;
    readonly knowledgeRetrieval: KnowledgeRetrievalAdapter;
    readonly captureCompletedAttemptNotes: CaptureCompletedAttemptNotesUseCase;
    readonly checkKnowledgeClaim: CheckKnowledgeClaimUseCase;
    readonly decideKnowledgeDisposition: DecideKnowledgeDispositionUseCase;
    readonly publishAcceptedKeeper: PublishAcceptedKeeperUseCase;
    readonly proposeBriefContext: ProposeBriefContextUseCase;
    readonly recordContextSelection: RecordContextSelectionUseCase;
    readonly recordKnowledgeReuse: RecordKnowledgeReuseUseCase;
    readonly supersedeKnowledgeEntry: SupersedeKnowledgeEntryUseCase;
  };
  readonly evidence: {
    readonly evidenceAssessmentRepository: EvidenceAssessmentRepositoryAdapter;
    readonly evidenceArchive: EvidenceArchiveAdapter;
    readonly verificationExecutor: VerificationExecutorAdapter;
    readonly independentReview: IndependentReviewAdapter;
    readonly forgeEvidence: ForgeEvidenceAdapter;
    readonly requestVerification: RequestVerificationUseCase;
    readonly requestIndependentReview: RequestIndependentReviewUseCase;
    readonly recordVerificationReceipt: RecordVerificationReceiptUseCase;
    readonly recordReviewReceipt: RecordReviewReceiptUseCase;
    readonly recordFindingDisposition: RecordFindingDispositionUseCase;
    readonly assessHeadAcceptance: AssessHeadAcceptanceUseCase;
    readonly inspectAcceptanceEvidence: InspectAcceptanceEvidenceUseCase;
  };
  readonly execution: {
    readonly workOrderRepository: WorkOrderRepositoryAdapter;
    readonly attemptRepository: AttemptRepositoryAdapter;
    readonly executionJournal: ExecutionJournalAdapter;
    readonly workspace: WorkspaceAdapter;
    readonly runner: ExecutionRunnerAdapter;
    readonly attemptArtifact: AttemptArtifactAdapter;
    readonly briefAuthoring: BriefAuthoringAdapter;
    readonly acceptanceAssessment: AcceptanceAssessmentAdapter;
    readonly actionAuthorization: ActionAuthorizationAdapter;
    readonly briefKnowledge: BriefKnowledgeAdapter;
    readonly executionObservation: ExecutionObservationAdapter;
    readonly forgeAction: ForgeActionAdapter;
    readonly registerWorkOrder: RegisterWorkOrderUseCase;
    readonly inspectWorkOrder: InspectWorkOrderUseCase;
    readonly prepareBriefPackage: PrepareBriefPackageUseCase;
    readonly reserveExecutionCapacity: ReserveExecutionCapacityUseCase;
    readonly dispatchAttempt: DispatchAttemptUseCase;
    readonly reconcileAttempt: ReconcileAttemptUseCase;
    readonly stopAttempt: StopAttemptUseCase;
    readonly collectAttemptArtifacts: CollectAttemptArtifactsUseCase;
    readonly prepareFixAttempt: PrepareFixAttemptUseCase;
    readonly requestAttemptAcceptance: RequestAttemptAcceptanceUseCase;
    readonly executeAuthorizedForgeAction: ExecuteAuthorizedForgeActionUseCase;
  };
}

export function createFleetCliRuntime(options?: FleetCliRuntimeOptions): FleetCliRuntime {
  const stateDir = options?.stateDir;

  // --- live runner / worktree host configuration -----------------------------
  // Explicit options win; the environment is the operator's installation
  // configuration. A blank value is treated as absent rather than as "".
  const worktreeSshHost =
    options?.worktreeSshHost ?? (process.env.FLEET_WORKTREE_SSH_HOST?.trim() || undefined);
  const runnerAgent = options?.runnerAgent ?? (process.env.FLEET_RUNNER_AGENT?.trim() || undefined);
  const runnerModel = options?.runnerModel ?? (process.env.FLEET_RUNNER_MODEL?.trim() || undefined);
  const runnerVariant =
    options?.runnerVariant ?? (process.env.FLEET_RUNNER_VARIANT?.trim() || undefined);
  const parsedPort = process.env.OCM_REMOTE_PORT ? Number(process.env.OCM_REMOTE_PORT) : Number.NaN;
  const runnerRemotePort =
    options?.runnerRemotePort ?? (Number.isFinite(parsedPort) ? parsedPort : undefined);
  const ocmRunBin = options?.ocmRunBin ?? (process.env.FLEET_OCM_RUN_BIN?.trim() || undefined);
  const runnerRemoteHost =
    options?.runnerRemoteHost ?? (process.env.OCM_HOST?.trim() || undefined);
  const ownerPublicKey =
    options?.ownerPublicKey ?? (process.env.FLEET_OWNER_PUBLIC_KEY?.trim() || undefined);

  // --- operator-coordination -------------------------------------------------

  const projectProfileRepository = new ProjectProfileRepositoryAdapter({ stateDir });
  const coordinationRequestRepository = new CoordinationRequestRepositoryAdapter({ stateDir });
  // Owner-recorded decision answers, one `<requestId>.json` per request. An
  // absent or grantless answer stays `awaiting-decision`; nothing is upgraded.
  const decisionTransport = new DecisionTransportAdapter({
    decisionsDir: stateDir === undefined ? undefined : join(stateDir, 'decisions'),
    ownerPublicKey,
  });
  const observationPublication = new ObservationPublicationAdapter({
    outboxDir: stateDir === undefined ? undefined : join(stateDir, 'observation-outbox'),
  });
  const relayTransport = new RelayTransportAdapter({
    outboxDir: stateDir === undefined ? undefined : join(stateDir, 'relay-outbox'),
  });
  // No attention reader is configured in the scaffold; reads report absence.
  const attentionRead = new AttentionReadAdapter();

  const coordination = {
    projectProfileRepository,
    coordinationRequestRepository,
    decisionTransport,
    observationPublication,
    relayTransport,
    attentionRead,
    registerProjectProfile: new RegisterProjectProfileUseCase({ profileRepo: projectProfileRepository }),
    inspectConfiguredCapabilities: new InspectConfiguredCapabilitiesUseCase({
      profileRepo: projectProfileRepository,
    }),
    requestScopedDecision: new RequestScopedDecisionUseCase({
      requestRepo: coordinationRequestRepository,
      decisionTransport,
    }),
    resolveActionAuthorization: new ResolveActionAuthorizationUseCase({
      requestRepo: coordinationRequestRepository,
      decisionTransport,
    }),
    recordAuthorizationConsumption: new RecordAuthorizationConsumptionUseCase({
      requestRepo: coordinationRequestRepository,
    }),
    publishProjectObservation: new PublishProjectObservationUseCase({
      publicationPort: observationPublication,
    }),
    readProjectAttention: new ReadProjectAttentionUseCase({ attentionPort: attentionRead }),
    sendFleetRelay: new SendFleetRelayUseCase({
      requestRepo: coordinationRequestRepository,
      relayTransport,
    }),
    recordRelayAcknowledgement: new RecordRelayAcknowledgementUseCase({
      requestRepo: coordinationRequestRepository,
    }),
    inspectOutstandingCoordination: new InspectOutstandingCoordinationUseCase({
      requestRepo: coordinationRequestRepository,
      publicationPort: observationPublication,
    }),
  };

  // --- brief-knowledge -------------------------------------------------------

  const knowledgeEntryRepository = new KnowledgeEntryRepositoryAdapter({ stateDir });
  // Bounded, allow-listed procedures only; the claim text is never interpreted.
  const claimVerification = new ClaimVerificationAdapter();
  const keeperPublication = new KeeperPublicationAdapter({ stateDir });
  const knowledgeRetrieval = new KnowledgeRetrievalAdapter();

  const knowledge = {
    knowledgeEntryRepository,
    claimVerification,
    keeperPublication,
    knowledgeRetrieval,
    captureCompletedAttemptNotes: new CaptureCompletedAttemptNotesUseCase({
      repo: knowledgeEntryRepository,
    }),
    checkKnowledgeClaim: new CheckKnowledgeClaimUseCase({
      repo: knowledgeEntryRepository,
      verifier: claimVerification,
    }),
    decideKnowledgeDisposition: new DecideKnowledgeDispositionUseCase({
      repo: knowledgeEntryRepository,
    }),
    publishAcceptedKeeper: new PublishAcceptedKeeperUseCase({
      repo: knowledgeEntryRepository,
      publisher: keeperPublication,
    }),
    proposeBriefContext: new ProposeBriefContextUseCase({
      repo: knowledgeEntryRepository,
      retrieval: knowledgeRetrieval,
    }),
    recordContextSelection: new RecordContextSelectionUseCase({ repo: knowledgeEntryRepository }),
    recordKnowledgeReuse: new RecordKnowledgeReuseUseCase({ repo: knowledgeEntryRepository }),
    supersedeKnowledgeEntry: new SupersedeKnowledgeEntryUseCase({ repo: knowledgeEntryRepository }),
  };

  // --- evidence-and-acceptance ------------------------------------------------

  const evidenceAssessmentRepository = new EvidenceAssessmentRepositoryAdapter({ stateDir });
  const evidenceArchive = new EvidenceArchiveAdapter({
    archiveDir: stateDir === undefined ? undefined : join(stateDir, 'evidence-archive'),
  });
  // No verification host is allow-listed in the scaffold, so executed checks
  // report `unknown` until a receipt is recorded by the operator.
  const verificationExecutor = new VerificationExecutorAdapter();
  // No independent review transport is configured; requests report that.
  const independentReview = new IndependentReviewAdapter();
  // Instantiated for the station that binds a live forge transport; an
  // unconfigured adapter reads every CI state as `unknown`, so it is not
  // bound to AssessHeadAcceptanceUseCase here. Recorded receipts stay the
  // acceptance evidence until that transport exists.
  const forgeEvidence = new ForgeEvidenceAdapter();

  const evidence = {
    evidenceAssessmentRepository,
    evidenceArchive,
    verificationExecutor,
    independentReview,
    forgeEvidence,
    requestVerification: new RequestVerificationUseCase({
      repo: evidenceAssessmentRepository,
      executor: verificationExecutor,
      archive: evidenceArchive,
    }),
    requestIndependentReview: new RequestIndependentReviewUseCase({
      repo: evidenceAssessmentRepository,
      reviewer: independentReview,
      archive: evidenceArchive,
    }),
    recordVerificationReceipt: new RecordVerificationReceiptUseCase({
      repo: evidenceAssessmentRepository,
    }),
    recordReviewReceipt: new RecordReviewReceiptUseCase({ repo: evidenceAssessmentRepository }),
    recordFindingDisposition: new RecordFindingDispositionUseCase({
      repo: evidenceAssessmentRepository,
    }),
    assessHeadAcceptance: new AssessHeadAcceptanceUseCase({ repo: evidenceAssessmentRepository }),
    inspectAcceptanceEvidence: new InspectAcceptanceEvidenceUseCase({
      repo: evidenceAssessmentRepository,
    }),
  };

  // --- work-execution ---------------------------------------------------------

  const workOrderRepository = new WorkOrderRepositoryAdapter({ stateDir });
  const attemptRepository = new AttemptRepositoryAdapter({ stateDir });
  const executionJournal = new ExecutionJournalAdapter({ stateDir });
  const workspace = new WorkspaceAdapter({ sshHost: worktreeSshHost });
  // Wraps the reviewed `ocm-run` runner subprocess. The bundled repository
  // script is the default; the worktree locator is resolved from the recorded
  // attempt so a later CLI process (reconcile, stop, collect) addresses the
  // same directory the dispatch used.
  const runner = new ExecutionRunnerAdapter({
    ocmRunBin,
    agent: runnerAgent,
    model: runnerModel,
    variant: runnerVariant,
    remotePort: runnerRemotePort,
    remoteHost: runnerRemoteHost,
    resolveWorktreePath: async (attemptId) =>
      (await attemptRepository.findAttemptById(attemptId))?.worktreePath ?? null,
  });
  const attemptArtifact = new AttemptArtifactAdapter({ sshHost: worktreeSshHost });
  // Hand-written brief files arrive per request; no default prose is assumed.
  const briefAuthoring = new BriefAuthoringAdapter();
  // The reviewed GitHub CLI subprocess behind a host-side delegate; every
  // invocation first verifies the live HEAD of the attempt's own worktree so
  // a moved branch head is never pushed or merged on stale readiness.
  const forgeAction = new ForgeActionAdapter({
    runGh: runGhSubprocess,
    verifyCurrentHeadSha: async (branchName, request) => {
      const attempt = await attemptRepository.findAttemptById(request.attemptId);
      if (attempt === null) {
        throw new Error(`No attempt is recorded for ${request.attemptId}`);
      }
      const head = await readGitHead(attempt.worktreePath, worktreeSshHost);
      // A worktree that lives on another host has its branch only on that
      // host's repository; `gh pr create` needs the branch on origin, so the
      // verified head is fetched across and pushed before the PR is opened.
      const branchRef = `${head}:refs/heads/${branchName}`;
      const shouldSeedOrigin =
        request.kind === 'push-and-open-pr' &&
        head === request.expectedHeadSha &&
        (worktreeSshHost !== undefined || process.env.FLEET_FORGE_PUSH_ORIGIN === '1');
      if (shouldSeedOrigin && worktreeSshHost !== undefined && !existsSync(attempt.worktreePath)) {
        await runGitCommand([
          'fetch',
          `${worktreeSshHost}:${attempt.worktreePath}`,
          branchRef,
          '--force',
        ]);
        await runGitCommand(['push', '-f', 'origin', branchRef]);
      }
      return head;
    },
  });

  // Live registry of acceptance receipts per candidate head: the acceptance
  // delegate records entries and the merge gate consumes them, so a merge is
  // only ever authorized for a head whose acceptance receipt exists. With a
  // stateDir the registry is backed by `<stateDir>/accepted-receipts.json`:
  // every read reloads the file first, so a separate CLI process running
  // `forge execute --kind merge-pr` sees receipts recorded by an earlier
  // `attempt accept` / `evidence assess` process.
  const acceptedReceiptsPath =
    stateDir === undefined ? undefined : join(stateDir, 'accepted-receipts.json');
  const acceptedReceiptByHead: Record<string, string> = {};
  const acceptedReceiptByHeadView: Record<string, string> =
    acceptedReceiptsPath === undefined
      ? acceptedReceiptByHead
      : new Proxy(acceptedReceiptByHead, {
          get(target, prop) {
            if (typeof prop === 'string') {
              Object.assign(target, readJsonRecord<string>(acceptedReceiptsPath));
              return target[prop];
            }
            return undefined;
          },
        });

  const acceptanceAssessment = new AcceptanceAssessmentAdapter({
    assess: async (request) => {
      const result = await evidence.assessHeadAcceptance.assessHeadAcceptance({
        assessmentId: assessmentIdForAttempt(request.attemptId),
        candidateHeadSha: request.candidateHeadSha,
        policyRevision: request.policyRevision,
      });
      if (result.outcome === 'accepted') {
        acceptedReceiptByHead[result.candidateHeadSha] = result.receiptId;
        if (acceptedReceiptsPath !== undefined) {
          writeJsonRecordAtomic(acceptedReceiptsPath, {
            ...readJsonRecord<string>(acceptedReceiptsPath),
            [result.candidateHeadSha]: result.receiptId,
          });
        }
        return {
          outcome: 'accepted',
          receiptId: result.receiptId,
          assessedHeadSha: result.candidateHeadSha,
        };
      }
      if (result.outcome === 'blocked') {
        return { outcome: 'rejected', reason: `Acceptance blocked: ${result.blockers.join('; ')}` };
      }
      // `rejected` and `stale` both leave the action without a pass.
      return { outcome: 'rejected', reason: result.reason };
    },
  });

  const briefKnowledge = new BriefKnowledgeAdapter({
    propose: async (request) => {
      const result = await knowledge.proposeBriefContext.proposeBriefContext({
        projectId: request.projectId,
        laneId: request.laneId,
        taskSummary: request.taskSummary,
      });
      return result.outcome === 'proposed'
        ? {
            outcome: 'proposed',
            proposals: result.proposals.map((proposal) => ({
              proposalId: proposal.proposalId,
              knowledgeEntryId: proposal.knowledgeEntryId,
              version: proposal.version,
              proposedBecause: proposal.proposedBecause,
            })),
          }
        : { outcome: 'unavailable', reason: result.reason };
    },
    recordSelection: async (request) => {
      const result = await knowledge.recordContextSelection.recordContextSelection({
        attemptId: request.attemptId,
        selections: request.selections.map((selection) => ({
          proposalId: selection.proposalId,
          knowledgeEntryId: selection.knowledgeEntryId,
          version: selection.version,
          accepted: selection.accepted,
        })),
      });
      return result.outcome === 'recorded'
        ? { outcome: 'recorded' }
        : { outcome: 'refused', reason: result.reason };
    },
    forwardNotes: async (request) => {
      // The consumer-side contract carries no project identity; the work order
      // owns it, so the delegation resolves it before capturing notes.
      const workOrder = await workOrderRepository.findWorkOrderById(request.workOrderId);
      if (workOrder === null) {
        return { outcome: 'refused', reason: `Work order not found: ${request.workOrderId}` };
      }
      const result = await knowledge.captureCompletedAttemptNotes.captureCompletedAttemptNotes({
        projectId: workOrder.projectId,
        attemptId: request.attemptId,
        workOrderId: request.workOrderId,
        headCommitSha: request.headCommit,
        notesMarkdown: request.notes,
      });
      return result.outcome === 'captured'
        ? { outcome: 'forwarded' }
        : { outcome: 'refused', reason: result.reason };
    },
  });

  // Grant-to-attempt coordinates recorded when the authorization delegate
  // resolves a grant. With a stateDir they are mirrored to
  // `<stateDir>/authorization-coordinates.json`, so a separate CLI process
  // running `forge execute` after an earlier `coordination resolve-auth`
  // process finds the grant's bound attempt and expected head.
  const authorizationCoordinatesPath =
    stateDir === undefined ? undefined : join(stateDir, 'authorization-coordinates.json');
  const resolveCoordinates = new Map<string, AuthorizationCoordinates>();

  const actionAuthorization = new ActionAuthorizationAdapter({
    resolveGrant: async (request) => {
      const result = await coordination.resolveActionAuthorization.resolveActionAuthorization({
        projectId: request.projectId,
        actionScope: forgeActionScope(request.actionKind),
        expectedHeadSha: request.expectedHeadSha,
      });
      if (result.outcome === 'authorized') {
        resolveCoordinates.set(result.grantId, {
          attemptId: request.attemptId,
          expectedHeadSha: request.expectedHeadSha,
        });
        if (authorizationCoordinatesPath !== undefined) {
          writeJsonRecordAtomic(authorizationCoordinatesPath, {
            ...readJsonRecord<AuthorizationCoordinates>(authorizationCoordinatesPath),
            [result.grantId]: {
              attemptId: request.attemptId,
              expectedHeadSha: request.expectedHeadSha,
            },
          });
        }
        return { outcome: 'granted', authorizationGrantId: result.grantId };
      }
      return { outcome: 'blocked', reason: result.reason };
    },
    consumeGrant: async (request) => {
      // The consumer-side consumption request carries only grant and action
      // identities; the head and the bound attempt are resolved from the
      // recorded grant so the coordination context can durably bind them.
      const grant = await coordinationRequestRepository.findRequestByGrantId(
        request.authorizationGrantId,
      );
      if (grant === null) {
        return { outcome: 'refused', reason: `Authorization grant not recorded: ${request.authorizationGrantId}` };
      }
      if (grant.expectedHeadSha === null) {
        return {
          outcome: 'refused',
          reason: `Authorization grant ${request.authorizationGrantId} records no expected head`,
        };
      }
      // Coordinates recorded at resolve time bind the grant to its attempt;
      // a fresh process reloads them from disk before falling back to the
      // head-matching scan over all recorded attempts.
      if (
        !resolveCoordinates.has(request.authorizationGrantId) &&
        authorizationCoordinatesPath !== undefined
      ) {
        for (const [grantId, coordinates] of Object.entries(
          readJsonRecord<AuthorizationCoordinates>(authorizationCoordinatesPath),
        )) {
          if (
            typeof coordinates.attemptId === 'string' &&
            typeof coordinates.expectedHeadSha === 'string'
          ) {
            resolveCoordinates.set(grantId, {
              attemptId: coordinates.attemptId,
              expectedHeadSha: coordinates.expectedHeadSha,
            });
          }
        }
      }
      const coordinates = resolveCoordinates.get(request.authorizationGrantId);
      const boundAttempt =
        coordinates === undefined
          ? null
          : await attemptRepository.findAttemptById(coordinates.attemptId);
      const attempt =
        boundAttempt !== null && boundAttempt.artifacts?.headCommit === grant.expectedHeadSha
          ? boundAttempt
          : (await attemptRepository.listAllAttempts()).find(
              (candidate) => candidate.artifacts?.headCommit === grant.expectedHeadSha,
            );
      if (attempt === undefined) {
        return {
          outcome: 'refused',
          reason:
            `No collected attempt matches the head recorded for grant ${request.authorizationGrantId}`,
        };
      }
      const result = await coordination.recordAuthorizationConsumption.recordAuthorizationConsumption({
        consumptionId: `consumption-${request.actionId}`,
        grantId: request.authorizationGrantId,
        actionId: request.actionId,
        attemptId: attempt.id,
        expectedHeadSha: grant.expectedHeadSha,
      });
      return result.outcome === 'consumed'
        ? { outcome: 'consumed', actionId: request.actionId }
        : { outcome: 'refused', reason: result.reason };
    },
  });

  const executionObservation = new ExecutionObservationAdapter({
    publish: async (request) => {
      const result = await coordination.publishProjectObservation.publishProjectObservation({
        observationId: request.entry.id,
        projectId: request.projectId,
        eventKind: `execution:${request.entry.action}:${request.entry.status}`,
        sourceAttemptId: request.entry.attemptId,
        payloadSummary: JSON.stringify(request.entry),
      });
      return result.outcome === 'published'
        ? { outcome: 'published' }
        : { outcome: 'delivery-gap', reason: result.reason };
    },
  });

  const execution = {
    workOrderRepository,
    attemptRepository,
    executionJournal,
    workspace,
    runner,
    attemptArtifact,
    briefAuthoring,
    acceptanceAssessment,
    actionAuthorization,
    briefKnowledge,
    executionObservation,
    forgeAction,
    registerWorkOrder: new RegisterWorkOrderUseCase({ workOrderRepo: workOrderRepository }),
    inspectWorkOrder: new InspectWorkOrderUseCase({
      workOrderRepo: workOrderRepository,
      attemptRepo: attemptRepository,
      journal: executionJournal,
    }),
    prepareBriefPackage: new PrepareBriefPackageUseCase({
      briefAuthoring,
      artifactPort: attemptArtifact,
      briefKnowledge,
    }),
    reserveExecutionCapacity: new ReserveExecutionCapacityUseCase({
      journal: executionJournal,
      attemptRepo: attemptRepository,
    }),
    dispatchAttempt: new DispatchAttemptUseCase({
      workOrderRepo: workOrderRepository,
      attemptRepo: attemptRepository,
      journal: executionJournal,
      workspace,
      runner,
      observation: executionObservation,
    }),
    reconcileAttempt: new ReconcileAttemptUseCase({
      attemptRepo: attemptRepository,
      journal: executionJournal,
      runner,
    }),
    stopAttempt: new StopAttemptUseCase({
      attemptRepo: attemptRepository,
      journal: executionJournal,
      runner,
    }),
    collectAttemptArtifacts: new CollectAttemptArtifactsUseCase({
      attemptRepo: attemptRepository,
      journal: executionJournal,
      artifactPort: attemptArtifact,
      briefKnowledge,
    }),
    prepareFixAttempt: new PrepareFixAttemptUseCase({ attemptRepo: attemptRepository }),
    requestAttemptAcceptance: new RequestAttemptAcceptanceUseCase({
      attemptRepo: attemptRepository,
      workOrderRepo: workOrderRepository,
      acceptancePort: acceptanceAssessment,
    }),
    executeAuthorizedForgeAction: new ExecuteAuthorizedForgeActionUseCase({
      attemptRepo: attemptRepository,
      workOrderRepo: workOrderRepository,
      journal: executionJournal,
      authorizationPort: actionAuthorization,
      forgePort: forgeAction,
      acceptedReceiptByHead: acceptedReceiptByHeadView,
    }),
  };

  return { coordination, knowledge, evidence, execution };
}
