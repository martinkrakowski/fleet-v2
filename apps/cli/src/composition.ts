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
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { types } from 'node:util';

import { GH_BINARY_CANDIDATES, resolveGhBinary } from './gh-binary.js';
import { SSH_BINARY_CANDIDATES, resolveSshBinary } from './ssh-binary.js';
import { parseConfiguredCliPath } from './release.js';
import {
  isUsableSshHost,
  RunnerTunnelAdapter,
  RunnerTunnelSetAdapter,
  type RunnerTunnelPort,
} from './runner-tunnel.js';
import { composeCoordination, DeferredAttemptFactsRead } from './composition/coordination.js';
import { composeReadOnlyRelaunch } from './composition/relaunch.js';
import { recordedHostOf } from './relaunch.js';
import { composeKnowledge } from './composition/knowledge.js';
import { composeEvidence } from './composition/evidence.js';
import { composeExecutionHosts } from './composition/work-execution-hosts.js';
import { composeExecution } from './composition/work-execution.js';
import { composeConductor } from './composition/conductor.js';
import { composeDaemon, type ComposedDaemon } from './composition/daemon.js';
import { newUlid } from './ulid.js';
import { composeTelemetry, type TelemetryConfiguredState, type TelemetryPolicyView } from './composition/telemetry.js';

import {
  AcceptanceAssessmentAdapter,
  AcceptanceEvidenceAdapter,
  ActionAuthorizationAdapter,
  AutoMergeAttemptUseCase,
  AttemptArtifactAdapter,
  AttemptRepositoryAdapter,
  AttestShadowFactUseCase,
  AuthorBriefUseCase,
  BriefAuthoringAdapter,
  BriefKnowledgeAdapter,
  BuildFactPackUseCase,
  CiStateAdapter,
  CloseWorkOrderUseCase,
  ChainRepositoryAdapter,
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
  BriefReadRepositoryAdapter,
  DeclarationRepositoryAdapter,
  DeclareLaneActivityUseCase,
  ImportLanePlanUseCase,
  InspectMergeReadinessUseCase,
  InspectWorkOrderUseCase,
  LanePlanRepositoryAdapter,
  LinkPullRequestUseCase,
  RecordBriefReadUseCase,
  SyncPlanDecisionsUseCase,
  InventoryRelaunchUseCase,
  PlanRelaunchUseCase,
  AdoptLaneUseCase,
  ApplyRelaunchUseCase,
  LaneDiffCheckAdapter,
  LaneEditSaveAdapter,
  ProcessTreeTerminationAdapter,
  SaveLaneEditsUseCase,
  RelaunchPlanRepositoryAdapter,
  ReleaseStoreAdapter,
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
  RecordSeatObservationUseCase,
  SeatObservationRepositoryAdapter,
  RegisterWorkOrderUseCase,
  RepositoryFactsAdapter,
  RequestAttemptAcceptanceUseCase,
  ReviewAssessmentAdapter,
  ReviewRequestAdapter,
  ReserveExecutionCapacityUseCase,
  RunnerForAttemptAdapter,
  SshExecutor,
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
  evaluateShadowGrantCoverage,
  RETIREMENT_LEDGER_MAX_BYTES,
  ShadowAttestationAdapter,
  ShadowEvidenceAdapter,
  WORK_EXECUTION_STATE_FILES,
  ReapLaneWorktreesUseCase,
  ReapOrphanReservationsUseCase,
  ReapOrphanSessionsUseCase,
  ReapZombiesUseCase,
  ReaperFindingRepositoryAdapter,
  InMemoryReaperFindingRepositoryAdapter,
  ResumeLaneRunUseCase,
  type AuditedRequestLaneRunStopPort,
  type StopAttemptPort,
  type ProjectProfileReadPort,
  type AttemptRecord,
  type AttemptReviewLocator,
  type InventoryRelaunchResult,
  type RelaunchCloneRef,
  type ExecutionRunnerHost,
  type EvaluateAttemptGatePort,
  type EnqueueMergeUseCase,
  type ListMergeQueueUseCase,
  ImportTrainStateUseCase,
  type LegacyTrainStateReadAdapter,
  type LaneRunRepositoryPort,
  MergeQueueRepositoryAdapter,
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
  type HostAudibleAlertPort,
  type CutoverJournalPort,
} from '@fleet/work-execution';
import { readCurrentReleaseSha } from './shadow-release-sha.js';

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
  resolvePinnedOwnerPublicKey,
  OPERATOR_COORDINATION_STATE_FILES,
} from '@fleet/operator-coordination';
import {
  loadInstallation,
  parseMergeRepositoryKey,
  requireValidInstallationModel,
  resolveMergePolicy,
  resolveSeatsPolicy,
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
  /** The host audible alert (tests only); production resolves it from FLEET_AUDIBLE_ALERT. */
  readonly daemonAudibleAlert?: Pick<HostAudibleAlertPort, 'speak'>;
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
  /**
   * KEY0b: the fallback pinned owner key when `installation.owner.publicKey`
   * is absent (tests inject one here). `FLEET_OWNER_PUBLIC_KEY` is never an
   * authority; the pinned key is resolved by `resolvePinnedOwnerPublicKey`.
   */
  readonly ownerPublicKey?: string;
  /** The one-line deprecation warning is emitted here exactly once. */
  readonly onOwnerKeyWarning?: (message: string) => void;
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
 * G2: one `ssh -N -L` forward per `ssh` `opencode` `lane-runner` host of a v2
 * installation. `hostName` is the installation's own host key, `sshHost` the
 * trimmed alias the forward dials and `remotePort` the server port behind it
 * (the dial port is one above). Local hosts, `agy` runners, hosts without the
 * `lane-runner` role, unusable aliases and unusable ports yield no entry; a
 * v1 or absent installation yields none at all.
 */
export interface RunnerTunnelTarget {
  readonly hostName: string;
  readonly sshHost: string;
  readonly remotePort: number;
  /**
   * IH1b: true when the host's runner block declares `optional: true` — a
   * failed forward for such a host is reported and skipped, never fatal.
   * Absent on every non-optional target, so their object shape is unchanged.
   */
  readonly optional?: boolean;
}

/** Keys that must never be read off untrusted records. */
const POLLUTING_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  // A Proxy is refused before `Array.isArray` (which throws on a revoked
  // Proxy) or any trap can run; `types.isProxy` invokes no trap. O(1).
  if (types.isProxy(value) || Array.isArray(value)) {
    return false;
  }
  // Only an exactly plain prototype is accepted, so a class instance or an
  // object with a custom prototype (whose inherited fields and getters would
  // otherwise be reachable) is refused. A Proxy's `getPrototypeOf` trap is
  // never allowed to escape: a throwing trap simply refuses the value.
  try {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

/**
 * True unless the key is an own data property: an accessor is refused unread,
 * a missing own property is refused too (reading it would fall through to the
 * prototype chain, where a polluted `Object.prototype` getter could run), and
 * a throwing descriptor trap refuses the record instead of escaping.
 */
function isAccessor(record: Record<string, unknown>, key: string): boolean {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return (
      descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined
    );
  } catch {
    // A hostile `getOwnPropertyDescriptor` trap: refuse without escaping.
    return true;
  }
}

/** Array membership without ever calling a method or a getter on the array. */
function rolesIncludeLaneRunner(roles: readonly unknown[]): boolean {
  // Proxy guard: a Proxy (even one reporting Array.prototype) is refused, and
  // a plain Array prototype is the only accepted shape.
  if (types.isProxy(roles) || Object.getPrototypeOf(roles) !== Array.prototype) {
    return false;
  }
  // Cost O(roles.length), capped at 1024; holes and accessors are skipped.
  const bound = Math.min(roles.length, 1024);
  for (let i = 0; i < bound; i += 1) {
    if (!(i in roles)) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(roles, i);
    if (descriptor !== undefined && (descriptor.get !== undefined || descriptor.set !== undefined)) {
      continue;
    }
    if (descriptor?.value === 'lane-runner') {
      return true;
    }
  }
  return false;
}

export function resolveRunnerTunnelTargets(installation?: FleetInstallation): readonly RunnerTunnelTarget[] {
  // Hostile input, cost O(Object.keys(hosts).length): nothing here lets a
  // getter or a Proxy trap escape — an accessor is refused unread, and a
  // throwing trap only refuses (or skips) the input instead of propagating.
  if (installation === undefined || !isPlainObject(installation)) {
    return [];
  }
  if (isAccessor(installation, 'schemaVersion')) {
    return [];
  }
  let schemaVersion: unknown;
  try {
    schemaVersion = installation.schemaVersion;
  } catch {
    return [];
  }
  if (schemaVersion !== 2) {
    return [];
  }
  if (isAccessor(installation, 'hosts')) {
    return [];
  }
  let hosts: unknown;
  try {
    hosts = installation.hosts;
  } catch {
    // A hostile `get` trap on the wrapped record: refuse the installation.
    return [];
  }
  if (!isPlainObject(hosts)) {
    return [];
  }
  let hostNames: readonly string[];
  try {
    hostNames = Object.keys(hosts);
  } catch {
    return [];
  }
  const targets: RunnerTunnelTarget[] = [];
  for (const hostName of hostNames) {
    if (POLLUTING_KEYS.has(hostName)) {
      continue;
    }
    let host: unknown;
    try {
      if (isAccessor(hosts, hostName)) {
        continue;
      }
      host = hosts[hostName];
    } catch {
      // A hostile `getOwnPropertyDescriptor` or `get` trap skips the entry.
      continue;
    }
    if (!isPlainObject(host)) {
      continue;
    }
    const entry = readHostEntry(host);
    if (entry !== null) {
      targets.push({
        hostName,
        sshHost: entry.trimmedAlias,
        remotePort: entry.port,
        ...(entry.optional ? { optional: true } : {}),
      });
    }
  }
  return targets;
}

/**
 * Read one host entry of an installation's `hosts` section. Every read is
 * guarded: an accessor descriptor on any read field skips the entry (its
 * getter is never invoked) and a throwing Proxy trap skips the entry instead
 * of escaping. Cost O(1) reads per entry. Returns `null` for every entry that
 * yields no tunnel target.
 */
function readHostEntry(host: Record<string, unknown>): {
  readonly trimmedAlias: string;
  readonly port: number;
  readonly optional: boolean;
} | null {
  try {
    if (
      isAccessor(host, 'roles') ||
      isAccessor(host, 'transport') ||
      isAccessor(host, 'sshAlias') ||
      isAccessor(host, 'runner')
    ) {
      return null;
    }
    const roles = host.roles;
    if (!Array.isArray(roles) || !rolesIncludeLaneRunner(roles)) {
      return null;
    }
    if (host.transport !== 'ssh') {
      return null;
    }
    const alias = host.sshAlias;
    if (typeof alias !== 'string') {
      return null;
    }
    const trimmedAlias = alias.trim();
    if (trimmedAlias === '' || !isUsableSshHost(trimmedAlias)) {
      return null;
    }
    if (!isPlainObject(host.runner)) {
      return null;
    }
    const runner = host.runner;
    // The runner's own fields are guarded too: an accessor on `kind` or
    // `port` skips the entry without ever invoking the getter.
    if (isAccessor(runner, 'kind') || isAccessor(runner, 'port')) {
      return null;
    }
    if (runner.kind !== 'opencode') {
      return null;
    }
    const port = runner.port;
    if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65534) {
      return null;
    }
    // IH1b: `runner.optional` marks a skippable tunnel. Read through its own
    // descriptor: an accessor is refused unread, an absent field is simply
    // false (plain records keep their meaning), and any non-`true` value —
    // a non-boolean among them — reads as false.
    const optionalDescriptor = Object.getOwnPropertyDescriptor(runner, 'optional');
    if (
      optionalDescriptor !== undefined &&
      (optionalDescriptor.get !== undefined || optionalDescriptor.set !== undefined)
    ) {
      return null;
    }
    const optional = optionalDescriptor?.value === true;
    return { trimmedAlias, port, optional };
  } catch {
    // Any hostile trap on the entry's record refuses the entry, never escapes.
    return null;
  }
}

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
  /**
   * Locates the worktree a review reads. A `brief:<projectId>:<digest>` id
   * resolves to the one recorded attempt for that brief (CO18a3b).
   */
  readonly reviewLocator: AttemptReviewLocator;
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
    /** WB4a/WB7a: the imported lane-plan store behind the `plan` group. */
    readonly lanePlanRepository: LanePlanRepositoryAdapter;
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
    /** WB7a: the lane-activity stores behind `plan declare` and `plan brief-check`. */
    readonly declarationRepository: DeclarationRepositoryAdapter;
    readonly briefReadRepository: BriefReadRepositoryAdapter;
    /** WB7a: the plan use cases behind the `plan` command group. */
    readonly importLanePlan: ImportLanePlanUseCase;
    readonly linkPullRequest: LinkPullRequestUseCase;
    readonly declareLaneActivity: DeclareLaneActivityUseCase;
    readonly recordBriefRead: RecordBriefReadUseCase;
    readonly syncPlanDecisions: SyncPlanDecisionsUseCase;
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
    /** FC12B: the stop use case wrapped with the authority event emission. */
    readonly stopAttempt: StopAttemptPort;
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
    /** SW2a2: the shadow-park journal (`shadow-park-journal.json`, schemaVersion 3), a `CutoverJournalPort`. */
    readonly shadowParkJournal: CutoverJournalPort;
    /** CO30a: the killall train-pause record `cutover rollback` lifts when the cutover set it. */
    readonly killallTrainPause: KillallTrainPauseAdapter;
    /** CO30a: `cutover status` and `cutover rollback`; switch and retire are CO30b. */
    readonly manageCutover: ManageCutoverUseCase;
    /** SH8a: the shadow day-writer behind `cutover shadow record-day`; undefined without a durable state directory. */
    readonly recordShadowDay?: RecordShadowDayUseCase;
    /** AT1: the owner attestation writer behind `cutover shadow attest`; undefined without a durable state directory. */
    readonly attestShadowFact?: AttestShadowFactUseCase;
    /** RC1: the read-only lane-run reader record-day's early warning reads; the same instance `conducted.facts.runs` uses, undefined when conducted is not wired or not durable. */
    readonly shadowRunsRead?: Pick<LaneRunRepositoryPort, 'list'>;
    /** CO24comp: PR-feedback fix round preparation and grant-scoped push-to-pr. */
    readonly preparePullRequestFeedbackFix: PreparePullRequestFeedbackFixUseCase;
    /** AR3c1: the single process-tree termination adapter, shared with relaunch live apply. */
    readonly processTreeTermination: ProcessTreeTerminationAdapter;
    /** AR3c1: `relaunch apply` live execution; wired with all twelve ports. */
    readonly applyRelaunch: ApplyRelaunchUseCase;
    /** OG-8b: the operator-only review thread helper; bound in forge mode github only, never given to the daemon. */
    readonly reviewThreadHelper: ReviewThreadHelperPort;
    /** SR6: `seats observe`; records one seat observation from outside the runner. */
    readonly recordSeatObservation: RecordSeatObservationUseCase;
  };
  readonly conductor: {
    readonly laneRunRepository: LaneRunRepositoryAdapter;
    readonly laneRunJournal: LaneRunJournalAdapter;
    readonly driverLease: ConductorDriverLeaseAdapter;
    readonly halt: ConductorHaltAdapter;
    /** FC12B: the audited stop port; its `auditGap` flags a missed sink write. */
    readonly requestLaneRunStop: AuditedRequestLaneRunStopPort;
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
   * `OCM_REMOTE_PORT`. Absent values mean the driver opens nothing. G2: a v2
   * installation with more than one ssh runner host (or a selected non-ssh
   * host beside one) gets the set adapter forwarding every ssh host at once.
   */
  readonly runnerTunnel: RunnerTunnelPort & { readonly owned: boolean };
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
 * re-implement the 1-day, 20-merge, or S1–S12 rules. `nowIso` is the daemon
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
    // OD-4: the 1-day window must be bound to one pinned non-null release sha.
    const composed = composeCutoverShadowEvidence(read.ledger, nowIso(), {
      requireSingleRelease: true,
    });
    return composed.status === 'ok'
      ? { status: 'ok', evidence: composed.evidence }
      : { status: 'absent' };
  };
}

/**
 * CO30c: the typed sum the switch lane gate consumes. A non-`inventoried`
 * inventory (unreadable records, unknown halt or lease bytes, a refused state
 * probe) is unreadable, never a zero. The sums take only what refuses or
 * unknowns the gate: the hosts' `unrecorded` population counts (idle
 * leftovers included — relaunch apply/adopt does not exist yet, so every
 * unrecorded listed worktree is lane work nothing explains) and the
 * `unknown-worktree-read` and `unknown-runner-state` flag counts (an unroutable
 * host or a failed listing or runner read refuses as unknown rather than
 * failing open when a stale record on a reused path stays `attempt-recorded`
 * and counts 0 unrecorded). `unproven-lane-records` is deliberately not
 * counted: an unproven record is listed in the inventory and never refuses
 * the switch. When `declaredClones` is given, an inventory that inspected
 * fewer clones than declared is unreadable, never a pass on partial
 * coverage (CO30c fix round). Exported for the cutover-switch regression
 * tests. A top-level `driver-lease-live` flag refuses as
 * `conductor-driver-live`: the driver lease is held right now, so a driver is
 * still active. A top-level `driver-lease-unknown` flag is unreadable instead
 * (CO30c follow-up): the lease state could not be read, so the gate cannot
 * tell whether a driver is active and never passes on that doubt. The
 * top-level `conductor-halted` flag is different — the code
 * reads it from the halt marker, which means the conductor is halted, not
 * that a driver is active — so it does not refuse this gate (an unreadable
 * halt marker already answers `unreadable` through a non-`inventoried`
 * outcome).
 */
export function summarizeInventoryForCutover(
  result: InventoryRelaunchResult,
  declaredClones?: number,
):
  | { readonly status: 'ok'; readonly unrecorded: number; readonly unknownListings: number }
  | { readonly status: 'unreadable' }
  | { readonly status: 'refused'; readonly reason: 'conductor-driver-live' } {
  if (result.outcome !== 'inventoried') {
    return { status: 'unreadable' };
  }
  // CO30c fix round: a live driver lease is a driver still active on the
  // installation, so the switch refuses with its own typed reason. A lease
  // whose state is unknown already arrives as a non-`inventoried` outcome
  // (`lease-unreadable`) and answers `unreadable` above.
  if (result.riskFlags.some((flag) => flag.code === 'driver-lease-live')) {
    return { status: 'refused', reason: 'conductor-driver-live' };
  }
  // CO30c follow-up: an unknown driver-lease state is not evidence of a live
  // driver, but neither is it evidence of an idle one — the gate answers
  // `unreadable` rather than passing on a state it could not read.
  if (result.riskFlags.some((flag) => flag.code === 'driver-lease-unknown')) {
    return { status: 'unreadable' };
  }
  let unrecorded = 0;
  let unknownListings = 0;
  let inspectedClones = 0;
  for (const host of result.hosts) {
    inspectedClones += host.cloneCount;
    // CO30c fix round: the inventory's own counts must account for every
    // listed worktree. `worktreeCount` is what the clone's listing returned
    // and `lanes` is what the inventory accounted for; the only difference a
    // correct read leaves is each clone's own main worktree, one per
    // `cloneCount` clone. When the listed worktrees outnumber the accounted
    // lanes beyond that — a worktree listed outside the clone's
    // `worktreeRoot`, silently dropped by the listing — the inventory cannot
    // vouch for the leftovers it never saw, so it is unreadable, never a
    // pass with `unrecorded 0`.
    if (host.worktreeCount - host.lanes.length > host.cloneCount) {
      return { status: 'unreadable' };
    }
    unrecorded += host.counts.unrecorded;
    for (const flag of host.riskFlags) {
      if (flag.code === 'unknown-worktree-read' || flag.code === 'unknown-runner-state') {
        unknownListings += flag.count;
      }
    }
  }
  // CO30c fix round: the inventory must have inspected every clone the
  // active profiles declare. Fewer inspected clones (a dropped host group, a
  // clone the read skipped) is not fewer lanes to explain: it is unreadable,
  // never a pass on partial coverage.
  if (declaredClones !== undefined && inspectedClones < declaredClones) {
    return { status: 'unreadable' };
  }
  return { status: 'ok', unrecorded, unknownListings };
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
  // KEY0b: the owner public key is read ONLY from the pinned
  // installation.owner.publicKey (or the test-injected pinned fallback when
  // the installation carries none). FLEET_OWNER_PUBLIC_KEY is never an
  // authority: a mismatching value refuses, an equal value only warns once.
  const resolvedOwnerKey = resolvePinnedOwnerPublicKey(
    options?.installation?.owner?.publicKey ?? options?.ownerPublicKey,
    options?.env ?? process.env,
  );
  const ownerPublicKey = resolvedOwnerKey.status === 'pinned' ? resolvedOwnerKey.publicKey : undefined;
  const ownerKeyRefusal =
    resolvedOwnerKey.status === 'pinned' ? undefined : resolvedOwnerKey.code;
  if (resolvedOwnerKey.status === 'pinned' && resolvedOwnerKey.deprecationWarning !== undefined) {
    options?.onOwnerKeyWarning?.(resolvedOwnerKey.deprecationWarning);
  }

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
  } = composeCoordination({ stateDir, ownerPublicKey, ownerKeyRefusal, options, attemptFactsRead });

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

  // SR6: `seats observe` is built here too, for the same reason as the close:
  // a review-request subject resolves its committed seat through the
  // conductor's lane-run stores. The observation store is the append-only
  // seat-observation file; the cooling policy is the installation's
  // `policy.seats.observationCooldownMinutes` at composition (0 = off). The
  // pre-merge chain order is copied once: `pre-merge` has no `SeatPlan` v1
  // role, so the chain entry at the journal key's seat index is the seat.
  const seatObservationRepository = new SeatObservationRepositoryAdapter({ stateDir });
  const highRiskReviewerSeatIds = installationModel?.chains?.['high-risk-reviewer']?.map(
    (step) => step.seatId,
  );
  const recordSeatObservation = new RecordSeatObservationUseCase({
    observations: seatObservationRepository,
    attempts: attemptRepository,
    isProxy: types.isProxy,
    nowIso: () => new Date().toISOString(),
    mintObservationId: () => newUlid(),
    observationCooldownMinutes: resolveSeatsPolicy(installationModel?.policy).observationCooldownMinutes,
    runRepo: conductor.laneRunRepository,
    runJournal: conductor.laneRunJournal,
    reviewRequest: conductor.reviewRequest,
    ...(highRiskReviewerSeatIds !== undefined ? { highRiskReviewerSeatIds } : {}),
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

  // KF-35: the driver's runner tunnel, aimed at the same target the runner
  // dispatches to: the installation's selected lane-runner host for v2, else the
  // resolved runner settings (which read the runtime's own environment object,
  // never the process environment when a test supplies one). Nothing is spawned
  // here; the conductor driver opens the forward before its first pass and stops
  // it in the same finally that releases its leases.
  // G2: a v2 installation's every `ssh` `opencode` `lane-runner` host gets its
  // own forward through the set adapter — including when a `local` host is the
  // selected runner host beside an ssh host. A single ssh host that is the
  // selected one (or v1/absent installations) keeps the single-target adapter.
  // IH1b: any optional host also composes the set adapter, so its failed
  // forward is reported and skipped instead of failing the whole start; every
  // member carries its host key so the reserve can exclude a down tunnel's
  // host at reservation time.
  const tunnelTargets = resolveRunnerTunnelTargets(options?.installation);
  const runnerTunnel =
    tunnelTargets.length >= 2 ||
    (tunnelTargets.length === 1 && tunnelTargets[0]!.hostName !== runnerHost?.hostName) ||
    tunnelTargets.some((target) => target.optional)
      ? new RunnerTunnelSetAdapter(
          tunnelTargets.map(
            (target) =>
              new RunnerTunnelAdapter({
                sshHost: target.sshHost,
                remotePort: target.remotePort,
                hostName: target.hostName,
                ...(target.optional ? { optional: true } : {}),
              }),
          ),
        )
      : new RunnerTunnelAdapter({
          ...resolveRunnerTunnelTarget(runnerHost, { runnerRemoteHost, runnerRemotePort }),
          ...(tunnelTargets.length === 1 ? { hostName: tunnelTargets[0]!.hostName } : {}),
        });

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
    trainHealthAttention: {
      recordAttentionItem: (body, actor) => coordination.recordAttentionItem.recordAttentionItem(body, actor),
      clearAttentionItem: (request, via, actor) => coordination.clearAttentionItem.clearAttentionItem(request, via, actor),
      listAttentionItems: (request) => coordination.listAttentionItems.listAttentionItems(request),
    },
  });

  // CO30a: `cutover status` reads the pause stores through read-only handles so a corrupt file is
  // never quarantined; in memory mode the one writable instance is shared.
  const durableCutover = stateDir !== undefined && stateDir.trim().length > 0;
  const cutoverRecordRepository = new CutoverRecordRepositoryAdapter({ stateDir, nowIso: daemon.now });
  const cutoverJournal = new CutoverJournalAdapter({ stateDir });
  // AR3c1: relaunch live apply. AdoptLaneUseCase and SaveLaneEditsUseCase are
  // the per-step services ApplyRelaunchUseCase drives; each is wired once here,
  // with fakes nowhere — the same durable stores and executors the commands use.
  const adoptLaneUseCase = new AdoptLaneUseCase({
    workOrderRepo: workOrderRepository,
    attemptRepo: attemptRepository,
    runRepo: conductor.laneRunRepository,
    runJournal: conductor.laneRunJournal,
    cutoverJournal,
    computeDigest: sha256HexDigest,
    mintEntryId: daemon.newUlid,
    now: daemon.now,
  });
  const saveLaneEditsUseCase = new SaveLaneEditsUseCase({
    diffCheck: new LaneDiffCheckAdapter(roleExecutors.worktree),
    runner,
    laneSave: new LaneEditSaveAdapter(roleExecutors.worktree, {
      executorForRecordedHost: (recorded) => {
        const r = executorForHost.executorForRecordedHost(recorded);
        return r.ok ? r.executor : null;
      },
    }),
    journal: cutoverJournal,
    mintEntryId: daemon.newUlid,
  });
  const applyRelaunch = new ApplyRelaunchUseCase({
    planRepo: relaunchPlanRepository,
    cutoverJournal,
    computeDigest: sha256HexDigest,
    authorization: execution.actionAuthorization,
    clock: daemon.now,
    saveLaneEdits: (request) => saveLaneEditsUseCase.execute(request),
    runner,
    processTreeTermination: execution.processTreeTermination,
    runRepo: conductor.laneRunRepository,
    runJournal: conductor.laneRunJournal,
    adoptLane: (request) => adoptLaneUseCase.adoptLane(request),
    attemptRepo: attemptRepository,
    mintEntryId: daemon.newUlid,
  });
  const killallTrainPause = new KillallTrainPauseAdapter({ stateDir });
  const daemonPauseRead = durableCutover ? new DaemonPauseAdapter({ stateDir, readOnly: true }) : daemon.pause;
  const trainPauseRead = durableCutover ? new KillallTrainPauseAdapter({ stateDir, readOnly: true }) : killallTrainPause;
  // SW2b2: `cutover switch` lists the merge queue through a read-only handle
  // over durable state so a corrupt queue file is never quarantined by a
  // switch read; in memory mode the one writable instance is shared.
  const mergeQueueRead = durableCutover
    ? new MergeQueueRepositoryAdapter({ stateDir, readOnly: true })
    : execution.mergeQueueRepository;
  // SH8b: read-only ledger for `cutover switch`. In-memory mode has no durable
  // ledger, so the reader stays undefined and the use case refuses. CO30c
  // wires `countUnrecordedLanes` beside it (below); the shadow daemon still
  // does not start from here.
  const shadowEvidence = durableCutover ? new ShadowEvidenceAdapter({ stateDir, readOnly: true }) : undefined;
  const readShadowEvidence =
    shadowEvidence === undefined ? undefined : readStoredShadowEvidence(shadowEvidence, daemon.now);
  // CO30c: the switch's last gate. Only durable state has the stores to
  // count; in-memory mode leaves it unwired exactly like `readShadowEvidence`.
  // The count reads ONLY read-only instances already composed: the relaunch
  // inventory's read-only store adapters (composeReadOnlyRelaunch), the
  // read-only project-profile listing, and the worktree/runner readers — so
  // a corrupt store file is a read error answered `unreadable`, never a
  // quarantine, and no writable daemon, conductor or profile instance is
  // reachable from here. Zero active project profiles (a missing
  // `project-profiles.json` reads as empty) is unreadable too: it never
  // passes 0/0. Nor does partial clone coverage (CO30c fix round): an
  // active profile with zero clones, zero clones across all profiles, or
  // an inventory that inspected fewer clones than the profiles declare is
  // unreadable, never a vacuous pass.
  const countUnrecordedLanes = durableCutover
    ? async (): Promise<
        | { readonly status: 'ok'; readonly unrecorded: number; readonly unknownListings: number }
        | { readonly status: 'unreadable' }
        | { readonly status: 'refused'; readonly reason: 'conductor-driver-live' }
      > => {
        try {
          let profiles: Awaited<
            ReturnType<
              typeof coordination.listProjectProfilesReadOnly.listProjectProfiles
            >
          >;
          try {
            profiles = await coordination.listProjectProfilesReadOnly.listProjectProfiles({
              status: 'active',
            });
          } catch {
            return { status: 'unreadable' };
          }
          if (profiles.outcome !== 'listed') {
            return { status: 'unreadable' };
          }
          const active = profiles.profiles.filter((profile) => profile.status === 'active');
          if (active.length === 0) {
            return { status: 'unreadable' };
          }
          const clones: RelaunchCloneRef[] = [];
          // CO30c follow-up: two active profiles may declare the same clone
          // (same host, path and worktree root). Deduplicating by that triple
          // keeps the inventory from listing one clone twice — which would
          // double the declared count and fail the partial-coverage check
          // against itself.
          const seenClones = new Set<string>();
          for (const profile of active) {
            const entries = Object.entries(profile.clones);
            // CO30c fix round: an active profile with no clone coverage is
            // never a pass — the inventory would see nothing and the gate
            // would pass vacuously. One declared-clone-less profile is as
            // unreadable as zero profiles.
            if (entries.length === 0) {
              return { status: 'unreadable' };
            }
            for (const [cloneHost, clone] of entries) {
              const cloneKey = `${cloneHost}\u0000${clone.path}\u0000${clone.worktreeRoot}`;
              if (seenClones.has(cloneKey)) {
                continue;
              }
              seenClones.add(cloneKey);
              clones.push({
                projectId: profile.projectId,
                hostName: cloneHost,
                clonePath: clone.path,
                worktreeRoot: clone.worktreeRoot,
                recordedHost: recordedHostOf(cloneHost, { installation: options?.installation }),
              });
            }
          }
          // CO30c fix round: zero declared clones across every active
          // profile is the same vacuous pass, refused before the read.
          if (clones.length === 0) {
            return { status: 'unreadable' };
          }
          const inventory = await inventoryRelaunch.inventoryRelaunch({
            nowIso: daemon.now(),
            hostName: null,
            clones,
          });
          return summarizeInventoryForCutover(inventory, clones.length);
        } catch {
          return { status: 'unreadable' };
        }
      }
    : undefined;
  // BL14b: the §1 cutover-plan retirement ledger the retire move demands.
  // Read-only: no lock, no quarantine. A symlink is refused from its lstat, an
  // over-long file from its stat, a parse or read failure is `unreadable`, a
  // newer schemaVersion is `unknown-version`, and a missing file is `absent`.
  // In-memory mode has no durable ledger, so the reader stays undefined and
  // the use case refuses `retirement-ledger-absent`.
  const readRetirementLedger = durableCutover
    ? async (): Promise<
        | { readonly status: 'ok'; readonly ledger: unknown }
        | { readonly status: 'absent' }
        | { readonly status: 'unreadable' }
        | { readonly status: 'unknown-version' }
      > => {
        const path = join(stateDir, 'cutover-retirement-ledger.json');
        try {
          const linked = lstatSync(path);
          if (!linked.isFile()) {
            return { status: 'unreadable' };
          }
          if (statSync(path).size > RETIREMENT_LEDGER_MAX_BYTES) {
            return { status: 'unreadable' };
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(readFileSync(path, 'utf8'));
          } catch {
            return { status: 'unreadable' };
          }
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            !Array.isArray(parsed) &&
            typeof (parsed as Record<string, unknown>).schemaVersion === 'number' &&
            Number.isSafeInteger((parsed as Record<string, unknown>).schemaVersion) &&
            ((parsed as Record<string, unknown>).schemaVersion as number) > 1
          ) {
            return { status: 'unknown-version' };
          }
          return { status: 'ok', ledger: parsed };
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'absent' } : { status: 'unreadable' };
        }
      }
    : undefined;
  const manageCutover = new ManageCutoverUseCase({
    cutoverRepo: cutoverRecordRepository,
    cutoverJournal,
    daemonStatus: daemon.statusReadOnly,
    daemonPauseRead,
    daemonPause: daemon.pause,
    trainPauseRead,
    trainPause: killallTrainPause,
    // SW2b2: the shadow parks a switch plans, journals and releases. The
    // shadow-park journal is the separate `shadow-park-journal.json` store
    // (SW2a2), never the cutover journal.
    mergeQueueRead,
    mergeQueue: execution.mergeQueueRepository,
    mergePolicy: daemon.mergePolicy,
    shadowParkJournal: execution.shadowParkJournal,
    computeDigest: sha256HexDigest,
    mintEntryId: daemon.newUlid,
    nowIso: daemon.now,
    ...(readShadowEvidence === undefined ? {} : { readShadowEvidence }),
    ...(countUnrecordedLanes === undefined ? {} : { countUnrecordedLanes }),
    ...(readRetirementLedger === undefined ? {} : { readRetirementLedger }),
  });

  const reviewLocator = reviewLocatorRef.locator;
  if (reviewLocator === undefined) {
    throw new Error('The work context is not wired for review location');
  }

  // SH19c: the one release root the one-time criteria (S2, S3, S10, S11)
  // inspect verified build files under — parsed lexically from the configured
  // `daemon.cliPath` (CO14c-1); empty when unconfigured or not a served
  // release path. `requireValidInstallationModel` above already validated the
  // installation this parse reads.
  const parsedCliPath = parseConfiguredCliPath(installationModel?.daemon?.cliPath);
  const releaseRoot = parsedCliPath.outcome === 'ok' ? parsedCliPath.root : '';

  // SH20: the one release-store reader the record-day composition builds.
  // Reused in BOTH places below — the one-time criteria's verified-build
  // inspector and the day's `releaseSha` source — so the sha recorded for the
  // day is the one `inspectReleaseFiles` inspects.
  const releaseStore = new ReleaseStoreAdapter();

  // SH8a: `cutover shadow record-day` — the shadow day-writer. Durable-state
  // only: without a state directory there is no ledger to write and no fleet
  // stores to check, so the use case stays undefined exactly like every other
  // durable-only use case in this composition (in-memory mode is disposable).
  // RC1: the same SH19c read-only lane-run reader `conducted.facts.runs`
  // binds — one instance, never a second adapter or writable handle — also
  // exposed on the runtime so `recordShadowDayHandler` can read the store's
  // run count for the early warning. Undefined without a durable state
  // directory or a conducted (github forge) repository.
  const shadowRunsRead: LaneRunRepositoryAdapter | undefined =
    durableCutover && stateDir !== undefined && stateDir.trim().length > 0 && forgeGithubSection !== undefined
      ? new LaneRunRepositoryAdapter({ stateDir, readOnly: true })
      : undefined;
  const recordShadowDay =
    durableCutover && stateDir !== undefined && stateDir.trim().length > 0
      ? (() => {
        // SH19d: one fresh read-only merge-queue reader for both the record-day
        // queue seat and S8's dry-run import use case. Read-only so a corrupt
        // merge-queue.json is a read error, never a quarantine.
        const readOnlyQueue = new MergeQueueRepositoryAdapter({ stateDir, readOnly: true });
        return new RecordShadowDayUseCase({
        // SH2's composition created no ShadowEvidenceAdapter elsewhere, so this
        // is the one writable instance over the ledger store it owns.
        evidence: new ShadowEvidenceAdapter({ stateDir }),
        // The same read-only shell-train reader the shadow report composes:
        // reuse the instance rather than point a second one at the same files.
        // LegacyTrainStateReadAdapter is genuinely read-only — it opens with
        // O_RDONLY | O_NOFOLLOW | O_NONBLOCK and uses lstat/readdir — so it
        // never writes or quarantines anything.
        legacy: execution.legacyTrainState,
        // SH19d: a fresh read-only queue reader (never the shared
        // execution.mergeQueueRepository), so a corrupt merge-queue.json
        // throws StateFileUnreadableReadOnlyError rather than quarantining.
        queue: readOnlyQueue,
        // S8's dry-run seat: a fresh import use case over the same read-only
        // queue, apply never set — listMergeEntries runs before the apply
        // check, so the read-only wiring covers the dry run too.
        importDryRun: new ImportTrainStateUseCase({
          legacyState: execution.legacyTrainState,
          queue: readOnlyQueue,
          mintUlid: () => newUlid(),
          nowIso: daemon.now,
        }),
        sleep:
          options?.daemonSleep ??
          ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
        // SH19c fix round: a fresh read-only journal reader, never the
        // conductor's writable instance — a corrupt run-journal.json is a
        // read error here, never a quarantine.
        journal: new LaneRunJournalAdapter({ stateDir, readOnly: true }),
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
        // SH19c: the conducted-facts readers, wired only when a GitHub
        // repository is configured as conducted; every reader is read-only so
        // a corrupt state file is never quarantined and no directory or lock
        // is created. Without the forge section there is no conducted
        // repository and S4/S6 stay `not-wired`.
        ...(forgeGithubSection === undefined
          ? {}
          : {
            conducted: {
              repository: { owner: forgeGithubSection.owner, repo: forgeGithubSection.repo },
              facts: {
                // RC1: the gated spread above guarantees the wired reader here.
                runs: shadowRunsRead!,
                journal: new LaneRunJournalAdapter({ stateDir, readOnly: true }),
                attempts: new AttemptRepositoryAdapter({ stateDir, readOnly: true }),
                receipts: telemetry.acceptanceReceiptRead,
                forge: forgeRead,
                nowIso: daemon.now,
              },
            },
          }),
        // S7's chain-record store: read-only, so a missing `chains` directory
        // lists as empty and nothing is ever created or locked.
        chains: new ChainRepositoryAdapter({ stateDir, readOnly: true }),
        // S5's fleet answer to one shell premerge-carry decision: owner
        // decision, hardcoded `unknown` for now.
        premergeCarry: async () => 'unknown',
        // S2, S3, S10 and S11: the sticky attestation ledger (read-only, so a
        // corrupt or missing file is reported, never quarantined) and the
        // verified-build file inspector over the one release root parsed from
        // the configured `daemon.cliPath` (empty when unconfigured or not a
        // served release path).
        oneTime: {
          attestations: new ShadowAttestationAdapter({ stateDir, readOnly: true }),
          releaseStore,
          releaseRoot,
        },
        // SH20: the day's sha is the installed `current` verified release
        // under the parsed release root — read through the same adapter
        // instance above — or `null` (S2/S10/S11 `release-unpinned`) when
        // unconfigured, missing, unverified, or unreadable.
        releaseSha: () => readCurrentReleaseSha({ releaseStore, releaseRoot }),
        nowIso: daemon.now,
        // OD7a2: the standing `merge:import-shadow` grant's day-coverage
        // reader for scheduled mode. Fail closed: a missing `grantId` or
        // `projectId`, a blocked or thrown resolve, an unreadable request
        // store and every unparseable timestamp are `unavailable` — never a
        // pass. The grant must be `approved` before the day's `00:00Z` and
        // expire strictly after the day's `24:00Z` to cover it.
        shadowGrantCoverage: async (input) => {
          const grantId = installationModel?.daemon?.shadow?.grantId?.trim() ?? '';
          if (grantId === '') {
            return { outcome: 'unavailable' as const };
          }
          const policy = resolveMergePolicy(options?.installation?.policy ?? {});
          const entry =
            policy.outcome === 'resolved'
              ? policy.repositories.find((candidate) => {
                  if (candidate.shadow !== true) {
                    return false;
                  }
                  const parsed = parseMergeRepositoryKey(candidate.repositoryKey);
                  return (
                    parsed !== undefined &&
                    parsed.owner === input.repository.owner &&
                    parsed.repo === input.repository.repo
                  );
                })
              : undefined;
          const projectId = entry?.projectId?.trim() ?? '';
          if (projectId === '') {
            return { outcome: 'unavailable' as const };
          }
          try {
            const resolved =
              await coordination.resolveActionAuthorization.resolveActionAuthorization({
                projectId,
                actionScope: 'merge:import-shadow',
                expectedHeadSha: '',
                authorizationGrantId: grantId,
                repository: input.repository,
              });
            if (resolved.outcome !== 'authorized') {
              return { outcome: 'not-covering' as const };
            }
            const record = await coordinationRequestRepository.findRequestByGrantId(grantId);
            if (record === null) {
              return { outcome: 'unavailable' as const };
            }
            const dayStartMs = Date.parse(`${input.day}T00:00:00.000Z`);
            if (Number.isNaN(dayStartMs)) {
              return { outcome: 'unavailable' as const };
            }
            return evaluateShadowGrantCoverage(
              record,
              new Date(dayStartMs).toISOString(),
              new Date(dayStartMs + 24 * 60 * 60 * 1000).toISOString(),
            );
          } catch {
            return { outcome: 'unavailable' as const };
          }
        },
        // Owner decision 2026-11-25: batch merges (batch-member merges and a
        // batch PR's own merge) are excluded from S1's merge set. A
        // batch-aware decider is the follow-up; until then the exclusion is
        // unconditional.
        settings: { excludeBatchMerges: true },
        });
      })()
    : undefined;
  // AT1: `cutover shadow attest` — the owner attestation writer. Durable-state
  // only, like record-day. The attestation adapter here is the one WRITABLE
  // instance over `cutover-shadow-attestations.json`; RecordShadowDayUseCase
  // keeps its own read-only instance above, so record-day can never write the
  // attestation store. The journal intent and result go through the same
  // `cutoverJournal` every cutover move shares.
  const attestShadowFact =
    durableCutover && stateDir !== undefined && stateDir.trim().length > 0
      ? new AttestShadowFactUseCase({
          attestations: new ShadowAttestationAdapter({ stateDir }),
          cutoverJournal,
          releaseSha: () => readCurrentReleaseSha({ releaseStore, releaseRoot }),
          computeDigest: sha256HexDigest,
          mintEntryId: () => newUlid(),
          nowIso: daemon.now,
        })
      : undefined;
  return {
    installation: options?.installation,
    reviewLocator,
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
      /** AR3c1: the shared process-tree termination adapter and live relaunch apply. */
      processTreeTermination: execution.processTreeTermination,
      applyRelaunch,
      /** SH8a: `cutover shadow record-day`; undefined without a durable state directory. */
      ...(recordShadowDay !== undefined ? { recordShadowDay } : {}),
      /** AT1: `cutover shadow attest`; undefined without a durable state directory. */
      ...(attestShadowFact !== undefined ? { attestShadowFact } : {}),
      /** RC1: the same read-only lane-run reader `conducted.facts.runs` uses, for record-day's early warning; undefined when conducted is not wired or the composition is not durable. */
      ...(recordShadowDay !== undefined && shadowRunsRead !== undefined ? { shadowRunsRead } : {}),
      reviewThreadHelper,
      /** SR6: `seats observe`; records one seat observation from outside the runner. */
      recordSeatObservation,
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
