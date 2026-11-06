/**
 * The canonical per-block allowed-key lists for every v1/v2 installation
 * section, in the exact serialization order `write.ts` emits. One module owns
 * each list; readers (`parse.ts` and the policy readers) and writers
 * (`write.ts`, `decision-consumers.ts`) import the same frozen arrays, so a
 * property added to a `types.ts` block interface without being added to its
 * key list fails `tsc`, and a key a writer omits can never pass the round-trip
 * suite.
 */

import type {
  AgyAcknowledgement,
  AgyHostRunnerSection,
  AnswerFileDecisionsSection,
  AutoMergePolicy,
  BoardPolicySection,
  ChainStep,
  ChainsSection,
  ClaimTriageSettings,
  ConductorPolicy,
  ConductorReaperDiskPolicy,
  ConductorReaperPolicy,
  ConductorReaperRepairKind,
  ConductorReaperWorktreePolicy,
  ConsumerSettings,
  DaemonSection,
  DecisionConsumers,
  FallbackSeat,
  FleetInstallationV1,
  FleetInstallationV2,
  ForbiddenRouteRule,
  ForgeSection,
  GateSlotSection,
  GitShelfSection,
  GithubForgeSection,
  HostRole,
  HostSection,
  JevDecisionsSection,
  LiveTailPolicy,
  LocalShelfSection,
  MergeDaemonSection,
  MergePolicySection,
  MergeRepositoryPolicy,
  MergeVetoPolicy,
  NoDecisionsSection,
  NoForgeSection,
  OpencodeHostRunnerSection,
  PolicySection,
  ProcedureCoverage,
  RunnerCapabilityDeclaration,
  RunnerSection,
  SeatSection,
  SeatsPolicy,
  ShelfSection,
  TelemetryPolicy,
  VerificationProcedure,
  VerificationProceduresSection,
  VerificationSection,
  WavesSection,
  WorktreeSection,
} from './types.js';

type AssertAllKeys<Block, Keys extends readonly (keyof Block)[]> =
  Exclude<keyof Block, Keys[number]> extends never ? Keys : never;

function freezeKeys<Block>() {
  return <const Keys extends readonly (keyof Block)[]>(
    keys: AssertAllKeys<Block, Keys>,
  ): Readonly<Keys> => Object.freeze(keys);
}

// ---------------------------------------------------------------------------
// v1 file blocks
// ---------------------------------------------------------------------------

export const V1_ROOT_KEYS: readonly string[] = freezeKeys<FleetInstallationV1>()([
  'schemaVersion',
  'runner',
  'worktree',
  'verification',
  'forge',
  'reviewer',
  'waves',
  'shelf',
]);

export const RUNNER_KEYS: readonly string[] = freezeKeys<RunnerSection>()([
  'agent',
  'model',
  'variant',
  'remotePort',
  'host',
  'ocmRunBin',
  'fallbackChain',
]);

export const WORKTREE_KEYS: readonly string[] = freezeKeys<WorktreeSection>()(['sshHost']);

export const VERIFICATION_KEYS: readonly string[] = freezeKeys<VerificationSection>()([
  'sshHost',
  'procedures',
]);

export const FORGE_KEYS: readonly string[] = freezeKeys<ForgeSection>()(['owner', 'repo']);

export const SEAT_KEYS: readonly string[] = freezeKeys<FallbackSeat>()([
  'agent',
  'model',
  'variant',
]);

export const SHELF_KEYS: readonly string[] = freezeKeys<ShelfSection>()(['baseUrl', 'keyFile']);

export const WAVES_KEYS: readonly string[] = freezeKeys<WavesSection>()([
  'baseUrl',
  'tokenFile',
  'caFile',
  'ownerPublicKey',
]);

// ---------------------------------------------------------------------------
// v2 root and non-policy blocks
// ---------------------------------------------------------------------------

export const V2_ROOT_KEYS: readonly string[] = freezeKeys<FleetInstallationV2>()([
  'schemaVersion',
  'hosts',
  'tools',
  'seats',
  'chains',
  'policy',
  'shelf',
  'forge',
  'verification',
  'waves',
  'decisions',
  'daemon',
]);

/** `hosts.<name>` keys in the writer's stable order (byte-identical host JSON). */
export const HOST_KEYS: readonly string[] = freezeKeys<HostSection>()([
  'transport',
  'sshAlias',
  'worktreeRoot',
  'tmpDir',
  'container',
  'roleAliases',
  'roles',
  'runner',
]);

/** The host roles in canonical order. */
export const HOST_ROLES: readonly HostRole[] = Object.freeze([
  'orchestrator',
  'lane-runner',
  'verifier',
]);

export const HOST_RUNNER_KEYS: readonly string[] = freezeKeys<OpencodeHostRunnerSection>()([
  'kind',
  'port',
  'tunnelOffset',
  'authFile',
  'capabilities',
  'maxLanes',
  'gateSlot',
]);

/** The agy-only runner fields; unknown keys on an opencode runner (D7). */
export const AGY_ONLY_RUNNER_KEYS: readonly ['agyMode', 'agyAcknowledgement'] =
  Object.freeze(['agyMode', 'agyAcknowledgement']);

export const AGY_HOST_RUNNER_KEYS: readonly string[] = freezeKeys<AgyHostRunnerSection>()([
  'kind',
  'port',
  'tunnelOffset',
  'authFile',
  'capabilities',
  'maxLanes',
  'gateSlot',
  'agyMode',
  'agyAcknowledgement',
]);

export const AGY_ACKNOWLEDGEMENT_KEYS: readonly string[] = freezeKeys<AgyAcknowledgement>()([
  'textVersion',
  'acceptedAt',
]);

export const CAPABILITY_KEYS: readonly string[] = freezeKeys<RunnerCapabilityDeclaration>()([
  'networkEgressRestricted',
  'cpuAndMemoryLimited',
  'processTreeTermination',
  'filesystemScope',
]);

export const GATE_SLOT_KEYS: readonly string[] = freezeKeys<GateSlotSection>()([
  'path',
  'slots',
]);

export const V2_SEAT_KEYS: readonly string[] = freezeKeys<SeatSection>()([
  'id',
  'tool',
  'model',
  'variant',
  'agent',
  'roles',
  'costClass',
  'health',
]);

export const CHAIN_KEYS = freezeKeys<ChainsSection>()([
  'implementer',
  'fix',
  'reviewer',
  'high-risk-reviewer',
]);

export const CHAIN_STEP_KEYS: readonly string[] = freezeKeys<ChainStep>()([
  'seatId',
  'triggers',
]);

export const LOCAL_SHELF_KEYS: readonly string[] = freezeKeys<LocalShelfSection>()(['provider']);

export const GIT_SHELF_KEYS: readonly string[] = freezeKeys<GitShelfSection>()([
  'provider',
  'repoDir',
  'branch',
  'pathPrefix',
]);

export const NO_FORGE_KEYS: readonly string[] = freezeKeys<NoForgeSection>()(['mode']);

export const GITHUB_FORGE_KEYS: readonly string[] = freezeKeys<GithubForgeSection>()([
  'mode',
  'owner',
  'repo',
]);

export const V2_VERIFICATION_KEYS: readonly string[] =
  freezeKeys<VerificationProceduresSection>()(['procedures']);

export const PROCEDURE_KEYS: readonly string[] = freezeKeys<VerificationProcedure>()([
  'command',
  'args',
  'coverage',
]);

export const PROCEDURE_COVERAGE_KEYS: readonly string[] = freezeKeys<ProcedureCoverage>()([
  'reader',
  'unitKind',
  'minUnits',
]);

export const NO_DECISIONS_KEYS: readonly string[] = freezeKeys<NoDecisionsSection>()(['provider']);

export const JEV_DECISIONS_KEYS: readonly string[] = freezeKeys<JevDecisionsSection>()([
  'provider',
  'model',
  'keyFile',
  'minConfidence',
  'monthlyBudgetUsd',
  'assumedCostPerCallUsd',
  'acknowledgeProseLeavesHost',
  'disabledProjects',
  'consumers',
]);

export const ANSWER_FILE_DECISIONS_KEYS: readonly string[] =
  freezeKeys<AnswerFileDecisionsSection>()(['provider', 'answerFile', 'consumers']);

export const DECISION_CONSUMERS_KEYS = freezeKeys<DecisionConsumers>()([
  'knowledge-ranking',
  'claim-triage',
]);

export const KNOWLEDGE_RANKING_CONSUMER_KEYS: readonly string[] =
  freezeKeys<ConsumerSettings>()(['minConfidence', 'monthlyBudgetUsd']);

export const CLAIM_TRIAGE_CONSUMER_KEYS: readonly string[] =
  freezeKeys<ClaimTriageSettings>()([
    'minConfidence',
    'monthlyBudgetUsd',
    'acknowledgeCandidateClaimsLeaveHost',
  ]);

export const DAEMON_KEYS: readonly string[] = freezeKeys<DaemonSection>()([
  'nodePath',
  'cliPath',
  'stateDir',
  'unitDir',
  'installationFile',
]);

// ---------------------------------------------------------------------------
// v2 `policy` and sub-blocks
// ---------------------------------------------------------------------------

export const POLICY_KEYS: readonly string[] = freezeKeys<PolicySection>()([
  'forbiddenRoutes',
  'perLaneCostCeiling',
  'useFreeSeats',
  'liveTail',
  'autoMerge',
  'conductor',
  'board',
  'telemetry',
  'seats',
  'merge',
  'daemon',
]);

export const FORBIDDEN_ROUTE_KEYS: readonly string[] = freezeKeys<ForbiddenRouteRule>()([
  'tool',
  'modelPattern',
]);

export const LIVE_TAIL_KEYS: readonly string[] = freezeKeys<LiveTailPolicy>()(['content']);

export const AUTO_MERGE_KEYS: readonly string[] = freezeKeys<AutoMergePolicy>()([
  'enabled',
  'allowHighRisk',
  'onBlocked',
]);

export const CONDUCTOR_KEYS: readonly string[] = freezeKeys<ConductorPolicy>()([
  'enabled',
  'stopGraceMinutes',
  'reaper',
]);

export const CONDUCTOR_REAPER_KEYS: readonly string[] = freezeKeys<ConductorReaperPolicy>()([
  'enabled',
  'intervalMinutes',
  'graceMinutes',
  'staleStopMinutes',
  'repairs',
  'worktrees',
  'disk',
]);

/** Repair kinds in canonical order; the first four are record-only (D14); `merged-worktree` and
 * `orphan-session` are destructive (D17). `orphan-session` stays last. */
export const CONDUCTOR_REAPER_REPAIR_KINDS: readonly ConductorReaperRepairKind[] =
  Object.freeze([
    'dead-attempt',
    'leaked-slot',
    'stale-stop',
    'stale-attention',
    'merged-worktree',
    'orphan-session',
  ]);

export const CONDUCTOR_REAPER_WORKTREE_KEYS: readonly string[] =
  freezeKeys<ConductorReaperWorktreePolicy>()([
    'retentionHours',
    'maxRemovalsPerPass',
    'passBudgetSeconds',
  ]);

export const CONDUCTOR_REAPER_DISK_KEYS: readonly string[] =
  freezeKeys<ConductorReaperDiskPolicy>()(['minFreePercent', 'clearFreePercent']);

export const BOARD_KEYS: readonly string[] = freezeKeys<BoardPolicySection>()([
  'forgeStaleMinutes',
  'declarationTtlMinutes',
  'doneWindowDays',
  'forgeSyncMinutes',
]);

export const TELEMETRY_POLICY_KEYS: readonly string[] = freezeKeys<TelemetryPolicy>()([
  'enabled',
  'projectName',
  'route',
  'sampleRatio',
  'sendCost',
  'includeDryRun',
  'projectAliases',
  'salt',
]);

export const SEATS_POLICY_KEYS: readonly string[] = freezeKeys<SeatsPolicy>()([
  'rotate',
  'cooldownMinutes',
  'observationCooldownMinutes',
]);

export const MERGE_KEYS: readonly string[] = freezeKeys<MergePolicySection>()(['repos']);

export const MERGE_REPO_KEYS: readonly string[] = freezeKeys<MergeRepositoryPolicy>()([
  'projectId',
  'shadow',
  'unattended',
  'requiredContexts',
  'updateBranch',
  'macosProcedure',
  'maxAttempts',
  'checksGraceMinutes',
  'veto',
]);

export const MERGE_VETO_KEYS: readonly string[] = freezeKeys<MergeVetoPolicy>()([
  'mode',
  'holdConfidence',
]);

export const POLICY_DAEMON_KEYS: readonly string[] = freezeKeys<MergeDaemonSection>()([
  'intervalSeconds',
  'budgetSeconds',
  'settleSeconds',
  'chainRefresh',
]);
