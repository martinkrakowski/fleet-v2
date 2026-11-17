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
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

import { GH_BINARY_CANDIDATES, resolveGhBinary } from './gh-binary.js';
import { SSH_BINARY_CANDIDATES, resolveSshBinary } from './ssh-binary.js';
import { RunnerTunnelAdapter } from './runner-tunnel.js';
import { composeCoordination, DeferredAttemptFactsRead } from './composition/coordination.js';
import { composeReadOnlyRelaunch } from './composition/relaunch.js';
import { composeKnowledge } from './composition/knowledge.js';
import { composeEvidence } from './composition/evidence.js';
import { composeExecutionHosts } from './composition/work-execution-hosts.js';
import { composeExecution } from './composition/work-execution.js';
import { composeConductor } from './composition/conductor.js';
import { composeDaemon, type ComposedDaemon } from './composition/daemon.js';
import { composeTelemetry, type TelemetryConfiguredState, type TelemetryPolicyView } from './composition/telemetry.js';

import {
  AcceptanceAssessmentAdapter,
  AcceptanceEvidenceAdapter,
  ActionAuthorizationAdapter,
  AutoMergeAttemptUseCase,
  AttemptArtifactAdapter,
  AttemptRepositoryAdapter,
  AuthorBriefUseCase,
  BriefAuthoringAdapter,
  BriefKnowledgeAdapter,
  BuildFactPackUseCase,
  CiStateAdapter,
  CloseWorkOrderUseCase,
  CutoverJournalAdapter,
  CutoverRecordRepositoryAdapter,
  DaemonPauseAdapter,
  KillallTrainPauseAdapter,
  ManageCutoverUseCase,
  GateReceiptAdapter,
  CollectAttemptArtifactsUseCase,
  CommitEditOnlyAttemptUseCase,
  ListHeldWorkOrdersUseCase,
  ListStaleWorkOrdersUseCase,
  ConductorForgeGrantAdapter,
  DispatchAttemptUseCase,
  ExecuteAuthorizedForgeActionUseCase,
  ExplainAttemptUseCase,
  ExportLegacyTrainStateUseCase,
  ExecutionJournalAdapter,
  ExecutionObservationAdapter,
  ExecutionRunnerAdapter,
  ForgeActionAdapter,
  MergeGrantAdapter,
  MergeRecordRepositoryAdapter,
  ForgeReadAdapter,
  GhForgeMergeReadAdapter,
  GhReviewThreadHelperAdapter,
  type ReviewThreadHelperPort,
  InspectAttemptUseCase,
  InspectMergeReadinessUseCase,
  InspectWorkOrderUseCase,
  InventoryRelaunchUseCase,
  PlanRelaunchUseCase,
  RelaunchPlanRepositoryAdapter,
  LaneRunParkNoticeAdapter,
  ListUnregisteredProjectsUseCase,
  OpencodeApiUsageAdapter,
  PrepareBriefPackageUseCase,
  PreparePullRequestFeedbackFixUseCase,
  PrepareFixAttemptUseCase,
  CancelPreparedAttemptUseCase,
  ProbeProjectUseCase,
  PullRequestFindingsReadAdapter,
  ReconcileAttemptUseCase,
  RegisterWorkOrderUseCase,
  RepositoryFactsAdapter,
  RequestAttemptAcceptanceUseCase,
  ReviewAssessmentAdapter,
  ReviewRequestAdapter,
  ReserveExecutionCapacityUseCase,
  RunnerForAttemptAdapter,
  SshExecutor,
  StopAttemptUseCase,
  WorkOrderRepositoryAdapter,
  WorkspaceAdapter,
  composeCutoverShadowEvidence,
  consumptionId,
  forgeActionScope,
  isSafeSshHost,
  mergeQueueRepositoryDigest,
  observationEventKind,
  resolveExecutionRunnerHost,
  resolveInstallationForgeMode,
  resolveRoleExecutors,
  resolveRunnerCapabilityProfile,
  sha256HexDigest,
  ConductorDriverLeaseAdapter,
  ConductorHaltAdapter,
  InspectLaneRunsUseCase,
  LaneRunJournalAdapter,
  LaneRunRepositoryAdapter,
  ListConductorPassesUseCase,
  ListLaneRunsUseCase,
  RecordShadowDayUseCase,
  ShadowEvidenceAdapter,
  WORK_EXECUTION_STATE_FILES,
  ReapLaneWorktreesUseCase,
  ReapOrphanReservationsUseCase,
  ReapOrphanSessionsUseCase,
  ReapZombiesUseCase,
  ReaperFindingRepositoryAdapter,
  InMemoryReaperFindingRepositoryAdapter,
  RequestLaneRunStopUseCase,
  ResumeLaneRunUseCase,
  type ProjectProfileReadPort,
  type AttemptRecord,
  type ExecutionRunnerHost,
  type EvaluateAttemptGatePort,
  type EnqueueMergeUseCase,
  type ListMergeQueueUseCase,
  type ImportTrainStateUseCase,
  type LegacyTrainStateReadAdapter,
  type MergeQueueRepositoryAdapter,
  type ForgeActionDelegate,
  type GhInvocationResult,
  type SubprocessRunner,
  type CommandExecutorPort,
  type AcceptanceReceiptReadAdapter,
  type GateFailingFileAdapter,
  type ListStalledRunsUseCase,
  type StallAttentionAdapter,
  type ExportRunTelemetryUseCase,
  type TelemetryDispositionAdapter,
  type TelemetryResourceInput,
  type RunTelemetryMarkPort,
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
  EVIDENCE_AND_ACCEPTANCE_STATE_FILES,
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
  BRIEF_KNOWLEDGE_STATE_FILES,
} from '@fleet/brief-knowledge';

import {
  AcknowledgeOwnerAnswerUseCase,
  AnswerOwnerQuestionUseCase,
  AskOwnerQuestionUseCase,
  AttentionItemRepositoryAdapter,
  AttentionReadAdapter,
  ClearAttentionItemUseCase,
  ListAttentionItemsUseCase,
  ListOwnerItemsUseCase,
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
  OrchestratorSessionRepositoryAdapter,
  OwnerQuestionRepositoryAdapter,
  ProjectProfileRepositoryAdapter,
  PublishProjectObservationUseCase,
  ReadOwnerQuestionUseCase,
  ReadProjectAttentionUseCase,
  RecordAttentionItemUseCase,
  RecordAuthorizationConsumptionUseCase,
  RecordOwnerItemUseCase,
  RecordProjectProbeUseCase,
  RecordRelayAcknowledgementUseCase,
  RegisterProjectProfileUseCase,
  RelayTransportAdapter,
  RequestScopedDecisionUseCase,
  ResolveActionAuthorizationUseCase,
  ResolveOwnerItemUseCase,
  RetireProjectProfileUseCase,
  SendFleetRelayUseCase,
  SyncOneWayOwnerQuestionsUseCase,
  UpdateProjectProfileUseCase,
  OPERATOR_COORDINATION_STATE_FILES,
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
  /**
   * Fresh installation loader for the daemon's merge-policy binding (DT10b).
   * Takes precedence over `installation`; tests inject a temp file and the
   * `daemon` command injects an already-loaded (possibly invalid) result.
   */
  readonly loadInstallationForMergePolicy?: () => LoadResult;
  /** The daemon clock (tests only); production reads the system clock. */
  readonly daemonNow?: () => string;
  /** The daemon wake-settle sleep (tests only); production waits with a timer. */
  readonly daemonSleep?: (ms: number) => Promise<void>;
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
  readonly forgeGhRunner?: (
    args: readonly string[],
    timeoutMs?: number,
  ) => Promise<GhInvocationResult>;
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

/** Whether `path` is an executable regular file (S4036: absolute gh and ssh only). */
function isExecutableRegularFile(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Normal one-call timeout for a `gh` subprocess; the subprocess is killed on expiry. */
const GH_SUBPROCESS_TIMEOUT_MS = 30_000;

/**
 * Build the child environment for a GitHub CLI subprocess. When `env` sets
 * `GH_CONFIG_DIR`, ambient token credentials (which gh prefers over hosts.yml)
 * are stripped so the configured identity authenticates the child.
 */
export function buildGhChildEnvironment(
  ambient: NodeJS.ProcessEnv = process.env,
  env?: Record<string, string>,
): NodeJS.ProcessEnv | undefined {
  if (env === undefined) {
    return undefined;
  }
  const child: NodeJS.ProcessEnv = { ...ambient, ...env };
  if ('GH_CONFIG_DIR' in env) {
    delete child.GH_TOKEN;
    delete child.GITHUB_TOKEN;
    delete child.GH_ENTERPRISE_TOKEN;
    delete child.GITHUB_ENTERPRISE_TOKEN;
  }
  return child;
}

/**
 * Run the reviewed GitHub CLI subprocess for the forge adapter. The binary is
 * resolved from fixed absolute locations (S4036), never through PATH; when
 * none is found the invocation rejects so the adapter reports the forge as
 * unreadable (fail closed, as a missing binary does today). A completed
 * invocation resolves with its exit code and captured output; a spawn failure
 * rejects so the adapter reports the outcome as ambiguous for reconciliation
 * instead of guessing. `env` (when provided) is merged over the inherited
 * environment, with ambient tokens stripped when `GH_CONFIG_DIR` is set; the
 * value is never logged. A timeout that kills the subprocess also rejects: an
 * expired write may have reached the forge, so the adapters report it ambiguous,
 * never as proof of success.
 */
export function runGhSubprocess(
  args: readonly string[],
  candidates: readonly string[] = GH_BINARY_CANDIDATES,
  env?: Record<string, string>,
  timeoutMs?: number,
): Promise<GhInvocationResult> {
  const ghBinary = resolveGhBinary(candidates, isExecutableRegularFile);
  if (ghBinary === undefined) {
    return Promise.reject(new Error('gh not found in fixed locations'));
  }
  const executionOptions: {
    encoding: 'utf8';
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  } = { encoding: 'utf8', timeout: timeoutMs ?? GH_SUBPROCESS_TIMEOUT_MS };
  const childEnv = buildGhChildEnvironment(process.env, env);
  if (childEnv !== undefined) {
    executionOptions.env = childEnv;
  }
  return new Promise((resolve, reject) => {
    execFile(ghBinary, [...applyGhEnvironmentOverrides(args)], executionOptions, (error, stdout, stderr) => {
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

/**
 * Read HEAD through the reviewed ssh alias (a worktree on another host). The
 * login shell parses only `sh -c` plus one single-quoted string; the remote
 * argv is `['sh', '-c', <twice-quoted command line>], the twin of
 * `posixQuote` and `sshArgvFor` in
 * packages/work-execution/src/infrastructure/adapters/SshExecutor.adapter.ts.
 * The remote programs must stay PATH executables, not login-shell functions
 * or builtins specific to the login shell: the login shell starts first and
 * `sh` inherits only its exported environment. fish and csh are not
 * supported, before or after this change.
 */
export function readGitHeadOverSsh(
  worktreePath: string,
  sshHost: string,
  sshCandidates: readonly string[] = SSH_BINARY_CANDIDATES,
): Promise<string> {
  if (!isSafeSshHost(sshHost)) {
    return Promise.reject(new Error(`Refusing to read HEAD over SSH: unsafe host '${sshHost}'`));
  }
  if (worktreePath === '' || worktreePath.includes('\0')) {
    return Promise.reject(new Error('Refusing to read HEAD over SSH: unusable worktree path'));
  }
  const sshBinary = resolveSshBinary(sshCandidates, isExecutableRegularFile);
  if (sshBinary === undefined) {
    return Promise.reject(new Error('Refusing to read HEAD over SSH: ssh not found in fixed locations'));
  }
  const words = ['git', '-C', worktreePath, 'rev-parse', 'HEAD'];
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    sshHost,
    '--',
    'sh',
    '-c',
    posixQuote(words.map(posixQuote).join(' ')),
  ];
  return new Promise((resolve, reject) => {
    execFile(sshBinary, args, { encoding: 'utf8', timeout: 60_000 }, (error, stdout) => {
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
  /** DT10b: the daemon stores, tick and status use cases, pause port and forge probe. */
  readonly daemon: ComposedDaemon;
  readonly coordination: {
    readonly projectProfileRepository: ProjectProfileRepositoryAdapter;
    readonly coordinationRequestRepository: CoordinationRequestRepositoryAdapter;
    readonly orchestratorSessionRepository: OrchestratorSessionRepositoryAdapter;
    readonly decisionTransport: DecisionTransportAdapter;
    readonly observationPublication: ObservationPublicationAdapter;
    readonly relayTransport: RelayTransportAdapter;
    readonly attentionRead: AttentionReadAdapter;
    readonly registerProjectProfile: RegisterProjectProfileUseCase;
    readonly updateProjectProfile: UpdateProjectProfileUseCase;
    readonly retireProjectProfile: RetireProjectProfileUseCase;
    readonly listProjectProfiles: ListProjectProfilesUseCase;
    /** CO29a-ro2: the read-only profile listing the relaunch commands read. */
    readonly listProjectProfilesReadOnly: ListProjectProfilesUseCase;
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
    readonly recordOwnerItem: RecordOwnerItemUseCase;
    readonly listOwnerItems: ListOwnerItemsUseCase;
    readonly resolveOwnerItem: ResolveOwnerItemUseCase;
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
    readonly mergeRecordRepository: MergeRecordRepositoryAdapter;
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
    readonly mergeGrant: MergeGrantAdapter;
    /** Read-only PR state (AM4b-2); bound in forge mode `github` only. */
    readonly forgeRead: ForgeReadAdapter;
    readonly registerWorkOrder: RegisterWorkOrderUseCase;
    readonly inspectWorkOrder: InspectWorkOrderUseCase;
    /** KF-36b-1b: the operator's close command; built after the conductor composes its lane-run stores. */
    readonly closeWorkOrder: CloseWorkOrderUseCase;
    /** KF-36b-2: the read-only stale work-order listing; built beside closeWorkOrder from the same stores. */
    readonly listStaleWorkOrders: ListStaleWorkOrdersUseCase;
    /** PT1ca: the read-only listing of registrations held by overlap admission. */
    readonly listHeldWorkOrders: ListHeldWorkOrdersUseCase;
    readonly inspectAttempt: InspectAttemptUseCase;
    readonly explainAttempt: ExplainAttemptUseCase;
    readonly prepareBriefPackage: PrepareBriefPackageUseCase;
    /** CO17c: one brief-author seat session per brief; the CLI never dispatches. */
    readonly authorBrief: AuthorBriefUseCase;
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
    readonly mergeQueueRepository: MergeQueueRepositoryAdapter;
    readonly enqueueMerge: EnqueueMergeUseCase;
    readonly listMergeQueue: ListMergeQueueUseCase;
    readonly importTrainState: ImportTrainStateUseCase;
    /** CO5b: the read-only rollback export of the queue as legacy documents. */
    readonly exportLegacyTrainState: ExportLegacyTrainStateUseCase;
    /** CO32: the read-only shell train state reader behind the cutover shadow report. */
    readonly legacyTrainState: LegacyTrainStateReadAdapter;
    /** CO25: the read-only merge readiness check for one pull request. */
    readonly inspectMergeReadiness: InspectMergeReadinessUseCase;
    /** CO26: the read-only relaunch inventory per lane host. */
    readonly inventoryRelaunch: InventoryRelaunchUseCase;
    /** CO29a: the immutable relaunch plan store, keyed by canonical plan digest. */
    readonly relaunchPlanRepository: RelaunchPlanRepositoryAdapter;
    /** CO29a: build and store the ordered relaunch plan (read-only over the inventory and records). */
    readonly planRelaunch: PlanRelaunchUseCase;
    /** CO30a: the one cutover record v1 (`cutover.json`). */
    readonly cutoverRecordRepository: CutoverRecordRepositoryAdapter;
    /** CO30a: the keyed cutover journal (`cutover-journal.json`). */
    readonly cutoverJournal: CutoverJournalAdapter;
    /** CO30a: the killall train-pause record `cutover rollback` lifts when the cutover set it. */
    readonly killallTrainPause: KillallTrainPauseAdapter;
    /** CO30a: `cutover status` and `cutover rollback`; switch and retire are CO30b. */
    readonly manageCutover: ManageCutoverUseCase;
    /** SH8a: the shadow day-writer behind `cutover shadow record-day`; undefined without a durable state directory. */
    readonly recordShadowDay?: RecordShadowDayUseCase;
    /** CO24comp: PR-feedback fix round preparation and grant-scoped push-to-pr. */
    readonly preparePullRequestFeedbackFix: PreparePullRequestFeedbackFixUseCase;
    /** OG-8b: the operator-only review thread helper; bound in forge mode github only, never given to the daemon. */
    readonly reviewThreadHelper: ReviewThreadHelperPort;
  };
  readonly conductor: {
    readonly laneRunRepository: LaneRunRepositoryAdapter;
    readonly laneRunJournal: LaneRunJournalAdapter;
    readonly driverLease: ConductorDriverLeaseAdapter;
    readonly halt: ConductorHaltAdapter;
    readonly requestLaneRunStop: RequestLaneRunStopUseCase;
    readonly inspectLaneRuns: InspectLaneRunsUseCase;
    /** PT1a (SN3): the runs parked past `policy.daemon.stallAfterMinutes`, for `conductor status --stalled`. */
    readonly listStalledRuns: ListStalledRunsUseCase;
    /** PT1a (SN2): raises, refreshes and clears one `stall:<runId>` attention item per stalled run. */
    readonly stallAttention: StallAttentionAdapter;
    /** PT1a: the failing gate file a verification receipt recorded, read to class a gate park. */
    readonly gateFailingFile: GateFailingFileAdapter;
    /** PT1a: `policy.daemon.stallAfterMinutes` as resolved at composition. */
    readonly stallAfterMinutes: number;
    readonly listLaneRuns: ListLaneRunsUseCase;
    /** VZ5b: the recorded conductor passes newest first (conductor schedule --passes). */
    readonly listConductorPasses: ListConductorPassesUseCase;
    readonly resumeLaneRun: ResumeLaneRunUseCase;
    /** EX-2b: the operator-opt-in worktree reap (conductor reap --worktrees). */
    readonly reapLaneWorktrees: ReapLaneWorktreesUseCase;
    /** EX-4: the operator-opt-in orphan-session reap (conductor reap --sessions). */
    readonly reapOrphanSessions: ReapOrphanSessionsUseCase;
    /** OG22b: the operator-opt-in orphan-reservation reap (conductor reap --reservations --yes). */
    readonly reapOrphanReservations: ReapOrphanReservationsUseCase;
    /** OG22b: the same reap over read-only stores, used by --dry-run; it can write nothing. */
    readonly reapOrphanReservationsDryRun: ReapOrphanReservationsUseCase;
    /** KW4b': the zombie reaper pass. */
    readonly reapZombies: ReapZombiesUseCase;
    /** KW4b': the reaper's findings store (file-backed with a state dir). */
    readonly reaperFindingRepository: ReaperFindingRepositoryAdapter | InMemoryReaperFindingRepositoryAdapter;
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
    /**
     * The driver's mark port (OT5): the no-op mark when telemetry is
     * unconfigured, else the driver exporter's `mark`. The driver calls this
     * after every advanced run's pass; it never throws.
     */
    readonly mark: RunTelemetryMarkPort;
    /**
     * Starts the driver's background exporter (OT5); null when telemetry is
     * unconfigured. The driver calls it after its tunnel opens, never on the
     * dry-run path.
     */
    readonly startExporter: (() => void) | null;
    /**
     * Stops the background exporter (OT5); null when telemetry is
     * unconfigured. The driver awaits it in its `finally` against a 2 s
     * unref'd timer, so the exit is delayed by at most 2 s.
     */
    readonly stopExporter: (() => Promise<void>) | null;
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

type ShadowEvidenceRead =
  | { readonly status: 'ok'; readonly evidence: unknown }
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable' }
  | { readonly status: 'unknown-version' };

/**
 * SH8b: the reader `cutover switch` binds when a durable state directory
 * exists. The stored ledger is composed here and judged by
 * `readCutoverShadowEvidence` inside the use case; this function does not
 * re-implement the 3-day, 20-merge, or S1–S13 rules. `nowIso` is the daemon
 * clock and is read when the switch runs, never the operator's `--now-iso`.
 * Unreadable and unknown-version stay unknown. Every other non-ok result is
 * absence. A throw from the store propagates so the use case reports
 * `shadow-evidence-unreadable`; this mapping never echoes the ledger.
 */
function readStoredShadowEvidence(
  evidence: ShadowEvidenceAdapter,
  nowIso: () => string,
): () => Promise<ShadowEvidenceRead> {
  return async () => {
    const read = await evidence.read();
    if (read.status === 'unreadable') return { status: 'unreadable' };
    if (read.status === 'unknown-version') return { status: 'unknown-version' };
    if (read.status !== 'ok') return { status: 'absent' };
    // OD-4: each 3-day window must be bound to one pinned non-null release sha.
    const composed = composeCutoverShadowEvidence(read.ledger, nowIso(), {
      requireSingleRelease: true,
    });
    return composed.status === 'ok'
      ? { status: 'ok', evidence: composed.evidence }
      : { status: 'absent' };
  };
}

export function createFleetCliRuntime(options?: FleetCliRuntimeOptions): FleetCliRuntime {
  const stateDir = options?.stateDir;
  // Taken before any adapter is composed (some create the directory): the relaunch commands refuse
  // a state directory that did not exist as a directory instead of reading it as an empty installation.
  const stateDirPresentAtStart =
    stateDir === undefined || stateDir.trim().length === 0
      ? undefined
      : statSync(stateDir, { throwIfNoEntry: false })?.isDirectory() === true;
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

  // CO24f: the authorization resolve binds owner grants to the attempt that
  // resolves them, and validates that attempt through the execution stack's
  // attempt store. The execution stack composes after the coordination stack,
  // so the root fills the deferred reader in once the repositories exist;
  // until then every read reports absence, which fails closed.
  const attemptFactsRead = new DeferredAttemptFactsRead();

  const {
    coordination,
    coordinationRequestRepository,
    issuePolicyForgeGrantUseCase,
    issueMergeGrantUseCase,
    profileRead,
    probeRecord,
    executorForHostName,
  } = composeCoordination({ stateDir, ownerPublicKey, options, attemptFactsRead });

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
    mergeGrant,
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
    issuePolicyForgeGrantUseCase,
    issueMergeGrantUseCase,
  });

  // CO24f: the attempt facts live behind the execution stack's repositories,
  // composed above; the deferred reader now resolves them through both.
  attemptFactsRead.setDelegate({
    findAttemptFactsById: async (attemptId) => {
      const attempt = await attemptRepository.findAttemptById(attemptId);
      if (attempt === null) {
        return null;
      }
      const workOrder = await workOrderRepository.findWorkOrderById(attempt.workOrderId);
      return {
        attemptId,
        projectId: workOrder?.projectId ?? null,
        collectedHeadSha: attempt.artifacts?.headCommit ?? null,
      };
    },
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
    mergeGrant,
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

  // CO17c: the brief author use case composes from the same execution stack it
  // freezes through. The fact pack reads through the orchestrator executor
  // (the role that runs where this process runs) and the brief authoring
  // adapter is the already-composed instance with no seat command configured.
  const authorBrief = new AuthorBriefUseCase({
    factPack: new BuildFactPackUseCase({
      facts: new RepositoryFactsAdapter({ executor: roleExecutors.orchestrator }),
      mintNonce: () => randomBytes(16).toString('hex'),
    }),
    briefAuthoring: execution.briefAuthoring,
    prepareBriefPackage: execution.prepareBriefPackage,
  });

  const { conductor } = composeConductor({
    stateDir,
    evidence,
    profileRead,
    coordination,
    attemptArtifact,
    coordinationRequestRepository,
    issuePolicyForgeGrantUseCase,
    autoMergeLoad,
    installation: options?.installation,
    workOrderRepository,
    attemptRepository,
    forgeRead,
    executionJournal,
    workspace,
    runnerForAttempt,
    reconcileAttempt: execution.reconcileAttempt,
    mergeRecordRepository: execution.mergeRecordRepository,
    runner,
  });

  // PT1ca: registration checks the open pull requests of the base branch, so it
  // is built here, after the conductor composes its lane-run stores (a pull
  // request bound to the work order by a run is never its own blocker). The
  // forge read is bound in forge mode `github` only, as for AssessHeadAcceptance
  // in the evidence composition: a workspace without a GitHub installation keeps
  // registering, while every GitHub installation enforces the open-PR check and
  // fails closed with `overlap-unknown` when the forge cannot be read.
  const registerWorkOrder = new RegisterWorkOrderUseCase({
    workOrderRepo: workOrderRepository,
    profileRead,
    lanePlanRepo: execution.lanePlanRepository,
    heldWorkOrderRepo: execution.heldWorkOrderRepository,
    runRepo: conductor.laneRunRepository,
    attemptRepo: attemptRepository,
    executionJournal,
    computeDigest: sha256HexDigest,
    // PT1ca fix 3: a hold skipped for an invalid blocker id is recorded as a
    // work-execution attention item, through the same recorder the conductor
    // and the daemon use.
    recordAttentionItem: (body, actor) => coordination.recordAttentionItem.recordAttentionItem(body, actor),
    ...(forgeMode === 'github' ? { forgeRead } : {}),
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

  // CO26 + CO29a: `relaunch inventory` and `relaunch plan` are strictly
  // read-only; composeReadOnlyRelaunch builds every state adapter they reach
  // read-only and takes no store from the conductor (CO29a-ro). A corrupt
  // store file is never quarantined by either command, and unreadable halt
  // or lease bytes answer unknown instead of a value (CO29a-ro2). The plan
  // store (relaunch-plans.json) is the one allowed write, and only
  // `planRelaunch` holds it.
  const { inventoryRelaunch, planRelaunch, relaunchPlanRepository } = composeReadOnlyRelaunch({
    stateDir,
    stateDirPresentAtStart,
    workspace,
    runnerForAttempt,
    computeDigest: sha256HexDigest,
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

  // CO25: the merge-readiness forge read (DT5) behind the same reviewed gh
  // subprocess as the other forge reads. Without forge mode github the
  // adapter stays unconfigured, so a readiness check answers unknown instead
  // of reaching for a forge the installation forbids.
  const mergeForgeRead =
    forgeMode === 'github'
      ? new GhForgeMergeReadAdapter({
          runGh: (args, timeoutMs) =>
            (
              options?.forgeGhRunner ??
              ((ghArgs: readonly string[], ghTimeoutMs?: number) =>
                runGhSubprocess(ghArgs, ghBinaryCandidates, undefined, ghTimeoutMs))
            )(args, timeoutMs),
        })
      : new GhForgeMergeReadAdapter();
  const inspectMergeReadiness = new InspectMergeReadinessUseCase({
    mergeRead: mergeForgeRead,
    nowIso: () => new Date().toISOString(),
  });

  // OG-8b: the operator-only review thread helper. Bound only when forge mode
  // is github; the daemon and the conductor receive no reference to it.
  const reviewThreadHelper: ReviewThreadHelperPort =
    forgeMode === 'github'
      ? new GhReviewThreadHelperAdapter({
          runGh: (args, timeoutMs) =>
            (
              options?.forgeGhRunner ??
              ((ghArgs: readonly string[], ghTimeoutMs?: number) =>
                runGhSubprocess(ghArgs, ghBinaryCandidates, undefined, ghTimeoutMs))
            )(args, timeoutMs),
        })
      : new GhReviewThreadHelperAdapter();

  // CO24comp: the PR-feedback fix round reads findings through the same
  // reviewed gh subprocess as the other forge reads, and only when the
  // installation binds github; otherwise the adapter stays unconfigured and
  // every round refuses instead of reaching for a forge the installation
  // forbids.
  const pullRequestFindingsRead =
    forgeMode === 'github' && forgeGithubSection !== undefined
      ? new PullRequestFindingsReadAdapter({
          repository: { owner: forgeGithubSection.owner, repo: forgeGithubSection.repo },
          runGh: (args, timeoutMs) =>
            (
              options?.forgeGhRunner ??
              ((ghArgs: readonly string[], ghTimeoutMs?: number) =>
                runGhSubprocess(ghArgs, ghBinaryCandidates, undefined, ghTimeoutMs))
            )(args, timeoutMs),
        })
      : new PullRequestFindingsReadAdapter();
  const preparePullRequestFeedbackFix = new PreparePullRequestFeedbackFixUseCase({
    findings: pullRequestFindingsRead,
    prepareFixAttempt: execution.prepareFixAttempt,
    executeForgeAction: execution.executeAuthorizedForgeAction,
    repository:
      forgeGithubSection !== undefined
        ? { owner: forgeGithubSection.owner, repo: forgeGithubSection.repo }
        : { owner: '', repo: '' },
    nowIso: () => new Date().toISOString(),
    mintNonce: () => randomBytes(16).toString('hex'),
  });

  // DT10b: the daemon stack (merge pass, tick, status, pause, forge probe).
  const daemon = composeDaemon({
    stateDir,
    options,
    installationModel,
    forgeMode,
    mergeForgeRead,
    mergeQueueRepository: execution.mergeQueueRepository,
    chainBranchRead: execution.forgeAction,
    evidence,
    conductor,
    runGh: (args, timeoutMs) =>
      (
        options?.forgeGhRunner ??
        ((ghArgs: readonly string[], ghTimeoutMs?: number) =>
          runGhSubprocess(ghArgs, ghBinaryCandidates, undefined, ghTimeoutMs))
      )(args, timeoutMs),
    chainAttention: {
      recordAttentionItem: (body, actor) => coordination.recordAttentionItem.recordAttentionItem(body, actor),
      clearAttentionItem: (request, via, actor) => coordination.clearAttentionItem.clearAttentionItem(request, via, actor),
    },
  });

  // CO30a: `cutover status` reads the pause stores through read-only handles so a corrupt file is
  // never quarantined; in memory mode the one writable instance is shared.
  const durableCutover = stateDir !== undefined && stateDir.trim().length > 0;
  const cutoverRecordRepository = new CutoverRecordRepositoryAdapter({ stateDir, nowIso: daemon.now });
  const cutoverJournal = new CutoverJournalAdapter({ stateDir });
  const killallTrainPause = new KillallTrainPauseAdapter({ stateDir });
  const daemonPauseRead = durableCutover ? new DaemonPauseAdapter({ stateDir, readOnly: true }) : daemon.pause;
  const trainPauseRead = durableCutover ? new KillallTrainPauseAdapter({ stateDir, readOnly: true }) : killallTrainPause;
  // SH8b: read-only ledger for `cutover switch`. In-memory mode has no durable
  // ledger, so the reader stays undefined and the use case refuses. This does
  // not wire `countUnrecordedLanes` and does not start the shadow daemon.
  const shadowEvidence = durableCutover ? new ShadowEvidenceAdapter({ stateDir, readOnly: true }) : undefined;
  const readShadowEvidence =
    shadowEvidence === undefined ? undefined : readStoredShadowEvidence(shadowEvidence, daemon.now);
  const manageCutover = new ManageCutoverUseCase({
    cutoverRepo: cutoverRecordRepository,
    cutoverJournal,
    daemonStatus: daemon.statusReadOnly,
    daemonPauseRead,
    daemonPause: daemon.pause,
    trainPauseRead,
    trainPause: killallTrainPause,
    computeDigest: sha256HexDigest,
    mintEntryId: daemon.newUlid,
    nowIso: daemon.now,
    ...(readShadowEvidence === undefined ? {} : { readShadowEvidence }),
  });

  // SH8a: `cutover shadow record-day` — the shadow day-writer. Durable-state
  // only: without a state directory there is no ledger to write and no fleet
  // stores to check, so the use case stays undefined exactly like every other
  // durable-only use case in this composition (in-memory mode is disposable).
  const recordShadowDay =
    durableCutover && stateDir !== undefined && stateDir.trim().length > 0
      ? new RecordShadowDayUseCase({
        // SH2's composition created no ShadowEvidenceAdapter elsewhere, so this
        // is the one writable instance over the ledger store it owns.
        evidence: new ShadowEvidenceAdapter({ stateDir }),
        // The same read-only shell-train reader the shadow report composes:
        // reuse the instance rather than point a second one at the same files.
        legacy: execution.legacyTrainState,
        queue: execution.mergeQueueRepository,
        // S8's dry-run seat: the existing import use case, apply never set.
        importDryRun: execution.importTrainState,
        sleep:
          options?.daemonSleep ??
          ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
        journal: conductor.laneRunJournal,
        daemonEvents: daemon.events,
        // S9's state integrity sample: the same four-context check the
        // `state check` logic in state.ts runs, over each package's own
        // state-file descriptor list, counting the genuinely-unknown statuses.
        checkState: async () => {
          const checks = await Promise.all(
            [
              ...WORK_EXECUTION_STATE_FILES,
              ...EVIDENCE_AND_ACCEPTANCE_STATE_FILES,
              ...BRIEF_KNOWLEDGE_STATE_FILES,
              ...OPERATOR_COORDINATION_STATE_FILES,
            ].map((descriptor) => descriptor.check(stateDir)),
          );
          return {
            checked: checks.length,
            bad: checks.filter(
              (check) =>
                check.result.status === 'unreadable' ||
                check.result.status === 'read-error' ||
                check.result.status === 'unknown-version',
            ).length,
          };
        },
        computeDigest: sha256HexDigest,
        // The same repository derivation MergeQueueRepositoryAdapter and the
        // daemon's mergePolicySource use — never a second formula.
        repoDigestOf: mergeQueueRepositoryDigest,
        // OD-4: release binding is not yet built; SH8b and a later unit revisit
        // this constant once a release sha source exists.
        releaseSha: async () => null,
        nowIso: daemon.now,
        // OD-1: the owner-accepted default is false, fail-closed; this use case
        // only receives it.
        settings: { excludeBatchMerges: false },
      })
    : undefined;
  return {
    installation: options?.installation,
    daemon,
    coordination,
    knowledge,
    evidence,
    execution: {
      ...execution,
      authorBrief,
      registerWorkOrder,
      closeWorkOrder,
      listStaleWorkOrders,
      inspectMergeReadiness,
      inventoryRelaunch,
      /** CO29a: the immutable relaunch plan store, keyed by canonical plan digest. */
      relaunchPlanRepository,
      /** CO29a: build and store the ordered relaunch plan (read-only over the inventory and records). */
      planRelaunch,
      cutoverRecordRepository,
      cutoverJournal,
      killallTrainPause,
      manageCutover,
      preparePullRequestFeedbackFix,
      /** SH8a: `cutover shadow record-day`; undefined without a durable state directory. */
      ...(recordShadowDay !== undefined ? { recordShadowDay } : {}),
      reviewThreadHelper,
      exportLegacyTrainState: new ExportLegacyTrainStateUseCase({
        listMergeQueue: execution.listMergeQueue,
        nowIso: () => new Date().toISOString(),
      }),
    },
    conductor,
    runnerTunnel,
    telemetry,
  };
}
