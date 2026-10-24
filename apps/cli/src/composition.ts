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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { GH_BINARY_CANDIDATES, resolveGhBinary } from './gh-binary.js';
import { withFileLock, writeJsonAtomically } from './file-store.js';

import {
  AcceptanceAssessmentAdapter,
  AcceptanceEvidenceAdapter,
  ActionAuthorizationAdapter,
  AllowedSeatAdapter,
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
  InspectAttemptUseCase,
  InspectWorkOrderUseCase,
  OpencodeDbUsageAdapter,
  PrepareBriefPackageUseCase,
  PrepareFixAttemptUseCase,
  ReconcileAttemptUseCase,
  RegisterWorkOrderUseCase,
  RequestAttemptAcceptanceUseCase,
  ReserveExecutionCapacityUseCase,
  RunnerForAttemptAdapter,
  SshExecutor,
  StopAttemptUseCase,
  WorkOrderRepositoryAdapter,
  WorkspaceAdapter,
  ExecutorForHost,
  hasRecordedHostName,
  consumptionId,
  forgeActionScope,
  isSafeSshHost,
  observationEventKind,
  resolveExecutionRunnerHost,
  resolveInstallationForgeMode,
  resolveRoleExecutors,
  resolveRunnerCapabilityProfile,
  sha256HexDigest,
  type ExecutionRunnerHost,
  type GhInvocationResult,
  type SubprocessRunner,
  type CommandExecutorPort,
} from '@fleet/work-execution';

import {
  AssessHeadAcceptanceUseCase,
  assessmentIdForAttempt,
  AttemptOwnerDecisionAdapter,
  EvidenceArchiveAdapter,
  EvidenceAssessmentRepositoryAdapter,
  EvidenceSeatPolicyAdapter,
  ForgeEvidenceAdapter,
  IndependentReviewAdapter,
  InspectAcceptanceEvidenceUseCase,
  OwnerDecisionAdapter,
  RecordFindingDispositionUseCase,
  RecordReviewReceiptUseCase,
  RecordVerificationReceiptUseCase,
  RequestIndependentReviewUseCase,
  RequestVerificationUseCase,
  VerificationExecutorAdapter,
} from '@fleet/evidence-and-acceptance';

import {
  AdvisedKnowledgeRetrievalAdapter,
  CaptureCompletedAttemptNotesUseCase,
  CheckKnowledgeClaimUseCase,
  ClaimVerificationAdapter,
  createClaimTriage,
  createRankingAdvice,
  DecideKnowledgeDispositionUseCase,
  type DecisionReceiptJournalPort,
  FileDecisionReceiptJournalAdapter,
  KeeperPublicationAdapter,
  KnowledgeEntryRepositoryAdapter,
  KnowledgeRetrievalAdapter,
  ListCandidateClaimsUseCase,
  NotConfiguredReceiptJournal,
  ProposeBriefContextUseCase,
  PublishAcceptedKeeperUseCase,
  RecordContextSelectionUseCase,
  RecordKnowledgeReuseUseCase,
  SupersedeKnowledgeEntryUseCase,
} from '@fleet/brief-knowledge';

import {
  AcknowledgeOwnerAnswerUseCase,
  AnswerOwnerQuestionUseCase,
  AskOwnerQuestionUseCase,
  AttentionReadAdapter,
  CheckOwnerDecisionUseCase,
  CoordinationRequestRepositoryAdapter,
  DecisionTransportAdapter,
  ExpireOwnerQuestionsUseCase,
  InspectConfiguredCapabilitiesUseCase,
  InspectOutstandingCoordinationUseCase,
  ListOwnerQuestionsUseCase,
  ObservationPublicationAdapter,
  OwnerQuestionRepositoryAdapter,
  ProjectProfileRepositoryAdapter,
  PublishProjectObservationUseCase,
  ReadOwnerQuestionUseCase,
  ReadProjectAttentionUseCase,
  RecordAuthorizationConsumptionUseCase,
  RecordRelayAcknowledgementUseCase,
  RegisterProjectProfileUseCase,
  RelayTransportAdapter,
  RequestScopedDecisionUseCase,
  ResolveActionAuthorizationUseCase,
  SendFleetRelayUseCase,
  SyncOneWayOwnerQuestionsUseCase,
  type OwnerQuestionClock,
} from '@fleet/operator-coordination';
import { requireValidInstallationModel, type FleetInstallation } from '@fleet/installation';

export interface FleetCliRuntimeOptions {
  /** Directory for file-backed state; every store is in-memory when omitted. */
  readonly stateDir?: string;
  /** Parsed installation configuration. */
  readonly installation?: FleetInstallation;
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
  /** Deterministic subprocess execution for runner tests. */
  readonly runSubprocess?: SubprocessRunner;
  /**
   * Argument-array `gh` runner for forge evidence reads (D6). Defaults to the
   * reviewed subprocess runner shared with the forge action adapter; tests
   * inject a stub transport here.
   */
  readonly forgeGhRunner?: (args: readonly string[]) => Promise<GhInvocationResult>;
  /**
   * Absolute gh locations overriding the fixed defaults (tests only).
   * Production always resolves the reviewed GitHub CLI from
   * GH_BINARY_CANDIDATES and never falls back to PATH (S4036).
   */
  readonly ghBinaryCandidates?: readonly string[];
  /**
   * Spy transport override for the ranking advice provider (tests only).
   * Production uses globalThis.fetch; the key itself is never in argv or env.
   */
  readonly adviceFetch?: typeof fetch;
  /** Stub key reader override for the ranking advice provider (tests only). */
  readonly adviceReadKey?: (path: string) => Promise<string>;
}

export interface ResolvedRunnerSettings {
  readonly worktreeSshHost?: string;
  readonly runnerAgent?: string;
  readonly runnerModel?: string;
  readonly runnerVariant?: string;
  readonly runnerRemotePort?: number;
  readonly ocmRunBin?: string;
  readonly runnerRemoteHost?: string;
}

/**
 * Resolves runner and worktree host configuration.
 * Resolution precedence: options.<x> ?? installation.<x> ?? <env read>.
 *
 * A v2 installation's own hosts section is the only routing source (plan
 * section 3, "Runtime reads the selected host, never the environment"): the
 * environment variables that redirect a legacy run (`OCM_REMOTE_PORT`,
 * `OCM_HOST`, `FLEET_WORKTREE_SSH_HOST`, `FLEET_RUNNER_*`) are ignored, the
 * `worktreeSshHost` override is dropped, and only the ocm-run binary path
 * (`FLEET_OCM_RUN_BIN`) stays environmental. The selected lane-runner host is
 * passed to the runner adapter separately through `resolveExecutionRunnerHost`.
 * A v1 or absent installation keeps today's behaviour byte-for-byte.
 */
export function resolveRunnerSettings(
  options?: FleetCliRuntimeOptions,
  installation?: FleetInstallation,
  env: Record<string, string | undefined> = process.env,
): ResolvedRunnerSettings {
  const inst = options?.installation ?? installation;
  if (inst?.schemaVersion === 2) {
    return {
      ocmRunBin:
        options?.ocmRunBin ??
        inst?.runner?.ocmRunBin ??
        (env.FLEET_OCM_RUN_BIN?.trim() || undefined),
    };
  }
  const parsedPort = env.OCM_REMOTE_PORT ? Number(env.OCM_REMOTE_PORT) : Number.NaN;
  return {
    worktreeSshHost:
      options?.worktreeSshHost ??
      inst?.worktree?.sshHost ??
      (env.FLEET_WORKTREE_SSH_HOST?.trim() || undefined),
    runnerAgent:
      options?.runnerAgent ??
      inst?.runner?.agent ??
      (env.FLEET_RUNNER_AGENT?.trim() || undefined),
    runnerModel:
      options?.runnerModel ??
      inst?.runner?.model ??
      (env.FLEET_RUNNER_MODEL?.trim() || undefined),
    runnerVariant:
      options?.runnerVariant ??
      inst?.runner?.variant ??
      (env.FLEET_RUNNER_VARIANT?.trim() || undefined),
    runnerRemotePort:
      options?.runnerRemotePort ??
      inst?.runner?.remotePort ??
      (Number.isFinite(parsedPort) ? parsedPort : undefined),
    ocmRunBin:
      options?.ocmRunBin ??
      inst?.runner?.ocmRunBin ??
      (env.FLEET_OCM_RUN_BIN?.trim() || undefined),
    runnerRemoteHost:
      options?.runnerRemoteHost ??
      inst?.runner?.host ??
      (env.OCM_HOST?.trim() || undefined),
  };
}

/** Deterministic identity of the acceptance assessment bound to one attempt. */
export { assessmentIdForAttempt } from '@fleet/evidence-and-acceptance';

/**
 * Read one flat JSON record file as a plain object. ENOENT means {};
 * any other read error or a JSON parse failure THROWS, preventing
 * destructive writes over corrupt state.
 */
export function readJsonRecord<T>(filePath: string): Record<string, T> {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'ENOENT'
    ) {
      return {};
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid JSON record in ${filePath}: expected an object`);
  }
  return parsed as Record<string, T>;
}

/** Grant-to-attempt binding persisted for cross-process forge execution. */
interface AuthorizationCoordinates {
  readonly attemptId: string;
  readonly expectedHeadSha: string;
}

export { consumptionId, forgeActionScope, observationEventKind };

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

/** Whether `path` is an executable regular file (S4036: absolute gh only). */
function isExecutableRegularFile(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Run the reviewed GitHub CLI subprocess for the forge adapter. The binary is
 * resolved from fixed absolute locations (S4036), never through PATH; when
 * none is found the invocation rejects so the adapter reports the forge as
 * unreadable (fail closed, as a missing binary does today). A completed
 * invocation resolves with its exit code and captured output; a spawn failure
 * rejects so the adapter reports the outcome as ambiguous for reconciliation
 * instead of guessing.
 */
function runGhSubprocess(
  args: readonly string[],
  candidates: readonly string[] = GH_BINARY_CANDIDATES,
): Promise<GhInvocationResult> {
  const ghBinary = resolveGhBinary(candidates, isExecutableRegularFile);
  if (ghBinary === undefined) {
    return Promise.reject(new Error('gh not found in fixed locations'));
  }
  return new Promise((resolve, reject) => {
    execFile(ghBinary, [...applyGhEnvironmentOverrides(args)], { encoding: 'utf8' }, (error, stdout, stderr) => {
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
 *
 * H9b2: this signature is the legacy path only. An attempt recorded on a
 * named host decides local-versus-ssh from the recorded transport (see the
 * forge wiring below); the `existsSync(worktreePath)` heuristic here is kept
 * exactly for legacy records and is no longer part of the recorded-host
 * decision.
 */
export function readGitHead(worktreePath: string, sshHost?: string): Promise<string> {
  if (sshHost !== undefined && !existsSync(worktreePath)) {
    return readGitHeadOverSsh(worktreePath, sshHost);
  }
  return readGitHeadLocally(worktreePath);
}

/** Read HEAD through the reviewed ssh alias (a worktree on another host). */
export function readGitHeadOverSsh(worktreePath: string, sshHost: string): Promise<string> {
  if (!isSafeSshHost(sshHost)) {
    return Promise.reject(new Error(`Refusing to read HEAD over SSH: unsafe host '${sshHost}'`));
  }
  const invocation = {
    command: 'ssh',
    args: [
      sshHost,
      '--',
      ['git', '-C', worktreePath, 'rev-parse', 'HEAD'].map(posixQuote).join(' '),
    ],
  };
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

/** Read HEAD locally (the worktree lives on this host). */
export function readGitHeadLocally(worktreePath: string): Promise<string> {
  return runGitCommand(['-C', worktreePath, 'rev-parse', 'HEAD']);
}

/** How a HEAD read reaches the worktree: over an ssh alias, or locally. */
export type RecordedHeadRoute =
  | { readonly route: 'ssh'; readonly alias: string }
  | { readonly route: 'local' };

/**
 * H9b2: the recorded transport decides local-versus-remote git reads. The
 * executor resolved for the recorded host carries the decision — an
 * `SshExecutor` reads through its alias, a local executor reads locally.
 * The legacy `existsSync(worktreePath)` heuristic is no longer part of this
 * decision.
 */
export function headRouteForExecutor(executor: CommandExecutorPort): RecordedHeadRoute {
  return executor instanceof SshExecutor
    ? { route: 'ssh', alias: executor.sshHost }
    : { route: 'local' };
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
  /** The parsed installation the runtime was composed with, if any. */
  readonly installation?: FleetInstallation;
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
    readonly checkOwnerDecision: CheckOwnerDecisionUseCase;
    readonly ownerQuestionRepository: OwnerQuestionRepositoryAdapter;
    readonly askOwnerQuestion: AskOwnerQuestionUseCase;
    readonly answerOwnerQuestion: AnswerOwnerQuestionUseCase;
    readonly listOwnerQuestions: ListOwnerQuestionsUseCase;
    readonly readOwnerQuestion: ReadOwnerQuestionUseCase;
    readonly syncOneWayOwnerQuestions: SyncOneWayOwnerQuestionsUseCase;
    readonly expireOwnerQuestions: ExpireOwnerQuestionsUseCase;
    readonly acknowledgeOwnerAnswer: AcknowledgeOwnerAnswerUseCase;
  };
  readonly knowledge: {
    readonly knowledgeEntryRepository: KnowledgeEntryRepositoryAdapter;
    readonly claimVerification: ClaimVerificationAdapter;
    readonly keeperPublication: KeeperPublicationAdapter;
    readonly knowledgeRetrieval: KnowledgeRetrievalAdapter;
    readonly captureCompletedAttemptNotes: CaptureCompletedAttemptNotesUseCase;
    readonly checkKnowledgeClaim: CheckKnowledgeClaimUseCase;
    readonly decideKnowledgeDisposition: DecideKnowledgeDispositionUseCase;
    readonly listCandidateClaims: ListCandidateClaimsUseCase;
    readonly publishAcceptedKeeper: PublishAcceptedKeeperUseCase;
    readonly proposeBriefContext: ProposeBriefContextUseCase;
    readonly recordContextSelection: RecordContextSelectionUseCase;
    /**
     * The decision receipt journal (K4): selections join their ranking
     * outcome through it and `decisions report` reads it. Unconfigured
     * without a state dir — nothing was ever reserved or settled there.
     */
    readonly decisionReceiptJournal: DecisionReceiptJournalPort;
    readonly recordKnowledgeReuse: RecordKnowledgeReuseUseCase;
    readonly supersedeKnowledgeEntry: SupersedeKnowledgeEntryUseCase;
  };
  readonly evidence: {
    readonly evidenceAssessmentRepository: EvidenceAssessmentRepositoryAdapter;
    readonly evidenceArchive: EvidenceArchiveAdapter;
    readonly verificationExecutor: VerificationExecutorAdapter;
    readonly independentReview: IndependentReviewAdapter;
    readonly forgeEvidence: ForgeEvidenceAdapter;
    readonly ownerDecision: OwnerDecisionAdapter;
    readonly attemptOwnerDecision: AttemptOwnerDecisionAdapter;
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
    /** H9b1: resolves the runner for an attempt's recorded host. */
    readonly runnerForAttempt: RunnerForAttemptAdapter;
    /**
     * The installation's selected lane-runner host (v2 mode); undefined for
     * a v1 or absent installation, which keeps the adapter in legacy mode.
     */
    readonly runnerHost?: ExecutionRunnerHost;
    /** The runner entry's declared lane budget; undefined without one. */
    readonly runnerMaxLanes?: number;
    readonly attemptArtifact: AttemptArtifactAdapter;
    /** S3: reads an attempt's opencode session usage on its recorded host. */
    readonly opencodeDbUsage: OpencodeDbUsageAdapter;
    readonly briefAuthoring: BriefAuthoringAdapter;
    readonly acceptanceAssessment: AcceptanceAssessmentAdapter;
    readonly acceptanceEvidence: AcceptanceEvidenceAdapter;
    readonly actionAuthorization: ActionAuthorizationAdapter;
    readonly briefKnowledge: BriefKnowledgeAdapter;
    readonly executionObservation: ExecutionObservationAdapter;
    readonly forgeAction: ForgeActionAdapter;
    readonly registerWorkOrder: RegisterWorkOrderUseCase;
    readonly inspectWorkOrder: InspectWorkOrderUseCase;
    readonly inspectAttempt: InspectAttemptUseCase;
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
  // Resolution precedence: options.<x> ?? installation.<x> ?? <env read>.
  // A blank env value is treated as absent rather than as "".
  const {
    worktreeSshHost,
    runnerRemotePort,
    ocmRunBin,
    runnerRemoteHost,
  } = resolveRunnerSettings(options);
  // an invalid installation throws here, never runs
  const installationModel = options?.installation
    ? requireValidInstallationModel(options.installation)
    : undefined;
  const runnerProfile = resolveRunnerCapabilityProfile(installationModel?.hosts);
  const forgeMode = resolveInstallationForgeMode(options?.installation);
  // The installation's selected lane-runner host (v2): its presence routes the
  // runner from the host entry and ignores the routing environment (plan
  // section 3). Undefined for v1 and absent installations keeps legacy mode.
  const runnerHost = resolveExecutionRunnerHost(options?.installation);
  // One executor per role: the installation's hosts (v2) or the v1 mapping
  // decides local versus ssh per host; the orchestrator runs where this root
  // runs. runnerRemoteHost/ocmRunBin stay runner settings, separate from the
  // worktree executor's host. For v2 the worktreeSshHost override is never
  // set (resolveRunnerSettings drops it), so the hosts section decides alone.
  const roleExecutors = resolveRoleExecutors(options?.installation, {
    worktreeSshHost,
  });
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
  // Owner questions are their own aggregate beside the coordination requests,
  // persisted to `<stateDir>/owner-questions.json` and in-memory without a
  // stateDir. The clock is the composition root's alone: no request body ever
  // supplies the moment a question is asked, answered, expired or
  // acknowledged.
  const ownerQuestionRepository = new OwnerQuestionRepositoryAdapter({ stateDir });
  const ownerQuestionClock: OwnerQuestionClock = { nowIso: () => new Date().toISOString() };

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
    // One-way doors are answered by the coordination request's own
    // authorization rule, through the application layer: the evidence context
    // never reads this repository directly.
    checkOwnerDecision: new CheckOwnerDecisionUseCase({
      requestRepo: coordinationRequestRepository,
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
    // Owner questions: two-way questions are answered through the answer use
    // case with `answeredVia 'cli'`; one-way questions are settled only by the
    // signed owner decision their linked request carries, read through the
    // same decision transport that verifies forge-time approvals. An answer
    // unblocks; it grants nothing and writes no coordination request.
    ownerQuestionRepository,
    askOwnerQuestion: new AskOwnerQuestionUseCase({
      ownerQuestionRepo: ownerQuestionRepository,
      requestRepo: coordinationRequestRepository,
      clock: ownerQuestionClock,
    }),
    answerOwnerQuestion: new AnswerOwnerQuestionUseCase({
      ownerQuestionRepo: ownerQuestionRepository,
      clock: ownerQuestionClock,
    }),
    listOwnerQuestions: new ListOwnerQuestionsUseCase({
      ownerQuestionRepo: ownerQuestionRepository,
    }),
    readOwnerQuestion: new ReadOwnerQuestionUseCase({
      ownerQuestionRepo: ownerQuestionRepository,
    }),
    syncOneWayOwnerQuestions: new SyncOneWayOwnerQuestionsUseCase({
      ownerQuestionRepo: ownerQuestionRepository,
      requestRepo: coordinationRequestRepository,
      decisionTransport,
      clock: ownerQuestionClock,
    }),
    expireOwnerQuestions: new ExpireOwnerQuestionsUseCase({
      ownerQuestionRepo: ownerQuestionRepository,
      clock: ownerQuestionClock,
    }),
    acknowledgeOwnerAnswer: new AcknowledgeOwnerAnswerUseCase({
      ownerQuestionRepo: ownerQuestionRepository,
      clock: ownerQuestionClock,
    }),
  };

  // --- brief-knowledge -------------------------------------------------------

  const knowledgeEntryRepository = new KnowledgeEntryRepositoryAdapter({ stateDir });
  // Bounded, allow-listed procedures only; the claim text is never interpreted.
  const claimVerification = new ClaimVerificationAdapter();
  const keeperPublication = new KeeperPublicationAdapter({ stateDir });
  const knowledgeRetrieval = new KnowledgeRetrievalAdapter();
  // Advisory only (decision port plan): the installation's v2 decisions block
  // (v1 files never carry one) drives an advice port that reorders the
  // deterministic retrieval set; with no block the advice port is null and the
  // inner result stands unchanged. Proposals flow through ProposeBriefContext
  // only; the key never enters argv, env or logs.
  const rankingAdvice = createRankingAdvice({
    ...(options?.installation?.decisions !== undefined
      ? { decisions: options.installation.decisions }
      : {}),
    ...(stateDir !== undefined ? { stateDir } : {}),
    fetch: options?.adviceFetch ?? globalThis.fetch,
    ...(options?.adviceReadKey !== undefined ? { readKey: options.adviceReadKey } : {}),
  });
  const advisedRetrieval = new AdvisedKnowledgeRetrievalAdapter(
    knowledgeRetrieval,
    rankingAdvice,
  );
  // Candidate-claim triage (K6): the same decisions block, key source and
  // receipt journal the ranking advice uses. The factory returns undefined
  // unless the block is enabled, a key source is declared, the claim-triage
  // consumer carries `acknowledgeCandidateClaimsLeaveHost: true` and a fetch
  // was injected — triage stays off otherwise and capture is unchanged.
  const claimTriage = createClaimTriage({
    ...(options?.installation?.decisions !== undefined
      ? { decisions: options.installation.decisions }
      : {}),
    ...(stateDir !== undefined ? { stateDir } : {}),
    fetch: options?.adviceFetch ?? globalThis.fetch,
    ...(options?.adviceReadKey !== undefined ? { readKey: options.adviceReadKey } : {}),
  });
  // The decision receipt journal (K4): the same `<stateDir>/decision-receipts`
  // store the ranking advice adapter writes. With no state dir nothing was
  // ever reserved or settled, so the unconfigured journal answers reads with
  // an empty snapshot and the selection outcome is skipped silently.
  const decisionReceiptJournal: DecisionReceiptJournalPort =
    stateDir === undefined || stateDir.trim().length === 0
      ? new NotConfiguredReceiptJournal()
      : new FileDecisionReceiptJournalAdapter(stateDir);

  const knowledge = {
    knowledgeEntryRepository,
    claimVerification,
    keeperPublication,
    knowledgeRetrieval,
    captureCompletedAttemptNotes: new CaptureCompletedAttemptNotesUseCase({
      repo: knowledgeEntryRepository,
      ...(claimTriage !== undefined ? { triage: claimTriage } : {}),
    }),
    checkKnowledgeClaim: new CheckKnowledgeClaimUseCase({
      repo: knowledgeEntryRepository,
      verifier: claimVerification,
    }),
    decideKnowledgeDisposition: new DecideKnowledgeDispositionUseCase({
      repo: knowledgeEntryRepository,
    }),
    listCandidateClaims: new ListCandidateClaimsUseCase({
      repo: knowledgeEntryRepository,
    }),
    publishAcceptedKeeper: new PublishAcceptedKeeperUseCase({
      repo: knowledgeEntryRepository,
      publisher: keeperPublication,
    }),
    proposeBriefContext: new ProposeBriefContextUseCase({
      repo: knowledgeEntryRepository,
      retrieval: advisedRetrieval,
    }),
    recordContextSelection: new RecordContextSelectionUseCase({
      repo: knowledgeEntryRepository,
      // The selection outcome joins the ranking receipt the proposals named
      // (K4); best effort by contract, never failing the recording.
      journal: decisionReceiptJournal,
    }),
    recordKnowledgeReuse: new RecordKnowledgeReuseUseCase({ repo: knowledgeEntryRepository }),
    supersedeKnowledgeEntry: new SupersedeKnowledgeEntryUseCase({ repo: knowledgeEntryRepository }),
    decisionReceiptJournal,
  };

  // --- evidence-and-acceptance ------------------------------------------------

  const evidenceAssessmentRepository = new EvidenceAssessmentRepositoryAdapter({ stateDir });
  const evidenceArchive = new EvidenceArchiveAdapter({
    archiveDir: stateDir === undefined ? undefined : join(stateDir, 'evidence-archive'),
  });
  // The verification executor runs only allow-listed procedures, locally or
  // over the verifier role's ssh transport; with no installation (and so no
  // allow-list) executed checks report `unknown` until a receipt is recorded
  // by the operator.
  const verificationExecutor = new VerificationExecutorAdapter({
    executor: roleExecutors.verifier,
    allowListedCommands: options?.installation?.verification?.procedures,
  });
  // No independent review transport is configured; requests report that.
  const independentReview = new IndependentReviewAdapter();
  // Free-seat flag (F5): a structural subset of the derived model; absent
  // installation or flag means allowed.
  const seatPolicy = new EvidenceSeatPolicyAdapter({
    useFreeSeats: installationModel?.policy?.useFreeSeats,
    seats: installationModel?.seats,
  });
  // Instantiated for the station that binds a live forge transport. With
  // forge mode `github` (D6) it is bound to AssessHeadAcceptanceUseCase with
  // the installation's owner/repo; with mode `none` acceptance is
  // receipt-only and records `forgeEvidence: 'not-configured'`; with no forge
  // section the CLI keeps today's receipt-only behaviour.
  const forgeSection =
    installationModel?.forge !== undefined && 'mode' in installationModel.forge
      ? installationModel.forge
      : undefined;
  const forgeGithubSection =
    forgeSection?.mode === 'github' ? forgeSection : undefined;
  // The argument-array gh runner shared with the forge action adapter (D6):
  // mode `github` hands it to the forge-evidence adapter so reads can
  // succeed; tests inject a stub transport through the runtime options.
  const ghBinaryCandidates = options?.ghBinaryCandidates ?? GH_BINARY_CANDIDATES;
  const forgeGhRunner =
    options?.forgeGhRunner ??
    ((args: readonly string[]) => runGhSubprocess(args, ghBinaryCandidates));
  const forgeEvidence =
    forgeMode === 'github'
      ? new ForgeEvidenceAdapter({
          owner: forgeGithubSection?.owner,
          repo: forgeGithubSection?.repo,
          runGh: forgeGhRunner,
        })
      : new ForgeEvidenceAdapter();
  const ownerDecision = new OwnerDecisionAdapter({
    checkOwnerDecision: async (request) => {
      const result = await coordination.checkOwnerDecision.checkOwnerDecision({
        requestId: request.requestId,
        candidateHeadSha: request.candidateHeadSha,
      });
      return result.outcome === 'approved'
        ? { outcome: 'approved', decisionId: result.requestId }
        : result;
    },
  });
  // The doors an attempt must clear are read from its own record, which
  // dispatch wrote from the frozen brief package. The attempt lookup is
  // captured here and filled in once the work composition exists below.
  const attemptLookup: { inspectAttempt?: InspectAttemptUseCase } = {};
  const attemptOwnerDecision = new AttemptOwnerDecisionAdapter({
    readAttemptOwnerDecisionReferences: async (request) => {
      const inspectAttempt = attemptLookup.inspectAttempt;
      if (!inspectAttempt) {
        return {
          outcome: 'unknown',
          reason: 'The work context is not wired for attempt inspection',
        };
      }
      const inspection = await inspectAttempt.inspectAttempt({
        attemptId: request.attemptId,
      });
      if (inspection.outcome !== 'found') {
        return {
          outcome: 'unknown',
          reason: `No attempt is recorded for ${request.attemptId}`,
        };
      }
      const recorded = inspection.attempt.ownerDecisionReferences;
      if (recorded === undefined) {
        return {
          outcome: 'unknown',
          reason: `attempt ${request.attemptId} was recorded before owner decision references were frozen`,
        };
      }
      return { outcome: 'recorded', ownerDecisionReferences: recorded };
    },
  });

  const evidence = {
    evidenceAssessmentRepository,
    evidenceArchive,
    verificationExecutor,
    independentReview,
    forgeEvidence,
    ownerDecision,
    attemptOwnerDecision,
    requestVerification: new RequestVerificationUseCase({
      repo: evidenceAssessmentRepository,
      executor: verificationExecutor,
      archive: evidenceArchive,
    }),
    requestIndependentReview: new RequestIndependentReviewUseCase({
      repo: evidenceAssessmentRepository,
      reviewer: independentReview,
      archive: evidenceArchive,
      seatPolicy,
    }),
    recordVerificationReceipt: new RecordVerificationReceiptUseCase({
      repo: evidenceAssessmentRepository,
    }),
    recordReviewReceipt: new RecordReviewReceiptUseCase({
      repo: evidenceAssessmentRepository,
      seatPolicy,
    }),
    recordFindingDisposition: new RecordFindingDispositionUseCase({
      repo: evidenceAssessmentRepository,
    }),
    assessHeadAcceptance: new AssessHeadAcceptanceUseCase({
      repo: evidenceAssessmentRepository,
      // Forge mode `github` binds the forge-evidence port in this root too
      // (D6); mode `none` records receipt-only acceptance as not-configured.
      ...(forgeMode === 'github' ? { forgeEvidence } : {}),
      ...(forgeMode === 'none' ? { forgeMode: 'none' as const } : {}),
      ownerDecisionPort: ownerDecision,
      attemptOwnerDecisionPort: attemptOwnerDecision,
    }),
    inspectAcceptanceEvidence: new InspectAcceptanceEvidenceUseCase({
      repo: evidenceAssessmentRepository,
    }),
  };

  // --- work-execution ---------------------------------------------------------

  const workOrderRepository = new WorkOrderRepositoryAdapter({ stateDir });
  const attemptRepository = new AttemptRepositoryAdapter({ stateDir });
  const executionJournal = new ExecutionJournalAdapter({ stateDir });
  // H9b2: workspace and artifact reads for an attempt recorded on a named
  // host run through that recorded host's executor (the recorded host is the
  // truth); legacy records keep the worktree-role executor exactly as before.
  const executorForHost = new ExecutorForHost({
    hosts: options?.installation?.hosts,
    legacyExecutor: roleExecutors.worktree,
  });
  const workspace = new WorkspaceAdapter({
    executor: roleExecutors.worktree,
    executorForRecordedHost: (recorded) => executorForHost.executorForRecordedHost(recorded),
  });
  // Wraps the reviewed `ocm-run` runner subprocess. The bundled repository
  // script is the default; the worktree locator is resolved from the recorded
  // attempt so a later CLI process (reconcile, stop, collect) addresses the
  // same directory the dispatch used.
  const runner = new ExecutionRunnerAdapter({
    ocmRunBin,
    remotePort: runnerRemotePort,
    remoteHost: runnerRemoteHost,
    // A v2 installation routes the runner from its selected lane-runner host;
    // the host's presence switches the adapter to v2 mode (no env fallbacks,
    // OCM_HOST/OCM_REMOTE_PORT/OPENCODE_AUTH_FILE set from the host alone).
    ...(runnerHost !== undefined ? { host: runnerHost } : {}),
    executor: roleExecutors.orchestrator,
    runSubprocess: options?.runSubprocess,
    // The capability report comes from the installation's lane-runner entry
    // with the loader-derived source (D4); the transport trims the runner
    // environment on a single machine (D5).
    ...(runnerProfile !== undefined ? { capabilities: runnerProfile.capabilities } : {}),
    ...(runnerProfile !== undefined ? { runnerTransport: runnerProfile.transport } : {}),
    resolveWorktreePath: async (attemptId) =>
      (await attemptRepository.findAttemptById(attemptId))?.worktreePath ?? null,
    resolveAttempt: async (attemptId) =>
      await attemptRepository.findAttemptById(attemptId),
  });
  // H9b1: inspect, reconcile, stop and collect act through the attempt's
  // recorded host. One adapter per host name is built and cached from the
  // installation's hosts with the same options as the single runner above;
  // legacy attempts (no recorded hostName) keep this single runner.
  const runnerForAttempt = new RunnerForAttemptAdapter({
    hosts: options?.installation?.hosts,
    legacyRunner: runner,
    ocmRunBin,
    executor: roleExecutors.orchestrator,
    runSubprocess: options?.runSubprocess,
    ...(runnerProfile !== undefined ? { capabilities: runnerProfile.capabilities } : {}),
    ...(runnerProfile !== undefined ? { runnerTransport: runnerProfile.transport } : {}),
    resolveWorktreePath: async (attemptId) =>
      (await attemptRepository.findAttemptById(attemptId))?.worktreePath ?? null,
    resolveAttempt: async (attemptId) =>
      await attemptRepository.findAttemptById(attemptId),
  });
  const attemptArtifact = new AttemptArtifactAdapter({
    executor: roleExecutors.worktree,
    executorForRecordedHost: (recorded) => executorForHost.executorForRecordedHost(recorded),
  });
  // S3: the usage read runs on the attempt's recorded runner host through the
  // same recorded-host executor the artifact read uses; a recorded host that
  // changed or was removed refuses (throws), which the adapter reports as
  // `unavailable`.
  const opencodeDbUsage = new OpencodeDbUsageAdapter({
    executorForRecordedHost: (attempt) => {
      const resolved = executorForHost.executorForRecordedHost(attempt.runner ?? null);
      if (!resolved.ok) {
        throw new Error(resolved.reason);
      }
      return resolved.executor;
    },
    nodeBin: process.env.FLEET_USAGE_NODE_BIN?.trim() || undefined,
  });
  // Hand-written brief files arrive per request; no default prose is assumed.
  const briefAuthoring = new BriefAuthoringAdapter();
  // The reviewed GitHub CLI subprocess behind a host-side delegate; every
  // invocation first verifies the live HEAD of the attempt's own worktree so
  // a moved branch head is never pushed or merged on stale readiness.
  const forgeAction = new ForgeActionAdapter({
    runGh: (args: readonly string[]) => runGhSubprocess(args, ghBinaryCandidates),
    verifyCurrentHeadSha: async (branchName, request) => {
      const attempt = await attemptRepository.findAttemptById(request.attemptId);
      if (attempt === null) {
        throw new Error(`No attempt is recorded for ${request.attemptId}`);
      }
      // H9b2: the recorded host is the truth. An attempt recorded on a named
      // host reads its HEAD and pushes from that host's transport — local
      // reads locally, an ssh host through its alias — and a host that
      // changed or was removed refuses, naming the recorded host. The
      // `existsSync(worktreePath)` heuristic stays behind the legacy branch
      // only (legacy records keep today's behaviour exactly).
      const recorded = attempt.runner ?? null;
      const recordedIsNamed = hasRecordedHostName(recorded);
      const recordedExecutor = recordedIsNamed
        ? executorForHost.executorForRecordedHost(recorded)
        : null;
      if (recordedExecutor !== null && !recordedExecutor.ok) {
        // A changed or removed host refuses, naming the recorded host.
        throw new Error(recordedExecutor.reason);
      }
      const recordedRoute =
        recordedExecutor !== null && recordedExecutor.ok
          ? headRouteForExecutor(recordedExecutor.executor)
          : null;
      const recordedSshAlias = recordedRoute?.route === 'ssh' ? recordedRoute.alias : null;
      const head =
        recordedRoute !== null
          ? recordedRoute.route === 'ssh'
            ? await readGitHeadOverSsh(attempt.worktreePath, recordedRoute.alias)
            : await readGitHeadLocally(attempt.worktreePath)
          : await readGitHead(attempt.worktreePath, worktreeSshHost);
      // A worktree that lives on another host has its branch only on that
      // host's repository; `gh pr create` needs the branch on origin, so the
      // verified head is fetched across and pushed before the PR is opened.
      const branchRef = `${head}:refs/heads/${branchName}`;
      const recordedWantsSeed =
        recordedIsNamed
          ? recordedSshAlias !== null ||
            process.env.FLEET_FORGE_PUSH_ORIGIN === '1'
          : null;
      const shouldSeedOrigin =
        request.kind === 'push-and-open-pr' &&
        head === request.expectedHeadSha &&
        (recordedWantsSeed !== null
          ? recordedWantsSeed
          : worktreeSshHost !== undefined ||
            process.env.FLEET_FORGE_PUSH_ORIGIN === '1');
      if (shouldSeedOrigin && recordedSshAlias !== null) {
        if (!isSafeSshHost(recordedSshAlias)) {
          throw new Error(
            `Refusing to fetch from unsafe SSH host: '${recordedSshAlias}'`,
          );
        }
        await runGitCommand([
          'fetch',
          `${recordedSshAlias}:${attempt.worktreePath}`,
          branchRef,
          '--force',
        ]);
        await runGitCommand(['push', '-f', 'origin', branchRef]);
      } else if (
        shouldSeedOrigin &&
        recordedIsNamed &&
        recordedSshAlias === null &&
        process.env.FLEET_FORGE_PUSH_ORIGIN === '1'
      ) {
        // A recorded local host: the worktree lives on this machine, so the
        // orchestrator fetches from the worktree path itself.
        await runGitCommand(['fetch', attempt.worktreePath, branchRef, '--force']);
        await runGitCommand(['push', '-f', 'origin', branchRef]);
      } else if (
        shouldSeedOrigin &&
        !recordedIsNamed &&
        worktreeSshHost !== undefined &&
        !existsSync(attempt.worktreePath)
      ) {
        // Legacy record: today's fetch across the configured worktree ssh
        // host, unchanged.
        if (!isSafeSshHost(worktreeSshHost)) {
          throw new Error(`Refusing to fetch from unsafe SSH host: '${worktreeSshHost}'`);
        }
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
      const assessmentId = assessmentIdForAttempt(request.attemptId);
      // Always delegate to the use case: it re-checks the attempt's one-way
      // doors before its idempotent accepted path, so a stored acceptance
      // whose owner decision has been withdrawn still blocks here.
      const result = await evidence.assessHeadAcceptance.assessHeadAcceptance({
        assessmentId,
        candidateHeadSha: request.candidateHeadSha,
        policyRevision: request.policyRevision,
      });
      if (result.outcome === 'accepted') {
        acceptedReceiptByHead[result.candidateHeadSha] = result.receiptId;
        if (acceptedReceiptsPath !== undefined) {
          await withFileLock(`${acceptedReceiptsPath}.lock`, async () => {
            const current = readJsonRecord<string>(acceptedReceiptsPath);
            current[result.candidateHeadSha] = result.receiptId;
            await writeJsonAtomically(acceptedReceiptsPath, current);
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

  const acceptanceEvidence = new AcceptanceEvidenceAdapter({
    readAcceptance: async (request) => {
      let inspected = await evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence({
        assessmentId: assessmentIdForAttempt(request.attemptId),
        candidateHeadSha: request.candidateHeadSha,
      });
      if (inspected.outcome === 'not-found') {
        inspected = await evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence({
          assessmentId: request.attemptId,
          candidateHeadSha: request.candidateHeadSha,
        });
      }
      // No head-only fallback: an assessment that is not bound to this attempt
      // is another attempt's evidence, and this attempt has none.
      if (
        inspected.outcome === 'found' &&
        inspected.assessment.attemptId !== request.attemptId
      ) {
        return {
          outcome: 'not-found',
          reason: `No acceptance assessment found for head ${request.candidateHeadSha}`,
        };
      }
      if (inspected.outcome === 'found') {
        return {
          outcome: 'found',
          assessment: {
            candidateHeadSha: inspected.assessment.candidateHeadSha,
            policyRevision: inspected.assessment.policyRevision,
            state: inspected.assessment.state,
            acceptanceReceiptId: inspected.assessment.acceptanceReceiptId,
          },
        };
      }
      return {
        outcome: 'not-found',
        reason: `No acceptance assessment found for head ${request.candidateHeadSha}`,
      };
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
          decisionBecause: selection.decisionBecause,
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
          await withFileLock(`${authorizationCoordinatesPath}.lock`, async () => {
            const current =
              readJsonRecord<AuthorizationCoordinates>(authorizationCoordinatesPath);
            current[result.grantId] = {
              attemptId: request.attemptId,
              expectedHeadSha: request.expectedHeadSha,
            };
            await writeJsonAtomically(authorizationCoordinatesPath, current);
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
      if (grant.actionScope !== forgeActionScope(request.actionKind)) {
        return {
          outcome: 'refused',
          reason: `Authorization grant ${request.authorizationGrantId} was recorded for scope ${grant.actionScope}, not ${forgeActionScope(request.actionKind)}`,
        };
      }
      if (grant.expectedHeadSha !== request.expectedHeadSha) {
        return {
          outcome: 'refused',
          reason: `Authorization grant ${request.authorizationGrantId} was recorded for head ${grant.expectedHeadSha}, not ${request.expectedHeadSha}`,
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
        boundAttempt !== null && boundAttempt.artifacts?.headCommit === request.expectedHeadSha
          ? boundAttempt
          : (await attemptRepository.listAllAttempts()).find(
              (candidate) => candidate.artifacts?.headCommit === request.expectedHeadSha,
            );
      if (attempt === undefined) {
        return {
          outcome: 'refused',
          reason:
            `No collected attempt matches the head recorded for grant ${request.authorizationGrantId}`,
        };
      }
      const result = await coordination.recordAuthorizationConsumption.recordAuthorizationConsumption({
        consumptionId: consumptionId(request.actionId),
        grantId: request.authorizationGrantId,
        actionId: request.actionId,
        actionScope: forgeActionScope(request.actionKind),
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
        eventKind: observationEventKind(request.entry.action, request.entry.status),
        sourceAttemptId: request.entry.attemptId,
        payloadSummary: JSON.stringify(request.entry),
      });
      return result.outcome === 'published'
        ? { outcome: 'published' }
        : { outcome: 'delivery-gap', reason: result.reason };
    },
  });

  // Free-seat policy (plan F3/F5): the adapter reads the installation's seat
  // catalogue and policy as a structural subset. A seat mapped from a v1 file
  // carries no cost class, so it stays out of the catalogue: with the flag
  // off it cannot be proven non-free and is refused as not in the catalogue.
  // An absent installation keeps the flag on (every seat allowed).
  const allowedSeats = new AllowedSeatAdapter({
    seats: (installationModel?.seats ?? []).flatMap((seat) =>
      seat.costClass === undefined
        ? []
        : [
            {
              id: seat.id,
              tool: seat.tool,
              model: seat.model,
              ...(seat.variant !== undefined ? { variant: seat.variant } : {}),
              costClass: seat.costClass,
            },
          ],
    ),
    policy: installationModel?.policy,
  });

  const execution = {
    workOrderRepository,
    attemptRepository,
    executionJournal,
    workspace,
    runner,
    runnerForAttempt,
    ...(runnerHost !== undefined ? { runnerHost } : {}),
    // The runner entry's lane budget (D4/D6 plan item 4); undefined without a
    // declared lane-runner entry, in which case the request default applies.
    runnerMaxLanes: runnerProfile?.maxLanes,
    attemptArtifact,
    opencodeDbUsage,
    briefAuthoring,
    acceptanceAssessment,
    acceptanceEvidence,
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
    inspectAttempt: new InspectAttemptUseCase({
      attemptRepo: attemptRepository,
      runnerForAttempt,
    }),
    prepareBriefPackage: new PrepareBriefPackageUseCase({
      briefAuthoring,
      artifactPort: attemptArtifact,
      briefKnowledge,
      computeDigest: sha256HexDigest,
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
      artifactPort: attemptArtifact,
      computeDigest: sha256HexDigest,
      allowedSeats,
    }),
    reconcileAttempt: new ReconcileAttemptUseCase({
      attemptRepo: attemptRepository,
      journal: executionJournal,
      runner,
      runnerForAttempt,
    }),
    stopAttempt: new StopAttemptUseCase({
      attemptRepo: attemptRepository,
      journal: executionJournal,
      runner,
      runnerForAttempt,
    }),
    collectAttemptArtifacts: new CollectAttemptArtifactsUseCase({
      attemptRepo: attemptRepository,
      journal: executionJournal,
      artifactPort: attemptArtifact,
      briefKnowledge,
      runnerForAttempt,
      usage: opencodeDbUsage,
    }),
    prepareFixAttempt: new PrepareFixAttemptUseCase({ attemptRepo: attemptRepository }),
    requestAttemptAcceptance: new RequestAttemptAcceptanceUseCase({
      attemptRepo: attemptRepository,
      workOrderRepo: workOrderRepository,
      acceptancePort: acceptanceAssessment,
      artifactPort: attemptArtifact,
      allowedSeats,
    }),
    executeAuthorizedForgeAction: new ExecuteAuthorizedForgeActionUseCase({
      attemptRepo: attemptRepository,
      workOrderRepo: workOrderRepository,
      journal: executionJournal,
      authorizationPort: actionAuthorization,
      forgePort: forgeAction,
      acceptedReceiptByHead: acceptedReceiptByHeadView,
      acceptanceEvidencePort: acceptanceEvidence,
      // Forge actions re-check the attempt's one-way doors through the same
      // owner-decision resolution acceptance uses.
      ownerDecisionPort: ownerDecision,
      attemptOwnerDecisionPort: attemptOwnerDecision,
      // Forge mode `none` (D6) refuses every forge action.
      ...(forgeMode === 'none' ? { forgeMode: 'none' as const } : {}),
    }),
  };

  attemptLookup.inspectAttempt = execution.inspectAttempt;

  return {
    installation: options?.installation,
    coordination,
    knowledge,
    evidence,
    execution,
  };
}
