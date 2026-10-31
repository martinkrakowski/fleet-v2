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

import { GH_BINARY_CANDIDATES, resolveGhBinary } from './gh-binary.js';
import { RunnerTunnelAdapter } from './runner-tunnel.js';
import { composeCoordination } from './composition/coordination.js';
import { composeKnowledge } from './composition/knowledge.js';
import { composeEvidence } from './composition/evidence.js';
import { composeExecutionHosts } from './composition/work-execution-hosts.js';
import { composeExecution } from './composition/work-execution.js';
import { composeConductor } from './composition/conductor.js';
import { composeTelemetry, type TelemetryConfiguredState, type TelemetryPolicyView } from './composition/telemetry.js';

import {
  AcceptanceAssessmentAdapter,
  AcceptanceEvidenceAdapter,
  ActionAuthorizationAdapter,
  AutoMergeAttemptUseCase,
  AttemptArtifactAdapter,
  AttemptRepositoryAdapter,
  BriefAuthoringAdapter,
  BriefKnowledgeAdapter,
  CiStateAdapter,
  CloseWorkOrderUseCase,
  GateReceiptAdapter,
  CollectAttemptArtifactsUseCase,
  CommitEditOnlyAttemptUseCase,
  ListStaleWorkOrdersUseCase,
  ConductorForgeGrantAdapter,
  DispatchAttemptUseCase,
  ExecuteAuthorizedForgeActionUseCase,
  ExecutionJournalAdapter,
  ExecutionObservationAdapter,
  ExecutionRunnerAdapter,
  ForgeActionAdapter,
  ForgeReadAdapter,
  InspectAttemptUseCase,
  InspectWorkOrderUseCase,
  LaneRunParkNoticeAdapter,
  ListUnregisteredProjectsUseCase,
  OpencodeApiUsageAdapter,
  PrepareBriefPackageUseCase,
  PrepareFixAttemptUseCase,
  CancelPreparedAttemptUseCase,
  ProbeProjectUseCase,
  ReconcileAttemptUseCase,
  RegisterWorkOrderUseCase,
  RequestAttemptAcceptanceUseCase,
  ReviewAssessmentAdapter,
  ReviewRequestAdapter,
  ReserveExecutionCapacityUseCase,
  RunnerForAttemptAdapter,
  SshExecutor,
  StopAttemptUseCase,
  WorkOrderRepositoryAdapter,
  WorkspaceAdapter,
  consumptionId,
  forgeActionScope,
  isSafeSshHost,
  observationEventKind,
  resolveExecutionRunnerHost,
  resolveInstallationForgeMode,
  resolveRoleExecutors,
  resolveRunnerCapabilityProfile,
  ConductorDriverLeaseAdapter,
  ConductorHaltAdapter,
  InspectLaneRunsUseCase,
  LaneRunJournalAdapter,
  LaneRunRepositoryAdapter,
  ReapLaneWorktreesUseCase,
  ReapOrphanSessionsUseCase,
  RequestLaneRunStopUseCase,
  ResumeLaneRunUseCase,
  type ProjectProfileReadPort,
  type AttemptRecord,
  type ExecutionRunnerHost,
  type EvaluateAttemptGatePort,
  type ForgeActionDelegate,
  type GhInvocationResult,
  type SubprocessRunner,
  type CommandExecutorPort,
  type AcceptanceReceiptReadAdapter,
  type ExportRunTelemetryUseCase,
  type TelemetryDispositionAdapter,
  type TelemetryResourceInput,
} from '@fleet/work-execution';

import {
  AssessHeadAcceptanceUseCase,
  AttemptOwnerDecisionAdapter,
  EvidenceArchiveAdapter,
  EvidenceAssessmentRepositoryAdapter,
  ForgeEvidenceAdapter,
  IndependentReviewAdapter,
  InspectAcceptanceEvidenceUseCase,
  InspectHeadCiStateUseCase,
  OpenEvidenceAssessmentUseCase,
  type OcmReviewTransportSpawn,
  OwnerDecisionAdapter,
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
  type DecisionReceiptJournalPort,
  KeeperPublicationAdapter,
  KnowledgeEntryRepositoryAdapter,
  KnowledgeRetrievalAdapter,
  ListCandidateClaimsUseCase,
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
  AttentionItemRepositoryAdapter,
  AttentionReadAdapter,
  ClearAttentionItemUseCase,
  ListAttentionItemsUseCase,
  CheckOwnerDecisionUseCase,
  CoordinationRequestRepositoryAdapter,
  DecisionTransportAdapter,
  ExpireOwnerQuestionsUseCase,
  InspectConfiguredCapabilitiesUseCase,
  InspectOutstandingCoordinationUseCase,
  InspectProjectProfileUseCase,
  ListOwnerQuestionsUseCase,
  ListProjectProfilesUseCase,
  ObservationPublicationAdapter,
  OwnerQuestionRepositoryAdapter,
  ProjectProfileRepositoryAdapter,
  PublishProjectObservationUseCase,
  ReadOwnerQuestionUseCase,
  ReadProjectAttentionUseCase,
  RecordAttentionItemUseCase,
  RecordAuthorizationConsumptionUseCase,
  RecordProjectProbeUseCase,
  RecordRelayAcknowledgementUseCase,
  RegisterProjectProfileUseCase,
  RelayTransportAdapter,
  RequestScopedDecisionUseCase,
  ResolveActionAuthorizationUseCase,
  RetireProjectProfileUseCase,
  SendFleetRelayUseCase,
  SyncOneWayOwnerQuestionsUseCase,
  UpdateProjectProfileUseCase,
} from '@fleet/operator-coordination';
import {
  loadInstallation,
  requireValidInstallationModel,
  resolveTelemetryPolicy,
  type FleetInstallation,
  type FleetInstallationModel,
  type LoadResult,
} from '@fleet/installation';

export interface FleetCliRuntimeOptions {
  /** Directory for file-backed state; every store is in-memory when omitted. */
  readonly stateDir?: string;
  /** Parsed installation configuration. */
  readonly installation?: FleetInstallation;
  /**
   * Fresh installation loader for the auto-merge settings binding (AM5-3).
   * Defaults to the real `loadInstallation()`; tests inject a temp file.
   */
  readonly loadInstallationForAutoMerge?: () => LoadResult;
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
  /**
   * The runtime's own environment object (tests inject a record here).
   * Defaults to `process.env`. The runner tunnel reads `OCM_HOST` and
   * `OCM_REMOTE_PORT` from this object only, so a test runtime with an
   * environment without them never opens a tunnel even when the real process
   * environment carries the variables.
   */
  readonly env?: Record<string, string | undefined>;
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
  /** Spy transport for the review subprocess (tests only); production runs ocm-run. */
  readonly reviewSpawn?: OcmReviewTransportSpawn;
  /**
   * Gate used by auto-merge and the conductor (tests only); production
   * composes the gate predicates.
   */
  readonly attemptGate?: EvaluateAttemptGatePort;
  /**
   * Test-only delegate for the forge action's reviewed gh subprocess and the
   * live head read; production binds the reviewed gh subprocess and the live
   * head read.
   */
  readonly forgeActionDelegate?: Pick<ForgeActionDelegate, 'runGh' | 'verifyCurrentHeadSha'>;
}

/** The fields of a test-only forge delegate that were actually supplied; nothing else is overridden. */
function forgeActionOverrides(
  delegate: Pick<ForgeActionDelegate, 'runGh' | 'verifyCurrentHeadSha'> | undefined,
): Partial<Pick<ForgeActionDelegate, 'runGh' | 'verifyCurrentHeadSha'>> {
  return {
    ...(delegate?.runGh === undefined ? {} : { runGh: delegate.runGh }),
    ...(delegate?.verifyCurrentHeadSha === undefined ? {} : { verifyCurrentHeadSha: delegate.verifyCurrentHeadSha }),
  };
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

/**
 * KF-35: the runner tunnel's target. A v2 installation's selected lane-runner
 * host decides alone (an `ssh` host forwards to its alias and port; a `local`
 * host needs no tunnel); otherwise the resolved runner settings decide. A port
 * outside 1..65534 (the dial port is one above it) opens no tunnel.
 */
export function resolveRunnerTunnelTarget(
  runnerHost: ExecutionRunnerHost | undefined,
  settings: { readonly runnerRemoteHost?: string; readonly runnerRemotePort?: number },
): { readonly sshHost?: string; readonly remotePort?: number } {
  const usablePort = (port: number | null | undefined): number | undefined =>
    typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65534 ? port : undefined;
  if (runnerHost !== undefined) {
    if (runnerHost.transport !== 'ssh') {
      return {};
    }
    const remotePort = usablePort(runnerHost.remotePort);
    return {
      ...(runnerHost.sshAlias !== undefined ? { sshHost: runnerHost.sshAlias } : {}),
      ...(remotePort !== undefined ? { remotePort } : {}),
    };
  }
  const remotePort = usablePort(settings.runnerRemotePort);
  return {
    ...(settings.runnerRemoteHost !== undefined ? { sshHost: settings.runnerRemoteHost } : {}),
    ...(remotePort !== undefined ? { remotePort } : {}),
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
    readonly updateProjectProfile: UpdateProjectProfileUseCase;
    readonly retireProjectProfile: RetireProjectProfileUseCase;
    readonly listProjectProfiles: ListProjectProfilesUseCase;
    readonly inspectProjectProfile: InspectProjectProfileUseCase;
    readonly recordProjectProbe: RecordProjectProbeUseCase;
    readonly inspectConfiguredCapabilities: InspectConfiguredCapabilitiesUseCase;
    readonly requestScopedDecision: RequestScopedDecisionUseCase;
    readonly resolveActionAuthorization: ResolveActionAuthorizationUseCase;
    readonly recordAuthorizationConsumption: RecordAuthorizationConsumptionUseCase;
    readonly publishProjectObservation: PublishProjectObservationUseCase;
    readonly readProjectAttention: ReadProjectAttentionUseCase;
    readonly attentionItemRepository: AttentionItemRepositoryAdapter;
    readonly recordAttentionItem: RecordAttentionItemUseCase;
    readonly clearAttentionItem: ClearAttentionItemUseCase;
    readonly listAttentionItems: ListAttentionItemsUseCase;
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
    /** Opens the pending evidence assessment for a conductor review (K5-E2); K5-6 composes it. */
    readonly openEvidenceAssessment: OpenEvidenceAssessmentUseCase;
    readonly recordVerificationReceipt: RecordVerificationReceiptUseCase;
    readonly recordReviewReceipt: RecordReviewReceiptUseCase;
    readonly recordFindingDisposition: RecordFindingDispositionUseCase;
    readonly assessHeadAcceptance: AssessHeadAcceptanceUseCase;
    readonly inspectAcceptanceEvidence: InspectAcceptanceEvidenceUseCase;
    /** CI per exact head (PC); K6 composes it. */
    readonly inspectHeadCiState: InspectHeadCiStateUseCase;
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
    /** KF-15b: reads an attempt's opencode session usage from the server that ran it. */
    readonly opencodeUsage: OpencodeApiUsageAdapter;
    readonly briefAuthoring: BriefAuthoringAdapter;
    readonly acceptanceAssessment: AcceptanceAssessmentAdapter;
    readonly acceptanceEvidence: AcceptanceEvidenceAdapter;
    readonly actionAuthorization: ActionAuthorizationAdapter;
    readonly briefKnowledge: BriefKnowledgeAdapter;
    readonly executionObservation: ExecutionObservationAdapter;
    readonly forgeAction: ForgeActionAdapter;
    /** Read-only PR state (AM4b-2); bound in forge mode `github` only. */
    readonly forgeRead: ForgeReadAdapter;
    readonly registerWorkOrder: RegisterWorkOrderUseCase;
    readonly inspectWorkOrder: InspectWorkOrderUseCase;
    /** KF-36b-1b: the operator's close command; built after the conductor composes its lane-run stores. */
    readonly closeWorkOrder: CloseWorkOrderUseCase;
    /** KF-36b-2: the read-only stale work-order listing; built beside closeWorkOrder from the same stores. */
    readonly listStaleWorkOrders: ListStaleWorkOrdersUseCase;
    readonly inspectAttempt: InspectAttemptUseCase;
    readonly prepareBriefPackage: PrepareBriefPackageUseCase;
    readonly reserveExecutionCapacity: ReserveExecutionCapacityUseCase;
    readonly dispatchAttempt: DispatchAttemptUseCase;
    /** AG-5: the edit-only commit step for a recorded agy edit-only attempt. */
    readonly commitEditOnlyAttempt: CommitEditOnlyAttemptUseCase;
    readonly reconcileAttempt: ReconcileAttemptUseCase;
    readonly stopAttempt: StopAttemptUseCase;
    readonly collectAttemptArtifacts: CollectAttemptArtifactsUseCase;
    readonly prepareFixAttempt: PrepareFixAttemptUseCase;
    /** EX-1a: the operator's record-only cancel for a prepared, never-dispatched attempt. */
    readonly cancelPreparedAttempt: CancelPreparedAttemptUseCase;
    readonly requestAttemptAcceptance: RequestAttemptAcceptanceUseCase;
    readonly attemptGate: RequestAttemptAcceptanceUseCase;
    readonly executeAuthorizedForgeAction: ExecuteAuthorizedForgeActionUseCase;
    readonly autoMergeAttempt: AutoMergeAttemptUseCase;
    readonly probeProject: ProbeProjectUseCase;
    readonly listUnregisteredProjects: ListUnregisteredProjectsUseCase;
  };
  readonly conductor: {
    readonly laneRunRepository: LaneRunRepositoryAdapter;
    readonly laneRunJournal: LaneRunJournalAdapter;
    readonly driverLease: ConductorDriverLeaseAdapter;
    readonly halt: ConductorHaltAdapter;
    readonly requestLaneRunStop: RequestLaneRunStopUseCase;
    readonly inspectLaneRuns: InspectLaneRunsUseCase;
    readonly resumeLaneRun: ResumeLaneRunUseCase;
    /** EX-2b: the operator-opt-in worktree reap (conductor reap --worktrees). */
    readonly reapLaneWorktrees: ReapLaneWorktreesUseCase;
    /** EX-4: the operator-opt-in orphan-session reap (conductor reap --sessions). */
    readonly reapOrphanSessions: ReapOrphanSessionsUseCase;
    /** A fresh ULID per call (journal entry ids, run and attempt ids). */
    readonly newUlid: () => string;
    /** The project profile read the root already builds; exposed for `conductor start` (K7-7). */
    readonly profileRead: ProjectProfileReadPort;
    /** The review step's port (PC); K5 composes it into the advance. */
    readonly reviewRequest: ReviewRequestAdapter;
    /** Opens the evidence assessment before a conductor review (K5-3); K5-6 composes it into the advance. */
    readonly reviewAssessment: ReviewAssessmentAdapter;
    /** The conducted gate's verification receipts, one per acceptance check (KF-13). */
    readonly gateReceipts: GateReceiptAdapter;
    /** CI per exact head (PC); K6 composes it. */
    readonly ciState: CiStateAdapter;
    /** The conductor's own push grant issuer (K6-2); K6-8 composes it into the advance. */
    readonly conductorForgeGrant: ConductorForgeGrantAdapter;
    /** Raises park attention items and keyed owner questions (K6-3); K6-8 composes it into the advance. */
    readonly parkNotice: LaneRunParkNoticeAdapter;
    /** The auto-merge setting read once at composition; a toggle takes a restart (K6-8). */
    readonly autoMergeEnabled: boolean;
  };
  /**
   * KF-35: the runner tunnel the conductor driver holds for its lifetime,
   * resolved from the runtime's own environment object's `OCM_HOST` and
   * `OCM_REMOTE_PORT`. Absent values mean the driver opens nothing.
   */
  readonly runnerTunnel: RunnerTunnelAdapter;
  readonly telemetry: {
    /** Telemetry's own read-only receipt read (OT2b); OT2c/OT4b consume it. */
    readonly acceptanceReceiptRead: AcceptanceReceiptReadAdapter;
    /** The telemetry disposition store (OT4b); the export writes only here. */
    readonly dispositions: TelemetryDispositionAdapter;
    /** The export use case; null without an installation salt (dry runs need no endpoint). */
    readonly exportTelemetry: ExportRunTelemetryUseCase | null;
    /** Whether telemetry is configured; a fixed code, never the endpoint/token/salt. */
    readonly configured: TelemetryConfiguredState;
    /** Fingerprint of the installation salt (first 8 hex), or null without one. */
    readonly saltFingerprint: string | null;
    /** The resolved telemetry policy without its salt (the salt never leaves the composer). */
    readonly policy: TelemetryPolicyView;
    /** The OTLP resource input for dry-run encoding (plan §3.2); frozen. */
    readonly resource: TelemetryResourceInput;
    /** The redaction canary values of the real state directory's records (OT4b-3). */
    readonly canaryValues: () => Promise<readonly string[]>;
  };
}

/**
 * The first lane-runner host whose runner is agy, by installation key order;
 * undefined when none (AG-5). Dispatch gets one agy runner only: dispatching
 * across several agy hosts needs the per-reservation runner of H9b/H10.
 */
function agyLaneRunnerHostOf(
  hosts: FleetInstallationModel['hosts'] | undefined,
): { readonly name: string; readonly mode: 'edit-only' | 'full'; readonly sshAlias?: string } | undefined {
  if (hosts === undefined) return undefined;
  for (const [name, host] of Object.entries(hosts)) {
    if (!host.roles.includes('lane-runner')) continue;
    if (host.runner?.kind !== 'agy') continue;
    return {
      name,
      mode: host.runner.agyMode,
      ...(host.transport === 'ssh' && host.sshAlias !== undefined
        ? { sshAlias: host.sshAlias }
        : {}),
    };
  }
  return undefined;
}

/**
 * The recorded host's agy mode (D7): edit-only commits here; full and opencode
 * lanes commit themselves. Unknown when the attempt is not recorded on a
 * current agy lane-runner host.
 */
function editOnlyModeOf(
  attempt: AttemptRecord,
  hosts: FleetInstallationModel['hosts'] | undefined,
): 'edit-only' | 'not-edit-only' | 'unknown' {
  if (attempt.runner?.kind !== 'agy') return 'not-edit-only';
  const hostName = attempt.runner.hostName?.trim();
  if (hostName === undefined || hostName === '') return 'unknown';
  const host = hosts?.[hostName];
  if (host === undefined || host.runner?.kind !== 'agy') return 'unknown';
  return host.runner.agyMode === 'edit-only' ? 'edit-only' : 'not-edit-only';
}

export function createFleetCliRuntime(options?: FleetCliRuntimeOptions): FleetCliRuntime {
  const stateDir = options?.stateDir;
  // AM5-3: the auto-merge settings binding re-reads a fresh installation on
  // every call (A7); tests inject a loader over a temp file.
  const autoMergeLoad = options?.loadInstallationForAutoMerge ?? (() => loadInstallation());

  // --- live runner / worktree host configuration -----------------------------
  // Resolution precedence: options.<x> ?? installation.<x> ?? <env read>.
  // A blank env value is treated as absent rather than as "".
  const {
    worktreeSshHost,
    runnerRemotePort,
    ocmRunBin,
    runnerRemoteHost,
  } = resolveRunnerSettings(options, undefined, options?.env ?? process.env);
  // an invalid installation throws here, never runs
  const installationModel = options?.installation
    ? requireValidInstallationModel(options.installation)
    : undefined;
  const runnerProfile = resolveRunnerCapabilityProfile(installationModel?.hosts);
  // AG-5: the installation's agy lane-runner host (first by key order), if any.
  const agyHost = agyLaneRunnerHostOf(installationModel?.hosts);
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

  const {
    coordination,
    coordinationRequestRepository,
    issuePolicyForgeGrantUseCase,
    profileRead,
    probeRecord,
    executorForHostName,
  } = composeCoordination({ stateDir, ownerPublicKey, options });

  const { knowledge } = composeKnowledge({ stateDir, options });

  const {
    evidence,
    reviewLocatorRef,
    attemptLookup,
    forgeRead,
    ghBinaryCandidates,
    forgeGithubSection,
    ownerDecision,
    attemptOwnerDecision,
  } = composeEvidence({
    stateDir,
    roleExecutors,
    options,
    installationModel,
    ocmRunBin,
    forgeMode,
    coordination,
    runGhSubprocess,
  });

  const {
    workOrderRepository,
    attemptRepository,
    executionJournal,
    executorForHost,
    workspace,
    runner,
    runnerForAttempt,
    agyRunner,
    runnerSelector,
    attemptArtifact,
    opencodeUsage,
    briefAuthoring,
    forgeAction,
  } = composeExecutionHosts({
    stateDir,
    options,
    roleExecutors,
    reviewLocatorRef,
    runnerRemotePort,
    runnerRemoteHost,
    ocmRunBin,
    runnerHost,
    runnerProfile,
    executorForHostName,
    agyHost,
    installationModel,
    runGhSubprocess,
    ghBinaryCandidates,
    forgeRead,
    forgeGithubSection,
    worktreeSshHost,
    forgeActionOverrides,
    readGitHeadOverSsh,
    readGitHeadLocally,
    readGitHead,
    headRouteForExecutor,
    runGitCommand,
  });

  const { execution } = composeExecution({
    stateDir,
    options,
    installationModel,
    runnerHost,
    runnerProfile,
    forgeMode,
    autoMergeLoad,
    evidence,
    knowledge,
    coordination,
    coordinationRequestRepository,
    ownerDecision,
    attemptOwnerDecision,
    attemptLookup,
    forgeRead,
    issuePolicyForgeGrantUseCase,
    profileRead,
    probeRecord,
    executorForHostName,
    workOrderRepository,
    attemptRepository,
    executionJournal,
    executorForHost,
    workspace,
    runner,
    runnerForAttempt,
    agyRunner,
    runnerSelector,
    attemptArtifact,
    opencodeUsage,
    briefAuthoring,
    forgeAction,
    editOnlyModeOf,
    readJsonRecord,
  });

  const { conductor } = composeConductor({
    stateDir,
    evidence,
    profileRead,
    coordination,
    issuePolicyForgeGrantUseCase,
    autoMergeLoad,
    installation: options?.installation,
    workOrderRepository,
    attemptRepository,
    executionJournal,
    workspace,
    runnerForAttempt,
  });

  // KF-36b-1b: the operator's close command is built here, after the
  // conductor composes its lane-run stores, because composeExecution holds no
  // lane-run stores of its own.
  const closeWorkOrder = new CloseWorkOrderUseCase({
    workOrderRepo: workOrderRepository,
    attemptRepo: attemptRepository,
    executionJournal,
    runRepo: conductor.laneRunRepository,
    runJournal: conductor.laneRunJournal,
  });

  // KF-36b-2: the read-only stale listing reads the same stores as the close,
  // so it is built beside it, after the conductor composes its lane-run stores.
  const listStaleWorkOrders = new ListStaleWorkOrdersUseCase({
    workOrderRepo: workOrderRepository,
    attemptRepo: attemptRepository,
    runRepo: conductor.laneRunRepository,
    runJournal: conductor.laneRunJournal,
  });

  const { telemetry } = composeTelemetry({
    stateDir,
    policy: resolveTelemetryPolicy(options?.installation?.policy),
    env: process.env,
  });

  // KF-35: the driver's one runner tunnel, aimed at the same target the runner
  // dispatches to: the installation's selected lane-runner host for v2, else the
  // resolved runner settings (which read the runtime's own environment object,
  // never the process environment when a test supplies one). Nothing is spawned
  // here; the conductor driver opens the forward before its first pass and stops
  // it in the same finally that releases its leases.
  const tunnelTarget = resolveRunnerTunnelTarget(runnerHost, { runnerRemoteHost, runnerRemotePort });
  const runnerTunnel = new RunnerTunnelAdapter(tunnelTarget);

  return {
    installation: options?.installation,
    coordination,
    knowledge,
    evidence,
    execution: { ...execution, closeWorkOrder, listStaleWorkOrders },
    conductor,
    runnerTunnel,
    telemetry,
  };
}
